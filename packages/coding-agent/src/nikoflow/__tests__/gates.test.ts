import { describe, expect, test } from "bun:test";
import { detectReviewerVerdict, humanGateAccepted, parseReviewerVerdict } from "../gates";
import { createState, mintGateRequest } from "../state";

describe("nikoflow gates", () => {
	test("parses structured reviewer verdicts", () => {
		expect(parseReviewerVerdict({ gateId: "g1", verdict: "pass", score: 9.8 })).toEqual({
			gateId: "g1",
			verdict: "pass",
			score: 9.8,
		});
		expect(parseReviewerVerdict({ gateId: "g1", verdict: "maybe" })).toBeNull();
		expect(parseReviewerVerdict({ verdict: "pass" })).toBeNull();
	});

	test("parses fenced or prose-prefixed reviewer JSON", () => {
		expect(parseReviewerVerdict('```json\n{"gateId":"g1","verdict":"pass"}\n```')).toEqual({
			gateId: "g1",
			verdict: "pass",
		});
		expect(parseReviewerVerdict('Verdict:\n{"gateId":"g1","verdict":"block","reason":"fix it"}')).toEqual({
			gateId: "g1",
			verdict: "block",
			reason: "fix it",
		});
	});

	test("accepts only matching pass verdicts from tool_result content", () => {
		const state = mintGateRequest(createState("standard"), "g1");
		expect(detectReviewerVerdict({ gateId: "g1", verdict: "pass" }, state)).toEqual({
			matched: false,
			reason: "not_tool_result",
		});
		expect(
			detectReviewerVerdict(
				{ type: "tool_result", content: JSON.stringify({ gateId: "g1", verdict: "pass" }) },
				state,
			),
		).toEqual({
			matched: true,
			verdict: { gateId: "g1", verdict: "pass" },
		});
		expect(
			detectReviewerVerdict({ type: "tool_result", content: { gateId: "old", verdict: "pass" } }, state),
		).toEqual({
			matched: false,
			reason: "stale_gate",
		});
		expect(
			detectReviewerVerdict({ type: "tool_result", content: { gateId: "g1", verdict: "block" } }, state),
		).toEqual({
			matched: false,
			reason: "blocked",
		});
		expect(detectReviewerVerdict({ type: "tool_result", content: { gateId: "g1" } }, state)).toEqual({
			matched: false,
			reason: "missing_verdict",
		});
	});

	test("uses harness-owned tool_result details for gate correlation", () => {
		const state = mintGateRequest(createState("standard"), "g1");
		expect(
			detectReviewerVerdict(
				{ role: "toolResult", details: { gateId: "g1" }, content: { verdict: "pass", reason: "ok" } },
				state,
			),
		).toEqual({
			matched: true,
			verdict: { gateId: "g1", verdict: "pass", reason: "ok" },
		});
	});

	test("human gate requires a real later turn", () => {
		expect(humanGateAccepted(1_000, 1_001)).toBe(true);
		expect(humanGateAccepted(1_000, 1_000)).toBe(false);
		expect(humanGateAccepted(1_000, undefined)).toBe(false);
		expect(humanGateAccepted(null, 1_001)).toBe(false);
	});
});
