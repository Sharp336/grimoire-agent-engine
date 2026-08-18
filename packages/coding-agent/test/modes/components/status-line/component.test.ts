import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../../src/config/settings";
import { StatusLineComponent } from "../../../../src/modes/components/status-line/component";
import { getThemeByName, setThemeInstance } from "../../../../src/modes/theme/theme";
import type { AgentSession } from "../../../../src/session/agent-session";

function makeSessionWithLastMessage(
	lastMessage: unknown,
	prewalkArmed: boolean = false,
	{
		cost = 0,
		directCost,
		advisorCost = 0,
		usingSubscription = false,
	}: { cost?: number; directCost?: number; advisorCost?: number; usingSubscription?: boolean } = {},
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
			getDirectUsageCost: () => directCost,
		},
		getPrewalkState: () => (prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined),
		getAsyncJobSnapshot: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({
			configured: advisorCost > 0,
			advisors: advisorCost > 0 ? [{ name: "test", status: "running" as const }] : [],
		}),
		getAdvisorCost: () => advisorCost,
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

	it("renders Prewalk annotation when prewalk is armed", () => {
		const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null, true) as unknown as AgentSession);

		// By default preset, 'mode' segment is included in left/right segments.
		// Let's get the border and see if Prewalk is rendered.
		const border = statusLine.getTopBorder(100);
		// SGR codes might be included, so we check if the stripped content contains "Prewalk"
		const stripped = border.content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("Prewalk");
	});
	it("renders primary and advisor costs separately", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, {
				cost: 2.67,
				advisorCost: 0.41,
				usingSubscription: true,
			}) as unknown as AgentSession,
		);

		const stripped = statusLine.getTopBorder(120).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("$2.67 (sub) + $0.41 (adv)");
	});
	it("renders descendant subagent cost separately from direct session cost", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, {
				cost: 2.67,
				directCost: 2.67,
				advisorCost: 0.41,
			}) as unknown as AgentSession,
		);
		statusLine.setSubagentCostProvider(() => 1.23);

		const stripped = statusLine.getTopBorder(200).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("$2.67 + $1.23 (subagents) + $0.41 (adv)");
	});
	it("uses durable direct cost instead of aggregate task-inclusive cost", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, { cost: 5, directCost: 2 }) as unknown as AgentSession,
		);

		const stripped = statusLine.getTopBorder(120).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("$2.00");
		expect(stripped).not.toContain("$5.00");
	});
	it("preserves the task-inclusive aggregate for collab guests", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, { cost: 5, directCost: 2 }) as unknown as AgentSession,
		);
		statusLine.setCollabStatus({ role: "guest", participantCount: 1 });
		statusLine.setSubagentCostProvider(() => 3);

		const stripped = statusLine.getTopBorder(200).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("$5.00");
		expect(stripped).not.toContain("$2.00");
		expect(stripped).not.toContain("$3.00");
		expect(stripped).not.toContain("(subagents)");
	});

	it("omits advisor cost when the advisor has never been active", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, {
				cost: 2.67,
				usingSubscription: true,
			}) as unknown as AgentSession,
		);

		const stripped = statusLine.getTopBorder(120).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("$2.67 (sub)");
		expect(stripped).not.toContain("(adv)");
	});
});
