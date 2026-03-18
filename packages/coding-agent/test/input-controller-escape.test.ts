import { describe, expect, it, mock, vi } from "bun:test";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";

const themeModulePath = new URL("../src/modes/theme/theme.ts", import.meta.url).pathname;

mock.module(themeModulePath, () => ({
	getEditorTheme: () => ({ borderColor: (text: string) => text }),
	getMarkdownTheme: () => ({}),
	getSymbolTheme: () => ({}),
	highlightCode: (text: string) => text,
	getLanguageFromPath: () => undefined,
	isLightTheme: () => false,
	setAutoThemeMapping: () => Promise.resolve(),
	setColorBlindMode: () => Promise.resolve(),
	setSymbolPreset: () => Promise.resolve(),
	onTerminalAppearanceChange: () => {},
	onThemeChange: () => {},
	theme: {
		fg: (_tone: string, text: string) => text,
	},
}));

mock.module("@oh-my-pi/pi-natives", () => ({
	copyToClipboard: vi.fn(),
	readImageFromClipboard: vi.fn(),
	sanitizeText: (text: string) => text,
	fuzzyFind: vi.fn(async () => ({ matches: [] })),
	glob: vi.fn(async () => []),
	FileType: { File: "file", Directory: "directory", Symlink: "symlink" },
	ImageFormat: { Png: "png", Jpeg: "jpeg" },
	SamplingFilter: { Lanczos3: "Lanczos3" },
	PhotonImage: class PhotonImage {},
	Shell: class Shell {},
	PtySession: class PtySession {},
	matchesKey: (data: string, keyId: string) => {
		if (keyId === "escape" || keyId === "esc") return data === "\x1b";
		const match = keyId.match(/^ctrl\+([a-z])$/i);
		if (!match) return false;
		return data === String.fromCharCode(match[1]!.toLowerCase().charCodeAt(0) & 0x1f);
	},
	parseKey: vi.fn(() => undefined),
	parseKittySequence: vi.fn(() => null),
	encodeSixel: vi.fn(),
	sliceWithWidth: (text: string) => text,
	Ellipsis: { Omit: "omit" },
	extractSegments: vi.fn(() => []),
	truncateToWidth: (text: string) => text,
	wrapTextWithAnsi: (text: string) => [text],
	executeShell: vi.fn(),
	getWorkProfile: vi.fn(),
	highlightCode: vi.fn((code: string) => code),
	supportsLanguage: vi.fn(() => false),
	projfsOverlayProbe: vi.fn(),
	projfsOverlayStart: vi.fn(),
	projfsOverlayStop: vi.fn(),
	astEdit: vi.fn(),
	astGrep: vi.fn(),
	grep: vi.fn(),
	htmlToMarkdown: vi.fn(),
	invalidateFsScanCache: vi.fn(),
}));

const { InputController } = await import("@oh-my-pi/pi-coding-agent/modes/controllers/input-controller");

type FakeEditor = {
	onEscape?: () => void;
	onSubmit?: (text: string) => Promise<void>;
	shouldBypassAutocompleteOnEscape?: () => boolean;
	onCtrlC?: () => void;
	onCtrlD?: () => void;
	onCtrlZ?: () => void;
	onShiftTab?: () => void;
	onCtrlP?: () => void;
	onShiftCtrlP?: () => void;
	onAltP?: () => void;
	onCtrlL?: () => void;
	onCtrlR?: () => void;
	onQuestionMark?: () => void;
	onCtrlV?: () => void;
	onCopyPrompt?: () => void;
	onAltUp?: () => void;
	onChange?: (text: string) => void;
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setAppActionHandler(action: string, keys: string[], handler: (() => void) | undefined): void;
	clearAppActionHandlers(): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
};

function createSubmission(input: {
	text: string;
	images?: InteractiveModeContext["pendingImages"];
}): SubmittedUserInput {
	return {
		text: input.text,
		images: input.images,
		cancelled: false,
		started: false,
	};
}

function createContext(): {
	ctx: InteractiveModeContext;
	editor: FakeEditor;
	spies: {
		abort: ReturnType<typeof vi.fn>;
		abortBash: ReturnType<typeof vi.fn>;
		abortPython: ReturnType<typeof vi.fn>;
		addMessageToChat: ReturnType<typeof vi.fn>;
		cancelPendingSubmission: ReturnType<typeof vi.fn>;
		clearAppActionHandlers: ReturnType<typeof vi.fn>;
		clearCustomKeyHandlers: ReturnType<typeof vi.fn>;
		clearQueue: ReturnType<typeof vi.fn>;
		ensureLoadingAnimation: ReturnType<typeof vi.fn>;
		handleBtwCommand: ReturnType<typeof vi.fn>;
		handleBtwEscape: ReturnType<typeof vi.fn>;
		hasActiveBtw: ReturnType<typeof vi.fn>;
		onInputCallback: ReturnType<typeof vi.fn>;
		prompt: ReturnType<typeof vi.fn>;
		requestRender: ReturnType<typeof vi.fn>;
		setAppActionHandler: ReturnType<typeof vi.fn>;
		startPendingSubmission: ReturnType<typeof vi.fn>;
	};
} {
	let editorText = "";
	const abort = vi.fn();
	const abortBash = vi.fn();
	const abortPython = vi.fn();
	const addMessageToChat = vi.fn();
	const cancelPendingSubmission = vi.fn(() => false);
	const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
	const onInputCallback = vi.fn();
	const prompt = vi.fn();
	const requestRender = vi.fn();
	const handleBtwCommand = vi.fn(async () => {});
	const handleBtwEscape = vi.fn(() => true);
	const hasActiveBtw = vi.fn(() => false);
	const startPendingSubmission = vi.fn((input: { text: string; images?: InteractiveModeContext["pendingImages"] }) => {
		ensureLoadingAnimation();
		return createSubmission(input);
	});
	const clearAppActionHandlers = vi.fn();
	const clearCustomKeyHandlers = vi.fn();
	const setAppActionHandler = vi.fn();
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		setAppActionHandler,
		clearAppActionHandlers,
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers,
	};

	let ctx!: InteractiveModeContext;
	const ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
	});

	ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: {
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isBashRunning: false,
			isPythonRunning: false,
			queuedMessageCount: 0,
			messages: [],
			extensionRunner: undefined,
			abort,
			abortBash,
			abortPython,
			clearQueue,
			prompt,
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			getSessionName: () => "existing session",
		} as unknown as InteractiveModeContext["sessionManager"],
		keybindings: {
			getKeys: (action: string) => (action === "interrupt" ? ["escape"] : []),
		} as unknown as InteractiveModeContext["keybindings"],
		pendingImages: [],
		isBashMode: false,
		isPythonMode: false,
		optimisticUserMessageSignature: undefined,
		onInputCallback,
		addMessageToChat,
		cancelPendingSubmission,
		ensureLoadingAnimation,
		finishPendingSubmission: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		markPendingSubmissionStarted: vi.fn(() => true),
		startPendingSubmission,
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showDebugSelector: vi.fn(),
		toggleTodoExpansion: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		handleSTTToggle: vi.fn(),
		handleBtwEscape,
		handleBtwCommand,
		hasActiveBtw,
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		spies: {
			abort,
			abortBash,
			abortPython,
			addMessageToChat,
			cancelPendingSubmission,
			clearAppActionHandlers,
			clearCustomKeyHandlers,
			clearQueue,
			ensureLoadingAnimation,
			handleBtwCommand,
			handleBtwEscape,
			hasActiveBtw,
			onInputCallback,
			prompt,
			requestRender,
			setAppActionHandler,
			startPendingSubmission,
		},
	};
}

describe("InputController escape behavior", () => {
	it("registers escape as the interrupt app action through the editor app-action API", () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(spies.clearAppActionHandlers).toHaveBeenCalledTimes(1);
		expect(spies.clearCustomKeyHandlers).toHaveBeenCalledTimes(1);
		expect(spies.setAppActionHandler).toHaveBeenCalledWith("interrupt", ["escape"], expect.any(Function));
	});

	it("prefers canceling a pending optimistic submission before aborting the session", async () => {
		const { ctx, editor, spies } = createContext();
		const submission = createSubmission({ text: "hello" });
		spies.startPendingSubmission.mockReturnValue(submission);
		spies.cancelPendingSubmission.mockReturnValue(true);
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("hello");

		expect(spies.startPendingSubmission).toHaveBeenCalledWith({ text: "hello", images: undefined });
		expect(spies.onInputCallback).toHaveBeenCalledWith(submission);
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);

		editor.onEscape?.();
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("runs /btw as a builtin side request instead of steering the active stream", async () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/btw why is it doing that?");
		await editor.onSubmit?.("/btw why is it doing that?");

		expect(spies.handleBtwCommand).toHaveBeenCalledWith("why is it doing that?");
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(editor.addToHistory).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("falls back to aborting the active session when no pending optimistic submission exists", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
	});

	it("prefers aborting bash before aborting an overlapping stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; isBashRunning: boolean }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; isBashRunning: boolean }).isBashRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortBash).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("prefers aborting python before aborting an overlapping stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; isPythonRunning: boolean }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; isPythonRunning: boolean }).isPythonRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortPython).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting the main stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before canceling a pending optimistic submission", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting bash", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isBashRunning: boolean }).isBashRunning = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abortBash).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("aborts streaming even when the working loader is no longer present", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).toHaveBeenCalledTimes(1);
	});
});
