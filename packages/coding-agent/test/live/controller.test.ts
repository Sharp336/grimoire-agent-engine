import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as natives from "@oh-my-pi/pi-natives";
import { type LiveSessionCallbacks, LiveSessionController } from "../../src/live/controller";
import type { GrokLiveTransport } from "../../src/live/grok-transport";
import type { LiveClientMessage } from "../../src/live/protocol";
import { GrokVoiceProvider } from "../../src/live/providers/grok";
import type { ILiveTransport, LiveTransportCallbacks } from "../../src/live/transport-types";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";

const callbacks: LiveSessionCallbacks = {
	onPhase: () => {},
	onLevels: () => {},
	onTranscript: () => {},
	onTerminal: () => {},
};

describe("LiveSessionController", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("does not create a transport after the session stops during provider selection", async () => {
		const createTransport = vi.spyOn(GrokVoiceProvider.prototype, "createTransport");
		const session = {
			sessionId: "test-session",
			modelRegistry: { authStorage: {} },
		} as unknown as AgentSession;
		const controller = new LiveSessionController({
			session,
			extractAssistantText: () => "",
			provider: "grok",
			callbacks,
		});

		const starting = controller.start();
		await controller.stop();

		await expect(starting).rejects.toThrow("stopped while selecting a provider");
		expect(createTransport).not.toHaveBeenCalled();
	});

	test("routes two function calls to separate agent turns and returns each result to its caller", async () => {
		const fakeAudioCapture = () => ({ stop: () => {} });
		const audioCaptureSpy = vi.spyOn(natives, "AudioCapture") as unknown as {
			mockImplementation(implementation: typeof fakeAudioCapture): void;
		};
		audioCaptureSpy.mockImplementation(fakeAudioCapture);

		const sent: LiveClientMessage[] = [];
		const resultsRouted = Promise.withResolvers<void>();
		let transportCallbacks: LiveTransportCallbacks | undefined;
		const transport = {
			identity: { voiceProvider: "grok", api: "openai-completions", provider: "xai", model: "grok-voice" },
			connect: vi.fn(async () => {}),
			send: vi.fn(async (message: LiveClientMessage) => {
				sent.push(message);
				if (sent.length === 2) resultsRouted.resolve();
			}),
			shouldStreamAudio: () => true,
			pushAudio: () => {},
			setMuted: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		} satisfies ILiveTransport;
		vi.spyOn(GrokVoiceProvider.prototype, "createTransport").mockImplementation(options => {
			transportCallbacks = options.callbacks;
			return transport as unknown as GrokLiveTransport;
		});

		const requests: string[] = [];
		const agentResults = ["First result", "Second result"];
		let sessionListener: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			sessionId: "test-session",
			modelRegistry: { authStorage: {} },
			sendCustomMessage: vi.fn(async (message: { content: string }) => {
				requests.push(message.content);
			}),
			subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
				sessionListener = listener;
				return () => {};
			}),
		} as unknown as AgentSession;
		const controller = new LiveSessionController({
			session,
			extractAssistantText: () => agentResults.shift() ?? "",
			provider: "grok",
			callbacks,
		});
		await controller.start();

		const onEvent = transportCallbacks?.onEvent;
		if (!onEvent || !sessionListener) throw new Error("live callbacks were not installed");
		onEvent({
			type: "delegation.created",
			item: {
				type: "delegation",
				target: "client",
				id: "call-1",
				content: [{ type: "input_text", text: "First request" }],
			},
		});
		onEvent({
			type: "delegation.created",
			item: {
				type: "delegation",
				target: "client",
				id: "call-2",
				content: [{ type: "input_text", text: "Second request" }],
			},
		});
		sessionListener({
			type: "agent_end",
			messages: [{ role: "assistant" }],
		} as unknown as AgentSessionEvent);
		sessionListener({
			type: "agent_end",
			messages: [{ role: "assistant" }],
		} as unknown as AgentSessionEvent);
		await resultsRouted.promise;

		expect(requests).toEqual(["First request", "Second request"]);
		const routedResults = sent.filter(message => message.type === "delegation.context.append");
		expect(routedResults.map(message => message.delegation_item_id)).toEqual(["call-1", "call-2"]);
		expect(routedResults.map(message => message.content[0]?.text)).toEqual([
			expect.stringContaining("First result"),
			expect.stringContaining("Second result"),
		]);

		await controller.stop();
	});
});
