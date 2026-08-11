import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { runRpcSessionStartup } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-init";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const GOAL_ID = "restore-ordering-fixture";

/**
 * RPC goal-mode startup ordering contract, bound to the PRODUCTION wiring.
 *
 * The ordering lives in {@link runRpcSessionStartup} (called by runRpcMode),
 * not in this test: this test drives that helper with a real AgentSession +
 * real ExtensionRunner, so it fails whenever the helper's internal order
 * regresses (session_start emitted before restore, or the output subscriber
 * installed after restore) — the manual reproduction this file replaces
 * stayed green under the old buggy order.
 *
 * The contract the helper must satisfy:
 *   1. install the output subscriber,
 *   2. initializeExtensions with `emitSessionStart: false`,
 *   3. attachHeadlessGoalAdapter (its initial `controller.restore()`),
 *   4. emitExtensionSessionStart.
 *
 * Restore() reconciles a persisted goal: it sets goal-mode state, exposes the
 * `goal` tool, and emits `goal_updated`. That event must reach (a) the output
 * subscriber installed BEFORE restore (get_state has no goal field — the event
 * is the only client signal) and (b) an INITIALIZED extension runner (an
 * uninitialized runtime throws on tool access). `session_start` must fire only
 * AFTER restore so a session_start handler that inspects tools or starts a
 * turn observes goal-mode state.
 */
describe("RPC goal-mode startup ordering", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => void | Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-rpc-goal-ordering-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
	});

	it("delivers restore's goal_updated to the pre-restore subscriber and defers session_start until after restore", async () => {
		const root = tempDir.path();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		cleanups.push(async () => {
			authStorage.close();
		});
		// Runtime override so the session's own API-key gate passes: the turn
		// below runs through the canned mock provider (no network, no key).
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"goal.enabled": true,
			"plan.enabled": true,
		});
		const bootstrapToolSession = {
			cwd: root,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
		const initialTools = await createTools(bootstrapToolSession, ["read", "edit"]);
		const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));

		// Extension runner whose handlers capture (1) what a session_start
		// handler observes — the state a turn started from session_start would
		// read — and (2) the extension-stream ordering of restore's goal_updated
		// vs the deferred session_start. Handlers close over `session`, which is
		// assigned below.
		let session: AgentSession | undefined;
		const extensionEventOrder: string[] = [];
		const observed = {
			sessionStartRuns: 0,
			goalAtSessionStart: undefined as GoalModeState | undefined,
			activeToolsAtSessionStart: [] as string[],
			goalUpdatedRuns: 0,
			goalIdAtGoalUpdated: undefined as string | undefined,
			runtimeErrors: [] as string[],
		};
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("goal_updated", (_event, _ctx) => {
					extensionEventOrder.push("goal_updated");
					observed.goalUpdatedRuns++;
					// The goal mode state is set before restore emits goal_updated.
					observed.goalIdAtGoalUpdated = session?.getGoalModeState()?.goal?.id;
				});
				pi.on("session_start", (_event, _ctx) => {
					extensionEventOrder.push("session_start");
					observed.sessionStartRuns++;
					observed.goalAtSessionStart = session?.getGoalModeState();
					// getActiveTools in the RPC init wiring reads
					// session.getEnabledToolNames(); observe the same contract.
					observed.activeToolsAtSessionStart = session?.getEnabledToolNames() ?? [];
				});
			},
			root,
			new EventBus(),
			extensionRuntime,
			"rpc-goal-ordering",
		);
		const sessionManager = SessionManager.create(root, root);
		const extensionRunner = new ExtensionRunner([extension], extensionRuntime, root, sessionManager, modelRegistry);

		// Canned model: lets the session run a REAL turn below without an API
		// key, so agent_start can be observed with goal mode active.
		const mock = createMockModel({
			responses: [{ content: ["working on the persisted goal"], stopReason: "stop" }],
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: initialTools,
					messages: [],
				},
				streamFn: mock.stream,
			}),
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
			extensionRunner,
		});
		cleanups.push(async () => {
			await session?.dispose();
		});

		const goalToolSession = {
			...bootstrapToolSession,
			getGoalModeState: () => session?.getGoalModeState(),
			getGoalRuntime: () => session?.goalRuntime,
		} as unknown as ToolSession;
		toolRegistry.set("goal", new GoalTool(goalToolSession) as unknown as Tool);

		// Persisted active goal in the transcript: the adapter's initial
		// controller.restore() must reconcile this entry before session_start.
		session.sessionManager.appendModeChange("goal", {
			goal: {
				id: GOAL_ID,
				objective: "Persisted goal from a resumed RPC session",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});

		// Drive the PRODUCTION startup sequence. The output sink is the helper's
		// subscriber; the init options mirror runRpcMode's (minus the deferred
		// emitSessionStart flag, which the helper forces to false).
		const receivedEvents: AgentSessionEvent[] = [];
		const detachGoalAdapter = await runRpcSessionStartup(
			session,
			event => {
				receivedEvents.push(event);
			},
			{
				reportSendError: (_action, error) => {
					observed.runtimeErrors.push(error.message);
				},
				reportRuntimeError: error => {
					observed.runtimeErrors.push(error.error);
				},
			},
		);
		cleanups.push(detachGoalAdapter);

		// (a) Client-signal contract: the subscriber is installed BEFORE
		// restore, so restore's goal_updated is the FIRST event the client sees
		// — nothing spurious precedes it (runner.initialize schedules only
		// extension-handler drains, never agent events), and the goal id proves
		// it is the restored goal's event.
		expect(receivedEvents[0]?.type).toBe("goal_updated");
		const goalUpdatedEvents = receivedEvents.filter(event => event.type === "goal_updated");
		expect(goalUpdatedEvents[0]?.goal?.id).toBe(GOAL_ID);

		// Restore ran between init and session_start: state set + goal tool
		// exposed the moment the adapter attached.
		expect(session.getGoalModeState()?.goal?.id).toBe(GOAL_ID);
		expect(session.getEnabledToolNames()).toContain("goal");

		// (b) + (c) session_start fires exactly once, from the helper's FINAL
		// emit step (never during initializeExtensions), and its handler
		// observes the restored session. The extension event order proves
		// restore's goal_updated precedes session_start in the extension stream;
		// a reverted order (session_start during init, or attach after
		// session_start) fails these assertions.
		expect(extensionEventOrder).toEqual(["goal_updated", "session_start"]);
		expect(observed.sessionStartRuns).toBe(1);
		expect(observed.goalAtSessionStart?.goal?.id).toBe(GOAL_ID);
		expect(observed.activeToolsAtSessionStart).toContain("goal");

		// The runner was initialized before restore (initializeExtensions ran
		// first), so the goal_updated handler executed against the restored
		// session with no runtime errors.
		expect(observed.goalUpdatedRuns).toBeGreaterThan(0);
		expect(observed.goalIdAtGoalUpdated).toBe(GOAL_ID);
		expect(observed.runtimeErrors).toEqual([]);

		// A session_start-triggered turn would run in goal mode. A full turn
		// needs a model, so the state observation above (goal state + enabled
		// `goal` tool — exactly what a turn reads) is the proxy; in addition,
		// drive a REAL no-API turn through the canned mock provider the
		// AgentSession supports and confirm agent_start fires with goal mode
		// active.
		const goalAtAgentStart: Array<{ goalId: string | undefined; tools: string[] }> = [];
		const turnProbe = session.subscribe(event => {
			if (event.type === "agent_start") {
				goalAtAgentStart.push({
					goalId: session.getGoalModeState()?.goal?.id,
					tools: session.getEnabledToolNames(),
				});
			}
		});
		cleanups.push(turnProbe);

		await session.sendUserMessage("Continue working toward the persisted goal");
		await session.waitForIdle();

		expect(mock.calls.length).toBeGreaterThan(0);
		expect(goalAtAgentStart).toHaveLength(1);
		expect(goalAtAgentStart[0]?.goalId).toBe(GOAL_ID);
		expect(goalAtAgentStart[0]?.tools).toContain("goal");
	});

	it("holds buffered mcp_notification until the goal is restored so a handler-sent turn runs in goal mode", async () => {
		const root = tempDir.path();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		cleanups.push(async () => {
			authStorage.close();
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"goal.enabled": true,
			"plan.enabled": true,
		});
		const bootstrapToolSession = {
			cwd: root,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
		const initialTools = await createTools(bootstrapToolSession, ["read", "edit"]);
		const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));

		// Extension whose mcp_notification handler does exactly what the gate
		// must protect against: it starts a turn via pi.sendUserMessage. The
		// handler records the goal state it observes; the extension event order
		// proves the notification delivered only after restore's goal_updated.
		let session: AgentSession | undefined;
		const extensionEventOrder: string[] = [];
		const observed = {
			notificationRuns: 0,
			goalIdAtNotification: undefined as string | undefined,
			sendErrors: [] as string[],
			runtimeErrors: [] as string[],
		};
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("goal_updated", (_event, _ctx) => {
					extensionEventOrder.push("goal_updated");
				});
				pi.on("mcp_notification", (_event, _ctx) => {
					extensionEventOrder.push("mcp_notification");
					observed.notificationRuns++;
					// The gate must deliver this only AFTER the persisted goal is
					// restored; the goal state the handler observes is the proof.
					observed.goalIdAtNotification = session?.getGoalModeState()?.goal?.id;
					pi.sendUserMessage("A notification-driven turn");
				});
				pi.on("session_start", (_event, _ctx) => {
					extensionEventOrder.push("session_start");
				});
			},
			root,
			new EventBus(),
			extensionRuntime,
			"rpc-goal-ordering-notification",
		);
		const sessionManager = SessionManager.create(root, root);
		const extensionRunner = new ExtensionRunner([extension], extensionRuntime, root, sessionManager, modelRegistry);

		const mock = createMockModel({
			responses: [{ content: ["handled the notification"], stopReason: "stop" }],
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: initialTools,
					messages: [],
				},
				streamFn: mock.stream,
			}),
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
			extensionRunner,
		});
		cleanups.push(async () => {
			await session?.dispose();
		});

		const goalToolSession = {
			...bootstrapToolSession,
			getGoalModeState: () => session?.getGoalModeState(),
			getGoalRuntime: () => session?.goalRuntime,
		} as unknown as ToolSession;
		toolRegistry.set("goal", new GoalTool(goalToolSession) as unknown as Tool);

		session.sessionManager.appendModeChange("goal", {
			goal: {
				id: GOAL_ID,
				objective: "Persisted goal from a resumed RPC session",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});

		// Buffer a notification BEFORE initialize: the runner is uninitialized
		// at this point, so emitMcpNotification buffers it. With the delivery
		// gate engaged, initialize must NOT drain it (the notification survives
		// to resumeRuntimeEventDelivery, after the restore).
		await session.extensionRunner!.emitMcpNotification({
			server: "test-server",
			method: "notifications/custom_event",
			params: {},
		});

		// agent_start probe installed BEFORE startup: the notification
		// handler's turn fires during startup (inside resume), so the probe
		// must already be subscribed. Same for the agent_end signal below —
		// pi.sendUserMessage is fire-and-forget, so the turn completes
		// asynchronously and waitForIdle() alone can return while the prompt is
		// still in pre-stream setup.
		const goalAtAgentStart: Array<{ goalId: string | undefined; tools: string[] }> = [];
		const { promise: turnEnded, resolve: resolveTurnEnded } = Promise.withResolvers<void>();
		const turnProbe = session.subscribe(event => {
			if (event.type === "agent_start") {
				goalAtAgentStart.push({
					goalId: session.getGoalModeState()?.goal?.id,
					tools: session.getEnabledToolNames(),
				});
			} else if (event.type === "agent_end") {
				resolveTurnEnded();
			}
		});
		cleanups.push(turnProbe);

		const receivedEvents: AgentSessionEvent[] = [];
		const detachGoalAdapter = await runRpcSessionStartup(
			session,
			event => {
				receivedEvents.push(event);
			},
			{
				reportSendError: (_action, error) => {
					observed.sendErrors.push(error.message);
				},
				reportRuntimeError: error => {
					observed.runtimeErrors.push(error.error);
				},
			},
		);
		cleanups.push(detachGoalAdapter);

		// The turn the notification handler started runs asynchronously
		// (pi.sendUserMessage is fire-and-forget); wait for its agent_end, then
		// settle post-prompt recovery before asserting on it.
		await turnEnded;
		await session.waitForIdle();

		// The gate delivered the buffered notification only after restore: the
		// handler ran exactly once, observed the restored goal, and the turn it
		// started fired agent_start with goal mode ACTIVE (goal tool enabled +
		// goalModeState.goal.id === the persisted goal id).
		expect(observed.notificationRuns).toBe(1);
		expect(observed.goalIdAtNotification).toBe(GOAL_ID);
		expect(mock.calls.length).toBeGreaterThan(0);
		expect(goalAtAgentStart).toHaveLength(1);
		expect(goalAtAgentStart[0]?.goalId).toBe(GOAL_ID);
		expect(goalAtAgentStart[0]?.tools).toContain("goal");
		expect(observed.sendErrors).toEqual([]);
		expect(observed.runtimeErrors).toEqual([]);

		// goal_updated is NOT gated: restore delivered it during attach, ahead
		// of the gated mcp_notification, which itself precedes session_start.
		expect(extensionEventOrder).toEqual(["goal_updated", "mcp_notification", "session_start"]);
		expect(receivedEvents[0]?.type).toBe("goal_updated");
	});
});
