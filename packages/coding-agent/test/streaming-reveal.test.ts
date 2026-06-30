import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import {
	BlockUnitCounter,
	buildDisplayMessage,
	CATCHUP_FRAMES,
	MIN_STEP,
	nextStep,
	STREAMING_REVEAL_FRAME_MS,
	StreamingRevealController,
	visibleUnits,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/streaming-reveal";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getSegmenter } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme(false);
});

function makeUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: 0,
	};
}

function textAt(message: AssistantMessage, index: number): string {
	const block = message.content[index];
	if (block?.type !== "text") {
		throw new Error(`Expected text block at index ${index}`);
	}
	return block.text;
}

function thinkingAt(message: AssistantMessage, index: number): string {
	const block = message.content[index];
	if (block?.type !== "thinking") {
		throw new Error(`Expected thinking block at index ${index}`);
	}
	return block.thinking;
}

class RecordingComponent {
	messages: AssistantMessage[] = [];
	transientFlags: Array<boolean | undefined> = [];

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.messages.push(message);
		this.transientFlags.push(opts?.transient);
	}
}

function latestMessage(component: RecordingComponent): AssistantMessage {
	const message = component.messages.at(-1);
	if (!message) {
		throw new Error("Expected at least one rendered message");
	}
	return message;
}

function makeController(
	options: { smooth?: boolean; hideThinking?: boolean; proseOnly?: () => boolean; requestRender?: () => void } = {},
) {
	const component = new RecordingComponent();
	const controller = new StreamingRevealController({
		getSmoothStreaming: () => options.smooth ?? true,
		getHideThinkingBlock: () => options.hideThinking ?? false,
		getProseOnlyThinking: options.proseOnly ?? (() => true),
		requestRender: options.requestRender ?? (() => {}),
	});
	return { component, controller };
}

describe("streaming reveal", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("slices at grapheme boundaries without mutating the target message", () => {
		const familyEmoji = "👨‍👩‍👧‍👦";
		const target = makeMessage([{ type: "text", text: `${familyEmoji}B` }]);

		expect(visibleUnits(target, false)).toBe(2);
		const display = buildDisplayMessage(target, 1, false);

		expect(textAt(display, 0)).toBe(familyEmoji);
		expect(textAt(target, 0)).toBe(`${familyEmoji}B`);
	});

	it("excludes hidden thinking from the reveal budget and passes it through", () => {
		const thinkingBlock = { type: "thinking" as const, thinking: "thought" };
		const target = makeMessage([thinkingBlock, { type: "text", text: "answer" }]);

		expect(visibleUnits(target, true)).toBe("answer".length);
		const display = buildDisplayMessage(target, 1, true);

		expect(display.content[0]).toBe(thinkingBlock);
		expect(thinkingAt(display, 0)).toBe("thought");
		expect(textAt(display, 1)).toBe("a");
	});

	it("excludes dot-only reasoning placeholders from the reveal budget", () => {
		const thinkingBlock = { type: "thinking" as const, thinking: "...", thinkingSignature: "reasoning_content" };
		const target = makeMessage([thinkingBlock, { type: "text", text: "answer" }]);

		expect(visibleUnits(target, false)).toBe("answer".length);
		const display = buildDisplayMessage(target, 1, false);

		expect(display.content[0]).toBe(thinkingBlock);
		expect(textAt(display, 1)).toBe("a");
	});

	it("keeps pure-code thinking visible as an ascii ellipsis", () => {
		const target = makeMessage([
			{ type: "thinking", thinking: "```js\nconst x = 1;\n```" },
			{ type: "text", text: "answer" },
		]);

		expect(visibleUnits(target, false)).toBe("...answer".length);
		const display = buildDisplayMessage(target, 3, false);

		expect(thinkingAt(display, 0)).toBe("...");
		expect(textAt(display, 1)).toBe("");

		const component = new AssistantMessageComponent(display);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("...");
	});

	it("refreshes prose-only setting during unsmoothed streaming updates", () => {
		let proseOnly = true;
		const target = makeMessage([{ type: "thinking", thinking: "```js\nconst x = 1;\n```" }]);
		const { component, controller } = makeController({ smooth: false, proseOnly: () => proseOnly });

		controller.begin(component, target);
		expect(thinkingAt(latestMessage(component), 0)).toBe("...");

		proseOnly = false;
		controller.setTarget(target);
		expect(thinkingAt(latestMessage(component), 0)).toBe("```js\nconst x = 1;\n```");
	});

	it("smooths thinking content when thinking is shown", () => {
		const target = makeMessage([
			{ type: "thinking", thinking: "thought" },
			{ type: "text", text: "answer" },
		]);

		expect(visibleUnits(target, false)).toBe("thoughtanswer".length);
		const display = buildDisplayMessage(target, 3, false);

		expect(thinkingAt(display, 0)).toBe("tho");
		expect(textAt(display, 1)).toBe("");
	});

	it("uses an adaptive catchup step with the configured floor", () => {
		const largeBacklog = CATCHUP_FRAMES * 101;
		const step = nextStep(largeBacklog);

		expect(step).toBe(101);
		expect(step * CATCHUP_FRAMES).toBeGreaterThanOrEqual(largeBacklog);
		expect(nextStep(1)).toBe(MIN_STEP);
		expect(nextStep(MIN_STEP * CATCHUP_FRAMES)).toBe(MIN_STEP);
	});

	it("reveals cumulative targets to the exact final text with monotonic prefixes", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const first = makeMessage([{ type: "text", text: "Hello" }]);
		const second = makeMessage([{ type: "text", text: "Hello world" }]);

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(first);
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		controller.setTarget(second);
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}

		const renderedTexts = component.messages.map(message => textAt(message, 0));
		expect(renderedTexts.at(-1)).toBe("Hello world");
		for (let i = 1; i < renderedTexts.length; i++) {
			expect(renderedTexts[i].length).toBeGreaterThanOrEqual(renderedTexts[i - 1].length);
			expect("Hello world".startsWith(renderedTexts[i])).toBe(true);
		}
	});

	it("keeps grapheme counts correct when an append extends the final cluster", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "ab👨" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		// The appended ZWJ sequence merges into the previous final grapheme:
		// "👨" + "\u200D👩" becomes a single cluster, so the cached per-block
		// count must re-segment from that cluster, not just add the suffix.
		controller.setTarget(makeMessage([{ type: "text", text: "ab👨\u200D👩x" }]));
		for (let i = 0; i < 6; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}

		expect(textAt(latestMessage(component), 0)).toBe("ab👨\u200D👩x");
	});

	it("renders full targets immediately when smoothing is disabled", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ smooth: false, requestRender });

		controller.begin(component, makeMessage([{ type: "text", text: "chunk" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "chunky" }]));
		const updates = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(textAt(latestMessage(component), 0)).toBe("chunky");
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("marks unsmoothed in-flight updates as transient", () => {
		const { component, controller } = makeController({ smooth: false });

		controller.begin(component, makeMessage([{ type: "text", text: "chunk" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "chunky" }]));

		expect(component.transientFlags).toEqual([true, true]);
	});

	it("keeps smooth catch-up renders transient until the final message_end render", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abc" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);

		expect(textAt(latestMessage(component), 0)).toBe("abc");
		expect(component.transientFlags).not.toHaveLength(0);
		expect(component.transientFlags.every(flag => flag === true)).toBe(true);
	});

	it("stop halts pending ticker updates", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		controller.stop();
		const updates = component.messages.length;
		const lastText = textAt(latestMessage(component), 0);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(component.messages).toHaveLength(updates);
		expect(textAt(latestMessage(component), 0)).toBe(lastText);
	});

	it("snaps to full text when a tool call arrives", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ requestRender });

		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(textAt(latestMessage(component), 0)).toBe("abc");

		controller.setTarget(
			makeMessage([
				{ type: "text", text: "abcdefghi" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			]),
		);
		const updates = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(textAt(latestMessage(component), 0)).toBe("abcdefghi");
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});

/** Pure reference slice: the first `units` graphemes of `text`, segmenting the
 *  whole string each call (the O(revealed) behaviour the counter must match). */
function pureSlice(text: string, units: number): string {
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

describe("BlockUnitCounter.slice", () => {
	it("matches the reference for fixed text with growing units", () => {
		const counter = new BlockUnitCounter();
		const text = "Hello, world — güten tag 👋";
		for (let units = 0; units <= 30; units++) {
			expect(counter.slice(0, text, units)).toBe(pureSlice(text, units));
		}
	});

	it("matches the reference across an append-only stream with growing units", () => {
		const counter = new BlockUnitCounter();
		const full = "the quick brown fox jumps over the lazy dog. ".repeat(3);
		let text = "";
		for (const chunk of full.match(/.{1,7}/g) ?? []) {
			text += chunk;
			const total = counter.count(0, text);
			for (let units = 0; units <= total; units += 3) {
				expect(counter.slice(0, text, units)).toBe(pureSlice(text, units));
			}
		}
	});

	it("re-segments when an append extends the boundary cluster (combining mark)", () => {
		// "a" cached at 1 grapheme; text grows to "a\u0301" — still one grapheme,
		// but the cluster is now longer. A stale cache would return "a".
		const counter = new BlockUnitCounter();
		expect(counter.slice(0, "a", 1)).toBe("a");
		expect(counter.slice(0, "a\u0301", 1)).toBe("a\u0301");
		expect(counter.slice(0, "a\u0301b", 2)).toBe("a\u0301b");
	});

	it("re-segments when an append merges a ZWJ sequence", () => {
		// "ab👨" (3 graphemes) grows to "ab👨\u200D👩x" — the ZWJ merges the two
		// emoji into one cluster, so the count stays 3→4 and the 3rd cluster grows.
		const counter = new BlockUnitCounter();
		expect(counter.slice(0, "ab👨", 3)).toBe("ab👨");
		expect(counter.slice(0, "ab👨\u200D👩", 3)).toBe("ab👨\u200D👩");
		expect(counter.slice(0, "ab👨\u200D👩x", 4)).toBe("ab👨\u200D👩x");
	});

	it("handles shrunk units via full re-segment", () => {
		const counter = new BlockUnitCounter();
		const text = "abcdefgh";
		expect(counter.slice(0, text, 6)).toBe("abcdef");
		// Fewer units than cached — cannot extend the boundary cluster backwards.
		expect(counter.slice(0, text, 3)).toBe("abc");
		expect(counter.slice(0, text, 1)).toBe("a");
	});

	it("full re-segments when text is replaced", () => {
		const counter = new BlockUnitCounter();
		expect(counter.slice(0, "abcdef", 3)).toBe("abc");
		// Unrelated text at the same index — no shared prefix.
		expect(counter.slice(0, "xyz123", 2)).toBe("xy");
	});

	it("clamps units beyond the total and never returns a stale prefix", () => {
		// Regression: a cached `units` past the end would let an append fast-path
		// under-slice. Asking for more graphemes than exist must yield the full text.
		const counter = new BlockUnitCounter();
		expect(counter.slice(0, "ab", 5)).toBe("ab");
		expect(counter.slice(0, "abc", 5)).toBe("abc");
		expect(counter.slice(0, "abcdef", 5)).toBe("abcde");
	});

	it("keeps independent cache entries per block index", () => {
		const counter = new BlockUnitCounter();
		expect(counter.slice(0, "aaa", 2)).toBe("aa");
		expect(counter.slice(1, "bbbb", 3)).toBe("bbb");
		// Index 0's cache must be untouched by index 1's calls.
		expect(counter.slice(0, "aaa", 2)).toBe("aa");
		expect(counter.slice(0, "aaaa", 3)).toBe("aaa");
	});

	it("matches the reference across a randomized fuzz of streams", () => {
		const counter = new BlockUnitCounter();
		const alphabet = ["a", "b", "x", "\u0301", "👨", "\u200D", "👩", "\n", "c"];
		let seed = 1234567;
		const rand = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let block = 0; block < 5; block++) {
			let text = "";
			for (let step = 0; step < 40; step++) {
				text += alphabet[Math.floor(rand() * alphabet.length)] ?? "a";
				const total = counter.count(block, text);
				const units = Math.floor(rand() * (total + 2));
				expect(counter.slice(block, text, units)).toBe(pureSlice(text, units));
			}
			counter.reset();
		}
	});
});
