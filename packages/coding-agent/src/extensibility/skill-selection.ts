import type { Skill } from "./skills";

function normalizeForPhraseMatch(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isSkillExplicitlyMentioned(userText: string, skillName: string): boolean {
	const normalizedText = userText.toLowerCase();
	const normalizedSkillName = skillName.toLowerCase();
	if (normalizedText.includes(`$${normalizedSkillName}`)) return true;
	if (normalizedText.includes(normalizedSkillName)) return true;
	return normalizeForPhraseMatch(userText).includes(normalizeForPhraseMatch(skillName));
}

export function selectPromptSkills(
	skills: readonly Skill[],
	userText: string,
	pinnedSkillNames: readonly string[],
	_maxAutoMatches = 3,
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

	const explicitlyMentioned = skills
		.filter(skill => !selectedNames.has(skill.name.toLowerCase()))
		.filter(skill => isSkillExplicitlyMentioned(userText, skill.name))
		.sort((a, b) => a.name.localeCompare(b.name));

	return [...selected, ...explicitlyMentioned];
}
