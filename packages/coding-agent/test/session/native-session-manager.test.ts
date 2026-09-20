import { describe, expect, it } from "bun:test";
import {
	type NativeSessionCheckpoint,
	type NativeSessionPosition,
	type NativeSessionRead,
	type NativeSessionStorage,
	type NativeSessionTicket,
	NativeSessionWriteRejectedError,
} from "../../src/session/native-session-storage";
import { buildSessionContext } from "../../src/session/session-context";
import type { SessionEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { getLatestTodoPhasesFromEntries } from "../../src/tools/todo";

class StructuredStore implements NativeSessionStorage {
	readonly locator = "native:test/session";
	entries: SessionEntry[] = [];
	checkpoint!: NativeSessionCheckpoint;
	seq = 0;
	readIds: string[] = [];
	archiveReads = 0;
	fail = false;
	rejectRewrite = false;
	constructor(readonly parent?: StructuredStore) {}
	initializeFork(source: NativeSessionPosition, checkpoint: NativeSessionCheckpoint): NativeSessionTicket {
		if (!this.parent || this.parent.seq !== source.throughSeq) throw new Error("Missing immutable test parent cut");
		this.entries = structuredClone(this.parent.entries);
		return this.append([], checkpoint);
	}
	append(entries: readonly SessionEntry[], checkpoint: NativeSessionCheckpoint): NativeSessionTicket {
		if (this.fail) throw new Error("admission capacity exhausted");
		this.entries.push(...structuredClone(entries));
		this.checkpoint = structuredClone(checkpoint);
		this.seq += Math.max(1, entries.length);
		return {
			position: { familyId: "f", generationId: "g", throughSeq: this.seq, incarnation: 1 },
			completion: Promise.resolve(),
		};
	}
	rewrite(
		entries: readonly SessionEntry[],
		deleted: readonly string[],
		checkpoint: NativeSessionCheckpoint,
		appended: readonly SessionEntry[] = [],
	): NativeSessionTicket {
		if (this.fail) throw new Error("admission capacity exhausted");
		if (this.rejectRewrite)
			return {
				position: { familyId: "f", generationId: "g", throughSeq: this.seq + 1, incarnation: 1 },
				completion: Promise.reject(new NativeSessionWriteRejectedError("native CAS conflict")),
			};
		this.entries = structuredClone(
			this.entries
				.filter(entry => !deleted.includes(entry.id))
				.map(entry => entries.find(replacement => replacement.id === entry.id) ?? entry),
		);
		return this.append(appended, checkpoint);
	}
	async barrier(_position: NativeSessionPosition): Promise<void> {}
	async readContext(): Promise<NativeSessionRead> {
		const byId = new Map(this.entries.map(entry => [entry.id, entry]));
		const entries: SessionEntry[] = [];
		let id = this.checkpoint.leafId;
		while (id) {
			const entry = byId.get(id)!;
			entries.unshift(entry);
			this.readIds.push(id);
			if (id === this.checkpoint.contextStartId) break;
			id = entry.parentId;
		}
		return {
			checkpoint: structuredClone(this.checkpoint),
			entries: structuredClone(entries),
			throughSeq: this.seq,
			position: { familyId: "f", generationId: "g", throughSeq: this.seq, incarnation: 1 },
			complete: false,
		};
	}
	async readChildren(parentId: string): Promise<SessionEntry[]> {
		return structuredClone(this.entries.filter(entry => entry.parentId === parentId));
	}
	async readArchive(): Promise<NativeSessionRead> {
		this.archiveReads++;
		return {
			checkpoint: structuredClone(this.checkpoint),
			entries: structuredClone(this.entries),
			throughSeq: this.seq,
			position: { familyId: "f", generationId: "g", throughSeq: this.seq, incarnation: 1 },
			complete: true,
		};
	}
}

describe("structured native SessionManager", () => {
	it("forks a fresh native generation from the durable context without archive materialization", async () => {
		const source = new StructuredStore();
		const manager = SessionManager.createNative("/source", source);
		manager.appendModelChange("openai/model");
		const archived = manager.appendMessage({ role: "user", content: "archive", timestamp: 1 });
		const kept = manager.appendMessage({ role: "user", content: "keep", timestamp: 2 });
		manager.appendCompaction("summary", undefined, kept, 100);
		await manager.flush();
		const target = new StructuredStore(source);
		const fork = await SessionManager.forkNativeContext(source, target, "/target");
		expect(fork.getSessionId()).not.toBe(manager.getSessionId());
		expect(fork.buildSessionContext()).toEqual(manager.buildSessionContext());
		expect(source.readIds).not.toContain(archived);
		expect(source.archiveReads).toBe(0);
		fork.appendMessage({ role: "user", content: "only fork", timestamp: 3 });
		await fork.flush();
		expect((await SessionManager.openNative(target)).buildSessionContext()).toEqual(fork.buildSessionContext());
		expect(source.entries).toHaveLength(4);
		expect(target.checkpoint.header.parentSession).toBe(manager.getSessionId());
	});
	it("rolls back edits and metadata reparenting after a known CAS rejection", async () => {
		const storage = new StructuredStore();
		const manager = SessionManager.createNative("/native", storage);
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const doomed = manager.appendMessage({ role: "user", content: "discard", timestamp: 2 });
		const tier = manager.appendServiceTierChange(null);
		await manager.flush();
		const expected = manager.buildSessionContext();
		storage.rejectRewrite = true;
		await expect(manager.discardEntryDurably(doomed)).rejects.toThrow("CAS conflict");
		expect(manager.getEntry(doomed)?.parentId).toBe(root);
		expect(manager.getEntry(tier)?.parentId).toBe(doomed);
		expect(manager.buildSessionContext()).toEqual(expected);
		expect(storage.entries).toHaveLength(3);
	});

	it("reparents metadata children atomically and cold resumes the selected branch", async () => {
		const storage = new StructuredStore();
		const manager = SessionManager.createNative("/native", storage);
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const doomed = manager.appendMessage({ role: "user", content: "discard", timestamp: 2 });
		const tier = manager.appendServiceTierChange(null);
		await manager.discardEntryDurably(doomed);
		expect(storage.entries.some(entry => entry.id === doomed)).toBe(false);
		expect(storage.entries.find(entry => entry.id === tier)?.parentId).toBe(root);
		expect((await SessionManager.openNative(storage)).buildSessionContext()).toEqual(manager.buildSessionContext());
	});

	it("does not double-count archive usage across repeated branch selection and reset in an atomic batch", async () => {
		const storage = new StructuredStore();
		const manager = SessionManager.createNative("/native", storage);
		manager.appendModelChange("openai/model");
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			provider: "openai",
			model: "model",
			api: "openai-responses",
			timestamp: 1,
			stopReason: "stop",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		const compact = manager.appendCompaction("summary", undefined, kept, 100);
		const usage = manager.getUsageStatistics();
		manager.branch(compact);
		manager.branch(compact);
		expect(manager.getUsageStatistics()).toEqual(usage);
		await manager.appendEntriesAtomically(() => {
			manager.resetLeaf();
			manager.appendMessage({ role: "user", content: "fresh", timestamp: 3 });
		});
		const cold = await SessionManager.openNative(storage);
		expect(cold.getUsageStatistics()).toEqual(usage);
		expect(cold.buildSessionContext()).toEqual(manager.buildSessionContext());
		expect(cold.buildSessionContext().models.default).toBeUndefined();
	});
	it("cold resume retains opaque compaction, settings and tool identities without reading the archive", async () => {
		const storage = new StructuredStore();
		const manager = SessionManager.createNative("/native", storage);
		manager.appendModelChange("openai/configured");
		manager.appendThinkingLevelChange("high", "auto");
		manager.appendModeChange("plan", { exact: true });
		manager.appendTtsrInjection(["a", "b"]);
		const old = manager.appendMessage({ role: "user", content: "archive", timestamp: 1 });
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		const replacementHistory = [
			{ type: "compaction", encrypted_content: "opaque-ciphertext", unknown: { keep: [1, 2] } },
		];
		manager.appendCompaction("summary", undefined, kept, 100, {
			preserveData: { openaiRemoteCompaction: { provider: "openai", replacementHistory } },
		});
		const expected = manager.buildSessionContext();
		await manager.close();
		const reopened = await SessionManager.openNative(storage);
		expect(reopened.buildSessionContext()).toEqual(expected);
		expect(reopened.getSessionId()).toBe(manager.getSessionId());
		expect(reopened.getLeafId()).toBe(manager.getLeafId());
		expect(reopened.getLastModelChangeRole()).toBe("default");
		expect(reopened.hasContextEntryType("thinking_level_change")).toBe(true);
		expect(storage.readIds).not.toContain(old);
		expect(storage.archiveReads).toBe(0);
		expect(() => reopened.getEntries()).toThrow("materializeHistory");
		await reopened.materializeHistory();
		expect(reopened.getEntries().map(entry => entry.id)).toContain(old);
		expect(reopened.buildSessionContext()).toEqual(expected);
	});

	it("commits entry batches together and surfaces rejected admission at the durability boundary", async () => {
		const storage = new StructuredStore();
		const manager = SessionManager.createNative("/native", storage);
		await manager.appendEntriesAtomically(() => {
			manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
			manager.appendMessage({ role: "user", content: "two", timestamp: 2 });
		});
		const checkpoint = await manager.flushAndCheckpoint();
		expect(checkpoint.native?.throughSeq).toBe(2);
		expect(storage.entries[1].parentId).toBe(storage.entries[0].id);
		storage.fail = true;
		expect(() => manager.appendMessage({ role: "user", content: "rejected", timestamp: 3 })).toThrow(
			"admission capacity",
		);
		await expect(manager.flushAndCheckpoint()).rejects.toThrow("admission capacity");
		expect(storage.entries).toHaveLength(2);
	});
	it("preserves tool pairs and auxiliary state across compaction, reset and native delta rewrites", async () => {
		const storage = new StructuredStore();
		const manager = SessionManager.createNative("/native", storage);
		manager.appendModelChange("openai/configured");
		manager.appendThinkingLevelChange("high", "auto");
		manager.appendCustomEntry("user_todo_edit", {
			phases: [{ name: "phase", tasks: [{ content: "todo", status: "in_progress" }] }],
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "checkpoint",
			toolName: "checkpoint",
			content: [{ type: "text", text: "ready" }],
			details: { startedAt: "2026-09-20T00:00:00Z" },
			isError: false,
			timestamp: 1,
		});
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		manager.appendCompaction("summary", undefined, kept, 100);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "x" } }],
			provider: "openai",
			model: "temporary",
			api: "openai-responses",
			timestamp: 3,
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const resultId = manager.appendMessage({
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "old output" }],
			isError: false,
			timestamp: 4,
		});
		await manager.close();
		const cold = await SessionManager.openNative(storage);
		expect(cold.buildSessionContext()).toEqual(buildSessionContext(storage.entries, cold.getLeafId()));
		expect(cold.buildSessionContext().models.default).toBe("openai/configured");
		expect(getLatestTodoPhasesFromEntries(cold.getTodoStateEntries())[0].tasks[0].content).toBe("todo");
		expect(cold.getCheckpointRewindPrefix()?.pending?.startedAt).toBe("2026-09-20T00:00:00Z");
		const result = cold.getEntry(resultId)!;
		if (result.type !== "message" || result.message.role !== "toolResult") throw new Error("Expected tool result");
		result.message.content = [{ type: "text", text: "pruned output" }];
		await cold.rewriteEntries();
		const rewritten = await SessionManager.openNative(storage);
		expect(rewritten.buildSessionContext()).toEqual(buildSessionContext(storage.entries, rewritten.getLeafId()));
		expect(rewritten.getEntry(resultId)?.parentId).toBe(result.parentId);
		rewritten.appendResetBoundary();
		rewritten.appendMessage({ role: "user", content: "after reset", timestamp: 5 });
		await rewritten.close();
		const reset = await SessionManager.openNative(storage);
		expect(reset.buildSessionContext()).toEqual(buildSessionContext(storage.entries, reset.getLeafId()));
		expect(reset.buildSessionContext().messages).toHaveLength(1);
		expect(reset.getUsageStatistics()).toEqual(manager.getUsageStatistics());
		expect(storage.archiveReads).toBe(0);
	});

	it("queries off-branch children before discard and keeps the same native leaf semantics", async () => {
		const storage = new StructuredStore();
		const manager = SessionManager.createNative("/native", storage);
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const sibling = manager.appendMessage({ role: "user", content: "sibling", timestamp: 2 });
		manager.branch(root);
		manager.appendServiceTierChange(null);
		await manager.close();
		const cold = await SessionManager.openNative(storage);
		await cold.discardEntryDurably(root);
		expect(storage.entries.find(entry => entry.id === sibling)?.parentId).toBe(root);
		expect(storage.entries.some(entry => entry.id === root)).toBe(true);
		const resumed = await SessionManager.openNative(storage);
		expect(resumed.buildSessionContext()).toEqual(buildSessionContext(storage.entries, resumed.getLeafId()));
		expect(storage.archiveReads).toBe(0);
	});
});
