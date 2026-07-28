import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, completeSimple, type Message, type TextContent } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";

import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import nextPromptSuggestionPrompt from "../prompts/system/next-prompt-suggestion.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { sanitizeAssistantForReparentedHistory } from "../session/messages";
import { isTerminalTextAssistantAnswer, isUserQueuedMessage } from "../session/queued-messages";
import { MAX_TINY_MESSAGE_CHARS, preprocessTinyMessage } from "../tiny/message-preproc";

const SYSTEM_PROMPT = prompt.render(nextPromptSuggestionPrompt);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MARKDOWN_FENCE = /```|~~~/u;
const EXTERNAL_QUOTE_PAIRS = [
	['"', '"'],
	["'", "'"],
	["“", "”"],
	["‘", "’"],
] as const;

export const NEXT_PROMPT_CONTEXT_MAX_CHARS = MAX_TINY_MESSAGE_CHARS;
export const NEXT_PROMPT_SUGGESTION_MAX_CHARS = 500;
export const NEXT_PROMPT_MAX_TOKENS = 1024;
export const NEXT_PROMPT_TIMEOUT_MS = 6000;
export const NEXT_PROMPT_EXPIRY_MS = 30_000;

export interface GenerateNextPromptSuggestionOptions {
	session: AgentSession;
	settings: Settings;
	event: Extract<AgentSessionEvent, { type: "agent_end" }>;
	signal: AbortSignal;
}

export type NextPromptSuggestionGenerator = (options: GenerateNextPromptSuggestionOptions) => Promise<string | null>;

function textContent(content: string | readonly { type: string; text?: string }[]): string | TextContent[] | null {
	if (typeof content === "string") return content.trim().length > 0 ? content : null;
	const text = content.filter((part): part is TextContent => part.type === "text").map(part => ({ ...part }));
	return text.some(part => part.text.trim().length > 0) ? text : null;
}

function stripProviderPayload<M extends AgentMessage>(message: M): M {
	const { providerPayload: _ignored, ...rest } = message as M & { providerPayload?: unknown };
	void _ignored;
	return rest as M;
}

/** Latest assistant answer of the event, only when it is the terminal textual answer. */
function selectTerminalAssistant(
	messages: readonly AgentMessage[],
): { assistant: AssistantMessage; index: number } | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return isTerminalTextAssistantAnswer(message) ? { assistant: message, index } : null;
	}
	return null;
}

function selectContextPair(
	event: Extract<AgentSessionEvent, { type: "agent_end" }>,
): [AgentMessage, AssistantMessage] | null {
	const terminal = selectTerminalAssistant(event.messages);
	if (!terminal) return null;
	const { assistant, index: assistantIndex } = terminal;

	for (let index = assistantIndex - 1; index >= 0; index--) {
		const message = event.messages[index];
		if (!message || !isUserQueuedMessage(message)) continue;
		if (message.role !== "user" && message.role !== "custom") return null;
		if (message.role === "user" && (message.synthetic === true || message.attribution === "agent")) return null;
		const content = textContent(message.content);
		if (!content) return null;
		const assistantContent = textContent(assistant.content);
		if (!assistantContent || typeof assistantContent === "string") return null;
		const sanitizedMessage: AgentMessage = { ...stripProviderPayload(message), content };
		return [sanitizedMessage, sanitizeAssistantForReparentedHistory({ ...assistant, content: assistantContent })];
	}
	return null;
}

export function hasNextPromptSuggestionContext(event: Extract<AgentSessionEvent, { type: "agent_end" }>): boolean {
	return selectContextPair(event) !== null;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

function convertedMessageText(message: Message): string | null {
	if (typeof message.content === "string") return message.content.trim().length > 0 ? message.content : null;
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	const text = parts.join("\n");
	return text.trim().length > 0 ? text : null;
}

function prepareConvertedContext(messages: Message[], hasSecrets: boolean): Message[] | null {
	if (messages.length !== 2) return null;
	const [user, assistant] = messages;
	if ((user.role !== "user" && user.role !== "developer") || assistant.role !== "assistant") return null;
	const userText = convertedMessageText(user);
	const assistantContextText = convertedMessageText(assistant);
	if (!userText || !assistantContextText) return null;
	if (hasSecrets) {
		if (
			userText.length > NEXT_PROMPT_CONTEXT_MAX_CHARS ||
			assistantContextText.length > NEXT_PROMPT_CONTEXT_MAX_CHARS
		) {
			return null;
		}
		return messages;
	}
	return [
		{ ...user, content: preprocessTinyMessage(userText) },
		{ ...assistant, content: [{ type: "text", text: preprocessTinyMessage(assistantContextText) }] },
	];
}

function parseNextPromptSuggestion(raw: string, obfuscator: AgentSession["obfuscator"]): string | null {
	if (CONTROL_CHARACTERS.test(raw)) return null;
	const suggestion = raw.trim();
	if (!suggestion || suggestion === "NO_SUGGESTION") return null;
	if (MARKDOWN_FENCE.test(suggestion)) return null;
	if (EXTERNAL_QUOTE_PAIRS.some(([open, close]) => suggestion.startsWith(open) && suggestion.endsWith(close))) {
		return null;
	}
	if (Array.from(suggestion).length > NEXT_PROMPT_SUGGESTION_MAX_CHARS) return null;
	if (obfuscator && obfuscator.deobfuscate(suggestion) !== suggestion) return null;
	return suggestion;
}

export async function generateNextPromptSuggestion({
	session,
	settings,
	event,
	signal,
}: GenerateNextPromptSuggestionOptions): Promise<string | null> {
	try {
		if (signal.aborted) return null;
		const pair = selectContextPair(event);
		if (!pair) return null;
		const model = resolveModelRoleValue("@tiny", session.modelRegistry.getAvailable(), {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		}).model;
		if (!model) return null;
		const apiKey = await session.modelRegistry.getApiKey(model, session.sessionId);
		if (!apiKey) return null;
		if (signal.aborted) return null;

		const convertedMessages = session.convertToLlmForSideRequest(pair);
		const messages = prepareConvertedContext(convertedMessages, session.obfuscator?.hasSecrets() === true);
		if (!messages) return null;
		const response = await completeSimple(
			model,
			{ systemPrompt: [SYSTEM_PROMPT], messages },
			session.prepareSimpleStreamOptions(
				{
					apiKey: session.modelRegistry.resolver(model, session.sessionId),
					maxTokens: NEXT_PROMPT_MAX_TOKENS,
					disableReasoning: true,
					signal,
					loopGuard: { enabled: false },
					codexSseMaxAttempts: 1,
				},
				model.provider,
			),
		);
		if (signal.aborted) return null;
		if (response.stopReason === "error") return null;
		return parseNextPromptSuggestion(assistantText(response), session.obfuscator);
	} catch {
		return null;
	}
}
