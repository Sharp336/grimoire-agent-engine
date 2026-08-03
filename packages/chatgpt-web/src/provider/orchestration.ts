import type { Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { ChatGptWebRuntimeAdmission, ChatGptWebTurnIdentity } from "./types";

export interface ChatGptWebBindingCapability {
	readonly __opaque: unique symbol;
}

export interface ChatGptWebConnectorCapability {
	readonly __opaque: unique symbol;
}

export interface ChatGptWebInvocationRequest {
	readonly callId: string;
	readonly wireName: string;
	readonly freeform: boolean;
	readonly arguments?: Record<string, unknown>;
	readonly input?: string;
}

export interface ChatGptWebTurnIssue {
	readonly turnToken: string;
	readonly binding: ChatGptWebBindingCapability;
	readonly connector: ChatGptWebConnectorCapability;
	readonly expiresAt: number;
}

export interface ChatGptWebIssueRequest {
	readonly identity: ChatGptWebTurnIdentity;
	readonly routeKey: string;
	readonly effort?: string;
	readonly tools: readonly Tool[];
}

export interface ChatGptWebOrchestration {
	issue(request: ChatGptWebIssueRequest, admission: ChatGptWebRuntimeAdmission): Promise<ChatGptWebTurnIssue>;
	nextInvocationBatch(
		issue: ChatGptWebTurnIssue,
		signal?: AbortSignal,
	): Promise<readonly ChatGptWebInvocationRequest[]>;
	resolveBatch(
		issue: ChatGptWebTurnIssue,
		results: readonly { callId: string; result: ToolResultMessage }[],
	): Promise<void>;
	release(issue: ChatGptWebTurnIssue): Promise<void>;
}

export function assertInvocationBatch(requests: readonly ChatGptWebInvocationRequest[]): void {
	if (requests.length === 0) throw new Error("ChatGPT Web orchestration returned an empty tool batch");
	const ids = new Set<string>();
	for (const request of requests) {
		if (!request.callId || ids.has(request.callId)) {
			throw new Error("ChatGPT Web orchestration returned a missing or duplicate tool call ID");
		}
		if (!request.wireName || request.wireName.length > 128) {
			throw new Error("ChatGPT Web orchestration returned an invalid tool name");
		}
		if (request.freeform) {
			if (typeof request.input !== "string" || request.arguments !== undefined) {
				throw new Error("ChatGPT Web orchestration returned a malformed freeform tool call");
			}
		} else if (!request.arguments || request.input !== undefined) {
			throw new Error("ChatGPT Web orchestration returned malformed JSON tool arguments");
		}
		ids.add(request.callId);
	}
}
