import { countTokens } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Skill } from "./extensibility/skills";
import skillsBlockTemplate from "./prompts/system/skills-block.md" with { type: "text" };

export type SkillDescriptionRedactionMode = "off" | "trim" | "cap";

export interface SkillDescriptionRedactionOptions {
	mode: SkillDescriptionRedactionMode;
	maxContextShare: number;
	contextWindow?: number | null;
	/**
	 * Which prompt-template rendering shape the redacted skills will be inlined
	 * into. Cap mode estimates tokens against this shape so the budget matches
	 * what the provider actually receives. Defaults to `"default"`.
	 */
	renderFormat?: "default" | "custom";
}

const CJK_SENTENCE_TERMINATOR_RE = /([。！？])(?=\S)/gu;
const SENTENCE_BOUNDARY_RE = /(?<=[.!?。！？])\s+/u;

function splitSentences(description: string): string[] {
	const trimmed = description.trim();
	if (!trimmed) return [""];
	const normalized = trimmed.replace(CJK_SENTENCE_TERMINATOR_RE, "$1 ");
	return normalized.split(SENTENCE_BOUNDARY_RE).filter(sentence => sentence.length > 0);
}

function trimDescriptionToTokenBudget(description: string, tokenBudget: number): string {
	if (countTokens(description) <= tokenBudget) return description;

	const sentences = splitSentences(description);
	const kept: string[] = [];
	for (const sentence of sentences) {
		const candidate = [...kept, sentence].join(" ");
		if (countTokens(candidate) > tokenBudget) break;
		kept.push(sentence);
	}

	return kept.join(" ");
}

/** One `{ name, description }` row as the skills-block template consumes it. */
interface SkillsBlockEntry {
	name: string;
	description: string;
}

// Compiled once; `prompt.compile` also memoizes on the template string.
// Deliberately NOT `prompt.render`, which post-formats and would strip the
// trailing space an empty description leaves on a `- name: ` line, silently
// changing the token estimate against the block bytes actually shipped.
const renderSkillsBlockTemplate = prompt.compile(skillsBlockTemplate);

/**
 * Render the exact `<skills>` block text that the system prompt template
 * emits for the given skills. Exposed so callers (e.g. sdk.ts skills-block
 * detection) can compare against the *generated* block rather than the first
 * literal `<skills>` wrapper in user content.
 *
 * Both render shapes live in `prompts/system/skills-block.md`, shared with the
 * budget estimator below, so a template edit cannot desync detection from the
 * token accounting.
 */
export function renderSkillsBlock(
	skills: readonly SkillsBlockEntry[],
	renderFormat: "default" | "custom" = "default",
): string {
	const rendered = renderSkillsBlockTemplate({ skills, custom: renderFormat === "custom" });
	// The template file ends in a newline; the block text itself must not.
	return rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
}

function estimateRenderedSkillsTokens(
	entries: readonly { skill: Skill; sentences: string[] }[],
	renderFormat: "default" | "custom" = "default",
): number {
	return countTokens(
		renderSkillsBlock(
			entries.map(({ skill, sentences }) => ({ name: skill.name, description: sentences.join(" ") })),
			renderFormat,
		),
	);
}

function applyTrimMode(
	skills: Skill[],
	contextWindow: number,
	maxContextShare: number,
	renderFormat: "default" | "custom",
): Skill[] {
	if (skills.length === 0) return [];

	const budgetTokens = Math.max(1, Math.floor(contextWindow * maxContextShare));
	// Bail out before split/rejoin when the rendered block already fits, matching
	// cap mode. splitSentences normalizes CJK terminators (`。` → `。 `), so
	// rejoining with spaces would mutate descriptions like `第一。第二。` even
	// when no redaction is needed.
	if (countTokens(renderSkillsBlock(skills, renderFormat)) <= budgetTokens) {
		return skills;
	}
	const perSkillTokenBudget = Math.max(1, Math.floor(budgetTokens / skills.length));

	// Phase 1: trim each description to a per-skill token budget. With many
	// skills the per-skill floor (≥1 token) can cause the aggregate rendered
	// block to exceed the total budget, so this is a first pass only.
	const redacted = skills.map(skill => {
		const description = trimDescriptionToTokenBudget(skill.description, perSkillTokenBudget);
		return { skill, sentences: splitSentences(description) };
	});

	// Phase 2: only when the per-skill floor (≥1 token) caused the aggregate
	// to exceed the budget — i.e. when there are more skills than budget
	// tokens (skills.length > budgetTokens). For small skill counts the per-skill
	// budget already accounts for the total, so trim mode trusts Phase 1 there
	// (cap mode is the more aggressive mode and enters Phase 2 on rendered > budget
	// alone). When the per-skill floor itself caused the overflow, iteratively trim
	// description text down to a residual per-entry budget that accounts for fixed
	// rendering overhead, enforcing the same aggregate ceiling as cap mode Phase 2.
	// Skill names are never touched, so the entry list and names always survive
	// even when the budget is unsplittable.
	if (skills.length > budgetTokens && estimateRenderedSkillsTokens(redacted, renderFormat) > budgetTokens) {
		const framingTokens = estimateRenderedSkillsTokens(
			redacted.map(entry => ({ skill: entry.skill, sentences: [] })),
			renderFormat,
		);
		// When framing alone already meets/exceeds the budget, drive the
		// description budget to zero so Phase 1's one-token survivors are
		// dropped. Leaving Phase 1 verbatim would keep every short description
		// even though clearing them materially shrinks the over-budget block.
		const descriptionTokenBudget = framingTokens >= budgetTokens ? 0 : Math.max(0, budgetTokens - framingTokens);
		let residualTokenBudget = Math.max(0, Math.floor(descriptionTokenBudget / skills.length));

		while (estimateRenderedSkillsTokens(redacted, renderFormat) > budgetTokens) {
			for (const entry of redacted) {
				const text = entry.sentences.join(" ");
				const trimmed = trimDescriptionToTokenBudget(text, residualTokenBudget);
				entry.sentences = trimmed ? [trimmed] : [];
			}
			if (estimateRenderedSkillsTokens(redacted, renderFormat) <= budgetTokens) break;
			if (residualTokenBudget === 0) break;
			residualTokenBudget = Math.floor(residualTokenBudget / 2);
		}
	}

	return redacted.map(({ skill, sentences }) => {
		const description = sentences.join(" ");
		return description === skill.description ? skill : { ...skill, description };
	});
}

function applyCapMode(
	skills: Skill[],
	contextWindow: number,
	maxContextShare: number,
	renderFormat: "default" | "custom",
): Skill[] {
	if (skills.length === 0) return [];

	const budgetTokens = Math.max(1, Math.floor(contextWindow * maxContextShare));
	// Bail out before split/rejoin when the rendered block already fits.
	// splitSentences normalizes CJK terminators (`。` → `。 `), so rejoining
	// with spaces would mutate descriptions like `第一。第二。` even when no
	// redaction is needed.
	if (countTokens(renderSkillsBlock(skills, renderFormat)) <= budgetTokens) {
		return skills;
	}
	const redacted = skills.map(skill => ({ skill, sentences: splitSentences(skill.description) }));

	// Phase 1: pop sentences from the longest multi-sentence descriptions until
	// the rendered block fits the token budget.
	while (estimateRenderedSkillsTokens(redacted, renderFormat) > budgetTokens) {
		let longestIndex = -1;
		let longestLength = -1;

		for (const [index, entry] of redacted.entries()) {
			if (entry.sentences.length <= 1) continue;
			const length = entry.sentences.join(" ").length;
			if (length > longestLength) {
				longestLength = length;
				longestIndex = index;
			}
		}

		if (longestIndex < 0) break;
		redacted[longestIndex]?.sentences.pop();
	}

	// Phase 2: if still over budget (every remaining entry is ≤1 sentence), trim
	// each description's text down to a residual per-entry token budget. The
	// residual must account for the fixed rendering overhead — wrapper tags
	// (<skills>/</skills>) and per-entry name framing — so the budget is not
	// given entirely to description text. Descriptions are iteratively shortened
	// until the rendered estimate fits the token budget. Skill names are never
	// touched, so the entry list and names always survive even when the budget
	// is unsplittable.
	if (estimateRenderedSkillsTokens(redacted, renderFormat) > budgetTokens) {
		// Estimate the fixed framing overhead by rendering with empty
		// descriptions; only the remaining budget is available for text.
		const framingTokens = estimateRenderedSkillsTokens(
			redacted.map(entry => ({ skill: entry.skill, sentences: [] })),
			renderFormat,
		);
		const descriptionTokenBudget = Math.max(0, budgetTokens - framingTokens);
		let residualTokenBudget = Math.max(0, Math.floor(descriptionTokenBudget / skills.length));

		// Iteratively trim and re-estimate. If the rendered block still exceeds
		// the budget, halve the residual cap and retry until it fits or all
		// descriptions are empty (framing alone exceeds the budget).
		while (estimateRenderedSkillsTokens(redacted, renderFormat) > budgetTokens) {
			for (const entry of redacted) {
				const text = entry.sentences.join(" ");
				const trimmed = trimDescriptionToTokenBudget(text, residualTokenBudget);
				entry.sentences = trimmed ? [trimmed] : [];
			}
			if (estimateRenderedSkillsTokens(redacted, renderFormat) <= budgetTokens) break;
			if (residualTokenBudget === 0) break;
			residualTokenBudget = Math.floor(residualTokenBudget / 2);
		}
	}

	return redacted.map(({ skill, sentences }) => {
		const description = sentences.join(" ");
		return description === skill.description ? skill : { ...skill, description };
	});
}

export function redactSkillDescriptions(skills: Skill[], options: SkillDescriptionRedactionOptions): Skill[] {
	if (options.mode === "off") return skills;

	const contextWindow =
		typeof options.contextWindow === "number" && Number.isFinite(options.contextWindow) && options.contextWindow > 0
			? options.contextWindow
			: null;
	const maxContextShare =
		Number.isFinite(options.maxContextShare) && options.maxContextShare > 0 ? options.maxContextShare : null;
	if (contextWindow === null || maxContextShare === null) return skills;

	const renderFormat = options.renderFormat ?? "default";

	if (options.mode === "trim") return applyTrimMode(skills, contextWindow, maxContextShare, renderFormat);
	return applyCapMode(skills, contextWindow, maxContextShare, renderFormat);
}
