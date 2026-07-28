import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("SessionManager compaction statistics", () => {
	it("tracks compactions incrementally and resets with the session", async () => {
		const session = SessionManager.inMemory();
		const firstMessageId = session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		expect(session.getCompactionCount()).toBe(0);

		session.appendCompaction("first summary", undefined, firstMessageId, 100);
		expect(session.getCompactionCount()).toBe(1);

		const secondMessageId = session.appendMessage({ role: "user", content: "second", timestamp: 2 });
		session.appendCompaction("second summary", undefined, secondMessageId, 200);
		expect(session.getCompactionCount()).toBe(2);
		expect(session.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(2);

		await session.newSession();
		expect(session.getCompactionCount()).toBe(0);
	});

	it("rebuilds the total when opening an existing journal", async () => {
		using tempDir = TempDir.createSync("@pi-session-compaction-statistics-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const firstMessageId = session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		session.appendCompaction("first summary", undefined, firstMessageId, 100);
		session.appendCompaction("second summary", undefined, firstMessageId, 200);
		await session.ensureOnDisk();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");
		await session.close();

		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		try {
			expect(reopened.getCompactionCount()).toBe(2);
		} finally {
			await reopened.close();
		}
	});

	it("advances the journal revision for off-branch appends and rewrites", async () => {
		using tempDir = TempDir.createSync("@pi-session-journal-revision-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			const rootId = session.appendMessage({ role: "user", content: "root", timestamp: 1 });
			const activeLeafId = session.appendMessage({ role: "user", content: "active", timestamp: 2 });
			await session.ensureOnDisk();

			const beforeBranchAppend = session.getJournalRevision();
			session.appendMessageToBranch({ role: "user", content: "background", timestamp: 3 }, rootId);
			expect(session.getLeafId()).toBe(activeLeafId);
			expect(session.getJournalRevision()).toBeGreaterThan(beforeBranchAppend);

			const beforeRewrite = session.getJournalRevision();
			await session.rewriteEntries();
			expect(session.getJournalRevision()).toBeGreaterThan(beforeRewrite);
		} finally {
			await session.close();
		}
	});
});
