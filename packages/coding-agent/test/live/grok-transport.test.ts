import { afterEach, describe, expect, test, vi } from "bun:test";
import { buildGrokSessionUpdate, GrokLiveTransport } from "../../src/live/grok-transport";
import { buildDelegationContextAppend, type LiveServerEvent } from "../../src/live/protocol";
import type { LiveTransportCallbacks, LiveTransportOptions } from "../../src/live/transport-types";

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;

class ControlledWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static readonly instances: ControlledWebSocket[] = [];

	readyState = ControlledWebSocket.CONNECTING;
	binaryType = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	readonly sent: string[] = [];
	closeCalls = 0;

	constructor() {
		ControlledWebSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code = 1000, reason = ""): void {
		this.closeCalls += 1;
		this.readyState = ControlledWebSocket.CLOSED;
		this.onclose?.({ code, reason } as CloseEvent);
	}

	open(): void {
		this.readyState = ControlledWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}
}

async function waitForSocket(): Promise<ControlledWebSocket> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const socket = ControlledWebSocket.instances[0];
		if (socket) return socket;
		await Promise.resolve();
	}
	throw new Error("Grok transport did not create a WebSocket");
}

function createTransport(callbacks: LiveTransportCallbacks): GrokLiveTransport {
	return new GrokLiveTransport({
		authStorage: {
			getApiKey: async () => "test-xai-key",
		} as unknown as LiveTransportOptions["authStorage"],
		sessionId: "test-session-123",
		instructions: "Test instructions",
		voice: "eve",
		callbacks,
	});
}

describe("GrokLiveTransport", () => {
	afterEach(() => {
		globalThis.WebSocket = ORIGINAL_WEBSOCKET;
		ControlledWebSocket.instances.length = 0;
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
		expect(transport.shouldStreamAudio(0, 1)).toBe(true);
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
		transport.handleServerMessage(JSON.stringify({ type: "response.done" }));

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

	test("closes a pending socket without allowing a late open to reconnect", async () => {
		globalThis.WebSocket = ControlledWebSocket as unknown as typeof WebSocket;
		const transport = createTransport({ onEvent: () => {}, onOutputLevel: () => {} });
		const connecting = transport.connect();
		const socket = await waitForSocket();

		await transport.close();
		await expect(connecting).rejects.toThrow("closed before connecting");
		socket.open();

		expect(socket.closeCalls).toBeGreaterThanOrEqual(2);
		await expect(transport.send({ type: "session.close" })).rejects.toThrow("not connected");
	});

	test("waits for every function output before creating one continuation response", async () => {
		globalThis.WebSocket = ControlledWebSocket as unknown as typeof WebSocket;
		const events: LiveServerEvent[] = [];
		const transport = createTransport({
			onEvent: event => events.push(event),
			onOutputLevel: () => {},
		});
		const connecting = transport.connect();
		const socket = await waitForSocket();
		socket.open();
		await connecting;
		socket.sent.length = 0;

		transport.handleServerMessage(
			JSON.stringify({
				type: "response.function_call_arguments.done",
				call_id: "call-1",
				arguments: JSON.stringify({ request: "First task" }),
			}),
		);
		transport.handleServerMessage(
			JSON.stringify({
				type: "response.function_call_arguments.done",
				call_id: "call-2",
				arguments: JSON.stringify({ request: "Second task" }),
			}),
		);
		expect(events).toEqual([]);
		transport.handleServerMessage(JSON.stringify({ type: "response.done" }));
		expect(events).toHaveLength(2);

		await transport.send(buildDelegationContextAppend("call-1", "First result", "speakable"));
		expect(socket.sent.map(payload => JSON.parse(payload).type)).toEqual(["conversation.item.create"]);

		await transport.send(buildDelegationContextAppend("call-2", "Second result", "speakable"));
		expect(socket.sent.map(payload => JSON.parse(payload).type)).toEqual([
			"conversation.item.create",
			"conversation.item.create",
			"response.create",
		]);
		await transport.close();
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
