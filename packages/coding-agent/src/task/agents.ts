/**
 * Bundled agent definitions.
 *
 * Agents are embedded at build time via Bun's import with { type: "text" }.
 */
import { Effort } from "@oh-my-pi/pi-ai";
import { parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import { parseAgentFields } from "../discovery/helpers";
import designerMd from "../prompts/agents/designer.md" with { type: "text" };
import exploreMd from "../prompts/agents/explore.md" with { type: "text" };
// Embed agent markdown files at build time
import agentFrontmatterTemplate from "../prompts/agents/frontmatter.md" with { type: "text" };
import librarianMd from "../prompts/agents/librarian.md" with { type: "text" };

import planMd from "../prompts/agents/plan.md" with { type: "text" };
import reviewerMd from "../prompts/agents/reviewer.md" with { type: "text" };
import taskMd from "../prompts/agents/task.md" with { type: "text" };

import type { AgentDefinition, AgentSource } from "./types";

interface AgentFrontmatter {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string;
	model?: string | string[];
	thinkingLevel?: string;
	blocking?: boolean;
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
	{ fileName: "explore.md", template: exploreMd },
	{ fileName: "plan.md", template: planMd },
	{ fileName: "designer.md", template: designerMd },
	{ fileName: "reviewer.md", template: reviewerMd },
	{ fileName: "librarian.md", template: librarianMd },
	{
		fileName: "task.md",
		frontmatter: {
			name: "task",
			description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
			spawns: "*",
			model: "pi/task",
			thinkingLevel: Effort.Medium,
		},
		template: taskMd,
	},
	{
		fileName: "quick_task.md",
		frontmatter: {
			name: "quick_task",
			description: "Low-reasoning agent for strictly mechanical updates or data collection only",
			model: "pi/smol",
			thinkingLevel: Effort.Minimal,
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

	toString(): string {
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
		explicitReadOnly: fields.readOnly,
		readOnly: resolveReadOnly(fields.readOnly, fields.tools, KNOWN_READ_TOOLS),
		systemPrompt: body,
		source,
		filePath,
	};
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

// Read-safe tool allowlist. Membership rule + escape hatches: AGENTS.md#read-only-agent-tool-allowlist.
const KNOWN_READ_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"search",
	"find",
	"lsp",
	"ast_grep",
	"web_search",
	"inspect_image",
	"calc",
	"render_mermaid",
	"recall",
	"search_tool_bm25",
	"yield",
	"report_finding",
]);

export function buildReadSafeToolSet(userReadSafeTools: readonly string[] = []): ReadonlySet<string> {
	if (userReadSafeTools.length === 0) return KNOWN_READ_TOOLS;
	return new Set<string>([...KNOWN_READ_TOOLS, ...userReadSafeTools]);
}

function resolveReadOnly(
	explicit: boolean | undefined,
	tools: string[] | undefined,
	readSafeSet: ReadonlySet<string>,
): boolean {
	if (explicit !== undefined) return explicit;
	if (!tools || tools.length === 0) return false;
	return tools.every(name => readSafeSet.has(name));
}

export function isAgentReadOnly(
	agent: { readOnly?: boolean; tools?: string[] },
	userReadSafeTools: readonly string[] = [],
): boolean {
	return resolveReadOnly(agent.readOnly, agent.tools, buildReadSafeToolSet(userReadSafeTools));
}

export function applyUserReadSafeTools(
	agents: AgentDefinition[],
	userReadSafeTools: readonly string[],
): AgentDefinition[] {
	if (userReadSafeTools.length === 0) return agents;
	const extendedSet = buildReadSafeToolSet(userReadSafeTools);
	return agents.map(agent => {
		const readOnly =
			agent.explicitReadOnly !== undefined
				? agent.explicitReadOnly
				: resolveReadOnly(undefined, agent.tools, extendedSet);
		const shouldAugmentTools = agent.source === "bundled" && agent.tools !== undefined;
		if (!shouldAugmentTools && readOnly === agent.readOnly) return agent;
		const tools = shouldAugmentTools ? [...new Set([...agent.tools!, ...userReadSafeTools])] : agent.tools;
		return { ...agent, readOnly, tools };
	});
}

// Verbs that, in imperative position (first word after optional markdown markup), unambiguously
// indicate file edits or state-changing commands. Deliberately conservative: misses are absorbed
// by the [CAPABILITY] block in the subagent system prompt; false positives force re-dispatch as
// `task`, but they also block a possibly-legitimate read-only run, so we err toward inclusion of
// only verbs whose dominant usage is imperative file/code mutation.
//
// Deliberately EXCLUDED because they appear too often in investigation prose describing code
// behavior or summarizing findings: add, build, commit, convert, create, delete, extract,
// generate, patch, port, remove, replace, rewrite, update, write.
const WRITE_INTENT_VERBS: ReadonlySet<string> = new Set([
	"edit",
	"fix",
	"implement",
	"install",
	"migrate",
	"modify",
	"refactor",
	"rename",
	"scaffold",
]);

// Strips leading markdown list/heading markers (`#`, `*`, `-`, `>`, `1.`) and one optional
// "Label:" prefix so "# Change\nRefactor X" and "Goal: Refactor X" both surface "Refactor".
const IMPERATIVE_PREFIX = /^\s*(?:(?:[#*\->]+|\d+[.)])\s+)*(?:[a-zA-Z][a-zA-Z _-]*:\s+)?/;
const FIRST_WORD = /^([a-zA-Z]+)\b/;

/**
 * Heuristic: does the assignment imperatively request file edits or state-changing commands?
 * Scans each line's first content word (after markdown markup) against {@link WRITE_INTENT_VERBS}.
 * Conservative by design — see {@link WRITE_INTENT_VERBS} comment for the failure-mode tradeoff.
 */
export function assignmentRequiresWrite(assignment: string): boolean {
	for (const rawLine of assignment.split("\n")) {
		const stripped = rawLine.replace(IMPERATIVE_PREFIX, "");
		const match = stripped.match(FIRST_WORD);
		if (!match) continue;
		if (WRITE_INTENT_VERBS.has(match[1].toLowerCase())) return true;
	}
	return false;
}
