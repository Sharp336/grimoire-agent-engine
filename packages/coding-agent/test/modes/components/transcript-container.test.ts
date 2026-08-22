import { describe, expect, it } from "bun:test";
import { TranscriptContainer, noteSealedTranscriptMutation } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { type Component } from "@oh-my-pi/pi-tui";

class Block implements Component {
	#rows: string[];
	#finalized: boolean;
	allocations: number[] = [];

	constructor(rows: string[], finalized: boolean) {
		this.#rows = rows;
		this.#finalized = finalized;
	}

	finalize(rows: string[]): void {
		this.#rows = rows;
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setTranscriptAllocation(rows: number): void {
		this.allocations.push(rows);
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

class MutableBlock implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	set(lines: string[]): void {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return [...this.#lines];
	}
}

// A block that can declare itself still-mutating (a foreground tool awaiting
// its result). Finalized blocks must be replayed by the compacted run instead
// of re-rendered; this one counts renders to observe the difference.
class StreamingBlock implements Component {
	#lines: string[];
	#finalized: boolean;
	constructor(lines: string[], finalized = false) {
		this.#lines = lines;
		this.#finalized = finalized;
	}
	set(lines: string[]): void {
		this.#lines = lines;
	}
	finalize(lines?: string[]): void {
		if (lines) this.#lines = lines;
		this.#finalized = true;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}
	invalidate(): void {}
	renderCount = 0;
	render(_width: number): string[] {
		this.renderCount++;
		return [...this.#lines];
	}
}

// A finalized block that can still mutate afterwards (an assistant message whose
// suppressed inline error is restored at the next turn, late tool-result images)
// and reports each mutation through the transcript block version protocol.
class VersionedFinalizedBlock implements Component {
	renderCount = 0;
	#lines: string[];
	#version = 0;

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	mutate(lines: string[]): void {
		this.#lines = lines;
		// Per the FinalizableBlock contract, a version bump on a finalized
		// block must trip the sealed-mutation epoch the container replays
		// sealed history against.
		noteSealedTranscriptMutation();
		this.#version++;
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		this.renderCount++;
		return [...this.#lines];
	}
}

const frame = { tick: 0, now: 0 };

describe("TranscriptContainer", () => {
	it("keeps settled blocks live while the viewport has room", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled"], true));
		transcript.addChild(new Block(["streaming"], false));

		// Both fit: nothing retires, the settled block still renders live.
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["settled", "", "streaming"]);
	});

	it("retires the settled prefix only under capacity pressure, in order", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["first final"], true);
		const second = new Block(["second live", "row", "row"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		// 5 rows fit everything (1 + separator + 3).
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		// 3 rows force the settled prefix out.
		expect(transcript.peekFinalizedBatch(80, 3)?.rows).toEqual(["first final", ""]);
	});

	it("never retires a finalized successor past an active predecessor", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["active live"], false);
		const settled = new Block(["settled final"], true);
		transcript.addChild(active);
		transcript.addChild(settled);

		// Pressure exists but the prefix starts with an active block: no batch,
		// and both blocks still render (clipped by the viewport).
		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active live", "", "settled final"]);

		active.finalize(["active final"]);
		// Capacity 1 fits the remaining settled block, so only the first retires.
		expect(transcript.peekFinalizedBatch(80, 1)?.rows).toEqual(["active final", ""]);
	});

	it("reoffers an unacknowledged batch and retires it exactly once", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final one"], true));
		transcript.addChild(new Block(["final two"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		const second = transcript.peekFinalizedBatch(80, 50);

		expect(second).toEqual(first);
		if (first === undefined) throw new Error("expected a batch under zero capacity");
		transcript.acknowledgeFinalizedBatch(first.id);
		// Committed blocks leave the live tail and never render again.
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
	});

	it("excludes an offered batch from the live viewport in the same frame", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["old settled"], true));
		transcript.addChild(new Block(["fresh live"], false));

		const batch = transcript.peekFinalizedBatch(80, 1);
		expect(batch?.rows).toEqual(["old settled", ""]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["fresh live"]);
	});

	it("assigns one row per live block until pressure requires aggregation", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"], false));
		transcript.addChild(new Block(["second"], false));

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["first", "second"]);
		expect(transcript.canAdmit(2)).toBe(false);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["1 more transcript blocks active"]);
	});
	it("does not report settled resume backlog as active", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled one"], true));
		transcript.addChild(new Block(["settled two"], true));
		transcript.addChild(new Block(["current tool"], false));

		// The welcome header can consume the first history offer, leaving the
		// settled transcript prefix live for one frame while it drains next.
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["current tool"]);
	});

	it("permits removing settled blocks until they are offered or committed", () => {
		const transcript = new TranscriptContainer();
		const settled = new Block(["settled snapshot"], true);
		const live = new Block(["live", "live", "live"], false);
		transcript.addChild(settled);
		transcript.addChild(live);

		// Settled but still in the mutable viewport: removable without a trace,
		// so a follow-up displaceable snapshot can retract it.
		expect(transcript.canRemoveBlock(settled)).toBe(true);

		// Offered to the terminal: mid-write, no longer removable.
		const batch = transcript.peekFinalizedBatch(80, 2);
		expect(batch?.rows).toEqual(["settled snapshot", ""]);
		expect(transcript.canRemoveBlock(settled)).toBe(false);

		// Committed: immutable history; removal must be refused outright.
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.canRemoveBlock(settled)).toBe(false);
		transcript.removeChild(settled);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);
	});

	it("reoffers committed history after an explicit destructive reset", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		if (first === undefined) throw new Error("expected initial batch");
		transcript.acknowledgeFinalizedBatch(first.id);

		transcript.resetRetirement();
		// Fits again after the reset: stays live until pressure returns.
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["final"]);
		const replay = transcript.peekFinalizedBatch(80, 0);
		expect(replay?.id).toBeGreaterThan(first.id);
		expect(replay?.rows).toEqual(["final", ""]);
	});
});

describe("TranscriptContainer full render", () => {
	const W = 40;

	it("does not re-render finalized history on steady ticks", () => {
		const container = new TranscriptContainer();
		const history = [
			new StreamingBlock(["h1", "h2"], true),
			new StreamingBlock(["h3"], true),
			new StreamingBlock(["h4", "h5"], true),
		];
		for (const block of history) container.addChild(block);
		const tail = new StreamingBlock(["tail"]);
		container.addChild(tail);

		// First render walks everything and bakes the finalized prefix into the
		// compacted run; every later tick must replay it without calling render().
		expect(container.render(W)).toEqual(["h1", "h2", "", "h3", "", "h4", "h5", "", "tail"]);
		const countsAfterFirst = history.map(block => block.renderCount);

		tail.set(["tail", "grown"]);
		for (let i = 0; i < 5; i++) expect(container.render(W)).toEqual(["h1", "h2", "", "h3", "", "h4", "h5", "", "tail", "grown"]);

		expect(history.map(block => block.renderCount)).toEqual(countsAfterFirst);
	});

	it("absorbs a newly finalized tail block into the compacted run after one render", () => {
		const container = new TranscriptContainer();
		const first = new StreamingBlock(["a"], true);
		const second = new StreamingBlock(["b"]);
		const tail = new StreamingBlock(["c"]);
		container.addChild(first);
		container.addChild(second);
		container.addChild(tail);
		expect(container.render(W)).toEqual(["a", "", "b", "", "c"]);

		// While unfinalized, the middle block re-renders each tick...
		const beforeFinalize = second.renderCount;
		container.render(W);
		expect(second.renderCount).toBe(beforeFinalize + 1);

		// ...but once finalized, exactly one more render proves its bytes and
		// every later tick replays it.
		second.finalize(["b-final"]);
		container.render(W);
		expect(container.render(W)).toEqual(["a", "", "b-final", "", "c"]);
		const afterProof = second.renderCount;
		container.render(W);
		container.render(W);
		expect(second.renderCount).toBe(afterProof);
	});

	it("re-renders a finalized block when its version moves and keeps replaying afterwards", () => {
		const container = new TranscriptContainer();
		const first = new VersionedFinalizedBlock(["one"]);
		const second = new VersionedFinalizedBlock(["two"]);
		container.addChild(first);
		container.addChild(second);
		expect(container.render(W)).toEqual(["one", "", "two"]);
		const stableCounts = [first.renderCount, second.renderCount];

		// Steady tick: both replayed, no renders.
		container.render(W);
		expect([first.renderCount, second.renderCount]).toEqual(stableCounts);

		// Post-finalize mutation trips the sealed epoch: the mutated block
		// re-renders once, the untouched prefix stays replayed.
		second.mutate(["two", "updated"]);
		expect(container.render(W)).toEqual(["one", "", "two", "updated"]);
		expect(first.renderCount).toBe(stableCounts[0]);
		expect(second.renderCount).toBe(stableCounts[1]! + 1);

		// And the fresh bytes are trusted history again on the next tick.
		container.render(W);
		expect(second.renderCount).toBe(stableCounts[1]! + 1);
		expect(container.render(W)).toEqual(["one", "", "two", "updated"]);
	});

	it("inserts exactly one blank line between consecutive blocks", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		container.addChild(new MutableBlock(["b"]));
		container.addChild(new MutableBlock(["c"]));
		// One separator between each block; none above the first.
		expect(container.render(40)).toEqual(["a", "", "b", "", "c"]);
	});

	it("strips a block's plain-blank top/bottom padding", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		// Leading Spacer rows + a trailing paddingY row collapse to just the body.
		container.addChild(new MutableBlock(["", "   ", "body", ""]));
		expect(container.render(40)).toEqual(["a", "", "body"]);
	});

	it("preserves background-colored padding rows (block-internal design)", () => {
		const bgPad = "\x1b[48;2;0;0;0m   \x1b[0m";
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		// The ANSI-bearing padding row is not "plain blank", so it survives stripping.
		container.addChild(new MutableBlock([bgPad, "x", bgPad]));
		expect(container.render(40)).toEqual(["a", "", bgPad, "x", bgPad]);
	});

	it("does not double the gap when a block carries its own trailing blank", () => {
		const container = new TranscriptContainer();
		// The trailing blank is stripped, so only the container's separator remains.
		container.addChild(new MutableBlock(["note", ""]));
		container.addChild(new MutableBlock(["b"]));
		expect(container.render(40)).toEqual(["note", "", "b"]);
	});

	it("drops a blank-only block without leaving a stray gap", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		container.addChild(new MutableBlock(["", "  "]));
		container.addChild(new MutableBlock(["b"]));
		expect(container.render(40)).toEqual(["a", "", "b"]);
	});

	it("keeps an appended finalized block byte-stable without invalidating the run", () => {
		const container = new TranscriptContainer();
		const history = new StreamingBlock(["history"], true);
		container.addChild(history);
		expect(container.render(W)).toEqual(["history"]);

		// Appending bumps the child-list epoch: the run re-validates (cheap
		// identity/finality checks), the new block renders, old bytes stay put.
		const tail = new StreamingBlock(["tail"], true);
		container.addChild(tail);
		expect(container.render(W)).toEqual(["history", "", "tail"]);
		expect(history.renderCount).toBe(1);
	});

	it("re-renders everything at a new width", () => {
		const container = new TranscriptContainer();
		const history = new StreamingBlock(["history"], true);
		const tail = new StreamingBlock(["tail"], true);
		container.addChild(history);
		container.addChild(tail);
		container.render(W);

		// Settled blocks must reflow at the current width: a width change
		// dissolves the compacted run and re-walks every block.
		container.render(W + 10);
		expect(history.renderCount).toBe(2);
		expect(tail.renderCount).toBe(2);
	});

});
