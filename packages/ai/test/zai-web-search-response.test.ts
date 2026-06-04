import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai/types";

function sseFetch(sseEvents: string[], capture?: { body?: unknown }) {
	return async (_url: string | URL | Request, init?: RequestInit) => {
		if (capture && init?.body) capture.body = JSON.parse(init.body as string);
		return new Response(sseEvents.join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
}

const zaiModel = {
	id: "glm-4.7", name: "GLM 4.7", provider: "zai", api: "anthropic-messages",
	baseUrl: "https://api.z.ai/api/anthropic", input: ["text"], output: ["text"],
	context: 128000, contextWindow: 128000, maxTokens: 8192, reasoning: false,
	toolCall: "native", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"anthropic-messages">;

const ctx = {
	systemPrompt: [""],
	messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "test" }], timestamp: Date.now() }],
};

const msgStart = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"test","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
const msgEnd = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

async function collectEvents(stream: ReturnType<typeof streamSimple>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("Z.AI web search response handling", () => {
	it("web_search_tool_result emits text_start/text_delta/text_end", async () => {
		const searchResult = JSON.stringify([{ type: "web_search_result", title: "Node.js", url: "https://nodejs.org" }]);
		const sse = [
			msgStart,
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Here are the results."}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			`event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"ws_1","content":${searchResult}}}\n\n`,
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Node.js is a JS runtime."}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
			msgEnd,
		];
		const stream = streamSimple(zaiModel, ctx, { apiKey: "test", fetch: sseFetch(sse) });
		const events = await collectEvents(stream);
		const result = await stream.result();

		const allText = result.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("");
		expect(allText).toContain("Node.js");
		expect(allText).toContain("https://nodejs.org");

		expect(events.some(e => e.type === "text_start")).toBe(true);
		expect(events.some(e => e.type === "text_end")).toBe(true);
	});

	it("tool_result (Z.AI format) parses JSON and emits text events", async () => {
		const zaiContent = JSON.stringify([[{ title: "Python 3.12", link: "https://python.org", content: "desc", refer: "ref_1" }]]);
		const escapedContent = zaiContent.replace(/"/g, '\\"');
		const sse = [
			msgStart,
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"su_1","name":"web_search_prime","input":{}}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			`event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_result","tool_use_id":"su_1","content":"${escapedContent}"}}\n\n`,
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Python 3.12 is the latest."}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
			msgEnd,
		];
		const stream = streamSimple(zaiModel, ctx, { apiKey: "test", fetch: sseFetch(sse) });
		const events = await collectEvents(stream);
		const result = await stream.result();

		const allText = result.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("");
		expect(allText).toContain("Python 3.12");
		expect(allText).toContain("https://python.org");
		expect(events.some(e => e.type === "text_start")).toBe(true);
		expect(events.some(e => e.type === "text_end")).toBe(true);
	});

	it("server_tool_use is skipped without emitting stream events", async () => {
		const sse = [
			msgStart,
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"su_1","name":"web_search_prime","input":{"query":"test"}}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"query\\":\\"test\\""}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done."}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
			msgEnd,
		];
		const stream = streamSimple(zaiModel, ctx, { apiKey: "test", fetch: sseFetch(sse) });
		const result = await stream.result();

		const allText = result.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("");
		expect(allText).toBe("Done.");
	});

	it("unparsable tool_result does not throw and still completes", async () => {
		const sse = [
			msgStart,
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_result","tool_use_id":"su_1","content":"not valid json {["}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Response after bad result."}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
			msgEnd,
		];
		const stream = streamSimple(zaiModel, ctx, { apiKey: "test", fetch: sseFetch(sse) });
		const result = await stream.result();

		const allText = result.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("");
		expect(allText).toContain("Response after bad result.");
	});
});
