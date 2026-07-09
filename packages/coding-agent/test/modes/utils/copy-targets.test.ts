import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	buildCopyTargets,
	type CopySource,
	type CopyTarget,
	extractBlocks,
	extractCodeBlocks,
	extractLastCommand,
	extractQuoteBlocks,
} from "@oh-my-pi/pi-coding-agent/modes/utils/copy-targets";

function source(overrides: Partial<CopySource>): CopySource {
	return {
		messages: [],
		getLastVisibleHandoffText: () => undefined,
		...overrides,
	};
}

function byId(targets: CopyTarget[], id: string): CopyTarget | undefined {
	return targets.find(t => t.id === id);
}

function assistantText(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistantCalls(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>): AgentMessage {
	return {
		role: "assistant",
		content: toolCalls.map((tc, i) => ({ type: "toolCall", id: `tc-${i}`, name: tc.name, arguments: tc.arguments })),
	} as unknown as AgentMessage;
}

describe("extractCodeBlocks", () => {
	it("captures the language id and strips the trailing newline", () => {
		expect(extractCodeBlocks("intro\n```ts\nconst x = 1;\n```\ntail")).toEqual([
			{ lang: "ts", code: "const x = 1;" },
		]);
	});

	it("returns blocks in document order with empty lang for bare fences", () => {
		const blocks = extractCodeBlocks("```\nplain\n```\n\n```py\nprint(1)\n```");
		expect(blocks.map(b => b.lang)).toEqual(["", "py"]);
		expect(blocks.map(b => b.code)).toEqual(["plain", "print(1)"]);
	});
});

describe("extractQuoteBlocks", () => {
	it("collects a `>`-prefixed run and strips the marker plus one space", () => {
		const text = "intro\n> line one\n> line two\ntail";
		expect(extractQuoteBlocks(text)).toEqual([{ text: "line one\nline two" }]);
	});

	it("keeps bare `>` separator lines as blank lines and splits on plain text", () => {
		const text = "> first\n>\n> second\n\nbreak\n> later";
		expect(extractQuoteBlocks(text).map(b => b.text)).toEqual(["first\n\nsecond", "later"]);
	});

	it("does not treat `>` lines inside a fenced code block as a quote", () => {
		const text = "> real quote\n```\n> not a quote\n```";
		expect(extractQuoteBlocks(text)).toEqual([{ text: "real quote" }]);
	});
});

describe("extractBlocks", () => {
	it("emits a text block for bare prose", () => {
		expect(extractBlocks("Hello world")).toEqual([{ kind: "text", text: "Hello world" }]);
	});

	it("splits on blank lines into separate text blocks", () => {
		expect(extractBlocks("First\n\nSecond")).toEqual([
			{ kind: "text", text: "First" },
			{ kind: "text", text: "Second" },
		]);
	});

	it("treats a whitespace-only line as a text delimiter", () => {
		expect(extractBlocks("Block A\n   \nBlock B")).toEqual([
			{ kind: "text", text: "Block A" },
			{ kind: "text", text: "Block B" },
		]);
	});

	it("emits text, code, text in document order", () => {
		expect(extractBlocks("intro\n```ts\ncode\n```\noutro")).toEqual([
			{ kind: "text", text: "intro" },
			{ kind: "code", lang: "ts", code: "code" },
			{ kind: "text", text: "outro" },
		]);
	});

	it("blank lines inside a fenced block stay inside the code and do not create text blocks", () => {
		expect(extractBlocks("```py\nx = 1\n\ny = 2\n```")).toEqual([
			{ kind: "code", lang: "py", code: "x = 1\n\ny = 2" },
		]);
	});

	it("treats an unclosed fence as ordinary text", () => {
		expect(extractBlocks("Before\n```ts\nnot closed\nAfter")).toEqual([
			{ kind: "text", text: "Before\n```ts\nnot closed\nAfter" },
		]);
	});

	it("preserves list markers and headings inside text blocks", () => {
		expect(extractBlocks("# Heading\n\n- item one\n- item two")).toEqual([
			{ kind: "text", text: "# Heading" },
			{ kind: "text", text: "- item one\n- item two" },
		]);
	});

	it("a quote run flushes pending text first and text resumes after the run closes", () => {
		expect(extractBlocks("Intro\n> quoted\nRest")).toEqual([
			{ kind: "text", text: "Intro" },
			{ kind: "quote", text: "quoted" },
			{ kind: "text", text: "Rest" },
		]);
	});
});

describe("extractLastCommand", () => {
	it("returns the most recent bash command, walking backwards", () => {
		const messages = [
			assistantCalls([{ name: "bash", arguments: { command: "echo old" } }]),
			assistantCalls([{ name: "read", arguments: { path: "x" } }]),
			assistantCalls([
				{ name: "bash", arguments: { command: "echo a" } },
				{ name: "bash", arguments: { command: "echo b" } },
			]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(messages)).toEqual({ kind: "bash", code: "echo b", language: "bash" });
	});

	it("extracts eval code from flat args and reports the language", () => {
		const py = [
			assistantCalls([{ name: "eval", arguments: { language: "py", code: "print(1)" } }]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(py)).toEqual({ kind: "eval", code: "print(1)", language: "python" });

		const js = [
			assistantCalls([{ name: "eval", arguments: { language: "js", code: "log(1)" } }]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(js)?.language).toBe("javascript");
	});

	it("still joins legacy multi-cell eval args from older transcripts", () => {
		const py = [
			assistantCalls([
				{ name: "eval", arguments: { cells: [{ language: "py", code: "print(1)" }, { code: "print(2)" }] } },
			]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(py)).toEqual({ kind: "eval", code: "print(1)\n\nprint(2)", language: "python" });
	});
});

describe("buildCopyTargets", () => {
	it("lists assistant messages most-recent-first, drilling code-bearing ones", () => {
		const newer = "Newer message\n```ts\nconst a = 1;\n```\nand\n```py\nprint(2)\n```";
		const targets = buildCopyTargets(
			source({
				messages: [assistantText("Older message"), assistantText(newer)] as unknown as AgentMessage[],
			}),
		);

		// Newest first.
		expect(targets[0]?.id).toBe("msg:1");
		expect(targets[0]?.label).toBe("Newer message");
		expect(targets[1]?.id).toBe("msg:2");

		// The newer message is itself a copy target (full text) AND a tree node
		// exposing text spans and code blocks as child copy targets in document order.
		const group = targets[0]!;
		expect(group.content).toBe(newer);
		expect(group.children?.map(c => c.label)).toEqual(["Newer message", "Block 1", "and", "Block 2", "All 2 blocks"]);
		expect(group.children?.find(c => c.id === "msg:1:code:0")?.content).toBe("const a = 1;");
		expect(group.children?.find(c => c.id === "msg:1:code:0")?.language).toBe("ts"); // drives preview syntax highlighting
		expect(group.children?.at(-1)?.content).toBe("const a = 1;\n\nprint(2)");

		// The older, code-free message is a leaf that copies its full text.
		expect(targets[1]?.children).toBeUndefined();
		expect(targets[1]?.content).toBe("Older message");
	});

	it("exposes a single-block message as content plus one block child (no 'all')", () => {
		const targets = buildCopyTargets(
			source({ messages: [assistantText("Just one\n```js\nfoo();\n```")] as unknown as AgentMessage[] }),
		);
		const msg = byId(targets, "msg:1");
		expect(msg?.content).toBe("Just one\n```js\nfoo();\n```");
		expect(msg?.children?.map(c => c.label)).toEqual(["Just one", "Block 1"]);
	});

	it("drills a quoted message into a de-prefixed quote child", () => {
		const text = "Copy-paste to the other agent:\n\n> relay this\n> across agents";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		// The message node still copies the full markdown (with markers).
		expect(msg?.content).toBe(text);
		expect(msg?.hint).toBe("4 lines · 1 quote");
		const quote = msg?.children?.find(c => c.id === "msg:1:quote:0");
		expect(quote?.label).toBe("Quote 1");
		// The drilled child copies the un-prefixed quote, ready to paste onward.
		expect(quote?.content).toBe("relay this\nacross agents");
		expect(quote?.language).toBeUndefined();
		expect(quote?.copyMessage).toBe("Copied quote block 1 to clipboard");
	});

	it("interleaves code and quote children in document order with combined nodes", () => {
		const text = "intro\n```ts\na;\n```\n> q one\n```py\nb\n```\n> q two";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		expect(msg?.children?.map(c => c.id)).toEqual([
			"msg:1:text:0",
			"msg:1:code:0",
			"msg:1:quote:0",
			"msg:1:code:1",
			"msg:1:quote:1",
			"msg:1:all",
			"msg:1:all-quotes",
		]);
		expect(msg?.hint).toBe("9 lines · 2 code · 2 quote");
		expect(msg?.children?.find(c => c.id === "msg:1:all-quotes")?.content).toBe("q one\n\nq two");
	});

	it("skips tool-only assistant turns and non-assistant messages", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			assistantCalls([{ name: "read", arguments: { path: "x" } }]),
			assistantText("real answer"),
		] as unknown as AgentMessage[];
		const targets = buildCopyTargets(source({ messages }));
		expect(targets.filter(t => t.id.startsWith("msg:")).map(t => t.label)).toEqual(["real answer"]);
	});

	it("falls back to handoff context only when there are no assistant messages", () => {
		const withMessages = buildCopyTargets(
			source({
				messages: [assistantText("answer")] as unknown as AgentMessage[],
				getLastVisibleHandoffText: () => "<handoff>",
			}),
		);
		expect(byId(withMessages, "handoff")).toBeUndefined();

		const fresh = buildCopyTargets(source({ getLastVisibleHandoffText: () => "<handoff>\nGoal" }));
		expect(byId(fresh, "handoff")?.content).toBe("<handoff>\nGoal");
		expect(byId(fresh, "handoff")?.copyMessage).toBe("Copied handoff context to clipboard");
	});

	it("interleaves runnable commands after the assistant message that issued them", () => {
		const targets = buildCopyTargets(
			source({
				messages: [
					assistantText("older answer"),
					assistantCalls([{ name: "bash", arguments: { command: "echo old" } }]),
					assistantText("newer answer"),
					assistantCalls([{ name: "bash", arguments: { command: "bun check" } }]),
				] as unknown as AgentMessage[],
			}),
		);

		expect(targets.map(t => t.id)).toEqual(["msg:1", "cmd:1", "msg:2", "cmd:2"]);

		const cmd = byId(targets, "cmd:1");
		expect(cmd?.label).toBe("bun check");
		expect(cmd?.hint).toBe("bash · 1 line");
		expect(cmd?.content).toBe("bun check");
		expect(cmd?.language).toBe("bash");
		expect(byId(targets, "cmd:2")?.content).toBe("echo old");
	});

	it("a plain text-only message remains a leaf with no children", () => {
		const targets = buildCopyTargets(
			source({ messages: [assistantText("Hello world")] as unknown as AgentMessage[] }),
		);
		const msg = byId(targets, "msg:1");
		expect(msg?.content).toBe("Hello world");
		expect(msg?.children).toBeUndefined();
		expect(msg?.hint).toBe("1 line");
	});

	it("blank-line-delimited paragraphs become indexed text children with exact ids, labels, hints, payloads, and copy messages", () => {
		const text = "First paragraph\n\nSecond paragraph";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		expect(msg?.content).toBe(text);
		expect(msg?.children?.map(c => c.id)).toEqual(["msg:1:text:0", "msg:1:text:1"]);
		const t0 = msg!.children![0]!;
		expect(t0.label).toBe("First paragraph");
		expect(t0.hint).toBe("Text 1 · 1 line");
		expect(t0.content).toBe("First paragraph");
		expect(t0.copyMessage).toBe("Copied text block 1 to clipboard");
		const t1 = msg!.children![1]!;
		expect(t1.label).toBe("Second paragraph");
		expect(t1.hint).toBe("Text 2 · 1 line");
		expect(t1.content).toBe("Second paragraph");
		expect(t1.copyMessage).toBe("Copied text block 2 to clipboard");
	});

	it("text, code, quote, and trailing text children appear in source order", () => {
		const text = "Intro\n```py\nprint(1)\n```\n\n> quoted\n\nTrailing";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		expect(msg?.children?.map(c => c.id)).toEqual(["msg:1:text:0", "msg:1:code:0", "msg:1:quote:0", "msg:1:text:1"]);
		expect(msg?.children?.find(c => c.id === "msg:1:text:0")?.content).toBe("Intro");
		expect(msg?.children?.find(c => c.id === "msg:1:text:1")?.content).toBe("Trailing");
	});

	it("five-block message: text, fenced code, text, quote, trailing text appear in exact source order with correct ids and payloads", () => {
		const text = "Intro text\n```ts\nconst x = 1;\n```\nMiddle text\n\n> quoted line\n\nTrailing text";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		expect(msg?.children?.map(c => c.id)).toEqual([
			"msg:1:text:0",
			"msg:1:code:0",
			"msg:1:text:1",
			"msg:1:quote:0",
			"msg:1:text:2",
		]);
		expect(msg?.children?.find(c => c.id === "msg:1:text:0")?.content).toBe("Intro text");
		expect(msg?.children?.find(c => c.id === "msg:1:text:0")?.hint).toBe("Text 1 · 1 line");
		expect(msg?.children?.find(c => c.id === "msg:1:code:0")?.content).toBe("const x = 1;");
		expect(msg?.children?.find(c => c.id === "msg:1:code:0")?.language).toBe("ts");
		expect(msg?.children?.find(c => c.id === "msg:1:text:1")?.content).toBe("Middle text");
		expect(msg?.children?.find(c => c.id === "msg:1:text:1")?.hint).toBe("Text 2 · 1 line");
		expect(msg?.children?.find(c => c.id === "msg:1:quote:0")?.content).toBe("quoted line");
		expect(msg?.children?.find(c => c.id === "msg:1:text:2")?.content).toBe("Trailing text");
		expect(msg?.children?.find(c => c.id === "msg:1:text:2")?.hint).toBe("Text 3 · 1 line");
	});

	it("text block payloads preserve list markers, headings, and blank-line boundaries exactly", () => {
		const text = "# Heading\n\n- item one\n- item two\n\n**bold**";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		expect(msg?.children?.find(c => c.id === "msg:1:text:0")?.content).toBe("# Heading");
		expect(msg?.children?.find(c => c.id === "msg:1:text:1")?.content).toBe("- item one\n- item two");
		expect(msg?.children?.find(c => c.id === "msg:1:text:2")?.content).toBe("**bold**");
	});

	it("a whitespace-only line delimits adjacent text blocks", () => {
		const text = "Block A\n   \nBlock B";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		expect(msg?.children?.map(c => c.id)).toEqual(["msg:1:text:0", "msg:1:text:1"]);
		expect(msg?.children?.[0]?.content).toBe("Block A");
		expect(msg?.children?.[1]?.content).toBe("Block B");
	});

	it("blank lines inside a fenced code block stay inside the code and do not create text children", () => {
		const text = "```py\nx = 1\n\ny = 2\n```";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		expect(msg?.children?.map(c => c.id)).toEqual(["msg:1:code:0"]);
		expect(msg?.children?.[0]?.content).toBe("x = 1\n\ny = 2");
	});

	it("an unclosed fence is treated as ordinary text and the message remains a leaf", () => {
		const text = "Before\n```ts\nno close\nAfter";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		expect(msg?.children).toBeUndefined();
		expect(msg?.content).toBe(text);
	});
});
