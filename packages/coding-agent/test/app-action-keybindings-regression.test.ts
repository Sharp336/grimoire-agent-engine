import { afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";

const themeModulePath = new URL("../src/modes/theme/theme.ts", import.meta.url).pathname;

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 0x1f);
}

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

const { Container } = await import("@oh-my-pi/pi-tui");
const { _resetSettingsForTest, Settings } = await import("../src/config/settings");

import type { KeybindingsConfig } from "../src/config/keybindings";
import type { Settings as SettingsType } from "../src/config/settings";
import type { CustomEditor as CustomEditorType } from "../src/modes/components/custom-editor";
import type { InputController as InputControllerType } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";

const { KeybindingsManager } = await import("../src/config/keybindings");
const { CustomEditor } = await import("../src/modes/components/custom-editor");
const { InputController } = await import("../src/modes/controllers/input-controller");

type Shortcut = {
	extensionPath: string;
	handler: (ctx: unknown) => void;
};

function createHarness(
	runtimeSettings: SettingsType,
	config: KeybindingsConfig = {},
	shortcuts: Map<string, Shortcut> = new Map(),
): {
	controller: InputControllerType;
	ctx: InteractiveModeContext;
	editor: CustomEditorType;
	spies: {
		toggleTodoExpansion: ReturnType<typeof vi.fn>;
		rebuildChatFromMessages: ReturnType<typeof vi.fn>;
		showStatus: ReturnType<typeof vi.fn>;
	};
} {
	const editor = new CustomEditor({ borderColor: (text: string) => text } as never);
	const toggleTodoExpansion = vi.fn();
	const rebuildChatFromMessages = vi.fn();
	const showStatus = vi.fn();
	const extensionRunner = shortcuts.size
		? {
				getShortcuts: () => shortcuts,
				createCommandContext: () => ({ source: "test" }),
				emitError: vi.fn(),
			}
		: undefined;

	const ctx = {
		editor,
		ui: { requestRender: vi.fn(), start: vi.fn(), stop: vi.fn() },
		chatContainer: new Container(),
		session: {
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isBashRunning: false,
			isPythonRunning: false,
			queuedMessageCount: 0,
			messages: [],
			extensionRunner,
			abort: vi.fn(),
			abortBash: vi.fn(),
			abortPython: vi.fn(),
			clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
			prompt: vi.fn(),
		},
		sessionManager: { getSessionName: () => "existing session" },
		keybindings: KeybindingsManager.inMemory(config),
		settings: runtimeSettings,
		pendingImages: [],
		isBashMode: false,
		isPythonMode: false,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		optimisticUserMessageSignature: undefined,
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		streamingComponent: undefined,
		streamingMessage: undefined,
		lastSigintTime: 0,
		lastEscapeTime: 0,
		updateEditorBorderColor: vi.fn(),
		toggleTodoExpansion,
		rebuildChatFromMessages,
		showStatus,
		hasActiveBtw: vi.fn(() => false),
		handleBtwEscape: vi.fn(() => false),
		handleHotkeysCommand: vi.fn(),
		handleSTTToggle: vi.fn(),
		showDebugSelector: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		clearEditor: vi.fn(),
		shutdown: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext;

	return {
		controller: new InputController(ctx),
		ctx,
		editor,
		spies: {
			toggleTodoExpansion,
			rebuildChatFromMessages,
			showStatus,
		},
	};
}

describe("app action keybinding regressions", () => {
	let runtimeSettings: SettingsType;

	beforeEach(async () => {
		_resetSettingsForTest();
		runtimeSettings = await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		_resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("dispatches remapped external editor bindings and stops honoring ctrl+g", () => {
		const { controller, editor } = createHarness(runtimeSettings, { externalEditor: "ctrl+x" });
		const openExternalEditor = vi.fn(async (): Promise<void> => {});
		controller.openExternalEditor = openExternalEditor;

		controller.setupKeyHandlers();
		editor.handleInput(ctrl("x"));
		editor.handleInput(ctrl("g"));

		expect(openExternalEditor).toHaveBeenCalledTimes(1);
	});

	it("disables formerly hardcoded actions when they are explicitly unbound", () => {
		const { controller, editor } = createHarness(runtimeSettings, { externalEditor: [] });
		const openExternalEditor = vi.fn(async (): Promise<void> => {});
		controller.openExternalEditor = openExternalEditor;

		controller.setupKeyHandlers();
		editor.handleInput(ctrl("g"));

		expect(openExternalEditor).not.toHaveBeenCalled();
	});

	it("lets built-in app actions win over extension custom handlers on the same key", () => {
		const extensionShortcut = vi.fn();
		const { controller, editor } = createHarness(
			runtimeSettings,
			{},
			new Map([["ctrl+g", { extensionPath: "extensions/test-shortcut.ts", handler: extensionShortcut }]]),
		);
		const openExternalEditor = vi.fn(async (): Promise<void> => {});
		controller.openExternalEditor = openExternalEditor;

		controller.setupKeyHandlers();
		editor.handleInput(ctrl("g"));

		expect(openExternalEditor).toHaveBeenCalledTimes(1);
		expect(extensionShortcut).not.toHaveBeenCalled();
	});

	it("routes custom toggleThinking bindings while ctrl+t remains toggleTodoExpansion", () => {
		const { controller, ctx, editor, spies } = createHarness(runtimeSettings, { toggleThinking: "ctrl+y" });

		controller.setupKeyHandlers();
		editor.handleInput(ctrl("y"));
		editor.handleInput(ctrl("t"));

		expect(ctx.hideThinkingBlock).toBe(true);
		expect(spies.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(spies.showStatus).toHaveBeenCalledWith("Thinking blocks: hidden");
		expect(spies.toggleTodoExpansion).toHaveBeenCalledTimes(1);
	});
});
