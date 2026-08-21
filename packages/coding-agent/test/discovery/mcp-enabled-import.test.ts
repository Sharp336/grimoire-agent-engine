import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { convertToLegacyConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { lazyConfig, spawnCount, waitFor } from "../mcp-lifecycle-harness";

async function loadMcp(cwd: string, provider: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: [provider],
	});
	return result.items;
}

interface Fixture {
	/** Discovery provider id passed to `loadCapability`. */
	provider: string;
	/** Project-relative config file the importer reads. */
	file: string;
	/** File body carrying a single server with `enabled: false`. */
	content: string;
}

// Project-scoped config for each translated importer that previously dropped the
// per-server `enabled` flag (issue #7652). Codex/OpenCode/native already
// propagate it and are covered elsewhere.
const FIXTURES: Fixture[] = [
	{
		provider: "claude",
		file: ".claude/.mcp.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "cursor",
		file: ".cursor/mcp.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "gemini",
		file: ".gemini/settings.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "windsurf",
		file: ".windsurf/mcp_config.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "vscode",
		file: ".vscode/mcp.json",
		content: JSON.stringify({
			mcp: { servers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } } },
		}),
	},
];

interface CompoundFixture {
	/** Discovery provider id passed to `loadCapability`. */
	provider: string;
	/** User-scope config file, relative to the temp HOME. */
	userFile: string;
	/** Project-scope config file, relative to the temp cwd. */
	projectFile: string;
}

// Providers exposing both a user and a project MCP scope. A project
// `enabled: false` must claim the dedupe key ahead of the same-named user
// server so the disable actually suppresses it (#7654). VS Code MCP is
// project-only, so it has no user/project compound case.
const COMPOUND_FIXTURES: CompoundFixture[] = [
	{ provider: "claude", userFile: ".claude.json", projectFile: ".claude/.mcp.json" },
	{ provider: "cursor", userFile: ".cursor/mcp.json", projectFile: ".cursor/mcp.json" },
	{ provider: "gemini", userFile: ".gemini/settings.json", projectFile: ".gemini/settings.json" },
	{ provider: "windsurf", userFile: ".codeium/windsurf/mcp_config.json", projectFile: ".windsurf/mcp_config.json" },
];

function mcpServersJson(enabled: boolean, command: string): string {
	return JSON.stringify({
		mcpServers: { markitdown: { command, args: ["markitdown-mcp"], type: "stdio", enabled } },
	});
}

describe("translated MCP importers propagate enabled: false", () => {
	let tempCwd = "";
	let tempHome = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-enabled-cwd-"));
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-enabled-home-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempCwd);
		await removeWithRetries(tempHome);
	});

	for (const { provider, file, content } of FIXTURES) {
		test(`${provider} carries enabled: false`, async () => {
			const filePath = path.join(tempCwd, file);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content);

			const servers = await loadMcp(tempCwd, provider);
			const server = servers.find(item => item.name === "markitdown");

			expect(server).toBeDefined();
			expect(server?.enabled).toBe(false);
		});
	}
	test("claude lifecycle lazy with finite idleTimeout spawns once and defers despite eager manager defaults", async () => {
		const filePath = path.join(tempCwd, ".claude", ".mcp.json");
		const spawnLog = path.join(tempCwd, "claude-lazy-reap.log");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(
			filePath,
			JSON.stringify({
				mcpServers: { lazy: lazyConfig({ lifecycle: "lazy", idleTimeout: 50, spawnLog }) },
			}),
		);

		const servers = await loadMcp(tempCwd, "claude");
		const server = servers.find(item => item.name === "lazy");
		expect(server).toBeDefined();
		if (!server) throw new Error("Expected lazy fixture from Claude project .mcp.json discovery");

		const manager = new MCPManager(tempCwd);
		try {
			manager.setLifecycleDefaults("eager", 300_000);
			const connected = await manager.connectServers({ lazy: convertToLegacyConfig(server) }, {});
			expect(connected.errors.has("lazy")).toBe(false);
			expect(await waitFor(() => manager.getConnectionStatus("lazy") === "deferred")).toBe(true);
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 20_000);

	test("claude idleTimeout: 0 keeps a lazy server connected under reaping manager defaults", async () => {
		const filePath = path.join(tempCwd, ".claude", ".mcp.json");
		const spawnLog = path.join(tempCwd, "claude-idle-zero.log");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(
			filePath,
			JSON.stringify({
				mcpServers: { sticky: lazyConfig({ lifecycle: "lazy", idleTimeout: 0, spawnLog }) },
			}),
		);

		const servers = await loadMcp(tempCwd, "claude");
		const server = servers.find(item => item.name === "sticky");
		expect(server).toBeDefined();
		if (!server) throw new Error("Expected sticky fixture from Claude project .mcp.json discovery");

		const manager = new MCPManager(tempCwd);
		try {
			manager.setLifecycleDefaults("lazy", 50);
			const connected = await manager.connectServers({ sticky: convertToLegacyConfig(server) }, {});
			expect(connected.errors.has("sticky")).toBe(false);
			expect(await waitFor(() => manager.getConnectionStatus("sticky") === "connected")).toBe(true);
			// Genuine integration wait: idleTimeout 0 must arm no reaper, so let real
			// wall-clock pass and confirm the connection survives. Fake timers cannot
			// stand in for "no timer was scheduled at all".
			await Bun.sleep(300);
			expect(manager.getConnectionStatus("sticky")).toBe("connected");
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 20_000);

	test("claude preserves invalid lifecycle values for capability validation", async () => {
		const filePath = path.join(tempCwd, ".claude", ".mcp.json");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(
			filePath,
			JSON.stringify({ mcpServers: { typo: { command: "typo-server", lifecycle: "lazyy" } } }),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempCwd,
			providers: ["claude"],
		});
		expect(result.items.find(server => server.name === "typo")).toBeUndefined();
		expect(String(result.all.find(server => server.name === "typo")?.lifecycle)).toBe("lazyy");
		expect(result.warnings?.some(warning => warning.includes('Invalid lifecycle "lazyy"'))).toBe(true);
	});

	test("claude preserves invalid idleTimeout values for capability validation", async () => {
		const filePath = path.join(tempCwd, ".claude", ".mcp.json");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(
			filePath,
			JSON.stringify({ mcpServers: { invalid: { command: "invalid-server", idleTimeout: "300000" } } }),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempCwd,
			providers: ["claude"],
		});
		expect(result.items.find(server => server.name === "invalid")).toBeUndefined();
		expect(String(result.all.find(server => server.name === "invalid")?.idleTimeout)).toBe("300000");
		expect(result.warnings?.some(warning => warning.includes("idleTimeout must be a non-negative number"))).toBe(
			true,
		);
	});

	for (const { provider, userFile, projectFile } of COMPOUND_FIXTURES) {
		test(`${provider} project enabled: false suppresses a same-named user server`, async () => {
			const userPath = path.join(tempHome, userFile);
			const projectPath = path.join(tempCwd, projectFile);
			await fs.mkdir(path.dirname(userPath), { recursive: true });
			await fs.mkdir(path.dirname(projectPath), { recursive: true });
			await fs.writeFile(userPath, mcpServersJson(true, "user-markitdown"));
			await fs.writeFile(projectPath, mcpServersJson(false, "project-markitdown"));

			const result = await loadCapability<MCPServer>(mcpCapability.id, {
				cwd: tempCwd,
				providers: [provider],
				suppress: server => server.enabled === false,
			});

			expect(result.items.find(server => server.name === "markitdown")).toBeUndefined();
		});
	}
});
