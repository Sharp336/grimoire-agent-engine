import { describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, PromptProgress } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const context: Context = {
	systemPrompt: ["Test"],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

function makeModel(provider: string): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		provider,
		id: "local-model",
		name: "Local model",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	} satisfies ModelSpec<"openai-responses">);
}

function responseEvents(progressEvents: unknown[]): unknown[] {
	return [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
		...progressEvents,
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "pong" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "pong", annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 },
			},
		},
	];
}

function mockFetch(events: unknown[]): { fetch: FetchImpl; requests: Array<Record<string, unknown>> } {
	const requests: Array<Record<string, unknown>> = [];
	const fetch: FetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		if (typeof init?.body === "string") requests.push(JSON.parse(init.body) as Record<string, unknown>);
		const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	});
	return { fetch, requests };
}

async function run(
	model: Model<"openai-responses">,
	events: unknown[],
): Promise<{ requests: Array<Record<string, unknown>>; progress: PromptProgress[] }> {
	const transport = mockFetch(events);
	const progress: PromptProgress[] = [];
	await streamSimple(model, context, {
		apiKey: "test",
		fetch: transport.fetch,
		onPromptProgress: update => progress.push(update),
	}).result();
	return { requests: transport.requests, progress };
}

describe("llama.cpp Responses prompt progress", () => {
	it("requests and emits normalized progress for the llama.cpp provider", async () => {
		const result = await run(
			makeModel("llama.cpp"),
			responseEvents([
				{
					type: "response.in_progress",
					response: { id: "resp_1", status: "in_progress" },
					prompt_progress: { total: 100, cache: 40, processed: 56, time_ms: 12.5 },
				},
			]),
		);

		expect(result.requests).toHaveLength(1);
		expect(result.requests[0]?.return_progress).toBe(true);
		expect(result.progress).toEqual([{ total: 100, cached: 40, processed: 56 }]);
	});

	it("does not request or expose the llama.cpp extension for other providers", async () => {
		const result = await run(
			makeModel("openai"),
			responseEvents([
				{
					type: "response.in_progress",
					response: { id: "resp_1", status: "in_progress" },
					prompt_progress: { total: 100, cache: 40, processed: 56, time_ms: 12.5 },
				},
			]),
		);

		expect(result.requests[0]).not.toHaveProperty("return_progress");
		expect(result.progress).toEqual([]);
	});

	it("ignores missing or malformed progress while the response continues normally", async () => {
		const result = await run(
			makeModel("llama.cpp"),
			responseEvents([
				{ type: "response.in_progress", response: { id: "resp_1", status: "in_progress" } },
				{
					type: "response.in_progress",
					response: { id: "resp_1", status: "in_progress" },
					prompt_progress: { total: 100, cache: 60, processed: 50 },
				},
			]),
		);

		expect(result.progress).toEqual([]);
	});
});
