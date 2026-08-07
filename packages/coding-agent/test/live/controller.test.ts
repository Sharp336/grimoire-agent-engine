import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { LiveSessionCallbacks } from "../../src/live/controller";
import { LiveSessionController } from "../../src/live/controller";
import { GrokVoiceProvider } from "../../src/live/providers/grok";

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
});
