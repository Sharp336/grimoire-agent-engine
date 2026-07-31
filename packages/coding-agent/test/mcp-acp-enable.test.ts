import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { handleMcpAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mcp";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const cleanupPaths: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("ACP /mcp enable", () => {
	test("updates a source-disabled project server before enabling its activation", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-agent-"));
		cleanupPaths.push(projectDir, agentDir);
		const configPath = path.join(projectDir, ".omp", "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { disabled: { type: "stdio", command: "echo", enabled: false } } }),
		);
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
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
		expect(output).toEqual(['Server "disabled" enabled.']);
	});
});
