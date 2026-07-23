import { beforeAll, describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(async () => {
	await initTheme(false);
});

function createContext() {
	const showStatus = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn() },
		viewSession: { isStreaming: false },
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, showStatus };
}

describe("EventController credential rotation", () => {
	it("routes credential_rotated to the status line, naming the rotated provider", async () => {
		const { ctx, showStatus } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "credential_rotated",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		} satisfies Extract<AgentSessionEvent, { type: "credential_rotated" }>);

		expect(showStatus).toHaveBeenCalledTimes(1);
		// The surfaced status must convey a rate-limit-driven credential rotation
		// naming the provider — so a regression to a semantically-wrong message
		// (a plain model fallback, a generic error, or the wrong provider) fails.
		const status = showStatus.mock.calls[0]![0] as string;
		expect(status).toMatch(/rate.?limit/i);
		expect(status).toMatch(/rotat/i);
		expect(status).toContain("anthropic");
	});
});
