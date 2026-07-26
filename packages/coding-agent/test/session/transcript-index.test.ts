import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SESSION_TAG_PREFIX } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TranscriptIndex } from "@oh-my-pi/pi-coding-agent/session/transcript-index";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;
let dbPath = "";

function freshIndex(): TranscriptIndex {
	tempDir = TempDir.createSync("@omp-transcript-index-");
	TranscriptIndex.resetInstance();
	dbPath = tempDir.join("transcripts.db");
	return TranscriptIndex.open(dbPath);
}

function writeJsonl(sessionDir: string, fileName: string, lines: unknown[]): string {
	fs.mkdirSync(sessionDir, { recursive: true });
	const filePath = path.join(sessionDir, fileName);
	fs.writeFileSync(filePath, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`, "utf8");
	return filePath;
}

function tableCounts(fileDbPath: string): { chunks: number; fts: number } {
	const db = new Database(fileDbPath, { readonly: true });
	try {
		const chunks = (db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
		const fts = (db.prepare("SELECT count(*) AS n FROM chunks_fts").get() as { n: number }).n;
		return { chunks, fts };
	} finally {
		db.close();
	}
}

function kindCounts(fileDbPath: string): Record<string, number> {
	const db = new Database(fileDbPath, { readonly: true });
	try {
		const rows = db.prepare("SELECT kind, count(*) AS n FROM chunks GROUP BY kind").all() as Array<{
			kind: string;
			n: number;
		}>;
		const out: Record<string, number> = {};
		for (const row of rows) out[row.kind] = row.n;
		return out;
	} finally {
		db.close();
	}
}

function sessionHeader(id: string, cwd = "/tmp/workspace") {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-07-25T12:00:00.000Z",
		cwd,
	};
}

function messageEntry(
	id: string,
	parentId: string | null,
	message: Record<string, unknown>,
	timestamp = "2026-07-25T12:00:01.000Z",
) {
	return { type: "message", id, parentId, timestamp, message };
}

beforeEach(() => {
	TranscriptIndex.resetInstance();
});

afterEach(async () => {
	TranscriptIndex.resetInstance();
	if (tempDir) {
		await Bun.sleep(0);
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
	dbPath = "";
});

describe("TranscriptIndex", () => {
	it("reindex extracts message_text, tool_use, and tool_result chunks and skips non-message entries", async () => {
		const index = freshIndex();
		const sessionDir = tempDir!.join("sessions");
		writeJsonl(sessionDir, "extract.jsonl", [
			sessionHeader("sess-extract"),
			{
				type: "model_change",
				id: "mc1",
				parentId: null,
				timestamp: "2026-07-25T12:00:00.500Z",
				model: "anthropic/claude-sonnet-4",
			},
			{
				type: "thinking_level_change",
				id: "tl1",
				parentId: "mc1",
				timestamp: "2026-07-25T12:00:00.750Z",
				thinkingLevel: "high",
			},
			messageEntry("m-user", null, {
				role: "user",
				content: "extract-user-alpha",
			}),
			messageEntry(
				"m-asst",
				"m-user",
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "should-not-be-indexed" },
						{ type: "text", text: "extract-assistant-beta" },
						{
							type: "toolCall",
							id: "tc1",
							name: "bash",
							arguments: { command: "extract-tool-use-gamma" },
						},
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test-model",
					usage: {},
					stopReason: "toolUse",
					timestamp: Date.parse("2026-07-25T12:00:02.000Z"),
				},
				"2026-07-25T12:00:02.000Z",
			),
			messageEntry(
				"m-tool",
				"m-asst",
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "extract-tool-result-delta" }],
					isError: false,
					timestamp: Date.parse("2026-07-25T12:00:03.000Z"),
				},
				"2026-07-25T12:00:03.000Z",
			),
			{
				type: "label",
				id: "lbl1",
				parentId: "m-tool",
				timestamp: "2026-07-25T12:00:04.000Z",
				targetId: "m-user",
				label: "bookmark-not-a-session-tag",
			},
		]);

		const result = await index.reindex({ sessionDirs: [sessionDir] });
		expect(result).toEqual({ files: 1, indexedFiles: 1 });

		expect(kindCounts(dbPath)).toEqual({
			message_text: 2,
			tool_use: 1,
			tool_result: 1,
		});
		expect(tableCounts(dbPath)).toEqual({ chunks: 4, fts: 4 });

		expect(index.search("extract-user-alpha").map(h => h.kind)).toEqual(["message_text"]);
		expect(index.search("extract-assistant-beta").map(h => h.kind)).toEqual(["message_text"]);
		expect(index.search("extract-tool-use-gamma").map(h => ({ kind: h.kind, snippet: h.snippet }))).toEqual([
			{ kind: "tool_use", snippet: 'bash {"command":"extract-tool-use-gamma"}' },
		]);
		expect(index.search("extract-tool-result-delta").map(h => h.kind)).toEqual(["tool_result"]);
		expect(index.search("should-not-be-indexed")).toEqual([]);
		expect(index.search("bookmark-not-a-session-tag")).toEqual([]);
		expect(index.search("claude-sonnet-4")).toEqual([]);
	});

	it("second reindex over an unchanged tree indexes zero files (mtime+size skip)", async () => {
		const index = freshIndex();
		const sessionDir = tempDir!.join("sessions");
		writeJsonl(sessionDir, "stable-a.jsonl", [
			sessionHeader("sess-a"),
			messageEntry("m1", null, { role: "user", content: "stable-alpha" }),
		]);
		writeJsonl(sessionDir, "stable-b.jsonl", [
			sessionHeader("sess-b"),
			messageEntry("m1", null, { role: "user", content: "stable-beta" }),
		]);

		expect(await index.reindex({ sessionDirs: [sessionDir] })).toEqual({ files: 2, indexedFiles: 2 });
		expect(await index.reindex({ sessionDirs: [sessionDir] })).toEqual({ files: 2, indexedFiles: 0 });
		expect(tableCounts(dbPath)).toEqual({ chunks: 2, fts: 2 });
	});

	it("touching one file reindexes only that file with no duplicate rows (chunks_ad FTS delete trigger)", async () => {
		const index = freshIndex();
		const sessionDir = tempDir!.join("sessions");
		const untouchedPath = writeJsonl(sessionDir, "untouched.jsonl", [
			sessionHeader("sess-untouched"),
			messageEntry("m1", null, { role: "user", content: "keep-me-one" }),
			messageEntry("m2", "m1", {
				role: "assistant",
				content: [{ type: "text", text: "keep-me-two" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {},
				stopReason: "endTurn",
				timestamp: Date.parse("2026-07-25T12:00:02.000Z"),
			}),
		]);
		const touchedPath = writeJsonl(sessionDir, "touched.jsonl", [
			sessionHeader("sess-touched"),
			messageEntry("m1", null, { role: "user", content: "rewrite-me-old" }),
		]);

		expect(await index.reindex({ sessionDirs: [sessionDir] })).toEqual({ files: 2, indexedFiles: 2 });
		expect(tableCounts(dbPath)).toEqual({ chunks: 3, fts: 3 });

		// Change content + mtime so the skip check fails for only this file.
		writeJsonl(sessionDir, "touched.jsonl", [
			sessionHeader("sess-touched"),
			messageEntry("m1", null, { role: "user", content: "rewrite-me-new" }),
			messageEntry("m2", "m1", {
				role: "assistant",
				content: [{ type: "text", text: "rewrite-me-extra" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {},
				stopReason: "endTurn",
				timestamp: Date.parse("2026-07-25T12:00:02.000Z"),
			}),
		]);
		const later = new Date(Date.now() + 10_000);
		fs.utimesSync(touchedPath, later, later);
		// Ensure the untouched file's mtime/size still match the indexed row.
		const untouchedStat = fs.statSync(untouchedPath);
		fs.utimesSync(untouchedPath, new Date(untouchedStat.mtimeMs), new Date(untouchedStat.mtimeMs));

		expect(await index.reindex({ sessionDirs: [sessionDir] })).toEqual({ files: 2, indexedFiles: 1 });

		const counts = tableCounts(dbPath);
		expect(counts.chunks).toBe(4); // 2 untouched + 2 rewritten
		expect(counts.fts).toBe(counts.chunks);
		expect(index.search("rewrite-me-old")).toEqual([]);
		expect(index.search("rewrite-me-new")).toHaveLength(1);
		expect(index.search("rewrite-me-extra")).toHaveLength(1);
		expect(index.search("keep-me-one")).toHaveLength(1);
		expect(index.search("keep-me-two")).toHaveLength(1);

		const db = new Database(dbPath, { readonly: true });
		try {
			const touchedRows = db
				.prepare("SELECT content FROM chunks WHERE file_path = ? ORDER BY content")
				.all(touchedPath) as Array<{ content: string }>;
			expect(touchedRows.map(r => r.content)).toEqual(["rewrite-me-extra", "rewrite-me-new"]);
		} finally {
			db.close();
		}
	});

	it("search finds content past the first 4096 transcript bytes via FTS prefix and LIKE fallback", async () => {
		const index = freshIndex();
		const sessionDir = tempDir!.join("sessions");
		const needle = "Uniqueneedlezebra99";
		const padding = "P".repeat(4500);
		const filePath = writeJsonl(sessionDir, "deep.jsonl", [
			sessionHeader("sess-deep"),
			messageEntry("m-pad", null, { role: "user", content: padding }),
			messageEntry("m-needle", "m-pad", {
				role: "user",
				content: `prefix ${needle} suffix with precommit flavor`,
			}),
		]);

		const raw = fs.readFileSync(filePath, "utf8");
		expect(raw.indexOf(needle)).toBeGreaterThan(4096);

		expect(await index.reindex({ sessionDirs: [sessionDir] })).toEqual({ files: 1, indexedFiles: 1 });

		// FTS prefix path: full token matches `"Uniqueneedlezebra99"*`.
		const ftsHits = index.search(needle);
		expect(ftsHits).toHaveLength(1);
		expect(ftsHits[0]?.snippet).toContain(needle);
		expect(ftsHits[0]?.sessionId).toBe("sess-deep");

		// LIKE fallback: infix `eedleze` cannot match via FTS5 prefix-only `*`.
		const likeHits = index.search("eedleze");
		expect(likeHits).toHaveLength(1);
		expect(likeHits[0]?.snippet).toContain(needle);
	});

	it("skips a malformed jsonl without aborting; other files still index", async () => {
		const index = freshIndex();
		const sessionDir = tempDir!.join("sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(path.join(sessionDir, "broken.jsonl"), "this is not json\n{{{also-broken\n", "utf8");
		writeJsonl(sessionDir, "good.jsonl", [
			sessionHeader("sess-good"),
			messageEntry("m1", null, { role: "user", content: "malformed-sibling-ok" }),
		]);

		const result = await index.reindex({ sessionDirs: [sessionDir] });
		expect(result.files).toBe(2);
		expect(result.indexedFiles).toBe(1);
		expect(index.search("malformed-sibling-ok")).toHaveLength(1);
		expect(tableCounts(dbPath)).toEqual({ chunks: 1, fts: 1 });
	});

	it("tagsFor and sessionIdsByTag agree; cleared labels disappear (last-write-wins per targetId)", async () => {
		const index = freshIndex();
		const sessionDir = tempDir!.join("sessions");
		const filePath = writeJsonl(sessionDir, "tagged.jsonl", [
			sessionHeader("sess-tags"),
			messageEntry("m1", null, { role: "user", content: "tagged-session-body" }),
			{
				type: "label",
				id: "t1",
				parentId: "m1",
				timestamp: "2026-07-25T12:00:05.000Z",
				targetId: `${SESSION_TAG_PREFIX}alpha`,
				label: "alpha",
			},
			{
				type: "label",
				id: "t2",
				parentId: "t1",
				timestamp: "2026-07-25T12:00:06.000Z",
				targetId: `${SESSION_TAG_PREFIX}beta`,
				label: "beta",
			},
			{
				// Earlier write for gamma — should be overwritten by the empty clear below.
				type: "label",
				id: "t3",
				parentId: "t2",
				timestamp: "2026-07-25T12:00:07.000Z",
				targetId: `${SESSION_TAG_PREFIX}gamma`,
				label: "gamma",
			},
			{
				type: "label",
				id: "t4",
				parentId: "t3",
				timestamp: "2026-07-25T12:00:08.000Z",
				targetId: `${SESSION_TAG_PREFIX}gamma`,
				label: "",
			},
		]);

		expect(await index.reindex({ sessionDirs: [sessionDir] })).toEqual({ files: 1, indexedFiles: 1 });

		expect(index.tagsFor("sess-tags")).toEqual(["alpha", "beta"]);
		expect(index.sessionIdsByTag("alpha")).toEqual(["sess-tags"]);
		expect(index.sessionIdsByTag("beta")).toEqual(["sess-tags"]);
		expect(index.sessionIdsByTag("gamma")).toEqual([]);

		// Rewrite: clear alpha (empty label), keep beta — proves last-write-wins + reindex refresh.
		writeJsonl(sessionDir, "tagged.jsonl", [
			sessionHeader("sess-tags"),
			messageEntry("m1", null, { role: "user", content: "tagged-session-body" }),
			{
				type: "label",
				id: "t1",
				parentId: "m1",
				timestamp: "2026-07-25T12:00:05.000Z",
				targetId: `${SESSION_TAG_PREFIX}alpha`,
				label: "alpha",
			},
			{
				type: "label",
				id: "t2",
				parentId: "t1",
				timestamp: "2026-07-25T12:00:06.000Z",
				targetId: `${SESSION_TAG_PREFIX}beta`,
				label: "beta",
			},
			{
				type: "label",
				id: "t5",
				parentId: "t2",
				timestamp: "2026-07-25T12:00:09.000Z",
				targetId: `${SESSION_TAG_PREFIX}alpha`,
				label: "",
			},
		]);
		const later = new Date(Date.now() + 10_000);
		fs.utimesSync(filePath, later, later);

		expect(await index.reindex({ sessionDirs: [sessionDir] })).toEqual({ files: 1, indexedFiles: 1 });
		expect(index.tagsFor("sess-tags")).toEqual(["beta"]);
		expect(index.sessionIdsByTag("alpha")).toEqual([]);
		expect(index.sessionIdsByTag("beta")).toEqual(["sess-tags"]);
	});

	it("purges chunks and tags for deleted session files", async () => {
		const index = freshIndex();
		const sessionDir = tempDir!.join("sessions");
		const filePath = writeJsonl(sessionDir, "deleted.jsonl", [
			sessionHeader("sess-deleted"),
			messageEntry("m1", null, { role: "user", content: "purge-me-token" }),
		]);
		expect(await index.reindex({ sessionDirs: [sessionDir] })).toEqual({ files: 1, indexedFiles: 1 });
		expect(index.search("purge-me-token")).toHaveLength(1);
		fs.unlinkSync(filePath);
		expect(await index.reindex({ sessionDirs: [sessionDir] })).toEqual({ files: 0, indexedFiles: 0 });
		expect(index.search("purge-me-token")).toEqual([]);
		expect(tableCounts(dbPath)).toEqual({ chunks: 0, fts: 0 });
	});

	it("encloses scoped searches and session ranking to the requested directory", async () => {
		const index = freshIndex();
		const firstDir = tempDir!.join("first");
		const secondDir = tempDir!.join("second");
		writeJsonl(firstDir, "first.jsonl", [
			sessionHeader("sess-first"),
			messageEntry("m1", null, { role: "user", content: "shared-scope-token" }),
		]);
		writeJsonl(secondDir, "second.jsonl", [
			sessionHeader("sess-second"),
			messageEntry("m1", null, { role: "user", content: "shared-scope-token" }),
		]);
		await index.reindex({ sessionDirs: [firstDir, secondDir] });
		expect(index.search("shared-scope-token", { sessionDir: firstDir }).map(hit => hit.sessionId)).toEqual([
			"sess-first",
		]);
		expect(index.matchingSessionIds("shared-scope-token", { sessionDir: secondDir })).toEqual(["sess-second"]);
	});

	it("indexes bash and Python execution source and output", async () => {
		const index = freshIndex();
		const sessionDir = tempDir!.join("sessions");
		writeJsonl(sessionDir, "execution.jsonl", [
			sessionHeader("sess-execution"),
			messageEntry("bash", null, {
				role: "bashExecution",
				command: "bash-command-token",
				output: "bash-output-token",
			}),
			messageEntry("python", "bash", {
				role: "pythonExecution",
				code: "python-code-token",
				output: "python-output-token",
			}),
		]);
		await index.reindex({ sessionDirs: [sessionDir] });
		expect(index.search("bash-command-token")[0]?.kind).toBe("tool_use");
		expect(index.search("bash-output-token")[0]?.kind).toBe("tool_result");
		expect(index.search("python-code-token")[0]?.kind).toBe("tool_use");
		expect(index.search("python-output-token")[0]?.kind).toBe("tool_result");
	});

	it("deduplicates session ids before applying the ranking limit", async () => {
		const index = freshIndex();
		const sessionDir = tempDir!.join("sessions");
		writeJsonl(sessionDir, "chatty.jsonl", [
			sessionHeader("sess-chatty"),
			...Array.from({ length: 5 }, (_, i) =>
				messageEntry(`m${i}`, null, { role: "user", content: "rank-limit-token" }),
			),
		]);
		writeJsonl(sessionDir, "other.jsonl", [
			sessionHeader("sess-other"),
			messageEntry("m1", null, { role: "user", content: "rank-limit-token" }),
		]);
		await index.reindex({ sessionDirs: [sessionDir] });
		expect(index.matchingSessionIds("rank-limit-token", { limit: 2 })).toEqual(
			expect.arrayContaining(["sess-other", "sess-chatty"]),
		);
	});
});
