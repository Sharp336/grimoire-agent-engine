import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";

/**
 * Load MCP servers using only the "copilot" provider.
 * Caller must set HOME/USERPROFILE before calling so resolveCopilotHome
 * picks up the temp fixture directory. loadCapability derives ctx.home
 * from os.homedir() — it does NOT accept a home option.
 */
async function loadCopilotMcpServers(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["copilot"],
	});
	return result.items;
}

function envPlaceholder(name: string): string {
	return `\${${name}}`;
}

describe("copilot MCP discovery", () => {
	let tempDir = "";
	let originalHome = "";
	let originalCopilotHome: string | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-copilot-"));
		originalHome = process.env.HOME ?? process.env.USERPROFILE ?? "";
		originalCopilotHome = process.env.COPILOT_HOME;
		// Point HOME to tempDir so resolveCopilotHome returns tempDir/.copilot
		process.env.HOME = tempDir;
		process.env.USERPROFILE = tempDir;
		delete process.env.COPILOT_HOME;
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
		process.env.HOME = originalHome;
		process.env.USERPROFILE = originalHome;
		if (originalCopilotHome === undefined) {
			delete process.env.COPILOT_HOME;
		} else {
			process.env.COPILOT_HOME = originalCopilotHome;
		}
	});

	test("discovers servers from mcpServers key", async () => {
		const copilotDir = path.join(tempDir, ".copilot");
		await fs.mkdir(copilotDir, { recursive: true });
		await fs.writeFile(
			path.join(copilotDir, "mcp-config.json"),
			JSON.stringify({
				mcpServers: {
					"my-server": {
						command: "node",
						args: ["server.js"],
					},
				},
			}),
		);

		const servers = await loadCopilotMcpServers(tempDir);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.name).toBe("my-server");
		expect(servers[0]?.command).toBe("node");
		expect(servers[0]?.args).toEqual(["server.js"]);
	});

	test("discovers servers from servers key (compatibility fallback)", async () => {
		const copilotDir = path.join(tempDir, ".copilot");
		await fs.mkdir(copilotDir, { recursive: true });
		await fs.writeFile(
			path.join(copilotDir, "mcp-config.json"),
			JSON.stringify({
				servers: {
					"fallback-server": {
						url: "https://example.com/mcp",
					},
				},
			}),
		);

		const servers = await loadCopilotMcpServers(tempDir);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.name).toBe("fallback-server");
		expect(servers[0]?.url).toBe("https://example.com/mcp");
	});

	test("mcpServers takes priority over servers when both present", async () => {
		const copilotDir = path.join(tempDir, ".copilot");
		await fs.mkdir(copilotDir, { recursive: true });
		await fs.writeFile(
			path.join(copilotDir, "mcp-config.json"),
			JSON.stringify({
				mcpServers: {
					"official-server": {
						command: "official",
					},
				},
				servers: {
					"fallback-server": {
						command: "fallback",
					},
				},
			}),
		);

		const servers = await loadCopilotMcpServers(tempDir);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.name).toBe("official-server");
	});

	test("returns empty when mcp-config.json is missing", async () => {
		// No .copilot directory created
		const servers = await loadCopilotMcpServers(tempDir);
		expect(servers).toHaveLength(0);
	});

	test("returns warning on invalid JSON", async () => {
		const copilotDir = path.join(tempDir, ".copilot");
		await fs.mkdir(copilotDir, { recursive: true });
		await fs.writeFile(path.join(copilotDir, "mcp-config.json"), "{bad json}");

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["copilot"],
		});
		expect(result.items).toHaveLength(0);
		expect(result.warnings.some(w => w.includes("Failed to parse JSON"))).toBe(true);
	});

	test("respects COPILOT_HOME env var", async () => {
		const customDir = path.join(tempDir, "custom-copilot");
		await fs.mkdir(customDir, { recursive: true });
		await fs.writeFile(
			path.join(customDir, "mcp-config.json"),
			JSON.stringify({
				mcpServers: {
					"custom-server": {
						command: "custom",
					},
				},
			}),
		);

		process.env.COPILOT_HOME = customDir;
		const servers = await loadCopilotMcpServers(tempDir);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.name).toBe("custom-server");
	});

	test("expands environment variables in config values", async () => {
		const copilotDir = path.join(tempDir, ".copilot");
		await fs.mkdir(copilotDir, { recursive: true });

		process.env.OMP_TEST_TOKEN = "secret-token";
		process.env.OMP_TEST_URL = "https://mcp.example.com";

		await fs.writeFile(
			path.join(copilotDir, "mcp-config.json"),
			JSON.stringify({
				mcpServers: {
					"env-server": {
						url: envPlaceholder("OMP_TEST_URL"),
						headers: { Authorization: envPlaceholder("OMP_TEST_TOKEN") },
					},
				},
			}),
		);

		const servers = await loadCopilotMcpServers(tempDir);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.url).toBe("https://mcp.example.com");
		expect(servers[0]?.headers).toEqual({ Authorization: "secret-token" });

		delete process.env.OMP_TEST_TOKEN;
		delete process.env.OMP_TEST_URL;
	});

	test("normalizes type 'local' to transport 'stdio'", async () => {
		const copilotDir = path.join(tempDir, ".copilot");
		await fs.mkdir(copilotDir, { recursive: true });
		await fs.writeFile(
			path.join(copilotDir, "mcp-config.json"),
			JSON.stringify({
				mcpServers: {
					"local-server": {
						command: "node",
						args: ["local.js"],
						type: "local",
					},
				},
			}),
		);

		const servers = await loadCopilotMcpServers(tempDir);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.transport).toBe("stdio");
	});
});
