import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

describe("SessionManager.forkNativeHistory", () => {
	it("edits an assistant as assistant while preserving the native prefix and discarding its suffix", async () => {
		using tempDir = TempDir.createSync("@pi-native-history-edit-");
		const source = SessionManager.create(tempDir.path(), tempDir.path());
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const firstUser = source.appendMessage({
			role: "user",
			content: [{ type: "text", text: "inspect" }, image],
			timestamp: 1,
		});
		source.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }],
		});
		source.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "contents" }, image],
			isError: false,
			timestamp: 2,
		});
		source.appendCompaction("summary", "short", firstUser, 100, { preserveData: { exact: "preserved" } });
		const selected = source.appendMessage({
			...makeAssistantMessage(),
			responseId: "stale-response",
			content: [
				{ type: "text", text: "old answer" },
				{ type: "toolCall", id: "discarded-call", name: "write", arguments: { path: "b.txt" } },
			],
		});
		source.appendMessage({
			role: "toolResult",
			toolCallId: "discarded-call",
			toolName: "write",
			content: [{ type: "text", text: "written" }],
			isError: false,
			timestamp: 3,
		});
		source.appendMessage({ role: "user", content: "discarded suffix", timestamp: 4 });
		await source.flush();
		const sourceFile = source.getSessionFile();
		const sourceLeaf = source.getLeafId();
		if (!sourceFile || !sourceLeaf) throw new Error("Expected persisted source history");

		const fork = await SessionManager.forkNativeHistory(
			sourceFile,
			tempDir.path(),
			selected,
			tempDir.path(),
			undefined,
			{
				leafEntryId: sourceLeaf,
				edit: { entryId: selected, text: "edited answer" },
			},
		);
		expect(fork.selectedRole).toBe("assistant");
		expect(fork.replacementEntryId === fork.sessionManager.getLeafId()).toBeTrue();
		expect(fork.sessionManager.getSessionId()).not.toBe(source.getSessionId());

		const targetBranch = fork.sessionManager.getBranch();
		expect(
			targetBranch.some(entry => entry.type === "compaction" && entry.preserveData?.exact === "preserved"),
		).toBeTrue();
		const targetMessages = fork.sessionManager.buildSessionContext().messages;
		expect(
			targetMessages.some(message => message.role === "toolResult" && message.content[1]?.type === "image"),
		).toBeTrue();
		const edited = targetMessages.at(-1);
		expect(edited?.role).toBe("assistant");
		if (edited?.role !== "assistant") throw new Error("Expected edited assistant leaf");
		expect(edited.content).toEqual([{ type: "text", text: "edited answer" }]);
		expect(edited.responseId).toBeUndefined();
		expect(JSON.stringify(targetBranch)).not.toContain("discarded suffix");
		expect(JSON.stringify(targetBranch)).not.toContain("discarded-call");
		expect(JSON.stringify(source.getBranch())).toContain("discarded suffix");

		const targetFile = fork.sessionManager.getSessionFile();
		if (!targetFile) throw new Error("Expected persisted target history");
		const reopened = await SessionManager.open(targetFile, tempDir.path());
		expect(reopened.getLeafId() === fork.replacementEntryId).toBeTrue();
		expect(JSON.stringify(reopened.getBranch())).not.toContain("discarded suffix");
	});

	it("branches through the selected entry without rewriting it", async () => {
		using tempDir = TempDir.createSync("@pi-native-history-branch-");
		const source = SessionManager.create(tempDir.path(), tempDir.path());
		const selected = source.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const sourceFile = source.getSessionFile();
		const sourceLeaf = source.getLeafId();
		if (!sourceFile || !sourceLeaf) throw new Error("Expected persisted source history");

		const fork = await SessionManager.forkNativeHistory(
			sourceFile,
			tempDir.path(),
			selected,
			tempDir.path(),
			undefined,
			{ leafEntryId: sourceLeaf },
		);

		expect(fork.replacementEntryId).toBeUndefined();
		expect(fork.sessionManager.getLeafId()).toBe(selected);
		expect(fork.sessionManager.buildSessionContext().messages).toEqual([
			{ role: "user", content: "branch point", timestamp: 1 },
		]);
		expect(source.getLeafId()).toBe(sourceLeaf);
	});
});
