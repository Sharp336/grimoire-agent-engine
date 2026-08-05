import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function acpRuntime() {
	const pruneEmptyBranches = vi.fn(async () => 5);
	const output = vi.fn();
	const runtime = { session: { pruneEmptyBranches }, output } as unknown as SlashCommandRuntime;
	return { pruneEmptyBranches, output, runtime };
}

function tuiRuntime() {
	const handlePruneCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const runtime = {
		ctx: {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			handlePruneCommand,
		} as unknown as InteractiveModeContext,
	};
	return { handlePruneCommand, setText, runtime };
}

describe("/prune dispatch (ACP)", () => {
	it("invokes pruneEmptyBranches and outputs the count", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/prune", h.runtime);
		expect(h.pruneEmptyBranches).toHaveBeenCalled();
		expect(h.output.mock.calls[0]?.[0] as string).toContain("Pruned 5 empty branch entries.");
	});

	it("is advertised to ACP clients", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "prune");
		expect(advertised).toBeDefined();
		expect(advertised?.description).toContain("Prune empty conversation branches");
	});
});

describe("/prune dispatch (TUI)", () => {
	it("routes to handlePruneCommand and clears the editor", async () => {
		const h = tuiRuntime();
		const handled = await executeBuiltinSlashCommand("/prune", h.runtime);
		expect(handled).toBe(true);
		expect(h.setText).toHaveBeenCalledWith("");
		expect(h.handlePruneCommand).toHaveBeenCalled();
	});
});
