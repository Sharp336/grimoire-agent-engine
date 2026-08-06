/**
 * Bundled agent definitions.
 *
 * Agents are embedded at build time via Bun's import with { type: "text" }.
 */
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { parseAgentFields } from "../discovery/helpers";
import designerMd from "../prompts/agents/designer.md" with { type: "text" };
// Embed agent markdown files at build time
import agentFrontmatterTemplate from "../prompts/agents/frontmatter.md" with { type: "text" };
import librarianMd from "../prompts/agents/librarian.md" with { type: "text" };
import reviewerMd from "../prompts/agents/reviewer.md" with { type: "text" };
import scoutMd from "../prompts/agents/scout.md" with { type: "text" };
import securityReviewerMd from "../prompts/agents/security-reviewer.md" with { type: "text" };
import taskMd from "../prompts/agents/task.md" with { type: "text" };
import { AUTO_THINKING } from "../thinking";

import type { AgentDefinition, AgentSource } from "./types";

interface AgentFrontmatter {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string;
	model?: string | string[];
	thinkingLevel?: string;
	blocking?: boolean;
	prewalk?: boolean | string;
}

interface EmbeddedAgentDef {
	fileName: string;
	frontmatter?: AgentFrontmatter;
	template: string;
}

function buildAgentContent(def: EmbeddedAgentDef): string {
	const body = prompt.render(def.template);
	if (!def.frontmatter) return body;
	return prompt.render(agentFrontmatterTemplate, { ...def.frontmatter, body });
}

const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef[] = [
	{ fileName: "scout.md", template: scoutMd },
	{ fileName: "designer.md", template: designerMd },
	{ fileName: "reviewer.md", template: reviewerMd },
	{ fileName: "security-reviewer.md", template: securityReviewerMd },
	{ fileName: "librarian.md", template: librarianMd },
	{
		fileName: "task.md",
		frontmatter: {
			name: "task",
			description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
			spawns: "*",
			model: "@task",
			thinkingLevel: AUTO_THINKING,
			// No `prewalk` frontmatter: the generic task hand-off (strong model
			// plans, then hands off to the smol role) is armed by the
			// `task.prewalk` setting (default off) or per agent via /agents
			// (task.agentPrewalk).
		},
		template: taskMd,
	},
	{
		fileName: "sonic.md",
		frontmatter: {
			name: "sonic",
			description: "Low-reasoning agent for strictly mechanical updates or data collection only",
			model: "@smol",
			thinkingLevel: Effort.Medium,
		},
		template: taskMd,
	},
];

// Computed lazily on first loadBundledAgents() call to avoid eager prompt.render at module load.

export class AgentParsingError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse agent: ${error.message}`, { cause: error });
		this.name = "AgentParsingError";
	}

	override toString(): string {
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

/**
 * Parse an agent from embedded content.
 */
export function parseAgent(
	filePath: string,
	content: string,
	source: AgentSource,
	level: "fatal" | "warn" | "off" = "fatal",
): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter(content, {
		location: filePath,
		level,
	});
	const fields = parseAgentFields(frontmatter);
	if (!fields) {
		throw new AgentParsingError(new Error(`Invalid agent field: ${filePath}\n${content}`), filePath);
	}
	return {
		...fields,
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Build the frontmatter record for an agent definition with a fresh `advisors` list. */
function buildAdvisorFrontmatterRecord(agent: AgentDefinition, advisors: string[]): Record<string, unknown> {
	const record: Record<string, unknown> = {
		name: agent.name,
		description: agent.description,
	};
	if (agent.tools && agent.tools.length > 0) record.tools = agent.tools;
	if (agent.spawns !== undefined) record.spawns = agent.spawns;
	if (advisors.length > 0) record.advisors = advisors;
	if (agent.model && agent.model.length > 0) record.model = agent.model;
	if (agent.thinkingLevel !== undefined) record.thinkingLevel = agent.thinkingLevel;
	if (agent.output !== undefined) record.output = agent.output;
	if (agent.autoloadSkills && agent.autoloadSkills.length > 0) record.autoloadSkills = agent.autoloadSkills;
	if (agent.readSummarize !== undefined) record.readSummarize = agent.readSummarize;
	if (agent.blocking !== undefined) record.blocking = agent.blocking;
	if (agent.prewalk !== undefined) record.prewalk = agent.prewalk;
	return record;
}

/**
 * Parse a raw frontmatter block into a record; falls back to the normalized
 * frontmatter parser when the raw YAML fails to parse.
 */
function parseRawFrontmatterRecord(block: string, raw: string): Record<string, unknown> {
	try {
		const parsed = YAML.parse(block);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Fall through to the normalized frontmatter parser.
	}
	return parseFrontmatter(raw).frontmatter;
}

/**
 * Rewrite only the `advisors` key of a raw agent file's frontmatter, splicing
 * the raw block so the body and all unrelated keys survive unchanged.
 */
function updateAdvisorsFrontmatter(raw: string, advisors: string[], agent: AgentDefinition): string {
	const endIndex = raw.startsWith("---") ? raw.indexOf("\n---", 3) : -1;
	const record =
		endIndex !== -1
			? parseRawFrontmatterRecord(raw.slice(4, endIndex), raw)
			: buildAdvisorFrontmatterRecord(agent, advisors);
	if (advisors.length > 0) {
		record.advisors = advisors;
	} else {
		delete record.advisors;
	}
	const yaml = YAML.stringify(record, null, 2).trimEnd();
	if (endIndex !== -1) {
		return `---\n${yaml}${raw.slice(endIndex)}`;
	}
	return `---\n${yaml}\n---\n\n${raw}`;
}

/** Rebuild a full agent file from a definition, replacing the frontmatter's `advisors`. */
function serializeAgentWithAdvisors(agent: AgentDefinition, advisors: string[]): string {
	const record = buildAdvisorFrontmatterRecord(agent, advisors);
	const yaml = YAML.stringify(record, null, 2).trimEnd();
	return `---\n${yaml}\n---\n\n${agent.systemPrompt.trimEnd()}\n`;
}

/** Whether a discovered agent file may be edited where it lives (user or project agents dir). */
function isAgentFileWritableInPlace(filePath: string, userAgentsDir: string): boolean {
	const resolved = path.resolve(filePath);
	return (
		resolved.startsWith(path.resolve(userAgentsDir) + path.sep) ||
		resolved.includes(`${path.sep}.omp${path.sep}agents${path.sep}`)
	);
}

/**
 * Persist an agent definition's `advisors` frontmatter list.
 *
 * Real agent files are edited in place when they live in the user agents dir
 * or any project `.omp/agents` dir. Files anywhere else (plugins, extensions)
 * and bundled `embedded:` definitions are shadowed by writing a copy into
 * `userAgentsDir`, so the edit sticks and discovery precedence keeps the
 * shadowed file winning.
 */
export async function writeAgentAdvisors(
	agent: AgentDefinition,
	advisors: string[],
	userAgentsDir: string,
): Promise<{ filePath: string; shadowed: boolean }> {
	const filePath = agent.filePath;
	if (filePath !== undefined && !filePath.startsWith("embedded:")) {
		const inPlace = isAgentFileWritableInPlace(filePath, userAgentsDir);
		const target = inPlace ? filePath : path.join(userAgentsDir, `${agent.name}.md`);
		const content = updateAdvisorsFrontmatter(await Bun.file(filePath).text(), advisors, agent);
		await Bun.write(target, content);
		return { filePath: target, shadowed: target !== filePath };
	}
	const target = path.join(userAgentsDir, `${agent.name}.md`);
	await Bun.write(target, serializeAgentWithAdvisors(agent, advisors));
	return { filePath: target, shadowed: target !== filePath };
}

/** Cache for bundled agents */
let bundledAgentsCache: AgentDefinition[] | null = null;

/**
 * Load all bundled agents from embedded content.
 * Results are cached after first load.
 */
export function loadBundledAgents(): AgentDefinition[] {
	if (bundledAgentsCache !== null) {
		return bundledAgentsCache;
	}
	bundledAgentsCache = EMBEDDED_AGENT_DEFS.map(def =>
		parseAgent(`embedded:${def.fileName}`, buildAgentContent(def), "bundled"),
	);
	return bundledAgentsCache;
}

/**
 * Get a bundled agent by name.
 */
export function getBundledAgent(name: string): AgentDefinition | undefined {
	return loadBundledAgents().find(a => a.name === name);
}

/**
 * Get all bundled agents as a map keyed by name.
 */
export function getBundledAgentsMap(): Map<string, AgentDefinition> {
	const map = new Map<string, AgentDefinition>();
	for (const agent of loadBundledAgents()) {
		map.set(agent.name, agent);
	}
	return map;
}

/**
 * Clear the bundled agents cache (for testing).
 */
export function clearBundledAgentsCache(): void {
	bundledAgentsCache = null;
}

// Re-export for backward compatibility
export const BUNDLED_AGENTS = loadBundledAgents;
