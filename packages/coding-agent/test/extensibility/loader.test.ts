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

	it("should force re-enumeration when policy files mtime/size change", async () => {
		const spy = vi.spyOn(fs, "existsSync");
		spy.mockClear();

		const pkgJsonPath = path.join(userRoot, "package.json");
		const now = Date.now();

		// Explicitly set package.json mtime in the past
		fs.utimesSync(pkgJsonPath, new Date(now - 10000), new Date(now - 10000));

		// Call 1: Populates cache
		const plugins1 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins1).toHaveLength(1);

		let nodeModulesExistsCalls = spy.mock.calls.filter(
			args => typeof args[0] === "string" && args[0].endsWith("node_modules"),
		).length;
		expect(nodeModulesExistsCalls).toBe(1);

		// Call 2: Uses cache (no change)
		const plugins2 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins2).toHaveLength(1);

		nodeModulesExistsCalls = spy.mock.calls.filter(
			args => typeof args[0] === "string" && args[0].endsWith("node_modules"),
		).length;
		expect(nodeModulesExistsCalls).toBe(1);

		// Change package.json mtime to the present
		fs.utimesSync(pkgJsonPath, new Date(now), new Date(now));

		// Call 3: Detects policy file change (mtime) and re-evaluates
		const plugins3 = await getEnabledPlugins(tmpHome, { home: tmpHome });
		expect(plugins3).toHaveLength(1);

		nodeModulesExistsCalls = spy.mock.calls.filter(
			args => typeof args[0] === "string" && args[0].endsWith("node_modules"),
		).length;
		expect(nodeModulesExistsCalls).toBe(2);
	});
});
