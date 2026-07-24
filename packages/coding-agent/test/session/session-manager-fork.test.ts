import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getAgentDir, getTerminalSessionsDir, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

interface JsonlMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user";
		content: string;
		timestamp: number;
	};
}

describe("SessionManager.forkFrom", () => {
	it("suppresses terminal breadcrumbs while preserving source history under a new parented session", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-");
		const previousAgentDir = getAgentDir();
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		setAgentDir(path.join(tempDir.path(), "agent"));
		process.env.TERM_SESSION_ID = "omp-fork-test";
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceHeader: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp,
				cwd,
			};
			const sourceMessage: JsonlMessageEntry = {
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hello", timestamp: Date.now() },
			};
			const sourceText = `${JSON.stringify(sourceHeader)}\n${JSON.stringify(sourceMessage)}\n`;
			await Bun.write(sourceFile, sourceText);

			const terminalId = getTerminalId();
			expect(terminalId).toBeString();
			const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId ?? "missing");
			await removeWithRetries(breadcrumbFile);

			const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			await Bun.sleep(10);
			const cloneFile = forked.getSessionFile();
			expect(cloneFile).toBeString();
			if (!cloneFile) throw new Error("expected forked session file");

			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			expect(await Bun.file(breadcrumbFile).exists()).toBe(false);
			expect(cloneFile).not.toBe(sourceFile);

			const cloneEntries = await loadEntriesFromFile(cloneFile);
			const cloneHeader = cloneEntries.find((entry): entry is SessionHeader => entry.type === "session");
			const cloneMessage = cloneEntries.find((entry): entry is SessionMessageEntry => entry.type === "message");
			expect(cloneHeader?.id).not.toBe(sourceHeader.id);
			expect(cloneHeader?.parentSession).toBe(sourceHeader.id);
			expect(cloneHeader?.cwd).toBe(cwd);
			if (cloneMessage?.message.role !== "user") throw new Error("expected forked user message");
			expect(cloneMessage.message.content).toBe("hello");
		} finally {
			if (previousTermSessionId === undefined) {
				delete process.env.TERM_SESSION_ID;
			} else {
				process.env.TERM_SESSION_ID = previousTermSessionId;
			}
			setAgentDir(previousAgentDir);
		}
	});

	it("pins a committed path and rejects an absent boundary", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-boundary-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "source-session",
			timestamp,
			cwd,
		};
		const first: JsonlMessageEntry = {
			type: "message",
			id: "first",
			parentId: null,
			timestamp,
			message: { role: "user", content: "first", timestamp: Date.now() },
		};
		const later: JsonlMessageEntry = {
			type: "message",
			id: "later",
			parentId: first.id,
			timestamp,
			message: { role: "user", content: "later", timestamp: Date.now() },
		};
		await Bun.write(sourceFile, `${JSON.stringify(header)}\n${JSON.stringify(first)}\n${JSON.stringify(later)}\n`);

		const pinned = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			throughLeafId: first.id,
			suppressBreadcrumb: true,
		});
		expect(pinned.getEntries().map(entry => entry.id)).toEqual([first.id]);
		expect(pinned.buildSessionContextAt(first.id).messages).toHaveLength(1);

		const empty = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			throughLeafId: null,
			suppressBreadcrumb: true,
		});
		expect(empty.getEntries()).toEqual([]);
		expect(() => pinned.buildSessionContextAt("missing")).toThrow(
			"Cannot fork committed snapshot: entry missing not found",
		);
		await expect(
			SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
				throughLeafId: "missing",
				suppressBreadcrumb: true,
			}),
		).rejects.toThrow("Cannot fork committed snapshot: entry missing not found");
	});
	it("keeps an immediate parent append when materializing a lazy header", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-materialize-race-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const parent = SessionManager.create(cwd, sessionDir);
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("expected lazy parent session file");

		// Do not await first: this models a provider append arriving immediately
		// after /consult has captured the metadata-only parent boundary.
		const header = parent.getHeader();
		const materializing = parent.materializeHeaderAndModelState({
			header: header === null ? undefined : structuredClone(header),
			model: "test-provider/test-model",
			providerPromptCacheKey: "parent-cache",
			sessionFile: parentFile,
		});
		parent.appendMessage(createAssistantMessage("must remain on parent"));
		await materializing;
		await parent.flush();

		const parentEntries = await loadEntriesFromFile(parentFile);
		expect(parentEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.objectContaining({
						role: "assistant",
						content: [{ type: "text", text: "must remain on parent" }],
					}),
				}),
			]),
		);
	});
});
