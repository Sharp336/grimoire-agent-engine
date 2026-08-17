import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { BtwPanelComponent } from "@oh-my-pi/pi-coding-agent/modes/components/btw-panel";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

// Contract under test: the `/btw` panel lives in the anchored live region above
// the editor. That region only stays out of native scrollback while it fits the
// viewport — rows that scroll off are recorded, and a rebuilt-in-place panel
// then records them again on the next frame. Measured on a real pane before this
// bound existed: a 60-line side answer streaming under a growing transcript left
// 39 of its lines in history 2-3 times each; with the bound, zero.
function tuiStub(rows: number): TUI {
	return {
		requestComponentRender: vi.fn(),
		terminal: { rows },
	} as unknown as TUI;
}

function visibleRows(component: BtwPanelComponent, width = 80): string[] {
	return component.render(width).map(row => stripVTControlCharacters(row));
}

describe("BtwPanelComponent answer bound", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("keeps a long answer within a viewport share and points at the full copy", () => {
		const panel = new BtwPanelComponent({ question: "why", tui: tuiStub(40) });
		const answer = Array.from({ length: 80 }, (_, i) => `line-${i + 1}`).join("\n");
		panel.setAnswer(answer);
		panel.markComplete();

		const rendered = visibleRows(panel);
		// 40 rows viewport -> 16 answer rows, plus the panel's own chrome.
		expect(rendered.length).toBeLessThan(30);
		expect(rendered.some(row => row.includes("earlier rows") && row.includes("c copy"))).toBe(true);
		// The newest end of a streaming answer is what the reader wants visible.
		expect(rendered.some(row => row.includes("line-80"))).toBe(true);
		expect(rendered.some(row => row.includes("line-1\b") || row === " line-1")).toBe(false);
		// Nothing is lost: the copy affordance still yields the whole answer.
		expect(panel.getCopyText()).toBe(answer);
	});

	it("never shrinks the answer below the floor on a short terminal", () => {
		const panel = new BtwPanelComponent({ question: "why", tui: tuiStub(4) });
		panel.setAnswer(Array.from({ length: 40 }, (_, i) => `row-${i + 1}`).join("\n"));
		panel.markComplete();

		const answerRows = visibleRows(panel).filter(row => row.includes("row-"));
		expect(answerRows.length).toBeGreaterThanOrEqual(5);
	});

	it("renders a short answer untouched", () => {
		const panel = new BtwPanelComponent({ question: "why", tui: tuiStub(40) });
		panel.setAnswer("one\ntwo\nthree");
		panel.markComplete();

		const rendered = visibleRows(panel);
		expect(rendered.some(row => row.includes("earlier rows"))).toBe(false);
		for (const word of ["one", "two", "three"]) {
			expect(rendered.some(row => row.includes(word))).toBe(true);
		}
	});
});
