import { describe, expect, it, vi } from "bun:test";
import type { BuiltinSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/plan slash command", () => {
	it("shows the current plan reference without toggling plan mode", async () => {
		const handlePlanModeCommand = vi.fn();
		const showStatus = vi.fn();
		const editorSetText = vi.fn();
		const runtime = {
			ctx: {
				session: {
					async getPlanReference() {
						return {
							planFilePath: "local://approved-plan.md",
							resolvedPlanPath: "/tmp/session/local/approved-plan.md",
							planContent: "# Approved Plan",
						};
					},
				},
				handlePlanModeCommand,
				showStatus,
				showWarning: vi.fn(),
				editor: { setText: editorSetText },
			},
			handleBackgroundCommand: vi.fn(),
		} as unknown as BuiltinSlashCommandRuntime;

		const result = await executeBuiltinSlashCommand("/plan show", runtime);

		expect(result).toBe(true);
		expect(handlePlanModeCommand).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Current plan: local://approved-plan.md");
		expect(editorSetText).toHaveBeenCalledWith("");
	});
});
