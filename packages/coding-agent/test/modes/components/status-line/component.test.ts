import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../../src/config/settings";
import { StatusLineComponent } from "../../../../src/modes/components/status-line/component";
import { getThemeByName, setThemeInstance } from "../../../../src/modes/theme/theme";
import type { AgentSession } from "../../../../src/session/agent-session";

// The cost assertions below care about how the two costs are rendered, not about
// terminal width. The status line also shows the cwd and git branch, so a long
// checkout path or branch name eats the budget and pushes the cost segment out
// at a realistic 120 columns. Render these two cases wide enough that the
// segment always fits, and let the width-sensitive behavior stay covered by the
// truncation tests that target it directly.
const WIDE_ENOUGH_FOR_COST_SEGMENT = 400;

function makeSessionWithLastMessage(
	lastMessage: unknown,
	{ cost = 0, usingSubscription = false }: { cost?: number; usingSubscription?: boolean } = {},
) {
	return {
		messages: lastMessage ? [lastMessage] : [],
		model: { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		state: {
			messages: lastMessage ? [lastMessage] : [],
			model: { contextWindow: 128000 },
		},
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost,
				tokensPerSecond: null,
			}),
			getSessionName: () => "test-session",
		},
		getAsyncJobSnapshot: () => undefined,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: {
			isUsingOAuth: () => usingSubscription,
		},
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("StatusLineComponent", () => {
	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage({
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "toolCall",
						name: "read",
						arguments: { offset: 1n, nested: { limit: 2n } },
					},
				],
			}) as unknown as AgentSession,
		);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});
	it("renders subscription costs", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, {
				cost: 2.67,
				usingSubscription: true,
			}) as unknown as AgentSession,
		);

		const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("S2.67");
	});
});
