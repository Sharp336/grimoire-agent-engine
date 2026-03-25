import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";

async function loadPluginMcpServers(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["claude-plugins"],
	});
	return result.items;
}

interface SetupOptions {
	plugins: Record<
		string,
		Array<{
			scope?: string;
			installPath: string;
			version?: string;
		}>
	>;
	enabledPlugins?: Record<string, boolean> | undefined;
	/** Map of installPath → .mcp.json content (as object) */
	mcpJsons?: Record<string, Record<string, unknown>>;
}

/**
 * Creates the installed_plugins.json registry, optionally settings.json with
 * enabledPlugins, and any .mcp.json files at the given install paths.
 */
async function setupPluginRegistry(home: string, opts: SetupOptions): Promise<void> {
	const pluginsDir = path.join(home, ".claude", "plugins");
	await fs.mkdir(pluginsDir, { recursive: true });

	const registry = {
		version: 2,
		plugins: Object.fromEntries(
			Object.entries(opts.plugins).map(([id, entries]) => [
				id,
				entries.map(e => ({
					scope: e.scope ?? "user",
					installPath: e.installPath,
					version: e.version ?? "1.0.0",
					installedAt: "2025-01-01T00:00:00Z",
					lastUpdated: "2025-01-01T00:00:00Z",
				})),
			]),
		),
	};
	await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

	if (opts.enabledPlugins !== undefined) {
		const claudeDir = path.join(home, ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({ enabledPlugins: opts.enabledPlugins }),
		);
	}

	if (opts.mcpJsons) {
		for (const [installPath, content] of Object.entries(opts.mcpJsons)) {
			await fs.mkdir(installPath, { recursive: true });
			await fs.writeFile(path.join(installPath, ".mcp.json"), JSON.stringify(content));
		}
	}
}

describe("claude-plugins MCP server discovery", () => {
	let tempDir: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugin-mcps-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearClaudePluginRootsCache();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("loads MCP servers from plugin .mcp.json files (standard format)", async () => {
		const installPath = path.join(tempDir, "plugins", "notion");
		await setupPluginRegistry(tempDir, {
			plugins: {
				"notion@official": [{ installPath }],
			},
			enabledPlugins: { "notion@official": true },
			mcpJsons: {
				[installPath]: {
					mcpServers: {
						notion: {
							type: "http",
							url: "https://mcp.notion.so/mcp",
						},
					},
				},
			},
		});

		const servers = await loadPluginMcpServers(tempDir);
		expect(servers).toHaveLength(1);
		expect(servers[0].name).toBe("notion");
		expect(servers[0].url).toBe("https://mcp.notion.so/mcp");
		expect(servers[0].transport).toBe("http");
		expect(servers[0]._source.provider).toBe("claude-plugins");
	});

	test("skips disabled plugins", async () => {
		const installPath = path.join(tempDir, "plugins", "notion");
		await setupPluginRegistry(tempDir, {
			plugins: {
				"notion@official": [{ installPath }],
			},
			enabledPlugins: { "notion@official": false },
			mcpJsons: {
				[installPath]: {
					mcpServers: {
						notion: {
							type: "http",
							url: "https://mcp.notion.so/mcp",
						},
					},
				},
			},
		});

		const servers = await loadPluginMcpServers(tempDir);
		expect(servers).toHaveLength(0);
	});

	test("loads all plugins when no enabledPlugins map exists", async () => {
		const installPath = path.join(tempDir, "plugins", "slack");
		await setupPluginRegistry(tempDir, {
			plugins: {
				"slack@official": [{ installPath }],
			},
			// No enabledPlugins — all plugins should be considered enabled
			mcpJsons: {
				[installPath]: {
					mcpServers: {
						slack: {
							type: "http",
							url: "https://mcp.slack.com/mcp",
						},
					},
				},
			},
		});

		const servers = await loadPluginMcpServers(tempDir);
		expect(servers).toHaveLength(1);
		expect(servers[0].name).toBe("slack");
	});

	test("preserves oauth config from plugin .mcp.json", async () => {
		const installPath = path.join(tempDir, "plugins", "slack");
		await setupPluginRegistry(tempDir, {
			plugins: {
				"slack@official": [{ installPath }],
			},
			enabledPlugins: { "slack@official": true },
			mcpJsons: {
				[installPath]: {
					mcpServers: {
						slack: {
							type: "http",
							url: "https://mcp.slack.com/mcp",
							oauth: {
								clientId: "slack-client-id",
								callbackPort: 3118,
							},
						},
					},
				},
			},
		});

		const servers = await loadPluginMcpServers(tempDir);
		expect(servers).toHaveLength(1);
		const slack = servers[0];
		expect(slack.oauth?.clientId).toBe("slack-client-id");
		expect(slack.oauth?.callbackPort).toBe(3118);
	});

	test("handles plugin with no .mcp.json gracefully", async () => {
		const installPath = path.join(tempDir, "plugins", "empty-plugin");
		// Create the directory but no .mcp.json
		await fs.mkdir(installPath, { recursive: true });
		await setupPluginRegistry(tempDir, {
			plugins: {
				"empty@official": [{ installPath }],
			},
			enabledPlugins: { "empty@official": true },
		});

		const servers = await loadPluginMcpServers(tempDir);
		expect(servers).toHaveLength(0);
	});

	test("handles flat format without mcpServers wrapper", async () => {
		const installPath = path.join(tempDir, "plugins", "context7");
		await setupPluginRegistry(tempDir, {
			plugins: {
				"context7@official": [{ installPath }],
			},
			enabledPlugins: { "context7@official": true },
			mcpJsons: {
				[installPath]: {
					context7: {
						command: "npx",
						args: ["-y", "@context7/mcp-server"],
					},
				},
			},
		});

		const servers = await loadPluginMcpServers(tempDir);
		expect(servers).toHaveLength(1);
		expect(servers[0].name).toBe("context7");
		expect(servers[0].command).toBe("npx");
		expect(servers[0].args).toEqual(["-y", "@context7/mcp-server"]);
		expect(servers[0].transport).toBeUndefined();
	});
});
