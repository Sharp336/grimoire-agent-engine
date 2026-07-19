/**
 * Contract: `loadAllMCPConfigs` with `extraConfigPaths` (the `--mcp-config`
 * flag) loads servers from explicitly specified `mcpServers` JSON files that
 * live outside every discovery path, with these semantics:
 *
 * - servers from an extra config override same-named discovered servers;
 * - an `enabled: false` entry disables the same-named discovered server;
 * - an unreadable or malformed file is a hard error (the caller asked for
 *   this exact file), unlike best-effort provider discovery.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
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
});
