import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const COLLIDING_SESSION_IDS = ["01a03242-993e-73f7-9bb9-4be42368e12f", "01a03242-e0d8-7074-806e-79104cd3e1d3"] as const;

beforeAll(async () => {
	await initTheme();
});

function renderSession(sessionId: string, length?: number): string {
	const ctx = {
		session: { sessionManager: { getSessionId: () => sessionId } },
		options: length === undefined ? {} : { session: { length } },
	} as unknown as SegmentContext;
	return Bun.stripANSI(renderSegment("session", ctx).content);
}

describe("session status-line segment", () => {
	it("distinguishes nearby UUIDv7 sessions by default", () => {
		const [first, second] = COLLIDING_SESSION_IDS.map(id => renderSession(id));

		expect(first).toContain("01a03242-993e");
		expect(second).toContain("01a03242-e0d8");
		expect(first).not.toBe(second);
	});

	it("honors a configured prefix length", () => {
		expect(renderSession(COLLIDING_SESSION_IDS[0], 8)).toContain("01a03242");
		expect(renderSession(COLLIDING_SESSION_IDS[0], 8)).not.toContain("01a03242-993e");
	});

	it("clamps configured prefix lengths to at least one character", () => {
		expect(renderSession(COLLIDING_SESSION_IDS[0], 0)).not.toContain("new");
		expect(renderSession(COLLIDING_SESSION_IDS[0], 0)).toContain("0");
	});
});
