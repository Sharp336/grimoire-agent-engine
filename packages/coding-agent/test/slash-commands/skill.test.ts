import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

type RuntimeHarness = {
	runtime: { ctx: InteractiveModeContext; handleBackgroundCommand: () => void };
	getHandledSkillCommand: () => string | undefined;
	getEditorText: () => string | undefined;
};

const createRuntimeHarness = (): RuntimeHarness => {
	let handledSkillCommand: string | undefined;
	let editorText: string | undefined;

	const ctx = {
		editor: {
			setText: (value: string) => {
				editorText = value;
			},
		} as unknown as InteractiveModeContext["editor"],
		handleSkillManageCommand: async (text: string) => {
			handledSkillCommand = text;
		},
	} as InteractiveModeContext;

	return {
		runtime: {
			ctx,
			handleBackgroundCommand: () => {},
		},
		getHandledSkillCommand: () => handledSkillCommand,
		getEditorText: () => editorText,
	};
};

describe("/skill slash command", () => {
	it("routes /skill pin to skill management handler", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/skill pin linear", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getHandledSkillCommand()).toBe("/skill pin linear");
		expect(harness.getEditorText()).toBe("");
	});

	it("routes /skill without args (list default) to handler", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/skill", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getHandledSkillCommand()).toBe("/skill");
		expect(harness.getEditorText()).toBe("");
	});
});
