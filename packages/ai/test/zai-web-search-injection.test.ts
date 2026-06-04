import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";

function mockFetch(capture: { body?: unknown }) {
	return async (_url: string | URL | Request, init?: RequestInit) => {
		if (init?.body) capture.body = JSON.parse(init.body as string);
		const sse = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"test","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		].join("");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

const zaiModel = {
	id: "glm-4.7", name: "GLM 4.7", provider: "zai", api: "anthropic-messages",
	baseUrl: "https://api.z.ai/api/anthropic", input: ["text"], output: ["text"],
	context: 128000, contextWindow: 128000, maxTokens: 8192, reasoning: false,
	toolCall: "native", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"anthropic-messages">;

const anthropicModel = {
	...zaiModel, id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4",
	provider: "anthropic", baseUrl: "https://api.anthropic.com",
} as Model<"anthropic-messages">;

const emptyContext = {
	systemPrompt: [""],
	messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "test" }], timestamp: Date.now() }],
};

describe("Z.AI web_search tool injection", () => {
	it("injects web_search tool for Z.AI models", async () => {
		const capture: { body?: unknown } = {};
		const stream = streamSimple(zaiModel, emptyContext, { apiKey: "test-key", fetch: mockFetch(capture), zaiWebSearch: { enabled: true, maxSearchCalls: 5 } });
		await stream.result();
		const body = capture.body as { tools?: Array<Record<string, unknown>> };
		expect(body?.tools).toBeDefined();
		const ws = body!.tools!.find(t => t.type === "web_search_20250305");
		expect(ws).toBeDefined();
		expect(ws!.name).toBe("web_search");
		expect(ws!.max_uses).toBe(5);
	});

	it("does not inject for non-Z.AI models", async () => {
		const capture: { body?: unknown } = {};
		const stream = streamSimple(anthropicModel, emptyContext, { apiKey: "test-key", fetch: mockFetch(capture), zaiWebSearch: { enabled: true, maxSearchCalls: 5 } });
		await stream.result();
		const body = capture.body as { tools?: Array<Record<string, unknown>> };
		expect(body?.tools?.find(t => t.type === "web_search_20250305")).toBeUndefined();
	});

	it("suppresses when enabled is false", async () => {
		const capture: { body?: unknown } = {};
		const stream = streamSimple(zaiModel, emptyContext, { apiKey: "test-key", fetch: mockFetch(capture), zaiWebSearch: { enabled: false } });
		await stream.result();
		const body = capture.body as { tools?: Array<Record<string, unknown>> };
		expect(body?.tools?.find(t => t.type === "web_search_20250305")).toBeUndefined();
	});

	it("serializes recencyFilter", async () => {
		const capture: { body?: unknown } = {};
		const stream = streamSimple(zaiModel, emptyContext, { apiKey: "test-key", fetch: mockFetch(capture), zaiWebSearch: { enabled: true, recencyFilter: "oneDay" } });
		await stream.result();
		const body = capture.body as { tools?: Array<Record<string, unknown>> };
		const ws = body?.tools?.find(t => t.type === "web_search_20250305");
		expect(ws).toBeDefined();
		expect(ws!.search_recency_filter).toBe("oneDay");
	});

	it("clamps maxSearchCalls to 1-50", async () => {
		const capture: { body?: unknown } = {};
		const stream = streamSimple(zaiModel, emptyContext, { apiKey: "test-key", fetch: mockFetch(capture), zaiWebSearch: { enabled: true, maxSearchCalls: 100 } });
		await stream.result();
		const body = capture.body as { tools?: Array<Record<string, unknown>> };
		const ws = body?.tools?.find(t => t.type === "web_search_20250305");
		expect(ws).toBeDefined();
		expect(ws!.max_uses).toBe(50);
	});
});
