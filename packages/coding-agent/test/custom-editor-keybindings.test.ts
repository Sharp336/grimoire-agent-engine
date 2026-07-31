import { beforeAll, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("CustomEditor keybindings", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("routes the configured retry chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();

		editor.setActionKeys("app.retry", ["alt+shift+r"]);
		editor.onRetry = onRetry;
		editor.handleInput("\x1bR");

		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("lets custom handlers keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const customHandler = vi.fn();

		editor.onRetry = onRetry;
		editor.setCustomKeyHandler("alt+r", customHandler);
		editor.handleInput("\x1br");

		expect(customHandler).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("lets copy-prompt remaps keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const onCopyPrompt = vi.fn();

		editor.onRetry = onRetry;
		editor.onCopyPrompt = onCopyPrompt;
		editor.setActionKeys("app.clipboard.copyPrompt", ["alt+r"]);
		editor.handleInput("\x1br");

		expect(onCopyPrompt).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("routes each dequeue chord to its own handler through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onDequeue = vi.fn();
		const onDequeueFollowUp = vi.fn();

		editor.onDequeue = onDequeue;
		editor.onDequeueFollowUp = onDequeueFollowUp;

		// ctrl+shift+up must not fall through to the steering dequeue, whose own
		// binding is checked first in the dispatch chain.
		editor.handleInput("\x1b[1;6A");
		expect(onDequeueFollowUp).toHaveBeenCalledTimes(1);
		expect(onDequeue).not.toHaveBeenCalled();

		editor.handleInput("\x1b[1;3A");
		expect(onDequeue).toHaveBeenCalledTimes(1);
		expect(onDequeueFollowUp).toHaveBeenCalledTimes(1);
	});

	it("binds ctrl+shift+up to the follow-up dequeue", () => {
		const keybindings = KeybindingsManager.inMemory();
		expect(keybindings.getKeys("app.message.dequeueFollowUp")).toEqual(["ctrl+shift+up"]);
	});
});
