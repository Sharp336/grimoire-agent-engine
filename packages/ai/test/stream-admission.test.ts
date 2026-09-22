import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AgentPauseGate } from "../../agent/src/pause";
import { streamSimple } from "../src/stream";
import type { AssistantMessage } from "../src/types";
import { AssistantMessageEventStream, EventStream } from "../src/utils/event-stream";
import {
	boundedProviderBody,
	enqueueStreamWork,
	runWithStreamAdmission,
	StreamAdmission,
} from "../src/utils/stream-admission";

test("slow serial callbacks reserve before serialization and abort leaves manual pause engaged", async () => {
	const admission = new StreamAdmission({ maxEvents: 2 });
	const storage = Promise.withResolvers<void>();
	const pause = new AgentPauseGate();
	pause.pause();
	const parked = pause.waitUntilResumed(admission.signal);
	let serialized = 0;
	const work = async () => {
		serialized++;
	};
	const first = enqueueStreamWork(admission, storage.promise, "first", work);
	const second = enqueueStreamWork(admission, first, "second", work);
	void first.catch(() => {});
	void second.catch(() => {});
	expect(() => enqueueStreamWork(admission, second, "overflow", work)).toThrow("maxEvents");
	await parked;
	expect(pause.paused).toBe(true);
	expect(serialized).toBe(0);
	storage.resolve();
	await expect(first).rejects.toThrow("maxEvents");
	await expect(second).rejects.toThrow("maxEvents");
	expect(admission.metrics).toMatchObject({ events: 0, bytes: 0, peakEvents: 2 });
});

test("aggregate admission includes yielded events and has an out-of-band failure reserve", async () => {
	const admission = new StreamAdmission({ maxEvents: 2 });
	const [a, b] = runWithStreamAdmission(admission, () => [
		new EventStream<number>(
			() => false,
			value => value,
		),
		new EventStream<number>(
			() => false,
			value => value,
		),
	]);
	a.push(1);
	const consumer = a[Symbol.asyncIterator]();
	expect((await consumer.next()).value).toBe(1);
	b.push(2);
	expect(admission.metrics.events).toBe(2);
	expect(() => b.push(3)).toThrow("maxEvents");
	expect(admission.signal.aborted).toBe(true);
	await expect(a.result()).rejects.toThrow("maxEvents");
	await expect(b.result()).rejects.toThrow("maxEvents");
	await expect(consumer.next()).rejects.toThrow("maxEvents");
	expect(admission.metrics).toMatchObject({ events: 0, peakEvents: 2, aborted: "maxEvents" });
});

test("byte overflow cannot resolve a terminal success; draining releases its charge", async () => {
	const admission = new StreamAdmission({ maxQueuedBytes: 300, maxEventBytes: 300 });
	const stream = runWithStreamAdmission(
		admission,
		() =>
			new EventStream<string>(
				v => v === "done",
				v => v,
			),
	);
	stream.push("a");
	expect([...stream.drain()]).toEqual(["a"]);
	expect(admission.metrics.bytes).toBe(0);
	expect(() => stream.push("x".repeat(100))).toThrow("maxEventBytes");
	stream.push("done");
	await expect(stream.result()).rejects.toThrow("maxEventBytes");
});

test.each([
	[300_000, "maxEventBytes", 0],
	[200_000, "maxQueuedBytes", 5],
] as const)("native nested partial snapshots enforce %s chars against %s", async (length, limit, admitted) => {
	const admission = new StreamAdmission();
	const stream = runWithStreamAdmission(
		admission,
		() =>
			new EventStream<unknown>(
				() => false,
				event => event,
			),
	);
	let produced = 0;
	expect(() => {
		for (let index = 0; index < 12; index++) {
			const message = {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: `call${index}`,
						name: "write",
						arguments: { partial: String(index).padStart(8, "0") + "x".repeat(length) },
					},
				],
			};
			stream.push({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_delta", delta: "x", partial: message },
			});
			produced++;
		}
	}).toThrow(limit);
	expect(produced).toBe(admitted);
	await expect(stream.result()).rejects.toThrow(limit);
	expect(admission.metrics.peakBytes).toBeLessThanOrEqual(admission.limits.maxQueuedBytes);
	expect(admission.metrics).toMatchObject({ events: 0, bytes: 0, aborted: limit });
});

test("only a typed assistant event's root partial is shared; callbacks and nested tool fields are charged", () => {
	const partial = { role: "assistant", content: [{ type: "text", text: "x".repeat(300_000) }] } as AssistantMessage;
	const admission = new StreamAdmission();
	const stream = runWithStreamAdmission(admission, () => new AssistantMessageEventStream());
	stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
	expect(admission.metrics.bytes).toBeLessThan(1024);
	for (const _event of stream.drain()) {
		/* Release the known shared envelope. */
	}
	const nestedAdmission = new StreamAdmission();
	const nestedStream = runWithStreamAdmission(nestedAdmission, () => new AssistantMessageEventStream());
	// Provider adapters wrap the shared partial in a message_update envelope;
	// that object must not be charged a second time.
	nestedStream.push({
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial },
	});
	expect(nestedAdmission.metrics.bytes).toBeLessThan(1024);
	for (const _event of nestedStream.drain()) {
		/* Release the nested shared envelope. */
	}
	const genericAdmission = new StreamAdmission();
	const genericStream = runWithStreamAdmission(
		genericAdmission,
		() =>
			new EventStream<unknown>(
				() => false,
				() => undefined,
			),
	);
	// AgentSession uses a generic EventStream for message_update envelopes.
	genericStream.push({
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial },
	});
	expect(genericAdmission.metrics.bytes).toBeLessThan(1024);
	for (const _event of genericStream.drain()) {
		/* Release the generic shared envelope. */
	}
	expect(() => admission.reserve({ type: "text_delta", partial })).toThrow("maxEventBytes");

	const toolAdmission = new StreamAdmission();
	const toolStream = runWithStreamAdmission(toolAdmission, () => new AssistantMessageEventStream());
	expect(() =>
		toolStream.push({
			type: "toolcall_end",
			contentIndex: 0,
			partial,
			toolCall: { type: "toolCall", id: "call", name: "write", arguments: { partial: "x".repeat(300_000) } },
		}),
	).toThrow("maxEventBytes");
});

test("normal terminal consumption releases all tickets and local work is finite", async () => {
	const admission = new StreamAdmission({ maxLocalWork: 1 });
	const stream = runWithStreamAdmission(
		admission,
		() =>
			new EventStream<string>(
				v => v === "done",
				v => v,
			),
	);
	stream.push("delta");
	stream.push("done");
	const events: string[] = [];
	for await (const event of stream) events.push(event);
	expect(events).toEqual(["delta", "done"]);
	expect(await stream.result()).toBe("done");
	expect(admission.metrics).toMatchObject({ events: 0, bytes: 0 });
	const release = admission.reserveLocalWork();
	expect(() => admission.reserveLocalWork()).toThrow("maxLocalWork");
	release();
	expect(admission.metrics).toMatchObject({ localWork: 0, peakLocalWork: 1 });
});

test("parser input is checked before decoding; overflow cancels source without reading ahead", async () => {
	const admission = new StreamAdmission({ maxIngressBytes: 8, maxChunkBytes: 8 });
	let reads = 0;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				reads++;
				controller.enqueue(new Uint8Array(5));
			},
			cancel() {
				cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	const reader = runWithStreamAdmission(admission, () => boundedProviderBody(body)).getReader();
	await reader.read();
	expect(reads).toBe(1);
	await expect(reader.read()).rejects.toThrow("maxIngressBytes");
	expect(reads).toBe(2);
	expect(cancelled).toBe(true);
	expect(admission.metrics.ingressBytes).toBe(5);
});

test.each(["maxEvents", "maxIngressBytes"] as const)(
	"real Anthropic HTTP/parser/retry forwarding aborts %s without retry",
	async limit => {
		const model = buildModel({
			id: "claude-opus-5",
			name: "Opus fixture",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32000,
			maxTokens: 8192,
		});
		const frame = (type: string, data: Record<string, unknown>) =>
			`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
		const frames = [
			frame("message_start", {
				message: {
					id: "msg_bounded",
					type: "message",
					role: "assistant",
					content: [],
					model: "claude-opus-5",
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			}),
			frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
		];
		let requests = 0;
		let chunks = 0;
		let cancelled = false;
		const admission = new StreamAdmission({
			maxEvents: 8,
			...(limit === "maxIngressBytes" ? { maxIngressBytes: 512 } : {}),
		});
		const response = runWithStreamAdmission(admission, () =>
			streamSimple(
				model,
				{
					messages: [{ role: "user", content: "fixture", timestamp: 1 }],
				},
				{
					apiKey: "fixture-key",
					disableReasoning: true,
					fetch: async () => {
						requests++;
						return new Response(
							new ReadableStream<Uint8Array>(
								{
									pull(controller) {
										const text =
											frames[chunks] ??
											frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } });
										chunks++;
										controller.enqueue(new TextEncoder().encode(text));
									},
									cancel() {
										cancelled = true;
									},
								},
								{ highWaterMark: 0 },
							),
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
				},
			),
		);
		await expect(response.result()).rejects.toThrow(limit);
		// The producer unwinds its current frame and releases the parser reader.
		for (let turn = 0; turn < 20 && !cancelled; turn++) await Bun.sleep(1);
		expect(requests).toBe(1);
		expect(admission.signal.aborted).toBe(true);
		expect(cancelled).toBe(true);
		expect(chunks).toBeLessThan(20);
		if (limit === "maxEvents") expect(admission.metrics.peakEvents).toBe(8);
		else expect(admission.metrics.ingressBytes).toBeLessThanOrEqual(512);
		expect(admission.metrics.events).toBe(0);
	},
);
