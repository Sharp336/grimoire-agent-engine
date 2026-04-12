/**
 * Flow message utilities — shared helpers for inspecting AgentMessage
 * content blocks. Kept in one place so the strategy, runtime, and sub-agent
 * helper agree on what "text" or "tool call" means in a message.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

interface ContentBlock {
	type?: unknown;
	text?: unknown;
	name?: unknown;
	id?: unknown;
}

function blocksOf(msg: AgentMessage): ContentBlock[] {
	const m = msg as { content?: unknown };
	return Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
}

/**
 * Concatenate every `text` block in the message. Non-text blocks are
 * skipped. Returns "" for string-content or non-array content.
 */
export function extractText(message: AgentMessage): string {
	const m = message as { content?: unknown };
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	const parts: string[] = [];
	for (const block of m.content as ContentBlock[]) {
		if (block && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join(" ");
}

/**
 * Short preview for trace logs: text blocks concatenated, tool calls
 * rendered as `[tool:NAME]`, thinking blocks as `[thinking]`. Clipped to
 * 200 chars so it never bloats a trace file.
 */
export function previewMessage(message: AgentMessage): string {
	const m = message as { content?: unknown };
	if (typeof m.content === "string") return m.content.slice(0, 200);
	if (!Array.isArray(m.content)) return "";
	const parts: string[] = [];
	for (const block of m.content as ContentBlock[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "toolCall" && typeof block.name === "string") parts.push(`[tool:${block.name}]`);
		else if (block.type === "thinking") parts.push("[thinking]");
	}
	return parts.join(" ").slice(0, 200);
}

/**
 * Walk a conversation in reverse and return the last assistant message's
 * concatenated text. Used by the sub-agent runner to surface the final
 * result to the caller. Empty assistant turns are skipped.
 */
export function extractFinalAssistantText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if ((msg as { role?: string }).role !== "assistant") continue;
		const text = extractText(msg);
		if (text.trim().length > 0) return text;
	}
	return "(sub-agent produced no text output)";
}

/**
 * Result of classifying an assistant message in a single pass over its
 * content blocks.
 */
export interface AssistantClassification {
	/** True if the message has no toolCall blocks. */
	isPlainText: boolean;
	/** Ordered list of tool call names (may be empty). */
	toolCallNames: string[];
	/** Ordered list of tool call ids aligned with toolCallNames. */
	toolCallIds: string[];
}

/**
 * Single-pass scan of an assistant message's content. Everything the
 * strategy needs to know about a turn (plain text? which tools were
 * called?) is derived from one iteration. Non-assistant messages return
 * an empty classification.
 */
export function classifyAssistantMessage(message: AgentMessage): AssistantClassification {
	const role = (message as { role?: string }).role;
	if (role !== "assistant") {
		return { isPlainText: false, toolCallNames: [], toolCallIds: [] };
	}
	const toolCallNames: string[] = [];
	const toolCallIds: string[] = [];
	for (const block of blocksOf(message)) {
		if (block?.type === "toolCall") {
			const name = typeof block.name === "string" ? block.name : "";
			toolCallNames.push(name);
			toolCallIds.push(typeof block.id === "string" ? block.id : "");
		}
	}
	return {
		isPlainText: toolCallNames.length === 0,
		toolCallNames,
		toolCallIds,
	};
}
