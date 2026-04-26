import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createContext(orchestratorMode: boolean): SegmentContext {
	return {
		session: {
			orchestratorMode,
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		sessionStartTime: Date.now(),
		git: {
			branch: null,
			status: null,
			pr: null,
		},
	};
}

describe("status line pi orchestrator marker", () => {
	it("renders a distinct marker when orchestrator mode is enabled", () => {
		const disabled = renderSegment("pi", createContext(false));
		const enabled = renderSegment("pi", createContext(true));

		expect(disabled.visible).toBe(true);
		expect(enabled.visible).toBe(true);

		const disabledPlain = Bun.stripANSI(disabled.content);
		const enabledPlain = Bun.stripANSI(enabled.content);
		const marker = "\u2208";

		expect(disabledPlain).not.toContain(marker);
		expect(enabledPlain).not.toBe(disabledPlain);
		expect(enabledPlain.startsWith(marker)).toBe(true);
		expect(enabledPlain).toBe(`${marker} ${disabledPlain}`);
	});
});
