/**
 * GitHub Copilot Provider
 *
 * Loads configuration from GitHub Copilot's config directories.
 * Priority: 30 (shared standard provider)
 *
 * Sources:
 * - Project: .github/ (project-only, no user-level discovery)
 *
 * Capabilities:
 * - context-files: copilot-instructions.md in .github/
 * - instructions: *.instructions.md in .github/instructions/ with applyTo frontmatter
 * - skills: <name>/SKILL.md in .github/skills/ (GitHub Agent Skills layout)
 */
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import { type Instruction, instructionCapability } from "../capability/instruction";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";

import {
	calculateDepth,
	createSourceMeta,
	expandEnvVarsDeep,
	getProjectPath,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "github";
const DISPLAY_NAME = "GitHub Copilot";
const PRIORITY = 30;

// =============================================================================
// MCP Servers
// =============================================================================

type GitHubCopilotMcpConfig = {
	servers?: Record<string, unknown>;
	mcpServers?: Record<string, unknown>;
};

function parseMCPServers(content: string, filePath: string): LoadResult<MCPServer> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const parsed = JSON.parse(content) as GitHubCopilotMcpConfig;
	const rawServers = parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : parsed.servers;
	if (!rawServers || typeof rawServers !== "object") {
		warnings.push(`${filePath}: missing or invalid 'servers'/'mcpServers' key`);
		return { items, warnings };
	}

	const servers = expandEnvVarsDeep(rawServers);
	for (const [name, config] of Object.entries(servers)) {
		if (!config || typeof config !== "object") {
			warnings.push(`Invalid MCP config for "${name}" in ${filePath}`);
			continue;
		}

		const serverConfig = config as Record<string, unknown>;
		items.push({
			name,
			command: typeof serverConfig.command === "string" ? serverConfig.command : undefined,
			args: Array.isArray(serverConfig.args) ? (serverConfig.args as string[]) : undefined,
			env:
				serverConfig.env && typeof serverConfig.env === "object"
					? (serverConfig.env as Record<string, string>)
					: undefined,
			url: typeof serverConfig.url === "string" ? serverConfig.url : undefined,
			headers:
				serverConfig.headers && typeof serverConfig.headers === "object"
					? (serverConfig.headers as Record<string, string>)
					: undefined,
			transport: ["stdio", "sse", "http"].includes(serverConfig.type as string)
				? (serverConfig.type as "stdio" | "sse" | "http")
				: undefined,
			timeout: typeof serverConfig.timeout === "number" ? serverConfig.timeout : undefined,
			_source: createSourceMeta(PROVIDER_ID, filePath, "user"),
		});
	}

	return { items, warnings };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const copilotMcpPath = path.join(ctx.home, ".copilot", "mcp-config.json");
	const content = await readFile(copilotMcpPath);
	if (!content) return { items: [], warnings: [] };

	try {
		return parseMCPServers(content, copilotMcpPath);
	} catch {
		return { items: [], warnings: [`Invalid JSON in ${copilotMcpPath}`] };
	}
}

// =============================================================================
// Context Files
// =============================================================================

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	const copilotInstructionsPath = getProjectPath(ctx, "github", "copilot-instructions.md");
	if (copilotInstructionsPath) {
		const content = await readFile(copilotInstructionsPath);
		if (content) {
			const fileDir = path.dirname(copilotInstructionsPath);
			const depth = calculateDepth(ctx.cwd, fileDir, path.sep);

			items.push({
				path: copilotInstructionsPath,
				content,
				level: "project",
				depth,
				_source: createSourceMeta(PROVIDER_ID, copilotInstructionsPath, "project"),
			});
		}
	}

	return { items, warnings };
}

// =============================================================================
// Instructions
// =============================================================================

async function loadInstructions(ctx: LoadContext): Promise<LoadResult<Instruction>> {
	const items: Instruction[] = [];
	const warnings: string[] = [];

	const instructionsDir = getProjectPath(ctx, "github", "instructions");
	if (instructionsDir) {
		const result = await loadFilesFromDir<Instruction>(ctx, instructionsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: transformInstruction,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

function transformInstruction(name: string, content: string, filePath: string, source: SourceMeta): Instruction | null {
	// Only process .instructions.md files
	if (!name.endsWith(".instructions.md")) {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });

	// Extract applyTo glob pattern from frontmatter
	const applyTo = typeof frontmatter.applyTo === "string" ? frontmatter.applyTo : undefined;

	// Derive name from filename (strip .instructions.md suffix)
	const instructionName = path.basename(name, ".instructions.md");

	return {
		name: instructionName,
		path: filePath,
		content: body,
		applyTo,
		_source: source,
	};
}

// =============================================================================
// Skills
// =============================================================================

/**
 * Load skills from `.github/skills/<name>/SKILL.md`.
 *
 * GitHub documents this layout for Copilot Agent Skills and matches the
 * non-recursive shape `scanSkillsFromDir` already expects. `requireDescription`
 * is on to match the Agent Skills spec (name + description are mandatory) and
 * the sibling `native`/`omp-plugins` providers.
 *
 * @see https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills
 */
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const skillsDir = getProjectPath(ctx, "github", "skills");
	if (!skillsDir) return { items: [], warnings: [] };

	return scanSkillsFromDir(ctx, {
		dir: skillsDir,
		providerId: PROVIDER_ID,
		level: "project",
		requireDescription: true,
	});
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from ~/.copilot/mcp-config.json",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load copilot-instructions.md from .github/",
	priority: PRIORITY,
	load: loadContextFiles,
});

registerProvider(instructionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load *.instructions.md from .github/instructions/ with applyTo frontmatter",
	priority: PRIORITY,
	load: loadInstructions,
});

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from .github/skills/*/SKILL.md",
	priority: PRIORITY,
	load: loadSkills,
});
