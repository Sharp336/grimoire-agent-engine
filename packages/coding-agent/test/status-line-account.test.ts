import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { initTheme } from "../src/modes/theme/theme";
import type { OAuthCredential } from "../src/session/auth-storage";

beforeAll(async () => {
	await initTheme();
});

function createCredential(email: string, accountId: string): OAuthCredential {
	return {
		type: "oauth",
		refresh: "refresh-token",
		access: "access-token",
		email,
		accountId,
		expires: 0,
	};
}

function createAccountContext(): SegmentContext {
	const credential = createCredential("dev@example.com", "acct_1234567890");

	return {
		session: {
			state: {
				model: { provider: "anthropic" },
			},
			sessionId: "session-1",
			isFastModeEnabled: () => false,
			modelRegistry: {
				isUsingOAuth: () => true,
				authStorage: {
					getAccountStatus: () => ({ activeIndex: 1, active: 2, total: 3 }),
					getAccountInfos: () => [{ credential }, { credential }, { credential }],
				},
			},
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		loopMode: null,
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

describe("status line account segment", () => {
	it("shows provider, active account label, and active/total counts", () => {
		const rendered = renderSegment("account", createAccountContext());

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("Anthropic");
		expect(rendered.content).toContain("dev@example.com");
		expect(rendered.content).toContain("(2/3)");
	});

	it("shows the active account even when only one account exists", () => {
		const context = createAccountContext();
		const authStorage = context.session.modelRegistry.authStorage as unknown as {
			getAccountStatus: () => { activeIndex: number; active: number; total: number } | undefined;
			getAccountInfos: () => Array<{ credential: OAuthCredential }>;
		};
		authStorage.getAccountStatus = () => undefined;
		authStorage.getAccountInfos = () => [{ credential: createCredential("solo@example.com", "acct_solo") }];

		const rendered = renderSegment("account", context);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("solo@example.com");
		expect(rendered.content).not.toContain("(1/1)");
	});
});
