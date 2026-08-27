import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EngineLaunchProfile } from "@oh-my-pi/pi-coding-agent/engine/contracts";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
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

	async function createRuntime() {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-runtime-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async () => true,
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
		});
		return { runtime, cwd };
	}

	const profile: EngineLaunchProfile = {
		spawns: "",
		profileDigest: "leaf-profile-v1",
		enableMCP: false,
		enableLsp: false,
	};

	it("runs two independent roots on one shared runtime and disposes only the targeted root", async () => {
		const { runtime, cwd } = await createRuntime();
		const first = await runtime.start(
			{ agentInstanceId: "agent-a", executionId: "execution-a", attemptId: "attempt-a", cwd, input: "A" },
			profile,
		);
		const second = await runtime.start(
			{ agentInstanceId: "agent-b", executionId: "execution-b", attemptId: "attempt-b", cwd, input: "B" },
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
			{ agentInstanceId: "agent-a", executionId: "execution-a", attemptId: "attempt-a", cwd, input: "A" },
			profile,
		);
		await runtime.drain();
		const firstSession = runtime.agentRegistry.get(first.engineAgentId)?.session;
		const second = await runtime.start(
			{ agentInstanceId: "agent-a", executionId: "execution-b", attemptId: "attempt-b", cwd, input: "B" },
			profile,
		);
		expect(second.bindingGeneration).toBe(first.bindingGeneration);
		expect(runtime.agentRegistry.get(second.engineAgentId)?.session).toBe(firstSession);
		await expect(
			runtime.start(
				{ agentInstanceId: "agent-a", executionId: "execution-c", attemptId: "attempt-b", cwd, input: "C" },
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
});
