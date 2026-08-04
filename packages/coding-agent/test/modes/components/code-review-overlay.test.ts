import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
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
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";

const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";

let darkTheme = await getThemeByName("dark");

function render(component: CodeReviewOverlay, width = 90): string {
	return stripVTControlCharacters(component.render(width).join("\n"));
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
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("renders changed files, diff contents, and review actions", () => {
		const { overlay } = makeOverlay(`diff --git a/src/alpha.ts b/src/alpha.ts
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -0,0 +1 @@
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

		overlay.handleInput("]");
		expect(render(overlay)).toContain("beta");
	});

	it("anchors an annotation to the selected diff line", () => {
		const rows = Array.from({ length: 80 }, (_, index) => ` context-row-${String(index).padStart(3, "0")}`);
		const { overlay, onComplete } = makeOverlay(
			`diff --git a/src/long.ts b/src/long.ts\n--- a/src/long.ts\n+++ b/src/long.ts\n@@ -1,80 +1,80 @@\n${rows.join("\n")}`,
		);

		render(overlay);
		overlay.handleInput(TAB);
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

	it("gates paste until annotations exist and supports undo", () => {
		const diff =
			"diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -0,0 +1 @@\n+new";
		const first = makeOverlay(diff);

		first.overlay.handleInput(DOWN);
		first.overlay.handleInput(ENTER);
		expect(first.onComplete).toHaveBeenCalledWith({ action: "review", annotations: [] });

		const { overlay } = makeOverlay(diff);
		render(overlay);
		overlay.handleInput(TAB);
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
