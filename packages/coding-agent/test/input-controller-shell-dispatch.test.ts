import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

type FakeEditor = {
	onSubmit?: (text: string) => Promise<void>;
	imageLinks?: readonly (string | undefined)[];
	setText(text: string): void;
	addToHistory(text: string): void;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
};

function createContext() {
	const handleInteractiveShell = vi.fn(async () => {});
	const handleBashCommand = vi.fn(async (_command: string, _isExcluded: boolean) => {});
	const onInputCallback = vi.fn();
	const editor: FakeEditor = {
		setText: vi.fn(),
		addToHistory: vi.fn(),
		pendingImages: [],
		pendingImageLinks: [],
	};
	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender: vi.fn() } as unknown as InteractiveModeContext["ui"],
		session: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			maybeStartTitleGeneration: vi.fn(),
			prompt: vi.fn(async () => {}),
			queuedMessageCount: 0,
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
		} as unknown as InteractiveModeContext["session"],
		sessionManager: { getSessionName: () => "shell-test" } as unknown as InteractiveModeContext["sessionManager"],
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		onInputCallback,
		startPendingSubmission: vi.fn((submission: unknown) => submission),
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
		fileSlashCommands: new Set<string>(),
		isKnownSlashCommand: () => false,
		handleInteractiveShell,
		handleBashCommand,
		handlePythonCommand: vi.fn(async () => {}),
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, handleBashCommand, handleInteractiveShell, onInputCallback };
}

describe("InputController shell shortcuts", () => {
	it("dispatches trimmed exact bang to the interactive shell", async () => {
		const { ctx, editor, handleBashCommand, handleInteractiveShell, onInputCallback } = createContext();
		new InputController(ctx).setupEditorSubmitHandler();

		await editor.onSubmit?.(" \n!\t ");

		expect(handleInteractiveShell).toHaveBeenCalledTimes(1);
		expect(handleBashCommand).not.toHaveBeenCalled();
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("keeps quick bang and double-bang command dispatch unchanged", async () => {
		const { ctx, editor, handleBashCommand, handleInteractiveShell, onInputCallback } = createContext();
		new InputController(ctx).setupEditorSubmitHandler();

		await editor.onSubmit?.("! printf one");
		await editor.onSubmit?.("!! printf two");

		expect(handleBashCommand.mock.calls).toEqual([
			["printf one", false],
			["printf two", true],
		]);
		expect(handleInteractiveShell).not.toHaveBeenCalled();
		expect(onInputCallback).not.toHaveBeenCalled();
	});
});
