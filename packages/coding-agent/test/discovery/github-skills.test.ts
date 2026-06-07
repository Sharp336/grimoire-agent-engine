/**
 * Regression tests for GitHub Copilot discovery provider.
 *
 * - Issue #1906: `.github/skills/<name>/SKILL.md` must be discovered as a skill.
 * - Issue #1917: `~/.copilot/mcp-config.json` must be discovered as MCP servers.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import "@oh-my-pi/pi-coding-agent/capability/skill";
import "@oh-my-pi/pi-coding-agent/discovery/github";

function writeSkill(root: string, name: string, description: string | null): void {
	const skillDir = path.join(root, name);
	fs.mkdirSync(skillDir, { recursive: true });
	const frontmatter =
		description === null ? `---\nname: ${name}\n---\n` : `---\nname: ${name}\ndescription: ${description}\n---\n`;
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${frontmatter}\n# ${name}\n\nSkill body.\n`);
}

function writeCopilotMcpConfig(home: string, content: string): string {
	const filePath = path.join(home, ".copilot", "mcp-config.json");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("github discovery", () => {
	let tempDir!: string;
	let homeDir!: string;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-github-discovery-"));
		homeDir = path.join(tempDir, "home");
		process.env.HOME = homeDir;
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
	});

	afterEach(() => {
		clearCache();
		vi.restoreAllMocks();
		delete process.env.GITHUB_COPILOT_MCP_TOKEN;
		delete process.env.HOME;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("discovers .github/skills/<name>/SKILL.md via the github provider", async () => {
		writeSkill(path.join(tempDir, ".github", "skills"), "demo-skill", "Demo skill for Copilot");

		const result = await loadCapability<Skill>("skills", { cwd: tempDir, providers: ["github"] });

		const found = result.all.find(skill => skill.name === "demo-skill");
		expect(found).toBeDefined();
		expect(found?.path).toBe(path.join(tempDir, ".github", "skills", "demo-skill", "SKILL.md"));
		expect(found?.level).toBe("project");
		expect(found?._source.provider).toBe("github");
		expect(result.warnings).toEqual([]);
	});

	test("skips skills missing a description (matches GitHub agent-skills standard)", async () => {
		writeSkill(path.join(tempDir, ".github", "skills"), "no-desc", null);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir, providers: ["github"] });

		expect(result.all.find(skill => skill.name === "no-desc")).toBeUndefined();
	});

	test("returns no skills when .github/skills/ is absent", async () => {
		const result = await loadCapability<Skill>("skills", { cwd: tempDir, providers: ["github"] });

		expect(result.all).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("discovers ~/.copilot/mcp-config.json via the github provider", async () => {
		process.env.GITHUB_COPILOT_MCP_TOKEN = "copilot-secret";
		const configPath = writeCopilotMcpConfig(
			homeDir,
			JSON.stringify({
				servers: {
					githubCopilot: {
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-github"],
						env: { AUTH_TOKEN: "$" + "{GITHUB_COPILOT_MCP_TOKEN}" },
						type: "stdio",
						timeout: 45000,
					},
				},
			}),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["github"],
		});

		expect(result.warnings).toEqual([]);
		const found = result.items.find(server => server.name === "githubCopilot");
		expect(found).toBeDefined();
		expect(found?.command).toBe("npx");
		expect(found?.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
		expect(found?.env).toEqual({ AUTH_TOKEN: "copilot-secret" });
		expect(found?.transport).toBe("stdio");
		expect(found?.timeout).toBe(45000);
		expect(found?._source.provider).toBe("github");
		expect(found?._source.path).toBe(configPath);
		expect(found?._source.level).toBe("user");
	});

	test("supports mcpServers top-level key in ~/.copilot/mcp-config.json", async () => {
		writeCopilotMcpConfig(
			homeDir,
			JSON.stringify({
				mcpServers: {
					remoteCopilot: {
						url: "https://mcp.example.com",
						headers: { Authorization: "Bearer token" },
						type: "http",
					},
				},
			}),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["github"],
		});

		expect(result.warnings).toEqual([]);
		expect(result.items).toEqual([
			expect.objectContaining({
				name: "remoteCopilot",
				url: "https://mcp.example.com",
				headers: { Authorization: "Bearer token" },
				transport: "http",
			}),
		]);
	});

	test("reports invalid JSON in ~/.copilot/mcp-config.json", async () => {
		writeCopilotMcpConfig(homeDir, "{ not-json }");

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["github"],
		});

		expect(result.items).toEqual([]);
		expect(result.warnings).toEqual([
			`[GitHub Copilot] Invalid JSON in ${path.join(homeDir, ".copilot", "mcp-config.json")}`,
		]);
	});
});
