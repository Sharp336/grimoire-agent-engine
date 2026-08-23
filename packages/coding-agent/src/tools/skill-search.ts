import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { compareSkillOrder } from "../discovery/helpers";
import type { Skill } from "../extensibility/skills";
import skillSearchDescription from "../prompts/tools/skill-search.md" with { type: "text" };
import type { ToolSession } from ".";

const skillSearchSchema = type({
	query: type("string").describe("skill name or capability to search for"),
});

export type SkillSearchParams = typeof skillSearchSchema.infer;

export interface SkillSearchMatch {
	name: string;
	description: string;
	path: string;
	source: string;
	score: number;
}

const MAX_RESULTS = 8;

function tokens(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

function scoreSkill(queryTokens: readonly string[], skill: Pick<Skill, "name" | "description">): number {
	const nameTokens = tokens(skill.name);
	const descriptionTokens = tokens(skill.description);
	let score = 0;

	for (const queryToken of queryTokens) {
		if (nameTokens.includes(queryToken)) score += 6;
		else if (nameTokens.some(token => token.startsWith(queryToken))) score += 3;

		if (descriptionTokens.includes(queryToken)) score += 3;
		else if (descriptionTokens.some(token => token.startsWith(queryToken))) score += 1;
	}

	return score;
}

export function searchSkills(skills: readonly Skill[], query: string, limit = MAX_RESULTS): SkillSearchMatch[] {
	const queryTokens = tokens(query);
	if (queryTokens.length === 0) return [];

	return skills
		.filter(skill => skill.hide !== true)
		.map(skill => ({
			skill,
			score: scoreSkill(queryTokens, skill),
		}))
		.filter(match => match.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score || compareSkillOrder(a.skill.name, a.skill.filePath, b.skill.name, b.skill.filePath),
		)
		.slice(0, limit)
		.map(({ skill, score }) => ({
			name: skill.name,
			description: skill.description,
			path: `skill://${skill.name}`,
			source: skill.source,
			score,
		}));
}

export class SkillSearchTool implements AgentTool<typeof skillSearchSchema> {
	readonly name = "skill_search";
	readonly approval = "read" as const;
	readonly label = "Skill Search";
	readonly description = skillSearchDescription;
	readonly parameters = skillSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Search local skill metadata";

	constructor(private readonly session: Pick<ToolSession, "skills">) {}

	async execute(_id: string, params: SkillSearchParams): Promise<AgentToolResult> {
		const matches = searchSkills(this.session.skills ?? [], params.query);
		if (matches.length === 0) {
			return {
				content: [{ type: "text", text: "No matching skills found." }],
				details: { query: params.query, results: [] },
				useless: true,
			};
		}

		const lines = [
			`Found ${matches.length} matching ${matches.length === 1 ? "skill" : "skills"}:`,
			...matches.map(match => `- ${match.path} (${match.score}): ${match.description}`),
			`Use read with ${matches[0].path} to load the full skill instructions.`,
		];

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { query: params.query, results: matches },
		};
	}
}
