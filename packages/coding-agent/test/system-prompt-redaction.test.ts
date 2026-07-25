import { describe, expect, it } from "bun:test";
import { countTokens } from "@oh-my-pi/pi-agent-core";
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
		// Set contextWindow/maxContextShare to force a per-skill budget of 1 token.
		// totalTokenBudget = floor(30 * 0.05) = 1 token.
		// 1 skill in input -> per-skill budget = 1.
		// countTokens("One.") = 1 ≤ 1, so "One." is kept.
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
			contextWindow: 100, // small enough to pop to 1 sentence, large enough for "One." after framing
		});
		expect(resultCap[0].description).toBe("One.");
		expect(resultCap[0].name).toBe(singleSkill[0].name);
		expect(resultCap[0]).not.toBe(singleSkill[0]);

		// Verify unchanged description keeps same object reference
		// Budget is large: totalTokenBudget = floor(1000 * 0.05) = 50. Per skill = 50 tokens.
		// countTokens("One. Two. Three.") = 4 ≤ 50, so it fits unchanged.
		const resultUnchanged = redactSkillDescriptions(singleSkill, {
			mode: "trim",
			maxContextShare: 0.05,
			contextWindow: 1000,
		});
		expect(resultUnchanged[0]).toBe(singleSkill[0]);
	});

	describe("trim mode", () => {
		it("respects sentence boundaries and does not append ellipsis", () => {
			// totalTokenBudget = floor(1000 * 0.05) = 50 tokens.
			// With 2 skills, per-skill token budget is 25.
			// skill-one description is 4 tokens. Fits within budget.
			const result = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 1000,
			});
			expect(result[0].description).toBe(MOCK_SKILLS[0].description);
		});

		it("trims description to fit within per-skill token budget by dropping trailing sentences", () => {
			// One skill: Phase 2 never runs (skills.length(1) > budgetTokens is false),
			// so this isolates Phase 1 per-skill sentence-boundary trimming.
			// contextWindow = 30, maxContextShare = 0.05 -> totalTokenBudget = 1 token.
			// 1 skill -> per-skill budget = max(1, floor(1/1)) = 1 token.
			// countTokens("One.") = 1 <= 1, so the first sentence fits.
			// countTokens("One. Two.") = 3 > 1, so only "One." is kept.
			const result = redactSkillDescriptions([MOCK_SKILLS[0]], {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 30,
			});
			expect(result[0].description).toBe("One.");
		});

		it("preserves leading CJK sentences when trimming to a token budget", () => {
			const firstSentence = "最初の説明です。";
			const cjkSkill: Skill = {
				name: "cjk-skill",
				description: `${firstSentence}これは予算を超える追加説明です。`,
				filePath: "/path/to/cjk",
				baseDir: "/path/to",
				source: "test",
			};

			const result = redactSkillDescriptions([cjkSkill], {
				mode: "trim",
				maxContextShare: 1,
				contextWindow: countTokens(firstSentence),
			});

			expect(result[0].description).toBe(firstSentence);
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

			// contextWindow = 10, maxContextShare = 0.05 -> totalTokenBudget = floor(0.5) = 0, per-skill = max(1, 0) = 1.
			// countTokens("Longsentence.") = 4 > 1, so even the first (only) sentence exceeds the budget.
			const result = redactSkillDescriptions(singleSentenceSkill, {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 10,
			});

			expect(result[0].description).toBe("");
		});

		it("keeps as many complete sentences as can fit under the token budget", () => {
			// skill-one sentences and their token counts (byte-based estimate):
			// - "One."             → countTokens = 1
			// - "One. Two."        → countTokens = 3
			// - "One. Two. Three." → countTokens = 4
			// contextWindow = 100, maxContextShare = 0.05 -> totalTokenBudget = 5.
			// 2 skills -> per-skill budget = max(1, floor(5/2)) = 2 tokens.
			// countTokens("One.") = 1 ≤ 2, countTokens("One. Two.") = 3 > 2.
			// So only the first sentence "One." is kept.
			const result = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 100,
			});
			expect(result[0].description).toBe("One.");
		});
		it("enforces aggregate token budget when many skills exceed total budget", () => {
			// OONQH: with many skills, the per-skill floor (≥1 token) can cause
			// the aggregate rendered block to exceed the total token budget.
			// trim mode must enforce the aggregate ceiling like cap mode does.
			//
			// 100 skills, contextWindow=10, maxContextShare=0.05 → budget = 1 token.
			// Per-skill floor = max(1, floor(1/100)) = 1 token each.
			// Without aggregate enforcement: 100 skills × 1 token = 100 tokens » 1.
			// With Phase 2: framing alone (100 name lines + wrapper) exceeds 1,
			// so all descriptions are trimmed to "" and only names survive.
			const manySkills: Skill[] = Array.from({ length: 100 }, (_, i) => ({
				name: `skill-${i}`,
				description: `Description ${i}.`,
				filePath: `/path/to/skill-${i}`,
				baseDir: "/path/to",
				source: "test",
			}));
			const result = redactSkillDescriptions(manySkills, {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 10,
			});
			expect(result.length).toBe(100);
			// Every entry name survives.
			for (let i = 0; i < 100; i++) {
				expect(result[i].name).toBe(`skill-${i}`);
			}
			// When framing alone exceeds the budget, Phase 2 trims all
			// descriptions to empty (best effort) — names always survive.
			expect(result.every(s => s.description === "")).toBe(true);
		});

		it("clears one-token descriptions when framing alone already exceeds the trim budget", () => {
			// 200 skills with one-token descriptions (`A.`) against a 10-token total
			// budget. Phase 1 keeps every description because each fits the per-skill
			// floor (≥1). Framing alone (200 name lines + wrapper) exceeds the budget,
			// so Phase 2 must drive the description budget to zero and drop them all
			// rather than returning Phase 1 output verbatim.
			const manySkills: Skill[] = Array.from({ length: 200 }, (_, i) => ({
				name: `s${i}`,
				description: "A.",
				filePath: `/path/to/s${i}`,
				baseDir: "/path/to",
				source: "test",
			}));
			// budgetTokens = max(1, floor(10 * 1)) = 10; 200 > 10 so Phase 2 runs.
			const result = redactSkillDescriptions(manySkills, {
				mode: "trim",
				maxContextShare: 1,
				contextWindow: 10,
			});
			expect(result.length).toBe(200);
			for (let i = 0; i < 200; i++) {
				expect(result[i].name).toBe(`s${i}`);
			}
			expect(result.every(s => s.description === "")).toBe(true);
			// Clearing descriptions must shrink the rendered block vs Phase 1 survivors.
			const phase1Rendered = `<skills>\n${manySkills.map(s => `- ${s.name}: ${s.description}`).join("\n")}\n</skills>`;
			const resultRendered = `<skills>\n${result.map(s => `- ${s.name}: ${s.description}`).join("\n")}\n</skills>`;
			expect(countTokens(resultRendered)).toBeLessThan(countTokens(phase1Rendered));
		});
	});

	describe("cap mode", () => {
		it("iteratively trims the longest descriptions sentence-by-sentence until under token budget", () => {
			// Budget is contextWindow * maxContextShare in tokens.
			// Using countTokens (byte-based estimate in tests):
			// "<skills>\n- skill-one: One. Two. Three.\n- skill-two: Short.\n</skills>"
			//   → countTokens = 17 tokens.
			//
			// If we pop 1 sentence of skill-one:
			// "<skills>\n- skill-one: One. Two.\n- skill-two: Short.\n</skills>"
			//   → countTokens = 16 tokens.
			//
			// If we set contextWindow = 160, maxContextShare = 0.1 -> budget = 16 tokens.
			// Since original (17 tokens) > 16 tokens, it should pop 1 sentence from skill-one, reaching 16 tokens.
			const result = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "cap",
				maxContextShare: 0.1,
				contextWindow: 160,
			});
			expect(result[0].description).toBe("One. Two.");
		});

		it("returns CJK descriptions that already fit byte-identical without split/rejoin", () => {
			// Cap mode used to split every description before checking budget. For a
			// CJK description that already fits, splitSentences inserts a space after
			// `。` and rejoin yields `第一。 第二。` — mutating the provider prompt with
			// no redaction needed. When the rendered block is within budget, originals
			// must be returned untouched (same object reference / byte-identical text).
			const description = "第一。第二。";
			const cjkSkill: Skill = {
				name: "cjk-fit",
				description,
				filePath: "/path/to/cjk-fit",
				baseDir: "/path/to",
				source: "test",
			};
			const skills = [cjkSkill];
			const renderedTokens = countTokens(`<skills>\n- cjk-fit: ${description}\n</skills>`);
			const result = redactSkillDescriptions(skills, {
				mode: "cap",
				maxContextShare: 1,
				contextWindow: renderedTokens, // exact fit
			});
			expect(result).toBe(skills);
			expect(result[0]).toBe(cjkSkill);
			expect(result[0].description).toBe(description);
			expect(result[0].description).toBe("第一。第二。");
			expect(result[0].description).not.toBe("第一。 第二。");
		});

		it("preserves leading CJK sentences when capping rendered skills", () => {
			const firstSentence = "最初の説明です。";
			const cjkSkill: Skill = {
				name: "cjk-skill",
				description: `${firstSentence}これは予算を超える追加説明です。`,
				filePath: "/path/to/cjk",
				baseDir: "/path/to",
				source: "test",
			};
			const renderedFirstSentenceTokens = countTokens(`<skills>\n- cjk-skill: ${firstSentence}\n</skills>`);

			const result = redactSkillDescriptions([cjkSkill], {
				mode: "cap",
				maxContextShare: 1,
				contextWindow: renderedFirstSentenceTokens,
			});

			expect(result[0].description).toBe(firstSentence);
		});

		it("never drops a skill entry even when budget is unsplittable", () => {
			// With an extremely small budget (contextWindow = 10, maxContextShare = 0.1 → 1 token),
			// every entry is ≤1 sentence after Phase 1, so Phase 2 trims description text
			// down to a residual token budget. Skill entries and names must survive.
			const result = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "cap",
				maxContextShare: 0.1,
				contextWindow: 10,
			});
			expect(result.length).toBe(MOCK_SKILLS.length);
			expect(result[0].name).toBe("skill-one");
			expect(result[1].name).toBe("skill-two");
			// Descriptions are strictly shortened by Phase 2 token-level trim.
			// Framing overhead (12 tokens) exceeds the 1-token budget, so
			// descriptionTokenBudget = 0 and all descriptions become "".
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
			// contextWindow = 20, maxContextShare = 0.1 → budget = 2 tokens.
			// Framing = 9 tokens > 2, so descriptionTokenBudget = 0, residualTokenBudget = 0.
			// The description (28 tokens) is trimmed to "" (0 chars).
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

		it("cap mode with custom render format trims more aggressively than default format", () => {
			// The custom prompt template wraps each skill in
			//   <skill name="{{name}}">\n{{description}}\n</skill>
			// which has a larger per-entry footprint than the default
			//   - {{name}}: {{description}}
			// Cap mode must estimate against the actual rendering shape so the
			// budget matches what the provider receives.
			//
			// Default format for MOCK_SKILLS (full):
			//   "<skills>\n- skill-one: One. Two. Three.\n- skill-two: Short.\n</skills>"
			//   → countTokens = 17 tokens.
			//
			// Custom format for MOCK_SKILLS (full):
			//   "<skills>\n<skill name=\"skill-one\">\nOne. Two. Three.\n</skill>\n<skill name=\"skill-two\">\nShort.\n</skill>\n</skills>"
			//   → countTokens = 28 tokens.
			//
			// With budget = 16 tokens (contextWindow=160, share=0.1):
			// - Default: 17 > 16 → pops 1 sentence → 16 tokens → result "One. Two."
			// - Custom: 28 > 16 → pops sentences more aggressively because the
			//   wrapping tags eat into the budget. The custom-format result must
			//   be strictly shorter than the default-format result.
			const defaultResult = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "cap",
				maxContextShare: 0.1,
				contextWindow: 160,
				renderFormat: "default",
			});
			const customResult = redactSkillDescriptions(MOCK_SKILLS, {
				mode: "cap",
				maxContextShare: 0.1,
				contextWindow: 160,
				renderFormat: "custom",
			});

			// Both keep both skill entries and their names.
			expect(customResult.length).toBe(MOCK_SKILLS.length);
			expect(customResult[0].name).toBe("skill-one");
			expect(customResult[1].name).toBe("skill-two");

			// The custom format has a larger per-entry footprint, so cap mode
			// must trim at least as aggressively as the default format.
			expect(customResult[0].description.length).toBeLessThanOrEqual(defaultResult[0].description.length);

			// Verify the custom-format estimate actually exceeds the default-format
			// estimate for the unredacted skills, proving the format matters.
			// (If they were equal, the custom format wouldn't trim more.)
			const defaultFull = "<skills>\n- skill-one: One. Two. Three.\n- skill-two: Short.\n</skills>";
			const customFull =
				'<skills>\n<skill name="skill-one">\nOne. Two. Three.\n</skill>\n<skill name="skill-two">\nShort.\n</skill>\n</skills>';
			expect(countTokens(customFull)).toBeGreaterThan(countTokens(defaultFull));
		});
		it("Phase 2 subtracts skill framing before residual caps so the rendered estimate fits", () => {
			// Multiple single-sentence descriptions: Phase 1 cannot pop (all ≤1
			// sentence), so Phase 2 must trim text. The residual token budget must
			// account for fixed rendering overhead (wrapper tags + name framing)
			// rather than giving the whole budget to description text.
			//
			// Default render framing (empty descriptions):
			//   "<skills>\n- skill-a: \n- skill-b: \n- skill-c: \n</skills>"
			//   → countTokens = 14 tokens.
			// Full render:
			//   "<skills>\n- skill-a: A.\n- skill-b: Beta xyz.\n- skill-c: Gamma xyz.\n</skills>"
			//   → countTokens = 19 tokens.
			//
			// budget = 20 tokens (contextWindow=200, share=0.1).
			// framing = 14 tokens, descriptionTokenBudget = 6,
			// residualTokenBudget = floor(6/3) = 2. countTokens("A.") = 1 ≤ 2, so
			// "A." survives; countTokens("Beta xyz.") = 3 > 2, so longer
			// descriptions are trimmed. Estimate = 14 ≤ 20. Fits.
			const singleSentenceSkills: Skill[] = [
				{ name: "skill-a", description: "A.", filePath: "/a", baseDir: "/", source: "test" },
				{ name: "skill-b", description: "Beta xyz.", filePath: "/b", baseDir: "/", source: "test" },
				{ name: "skill-c", description: "Gamma xyz.", filePath: "/c", baseDir: "/", source: "test" },
			];
			const budgetTokens = 20;
			const result = redactSkillDescriptions(singleSentenceSkills, {
				mode: "cap",
				maxContextShare: 0.1,
				contextWindow: 200, // 200 * 0.1 = 20 tokens
			});

			// All names survive.
			expect(result.length).toBe(3);
			expect(result[0].name).toBe("skill-a");
			expect(result[1].name).toBe("skill-b");
			expect(result[2].name).toBe("skill-c");

			// The rendered estimate of the result must fit within the budget.
			const rendered = `<skills>\n${result.map(s => `- ${s.name}: ${s.description}`).join("\n")}\n</skills>`;
			expect(countTokens(rendered)).toBeLessThanOrEqual(budgetTokens);

			// The shortest description survives; longer ones are trimmed.
			expect(result[0].description).toBe("A.");
		});
	});

	describe("non-ASCII token estimation", () => {
		it("CJK descriptions are measured by UTF-8 byte length, not char count", () => {
			// CJK characters are 3 bytes each in UTF-8. The old chars/4 heuristic
			// undercounted CJK tokens by ~3×, letting too much text through trim
			// mode. countTokens (the same estimator used by context accounting)
			// uses byte length, so CJK text is correctly measured.
			//
			// CJK skill: "这是第一个句子. 这是第二个句子. 这是第三个句子."
			//   chars=26, bytes=68 → countTokens=17, old estimateTokens=7
			//
			// contextWindow=160, share=0.05 → perSkill token budget = 8.
			// countTokens("这是第一个句子.") = 6 ≤ 8 → first sentence fits.
			// countTokens("这是第一个句子. 这是第二个句子.") = 12 > 8 → second doesn't.
			// Result: only the first sentence is kept.
			//
			// Under the OLD chars/4 heuristic: char budget = 160*0.05*4 = 32.
			// cjkDesc.length = 26 ≤ 32 → NO trimming at all. This is the bug:
			// the old heuristic let 17 tokens of CJK through a 8-token budget.
			const cjkSkill: Skill[] = [
				{
					name: "cjk-skill",
					description: "这是第一个句子. 这是第二个句子. 这是第三个句子.",
					filePath: "/path/to/cjk",
					baseDir: "/path/to",
					source: "test",
				},
			];
			const result = redactSkillDescriptions(cjkSkill, {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 160,
			});
			expect(result[0].description).toBe("这是第一个句子.");
			expect(result[0].description).not.toBe(cjkSkill[0].description);
		});

		it("emoji descriptions are measured by UTF-8 byte length", () => {
			// Emoji are 4 bytes each in UTF-8. The old chars/4 heuristic treated
			// each emoji as 0.25 tokens (1 char / 4), but countTokens treats them
			// as ~1 token (4 bytes / 4). This test ensures the redaction budget
			// uses the same byte-aware estimator as context accounting.
			//
			// Emoji skill: "🔧 Fix things. 🚀 Launch stuff. ✨ Make it sparkle."
			//   chars=50, bytes=56 → countTokens=14
			//
			// contextWindow=200, share=0.05 → perSkill token budget = 10.
			// countTokens("🔧 Fix things.") = 4 ≤ 10 → first fits.
			// countTokens("🔧 Fix things. 🚀 Launch stuff.") = 9 ≤ 10 → second fits.
			// countTokens(full) = 14 > 10 → third doesn't fit.
			// Result: first two sentences kept.
			const emojiSkill: Skill[] = [
				{
					name: "emoji-skill",
					description: "🔧 Fix things. 🚀 Launch stuff. ✨ Make it sparkle.",
					filePath: "/path/to/emoji",
					baseDir: "/path/to",
					source: "test",
				},
			];
			const result = redactSkillDescriptions(emojiSkill, {
				mode: "trim",
				maxContextShare: 0.05,
				contextWindow: 200,
			});
			expect(result[0].description).toBe("🔧 Fix things. 🚀 Launch stuff.");
			expect(result[0].description).not.toBe(emojiSkill[0].description);
		});

		it("cap mode non-ASCII rendered estimate uses byte-aware countTokens", () => {
			// Cap mode estimates the rendered skills block with countTokens.
			// A CJK description in cap mode must be measured by byte length so
			// the budget matches what context accounting reports.
			//
			// Rendered: "<skills>\n- cjk: 这是第一个句子. 这是第二个句子.\n</skills>"
			//   bytes = 9 + 1 + 4 + 2 + 45 + 1 + 9 = 71 → countTokens = 18
			// budget = 12 (contextWindow=120, share=0.1).
			// 18 > 12 → Phase 1 pops the second sentence.
			// "<skills>\n- cjk: 这是第一个句子.\n</skills>"
			//   bytes = 9 + 1 + 4 + 2 + 22 + 1 + 9 = 48 → countTokens = 12. Fits.
			const cjkSkills: Skill[] = [
				{
					name: "cjk",
					description: "这是第一个句子. 这是第二个句子.",
					filePath: "/path/to/cjk",
					baseDir: "/path/to",
					source: "test",
				},
			];
			const result = redactSkillDescriptions(cjkSkills, {
				mode: "cap",
				maxContextShare: 0.1,
				contextWindow: 120,
			});
			expect(result[0].description).toBe("这是第一个句子.");

			// The rendered estimate of the result must fit within the budget.
			const rendered = `<skills>\n${result.map(s => `- ${s.name}: ${s.description}`).join("\n")}\n</skills>`;
			expect(countTokens(rendered)).toBeLessThanOrEqual(12);
		});
	});
});
