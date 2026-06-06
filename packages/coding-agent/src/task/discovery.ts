/**
 * Agent discovery from filesystem.
 *
 * Discovers agent definitions from:
 *   - ~/.omp/agent/agents/*.md (user-level, primary)
 *   - ~/.pi/agent/agents/*.md (user-level, legacy)
 *   - ~/.claude/agents/*.md (user-level, legacy)
 *   - .omp/agents/*.md (project-level, primary)
 *   - .pi/agents/*.md (project-level, legacy)
 *   - .claude/agents/*.md (project-level, legacy)
 *   - ~/.copilot/agents/*.md (user-level, GitHub Copilot; relocatable via COPILOT_HOME)
 *   - .github/agents/*.md (project-level, GitHub Copilot)
 *
 * Agent files use markdown with YAML frontmatter.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { isProviderEnabled } from "../capability";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { listClaudePluginRoots } from "../discovery/helpers";
import { loadBundledAgents, parseAgent } from "./agents";
import type { AgentDefinition, AgentSource } from "./types";

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			return fs
				.readFile(filePath, "utf-8")
				.then(content => parseAgent(filePath, content, source, "warn"))
				.catch(error => {
					logger.warn("Failed to read agent file", { filePath, error });
					return null;
				});
		});

	return (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
}

/**
 * Find the nearest `.github/agents` directory, walking up from `startDir`. Mirrors how
 * project config dirs are resolved so Copilot agents work from monorepo subdirectories.
 */
async function findNearestCopilotAgentsDir(startDir: string): Promise<string | null> {
	let dir = startDir;
	while (true) {
		const candidate = path.join(dir, ".github", "agents");
		const isDir = await fs
			.stat(candidate)
			.then(s => s.isDirectory())
			.catch(() => false);
		if (isDir) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Load GitHub Copilot agent files from a directory. Copilot agent profiles use the
 * `.agent.md` (or `.md`) extension and may omit `name` — the filename (minus the
 * extension) is then the identity — so a filename-derived fallback name is supplied.
 */
async function loadCopilotAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			const fallbackName = file.name.replace(/\.agent\.md$/, "").replace(/\.md$/, "");
			return fs
				.readFile(filePath, "utf-8")
				.then(content => parseAgent(filePath, content, source, "warn", fallbackName))
				.catch(error => {
					logger.warn("Failed to read Copilot agent file", { filePath, error });
					return null;
				});
		});

	return (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
}

/**
 * Discover GitHub Copilot custom agents from `~/.copilot/agents/` (user-global,
 * relocatable via COPILOT_HOME) and `.github/agents/` (project, nearest walking up).
 * Per Copilot CLI, a home-directory agent overrides a project agent of the same name,
 * so user agents are returned first (the caller dedupes first-name-wins). Gated on the
 * github discovery provider.
 */
async function loadCopilotAgents(cwd: string, home: string): Promise<AgentDefinition[]> {
	if (!isProviderEnabled("github")) return [];

	const copilotHome = process.env.COPILOT_HOME?.trim() || path.join(home, ".copilot");
	const agents = await loadCopilotAgentsFromDir(path.join(copilotHome, "agents"), "user");

	const projectDir = await findNearestCopilotAgentsDir(cwd);
	if (projectDir) agents.push(...(await loadCopilotAgentsFromDir(projectDir, "project")));

	return agents;
}

/**
 * Discover agents from filesystem and merge with bundled agents.
 *
 * Precedence (highest wins): .omp > .pi > .claude (project before user), then bundled
 *
 * @param cwd - Current working directory for project agent discovery
 */
export async function discoverAgents(cwd: string, home: string = os.homedir()): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);
	const agentSources = Array.from(new Set(getConfigDirs("", { project: false }).map(entry => entry.source)));

	// Get user directories (priority order: .omp, .pi, .claude, ...)
	const userDirs = getConfigDirs("agents", { project: false })
		.filter(entry => agentSources.includes(entry.source))
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	// Get project directories by walking up from cwd (priority order)
	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd)
		.filter(entry => agentSources.includes(entry.source))
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedSources = agentSources.filter(
		source => userDirs.some(entry => entry.source === source) || projectDirs.some(entry => entry.source === source),
	);

	const orderedDirs: Array<{ dir: string; source: AgentSource }> = [];
	for (const source of orderedSources) {
		const project = projectDirs.find(entry => entry.source === source);
		if (project) orderedDirs.push({ dir: project.path, source: "project" });
		const user = userDirs.find(entry => entry.source === source);
		if (user) orderedDirs.push({ dir: user.path, source: "user" });
	}

	// Load agents from Claude Code marketplace plugins (respects disabledProviders)
	const { roots: pluginRoots } = isProviderEnabled("claude-plugins")
		? await listClaudePluginRoots(home, resolvedCwd)
		: { roots: [] };
	const sortedPluginRoots = [...pluginRoots].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "project" ? -1 : 1;
	});
	for (const plugin of sortedPluginRoots) {
		const agentsDir = path.join(plugin.path, "agents");
		orderedDirs.push({ dir: agentsDir, source: plugin.scope === "project" ? "project" : "user" });
	}

	const baseResults = await Promise.all(orderedDirs.map(({ dir, source }) => loadAgentsFromDir(dir, source)));
	// Copilot agents are lowest priority among discovered sources; within Copilot the
	// user (home) dir wins over the project dir, so it is loaded first.
	const copilotAgents = await loadCopilotAgents(resolvedCwd, home);

	const seen = new Set<string>();
	const loadedAgents = [...baseResults.flat(), ...copilotAgents].filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0].path : null;

	return { agents: [...loadedAgents, ...bundledAgents], projectAgentsDir };
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}
