import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { CopySelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/copy-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CopyTarget } from "@oh-my-pi/pi-coding-agent/modes/utils/copy-targets";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\n";
const CANCEL = "\x07"; // ctrl+g, remapped to tui.select.cancel below

let darkTheme = await getThemeByName("dark");

// Flatten order (always expanded): msg:1, Block 1, Block 2, msg:2.
function makeRoots(): CopyTarget[] {
	return [
		{
			id: "msg:1",
			label: "Newest message",
			hint: "5 lines · 2 code",
			preview: "newest-preview-text",
			content: "FULL_MESSAGE",
			copyMessage: "Copied last message to clipboard",
			children: [
				{
					id: "msg:1:code:0",
					label: "Block 1",
					hint: "ts",
					language: "ts",
					preview: "alpha()",
					content: "BLOCK0",
					copyMessage: "Copied block 1",
				},
				{
					id: "msg:1:code:1",
					label: "Block 2",
					hint: "py",
					language: "python",
					preview: "beta()",
					content: "BLOCK1",
					copyMessage: "Copied block 2",
				},
			],
		},
		{
			id: "msg:2",
			label: "Older message",
			hint: "3 lines",
			preview: "older-text",
			content: "OLDER",
			copyMessage: "Copied message",
		},
	];
}

function render(component: CopySelectorComponent): string {
	return stripVTControlCharacters(component.render(80).join("\n"));
}

describe("CopySelectorComponent", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
	});

	it("renders an outlined tree with code blocks nested under their message", () => {
		const out = render(new CopySelectorComponent(makeRoots(), { onPick: vi.fn(), onCancel: vi.fn() }));
		expect(out).toContain("┌");
		expect(out).toContain("│");
		expect(out).toContain("Copy to clipboard");
		// Messages and their nested blocks are all visible (always expanded),
		// connected with /tree-style branch glyphs.
		expect(out).toContain("Newest message");
		expect(out).toContain("Block 1");
		expect(out).toContain("Block 2");
		expect(out).toContain("Older message");
		expect(out).toMatch(/[├└]/);
	});

	it("copies the message node itself on Enter", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		component.handleInput(ENTER); // cursor starts on the message node

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("FULL_MESSAGE");
	});

	it("navigates into a nested code block and copies it", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		component.handleInput(DOWN); // onto "Block 1"
		component.handleInput(ENTER);

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("BLOCK0");
	});

	it("traverses past nested blocks to the older message, with the preview tracking the cursor", () => {
		const component = new CopySelectorComponent(makeRoots(), { onPick: vi.fn(), onCancel: vi.fn() });

		component.handleInput(DOWN); // Block 1
		expect(render(component)).toContain("alpha()");

		component.handleInput(DOWN); // Block 2
		component.handleInput(DOWN); // Older message
		expect(render(component)).toContain("older-text");

		component.handleInput(UP); // back onto Block 2
		expect(render(component)).toContain("beta()");
	});

	it("quits on the cancel key", () => {
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick: vi.fn(), onCancel });

		component.handleInput(CANCEL);

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	// Mouse: the fullscreen overlay enables SGR tracking. Wire row is 1-based and
	// parseSgrMouse converts to 0-based; the top border is screen row 0, so the
	// first tree row (msg:1) is screen row 1 == wire row 2.
	it("copies the block under a left click", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });
		render(component); // builds the per-row hit map
		component.handleInput("\x1b[<0;4;3M"); // wire row 3 -> screen row 2 -> Block 1
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("BLOCK0");
	});

	it("moves the selection with the wheel and clamps at the top", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });
		render(component);
		component.handleInput("\x1b[<65;4;2M"); // wheel down -> Block 1
		expect(render(component)).toContain("alpha()");
		component.handleInput("\x1b[<64;4;2M"); // wheel up -> msg:1
		component.handleInput("\x1b[<64;4;2M"); // already at top, clamps (no wrap)
		component.handleInput(ENTER);
		expect(onPick.mock.calls.at(-1)![0].content).toBe("FULL_MESSAGE");
	});

	it("ignores a click outside the tree rows", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });
		render(component);
		component.handleInput("\x1b[<0;4;1M"); // wire row 1 -> screen row 0 (top border)
		component.handleInput("\x1b[<0;4;39M"); // far below the tree
		expect(onPick).not.toHaveBeenCalled();
	});

	it("does not copy a node that carries no content", () => {
		const onPick = vi.fn();
		const roots: CopyTarget[] = [
			{
				id: "group",
				label: "Group",
				preview: "",
				children: [{ id: "leaf", label: "Leaf", preview: "x", content: "LEAF", copyMessage: "c" }],
			},
		];
		const component = new CopySelectorComponent(roots, { onPick, onCancel: vi.fn() });
		render(component);
		component.handleInput("\x1b[<0;4;2M"); // screen row 1 -> the contentless group
		expect(onPick).not.toHaveBeenCalled();
		component.handleInput("\x1b[<0;4;3M"); // screen row 2 -> the leaf
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("LEAF");
	});

	it("falls through on a non-SGR-mouse sequence without copying", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });
		render(component);
		expect(() => component.handleInput("\x1b[<garbage")).not.toThrow();
		expect(onPick).not.toHaveBeenCalled();
	});
});
