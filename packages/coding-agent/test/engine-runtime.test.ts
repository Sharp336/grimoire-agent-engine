import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { defineCapability, loadCapability, registerProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { settings as ambientSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	EngineControlInitiator,
	EngineEvent,
	EngineLaunchProfile,
} from "@oh-my-pi/pi-coding-agent/engine/contracts";
import { EngineRuntime, type EngineRuntimeOptions } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import { getLspResourceCounts } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveProviderCandidates } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("EngineRuntime", () => {
	const tempDirs: string[] = [];
	let sharedDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		registerMockApi("engine-runtime-test");
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-engine-runtime-shared-"));
		authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
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
		sessionDefaultOverrides: EngineRuntimeOptions["sessionDefaults"] = {},
	) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-runtime-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const agentDir = path.join(tempDir, "agent");
		const settings = await Settings.loadReadOnly({
			cwd,
			agentDir,
			overrides: { "bash.autoBackground.enabled": true },
		});
		const options: EngineRuntimeOptions = {
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt,
			sessionDefaults: {
				cwd,
				agentDir,
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
				...sessionDefaultOverrides,
			},
			...overrides,
		};
		if (options.resolveSessionProfile && !options.resolveSessionContinuation) {
			options.resolveSessionContinuation = async launch => `test:${launch.profileDigest}`;
		}
		const runtime = await EngineRuntime.create(options);
		return { runtime, cwd, options };
	}

	const profile: EngineLaunchProfile = {
		spawns: "",
		profileDigest: "leaf-profile-v1",
		enableMCP: false,
		enableLsp: false,
	};

	it("fails closed when Engine mode has no explicit Settings snapshot", async () => {
		const { runtime, cwd } = await createRuntime(async () => true, {}, { settings: undefined });
		await expect(
			runtime.start(
				{
					commandId: "command-missing-settings",
					agentInstanceId: "agent-missing-settings",
					executionId: "execution-missing-settings",
					attemptId: "attempt-missing-settings",
					authorityGeneration: 1,
					cwd,
					input: "must fail before startup",
				},
				profile,
			),
		).rejects.toThrow("Engine mode requires explicit settings");
		await runtime.dispose();
	});

	it("rejects an Engine Settings snapshot captured for another cwd", async () => {
		const { runtime, cwd } = await createRuntime(
			async () => true,
			{},
			{ settings: await Settings.loadReadOnly({ cwd: process.cwd() }) },
		);
		await expect(
			runtime.start(
				{
					commandId: "command-mismatched-settings",
					agentInstanceId: "agent-mismatched-settings",
					executionId: "execution-mismatched-settings",
					attemptId: "attempt-mismatched-settings",
					authorityGeneration: 1,
					cwd,
					input: "must fail before startup",
				},
				profile,
			),
		).rejects.toThrow("Engine settings cwd does not match session cwd");
		await runtime.dispose();
	});

	it("forces extension discovery to explicit-only with no in-process roots", async () => {
		let roots: { mode: string; explicit: readonly string[] } | undefined;
		let enabledTools: string[] = [];
		const { runtime, cwd } = await createRuntime(
			async session => {
				roots = session.effectiveExtensionRoots;
				enabledTools = session.getEnabledToolNames();
				return true;
			},
			{},
			{
				disableExtensionDiscovery: false,
				additionalExtensionPaths: [process.cwd()],
				preloadedCustomToolPaths: [{ path: "ambient-engine-tool.js" }],
			},
		);
		fs.writeFileSync(
			path.join(cwd, "ambient-engine-tool.js"),
			[
				"export default api => ({",
				'  name: "ambient_engine_tool",',
				'  label: "Ambient Engine Tool",',
				'  description: "must not load",',
				"  parameters: api.arktype({}),",
				'  async execute() { return { content: [{ type: "text", text: "bad" }] }; },',
				"});",
			].join("\n"),
		);
		await runtime.start(
			{
				commandId: "command-ambient-extensions",
				agentInstanceId: "agent-ambient-extensions",
				executionId: "execution-ambient-extensions",
				attemptId: "attempt-ambient-extensions",
				authorityGeneration: 1,
				cwd,
				input: "start without ambient extensions",
			},
			{ ...profile, spawns: "*", maxSpawnDepth: 1 },
		);
		await runtime.drain();
		expect(roots).toMatchObject({ mode: "explicit-only", explicit: [] });
		expect(enabledTools).not.toContain("ambient_engine_tool");
		expect(enabledTools).not.toContain("task");
		await runtime.dispose();
	});

	it("seals cwd, settings, provider policy and tools across one root plus six concurrent children", async () => {
		const capabilityId = `engine-policy-${Snowflake.next()}`;
		const providers = Array.from({ length: 7 }, (_, index) => `${capabilityId}-${index}`);
		const webProviders = ["perplexity", "gemini", "anthropic", "codex", "xai", "zai", "exa"] as const;
		defineCapability<{ name: string }>({
			id: capabilityId,
			displayName: capabilityId,
			description: capabilityId,
			key: item => item.name,
		});
		for (const provider of providers) {
			registerProvider(capabilityId, {
				id: provider,
				displayName: provider,
				description: provider,
				priority: 1,
				load: async ctx => ({
					items: [
						{
							name: provider,
							_source: { provider, providerName: provider, path: ctx.cwd, level: "project" as const },
						},
					],
				}),
			});
		}

		const settingsByProfile = new Map<string, Settings>();
		const entered = Promise.withResolvers<void>();
		const providerResults = new Map<string, string[]>();
		const webProviderResults = new Map<string, string>();
		const toolResults = new Map<string, string[]>();
		let enteredCount = 0;
		const { runtime, cwd } = await createRuntime(
			async session => {
				expect(session.settings.isReadOnly()).toBe(true);
				expect(ambientSettings.getCwd()).toBe(session.settings.getCwd());
				expect(() => session.settings.override("task.maxRecursionDepth", 99)).toThrow(
					"Settings snapshot is read-only",
				);
				expect(() => session.settings.get("disabledProviders").push("ambient-mutation")).toThrow();
				await expect(session.settings.reloadForCwd(process.cwd())).rejects.toThrow(
					"Settings snapshot is read-only",
				);
				enteredCount++;
				if (enteredCount === 7) entered.resolve();
				await entered.promise;
				const loaded = await loadCapability<{ name: string }>(capabilityId, { cwd: session.settings.getCwd() });
				providerResults.set(
					session.settings.getCwd(),
					loaded.items.map(item => item.name),
				);
				webProviderResults.set(session.settings.getCwd(), resolveProviderCandidates()[0]!.id);
				toolResults.set(session.settings.getCwd(), session.getEnabledToolNames());
				return true;
			},
			{
				resolveSessionProfile: async launch => ({
					options: { settings: settingsByProfile.get(launch.profileDigest) },
					dispose() {},
				}),
			},
		);
		const processCwd = process.cwd();
		const workspaces = await Promise.all(
			providers.map(async (provider, index) => {
				const sessionCwd = path.join(path.dirname(cwd), `workspace-${index}`);
				fs.mkdirSync(sessionCwd);
				settingsByProfile.set(
					`profile-${index}`,
					await Settings.loadReadOnly({
						cwd: sessionCwd,
						overrides: {
							disabledProviders: providers.filter(candidate => candidate !== provider),
							"providers.webSearchOrder": [webProviders[index]!],
						},
					}),
				);
				return sessionCwd;
			}),
		);
		const starts = await Promise.all(
			workspaces.map((sessionCwd, index) =>
				runtime.start(
					{
						commandId: `command-policy-${index}`,
						agentInstanceId: `agent-policy-${index}`,
						...(index > 0 ? { parentAgentInstanceId: "agent-policy-0" } : {}),
						executionId: `execution-policy-${index}`,
						attemptId: `attempt-policy-${index}`,
						authorityGeneration: 1,
						cwd: sessionCwd,
						input: String(index),
					},
					{
						...profile,
						profileDigest: `profile-${index}`,
						toolNames: [index % 2 === 0 ? "read" : "glob"],
						restrictToolNames: true,
					},
				),
			),
		);
		await runtime.drain();
		for (let index = 0; index < workspaces.length; index++) {
			expect(providerResults.get(workspaces[index]!)).toEqual([providers[index]!]);
			expect(webProviderResults.get(workspaces[index]!)).toBe(webProviders[index]!);
			const ownTool = index % 2 === 0 ? "read" : "glob";
			const otherTool = index % 2 === 0 ? "glob" : "read";
			expect(toolResults.get(workspaces[index]!)?.includes(ownTool)).toBe(true);
			expect(toolResults.get(workspaces[index]!)?.includes(otherTool)).toBe(false);
		}
		expect(process.cwd()).toBe(processCwd);
		await Promise.all(starts.map(target => runtime.release(target)));
		expect(runtime.agentRegistry.list()).toHaveLength(0);
		expect(runtime.asyncJobManager.getRunningJobs()).toHaveLength(0);
		await runtime.dispose();
	});

	it("releases every binding resource when one session disposer fails", async () => {
		let profileDisposals = 0;
		const { runtime, cwd } = await createRuntime(
			async session => {
				const dispose = session.dispose.bind(session);
				session.dispose = async () => {
					await dispose();
					throw new Error("injected session disposal failure");
				};
				return true;
			},
			{
				resolveSessionProfile: async () => ({
					options: {},
					dispose: () => {
						profileDisposals++;
					},
				}),
			},
		);
		await Promise.all(
			[0, 1].map(index =>
				runtime.start(
					{
						commandId: `command-cleanup-${index}`,
						agentInstanceId: `agent-cleanup-${index}`,
						executionId: `execution-cleanup-${index}`,
						attemptId: `attempt-cleanup-${index}`,
						authorityGeneration: 1,
						cwd,
						input: "finish",
					},
					profile,
				),
			),
		);
		await runtime.drain();
		await expect(runtime.dispose()).rejects.toBeInstanceOf(AggregateError);
		expect(profileDisposals).toBe(2);
		expect(runtime.agentRegistry.list()).toHaveLength(0);
		expect(runtime.asyncJobManager.getRunningJobs()).toHaveLength(0);
		expect(getLspResourceCounts()).toEqual({ clients: 0, pending: 0, owners: 0 });
	});

	it("waits for a validated rich Ask answer and resumes the same Attempt", async () => {
		const questions = [
			{
				id: "delivery",
				question: "How should this ship?",
				header: "Delivery",
				options: [
					{ label: "Fast", description: "Minimize scope" },
					{ label: "Safe", preview: "Run the focused suite first" },
				],
				recommended: 1,
			},
			{
				id: "checks",
				question: "Which checks matter?",
				options: [{ label: "Tests" }, { label: " Docs " }],
				multi: true,
			},
		];
		const release = Promise.withResolvers<void>();
		const secondModelCall = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: (async function* () {
				yield { content: [{ type: "toolCall" as const, id: "ask-engine", name: "ask", arguments: { questions } }] };
				secondModelCall.resolve();
				await release.promise;
				yield { content: ["done"] };
			})(),
		});
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await runtime.start(
			{
				commandId: "command-input",
				agentInstanceId: "agent-input",
				executionId: "execution-input",
				attemptId: "attempt-input",
				authorityGeneration: 1,
				cwd,
				input: "ask",
			},
			{ ...profile, toolNames: ["ask"], restrictToolNames: true },
		);
		const input = await requested;
		const inputId = String(input.payload?.inputId);
		expect(input.payload).toEqual({
			inputId,
			inputKind: "ask",
			questions,
			attemptState: "waiting_input",
			controlReadiness: { pause: false, resume: false, steer: false, cancel: true, resolveInput: true },
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("waiting_input");
		await expect(
			runtime.steer({ ...started, commandId: "steer-while-input", message: "do something else" }),
		).rejects.toMatchObject({ code: "too_late" });

		await expect(
			runtime.resolveInput({
				...started,
				commandId: "command-invalid-input",
				inputId,
				result: {
					kind: "submit",
					results: [
						{
							id: "wrong-order",
							question: "How should this ship?",
							options: ["Safe", "Fast"],
							multi: false,
							selectedOptions: ["Safe"],
						},
						{
							id: "checks",
							question: "Which checks matter?",
							options: ["Tests", "Docs"],
							multi: true,
							selectedOptions: ["Tests"],
						},
					],
				},
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		await expect(
			runtime.resolveInput({
				...started,
				commandId: "command-oversized-input",
				inputId,
				result: {
					kind: "submit",
					results: [
						{
							id: "delivery",
							question: "How should this ship?",
							options: ["Fast", "Safe"],
							multi: false,
							selectedOptions: ["Safe"],
							note: "x".repeat(48_001),
						},
						{
							id: "checks",
							question: "Which checks matter?",
							options: ["Tests", "Docs"],
							multi: true,
							selectedOptions: ["Tests"],
						},
					],
				},
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("waiting_input");

		const result = {
			kind: "submit" as const,
			results: [
				{
					id: "delivery",
					question: "How should this ship?",
					options: ["Fast", "Safe"],
					multi: false,
					selectedOptions: ["Safe"],
					note: "Prefer deterministic checks",
				},
				{
					id: "checks",
					question: "Which checks matter?",
					options: ["Tests", "Docs"],
					multi: true,
					selectedOptions: ["Tests", "Docs"],
				},
			],
		};
		const canonicalResult = {
			...result,
			results: [
				result.results[0]!,
				{
					...result.results[1]!,
					options: ["Tests", " Docs "],
					selectedOptions: ["Tests", " Docs "],
				},
			],
		};
		const commitAttemptTransition = runtime.store.commitAttemptTransition.bind(runtime.store);
		const transitionSpy = spyOn(runtime.store, "commitAttemptTransition").mockImplementation(
			async (binding, state, events, options) => {
				if (events.some(event => event.kind === "input_resolved")) {
					throw new Error("injected input_resolved failure");
				}
				return await commitAttemptTransition(binding, state, events, options);
			},
		);
		try {
			await expect(
				runtime.resolveInput({ ...started, commandId: "command-failed-input-event", inputId, result }),
			).rejects.toThrow("injected input_resolved failure");
		} finally {
			transitionSpy.mockRestore();
		}
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("waiting_input");
		const resolved = nextEngineEvent(runtime, "input_resolved");
		await runtime.resolveInput({ ...started, commandId: "command-resolve-input", inputId, result });
		const resolvedEvent = await resolved;
		await secondModelCall.promise;
		expect(resolvedEvent).toMatchObject({
			attemptId: started.attemptId,
			causationCommandId: "command-resolve-input",
			payload: {
				inputId,
				result: canonicalResult,
				attemptState: "running",
				controlReadiness: { pause: true, resume: false, steer: true, cancel: true, resolveInput: false },
			},
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		release.resolve();
		await runtime.drain();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("completed");
		await runtime.dispose();
	}, 60_000);

	it("cancels an Attempt that is waiting for Ask input", async () => {
		const questions = [{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }];
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", id: "ask-cancel", name: "ask", arguments: { questions } }] }],
		});
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await runtime.start(
			{
				commandId: "command-cancel-input",
				agentInstanceId: "agent-cancel-input",
				executionId: "execution-cancel-input",
				attemptId: "attempt-cancel-input",
				authorityGeneration: 1,
				cwd,
				input: "ask",
			},
			{ ...profile, toolNames: ["ask"], restrictToolNames: true },
		);
		const input = await requested;
		const resolved = nextEngineEvent(runtime, "input_resolved");
		await runtime.cancel({ ...started, commandId: "command-stop-input", reason: "No answer needed" });
		await runtime.drain();
		expect(await resolved).toMatchObject({
			causationCommandId: "command-stop-input",
			payload: {
				inputId: input.payload?.inputId,
				status: "cancelled",
				reason: "No answer needed",
				attemptState: "cancel_requested",
				controlReadiness: { pause: false, resume: false, steer: false, cancel: false, resolveInput: false },
			},
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		const eventKinds = (await runtime.store.pendingEvents()).map(event => event.kind);
		expect(eventKinds.indexOf("input_resolved")).toBeLessThan(eventKinds.indexOf("cancelled"));
		await runtime.dispose();
	}, 60_000);

	it("releases pending Ask input when its dialog signal aborts", async () => {
		const questions = [{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }];
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", id: "ask-abort", name: "ask", arguments: { questions } }] }],
		});
		let abortDialog: (() => Promise<void>) | undefined;
		const { runtime, cwd } = await createRuntime(
			(session, input) => {
				abortDialog = () => session.abort({ reason: "dialog aborted" });
				return session.prompt(input);
			},
			{},
			{ model: mock.model },
		);
		const requested = nextEngineEvent(runtime, "input_requested");
		const started = await runtime.start(
			{
				commandId: "command-abort-input",
				agentInstanceId: "agent-abort-input",
				executionId: "execution-abort-input",
				attemptId: "attempt-abort-input",
				authorityGeneration: 1,
				cwd,
				input: "ask",
			},
			{ ...profile, toolNames: ["ask"], restrictToolNames: true },
		);
		const input = await requested;
		const resolved = nextEngineEvent(runtime, "input_resolved");
		if (!abortDialog) throw new Error("dialog abort handle is unavailable");
		await abortDialog();
		await runtime.drain();
		expect(await resolved).toMatchObject({
			payload: { inputId: input.payload?.inputId, status: "cancelled", reason: "Input request aborted" },
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).not.toBe("waiting_input");
		await expect(
			runtime.resolveInput({
				...started,
				commandId: "late-input",
				inputId: String(input.payload?.inputId),
				result: { kind: "chat" },
			}),
		).rejects.toMatchObject({ code: "too_late" });
		await runtime.dispose();
	}, 60_000);

	it("waits for an explicit permit decision before executing a tool", async () => {
		let executed = false;
		const { runtime, cwd } = await createRuntime(async session => {
			const read = session.getToolByName("read");
			if (!read) throw new Error("read tool is unavailable");
			await read.execute("read-permit", { path: "permit.txt" });
			executed = true;
			return true;
		});
		fs.writeFileSync(path.join(cwd, "permit.txt"), "approved");
		const approvalRequested = nextEngineEvent(runtime, "tool_approval_requested");
		const started = await runtime.start(
			{
				commandId: "command-permit",
				agentInstanceId: "agent-permit",
				executionId: "execution-permit",
				attemptId: "attempt-permit",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			{ ...profile, toolPolicies: { read: "permit" } },
		);
		const approval = await approvalRequested;
		const approvalId = String(approval.payload?.approvalId);
		expect(executed).toBeFalse();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "planned", policy: "permit" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "pending", decision: null });

		await runtime.resolveToolApproval({
			...started,
			commandId: "command-approve",
			approvalId,
			decision: "approve",
		});
		await runtime.drain();
		expect(executed).toBeTrue();
		const events = await runtime.store.pendingEvents();
		expect(events.filter(event => event.kind.startsWith("tool_")).map(event => event.kind)).toEqual([
			"tool_approval_requested",
			"tool_approval_resolved",
			"tool_started",
			"tool_settled",
		]);
		expect(events.find(event => event.kind === "tool_approval_resolved")?.causationCommandId).toBe("command-approve");
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "settled", outcome: "completed" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "resolved", decision: "approve" });
		await runtime.dispose();
	}, 60_000);

	it("cancels an Attempt that is waiting for a tool permit", async () => {
		let executed = false;
		const { runtime, cwd } = await createRuntime(async session => {
			const read = session.getToolByName("read");
			if (!read) throw new Error("read tool is unavailable");
			await read.execute("read-cancelled-permit", { path: "permit.txt" });
			executed = true;
			return true;
		});
		fs.writeFileSync(path.join(cwd, "permit.txt"), "not read");
		const approvalRequested = nextEngineEvent(runtime, "tool_approval_requested");
		const started = await runtime.start(
			{
				commandId: "command-cancelled-permit",
				agentInstanceId: "agent-cancelled-permit",
				executionId: "execution-cancelled-permit",
				attemptId: "attempt-cancelled-permit",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			{ ...profile, toolPolicies: { read: "permit" } },
		);
		const approval = await approvalRequested;
		const approvalId = String(approval.payload?.approvalId);
		await runtime.cancel({ ...started, commandId: "command-cancel-permit" });
		await runtime.drain();
		expect(executed).toBeFalse();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		const events = await runtime.store.pendingEvents();
		expect(events.find(event => event.kind === "tool_approval_resolved")?.payload?.decision).toBe("cancelled");
		expect(events.find(event => event.kind === "tool_approval_resolved")?.causationCommandId).toBe(
			"command-cancel-permit",
		);
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "settled", outcome: "cancelled" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "resolved", decision: "cancelled" });
		await runtime.dispose();
	}, 60_000);

	it("durably denies a permitted tool without executing it", async () => {
		let executed = false;
		const { runtime, cwd } = await createRuntime(async session => {
			const read = session.getToolByName("read");
			if (!read) throw new Error("read tool is unavailable");
			await read.execute("read-denied-permit", { path: "permit.txt" });
			executed = true;
			return true;
		});
		fs.writeFileSync(path.join(cwd, "permit.txt"), "not read");
		const requested = nextEngineEvent(runtime, "tool_approval_requested");
		const started = await runtime.start(
			{
				commandId: "command-denied-permit",
				agentInstanceId: "agent-denied-permit",
				executionId: "execution-denied-permit",
				attemptId: "attempt-denied-permit",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			{ ...profile, toolPolicies: { read: "permit" } },
		);
		const approvalId = String((await requested).payload?.approvalId);
		await runtime.resolveToolApproval({
			...started,
			commandId: "command-deny",
			approvalId,
			decision: "deny",
			reason: "not now",
		});
		await runtime.drain();
		expect(executed).toBeFalse();
		expect(await runtime.store.getEffect(approvalId)).toMatchObject({ state: "settled", outcome: "denied" });
		expect(await runtime.store.getApproval(approvalId)).toMatchObject({ state: "resolved", decision: "deny" });
		await runtime.dispose();
	}, 60_000);

	it("settles a tracked async effect only after its owner job finishes", async () => {
		const release = Promise.withResolvers<string>();
		let runtime!: EngineRuntime;
		let cwd = "";
		({ runtime, cwd } = await createRuntime(async session => {
			const jobId = runtime.asyncJobManager.register("bash", "tracked", () => release.promise, {
				ownerId: session.getAgentId(),
				attemptId: session.getAttemptId(),
				sourceToolCallId: "read-tracked",
			});
			runtime.asyncJobManager.watchJobs([jobId]);
			const read = session.getToolByName("read");
			if (!read) throw new Error("read tool is unavailable");
			await read.execute("read-tracked", { path: "tracked.txt" });
			return true;
		}));
		fs.writeFileSync(path.join(cwd, "tracked.txt"), "tracked");
		const toolStarted = nextEngineEvent(runtime, "tool_started");
		const started = await runtime.start(
			{
				commandId: "command-tracked",
				agentInstanceId: "agent-tracked",
				executionId: "execution-tracked",
				attemptId: "attempt-tracked",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			{ ...profile, toolPolicies: { read: "tracked" } },
		);
		const startedEvent = await toolStarted;
		const effectId = String(startedEvent.payload?.invocationId);
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		expect(await runtime.store.getEffect(effectId)).toMatchObject({ state: "started", policy: "tracked" });
		expect((await runtime.store.pendingEvents()).find(event => event.kind === "tool_settled")).toBeUndefined();
		release.resolve("done");
		await runtime.drain();
		const events = await runtime.store.pendingEvents();
		expect(events.find(event => event.kind === "tool_settled")?.payload).toMatchObject({ status: "completed" });
		expect(events.findIndex(event => event.kind === "tool_settled")).toBeLessThan(
			events.findIndex(event => event.kind === "completed"),
		);
		expect(await runtime.store.getEffect(effectId)).toMatchObject({ state: "settled", outcome: "completed" });
		await runtime.dispose();
	}, 60_000);

	it("records unrestricted tools without exposing their raw input", async () => {
		const { runtime, cwd } = await createRuntime(async session => {
			const read = session.getToolByName("read");
			if (!read) throw new Error("read tool is unavailable");
			await read.execute("read-unrestricted", { path: "secret-name.txt" });
			return true;
		});
		fs.writeFileSync(path.join(cwd, "secret-name.txt"), "secret-value");
		await runtime.start(
			{
				commandId: "command-unrestricted",
				agentInstanceId: "agent-unrestricted",
				executionId: "execution-unrestricted",
				attemptId: "attempt-unrestricted",
				authorityGeneration: 1,
				cwd,
				input: "read",
			},
			profile,
		);
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.kind.startsWith("tool_"));
		expect(events.map(event => event.kind)).toEqual(["tool_started", "tool_settled"]);
		expect(JSON.stringify(events)).not.toContain("secret-name.txt");
		const effectId = String(events[0]?.payload?.invocationId);
		expect(await runtime.store.getEffect(effectId)).toMatchObject({
			state: "settled",
			outcome: "completed",
			policy: "unrestricted",
		});
		await runtime.dispose();
	}, 60_000);

	it("records model dispatch certainty without exposing the prompt", async () => {
		const { runtime, cwd } = await createRuntime();
		await runtime.start(
			{
				commandId: "command-model-effect",
				agentInstanceId: "agent-model-effect",
				executionId: "execution-model-effect",
				attemptId: "attempt-model-effect",
				authorityGeneration: 1,
				cwd,
				input: "private prompt sentinel",
			},
			profile,
		);
		await runtime.drain();
		const events = (await runtime.store.pendingEvents()).filter(event => event.kind.startsWith("model_"));
		expect(events.map(event => event.kind)).toEqual(["model_started", "model_settled"]);
		expect(JSON.stringify(events)).not.toContain("private prompt sentinel");
		const effectId = String(events[0]?.payload?.effectId);
		expect(await runtime.store.getEffect(effectId)).toMatchObject({
			effect_kind: "model",
			state: "settled",
			outcome: "completed",
		});
		await runtime.dispose();
	}, 60_000);

	it("keeps reasoning and tool input out of public trace events", async () => {
		const mock = createMockModel({
			reasoning: true,
			responses: [
				{
					content: [
						{ type: "thinking", thinking: "private reasoning sentinel" },
						{ type: "toolCall", id: "read-private", name: "read", arguments: { path: "private-input.txt" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const { runtime, cwd } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		fs.writeFileSync(path.join(cwd, "private-input.txt"), "private tool output sentinel");
		await runtime.start(
			{
				commandId: "command-public-trace",
				agentInstanceId: "agent-public-trace",
				executionId: "execution-public-trace",
				attemptId: "attempt-public-trace",
				authorityGeneration: 1,
				cwd,
				input: "inspect the file",
			},
			{ ...profile, toolNames: ["read"], restrictToolNames: true },
		);
		await runtime.drain();
		const events = await runtime.store.pendingEvents();
		const trace = events.filter(event => event.kind.startsWith("trace_"));
		expect(trace.some(event => event.kind === "trace_reasoning")).toBe(true);
		expect(trace.some(event => event.kind === "trace_tool")).toBe(true);
		expect(JSON.stringify(events)).not.toMatch(
			/private reasoning sentinel|private-input\.txt|private tool output sentinel/,
		);
		await runtime.dispose();
	}, 60_000);

	it("launches six pinned children in parallel and rejects the seventh", async () => {
		let taskResults: string[] = [];
		const launches: Array<{ toolCallId: string; maxSpawnDepth: number }> = [];
		const { runtime, cwd } = await createRuntime(
			async session => {
				const task = session.getToolByName("task");
				if (!task) throw new Error("Engine root did not expose task");
				const results = await Promise.all(
					Array.from({ length: 7 }, (_, index) =>
						task.execute(`tool-child-${index}`, {
							profileRef: "gctx:2222222222222222",
							workStepId: `child-step-${index}`,
						}),
					),
				);
				taskResults = results.map(result => result.content.find(part => part.type === "text")?.text ?? "");
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
					return {
						agentInstanceId: `child-${request.toolCallId}`,
						status: "completed",
						assistantFinal: `done ${request.toolCallId}`,
					};
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
			{
				...profile,
				spawns: "*",
				maxSpawnDepth: 1,
				maxChildren: 6,
				childProfileRefs: ["gctx:2222222222222222"],
			},
		);
		await runtime.drain();
		expect(launches).toHaveLength(6);
		expect(taskResults.slice(0, 6)).toEqual(Array.from({ length: 6 }, (_, index) => `done tool-child-${index}`));
		expect(taskResults[6]).toContain("maxChildren ceiling (6) reached");
		expect(launches[0]).toMatchObject({
			maxSpawnDepth: 0,
		});
		await runtime.dispose();
	}, 60_000);

	it("does not expose task when the pinned profile has no child catalog", async () => {
		let enabledTools: string[] = [];
		const { runtime, cwd } = await createRuntime(
			async session => {
				enabledTools = session.getEnabledToolNames();
				return true;
			},
			{
				resolveSessionProfile: async () => ({ options: {}, childProfiles: [], dispose() {} }),
				launchChild: async () => {
					throw new Error("must not launch");
				},
			},
		);
		await runtime.start(
			{
				commandId: "command-leaf",
				agentInstanceId: "leaf-agent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/leaf-agent",
				executionId: "execution-leaf",
				attemptId: "attempt-leaf",
				authorityGeneration: 1,
				cwd,
				input: "leaf",
			},
			profile,
		);
		await runtime.drain();
		expect(enabledTools).not.toContain("task");
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

	it("rebuilds an idle root when only its per-run tool policy changes", async () => {
		const { runtime, cwd } = await createRuntime();
		const first = await runtime.start(
			{
				commandId: "command-policy-a",
				agentInstanceId: "agent-policy",
				executionId: "execution-policy-a",
				attemptId: "attempt-policy-a",
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
				commandId: "command-policy-b",
				agentInstanceId: "agent-policy",
				executionId: "execution-policy-b",
				attemptId: "attempt-policy-b",
				authorityGeneration: 1,
				cwd,
				input: "B",
			},
			{ ...profile, toolPolicies: { read: "tracked" } },
		);
		expect(second.bindingGeneration).toBeGreaterThan(first.bindingGeneration);
		expect(runtime.agentRegistry.get(second.engineAgentId)?.session).not.toBe(firstSession);
		await runtime.drain();
		await runtime.dispose();
	}, 60_000);

	it("reopens a durable transcript only for the same AgentInstance profile", async () => {
		const mock = createMockModel({
			responses: [{ content: ["remembered 41"] }, { content: ["same profile"] }, { content: ["fresh profile"] }],
		});
		const { runtime, cwd, options } = await createRuntime(
			(session, input) => session.prompt(input),
			{},
			{ model: mock.model },
		);
		const first = await runtime.start(
			{
				commandId: "command-continuity-a",
				agentInstanceId: "agent-continuity",
				executionId: "execution-continuity-a",
				attemptId: "attempt-continuity-a",
				authorityGeneration: 1,
				cwd,
				input: "Remember 41",
			},
			profile,
		);
		await runtime.drain();
		await runtime.dispose();

		const restarted = await EngineRuntime.create(options);
		const second = await restarted.start(
			{
				commandId: "command-continuity-b",
				agentInstanceId: "agent-continuity",
				executionId: "execution-continuity-b",
				attemptId: "attempt-continuity-b",
				authorityGeneration: 1,
				cwd,
				input: "What number did I say?",
			},
			profile,
		);
		await restarted.drain();
		expect(second.sessionFile).toBe(first.sessionFile);
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain("Remember 41");

		const changed = await restarted.start(
			{
				commandId: "command-continuity-c",
				agentInstanceId: "agent-continuity",
				executionId: "execution-continuity-c",
				attemptId: "attempt-continuity-c",
				authorityGeneration: 1,
				cwd,
				input: "Start clean",
			},
			{ ...profile, systemPrompt: "A different AgentInstance profile" },
		);
		await restarted.drain();
		expect(changed.sessionFile).not.toBe(second.sessionFile);
		expect(JSON.stringify(mock.calls[2]?.context.messages)).not.toContain("Remember 41");
		await restarted.dispose();
	}, 60_000);

	it("reopens a transcript only across an exact continuation identity", async () => {
		let dependencyDigest = "dependency-a";
		const { runtime, cwd } = await createRuntime(async () => true, {
			resolveSessionContinuation: async () => dependencyDigest,
			resolveSessionProfile: async (_profile, sessionCwd) => ({
				options: { settings: await Settings.loadReadOnly({ cwd: sessionCwd }) },
				dispose() {},
			}),
		});
		const request = {
			agentInstanceId: "agent-exact-continuation",
			agentInstanceRef: "grimoire://tasks/project-a/task-a/agents/agent-exact-continuation",
			authorityGeneration: 1,
			cwd,
		};
		const start = (suffix: string, overrides: Partial<typeof request> = {}, launch = profile) =>
			runtime.start(
				{
					...request,
					...overrides,
					commandId: `command-exact-${suffix}`,
					executionId: `execution-exact-${suffix}`,
					attemptId: `attempt-exact-${suffix}`,
					input: suffix,
				},
				launch,
			);

		const first = await start("first");
		await runtime.drain();
		const same = await start("same");
		await runtime.drain();
		expect(same.sessionFile).toBe(first.sessionFile);

		dependencyDigest = "dependency-b";
		const dependencyChanged = await start("dependency");
		await runtime.drain();
		expect(dependencyChanged.sessionFile).not.toBe(same.sessionFile);

		const projectChanged = await start("project", {
			agentInstanceRef: "grimoire://tasks/project-b/task-b/agents/agent-exact-continuation",
		});
		await runtime.drain();
		expect(projectChanged.sessionFile).not.toBe(dependencyChanged.sessionFile);

		const authorityChanged = await start("authority", { authorityGeneration: 2 });
		await runtime.drain();
		expect(authorityChanged.sessionFile).not.toBe(projectChanged.sessionFile);

		const otherCwd = path.join(path.dirname(cwd), "workspace-b");
		fs.mkdirSync(otherCwd);
		const cwdChanged = await start("cwd", { authorityGeneration: 2, cwd: otherCwd });
		await runtime.drain();
		expect(cwdChanged.sessionFile).not.toBe(authorityChanged.sessionFile);

		const fresh = await start(
			"fresh-a",
			{ authorityGeneration: 2, cwd: otherCwd },
			{ ...profile, continuationPolicy: "fresh" },
		);
		await runtime.drain();
		const freshAgain = await start(
			"fresh-b",
			{ authorityGeneration: 2, cwd: otherCwd },
			{ ...profile, continuationPolicy: "fresh" },
		);
		await runtime.drain();
		expect(freshAgain.sessionFile).not.toBe(fresh.sessionFile);
		await runtime.dispose();
	}, 60_000);

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

	it("attributes parent-driven cancellation to the start command that owns the Attempt", async () => {
		const prompt = Promise.withResolvers<boolean>();
		const { runtime, cwd } = await createRuntime(() => prompt.promise);
		const events: Array<{ kind: string; causationCommandId: string }> = [];
		runtime.subscribe(event => {
			events.push(event);
		});
		await runtime.start(
			{
				commandId: "command-parent-owned",
				agentInstanceId: "agent-parent-owned",
				executionId: "execution-parent-owned",
				attemptId: "attempt-parent-owned",
				authorityGeneration: 1,
				cwd,
				input: "wait",
			},
			profile,
		);
		await runtime.cancelAgentInstance("agent-parent-owned", "parent aborted");
		prompt.resolve(true);
		await runtime.drain();
		expect(events.find(event => event.kind === "cancelled")?.causationCommandId).toBe("command-parent-owned");
		await runtime.dispose();
	}, 60000);

	it("pauses and resumes the same child Attempt without waking its parent", async () => {
		const prompts = new Map<string, PromiseWithResolvers<boolean>>();
		const { runtime, cwd } = await createRuntime(session => {
			const prompt = Promise.withResolvers<boolean>();
			const agentId = session.getAgentId();
			if (!agentId) throw new Error("Engine test session has no agent id");
			prompts.set(agentId, prompt);
			return prompt.promise;
		});
		const parent = await runtime.start(
			{
				commandId: "command-parent",
				agentInstanceId: "parent-agent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/parent-agent",
				executionId: "execution-parent",
				attemptId: "attempt-parent",
				authorityGeneration: 1,
				cwd,
				input: "wait for children",
			},
			profile,
		);
		const parentSession = runtime.agentRegistry.get(parent.engineAgentId)?.session;
		if (!parentSession) throw new Error("parent session is unavailable");
		let parentSessionEvents = 0;
		parentSession.subscribe(() => parentSessionEvents++);

		const sources: EngineControlInitiator[] = [
			{ kind: "human" },
			{
				kind: "agent",
				agentInstanceId: "controller-agent",
				agentInstanceRef: "grimoire://tasks/p/t/agents/controller-agent",
			},
		];
		for (const [index, initiator] of sources.entries()) {
			const child = await runtime.start(
				{
					commandId: `command-child-${index}`,
					agentInstanceId: `child-agent-${index}`,
					agentInstanceRef: `grimoire://tasks/p/t/agents/child-agent-${index}`,
					parentAgentInstanceId: "parent-agent",
					executionId: `execution-child-${index}`,
					attemptId: `attempt-child-${index}`,
					authorityGeneration: 1,
					cwd,
					input: "work",
				},
				profile,
			);
			const parentEventsBefore = (await runtime.store.pendingEvents()).filter(
				event => event.agentInstanceId === "parent-agent",
			);
			const parentSnapshot = {
				mailbox: runtime.ircBus.inbox(parent.engineAgentId, { peek: true }),
				unread: runtime.ircBus.unreadCount(parent.engineAgentId),
				sessionEvents: parentSessionEvents,
				messages: parentSession.messages.length,
				eventSeq: parentEventsBefore.map(event => event.seq),
			};
			const paused = nextEngineEvent(runtime, "paused");
			await runtime.pause({ ...child, commandId: `pause-child-${index}`, initiator });
			prompts.get(child.engineAgentId)?.resolve(true);
			const pausedEvent = await paused;

			const pausedAttempt = await runtime.store.getAttempt(child.attemptId);
			expect(pausedAttempt).toMatchObject({ state: "paused", transcript_revision: 1 });
			expect(runtime.getBinding(child.agentInstanceId)).toMatchObject({
				bindingId: child.bindingId,
				attemptId: child.attemptId,
			});
			expect(pausedEvent.payload).toMatchObject({
				initiator,
				attemptState: "paused",
				controlReadiness: { pause: false, resume: true, steer: true, cancel: true },
				transcriptCheckpoint: { revision: 1 },
			});
			expect({
				mailbox: runtime.ircBus.inbox(parent.engineAgentId, { peek: true }),
				unread: runtime.ircBus.unreadCount(parent.engineAgentId),
				sessionEvents: parentSessionEvents,
				messages: parentSession.messages.length,
				eventSeq: (await runtime.store.pendingEvents())
					.filter(event => event.agentInstanceId === "parent-agent")
					.map(event => event.seq),
			}).toEqual(parentSnapshot);

			const completed = nextEngineEvent(runtime, "completed");
			await runtime.resume({ ...child, commandId: `resume-child-${index}`, initiator });
			const completedEvent = await completed;
			expect(completedEvent.attemptId).toBe(child.attemptId);
			expect(completedEvent.payload).toMatchObject({ transcriptCheckpoint: { revision: 2 } });
			const completedAttempt = await runtime.store.getAttempt(child.attemptId);
			expect(completedAttempt).toMatchObject({ state: "completed", transcript_revision: 2 });
			expect(Number(completedAttempt?.transcript_byte_boundary)).toBeGreaterThanOrEqual(
				Number(pausedAttempt?.transcript_byte_boundary),
			);
			const resumedEvent = (await runtime.store.pendingEvents()).find(
				event => event.kind === "resumed" && event.attemptId === child.attemptId,
			);
			expect(resumedEvent?.payload).toMatchObject({ initiator, attemptState: "running" });
		}

		prompts.get(parent.engineAgentId)?.resolve(true);
		await runtime.drain();
		await runtime.dispose();
	}, 60000);

	it("accepts a steer while paused and resumes the same Attempt", async () => {
		const promptStarted = Promise.withResolvers<void>();
		const prompt = Promise.withResolvers<boolean>();
		const queued: string[] = [];
		const { runtime, cwd } = await createRuntime(async session => {
			session.steer = async message => {
				queued.push(message);
			};
			promptStarted.resolve();
			return prompt.promise;
		});
		const started = await runtime.start(
			{
				commandId: "command-paused-steer",
				agentInstanceId: "agent-paused-steer",
				executionId: "execution-paused-steer",
				attemptId: "attempt-paused-steer",
				authorityGeneration: 1,
				cwd,
				input: "work",
			},
			profile,
		);
		await promptStarted.promise;
		const paused = nextEngineEvent(runtime, "paused");
		await runtime.pause({ ...started, commandId: "pause-before-steer", initiator: { kind: "human" } });
		prompt.resolve(true);
		await paused;

		const steered = nextEngineEvent(runtime, "steered");
		await runtime.steer({ ...started, commandId: "steer-while-paused", message: "change course" });
		const steeredEvent = await steered;
		expect(queued).toEqual(["change course"]);
		expect(steeredEvent).toMatchObject({
			attemptId: started.attemptId,
			causationCommandId: "steer-while-paused",
		});
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("paused");

		const completed = nextEngineEvent(runtime, "completed");
		await runtime.resume({ ...started, commandId: "resume-after-steer", initiator: { kind: "human" } });
		expect((await completed).attemptId).toBe(started.attemptId);
		await runtime.dispose();
	}, 60000);

	it("keeps cancel terminal and distinct from resume for a paused Attempt", async () => {
		const prompt = Promise.withResolvers<boolean>();
		const { runtime, cwd } = await createRuntime(() => prompt.promise);
		const started = await runtime.start(
			{
				commandId: "command-paused-cancel",
				agentInstanceId: "agent-paused-cancel",
				executionId: "execution-paused-cancel",
				attemptId: "attempt-paused-cancel",
				authorityGeneration: 1,
				cwd,
				input: "wait",
			},
			profile,
		);
		const paused = nextEngineEvent(runtime, "paused");
		await runtime.pause({ ...started, commandId: "pause-before-cancel", initiator: { kind: "human" } });
		prompt.resolve(true);
		await paused;
		await runtime.cancel({ ...started, commandId: "cancel-not-resume" });
		await runtime.drain();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		const events = await runtime.store.pendingEvents();
		expect(events.some(event => event.kind === "resumed")).toBeFalse();
		expect(
			events.find(event => event.kind === "cancelled" && event.causationCommandId === "cancel-not-resume"),
		).toBeDefined();
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

	it("interrupts active, paused and approval-waiting Attempts before closing the store", async () => {
		const pausedDispatch = Promise.withResolvers<boolean>();
		const activeDispatch = Promise.withResolvers<boolean>();
		const { runtime, cwd } = await createRuntime(async (session, input) => {
			switch (input) {
				case "wait": {
					const abort = session.abort.bind(session);
					session.abort = async options => {
						activeDispatch.resolve(false);
						return await abort(options);
					};
					return await activeDispatch.promise;
				}
				case "pause":
					return await pausedDispatch.promise;
				case "read": {
					const read = session.getToolByName("read");
					if (!read) throw new Error("read tool is unavailable");
					await read.execute("read-shutdown-permit", { path: "shutdown.txt" });
					return true;
				}
				default:
					throw new Error("unexpected shutdown test agent");
			}
		}, {});
		fs.writeFileSync(path.join(cwd, "shutdown.txt"), "must not be read");
		try {
			const modelStarted = nextEngineEvent(runtime, "model_started");
			await runtime.start(
				{
					commandId: "command-shutdown-active",
					agentInstanceId: "agent-shutdown-active",
					executionId: "execution-shutdown-active",
					attemptId: "attempt-shutdown-active",
					authorityGeneration: 1,
					cwd,
					input: "wait",
				},
				profile,
			);
			await modelStarted;

			const paused = await runtime.start(
				{
					commandId: "command-shutdown-paused",
					agentInstanceId: "agent-shutdown-paused",
					executionId: "execution-shutdown-paused",
					attemptId: "attempt-shutdown-paused",
					authorityGeneration: 1,
					cwd,
					input: "pause",
				},
				profile,
			);
			const pauseFinished = nextEngineEvent(runtime, "paused");
			await runtime.pause({ ...paused, commandId: "pause-for-shutdown", initiator: { kind: "human" } });
			pausedDispatch.resolve(true);
			await pauseFinished;

			const approvalRequested = nextEngineEvent(runtime, "tool_approval_requested");
			await runtime.start(
				{
					commandId: "command-shutdown-approval",
					agentInstanceId: "agent-shutdown-approval",
					executionId: "execution-shutdown-approval",
					attemptId: "attempt-shutdown-approval",
					authorityGeneration: 1,
					cwd,
					input: "read",
				},
				{ ...profile, toolPolicies: { read: "permit" } },
			);
			const approvalId = String((await approvalRequested).payload?.approvalId);

			await runtime.dispose({ closeStore: false });
			for (const attemptId of ["attempt-shutdown-active", "attempt-shutdown-paused", "attempt-shutdown-approval"]) {
				expect(await runtime.store.getAttempt(attemptId)).toMatchObject({ state: "interrupted" });
			}
			const events = await runtime.store.pendingEvents();
			expect(
				events
					.filter(event => event.kind === "interrupted")
					.map(event => event.attemptId)
					.sort(),
			).toEqual(["attempt-shutdown-active", "attempt-shutdown-approval", "attempt-shutdown-paused"]);
			expect(await runtime.store.getApproval(approvalId)).toMatchObject({
				state: "resolved",
				decision: "cancelled",
			});
		} finally {
			await runtime.store.close();
		}
	}, 60_000);

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
		expect(completed?.payload).toMatchObject({
			assistantFinal: "final answer",
			transcriptRef: `history://${started.engineAgentId}`,
			transcriptCheckpoint: {
				sessionId: expect.any(String),
				sessionPath: expect.any(String),
				leafEntryId: expect.any(String),
				byteBoundary: expect.any(Number),
				revision: 1,
			},
		});
		expect(await runtime.store.getAttempt(started.attemptId)).toMatchObject({
			state: "completed",
			transcript_session_id: expect.any(String),
			transcript_path: expect.any(String),
			transcript_leaf_entry_id: expect.any(String),
			transcript_byte_boundary: expect.any(Number),
			transcript_revision: 1,
		});
		await runtime.dispose();
	}, 60000);

	it("publishes schema-validated yield data as the Engine final result", async () => {
		const prompts: string[] = [];
		const { runtime, cwd } = await createRuntime(async (session, input) => {
			prompts.push(input);
			expect(session.getToolByName("yield")).toBeDefined();
			if (prompts.length === 1) return true;
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
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("Call the yield tool now");
		await runtime.dispose();
	}, 60000);

	it("fails a required-yield attempt after two prose-only reminders", async () => {
		const prompts: string[] = [];
		const { runtime, cwd } = await createRuntime(async (_session, input) => {
			prompts.push(input);
			return true;
		});
		await runtime.start(
			{
				commandId: "command-missing-yield",
				agentInstanceId: "agent-missing-yield",
				executionId: "execution-missing-yield",
				attemptId: "attempt-missing-yield",
				authorityGeneration: 1,
				cwd,
				input: "finish",
			},
			{ ...profile, requireYieldTool: true, outputSchema: { type: "object" } },
		);
		await runtime.drain();
		const events = await runtime.store.pendingEvents();
		expect(events.find(event => event.kind === "completed")).toBeUndefined();
		expect(events.find(event => event.kind === "failed")?.payload).toMatchObject({
			error: "required_yield_not_submitted",
			transcriptCheckpoint: { revision: 1 },
		});
		expect(prompts).toHaveLength(3);
		await runtime.dispose();
	}, 60000);

	it("fails an attempt when the model turn ends with a provider error", async () => {
		const { runtime, cwd } = await createRuntime(async session => {
			Object.defineProperty(session, "getLastAssistantMessage", {
				value: () => ({
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "provider rejected request",
				}),
			});
			return true;
		});
		await runtime.start(
			{
				commandId: "command-provider-error",
				agentInstanceId: "agent-provider-error",
				executionId: "execution-provider-error",
				attemptId: "attempt-provider-error",
				authorityGeneration: 1,
				cwd,
				input: "fail",
			},
			profile,
		);
		await runtime.drain();
		const events = await runtime.store.pendingEvents();
		expect(events.find(event => event.kind === "completed")).toBeUndefined();
		expect(events.find(event => event.kind === "failed")?.payload).toMatchObject({
			error: "provider rejected request",
			transcriptCheckpoint: { revision: 1 },
		});
		const modelEffectId = String(events.find(event => event.kind === "model_started")?.payload?.effectId);
		expect(await runtime.store.getEffect(modelEffectId)).toMatchObject({
			effect_kind: "model",
			state: "settled",
			outcome: "failed",
		});
		await runtime.dispose();
	}, 60000);

	it("keeps an Attempt nonterminal when transcript durability cannot be proven", async () => {
		const { runtime, cwd } = await createRuntime();
		const failedTwice = Promise.withResolvers<void>();
		let flushCalls = 0;
		const flush = spyOn(SessionManager.prototype, "flushAndCheckpoint").mockImplementation(async () => {
			flushCalls++;
			if (flushCalls === 2) failedTwice.resolve();
			throw new Error("injected transcript flush failure");
		});
		const started = await runtime.start(
			{
				commandId: "command-flush-failure",
				agentInstanceId: "agent-flush-failure",
				executionId: "execution-flush-failure",
				attemptId: "attempt-flush-failure",
				authorityGeneration: 1,
				cwd,
				input: "finish",
			},
			profile,
		);
		await failedTwice.promise;
		await Bun.sleep(1);
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("running");
		expect(
			(await runtime.store.pendingEvents()).some(event => event.kind === "completed" || event.kind === "failed"),
		).toBeFalse();

		flush.mockRestore();
		await runtime.cancel({ ...started, commandId: "cancel-after-flush-failure" });
		await runtime.drain();
		expect((await runtime.store.getAttempt(started.attemptId))?.state).toBe("cancelled");
		await runtime.dispose();
	}, 60000);
});

function nextEngineEvent(runtime: EngineRuntime, kind: EngineEvent["kind"]): Promise<EngineEvent> {
	const result = Promise.withResolvers<EngineEvent>();
	const unsubscribe = runtime.subscribe(event => {
		if (event.kind !== kind) return;
		unsubscribe();
		result.resolve(event);
	});
	return result.promise;
}
