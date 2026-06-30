import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getSegmenter } from "@oh-my-pi/pi-tui";
import { LRUCache } from "lru-cache/raw";
import { formatThinkingForDisplay, hasDisplayableThinking } from "../../utils/thinking-display";
import type { AssistantMessageComponent } from "../components/assistant-message";

export const STREAMING_REVEAL_FRAME_MS = 1000 / 30;
export const MIN_STEP = 3;
export const CATCHUP_FRAMES = 8;

type AssistantContentBlock = AssistantMessage["content"][number];
type DisplayThinkingContentBlock = Extract<AssistantContentBlock, { type: "thinking" }> & { rawThinking?: string };
type StreamingRevealComponent = Pick<AssistantMessageComponent, "updateContent">;

type StreamingRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	getHideThinkingBlock(): boolean;
	getProseOnlyThinking(): boolean;
	requestRender(): void;
};

const graphemeCountCache = new LRUCache<string, number>({ max: 128 });

function countGraphemes(text: string): number {
	if (text.length === 0) return 0;
	const cached = graphemeCountCache.get(text);
	if (cached !== undefined) return cached;
	let count = 0;
	for (const _segment of getSegmenter().segment(text)) {
		count += 1;
	}
	graphemeCountCache.set(text, count);
	return count;
}

/** Count graphemes of `text` from code-unit offset `start`, also reporting the
 *  start offset of the final grapheme (where an append could extend a cluster). */
function countGraphemesFrom(text: string, start: number): { count: number; tailStart: number } {
	let count = 0;
	let tailStart = start;
	for (const seg of getSegmenter().segment(start === 0 ? text : text.slice(start))) {
		count += 1;
		tailStart = start + seg.index;
	}
	return { count, tailStart };
}

/** Memoizes per-block grapheme counts across reveal ticks. Streaming blocks only
 *  grow by appending, and an append can only alter the final grapheme cluster of
 *  the previous text, so only the suffix from that cluster needs re-segmenting. */
export class BlockUnitCounter {
	#entries = new Map<number, { text: string; count: number; tailStart: number }>();
	#slices = new Map<number, { text: string; units: number; end: number; lastStart: number; slice: string }>();

	count(index: number, text: string): number {
		const entry = this.#entries.get(index);
		if (entry !== undefined) {
			if (entry.text === text) return entry.count;
			if (entry.count > 0 && text.length > entry.text.length && text.startsWith(entry.text)) {
				const tail = countGraphemesFrom(text, entry.tailStart);
				const next = { text, count: entry.count - 1 + tail.count, tailStart: tail.tailStart };
				this.#entries.set(index, next);
				return next.count;
			}
		}
		const full = countGraphemesFrom(text, 0);
		this.#entries.set(index, { text, count: full.count, tailStart: full.tailStart });
		return full.count;
	}

	/** Slice the first `units` graphemes of `text`, memoized per block across
	 *  reveal ticks. Streaming blocks grow append-only, and an append can only
	 *  alter the final grapheme cluster of the previous text, so once a block's
	 *  slice is known the suffix from that boundary cluster is all that must be
	 *  re-segmented — turning a per-tick O(revealed) slice into O(delta).
	 *
	 *  Invariant: only an EXACT text+units match skips segmentation. A same-unit
	 *  append can still extend the boundary cluster ("a" → "a\u0301" stays one
	 *  grapheme), so the `startsWith` fast path always re-segments from that
	 *  cluster's start (`lastStart`). */
	slice(index: number, text: string, units: number): string {
		if (units <= 0 || text.length === 0) return "";
		// Clamp to the block's actual grapheme count. A cached `units` beyond the
		// text would let an append fast-path under-slice, so the cache must never
		// store one. count() is memoized per block and already warm by now.
		const total = this.count(index, text);
		if (units >= total) return text;
		const cached = this.#slices.get(index);
		// Exact hit: identical text and unit count → reuse the cached slice verbatim.
		if (cached !== undefined && cached.text === text && cached.units === units) {
			return cached.slice;
		}
		// Incremental: text grew by appending (or is unchanged) and we want at least
		// as many units. Graphemes before the cached boundary cluster are stable, so
		// re-segment only from `lastStart` for `units - cached.units + 1` clusters —
		// the first of which is the boundary cluster, possibly extended by the append.
		if (cached !== undefined && cached.units >= 1 && text.startsWith(cached.text) && units >= cached.units) {
			const need = units - cached.units + 1;
			let taken = 0;
			let lastStart = cached.lastStart;
			let end = cached.lastStart;
			const from = cached.lastStart === 0 ? text : text.slice(cached.lastStart);
			for (const seg of getSegmenter().segment(from)) {
				taken += 1;
				lastStart = cached.lastStart + seg.index;
				end = lastStart + seg.segment.length;
				if (taken >= need) break;
			}
			const slice = end >= text.length ? text : text.slice(0, end);
			this.#slices.set(index, { text, units, end, lastStart, slice });
			return slice;
		}
		// Full re-segment: new block, shrunk units, or replaced text.
		const meta = sliceGraphemesMeta(text, units);
		this.#slices.set(index, { text, units, end: meta.end, lastStart: meta.lastStart, slice: meta.slice });
		return meta.slice;
	}

	reset(): void {
		this.#entries.clear();
		this.#slices.clear();
	}
}

function sliceGraphemes(text: string, units: number): string {
	if (units <= 0 || text.length === 0) return "";
	let count = 0;
	for (const { index, segment } of getSegmenter().segment(text)) {
		count += 1;
		if (count >= units) {
			const end = index + segment.length;
			return end >= text.length ? text : text.slice(0, end);
		}
	}
	return text;
}

/** Slice the first `units` graphemes of `text`, also reporting the code-unit
 *  end of the final cluster and where it begins — the point from which an
 *  append could extend that cluster. Used by {@link BlockUnitCounter.slice}. */
function sliceGraphemesMeta(text: string, units: number): { slice: string; end: number; lastStart: number } {
	if (units <= 0 || text.length === 0) return { slice: "", end: 0, lastStart: 0 };
	let count = 0;
	let lastStart = 0;
	for (const { index, segment } of getSegmenter().segment(text)) {
		count += 1;
		lastStart = index;
		if (count >= units) {
			const end = index + segment.length;
			return { slice: end >= text.length ? text : text.slice(0, end), end, lastStart };
		}
	}
	return { slice: text, end: text.length, lastStart };
}

export function visibleUnits(message: AssistantMessage, hideThinking: boolean, proseOnly = true): number {
	let total = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			total += countGraphemes(block.text);
		} else if (block.type === "thinking" && !hideThinking) {
			const formatted = formatThinkingForDisplay(block.thinking, proseOnly);
			if (hasDisplayableThinking(block.thinking, formatted)) {
				total += countGraphemes(formatted);
			}
		}
	}
	return total;
}

function revealTextBlock(
	block: Extract<AssistantContentBlock, { type: "text" }>,
	index: number,
	remaining: number,
	units: number,
	sliceOf: (index: number, text: string, units: number) => string,
): AssistantContentBlock {
	if (remaining <= 0) return block.text.length === 0 ? block : { ...block, text: "" };
	if (remaining >= units) return block;
	return { ...block, text: sliceOf(index, block.text, remaining) };
}

function revealThinkingBlock(
	block: Extract<AssistantContentBlock, { type: "thinking" }>,
	index: number,
	remaining: number,
	units: number,
	sliceOf: (index: number, text: string, units: number) => string,
): AssistantContentBlock {
	if (remaining <= 0) return block.thinking.length === 0 ? block : { ...block, thinking: "" };
	if (remaining >= units) return block;
	return { ...block, thinking: sliceOf(index, block.thinking, remaining) };
}

export function buildDisplayMessage(
	target: AssistantMessage,
	revealed: number,
	hideThinking: boolean,
	proseOnly = true,
	countOf: (index: number, text: string) => number = (_index, text) => countGraphemes(text),
	sliceOf: (index: number, text: string, units: number) => string = (_index, text, units) =>
		sliceGraphemes(text, units),
): AssistantMessage {
	let remaining = Math.max(0, Math.floor(revealed));
	const content: AssistantContentBlock[] = [];
	for (let i = 0; i < target.content.length; i++) {
		const block = target.content[i]!;
		if (block.type === "text") {
			const units = countOf(i, block.text);
			content.push(revealTextBlock(block, i, remaining, units, sliceOf));
			remaining = Math.max(0, remaining - units);
		} else if (block.type === "thinking" && !hideThinking) {
			const formatted = formatThinkingForDisplay(block.thinking, proseOnly);
			if (hasDisplayableThinking(block.thinking, formatted)) {
				const units = countOf(i, formatted);
				const displayBlock: DisplayThinkingContentBlock = {
					...block,
					thinking: formatted,
					rawThinking: block.thinking,
				};
				content.push(revealThinkingBlock(displayBlock, i, remaining, units, sliceOf));
				remaining = Math.max(0, remaining - units);
			} else {
				content.push(block);
			}
		} else {
			content.push(block);
		}
	}
	return { ...target, content };
}

export function nextStep(backlog: number): number {
	return Math.max(MIN_STEP, Math.ceil(Math.max(0, backlog) / CATCHUP_FRAMES));
}

export class StreamingRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #getHideThinkingBlock: () => boolean;
	readonly #getProseOnlyThinking: () => boolean;
	readonly #requestRender: () => void;
	#target: AssistantMessage | undefined;
	#component: StreamingRevealComponent | undefined;
	#timer: NodeJS.Timeout | undefined;
	#revealed = 0;
	#hideThinkingBlock = false;
	#proseOnlyThinking = true;
	#smoothStreaming = true;
	readonly #unitCounter = new BlockUnitCounter();
	readonly #countOf = (index: number, text: string): number => this.#unitCounter.count(index, text);
	readonly #sliceOf = (index: number, text: string, units: number): string =>
		this.#unitCounter.slice(index, text, units);

	constructor(options: StreamingRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#getHideThinkingBlock = options.getHideThinkingBlock;
		this.#getProseOnlyThinking = options.getProseOnlyThinking;
		this.#requestRender = options.requestRender;
	}

	begin(component: StreamingRevealComponent, message: AssistantMessage): void {
		this.stop();
		this.#component = component;
		this.#target = message;
		this.#revealed = 0;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		this.#smoothStreaming = this.#getSmoothStreaming();
		if (!this.#smoothStreaming) {
			const total = this.#visibleUnits(message);
			component.updateContent(
				buildDisplayMessage(
					message,
					total,
					this.#hideThinkingBlock,
					this.#proseOnlyThinking,
					this.#countOf,
					this.#sliceOf,
				),
				{ transient: true },
			);
			return;
		}
		const total = this.#visibleUnits(message);
		if (message.content.some(block => block.type === "toolCall")) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealed = total;
			component.updateContent(
				buildDisplayMessage(
					message,
					this.#revealed,
					this.#hideThinkingBlock,
					this.#proseOnlyThinking,
					this.#countOf,
					this.#sliceOf,
				),
				{
					transient: true,
				},
			);
			return;
		}
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	setTarget(message: AssistantMessage): void {
		this.#target = message;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		this.#smoothStreaming = this.#getSmoothStreaming();
		if (!this.#component) return;
		if (!this.#smoothStreaming) {
			const total = this.#visibleUnits(message);
			this.#component.updateContent(
				buildDisplayMessage(
					message,
					total,
					this.#hideThinkingBlock,
					this.#proseOnlyThinking,
					this.#countOf,
					this.#sliceOf,
				),
				{ transient: true },
			);
			return;
		}
		const total = this.#visibleUnits(message);
		if (message.content.some(block => block.type === "toolCall")) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealed = total;
			this.#stopTimer();
			this.#component.updateContent(
				buildDisplayMessage(
					message,
					this.#revealed,
					this.#hideThinkingBlock,
					this.#proseOnlyThinking,
					this.#countOf,
					this.#sliceOf,
				),
				{
					transient: true,
				},
			);
			return;
		}
		if (this.#revealed > total) {
			this.#revealed = total;
		}
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	stop(): void {
		this.#stopTimer();
		this.#target = undefined;
		this.#component = undefined;
		this.#revealed = 0;
		this.#unitCounter.reset();
	}

	/**
	 * Re-read cached visibility flags (hideThinkingBlock, proseOnlyThinking)
	 * and re-render the current target. Called when the thinking level changes
	 * mid-stream so the reveal controller doesn't keep rendering with stale values.
	 */
	resyncVisibility(): void {
		if (!this.#target || !this.#component) return;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		// Recalculate visible units — hiding thinking blocks may reduce the total,
		// and the reveal position may now exceed it.
		const total = this.#visibleUnits(this.#target);
		this.#revealed = Math.min(this.#revealed, total);
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	/** Total reveal units of `message`, memoized per block across ticks. */
	#visibleUnits(message: AssistantMessage): number {
		let total = 0;
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i]!;
			if (block.type === "text") {
				total += this.#unitCounter.count(i, block.text);
			} else if (block.type === "thinking" && !this.#hideThinkingBlock) {
				const formatted = formatThinkingForDisplay(block.thinking, this.#proseOnlyThinking);
				if (hasDisplayableThinking(block.thinking, formatted)) {
					total += this.#unitCounter.count(i, formatted);
				}
			}
		}
		return total;
	}

	#renderCurrent(): void {
		if (!this.#target || !this.#component) return;
		// Every controller render is an in-flight streaming snapshot, even when
		// smooth reveal has temporarily caught up to the current target. The
		// message_end handler performs the only stable non-transient render.
		this.#component.updateContent(
			buildDisplayMessage(
				this.#target,
				this.#revealed,
				this.#hideThinkingBlock,
				this.#proseOnlyThinking,
				this.#countOf,
				this.#sliceOf,
			),
			{ transient: true },
		);
	}

	#syncTimer(total = this.#target ? this.#visibleUnits(this.#target) : 0): void {
		if (!this.#target || !this.#component || this.#revealed >= total) {
			this.#stopTimer();
			return;
		}
		this.#startTimer();
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick();
		}, STREAMING_REVEAL_FRAME_MS);
		this.#timer.unref?.();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#tick(): void {
		const target = this.#target;
		const component = this.#component;
		if (!target || !component) {
			this.stop();
			return;
		}
		const total = this.#visibleUnits(target);
		if (this.#revealed >= total) {
			this.#stopTimer();
			return;
		}
		this.#revealed = Math.min(total, this.#revealed + nextStep(total - this.#revealed));
		component.updateContent(
			buildDisplayMessage(
				target,
				this.#revealed,
				this.#hideThinkingBlock,
				this.#proseOnlyThinking,
				this.#countOf,
				this.#sliceOf,
			),
			{
				transient: true,
			},
		);
		this.#requestRender();
		if (this.#revealed >= total) {
			this.#stopTimer();
		}
	}
}
