import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Tool } from "@oh-my-pi/pi-ai";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { toReasoningEffort } from "../thinking";

const RESPOND_TOOL_NAME = "respond";

const RESPOND_TOOL: Tool = {
	name: RESPOND_TOOL_NAME,
	description: "Return the next guided-goal interview step.",
	parameters: {
		type: "object",
		properties: {
			kind: { type: "string", enum: ["question", "ready"] },
			question: { type: "string" },
			objective: { type: "string" },
		},
		required: ["kind"],
		additionalProperties: false,
	},
	strict: false,
};

export interface GuidedGoalMessage {
	role: "user" | "assistant";
	content: string;
}

export type GuidedGoalTurnResult = { kind: "question"; question: string } | { kind: "ready"; objective: string };

export interface GuidedGoalTurnOptions {
	messages: readonly GuidedGoalMessage[];
	signal?: AbortSignal;
}

function renderMessages(messages: readonly GuidedGoalMessage[]): string {
	return messages.map(message => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
}

function parseGuidedGoalPayload(value: unknown): GuidedGoalTurnResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("guided goal returned an invalid response");
	}
	const payload = value as Record<string, unknown>;
	if (payload.kind === "question" && typeof payload.question === "string" && payload.question.trim()) {
		return { kind: "question", question: payload.question.trim() };
	}
	if (payload.kind === "ready" && typeof payload.objective === "string" && payload.objective.trim()) {
		return { kind: "ready", objective: payload.objective.trim() };
	}
	throw new Error("guided goal returned an invalid response");
}

function parseToolArguments(value: unknown): unknown {
	return typeof value === "string" ? parseJsonPayload(value) : value;
}

export async function runGuidedGoalTurn(
	session: AgentSession,
	options: GuidedGoalTurnOptions,
): Promise<GuidedGoalTurnResult> {
	const plan = session.resolveRoleModelWithThinking("plan");
	const resolved = plan.model ? plan : session.resolveRoleModelWithThinking("slow");
	if (!resolved.model) {
		throw new Error("No plan or slow model is available for /guided-goal.");
	}

	const apiKey = await session.modelRegistry.getApiKey(resolved.model, session.sessionId);
	if (!apiKey) {
		throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
	}

	const prompt = guidedGoalInterviewPrompt.replace("{{messages}}", renderMessages(options.messages));
	const response = await instrumentedCompleteSimple(
		resolved.model,
		{
			systemPrompt: ["You are a precise goal setup interviewer."],
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			tools: [RESPOND_TOOL],
		},
		{
			apiKey: session.modelRegistry.resolver(resolved.model, session.sessionId),
			signal: options.signal,
			reasoning: toReasoningEffort(resolved.thinkingLevel),
			toolChoice: { type: "tool", name: RESPOND_TOOL_NAME },
		},
		{ telemetry: resolveTelemetry(session.agent.telemetry, session.sessionId), oneshotKind: "guided_goal_setup" },
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage ?? "guided goal request failed");
	}
	if (response.stopReason === "aborted") {
		throw new Error("guided goal request aborted");
	}

	const call = extractToolCall(response, RESPOND_TOOL_NAME);
	if (call) {
		return parseGuidedGoalPayload(parseToolArguments(call.arguments));
	}

	const text = extractTextContent(response);
	if (!text) {
		throw new Error("guided goal returned an invalid response");
	}
	return parseGuidedGoalPayload(parseJsonPayload(text));
}
