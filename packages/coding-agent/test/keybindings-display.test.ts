import { describe, expect, it, mock, vi } from "bun:test";

mock.module("@oh-my-pi/pi-natives", () => ({
	fuzzyFind: vi.fn(async () => ({ matches: [] })),
	glob: vi.fn(async () => []),
	FileType: { File: "file", Directory: "directory", Symlink: "symlink" },
	ImageFormat: { Png: "png", Jpeg: "jpeg" },
	SamplingFilter: { Lanczos3: "Lanczos3" },
	PhotonImage: class PhotonImage {},
	Shell: class Shell {},
	PtySession: class PtySession {},
	matchesKey: vi.fn(() => false),
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
	copyToClipboard: vi.fn(),
	readImageFromClipboard: vi.fn(),
	sanitizeText: (text: string) => text,
}));

const { KeybindingsManager } = await import("../src/config/keybindings");

describe("KeybindingsManager.getDisplayString", () => {
	it("formats a single binding as a human-readable key hint", () => {
		const keybindings = KeybindingsManager.inMemory({
			dequeue: "alt+up",
		});

		expect(keybindings.getDisplayString("dequeue")).toBe("Alt+Up");
	});

	it("formats multiple bindings with the existing separator", () => {
		const keybindings = KeybindingsManager.inMemory({
			copyPrompt: ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("copyPrompt")).toBe("Alt+Shift+C/Ctrl+Shift+C");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			copyPrompt: [],
		});

		expect(keybindings.getDisplayString("copyPrompt")).toBe("");
	});

	it("reflects the truthful default app-action surface for todo and thinking toggles", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getDisplayString("toggleTodoExpansion")).toBe("Ctrl+T");
		expect(keybindings.getDisplayString("toggleThinking")).toBe("");
	});
});

describe("KeybindingsManager.getEffectiveConfig", () => {
	it("includes the effective todo/thinking toggle bindings without removed actions", () => {
		const keybindings = KeybindingsManager.inMemory();
		const effectiveConfig = keybindings.getEffectiveConfig() as Record<string, unknown>;

		expect(effectiveConfig.toggleTodoExpansion).toBe("ctrl+t");
		expect(effectiveConfig.toggleThinking).toEqual([]);
		expect(Object.hasOwn(effectiveConfig, "toggleSessionNamedFilter")).toBe(false);
	});
});
