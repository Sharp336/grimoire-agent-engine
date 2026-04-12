/**
 * Sub-agent helper — spawn a nested agentLoop with a minimal context so the
 * parent conversation is not polluted with intermediate turns.
 *
 * The sub-agent receives only the task text and the allowed subset of tools.
 * It returns the final assistant text, which the caller injects into the
 * parent context as a single developer message.
 *
 * v1 constraints:
 * - Model is inherited from the first LLM tool's implicit environment;
 *   callers must pass it explicitly via `model`.
 * - No nested flow execution — sub-agents use the plain agentLoop runner.
 *   A sub-agent with its own flow is straightforward to add later by
 *   calling runFlow recursively instead of agentLoop.
 * - budgetTurns is advisory; the current agentLoop does not enforce a turn
 *   cap directly, so the helper stops after the first assistant message
 *   with no tool calls. Follow-up budget enforcement is not yet implemented.
 */

import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core";
import type { Model, UserMessage } from "@oh-my-pi/pi-ai";
import { convertToLlm as baseConvertToLlm } from "../session/messages";
import { extractFinalAssistantText } from "./flow-message-utils";
import { isFlowStateMessage } from "./flow-state-codec";
import subAgentPrompt from "./prompts/sub-agent.md" with { type: "text" };

export interface RunSubAgentOptions {
	parentTools: readonly AgentTool<any>[];
	task: string;
	allowedTools: string[] | "*";
	model: Model;
	systemPrompt?: string;
	budgetTurns?: number;
	signal?: AbortSignal;
}

/**
 * Run a sub-agent to completion and return its final text output.
 *
 * The sub-agent has its own fresh context — no access to parent history.
 * This is deliberate: the whole point is to isolate a side task so the
 * parent's prompt cache stays hot and its history stays small.
 */
export async function runSubAgent(options: RunSubAgentOptions): Promise<string> {
	const { parentTools, task, allowedTools, model, systemPrompt, signal } = options;

	const tools = filterTools(parentTools, allowedTools);

	const context: AgentContext = {
		systemPrompt: systemPrompt ?? subAgentPrompt.trim(),
		messages: [],
		tools,
	};

	const taskPrompt: UserMessage = {
		role: "user",
		content: [{ type: "text", text: task }],
		timestamp: Date.now(),
	};

	const config: AgentLoopConfig = {
		model,
		convertToLlm: async (messages: AgentMessage[]) => baseConvertToLlm(messages.filter(m => !isFlowStateMessage(m))),
		// No flow hooks here — sub-agents run plain.
		getSteeringMessages: async () => [],
		getFollowUpMessages: async () => [],
	};

	const stream = agentLoop([taskPrompt], context, config, signal);
	const messages = await stream.result();
	return extractFinalAssistantText(messages);
}

function filterTools(all: readonly AgentTool<any>[], allowed: string[] | "*"): AgentTool<any>[] {
	if (allowed === "*") return [...all];
	const set = new Set(allowed);
	return all.filter(t => set.has(t.name));
}
