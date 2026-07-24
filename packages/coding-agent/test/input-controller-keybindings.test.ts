import { describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type KeyId, matchesKey } from "@oh-my-pi/pi-tui";
import manualContinuePrompt from "../src/prompts/system/manual-continue.md" with { type: "text" };

type FakeEditor = {
	onEscape?: () => void;
	onClear?: () => void;
	onExit?: () => void;
	onDisplayReset?: () => void;
	onSuspend?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModelTemporary?: () => void;
	onSelectModel?: () => void;
	onHistorySearch?: () => void;
	onConsult?: () => void;
	onCopyPrompt?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onRetry?: () => void;
	onDequeue?: () => void;
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => Promise<void>;
	setText(text: string): void;
	getText(): string;
	getExpandedText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	pasteText(text: string): void;
	imageLinks?: (string | undefined)[];
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	clearDraft(historyText?: string): void;
};

type InputListenerResult = { consume: boolean } | undefined;
type InputListener = (data: string) => InputListenerResult;

function dispatchInput(listeners: InputListener[], data: string): InputListenerResult {
	for (const listener of listeners) {
		const result = listener(data);
		if (result) return result;
	}
	return undefined;
}

function registeredInputListeners(addInputListener: Mock<(listener: InputListener) => void>): InputListener[] {
	return addInputListener.mock.calls.map(call => call[0]);
}

async function createContext() {
	let editorText = "";
	const keyMap: Record<string, KeyId[]> = {
		"app.clear": ["ctrl+c"],
		"app.display.reset": ["ctrl+l"],
		"app.model.selectTemporary": ["ctrl+y"],
		"app.model.select": ["alt+m"],
		"app.retry": ["alt+r"],
		"app.clipboard.pasteImage": ["ctrl+v"],
		"app.consult": ["alt+shift+q"],
		"app.message.dequeue": ["alt+shift+d"],
	};
	const customHandlers = new Map<string, () => void>();
	const setActionKeys = vi.fn();
	const setCustomKeyHandler = vi.fn((key: string, handler: () => void) => {
		customHandlers.set(key, handler);
	});
	const clearCustomKeyHandlers = vi.fn(() => {
		customHandlers.clear();
	});
	const resetDisplay = vi.fn();
	const showModelSelector = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	let focused: unknown;
	const addInputListener = vi.fn((listener: InputListener) => {
		void listener;
	});
	const addStartListener = vi.fn();
	const terminalWrite = vi.fn();
	const refreshAppearance = vi.fn();
	const prompt = vi.fn(async () => {});
	const retry = vi.fn(async () => true);
	const abort = vi.fn(async () => {});
	const session = {
		isStreaming: false,
		isCompacting: false,
		isGeneratingHandoff: false,
		isBashRunning: false,
		isEvalRunning: false,
		extensionRunner: undefined,
		prompt,
		queuedMessageCount: 0,
		abort,
		retry,
	};
	const flushSync = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();
	const handleBtwBranchKey = vi.fn(async () => true);
	const canBranchBtw: Mock<InteractiveModeContext["canBranchBtw"]> = vi.fn(() => false);
	const handleBtwCopyKey = vi.fn(async () => true);
	const canCopyBtw = vi.fn(() => false);
	const canCopyConsult: Mock<InteractiveModeContext["canCopyConsult"]> = vi.fn(() => false);
	const handleConsultCopyKey: Mock<InteractiveModeContext["handleConsultCopyKey"]> = vi.fn(async () => true);
	const canAskMainAboutConsultationAnswer: Mock<InteractiveModeContext["canAskMainAboutConsultationAnswer"]> = vi.fn(
		() => false,
	);
	const askMainAboutConsultationAnswer: Mock<InteractiveModeContext["askMainAboutConsultationAnswer"]> = vi.fn(
		async () => true,
	);
	let consultComposerActive = false;
	const getConsultTurnPresentation: Mock<InteractiveModeContext["getConsultTurnPresentation"]> = vi.fn(
		() => undefined,
	);
	const hasActiveConsult: Mock<InteractiveModeContext["hasActiveConsult"]> = vi.fn(() => false);
	const hasActiveOmfg: Mock<InteractiveModeContext["hasActiveOmfg"]> = vi.fn(() => false);
	const returnConsultToParent: Mock<InteractiveModeContext["returnConsultToParent"]> = vi.fn(() => false);
	const startNewConsultation: Mock<InteractiveModeContext["startNewConsultation"]> = vi.fn(async () => true);
	const showPreviousConsultTurn: Mock<InteractiveModeContext["showPreviousConsultTurn"]> = vi.fn(async () => true);
	const showNextConsultTurn: Mock<InteractiveModeContext["showNextConsultTurn"]> = vi.fn(async () => true);
	const scrollConsultAnswer: Mock<InteractiveModeContext["scrollConsultAnswer"]> = vi.fn(() => true);
	const scrollConsultAnswerPage: Mock<InteractiveModeContext["scrollConsultAnswerPage"]> = vi.fn(() => true);
	const scrollConsultAnswerToStart: Mock<InteractiveModeContext["scrollConsultAnswerToStart"]> = vi.fn(() => true);
	const scrollConsultAnswerToEnd: Mock<InteractiveModeContext["scrollConsultAnswerToEnd"]> = vi.fn(() => true);
	const showConsultActionMenu: Mock<InteractiveModeContext["showConsultActionMenu"]> = vi.fn(async () => true);
	const handleConsultSubmit: Mock<InteractiveModeContext["handleConsultSubmit"]> = vi.fn(async () => {});
	const showWarning = vi.fn();
	const clearEditor = vi.fn();
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		pasteText(text: string) {
			editorText += text;
		},
		setActionKeys,
		setCustomKeyHandler,
		clearCustomKeyHandlers,
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			this.setText("");
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	focused = editor;
	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: {
			requestRender,
			resetDisplay,
			addInputListener,
			addStartListener,
			getFocused: vi.fn(() => focused),
			terminal: { write: terminalWrite, refreshAppearance },
		} as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: session as unknown as InteractiveModeContext["session"],
		viewSession: session as unknown as InteractiveModeContext["viewSession"],
		keybindings: {
			getKeys(action: string) {
				return keyMap[action] ? [...keyMap[action]] : [];
			},
			matches(data: string, action: string) {
				return keyMap[action]?.some(key => matchesKey(data, key)) ?? false;
			},
		} as InteractiveModeContext["keybindings"],
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		recordLocalSubmission(this: InteractiveModeContext, text: string, imageCount = 0) {
			if (this.isKnownSlashCommand(text)) return () => {};
			const sig = `${text}\u0000${imageCount}`;
			this.locallySubmittedUserSignatures.add(sig);
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				this.locallySubmittedUserSignatures.delete(sig);
			};
		},
		async withLocalSubmission<T>(
			this: InteractiveModeContext,
			text: string,
			fn: () => Promise<T>,
			options?: { imageCount?: number },
		): Promise<T> {
			const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
			try {
				return await fn();
			} catch (err) {
				dispose();
				throw err;
			}
		},
		updatePendingMessagesDisplay,
		sessionManager: { flushSync },
		clearEditor,
		lastSigintTime: 0,
		isBashMode: false,
		isPythonMode: false,
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleClearCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleSTTToggle: vi.fn(),
		showDebugSelector: vi.fn(),
		showHistorySearch: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(),
		showModelSelector,
		updateEditorBorderColor: vi.fn(),
		hasActiveBtw: vi.fn(() => false),
		hasActiveOmfg,
		handleBtwBranchKey,
		canBranchBtw,
		canCopyBtw,
		handleBtwCopyKey,
		get isConsultComposerActive() {
			return consultComposerActive;
		},
		hasActiveConsult,
		returnConsultToParent,
		startNewConsultation,
		showPreviousConsultTurn,
		showNextConsultTurn,
		scrollConsultAnswer,
		scrollConsultAnswerPage,
		scrollConsultAnswerToStart,
		scrollConsultAnswerToEnd,
		getConsultTurnPresentation,
		canCopyConsult,
		handleConsultCopyKey,
		showConsultActionMenu,
		canAskMainAboutConsultationAnswer,
		askMainAboutConsultationAnswer,
		handleConsultSubmit,
		showWarning,
		showError,
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		InputController,
		ctx,
		editor,
		customHandlers,
		getFocused() {
			return focused;
		},
		setFocused(target: unknown) {
			focused = target;
		},
		setConsultComposerActive(value: boolean) {
			consultComposerActive = value;
		},
		spies: {
			setActionKeys,
			showModelSelector,
			prompt,
			updatePendingMessagesDisplay,
			requestRender,
			retry,
			abort,
			resetDisplay,
			refreshAppearance,
			handleBtwBranchKey,
			addInputListener,
			canBranchBtw,
			handleBtwCopyKey,
			canCopyBtw,
			showError,
			hasActiveConsult,
			returnConsultToParent,
			startNewConsultation,
			showPreviousConsultTurn,
			showNextConsultTurn,
			scrollConsultAnswer,
			scrollConsultAnswerPage,
			handleConsultSubmit,
			scrollConsultAnswerToStart,
			scrollConsultAnswerToEnd,
			showWarning,
			getConsultTurnPresentation,
			canCopyConsult,
			handleConsultCopyKey,
			showConsultActionMenu,
			canAskMainAboutConsultationAnswer,
			askMainAboutConsultationAnswer,
			flushSync,
			clearEditor,
		},
	};
}

describe("InputController keybinding setup", () => {
	it("registers model selector and display reset actions separately", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(spies.setActionKeys).toHaveBeenCalledWith("app.display.reset", ["ctrl+l"]);
		expect(spies.setActionKeys).toHaveBeenCalledWith("app.model.selectTemporary", ["ctrl+y"]);
		expect(spies.setActionKeys).toHaveBeenCalledWith("app.model.select", ["alt+m"]);
		expect(editor.onDisplayReset).toBeDefined();
		expect(editor.onSelectModelTemporary).toBeDefined();
		expect(editor.onSelectModel).toBeDefined();
		expect(editor.onSelectModelTemporary).not.toBe(editor.onSelectModel);

		editor.onDisplayReset?.();
		editor.onSelectModelTemporary?.();
		editor.onSelectModel?.();

		expect(spies.showModelSelector).toHaveBeenNthCalledWith(1, { temporaryOnly: true });
		expect(spies.showModelSelector).toHaveBeenNthCalledWith(2);
		expect(spies.resetDisplay).toHaveBeenCalledTimes(1);
		expect(spies.refreshAppearance).toHaveBeenCalledTimes(1);
		// The background re-query must run before the repaint so the appearance
		// callback re-evaluates the auto theme against the fresh classification.
		expect(spies.refreshAppearance.mock.invocationCallOrder[0]!).toBeLessThan(
			spies.resetDisplay.mock.invocationCallOrder[0]!,
		);
	});

	it("does not mark pasted shell prompts as Python mode while editing", async () => {
		const { InputController, ctx, editor } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		editor.onChange?.("$ cd ~/project && sudo ./build-and-push.sh o5.7 2>&1 | tail -4");

		expect(ctx.isPythonMode).toBe(false);
		expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();

		editor.onChange?.("$ print(1)");

		expect(ctx.isPythonMode).toBe(true);
		expect(ctx.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	it("registers retry as an editor action and retries the failed turn", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(spies.setActionKeys).toHaveBeenCalledWith("app.retry", ["alt+r"]);
		expect(editor.onRetry).toBeDefined();

		editor.setText("draft that should clear after retry");
		editor.onRetry?.();
		await Promise.resolve();

		expect(spies.retry).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("retries the focused view session instead of the main session", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const focusedRetry = vi.fn(async () => true);
		(ctx as unknown as { focusedAgentId: string; viewSession: { retry: typeof focusedRetry } }).focusedAgentId =
			"worker";
		(ctx as unknown as { viewSession: { retry: typeof focusedRetry } }).viewSession = { retry: focusedRetry };
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onRetry?.();
		await Promise.resolve();

		expect(focusedRetry).toHaveBeenCalledTimes(1);
		expect(spies.retry).not.toHaveBeenCalled();
	});

	it("keeps retry host-only for collab guests", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const showStatus = ctx.showStatus as unknown as Mock<(message: string) => void>;
		(ctx as unknown as { collabGuest: { readOnly: boolean } }).collabGuest = { readOnly: true };
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("guest draft");
		editor.onRetry?.();
		await Promise.resolve();

		expect(spies.retry).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("/retry is host-only during a collab session");
		expect(editor.getText()).toBe("guest draft");
	});

	it("keeps the draft when there is nothing to retry", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		spies.retry.mockResolvedValueOnce(false);
		const showStatus = ctx.showStatus as unknown as Mock<(message: string) => void>;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft that should survive");
		editor.onRetry?.();
		await Promise.resolve();

		expect(showStatus).toHaveBeenCalledWith("Nothing to retry");
		expect(editor.getText()).toBe("draft that should survive");
	});

	it("clears retry draft attachments only after retry starts", async () => {
		const { InputController, ctx, editor } = await createContext();
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "abc" };
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		ctx.editor.pendingImages = [image];
		ctx.editor.pendingImageLinks = ["local://draft.png"];
		editor.imageLinks = ctx.editor.pendingImageLinks;
		editor.setText("draft with image");
		editor.onRetry?.();
		await Promise.resolve();

		expect(ctx.editor.pendingImages).toEqual([]);
		expect(ctx.editor.pendingImageLinks).toEqual([]);
		expect(editor.imageLinks).toBeUndefined();
		expect(editor.getText()).toBe("");
	});

	it("routes b to branch a branchable /btw panel", async () => {
		const { InputController, ctx, spies } = await createContext();
		(ctx.canBranchBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const listener = spies.addInputListener.mock.calls[1]?.[0];
		expect(listener).toBeDefined();
		const result = listener?.("b");

		expect(result).toEqual({ consume: true });
		expect(spies.handleBtwBranchKey).toHaveBeenCalledTimes(1);
	});

	it("lets b fall through while the editor has draft text", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		(ctx.canBranchBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		editor.setText("build a branch");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const listener = spies.addInputListener.mock.calls[1]?.[0];
		expect(listener).toBeDefined();
		const result = listener?.("b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("lets b fall through when /btw is not branchable", async () => {
		const { InputController, ctx, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const listener = spies.addInputListener.mock.calls[1]?.[0];
		expect(listener).toBeDefined();
		const result = listener?.("b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("lets b fall through while another input is focused", async () => {
		const { InputController, ctx, setFocused, spies } = await createContext();
		(ctx.canBranchBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		setFocused({ pasteText: vi.fn() });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("routes the smart-paste shortcut to a focused login input", async () => {
		const { promise: pasted, resolve: resolvePaste } = Promise.withResolvers<string>();
		const focusedPasteText = vi.fn((text: string) => {
			resolvePaste(text);
		});
		const { InputController, ctx, setFocused, spies } = await createContext();
		setFocused({ pasteText: focusedPasteText });
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "sk-test-key",
		});

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "\x16");

		expect(result).toEqual({ consume: true });
		expect(await pasted).toBe("sk-test-key");
		expect(focusedPasteText).toHaveBeenCalledWith("sk-test-key");
	});

	it("rejects image smart-paste while a login input is focused instead of mutating the hidden editor", async () => {
		const focusedPasteText = vi.fn();
		const { InputController, ctx, editor, setFocused, spies } = await createContext();
		setFocused({ pasteText: focusedPasteText });
		const { promise: rejected, resolve: resolveRejected } = Promise.withResolvers<string>();
		(ctx.showStatus as unknown as Mock<(message: string) => void>).mockImplementation(message => {
			resolveRejected(message);
		});
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: new Uint8Array([0x89, 0x50]), mimeType: "image/png" }),
			readText: async () => "sk-test-key",
		});

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "\x16");

		expect(result).toEqual({ consume: true });
		expect(await rejected).toBe("Image paste is not supported in this prompt");
		expect(focusedPasteText).not.toHaveBeenCalled();
		expect(editor.pendingImages).toHaveLength(0);
		expect(editor.getText()).toBe("");
	});

	it("routes c to copy a copyable /btw panel when the editor is empty", async () => {
		const { InputController, ctx, spies } = await createContext();
		(ctx.canCopyBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toEqual({ consume: true });
		expect(spies.handleBtwCopyKey).toHaveBeenCalledTimes(1);
	});

	it("lets c fall through while the editor has draft text", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		(ctx.canCopyBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		editor.setText("continue this draft");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toBeUndefined();
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("lets c fall through when /btw is not copyable", async () => {
		const { InputController, ctx, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toBeUndefined();
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("lets c fall through while another input is focused", async () => {
		const { InputController, ctx, setFocused, spies } = await createContext();
		(ctx.canCopyBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		setFocused({ pasteText: vi.fn() });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toBeUndefined();
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("empty Enter aborts the active stream when queued messages are pending", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean; queuedMessageCount: number };
		session.isStreaming = true;
		session.queuedMessageCount = 1;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("");

		expect(spies.abort).toHaveBeenCalledWith({ reason: "Interrupted by user" });
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(spies.requestRender).toHaveBeenCalledTimes(1);
		expect(spies.prompt).not.toHaveBeenCalled();
	});

	it("marks streaming follow-up submissions as local", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		editor.setText("follow up after current response");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(ctx.locallySubmittedUserSignatures.has("follow up after current response\u00000")).toBe(true);
		expect(spies.prompt).toHaveBeenCalledWith("follow up after current response", {
			streamingBehavior: "followUp",
		});
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("marks idle follow-up submissions as local", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		// Default fake session is idle.
		editor.setText("plain idle submit");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(ctx.locallySubmittedUserSignatures.has("plain idle submit\u00000")).toBe(true);
		// Idle submit calls prompt() with no streamingBehavior (images forwarded, undefined here).
		expect(spies.prompt).toHaveBeenCalledWith("plain idle submit", { images: undefined });
	});

	it("surfaces and recovers from an idle follow-up dispatch failure", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		editor.setText("doomed submit");
		const controller = new InputController(ctx);

		// Dispatch failures are caught and surfaced (mirroring the main/focused
		// submit paths), not rethrown, so the keybinding's fire-and-forget call
		// never raises an unhandled rejection.
		await controller.handleFollowUp();

		expect(spies.showError).toHaveBeenCalledWith("boom");
		// Draft handed back so the user can retry.
		expect(editor.getText()).toBe("doomed submit");
		// Contract: a failed delivery must not leave a stale signature behind,
		// otherwise the next attempt with the same text would silently suppress
		// the editor-clear protection that was meant for the failed call.
		expect(ctx.locallySubmittedUserSignatures.has("doomed submit\u00000")).toBe(false);
	});

	it("surfaces and recovers from a streaming follow-up dispatch failure", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("queue full");
		});
		editor.setText("queued during stream");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(spies.showError).toHaveBeenCalledWith("queue full");
		expect(editor.getText()).toBe("queued during stream");
		expect(ctx.locallySubmittedUserSignatures.has("queued during stream\u00000")).toBe(false);
	});

	it("keeps clear and consultation as distinct configured editor actions", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(spies.setActionKeys).toHaveBeenCalledWith("app.clear", ["ctrl+c"]);
		expect(spies.setActionKeys).toHaveBeenCalledWith("app.consult", ["alt+shift+q"]);
		expect(editor.onClear).toBeDefined();
		expect(editor.onConsult).toBeDefined();

		editor.onClear?.();

		expect(spies.startNewConsultation).not.toHaveBeenCalled();

		editor.onConsult?.();

		expect(spies.startNewConsultation).toHaveBeenCalledTimes(1);
	});

	it("returns consultation editor ownership to the parent on Esc before interrupting its stream", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		spies.hasActiveConsult.mockReturnValue(true);
		spies.returnConsultToParent.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.returnConsultToParent).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("keeps consultation focus in the editor and reserves its explicit Alt turn navigation", async () => {
		const { InputController, ctx, editor, getFocused, setConsultComposerActive, spies } = await createContext();
		setConsultComposerActive(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(dispatchInput(registeredInputListeners(spies.addInputListener), "\x1b[1;3A")).toEqual({ consume: true });
		expect(dispatchInput(registeredInputListeners(spies.addInputListener), "\x1b[1;3B")).toEqual({ consume: true });
		expect(spies.showPreviousConsultTurn).toHaveBeenCalledTimes(1);
		expect(spies.showNextConsultTurn).toHaveBeenCalledTimes(1);

		// These printable keys remain available for a consultation question rather
		// than becoming panel navigation aliases.
		expect(dispatchInput(registeredInputListeners(spies.addInputListener), "[")).toBeUndefined();
		expect(dispatchInput(registeredInputListeners(spies.addInputListener), "]")).toBeUndefined();
		expect(getFocused()).toBe(editor);
	});

	it("disables parent model, retry, dequeue, and external-editor actions while composing a consultation", async () => {
		const { InputController, ctx, editor, setConsultComposerActive, spies } = await createContext();
		setConsultComposerActive(true);
		const controller = new InputController(ctx);
		const dequeue = vi.spyOn(controller, "handleDequeue");

		controller.setupKeyHandlers();
		editor.setText("consultation draft");
		editor.onSelectModel?.();
		editor.onSelectModelTemporary?.();
		editor.onRetry?.();
		// This represents a user-configured non-navigation dequeue chord. It
		// bypasses the consultation panel's Alt+Up listener and must still not
		// restore the parent queue or its images into this draft.
		editor.onDequeue?.();
		editor.onExternalEditor?.();
		await Promise.resolve();

		expect(spies.setActionKeys).toHaveBeenCalledWith("app.message.dequeue", ["alt+shift+d"]);
		expect(spies.showModelSelector).not.toHaveBeenCalled();
		expect(spies.retry).not.toHaveBeenCalled();
		expect(dequeue).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("consultation draft");
	});

	it("routes wheel, Alt page navigation, and Alt Home/End to the bounded answer viewport; Alt+End clears detached new-output state through its context action", async () => {
		const { InputController, ctx, setConsultComposerActive, spies } = await createContext();
		setConsultComposerActive(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(spies.addInputListener);
		expect(dispatchInput(listeners, "\x1b[<64;40;8M")).toEqual({ consume: true });
		expect(dispatchInput(listeners, "\x1b[<65;40;8M")).toEqual({ consume: true });
		expect(spies.scrollConsultAnswer).toHaveBeenNthCalledWith(1, -3);
		expect(spies.scrollConsultAnswer).toHaveBeenNthCalledWith(2, 3);

		expect(dispatchInput(listeners, "\x1b[5;3~")).toEqual({ consume: true });
		expect(dispatchInput(listeners, "\x1b[6;3~")).toEqual({ consume: true });
		expect(spies.scrollConsultAnswerPage).toHaveBeenNthCalledWith(1, -1);
		expect(spies.scrollConsultAnswerPage).toHaveBeenNthCalledWith(2, 1);

		expect(dispatchInput(listeners, "\x1b[1;3H")).toEqual({ consume: true });
		expect(spies.scrollConsultAnswerToStart).toHaveBeenCalledTimes(1);
		expect(dispatchInput(listeners, "\x1b[1;3F")).toEqual({ consume: true });
		expect(spies.scrollConsultAnswerToEnd).toHaveBeenCalledTimes(1);
	});

	it("uses the eligible visible consultation answer in the parent only with Alt+Enter", async () => {
		const { InputController, ctx, editor, setConsultComposerActive, spies } = await createContext();
		setConsultComposerActive(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(spies.addInputListener);
		expect(dispatchInput(listeners, "\x1b[13;3u")).toBeUndefined();
		expect(spies.askMainAboutConsultationAnswer).not.toHaveBeenCalled();

		spies.canAskMainAboutConsultationAnswer.mockReturnValue(true);
		editor.setText("follow-up draft");
		expect(dispatchInput(listeners, "\x1b[13;3u")).toBeUndefined();
		expect(spies.askMainAboutConsultationAnswer).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("follow-up draft");
		editor.setText("");
		expect(dispatchInput(listeners, "\x1b[13;3u")).toEqual({ consume: true });
		expect(spies.askMainAboutConsultationAnswer).toHaveBeenCalledTimes(1);
	});

	it("opens the consultation action menu with ? or Alt+/", async () => {
		const { InputController, ctx, editor, setConsultComposerActive, spies } = await createContext();
		setConsultComposerActive(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(spies.addInputListener);
		expect(dispatchInput(listeners, "?")).toEqual({ consume: true });
		expect(dispatchInput(listeners, "\x1b/")).toEqual({ consume: true });
		expect(spies.showConsultActionMenu).toHaveBeenCalledTimes(2);

		editor.setText("follow-up question");
		expect(dispatchInput(listeners, "?")).toBeUndefined();
		expect(spies.showConsultActionMenu).toHaveBeenCalledTimes(2);
	});

	it("routes Enter to the consultation thread and warns when an older turn is visible", async () => {
		const { InputController, ctx, editor, getFocused, setConsultComposerActive, spies } = await createContext();
		setConsultComposerActive(true);
		spies.getConsultTurnPresentation.mockReturnValue({
			consultationId: "consult-1",
			title: "Initial implementation review",
			turnIndex: 1,
			turnCount: 2,
			isLatest: false,
			status: "completed",
		});
		const controller = new InputController(ctx);

		expect(getFocused()).toBe(editor);
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("follow the latest answer");

		expect(spies.handleConsultSubmit).toHaveBeenCalledWith("follow the latest answer");
		expect(getFocused()).toBe(editor);
		expect(spies.showWarning).toHaveBeenCalledWith(
			"Viewing old consultation turn 1; your question will be appended to latest turn 2.",
		);
		expect(spies.prompt).not.toHaveBeenCalled();
	});

	it("clears rejected images from the consultation composer", async () => {
		const { InputController, ctx, editor, setConsultComposerActive, spies } = await createContext();
		setConsultComposerActive(true);
		const image = { type: "image", data: "base64-data", mimeType: "image/png" } as const;
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["local://draft.png"];
		editor.imageLinks = editor.pendingImageLinks;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("retry without image");

		expect(editor.getText()).toBe("retry without image");
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);
		expect(editor.imageLinks).toBeUndefined();
		expect(spies.handleConsultSubmit).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("Images are not supported in /consult.");
	});

	it("continue shortcuts submit a hidden synthetic developer directive", async () => {
		for (const shortcut of [".", "c"]) {
			const { InputController, ctx, editor } = await createContext();
			const onInput = vi.fn();
			ctx.onInputCallback = onInput;
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.(shortcut);

			expect(onInput, `shortcut ${shortcut}`).toHaveBeenCalledWith({
				text: manualContinuePrompt,
				cancelled: false,
				started: true,
				synthetic: true,
				userInitiated: true,
			});
		}
	});
});
