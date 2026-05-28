import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { stream } from "../src/stream";
import type { Context, Model, ToolCall } from "../src/types";
import {
	DsmlToolCallHealer,
	modelMayLeakDsmlToolCalls,
} from "../src/utils/dsml-tool-call-healing";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

const deepseekCloudModel: Model<"ollama-chat"> = {
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "ollama-chat",
	provider: "ollama-cloud",
	baseUrl: "https://ollama.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 8_192,
};

function createNdjsonResponse(lines: ReadonlyArray<unknown>): Response {
	const body = `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "application/x-ndjson" },
	});
}

const REPORTED_LEAK =
	"<｜DSML｜tool_calls>\n" +
	' <｜DSML｜invoke name="bash">\n' +
	' <｜DSML｜parameter name="_i" string="true">Check Fedora 42 available packages</｜DSML｜parameter>\n' +
	' <｜DSML｜parameter name="command" string="true">docker run --rm --platform linux/arm64 fedora:42 bash -c \'type python3; type git; type sed; type cp; ls /usr/bin/python3 2>/dev/null; rpm -qa | grep -E "^python3|^git-|^sed-|^bash-" | sort\'</｜DSML｜parameter>\n' +
	' <｜DSML｜parameter name="timeout" string="false">15</｜DSML｜parameter>\n' +
	" </｜DSML｜invoke>\n" +
	" </｜DSML｜tool_calls>";

describe("DSML envelope healer (unit)", () => {
	it("parses the reporter's verbatim leak into a structured tool call", () => {
		const healer = new DsmlToolCallHealer();
		const clean = healer.feed(REPORTED_LEAK);
		expect(clean).toBe("");

		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.name).toBe("bash");
		expect(call.id).toMatch(/^call_[0-9a-f]+$/);

		const args = JSON.parse(call.arguments) as Record<string, unknown>;
		expect(args._i).toBe("Check Fedora 42 available packages");
		// `string="false"` should coerce numeric value
		expect(args.timeout).toBe(15);
		// Command body must preserve raw `>` from shell redirection
		expect(String(args.command)).toContain("2>/dev/null");
		expect(String(args.command)).toContain('grep -E "^python3|^git-|^sed-|^bash-"');
	});

	it("reconstructs the envelope when split across many chunks (including mid-tag)", () => {
		const healer = new DsmlToolCallHealer();
		// Slice every 7 characters to stress partial-tag holdback.
		let visible = "";
		for (let i = 0; i < REPORTED_LEAK.length; i += 7) {
			visible += healer.feed(REPORTED_LEAK.slice(i, i + 7));
		}
		visible += healer.flushPending();
		expect(visible).toBe("");

		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("bash");
		const args = JSON.parse(calls[0].arguments) as Record<string, unknown>;
		expect(args.timeout).toBe(15);
	});

	it("passes prose through unchanged when no envelope is present", () => {
		const healer = new DsmlToolCallHealer();
		const out = healer.feed("Sure, I'll check that. The path is foo<bar>.\n");
		const tail = healer.flushPending();
		expect(out + tail).toBe("Sure, I'll check that. The path is foo<bar>.\n");
		expect(healer.drainCompleted()).toHaveLength(0);
	});

	it("strips the envelope from surrounding prose without losing the prose", () => {
		const healer = new DsmlToolCallHealer();
		const leaked =
			"Sure, running it now:\n" +
			REPORTED_LEAK +
			"\nThat should give us the package list.";
		const clean = healer.feed(leaked) + healer.flushPending();
		expect(clean).toBe(
			"Sure, running it now:\n\nThat should give us the package list.",
		);
		expect(healer.drainCompleted()).toHaveLength(1);
	});

	it("drops partial calls when the stream ends mid-envelope", () => {
		const healer = new DsmlToolCallHealer();
		const truncated = REPORTED_LEAK.slice(0, REPORTED_LEAK.length - 30);
		const clean = healer.feed(truncated);
		const tail = healer.flushPending();
		expect(clean).toBe("");
		expect(tail).toBe("");
		expect(healer.drainCompleted()).toHaveLength(0);
	});

	it("handles multiple invokes inside one envelope", () => {
		const healer = new DsmlToolCallHealer();
		const xml =
			"<｜DSML｜tool_calls>" +
			'<｜DSML｜invoke name="read">' +
			'<｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter>' +
			"</｜DSML｜invoke>" +
			'<｜DSML｜invoke name="read">' +
			'<｜DSML｜parameter name="path" string="true">b.ts</｜DSML｜parameter>' +
			"</｜DSML｜invoke>" +
			"</｜DSML｜tool_calls>";
		healer.feed(xml);
		const calls = healer.drainCompleted();
		expect(calls.map(c => c.name)).toEqual(["read", "read"]);
		expect(calls.map(c => JSON.parse(c.arguments))).toEqual([
			{ path: "a.ts" },
			{ path: "b.ts" },
		]);
		expect(calls[0].id).not.toBe(calls[1].id);
	});

	it("accepts ASCII pipe variant `<|DSML|...>`", () => {
		const healer = new DsmlToolCallHealer();
		const xml =
			"<|DSML|tool_calls>" +
			'<|DSML|invoke name="bash">' +
			'<|DSML|parameter name="cmd" string="true">ls -la</|DSML|parameter>' +
			"</|DSML|invoke>" +
			"</|DSML|tool_calls>";
		healer.feed(xml);
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("bash");
		expect(JSON.parse(calls[0].arguments)).toEqual({ cmd: "ls -la" });
	});

	it("gates by provider+model so non-DeepSeek streams skip the scan", () => {
		expect(modelMayLeakDsmlToolCalls("ollama-cloud", "deepseek-v4-pro")).toBe(true);
		expect(modelMayLeakDsmlToolCalls("ollama-cloud", "gpt-oss:120b")).toBe(false);
		expect(modelMayLeakDsmlToolCalls("openai", "deepseek-v4-pro")).toBe(false);
	});
});

describe("Ollama provider — DSML envelope leaked on deepseek-v4-pro", () => {
	it("emits a healed tool call and suppresses the leaked text", async () => {
		global.fetch = vi.fn(async () =>
			createNdjsonResponse([
				{
					model: "deepseek-v4-pro",
					message: { role: "assistant", content: " 精神精神\n\n" },
					done: false,
				},
				{
					model: "deepseek-v4-pro",
					message: { role: "assistant", content: REPORTED_LEAK },
					done: false,
				},
				{
					model: "deepseek-v4-pro",
					done: true,
					done_reason: "stop",
					prompt_eval_count: 12,
					eval_count: 200,
				},
			]),
		) as unknown as typeof fetch;

		const context: Context = {
			messages: [{ role: "user", content: "Check Fedora packages", timestamp: Date.now() }],
		};
		const response = stream(deepseekCloudModel, context, { apiKey: "test-key" });
		const result = await response.result();

		const visibleText = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(visibleText).not.toContain("DSML");
		expect(visibleText).not.toContain("<｜");
		expect(visibleText).not.toContain("<invoke");

		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("bash");
		const args = toolCalls[0].arguments as Record<string, unknown>;
		expect(args._i).toBe("Check Fedora 42 available packages");
		expect(args.timeout).toBe(15);
		expect(String(args.command)).toContain("docker run");

		// `done_reason:"stop"` must be promoted: the agent loop depends on
		// `toolUse` to dispatch the call instead of ending the turn.
		expect(result.stopReason).toBe("toolUse");
	});

	it("does not run the healer when the model is not DeepSeek", async () => {
		const ollamaGptOss: Model<"ollama-chat"> = {
			...deepseekCloudModel,
			id: "gpt-oss:120b",
			name: "GPT OSS 120B",
		};
		global.fetch = vi.fn(async () =>
			createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: "Inline `<｜literal｜>` token in prose." },
					done: false,
				},
				{
					model: "gpt-oss:120b",
					done: true,
					done_reason: "stop",
					prompt_eval_count: 1,
					eval_count: 1,
				},
			]),
		) as unknown as typeof fetch;

		const result = await stream(
			ollamaGptOss,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key" },
		).result();

		const text = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map(b => b.text)
			.join("");
		// Without the healer, prose passes through verbatim.
		expect(text).toBe("Inline `<｜literal｜>` token in prose.");
		expect(result.stopReason).toBe("stop");
	});
});

interface SseToolCallDelta {
	index: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
}

interface SseChoiceDelta {
	content?: string;
	tool_calls?: SseToolCallDelta[];
}

interface SseChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: ReadonlyArray<{
		index: number;
		delta: SseChoiceDelta;
		finish_reason?: "stop" | "tool_calls" | "length" | "content_filter" | null;
	}>;
}

function sseResponse(events: ReadonlyArray<SseChunk | "[DONE]">): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function mockOpenAIFetch(events: ReadonlyArray<SseChunk | "[DONE]">): typeof fetch {
	const fn = async (): Promise<Response> => sseResponse(events);
	return Object.assign(fn, { preconnect: originalFetch.preconnect });
}

function deepseekChunk(delta: SseChoiceDelta, finish: SseChunk["choices"][0]["finish_reason"] = null): SseChunk {
	return {
		id: "chatcmpl-deepseek-dsml",
		object: "chat.completion.chunk",
		created: 0,
		model: "deepseek-v4-pro",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

describe("openai-completions provider — DSML envelope on direct DeepSeek API", () => {
	it("heals the envelope into a structured tool call and suppresses leaked text", async () => {
		const model = getBundledModel("deepseek", "deepseek-v4-pro");
		global.fetch = mockOpenAIFetch([
			deepseekChunk({ content: "I'll check.\n" }),
			deepseekChunk({ content: REPORTED_LEAK }),
			deepseekChunk({}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "Check Fedora", timestamp: Date.now() }] },
			{ apiKey: "test-key" },
		).result();

		const text = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(text).not.toContain("DSML");
		expect(text).not.toContain("<｜");
		expect(text.startsWith("I'll check.")).toBe(true);

		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("bash");
		const args = toolCalls[0].arguments as Record<string, unknown>;
		expect(args._i).toBe("Check Fedora 42 available packages");
		expect(args.timeout).toBe(15);

		// finish_reason:"stop" must be promoted so the agent loop dispatches.
		expect(result.stopReason).toBe("toolUse");
	});
});
