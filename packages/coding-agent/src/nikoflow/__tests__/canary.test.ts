import { describe, expect, test } from "bun:test";
import { detectReviewerVerdict, humanGateAccepted } from "../gates";
import { createState, mintGateRequest } from "../state";

describe("nikoflow gate canary", () => {
	test("blocks before required provenance and passes after matching reviewer verdict", () => {
		const state = mintGateRequest(createState("standard"), "gate-current");

		expect(humanGateAccepted(1_000, 1_000)).toBe(false);
		expect(
			detectReviewerVerdict({ role: "assistant", content: '{"gateId":"gate-current","verdict":"pass"}' }, state),
		).toEqual({ matched: false, reason: "not_tool_result" });
		expect(
			detectReviewerVerdict({ type: "tool_result", content: { gateId: "stale", verdict: "pass" } }, state),
		).toEqual({
			matched: false,
			reason: "stale_gate",
		});
		expect(
			detectReviewerVerdict({ type: "tool_result", content: { gateId: "gate-current", verdict: "block" } }, state),
		).toEqual({
			matched: false,
			reason: "blocked",
		});
		expect(
			detectReviewerVerdict({ type: "tool_result", content: { gateId: "gate-current", verdict: "pass" } }, state),
		).toEqual({
			matched: true,
			verdict: { gateId: "gate-current", verdict: "pass" },
		});
	});
});
