import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EngineLaunchProfile } from "@oh-my-pi/pi-coding-agent/engine/contracts";
import { EngineRuntime, type EngineRuntimeOptions } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("EngineRuntime", () => {
	const tempDirs: string[] = [];
	let sharedDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-engine-runtime-shared-"));
		authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	async function createRuntime(
		dispatchPrompt: EngineRuntimeOptions["dispatchPrompt"] = async () => true,
		overrides: Partial<EngineRuntimeOptions> = {},
	) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-runtime-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const options: EngineRuntimeOptions = {
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt,
			sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
			},
			...overrides,
		};
		const runtime = await EngineRuntime.create(options);
		return { runtime, cwd, options };
	}

	const profile: EngineLaunchProfile = {
		spawns: "",
		profileDigest: "leaf-profile-v1",
		enableMCP: false,
		enableLsp: false,
	};

	it("routes Engine task calls through explicit AgentProfile child launch", async () => {
		let taskResult = "";
		const launches: unknown[] = [];
		const { runtime, cwd } = await createRuntime(
			async session => {
				const task = session.getToolByName("task");
				if (!task) throw new Error("Engine root did not expose task");
				const result = await task.execute("tool-child", {
					profileRef: "gctx:2222222222222222",
					workStepId: "child-step",
				});
				taskResult = result.content.find(part => part.type === "text")?.text ?? "";
				return true;
			},
			{
				resolveSessionProfile: async () => ({
					options: {},
					childProfiles: [{ profileRef: "gctx:2222222222222222", displayName: "Worker" }],
					dispose() {},
				}),
				launchChild: async request => {
					launches.push(request);
					return { agentInstanceId: "child-agent", status: "completed", assistantFinal: "child done" };
				},
			},
		);
		await runtime.start(
			{
				commandId: "command-parent",
				agentInstanceId: "parent-agent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/parent-agent",
				executionId: "execution-parent",
				attemptId: "attempt-parent",
				authorityGeneration: 1,
				cwd,
				input: "delegate",
			},
			{ ...profile, spawns: "*", maxSpawnDepth: 1 },
		);
		await runtime.drain();
		expect(taskResult).toBe("child done");
		expect(launches[0]).toMatchObject({
			parentAgentInstanceId: "parent-agent",
			parentAttemptId: "attempt-parent",
			profileRef: "gctx:2222222222222222",
			workStepId: "child-step",
			maxSpawnDepth: 0,
		});
		await runtime.dispose();
	}, 60_000);

	it("runs two independent roots on one shared runtime and disposes only the targeted root", async () => {
		const { runtime, cwd } = await createRuntime();
		const first = await runtime.start(
			{
				commandId: "command-a",
				agentInstanceId: "agent-a",
				executionId: "execution-a",
				attemptId: "attempt-a",
				authorityGeneration: 1,
				cwd,
				input: "A",
			},
			profile,
		);
		const second = await runtime.start(
			{
				commandId: "command-b",
				agentInstanceId: "agent-b",
				executionId: "execution-b",
				attemptId: "attempt-b",
				authorityGeneration: 1,
				cwd,
				input: "B",
			},
			profile,
		);
		await runtime.drain();
		const firstSession = runtime.agentRegistry.get(first.engineAgentId)?.session;
		const secondSession = runtime.agentRegistry.get(second.engineAgentId)?.session;
		expect(firstSession).toBeDefined();
		expect(secondSession).toBeDefined();
		expect(firstSession).not.toBe(secondSession);

		const release = Promise.withResolvers<string>();
		const jobId = runtime.asyncJobManager.register("bash", "agent-a job", async () => release.promise, {
			ownerId: first.engineAgentId,
			attemptId: first.attemptId,
		});
		await runtime.release(second);
		expect(runtime.asyncJobManager.getJob(jobId)?.status).toBe("running");
		expect(runtime.agentRegistry.get(first.engineAgentId)?.session).toBe(firstSession);
		release.resolve("done");
		await runtime.asyncJobManager.waitForAll();
		await runtime.dispose();
	}, 60000);

	it("reuses an idle root for a new Attempt and rejects stale generation fences", async () => {
		const { runtime, cwd } = await createRuntime();
		const first = await runtime.start(
			{
				commandId: "command-a",
				agentInstanceId: "agent-a",
				executionId: "execution-a",
				attemptId: "attempt-a",
				authorityGeneration: 1,
				cwd,
				input: "A",
			},
			profile,
		);
		await runtime.drain();
		const firstSession = runtime.agentRegistry.get(first.engineAgentId)?.session;
		const second = await runtime.start(
			{
				commandId: "command-b",
				agentInstanceId: "agent-a",
				executionId: "execution-b",
				attemptId: "attempt-b",
				authorityGeneration: 1,
				cwd,
				input: "B",
			},
			profile,
		);
		expect(second.bindingGeneration).toBe(first.bindingGeneration);
		expect(runtime.agentRegistry.get(second.engineAgentId)?.session).toBe(firstSession);
		await expect(
			runtime.start(
				{
					commandId: "command-c",
					agentInstanceId: "agent-a",
					executionId: "execution-c",
					attemptId: "attempt-b",
					authorityGeneration: 1,
					cwd,
					input: "C",
				},
				profile,
			),
		).rejects.toMatchObject({ code: "invalid_request" });
		await expect(
			runtime.cancel({ ...second, bindingGeneration: second.bindingGeneration + 1 }),
		).rejects.toMatchObject({
			code: "stale_target",
		});
		await runtime.drain();
		await runtime.dispose();
	}, 60000);

	it("keeps a completed Attempt terminal when cancel arrives late", async () => {
		const { runtime, cwd } = await createRuntime();
		const started = await runtime.start(
			{
				commandId: "command-a",
				agentInstanceId: "agent-a",
				executionId: "execution-a",
				attemptId: "attempt-a",
				authorityGeneration: 1,
				cwd,
				input: "A",
			},
			profile,
		);
		await runtime.drain();
		await expect(runtime.cancel(started)).rejects.toMatchObject({ code: "too_late" });
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
		await runtime.dispose();
	}, 60000);

	it("does not redispatch a durable Attempt after Engine restart", async () => {
		let dispatchCount = 0;
		const { runtime, cwd, options } = await createRuntime(async () => {
			dispatchCount++;
			return true;
		});
		const request = {
			commandId: "command-a",
			agentInstanceId: "agent-a",
			executionId: "execution-a",
			attemptId: "attempt-a",
			authorityGeneration: 1,
			cwd,
			input: "A",
		};
		await runtime.start(request, profile);
		await runtime.drain();
		await runtime.dispose();

		const restarted = await EngineRuntime.create(options);
		const duplicate = await restarted.start(request, profile);
		expect(duplicate.duplicate).toBeTrue();
		expect(duplicate.state).toBe("released");
		expect(dispatchCount).toBe(1);
		await restarted.dispose();
	}, 60000);

	it("rejects steering after an Attempt becomes idle", async () => {
		const { runtime, cwd } = await createRuntime();
		const started = await runtime.start(
			{
				commandId: "command-a",
				agentInstanceId: "agent-a",
				executionId: "execution-a",
				attemptId: "attempt-a",
				authorityGeneration: 1,
				cwd,
				input: "A",
			},
			profile,
		);
		await runtime.drain();
		await expect(runtime.steer({ ...started, commandId: "steer-1", message: "too late" })).rejects.toMatchObject({
			code: "too_late",
		});
		await runtime.dispose();
	}, 60000);

	it("admits cancel before owner jobs quiesce and publishes terminal cancellation after", async () => {
		const prompt = Promise.withResolvers<boolean>();
		const job = Promise.withResolvers<string>();
		let jobSettled = false;
		const { runtime, cwd } = await createRuntime(() => prompt.promise);
		const started = await runtime.start(
			{
				commandId: "command-a",
				agentInstanceId: "agent-a",
				executionId: "execution-a",
				attemptId: "attempt-a",
				authorityGeneration: 1,
				cwd,
				input: "A",
			},
			profile,
		);
		runtime.asyncJobManager.register(
			"bash",
			"slow cancellation",
			async () => {
				const result = await job.promise;
				jobSettled = true;
				return result;
			},
			{ ownerId: started.engineAgentId, attemptId: started.attemptId },
		);

		await runtime.cancel({ ...started, commandId: "cancel-a" });
		expect(jobSettled).toBeFalse();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancel_requested");
		job.resolve("stopped");
		prompt.resolve(true);
		await runtime.drain();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		expect(
			(await runtime.store.pendingEvents())
				.filter(event => event.kind === "cancelled")
				.map(event => event.causationCommandId),
		).toEqual(["command-a", "cancel-a"]);
		await runtime.dispose();
	}, 60000);

	it("waits for attempt jobs before publishing the bounded final result", async () => {
		const job = Promise.withResolvers<string>();
		const { runtime, cwd } = await createRuntime(async session => {
			Object.defineProperty(session, "getLastAssistantText", { value: () => "final answer" });
			const jobId = runtime.asyncJobManager.register("task", "child", () => job.promise, {
				ownerId: session.getAgentId(),
				attemptId: session.getAttemptId(),
			});
			runtime.asyncJobManager.watchJobs([jobId]);
			return true;
		});
		const started = await runtime.start(
			{
				commandId: "command-final",
				agentInstanceId: "agent-final",
				executionId: "execution-final",
				attemptId: "attempt-final",
				authorityGeneration: 1,
				cwd,
				input: "finish",
			},
			profile,
		);
		await Bun.sleep(10);
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		job.resolve("done");
		await runtime.drain();
		const completed = (await runtime.store.pendingEvents()).find(event => event.kind === "completed");
		expect(completed?.payload).toEqual({
			assistantFinal: "final answer",
			transcriptRef: `history://${started.engineAgentId}`,
		});
		await runtime.dispose();
	}, 60000);

	it("publishes schema-validated yield data as the Engine final result", async () => {
		const { runtime, cwd } = await createRuntime(async session => {
			Object.defineProperty(session, "messages", {
				value: [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								name: "yield",
								arguments: { result: { data: { schema: "example.v1", ok: true } } },
							},
						],
					},
				],
			});
			return true;
		});
		await runtime.start(
			{
				commandId: "command-yield",
				agentInstanceId: "agent-yield",
				executionId: "execution-yield",
				attemptId: "attempt-yield",
				authorityGeneration: 1,
				cwd,
				input: "finish",
			},
			{ ...profile, requireYieldTool: true, outputSchema: { type: "object" } },
		);
		await runtime.drain();
		const completed = (await runtime.store.pendingEvents()).find(event => event.kind === "completed");
		expect(completed?.payload?.assistantFinal).toBe('{"schema":"example.v1","ok":true}');
		await runtime.dispose();
	}, 60000);
});
