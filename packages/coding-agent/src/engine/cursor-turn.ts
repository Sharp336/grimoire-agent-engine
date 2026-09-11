import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentMessage, ExternalAgentLoop } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type {
	ContentBlock,
	PromptResponse,
	RequestPermissionRequest,
	SessionUpdate,
	ToolCallUpdate,
} from "@oh-my-pi/pi-utils/acp";
import type {
	ToolExecutionHook,
	ToolExecutionHookCall,
	ToolExecutionHookToken,
} from "../extensibility/extensions/runner";
import type { SessionManager } from "../session/session-manager";
import type { CursorAcpOptions } from "./cursor-acp";

const BINDING = "cursor_session_v1";

interface CursorBinding {
	sessionId: string;
	nativeSessionId: string;
}

export interface CursorTurnOptions {
	model: Model;
	sessionManager: SessionManager;
	open: (options: CursorAcpOptions) => CursorSession;
	beforePrompt: (signal: AbortSignal) => Promise<void>;
	toolExecutionHook: ToolExecutionHook;
}

export interface CursorSession {
	initialize(): Promise<void>;
	prompt(content: ContentBlock[], signal?: AbortSignal): Promise<PromptResponse>;
	dispose(): void;
}

interface Delivery {
	event: AgentEvent;
	acknowledge?: () => void;
}

/** Keep native Engine history/attempts while Cursor owns the actual agent loop. */
export function cursorTurn(options: CursorTurnOptions): ExternalAgentLoop {
	return async function* run(prompts, context, signal) {
		if (!prompts?.length) throw new Error("Cursor cannot replay an ambiguous turn; send an explicit new message");
		const queue = new EventStream<Delivery, void>(
			() => false,
			() => {},
		);
		const produced: AgentMessage[] = [];
		const stopped = Promise.withResolvers<never>();
		void stopped.promise.catch(() => {});
		const tools = new Map<
			string,
			{ call: ToolExecutionHookCall; token?: ToolExecutionHookToken; finished: boolean }
		>();
		let assistant: AssistantMessage | undefined;
		let session: CursorSession | undefined;
		let updateTail = Promise.resolve();
		let updateError: unknown;
		const nativeSessionId = options.sessionManager.getSessionId();
		const saved = options.sessionManager
			.getBranch()
			.findLast(entry => entry.type === "custom" && entry.customType === BINDING);
		const binding = saved?.type === "custom" ? cursorBinding(saved.data) : undefined;
		if (saved && (!binding || binding.nativeSessionId !== nativeSessionId)) {
			throw new Error("Cursor does not support branching this session; start a separate chat instead");
		}
		const emit = (event: AgentEvent) => queue.push({ event });
		const consumed = async (event: AgentEvent) => {
			const ack = Promise.withResolvers<void>();
			queue.push({ event, acknowledge: ack.resolve });
			await Promise.race([ack.promise, stopped.promise]);
		};
		const startAssistant = () => {
			if (assistant) return assistant;
			assistant = {
				role: "assistant",
				api: options.model.api,
				provider: options.model.provider,
				model: options.model.id,
				responseId: randomUUID(),
				timestamp: Date.now(),
				content: [],
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					unavailable: true,
				},
			};
			emit({ type: "message_start", message: assistant });
			return assistant;
		};
		const closeAssistant = async () => {
			if (!assistant) return;
			const message = assistant;
			assistant = undefined;
			produced.push(message);
			await consumed({ type: "message_end", message });
		};
		const ensureTool = async (update: ToolCallUpdate) => {
			let item = tools.get(update.toolCallId);
			if (item) return item;
			const call: ToolExecutionHookCall = {
				toolCallId: update.toolCallId,
				toolName: cursorToolName(update),
				input: update.rawInput ?? {},
			};
			item = { call, finished: false };
			tools.set(update.toolCallId, item);
			const message = startAssistant();
			message.stopReason = "toolUse";
			message.content.push({
				type: "toolCall",
				id: call.toolCallId,
				name: call.toolName,
				arguments: objectInput(call.input),
			});
			await closeAssistant();
			emit({ type: "tool_execution_start", toolCallId: call.toolCallId, toolName: call.toolName, args: call.input });
			return item;
		};
		const finishTool = async (update: ToolCallUpdate, failed = update.status === "failed") => {
			const item = await ensureTool(update);
			if (item.finished) return;
			item.finished = true;
			if (item.token) await options.toolExecutionHook.after(item.call, item.token, { isError: failed });
			const text =
				typeof update.rawOutput === "string"
					? update.rawOutput
					: JSON.stringify(update.rawOutput ?? update.content ?? []);
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: item.call.toolCallId,
				toolName: item.call.toolName,
				content: [{ type: "text", text }],
				isError: failed,
				timestamp: Date.now(),
			};
			produced.push(result);
			emit({
				type: "tool_execution_end",
				toolCallId: item.call.toolCallId,
				toolName: item.call.toolName,
				result,
				isError: failed,
			});
			emit({ type: "message_start", message: result });
			await consumed({ type: "message_end", message: result });
		};
		const update = async (event: SessionUpdate) => {
			if (
				(event.sessionUpdate === "agent_message_chunk" || event.sessionUpdate === "agent_thought_chunk") &&
				event.content.type === "text"
			) {
				const message = startAssistant();
				const thinking = event.sessionUpdate === "agent_thought_chunk";
				let block = message.content.at(-1);
				if (thinking ? block?.type !== "thinking" : block?.type !== "text") {
					block = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
					message.content.push(block);
				}
				const contentIndex = message.content.length - 1;
				const delta = event.content.text;
				if (block?.type === "thinking") {
					block.thinking += delta;
					emit({
						type: "message_update",
						message,
						assistantMessageEvent: { type: "thinking_delta", contentIndex, delta, partial: message },
					});
				} else if (block?.type === "text") {
					block.text += delta;
					emit({
						type: "message_update",
						message,
						assistantMessageEvent: { type: "text_delta", contentIndex, delta, partial: message },
					});
				}
			} else if (event.sessionUpdate === "tool_call" || event.sessionUpdate === "tool_call_update") {
				await ensureTool(event);
				if (event.status === "completed" || event.status === "failed") await finishTool(event);
			}
		};
		const permission = async (request: RequestPermissionRequest) => {
			await updateTail;
			if (updateError) throw updateError;
			const item = await ensureTool(request.toolCall);
			const choice = request.options.find(option => option.kind === "allow_once");
			if (!choice || item.finished) return { outcome: { outcome: "cancelled" as const } };
			try {
				item.token = await options.toolExecutionHook.before(item.call, signal);
				signal.throwIfAborted();
				return { outcome: { outcome: "selected" as const, optionId: choice.optionId } };
			} catch {
				return { outcome: { outcome: "cancelled" as const } };
			}
		};
		const operation = (async () => {
			try {
				await options.beforePrompt(signal);
				emit({ type: "agent_start" });
				emit({ type: "turn_start" });
				for (const message of prompts) {
					produced.push(message);
					emit({ type: "message_start", message });
					await consumed({ type: "message_end", message });
				}
				session = options.open({
					cwd: options.sessionManager.getCwd(),
					sessionId: binding?.sessionId,
					onSession: async sessionId => {
						if (!binding) {
							options.sessionManager.appendCustomEntry(BINDING, { sessionId, nativeSessionId });
							await options.sessionManager.flush();
						}
					},
					onPermission: permission,
					onUpdate: (notification, replay) => {
						if (replay) return;
						updateTail = updateTail
							.then(() => update(notification.update))
							.catch(error => {
								updateError = error;
								session?.dispose();
							});
					},
				});
				await session.initialize();
				const content = cursorPrompt(prompts);
				// The external runtime has no separate system-message method.
				if (!binding && context.systemPrompt.length)
					content.unshift({ type: "text", text: context.systemPrompt.join("\n\n") });
				const response = await session.prompt(content, signal);
				await updateTail;
				if (updateError) throw updateError;
				const message = startAssistant();
				message.stopReason =
					response.stopReason === "cancelled"
						? "aborted"
						: response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests"
							? "length"
							: "stop";
				if (response.usage)
					message.usage = {
						input: response.usage.inputTokens,
						output: response.usage.outputTokens,
						cacheRead: response.usage.cachedReadTokens ?? 0,
						cacheWrite: response.usage.cachedWriteTokens ?? 0,
						totalTokens: response.usage.totalTokens,
						cost: message.usage.cost,
						// ACP does not report billing. Do not present unknown cost as a free request.
						unavailable: true,
					};
				await closeAssistant();
				for (const [toolCallId, item] of tools)
					if (!item.finished)
						await finishTool({ toolCallId, rawOutput: "Cursor turn ended before the tool settled" }, true);
				emit({
					type: "turn_end",
					message,
					toolResults: produced.filter((item): item is ToolResultMessage => item.role === "toolResult"),
				});
				emit({ type: "agent_end", messages: produced });
				queue.end();
			} catch (error) {
				await updateTail;
				await closeAssistant();
				for (const [toolCallId, item] of tools)
					if (!item.finished) await finishTool({ toolCallId, rawOutput: "Cursor connection interrupted" }, true);
				queue.fail(error);
			} finally {
				session?.dispose();
			}
		})().catch(error => queue.fail(error));
		try {
			for await (const delivery of queue) {
				yield delivery.event;
				delivery.acknowledge?.();
			}
			await operation;
		} finally {
			stopped.reject(new Error("Cursor history consumer closed"));
			session?.dispose();
			await operation;
		}
	};
}

function cursorBinding(value: unknown): CursorBinding | undefined {
	if (!value || typeof value !== "object") return undefined;
	const item = value as Record<string, unknown>;
	return typeof item.sessionId === "string" && typeof item.nativeSessionId === "string"
		? { sessionId: item.sessionId, nativeSessionId: item.nativeSessionId }
		: undefined;
}

function cursorPrompt(messages: AgentMessage[]): ContentBlock[] {
	const content: ContentBlock[] = [];
	for (const message of messages) {
		if (!("content" in message)) throw new Error("Cursor cannot accept this message type");
		if (typeof message.content === "string") {
			content.push({ type: "text", text: message.content });
			continue;
		}
		if (!Array.isArray(message.content)) throw new Error("Cursor cannot accept this message content");
		for (const block of message.content) {
			if (block.type === "text") content.push({ type: "text", text: block.text });
			else if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
			else throw new Error("Cursor cannot accept this attachment type");
		}
	}
	return content;
}

function objectInput(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
}

function cursorToolName(update: ToolCallUpdate): string {
	const names: Record<string, string> = {
		read: "read",
		edit: "edit",
		delete: "delete",
		move: "move",
		search: "grep",
		execute: "bash",
		fetch: "fetch",
		think: "think",
	};
	return names[update.kind ?? ""] ?? "cursor";
}
