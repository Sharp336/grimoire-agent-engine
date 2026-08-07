import { afterEach, describe, expect, test, vi } from "bun:test";
import { buildGrokSessionUpdate, GrokLiveTransport } from "../../src/live/grok-transport";
import type { LiveServerEvent } from "../../src/live/protocol";
import type { LiveTransportCallbacks, LiveTransportOptions } from "../../src/live/transport-types";

describe("GrokLiveTransport", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	test("delegates microphone turn completion to xAI server VAD", () => {
		expect(buildGrokSessionUpdate("Test instructions", "eve")).toMatchObject({
			type: "session.update",
			session: {
				turn_detection: { type: "server_vad" },
				audio: {
					input: { format: { type: "audio/pcm", rate: 16_000 } },
				},
			},
		});
	});

	test("owns the transcript identity for its selected model", () => {
		const transport = new GrokLiveTransport({
			authStorage: {} as LiveTransportOptions["authStorage"],
			sessionId: "test-session-123",
			instructions: "Test instructions",
			voice: "eve",
			model: "grok-voice-custom",
			callbacks: {
				onEvent: () => {},
				onOutputLevel: () => {},
			},
		});

		expect(transport.identity).toEqual({
			voiceProvider: "grok",
			api: "openai-completions",
			provider: "xai",
			model: "grok-voice-custom",
		});
	});

	test("translates Grok function calls into delegation.created events", () => {
		const events: LiveServerEvent[] = [];
		const callbacks: LiveTransportCallbacks = {
			onEvent: event => events.push(event),
			onOutputLevel: () => {},
		};

		const mockAuthStorage = {
			getApiKey: vi.fn(async () => "test-xai-key"),
		} as unknown as LiveTransportOptions["authStorage"];
		const transport = new GrokLiveTransport({
			authStorage: mockAuthStorage,
			sessionId: "test-session-123",
			instructions: "Test instructions",
			voice: "eve",
			callbacks,
		});

		// Simulate server event dispatch internal method via prototype or handler
		transport.handleServerMessage(
			JSON.stringify({
				type: "response.function_call_arguments.done",
				call_id: "call-99",
				arguments: JSON.stringify({ request: "Run git status and report back" }),
			}),
		);

		expect(events).toEqual([
			{
				type: "delegation.created",
				item: {
					type: "delegation",
					target: "client",
					id: "call-99",
					content: [{ type: "input_text", text: "Run git status and report back" }],
				},
			},
		]);
	});

	test("translates transcript events from Grok server deltas", () => {
		const events: LiveServerEvent[] = [];
		const callbacks: LiveTransportCallbacks = {
			onEvent: event => events.push(event),
			onOutputLevel: () => {},
		};

		const mockAuthStorage = {
			getApiKey: vi.fn(async () => "test-xai-key"),
		} as unknown as LiveTransportOptions["authStorage"];

		const transport = new GrokLiveTransport({
			authStorage: mockAuthStorage,
			sessionId: "test-session-123",
			instructions: "Test instructions",
			voice: "eve",
			callbacks,
		});

		transport.handleServerMessage(
			JSON.stringify({
				type: "conversation.item.input_audio_transcription.completed",
				transcript: "Fix the bug in main.ts",
			}),
		);

		transport.handleServerMessage(
			JSON.stringify({
				type: "response.output_audio_transcript.delta",
				delta: "I will check main.ts.",
			}),
		);

		transport.handleServerMessage(
			JSON.stringify({
				type: "response.output_audio_transcript.done",
				transcript: "I will check main.ts.",
			}),
		);

		expect(events).toEqual([
			{
				type: "input_transcript.added",
				item: { text: "Fix the bug in main.ts" },
			},
			{
				type: "turn.done",
				turn: { role: "user", transcript: "Fix the bug in main.ts" },
			},
			{
				type: "output_transcript.added",
				item: { text: "I will check main.ts." },
			},
			{
				type: "turn.done",
				turn: { role: "assistant", transcript: "I will check main.ts." },
			},
		]);
	});

	test("keeps output active until queued speaker audio has played", () => {
		vi.useFakeTimers();
		const levels: number[] = [];
		const mockAuthStorage = {
			getApiKey: vi.fn(async () => "test-xai-key"),
		} as unknown as LiveTransportOptions["authStorage"];
		const transport = new GrokLiveTransport({
			authStorage: mockAuthStorage,
			sessionId: "test-session-123",
			instructions: "Test instructions",
			voice: "eve",
			callbacks: {
				onEvent: () => {},
				onOutputLevel: level => levels.push(level),
			},
		});
		const pcm = Buffer.alloc(480);
		for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(10_000, offset);

		transport.handleServerMessage(
			JSON.stringify({
				type: "response.output_audio.delta",
				delta: pcm.toString("base64"),
			}),
		);
		transport.handleServerMessage(JSON.stringify({ type: "response.output_audio.done" }));

		expect(levels).toHaveLength(1);
		expect(levels[0]).toBeGreaterThan(0);
		vi.advanceTimersByTime(20);
		expect(levels.at(-1)).toBe(0);
	});
});
