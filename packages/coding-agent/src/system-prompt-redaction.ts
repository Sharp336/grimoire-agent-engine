import { estimateTokens } from "./commit/map-reduce/utils";
import type { Skill } from "./extensibility/skills";

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

function splitSentences(description: string): string[] {
	const trimmed = description.trim();
	if (!trimmed) return [""];
	return trimmed.split(/(?<=[.!?])\s+/).filter(sentence => sentence.length > 0);
}

function trimDescriptionToBudget(description: string, charBudget: number): string {
	const sentences = splitSentences(description);
	if (description.length <= charBudget) return description;

	const kept: string[] = [];
	for (const sentence of sentences) {
		const candidate = [...kept, sentence].join(" ");
		if (candidate.length > charBudget) break;
		kept.push(sentence);
	}

	return kept.join(" ");
}

function estimateRenderedSkillsTokens(
	entries: readonly { skill: Skill; sentences: string[] }[],
	renderFormat: "default" | "custom" = "default",
): number {
	const lines = ["<skills>"];
	for (const { skill, sentences } of entries) {
		const description = sentences.join(" ");
		if (renderFormat === "custom") {
			// Matches custom-system-prompt.md: <skill name="{{name}}">\n{{description}}\n</skill>
			lines.push(`<skill name="${skill.name}">`);
			lines.push(description);
			lines.push("</skill>");
		} else {
			// Matches system-prompt.md: - {{name}}: {{description}}
			lines.push(`- ${skill.name}: ${description}`);
		}
	}
	lines.push("</skills>");
	return estimateTokens(lines.join("\n"));
}

function applyTrimMode(skills: Skill[], contextWindow: number, maxContextShare: number): Skill[] {
	if (skills.length === 0) return [];

	const totalCharBudget = Math.floor(contextWindow * maxContextShare * 4);
	const perSkillCharBudget = Math.max(1, Math.floor(totalCharBudget / skills.length));

	return skills.map(skill => {
		const description = trimDescriptionToBudget(skill.description, perSkillCharBudget);
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
	// each description's text down to a residual per-entry char budget. Skill
	// names are never touched — only the description text is shortened, so the
	// entry list and names always survive even when the budget is unsplittable.
	if (estimateRenderedSkillsTokens(redacted, renderFormat) > budgetTokens) {
		const residualCharBudget = Math.max(0, Math.floor((budgetTokens * 4) / skills.length));
		for (const entry of redacted) {
			const text = entry.sentences.join(" ");
			const trimmed = trimDescriptionToBudget(text, residualCharBudget);
			entry.sentences = trimmed ? [trimmed] : [];
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

	if (options.mode === "trim") return applyTrimMode(skills, contextWindow, maxContextShare);
	return applyCapMode(skills, contextWindow, maxContextShare, renderFormat);
}
