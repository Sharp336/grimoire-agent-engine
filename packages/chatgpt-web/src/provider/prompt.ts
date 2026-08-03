import {
	type Api,
	type AssistantMessage,
	type Context,
	type ImageContent,
	type Model,
	type Tool,
	toolWireSchema,
} from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import chatGptWebPrompt from "./prompts/chatgpt-web.md" with { type: "text" };

export const CHATGPT_WEB_MAX_ATTACHMENTS = 10;
export const CHATGPT_WEB_MAX_ATTACHMENT_BYTES = 50_000_000;
const CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192;
const CHATGPT_WEB_IMAGE_RESERVE_TOKENS = 4_096;
const CHATGPT_WEB_ORIGINAL_IMAGE_RESERVE_TOKENS = 8_192;
const CHATGPT_WEB_CHARS_PER_TOKEN = 3;
const RETIRED_HANDLE = /\b(?:turn|binding)_[A-Za-z0-9_-]{24,}\b/g;
const SENSITIVE_TRANSPORT_HANDLE = /\b(?:bootstrap|connector|control|runtime_key|session_nonce)_[A-Za-z0-9_-]{24,}\b/g;

export type ChatGptWebPromptMode = "browser-only" | "full";

export interface ChatGptWebCanonicalTool {
	kind: "function" | "custom";
	name: string;
	wireName: string;
	description: string;
	parameters: Record<string, unknown>;
	strict: boolean;
	customFormat?: { syntax: "lark" | "regex"; definition: string };
}

export interface ChatGptWebPromptAttachment {
	ref: string;
	name: string;
	mimeType: string;
	bytes: Uint8Array;
	detail?: ImageContent["detail"];
}

export interface CompiledChatGptWebPrompt {
	text: string;
	attachments: readonly ChatGptWebPromptAttachment[];
	estimatedInputTokens: number;
}

export interface CompileChatGptWebPromptOptions {
	context: Context;
	model: Model<Api>;
	routeKey: string;
	effort?: string;
	sessionId: string;
	turnId: string;
	mode: ChatGptWebPromptMode;
	requiresPro?: boolean;
	turnToken?: string;
	tools?: readonly Tool[];
}

export class ChatGptWebPromptError extends Error {
	readonly errorClass = "unsupported_context" as const;

	constructor(
		message: string,
		readonly code:
			| "ATTACHMENT_LIMIT"
			| "ATTACHMENT_BYTES"
			| "INVALID_IMAGE"
			| "INVALID_TOOL"
			| "MISSING_TURN_TOKEN"
			| "UNEXPECTED_TURN_TOKEN"
			| "CONTEXT_OVER_BUDGET",
	) {
		super(message);
		this.name = "ChatGptWebPromptError";
	}
}

function redactRetiredHandles(value: string): string {
	return value
		.replace(RETIRED_HANDLE, "[retired turn handle]")
		.replace(SENSITIVE_TRANSPORT_HANDLE, "[redacted transport handle]");
}

function decodeImage(data: string, remainingBytes: number): Uint8Array {
	const encoded = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
	if (encoded.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
		throw new ChatGptWebPromptError("ChatGPT Web received malformed base64 image data", "INVALID_IMAGE");
	}
	const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
	const decodedBytes = Math.floor((encoded.length * 3) / 4) - padding;
	if (decodedBytes > remainingBytes) {
		throw new ChatGptWebPromptError(
			"ChatGPT Web image attachments exceed the 50 MB per-turn limit",
			"ATTACHMENT_BYTES",
		);
	}
	try {
		return Buffer.from(encoded, "base64");
	} catch {
		throw new ChatGptWebPromptError("ChatGPT Web received malformed base64 image data", "INVALID_IMAGE");
	}
}

function extensionFor(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/jpeg":
			return "jpg";
		case "image/png":
			return "png";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			throw new ChatGptWebPromptError(`ChatGPT Web does not support image type ${mimeType}`, "INVALID_IMAGE");
	}
}

interface PromptBuildState {
	attachments: ChatGptWebPromptAttachment[];
	totalAttachmentBytes: number;
}

function imageEnvelope(
	image: ImageContent,
	messageIndex: number,
	contentIndex: number,
	state: PromptBuildState,
): unknown {
	if (state.attachments.length >= CHATGPT_WEB_MAX_ATTACHMENTS) {
		throw new ChatGptWebPromptError(
			`ChatGPT Web accepts at most ${CHATGPT_WEB_MAX_ATTACHMENTS} image attachments per turn`,
			"ATTACHMENT_LIMIT",
		);
	}
	const bytes = decodeImage(image.data, CHATGPT_WEB_MAX_ATTACHMENT_BYTES - state.totalAttachmentBytes);
	state.totalAttachmentBytes += bytes.byteLength;
	const extension = extensionFor(image.mimeType);
	const ref = `omp-image-${messageIndex + 1}-${contentIndex + 1}`;
	state.attachments.push({
		ref,
		name: `${ref}.${extension}`,
		mimeType: image.mimeType.toLowerCase(),
		bytes,
		...(image.detail ? { detail: image.detail } : {}),
	});
	return { type: "image_attachment", attachment_ref: ref, ...(image.detail ? { detail: image.detail } : {}) };
}

function inputContent(
	content: string | readonly ({ type: "text"; text: string } | ImageContent)[],
	messageIndex: number,
	state: PromptBuildState,
): unknown {
	if (typeof content === "string") return redactRetiredHandles(content);
	return content.map((part, contentIndex) =>
		part.type === "image"
			? imageEnvelope(part, messageIndex, contentIndex, state)
			: { type: "text", text: redactRetiredHandles(part.text) },
	);
}

function assistantContent(content: AssistantMessage["content"], includeTools: boolean): unknown[] {
	const result: unknown[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object" || !("type" in part)) continue;
		if (part.type === "text" && "text" in part && typeof part.text === "string") {
			result.push({ type: "text", text: redactRetiredHandles(part.text) });
		} else if (part.type === "thinking" && "thinking" in part && typeof part.thinking === "string") {
			result.push({ type: "thinking", text: redactRetiredHandles(part.thinking) });
		} else if (includeTools && part.type === "toolCall" && "id" in part && "name" in part && "arguments" in part) {
			result.push({ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments });
		}
	}
	return result;
}

function messageEnvelope(
	message: Context["messages"][number],
	messageIndex: number,
	includeTools: boolean,
	state: PromptBuildState,
): Record<string, unknown> | undefined {
	if (message.role === "toolResult") {
		if (!includeTools) return undefined;
		return {
			role: "tool_result",
			tool_call_id: message.toolCallId,
			tool_name: message.toolName,
			is_error: message.isError,
			content: inputContent(message.content, messageIndex, state),
		};
	}
	if (message.role === "assistant") {
		return { role: "assistant", content: assistantContent(message.content, includeTools) };
	}
	return { role: message.role, content: inputContent(message.content, messageIndex, state) };
}

function validateToolName(name: string, field: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
		throw new ChatGptWebPromptError(`ChatGPT Web received an invalid ${field}`, "INVALID_TOOL");
	}
}

export function canonicalizeChatGptWebTools(tools: readonly Tool[]): readonly ChatGptWebCanonicalTool[] {
	const names = new Set<string>();
	const aliases = new Set<string>();
	return tools.map(tool => {
		validateToolName(tool.name, "tool name");
		const wireName = tool.customWireName ?? tool.name;
		validateToolName(wireName, "customWireName");
		if (names.has(tool.name) || aliases.has(tool.name) || names.has(wireName) || aliases.has(wireName)) {
			throw new ChatGptWebPromptError(`ChatGPT Web tool name is ambiguous: ${wireName}`, "INVALID_TOOL");
		}
		if (tool.native) {
			throw new ChatGptWebPromptError(`ChatGPT Web cannot expose native tool ${tool.name}`, "INVALID_TOOL");
		}
		names.add(tool.name);
		if (wireName !== tool.name) aliases.add(wireName);
		const parameters = structuredClone(toolWireSchema(tool));
		return Object.freeze({
			kind: tool.customFormat ? ("custom" as const) : ("function" as const),
			name: tool.name,
			wireName,
			description: tool.description,
			parameters,
			strict: tool.strict === true,
			...(tool.customFormat ? { customFormat: structuredClone(tool.customFormat) } : {}),
		});
	});
}

export function estimateChatGptWebInputTokens(
	compiledText: string,
	attachments: readonly ChatGptWebPromptAttachment[],
): number {
	const imageTokens = attachments.reduce(
		(total, attachment) =>
			total +
			(attachment.detail === "original"
				? CHATGPT_WEB_ORIGINAL_IMAGE_RESERVE_TOKENS
				: CHATGPT_WEB_IMAGE_RESERVE_TOKENS),
		0,
	);
	return (
		CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + Math.ceil(compiledText.length / CHATGPT_WEB_CHARS_PER_TOKEN) + imageTokens
	);
}

export function compileChatGptWebPrompt(options: CompileChatGptWebPromptOptions): CompiledChatGptWebPrompt {
	const localTools = options.mode === "full" && options.requiresPro !== true;
	if (localTools && !options.turnToken) {
		throw new ChatGptWebPromptError(
			"Tool-capable ChatGPT Web mode requires a per-turn correlation token",
			"MISSING_TURN_TOKEN",
		);
	}
	if (!localTools && options.turnToken !== undefined) {
		throw new ChatGptWebPromptError(
			"Browser-only and Pro ChatGPT Web routes must not receive a turn token",
			"UNEXPECTED_TURN_TOKEN",
		);
	}
	const state: PromptBuildState = { attachments: [], totalAttachmentBytes: 0 };
	const messages = options.context.messages
		.map((message, index) => messageEnvelope(message, index, localTools, state))
		.filter((message): message is Record<string, unknown> => message !== undefined);
	const tools = localTools ? canonicalizeChatGptWebTools(options.tools ?? []) : undefined;
	const envelope = {
		version: 1,
		system: (options.context.systemPrompt ?? []).map(redactRetiredHandles),
		messages,
		model_route: { key: options.routeKey, ...(options.effort ? { effort: options.effort } : {}) },
		session: { session_id: options.sessionId, turn_id: options.turnId },
		...(tools ? { tools } : {}),
	};
	const text = prompt.render(chatGptWebPrompt, {
		localTools,
		turnToken: options.turnToken,
		contextJson: JSON.stringify(envelope),
	});
	const estimatedInputTokens = estimateChatGptWebInputTokens(text, state.attachments);
	const contextLimit = options.model.contextWindow;
	if (contextLimit !== null && estimatedInputTokens > contextLimit) {
		throw new ChatGptWebPromptError(
			`ChatGPT Web context requires ${estimatedInputTokens} estimated tokens but the selected route allows ${contextLimit}`,
			"CONTEXT_OVER_BUDGET",
		);
	}
	return { text, attachments: state.attachments, estimatedInputTokens };
}
