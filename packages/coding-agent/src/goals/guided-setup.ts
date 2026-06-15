import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Message, Tool, ToolCall } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import guidedGoalSystemPrompt from "../prompts/goals/guided-goal-system.md" with { type: "text" };
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

/**
 * Read-only builtin tools the guided-goal interviewer may call to ground its
 * questions/objective in the actual repo. All three are in READ_ONLY_TOOL_NAMES
 * (task/index.ts) — no workspace mutation, no external service. `lsp` (per-call
 * write tiers, needs running servers) and `web_search` (external knowledge,
 * usually disabled) are intentionally excluded.
 */
const GUIDED_GOAL_EXPLORE_TOOLS: readonly string[] = ["read", "search", "find"] as const;

/** Max read-only tool rounds before the final turn is forced to `respond`. */
const MAX_GUIDED_GOAL_TOOL_ROUNDS = 6;

export interface GuidedGoalMessage {
	role: "user" | "assistant";
	content: string;
}

export type GuidedGoalTurnResult =
	| { kind: "question"; question: string; objective?: string }
	| { kind: "ready"; objective: string };

export interface GuidedGoalTurnOptions {
	messages: readonly GuidedGoalMessage[];
	signal?: AbortSignal;
}

function parseGuidedGoalPayload(value: unknown): GuidedGoalTurnResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("guided goal returned an invalid response");
	}
	const payload = value as Record<string, unknown>;
	if (payload.kind === "question" && typeof payload.question === "string" && payload.question.trim()) {
		const question = payload.question.trim();
		if (typeof payload.objective === "string" && payload.objective.trim()) {
			return { kind: "question", question, objective: payload.objective.trim() };
		}
		return { kind: "question", question };
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

	const userPrompt = prompt.render(guidedGoalInterviewPrompt, {
		messages: options.messages.map(message => ({ label: message.role.toUpperCase(), content: message.content })),
	});
	// Secret obfuscation: route the user-authored transcript through the session obfuscator the
	// same way normal turns do, so an API key / secret typed into the rough goal or an answer is
	// never sent verbatim to the plan/slow provider. Deobfuscated again below before display/use.
	const obfuscator = session.obfuscator;
	const promptText = obfuscator?.hasSecrets() ? obfuscator.obfuscate(userPrompt) : userPrompt;

	// Read-only exploration tools, pulled from the session's already-constructed,
	// ToolSession-bound registry (getToolByName covers active + discoverable). A
	// tool absent from settings resolves undefined and is skipped.
	const exploreTools: AgentTool[] = [];
	const toolByName = new Map<string, AgentTool>();
	for (const name of GUIDED_GOAL_EXPLORE_TOOLS) {
		const tool = session.getToolByName(name);
		if (tool) {
			exploreTools.push(tool);
			toolByName.set(tool.name, tool);
		}
	}
	const tools: Tool[] = [...exploreTools, RESPOND_TOOL];
	const maxRounds = exploreTools.length > 0 ? MAX_GUIDED_GOAL_TOOL_ROUNDS : 0;

	const messages: Message[] = [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }];
	const completeOptions = {
		apiKey: session.modelRegistry.resolver(resolved.model, session.sessionId),
		signal: options.signal,
		reasoning: toReasoningEffort(resolved.thinkingLevel),
	};
	const span = {
		telemetry: resolveTelemetry(session.agent.telemetry, session.sessionId),
		oneshotKind: "guided_goal_setup",
	};

	let result: GuidedGoalTurnResult | undefined;
	for (let round = 0; round <= maxRounds && !result; round++) {
		// Final round (or no tools available): force a structured answer so the loop always terminates.
		const forceRespond = round >= maxRounds;
		const response = await instrumentedCompleteSimple(
			resolved.model,
			{ systemPrompt: [prompt.render(guidedGoalSystemPrompt)], messages, tools },
			{ ...completeOptions, toolChoice: forceRespond ? { type: "tool", name: RESPOND_TOOL_NAME } : "auto" },
			span,
		);
		if (response.stopReason === "error") {
			throw new Error(response.errorMessage ?? "guided goal request failed");
		}
		if (response.stopReason === "aborted") {
			throw new Error("guided goal request aborted");
		}

		const respondCall = extractToolCall(response, RESPOND_TOOL_NAME);
		if (respondCall) {
			result = parseGuidedGoalPayload(parseToolArguments(respondCall.arguments));
			break;
		}

		const toolCalls = response.content.filter((content): content is ToolCall => content.type === "toolCall");
		if (toolCalls.length === 0) {
			// No tool call and no respond: fall back to a raw JSON payload in the text, else fail.
			const text = extractTextContent(response);
			if (text) {
				result = parseGuidedGoalPayload(parseJsonPayload(text));
				break;
			}
			throw new Error("guided goal returned an invalid response");
		}

		// Append the assistant turn, then one toolResult per call (every call must be
		// answered to keep provider tool_use/tool_result pairing valid for the next round).
		messages.push(response);
		for (const call of toolCalls) {
			const tool = toolByName.get(call.name);
			let toolResult: AgentToolResult;
			if (!tool) {
				toolResult = { content: [{ type: "text", text: `Tool "${call.name}" is not available.` }], isError: true };
			} else {
				try {
					toolResult = await tool.execute(call.id, call.arguments, options.signal);
				} catch (error) {
					toolResult = {
						content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
						isError: true,
					};
				}
			}
			const content =
				obfuscator?.hasSecrets() && !toolResult.isError
					? toolResult.content.map(block =>
							block.type === "text" ? { ...block, text: obfuscator.obfuscate(block.text) } : block,
						)
					: toolResult.content;
			messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content,
				details: toolResult.details,
				isError: toolResult.isError ?? false,
				timestamp: Date.now(),
			});
		}
	}

	if (!result) {
		throw new Error("guided goal returned an invalid response");
	}

	// Reverse the obfuscation: restore any secret placeholders the model echoed back before the
	// question/objective is shown or the goal is started.
	if (!obfuscator?.hasSecrets()) return result;
	if (result.kind === "question") {
		return {
			kind: "question",
			question: obfuscator.deobfuscate(result.question),
			objective: result.objective !== undefined ? obfuscator.deobfuscate(result.objective) : undefined,
		};
	}
	return { kind: "ready", objective: obfuscator.deobfuscate(result.objective) };
}
