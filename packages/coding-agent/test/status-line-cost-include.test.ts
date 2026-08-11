import { describe, expect, it } from "bun:test";
import {
	type CostSegmentInputs,
	resolveCostParts,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";

function inputs(overrides: Partial<CostSegmentInputs> = {}): CostSegmentInputs {
	return {
		include: "main-subagents-advisors",
		cost: 6,
		subagentCost: 5,
		premiumRequests: 3,
		subagentPremiumRequests: 2,
		advisorCost: 0.5,
		usingSubscription: false,
		...overrides,
	};
}

describe("resolveCostParts (statusLine.costInclude)", () => {
	it("includes subagents and advisors for the default preset", () => {
		const parts = resolveCostParts(inputs());
		expect(parts.cost).toBe(6);
		expect(parts.premiumRequests).toBe(3);
		expect(parts.advisorCost).toBeCloseTo(0.5, 8);
		expect(parts.visible).toBe(true);
	});

	it("excludes subagent cost and advisors for main-only", () => {
		const parts = resolveCostParts(inputs({ include: "main" }));
		// Main share = aggregate (6) − subagent (5); premium likewise (3 − 2).
		expect(parts.cost).toBeCloseTo(1, 8);
		expect(parts.premiumRequests).toBe(1);
		expect(parts.advisorCost).toBe(0);
	});

	it("excludes advisors but keeps subagents for main-subagents", () => {
		const parts = resolveCostParts(inputs({ include: "main-subagents" }));
		expect(parts.cost).toBe(6);
		expect(parts.premiumRequests).toBe(3);
		expect(parts.advisorCost).toBe(0);
	});

	it("includes advisors but excludes subagents for main-advisors", () => {
		const parts = resolveCostParts(inputs({ include: "main-advisors" }));
		expect(parts.cost).toBeCloseTo(1, 8);
		expect(parts.premiumRequests).toBe(1);
		expect(parts.advisorCost).toBeCloseTo(0.5, 8);
	});

	it("hides the segment when every selected source is zero and no subscription badge applies", () => {
		const parts = resolveCostParts(
			inputs({ cost: 0, subagentCost: 0, premiumRequests: 0, subagentPremiumRequests: 0, advisorCost: 0 }),
		);
		expect(parts.visible).toBe(false);
	});

	it("keeps the segment visible when only the subscription badge applies", () => {
		const parts = resolveCostParts(
			inputs({
				cost: 0,
				subagentCost: 0,
				premiumRequests: 0,
				subagentPremiumRequests: 0,
				advisorCost: 0,
				usingSubscription: true,
			}),
		);
		expect(parts.visible).toBe(true);
	});

	it("clamps the main share at zero against float drift", () => {
		const parts = resolveCostParts(inputs({ cost: 0.1, subagentCost: 0.2, include: "main" }));
		expect(parts.cost).toBe(0);
		expect(parts.premiumRequests).toBe(1);
	});
});
