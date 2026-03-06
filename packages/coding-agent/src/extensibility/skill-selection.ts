import type { Skill } from "./skills";

const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"that",
	"this",
	"into",
	"when",
	"where",
	"what",
	"how",
	"why",
	"can",
	"could",
	"should",
	"would",
	"please",
	"about",
	"need",
	"want",
	"use",
	"using",
	"add",
	"make",
	"build",
	"help",
	"also",
	"just",
]);

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(token => token.length >= 3 && !STOP_WORDS.has(token));
}

function normalizeForPhraseMatch(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreSkill(textTokens: Set<string>, rawText: string, skill: Skill): number {
	let score = 0;
	const normalizedText = rawText.toLowerCase();
	const normalizedName = skill.name.toLowerCase();
	const normalizedTextPhrases = normalizeForPhraseMatch(rawText);
	const normalizedSkillPhrase = normalizeForPhraseMatch(skill.name);

	if (normalizedText.includes(normalizedName)) {
		score += 6;
	}
	if (normalizedText.includes(`$${normalizedName}`)) {
		score += 20;
	}
	if (normalizedTextPhrases.includes(normalizedSkillPhrase)) {
		score += 8;
	}

	const nameParts = tokenize(skill.name);
	let matchedNameParts = 0;
	for (const part of nameParts) {
		if (textTokens.has(part)) {
			score += 3;
			matchedNameParts++;
		}
	}
	if (nameParts.length > 0 && matchedNameParts === nameParts.length) {
		score += 4;
	}

	const descriptionParts = tokenize(skill.description);
	for (const part of descriptionParts) {
		if (textTokens.has(part)) score += 1;
	}

	return score;
}

function detectProcessSkills(userText: string): string[] {
	const normalized = userText.toLowerCase();
	const debugPattern =
		/\b(bug|debug|fix|failing|failure|broken|error|regression|crash|issue|not working|doesn't work|does not work)\b/;
	if (debugPattern.test(normalized)) {
		return ["systematic-debugging", "test-driven-development"];
	}

	const behaviorChangePattern =
		/\b(build|implement|create|add|change|refactor|redesign|customiz|feature|improve|update)\b/;
	if (behaviorChangePattern.test(normalized)) {
		return ["brainstorming", "writing-plans"];
	}

	return [];
}

export function selectPromptSkills(
	skills: readonly Skill[],
	userText: string,
	pinnedSkillNames: readonly string[],
	maxAutoMatches = 3,
): Skill[] {
	if (skills.length === 0) return [];

	const byName = new Map(skills.map(skill => [skill.name.toLowerCase(), skill]));
	const selected: Skill[] = [];
	const selectedNames = new Set<string>();

	for (const pinnedName of pinnedSkillNames) {
		const skill = byName.get(pinnedName.toLowerCase());
		if (!skill) continue;
		selected.push(skill);
		selectedNames.add(skill.name.toLowerCase());
	}

	for (const requiredName of detectProcessSkills(userText)) {
		const skill = byName.get(requiredName);
		if (!skill) continue;
		if (selectedNames.has(skill.name.toLowerCase())) continue;
		selected.push(skill);
		selectedNames.add(skill.name.toLowerCase());
	}

	const tokens = new Set(tokenize(userText));
	if (tokens.size === 0) return selected;

	const scored = skills
		.filter(skill => !selectedNames.has(skill.name.toLowerCase()))
		.map(skill => ({ skill, score: scoreSkill(tokens, userText, skill) }))
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
		.slice(0, Math.max(0, maxAutoMatches))
		.map(item => item.skill);

	return [...selected, ...scored];
}
