import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";

async function loadClaudeMcpServers(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["claude"],
	});
	return result.items;
}

describe("claude settings.json MCP discovery", () => {
	let tempDir: string;
	let claudeDir: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		originalHome = process.env.HOME;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-settings-mcp-"));
		claudeDir = path.join(tempDir, ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("loads MCP servers from settings.json when no mcp.json exists", async () => {
		await fs.writeFile(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({
				mcpServers: {
					statsig: { type: "http", url: "https://api.statsig.com/v1/mcp" },
				},
			}),
		);

		const servers = await loadClaudeMcpServers(tempDir);
		expect(servers.some(s => s.name === "statsig")).toBe(true);
		const statsig = servers.find(s => s.name === "statsig")!;
		expect(statsig.url).toBe("https://api.statsig.com/v1/mcp");
		expect(statsig.transport).toBe("http");
	});

	test("mcp.json takes precedence over settings.json", async () => {
		await fs.writeFile(
			path.join(claudeDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					fromMcpJson: { type: "http", url: "https://from-mcp.example.com" },
				},
			}),
		);
		await fs.writeFile(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({
				mcpServers: {
					fromSettings: { type: "http", url: "https://from-settings.example.com" },
				},
			}),
		);

		const servers = await loadClaudeMcpServers(tempDir);
		expect(servers.some(s => s.name === "fromMcpJson")).toBe(true);
		expect(servers.some(s => s.name === "fromSettings")).toBe(false);
	});

	test("loads servers with oauth config from settings.json", async () => {
		await fs.writeFile(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({
				mcpServers: {
					slack: {
						type: "http",
						url: "https://mcp.slack.com/mcp",
						oauth: { clientId: "abc", callbackPort: 3118 },
					},
				},
			}),
		);

		const servers = await loadClaudeMcpServers(tempDir);
		const slack = servers.find(s => s.name === "slack")!;
		expect(slack.oauth?.clientId).toBe("abc");
		expect(slack.oauth?.callbackPort).toBe(3118);
	});
});
