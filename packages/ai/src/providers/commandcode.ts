/**
 * Command Code provider transport.
 *
 * Command Code exposes a proprietary streaming endpoint rather than an
 * OpenAI-compatible API. The request and event shapes here are based on the
 * MIT-licensed community provider at github.com/ninehills/pi-commandcode-provider.
 */
import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import { calculateCost } from "../models";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolCall,
} from "../types";
import { isRecord, normalizeSystemPrompts, toNumber } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { notifyProviderResponse } from "../utils/provider-response";
import { toolWireSchema } from "../utils/schema/wire";

export interface CommandCodeOptions extends StreamOptions {}

const DEFAULT_BASE_URL = "https://api.commandcode.ai";
const COMMAND_CODE_CLI_VERSION = "0.27.2";
const COMMAND_CODE_MAX_OUTPUT_TOKENS = 200_000;

type CommandCodeEvent = {
	type?: string;
	text?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	input?: unknown;
	args?: unknown;
	arguments?: unknown;
	finishReason?: unknown;
	totalUsage?: unknown;
	error?: unknown;
};

function createEmptyOutput(model: Model<"commandcode">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "commandcode",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function pairedToolCallIds(messages: readonly Message[]): Set<string> {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const content of message.content) {
				if (content.type === "toolCall") calls.add(content.id);
			}
		} else if (message.role === "toolResult") {
			results.add(message.toolCallId);
		}
	}
	return new Set(Array.from(calls).filter(id => results.has(id)));
}

function toCommandCodeMessages(messages: readonly Message[]): unknown[] {
	const pairedIds = pairedToolCallIds(messages);
	const converted: unknown[] = [];
	for (const message of messages) {
		if (message.role === "user" || message.role === "developer") {
			converted.push({ role: "user", content: message.content });
			continue;
		}
		if (message.role === "assistant") {
			const content: unknown[] = [];
			for (const part of message.content) {
				if (part.type === "text") {
					content.push({ type: "text", text: part.text });
				} else if (part.type === "thinking") {
					content.push({ type: "reasoning", text: part.thinking });
				}
				if (part.type === "toolCall" && pairedIds.has(part.id)) {
					content.push({
						type: "tool-call",
						toolCallId: part.id,
						toolName: part.name,
						input: part.arguments,
					});
				}
			}
			if (content.length > 0) converted.push({ role: "assistant", content });
			continue;
		}
		if (pairedIds.has(message.toolCallId)) {
			const value = message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n");
			converted.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						output: { type: message.isError ? "error-text" : "text", value },
					},
				],
			});
		}
	}
	return converted;
}

function toCommandCodeTools(tools: readonly Tool[] | undefined): unknown[] {
	return (tools ?? []).map(tool => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		input_schema: toolWireSchema(tool),
	}));
}

function parseEventLine(line: string): CommandCodeEvent | undefined {
	let value = line.trim();
	if (!value || value.startsWith(":") || value.startsWith("event:")) return undefined;
	if (value.startsWith("data:")) value = value.slice("data:".length).trim();
	if (!value || value === "[DONE]") return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function doneReason(reason: unknown): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> {
	if (reason === "tool-calls") return "toolUse";
	if (reason === "length" || reason === "max_tokens" || reason === "max-tokens" || reason === "max_output_tokens") {
		return "length";
	}
	return "stop";
}

function buildRequest(
	model: Model<"commandcode">,
	context: Context,
	options: CommandCodeOptions,
): Record<string, unknown> {
	const maxTokens = Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens, COMMAND_CODE_MAX_OUTPUT_TOKENS);
	return {
		config: {
			workingDir: process.cwd(),
			date: new Date().toISOString().split("T")[0],
			environment: `${process.platform}-${process.arch}, Bun ${Bun.version}`,
			structure: [],
			isGitRepo: false,
			currentBranch: "",
			mainBranch: "",
			gitStatus: "",
			recentCommits: [],
		},
		memory: "",
		taste: "",
		skills: null,
		permissionMode: "standard",
		params: {
			model: model.id,
			messages: toCommandCodeMessages(context.messages),
			tools: toCommandCodeTools(context.tools),
			system: normalizeSystemPrompts(context.systemPrompt).join("\n\n"),
			max_tokens: maxTokens,
			stream: true,
		},
	};
}

export const streamCommandCode: StreamFunction<"commandcode"> = (
	model: Model<"commandcode">,
	context: Context,
	options: CommandCodeOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const output = createEmptyOutput(model);
		const startTime = Date.now();
		let firstTokenTime: number | undefined;
		let errorStatus: number | undefined;
		let activeTextIndex: number | undefined;
		let activeThinkingIndex: number | undefined;

		const endText = (): void => {
			if (activeTextIndex === undefined) return;
			const part = output.content[activeTextIndex];
			if (part?.type === "text") {
				stream.push({ type: "text_end", contentIndex: activeTextIndex, content: part.text, partial: output });
			}
			activeTextIndex = undefined;
		};
		const endThinking = (): void => {
			if (activeThinkingIndex === undefined) return;
			const part = output.content[activeThinkingIndex];
			if (part?.type === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: activeThinkingIndex,
					content: part.thinking,
					partial: output,
				});
			}
			activeThinkingIndex = undefined;
		};
		const markFirstToken = (): void => {
			firstTokenTime ??= Date.now();
		};

		try {
			const apiKey = options.apiKey || getEnvApiKey(model.provider);
			if (!apiKey) throw new Error("No API key for provider: commandcode");

			let body: unknown = buildRequest(model, context, options);
			const replacementPayload = await options.onPayload?.(body, model);
			if (replacementPayload !== undefined) body = replacementPayload;

			const baseUrl = model.baseUrl?.replace(/\/+$/, "") || DEFAULT_BASE_URL;
			const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/alpha/generate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
					"x-command-code-version": COMMAND_CODE_CLI_VERSION,
					"x-cli-environment": "production",
					"x-project-slug": "omp",
					"x-taste-learning": "false",
					"x-co-flag": "false",
					"x-session-id": options.sessionId ?? crypto.randomUUID(),
					...model.headers,
					...options.headers,
				},
				body: JSON.stringify(body),
				signal: options.signal,
			});
			await notifyProviderResponse(options, response, model);
			if (!response.ok) {
				errorStatus = response.status;
				const detail = (await response.text().catch(() => "")).slice(0, 500);
				throw new Error(`Command Code API error ${response.status}${detail ? `: ${detail}` : ""}`);
			}
			if (!response.body) throw new Error("Command Code returned an empty response body");

			stream.push({ type: "start", partial: output });
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let finished = false;
			const finish = (event: CommandCodeEvent): void => {
				endText();
				endThinking();
				const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined;
				const details = usage && isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined;
				output.usage.input = toNumber(usage?.inputTokens) ?? 0;
				output.usage.output = toNumber(usage?.outputTokens) ?? 0;
				output.usage.cacheRead = toNumber(details?.cacheReadTokens) ?? 0;
				output.usage.cacheWrite = toNumber(details?.cacheWriteTokens) ?? 0;
				output.usage.totalTokens =
					output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				calculateCost(model, output.usage);
				output.stopReason = doneReason(event.finishReason);
			};
			try {
				while (!finished) {
					const chunk = await reader.read();
					if (chunk.done) break;
					buffer += decoder.decode(chunk.value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						const event = parseEventLine(line);
						if (!event) continue;
						if (event.type === "text-delta") {
							endThinking();
							if (activeTextIndex === undefined) {
								output.content.push({ type: "text", text: "" });
								activeTextIndex = output.content.length - 1;
								stream.push({ type: "text_start", contentIndex: activeTextIndex, partial: output });
							}
							const text = asString(event.text) ?? "";
							const part = output.content[activeTextIndex];
							if (part?.type === "text") part.text += text;
							stream.push({ type: "text_delta", contentIndex: activeTextIndex, delta: text, partial: output });
							markFirstToken();
							continue;
						}
						if (event.type === "reasoning-delta") {
							endText();
							if (activeThinkingIndex === undefined) {
								output.content.push({ type: "thinking", thinking: "" });
								activeThinkingIndex = output.content.length - 1;
								stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: output });
							}
							const text = asString(event.text) ?? "";
							const part = output.content[activeThinkingIndex];
							if (part?.type === "thinking") part.thinking += text;
							stream.push({
								type: "thinking_delta",
								contentIndex: activeThinkingIndex,
								delta: text,
								partial: output,
							});
							markFirstToken();
							continue;
						}
						if (event.type === "reasoning-end") {
							endThinking();
							continue;
						}
						if (event.type === "tool-call") {
							endText();
							endThinking();
							const toolCall: ToolCall = {
								type: "toolCall",
								id: asString(event.toolCallId) ?? crypto.randomUUID(),
								name: asString(event.toolName) ?? "unknown_tool",
								arguments: recordOrEmpty(event.input ?? event.args ?? event.arguments),
							};
							output.content.push(toolCall);
							const index = output.content.length - 1;
							stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
							stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
							markFirstToken();
							continue;
						}
						if (event.type === "finish") {
							finish(event);
							finished = true;
							break;
						}
						if (event.type === "error") {
							const error = isRecord(event.error) ? asString(event.error.message) : asString(event.error);
							throw new Error(error ?? "Command Code stream error");
						}
					}
				}
			} finally {
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
			if (!finished && buffer.trim()) {
				const event = parseEventLine(buffer);
				if (event?.type === "finish") {
					finish(event);
					finished = true;
				}
			}
			if (!finished) throw new Error("Command Code stream ended before a finish event");
			output.duration = Date.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			const reason =
				output.stopReason === "length" ? "length" : output.stopReason === "toolUse" ? "toolUse" : "stop";
			stream.push({ type: "done", reason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorStatus = errorStatus ?? extractHttpStatusFromError(error);
			output.errorMessage =
				output.stopReason === "aborted"
					? "Request was aborted"
					: String(error instanceof Error ? error.message : error);
			output.duration = Date.now() - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};
