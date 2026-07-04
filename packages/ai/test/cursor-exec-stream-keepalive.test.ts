import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	awaitWithCursorExecKeepalive,
	pushCursorExecStreamKeepalive,
} from "@oh-my-pi/pi-ai/providers/cursor";

function createPartialWithToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "grep",
				arguments: { pattern: "foo", path: "." },
			},
		],
		api: "cursor-agent",
		provider: "cursor",
		model: "composer-2.5-fast",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("cursor exec stream keepalive", () => {
	it("pushes an empty toolcall_delta for tool-call blocks", () => {
		const output = createPartialWithToolCall();
		const events: AssistantMessageEvent[] = [];
		const stream = {
			push(event: AssistantMessageEvent) {
				events.push(event);
			},
		} as unknown as AssistantMessageEventStream;

		pushCursorExecStreamKeepalive(output, stream);

		expect(events).toEqual([
			{
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "",
				partial: output,
			},
		]);
		expect(output.content).toEqual(createPartialWithToolCall().content);
	});

	it("emits keepalive events while awaiting a long exec handler", async () => {
		const output = createPartialWithToolCall();
		const events: AssistantMessageEvent[] = [];
		const stream = {
			push(event: AssistantMessageEvent) {
				events.push(event);
			},
		} as unknown as AssistantMessageEventStream;

		const originalInterval = globalThis.setInterval;
		try {
			globalThis.setInterval = ((handler: () => void) => {
				handler();
				return 1 as unknown as ReturnType<typeof setInterval>;
			}) as typeof setInterval;
			globalThis.clearInterval = (() => {}) as typeof clearInterval;

			await awaitWithCursorExecKeepalive(Promise.resolve("done"), { stream, output });
		} finally {
			globalThis.setInterval = originalInterval;
		}

		expect(events.length).toBeGreaterThan(0);
		expect(events.every(event => event.type === "toolcall_delta" && event.delta === "")).toBe(true);
	});
});
