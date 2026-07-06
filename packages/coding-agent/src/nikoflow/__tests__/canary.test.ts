import { describe, expect, test } from "bun:test";
import { humanGateAccepted } from "../gates";
import { advanceNikoflowAdvisorGate, nikoflowAdvisorReviewBlockers, normalizeNikoflowAdvisorReview } from "../mode";
import { advancePhase, createState, isComplete, mintGateRequest } from "../state";

describe("nikoflow gate canary", () => {
	test("blocks before native advisor review and passes after matching clean review", () => {
		const state = mintGateRequest(advancePhase(advancePhase(createState("tactical"))), "gate-current");

		expect(humanGateAccepted(1_000, 1_000)).toBe(false);
		expect(normalizeNikoflowAdvisorReview('{"gateId":"gate-current","verdict":"pass"}', state)).toBeNull();
		expect(
			normalizeNikoflowAdvisorReview(
				{ type: "tool_result", content: { gateId: "gate-current", verdict: "pass" } },
				state,
			),
		).toBeNull();

		const blocker = normalizeNikoflowAdvisorReview(
			{ gateId: "gate-current", reviewed: true, notes: [{ severity: "blocker", note: "tests still red" }] },
			state,
		);
		expect(blocker).not.toBeNull();
		expect(nikoflowAdvisorReviewBlockers(blocker!)).toEqual(["tests still red"]);
		expect(advanceNikoflowAdvisorGate(state, blocker!)).toBe(state);

		const clean = normalizeNikoflowAdvisorReview(
			{ gateId: "gate-current", reviewed: true, notes: [{ severity: "nit", note: "clean" }] },
			state,
		);
		expect(clean).not.toBeNull();
		expect(isComplete(advanceNikoflowAdvisorGate(state, clean!))).toBe(true);
	});
});
