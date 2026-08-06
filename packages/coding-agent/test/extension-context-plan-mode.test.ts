import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";

function createRunner(getPlanModeState?: () => PlanModeState | undefined): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
	return new ExtensionRunner(
		[],
		runtime,
		"/tmp",
		{ getCwd: () => "/tmp" } as never,
		{} as never,
		undefined,
		undefined,
		undefined,
		undefined,
		getPlanModeState,
	);
}

const planModeState: PlanModeState = { enabled: true, planFilePath: "local://feature-plan.md" };

describe("ExtensionRunner plan mode context", () => {
	it("defaults to undefined outside a session", () => {
		expect(createRunner().createContext().getPlanModeState()).toBeUndefined();
	});

	it("exposes the owning session state", () => {
		expect(
			createRunner(() => planModeState)
				.createContext()
				.getPlanModeState(),
		).toBe(planModeState);
	});

	// Reads must be live: a handler that spans a plan-mode toggle has to observe
	// the change through the context object it already holds. A snapshot taken at
	// createContext() time would pass every other case here and fail this one.
	it("reads live through a single context object across a toggle", () => {
		let current: PlanModeState | undefined;
		const ctx = createRunner(() => current).createContext();

		expect(ctx.getPlanModeState()).toBeUndefined();

		current = planModeState;
		expect(ctx.getPlanModeState()?.enabled).toBe(true);
		expect(ctx.getPlanModeState()?.planFilePath).toBe("local://feature-plan.md");

		current = { enabled: false, planFilePath: planModeState.planFilePath };
		expect(ctx.getPlanModeState()?.enabled).toBe(false);
	});

	// createCommandContext() spreads createContext(). A spread snapshots a getter
	// but copies a method's closure, so the command context must stay live too.
	it("stays live through the command-context spread", () => {
		let current: PlanModeState | undefined;
		const ctx = createRunner(() => current).createCommandContext();

		expect(ctx.getPlanModeState()).toBeUndefined();

		current = planModeState;
		expect(ctx.getPlanModeState()).toBe(planModeState);
	});
});
