import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentToolCall } from "../types";
import type { SessionEntry } from "./entries";

export interface ProtectedToolContext {
	readonly toolResult: ToolResultMessage;
	readonly toolCall: AgentToolCall | undefined;
}

export type ProtectedToolMatcher = string | ((context: ProtectedToolContext) => boolean);

const SKILL_INTERNAL_URL_PREFIX = "skill://";

export function collectToolCallsById(entries: readonly SessionEntry[]): Map<string, AgentToolCall> {
	const toolCalls = new Map<string, AgentToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") toolCalls.set(block.id, block);
		}
	}
	return toolCalls;
}

function getReadToolPathArgument({ toolResult, toolCall }: ProtectedToolContext): unknown {
	if (toolResult.toolName !== "read" || toolCall?.name !== "read") return undefined;
	return (toolCall.arguments as Record<string, unknown>).path;
}

/**
 * Extract the scalar `path` argument from a paired `read` tool call. Native
 * path arrays return `undefined`; use {@link getReadToolPaths} when either
 * input shape is valid.
 */
export function getReadToolPath(context: ProtectedToolContext): string | undefined {
	const path = getReadToolPathArgument(context);
	return typeof path === "string" ? path : undefined;
}

/**
 * Extract every path from a paired scalar or native-array `read` tool call.
 * Malformed and empty path arguments return `undefined`.
 */
export function getReadToolPaths(context: ProtectedToolContext): readonly string[] | undefined {
	const path = getReadToolPathArgument(context);
	if (typeof path === "string") return path.length > 0 ? [path] : undefined;
	if (
		!Array.isArray(path) ||
		path.length === 0 ||
		!path.every((target): target is string => typeof target === "string" && target.length > 0)
	) {
		return undefined;
	}
	return path;
}

export function isSkillReadToolResult(context: ProtectedToolContext): boolean {
	return getReadToolPaths(context)?.some(path => path.startsWith(SKILL_INTERNAL_URL_PREFIX)) ?? false;
}

export function isProtectedToolResult(
	toolResult: ToolResultMessage,
	toolCall: AgentToolCall | undefined,
	matchers: readonly ProtectedToolMatcher[],
): boolean {
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			if (toolResult.toolName === matcher) return true;
			continue;
		}
		if (matcher({ toolResult, toolCall })) return true;
	}
	return false;
}
