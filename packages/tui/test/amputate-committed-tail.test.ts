import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// `TUI.amputateCommittedTail` is the preserve-mode history-rewind primitive:
// it declares that every current-frame row at/after a boundary is about to be
// dropped by the caller (not a render-driven shrink) and disowns any of those
// rows already on the terminal's native tape — the surviving prefix must
// commit nothing new and re-emit nothing that was already scrolled off,
// exactly like `tui.resizeScrollback: preserve` already accepts for a
// settled resize. `getComponentFrameRow` is the companion offset lookup a
// nested container (e.g. the coding agent's TranscriptContainer) uses to
// translate its own segment boundary into the TUI's absolute frame row.

class LineList implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
}

/** One scheduler per file; `beforeEach` rewinds it so each test starts at t=0 with an empty queue. */
const scheduler = new VirtualRenderScheduler();

async function settle(term: VirtualTerminal): Promise<void> {
	await scheduler.settle(term);
}

async function settleResize(term: VirtualTerminal): Promise<void> {
	await scheduler.advance(term, 160);
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	term.write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i.toString().padStart(2, "0")}`);
}

/** Scrollback history + active grid, right-trimmed, trailing blank rows dropped. */
function tape(term: VirtualTerminal): string[] {
	const buffer = term.getScrollBuffer().map(line => line.trimEnd());
	while (buffer.length > 0 && buffer.at(-1) === "") buffer.pop();
	return buffer;
}

function saveTerminalEnv(): Record<string, string | undefined> {
	const saved: Record<string, string | undefined> = {};
	for (const key of ["TMUX", "STY", "ZELLIJ", "TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE", "HERDR_ENV"]) {
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
	return saved;
}

function restoreTerminalEnv(saved: Record<string, string | undefined>): void {
	for (const key in saved) {
		const value = saved[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
}

describe("TUI.amputateCommittedTail", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		scheduler.reset();
		savedTerminalEnv = saveTerminalEnv();
	});

	afterEach(() => {
		restoreTerminalEnv(savedTerminalEnv);
		savedTerminalEnv = {};
	});

	it("resolves a root child's absolute frame row from its own local segment boundary", async () => {
		const term = new VirtualTerminal(20, 5, 1_000);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const header = new LineList(["header-00", "header-01"]);
		const transcript = new LineList(rows("row-", 20));

		try {
			tui.addChild(header);
			tui.addChild(transcript);
			tui.start();
			await settle(term);

			// `transcript` sits after `header`'s 2 rows: local row 10 inside
			// `transcript` is absolute frame row 12.
			expect(tui.getComponentFrameRow(transcript, 10)).toBe(12);
			expect(tui.getComponentFrameRow(header, 0)).toBe(0);
			// Not a root child of this frame.
			expect(tui.getComponentFrameRow(new LineList([]), 0)).toBeUndefined();
		} finally {
			tui.stop();
		}
	});

	it("drops a committed tail without re-emitting the surviving prefix, and clears dead viewport rows", async () => {
		const term = new VirtualTerminal(20, 5, 1_000);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const header = new LineList(["header-00", "header-01"]);
		const transcript = new LineList(rows("row-", 30));

		try {
			tui.addChild(header);
			tui.addChild(transcript);
			tui.start();
			await settle(term);

			// First paint: frame is 32 rows (2 header + 30 transcript), height 5,
			// so rows [0, 27) are already committed/scrolled off and rows
			// [27, 32) (row-25..row-29) are on screen.
			expect(term.getBufferPosition().baseY).toBe(27);
			expect(tape(term).slice(-5)).toEqual(rows("row-", 30).slice(-5));

			const writes = capture(term);

			// Rewind the transcript to its first 20 rows (row-00..row-19):
			// frame row 22 (2 header + 20 surviving) sits well inside the old
			// committed boundary (27) — exactly the "dropped block already on
			// the tape" case the fast-path veto refuses without this primitive.
			const frameRow = tui.getComponentFrameRow(transcript, 20);
			expect(frameRow).toBe(22);
			expect(tui.amputateCommittedTail(frameRow!)).toBe(true);
			transcript.setLines(rows("row-", 20));
			tui.requestRender();
			await settle(term);

			// No new physical scroll-commit: disowning committed rows is a pure
			// bookkeeping truncation, never a scrollback append.
			expect(term.getBufferPosition().baseY).toBe(27);
			const writtenBytes = writes.join("");
			// Rows strictly above the new viewport (row-00..row-14, and the two
			// header rows) were already final before the amputation and must
			// never be rewritten — the surviving prefix's already-scrolled
			// portion is re-emitted zero times.
			for (const line of ["header-00", "header-01", ...rows("row-", 15)]) {
				expect(writtenBytes.includes(line)).toBe(false);
			}
			// The new viewport shows exactly the surviving tail — the stale
			// row-20..row-29 rows the amputation disowned are gone from screen.
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("row-", 20).slice(-5));
			for (const stale of rows("row-", 30).slice(20)) {
				expect(term.getViewport().some(line => line.includes(stale))).toBe(false);
			}
		} finally {
			tui.stop();
		}
	});

	it("commits normally again once new content is appended after an amputation", async () => {
		const term = new VirtualTerminal(20, 5, 1_000);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new LineList(rows("row-", 30));

		try {
			tui.addChild(transcript);
			tui.start();
			await settle(term);
			expect(term.getBufferPosition().baseY).toBe(25);

			const frameRow = tui.getComponentFrameRow(transcript, 20)!;
			expect(tui.amputateCommittedTail(frameRow)).toBe(true);
			transcript.setLines(rows("row-", 20));
			tui.requestRender();
			await settle(term);

			// Append past the amputation boundary: the engine's ordinary
			// append/commit machinery is unimpaired afterwards.
			transcript.setLines([...rows("row-", 20), ...rows("new-", 8)]);
			tui.requestRender();
			await settle(term);

			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("new-", 8).slice(-5));
			// The genuinely new tail commits exactly once — no duplication for
			// content the amputation never touched.
			const finalTape = tape(term);
			for (const line of rows("new-", 8)) {
				expect(finalTape.filter(row => row === line)).toHaveLength(1);
			}
			// row-20..row-24 were disowned by the amputation and stay stale in
			// scrollback forever — never erased, but never re-synthesized either.
			for (const stale of rows("row-", 25).slice(20)) {
				expect(finalTape.filter(row => row === stale)).toHaveLength(1);
			}
			expect(term.getBufferPosition().baseY).toBeGreaterThan(25);
		} finally {
			tui.stop();
		}
	});

	it("refuses while an in-place width-epoch append ledger is still tracking a past resize", async () => {
		Bun.env.TMUX = "1";
		const term = new VirtualTerminal(20, 5, 1_000);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new LineList(rows("row-", 30));

		try {
			tui.addChild(transcript);
			tui.start();
			await settle(term);

			// A settled in-place resize (tmux repaints in place) leaves the
			// append-ledger baseline defined for the rest of the session.
			term.resize(24, 5);
			await settleResize(term);

			expect(tui.amputateCommittedTail(tui.getComponentFrameRow(transcript, 20)!)).toBe(false);

			// Refusal never mutated engine state: an ordinary render afterwards
			// still works.
			transcript.setLines([...rows("row-", 30), "row-30"]);
			tui.requestRender();
			await settle(term);
			expect(
				term
					.getViewport()
					.map(line => line.trimEnd())
					.at(-1),
			).toBe("row-30");
		} finally {
			tui.stop();
		}
	});

	it("refuses while a visible overlay is compositing its own rows", async () => {
		const term = new VirtualTerminal(20, 5, 1_000);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new LineList(rows("row-", 30));

		try {
			tui.addChild(transcript);
			tui.start();
			await settle(term);

			const overlay = tui.showOverlay(new LineList(["overlay"]), { anchor: "top-left" });
			await settle(term);

			expect(tui.amputateCommittedTail(tui.getComponentFrameRow(transcript, 20)!)).toBe(false);

			overlay.hide();
			await settle(term);
			expect(tui.amputateCommittedTail(tui.getComponentFrameRow(transcript, 20)!)).toBe(true);
		} finally {
			tui.stop();
		}
	});
});
