import { describe, expect, it } from "bun:test";
import {
	stopSharedSpinnerTicker,
	ToolExecutionComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/**
 * Finalized history block. With `tracked`, reports a post-finalize content
 * version like `AssistantMessageComponent`; otherwise it is version-untracked
 * like most tool blocks.
 */
class HistoryBlock implements Component {
	#lines: readonly string[];
	getTranscriptBlockVersion?: () => number;
	constructor(lines: readonly string[], tracked: boolean) {
		this.#lines = lines;
		if (tracked) this.getTranscriptBlockVersion = () => 1;
	}
	render(width: number): readonly string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

/** Streaming live block with a settled prefix, like a streaming assistant reply. */
class LiveBlock implements Component {
	lines: string[] = ["live-000"];
	settled = 0;
	render(width: number): readonly string[] {
		return this.lines.map(line => line.slice(0, width));
	}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	getTranscriptBlockSettledRows(): number {
		return this.settled;
	}
}

// Streams a live block behind a run of small finalized history blocks until the
// history fully commits to native scrollback, then verifies exactly-once history
// on the terminal tape. Regression guard: transcript-side committed-prefix
// compaction (dropping committed rows from the local frame) shifted the frame
// under the engine's committed-prefix ledger, the audit re-anchored, and
// already-taped rows were recommitted below their first copy — visibly
// duplicated blocks. The transcript now always keeps its full local frame.
async function streamPastCommit(tracked: boolean): Promise<Map<string, number>> {
	const term = new VirtualTerminal(40, 6);
	Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const chat = new TranscriptContainer();
	const historyRows: string[] = [];
	for (let i = 0; i < 6; i++) {
		const rows = [`box-${i}-alpha`, `box-${i}-beta`];
		historyRows.push(...rows);
		chat.addChild(new HistoryBlock(rows, tracked));
	}
	const live = new LiveBlock();
	chat.addChild(live);
	tui.addChild(chat);

	try {
		tui.start();
		await scheduler.drain(term);
		// Grow the live block one row per frame with the settled prefix trailing
		// by one, pushing the finalized history through commit and compaction.
		for (let i = 1; i < 40; i++) {
			live.lines.push(`live-${String(i).padStart(3, "0")}`);
			live.settled = live.lines.length - 1;
			tui.requestRender();
			await scheduler.drain(term);
		}
	} finally {
		tui.stop();
		await term.flush();
	}

	const counts = new Map<string, number>();
	for (const row of term.getScrollBuffer()) {
		const text = Bun.stripANSI(row).trimEnd();
		if (text.length === 0) continue;
		counts.set(text, (counts.get(text) ?? 0) + 1);
	}
	// Loss check alongside the duplication check: every history row must have
	// reached the tape exactly once.
	for (const row of historyRows) expect(counts.get(row) ?? 0).toBe(1);
	return counts;
}

describe("transcript committed history", () => {
	it("keeps version-tracked committed history exactly once on the tape", async () => {
		const counts = await streamPastCommit(true);
		expect([...counts.entries()].filter(([, count]) => count > 1)).toEqual([]);
	});

	it("keeps version-untracked committed history exactly once on the tape", async () => {
		const counts = await streamPastCommit(false);
		expect([...counts.entries()].filter(([, count]) => count > 1)).toEqual([]);
	});
});

/**
 * Streams a real foreground tool call past the commit boundary and then lands
 * its result. Regression guard for #8881: an unfinalized block rewrites rows it
 * already rendered, so committing them guarantees a later committed-prefix
 * re-anchor, and on a multiplexer that cannot erase scrollback the engine
 * recommits the block below its stale copy — the pane shows one box interleaved
 * with rows of a later frame. Driving `ToolExecutionComponent` itself keeps the
 * component's pin under test instead of a mock's imitation of it.
 */
describe("foreground tool block history", () => {
	it("commits a completed call exactly once, and no mid-run row", async () => {
		await initTheme();
		stopSharedSpinnerTicker();
		const term = new VirtualTerminal(40, 6);
		Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const chat = new TranscriptContainer();
		for (let i = 0; i < 4; i++) chat.addChild(new HistoryBlock([`hist-${i}-alpha`, `hist-${i}-beta`], false));
		const tool = new ToolExecutionComponent(
			"bash",
			{ command: "echo hi" },
			{},
			undefined,
			{ requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		chat.addChild(tool);
		tui.addChild(chat);
		const output = (rows: number) => ({
			content: [
				{
					type: "text",
					text: Array.from({ length: rows }, (_, i) => `out ${String(i).padStart(3, "0")}`).join("\n"),
				},
			],
		});

		try {
			tui.start();
			await scheduler.drain(term);
			// Partial results grow the block past the 6-row viewport, so its rows
			// reach the commit boundary while the call is still live.
			for (let rows = 1; rows <= 30; rows++) {
				tool.updateResult(output(rows), true);
				tui.requestRender();
				await scheduler.drain(term);
			}
			expect(tool.isNativeScrollbackLiveRegionPinned()).toBe(true);
			tool.updateResult(output(30), false);
			tui.requestRender();
			await scheduler.drain(term);
			expect(tool.isNativeScrollbackLiveRegionPinned()).toBe(false);
		} finally {
			tui.stop();
			await term.flush();
		}

		const counts = new Map<string, number>();
		for (const row of term.getScrollBuffer()) {
			const text = Bun.stripANSI(row).trimEnd();
			if (text.length === 0) continue;
			counts.set(text, (counts.get(text) ?? 0) + 1);
		}
		// Every row the block put on the tape — header, section divider, borders
		// and body alike — must belong to the final frame and appear once. The
		// header rows carry the reported corruption: a stale running header and
		// the timing-bearing final one are different strings, so a duplicate
		// count alone would permit both. The block's rows must reach the tape at
		// all, or these assertions hold vacuously; a bash result renders a
		// bounded preview, so rows the preview dropped are legitimately absent.
		const frameRow = /^[╭│├╰]/u;
		const taped = [...counts.keys()].filter(row => frameRow.test(row));
		const final = new Set(tool.render(40).map(row => Bun.stripANSI(row).trimEnd()));
		expect([...counts.entries()].filter(([, count]) => count > 1)).toEqual([]);
		expect(taped.filter(row => !final.has(row))).toEqual([]);
		expect(taped.length).toBeGreaterThan(0);
	});
});
