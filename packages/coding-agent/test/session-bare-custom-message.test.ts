/**
 * Regression tests for the bare custom_message session-poisoning bug.
 *
 * Real-world failure: on a turn-end error, `appendCustomMessageEntry` was
 * called with `content`/`customType`/`display` all undefined. `JSON.stringify`
 * dropped the undefined-valued keys on the way to the session JSONL, so the
 * persisted entry was a *bare* `custom_message` (no content/customType/display
 * keys at all). On every later turn, context rebuild + message conversion
 * crashed with `TypeError: undefined is not an object (evaluating
 * 'H.content.filter')` inside `convertImageBearingCustomMessage`, permanently
 * bricking the session before any provider call.
 *
 * Contracts defended here:
 *  1. The append chokepoint normalizes nullish fields so a bare entry can
 *     never be persisted again.
 *  2. `buildSessionContext` over a legacy poisoned file (bare entry already on
 *     disk) rebuilds without emitting nullish-content messages, and the
 *     rebuild → `convertToLlm` pipeline no longer throws.
 */
import { describe, expect, it } from "bun:test";
import { convertToLlm, normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const TIMESTAMP = "2025-01-01T00:00:00Z";
const USER_TEXT = "hello before the crash";

/** The exact call shape of the buggy turn-end error path: every argument undefined. */
type BareAppendCustomMessage = (customType?: string, content?: string, display?: boolean) => string;

function userEntry(id: string, parentId: string | null): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "user", content: USER_TEXT, timestamp: 1 },
	};
}

/**
 * The poisoned v3 JSONL shape this bug actually wrote: a custom_message entry
 * whose content/customType/display keys were dropped by `JSON.stringify`.
 */
function barePoisonedEntry(id: string, parentId: string | null): SessionEntry {
	const bare = { type: "custom_message" as const, id, parentId, timestamp: TIMESTAMP };
	// Unchecked cast: CustomMessageEntry requires content/customType/display;
	// legacy poisoned session files are missing exactly those keys.
	return bare as unknown as SessionEntry;
}

function poisonedSession(): SessionEntry[] {
	return [userEntry("user-1", null), barePoisonedEntry("poisoned-2", "user-1")];
}

describe("bare custom_message poisoning (turn-end error entries bricked session rebuild)", () => {
	it("appendCustomMessageEntry normalizes all-undefined fields so the persisted entry always carries content/customType/display", () => {
		const session = SessionManager.inMemory();
		// The buggy turn-end error path called this with every argument
		// undefined; the public signature forbids that, so widen deliberately
		// to reproduce the legacy call shape.
		const appendBare = session.appendCustomMessageEntry.bind(session) as unknown as BareAppendCustomMessage;
		const id = appendBare(undefined, undefined, undefined);

		const entry = session.getBranch().find(e => e.id === id);
		if (entry?.type !== "custom_message") {
			throw new Error(`Expected custom_message entry, got ${entry?.type ?? "none"}`);
		}
		expect(entry.content).toBe("");
		expect(entry.customType).toBe("unknown");
		expect(entry.display).toBe(false);

		// The original failure mode: undefined-valued keys vanish under
		// JSON.stringify (the JSONL persistence layer). The normalized values
		// must survive the round trip so a reload never sees a bare entry.
		const persisted = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>; // JSONL round trip of a plain entry object
		expect(Object.hasOwn(persisted, "content")).toBe(true);
		expect(Object.hasOwn(persisted, "customType")).toBe(true);
		expect(Object.hasOwn(persisted, "display")).toBe(true);
	});

	it("buildSessionContext over a legacy bare entry yields no nullish-content messages and keeps the real conversation", () => {
		const context = buildSessionContext(poisonedSession(), "poisoned-2");

		expect(context.messages.length).toBeGreaterThanOrEqual(1);
		for (const message of context.messages) {
			const content = "content" in message ? message.content : undefined;
			expect(content ?? null).not.toBeNull();
		}
		const userMessage = context.messages.find(m => m.role === "user");
		expect(userMessage?.content).toBe(USER_TEXT);
	});

	it("rebuild + LLM conversion over a poisoned session no longer throws the `.content.filter` TypeError", () => {
		const context = buildSessionContext(poisonedSession(), "poisoned-2");

		// Pre-fix this crashed with `TypeError: undefined is not an object
		// (evaluating 'H.content.filter')` before any provider call.
		expect(() => convertToLlm(context.messages)).not.toThrow();

		const llmMessages = convertToLlm(context.messages);
		const userTurn = llmMessages.find(m => m.role === "user");
		expect(userTurn?.content).toBe(USER_TEXT);
		for (const message of llmMessages) {
			expect(message.content ?? null).not.toBeNull();
		}
	});
});

describe("sendCustomMessage payload normalization (the hook-side injection vector)", () => {
	it("coerces the bare-string payload real hooks sent (pi.sendMessage(warning)) into content", () => {
		const normalized = normalizeCustomMessagePayload("warning: MANAGED region edit");
		expect(normalized.content).toBe("warning: MANAGED region edit");
		expect(normalized.customType).toBe("hook-message");
		expect(normalized.display).toBe(false);
		// The persisted JSONL shape must carry every key even after stringify.
		const persisted = JSON.parse(JSON.stringify(normalized)) as Record<string, unknown>;
		expect(Object.hasOwn(persisted, "content")).toBe(true);
		expect(Object.hasOwn(persisted, "customType")).toBe(true);
		expect(Object.hasOwn(persisted, "display")).toBe(true);
	});

	it("keeps provided fields and fills only the nullish ones", () => {
		const normalized = normalizeCustomMessagePayload({
			customType: "aienv:protect-regions",
			content: "warning text",
			display: true,
		});
		expect(normalized.customType).toBe("aienv:protect-regions");
		expect(normalized.content).toBe("warning text");
		expect(normalized.display).toBe(true);
	});

	it("survives a field-free object (the exact legacy crash shape) without producing nullish fields", () => {
		const normalized = normalizeCustomMessagePayload({} as never);
		expect(normalized.content).toBe("");
		expect(normalized.customType).toBe("hook-message");
		expect(normalized.display).toBe(false);
	});
});
