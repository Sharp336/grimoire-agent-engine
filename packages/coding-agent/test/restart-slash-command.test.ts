import { describe, expect, test, vi } from "bun:test";
import type { BuiltinSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/restart slash command", () => {
	test("keeps the draft for restart teardown to persist", async () => {
		const setText = vi.fn();
		const restart = vi.fn(async () => undefined);
		const runtime = { ctx: { editor: { setText }, restart } } as unknown as BuiltinSlashCommandRuntime;

		const result = await executeBuiltinSlashCommand("/restart", runtime);

		expect(result).toBe(true);
		expect(setText).not.toHaveBeenCalled();
		expect(restart).toHaveBeenCalledTimes(1);
	});
});
