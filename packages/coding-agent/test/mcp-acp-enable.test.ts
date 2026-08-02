import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { handleMcpAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mcp";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

const cleanupPaths: string[] = [];
const originalAgentDir = getAgentDir();

async function loadSettings(cwd: string, agentDir: string): Promise<Settings> {
	setAgentDir(agentDir);
	return await Settings.loadIsolated({ cwd, agentDir });
}

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	await Promise.all(cleanupPaths.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("ACP /mcp enable and disable", () => {
	test("updates a source-disabled project definition", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		const configPath = path.join(projectDir, ".omp", "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { disabled: { type: "stdio", command: "echo", enabled: false } } }),
		);
		const settings = await loadSettings(projectDir, agentDir);
		const setProjectActivation = vi.spyOn(settings, "setProjectActivation");
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;
		const command: ParsedSlashCommand = { name: "mcp", args: "enable disabled", text: "mcp enable disabled" };

		await handleMcpAcp(command, runtime);

		expect((await readMCPConfigFile(configPath)).mcpServers?.disabled?.enabled).toBe(true);
		expect(setProjectActivation).not.toHaveBeenCalled();
		expect(output).toEqual(['Server "disabled" enabled.']);
	});

	test("updates a configured project server when disabling", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		const configPath = path.join(projectDir, ".omp", "mcp.json");
		await Bun.write(configPath, JSON.stringify({ mcpServers: { local: { type: "stdio", command: "echo" } } }));
		const settings = await loadSettings(projectDir, agentDir);
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;

		await handleMcpAcp({ name: "mcp", args: "disable local", text: "mcp disable local" }, runtime);

		expect((await readMCPConfigFile(configPath)).mcpServers?.local?.enabled).toBe(false);
		expect(output).toEqual(['Server "local" disabled.']);
	});

	test("finds project servers from an ancestor project root", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		const nestedDir = path.join(projectDir, "packages", "nested");
		await fs.mkdir(nestedDir, { recursive: true });
		const configPath = path.join(projectDir, ".omp", "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { ancestor: { type: "stdio", command: "echo", enabled: false } } }),
		);
		const settings = await loadSettings(nestedDir, agentDir);
		const output: string[] = [];
		const runtime = {
			cwd: nestedDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;
		const command: ParsedSlashCommand = { name: "mcp", args: "enable ancestor", text: "mcp enable ancestor" };

		await handleMcpAcp(command, runtime);

		expect((await readMCPConfigFile(configPath)).mcpServers?.ancestor?.enabled).toBe(true);
		expect(output).toEqual(['Server "ancestor" enabled.']);
	});

	test("rejects an unconfigured server instead of creating a future denylist entry", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		const settings = await loadSettings(projectDir, agentDir);
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;
		const command: ParsedSlashCommand = {
			name: "mcp",
			args: "disable discovered-server",
			text: "mcp disable discovered-server",
		};

		await handleMcpAcp(command, runtime);

		expect(await Bun.file(path.join(agentDir, "mcp.json")).exists()).toBe(false);
		expect(output).toEqual(['Server "discovered-server" not found in user or project config.']);
	});

	test("does not treat a disabled project MCP source as discovered", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		await Bun.write(
			path.join(projectDir, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { projectOnly: { command: "echo" } } }),
		);
		const settings = await loadSettings(projectDir, agentDir);
		settings.set("mcp.enableProjectConfig", false);
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;

		await handleMcpAcp({ name: "mcp", args: "disable projectOnly", text: "mcp disable projectOnly" }, runtime);

		expect(await Bun.file(path.join(agentDir, "mcp.json")).exists()).toBe(false);
		expect(output).toEqual(['Server "projectOnly" not found in user or project config.']);
	});

	test("disables a discovered non-project MCP server through the user denylist", async () => {
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-home-"));
		const projectDir = await fs.mkdtemp(path.join(homeDir, "project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(homeDir, agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await Bun.write(
			path.join(homeDir, ".claude.json"),
			JSON.stringify({ mcpServers: { discovered: { command: "echo" } } }),
		);
		const settings = await loadSettings(projectDir, agentDir);
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;

		await handleMcpAcp({ name: "mcp", args: "disable discovered", text: "mcp disable discovered" }, runtime);

		expect((await readMCPConfigFile(path.join(agentDir, "mcp.json"))).disabledServers).toEqual(["discovered"]);
		expect(output).toEqual(['Server "discovered" disabled.']);
	});

	test("does not fall back to a user server behind a disabled project definition", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		await Bun.write(
			path.join(projectDir, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { shared: { type: "stdio", command: "project", enabled: false } } }),
		);
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { shared: { type: "stdio", command: "user" } } }),
		);
		const settings = await loadSettings(projectDir, agentDir);
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;

		await handleMcpAcp({ name: "mcp", args: "test shared", text: "mcp test shared" }, runtime);

		expect(output.join("\n")).toContain('Server "shared" not found.');
	});

	test("lists an inherited source-disabled server as enabled under a project allowlist", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		await Bun.write(path.join(projectDir, ".omp", "mcp.json"), JSON.stringify({ enabledServers: ["inherited"] }));
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { inherited: { type: "stdio", command: "user", enabled: false } } }),
		);
		const settings = await loadSettings(projectDir, agentDir);
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;

		await handleMcpAcp({ name: "mcp", args: "list", text: "mcp list" }, runtime);

		expect(output.join("\n")).toContain("inherited | stdio | enabled");
	});

	test("lists a project-denylisted inherited server as disabled", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		await Bun.write(path.join(projectDir, ".omp", "mcp.json"), JSON.stringify({ disabledServers: ["inherited"] }));
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { inherited: { type: "stdio", command: "user" } } }),
		);
		const settings = await loadSettings(projectDir, agentDir);
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;

		await handleMcpAcp({ name: "mcp", args: "list", text: "mcp list" }, runtime);

		expect(output.join("\n")).toContain("inherited | stdio | disabled");
	});

	test("enabling an inherited server changes only its user definition", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		const projectConfigPath = path.join(projectDir, ".omp", "mcp.json");
		await Bun.write(projectConfigPath, JSON.stringify({ disabledServers: ["inherited"] }));
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { inherited: { type: "stdio", command: "user", enabled: false } } }),
		);
		const settings = await loadSettings(projectDir, agentDir);
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;

		await handleMcpAcp({ name: "mcp", args: "enable inherited", text: "mcp enable inherited" }, runtime);

		expect((await readMCPConfigFile(path.join(agentDir, "mcp.json"))).mcpServers?.inherited?.enabled).toBe(true);
		expect(await readMCPConfigFile(projectConfigPath)).toMatchObject({ disabledServers: ["inherited"] });
		expect((await readMCPConfigFile(projectConfigPath)).enabledServers).toBeUndefined();
		expect(output).toEqual(['Server "inherited" enabled.']);
	});

	test("ignores project MCP config when project loading is disabled", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		await Bun.write(
			path.join(projectDir, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { projectOnly: { type: "stdio", command: "echo" } } }),
		);
		const settings = await loadSettings(projectDir, agentDir);
		settings.set("mcp.enableProjectConfig", false);
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;

		await handleMcpAcp({ name: "mcp", args: "list", text: "mcp list" }, runtime);

		expect(output).toEqual(["No MCP servers configured."]);
	});

	test("does not add a project MCP server when project loading is disabled", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		const settings = await loadSettings(projectDir, agentDir);
		settings.set("mcp.enableProjectConfig", false);
		const output: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;

		await handleMcpAcp(
			{ name: "mcp", args: "add blocked --scope project -- echo", text: "mcp add blocked --scope project -- echo" },
			runtime,
		);

		expect(output).toEqual(["Project MCP configuration is disabled."]);
		expect(await Bun.file(path.join(projectDir, ".omp", "mcp.json")).exists()).toBe(false);
	});
});
