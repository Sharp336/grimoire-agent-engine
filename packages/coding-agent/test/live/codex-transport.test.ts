import { describe, expect, test } from "bun:test";
import { CodexLiveTransport } from "../../src/live/transport";
import type { LiveTransportOptions } from "../../src/live/transport-types";

function createTransport(): CodexLiveTransport {
	return new CodexLiveTransport({
		authStorage: {} as LiveTransportOptions["authStorage"],
		sessionId: "test-session",
		instructions: "Test instructions",
		voice: "sol",
		callbacks: {
			onEvent: () => {},
			onOutputLevel: () => {},
		},
	});
}

describe("CodexLiveTransport", () => {
	test("rejects likely speaker echo while preserving genuine barge-in", () => {
		const transport = createTransport();

		expect(transport.shouldStreamAudio(0.01, 0)).toBe(true);
		expect(transport.shouldStreamAudio(0.02, 0.1)).toBe(false);
		expect(transport.shouldStreamAudio(0.08, 0.1)).toBe(true);
	});
});
