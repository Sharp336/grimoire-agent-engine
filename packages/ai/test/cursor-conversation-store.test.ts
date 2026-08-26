import { beforeEach, describe, expect, it } from "bun:test";
import {
	CURSOR_RETAINED_CONVERSATION_LIMIT,
	type CursorConversationEntry,
	isCursorRotationFresh,
	isCursorRotationMarked,
	MAX_CURSOR_CONVERSATION_ROTATIONS,
	markCursorRotationSucceeded,
	pinCursorConversation,
	resetCursorConversationStore,
	resolveCursorConversationId,
	rotateCursorConversation,
	unpinCursorConversation,
} from "../src/providers/cursor/conversation-store";

beforeEach(() => {
	resetCursorConversationStore();
});

describe("cursor conversation store — active/retained split", () => {
	it("a pinned entry survives 64 subsequent admissions and stays resolvable after retained overflow", () => {
		const pinned = pinCursorConversation("pinned-id");
		pinned.blobs.set("b1", new Uint8Array([1]));

		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT; i++) {
			const id = `admit-${i}`;
			pinCursorConversation(id);
			unpinCursorConversation(id);
		}
		// 64 admissions exactly fill retained: the pinned id is untouched.
		expect(pinCursorConversation("pinned-id")).toBe(pinned);
		unpinCursorConversation("pinned-id");

		// Overflow the retained set: the still-active pinned id is never evicted.
		for (let i = 0; i < 80; i++) {
			const id = `extra-${i}`;
			pinCursorConversation(id);
			unpinCursorConversation(id);
		}
		const after = pinCursorConversation("pinned-id");
		expect(after).toBe(pinned);
		expect(after.blobs).toBe(pinned.blobs);
		expect(after.blobs.get("b1")).toEqual(new Uint8Array([1]));
		unpinCursorConversation("pinned-id");
	});

	it("retained entries evict LRU at 65 — the earliest unpinned admission is dropped", () => {
		const originals = new Map<string, CursorConversationEntry>();
		for (let i = 0; i < CURSOR_RETAINED_CONVERSATION_LIMIT; i++) {
			const id = `r-${i}`;
			originals.set(id, pinCursorConversation(id));
			unpinCursorConversation(id);
		}
		// At exactly the limit nothing was evicted — the tail entry still resolves in place.
		const tailKey = `r-${CURSOR_RETAINED_CONVERSATION_LIMIT - 1}`;
		const tailOriginal = originals.get(tailKey)!;
		expect(pinCursorConversation(tailKey)).toBe(tailOriginal);
		unpinCursorConversation(tailKey);

		// The 65th retained admission evicts the earliest (r-0). Assert the
		// survivor before re-pinning r-0: a fresh re-pin would re-admit r-0 to
		// retained and push the size back past the limit, evicting r-1.
		pinCursorConversation("r-65");
		unpinCursorConversation("r-65");

		// A non-earliest survivor still resolves by its original identity.
		expect(pinCursorConversation("r-1")).toBe(originals.get("r-1")!);
		unpinCursorConversation("r-1");

		// Re-pinning the evicted r-0 yields a fresh entry with no residue.
		const r0 = pinCursorConversation("r-0");
		expect(r0).not.toBe(originals.get("r-0"));
		expect(r0.state).toBeUndefined();
		expect(r0.blobs.size).toBe(0);
	});

	it("re-pin after eviction recreates a fresh entry (no false residue)", () => {
		const first = pinCursorConversation("evicted-id");
		first.blobs.set("k", new Uint8Array([42]));
		first.state = undefined;
		unpinCursorConversation("evicted-id");
		// Overflow it out of retained.
		for (let i = 0; i <= CURSOR_RETAINED_CONVERSATION_LIMIT; i++) {
			const id = `filler-${i}`;
			pinCursorConversation(id);
			unpinCursorConversation(id);
		}
		const rePinned = pinCursorConversation("evicted-id");
		expect(rePinned).not.toBe(first);
		expect(rePinned.blobs).not.toBe(first.blobs);
		expect(rePinned.blobs.size).toBe(0);
		expect(rePinned.state).toBeUndefined();
		unpinCursorConversation("evicted-id");
	});

	it("unpinning an unknown id is a no-op", () => {
		expect(() => unpinCursorConversation("never-pinned")).not.toThrow();
		const entry = pinCursorConversation("known");
		entry.blobs.set("x", new Uint8Array([9]));
		unpinCursorConversation("known");
		// Now unpinned (retained) — a second unpin on the unpinned id is still a no-op.
		expect(() => unpinCursorConversation("known")).not.toThrow();
	});

	it("re-entrant pins keep the entry active until the final unpin", () => {
		const first = pinCursorConversation("re");
		expect(pinCursorConversation("re")).toBe(first);
		unpinCursorConversation("re");
		// Still pinned once → entry identity unchanged, not yet in the retained eviction set.
		expect(pinCursorConversation("re")).toBe(first);
		unpinCursorConversation("re");
	});
});

describe("cursor conversation store — rotation", () => {
	function requireRotation(result: string | undefined): string {
		if (result === undefined) throw new Error("expected a rotation id");
		return result;
	}

	it("returns three distinct ids then undefined on the fourth", () => {
		const ids: Array<string> = [];
		for (let i = 0; i < MAX_CURSOR_CONVERSATION_ROTATIONS; i++) {
			const rotated = requireRotation(rotateCursorConversation("base"));
			expect(ids).not.toContain(rotated);
			ids.push(rotated);
			// Each rotation must complete a turn before the next may be issued.
			markCursorRotationSucceeded(rotated);
		}
		expect(new Set(ids).size).toBe(MAX_CURSOR_CONVERSATION_ROTATIONS);
		expect(rotateCursorConversation("base")).toBeUndefined();
	});

	it("a rotation is fresh until a turn marks it succeeded", () => {
		const rotated = requireRotation(rotateCursorConversation("base"));
		expect(isCursorRotationFresh(rotated)).toBe(true);
		expect(isCursorRotationMarked(rotated)).toBe(false);
		// While unmarked, a re-rotation is refused and the resolved id holds.
		expect(rotateCursorConversation("base")).toBeUndefined();
		expect(resolveCursorConversationId("base")).toBe(rotated);

		markCursorRotationSucceeded(rotated);
		expect(isCursorRotationMarked(rotated)).toBe(true);
		expect(isCursorRotationFresh(rotated)).toBe(false);
	});

	it("marking and the rotation cap are tracked per base", () => {
		const rotA = requireRotation(rotateCursorConversation("a"));
		const rotC = requireRotation(rotateCursorConversation("c"));
		markCursorRotationSucceeded(rotA);
		expect(isCursorRotationMarked(rotA)).toBe(true);
		expect(isCursorRotationMarked(rotC)).toBe(false);
		// Base "a" hits its own cap of 3, independent of the single marking;
		// each step marks the freshly rotated id so the next rotation is allowed.
		expect(rotateCursorConversation("a")).toBeDefined();
		markCursorRotationSucceeded(resolveCursorConversationId("a"));
		expect(rotateCursorConversation("a")).toBeDefined();
		markCursorRotationSucceeded(resolveCursorConversationId("a"));
		expect(rotateCursorConversation("a")).toBeUndefined();
		// Base "c" is unaffected: its current id is unmarked, so its next
		// rotation must wait for a completed turn.
		expect(rotateCursorConversation("c")).toBeUndefined();
		markCursorRotationSucceeded(rotC);
		expect(rotateCursorConversation("c")).toBeDefined();
	});

	it("two consecutive rotations without marking return [id, undefined]", () => {
		const first = rotateCursorConversation("streak");
		expect(first).toBeDefined();
		// A failure streak must not consume ids: while the current rotated id is
		// unmarked, the next rotation is refused — real account exhaustion must
		// not be hidden behind a rotation cascade.
		expect(rotateCursorConversation("streak")).toBeUndefined();
		expect(resolveCursorConversationId("streak")).toBe(requireRotation(first));
	});

	it("resolveCursorConversationId returns the latest rotated id, or the base itself", () => {
		// A never-rotated base resolves to itself.
		expect(resolveCursorConversationId("never-rotated")).toBe("never-rotated");

		const first = requireRotation(rotateCursorConversation("base"));
		markCursorRotationSucceeded(first);
		const second = requireRotation(rotateCursorConversation("base"));
		// The latest rotation wins: the resolver returns the current wire id.
		expect(resolveCursorConversationId("base")).toBe(second);
		expect(resolveCursorConversationId("base")).not.toBe(first);
		// An unrelated base is unaffected by rotations on "base".
		expect(resolveCursorConversationId("other")).toBe("other");
	});
});
