import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";

describe("getEnabledPlugins cache and concurrent execution", () => {
	let tmpHome: string;
	let userRoot: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		originalHome = process.env.HOME;
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-loader-test-home-"));
		process.env.HOME = tmpHome;
		vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

		userRoot = path.join(tmpHome, ".omp", "plugins");
		fs.mkdirSync(path.join(userRoot, "node_modules", "test-plugin"), { recursive: true });

		fs.writeFileSync(
			path.join(userRoot, "package.json"),
			JSON.stringify({
				dependencies: {
					"test-plugin": "1.0.0",
				},
			}),
		);

		fs.writeFileSync(
			path.join(userRoot, "node_modules", "test-plugin", "package.json"),
			JSON.stringify({
				name: "test-plugin",
				version: "1.0.0",
				omp: {
					tools: ["index.ts"],
				},
			}),
		);

		clearClaudePluginRootsCache();
	});

	afterEach(() => {
		clearClaudePluginRootsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	it("should find and load the test-plugin", async () => {
		const plugins = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins).toHaveLength(1);
		expect(plugins[0].name).toBe("test-plugin");
		expect(plugins[0].version).toBe("1.0.0");
	});

	it("should share a single enumeration for concurrent calls", async () => {
		const spy = vi.spyOn(fs, "existsSync");
		spy.mockClear();

		const [plugins1, plugins2] = await Promise.all([
			getEnabledPlugins(tmpHome, { home: tmpHome }),
			getEnabledPlugins(tmpHome, { home: tmpHome }),
		]);

		expect(plugins1).toHaveLength(1);
		expect(plugins2).toHaveLength(1);
		expect(plugins1[0].name).toBe("test-plugin");
		expect(plugins2[0].name).toBe("test-plugin");

		// Count calls to existsSync checking for the node_modules directory
		const nodeModulesExistsCalls = spy.mock.calls.filter(
			args => typeof args[0] === "string" && args[0].endsWith("node_modules"),
		).length;

		// Concurrent calls should share a single enumeration, so the node_modules existence check is executed exactly once
		expect(nodeModulesExistsCalls).toBe(1);
	});

	it("should evict from cache when computation rejects (e.g. invalid JSON)", async () => {
		const pkgJsonPath = path.join(userRoot, "package.json");

		// Write invalid JSON to package.json to trigger a parsing syntax error
		fs.writeFileSync(pkgJsonPath, "{");

		let error: unknown;
		try {
			await getEnabledPlugins(tmpHome, { home: tmpHome });
		} catch (err: unknown) {
			error = err;
		}

		expect(error).toBeDefined();
		expect(error).toBeInstanceOf(SyntaxError);

		// Now write valid JSON back to package.json
		fs.writeFileSync(
			pkgJsonPath,
			JSON.stringify({
				dependencies: {
					"test-plugin": "1.0.0",
				},
			}),
		);

		// Because the first call rejected, the entry must be evicted, and a subsequent call should retry and succeed
		const plugins = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins).toHaveLength(1);
		expect(plugins[0].name).toBe("test-plugin");
	});

	it("should force re-enumeration when clearing plugin caches", async () => {
		const spy = vi.spyOn(fs, "existsSync");
		spy.mockClear();

		// Call 1: Populates the cache
		const plugins1 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins1).toHaveLength(1);

		let nodeModulesExistsCalls = spy.mock.calls.filter(
			args => typeof args[0] === "string" && args[0].endsWith("node_modules"),
		).length;
		expect(nodeModulesExistsCalls).toBe(1);

		// Call 2: Uses the cache (no new enumeration)
		const plugins2 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins2).toHaveLength(1);

		nodeModulesExistsCalls = spy.mock.calls.filter(
			args => typeof args[0] === "string" && args[0].endsWith("node_modules"),
		).length;
		expect(nodeModulesExistsCalls).toBe(1);

		// Clear cache
		clearClaudePluginRootsCache();

		// Call 3: Forces re-enumeration
		const plugins3 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins3).toHaveLength(1);

		nodeModulesExistsCalls = spy.mock.calls.filter(
			args => typeof args[0] === "string" && args[0].endsWith("node_modules"),
		).length;
		expect(nodeModulesExistsCalls).toBe(2);
	});

	it("should force re-enumeration and reflect behavioral changes when package.json dependencies change", async () => {
		// Call 1: Populates cache
		const plugins1 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins1).toHaveLength(1);
		expect(plugins1[0].name).toBe("test-plugin");

		// Call 2: Uses cache (no change)
		const plugins2 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins2).toHaveLength(1);

		// Change package.json content: remove the test-plugin dependency
		const pkgJsonPath = path.join(userRoot, "package.json");
		fs.writeFileSync(
			pkgJsonPath,
			JSON.stringify({
				dependencies: {},
			}),
		);

		// Call 3: Detects package.json content change, re-enumerates, and returns empty list
		const plugins3 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins3).toHaveLength(0);
	});

	it("should force re-enumeration and reflect behavioral changes when plugin-overrides.json is created", async () => {
		// Call 1: Populates cache
		const plugins1 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins1).toHaveLength(1);

		// Call 2: Uses cache
		const plugins2 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins2).toHaveLength(1);

		// Create project-level plugin-overrides.json to disable test-plugin
		const overridesDir = path.join(tmpHome, ".omp");
		fs.mkdirSync(overridesDir, { recursive: true });
		fs.writeFileSync(
			path.join(overridesDir, "plugin-overrides.json"),
			JSON.stringify({
				disabled: ["test-plugin"],
			}),
		);

		// Call 3: Detects that plugin-overrides.json is created, re-evaluates, and reflects disablement
		const plugins3 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins3).toHaveLength(0);
	});

	it("should detect when a new policy file is introduced via project root creation (policy path set change)", async () => {
		const projectDir = path.join(tmpHome, "project-a");
		fs.mkdirSync(projectDir, { recursive: true });

		// Call 1: Populates cache for projectDir
		const plugins1 = await getEnabledPlugins(projectDir, { home: tmpHome });
		expect(plugins1).toHaveLength(1);
		expect(plugins1[0].name).toBe("test-plugin");

		// Call 2: Uses cache
		const plugins2 = await getEnabledPlugins(projectDir, { home: tmpHome });
		expect(plugins2).toHaveLength(1);

		// Now introduce a project root by creating a .git directory.
		fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });

		// Create a project-level package.json with a new plugin dependency.
		const projectPluginsDir = path.join(projectDir, ".omp", "plugins");
		const projectNodeModules = path.join(projectPluginsDir, "node_modules");
		const otherPluginDir = path.join(projectNodeModules, "other-plugin");
		fs.mkdirSync(otherPluginDir, { recursive: true });
		fs.writeFileSync(
			path.join(otherPluginDir, "package.json"),
			JSON.stringify({
				name: "other-plugin",
				version: "2.0.0",
				omp: {
					tools: ["index.ts"],
				},
			}),
		);
		fs.writeFileSync(
			path.join(projectPluginsDir, "package.json"),
			JSON.stringify({
				dependencies: {
					"other-plugin": "2.0.0",
				},
			}),
		);

		// Call 3: Since the policy path set changed (now including project-level package.json/omp-plugins.lock.json),
		// validation recomputes policy paths, invalidates the cache, and re-evaluates.
		// Returns both the user-level test-plugin and the project-level other-plugin.
		const plugins3 = await getEnabledPlugins(projectDir, { home: tmpHome });
		expect(plugins3).toHaveLength(2);

		const names = plugins3.map(p => p.name).sort();
		expect(names).toEqual(["other-plugin", "test-plugin"]);
	});
});
