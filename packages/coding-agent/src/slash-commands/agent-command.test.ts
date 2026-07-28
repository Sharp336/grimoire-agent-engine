import { afterEach, describe, expect, test, vi } from "bun:test";
import * as discovery from "../task/discovery";
import { lookupBuiltinSlashCommand } from "./builtin-registry";
import type { ParsedSlashCommand, SlashCommandRuntime, TuiSlashCommandRuntime } from "./types";

describe("/agent slash command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function getAgentCommand() {
		const cmd = lookupBuiltinSlashCommand("agent");
		if (!cmd) throw new Error("/agent command not found");
		return cmd;
	}

	function makeCommand(args: string): ParsedSlashCommand {
		return { name: "agent", args, text: `/agent ${args}`.trim() };
	}

	test("handleTui with no args calls showAgentPersonaSelector", async () => {
		const showAgentPersonaSelector = vi.fn();
		const setText = vi.fn();
		const runtime = {
			ctx: {
				showAgentPersonaSelector,
				editor: { setText },
			},
		} as unknown as TuiSlashCommandRuntime;

		const cmd = getAgentCommand();
		await cmd.handleTui!(makeCommand(""), runtime);

		expect(showAgentPersonaSelector).toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
	});

	test("handle with valid agent calls switchAgentPersona", async () => {
		const mockAgent = { name: "test", description: "", systemPrompt: "", source: "project" as const };
		const switchPersona = vi.fn().mockResolvedValue(undefined);
		const output = vi.fn();
		const runtime = {
			session: { switchAgentPersona: switchPersona },
			cwd: "/test",
			output,
			sessionManager: {} as any,
			settings: {} as any,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
		} as unknown as SlashCommandRuntime;

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));

		const cmd = getAgentCommand();
		await cmd.handle!(makeCommand("test"), runtime);

		expect(switchPersona).toHaveBeenCalledWith(mockAgent);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Switched to agent persona"));
	});

	test("handle with unknown agent prints error", async () => {
		const output = vi.fn();
		const runtime = {
			session: { switchAgentPersona: vi.fn() },
			cwd: "/test",
			output,
			sessionManager: {} as any,
			settings: {} as any,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
		} as unknown as SlashCommandRuntime;

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockReturnValue(undefined);

		const cmd = getAgentCommand();
		await cmd.handle!(makeCommand("unknown"), runtime);

		expect(output).toHaveBeenCalledWith(expect.stringContaining("Unknown agent"));
	});

	test("handle with subagent-only agent prints error", async () => {
		const mockAgent = {
			name: "sub",
			description: "",
			systemPrompt: "",
			availability: "subagent" as const,
			source: "project" as const,
		};
		const output = vi.fn();
		const runtime = {
			session: { switchAgentPersona: vi.fn() },
			cwd: "/test",
			output,
			sessionManager: {} as any,
			settings: {} as any,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
		} as unknown as SlashCommandRuntime;

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));

		const cmd = getAgentCommand();
		await cmd.handle!(makeCommand("sub"), runtime);

		expect(output).toHaveBeenCalledWith(expect.stringContaining("subagent-only"));
	});

	test("/switch-agent alias resolves to same command", async () => {
		const switchCmd = lookupBuiltinSlashCommand("switch-agent");
		expect(switchCmd).toBeDefined();
		expect(switchCmd!.name).toBe("agent");
	});
});
