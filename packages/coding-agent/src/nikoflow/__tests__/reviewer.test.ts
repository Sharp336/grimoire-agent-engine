import { describe, expect, test } from "bun:test";
import { buildReviewerPrompt, reviewerBlock, reviewerPass } from "../reviewer";

describe("nikoflow reviewer", () => {
	test("builds a harness-owned structured verdict prompt", () => {
		const prompt = buildReviewerPrompt({
			gateId: "g1",
			phase: "verify",
			diff: "diff --git a/a b/a",
			acceptance: ["tests pass"],
			adr: "Use existing callback chain.",
			prd: "User can run gated mode.",
			validation: "bun test ok",
		});

		expect(prompt).toContain("primary agent did not author this prompt");
		expect(prompt).toContain("Gate id: g1");
		expect(prompt).toContain("1. tests pass");
		expect(prompt).toContain("Use existing callback chain.");
		expect(prompt).toContain("Return only JSON");
		expect(prompt).toContain("diff --git");
	});

	test("formats structured pass and block verdicts", () => {
		expect(reviewerPass("g1", 9.8)).toEqual({ gateId: "g1", verdict: "pass", score: 9.8, reason: "passed" });
		expect(reviewerBlock("g1", "red validation")).toEqual({
			gateId: "g1",
			verdict: "block",
			reason: "red validation",
		});
	});
});
