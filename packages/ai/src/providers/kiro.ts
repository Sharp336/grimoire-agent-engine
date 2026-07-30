import { parseKiroCredentials, resolveKiroRegion } from "@oh-my-pi/pi-catalog/discovery/kiro";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { isRecord, parseStreamingJsonThrottled, prompt } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { postH2Only, type TransportResponse } from "../transport";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toolWireSchema } from "../utils/schema/wire";
import { decodeEventStream } from "./aws-eventstream";
import toolResultsPrompt from "./kiro-tool-results.md" with { type: "text" };
import userMessagePrompt from "./kiro-user-message.md" with { type: "text" };

const KIRO_GENERATE_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const KIRO_MAX_EVENTSTREAM_FRAME_BYTES = 16 * 1024 * 1024;
const TEXT_DECODER = new TextDecoder();

type KiroWireToolSpecification = {
	toolSpecification: {
		name: string;
		description: string;
		inputSchema: { json: Record<string, unknown> };
	};
};

type KiroWireToolResult = {
	toolUseId: string;
	status: "success" | "error";
	content: Array<{ text: string }>;
};

type KiroWireUserMessage = {
	userInputMessage: {
		content: string;
		userInputMessageContext?: {
			envState?: { operatingSystem: string; currentWorkingDirectory: string };
			tools?: KiroWireToolSpecification[];
			toolResults?: KiroWireToolResult[];
		};
		origin: "KIRO_CLI";
		modelId: string;
	};
};

type KiroWireAssistantMessage = {
	assistantResponseMessage: {
		content: string;
		toolUses?: Array<{ toolUseId: string; name: string; input: Record<string, unknown> }>;
	};
};
type KiroWireHistoryMessage = KiroWireUserMessage | KiroWireAssistantMessage;

export interface KiroOptions extends StreamOptions {
	conversationId?: string;
	profileArn?: string;
	region?: string;
	reasoning?: Effort;
	disableReasoning?: boolean;
	hideThinkingSummary?: boolean;
}

export const streamKiro: StreamFunction<"kiro-agent"> = (
	model: Model<"kiro-agent">,
	context: Context,
	options?: KiroOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "kiro-agent",
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
			stopReason: "error",
			timestamp: Date.now(),
		};
		let textBlock: TextContent | undefined;
		let thinkingBlock: ThinkingContent | undefined;
		const toolBlocks = new Map<string, ToolCall>();
		const toolLastParseLength = new Map<string, number>();
		const toolPartialJson = new Map<string, string>();
		let sawEndTurn = false;
		let response: TransportResponse | undefined;
		try {
			const credentials = parseKiroCredentials(options?.apiKey, options?.profileArn);
			if (!credentials) throw new AIError.ConfigurationError("Kiro requires KIRO_API_KEY or an OAuth login");
			const request = buildKiroRequest(model, context, options, credentials.profileArn);
			options?.onPayload?.(request, model);
			const region = resolveKiroRegion(options?.region, credentials.profileArn);
			const requestUrl = new URL(model.baseUrl ?? `https://runtime.${region}.kiro.dev`);
			response = await postH2Only({
				url: requestUrl.toString(),
				provider: model.provider,
				headers: {
					authorization: `Bearer ${credentials.accessToken}`,
					accept: "application/vnd.amazon.eventstream",
					"content-type": "application/x-amz-json-1.0",
					"x-amz-target": KIRO_GENERATE_TARGET,
					...(options?.headers ?? {}),
				},
				body: new TextEncoder().encode(JSON.stringify(request)),
				signal: options?.signal,
				fetchOverride: options?.fetch,
			});
			if (response.status < 200 || response.status >= 300) {
				const chunks: Uint8Array[] = [];
				let totalBytes = 0;
				for await (const chunk of response.body) {
					if (totalBytes >= 1_000) break;
					const remaining = 1_000 - totalBytes;
					const bounded = chunk.subarray(0, remaining);
					chunks.push(bounded);
					totalBytes += bounded.byteLength;
				}
				const body = Buffer.concat(chunks).toString("utf8");
				throw kiroResponseError(`Kiro API error ${response.status}`, response.status, body);
			}

			stream.push({ type: "start", partial: output });
			const body = response.body;
			for await (const frame of decodeEventStream(body, { maxFrameBytes: KIRO_MAX_EVENTSTREAM_FRAME_BYTES })) {
				const messageType = frame.headers[":message-type"];
				if (messageType === "exception" || messageType === "error") {
					const code = frame.headers[":exception-type"] ?? frame.headers[":error-code"];
					throw kiroResponseError(
						"Kiro stream error",
						kiroStreamErrorStatus(code),
						TEXT_DECODER.decode(frame.payload),
						code,
					);
				}
				if (messageType !== "event") continue;
				const eventType = frame.headers[":event-type"];
				const payload = parseEventPayload(frame.payload, eventType);
				switch (eventType) {
					case "reasoningContentEvent": {
						if (typeof payload.text !== "string" || payload.text.length === 0) break;
						if (!thinkingBlock) {
							thinkingBlock = { type: "thinking", thinking: "" };
							output.content.push(thinkingBlock);
							stream.push({
								type: "thinking_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						if (firstTokenTime === undefined) firstTokenTime = performance.now();
						thinkingBlock.thinking += payload.text;
						stream.push({
							type: "thinking_delta",
							contentIndex: output.content.indexOf(thinkingBlock),
							delta: payload.text,
							partial: output,
						});
						break;
					}
					case "assistantResponseEvent": {
						if (typeof payload.content !== "string" || payload.content.length === 0) break;
						if (!textBlock) {
							textBlock = { type: "text", text: "" };
							output.content.push(textBlock);
							stream.push({
								type: "text_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						if (firstTokenTime === undefined) firstTokenTime = performance.now();
						textBlock.text += payload.content;
						stream.push({
							type: "text_delta",
							contentIndex: output.content.indexOf(textBlock),
							delta: payload.content,
							partial: output,
						});
						break;
					}
					case "toolUseEvent": {
						const toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : "";
						if (!toolUseId) {
							throw new AIError.ProviderResponseError("Kiro tool use event is missing toolUseId", {
								provider: model.provider,
								kind: "envelope",
							});
						}
						let block = toolBlocks.get(toolUseId);
						if (!block) {
							block = {
								type: "toolCall",
								id: toolUseId,
								name: typeof payload.name === "string" ? payload.name : "",
								arguments: {},
							};
							toolBlocks.set(toolUseId, block);
							output.content.push(block);
							stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
						}
						if (typeof payload.name === "string" && payload.name) block.name = payload.name;
						const delta =
							typeof payload.input === "string"
								? payload.input
								: payload.input === undefined
									? ""
									: JSON.stringify(payload.input);
						if (delta) {
							const accumulated = `${toolPartialJson.get(toolUseId) ?? ""}${delta}`;
							toolPartialJson.set(toolUseId, accumulated);
							const parsed = parseStreamingJsonThrottled(accumulated, toolLastParseLength.get(toolUseId) ?? 0);
							if (parsed) {
								block.arguments = parsed.value;
								toolLastParseLength.set(toolUseId, parsed.parsedLen);
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: output.content.indexOf(block),
								delta,
								partial: output,
							});
						}
						break;
					}
					case "metadataEvent":
						if (payload.stopReason === "END_TURN") sawEndTurn = true;
						// `metadataEvent` may carry a Bedrock-style `usage` block when the
						// server reports token counts inline. Populate the output usage from
						// it so callers (and `calculateCost`) see actual token consumption.
						if (isRecord(payload.usage)) {
							const u = payload.usage;
							output.usage.input = finiteNumber(u.inputTokens) ?? output.usage.input;
							output.usage.output = finiteNumber(u.outputTokens) ?? output.usage.output;
							output.usage.cacheRead = finiteNumber(u.cacheReadInputTokens) ?? output.usage.cacheRead;
							output.usage.cacheWrite = finiteNumber(u.cacheWriteInputTokens) ?? output.usage.cacheWrite;
							output.usage.totalTokens = finiteNumber(u.totalTokens) ?? output.usage.totalTokens;
						}
						break;
					default:
						break;
				}
			}
			if (options?.signal?.aborted) throw new AIError.AbortError();
			if (!sawEndTurn) {
				throw new AIError.ProviderResponseError("Kiro ended the response without END_TURN", {
					provider: model.provider,
					kind: "incomplete-stream",
				});
			}
			for (const [id, block] of toolBlocks) {
				block.arguments = parseCompleteToolArguments(toolPartialJson.get(id), id);
			}
			if (thinkingBlock) {
				stream.push({
					type: "thinking_end",
					contentIndex: output.content.indexOf(thinkingBlock),
					content: thinkingBlock.thinking,
					partial: output,
				});
			}
			if (textBlock) {
				stream.push({
					type: "text_end",
					contentIndex: output.content.indexOf(textBlock),
					content: textBlock.text,
					partial: output,
				});
			}
			for (const block of toolBlocks.values()) {
				stream.push({
					type: "toolcall_end",
					contentIndex: output.content.indexOf(block),
					toolCall: block,
					partial: output,
				});
			}
			output.stopReason = toolBlocks.size > 0 ? "toolUse" : "stop";
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			calculateCost(model, output.usage);
			const doneReason = output.stopReason;
			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			await response?.close().catch(() => {});
		}
	})();
	return stream;
};

function buildKiroRequest(
	model: Model<"kiro-agent">,
	context: Context,
	options: KiroOptions | undefined,
	profileArn?: string,
) {
	const wireModelId = model.requestModelId ?? model.id;
	const latestInputIndex = findLastInputMessage(context.messages);
	if (latestInputIndex < 0) throw new AIError.ConfigurationError("Kiro requires a user message or tool result");
	const currentInputIndex =
		context.messages[latestInputIndex]?.role === "toolResult"
			? findTrailingToolResultStart(context.messages, latestInputIndex)
			: latestInputIndex;
	const history = toKiroHistory(context.messages.slice(0, currentInputIndex), wireModelId);
	const latestMessage = context.messages[currentInputIndex];
	if (latestMessage.role !== "user" && latestMessage.role !== "developer" && latestMessage.role !== "toolResult") {
		throw new AIError.ConfigurationError("Kiro requires a user message or tool result");
	}
	const currentMessage: KiroWireUserMessage = {
		userInputMessage: {
			content: "",
			origin: "KIRO_CLI",
			modelId: wireModelId,
		},
	};
	const systemPrompt = context.systemPrompt?.filter(Boolean).join("\n\n");
	const content = latestMessage.role === "toolResult" ? toolResultsPrompt : userContent(latestMessage.content);
	currentMessage.userInputMessage.content = prompt.render(userMessagePrompt, { systemPrompt, content });
	const toolResults = context.messages
		.slice(currentInputIndex)
		.filter((message): message is ToolResultMessage => message.role === "toolResult")
		.map(toKiroToolResult);
	const tools: KiroWireToolSpecification[] =
		context.tools?.map(tool => ({
			toolSpecification: {
				name: tool.name,
				description: tool.description,
				inputSchema: { json: toolWireSchema(tool) },
			},
		})) ?? [];
	currentMessage.userInputMessage.userInputMessageContext = {
		envState: { operatingSystem: process.platform, currentWorkingDirectory: options?.cwd ?? process.cwd() },
		...(tools.length > 0 ? { tools } : undefined),
		...(toolResults.length > 0 ? { toolResults } : undefined),
	};
	const additionalModelRequestFields = buildKiroReasoningFields(model, options);
	return {
		conversationState: {
			conversationId: options?.conversationId ?? options?.sessionId ?? crypto.randomUUID(),
			history,
			currentMessage,
			chatTriggerType: "MANUAL",
			agentContinuationId: crypto.randomUUID(),
			agentTaskType: "vibe",
		},
		...(profileArn ? { profileArn } : {}),
		...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
	};
}

/**
 * Serialize the schema-appropriate Kiro reasoning controls. The model's
 * `thinking.mode` discriminates the two wire shapes, both of which reject
 * unknown properties (`additionalProperties: false`):
 *  - `kiro-thinking` (Claude-family): `{ thinking: { type, display? }, output_config: { effort } }`
 *  - `kiro-reasoning` (GPT-family): `{ reasoning: { effort } }`
 * Disabling reasoning emits the schema's off state (`thinking.type: "disabled"`
 * or `reasoning.effort: "none"`) so the server does not fall back to its default.
 */
function buildKiroReasoningFields(
	model: Model<"kiro-agent">,
	options: KiroOptions | undefined,
): Record<string, unknown> | undefined {
	const mode = model.thinking?.mode;
	if (mode !== "kiro-thinking" && mode !== "kiro-reasoning") return undefined;
	const effort = options?.reasoning;
	const disabled = options?.disableReasoning || !effort;
	const wireEffort = (effort ?? Effort.High) as string;
	if (mode === "kiro-thinking") {
		const thinking: Record<string, unknown> = { type: disabled ? "disabled" : "adaptive" };
		if (!disabled && !options?.hideThinkingSummary) thinking.display = "summarized";
		const fields: Record<string, unknown> = { thinking };
		if (!disabled) fields.output_config = { effort: wireEffort };
		return fields;
	}
	return { reasoning: { effort: disabled ? "none" : wireEffort } };
}

function findLastInputMessage(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const role = messages[index]?.role;
		if (role === "user" || role === "developer" || role === "toolResult") return index;
	}
	return -1;
}
function findTrailingToolResultStart(messages: readonly Message[], lastIndex: number): number {
	let index = lastIndex;
	while (index > 0 && messages[index - 1]?.role === "toolResult") index -= 1;
	return index;
}

function toKiroToolResult(message: ToolResultMessage): KiroWireToolResult {
	return {
		toolUseId: message.toolCallId,
		status: message.isError ? "error" : "success",
		content: [{ text: userContent(message.content) }],
	};
}

function toKiroHistory(messages: readonly Message[], modelId: string): KiroWireHistoryMessage[] {
	const history: KiroWireHistoryMessage[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role !== "toolResult") {
			history.push(...toKiroHistoryMessage(message, modelId));
			continue;
		}
		const toolResults: KiroWireToolResult[] = [];
		for (;;) {
			const toolResult = messages[index];
			if (toolResult?.role !== "toolResult") break;
			toolResults.push(toKiroToolResult(toolResult));
			index += 1;
		}
		index -= 1;
		history.push({
			userInputMessage: {
				content: toolResultsPrompt,
				userInputMessageContext: { toolResults },
				origin: "KIRO_CLI",
				modelId,
			},
		});
	}
	return history;
}

function toKiroHistoryMessage(message: Message, modelId: string): KiroWireHistoryMessage[] {
	if (message.role === "assistant") {
		const content = message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		const toolUses = message.content
			.filter((block): block is ToolCall => block.type === "toolCall")
			.map(block => ({ toolUseId: block.id, name: block.name, input: block.arguments }));
		return content || toolUses.length > 0
			? [{ assistantResponseMessage: { content, ...(toolUses.length > 0 ? { toolUses } : undefined) } }]
			: [];
	}
	if (message.role === "toolResult") return [];
	const content = userContent(message.content);
	return content ? [{ userInputMessage: { content, origin: "KIRO_CLI", modelId } }] : [];
}

function userContent(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	const text: string[] = [];
	for (const block of content) {
		if (block.type !== "text") {
			throw new AIError.ValidationError(`Kiro supports text input only; received ${block.mimeType}`);
		}
		text.push(block.text);
	}
	return text.join("\n");
}

function parseEventPayload(payload: Uint8Array, eventType: string | undefined): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(TEXT_DECODER.decode(payload));
	} catch (error) {
		throw new AIError.ProviderResponseError(`Kiro ${eventType ?? "event"} payload is invalid JSON`, {
			provider: "kiro",
			kind: "envelope",
			cause: error,
		});
	}
	if (!isRecord(parsed)) {
		throw new AIError.ProviderResponseError(`Kiro ${eventType ?? "event"} payload must be an object`, {
			provider: "kiro",
			kind: "envelope",
		});
	}
	return parsed;
}

function parseCompleteToolArguments(value: string | undefined, toolUseId: string): Record<string, unknown> {
	if (!value?.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (cause) {
		throw new AIError.ProviderResponseError(`Kiro tool use ${toolUseId} contained invalid JSON`, {
			provider: "kiro",
			kind: "envelope",
			cause,
		});
	}
	if (!isRecord(parsed)) {
		throw new AIError.ProviderResponseError(`Kiro tool use ${toolUseId} arguments must be an object`, {
			provider: "kiro",
			kind: "envelope",
		});
	}
	return parsed;
}

function kiroResponseError(prefix: string, status: number, body: string, headerCode?: string): Error {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		payload = undefined;
	}
	const payloadCode =
		isRecord(payload) && typeof payload.__type === "string"
			? payload.__type
			: isRecord(payload) && typeof payload.code === "string"
				? payload.code
				: undefined;
	const code = headerCode ?? payloadCode;
	const detail = isRecord(payload) && typeof payload.message === "string" ? payload.message : body;
	const error = new AIError.ProviderHttpError(`${prefix}: ${detail}`, status, { code });
	if (
		code?.split(/[#:]/).at(-1)?.toLowerCase() === "validationexception" &&
		/^Input is too long for requested model\. Maximum input length is [\d,]+ tokens\.$/i.test(detail.trim())
	) {
		AIError.attach(error, AIError.create(AIError.Flag.ContextOverflow));
	}
	return error;
}

function kiroStreamErrorStatus(code: string | undefined): number {
	const normalized = code?.split(/[#:]/).at(-1)?.toLowerCase();
	switch (normalized) {
		case "internalserverexception":
		case "serviceunavailableexception":
			return 503;
		case "throttlingexception":
			return 429;
		case "unauthorizedexception":
		case "expiredtokenexception":
		case "tokenexpiredexception":
		case "invalidtokenexception":
			return 401;
		case "accessdeniedexception":
			return 403;
		default:
			return 400;
	}
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
