import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

type MockEditorAction = "cursorLineStart" | "cursorLineEnd" | "undo";
type MockEditorKeybindingsConfig = Partial<Record<MockEditorAction, string | string[]>>;
type PromptActionOptions = {
	commands: [];
	basePath: string;
	keybindings: unknown;
	copyCurrentLine: () => void;
	copyPrompt: () => void;
	undo: (prefix: string) => void;
	moveCursorToMessageEnd: () => void;
	moveCursorToMessageStart: () => void;
	moveCursorToLineStart: () => void;
	moveCursorToLineEnd: () => void;
};
type PromptActionSuggestion = {
	value: string;
	label: string;
	description?: string;
};
type PromptActionProvider = {
	getSuggestions: (
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	) => Promise<{ items: PromptActionSuggestion[]; prefix: string } | null>;
	applyCompletion: (
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: PromptActionSuggestion,
		prefix: string,
	) => {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	};
};
type KeybindingsManagerLike = {
	inMemory: (config?: Record<string, string | string[]>) => unknown;
};

function toKeyList(value: string | readonly string[]): string[] {
	return typeof value === "string" ? [value] : [...value];
}

const DEFAULT_EDITOR_KEYBINDINGS = {
	cursorLineStart: ["home", "ctrl+a"],
	cursorLineEnd: ["end", "ctrl+e"],
	undo: "ctrl+-",
} as const satisfies Record<MockEditorAction, string | readonly string[]>;

class EditorKeybindingsManager {
	#config: Record<MockEditorAction, string[]>;

	constructor(config: MockEditorKeybindingsConfig = {}) {
		this.#config = {
			cursorLineStart: toKeyList(config.cursorLineStart ?? DEFAULT_EDITOR_KEYBINDINGS.cursorLineStart),
			cursorLineEnd: toKeyList(config.cursorLineEnd ?? DEFAULT_EDITOR_KEYBINDINGS.cursorLineEnd),
			undo: toKeyList(config.undo ?? DEFAULT_EDITOR_KEYBINDINGS.undo),
		};
	}

	getKeys(action: MockEditorAction): string[] {
		return [...this.#config[action]];
	}
}

let editorKeybindings = new EditorKeybindingsManager();
let KeybindingsManager: KeybindingsManagerLike;
let createPromptActionAutocompleteProvider: (options: PromptActionOptions) => PromptActionProvider;

function getEditorKeybindings(): EditorKeybindingsManager {
	return editorKeybindings;
}

function setEditorKeybindings(manager: EditorKeybindingsManager): void {
	editorKeybindings = manager;
}

function matchesKey(data: string, key: string): boolean {
	return data === key;
}

mock.module("@oh-my-pi/pi-tui", () => ({
	CombinedAutocompleteProvider: class {
		async getSuggestions(): Promise<null> {
			return null;
		}

		applyCompletion(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
		): { lines: string[]; cursorLine: number; cursorCol: number } {
			return { lines, cursorLine, cursorCol };
		}

		getInlineHint(): null {
			return null;
		}
	},
	DEFAULT_EDITOR_KEYBINDINGS,
	EditorKeybindingsManager,
	getEditorKeybindings,
	matchesKey,
	setEditorKeybindings,
}));

mock.module("@oh-my-pi/pi-utils", () => ({
	getAgentDir: () => "/tmp",
	isEnoent: () => false,
	logger: { warn: () => {} },
}));

beforeAll(async () => {
	KeybindingsManager = (await import("../src/config/keybindings"))
		.KeybindingsManager as unknown as KeybindingsManagerLike;
	createPromptActionAutocompleteProvider = (await import("../src/modes/prompt-action-autocomplete"))
		.createPromptActionAutocompleteProvider as unknown as (options: PromptActionOptions) => PromptActionProvider;
});

describe("prompt action autocomplete", () => {
	beforeEach(() => {
		setEditorKeybindings(
			new EditorKeybindingsManager({
				cursorLineStart: ["home", "f6"],
				cursorLineEnd: "f7",
				undo: "f8",
			}),
		);
	});

	afterEach(() => {
		setEditorKeybindings(new EditorKeybindingsManager());
	});

	it("shows prompt actions with configured shortcut hints", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: KeybindingsManager.inMemory({
				copyLine: "ctrl+shift+l",
				copyPrompt: ["alt+shift+c", "ctrl+shift+c"],
			}),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["#"], 0, 1);
		expect(suggestions).not.toBeNull();
		expect(suggestions?.prefix).toBe("#");
		expect(suggestions?.items.map(item => item.label)).toEqual([
			"Copy current line",
			"Copy whole prompt",
			"Undo",
			"Move cursor to end of message",
			"Move cursor to beginning of message",
			"Move cursor to beginning of line",
			"Move cursor to end of line",
		]);
		expect(suggestions?.items.find(item => item.label === "Copy current line")?.description).toBe("Ctrl+Shift+L");
		expect(suggestions?.items.find(item => item.label === "Copy whole prompt")?.description).toBe(
			"Alt+Shift+C/Ctrl+Shift+C",
		);
		expect(suggestions?.items.find(item => item.label === "Move cursor to beginning of line")?.description).toBe(
			"Home/F6",
		);
		expect(suggestions?.items.find(item => item.label === "Move cursor to end of line")?.description).toBe("F7");
		expect(suggestions?.items.find(item => item.label === "Undo")?.description).toBe("F8");
	});

	it("passes the typed trigger to undo and leaves text removal to the editor", async () => {
		let undoCalls = 0;
		let undoPrefix = "";
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: KeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: prefix => {
				undoCalls += 1;
				undoPrefix = prefix;
			},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["hello #undo"], 0, 11);
		const item = suggestions?.items.find(entry => entry.label === "Undo");
		expect(item).toBeDefined();
		if (!item || !suggestions) {
			throw new Error("expected undo suggestion");
		}

		const result = provider.applyCompletion(["hello #undo"], 0, 11, item, suggestions.prefix);
		expect(result.lines).toEqual(["hello #undo"]);
		expect(result.cursorLine).toBe(0);
		expect(result.cursorCol).toBe(11);
		result.onApplied?.();
		expect(undoCalls).toBe(1);
		expect(undoPrefix).toBe("#undo");
	});

	it("falls back to normal typing for literal hashtags with no matching action", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: KeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["release #v1"], 0, 11);
		expect(suggestions).toBeNull();
	});
});
