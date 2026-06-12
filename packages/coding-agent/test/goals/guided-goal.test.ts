import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@oh-my-pi/pi-agent-core";
import { runGuidedGoalTurn } from "@oh-my-pi/pi-coding-agent/goals/guided-setup";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const planModel = { provider: "test", id: "plan" };
const slowModel = { provider: "test", id: "slow" };

function createSession(options?: { plan?: boolean; slow?: boolean }): AgentSession {
	const plan = options?.plan ?? true;
	const slow = options?.slow ?? true;
	return {
		resolveRoleModelWithThinking(role: string) {
			if (role === "plan" && plan) return { model: planModel, explicitThinkingLevel: false };
			if (role === "slow" && slow) return { model: slowModel, explicitThinkingLevel: false };
			return { model: undefined, explicitThinkingLevel: false };
		},
		modelRegistry: {
			getApiKey: async () => "test-key",
			resolver: (model: typeof planModel) => `${model.provider}/${model.id}:key`,
		},
		sessionId: "session-1",
		agent: { telemetry: undefined },
	} as unknown as AgentSession;
}

function mockResponse(args: unknown) {
	return {
		stopReason: "tool_use",
		content: [{ type: "toolCall", name: "respond", arguments: args }],
	};
}

describe("guided goal setup", () => {
	afterEach(() => {
		(core.instrumentedCompleteSimple as { mockRestore?: () => void }).mockRestore?.();
	});

	it("prefers the plan model", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "question", question: "What is done?" }) as never,
		);

		const result = await runGuidedGoalTurn(createSession(), { messages: [{ role: "user", content: "Ship it" }] });

		expect(result).toEqual({ kind: "question", question: "What is done?" });
		expect(complete.mock.calls[0]?.[0]).toBe(planModel);
	});

	it("falls back to slow when plan is unavailable", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "ready", objective: "Deliver the confirmed feature." }) as never,
		);

		const result = await runGuidedGoalTurn(createSession({ plan: false, slow: true }), {
			messages: [{ role: "user", content: "Ship it" }],
		});

		expect(result).toEqual({ kind: "ready", objective: "Deliver the confirmed feature." });
		expect(complete.mock.calls[0]?.[0]).toBe(slowModel);
	});

	it("throws when neither plan nor slow resolves", async () => {
		await expect(
			runGuidedGoalTurn(createSession({ plan: false, slow: false }), {
				messages: [{ role: "user", content: "Ship it" }],
			}),
		).rejects.toThrow("No plan or slow model is available for /guided-goal.");
	});

	it("rejects malformed structured responses", async () => {
		spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(mockResponse({ kind: "ready" }) as never);

		await expect(
			runGuidedGoalTurn(createSession(), { messages: [{ role: "user", content: "Ship it" }] }),
		).rejects.toThrow("guided goal returned an invalid response");
	});
});
