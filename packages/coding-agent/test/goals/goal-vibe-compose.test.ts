/**
 * Contracts: /vibe ∘ /goal composition (goal-guided vibe mode).
 *
 * 1. Both entry orders compose: the active toolset becomes read + vibe tools +
 *    goal, and each mode exits back to the correct toolset regardless of order.
 * 2. The combined mode persists as a "goal" mode-change entry carrying
 *    `vibe: true`, and a fresh InteractiveMode resumes BOTH modes from it.
 * 3. Goal auto-continuation defers while a vibe worker turn is in flight and
 *    fires the director-variant continuation when workers are idle.
 * 4. Goal completion leaves vibe mode (and its toolset) active.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	};
}

function createGoalRecord(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship the release",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

type ComposeHarness = {
	tempDir: TempDir;
	settings: Settings;
	session: AgentSession;
	sessionManager: SessionManager;
	mode: InteractiveMode;
	cleanup: () => Promise<void>;
};

type SharedFixture = {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model;
	baseDir: TempDir;
};

async function createSharedFixture(): Promise<SharedFixture> {
	const baseDir = TempDir.createSync("@pi-goal-vibe-shared-");
	const authStorage = await AuthStorage.create(path.join(baseDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	return { authStorage, modelRegistry, model, baseDir };
}

async function createComposeHarness(
	shared: SharedFixture,
	options: { sessionManager?: SessionManager } = {},
): Promise<ComposeHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-vibe-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"plan.enabled": true,
	});
	const bootstrapToolSession = createToolSession(tempDir.path(), settings);
	// Pin the baseline to exactly `read` (createTools also emits companions like
	// `resolve`) so toolset assertions stay deterministic.
	const initialTools = (await createTools(bootstrapToolSession, ["read"])).filter(tool => tool.name === "read");
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));
	const sessionManager = options.sessionManager ?? SessionManager.create(tempDir.path(), tempDir.path());

	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: shared.model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager,
		settings,
		modelRegistry: shared.modelRegistry,
		toolRegistry,
		createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test");
	const toolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
	});
	toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);

	return {
		tempDir,
		settings,
		session,
		sessionManager,
		mode,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

function activeToolsSorted(harness: ComposeHarness): string[] {
	return harness.session.getActiveToolNames().toSorted();
}

const COMBINED_TOOLS = ["read", "goal", ...VIBE_TOOL_NAMES].toSorted();
const VIBE_ONLY_TOOLS = ["read", ...VIBE_TOOL_NAMES].toSorted();

async function waitForMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

function makeWorkerResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

describe("goal-guided vibe mode composition", () => {
	let shared: SharedFixture;
	let harness: ComposeHarness;

	beforeAll(async () => {
		await initTheme();
		shared = await createSharedFixture();
	});

	afterAll(() => {
		shared.authStorage.close();
		shared.baseDir.removeSync();
	});

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
		harness = await createComposeHarness(shared);
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await harness.cleanup();
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("composes and unwinds the toolset for vibe-then-goal", async () => {
		expect(activeToolsSorted(harness)).toEqual(["read"]);

		await harness.mode.handleVibeModeCommand();
		expect(harness.mode.vibeModeEnabled).toBe(true);
		expect(activeToolsSorted(harness)).toEqual(VIBE_ONLY_TOOLS);

		await harness.mode.handleGoalModeCommand("Ship the release");
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.mode.vibeModeEnabled).toBe(true);
		expect(activeToolsSorted(harness)).toEqual(COMBINED_TOOLS);

		// Exit goal (drop) while vibe stays on: back to the vibe-only set.
		vi.spyOn(harness.mode, "showHookConfirm").mockResolvedValue(true);
		await harness.mode.handleGoalModeCommand("drop");
		expect(harness.mode.goalModeEnabled).toBe(false);
		expect(harness.mode.vibeModeEnabled).toBe(true);
		expect(activeToolsSorted(harness)).toEqual(VIBE_ONLY_TOOLS);
		expect(harness.sessionManager.buildSessionContext().mode).toBe("vibe");

		await harness.mode.handleVibeModeCommand();
		expect(harness.mode.vibeModeEnabled).toBe(false);
		expect(activeToolsSorted(harness)).toEqual(["read"]);
	});

	it("composes and unwinds the toolset for goal-then-vibe", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		expect(activeToolsSorted(harness)).toEqual(["goal", "read"]);

		await harness.mode.handleVibeModeCommand();
		expect(harness.mode.vibeModeEnabled).toBe(true);
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(activeToolsSorted(harness)).toEqual(COMBINED_TOOLS);

		// Exit vibe while the goal stays active: full pre-vibe toolset + goal.
		await harness.mode.handleVibeModeCommand();
		expect(harness.mode.vibeModeEnabled).toBe(false);
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(activeToolsSorted(harness)).toEqual(["goal", "read"]);
		const context = harness.sessionManager.buildSessionContext();
		expect(context.mode).toBe("goal");
		expect(context.modeData?.vibe).toBeUndefined();

		vi.spyOn(harness.mode, "showHookConfirm").mockResolvedValue(true);
		await harness.mode.handleGoalModeCommand("drop");
		expect(activeToolsSorted(harness)).toEqual(["read"]);
	});

	it("persists the combined mode with vibe:true in either entry order", async () => {
		await harness.mode.handleVibeModeCommand();
		await harness.mode.handleGoalModeCommand("Ship the release");

		const context = harness.sessionManager.buildSessionContext();
		expect(context.mode).toBe("goal");
		expect(context.modeData?.vibe).toBe(true);
		const persistedGoal = context.modeData?.goal as Goal | undefined;
		expect(persistedGoal?.objective).toBe("Ship the release");
	});

	it("resumes both modes from a goal mode-change entry carrying vibe:true", async () => {
		const goal = createGoalRecord();
		harness.sessionManager.appendModeChange("goal", { goal, vibe: true });

		const resumed = await createComposeHarness(shared, { sessionManager: harness.sessionManager });
		try {
			await resumed.mode.init({ suppressWelcomeIntro: true });

			expect(resumed.mode.vibeModeEnabled).toBe(true);
			// A resumed active goal auto-pauses (onThreadResumed contract); the
			// goal tool stays active so the agent can resume/complete/drop it.
			expect(resumed.mode.goalModePaused).toBe(true);
			expect(activeToolsSorted(resumed)).toEqual(COMBINED_TOOLS);

			const context = resumed.sessionManager.buildSessionContext();
			expect(context.mode).toBe("goal_paused");
			expect(context.modeData?.vibe).toBe(true);
		} finally {
			resumed.mode.stop();
			await resumed.session.dispose();
			resumed.tempDir.removeSync();
		}
	});

	it("defers goal continuation while a worker turn is in flight and fires the director variant when idle", async () => {
		await harness.mode.handleVibeModeCommand();
		await harness.mode.handleGoalModeCommand("Ship the release");

		// Real registry turn owned by "Main" (both the interactive session and
		// the spawning tool session default to MAIN_AGENT_ID).
		const gate = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeWorkerResult(options.id);
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const spawnSession = createToolSession(harness.tempDir.path(), harness.settings, {
			asyncJobManager: manager,
		});
		const registry = VibeSessionRegistry.global();
		const { jobId } = await registry.spawn(spawnSession, { cli: "fast", name: "Fast", prompt: "Task A." });
		expect(registry.hasInFlightTurn("Main")).toBe(true);

		vi.useFakeTimers();
		let firstResolved: SubmittedUserInput | undefined;
		const first = harness.mode.getUserInput().then(input => {
			firstResolved = input;
			return input;
		});
		await waitForMicrotasks();

		// The continuation is not scheduled while the worker turn is in flight.
		vi.advanceTimersByTime(800);
		await waitForMicrotasks();
		expect(firstResolved).toBeUndefined();
		vi.useRealTimers();

		// Settle the worker turn.
		gate.resolve();
		await manager.getJob(jobId)!.promise;
		expect(registry.hasInFlightTurn("Main")).toBe(false);

		// Flush the armed waiter and clear its pending record like the run loop would.
		const noop = harness.mode.startPendingSubmission({ text: "noop" });
		harness.mode.onInputCallback?.(noop);
		harness.mode.finishPendingSubmission(await first);

		// With workers idle, the next idle window schedules and fires the
		// continuation, carrying the director (vibe) variant.
		vi.useFakeTimers();
		const second = harness.mode.getUserInput();
		await waitForMicrotasks();
		vi.advanceTimersByTime(800);
		await waitForMicrotasks();
		vi.useRealTimers();
		const continuation = await second;

		expect(continuation.customType).toBe("goal-continuation");
		expect(continuation.text).toContain("vibe_send");
		harness.mode.finishPendingSubmission(continuation);
		await manager.dispose({ timeoutMs: 1000 });
	});

	it("keeps vibe mode and its toolset alive when the goal completes", async () => {
		await harness.mode.handleVibeModeCommand();
		await harness.mode.handleGoalModeCommand("Ship the release");

		await harness.session.goalRuntime.completeGoalFromTool();
		// Completion exits goal mode at the next idle window (getUserInput awaits
		// the exit before arming its input callback).
		let resolved = false;
		const waiter = harness.mode.getUserInput().then(input => {
			resolved = true;
			return input;
		});
		await pollUntil(() => harness.mode.onInputCallback !== undefined);
		const noop = harness.mode.startPendingSubmission({ text: "noop" });
		harness.mode.onInputCallback?.(noop);
		harness.mode.finishPendingSubmission(await waiter);
		expect(resolved).toBe(true);

		expect(harness.mode.goalModeEnabled).toBe(false);
		expect(harness.mode.vibeModeEnabled).toBe(true);
		expect(activeToolsSorted(harness)).toEqual(VIBE_ONLY_TOOLS);
		expect(harness.sessionManager.buildSessionContext().mode).toBe("vibe");
	});
});
