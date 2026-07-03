import { describe, expect, it } from "bun:test";
import type { Skill } from "../src/extensibility/skills";
import { redactSkillDescriptions } from "../src/system-prompt-redaction";

const MOCK_SKILLS: Skill[] = [
	{
		name: "skill-one",
		description: "One. Two. Three.",
		filePath: "/path/to/skill-one",
		baseDir: "/path/to",
		source: "test",
	},
	{
		name: "skill-two",
		description: "Short.",
		filePath: "/path/to/skill-two",
		baseDir: "/path/to",
		source: "test",
	},
];

describe("redactSkillDescriptions", () => {
	it("returns identical skills in off mode", () => {
		const result = redactSkillDescriptions(MOCK_SKILLS, {
			mode: "off",
			maxContextShare: 0.05,
			contextWindow: 100000,
		});
		expect(result).toEqual(MOCK_SKILLS);
	});

	it("returns identical skills if options are invalid or missing context window", () => {
		const resultNoCtx = redactSkillDescriptions(MOCK_SKILLS, {
			mode: "trim",
			maxContextShare: 0.05,
			contextWindow: undefined,
		});
		expect(resultNoCtx).toEqual(MOCK_SKILLS);

		const resultZeroCtx = redactSkillDescriptions(MOCK_SKILLS, {
			mode: "trim",
			maxContextShare: 0.05,
			contextWindow: 0,
		});
		expect(resultZeroCtx).toEqual(MOCK_SKILLS);

		const resultInvalidShare = redactSkillDescriptions(MOCK_SKILLS, {
			mode: "trim",
			maxContextShare: 0,
			contextWindow: 100000,
		});
		expect(resultInvalidShare).toEqual(MOCK_SKILLS);
	});

	it("preserves non-description fields when descriptions change, and preserves object reference when unchanged", () => {
		// Set contextWindow/maxContextShare to force a per-skill budget of 6 chars.
		// totalCharBudget = 30 * 0.05 * 4 = 6 chars.
		// 1 skill in input -> per-skill budget = 6.
		// "One. Two. Three." (16 chars) will be trimmed to "One." (4 chars).
		const singleSkill = [MOCK_SKILLS[0]];
		const resultTrim = redactSkillDescriptions(singleSkill, {
			mode: "trim",
			maxContextShare: 0.05,
			contextWindow: 30,
		});

		expect(resultTrim[0].description).toBe("One.");
		expect(resultTrim[0].name).toBe(singleSkill[0].name);
		expect(resultTrim[0].filePath).toBe(singleSkill[0].filePath);
		expect(resultTrim[0].baseDir).toBe(singleSkill[0].baseDir);
		expect(resultTrim[0].source).toBe(singleSkill[0].source);
		expect(resultTrim[0]).not.toBe(singleSkill[0]); // mutated description, new object reference

		// Verify cap mode preserves other fields too
		const resultCap = redactSkillDescriptions(singleSkill, {
			mode: "cap",
			maxContextShare: 0.1,
			contextWindow: 10, // very small to force pop to 1 sentence
		});
		expect(resultCap[0].description).toBe("One.");
		expect(resultCap[0].name).toBe(singleSkill[0].name);
		expect(resultCap[0]).not.toBe(singleSkill[0]);

		// Verify unchanged description keeps same object reference
		// Budget is large: total budget = 1000 * 0.05 * 4 = 200. Per skill = 100 chars.
		// "One. Two. Three." fits within 100 chars budget.
		const resultUnchanged = redactSkillDescriptions(singleSkill, {
			mode: "trim",
			maxContextShare: 0.05,
			contextWindow: 1000,
		});
		expect(resultUnchanged[0]).toBe(singleSkill[0]);
	});

	describe("trim mode", () => {
		it("respects sentence boundaries and does not append ellipsis", () => {
			// contextWindow * maxContextShare * 4 = 1000 * 0.05 * 4 = 200 total char budget
			// With 2 skills, per-skill char budget is 100 chars.
			// skill-one description length is 16. Fits within budget.
			const result = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 1000,
			});
			expect(result[0].description).toBe(MOCK_SKILLS[0].description);
		});

		it("trims description to fit within per-skill budget by dropping trailing sentences", () => {
			// contextWindow = 30, maxContextShare = 0.05 -> total char budget = 6 chars
			// 2 skills -> per-skill budget is 3 chars.
			// Even the first sentence ("One." - 4 chars) exceeds budget (3 chars).
			// So trim mode keeps zero sentences to stay within budget.
			const result = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 30,
			});
			expect(result[0].description).toBe("");
		});

		it("allows zero kept sentences when a single sentence exceeds the per-skill budget", () => {
			const singleSentenceSkill: Skill[] = [
				{
					name: "single",
					description: "Longsentence.",
					filePath: "/path/to/single",
					baseDir: "/path/to",
					source: "test",
				},
			];

			// contextWindow = 10, maxContextShare = 0.05 -> total/per-skill budget = 2 chars.
			const result = redactSkillDescriptions(singleSentenceSkill, {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 10,
			});

			expect(result[0].description).toBe("");
		});

		it("keeps as many complete sentences as can fit under the budget", () => {
			// skill-one sentences:
			// - "One." (4 chars)
			// - "One. Two." (9 chars)
			// - "One. Two. Three." (16 chars)
			// Let's set contextWindow = 100, maxContextShare = 0.05 -> total budget = 20 chars.
			// 2 skills -> per-skill budget is 10 chars.
			// For budget 10, it should keep exactly 2 sentences: "One. Two."
			const result = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 100,
			});
			expect(result[0].description).toBe("One. Two.");
		});
	});

	describe("cap mode", () => {
		it("iteratively trims the longest descriptions sentence-by-sentence until under token budget", () => {
			// Budget is contextWindow * maxContextShare in tokens.
			// Let's calculate total tokens for:
			// "<skills>\n- skill-one: One. Two. Three.\n- skill-two: Short.\n</skills>"
			// Length: 10 + 1 + 13 + 16 + 1 + 13 + 6 + 1 + 9 = 70.
			// Tokens: Math.ceil(70 / 4) = 18 tokens.
			//
			// If we pop 1 sentence of skill-one:
			// "<skills>\n- skill-one: One. Two.\n- skill-two: Short.\n</skills>"
			// Length: 10 + 1 + 13 + 9 + 1 + 13 + 6 + 1 + 9 = 63.
			// Tokens: Math.ceil(63 / 4) = 16 tokens.
			//
			// If we set contextWindow = 160, maxContextShare = 0.1 -> budget = 16 tokens.
			// Since original (18 tokens) > 16 tokens, it should pop 1 sentence from skill-one, reaching 16 tokens.
			const result = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "cap",
				maxContextShare: 0.1,
				contextWindow: 160,
			});
			expect(result[0].description).toBe("One. Two.");
		});

		it("never drops a skill entry even when budget is unsplittable", () => {
			// With an extremely small budget (contextWindow = 10, maxContextShare = 0.1 → 1 token),
			// every entry is ≤1 sentence after Phase 1, so Phase 2 trims description text
			// down to a residual char budget. Skill entries and names must survive.
			const result = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "cap",
				maxContextShare: 0.1,
				contextWindow: 10,
			});
			expect(result.length).toBe(MOCK_SKILLS.length);
			expect(result[0].name).toBe("skill-one");
			expect(result[1].name).toBe("skill-two");
			// Descriptions are strictly shortened by Phase 2 char-level trim.
			// Residual char budget = floor(1 * 4 / 2) = 2 chars per entry.
			expect(result[0].description.length).toBeLessThan(MOCK_SKILLS[0].description.length);
			expect(result[1].description.length).toBeLessThan(MOCK_SKILLS[1].description.length);
		});

		it("shortens unsplittable single-sentence descriptions when over budget", () => {
			// A single long sentence with no sentence boundaries cannot be popped.
			// Phase 2 must trim the description text itself to fit the residual budget.
			const longSingleSentence: Skill[] = [
				{
					name: "verbose-skill",
					description:
						"This is a very long single sentence with no internal sentence breaks that cannot be split by the sentence popper",
					filePath: "/path/to/verbose",
					baseDir: "/path/to",
					source: "test",
				},
			];
			// contextWindow = 20, maxContextShare = 0.1 → budget = 2 tokens → 8 chars.
			// The description is 91 chars; Phase 2 must trim it to ≤ 8 chars.
			const result = redactSkillDescriptions(longSingleSentence, {
				mode: "cap",
				maxContextShare: 0.1,
				contextWindow: 20,
			});
			expect(result.length).toBe(1);
			expect(result[0].name).toBe("verbose-skill");
			expect(result[0].description.length).toBeLessThan(longSingleSentence[0].description.length);
			expect(result[0].description.length).toBeLessThanOrEqual(8);
		});
	});
});
