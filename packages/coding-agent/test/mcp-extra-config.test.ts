/**
 * Contract: `extraConfigPaths` (the `--mcp-config` flag) loads servers from
 * explicitly specified `mcpServers` JSON files that live outside every
 * discovery path, with these semantics:
 *
 * - servers from an extra config override same-named discovered servers;
 * - an `enabled: false` entry disables the same-named discovered server;
 * - an unreadable or malformed file is a hard error (the caller asked for
 *   this exact file), unlike best-effort provider discovery — "malformed"
 *   covers syntactically valid JSON of the wrong shape;
 * - that hard error survives the CLI/SDK-facing wrapper, which otherwise
 *   degrades discovery failures to a resolved, empty result;
 * - `MCPManager` remembers the paths, so an option-less rediscovery
 *   (`/mcp reload`) re-reads the same files.
 *
 * The shape check is shared with provider discovery, which warns instead of
 * throwing; the last test covers that half.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { discoverAndLoadMCPTools } from "@oh-my-pi/pi-coding-agent/mcp/loader";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

describe("loadAllMCPConfigs extraConfigPaths", () => {
	let tempHome = "";
	let projectDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-extra-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-extra-project-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		clearFsCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
	});

	test("loads servers from a file outside discovery paths and overrides same-named discovered servers", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					penpot: { url: "http://localhost:4401/mcp" },
					standalone: { command: "standalone-server" },
				},
			}),
		);
		const generatedDir = path.join(projectDir, ".devenv", "mcp");
		await fs.mkdir(generatedDir, { recursive: true });
		const generatedPath = path.join(generatedDir, "claude-code.json");
		await fs.writeFile(
			generatedPath,
			JSON.stringify({
				mcpServers: {
					penpot: { url: "http://localhost:14401/mcp" },
					serena: { url: "http://localhost:24181/mcp" },
				},
			}),
		);

		const { configs, sources } = await loadAllMCPConfigs(projectDir, {
			extraConfigPaths: [path.join(".devenv", "mcp", "claude-code.json")],
		});

		expect(configs.penpot).toMatchObject({ type: "http", url: "http://localhost:14401/mcp" });
		expect(configs.serena).toMatchObject({ type: "http", url: "http://localhost:24181/mcp" });
		expect(configs.standalone).toMatchObject({ type: "stdio", command: "standalone-server" });
		expect(sources.penpot.path).toBe(generatedPath);
		expect(sources.standalone.provider).toBe("mcp-json");
	});

	test("enabled: false in an extra config disables the same-named discovered server", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { noisy: { command: "noisy-server" } } }),
		);
		const overridePath = path.join(projectDir, "override.json");
		await fs.writeFile(overridePath, JSON.stringify({ mcpServers: { noisy: { enabled: false } } }));

		const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [overridePath] });

		expect(configs.noisy).toBeUndefined();
	});

	// The flag is repeatable and later files win per name — which has to hold for
	// an entry that only disables the name, not just for one carrying a real
	// config, or a generated config could never be turned off downstream of it.
	describe("repeated --mcp-config files resolve last-wins per name", () => {
		const writeExtras = async (...contents: object[]) => {
			const paths: string[] = [];
			for (const [index, body] of contents.entries()) {
				const extraPath = path.join(projectDir, `extra-${index}.json`);
				await fs.writeFile(extraPath, JSON.stringify(body));
				paths.push(extraPath);
			}
			return paths;
		};

		test("a later file's server replaces an earlier file's same-named server", async () => {
			const paths = await writeExtras(
				{ mcpServers: { shared: { url: "http://localhost:1111/mcp" } } },
				{ mcpServers: { shared: { url: "http://localhost:2222/mcp" } } },
			);

			const { configs, sources } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: paths });

			expect(configs.shared).toMatchObject({ type: "http", url: "http://localhost:2222/mcp" });
			expect(sources.shared.path).toBe(paths[1]);
		});

		test("a later file can disable an earlier file's server", async () => {
			const paths = await writeExtras(
				{ mcpServers: { shared: { command: "shared-server" } } },
				{ mcpServers: { shared: { enabled: false } } },
			);

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: paths });

			expect(configs.shared).toBeUndefined();
		});

		test("a later file re-enables a name an earlier file disabled", async () => {
			const paths = await writeExtras(
				{ mcpServers: { shared: { enabled: false } } },
				{ mcpServers: { shared: { command: "shared-server" } } },
			);

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: paths });

			expect(configs.shared).toMatchObject({ type: "stdio", command: "shared-server" });
		});

		test("a later file's disable still owns the name against discovery", async () => {
			await fs.writeFile(
				path.join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { shared: { command: "discovered-server" } } }),
			);
			const paths = await writeExtras(
				{ mcpServers: { shared: { command: "shared-server" } } },
				{ mcpServers: { shared: { enabled: false } } },
			);

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: paths });

			expect(configs.shared).toBeUndefined();
		});
	});

	test("missing extra config file is a hard error", async () => {
		await expect(
			loadAllMCPConfigs(projectDir, { extraConfigPaths: [path.join(projectDir, "does-not-exist.json")] }),
		).rejects.toThrow(/Cannot read MCP config/);
	});

	test("malformed extra config file is a hard error", async () => {
		const brokenPath = path.join(projectDir, "broken.json");
		await fs.writeFile(brokenPath, "{ not json");
		await expect(loadAllMCPConfigs(projectDir, { extraConfigPaths: [brokenPath] })).rejects.toThrow(
			/Invalid JSON in MCP config/,
		);
	});

	// Valid JSON of the wrong shape used to survive: `Object.entries` iterates a
	// string or array into blank stdio servers named by index.
	test.each([
		['"mcpServers" is a string', { mcpServers: "not-a-map" }, /"mcpServers" must be an object/],
		['"mcpServers" is an array', { mcpServers: ["a", "b"] }, /"mcpServers" must be an object/],
		["a server entry is not an object", { mcpServers: { broken: "oops" } }, /server "broken" must be an object/],
		["the root is not an object", ["mcpServers"], /expected a JSON object at the top level/],
	])("wrong-shape extra config is a hard error: %s", async (_label, contents, expected) => {
		const wrongShapePath = path.join(projectDir, "wrong-shape.json");
		await fs.writeFile(wrongShapePath, JSON.stringify(contents));

		await expect(loadAllMCPConfigs(projectDir, { extraConfigPaths: [wrongShapePath] })).rejects.toThrow(expected);
	});

	// `discoverAndLoadMCPTools` degrades discovery failures to a resolved result
	// with an `errors` entry, which startup only logs. An explicitly named file
	// has to escape that, or `--mcp-config typo.json` starts a session anyway.
	test("explicit-config failure propagates through discoverAndLoadMCPTools", async () => {
		await expect(
			discoverAndLoadMCPTools(projectDir, {
				extraConfigPaths: [path.join(projectDir, "does-not-exist.json")],
				cacheStorage: null,
			}),
		).rejects.toThrow(/Cannot read MCP config/);
	});

	// `/mcp reload` calls `discoverAndConnect()` with no options, so the paths
	// have to survive on the manager. Servers name commands that do not exist:
	// the connect fails fast and lands in `errors` keyed by server name, which
	// is enough to observe which file the second pass read.
	test("manager re-reads remembered extra config paths on option-less rediscovery", async () => {
		const extraPath = path.join(projectDir, "extra.json");
		await fs.writeFile(extraPath, JSON.stringify({ mcpServers: { alpha: { command: "omp-no-such-binary-alpha" } } }));

		const manager = new MCPManager(projectDir, null);
		try {
			const first = await manager.discoverAndConnect({ extraConfigPaths: [extraPath] });
			expect([...first.errors.keys()]).toEqual(["alpha"]);

			await fs.writeFile(
				extraPath,
				JSON.stringify({ mcpServers: { beta: { command: "omp-no-such-binary-beta" } } }),
			);
			clearFsCache();

			const second = await manager.discoverAndConnect();
			expect([...second.errors.keys()]).toEqual(["beta"]);
		} finally {
			await manager.disconnectAll();
		}
	});

	// Discovery keeps its best-effort contract: a wrong-shape `.mcp.json` is
	// skipped with a warning rather than iterated into servers named "0".."8".
	test("wrong-shape discovered config is skipped, not turned into blank servers", async () => {
		await fs.writeFile(path.join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: "not-a-map" }));

		const { configs } = await loadAllMCPConfigs(projectDir);

		expect(Object.keys(configs)).toEqual([]);
	});
});
