import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalModeController } from "@oh-my-pi/pi-coding-agent/goals/goal-mode-controller";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

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

type Harness = {
	session: AgentSession;
	controller: GoalModeController;
	sessionManager: SessionManager;
	toolSession: ToolSession;
	tempDir: TempDir;
	cleanup: () => Promise<void>;
};

type SharedFixture = {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model;
	baseDir: TempDir;
};

async function createSharedFixture(): Promise<SharedFixture> {
	const baseDir = TempDir.createSync("@pi-goal-controller-");
	const authStorage = await AuthStorage.create(path.join(baseDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	return { authStorage, modelRegistry, model, baseDir };
}

async function createHarness(shared: SharedFixture, options: { goalEnabled?: boolean } = {}): Promise<Harness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-controller-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const goalEnabled = options.goalEnabled ?? true;
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": goalEnabled,
		"plan.enabled": true,
	});
	const bootstrapToolSession = createToolSession(tempDir.path(), settings);
	const initialTools = await createTools(bootstrapToolSession, ["read", "edit"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: shared.model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry: shared.modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const toolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
	});
	if (goalEnabled) {
		toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);
	}
	return {
		session,
		controller: session.goalModeController,
		sessionManager: session.sessionManager,
		toolSession,
		tempDir,
		cleanup: async () => {
			await session.dispose();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

describe("GoalModeController", () => {
	let shared: SharedFixture;

	beforeAll(async () => {
		shared = await createSharedFixture();
	});

	afterAll(() => {
		shared.authStorage.close();
		shared.baseDir.removeSync();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("enter toggles the goal tool, sets enabled state, and returns {ok:true,prompt:objective}", async () => {
		const harness = await createHarness(shared);
		try {
			await harness.session.setActiveToolsByName(["read", "edit"]);
			expect(harness.session.getActiveToolNames()).not.toContain("goal");

			const result = await harness.controller.enter("Ship the release");

			expect(result).toEqual({ ok: true, prompt: "Ship the release" });
			expect(harness.session.getGoalModeState()?.enabled).toBe(true);
			expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
			expect(harness.session.getActiveToolNames()).toContain("goal");
			expect(harness.controller.previousTools).toEqual(["read", "edit"]);
		} finally {
			await harness.cleanup();
		}
	});

	it("enter rejects when goal.enabled is false", async () => {
		const harness = await createHarness(shared, { goalEnabled: false });
		try {
			const result = await harness.controller.enter("Ship the release");

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe("Goal mode is disabled. Enable it in settings (goal.enabled).");
			}
			expect(harness.session.getGoalModeState()).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});

	it("enter rejects while plan mode is active on the session", async () => {
		const harness = await createHarness(shared);
		try {
			harness.session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });

			const result = await harness.controller.enter("Ship the release");

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe("Exit plan mode first.");
			}
			expect(harness.session.getGoalModeState()).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});

	it("drop restores the previous tool set and clears the goal state", async () => {
		const harness = await createHarness(shared);
		try {
			await harness.session.setActiveToolsByName(["read", "edit"]);
			await harness.controller.enter("Ship the release");
			expect(harness.session.getActiveToolNames()).toContain("goal");

			const result = await harness.controller.drop();

			expect(result.ok).toBe(true);
			expect(harness.session.getGoalModeState()).toBeUndefined();
			expect(harness.session.getActiveToolNames()).toEqual(["read", "edit"]);
			expect(harness.session.getActiveToolNames()).not.toContain("goal");
			expect(harness.controller.previousTools).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});

	it("pause removes the goal tool, then resume re-adds it", async () => {
		// Contract (shared with headless adapters): pause keeps the goal record
		// but drops the goal tool from the active set; resume re-adds it. The
		// core owns this so ACP/RPC `/goal pause` does not strand the goal tool.
		const harness = await createHarness(shared);
		try {
			await harness.session.setActiveToolsByName(["read", "edit"]);
			await harness.controller.enter("Ship the release");
			expect(harness.session.getActiveToolNames()).toContain("goal");
			expect(harness.controller.previousTools).toEqual(["read", "edit"]);

			const paused = await harness.controller.pause();

			expect(paused.ok).toBe(true);
			expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
			expect(harness.session.getActiveToolNames()).not.toContain("goal");
			expect(harness.session.getActiveToolNames()).toEqual(["read", "edit"]);
			expect(harness.controller.previousTools).toBeUndefined();

			const resumed = await harness.controller.resume();

			expect(resumed.ok).toBe(true);
			expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
			expect(harness.session.getActiveToolNames()).toContain("goal");
			expect(harness.controller.previousTools).toEqual(["read", "edit"]);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects pause and budget on a paused goal (must resume first)", async () => {
		// Contract (matches TUI fix #5): a paused goal is not actionable for
		// pause/budget — resume first. Headless adapters rely on the controller
		// guard since they don't run the TUI's own paused checks.
		const harness = await createHarness(shared);
		try {
			await harness.session.setActiveToolsByName(["read", "edit"]);
			await harness.controller.enter("Ship the release");
			await harness.controller.pause();
			expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");

			const rePause = await harness.controller.pause();
			expect(rePause.ok).toBe(false);

			const budget = await harness.controller.setBudget(100);
			expect(budget.ok).toBe(false);
			// Budget must not have been mutated while paused.
			expect(harness.session.getGoalModeState()?.goal.tokenBudget).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});

	it("replaceObjective requires an active goal", async () => {
		const harness = await createHarness(shared);
		try {
			const result = await harness.controller.replaceObjective("Replace the objective");

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("cannot replace goal");
			}
			expect(harness.session.getGoalModeState()).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});

	it("resume re-adds the goal tool after a deactivated exit", async () => {
		const harness = await createHarness(shared);
		try {
			await harness.session.setActiveToolsByName(["read", "edit"]);
			await harness.controller.enter("Ship the release");
			await harness.controller.deactivate({ restoreTools: true });
			expect(harness.session.getActiveToolNames()).not.toContain("goal");

			const result = await harness.controller.resume();

			expect(result.ok).toBe(true);
			expect(harness.session.getGoalModeState()?.enabled).toBe(true);
			expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
			expect(harness.session.getActiveToolNames()).toContain("goal");
		} finally {
			await harness.cleanup();
		}
	});

	it("setBudget delegates to the runtime and preserves accumulated usage", async () => {
		const harness = await createHarness(shared);
		try {
			await harness.controller.enter("Ship the release");
			const goal = harness.session.getGoalModeState()?.goal;
			if (!goal) throw new Error("expected active goal");
			goal.tokensUsed = 42;
			goal.timeUsedSeconds = 5;
			const onBudgetMutated = vi.spyOn(harness.session.goalRuntime, "onBudgetMutated");

			const result = await harness.controller.setBudget(123);

			expect(result.ok).toBe(true);
			expect(onBudgetMutated).toHaveBeenCalledWith(123);
			const after = harness.session.getGoalModeState();
			expect(after?.goal.tokenBudget).toBe(123);
			expect(after?.goal.tokensUsed).toBe(42);
			expect(after?.goal.timeUsedSeconds).toBe(5);
		} finally {
			await harness.cleanup();
		}
	});

	it("show() reflects the active goal state and reports 'No goal set.' otherwise", async () => {
		const harness = await createHarness(shared);
		try {
			expect(harness.controller.show()).toBe("No goal set.");

			await harness.controller.enter("Ship the release");
			const text = harness.controller.show();

			expect(text).toContain("Objective: Ship the release");
			expect(text).toContain("Status: active");
			expect(text).toContain("Tokens:");
		} finally {
			await harness.cleanup();
		}
	});

	it("buildContinuationForSubmission returns a prompt when active and the turn made tool calls", async () => {
		const harness = await createHarness(shared);
		try {
			await harness.controller.enter("Ship the release");
			harness.controller.onToolStart();

			const decision = harness.controller.buildContinuationForSubmission();

			expect(decision).not.toBeNull();
			expect(decision?.prompt).toBeTruthy();
			expect(decision?.prompt).toContain("Ship the release");
		} finally {
			await harness.cleanup();
		}
	});

	it("buildContinuationForSubmission returns a prompt even when a normal turn made no tool calls", async () => {
		// A non-continuation turn never arms suppression, so the decision stays
		// live regardless of whether the turn made tool calls. Only a CONTINUATION
		// turn with no tool calls suppresses (covered below).
		const harness = await createHarness(shared);
		try {
			await harness.controller.enter("Ship the release");

			const decision = harness.controller.buildContinuationForSubmission();

			expect(decision).not.toBeNull();
			expect(decision?.prompt).toContain("Ship the release");
		} finally {
			await harness.cleanup();
		}
	});

	it("buildContinuationForSubmission returns null when a no-tool-call continuation is suppressed", async () => {
		const harness = await createHarness(shared);
		try {
			await harness.controller.enter("Ship the release");
			// A continuation turn that made no tool calls arms the suppression.
			harness.controller.markContinuationInFlight();
			await harness.controller.onAgentEnd();
			expect(harness.controller.isContinuationSuppressed()).toBe(true);

			expect(harness.controller.buildContinuationForSubmission()).toBeNull();
		} finally {
			await harness.cleanup();
		}
	});

	it("buildContinuationForSubmission returns null while the goal is paused", async () => {
		const harness = await createHarness(shared);
		try {
			await harness.controller.enter("Ship the release");
			harness.controller.onToolStart();
			await harness.controller.pause();

			expect(harness.controller.buildContinuationForSubmission()).toBeNull();
		} finally {
			await harness.cleanup();
		}
	});

	it("restore reconstructs goal mode from a persisted mode_change entry", async () => {
		const harness = await createHarness(shared);
		try {
			await harness.session.setActiveToolsByName(["read", "edit"]);
			const now = Date.now();
			harness.sessionManager.appendModeChange("goal", {
				goal: {
					id: "g1",
					objective: "Persisted objective",
					status: "active",
					tokensUsed: 7,
					timeUsedSeconds: 3,
					createdAt: now,
					updatedAt: now,
				},
			});

			const restored = await harness.controller.restore({ preserveActiveGoal: true });

			expect(restored?.goal.objective).toBe("Persisted objective");
			expect(harness.session.getGoalModeState()?.goal.objective).toBe("Persisted objective");
			expect(harness.session.getGoalModeState()?.goal.tokensUsed).toBe(7);
			expect(harness.session.getActiveToolNames()).toContain("goal");
			expect(harness.controller.previousTools).toEqual(["read", "edit"]);
		} finally {
			await harness.cleanup();
		}
	});

	it("restore pauses a persisted active goal unless preserveActiveGoal is set", async () => {
		const harness = await createHarness(shared);
		try {
			const now = Date.now();
			harness.sessionManager.appendModeChange("goal", {
				goal: {
					id: "g2",
					objective: "Paused on restore",
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: now,
					updatedAt: now,
				},
			});

			const restored = await harness.controller.restore();

			expect(restored?.enabled).toBe(false);
			expect(restored?.goal.status).toBe("paused");
		} finally {
			await harness.cleanup();
		}
	});

	it("schedules continuation after a normal turn that made no tool calls", async () => {
		// Contract: a user-initiated (non-continuation) turn that yields without any
		// tool calls must NOT suppress the next continuation. Only a CONTINUATION turn
		// with no tool calls arms suppression (anti-talk-loop). Mirrors the original
		// #scheduleGoalContinuation / #goalContinuationTurnInFlight semantics.
		const harness = await createHarness(shared);
		try {
			await harness.controller.enter("Ship the release");

			harness.controller.onAgentStart();
			// (no onToolStart — the agent talked but did not act)
			const decision = await harness.controller.onAgentEnd();

			expect(decision).not.toBeNull();
			if (decision) expect(decision.prompt).toContain("Ship the release");
		} finally {
			await harness.cleanup();
		}
	});

	it("suppresses the next continuation only after a continuation turn with no tool calls", async () => {
		const harness = await createHarness(shared);
		try {
			await harness.controller.enter("Ship the release");

			// A continuation turn that makes no tool calls arms suppression and
			// returns no continuation decision.
			harness.controller.markContinuationInFlight();
			harness.controller.onAgentStart();
			const stalled = await harness.controller.onAgentEnd();
			expect(stalled).toBeNull();

			// After reset, a continuation turn that DOES make tool calls keeps
			// continuation live.
			harness.controller.resetContinuationSuppression();
			harness.controller.markContinuationInFlight();
			harness.controller.onAgentStart();
			harness.controller.onToolStart();
			const progressing = await harness.controller.onAgentEnd();
			expect(progressing).not.toBeNull();
		} finally {
			await harness.cleanup();
		}
	});
});
