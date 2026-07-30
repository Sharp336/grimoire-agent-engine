import { describe, expect, test } from "bun:test";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";

const emptyRoutines = async () => [];

describe("buildAvailableSlashCommands", () => {
	test("returns RPC-safe command metadata with stable sources", async () => {
		const fileCommands = [{ name: "notes", description: "Open notes", content: "body", source: "test" }];
		const routines = [
			{
				name: "review-all",
				description: "Run reviews",
				path: "/tmp/review-all.yaml",
				steps: [{ command: "notes" }],
				level: "user" as const,
				_source: { provider: "test", providerName: "Test", path: "/tmp/review-all.yaml", level: "user" as const },
			},
		];
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
			skills: [{ name: "reviewer", description: "Review code", filePath: "/tmp/reviewer/SKILL.md" }],
			skillsSettings: { enableSkillCommands: true },
			sessionManager: { getCwd: () => process.cwd() },
			setSlashCommands(commands: typeof fileCommands) {
				expect(commands).toEqual(fileCommands);
			},
			setRoutines(loaded: typeof routines) {
				expect(loaded).toEqual(routines);
			},
		};

		const commands = await buildAvailableSlashCommands(
			session as never,
			async () => fileCommands,
			async () => routines,
		);
		const byName = Object.fromEntries(commands.map(command => [command.name, command]));

		expect(byName.usage.subcommands).toContainEqual({
			name: "show",
			description: "Show provider usage and limits",
		});
		expect(byName.usage.subcommands).toContainEqual({
			name: "reset",
			description: "Spend a saved Codex rate-limit reset",
			usage: "[account|active]",
		});
		expect(byName["reset-usage"]).toBeUndefined();

		expect(byName.fast.description).toBe("Toggle fast mode");
		expect(byName["ext:hello"].description).toBe("Extension hello");
		expect(byName["custom:hello"].description).toBe("Custom hello");
		expect(byName["server:prompt"].description).toBe("MCP prompt");
		expect(byName.notes.description).toBe("Open notes");
		expect(byName["skill:reviewer"].description).toBe("Review code");
		expect(byName["review-all"].description).toBe("Run reviews");

		expect(byName.model.source).toBe("builtin");
		expect(byName["skill:reviewer"].source).toBe("skill");
		expect(byName["ext:hello"].source).toBe("extension");
		expect(byName["server:prompt"].source).toBe("mcp_prompt");
		expect(byName["custom:hello"].source).toBe("custom");
		expect(byName.notes.source).toBe("file");
		expect(byName["review-all"].source).toBe("routine");
		expect(byName["review-all"].input).toBeUndefined();
	});

	test("loads file commands and routines into the session before advertising them", async () => {
		const fileCommands = [{ name: "notes", description: "Open notes", content: "body", source: "test" }];
		const routines = [
			{
				name: "review-all",
				description: "Run reviews",
				path: "/tmp/review-all.yaml",
				steps: [{ command: "notes" }],
				level: "user" as const,
				_source: { provider: "test", providerName: "Test", path: "/tmp/review-all.yaml", level: "user" as const },
			},
		];
		let loadedCommands: typeof fileCommands | undefined;
		let loadedRoutines: typeof routines | undefined;

		const commands = await buildAvailableSlashCommands(
			{
				customCommands: [],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands(commands: typeof fileCommands) {
					loadedCommands = commands;
				},
				setRoutines(next: typeof routines) {
					loadedRoutines = next;
				},
			} as never,
			async () => fileCommands,
			async () => routines,
		);

		expect(loadedCommands).toEqual(fileCommands);
		expect(loadedRoutines).toEqual(routines);
		expect(commands.find(command => command.name === "notes")?.source).toBe("file");
		expect(commands.find(command => command.name === "review-all")?.source).toBe("routine");
	});

	test("rejects conflicting candidates without replacing the committed command state", async () => {
		const validFileCommands = [{ name: "stable", description: "Stable command", content: "body", source: "test" }];
		const validRoutines = [
			{
				name: "review-all",
				description: "Run reviews",
				path: "/tmp/review-all.yaml",
				steps: [{ command: "stable" }],
				level: "user" as const,
				_source: { provider: "test", providerName: "Test", path: "/tmp/review-all.yaml", level: "user" as const },
			},
		];
		const conflictingRoutines = [
			{
				...validRoutines[0],
				name: "stable",
				path: "/tmp/stable.yaml",
				_source: { ...validRoutines[0]._source, path: "/tmp/stable.yaml" },
			},
		];
		const candidateFileCommands = validFileCommands;
		let candidateRoutines = validRoutines;
		let loadedCommands = validFileCommands;
		let loadedRoutines = validRoutines;
		const session = {
			customCommands: [],
			skills: [],
			sessionManager: { getCwd: () => process.cwd() },
			setSlashCommands(commands: typeof validFileCommands) {
				loadedCommands = commands;
			},
			setRoutines(routines: typeof validRoutines) {
				loadedRoutines = routines;
			},
		};

		await buildAvailableSlashCommands(
			session as never,
			async () => candidateFileCommands,
			async () => candidateRoutines,
		);
		candidateRoutines = conflictingRoutines;

		await expect(
			buildAvailableSlashCommands(
				session as never,
				async () => candidateFileCommands,
				async () => candidateRoutines,
			),
		).rejects.toThrow("Routine /stable conflicts with existing slash command /stable");

		const isDispatchable = (name: string) =>
			loadedCommands.some(command => command.name === name) || loadedRoutines.some(routine => routine.name === name);
		expect(isDispatchable("stable")).toBe(true);
		expect(isDispatchable("review-all")).toBe(true);
		expect(loadedRoutines.some(routine => routine.name === "stable")).toBe(false);
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
				setRoutines() {},
			} as never,
			async () => [],
			emptyRoutines,
		);

		const byName = Object.fromEntries(commands.map(command => [command.name, command]));
		expect(byName["server:prompt"].source).toBe("mcp_prompt");
		expect(byName.green.source).toBe("custom");
	});

	test("keeps legacy custom command fixtures without a path classified as custom", async () => {
		const commands = await buildAvailableSlashCommands(
			{
				customCommands: [{ command: { name: "legacy", description: "Legacy fixture" } }],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands() {},
				setRoutines() {},
			} as never,
			async () => [],
			emptyRoutines,
		);

		expect(commands.find(command => command.name === "legacy")?.source).toBe("custom");
	});
});
