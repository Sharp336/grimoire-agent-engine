/**
 * Claude Code Marketplace Plugin Provider
 *
 * Loads configuration from ~/.claude/plugins/cache/ based on installed_plugins.json registry.
 * Priority: 70 (below claude.ts at 80, so user overrides in .claude/ take precedence)
 */
import * as path from "node:path";
import { tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	type ClaudePluginRoot,
	createSourceMeta,
	expandEnvVarsDeep,
	listClaudePluginRoots,
	loadFilesFromDir,
	readClaudeEnabledPlugins,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "claude-plugins";
const DISPLAY_NAME = "Claude Code Marketplace";
const PRIORITY = 70; // Below claude.ts (80) so user .claude/ overrides win

// =============================================================================
// Skills
// =============================================================================

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listClaudePluginRoots(ctx.home);
	warnings.push(...rootWarnings);

	const results = await Promise.all(
		roots.map(async root => {
			const skillsDir = path.join(root.path, "skills");
			return scanSkillsFromDir(ctx, {
				dir: skillsDir,
				providerId: PROVIDER_ID,
				level: root.scope,
			});
		}),
	);

	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Slash Commands
// =============================================================================

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listClaudePluginRoots(ctx.home);
	warnings.push(...rootWarnings);

	const results = await Promise.all(
		roots.map(async root => {
			const commandsDir = path.join(root.path, "commands");
			return loadFilesFromDir<SlashCommand>(ctx, commandsDir, PROVIDER_ID, root.scope, {
				extensions: ["md"],
				transform: (name, content, filePath, source) => {
					const cmdName = name.replace(/\.md$/, "");
					return {
						name: cmdName,
						path: filePath,
						content,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Hooks
// =============================================================================

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const items: Hook[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listClaudePluginRoots(ctx.home);
	warnings.push(...rootWarnings);

	const hookTypes = ["pre", "post"] as const;

	const loadTasks: { root: ClaudePluginRoot; hookType: "pre" | "post" }[] = [];
	for (const root of roots) {
		for (const hookType of hookTypes) {
			loadTasks.push({ root, hookType });
		}
	}

	const results = await Promise.all(
		loadTasks.map(async ({ root, hookType }) => {
			const hooksDir = path.join(root.path, "hooks", hookType);
			return loadFilesFromDir<Hook>(ctx, hooksDir, PROVIDER_ID, root.scope, {
				transform: (name, _content, filePath, source) => {
					const toolName = name.replace(/\.(sh|bash|zsh|fish)$/, "");
					return {
						name,
						path: filePath,
						type: hookType,
						tool: toolName,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Custom Tools
// =============================================================================

async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const items: CustomTool[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listClaudePluginRoots(ctx.home);
	warnings.push(...rootWarnings);

	const results = await Promise.all(
		roots.map(async root => {
			const toolsDir = path.join(root.path, "tools");
			return loadFilesFromDir<CustomTool>(ctx, toolsDir, PROVIDER_ID, root.scope, {
				transform: (name, _content, filePath, source) => {
					const toolName = name.replace(/\.(ts|js|sh|bash|py)$/, "");
					return {
						name: toolName,
						path: filePath,
						description: `${toolName} custom tool`,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// MCP Servers
// =============================================================================

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listClaudePluginRoots(ctx.home);
	warnings.push(...rootWarnings);

	if (roots.length === 0) return { items, warnings };

	// Read enabledPlugins to gate which plugins contribute MCP servers.
	// If no enabledPlugins map exists, all installed plugins are considered enabled.
	const enabledPlugins = await readClaudeEnabledPlugins(ctx.home);

	const serverResults = await Promise.all(
		roots.map(async root => {
			// Check if plugin is enabled
			if (enabledPlugins !== null && !enabledPlugins.has(root.id)) {
				return [];
			}

			const mcpJsonPath = path.join(root.path, ".mcp.json");
			const content = await readFile(mcpJsonPath);
			if (!content) return [];

			const json = tryParseJson<Record<string, unknown>>(content);
			if (!json) {
				warnings.push(`Failed to parse ${mcpJsonPath}`);
				return [];
			}

			// Standard format: { mcpServers: { name: config } }
			const mcpServers = json.mcpServers as Record<string, unknown> | undefined;
			const serverEntries = mcpServers
				? Object.entries(expandEnvVarsDeep(mcpServers))
				: // Flat format fallback: { name: { command, args } } (no mcpServers wrapper)
					Object.entries(expandEnvVarsDeep(json));

			const servers: MCPServer[] = [];
			for (const [name, config] of serverEntries) {
				if (name.startsWith("$") || typeof config !== "object" || config === null) continue;
				const serverConfig = config as Record<string, unknown>;
				// Skip non-server entries (e.g., $schema)
				if (!serverConfig.command && !serverConfig.url && !serverConfig.type) continue;

				servers.push({
					name,
					timeout: typeof serverConfig.timeout === "number" ? serverConfig.timeout : undefined,
					command: serverConfig.command as string | undefined,
					args: serverConfig.args as string[] | undefined,
					env: serverConfig.env as Record<string, string> | undefined,
					url: serverConfig.url as string | undefined,
					headers: serverConfig.headers as Record<string, string> | undefined,
					transport: serverConfig.type as "stdio" | "sse" | "http" | undefined,
					oauth: serverConfig.oauth as MCPServer["oauth"],
					auth: serverConfig.auth as MCPServer["auth"],
					_source: createSourceMeta(PROVIDER_ID, mcpJsonPath, root.scope),
				});
			}
			return servers;
		}),
	);

	for (const servers of serverResults) {
		items.push(...servers);
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from Claude Code marketplace plugins (~/.claude/plugins/cache/)",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load slash commands from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load hooks from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadHooks,
});

registerProvider<CustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load custom tools from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadTools,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from Claude Code marketplace plugin .mcp.json files",
	priority: PRIORITY,
	load: loadMCPServers,
});
