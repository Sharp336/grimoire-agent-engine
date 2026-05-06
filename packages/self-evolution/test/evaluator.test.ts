import { describe, expect, test } from "bun:test";
import { HeuristicSkillEvaluator } from "../src/evaluator";
import type { EvolvedSkill, ExtractedSkill } from "../src/types";

describe("HeuristicSkillEvaluator", () => {
	const evaluator = new HeuristicSkillEvaluator();

	test("evaluates extracted skill with full marks", () => {
		const skill: ExtractedSkill = {
			name: "test-skill",
			description: "A detailed description of what this skill does",
			taskPattern: "This is a substantial task pattern with enough length",
			approach: "A very detailed approach that explains the exact steps and reasoning behind the solution",
			tools: ["read", "edit", "bash", "search", "write"],
			pitfalls: [
				"Watch for errors when running similar tasks; 1 error(s) occurred.",
				"Always check file permissions before writing.",
				"Verify the output format matches expectations.",
			],
			qualityScore: 0,
			llmRefined: true,
		};
		const score = evaluator.evaluate(skill);
		expect(score.total).toBeGreaterThanOrEqual(80);
		expect(score.toolDiversity).toBe(15);
		expect(score.pitfallCoverage).toBe(12);
		expect(score.taskPatternSubstance).toBe(8);
		expect(score.approachSubstance).toBe(10);
		expect(score.descriptionQuality).toBe(10);
		expect(score.reusesHistory).toBe(5);
		expect(score.recoveryExperience).toBe(3);
	});

	test("evaluates minimal skill with low score", () => {
		const skill: ExtractedSkill = {
			name: "x",
			description: "short",
			taskPattern: "x",
			approach: "x",
			tools: [],
			pitfalls: [],
			qualityScore: 0,
			llmRefined: false,
		};
		const score = evaluator.evaluate(skill);
		expect(score.total).toBeLessThan(40);
		expect(score.toolDiversity).toBe(0);
		expect(score.pitfallCoverage).toBe(0);
		expect(score.taskPatternSubstance).toBe(0);
		expect(score.approachSubstance).toBe(0);
		expect(score.descriptionQuality).toBe(0);
	});

	test("reevaluate uses success rate from stats", () => {
		const skill: EvolvedSkill = {
			name: "test",
			description: "A good description of the skill",
			taskPattern: "A substantial task pattern for testing purposes",
			approach: "A detailed approach with multiple steps and clear reasoning",
			tools: ["read", "edit"],
			pitfalls: ["Check permissions"],
			createdAt: 0,
			usageCount: 5,
			lastUsedAt: 0,
			successCount: 4,
			failureCount: 1,
			version: 1,
			qualityScore: 50,
		};
		const score = evaluator.reevaluate(skill);
		expect(score.successRate).toBeGreaterThan(0);
		expect(score.successRate).toBeLessThanOrEqual(35);
	});
});
