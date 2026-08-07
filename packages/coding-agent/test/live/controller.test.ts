import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { LiveSessionCallbacks } from "../../src/live/controller";
import { LiveSessionController } from "../../src/live/controller";
import { GrokLiveTransport } from "../../src/live/grok-transport";

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

	test("closes a transport selected after the session stops", async () => {
		const connect = vi.spyOn(GrokLiveTransport.prototype, "connect").mockResolvedValue();
		const close = vi.spyOn(GrokLiveTransport.prototype, "close");
		const session = {
			sessionId: "test-session",
			modelRegistry: { authStorage: {} },
		} as unknown as AgentSession;
		const controller = new LiveSessionController({
			session,
			extractAssistantText: () => "",
			provider: "xai-grok",
			callbacks,
		});

		const starting = controller.start();
		await controller.stop();

		await expect(starting).rejects.toThrow("stopped while selecting a provider");
		expect(close).toHaveBeenCalledTimes(1);
		expect(connect).not.toHaveBeenCalled();
	});
});
