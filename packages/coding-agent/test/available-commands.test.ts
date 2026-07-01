import { describe, expect, test } from "bun:test";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";

describe("buildAvailableSlashCommands", () => {
	test("returns RPC-safe command metadata with stable sources", async () => {
		const fileCommands = [{ name: "notes", description: "Open notes", content: "body", source: "test" }];
		const mcpPrompt = {
			path: "mcp:server/prompt",
			resolvedPath: "mcp:server/prompt",
			source: "project",
			command: { name: "server:prompt", description: "MCP prompt" },
		};
		const session = {
			extensionRunner: {
				getRegisteredCommands: () => [{ name: "ext:hello", description: "Extension hello" }],
			},
			customCommands: [
				mcpPrompt,
				{
					path: "custom.ts",
					resolvedPath: "custom.ts",
					source: "project",
					command: { name: "custom:hello", description: "Custom hello" },
				},
			],
			mcpPromptCommands: [mcpPrompt],
			promptTemplates: [{ name: "review", description: "Review prompt", content: "body", source: "test" }],
			skills: [{ name: "reviewer", description: "Review code", filePath: "/tmp/reviewer/SKILL.md" }],
			skillsSettings: { enableSkillCommands: true },
			sessionManager: { getCwd: () => process.cwd() },
			setSlashCommands(commands: typeof fileCommands) {
				expect(commands).toEqual(fileCommands);
			},
		};

		const commands = await buildAvailableSlashCommands(session as never, async () => fileCommands);
		const byName = Object.fromEntries(commands.map(command => [command.name, command]));

		expect(byName["cmd:usage"].subcommands).toContainEqual({
			name: "show",
			description: "Show provider usage and limits",
		});
		expect(byName["cmd:usage"].subcommands).toContainEqual({
			name: "reset",
			description: "Spend a saved Codex rate-limit reset",
			usage: "[account|active]",
		});
		expect(byName.usage).toBeUndefined();
		expect(byName["reset-usage"]).toBeUndefined();

		expect(byName["cmd:fast"].description).toBe("Toggle fast mode");
		expect(byName["cmd:ext:hello"].description).toBe("Extension hello");
		expect(byName["cmd:custom:hello"].description).toBe("Custom hello");
		expect(byName["cmd:server:prompt"].description).toBe("MCP prompt");
		expect(byName["cmd:notes"].description).toBe("Open notes");
		expect(byName["cmd:review"].description).toBe("Review prompt");
		expect(byName["skill:reviewer"].description).toBe("Review code");

		expect(byName["cmd:model"].source).toBe("builtin");
		expect(byName["skill:reviewer"].source).toBe("skill");
		expect(byName["cmd:ext:hello"].source).toBe("extension");
		expect(byName["cmd:server:prompt"].source).toBe("mcp_prompt");
		expect(byName["cmd:custom:hello"].source).toBe("custom");
		expect(byName["cmd:notes"].source).toBe("file");
		expect(byName["cmd:review"].source).toBe("prompt_template");
	});

	test("loads file commands into the session before advertising them", async () => {
		const fileCommands = [{ name: "notes", description: "Open notes", content: "body", source: "test" }];
		let loadedCommands: typeof fileCommands | undefined;

		const commands = await buildAvailableSlashCommands(
			{
				customCommands: [],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands(commands: typeof fileCommands) {
					loadedCommands = commands;
				},
			} as never,
			async () => fileCommands,
		);

		expect(loadedCommands).toEqual(fileCommands);
		expect(commands.find(command => command.name === "cmd:notes")?.source).toBe("file");
	});

	test("classifies MCP prompts by path and bundled custom commands as custom", async () => {
		const commands = await buildAvailableSlashCommands(
			{
				customCommands: [
					{
						path: "mcp:server/prompt",
						resolvedPath: "mcp:server/prompt",
						source: "project",
						command: { name: "server:prompt", description: "MCP prompt" },
					},
					{
						path: "green.md",
						resolvedPath: "green.md",
						source: "bundled",
						command: { name: "green", description: "Bundled custom command" },
					},
				],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands() {},
			} as never,
			async () => [],
		);

		const byName = Object.fromEntries(commands.map(command => [command.name, command]));
		expect(byName["cmd:server:prompt"].source).toBe("mcp_prompt");
		expect(byName["cmd:green"].source).toBe("custom");
	});

	test("keeps legacy custom command fixtures without a path classified as custom", async () => {
		const commands = await buildAvailableSlashCommands(
			{
				customCommands: [{ command: { name: "legacy", description: "Legacy fixture" } }],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands() {},
			} as never,
			async () => [],
		);

		expect(commands.find(command => command.name === "cmd:legacy")?.source).toBe("custom");
	});
});
