import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	type ToolCall,
	toolWireSchema,
	type Usage,
	validateJsonSchemaValue,
} from "@oh-my-pi/pi-ai";
import { type BrowserTurnRequest, runBrowserTurn } from "../browser/browser-worker";
import type { ChatGptWebRuntimeConfig } from "../config";
import { requireChatGptWebModelRoute } from "../models";
import type { BrowserHost } from "../runtime/host";
import {
	assertInvocationBatch,
	type ChatGptWebInvocationRequest,
	type ChatGptWebOrchestration,
	type ChatGptWebTurnIssue,
} from "./orchestration";
import { type ChatGptWebPromptMode, canonicalizeChatGptWebTools, compileChatGptWebPrompt } from "./prompt";
import {
	ChatGptWebEventFeed,
	type ChatGptWebSessionState,
	consumeContinuationResults,
	continuationContextFingerprint,
	markContinuationConsumed,
	providerSessionState,
} from "./session";
import type { ChatGptWebErrorClass, ChatGptWebEvent, ChatGptWebRuntimeAdmission, ChatGptWebRuntimeGate } from "./types";

const ZERO_USAGE: Usage = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

export interface ChatGptWebResolvedRuntime {
	config?: ChatGptWebRuntimeConfig;
	host: BrowserHost;
	gate: ChatGptWebRuntimeGate;
	orchestration?: ChatGptWebOrchestration;
}
export type ChatGptWebTurnRunner = (
	turn: BrowserTurnRequest,
	host: BrowserHost,
	admission: ChatGptWebRuntimeAdmission,
	emit: (event: ChatGptWebEvent) => void,
	signal?: AbortSignal,
) => Promise<void>;

export type ChatGptWebStream = (
	model: Model<Api>,
	context: Context,
	streamOptions?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface ChatGptWebStreamOptions {
	config?: ChatGptWebRuntimeConfig;
	host?: BrowserHost;
	gate?: ChatGptWebRuntimeGate;
	orchestration?: ChatGptWebOrchestration;
	resolveRuntime?: () => Promise<ChatGptWebResolvedRuntime>;
	turnRunner?: ChatGptWebTurnRunner;
	now?: () => number;
	turnId?: () => string;
}

export class ChatGptWebStreamError extends Error {
	constructor(
		message: string,
		readonly errorClass: ChatGptWebErrorClass,
	) {
		super(message);
		this.name = "ChatGptWebStreamError";
	}
}

function newAssistant(model: Model<Api>, now: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: structuredClone(ZERO_USAGE),
		stopReason: "stop",
		timestamp: now,
	};
}

function resolveTool(tools: readonly Tool[], wireName: string): Tool | undefined {
	return tools.find(tool => tool.name === wireName) ?? tools.find(tool => tool.customWireName === wireName);
}

const APPROVAL_CONTROL_FIELDS: Readonly<Record<string, true>> = {
	approval: true,
	approvaldecision: true,
	approvalmode: true,
	approvaloverride: true,
	approvaloverrides: true,
	approvalpolicy: true,
	approved: true,
	autoapprove: true,
	autoapprovetoolcalls: true,
	providersafetyapproved: true,
	toolapproval: true,
	toolapprovalpolicy: true,
	toolsapproval: true,
	toolsapprovalmode: true,
	xdevapproved: true,
};

function assertNoApprovalControlFields(value: unknown): void {
	const pending: unknown[] = [value];
	const visited = new Set<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || typeof current !== "object" || visited.has(current)) continue;
		visited.add(current);
		for (const [key, child] of Object.entries(current)) {
			const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
			if (APPROVAL_CONTROL_FIELDS[normalized]) {
				throw new ChatGptWebStreamError(
					"ChatGPT Web tool input contains a reserved approval-control field",
					"tool_protocol",
				);
			}
			pending.push(child);
		}
	}
}

function parseToolCall(event: Extract<ChatGptWebEvent, { type: "tool_call" }>, tools: readonly Tool[]): ToolCall {
	if (
		typeof event.callId !== "string" ||
		event.callId.length === 0 ||
		event.callId.length > 256 ||
		typeof event.name !== "string" ||
		event.name.length === 0 ||
		event.name.length > 128 ||
		typeof event.argumentsJson !== "string" ||
		typeof event.freeform !== "boolean"
	) {
		throw new ChatGptWebStreamError("ChatGPT Web returned a malformed tool call", "tool_protocol");
	}
	assertNoApprovalControlFields(event);
	const tool = resolveTool(tools, event.name);
	if (!tool) throw new ChatGptWebStreamError("ChatGPT Web requested an undeclared tool", "tool_protocol");
	let args: Record<string, unknown>;
	if (event.freeform) {
		if (!tool.customFormat)
			throw new ChatGptWebStreamError("ChatGPT Web used freeform input for a JSON tool", "tool_protocol");
		args = { input: event.argumentsJson };
	} else {
		let parsed: unknown;
		try {
			parsed = JSON.parse(event.argumentsJson) as unknown;
		} catch {
			throw new ChatGptWebStreamError("ChatGPT Web returned malformed tool JSON", "tool_protocol");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new ChatGptWebStreamError("ChatGPT Web tool arguments must be a JSON object", "tool_protocol");
		}
		args = parsed as Record<string, unknown>;
	}
	assertNoApprovalControlFields(args);
	const validation = validateJsonSchemaValue(toolWireSchema(tool), args);
	if (!validation.success) {
		throw new ChatGptWebStreamError("ChatGPT Web tool arguments failed the current OMP schema", "tool_protocol");
	}
	return {
		type: "toolCall",
		id: event.callId,
		name: tool.name,
		arguments: args,
		...(tool.customWireName ? { customWireName: tool.customWireName } : {}),
	};
}

class ChatGptWebEventProjector {
	readonly partial: AssistantMessage;
	#started = false;
	#terminal = false;
	#active?: { kind: "thinking" | "text"; index: number };
	readonly #toolCallIds = new Set<string>();

	constructor(
		readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
		readonly tools: readonly Tool[],
		readonly localTools: boolean,
		now: number,
		responseId?: string,
	) {
		this.partial = newAssistant(model, now);
		if (responseId) this.partial.responseId = responseId;
	}

	ensureStarted(): void {
		if (this.#started) return;
		this.#started = true;
		this.stream.push({ type: "start", partial: this.partial });
	}

	accept(event: ChatGptWebEvent): boolean {
		if (this.#terminal)
			throw new ChatGptWebStreamError("ChatGPT Web emitted data after a terminal event", "malformed_browser_output");
		if (event.type === "start") {
			if (
				this.#started ||
				typeof event.responseId !== "string" ||
				event.responseId.length === 0 ||
				event.responseId.length > 512
			) {
				throw new ChatGptWebStreamError("ChatGPT Web emitted an invalid start event", "malformed_browser_output");
			}
			this.partial.responseId = event.responseId;
			this.ensureStarted();
			return false;
		}
		this.ensureStarted();
		switch (event.type) {
			case "reasoning":
				this.appendText("thinking", event.text, event.continuation === true);
				return false;
			case "commentary":
			case "text":
				this.appendText("text", event.text, event.continuation === true);
				return false;
			case "usage":
				if (
					!Number.isSafeInteger(event.inputTokens) ||
					event.inputTokens < 0 ||
					!Number.isSafeInteger(event.outputTokens) ||
					event.outputTokens < 0 ||
					!Number.isSafeInteger(event.totalTokens) ||
					event.totalTokens < event.inputTokens + event.outputTokens
				) {
					throw new ChatGptWebStreamError("ChatGPT Web returned invalid usage", "malformed_browser_output");
				}
				this.partial.usage.input = event.inputTokens;
				this.partial.usage.output = event.outputTokens;
				this.partial.usage.totalTokens = event.totalTokens;
				return false;
			case "tool_call":
				if (!this.localTools) {
					throw new ChatGptWebStreamError(
						"A browser-only or Pro route attempted a local tool call",
						"tool_protocol",
					);
				}
				this.emitToolCall(event);
				return false;
			case "done": {
				const hasToolCalls = this.partial.content.some(part => part.type === "toolCall");
				if (
					(!this.localTools && event.reason === "toolUse") ||
					(hasToolCalls && event.reason !== "toolUse") ||
					(!hasToolCalls && event.reason === "toolUse")
				) {
					throw new ChatGptWebStreamError("ChatGPT Web returned an inconsistent stop reason", "tool_protocol");
				}
				this.finishOpenBlock();
				this.partial.stopReason = event.reason;
				this.#terminal = true;
				this.stream.push({ type: "done", reason: event.reason, message: this.partial });
				return true;
			}
			case "error":
				this.finishOpenBlock();
				this.partial.stopReason = event.errorClass === "aborted" ? "aborted" : "error";
				this.partial.errorMessage = safeErrorMessage(event.errorClass);
				this.#terminal = true;
				this.stream.push({ type: "error", reason: this.partial.stopReason, error: this.partial });
				return true;
			default:
				throw new ChatGptWebStreamError("ChatGPT Web returned an unknown event", "malformed_browser_output");
		}
	}

	emitInvocationBatch(requests: readonly ChatGptWebInvocationRequest[]): void {
		this.ensureStarted();
		for (const request of requests) {
			this.emitToolCall({
				type: "tool_call",
				callId: request.callId,
				name: request.wireName,
				argumentsJson: request.freeform ? (request.input ?? "") : JSON.stringify(request.arguments),
				freeform: request.freeform,
			});
		}
		this.finishOpenBlock();
		this.partial.stopReason = "toolUse";
		this.#terminal = true;
		this.stream.push({ type: "done", reason: "toolUse", message: this.partial });
	}

	fail(error: unknown): void {
		if (this.#terminal) return;
		this.ensureStarted();
		this.finishOpenBlock();
		const errorClass = chatGptWebErrorClass(error);
		const aborted = errorClass === "aborted";
		this.partial.stopReason = aborted ? "aborted" : "error";
		this.partial.errorMessage = safeErrorMessage(errorClass);
		this.#terminal = true;
		this.stream.push({ type: "error", reason: this.partial.stopReason, error: this.partial });
	}

	private appendText(kind: "thinking" | "text", delta: string, continuation: boolean): void {
		if (typeof delta !== "string" || delta.length === 0) {
			throw new ChatGptWebStreamError("ChatGPT Web returned an empty text delta", "malformed_browser_output");
		}
		if (!this.#active || this.#active.kind !== kind || !continuation) {
			this.finishOpenBlock();
			const index = this.partial.content.length;
			if (kind === "thinking") this.partial.content.push({ type: "thinking", thinking: "" });
			else this.partial.content.push({ type: "text", text: "" });
			this.#active = { kind, index };
			this.stream.push(
				kind === "thinking"
					? { type: "thinking_start", contentIndex: index, partial: this.partial }
					: { type: "text_start", contentIndex: index, partial: this.partial },
			);
		}
		const active = this.#active;
		if (!active) throw new ChatGptWebStreamError("ChatGPT Web lost its active text block", "internal");
		const block = this.partial.content[active.index];
		if (active.kind === "thinking" && block.type === "thinking") block.thinking += delta;
		else if (active.kind === "text" && block.type === "text") block.text += delta;
		else throw new ChatGptWebStreamError("ChatGPT Web produced an inconsistent text block", "internal");
		this.stream.push(
			active.kind === "thinking"
				? { type: "thinking_delta", contentIndex: active.index, delta, partial: this.partial }
				: { type: "text_delta", contentIndex: active.index, delta, partial: this.partial },
		);
	}

	private finishOpenBlock(): void {
		const active = this.#active;
		if (!active) return;
		const block = this.partial.content[active.index];
		if (active.kind === "thinking" && block.type === "thinking") {
			this.stream.push({
				type: "thinking_end",
				contentIndex: active.index,
				content: block.thinking,
				partial: this.partial,
			});
		} else if (active.kind === "text" && block.type === "text") {
			this.stream.push({ type: "text_end", contentIndex: active.index, content: block.text, partial: this.partial });
		}
		this.#active = undefined;
	}

	private emitToolCall(event: Extract<ChatGptWebEvent, { type: "tool_call" }>): void {
		this.finishOpenBlock();
		if (this.#toolCallIds.has(event.callId)) {
			throw new ChatGptWebStreamError("ChatGPT Web returned a duplicate tool call ID", "tool_protocol");
		}
		this.#toolCallIds.add(event.callId);
		const toolCall = parseToolCall(event, this.tools);
		const index = this.partial.content.length;
		this.partial.content.push(toolCall);
		this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.partial });
		this.stream.push({
			type: "toolcall_delta",
			contentIndex: index,
			delta: event.argumentsJson,
			partial: this.partial,
		});
		this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: this.partial });
	}
}

function chatGptWebErrorClass(error: unknown): ChatGptWebErrorClass {
	if (error instanceof DOMException && error.name === "AbortError") return "aborted";
	if (!error || typeof error !== "object" || !("errorClass" in error)) return "internal";
	switch (error.errorClass) {
		case "aborted":
		case "browser_unavailable":
		case "login_required":
		case "profile_conflict":
		case "selector_drift":
		case "tool_protocol":
		case "runtime_draining":
		case "malformed_browser_output":
		case "unsupported_context":
		case "internal":
			return error.errorClass;
		default:
			return "internal";
	}
}

function safeErrorMessage(errorClass: ChatGptWebErrorClass): string {
	switch (errorClass) {
		case "aborted":
			return "ChatGPT Web turn was aborted";
		case "unsupported_context":
			return "ChatGPT Web does not support this context or it exceeds the route budget";
		case "tool_protocol":
			return "ChatGPT Web rejected the local tool protocol";
		case "login_required":
			return "ChatGPT Web login is required";
		default:
			return "ChatGPT Web provider failed";
	}
}

function credentialIsAllowed(apiKey: SimpleStreamOptions["apiKey"]): boolean {
	return apiKey === undefined || apiKey === "" || apiKey === "N/A";
}

function nextTurnId(): string {
	return `turn_${randomUUID().replaceAll("-", "")}`;
}

function modeFor(config: ChatGptWebRuntimeConfig | undefined): ChatGptWebPromptMode {
	return config?.mode ?? "browser-only";
}

async function releaseSession(
	state: ChatGptWebSessionState,
	gate: ChatGptWebRuntimeGate,
	orchestration?: ChatGptWebOrchestration,
): Promise<void> {
	if (state.released) return;
	providerSessionState.remove(state);
	if (state.issue && orchestration) await orchestration.release(state.issue).catch(() => undefined);
	gate.release(state.admission);
}

function ensureSameActiveTurn(
	state: ChatGptWebSessionState,
	routeKey: string,
	effort: string,
	mode: ChatGptWebPromptMode,
	requiresPro: boolean,
	toolSetKey: string,
): void {
	if (
		state.routeKey !== routeKey ||
		state.effort !== effort ||
		state.mode !== mode ||
		state.requiresPro !== requiresPro ||
		state.toolSetKey !== toolSetKey
	) {
		throw new ChatGptWebStreamError(
			"ChatGPT Web route, mode, or tool set changed during an active browser turn",
			"tool_protocol",
		);
	}
}

async function pumpSession(
	state: ChatGptWebSessionState,
	projector: ChatGptWebEventProjector,
	orchestration: ChatGptWebOrchestration | undefined,
	signal?: AbortSignal,
): Promise<"terminal" | "toolUse"> {
	const waitController = new AbortController();
	const abortWait = () => waitController.abort();
	if (signal?.aborted) waitController.abort();
	else signal?.addEventListener("abort", abortWait, { once: true });
	try {
		const brokerBatch =
			state.issue && orchestration
				? orchestration
						.nextInvocationBatch(state.issue, waitController.signal)
						.then(requests => ({ kind: "tools" as const, requests }))
				: undefined;
		for (;;) {
			const nextEvent = state.feed.next(waitController.signal).then(event => ({ kind: "event" as const, event }));
			const next = await Promise.race(brokerBatch ? [nextEvent, brokerBatch] : [nextEvent]);
			if (next.kind === "event") {
				if (next.event.type === "start") state.responseId = next.event.responseId;
				if (projector.accept(next.event)) return "terminal";
				continue;
			}
			assertInvocationBatch(next.requests);
			const toolNamesByCallId = Object.fromEntries(
				next.requests.map(request => {
					const tool = resolveTool(projector.tools, request.wireName);
					if (!tool) throw new ChatGptWebStreamError("ChatGPT Web requested an undeclared tool", "tool_protocol");
					return [request.callId, tool.name];
				}),
			);
			projector.emitInvocationBatch(next.requests);
			state.pendingBatch = { requests: next.requests, toolNamesByCallId, deliveredAt: Date.now() };
			return "toolUse";
		}
	} finally {
		waitController.abort();
		signal?.removeEventListener("abort", abortWait);
	}
}

export function createChatGptWebStream(options: ChatGptWebStreamOptions = {}): ChatGptWebStream {
	return (
		model: Model<Api>,
		context: Context,
		streamOptions: SimpleStreamOptions = {},
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const now = options.now ?? Date.now;
		let projector = new ChatGptWebEventProjector(stream, model, context.tools ?? [], false, now());
		void (async () => {
			let state: ChatGptWebSessionState | undefined;
			let runtime: ChatGptWebResolvedRuntime | undefined;
			let unownedAdmission: ChatGptWebRuntimeAdmission | undefined;
			let unownedIssue: ChatGptWebTurnIssue | undefined;
			try {
				const sessionId = streamOptions.sessionId;
				if (!sessionId)
					throw new ChatGptWebStreamError("ChatGPT Web requires an OMP session ID", "unsupported_context");
				if (!credentialIsAllowed(streamOptions.apiKey)) {
					throw new ChatGptWebStreamError("ChatGPT Web does not accept API credentials", "unsupported_context");
				}
				if ((context as Context & { _compactionRequest?: unknown })._compactionRequest) {
					throw new ChatGptWebStreamError(
						"ChatGPT Web does not support provider-side compaction",
						"unsupported_context",
					);
				}
				if (streamOptions.signal?.aborted) throw new DOMException("ChatGPT Web turn was aborted", "AbortError");
				const resolved = options.resolveRuntime ? await options.resolveRuntime() : undefined;
				const host = options.host ?? resolved?.host;
				const gate = options.gate ?? resolved?.gate;
				const orchestration = options.orchestration ?? resolved?.orchestration;
				const config = options.config ?? resolved?.config;
				if (!host || !gate) {
					throw new ChatGptWebStreamError("ChatGPT Web runtime host is unavailable", "browser_unavailable");
				}
				runtime = { host, gate, ...(config ? { config } : {}), ...(orchestration ? { orchestration } : {}) };
				const route = requireChatGptWebModelRoute(model.requestModelId ?? model.id, true);
				const mode = modeFor(config);
				const localTools = mode === "full" && !route.requiresPro;
				projector = new ChatGptWebEventProjector(stream, model, context.tools ?? [], localTools, now());
				if (localTools && !orchestration) {
					throw new ChatGptWebStreamError("Full ChatGPT Web mode requires orchestration", "tool_protocol");
				}
				const toolSetKey = localTools ? JSON.stringify(canonicalizeChatGptWebTools(context.tools ?? [])) : "";
				providerSessionState.assertContinuationNotRetired(sessionId, context.messages, now());
				state = providerSessionState.get(sessionId, now());
				if (state) {
					ensureSameActiveTurn(state, route.key, route.effort, mode, route.requiresPro, toolSetKey);
					providerSessionState.touch(state, now());
					if (state.responseId) projector.partial.responseId = state.responseId;
				} else {
					unownedAdmission = await gate.admit("turn");
					const identity = { sessionId, turnId: options.turnId?.() ?? nextTurnId() };
					unownedIssue = localTools
						? await orchestration!.issue(
								{ identity, routeKey: route.key, effort: route.effort, tools: context.tools ?? [] },
								unownedAdmission,
							)
						: undefined;
					const compiled = compileChatGptWebPrompt({
						context,
						model,
						routeKey: route.key,
						effort: route.effort,
						sessionId: identity.sessionId,
						turnId: identity.turnId,
						mode,
						requiresPro: route.requiresPro,
						...(unownedIssue ? { turnToken: unownedIssue.turnToken, tools: context.tools ?? [] } : {}),
					});
					const feed = new ChatGptWebEventFeed();
					const abortController = new AbortController();
					const forwardAbort = () => abortController.abort();
					streamOptions.signal?.addEventListener("abort", forwardAbort, { once: true });
					const admission = unownedAdmission;
					const issued = unownedIssue;
					state = providerSessionState.create(
						{
							identity,
							admission,
							routeKey: route.key,
							effort: route.effort,
							mode,
							toolSetKey,
							requiresPro: route.requiresPro,
							feed,
							abortController,
							createdAt: now(),
							cleanup: () => {
								void (async () => {
									if (issued && orchestration) await orchestration.release(issued).catch(() => undefined);
									gate.release(admission);
								})();
							},
							...(unownedIssue ? { issue: unownedIssue } : {}),
						},
						now(),
					);
					unownedAdmission = undefined;
					unownedIssue = undefined;
					const turnRunner = options.turnRunner ?? runBrowserTurn;
					state.browserOutcome = turnRunner(
						{
							identity,
							modelKey: route.key,
							mode,
							headed: false,
							prompt: compiled.text,
							attachments: compiled.attachments.map(attachment => ({
								name: attachment.name,
								bytes: attachment.bytes,
							})),
						},
						host,
						state.admission,
						event => feed.push(event),
						abortController.signal,
					)
						.then(() =>
							feed.close(
								new ChatGptWebStreamError(
									"ChatGPT Web browser turn ended without a terminal event",
									"malformed_browser_output",
								),
							),
						)
						.catch(error => feed.close(error))
						.finally(async () => {
							streamOptions.signal?.removeEventListener("abort", forwardAbort);
							if (state) await releaseSession(state, gate, orchestration);
						});
				}
				await providerSessionState.runExclusive(state, async () => {
					const results = consumeContinuationResults(state!, context.messages);
					if (state!.pendingBatch && !results) {
						projector.emitInvocationBatch(state!.pendingBatch.requests);
						return;
					}
					if (results) {
						state!.continuationFingerprint = continuationContextFingerprint(context.messages);
						if (!state!.issue || !orchestration) {
							throw new ChatGptWebStreamError(
								"A read-only ChatGPT Web turn received tool results",
								"tool_protocol",
							);
						}
						await orchestration.resolveBatch(state!.issue, results);
						markContinuationConsumed(state!, results);
					}
					const outcome = await pumpSession(state!, projector, orchestration, streamOptions.signal);
					if (outcome === "terminal") await releaseSession(state!, gate, orchestration);
				});
			} catch (error) {
				projector.fail(error);
				if (state && runtime) await releaseSession(state, runtime.gate, runtime.orchestration);
				else {
					if (unownedIssue && runtime?.orchestration)
						await runtime.orchestration.release(unownedIssue).catch(() => undefined);
					if (unownedAdmission && runtime) runtime.gate.release(unownedAdmission);
				}
			}
		})();
		return stream;
	};
}
