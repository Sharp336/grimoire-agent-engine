import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const showModelSelector = vi.fn();
	const setText = vi.fn();
	return {
		showModelSelector,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showModelSelector,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/model slash command", () => {
	it("opens the temporary session model switcher", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("/models slash command", () => {
	it("opens the permanent model setup (role-assignment) picker", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/models", harness.runtime);

		expect(handled).toBe(true);
		// Permanent picker: showModelSelector() with no temporaryOnly flag, so
		// Enter opens the role/thinking menu instead of selecting directly.
		expect(harness.showModelSelector).toHaveBeenCalledTimes(1);
		expect(harness.showModelSelector.mock.calls[0]).toEqual([]);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("/switch slash command (removed)", () => {
	it("is no longer a recognized command", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch", harness.runtime);

		expect(handled).toBe(false);
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});
});
