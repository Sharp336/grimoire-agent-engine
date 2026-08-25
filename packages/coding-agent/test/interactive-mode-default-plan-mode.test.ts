import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	AgentSession,
	type AgentSessionConfig,
	CommittedNewSessionTransitionError,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { InteractiveMode, shouldEnterPlanModeOnStartup } from "../src/modes/interactive-mode";
import { resolveXdevTool, type XdevState } from "../src/tools/xdev";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

function createExtensionRunnerCapture(
	capture: (actions: ExtensionCommandContextActions | undefined) => void,
): NonNullable<AgentSessionConfig["extensionRunner"]> {
	return {
		initialize(
			_actions: ExtensionActions,
			_contextActions: ExtensionContextActions,
			commandActions?: ExtensionCommandContextActions,
			_uiContext?: ExtensionUIContext,
		): void {
			capture(commandActions);
		},
		onError(_handler: (error: unknown) => void): void {},
		emit: async (_event: unknown) => undefined,
		hasHandlers: (_eventType: string) => false,
		getRegisteredCommands: () => [],
		getCommandDiagnostics: () => [],
		getShortcuts: () => [],
		getComposerShapes: () => [],
		setToolApprovalPreviewWaiter: (_waiter: (toolCallId: string) => Promise<void>) => () => {},
	} as unknown as NonNullable<AgentSessionConfig["extensionRunner"]>;
}

const PLAN_FIRST_GUIDANCE = "## First-Response Planning Check";

interface HarnessOptions {
	extraRegistryTools?: readonly AgentTool[];
	builtInToolNames?: Iterable<string>;
	/** Registry tools active from the first turn, alongside the built-in `read`. */
	initialActiveTools?: readonly AgentTool[];
	rebuildGate?: { fail: boolean; calls?: number };
	xdev?: XdevState;
	extensionRunner?: AgentSessionConfig["extensionRunner"];
	/** Provider/id of the initial model; defaults to `anthropic/claude-sonnet-4-5`. */
	initialModel?: { provider: string; id: string };
}

describe("InteractiveMode plan.defaultOnStartup", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-default-plan-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		authStorage = undefined as unknown as AuthStorage;
		tempDir = undefined as unknown as TempDir;
		resetSettingsForTest();
	});

	function modelOrThrow(registry: ModelRegistry, id: string): Model<Api> {
		const model = registry.find("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	/** Build an InteractiveMode over a brand-new (never-persisted) session.
	 *  `extraRegistryTools` registers additional tools that are NOT initially
	 *  active — modeling tools hidden by `tools.discoveryMode === "all"` that
	 *  modes may force-activate on entry. `builtInToolNames` marks which registry
	 *  entries still have built-in provenance after extension shadowing. */
	function createHarness(settings: Settings, options: HarnessOptions = {}): InteractiveMode {
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
		const requested = options.initialModel;
		const initialModel = requested
			? (registry.find(requested.provider, requested.id) ??
				(() => {
					throw new Error(`Expected ${requested.provider}/${requested.id} to exist`);
				})())
			: modelOrThrow(registry, "claude-sonnet-4-5");
		const readTool = makeTool("read");
		// AgentSession requires a Map-typed tool registry; `read` is the initial
		// active tool. Plan approval is a `write` to xd://propose, so plan-mode
		// entry only augments the built-in `write` tool when present.
		const xdev = options.xdev;
		const toolRegistry = xdev?.tools ?? new Map<string, AgentTool>();
		toolRegistry.set(readTool.name, readTool);
		for (const tool of options.extraRegistryTools ?? []) {
			toolRegistry.set(tool.name, tool);
		}
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
		const createdSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: ["Test", PLAN_FIRST_GUIDANCE],
					tools: [readTool, ...(options.initialActiveTools ?? [])],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			toolRegistry,
			builtInToolNames: options.builtInToolNames ?? ["read"],
			rebuildSystemPrompt: options.rebuildGate
				? async () => {
						if (options.rebuildGate) options.rebuildGate.calls = (options.rebuildGate.calls ?? 0) + 1;
						if (options.rebuildGate?.fail) throw new Error("rebuild failed");
						return {
							systemPrompt: session?.getPlanModeState()?.enabled ? ["Test"] : ["Test", PLAN_FIRST_GUIDANCE],
						};
					}
				: undefined,
			extensionRunner: options.extensionRunner,
			xdev,
		});
		session = createdSession;
		mode = new InteractiveMode(createdSession, "test");
		return mode;
	}

	function startupDecisionHarness(
		sessionSettings: Settings,
		options: { conversation?: boolean; explicitMode?: boolean } = {},
	): boolean {
		return shouldEnterPlanModeOnStartup(
			{
				buildSessionContext: () => ({ messages: options.conversation ? [{}] : [] }) as never,
				getEntries: () => (options.explicitMode ? [{ type: "mode_change" }] : []) as never,
			},
			sessionSettings,
		);
	}

	it("enters plan mode at startup when the setting is enabled", async () => {
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getPlanModeState()).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		expect(session?.getActiveToolNames()).toContain("read");
	});

	it("removes first-response guidance after manual plan mode becomes active", async () => {
		const rebuildGate = { fail: false, calls: 0 };
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }), { rebuildGate });
		await created.init({ suppressWelcomeIntro: true });
		expect(session?.systemPrompt.join("\n")).toContain(PLAN_FIRST_GUIDANCE);

		await created.handlePlanModeCommand();

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getPlanModeState()?.enabled).toBe(true);
		expect(session?.systemPrompt.join("\n")).not.toContain(PLAN_FIRST_GUIDANCE);
	});

	it("rolls back manual plan mode when its prompt rebuild fails", async () => {
		const rebuildGate = { fail: true, calls: 0 };
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }), { rebuildGate });
		await created.init({ suppressWelcomeIntro: true });
		const promptBefore = session?.systemPrompt;

		await expect(created.handlePlanModeCommand()).rejects.toThrow("rebuild failed");

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
		expect(session?.getActiveToolNames()).toEqual(["read"]);
		expect(session?.systemPrompt).toEqual(promptBefore);
		expect(session?.peekPlanProposalHandler()).toBeUndefined();
	});

	it("rolls back startup plan mode when its prompt rebuild fails", async () => {
		const rebuildGate = { fail: true, calls: 0 };
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }), {
			rebuildGate,
		});
		const promptBefore = session?.systemPrompt;

		await expect(created.init({ suppressWelcomeIntro: true })).rejects.toThrow("rebuild failed");

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
		expect(session?.getActiveToolNames()).toEqual(["read"]);
		expect(session?.systemPrompt).toEqual(promptBefore);
		expect(session?.peekPlanProposalHandler()).toBeUndefined();
	});

	it("restores paused plan mode when prompted re-entry cannot rebuild the prompt", async () => {
		const rebuildGate = { fail: false, calls: 0 };
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }), {
			rebuildGate,
		});
		await created.init({ suppressWelcomeIntro: true });
		await created.handlePlanModeCommand();
		expect(created.planModePaused).toBe(true);
		const promptBefore = session?.systemPrompt;
		const toolsBefore = session?.getActiveToolNames();
		rebuildGate.fail = true;

		await expect(created.handlePlanModeCommand("Revise the plan")).rejects.toThrow("rebuild failed");

		expect(created.planModeEnabled).toBe(false);
		expect(created.planModePaused).toBe(true);
		expect(session?.getPlanModeState()).toBeUndefined();
		expect(session?.getActiveToolNames()).toEqual(toolsBefore);
		expect(session?.systemPrompt).toEqual(promptBefore);
		expect(session?.sessionManager.buildSessionContext().mode).toBe("plan_paused");
	});

	it("keeps the welcome banner synchronized across startup and later model switches", async () => {
		Settings.instance.set("startup.quiet", false);
		const settings = Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false });
		settings.setModelRole("plan", "anthropic/claude-haiku-4-5:high");
		const created = createHarness(settings);
		const initialModel = session?.model;
		if (!initialModel) throw new Error("Expected initial model");

		await created.init({ suppressWelcomeIntro: true });

		const planModel = session?.model;
		if (!planModel) throw new Error("Expected plan model");
		expect(planModel.id).toBe("claude-haiku-4-5");
		const rendered = Bun.stripANSI(created.ui.render(120).join("\n"));
		expect(rendered).toContain(planModel.name);
		expect(rendered).not.toContain(initialModel.name);

		const requestRenderSpy = vi.spyOn(created.ui, "requestRender");
		requestRenderSpy.mockClear();
		await session!.setModel(initialModel);

		expect(requestRenderSpy).toHaveBeenCalled();
		const switched = Bun.stripANSI(created.ui.render(120).join("\n"));
		expect(switched).toContain(initialModel.name);
		expect(switched).not.toContain(planModel.name);
	});

	it("activates write when entering plan mode even if it was hidden by discoveryMode (issue #3165)", async () => {
		// `plan-mode-active.md` instructs the agent to draft the plan file with
		// `write` and refine it with `edit`. Under `tools.discoveryMode === "all"`
		// `write` is hidden behind `search_tool_bm25` so it's in the registry but
		// not the initial active set. Plan-mode entry must force-activate it or
		// the agent only has `edit`, which fails on a non-existent file.
		const writeTool = makeTool("write");
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }), {
			extraRegistryTools: [writeTool],
			builtInToolNames: ["read", "write"],
		});

		expect(session?.getActiveToolNames()).not.toContain("write");

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getActiveToolNames()).toContain("write");
	});

	it("keeps write on the direct surface when plan mode starts under Code Mode", async () => {
		// Plan approval is a top-level `write` to `xd://propose`. Code Mode demotes
		// every non-direct tool behind `eval`, and the partition only keeps `write`
		// direct while a transport needs it — so plan mode state must be visible
		// before the entry partition runs, or approval strands inside an eval result.
		const evalTool = { ...makeTool("eval"), supportsCodeModeTransport: () => true };
		const created = createHarness(
			Settings.isolated({
				"plan.defaultOnStartup": true,
				"compaction.enabled": false,
				"providers.openai-codex.codeMode": "auto",
			}),
			{
				extraRegistryTools: [makeTool("write"), evalTool],
				builtInToolNames: ["read", "write"],
				initialActiveTools: [evalTool],
				initialModel: { provider: "openai-codex", id: "gpt-5.6-sol" },
			},
		);

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getActiveToolNames()).toContain("write");
		// The eval tool advertises the bridge from this set, so a direct `write`
		// must never appear as `tool.write()`.
		expect(session?.getCodeModeDirectToolNames()).toContain("write");
		expect(session?.getActiveToolNames()).toContain("eval");
	});

	it("does not activate an extension-shadowed write tool in plan mode", async () => {
		const shadowWriteTool = makeTool("write");
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }), {
			extraRegistryTools: [shadowWriteTool],
		});

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getActiveToolNames()).not.toContain("write");
	});

	it("removes plan-only write when exiting to the previous read-only tool set", async () => {
		const writeTool = makeTool("write");
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }), {
			extraRegistryTools: [writeTool],
			builtInToolNames: ["read", "write"],
		});
		await created.init({ suppressWelcomeIntro: true });
		expect(session?.getActiveToolNames()).toContain("write");

		await created.handlePlanModeCommand();

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
		expect(session?.getActiveToolNames()).toEqual(["read"]);
	});

	it("starts /new outside plan mode with restored tools and fresh plan-first guidance", async () => {
		const writeTool = makeTool("write");
		const rebuildGate = { fail: false, calls: 0 };
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }), {
			extraRegistryTools: [writeTool],
			builtInToolNames: ["read", "write"],
			rebuildGate,
		});
		await created.init({ suppressWelcomeIntro: true });
		await created.handlePlanModeCommand();
		created.sessionManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		const previousSessionFile = session!.sessionFile;

		expect(created.planModeEnabled).toBe(true);
		expect(session!.getActiveToolNames()).toEqual(["read", "write"]);
		expect(session!.systemPrompt.join("\n")).not.toContain(PLAN_FIRST_GUIDANCE);
		const reconcileMode = vi.spyOn(created, "reconcileModeAfterNewSession");

		await created.handleClearCommand();

		expect(session!.sessionFile).not.toBe(previousSessionFile);
		expect(created.planModeEnabled).toBe(false);
		expect(created.planModePaused).toBe(false);
		expect(created.planModePlanFilePath).toBeUndefined();
		expect(session!.getPlanModeState()).toBeUndefined();
		expect(session!.peekPlanProposalHandler()).toBeUndefined();
		expect(session!.getActiveToolNames()).toEqual(["read"]);
		expect(session!.systemPrompt.join("\n")).toContain(PLAN_FIRST_GUIDANCE);
		expect(created.sessionManager.buildSessionContext()).toMatchObject({ messages: [], mode: "none" });
		expect(created.sessionManager.getBranch().some(entry => entry.type === "mode_change")).toBe(false);
		expect(reconcileMode).toHaveBeenCalledTimes(1);
	});

	it("converges after a rejected pre-plan model restore before completing committed /new", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("plan", "anthropic/claude-haiku-4-5:high");
		const writeTool = makeTool("write");
		const created = createHarness(settings, {
			extraRegistryTools: [writeTool],
			builtInToolNames: ["read", "write"],
			rebuildGate: { fail: false },
		});
		const previousModel = session!.model;
		await created.init({ suppressWelcomeIntro: true });
		await created.handlePlanModeCommand();
		const planModel = session!.model;
		const priorMessage = { role: "user" as const, content: "prior turn", timestamp: Date.now() };
		session!.agent.appendMessage(priorMessage);
		session!.sessionManager.appendMessage(priorMessage);
		const resetTranscript = vi.spyOn(created, "resetTranscript");
		const setModelTemporary = session!.setModelTemporary.bind(session);
		const restoreModel = vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async (...args) => {
			await setModelTemporary(...args);
			throw new Error("model restore failed after switch");
		});

		await expect(created.handleClearCommand()).resolves.toBeUndefined();

		expect(restoreModel).toHaveBeenCalledTimes(2);
		expect(session!.model?.id).toBe(previousModel?.id);
		expect(session!.model?.id).not.toBe(planModel?.id);
		expect(session!.getActiveToolNames()).toEqual(["read"]);
		expect(created.planModeEnabled).toBe(false);
		expect(created.planModePaused).toBe(false);
		expect(session!.getPlanModeState()).toBeUndefined();
		expect(session!.messages).toEqual([]);
		expect(created.sessionManager.buildSessionContext()).toMatchObject({ messages: [], mode: "none" });
		expect(created.sessionManager.getBranch().some(entry => entry.type === "mode_change")).toBe(false);
		expect(session!.systemPrompt.join("\n")).toContain(PLAN_FIRST_GUIDANCE);
		expect(resetTranscript).toHaveBeenCalledTimes(1);
	});

	it("surfaces a structured committed /new failure after completing caller teardown", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		await created.init({ suppressWelcomeIntro: true });
		await created.handlePlanModeCommand();
		const priorMessage = { role: "user" as const, content: "prior turn", timestamp: Date.now() };
		session!.agent.appendMessage(priorMessage);
		session!.sessionManager.appendMessage(priorMessage);
		const previousSessionFile = session!.sessionFile;
		const failure = new Error("reconciliation failed");
		const reconcileModeAfterNewSession = created.reconcileModeAfterNewSession.bind(created);
		const reconcileMode = vi.spyOn(created, "reconcileModeAfterNewSession").mockImplementation(async () => {
			await reconcileModeAfterNewSession();
			throw failure;
		});
		const resetTranscript = vi.spyOn(created, "resetTranscript");
		const showError = vi.spyOn(created, "showError");
		const newSession = session!.newSession.bind(session);
		let committedError: unknown;
		vi.spyOn(session!, "newSession").mockImplementation(async options => {
			try {
				return await newSession(options);
			} catch (error) {
				committedError = error;
				throw error;
			}
		});

		await expect(created.handleClearCommand()).resolves.toBeUndefined();

		expect(committedError).toBeInstanceOf(CommittedNewSessionTransitionError);
		expect((committedError as CommittedNewSessionTransitionError).cause).toBe(failure);
		expect(reconcileMode).toHaveBeenCalledTimes(1);
		expect(session!.sessionFile).not.toBe(previousSessionFile);
		expect(session!.messages).toEqual([]);
		expect(created.planModeEnabled).toBe(false);
		expect(created.planModePaused).toBe(false);
		expect(session!.getPlanModeState()).toBeUndefined();
		expect(created.sessionManager.buildSessionContext()).toMatchObject({ messages: [], mode: "none" });
		expect(resetTranscript).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("reconciliation failed"));
	});

	it("reconciles active plan mode when an extension starts a new session", async () => {
		let commandActions: ExtensionCommandContextActions | undefined;
		const writeTool = makeTool("write");
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }), {
			extraRegistryTools: [writeTool],
			builtInToolNames: ["read", "write"],
			rebuildGate: { fail: false },
			extensionRunner: createExtensionRunnerCapture(actions => {
				commandActions = actions;
			}),
		});
		await created.init({ suppressWelcomeIntro: true });
		await created.handlePlanModeCommand();

		const result = await commandActions!.newSession();

		expect(result).toEqual({ cancelled: false });
		expect(created.planModeEnabled).toBe(false);
		expect(created.planModePaused).toBe(false);
		expect(session!.getPlanModeState()).toBeUndefined();
		expect(session!.getActiveToolNames()).toEqual(["read"]);
		expect(session!.systemPrompt.join("\n")).toContain(PLAN_FIRST_GUIDANCE);
		expect(created.sessionManager.buildSessionContext()).toMatchObject({ messages: [], mode: "none" });
	});

	it("reconciles active plan mode when deleting the selected active session", async () => {
		const writeTool = makeTool("write");
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }), {
			extraRegistryTools: [writeTool],
			builtInToolNames: ["read", "write"],
			rebuildGate: { fail: false },
		});
		await created.init({ suppressWelcomeIntro: true });
		await created.handlePlanModeCommand();
		created.sessionManager.appendMessage({ role: "user", content: "delete this session", timestamp: Date.now() });
		await created.sessionManager.flush();
		const previousSessionFile = session!.sessionFile;
		if (!previousSessionFile) throw new Error("Expected active session file");
		const listedAt = new Date();
		vi.spyOn(SessionManager, "list").mockResolvedValue([
			{
				path: previousSessionFile,
				id: created.sessionManager.getSessionId(),
				cwd: created.sessionManager.getCwd(),
				created: listedAt,
				modified: listedAt,
				messageCount: 1,
				size: 1,
				firstMessage: "delete this session",
				allMessagesText: "delete this session",
			},
		]);

		const selectorReady = Promise.withResolvers<SessionSelectorComponent>();
		vi.spyOn(created.ui, "showOverlay").mockImplementation(component => {
			selectorReady.resolve(component as SessionSelectorComponent);
			return {
				hide: vi.fn(),
				setHidden: vi.fn(),
				isHidden: () => false,
			} as never;
		});
		const deleteRequested = Promise.withResolvers<string>();
		vi.spyOn(FileSessionStorage.prototype, "deleteSessionWithArtifacts").mockImplementation(async sessionPath => {
			deleteRequested.resolve(sessionPath);
		});

		created.showSessionSelector();
		const selector = await selectorReady.promise;
		selector.handleInput("\x1b[3~");
		selector.handleInput("\n");
		expect(await deleteRequested.promise).toBe(previousSessionFile);

		expect(session!.sessionFile).not.toBe(previousSessionFile);
		expect(created.planModeEnabled).toBe(false);
		expect(created.planModePaused).toBe(false);
		expect(session!.getPlanModeState()).toBeUndefined();
		expect(session!.getActiveToolNames()).toEqual(["read"]);
		expect(created.sessionManager.buildSessionContext()).toMatchObject({ messages: [], mode: "none" });
	});

	it("keeps plan controller and session state aligned when /new fails before commit", async () => {
		const writeTool = makeTool("write");
		const rebuildGate = { fail: false, calls: 0 };
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }), {
			extraRegistryTools: [writeTool],
			builtInToolNames: ["read", "write"],
			rebuildGate,
		});
		await created.init({ suppressWelcomeIntro: true });
		await created.handlePlanModeCommand();
		const priorMessage = { role: "user" as const, content: "prior turn", timestamp: Date.now() };
		session!.agent.appendMessage(priorMessage);
		session!.sessionManager.appendMessage(priorMessage);
		const previousAgentMessages = session!.messages.slice();
		const previousSessionFile = session!.sessionFile;
		const planTools = session!.getActiveToolNames();
		vi.spyOn(session!.sessionManager, "newSession").mockRejectedValueOnce(new Error("new session failed"));

		await expect(created.handleClearCommand()).rejects.toThrow("new session failed");

		expect(session!.sessionFile).toBe(previousSessionFile);
		expect(created.planModeEnabled).toBe(true);
		expect(created.planModePaused).toBe(false);
		expect(session!.getPlanModeState()?.enabled).toBe(true);
		expect(session!.messages).toEqual(previousAgentMessages);
		expect(session!.peekPlanProposalHandler()).toBeDefined();
		expect(session!.getActiveToolNames()).toEqual(planTools);
		expect(created.sessionManager.buildSessionContext().mode).toBe("plan");
	});

	it("runs central failure reconciliation for an early pre-commit /new error", async () => {
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));
		await created.init({ suppressWelcomeIntro: true });
		const failure = new Error("abort failed");
		vi.spyOn(session!, "abort").mockRejectedValueOnce(failure);
		const subscribe = vi.spyOn(session!.agent, "subscribe");
		const reconcileFailure = vi.spyOn(created, "reconcileModeAfterFailedNewSession");

		await expect(created.handleClearCommand()).rejects.toThrow(failure);

		expect(reconcileFailure).toHaveBeenCalledTimes(1);
		expect(reconcileFailure).toHaveBeenCalledWith(false);
		expect(created.planModeEnabled).toBe(true);
		expect(session!.getPlanModeState()?.enabled).toBe(true);
		expect(subscribe).toHaveBeenCalledTimes(1);
	});

	it("preserves paused plan controller state when /new fails before commit", async () => {
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));
		await created.init({ suppressWelcomeIntro: true });
		await created.handlePlanModeCommand();
		const previousSessionFile = session!.sessionFile;
		const pausedTools = session!.getActiveToolNames();
		vi.spyOn(session!.sessionManager, "newSession").mockRejectedValueOnce(new Error("new session failed"));

		await expect(created.handleClearCommand()).rejects.toThrow("new session failed");

		expect(session!.sessionFile).toBe(previousSessionFile);
		expect(created.planModeEnabled).toBe(false);
		expect(created.planModePaused).toBe(true);
		expect(session!.getPlanModeState()).toBeUndefined();
		expect(session!.getActiveToolNames()).toEqual(pausedTools);
		expect(created.sessionManager.buildSessionContext().mode).toBe("plan_paused");
		expect(created.sessionManager.getBranch().filter(entry => entry.type === "mode_change")).toHaveLength(2);
	});

	it("keeps plan mode retryable when prior-tool restoration fails", async () => {
		const writeTool = makeTool("write");
		const rebuildGate = { fail: false };
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }), {
			extraRegistryTools: [writeTool],
			builtInToolNames: ["read", "write"],
			rebuildGate,
		});
		await created.init({ suppressWelcomeIntro: true });
		const activeBefore = session?.getActiveToolNames();
		rebuildGate.fail = true;

		await expect(created.handlePlanModeCommand()).rejects.toThrow("rebuild failed");
		expect(created.planModeEnabled).toBe(true);
		expect(session?.getPlanModeState()?.enabled).toBe(true);
		expect(session?.getActiveToolNames()).toEqual(activeBefore);

		rebuildGate.fail = false;
		await created.handlePlanModeCommand();
		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
		expect(session?.getActiveToolNames()).toEqual(["read"]);
	});

	it("restores plan tool presentation when prior-model restoration fails", async () => {
		const settings = Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false });
		settings.setModelRole("plan", "anthropic/claude-haiku-4-5:high");
		const writeTool = makeTool("write");
		const planSelectedTool = makeTool("plan_selected");
		const mountedTool: CustomTool = {
			name: "mcp__ambient_search",
			label: "ambient/search",
			description: "Search ambient data",
			parameters: type({}),
			loadMode: "discoverable",
			mcpServerName: "ambient",
			mcpToolName: "search",
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const xdev: XdevState = {
			tools: new Map(),
			mountedNames: new Set(),
			builtInNames: new Set(["read", "write"]),
			isActive: name => session?.getActiveToolNames().includes(name) === true,
		};
		const created = createHarness(settings, {
			extraRegistryTools: [writeTool, planSelectedTool],
			builtInToolNames: ["read", "write"],
			xdev,
		});
		const previousModel = session?.model;
		await created.init({ suppressWelcomeIntro: true });
		const planModel = session?.model;
		await session!.refreshMCPTools([mountedTool]);
		await session!.setActiveToolsByName([...session!.getEnabledToolNames(), planSelectedTool.name]);
		const planTools = session!.getEnabledToolNames();
		const planActiveTools = session!.getActiveToolNames();
		const planMountedTools = session!.getMountedXdevToolNames();
		expect(planModel?.id).toBe("claude-haiku-4-5");
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
		expect(planActiveTools).toEqual(["read", "write", planSelectedTool.name]);
		expect(planMountedTools).toEqual([mountedTool.name]);
		expect(xdev.mountedNames.has(mountedTool.name)).toBe(true);

		const setModelTemporary = session!.setModelTemporary.bind(session);
		const restoreModel = vi.spyOn(session!, "setModelTemporary").mockImplementationOnce(async (...args) => {
			await setModelTemporary(...args);
			throw new Error("model restore failed after switch");
		});
		await expect(created.handlePlanModeCommand()).rejects.toThrow("model restore failed after switch");

		expect(created.planModeEnabled).toBe(true);
		expect(created.planModePaused).toBe(false);
		expect(session?.getPlanModeState()?.enabled).toBe(true);
		expect(session?.peekPlanProposalHandler()).toBeDefined();
		expect(session?.model?.id).toBe(planModel?.id);
		expect(session?.configuredThinkingLevel()).toBe(Effort.High);
		expect(session?.getEnabledToolNames()).toEqual(planTools);
		expect(session?.getActiveToolNames()).toEqual(planActiveTools);
		expect(session?.getMountedXdevToolNames()).toEqual(planMountedTools);
		expect(xdev.mountedNames.has(mountedTool.name)).toBe(true);

		restoreModel.mockRestore();
		await created.handlePlanModeCommand();
		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
		expect(session?.model?.id).toBe(previousModel?.id);
		// Pre-existing successful-exit behavior (unchanged by this fix): restoring the
		// pre-plan tool set drops the MCP device and plan-only selections entirely.
		expect(session?.getActiveToolNames()).toEqual(["read"]);
		expect(session?.getMountedXdevToolNames()).toEqual([]);
		expect(xdev.tools.has(mountedTool.name)).toBe(true);
		expect(resolveXdevTool(xdev, mountedTool.name)).toBeUndefined();
	});

	it("clears old plan UI state when target-session reconciliation restore fails", async () => {
		const writeTool = makeTool("write");
		const rebuildGate = { fail: false, calls: 0 };
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }), {
			extraRegistryTools: [writeTool],
			builtInToolNames: ["read", "write"],
			rebuildGate,
		});
		await created.init({ suppressWelcomeIntro: true });
		expect(created.planModeEnabled).toBe(true);
		expect(session?.peekPlanProposalHandler()).toBeDefined();

		const targetManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "target-sessions"));
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		expect(targetSessionFile).toBeString();
		await targetManager.close();
		const callsBeforeSwitch = rebuildGate.calls;
		rebuildGate.fail = true;

		await expect(session!.switchSession(targetSessionFile!)).resolves.toBe(true);
		expect(session?.sessionFile).toBe(targetSessionFile);
		expect(created.planModeEnabled).toBe(false);
		expect(rebuildGate.calls).toBeGreaterThan(callsBeforeSwitch);
		expect(created.planModePaused).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
		expect(session?.peekPlanProposalHandler()).toBeUndefined();
	});

	it("enters only when enabled and the session has no conversation or explicit mode", () => {
		expect(startupDecisionHarness(Settings.isolated({ "compaction.enabled": false }))).toBe(false);
		const enabled = Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false });
		expect(startupDecisionHarness(enabled, { conversation: true })).toBe(false);
		expect(startupDecisionHarness(enabled, { explicitMode: true })).toBe(false);
		expect(
			startupDecisionHarness(
				Settings.isolated({
					"plan.defaultOnStartup": true,
					"plan.enabled": false,
					"compaction.enabled": false,
				}),
			),
		).toBe(false);
	});

	it("classifies persisted compaction, metadata, custom, and mode entries without constructing a TUI", async () => {
		const enabled = Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false });
		const manager = SessionManager.create(
			tempDir.path(),
			path.join(tempDir.path(), `startup-decision-${Bun.nanoseconds()}`),
		);
		try {
			manager.appendModelChange("anthropic/claude-sonnet-4-5");
			manager.appendThinkingLevelChange("medium");
			manager.appendCustomEntry("my-extension-state", { foo: "bar" });
			expect(shouldEnterPlanModeOnStartup(manager, enabled)).toBe(true);

			manager.appendCompaction("prior conversation summary", undefined, "first-kept", 1000);
			expect(shouldEnterPlanModeOnStartup(manager, enabled)).toBe(false);

			manager.appendModeChange("plan", { planFilePath: "local://PLAN.md" });
			manager.appendModeChange("none");
			expect(shouldEnterPlanModeOnStartup(manager, enabled)).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("preserves the restored model when resuming an active plan session", async () => {
		const created = createHarness(
			Settings.isolated({
				"compaction.enabled": false,
				modelRoles: { plan: "anthropic/claude-sonnet-4-6" },
			}),
		);
		created.sessionManager.appendModelChange("anthropic/claude-sonnet-4-5");
		created.sessionManager.appendModeChange("plan", { planFilePath: "local://PLAN.md" });
		created.sessionManager.appendMessage({ role: "user", content: "prior plan turn", timestamp: Date.now() });

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.model?.id).toBe("claude-sonnet-4-5");
	});
});
