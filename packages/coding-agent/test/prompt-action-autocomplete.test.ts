import { describe, expect, it } from "bun:test";
import { buildAvailableSlashCommands } from "../src/slash-commands/available-commands";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../src/slash-commands/builtin-registry";

describe("RPC composer command materialization", () => {
	it("advertises every builtin, including interactive-only entries and aliases", async () => {
		const commands = await buildAvailableSlashCommands(
			{
				customCommands: [],
				mcpPromptCommands: [],
				skills: [],
				skillsSettings: { enableSkillCommands: false } as never,
				sessionManager: { getCwd: () => "/tmp" },
				setSlashCommands: () => { },
			},
			async () => [],
		);
		const names = new Set(commands.flatMap(command => [command.name, ...(command.aliases ?? [])]));
		for (const builtin of BUILTIN_SLASH_COMMANDS_INTERNAL) {
			expect(names.has(builtin.name)).toBe(true);
			for (const alias of builtin.aliases ?? []) expect(names.has(alias)).toBe(true);
		}
	});

	it("keeps subcommand metadata for argument completion", async () => {
		const commands = await buildAvailableSlashCommands(
			{
				customCommands: [],
				mcpPromptCommands: [],
				skills: [],
				skillsSettings: { enableSkillCommands: false } as never,
				sessionManager: { getCwd: () => "/tmp" },
				setSlashCommands: () => { },
			},
			async () => [],
		);
		const mcp = commands.find(command => command.name === "mcp");
		expect(mcp?.subcommands?.length).toBeGreaterThan(0);
		expect(mcp?.subcommands?.some(command => command.name === "enable")).toBe(true);
	});
});
