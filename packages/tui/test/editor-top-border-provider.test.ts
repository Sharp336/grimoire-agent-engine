/**
 * Regression for oh-my-pi#4145 (TUI busy loop during long-running eval).
 *
 * The pre-fix hot path rebuilt the editor's top border synchronously on every
 * session event, even though renders are throttled to ~30 fps. On a busy
 * streaming turn that meant dozens of `getTopBorder` calls per painted frame.
 *
 * The fix installs a lazy provider on the editor: the host mutates status-line
 * state as much as it wants, and the provider is invoked exactly once per
 * editor render — bounded by the TUI's render throttle, not by event rate.
 *
 * Contract this test defends:
 * 1. Provider takes precedence over any eager `setTopBorder` content.
 * 2. Provider runs once per render (2 renders = 2 calls, no more).
 * 3. Provider observes the CURRENT status-line state at render time, so
 *    state mutations landing between renders coalesce into one rebuild.
 * 4. Clearing the provider falls back to the eager slot.
 */
import { describe, expect, it } from "bun:test";
import { Editor, type EditorTopBorder } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

function stubTopBorder(label: string): EditorTopBorder {
	return { content: label, width: label.length };
}

describe("Editor lazy top-border provider (#4145)", () => {
	it("invokes the provider once per render regardless of intervening state changes", () => {
		const editor = new Editor(defaultEditorTheme);
		let observedCounter = 0;
		let counter = 0;
		const calls: number[] = [];

		editor.setTopBorderProvider(availableWidth => {
			calls.push(availableWidth);
			observedCounter = counter;
			return stubTopBorder(`counter=${counter}`);
		});

		// Simulate a burst of "events" mutating upstream state between two
		// painted frames. Under the old eager rebuild path this would have
		// been 25 rebuilds; under the lazy provider it should be zero here…
		for (let i = 0; i < 25; i++) counter += 1;
		expect(calls).toHaveLength(0);

		// …and exactly one per painted frame.
		editor.render(80);
		expect(calls).toHaveLength(1);
		expect(observedCounter).toBe(25);

		for (let i = 0; i < 25; i++) counter += 1;
		editor.render(80);
		expect(calls).toHaveLength(2);
		expect(observedCounter).toBe(50);
	});

	it("prefers the provider over any eager setTopBorder content", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setTopBorder(stubTopBorder("eager"));
		editor.setTopBorderProvider(() => stubTopBorder("lazy"));

		const frame = editor.render(80).join("\n");
		expect(frame).toContain("lazy");
		expect(frame).not.toContain("eager");
	});

	it("falls back to eager content when the provider is cleared", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setTopBorder(stubTopBorder("eager"));
		editor.setTopBorderProvider(() => stubTopBorder("lazy"));
		editor.setTopBorderProvider(undefined);

		const frame = editor.render(80).join("\n");
		expect(frame).toContain("eager");
		expect(frame).not.toContain("lazy");
	});

	it("passes the visually-available width (terminal width minus border chrome) to the provider", () => {
		const editor = new Editor(defaultEditorTheme);
		const widths: number[] = [];
		editor.setTopBorderProvider(availableWidth => {
			widths.push(availableWidth);
			return undefined;
		});

		editor.render(80);
		editor.render(120);

		expect(widths).toHaveLength(2);
		expect(widths[0]).toBe(editor.getTopBorderAvailableWidth(80));
		expect(widths[1]).toBe(editor.getTopBorderAvailableWidth(120));
	});
});
describe("Editor header height cap (#8170 finding H)", () => {
	it("honours setMaxHeight(3) with a two-row header — total height never exceeds cap", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setMaxHeight(3);
		editor.setTopBorderProvider(() => [stubTopBorder("row1"), stubTopBorder("row2")]);
		editor.setText("hello");

		const rows = editor.render(80);
		// 2 header rows +1 content +1 bottom would be 4 >3, so the editor must
		// drop a secondary header row rather than blow the cap and steal a
		// transcript row. At least one content row stays visible.
		expect(rows.length).toBeLessThanOrEqual(3);
		expect(rows.join("\n")).toContain("hello");
		// Only one header row should survive the cap
		const headerRows = rows.filter(line => line.includes("row")).length;
		expect(headerRows).toBe(1);
	});

	it("never exceeds very small caps even with three header rows", () => {
		for (const maxHeight of [2, 3]) {
			for (const headerCount of [2, 3]) {
				const editor = new Editor(defaultEditorTheme);
				editor.setMaxHeight(maxHeight);
				const rows = Array.from({ length: headerCount }, (_, i) => stubTopBorder(`r${i + 1}`));
				editor.setTopBorderProvider(() => rows);
				editor.setText("x");
				expect(editor.render(80).length).toBeLessThanOrEqual(maxHeight);
			}
		}
	});

	it("keeps full header on roomy terminals (one- and two-row headers)", () => {
		for (const maxHeight of [6, 10, 18]) {
			for (const headerCount of [1, 2]) {
				const editor = new Editor(defaultEditorTheme);
				editor.setMaxHeight(maxHeight);
				const rows = Array.from({ length: headerCount }, (_, i) => stubTopBorder(`HDR${i + 1}`));
				editor.setTopBorderProvider(() => rows);
				editor.setText("hello");
				const rendered = editor.render(80);
				expect(rendered.length).toBeLessThanOrEqual(maxHeight);
				const headerRows = rendered.filter(line => line.includes("HDR")).length;
				expect(headerRows).toBe(headerCount);
			}
		}
	});
});
