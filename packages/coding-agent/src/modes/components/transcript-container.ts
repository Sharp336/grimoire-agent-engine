import type { Component, HistoryBatch } from "@oh-my-pi/pi-tui";
import { Container } from "@oh-my-pi/pi-tui";
import { isToolActivityComponent } from "./tool-activity";

/** Shared animation time supplied by the constrained transcript root. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** Lets an active block adapt its presentation to its allocated viewport rows. */
export interface TranscriptPresentationTarget {
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
}

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	/**
	 * Monotonic content version for blocks that can still mutate *after*
	 * reporting finalized (e.g. `AssistantMessageComponent`: the inline error
	 * restored at the next turn's `agent_start`, late tool-result images). The
	 * compacted-run replay in {@link TranscriptContainer.render} only reuses a
	 * block's previous rows when the version is unchanged; without this signal
	 * a post-finalize mutation would stay invisible until a global
	 * invalidation. Blocks that never mutate post-finalize simply omit the
	 * method.
	 *
	 * Every bump that occurs while the block reports finalized MUST be paired
	 * with {@link noteSealedTranscriptMutation}: sealed history is replayed
	 * without per-block validation unless that epoch moved (plus a periodic
	 * belt-and-braces pass). A missed pairing strands stale bytes in the
	 * composed frame until that pass.
	 */
	getTranscriptBlockVersion?(): number;
}

// Process-wide epoch of post-finalize ("sealed") transcript-block mutations.
// TranscriptContainer's compacted-run replay re-validates sealed rows only
// when this epoch moves (plus a periodic belt-and-braces pass), which is what
// keeps steady live-tail ticks flat against committed-history depth. Bumped
// only through {@link noteSealedTranscriptMutation}.
let sealedMutationEpoch = 0;

/**
 * Record a post-finalize ("sealed") mutation of a transcript block. A
 * component that can mutate after reporting finalized MUST pair every
 * `getTranscriptBlockVersion` bump that occurs while the block reports
 * finalized with a call to this (streaming updates on a still-live block do
 * not count): sealed history is replayed without per-block validation unless
 * this epoch moved, so a missed pairing strands stale bytes in the composed
 * frame until the periodic re-validation pass.
 */
export function noteSealedTranscriptMutation(): void {
	sealedMutationEpoch++;
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized but retained in the mutable viewport, re-rendering at
 *   the current width every frame (so resizes reflow it) until capacity
 *   pressure retires it.
 * - `committed`: appended to terminal history; immutable and never re-rendered.
 */
type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	state: BlockState;
}

const MAX_LIVE_BLOCKS = 256;
const EMPTY_ROWS: readonly string[] = [];

function isFinalized(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return block.isTranscriptBlockFinalized?.() ?? true;
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
}

/** Strip leading/trailing all-blank rows; the viewport allocator measures blocks by this trimmed height. */
export function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && isPlainBlank(rows[start]!)) start++;
	while (end > start && isPlainBlank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

interface BlockSegment {
	component: Component;
	rawRef: readonly string[];
	contribution: readonly string[];
	width: number;
	generation: number;
	/** Frame row of this block's first emitted row (the separator when present). */
	startRow: number;
	/** Rows emitted: separator + contribution (0 for empty contributions). */
	rowCount: number;
	sep: number;
	/** Whether the block reported finalized when this segment was rendered. */
	finalized: boolean;
	/** Block version observed when this segment was rendered (see {@link FinalizableBlock}). */
	version: number | undefined;
	// Combined finality/version re-check for the compacted-run replay, built
	// once per segment over the block's optional FinalizableBlock accessors
	// and the observed values: calling it answers "is this block still the
	// sealed content this segment recorded?" in one call. Undefined = the
	// block has no dynamic seam (documented default: finalized, unversioned,
	// immutable post-finalize).
	replayCheck?: () => boolean;
}

/** Owns transcript order, live capacity, and ordered immutable retirement. */
export class TranscriptContainer extends Container {
	#entries: TranscriptEntry[] = [];
	#frontier = 0;
	#nextBatchId = 1;
	#offered: { batch: HistoryBatch; end: number } | undefined;
	#toolActivityVisible = true;
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };
	// Bumped to retire every block segment at once (theme change / clear); a
	// segment is only reused when its stored generation matches.
	#generation = 0;
	// Persistent segment array: a stable frame rewrites only entries from the
	// first divergence on (see render()); the whole array is rebuilt fresh
	// after a poisoned walk or a width change.
	#segments: BlockSegment[] = [];
	// Whether #segments reflects a completed walk. A block render throwing
	// mid-walk poisons it; the next render must rebuild the array fresh.
	#segmentsClean = true;
	// Child-list mutation counter (addChild / removeChild / clear bump it);
	// gates the wholesale compacted-run replay.
	#childListEpoch = 0;
	// Child-list and sealed-mutation epochs at the last validated frame, plus
	// the frame counter for the periodic re-validation pass (see render()).
	#runChildListEpoch = -1;
	#runSealedEpoch = -1;
	#framesSinceValidation = 0;

	#renderWidth = -1;
	// Persistent assembled transcript rows. Rows before the first divergence
	// are byte-identical to the previous render; rows at/after it were re-pushed.
	// Returned directly by render() to keep steady ticks allocation-free.
	#lines: string[] = [];
	// Leading run of segments whose blocks reported finalized when rendered and
	// whose identity/finality/version a replay can re-validate cheaply (see
	// {@link TranscriptContainer.render}). Compacted history skips separator
	// re-derivation, contribution stripping, and segment re-allocation, so
	// per-tick compose cost stays flat against finalized-history depth.
	#committedRunLength = 0;

	override addChild(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		this.#childListEpoch++;
		super.addChild(component);
		this.#entries.push({ component, state: "active" });
	}

	override removeChild(component: Component): void {
		if (this.children.indexOf(component) < 0) return;
		if (!this.canRemoveBlock(component)) return;
		this.#childListEpoch++;
		super.removeChild(component);
		this.#entries = this.#entries.filter(candidate => candidate.component !== component);
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
	}

	override clear(): void {
		this.#generation++;
		this.#childListEpoch++;
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#segments = [];
		this.#segmentsClean = true;
		this.#committedRunLength = 0;
	}

	override invalidate(): void {
		// Theme/global invalidation: retire every diff snapshot so stale styling
		// is not diffed against the recolored render.
		this.#generation++;
		this.#committedRunLength = 0;
		super.invalidate();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	/** Whether a transient block may be discarded without leaving tape history. */
	canRemoveBlock(component: Component): boolean {
		// Active and settled blocks only live in the mutable viewport, so removing
		// them leaves no trace. Committed blocks are immutable terminal history,
		// and blocks inside the offered-but-unacknowledged batch are mid-write —
		// removing one would desync the offer's entry range.
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return false;
		if (this.#entries[index]!.state === "committed") return false;
		return this.#offered === undefined || index >= this.#offered.end;
	}
	/** Lifecycle state per block in transcript order (diagnostics and tests). */
	blockStates(): readonly BlockState[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.state);
	}

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Rebuild retirement state before replaying the complete transcript history. */
	resetRetirement(): void {
		this.#frontier = 0;
		this.#offered = undefined;
		for (const entry of this.#entries) {
			if (entry.state === "committed") entry.state = isFinalized(entry.component) ? "settled" : "active";
		}
	}

	/** Total rows the live (non-committed, non-offered) tail occupies at `width`. */
	liveRowCount(width: number): number {
		this.#syncEntries();
		this.#settleFinalized();
		let total = 0;
		for (const rendered of this.#liveBlocks(width)) {
			if (rendered.length > 0) total += rendered.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	/** Render the live tail, constrained to the supplied transcript height. */
	renderViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#syncEntries();
		this.#settleFinalized();
		const live = this.#liveEntries();
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0 || capacity === 0) return EMPTY_ROWS;
		if (live.length > capacity) return this.#renderEmergency(live, width, capacity, frame);

		// Full-height pass first: within capacity, live blocks render whole.
		const blocks: (readonly string[])[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			this.#setAllocation(live[index]!.component, Number.MAX_SAFE_INTEGER, frame);
			const rendered = trimBlankEdges(live[index]!.component.render(width));
			blocks[index] = rendered;
			if (rendered.length > 0) total += rendered.length + (visible++ > 0 ? 1 : 0);
		}
		if (total <= capacity) {
			const output: string[] = [];
			for (const rendered of blocks) {
				if (rendered.length === 0) continue;
				if (output.length > 0) output.push("");
				output.push(...rendered);
			}
			return output;
		}

		// Pressure: one row minimum per block, surplus to the newest blocks first,
		// separators dropped. Tool blocks re-render compact below three rows; text
		// blocks keep their latest rows visible.
		const allocation: number[] = new Array(live.length).fill(1);
		let surplus = capacity - live.length;
		for (let index = live.length - 1; index >= 0 && surplus > 0; index--) {
			const extra = Math.min(Math.max(0, blocks[index]!.length - 1), surplus);
			allocation[index] += extra;
			surplus -= extra;
		}
		const output: string[] = [];
		for (let index = 0; index < live.length; index++) {
			const allocated = allocation[index]!;
			this.#setAllocation(live[index]!.component, allocated, frame);
			const rendered = trimBlankEdges(live[index]!.component.render(width));
			if (rendered.length <= allocated) output.push(...rendered);
			else output.push(...rendered.slice(rendered.length - allocated));
		}
		return output.length > capacity ? output.slice(output.length - capacity) : output;
	}

	/**
	 * Offer the settled prefix that must retire for the live tail to fit
	 * `capacity` rows. Blocks stay live (re-rendering at the current width)
	 * while room remains; the offer stands until the terminal acknowledges it.
	 */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;
		const heights: number[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			this.#setAllocation(live[index]!.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = trimBlankEdges(live[index]!.component.render(width));
			heights[index] = rendered.length;
			if (rendered.length > 0) total += rendered.length + (visible++ > 0 ? 1 : 0);
		}
		const overflowing = total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (!overflowing) return undefined;
		// Retire the longest settled prefix needed to fit; commit order is
		// absolute, so retirement stops at the first still-active block.
		let end = this.#frontier;
		let freed = 0;
		let index = 0;
		while (end < this.#entries.length && this.#entries[end]!.state === "settled") {
			if (total - freed <= room && this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS) break;
			freed += heights[index]! > 0 ? heights[index]! + 1 : 0;
			end++;
			index++;
		}
		if (end === this.#frontier) return undefined;
		const rows: string[] = [];
		for (let retire = this.#frontier; retire < end; retire++) {
			this.#setAllocation(this.#entries[retire]!.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(this.#entries[retire]!.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		if (rows.length > 0) rows.push("");
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows };
		this.#offered = { batch, end };
		return batch;
	}

	/** Retire exactly the history batch most recently offered by this container. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		for (let index = this.#frontier; index < offered.end; index++) {
			this.#entries[index]!.state = "committed";
		}
		this.#frontier = offered.end;
		this.#offered = undefined;
	}

	/**
	 * Full semantic render used by exports and non-terminal commands.
	 *
	 * The leading run of finalized blocks whose bytes are provably stable is
	 * replayed from the persistent segment array instead of re-rendered:
	 * identity (same child at the same offset), width/generation, a finality +
	 * version re-check captured per segment, and the process-wide sealed-
	 * mutation epoch ({@link noteSealedTranscriptMutation}) together prove the
	 * stored separators/contributions still match what a fresh walk would
	 * produce. Re-validation runs whenever the child list or the sealed epoch
	 * moved, plus a periodic pass bounding any missed pairing; everything after
	 * the first divergence renders normally so late results, post-finalize
	 * re-layouts, and expand toggles remain visible. A block render throwing
	 * mid-walk poisons the segment array (#segmentsClean stays false) and the
	 * next render rebuilds it fresh instead of reusing half a frame.
	 */
	override render(width: number): readonly string[] {
		width = Math.max(1, width);
		const count = this.children.length;

		// Stability requires the same width, a previous walk that COMPLETED,
		// and, per segment, the same block at the same offset returning the
		// same array reference. The first divergence truncates the persistent
		// array there; everything after re-pushes.
		let chainStable = this.#segmentsClean && this.#renderWidth === width;
		this.#renderWidth = width;
		// Entry-unstable (width change, or the previous walk threw mid-frame
		// and left #segments partially rewritten while #lines was truncated
		// with only a prefix re-pushed): the divergence truncation inside the
		// loop only fires on a stable→unstable transition, so reset the
		// persistent arrays here to keep the
		// `!chainStable ⇒ lines.length === row` invariant — otherwise re-pushed
		// rows land after the stale frame, and a stale suffix segment whose
		// geometry numerically coincides with the new cursor would be marked
		// stable while its rows are no longer in #lines.
		const lines = this.#lines;
		if (!chainStable) lines.length = 0;

		// #segments is persistent across frames: a stable frame rewrites only
		// entries from the first divergence on. A fresh array is built after a
		// poisoned walk or a width change, which invalidates every carried
		// segment. Until the walk completes the carried state is untrusted.
		const rebuild = !this.#segmentsClean || !chainStable;
		const previousSegments = this.#segments;
		const segments = rebuild ? (new Array(count) as BlockSegment[]) : previousSegments;
		this.#segmentsClean = false;

		// Frame row cursor: rows emitted (reused or pushed) so far.
		let row = 0;

		// Compacted finalized run: its rows already sit in the persistent frame
		// (the stable chain never rewrote them) and its separators and stripped
		// contributions are baked into the stored segments, so replay skips
		// re-deriving any of it per frame. Correctness of the wholesale replay
		// is re-proven whenever anything that could disturb sealed history
		// moved: the child list, or the process-wide sealed-mutation epoch fed
		// by the blocks themselves (plus a periodic validation pass).
		let runStart = 0;
		if (chainStable && !rebuild && this.#committedRunLength > 0) {
			const runLength = Math.min(this.#committedRunLength, count);
			this.#framesSinceValidation++;
			const periodicDue = this.#framesSinceValidation > 256;
			const epochMoved = sealedMutationEpoch !== this.#runSealedEpoch || periodicDue;
			if (this.#childListEpoch === this.#runChildListEpoch && !epochMoved) {
				// Wholesale replay: nothing can have disturbed sealed history.
				runStart = runLength;
			} else {
				let k = 0;
				while (k < runLength) {
					const previous = previousSegments[k];
					const child = this.children[k];
					if (previous === undefined || child === undefined || previous.component !== child) break;
					// Fresh finality/version re-check: the same guarantee the
					// full walk's committedReusable check enforces, via the
					// validator captured on the segment when it was built.
					const replayCheck = previous.replayCheck;
					if (replayCheck !== undefined && !replayCheck()) break;
					k++;
				}
				runStart = k;
				this.#framesSinceValidation = 0;
				this.#runSealedEpoch = sealedMutationEpoch;
			}
			this.#runChildListEpoch = this.#childListEpoch;
			this.#committedRunLength = runStart;
			if (runStart > 0) {
				const last = previousSegments[runStart - 1]!;
				row = last.startRow + last.rowCount;
			}
		} else {
			this.#committedRunLength = 0;
		}

		for (let i = runStart; i < count; i++) {
			const child = this.children[i]!;

			// This child's contribution: its current render with plain-blank
			// top/bottom edges stripped (the container owns inter-block gaps).
			// Finalized blocks whose recorded bytes are provably stable reuse
			// their previous contribution without calling render(). Blocks
			// outside that proof still render normally so late results,
			// post-finalize re-layouts, and expand toggles remain visible.
			const previous = previousSegments[i];
			const finalizedCheck = (child as Component & FinalizableBlock).isTranscriptBlockFinalized;
			const finalized = finalizedCheck ? finalizedCheck.call(child) : true;
			const versionGet = (child as Component & FinalizableBlock).getTranscriptBlockVersion;
			const version = versionGet ? versionGet.call(child) : undefined;
			const replayCheck =
				finalizedCheck || versionGet
					? () => {
							if (finalizedCheck && !finalizedCheck.call(child)) return false;
							if (versionGet && versionGet.call(child) !== version) return false;
							return true;
						}
					: undefined;
			const committedReusable =
				previous !== undefined &&
				previous.component === child &&
				previous.width === width &&
				previous.generation === this.#generation &&
				previous.startRow === row &&
				finalized &&
				// Only replay bytes that were themselves produced by a finalized
				// render: a block finalizing between frames may have changed
				// content while unfinalized, so the first post-transition frame
				// must render.
				previous.finalized &&
				// Post-finalize mutations (inline error restore, late tool images)
				// bump the block version; a mismatch forces a real render so the
				// change becomes observable.
				previous.version === version;
			const raw = committedReusable ? previous.rawRef : child.render(width);
			const reusable =
				committedReusable ||
				(previous !== undefined &&
					previous.component === child &&
					previous.rawRef === raw &&
					previous.width === width &&
					previous.generation === this.#generation);
			const contribution = reusable ? previous.contribution : trimBlankEdges(raw);

			// Empty (or stripped-to-nothing) children contribute nothing and
			// never affect spacing.
			if (contribution.length === 0) {
				if (chainStable && !(reusable && previous.rowCount === 0 && previous.startRow === row)) {
					chainStable = false;
					lines.length = row;
				}
				segments[i] = {
					component: child,
					rawRef: raw,
					contribution,
					width,
					generation: this.#generation,
					startRow: row,
					rowCount: 0,
					sep: 0,
					finalized,
					version,
					replayCheck,
				};
				continue;
			}

			// Every block is separated from preceding visible content by exactly
			// one blank row — skipped when it opens the transcript or the prior
			// row is already a plain blank (a fragment's own trailing pad), never
			// doubling. `lines[row - 1]` is valid in both cases: reused rows are
			// still present in the persistent array, re-pushed rows were just
			// written.
			const sep = row > 0 && !isPlainBlank(lines[row - 1]!) ? 1 : 0;
			const rowCount = sep + contribution.length;
			const stable = chainStable && reusable && previous.startRow === row && previous.sep === sep;
			if (!stable) {
				if (chainStable) {
					chainStable = false;
					lines.length = row;
				}
				if (sep) lines.push("");
				for (let j = 0; j < contribution.length; j++) lines.push(contribution[j]!);
			}

			segments[i] = {
				component: child,
				rawRef: raw,
				contribution,
				width,
				generation: this.#generation,
				startRow: row,
				rowCount,
				sep,
				finalized,
				version,
				replayCheck,
			};
			row += rowCount;
		}
		// Trailing shrink: blocks removed from the tail leave stale rows behind
		// when every surviving segment was reused.
		if (lines.length !== row) lines.length = row;
		if (segments.length !== count) segments.length = count;
		if (segments !== this.#segments) this.#segments = segments;
		this.#segmentsClean = true;

		// Extend the compacted run over newly stabilized leading blocks. Each
		// step reads one freshly walked segment's finalized flag, so the scan
		// costs O(newly absorbed) per frame, not O(history). A segment only
		// counts when the walk above observed the block finalized AFTER a real
		// render — a just-finalized block re-rendered at least once before its
		// bytes are trusted as replayable history.
		let runLength = this.#committedRunLength;
		while (runLength < count) {
			const segment = segments[runLength]!;
			if (!segment.finalized || segment.component !== this.children[runLength]) break;
			runLength++;
		}
		this.#committedRunLength = runLength;
		return lines;
	}

	#renderEmergency(
		live: readonly TranscriptEntry[],
		width: number,
		rows: number,
		frame: AnimationFrame,
	): readonly string[] {
		const output: string[] = [];
		const hiddenCount = Math.max(0, live.length - rows);
		let hiddenActive = 0;
		for (let index = 0; index < hiddenCount; index++) {
			if (live[index]!.state === "active") hiddenActive++;
		}
		if (hiddenActive > 0) output.push(`${hiddenActive} more transcript blocks active`);
		const visibleRows = rows - output.length;
		const visible = visibleRows > 0 ? live.slice(-visibleRows) : [];
		for (const entry of visible) {
			this.#setAllocation(entry.component, 1, frame);
			output.push(entry.component.render(width)[0] ?? "");
		}
		return output.slice(0, rows);
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}

	#settleFinalized(): void {
		for (const entry of this.#entries) {
			if (entry.state === "active" && isFinalized(entry.component)) entry.state = "settled";
		}
	}

	/** Live entries: past the committed frontier and not in the offered batch. */
	#liveEntries(): TranscriptEntry[] {
		const start = this.#offered?.end ?? this.#frontier;
		return this.#entries.slice(start);
	}

	*#liveBlocks(width: number): Generator<readonly string[]> {
		for (const entry of this.#liveEntries()) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			yield trimBlankEdges(entry.component.render(width));
		}
	}

	#liveCount(): number {
		return this.#entries.length - this.#frontier;
	}

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(component => existing.get(component) ?? { component, state: "active" });
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}
}

/** Groups sibling rows into one semantic transcript block. */
export class TranscriptBlock extends Container {}
