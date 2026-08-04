import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/**
 * Test helpers that narrow an `AgentMessage` to the shape a specific assertion
 * needs, replacing `(message as any).<field>` accesses with a checked narrow.
 * A mismatch throws with the actual role so a broken build-context result fails
 * loudly instead of reading `undefined`.
 */

/** Narrow to the compaction-summary variant and return its `summary` text. */
export function compactionSummaryText(message: AgentMessage | undefined): string {
	if (message?.role !== "compactionSummary") {
		throw new Error(`expected a compactionSummary message, got ${message?.role ?? "undefined"}`);
	}
	return message.summary;
}

/** Narrow to the branch-summary variant and return its `summary` text. */
export function branchSummaryText(message: AgentMessage | undefined): string {
	if (message?.role !== "branchSummary") {
		throw new Error(`expected a branchSummary message, got ${message?.role ?? "undefined"}`);
	}
	return message.summary;
}

/**
 * Return a message's textual content: its string `content`, or the text of its
 * first content block. Throws when the message carries no text content.
 */
export function firstContentText(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) {
		throw new Error(`expected a message with content, got ${message?.role ?? "undefined"}`);
	}
	const { content } = message;
	if (typeof content === "string") {
		return content;
	}
	const first = content[0];
	if (first && "text" in first && typeof first.text === "string") {
		return first.text;
	}
	throw new Error("expected a text content block");
}
