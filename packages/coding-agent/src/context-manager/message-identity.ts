import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { SessionManager } from "../session/session-manager";
import type { ContextStore } from "./storage";
import type { ContextMessageRef } from "./types";

/** Non-enumerable link from a provider-bound message to its canonical session entry/tag. */
export const CONTEXT_MESSAGE_REF = Symbol.for("@oh-my-pi/context-message-ref");

function canonicalJson(value: unknown, ancestors: Set<object>): string | undefined {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
	if (typeof value !== "object") return JSON.stringify(String(value));
	if (ancestors.has(value)) return JSON.stringify("[Circular]");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return `[${value.map(item => canonicalJson(item, ancestors) ?? "null").join(",")}]`;
		}
		const record = value as Record<string, unknown>;
		const fields: string[] = [];
		for (const key of Object.keys(record).sort()) {
			const encoded = canonicalJson(record[key], ancestors);
			if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`);
		}
		return `{${fields.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

/** Stable SHA-256 over semantic message content; runtime/statistical metadata is deliberately excluded. */
export function hashContextMessage(message: AgentMessage): string {
	const semanticContent =
		message.role === "toolResult"
			? {
					role: message.role,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					isError: message.isError,
					content: message.content,
				}
			: message.role === "user" || message.role === "assistant"
				? { role: message.role, content: message.content }
				: { role: message.role };
	const encoded = canonicalJson(semanticContent, new Set<object>()) ?? "null";
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(encoded);
	return hasher.digest("hex");
}

export function getContextMessageRef(message: AgentMessage): ContextMessageRef | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(message, CONTEXT_MESSAGE_REF);
	return descriptor?.value as ContextMessageRef | undefined;
}

export function attachContextMessageRef(message: AgentMessage, ref: ContextMessageRef): boolean {
	try {
		Object.defineProperty(message, CONTEXT_MESSAGE_REF, {
			value: ref,
			configurable: true,
			enumerable: false,
			writable: false,
		});
		return true;
	} catch {
		return false;
	}
}

type TaggableMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

interface CanonicalMessageIdentity {
	readonly ref: ContextMessageRef;
	readonly message: AgentMessage;
}

interface RefQueue {
	readonly refs: ContextMessageRef[];
	index: number;
}

const TAG_PREFIX_PATTERN = /^(?:§\d+§\s*)+/;
const TEMPORAL_MARKER_PATTERN = /^<!-- \+\d+[mhdw](?: \d+[mhdw])? -->\n/;
const TEMPORAL_THRESHOLD_SECONDS = 300;

function isTaggableMessage(message: AgentMessage): message is TaggableMessage {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function temporalMarkerPrefix(gapSeconds: number): string | undefined {
	if (!Number.isFinite(gapSeconds) || gapSeconds < TEMPORAL_THRESHOLD_SECONDS) return undefined;
	const minutes = Math.floor(gapSeconds / 60);
	if (minutes < 60) return `<!-- +${minutes}m -->\n`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const remainingMinutes = minutes % 60;
		return `<!-- +${hours}h${remainingMinutes === 0 ? "" : ` ${remainingMinutes}m`} -->\n`;
	}
	const days = Math.floor(hours / 24);
	if (days < 7) {
		const remainingHours = hours % 24;
		return `<!-- +${days}d${remainingHours === 0 ? "" : ` ${remainingHours}h`} -->\n`;
	}
	const weeks = Math.floor(days / 7);
	const remainingDays = days % 7;
	return `<!-- +${weeks}w${remainingDays === 0 ? "" : ` ${remainingDays}d`} -->\n`;
}

function contextMarkedText(
	text: string,
	ref: ContextMessageRef | undefined,
	temporalPrefix: string | undefined,
): string {
	const existingTag = text.match(TAG_PREFIX_PATTERN)?.[0] ?? "";
	const body = ref ? text.replace(TAG_PREFIX_PATTERN, "") : text.slice(existingTag.length);
	const tagPrefix = ref ? `§${ref.tagOrdinal}§ ` : existingTag;
	const gapPrefix = temporalPrefix && !TEMPORAL_MARKER_PATTERN.test(body) ? temporalPrefix : "";
	return `${tagPrefix}${gapPrefix}${body}`;
}
function isTextPart(part: unknown): part is { type: "text"; text: string } {
	return (
		part !== null &&
		typeof part === "object" &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		typeof part.text === "string"
	);
}

function isToolCallPart(part: unknown): boolean {
	return part !== null && typeof part === "object" && "type" in part && part.type === "toolCall";
}

function cloneWithContextMarkers(
	message: TaggableMessage,
	ref: ContextMessageRef | undefined,
	temporalPrefix: string | undefined,
): AgentMessage {
	const content = message.content;
	if (typeof content === "string") {
		const text = contextMarkedText(content, ref, temporalPrefix);
		if (text === content) return message;
		const clone = { ...message, content: text } as AgentMessage;
		if (ref) attachContextMessageRef(clone, ref);
		return clone;
	}

	const parts: readonly unknown[] = content;
	const textIndex = parts.findIndex(isTextPart);
	if (textIndex >= 0) {
		const currentPart = parts[textIndex];
		if (!isTextPart(currentPart)) return message;
		const text = contextMarkedText(currentPart.text, ref, temporalPrefix);
		if (text === currentPart.text) return message;
		const nextContent = parts.slice();
		nextContent[textIndex] = { ...currentPart, text };
		const clone = { ...message, content: nextContent } as unknown as AgentMessage;
		if (ref) attachContextMessageRef(clone, ref);
		return clone;
	}
	if (ref && message.role === "assistant" && parts.some(isToolCallPart)) {
		const clone = {
			...message,
			content: [{ type: "text" as const, text: `§${ref.tagOrdinal}§ ` }, ...parts],
		} as unknown as AgentMessage;
		attachContextMessageRef(clone, ref);
		return clone;
	}
	return message;
}

/** Allocates and reconciles stable tags against canonical SessionManager entries. */
export class MessageIdentityManager {
	readonly #store: ContextStore;
	readonly #sessionManager: SessionManager;
	#canonicalSnapshot: CanonicalMessageIdentity[] = [];

	constructor(store: ContextStore, sessionManager: SessionManager) {
		this.#store = store;
		this.#sessionManager = sessionManager;
	}

	reconcileBranch(sessionId: string): void {
		let turnIndex = 0;
		for (const entry of this.#sessionManager.getBranch()) {
			if (entry.type !== "message" || !isTaggableMessage(entry.message)) continue;
			if (entry.message.role === "user") turnIndex++;
			this.#reconcileMessage(sessionId, entry.message, entry.id, turnIndex);
		}
	}

	prepareCanonicalMessages(sessionId: string, messages: AgentMessage[]): void {
		this.reconcileBranch(sessionId);
		const persistedMessages = new Set<AgentMessage>();
		for (const entry of this.#sessionManager.getBranch()) {
			if (entry.type === "message") persistedMessages.add(entry.message);
		}
		const outgoingMessages = messages.filter(
			message => message.role === "user" && !persistedMessages.has(message) && !getContextMessageRef(message),
		);
		if (outgoingMessages.length > 0) this.prepareOutgoingMessages(sessionId, outgoingMessages);
		this.#canonicalSnapshot = [];
		for (const message of messages) {
			const ref = getContextMessageRef(message);
			if (ref?.sessionId === sessionId) this.#canonicalSnapshot.push({ ref, message });
		}
	}

	prepareOutgoingMessages(sessionId: string, messages: AgentMessage[]): void {
		let turnIndex = this.#currentTurnIndex();
		for (const message of messages) {
			if (message.role !== "user") continue;
			const currentRef = getContextMessageRef(message);
			const contentHash = hashContextMessage(message);
			if (currentRef?.sessionId === sessionId && currentRef.contentHash === contentHash) continue;
			turnIndex++;
			this.#reconcileMessage(sessionId, message, undefined, turnIndex);
		}
	}

	transformMessages(sessionId: string, messages: AgentMessage[], temporalAwareness: boolean): AgentMessage[] {
		const refsByMessage = new WeakMap<object, ContextMessageRef>();
		const queues = new Map<string, RefQueue>();
		for (const identity of this.#canonicalSnapshot) {
			refsByMessage.set(identity.message, identity.ref);
			const key = `${identity.ref.role}\0${identity.ref.contentHash}`;
			const queue = queues.get(key);
			if (queue) {
				queue.refs.push(identity.ref);
			} else {
				queues.set(key, { refs: [identity.ref], index: 0 });
			}
		}

		const consumed = new Set<number>();
		let previousTimestamp: number | undefined;
		return messages.map(message => {
			const messageHash = isTaggableMessage(message) ? hashContextMessage(message) : undefined;
			let ref = refsByMessage.get(message) ?? getContextMessageRef(message);
			if (ref?.sessionId !== sessionId || ref.contentHash !== messageHash) {
				Reflect.deleteProperty(message, CONTEXT_MESSAGE_REF);
				ref = undefined;
			}
			if (!ref && messageHash !== undefined) {
				const key = `${message.role}\0${messageHash}`;
				const queue = queues.get(key);
				while (queue && queue.index < queue.refs.length && consumed.has(queue.refs[queue.index].tagOrdinal)) {
					queue.index++;
				}
				if (queue && queue.index < queue.refs.length) {
					ref = queue.refs[queue.index];
					queue.index++;
					attachContextMessageRef(message, ref);
				}
			}
			if (ref) consumed.add(ref.tagOrdinal);

			const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
			const temporalPrefix =
				temporalAwareness && message.role === "user" && previousTimestamp !== undefined && timestamp !== undefined
					? temporalMarkerPrefix((timestamp - previousTimestamp) / 1000)
					: undefined;
			if (timestamp !== undefined) previousTimestamp = timestamp;
			return isTaggableMessage(message) && (ref !== undefined || temporalPrefix !== undefined)
				? cloneWithContextMarkers(message, ref, temporalPrefix)
				: message;
		});
	}
	bindPersistedMessage(sessionId: string, message: AgentMessage, entryId: string): void {
		if (!isTaggableMessage(message)) return;
		let turnIndex = 0;
		let found = false;
		for (const entry of this.#sessionManager.getBranch()) {
			if (entry.type !== "message" || !isTaggableMessage(entry.message)) continue;
			if (entry.message.role === "user") turnIndex++;
			if (entry.id !== entryId) continue;
			found = true;
			break;
		}
		if (!found) {
			turnIndex = this.#currentTurnIndex();
			if (message.role === "user") turnIndex++;
		}
		this.#reconcileMessage(sessionId, message, entryId, turnIndex);
	}

	#currentTurnIndex(): number {
		let turnIndex = 0;
		for (const entry of this.#sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") turnIndex++;
		}
		return turnIndex;
	}

	#reconcileMessage(sessionId: string, message: AgentMessage, entryId: string | undefined, turnIndex: number): void {
		const contentHash = hashContextMessage(message);
		const currentRef = getContextMessageRef(message);
		const tag = this.#store.reconcileMessageTag({
			sessionId,
			entryId,
			preferredTagOrdinal: currentRef?.sessionId === sessionId ? currentRef.tagOrdinal : undefined,
			contentHash,
			role: message.role,
			turnIndex,
			tokenCount: Math.max(0, estimateTokens(message)),
		});
		attachContextMessageRef(message, tag);
	}
}
