import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { getCapability, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import {
	clearClaudePluginRootsCache,
	listClaudePluginRoots,
	parseClaudePluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";

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

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-"));
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
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
});

describe("claude plugin rule discovery", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	type PluginRegistryEntry = {
		id: string;
		scope: "project" | "user";
		installPath: string;
		version: string;
	};

	async function writeInstalledPlugins(entries: PluginRegistryEntry[]): Promise<void> {
		const pluginsDir = path.join(tempHomeDir, ".claude", "plugins");
		const plugins: Record<
			string,
			Array<{
				scope: "project" | "user";
				installPath: string;
				version: string;
				installedAt: string;
				lastUpdated: string;
			}>
		> = {};

		for (const entry of entries) {
			const pluginEntries = plugins[entry.id] ?? [];
			pluginEntries.push({
				scope: entry.scope,
				installPath: entry.installPath,
				version: entry.version,
				installedAt: "2025-01-01T00:00:00Z",
				lastUpdated: "2025-01-01T00:00:00Z",
			});
			plugins[entry.id] = pluginEntries;
		}

		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
	}

	async function writePluginRule(pluginPath: string, fileName: string, content: string): Promise<string> {
		const filePath = path.join(pluginPath, "rules", fileName);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content);
		return filePath;
	}

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-rules-home-"));
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-rules-"));
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
		await fs.rm(tempHomeDir, { recursive: true, force: true });
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("loads markdown and mdc plugin rules as canonical rules", async () => {
		const pluginPath = path.join(tempDir, "plugins", "catalog");
		const markdownRulePath = await writePluginRule(
			pluginPath,
			"style-guide.md",
			"---\ndescription: Prefer readable names\n---\nName things so maintainers can follow them.\n",
		);
		const mdcRulePath = await writePluginRule(
			pluginPath,
			"typed-api.mdc",
			"---\ndescription: Prefer explicit return types\n---\nReturn types should stay obvious.\n",
		);
		await writeInstalledPlugins([
			{
				id: "rules-plugin@market",
				scope: "user",
				installPath: pluginPath,
				version: "1.0.0",
			},
		]);

		const capability = getCapability<Rule>(ruleCapability.id);
		expect(capability).toBeDefined();
		const provider = capability?.providers.find(candidate => candidate.id === "claude-plugins");
		expect(provider).toBeDefined();

		const result = await provider!.load({ cwd: tempDir, home: tempHomeDir, repoRoot: null });
		expect(result.warnings).toEqual([]);
		expect(result.items).toHaveLength(2);

		const markdownRule = result.items.find(rule => rule.name === "style-guide");
		expect(markdownRule).toMatchObject({
			name: "style-guide",
			description: "Prefer readable names",
			path: markdownRulePath,
			_source: {
				provider: "claude-plugins",
				path: markdownRulePath,
				level: "user",
			},
		});
		expect(markdownRule?.content.trim()).toBe("Name things so maintainers can follow them.");

		const mdcRule = result.items.find(rule => rule.name === "typed-api");
		expect(mdcRule).toMatchObject({
			name: "typed-api",
			description: "Prefer explicit return types",
			path: mdcRulePath,
			_source: {
				provider: "claude-plugins",
				path: mdcRulePath,
				level: "user",
			},
		});
		expect(mdcRule?.content.trim()).toBe("Return types should stay obvious.");
	});

	test("prefers project-scoped plugin rules over user-scoped plugin rules when registry order is inverted", async () => {
		const ruleName = "shared-guidance";
		const userPluginPath = path.join(tempDir, "plugins", "user");
		const projectPluginPath = path.join(tempDir, "plugins", "project");
		const userRulePath = await writePluginRule(
			userPluginPath,
			`${ruleName}.md`,
			"---\ndescription: User plugin rule\n---\nUser scope loses.\n",
		);
		const projectRulePath = await writePluginRule(
			projectPluginPath,
			`${ruleName}.mdc`,
			"---\ndescription: Project plugin rule\n---\nProject scope wins.\n",
		);
		await writeInstalledPlugins([
			{
				id: "shared-plugin@market",
				scope: "user",
				installPath: userPluginPath,
				version: "1.0.0",
			},
			{
				id: "shared-plugin@market",
				scope: "project",
				installPath: projectPluginPath,
				version: "1.0.1",
			},
		]);

		process.env.HOME = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);

		const result = await loadCapability<Rule>(ruleCapability.id, { cwd: tempDir });
		const resolvedRule = result.items.find(rule => rule.name === ruleName);
		expect(resolvedRule).toMatchObject({
			name: ruleName,
			description: "Project plugin rule",
			path: projectRulePath,
			_source: {
				provider: "claude-plugins",
				path: projectRulePath,
				level: "project",
			},
		});
		expect(resolvedRule?.content.trim()).toBe("Project scope wins.");

		const projectPluginRule = result.all.find(rule => rule.path === projectRulePath);
		expect(projectPluginRule).toMatchObject({
			_source: { provider: "claude-plugins", level: "project" },
		});

		const userPluginRule = result.all.find(rule => rule.path === userRulePath);
		expect(userPluginRule).toMatchObject({
			_source: { provider: "claude-plugins", level: "user" },
			_shadowed: true,
		});
	});

	test("prefers native .omp rules over plugin rules with the same name", async () => {
		const ruleName = "shared-guidance";
		const pluginPath = path.join(tempDir, "plugins", "project");
		const pluginRulePath = await writePluginRule(
			pluginPath,
			`${ruleName}.md`,
			"---\ndescription: Plugin rule\n---\nPlugin guidance.\n",
		);
		const nativeRulePath = path.join(tempDir, ".omp", "rules", `${ruleName}.md`);
		await fs.mkdir(path.dirname(nativeRulePath), { recursive: true });
		await fs.writeFile(nativeRulePath, "---\ndescription: Native rule\n---\nNative guidance.\n");
		await writeInstalledPlugins([
			{
				id: "shared-plugin@market",
				scope: "project",
				installPath: pluginPath,
				version: "1.0.0",
			},
		]);

		process.env.HOME = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);

		const result = await loadCapability<Rule>(ruleCapability.id, { cwd: tempDir });
		const resolvedRule = result.items.find(rule => rule.name === ruleName);
		expect(resolvedRule).toMatchObject({
			name: ruleName,
			description: "Native rule",
			path: nativeRulePath,
			_source: {
				provider: "native",
				path: nativeRulePath,
				level: "project",
			},
		});
		expect(resolvedRule?.content.trim()).toBe("Native guidance.");

		const pluginRule = result.all.find(rule => rule.path === pluginRulePath);
		expect(pluginRule?._source.provider).toBe("claude-plugins");
		expect(pluginRule?._shadowed).toBe(true);
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
