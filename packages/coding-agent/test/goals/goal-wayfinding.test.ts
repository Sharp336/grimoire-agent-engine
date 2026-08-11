import { describe, expect, it } from "bun:test";
import { GoalRuntime, type GoalRuntimeHost, renderGoalPrompt } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type {
	Goal,
	GoalModeState,
	GoalRuntimeEvent,
	GoalTokenUsage,
	GoalWayfindingState,
} from "@oh-my-pi/pi-coding-agent/goals/state";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createUsage(): GoalTokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function cloneWayfinding(state: GoalWayfindingState | undefined): GoalWayfindingState | undefined {
	if (!state) return undefined;
	return {
		...state,
		waypoint: { ...state.waypoint },
		lastObservation: state.lastObservation ? { ...state.lastObservation } : undefined,
		blockers: state.blockers ? [...state.blockers] : undefined,
		assumptions: state.assumptions ? [...state.assumptions] : undefined,
	};
}

function cloneGoal(goal: Goal): Goal {
	return { ...goal, wayfinding: cloneWayfinding(goal.wayfinding) };
}

function cloneState(state: GoalModeState | undefined): GoalModeState | undefined {
	return state ? { ...state, goal: cloneGoal(state.goal) } : undefined;
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship the adaptive goal safely",
		status: "active",
		tokenBudget: 100,
		tokensUsed: 42,
		timeUsedSeconds: 7,
		createdAt: 10,
		updatedAt: 10,
		...overrides,
	};
}

function createHarness(goal = createGoal()) {
	let state: GoalModeState | undefined = { enabled: true, mode: "active", goal: cloneGoal(goal) };
	let now = 20;
	const events: GoalRuntimeEvent[] = [];
	const persists: Array<{ mode: "goal" | "goal_paused" | "none"; state?: GoalModeState }> = [];
	const host: GoalRuntimeHost = {
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next);
		},
		getCurrentUsage: createUsage,
		emit: async event => {
			events.push(event);
		},
		persist: (mode, persistedState) => {
			persists.push({ mode, state: cloneState(persistedState) });
		},
		sendHiddenMessage: async () => {},
		now: () => now,
	};
	return {
		runtime: new GoalRuntime(host),
		getState: () => cloneState(state),
		setNow: (value: number) => {
			now = value;
		},
		events,
		persists,
	};
}

function createToolSession(overrides: Partial<ToolSession>): ToolSession {
	return overrides as ToolSession;
}

describe("goal wayfinding", () => {
	it("atomically adds a bounded waypoint without resetting identity or accounting", async () => {
		const harness = createHarness();
		const blockers = ["  Missing credential  ", "Missing credential", " "];
		const assumptions = ["SDK v2 is authoritative"];

		const next = await harness.runtime.updateGoalWayfinding({
			goalId: " goal-1 ",
			expectedRevision: 0,
			focus: "  Verify the provider boundary  ",
			waypoint: {
				action: " Inspect the SDK adapter ",
				rationale: " The endpoint assumption is unverified ",
				guidance: " Read only; do not edit yet ",
				successSignal: " Authoritative request shape is identified ",
				replanIf: " The adapter delegates to a different transport ",
			},
			lastObservation: { outcome: "unexpected", summary: " The documented endpoint is absent " },
			blockers,
			assumptions,
		});

		expect(next.goal).toMatchObject({
			id: "goal-1",
			objective: "Ship the adaptive goal safely",
			status: "active",
			tokenBudget: 100,
			tokensUsed: 42,
			timeUsedSeconds: 7,
			createdAt: 10,
			updatedAt: 20,
			wayfinding: {
				revision: 1,
				focus: "Verify the provider boundary",
				waypoint: {
					action: "Inspect the SDK adapter",
					rationale: "The endpoint assumption is unverified",
					guidance: "Read only; do not edit yet",
					successSignal: "Authoritative request shape is identified",
					replanIf: "The adapter delegates to a different transport",
				},
				lastObservation: { outcome: "unexpected", summary: "The documented endpoint is absent" },
				blockers: ["Missing credential"],
				assumptions: ["SDK v2 is authoritative"],
			},
		});
		expect(harness.persists.at(-1)).toMatchObject({ mode: "goal", state: { goal: { id: "goal-1" } } });

		blockers[0] = "mutated after commit";
		assumptions.push("mutated after commit");
		expect(harness.getState()?.goal.wayfinding?.blockers).toEqual(["Missing credential"]);
		expect(harness.getState()?.goal.wayfinding?.assumptions).toEqual(["SDK v2 is authoritative"]);
	});

	it("serializes concurrent writers so a stale revision cannot overwrite the winning route", async () => {
		const harness = createHarness();
		const [first, second] = await Promise.allSettled([
			harness.runtime.updateGoalWayfinding({
				goalId: "goal-1",
				expectedRevision: 0,
				waypoint: { action: "Inspect adapter", rationale: "Verify the boundary" },
			}),
			harness.runtime.updateGoalWayfinding({
				goalId: "goal-1",
				expectedRevision: 0,
				waypoint: { action: "Apply stale route", rationale: "Late writer" },
			}),
		]);

		expect(first.status).toBe("fulfilled");
		expect(second.status).toBe("rejected");
		if (second.status !== "rejected") throw new Error("expected the second writer to be rejected");
		expect(second.reason).toBeInstanceOf(Error);
		expect((second.reason as Error).message).toContain("current revision is 1, received expected_revision 0");
		expect(harness.getState()?.goal.wayfinding).toMatchObject({
			revision: 1,
			waypoint: { action: "Inspect adapter" },
		});
		expect(harness.persists).toHaveLength(1);
	});

	it("replaces the full snapshot and clears optional route fields that are no longer supplied", async () => {
		const harness = createHarness();
		await harness.runtime.updateGoalWayfinding({
			goalId: "goal-1",
			expectedRevision: 0,
			focus: "Provider boundary",
			waypoint: { action: "Inspect adapter", rationale: "Verify the boundary" },
			blockers: ["Missing credential"],
			assumptions: ["SDK v2 is authoritative"],
		});

		const next = await harness.runtime.updateGoalWayfinding({
			goalId: "goal-1",
			expectedRevision: 1,
			waypoint: { action: "Run the focused test", rationale: "The request shape is now proven" },
		});

		expect(next.goal.wayfinding).toEqual({
			revision: 2,
			focus: undefined,
			waypoint: {
				action: "Run the focused test",
				rationale: "The request shape is now proven",
				guidance: undefined,
				successSignal: undefined,
				replanIf: undefined,
			},
			lastObservation: undefined,
			blockers: undefined,
			assumptions: undefined,
		});
	});

	it("rejects updates for a replaced goal id", async () => {
		const harness = createHarness();
		const before = harness.getState();

		await expect(
			harness.runtime.updateGoalWayfinding({
				goalId: "old-goal",
				expectedRevision: 0,
				waypoint: { action: "Inspect adapter", rationale: "Verify the boundary" },
			}),
		).rejects.toThrow("current goal is goal-1, received goal_id old-goal");

		expect(harness.getState()).toEqual(before);
		expect(harness.persists).toHaveLength(0);
	});

	it("preserves the committed waypoint across pause and resume", async () => {
		const harness = createHarness();
		await harness.runtime.updateGoalWayfinding({
			goalId: "goal-1",
			expectedRevision: 0,
			waypoint: { action: "Run the integration test", rationale: "Implementation is complete" },
		});
		const committed = harness.getState()?.goal.wayfinding;

		const paused = await harness.runtime.pauseGoal();
		expect(paused?.goal.status).toBe("paused");
		expect(paused?.goal.wayfinding).toEqual(committed);

		const resumed = await harness.runtime.resumeGoal();
		expect(resumed.goal.status).toBe("active");
		expect(resumed.goal.wayfinding).toEqual(committed);
	});

	it("allows a final navigation snapshot at the budget limit but rejects paused goals", async () => {
		const limited = createHarness(createGoal({ status: "budget-limited", tokensUsed: 100 }));
		const next = await limited.runtime.updateGoalWayfinding({
			goalId: "goal-1",
			expectedRevision: 0,
			waypoint: { action: "Resume with integration test", rationale: "Implementation is staged" },
			lastObservation: { outcome: "partial", summary: "Unit tests passed before the budget limit" },
		});
		expect(next.goal.status).toBe("budget-limited");
		expect(next.goal.wayfinding?.revision).toBe(1);

		const paused = createHarness(createGoal({ status: "paused" }));
		await expect(
			paused.runtime.updateGoalWayfinding({
				goalId: "goal-1",
				expectedRevision: 0,
				waypoint: { action: "Continue", rationale: "Work remains" },
			}),
		).rejects.toThrow("cannot update goal wayfinding while goal status is paused");
	});

	it("escapes persisted wayfinding text before prompt injection", () => {
		const goal = createGoal({
			objective: "Fix <root>&safe",
			wayfinding: {
				revision: 3,
				focus: "<focus>&",
				waypoint: {
					action: "<action>&",
					rationale: "<why>&",
					guidance: "<guide>&",
					successSignal: "<success>&",
					replanIf: "<replan>&",
				},
				lastObservation: { outcome: "unexpected", summary: "<observation>&" },
				blockers: ["<blocker>&"],
				assumptions: ["<assumption>&"],
			},
		});

		const rendered = renderGoalPrompt("continuation", goal);
		expect(rendered).toContain('<wayfinding revision="3">');
		expect(rendered).toContain("&lt;action&gt;&amp;");
		expect(rendered).toContain("&lt;observation&gt;&amp;");
		expect(rendered).toContain("&lt;blocker&gt;&amp;");
		expect(rendered).not.toContain("<action><action>&");
		expect(rendered).not.toContain("<summary><observation>&");
	});

	it("routes goal.update and returns the id plus the committed revision", async () => {
		const harness = createHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-update", {
			op: "update",
			goal_id: "goal-1",
			expected_revision: 0,
			focus: "Provider compatibility",
			next_action: "Inspect the installed SDK types",
			why: "The assumed endpoint is not authoritative",
			guidance: "Do not edit until the request shape is proven",
			success_signal: "One authoritative request type is identified",
			replan_if: "The SDK delegates to generated code",
			outcome: "unexpected",
			observation: "The documented endpoint is missing",
			blockers: ["Credential unavailable"],
			assumptions: ["Installed SDK matches runtime"],
		});

		expect(result.details).toMatchObject({
			op: "update",
			goal: { id: "goal-1", wayfinding: { revision: 1 } },
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Goal ID: goal-1\nWayfinding revision: 1"),
		});
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("Next action: Inspect the installed SDK types"),
		});
	});

	it("requires observation and outcome as one atomic pair", async () => {
		const harness = createHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-update", {
				op: "update",
				goal_id: "goal-1",
				expected_revision: 0,
				next_action: "Inspect adapter",
				why: "Verify the boundary",
				observation: "The endpoint is absent",
			}),
		).rejects.toThrow("outcome and observation must be provided together");
		expect(harness.getState()?.goal.wayfinding).toBeUndefined();
	});

	it("rejects oversized route fields before persistence", async () => {
		const harness = createHarness();
		await expect(
			harness.runtime.updateGoalWayfinding({
				goalId: "goal-1",
				expectedRevision: 0,
				waypoint: { action: "x".repeat(1_001), rationale: "Verify the boundary" },
			}),
		).rejects.toThrow("next_action must be at most 1000 characters");
		expect(harness.persists).toHaveLength(0);
	});
});
