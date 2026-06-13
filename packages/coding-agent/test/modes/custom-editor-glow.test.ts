import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import * as magicKeywords from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

// The glow shimmer is a 30fps setInterval driven by CustomEditor. These tests
// pin the ticker lifecycle (start/stop/dispose), the focus + enabled gating,
// and the contract that keyword presence is scanned on text change, never per
// frame (the per-frame full-buffer scan was the reviewed perf hazard).
describe("CustomEditor glow shimmer ticker", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function focusedEditor(): CustomEditor {
		const editor = new CustomEditor(getEditorTheme());
		editor.isMagicKeywordsEnabled = () => true;
		editor.focused = true;
		return editor;
	}

	it("ticks only while focused, enabled, and a magic keyword is present", () => {
		const editor = focusedEditor();
		let ticks = 0;
		editor.onGlowTick = () => {
			ticks += 1;
		};

		editor.setText("ultrathink");
		vi.advanceTimersByTime(100);
		expect(ticks).toBeGreaterThan(0);

		const whileGlowing = ticks;
		editor.setText("a plain prompt with no magic word");
		vi.advanceTimersByTime(100);
		expect(ticks).toBe(whileGlowing); // keyword removed -> ticker stopped
	});

	it("never starts while the magicKeywords gate is disabled", () => {
		const editor = focusedEditor();
		editor.isMagicKeywordsEnabled = () => false;
		let ticks = 0;
		editor.onGlowTick = () => {
			ticks += 1;
		};

		editor.setText("ultrathink");
		vi.advanceTimersByTime(100);
		expect(ticks).toBe(0);
	});

	it("starts a restored draft only once focus is (re)assigned", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.isMagicKeywordsEnabled = () => true;
		editor.focused = false;
		let ticks = 0;
		editor.onGlowTick = () => {
			ticks += 1;
		};

		editor.setText("orchestrate the plan"); // keyword present but unfocused
		vi.advanceTimersByTime(100);
		expect(ticks).toBe(0);

		editor.focused = true;
		editor.setUseTerminalCursor(false); // the TUI focus (re)assignment hook
		vi.advanceTimersByTime(100);
		expect(ticks).toBeGreaterThan(0);
	});

	it("stops the ticker on dispose without leaking the interval", () => {
		const editor = focusedEditor();
		let ticks = 0;
		editor.onGlowTick = () => {
			ticks += 1;
		};

		editor.setText("workflowz");
		vi.advanceTimersByTime(66);
		const beforeDispose = ticks;
		expect(beforeDispose).toBeGreaterThan(0);

		editor.dispose();
		vi.advanceTimersByTime(330); // ~10 frames
		expect(ticks).toBe(beforeDispose); // disposed -> no further ticks
	});

	it("scans for keywords on text change, not on every shimmer frame", () => {
		const editor = focusedEditor();
		editor.onGlowTick = () => {};
		const scanSpy = spyOn(magicKeywords, "containsAnyMagicKeyword");

		editor.setText("ultrathink");
		const afterEdit = scanSpy.mock.calls.length;
		expect(afterEdit).toBeGreaterThan(0);

		vi.advanceTimersByTime(330); // ~10 frames at 30fps
		// The frame loop must read the cached presence, not re-scan the buffer.
		expect(scanSpy.mock.calls.length).toBe(afterEdit);
	});
});
