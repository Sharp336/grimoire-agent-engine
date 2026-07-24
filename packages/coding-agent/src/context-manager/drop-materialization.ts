import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { attachContextMessageRef, getContextMessageRef } from "./message-identity";
import type { ContextDropRecord } from "./types";

/** Replay materialized drops on provider clones without touching canonical messages. */
export function applyContextDrops(messages: AgentMessage[], drops: readonly ContextDropRecord[]): AgentMessage[] {
	if (drops.length === 0) return messages;
	const removedTags = new Set<number>();
	const replacements = new Map<number, string>();
	const clearedReasoningTags = new Set<number>();
	for (const drop of drops) {
		if (drop.clearReasoning) {
			clearedReasoningTags.add(drop.targetTag);
			continue;
		}
		if (drop.replacementText === undefined) {
			for (const tag of drop.expandedTags) removedTags.add(tag);
			continue;
		}
		replacements.set(drop.targetTag, drop.replacementText);
	}

	const transformed: AgentMessage[] = [];
	for (const message of messages) {
		const ref = getContextMessageRef(message);
		if (!ref) {
			transformed.push(message);
			continue;
		}
		if (removedTags.has(ref.tagOrdinal)) continue;
		if (clearedReasoningTags.has(ref.tagOrdinal) && message.role === "assistant") {
			const content = message.content.filter(part => part.type !== "thinking" || Boolean(part.thinkingSignature));
			if (content.length !== message.content.length) {
				const clone = { ...message, content };
				attachContextMessageRef(clone, ref);
				transformed.push(clone);
				continue;
			}
		}
		const replacement = replacements.get(ref.tagOrdinal);
		if (replacement === undefined) {
			transformed.push(message);
			continue;
		}
		const text = `§${ref.tagOrdinal}§ ${replacement}`;
		let clone: AgentMessage | undefined;
		if (message.role === "toolResult") {
			clone = { ...message, content: [{ type: "text", text }] };
		} else if (message.role === "user" && typeof message.content === "string") {
			clone = { ...message, content: text };
		} else if (message.role === "user") {
			if (typeof message.content !== "string") {
				const textIndex = message.content.findIndex(part => part.type === "text");
				const currentPart = message.content[textIndex];
				if (currentPart?.type === "text") {
					const content = message.content.slice();
					content[textIndex] = { ...currentPart, text };
					clone = { ...message, content };
				}
			}
		} else if (message.role === "assistant") {
			const textIndex = message.content.findIndex(part => part.type === "text");
			const currentPart = message.content[textIndex];
			if (currentPart?.type === "text") {
				const content = message.content.slice();
				content[textIndex] = { ...currentPart, text };
				clone = { ...message, content };
			}
		}
		if (!clone) {
			transformed.push(message);
			continue;
		}
		attachContextMessageRef(clone, ref);
		transformed.push(clone);
	}
	return transformed;
}
