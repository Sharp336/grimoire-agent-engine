import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Container, setKeybindings } from "@oh-my-pi/pi-tui";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import type { CollabGuestUiResult, CollabHost } from "../../../src/collab/host";
import { KeybindingsManager } from "../../../src/config/keybindings";
import type { ExtensionAskDialogQuestion, ExtensionUIContext } from "../../../src/extensibility/extensions";
import { AskDialogComponent } from "../../../src/modes/components/ask-dialog";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { getEditorTheme, getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme");
	setThemeInstance(dark);
});

function makeHarness(options: { collabHost?: Pick<CollabHost, "requestGuestUi"> } = {}) {
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const requestRender = vi.fn();
	const setFocus = vi.fn();
	const addAutocompleteProvider = vi.fn();
	let uiContext: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		ui: {
			requestRender,
			setFocus,
			terminal: { rows: 40 },
		},
		editorContainer,
		session: {
			extensionRunner: undefined,
			setUsageFallbackConfirmer: vi.fn(),
		},
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
		...(options.collabHost === undefined ? {} : { collabHost: options.collabHost }),
	} as unknown as InteractiveModeContext;

	const controller = new ExtensionUiController(ctx);

	return {
		editor,
		requestRender,
		addAutocompleteProvider,
		editorContainer,
		setFocus,
		controller,
		async init(): Promise<ExtensionUIContext> {
			await controller.initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("keeps a populated prompt visible and routes input to it until the draft is cleared", async () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		const pending = harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		ask?.handleInput?.("d");
		expect(harness.editor.getText()).toBe("finish this word");

		harness.editor.setText("");
		ask?.handleInput?.("\n");
		expect(await pending).toEqual({
			kind: "submit",
			results: [
				{
					id: "confirm",
					question: "Continue?",
					options: ["Yes", "No"],
					multi: false,
					selectedOptions: ["Yes"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("does not fire editor-slot shortcuts that would orphan the ask dialog (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("draft in progress");
		// Simulate an editor-slot shortcut like the Agent Hub binding, whose
		// handler clears editorContainer and would strand the pending ask.
		let hubOpened = false;
		harness.editor.setCustomKeyHandler("ctrl+s", () => {
			hubOpened = true;
			harness.editorContainer.clear();
		});
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+S reaches the draft editor while ask is open; the shortcut must be
		// swallowed, the draft untouched, and the ask surface preserved.
		ask?.handleInput?.("\x13");
		expect(hubOpened).toBe(false);
		expect(harness.editor.getText()).toBe("draft in progress");
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
	});

	it("exposes the draft editor cursor while it proxies input, and drops it once cleared (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// The ask dialog holds TUI focus, but rendering it must mirror focus onto
		// the draft editor so its insertion cursor is visible.
		ask?.render?.(80);
		expect(harness.editor.focused).toBe(true);

		// Once the draft clears, the ask controls take over and the editor cursor
		// must not linger.
		harness.editor.setText("");
		ask?.render?.(80);
		expect(harness.editor.focused).toBe(false);
	});

	it("lets the clear action empty the draft and lift the ask guard (#6738)", () => {
		const harness = makeHarness();
		// Route Ctrl+C to the guard: keep app.clear on Ctrl+C but move the ask
		// cancel key off it, so Ctrl+C reaches draft editing instead of cancelling.
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
		harness.editor.setActionKeys("app.clear", ["ctrl+c"]);
		let cleared = 0;
		// Mirror interactive wiring: app.clear (Ctrl+C) clears the draft.
		harness.editor.onClear = () => {
			cleared++;
			harness.editor.setText("");
		};
		harness.editor.setText("half typed prompt");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+C is reserved by the base editor and never clears; the guard must
		// dispatch the configured clear action so the "finish or clear" hint works.
		ask?.handleInput?.("\x03");
		expect(cleared).toBe(1);
		expect(harness.editor.getText()).toBe("");

		// With the draft gone the guard releases: the next key reaches the ask
		// controls and submits the highlighted option.
		ask?.handleInput?.("\n");
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("remounts the draft editor when the ask surface is restored after a nested prompt (#6738)", async () => {
		const harness = makeHarness();
		harness.editor.setText("half typed prompt");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		// Draft submitted: the guard lifts and ask controls take input; open the
		// note prompt, which swaps the container to the nested editor.
		harness.editor.setText("");
		ask?.handleInput?.("n");
		const promptEditor = harness.editorContainer.children[0];
		expect(promptEditor).not.toBe(ask);

		// A failed async submission restores the draft while the nested prompt is
		// open, re-blocking the guard.
		harness.editor.setText("half typed prompt");

		// Cancelling the nested prompt restores the ask surface; the draft editor
		// must be remounted so routed input lands on a visible surface.
		promptEditor?.handleInput?.("\x1b");
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
		// The dialog's prompt-active latch clears when the awaited onPrompt
		// promise settles; yield a microtask before routing the next key.
		await Promise.resolve();
		ask?.handleInput?.("!");
		expect(harness.editor.getText()).toBe("half typed prompt!");
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});

	it("retries invalid guest Other input with sanitized title and prefill", async () => {
		const responses: CollabGuestUiResult[] = [
			{ kind: "answered", value: "Other (type your own)" },
			{ kind: "answered", value: "INVALID" },
			{ kind: "answered", value: "42" },
		];
		const requestGuestUi = vi.fn<
			(request: CollabUiRequestDraft, signal?: AbortSignal) => Promise<CollabGuestUiResult>
		>(async () => responses.shift() ?? { kind: "unavailable" });
		const harness = makeHarness({ collabHost: { requestGuestUi } });

		const result = await harness.controller.showAskDialog([
			{
				id: "code",
				question: "Enter the code",
				options: [{ label: "Skip" }],
				validation: { pattern: "^\\d+$", message: "Digits\tonly\n\x1b[31m" },
			},
		]);

		expect(result).toEqual({
			kind: "submit",
			results: [
				{
					id: "code",
					question: "Enter the code",
					options: ["Skip"],
					multi: false,
					selectedOptions: [],
					customInput: "42",
				},
			],
		});
		const editorRequests = requestGuestUi.mock.calls
			.map(([request]) => request)
			.filter((request): request is Extract<CollabUiRequestDraft, { kind: "editor" }> => request.kind === "editor");
		expect(editorRequests).toHaveLength(2);
		expect(editorRequests[1]?.prefill).toBe("INVALID");
		expect(editorRequests[1]?.title).toContain("Digits only");
		expect(editorRequests[1]?.title).not.toContain("\x1b");
	});

	it("returns to the guest select list when its Other editor is cancelled", async () => {
		const responses: CollabGuestUiResult[] = [
			{ kind: "answered", value: "Other (type your own)" },
			{ kind: "answered", value: undefined },
			{ kind: "answered", value: "Skip" },
		];
		const requestGuestUi = vi.fn<
			(request: CollabUiRequestDraft, signal?: AbortSignal) => Promise<CollabGuestUiResult>
		>(async () => responses.shift() ?? { kind: "unavailable" });
		const harness = makeHarness({ collabHost: { requestGuestUi } });

		const result = await harness.controller.showAskDialog([
			{ id: "code", question: "Enter the code", options: [{ label: "Skip" }] },
		]);

		expect(result).toMatchObject({
			kind: "submit",
			results: [{ selectedOptions: ["Skip"], customInput: undefined }],
		});
		expect(requestGuestUi.mock.calls).toHaveLength(3);
	});
});
