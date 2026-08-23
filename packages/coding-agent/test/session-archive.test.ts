import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import {
	archiveSessionFile,
	getArchivedSessionsDir,
	sessionHasLiveNestedSessions,
} from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { getSessionsDir } from "@oh-my-pi/pi-utils";

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
