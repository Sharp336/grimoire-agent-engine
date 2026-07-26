import { type AgentMessage, countTokens } from "@oh-my-pi/pi-agent-core";
import { estimateTokens, IMAGE_TOKEN_ESTIMATE } from "@oh-my-pi/pi-agent-core/compaction";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import { getContextMessageRef, hashContextMessage } from "./message-identity";
import type { ContextOnWireStats } from "./types";

interface MessageWireStats {
	readonly conversationTokens: number;
	readonly toolCallTokens: number;
}

interface CachedMessageWireStats extends MessageWireStats {
	readonly fingerprint: string;
}

function measureMessage(message: AgentMessage): MessageWireStats {
	const estimated = estimateTokens(message);
	if (message.role === "toolResult") {
		return { conversationTokens: 0, toolCallTokens: estimated };
	}
	if (message.role === "assistant") {
		let toolCallTokens = 0;
		let imageTokens = 0;
		for (const part of message.content) {
			if (part.type === "toolCall") {
				toolCallTokens += countTokens([part.name, stringifyJson(part.arguments) ?? "null"]);
			} else if (part.type === "image") {
				imageTokens += IMAGE_TOKEN_ESTIMATE;
			}
		}
		return {
			conversationTokens: Math.max(0, estimated - toolCallTokens) + imageTokens,
			toolCallTokens,
		};
	}
	if (message.role === "user") {
		const imageTokens =
			typeof message.content === "string"
				? 0
				: message.content.reduce((total, part) => total + (part.type === "image" ? IMAGE_TOKEN_ESTIMATE : 0), 0);
		return { conversationTokens: estimated + imageTokens, toolCallTokens: 0 };
	}
	return { conversationTokens: estimated, toolCallTokens: 0 };
}

/** Counts exactly the manager-produced message array and reuses unchanged stable-tag entries. */
export class OnWireTokenCounter {
	#cache = new Map<string, CachedMessageWireStats>();

	measure(messages: AgentMessage[], nonMessageTokens = 0): ContextOnWireStats {
		let conversationTokens = 0;
		let toolCallTokens = 0;
		const liveKeys = new Set<string>();
		for (const message of messages) {
			const ref = getContextMessageRef(message);
			const cacheKey = ref ? `${ref.sessionId}\0${ref.tagOrdinal}` : undefined;
			const fingerprint = cacheKey ? hashContextMessage(message) : undefined;
			const cached = cacheKey && fingerprint ? this.#cache.get(cacheKey) : undefined;
			const measured: MessageWireStats =
				cached && cached.fingerprint === fingerprint ? cached : measureMessage(message);
			conversationTokens += measured.conversationTokens;
			toolCallTokens += measured.toolCallTokens;
			if (cacheKey && fingerprint) {
				liveKeys.add(cacheKey);
				if (cached?.fingerprint !== fingerprint) this.#cache.set(cacheKey, { ...measured, fingerprint });
			}
		}
		for (const key of this.#cache.keys()) {
			if (!liveKeys.has(key)) this.#cache.delete(key);
		}
		return {
			conversationTokens,
			toolCallTokens,
			nonMessageTokens,
			totalTokens: conversationTokens + toolCallTokens + nonMessageTokens,
		};
	}

	clear(): void {
		this.#cache.clear();
	}
}
