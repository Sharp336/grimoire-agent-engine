import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { encodeResponse, encodeStream } from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

function makeMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages" as AssistantMessage["api"],
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
		stopReason: "stop",
		...overrides,
	};
}

function collectSse(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const frames: Record<string, unknown>[] = [];
	return (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			for (const block of text.split("\n\n")) {
				const event = block.match(/event: (\S+)/)?.[1];
				const data = block.match(/data: (\{.*\})/s)?.[1];
				if (event && data) frames.push({ event, ...JSON.parse(data) });
			}
		}
		return frames;
	})();
}

function lastStopSequence(
	frames: Record<string, unknown>[],
): { stop_reason: unknown; stop_sequence: unknown } | undefined {
	const deltas = frames.filter(f => f.event === "message_delta");
	const last = deltas[deltas.length - 1] as { delta?: { stop_reason?: unknown; stop_sequence?: unknown } } | undefined;
	return last?.delta ? { stop_reason: last.delta.stop_reason, stop_sequence: last.delta.stop_sequence } : undefined;
}

describe("anthropic-messages-server stop sequence (encoder)", () => {
	it("encodes a matched stop sequence in the non-streaming response", () => {
		const res = encodeResponse(makeMessage({ stopSequence: "DONE" }), "claude-sonnet-4-5") as Record<string, unknown>;
		expect(res.stop_reason).toBe("stop_sequence");
		expect(res.stop_sequence).toBe("DONE");
	});

	it("emits end_turn with null stop_sequence when none matched", () => {
		const res = encodeResponse(makeMessage(), "claude-sonnet-4-5") as Record<string, unknown>;
		expect(res.stop_reason).toBe("end_turn");
		expect(res.stop_sequence).toBeNull();
	});

	it("keeps tool_use mapping when no stop sequence matched", () => {
		const res = encodeResponse(makeMessage({ stopReason: "toolUse" }), "claude-sonnet-4-5") as Record<
			string,
			unknown
		>;
		expect(res.stop_reason).toBe("tool_use");
		expect(res.stop_sequence).toBeNull();
	});
});

describe("anthropic-messages-server stop sequence (streaming)", () => {
	it("surfaces the matched stop sequence on the streaming message_delta", async () => {
		const message = makeMessage({ stopSequence: "STOP_HERE" });
		const events = new AssistantMessageEventStream() as AssistantMessageEventStream;
		events.push({ type: "start", partial: message });
		events.push({ type: "done", reason: "stop", message });

		const frames = await collectSse(encodeStream(events, "claude-sonnet-4-5"));
		const delta = lastStopSequence(frames);
		expect(delta?.stop_reason).toBe("stop_sequence");
		expect(delta?.stop_sequence).toBe("STOP_HERE");
	});

	it("falls back to the last partial when the stream ends without an explicit done", async () => {
		const message = makeMessage();
		const events = new AssistantMessageEventStream() as AssistantMessageEventStream;
		events.push({ type: "start", partial: message });
		message.stopSequence = "STOP_HERE";
		message.usage = {
			input: 5,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		events.end(message);

		const frames = await collectSse(encodeStream(events, "claude-sonnet-4-5"));
		const delta = lastStopSequence(frames);
		expect(delta?.stop_reason).toBe("stop_sequence");
		expect(delta?.stop_sequence).toBe("STOP_HERE");
	});
});
