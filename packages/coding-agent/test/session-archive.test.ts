import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { cleanupRowsForArchivedSessions } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import {
	archiveDestinationExists,
	archiveSessionFile,
	getArchivedSessionsDir,
	resolveArchiveRoots,
	sessionHasLiveNestedSessions,
} from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { getHistoryDbPath, getSessionsDir } from "@oh-my-pi/pi-utils";

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-archive-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function sessionText(id: string, status: "complete" | "pending"): string {
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
	];
	if (status === "complete") {
		lines.push(JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }));
	} else {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: "waiting" } }));
	}
	return `${lines.join("\n")}\n`;
}

async function writeSession(project: string, id: string, status: "complete" | "pending"): Promise<string> {
	const file = path.join(getSessionsDir(root), project, `${id}.jsonl`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, sessionText(id, status));
	return file;
}

describe("archiveSessionFile", () => {
	test("gzips the session and moves artifacts into the archive tree", async () => {
		const session = await writeSession("project", "done", "complete");
		const artifacts = session.slice(0, -".jsonl".length);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(path.join(artifacts, "0.bash.log"), "artifact");

		const destination = await archiveSessionFile(session, getSessionsDir(root), getArchivedSessionsDir(root));

		expect(destination).toBe(path.join(root, "archive", "sessions", "project", "done.jsonl.gz"));
		expect(await Bun.file(session).exists()).toBe(false);
		expect(await Bun.file(path.join(artifacts, "0.bash.log")).exists()).toBe(false);
		expect(await Bun.file(destination).exists()).toBe(true);
		expect(new TextDecoder().decode(gunzipSync(await Bun.file(destination).bytes()))).toContain('"done"');
		expect(await Bun.file(path.join(destination.slice(0, -".jsonl.gz".length), "0.bash.log")).exists()).toBe(true);
	});

	test("refuses a path outside the sessions directory", async () => {
		const outside = path.join(root, "other", "done.jsonl");
		await fs.mkdir(path.dirname(outside), { recursive: true });
		await Bun.write(outside, sessionText("done", "complete"));

		await expect(archiveSessionFile(outside, getSessionsDir(root), getArchivedSessionsDir(root))).rejects.toThrow(
			"outside the sessions directory",
		);
		expect(await Bun.file(outside).exists()).toBe(true);
	});

	test("leaves the source in place when the archive destination already exists", async () => {
		const session = await writeSession("project", "done", "complete");
		const destination = path.join(getArchivedSessionsDir(root), "project", "done.jsonl.gz");
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await Bun.write(destination, "already-there");

		await expect(archiveSessionFile(session, getSessionsDir(root), getArchivedSessionsDir(root))).rejects.toThrow(
			"archive destination exists",
		);
		expect(await Bun.file(session).exists()).toBe(true);
		expect(await Bun.file(destination).text()).toBe("already-there");
	});
});

describe("resolveArchiveRoots", () => {
	test("keeps the default profile archive layout", () => {
		const sessionFile = path.join(getSessionsDir(root), "project", "abc.jsonl");
		const sessionDir = path.dirname(sessionFile);

		expect(
			resolveArchiveRoots({
				sessionFile,
				sessionDir,
				cwd: "/unrelated",
				agentDir: root,
			}),
		).toEqual({
			sessionsRoot: getSessionsDir(root),
			archiveRoot: getArchivedSessionsDir(root),
			destinationPath: path.join(getArchivedSessionsDir(root), "project", "abc.jsonl.gz"),
		});
	});

	test("archives beside a custom session directory", () => {
		const sessionDir = path.join(root, "custom-sessions");
		const sessionFile = path.join(sessionDir, "abc.jsonl");

		expect(
			resolveArchiveRoots({
				sessionFile,
				sessionDir,
				cwd: "/tmp/project",
				agentDir: root,
			}),
		).toEqual({
			sessionsRoot: sessionDir,
			archiveRoot: path.join(sessionDir, "archive"),
			destinationPath: path.join(sessionDir, "archive", "abc.jsonl.gz"),
		});
	});

	test("preserves cwd-key layout under a custom sessions root", () => {
		const sessionsRoot = path.join(root, "alt", "sessions");
		const sessionDir = path.join(sessionsRoot, "project");
		const sessionFile = path.join(sessionDir, "abc.jsonl");

		expect(
			resolveArchiveRoots({
				sessionFile,
				sessionDir,
				cwd: "/tmp/project",
				agentDir: root,
			}),
		).toEqual({
			sessionsRoot,
			archiveRoot: path.join(root, "alt", "archive", "sessions"),
			destinationPath: path.join(root, "alt", "archive", "sessions", "project", "abc.jsonl.gz"),
		});
	});

	test("returns null when the session file is not under the session directory", () => {
		expect(
			resolveArchiveRoots({
				sessionFile: path.join(root, "other", "abc.jsonl"),
				sessionDir: path.join(getSessionsDir(root), "project"),
				cwd: "/tmp",
				agentDir: root,
			}),
		).toBeNull();
	});
});

describe("archiveDestinationExists", () => {
	test("detects a gzip or legacy uncompressed destination", async () => {
		const source = path.join(root, "sessions", "done.jsonl");
		const destination = path.join(root, "archive", "done.jsonl.gz");
		expect(await archiveDestinationExists(source, destination)).toBe(false);

		await fs.mkdir(path.dirname(destination), { recursive: true });
		await Bun.write(destination, "gz");
		expect(await archiveDestinationExists(source, destination)).toBe(true);

		await fs.unlink(destination);
		await Bun.write(destination.slice(0, -".gz".length), "plain");
		expect(await archiveDestinationExists(source, destination)).toBe(true);
	});

	test("detects a leftover destination artifact directory when the source has artifacts", async () => {
		const source = path.join(root, "sessions", "done.jsonl");
		const destination = path.join(root, "archive", "done.jsonl.gz");
		await fs.mkdir(source.slice(0, -".jsonl".length), { recursive: true });
		await fs.mkdir(destination.slice(0, -".jsonl.gz".length), { recursive: true });

		expect(await archiveDestinationExists(source, destination)).toBe(true);

		await fs.rm(source.slice(0, -".jsonl".length), { recursive: true });
		expect(await archiveDestinationExists(source, destination)).toBe(false);
	});
});

describe("cleanupRowsForArchivedSessions", () => {
	test("removes history and stats rows after a session is archived", async () => {
		const session = await writeSession("project", "archive-me", "complete");
		const historyPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(historyPath), { recursive: true });
		const history = new Database(historyPath);
		history.run("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, session_id TEXT)");
		history.run("INSERT INTO history (prompt, session_id) VALUES ('old prompt', 'archive-me')");
		history.run("INSERT INTO history (prompt, session_id) VALUES ('keep', 'keep-me')");
		history.close();

		const statsPath = path.join(root, "stats.db");
		const stats = new Database(statsPath);
		for (const table of ["messages", "user_messages", "tool_calls", "file_offsets"] as const) {
			stats.run(`CREATE TABLE ${table} (session_file TEXT NOT NULL)`);
			stats.run(`INSERT INTO ${table} (session_file) VALUES (?)`, [session]);
			stats.run(`INSERT INTO ${table} (session_file) VALUES (?)`, [
				path.join(getSessionsDir(root), "project", "keep.jsonl"),
			]);
		}
		stats.close();

		const destination = await archiveSessionFile(session, getSessionsDir(root), getArchivedSessionsDir(root));
		const cleanup = await cleanupRowsForArchivedSessions(root, getArchivedSessionsDir(root), [
			{ id: "archive-me", path: session },
		]);

		expect(destination).toBe(path.join(getArchivedSessionsDir(root), "project", "archive-me.jsonl.gz"));
		expect(cleanup.errors).toEqual([]);
		expect(cleanup.historyRowsDeleted).toBe(1);
		expect(cleanup.statsRowsDeleted).toBe(4);

		const historyCheck = new Database(historyPath);
		expect(
			(
				historyCheck.prepare("SELECT session_id FROM history ORDER BY id").all() as Array<{ session_id: string }>
			).map(row => row.session_id),
		).toEqual(["keep-me"]);
		historyCheck.close();
	});

	test("transfers shared stats to a retained fork in a custom session directory", async () => {
		const sessionDir = path.join(root, "custom-sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const timestamp = "2026-06-26T12:00:00.000Z";
		const timestampMs = Date.parse(timestamp);
		const parent = path.join(sessionDir, "parent.jsonl");
		const child = path.join(sessionDir, "child.jsonl");
		const sharedUser = {
			type: "message",
			id: "shared-user",
			parentId: null,
			timestamp,
			message: { role: "user", content: "shared" },
		};
		const sharedAssistant = {
			type: "message",
			id: "shared-assistant",
			parentId: "shared-user",
			timestamp,
			message: { role: "assistant", content: [] },
		};
		await Bun.write(
			parent,
			[
				JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp, cwd: "/tmp" }),
				JSON.stringify(sharedUser),
				JSON.stringify(sharedAssistant),
				"",
			].join("\n"),
		);
		await Bun.write(
			child,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp,
					cwd: "/tmp",
					parentSession: parent,
				}),
				JSON.stringify(sharedUser),
				JSON.stringify(sharedAssistant),
				"",
			].join("\n"),
		);

		const statsPath = path.join(root, "stats.db");
		const db = new Database(statsPath);
		db.run(
			"CREATE TABLE messages (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(session_file, entry_id))",
		);
		db.run(
			"CREATE TABLE user_messages (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(session_file, entry_id))",
		);
		db.run(
			"CREATE TABLE tool_calls (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, timestamp INTEGER NOT NULL, tool_call_id TEXT NOT NULL, UNIQUE(session_file, tool_call_id))",
		);
		db.run(
			"CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER NOT NULL, last_modified INTEGER NOT NULL)",
		);
		db.prepare("INSERT INTO messages (session_file, entry_id, timestamp) VALUES (?, ?, ?)").run(
			parent,
			"shared-assistant",
			timestampMs,
		);
		db.prepare("INSERT INTO user_messages (session_file, entry_id, timestamp) VALUES (?, ?, ?)").run(
			parent,
			"shared-user",
			timestampMs,
		);
		db.prepare("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(parent, 1, 1);
		const childStat = await fs.stat(child);
		db.prepare("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(
			child,
			childStat.size,
			childStat.mtimeMs,
		);
		db.close();

		const archiveRoot = path.join(sessionDir, "archive");
		await archiveSessionFile(parent, sessionDir, archiveRoot);
		const cleanup = await cleanupRowsForArchivedSessions(
			root,
			archiveRoot,
			[{ id: "parent-session", path: parent }],
			sessionDir,
		);

		expect(cleanup.errors).toEqual([]);
		const check = new Database(statsPath);
		expect(check.prepare("SELECT session_file, entry_id FROM messages").all()).toEqual([
			{ session_file: child, entry_id: "shared-assistant" },
		]);
		expect(check.prepare("SELECT session_file, entry_id FROM user_messages").all()).toEqual([
			{ session_file: child, entry_id: "shared-user" },
		]);
		check.close();
	});
});

describe("sessionHasLiveNestedSessions", () => {
	test("reports pending nested sessions and ignores completed ones", async () => {
		const parent = await writeSession("project", "parent", "complete");
		const artifacts = parent.slice(0, -".jsonl".length);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(path.join(artifacts, "child.jsonl"), sessionText("child", "pending"));

		expect(await sessionHasLiveNestedSessions(parent)).toBe(true);

		await Bun.write(path.join(artifacts, "child.jsonl"), sessionText("child", "complete"));
		expect(await sessionHasLiveNestedSessions(parent)).toBe(false);
	});

	test("treats a recently modified completed nested session as live when a cutoff is set", async () => {
		const parent = await writeSession("project", "parent", "complete");
		const artifacts = parent.slice(0, -".jsonl".length);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(path.join(artifacts, "child.jsonl"), sessionText("child", "complete"));

		expect(await sessionHasLiveNestedSessions(parent, { recentlyModifiedAfterMs: Date.now() - 60_000 })).toBe(true);
		expect(await sessionHasLiveNestedSessions(parent, { recentlyModifiedAfterMs: Date.now() + 60_000 })).toBe(false);
	});
});
