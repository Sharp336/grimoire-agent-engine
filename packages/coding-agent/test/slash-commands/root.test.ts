import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

type RuntimeHarness = {
	runtime: { ctx: InteractiveModeContext; handleBackgroundCommand: () => void };
	getHandledRootCommand: () => string | undefined;
	getEditorText: () => string | undefined;
};

const createRuntimeHarness = (): RuntimeHarness => {
	let handledRootCommand: string | undefined;
	let editorText: string | undefined;

	const ctx = {
		editor: {
			setText: (value: string) => {
				editorText = value;
			},
		} as unknown as InteractiveModeContext["editor"],
		handleRootCommand: async (text: string) => {
			handledRootCommand = text;
		},
	} as InteractiveModeContext;

	return {
		runtime: {
			ctx,
			handleBackgroundCommand: () => {},
		},
		getHandledRootCommand: () => handledRootCommand,
		getEditorText: () => editorText,
	};
};

describe("/root slash command", () => {
	it("routes /root add to root command handler", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/root add ../service-b", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getHandledRootCommand()).toBe("/root add ../service-b");
		expect(harness.getEditorText()).toBe("");
	});

	it("routes /root without args (list default) to root command handler", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/root", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getHandledRootCommand()).toBe("/root");
		expect(harness.getEditorText()).toBe("");
	});
});
