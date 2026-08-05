import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { parseReviewDiffSnapshot } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import {
	CONTINUE_CODE_REVIEW_ACTION,
	CodeReviewOverlay,
	type CodeReviewOverlayResult,
	PASTE_CODE_REVIEW_ACTION,
} from "@oh-my-pi/pi-coding-agent/modes/components/code-review-overlay";
import * as diffRenderer from "@oh-my-pi/pi-coding-agent/modes/components/diff";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";

const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";
const SHIFT_ENTER = "\x1b[13;2~";

let darkTheme = await getThemeByName("dark");
let lightTheme = await getThemeByName("light");

function render(component: CodeReviewOverlay, width = 90): string {
	return component.render(width).map(stripVTControlCharacters).join("\n");
}

function makeOverlay(
	diff: string,
	onComplete = vi.fn<(result: CodeReviewOverlayResult | undefined) => void>(),
	tui = {} as TUI,
) {
	return {
		onComplete,
		overlay: new CodeReviewOverlay(tui, parseReviewDiffSnapshot(diff).files, "Reviewing changes", {
			onComplete,
		}),
	};
}

describe("CodeReviewOverlay", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		lightTheme = await getThemeByName("light");
		if (!darkTheme) throw new Error("Failed to load dark theme");
		if (!lightTheme) throw new Error("Failed to load light theme");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders changed files, diff contents, and review actions", () => {
		const { overlay } = makeOverlay(`diff --git a/src/alpha.ts b/src/alpha.ts
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/beta.ts b/src/beta.ts
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -0,0 +1 @@
+beta`);

		const out = render(overlay);
		expect(out).toContain("Code Review");
		expect(out).toContain("src/alpha.ts");
		expect(out).toContain("src/beta.ts");
		expect(out).toContain("new");
		expect(out).toContain(CONTINUE_CODE_REVIEW_ACTION);
		expect(out).toContain(PASTE_CODE_REVIEW_ACTION);

		overlay.handleInput(DOWN);
		expect(render(overlay)).toContain("beta");
		overlay.handleInput(TAB);
		expect(render(overlay)).toContain("↑↓ line");
	});

	it("shows the full current nested path above the wide diff pane", () => {
		const nestedPath = "packages/coding-agent/src/modes/components/deep/code-review-pane.ts";
		const { overlay } = makeOverlay(`diff --git a/${nestedPath} b/${nestedPath}
--- a/${nestedPath}
+++ b/${nestedPath}
@@ -0,0 +1 @@
+new`);

		expect(render(overlay, 120)).toContain(nestedPath);
	});

	it("anchors an annotation to the selected diff line", () => {
		const rows = Array.from({ length: 80 }, (_, index) => ` context-row-${String(index).padStart(3, "0")}`);
		const { overlay, onComplete } = makeOverlay(
			`diff --git a/src/long.ts b/src/long.ts\n--- a/src/long.ts\n+++ b/src/long.ts\n@@ -1,80 +1,80 @@\n${rows.join("\n")}`,
		);

		render(overlay);
		overlay.handleInput(TAB);
		for (let index = 0; index < 12; index++) overlay.handleInput(DOWN);
		overlay.handleInput("a");
		for (const char of "check this guard") overlay.handleInput(char);
		overlay.handleInput(ENTER);

		expect(overlay.getAnnotations()).toEqual([
			expect.objectContaining({
				path: "src/long.ts",
				oldLine: 13,
				newLine: 13,
				rawLine: " context-row-012",
				note: "check this guard",
			}),
		]);
		expect(render(overlay)).toContain("check this guard");

		overlay.handleInput(TAB);
		overlay.handleInput(ENTER);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({ action: "review", annotations: overlay.getAnnotations() }),
		);
	});

	it("commits a multiline annotation entered with shift+enter", () => {
		const { overlay } = makeOverlay(
			"diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -0,0 +1 @@\n+new",
		);

		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("first line");
		overlay.handleInput(SHIFT_ENTER);
		overlay.handleInput("second line");
		expect(render(overlay)).toContain("shift+enter newline");
		overlay.handleInput(ENTER);

		expect(overlay.getAnnotations()).toEqual([
			expect.objectContaining({ newLine: 1, note: "first line\nsecond line" }),
		]);
		const out = render(overlay);
		expect(out).toContain("first line");
		expect(out).toContain("second line");
	});

	it("keeps static diff rows cached while dynamic interactions update", () => {
		const trailingRows = Array.from(
			{ length: 40 },
			(_, index) => ` context-tail-${String(index).padStart(3, "0")}`,
		).join("\n");
		const longContent = `long-${"x".repeat(56)}`;
		const { overlay } = makeOverlay(`diff --git a/src/alpha.ts b/src/alpha.ts
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -1,41 +1,42 @@
 context-first
+${longContent}
${trailingRows}
diff --git a/src/beta.ts b/src/beta.ts
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -0,0 +1 @@
+beta`);
		const renderDiffSpy = vi.spyOn(diffRenderer, "renderDiff");

		expect(render(overlay, 120)).toContain(longContent);
		expect(renderDiffSpy).toHaveBeenCalledTimes(1);

		overlay.handleInput(TAB);
		overlay.handleInput(DOWN);
		expect(render(overlay, 120)).toContain(longContent);
		expect(renderDiffSpy).toHaveBeenCalledTimes(1);

		overlay.handleInput("a");
		for (const char of "cached annotation") overlay.handleInput(char);
		overlay.handleInput(ENTER);
		expect(render(overlay, 120)).toContain("cached annotation");
		expect(overlay.getAnnotations()).toEqual([expect.objectContaining({ newLine: 2, note: "cached annotation" })]);
		expect(renderDiffSpy).toHaveBeenCalledTimes(1);

		const narrow = render(overlay, 45);
		expect(narrow).not.toContain(longContent);
		expect(narrow).toContain("long-");
		expect(narrow.split("\n").every(line => Bun.stringWidth(line) <= 45)).toBe(true);
		expect(renderDiffSpy).toHaveBeenCalledTimes(1);

		for (let index = 0; index < 40; index++) overlay.handleInput(DOWN);
		expect(render(overlay, 120)).toContain("context-tail-039");
		expect(renderDiffSpy).toHaveBeenCalledTimes(1);

		overlay.handleInput("]");
		expect(render(overlay, 120)).toContain("beta");
		expect(renderDiffSpy).toHaveBeenCalledTimes(2);

		overlay.handleInput("[");
		expect(render(overlay, 120)).toContain("cached annotation");
		expect(renderDiffSpy).toHaveBeenCalledTimes(2);

		const darkLine = overlay.render(120).find(line => stripVTControlCharacters(line).includes("context-first"));
		try {
			setThemeInstance(lightTheme!);
			overlay.invalidate();
			const lightLine = overlay.render(120).find(line => stripVTControlCharacters(line).includes("context-first"));
			expect(stripVTControlCharacters(lightLine ?? "")).toContain("context-first");
			expect(lightLine).not.toBe(darkLine);
			expect(renderDiffSpy).toHaveBeenCalledTimes(3);
		} finally {
			setThemeInstance(darkTheme!);
			overlay.invalidate();
		}
	});

	it("gates paste until annotations exist and supports undo", () => {
		const diff =
			"diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -0,0 +1 @@\n+new";
		const first = makeOverlay(diff);
		render(first.overlay);
		first.overlay.handleInput(TAB);
		first.overlay.handleInput(TAB);

		first.overlay.handleInput(DOWN);
		first.overlay.handleInput(ENTER);
		expect(first.onComplete).toHaveBeenCalledWith({ action: "review", annotations: [] });

		const { overlay } = makeOverlay(diff);
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("n");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toHaveLength(1);

		overlay.handleInput("u");
		expect(overlay.getAnnotations()).toEqual([]);
	});
	it("edits an annotation draft in the configured external editor", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-code-review-editor-"));
		const editorPath = path.join(tempDir, "editor.sh");
		const previousEditor = Bun.env.EDITOR;
		const previousVisual = Bun.env.VISUAL;
		const editorApplied = Promise.withResolvers<void>();
		const stop = vi.fn();
		const start = vi.fn();
		const tui = {
			stop,
			start,
			requestRender: () => editorApplied.resolve(),
		} as unknown as TUI;

		try {
			await Bun.write(editorPath, '#!/bin/sh\nprintf "%s" "edited annotation" > "$1"\n');
			await fs.chmod(editorPath, 0o755);
			Bun.env.EDITOR = editorPath;
			delete Bun.env.VISUAL;
			setKeybindings(KeybindingsManager.inMemory({ "app.editor.external": "ctrl+e" }));
			const { overlay } = makeOverlay(
				"diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -0,0 +1 @@\n+new",
				undefined,
				tui,
			);

			render(overlay);
			overlay.handleInput(TAB);
			overlay.handleInput("a");
			overlay.handleInput("draft");
			overlay.handleInput("\x05");
			await editorApplied.promise;

			expect(overlay.getAnnotations()).toEqual([expect.objectContaining({ newLine: 1, note: "edited annotation" })]);
			expect(stop).toHaveBeenCalledTimes(1);
			expect(start).toHaveBeenCalledTimes(1);
		} finally {
			if (previousEditor === undefined) delete Bun.env.EDITOR;
			else Bun.env.EDITOR = previousEditor;
			if (previousVisual === undefined) delete Bun.env.VISUAL;
			else Bun.env.VISUAL = previousVisual;
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("uses the compact file header when the terminal is narrow", () => {
		const { overlay } = makeOverlay(`diff --git a/src/alpha.ts b/src/alpha.ts
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -0,0 +1 @@
+new
diff --git a/src/beta.ts b/src/beta.ts
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -0,0 +1 @@
+after
`);

		expect(render(overlay, 55)).toContain("src/alpha.ts");
		overlay.handleInput("]");
		const out = render(overlay, 55);
		expect(out).toContain("src/beta.ts");
		expect(out).toContain("after");
	});
	it("cancels without producing a review result", () => {
		const { overlay, onComplete } = makeOverlay(
			"diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -0,0 +1 @@\n+new",
		);

		overlay.handleInput("\x1b");

		expect(onComplete).toHaveBeenCalledWith(undefined);
	});
});
