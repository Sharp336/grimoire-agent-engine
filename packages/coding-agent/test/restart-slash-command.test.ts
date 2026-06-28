import { describe, expect, test, vi } from "bun:test";
import type { BuiltinSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/restart slash command", () => {
	test("clears the editor and restarts the TUI", async () => {
		const setText = vi.fn();
		const restart = vi.fn(async () => undefined);
		const runtime = { ctx: { editor: { setText }, restart } } as unknown as BuiltinSlashCommandRuntime;

		const result = await executeBuiltinSlashCommand("/restart", runtime);

		expect(result).toBe(true);
		expect(setText).toHaveBeenCalledWith("");
		expect(restart).toHaveBeenCalledTimes(1);
	});
});
