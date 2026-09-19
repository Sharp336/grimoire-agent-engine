import { describe, expect, it } from "bun:test";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildSessionContext } from "../../src/session/session-context";
import type { SessionEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";
import {
	assertStorageProtocolHash,
	STORAGE_PROTOCOL_SCHEMA,
	STORAGE_PROTOCOL_SCHEMA_HASH,
	STORAGE_PROTOCOL_VERSION,
	storageProtocolRequest,
} from "../../src/session/storage-protocol";

const user = (content: string, timestamp: number): UserMessage => ({
	role: "user",
	content,
	timestamp,
});

describe("native session storage contract", () => {
	it("keeps leaf-to-root lineage, protects branches, and stops cycles", () => {
		const manager = SessionManager.inMemory("/tmp/native-contract");
		const root = manager.appendMessage(user("root", 1));
		const originalChild = manager.appendMessage(user("original", 2));

		manager.branch(root);
		const branch = manager.appendMessage(user("branch", 3));

		expect(manager.getBranch().map(entry => entry.id)).toEqual([root, branch]);
		expect(manager.getEntry(originalChild)?.parentId).toBe(root);
		const originalEntry = manager.getEntry(originalChild);
		expect(originalEntry?.type).toBe("message");
		if (originalEntry?.type === "message") expect(originalEntry.message).toMatchObject({ content: "original" });

		manager.ingestReplicatedEntry({
			type: "custom",
			id: "cycle",
			parentId: "cycle",
			timestamp: new Date(4).toISOString(),
			customType: "native-contract",
		});
		expect(manager.getBranch("cycle").map(entry => entry.id)).toEqual(["cycle"]);
	});

	it("retains native transition metadata and ordered tool pairs", () => {
		const manager = SessionManager.inMemory("/tmp/native-contract");
		const first = manager.appendMessage(user("prompt", 1));
		manager.appendThinkingLevelChange("high", "high");
		manager.appendModelChange("anthropic/claude", "slow");
		manager.appendServiceTierChange(null);
		manager.appendModeChange("plan", { source: "test" });
		manager.appendTtsrInjection(["rule-a", "rule-a", "rule-b"]);
		manager.appendCompaction("summary", undefined, first, 12);

		expect(manager.getLastModelChangeRole()).toBe("slow");
		expect(manager.getInjectedTtsrRules()).toEqual(["rule-a", "rule-b"]);
		expect(manager.getEntries().map(entry => entry.type)).toEqual([
			"message",
			"thinking_level_change",
			"model_change",
			"service_tier_change",
			"mode_change",
			"ttsr_injection",
			"compaction",
		]);

		const dangling = [
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: new Date(1).toISOString(),
				message: user("run", 1),
			},
			{
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp: new Date(2).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
				},
			},
		] as SessionEntry[];
		const context = buildSessionContext(dangling, undefined, undefined, { transcript: true });
		expect(context.messages.some(message => message.role === "assistant" && message.content.length === 0)).toBe(true);
	});

	it("preserves session identity and completed entries on cold reopen", async () => {
		using tempDir = TempDir.createSync("@omp-native-contract-");
		const cwd = `${tempDir.path}/project`;
		const sessionDir = `${tempDir.path}/sessions`;
		const storage = new FileSessionStorage();
		const sessionFile = SessionManager.createEmptySessionFile(cwd, storage);
		const manager = await SessionManager.open(sessionFile, sessionDir, storage, { suppressBreadcrumb: true });
		const sessionId = manager.getSessionId();
		manager.appendMessage(user("durable", 1));
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, sessionDir, storage, { suppressBreadcrumb: true });
		expect(reopened.getSessionId()).toBe(sessionId);
		expect(reopened.getEntries().some(entry => entry.type === "message" && entry.message.role === "user")).toBe(true);
		await reopened.close();
	});

	it("seals the journal so shutdown cannot report a dropped append as durable", async () => {
		const manager = SessionManager.inMemory("/tmp/native-contract");
		manager.appendMessage(user("before seal", 1));
		const retained = manager.getEntries().length;
		manager.releaseRetainedEntries();
		manager.appendMessage(user("after seal", 2));
		expect(manager.getEntries()).toHaveLength(retained);
		await manager.close();
	});

	it("pins the Core-owned protocol identity without a second schema", () => {
		const request = storageProtocolRequest("barrier", {
			barrier: {
				requestId: "request-1",
				familyId: "family-1",
				generationId: "generation-1",
				throughSeq: 1,
				dependencies: [],
				incarnation: 1,
			},
		});
		expect(request.schema).toBe(STORAGE_PROTOCOL_SCHEMA);
		expect(request.version).toBe(STORAGE_PROTOCOL_VERSION);
		expect(STORAGE_PROTOCOL_SCHEMA_HASH).toBe(
			"sha256:09137f606a52bf6ff9ca8055caa0ca8470b21be9406ee924e424b3ce42d08a90",
		);
		expect(() => assertStorageProtocolHash(STORAGE_PROTOCOL_SCHEMA_HASH)).not.toThrow();
		expect(() => assertStorageProtocolHash("sha256:stale")).toThrow(/Unsupported storage protocol schema hash/);
	});
});
