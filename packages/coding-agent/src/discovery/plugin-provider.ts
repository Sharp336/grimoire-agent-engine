/**
 * Shared factory for marketplace plugin capability providers.
 *
 * Both `claude-plugins` and `omp-plugins` load capabilities from plugin roots
 * using identical logic — they differ only in which root-list function they
 * call and their provider metadata.  This module extracts that common pattern
 * so each provider file is a thin configuration call.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import { type ClaudePluginRoot, createSourceMeta, loadFilesFromDir, scanSkillsFromDir } from "./helpers";
import { substitutePluginRoot } from "./substitute-plugin-root";

export interface PluginProviderConfig {
	providerId: string;
	displayName: string;
	priority: number;
	/** Human-readable label used in registration descriptions, e.g. "OMP marketplace plugins". */
	label: string;
	listRoots: (home: string, cwd?: string) => Promise<{ roots: ClaudePluginRoot[]; warnings: string[] }>;
}

// ─── Loader factories ────────────────────────────────────────────────────────

function makeLoadSkills(cfg: PluginProviderConfig) {
	return async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
		const items: Skill[] = [];
		const warnings: string[] = [];

		const { roots, warnings: rootWarnings } = await cfg.listRoots(ctx.home, ctx.cwd);
		warnings.push(...rootWarnings);

		const results = await Promise.all(
			roots.map(async root => {
				const skillsDir = path.join(root.path, "skills");
				const result = await scanSkillsFromDir(ctx, {
					dir: skillsDir,
					providerId: cfg.providerId,
					level: root.scope,
				});
				return { root, result };
			}),
		);

		for (const { root, result } of results) {
			for (const skill of result.items) {
				if (root.plugin) skill.name = `${root.plugin}:${skill.name}`;
				items.push(skill);
			}
			if (result.warnings) warnings.push(...result.warnings);
		}

		return { items, warnings };
	};
}

function makeLoadSlashCommands(cfg: PluginProviderConfig) {
	return async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
		const items: SlashCommand[] = [];
		const warnings: string[] = [];

		const { roots, warnings: rootWarnings } = await cfg.listRoots(ctx.home, ctx.cwd);
		warnings.push(...rootWarnings);

		const results = await Promise.all(
			roots.map(async root => {
				const commandsDir = path.join(root.path, "commands");
				return loadFilesFromDir<SlashCommand>(ctx, commandsDir, cfg.providerId, root.scope, {
					extensions: ["md"],
					transform: (name, content, filePath, source) => {
						const cmdName = name.replace(/\.md$/, "");
						return {
							name: root.plugin ? `${root.plugin}:${cmdName}` : cmdName,
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
	};
}

function makeLoadHooks(cfg: PluginProviderConfig) {
	return async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
		const items: Hook[] = [];
		const warnings: string[] = [];

		const { roots, warnings: rootWarnings } = await cfg.listRoots(ctx.home, ctx.cwd);
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
				return loadFilesFromDir<Hook>(ctx, hooksDir, cfg.providerId, root.scope, {
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
	};
}

function makeLoadTools(cfg: PluginProviderConfig) {
	return async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
		const items: CustomTool[] = [];
		const warnings: string[] = [];

		const { roots, warnings: rootWarnings } = await cfg.listRoots(ctx.home, ctx.cwd);
		warnings.push(...rootWarnings);

		const results = await Promise.all(
			roots.map(async root => {
				const toolsDir = path.join(root.path, "tools");
				return loadFilesFromDir<CustomTool>(ctx, toolsDir, cfg.providerId, root.scope, {
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
	};
}

function makeLoadMCPServers(cfg: PluginProviderConfig) {
	return async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
		const items: MCPServer[] = [];
		const warnings: string[] = [];

		const { roots, warnings: rootWarnings } = await cfg.listRoots(ctx.home, ctx.cwd);
		warnings.push(...rootWarnings);

		for (const root of roots) {
			const mcpPath = path.join(root.path, ".mcp.json");
			const raw = await readFile(mcpPath);
			if (raw === null) continue; // file absent — skip silently

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				warnings.push(`[${cfg.providerId}] Invalid JSON in ${mcpPath}`);
				logger.warn(`[${cfg.providerId}] Invalid JSON in ${mcpPath}`);
				continue;
			}

			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const config = parsed as { mcpServers?: Record<string, unknown> };
			if (!config.mcpServers || typeof config.mcpServers !== "object") continue;

			for (const [serverName, serverCfg] of Object.entries(config.mcpServers)) {
				if (!serverCfg || typeof serverCfg !== "object" || Array.isArray(serverCfg)) continue;
				const raw = serverCfg as {
					enabled?: boolean;
					timeout?: number;
					command?: string;
					args?: string[];
					env?: Record<string, string>;
					cwd?: string;
					url?: string;
					headers?: Record<string, string>;
					auth?: MCPServer["auth"];
					oauth?: MCPServer["oauth"];
					type?: string;
				};
				const namespacedName = root.plugin ? `${root.plugin}:${serverName}` : serverName;
				const server: MCPServer = {
					name: namespacedName,
					...(raw.enabled !== undefined && { enabled: raw.enabled }),
					...(raw.timeout !== undefined && { timeout: raw.timeout }),
					...(raw.command !== undefined && { command: substitutePluginRoot(raw.command, root.path) }),
					...(raw.args !== undefined && { args: substitutePluginRoot(raw.args, root.path) }),
					...(raw.env !== undefined && { env: substitutePluginRoot(raw.env, root.path) }),
					...(raw.cwd !== undefined && { cwd: substitutePluginRoot(raw.cwd, root.path) }),
					...(raw.url !== undefined && { url: raw.url }),
					...(raw.headers !== undefined && { headers: raw.headers }),
					...(raw.auth !== undefined && { auth: raw.auth }),
					...(raw.oauth !== undefined && { oauth: raw.oauth }),
					...(raw.type !== undefined && { transport: raw.type as MCPServer["transport"] }),
					_source: createSourceMeta(cfg.providerId, mcpPath, root.scope),
				};
				items.push(server);
			}
		}

		return { items, warnings };
	};
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Register a marketplace plugin provider for all five capability types.
 *
 * Call at module scope (side-effect import) so providers register during startup.
 */
export function registerPluginProvider(cfg: PluginProviderConfig): void {
	const { providerId, displayName, priority, label } = cfg;
	const reg = <T>(capId: string, desc: string, load: (ctx: LoadContext) => Promise<LoadResult<T>>) =>
		registerProvider<T>(capId, { id: providerId, displayName, description: desc, priority, load });

	reg<Skill>(skillCapability.id, `Load skills from ${label}`, makeLoadSkills(cfg));
	reg<SlashCommand>(slashCommandCapability.id, `Load slash commands from ${label}`, makeLoadSlashCommands(cfg));
	reg<Hook>(hookCapability.id, `Load hooks from ${label}`, makeLoadHooks(cfg));
	reg<CustomTool>(toolCapability.id, `Load custom tools from ${label}`, makeLoadTools(cfg));
	reg<MCPServer>(mcpCapability.id, `Load MCP servers from ${label}`, makeLoadMCPServers(cfg));
}
