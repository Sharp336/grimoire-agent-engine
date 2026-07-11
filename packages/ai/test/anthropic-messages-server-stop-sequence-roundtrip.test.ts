import { describe, expect, it } from "bun:test";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";

function makeModel() {
	return {
		id: "claude-sonnet-4-5",
		name: "claude-sonnet-4-5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as unknown as Model<"anthropic-messages">;
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "hi" }] as Context["messages"] };
}

function frame(type: string, data: unknown): string {
	return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const body = events.map(e => frame(e.type as string, e)).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function messageDelta(
	stopReason: string,
	stopSequence: string | null,
	usage = { input_tokens: 5, output_tokens: 3 },
): Record<string, unknown> {
	return { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: stopSequence }, usage };
}

function makeFetchMock(responses: Array<() => Response>): { fetch: FetchImpl; calls: () => number } {
	let i = 0;
	const fetchImpl = (async (_input: unknown, _init?: unknown) => {
		const handler = responses[Math.min(i, responses.length - 1)];
		i++;
		return handler();
	}) as unknown as FetchImpl;
	return { fetch: fetchImpl, calls: () => i };
}

describe("anthropic provider stop sequence (parser round-trip)", () => {
	it("captures stop_sequence from the raw message_delta SSE frame", async () => {
		const { fetch } = makeFetchMock([
			() =>
				sseResponse([
					{
						type: "message_start",
						message: {
							id: "msg_1",
							type: "message",
							role: "assistant",
							model: "claude-sonnet-4-5",
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 5, output_tokens: 3 },
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
					{ type: "content_block_stop", index: 0 },
					messageDelta("stop_sequence", "STOP_HERE"),
					{ type: "message_stop" },
				]),
		]);

		const stream = streamAnthropic(makeModel(), makeContext(), { fetch });
		const message = await stream.result();

		expect(message.stopSequence).toBe("STOP_HERE");
		expect(message.stopReason).toBe("stop");
	});

	it("clears a stale stop_sequence from a prior attempt on retry", async () => {
		// First attempt sets a stop_sequence but then fails with a malformed
		// trailing frame (transient stream-parse error). No content blocks are
		// streamed, so streamedReplayUnsafeContent stays false and the parse
		// error enters the generic retry path (the provider will NOT retry once
		// it has replayed text to the consumer). The second attempt succeeds
		// cleanly; the final message must NOT retain the stale stop_sequence.
		const broken =
			frame("message_start", {
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 5, output_tokens: 0 },
				},
			}) +
			frame("message_delta", messageDelta("stop_sequence", "STALE")) +
			// Truncated JSON → transient stream-parse error → retry.
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"stop_sequence"';

		const clean = sseResponse([
			{
				type: "message_start",
				message: {
					id: "msg_2",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 5, output_tokens: 3 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			messageDelta("end_turn", null),
			{ type: "message_stop" },
		]);

		const { fetch, calls } = makeFetchMock([
			() => new Response(broken, { status: 200, headers: { "content-type": "text/event-stream" } }),
			() => clean,
		]);

		const stream = streamAnthropic(makeModel(), makeContext(), { fetch, providerRetryWait: async () => {} });
		const message = await stream.result();

		expect(message.stopSequence).toBeUndefined();
		expect(message.stopReason).toBe("stop");
		// Proves a retry actually happened (broken → clean), so the stale
		// stop_sequence was reset by the retry path rather than never set.
		expect(calls()).toBe(2);
	});
});
