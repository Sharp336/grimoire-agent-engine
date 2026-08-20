import { describe, expect, it } from "bun:test";
import { PrewalkCoordinator } from "@oh-my-pi/pi-coding-agent/session/prewalk";

describe("PrewalkCoordinator plan-yolo arming", () => {
	it("arms from the caller's slate, not a Code Mode transport eval", async () => {
		const applied: string[][] = [];
		const presentations: Array<{ enabled: string[]; mounted: string[] }> = [];
		const host = {
			agent: { steer: () => {} },
			setActiveToolsByName: async (names: string[]) => {
				applied.push(names);
			},
			setActiveToolPresentation: async (enabled: string[], mounted: string[]) => {
				presentations.push({ enabled, mounted });
			},
			// Code Mode injected `eval` as the bridge transport; the caller asked for `read`.
			getEnabledToolNames: () => ["read", "eval"],
			callerRequestedToolNames: () => ["read"],
			getMountedXdevToolNames: () => [],
			hasBuiltInTool: (name: string) => name === "write",
			setPlanModeState: () => {},
			getPlanReferencePath: () => "local://PLAN.md",
			setPlanProposalHandler: () => {},
		} as never;
		const coordinator = new PrewalkCoordinator(host, { planYolo: { enabled: true } as never });

		await coordinator.armPlanYoloIfNeeded();

		expect(applied).toEqual([["read", "write"]]);
	});
});
