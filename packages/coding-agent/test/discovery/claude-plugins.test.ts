import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	clearClaudePluginRootsCache,
	listClaudeOnlyPluginRoots,
	listClaudePluginRoots,
	listOmpOnlyPluginRoots,
	parseClaudePluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import type { SlashCommand } from "@oh-my-pi/pi-coding-agent/capability/slash-command";

describe("parseClaudePluginsRegistry", () => {
	test("parses valid registry", () => {
		const content = JSON.stringify({
			version: 2,
			plugins: {
				"my-plugin@marketplace": [
					{
						scope: "user",
						installPath: "/path/to/plugin",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		});

		const result = parseClaudePluginsRegistry(content);
		expect(result).not.toBeNull();
		expect(result?.version).toBe(2);
		expect(result?.plugins["my-plugin@marketplace"]).toHaveLength(1);
	});

	test("returns null for invalid JSON", () => {
		expect(parseClaudePluginsRegistry("not json")).toBeNull();
	});

	test("returns null for missing version", () => {
		const content = JSON.stringify({ plugins: {} });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});

	test("returns null for missing plugins", () => {
		const content = JSON.stringify({ version: 2 });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});

	test("returns null for null plugins", () => {
		const content = JSON.stringify({ version: 2, plugins: null });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});
});

describe("listClaudePluginRoots", () => {
	let tempDir: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("returns empty roots when no registry file exists", async () => {
		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("parses plugin with user scope", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"test-plugin@test-market": [
					{
						scope: "user",
						installPath: "/path/to/test-plugin",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0]).toEqual({
			id: "test-plugin@test-market",
			marketplace: "test-market",
			plugin: "test-plugin",
			version: "1.0.0",
			path: "/path/to/test-plugin",
			scope: "user",
			registrySource: "claude",
		});
	});

	test("parses plugin with project scope", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"project-plugin@market": [
					{
						scope: "project",
						installPath: "/path/to/project-plugin",
						version: "2.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0].scope).toBe("project");
	});

	test("handles multiple entries per plugin ID", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"multi-plugin@market": [
					{
						scope: "user",
						installPath: "/path/to/v2",
						version: "2.0.0",
						installedAt: "2025-01-02T00:00:00Z",
						lastUpdated: "2025-01-02T00:00:00Z",
					},
					{
						scope: "project",
						installPath: "/path/to/v1",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		// Should return both entries, not just the first one
		expect(result.roots).toHaveLength(2);
		expect(result.roots[0].version).toBe("2.0.0");
		expect(result.roots[0].scope).toBe("user");
		expect(result.roots[1].version).toBe("1.0.0");
		expect(result.roots[1].scope).toBe("project");
	});

	test("warns on invalid plugin ID format", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"invalid-no-at-symbol": [
					{
						scope: "user",
						installPath: "/path/to/invalid",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("Invalid plugin ID format");
	});

	test("warns on entry without installPath", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"no-path@market": [
					{
						scope: "user",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("has no installPath");
	});

	test("caches results for same home directory", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry: {
			version: number;
			plugins: Record<
				string,
				Array<{ scope: string; installPath: string; version: string; installedAt: string; lastUpdated: string }>
			>;
		} = {
			version: 2,
			plugins: {
				"cached-plugin@market": [
					{
						scope: "user",
						installPath: "/path/to/cached",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		// First call
		const result1 = await listClaudePluginRoots(tempDir);
		expect(result1.roots).toHaveLength(1);

		// Modify the file
		registry.plugins["new-plugin@market"] = [
			{
				scope: "user",
				installPath: "/path/to/new",
				version: "1.0.0",
				installedAt: "2025-01-01T00:00:00Z",
				lastUpdated: "2025-01-01T00:00:00Z",
			},
		];
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		// Second call should return cached result (still 1 plugin)
		const result2 = await listClaudePluginRoots(tempDir);
		expect(result2.roots).toHaveLength(1);

		// After clearing cache, should see new plugin
		clearClaudePluginRootsCache();
		clearFsCache(); // Also clear fs cache so the file is re-read
		const result3 = await listClaudePluginRoots(tempDir);
		expect(result3.roots).toHaveLength(2);
	});

	test("defaults scope to user when not specified", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"no-scope@market": [
					{
						installPath: "/path/to/no-scope",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0].scope).toBe("user");
	});
	test("reads skills directory from plugin manifest skills field", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-skills");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "skills", "manifest-skill"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-skills@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: "./.claude/skills" }),
		);
		await fs.writeFile(
			path.join(pluginPath, ".claude", "skills", "manifest-skill", "SKILL.md"),
			"---\nname: manifest-skill\ndescription: Manifest skill\n---\nBody\n",
		);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		expect(result.all.length).toBeGreaterThan(0);
		const found = result.all.find(skill => skill.name === "manifest-skills:manifest-skill");

		expect(found).toBeDefined();
		expect(found?.path).toContain(path.join(".claude", "skills", "manifest-skill", "SKILL.md"));
	});

	test("reads slash commands directory from plugin manifest slash-commands field", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "commands"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ "slash-commands": "./.claude/commands" }),
		);
		await fs.writeFile(path.join(pluginPath, ".claude", "commands", "ship.md"), "Ship it\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		expect(result.all.length).toBeGreaterThan(0);
		const found = result.all.find(command => command.name === "manifest-commands:ship");

		expect(found).toBeDefined();
		expect(found?.path).toContain(path.join(".claude", "commands", "ship.md"));
	});
	test("ignores manifest skills directory that resolves outside plugin root", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-skills-outside");
		const outsideDir = path.join(tempDir, "outside-skills", "outside-skill");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(outsideDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-skills-outside@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: "../../outside-skills" }),
		);
		await fs.writeFile(
			path.join(outsideDir, "SKILL.md"),
			"---\nname: outside-skill\ndescription: Outside skill\n---\nBody\n",
		);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.warnings[0]).toContain("Ignoring skills path outside plugin root");
		const found = result.all.find(skill => skill.name === "manifest-skills-outside:outside-skill");

		expect(found).toBeUndefined();
	});

	test("ignores manifest slash commands directory that resolves outside plugin root", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-outside");
		const outsideDir = path.join(tempDir, "outside-commands");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(outsideDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-outside@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ "slash-commands": "../../outside-commands" }),
		);
		await fs.writeFile(path.join(outsideDir, "ship.md"), "Ship it\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings[0]).toContain("Ignoring slash-commands path outside plugin root");
		const found = result.all.find(command => command.name === "manifest-commands-outside:ship");

		expect(found).toBeUndefined();
	});
});

describe("discoverAgents plugin precedence", () => {
	let tempDir: string;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-precedence-test-"));
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("prefers project-scoped plugin agent over user-scoped plugin agent", async () => {
		const pluginRegistryDir = path.join(tempDir, ".claude", "plugins");
		const projectPluginPath = path.join(tempDir, "plugins", "project");
		const userPluginPath = path.join(tempDir, "plugins", "user");
		const agentName = "plugin-precedence-test-agent";

		await fs.mkdir(pluginRegistryDir, { recursive: true });
		await fs.mkdir(path.join(projectPluginPath, "agents"), { recursive: true });
		await fs.mkdir(path.join(userPluginPath, "agents"), { recursive: true });

		const projectAgent = `---\nname: ${agentName}\ndescription: Project plugin version\n---\nProject scope agent`;
		const userAgent = `---\nname: ${agentName}\ndescription: User plugin version\n---\nUser scope agent`;

		await fs.writeFile(path.join(projectPluginPath, "agents", "shared.md"), projectAgent);
		await fs.writeFile(path.join(userPluginPath, "agents", "shared.md"), userAgent);

		const registry = {
			version: 2,
			plugins: {
				"shared-plugin@market": [
					{
						scope: "user",
						installPath: userPluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
					{
						scope: "project",
						installPath: projectPluginPath,
						version: "1.0.1",
						installedAt: "2025-01-02T00:00:00Z",
						lastUpdated: "2025-01-02T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginRegistryDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await discoverAgents(tempDir, tempDir);
		const found = result.agents.find(agent => agent.name === agentName);

		expect(found).toBeDefined();
		expect(found?.source).toBe("project");
		expect(found?.filePath).toContain(projectPluginPath);
	});
});

describe("listClaudeOnlyPluginRoots / listOmpOnlyPluginRoots provider split", () => {
	let tempDir: string;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-split-test-"));
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	const makeRegistry = (pluginId: string, installPath: string, scope: "user" | "project" = "user") => ({
		version: 2,
		plugins: {
			[pluginId]: [{ scope, installPath, version: "1.0.0", installedAt: "", lastUpdated: "" }],
		},
	});

	test("Claude registry entry appears only in listClaudeOnlyPluginRoots", async () => {
		const claudeDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("plugin-a@market", "/install/a")),
		);

		const claudeOnly = await listClaudeOnlyPluginRoots(tempDir);
		const ompOnly = await listOmpOnlyPluginRoots(tempDir);

		expect(claudeOnly.roots).toHaveLength(1);
		expect(claudeOnly.roots[0].id).toBe("plugin-a@market");
		expect(claudeOnly.roots[0].registrySource).toBe("claude");
		expect(ompOnly.roots).toHaveLength(0);
	});

	test("OMP registry entry appears only in listOmpOnlyPluginRoots", async () => {
		const ompDir = path.join(tempDir, ".omp", "plugins");
		await fs.mkdir(ompDir, { recursive: true });
		await fs.writeFile(
			path.join(ompDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("plugin-b@omp", "/install/b")),
		);

		const claudeOnly = await listClaudeOnlyPluginRoots(tempDir);
		const ompOnly = await listOmpOnlyPluginRoots(tempDir);

		expect(ompOnly.roots).toHaveLength(1);
		expect(ompOnly.roots[0].id).toBe("plugin-b@omp");
		expect(ompOnly.roots[0].registrySource).toBe("omp");
		expect(claudeOnly.roots).toHaveLength(0);
	});

	test("same plugin ID in both registries: Claude root is excluded from claude-only filter", async () => {
		const claudeDir = path.join(tempDir, ".claude", "plugins");
		const ompDir = path.join(tempDir, ".omp", "plugins");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.mkdir(ompDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("shared@market", "/install/claude")),
		);
		await fs.writeFile(
			path.join(ompDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("shared@market", "/install/omp")),
		);

		const claudeOnly = await listClaudeOnlyPluginRoots(tempDir);
		const ompOnly = await listOmpOnlyPluginRoots(tempDir);

		// Claude root is shadowed by the OMP root with the same plugin ID —
		// capability-key dedup alone is not sufficient (non-overlapping keys would leak through).
		expect(claudeOnly.roots).toHaveLength(0);
		// OMP filter is unaffected.
		expect(ompOnly.roots).toHaveLength(1);
		expect(ompOnly.roots[0].registrySource).toBe("omp");
	});

	test("OMP parse failure warning appears only in listOmpOnlyPluginRoots, not listClaudeOnlyPluginRoots", async () => {
		const claudeDir = path.join(tempDir, ".claude", "plugins");
		const ompDir = path.join(tempDir, ".omp", "plugins");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.mkdir(ompDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("plugin-c@market", "/install/c")),
		);
		await fs.writeFile(path.join(ompDir, "installed_plugins.json"), "not valid json");

		const claudeOnly = await listClaudeOnlyPluginRoots(tempDir);
		const ompOnly = await listOmpOnlyPluginRoots(tempDir);

		expect(claudeOnly.warnings).toHaveLength(0);
		expect(ompOnly.warnings.some(w => w.includes("OMP plugin registry"))).toBe(true);
	});

	test("project-scoped OMP root shadows Claude entry with same plugin ID in claude-only filter", async () => {
		const claudeDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("shared@market", "/install/claude")),
		);

		const projectCwd = path.join(tempDir, "my-project");
		const projectPluginsDir = path.join(projectCwd, ".omp", "plugins");
		await fs.mkdir(projectPluginsDir, { recursive: true });
		await fs.writeFile(
			path.join(projectPluginsDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("shared@market", "/install/project", "project")),
		);

		const claudeOnly = await listClaudeOnlyPluginRoots(tempDir, projectCwd);
		const ompOnly = await listOmpOnlyPluginRoots(tempDir, projectCwd);

		// Claude root is shadowed by the project OMP root — all OMP-family sources shadow Claude.
		expect(claudeOnly.roots).toHaveLength(0);

		// OMP filter sees the project entry.
		expect(ompOnly.roots.some(r => r.registrySource === "project")).toBe(true);
	});

	test("combined listClaudePluginRoots drops Claude entry when project OMP root shares same ID", async () => {
		// Verifies applyOmpOverClaude covers all OMP-family sources, not just registrySource==='omp'.
		const claudeDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("shared@market", "/install/claude")),
		);

		const projectCwd = path.join(tempDir, "my-project");
		const projectPluginsDir = path.join(projectCwd, ".omp", "plugins");
		await fs.mkdir(projectPluginsDir, { recursive: true });
		await fs.writeFile(
			path.join(projectPluginsDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("shared@market", "/install/project", "project")),
		);

		const { roots } = await listClaudePluginRoots(tempDir, projectCwd);

		// Combined list must contain only one entry for the ID: the higher-precedence project root.
		const forId = roots.filter(r => r.id === "shared@market");
		expect(forId).toHaveLength(1);
		expect(forId[0].registrySource).toBe("project");
	});

	test("OMP entry preserved; Claude entry with same plugin ID excluded from claude-only filter", async () => {
		// Verifies per-registry dedup Set does not mistake Claude entries for OMP duplicates,
		// and that the shared install path does not suppress the OMP root.
		const sharedPath = "/shared/cache/plugin-d";
		const claudeDir = path.join(tempDir, ".claude", "plugins");
		const ompDir = path.join(tempDir, ".omp", "plugins");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.mkdir(ompDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("plugin-d@market", sharedPath)),
		);
		await fs.writeFile(
			path.join(ompDir, "installed_plugins.json"),
			JSON.stringify(makeRegistry("plugin-d@market", sharedPath)),
		);

		const claudeOnly = await listClaudeOnlyPluginRoots(tempDir);
		const ompOnly = await listOmpOnlyPluginRoots(tempDir);

		// Claude root is shadowed — sharing the same install path must not suppress the OMP root.
		expect(claudeOnly.roots).toHaveLength(0);
		expect(ompOnly.roots).toHaveLength(1);
		expect(ompOnly.roots[0].registrySource).toBe("omp");
	});
});
