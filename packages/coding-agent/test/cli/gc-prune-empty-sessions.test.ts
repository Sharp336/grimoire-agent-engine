import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { holdFileOpen } from "../helpers/open-file-holder";
import { assistantMsg, userMsg } from "../utilities";

/** A mid-turn reply: the model asked for a tool and stopped. */
function toolCallMsg(text: string, toolName = "bash") {
	const base = assistantMsg(text);
	return {
		...base,
		content: [...base.content, { type: "toolCall" as const, id: `call-${text}`, name: toolName, arguments: {} }],
		stopReason: "toolUse" as const,
	};
}

const OLD_DATE = new Date("2026-01-01T00:00:00.000Z");

let root: string;
let stdoutSpy: { mockRestore(): void } | undefined;
let stdout = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gc-empty-"));
	stdout = "";
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout += String(chunk);
		return true;
	});
});

afterEach(async () => {
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	await fs.rm(root, { recursive: true, force: true });
});

function sessionHeader(id: string): SessionHeader {
	return { type: "session", version: 3, id, timestamp: "2026-08-14T00:00:00.000Z", cwd: "/tmp/gc-empty" };
}

async function writeSession(
	agentDir: string,
	id: string,
	build: (session: SessionManager) => void,
	mtime: Date = OLD_DATE,
): Promise<string> {
	const session = SessionManager.inMemory();
	build(session);
	const directory = path.join(getSessionsDir(agentDir), "-tmp-gc-empty");
	const file = path.join(directory, `2026-08-14T00-00-00-000Z_${id}.jsonl`);
	await fs.mkdir(directory, { recursive: true });
	await Bun.write(
		file,
		`${[sessionHeader(id), ...session.getEntries()].map(entry => JSON.stringify(entry)).join("\n")}\n`,
	);
	await fs.utimes(file, mtime, mtime);
	return file;
}

function artifactsPath(sessionFile: string): string {
	return sessionFile.slice(0, -".jsonl".length);
}

function archivedPath(agentDir: string, sessionFile: string): string {
	const sessionsRoot = getSessionsDir(agentDir);
	return path.join(path.dirname(sessionsRoot), "archive", "sessions", path.relative(sessionsRoot, sessionFile));
}

describe("omp gc empty-session pruning", () => {
	test("dry-run reports a user-only session without changing disk", async () => {
		const agentDir = path.join(root, "agent");
		const file = await writeSession(agentDir, "user-only", session => {
			session.appendMessage(userMsg("hello?"));
		});
		const before = await Bun.file(file).text();
		const bytes = (await fs.stat(file)).size;

		const result = await runGcCommand({ flags: { agentDir, pruneEmptySessions: "archive" } });

		expect(result.pruneEmptySessions).toMatchObject({
			scanned: 1,
			empty: 1,
			wouldPrune: 1,
			archived: 0,
			deleted: 0,
		});
		expect(result.pruneEmptySessions?.candidates).toEqual([
			{
				path: file,
				sessionId: "user-only",
				userMessages: 1,
				assistantMessages: 0,
				assistantTextChars: 0,
				unfinishedAttempts: 0,
				bytes,
			},
		]);
		expect(await Bun.file(file).text()).toBe(before);
		expect(stdout.split("\n")[1]).toBe(
			"empty sessions: would archive 1 of 1 empty session (0 assistant text characters)",
		);
	});

	test("archive apply moves the session and its artifacts together", async () => {
		const agentDir = path.join(root, "agent");
		const file = await writeSession(agentDir, "archive-me", session => {
			session.appendMessage(userMsg("hello?"));
		});
		const artifact = path.join(artifactsPath(file), "attachments", "question.txt");
		await fs.mkdir(path.dirname(artifact), { recursive: true });
		await Bun.write(artifact, "question artifact");

		const result = await runGcCommand({ flags: { agentDir, pruneEmptySessions: "archive", apply: true } });

		const archived = archivedPath(agentDir, file);
		expect(result.pruneEmptySessions?.archived).toBe(1);
		expect(await Bun.file(file).exists()).toBe(false);
		expect(await Bun.file(archived).exists()).toBe(true);
		expect(await Bun.file(path.join(artifactsPath(archived), "attachments", "question.txt")).text()).toBe(
			"question artifact",
		);
		expect(await Bun.file(artifact).exists()).toBe(false);
		expect(stdout.split("\n")[1]).toBe("empty sessions: archived 1 of 1 empty session (0 assistant text characters)");
	});

	test("delete apply unlinks the session and its artifacts", async () => {
		const agentDir = path.join(root, "agent");
		const file = await writeSession(agentDir, "delete-me", session => {
			session.appendMessage(userMsg("hello?"));
		});
		const artifact = path.join(artifactsPath(file), "attachments", "question.txt");
		await fs.mkdir(path.dirname(artifact), { recursive: true });
		await Bun.write(artifact, "question artifact");

		const result = await runGcCommand({ flags: { agentDir, pruneEmptySessions: "delete", apply: true } });

		expect(result.pruneEmptySessions?.deleted).toBe(1);
		expect(await Bun.file(file).exists()).toBe(false);
		expect(await Bun.file(artifactsPath(file)).exists()).toBe(false);
		expect(stdout.split("\n")[1]).toBe("empty sessions: deleted 1 of 1 empty session (0 assistant text characters)");
	});

	test("a real assistant reply is never a candidate", async () => {
		const agentDir = path.join(root, "agent");
		const file = await writeSession(agentDir, "answered", session => {
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
		});

		const result = await runGcCommand({ flags: { agentDir, pruneEmptySessions: "delete", apply: true } });

		expect(result.pruneEmptySessions?.empty).toBe(0);
		expect(result.pruneEmptySessions?.candidates).toEqual([]);
		expect(await Bun.file(file).exists()).toBe(true);
	});

	test("text-bearing tool calls are kept while pure tool-call traffic is a candidate", async () => {
		const agentDir = path.join(root, "agent");
		const textFile = await writeSession(agentDir, "tool-use-with-text", session => {
			session.appendMessage(userMsg("run it"));
			session.appendMessage(toolCallMsg("running"));
		});
		const pureFile = await writeSession(agentDir, "pure-tool-use", session => {
			session.appendMessage(userMsg("run it"));
			session.appendMessage(toolCallMsg(""));
		});

		const result = await runGcCommand({ flags: { agentDir, pruneEmptySessions: "archive" } });

		expect(result.pruneEmptySessions?.scanned).toBe(2);
		expect(result.pruneEmptySessions?.empty).toBe(1);
		expect(result.pruneEmptySessions?.candidates).toEqual([
			expect.objectContaining({
				path: pureFile,
				sessionId: "pure-tool-use",
				userMessages: 1,
				assistantMessages: 1,
				assistantTextChars: 0,
				unfinishedAttempts: 1,
			}),
		]);
		expect(await Bun.file(textFile).exists()).toBe(true);
	});

	test("prunes a fresh session when no process holds it", async () => {
		const agentDir = path.join(root, "agent");
		const now = new Date();
		const file = await writeSession(
			agentDir,
			"fresh",
			session => {
				session.appendMessage(userMsg("hello?"));
			},
			now,
		);

		const result = await runGcCommand({ flags: { agentDir, pruneEmptySessions: "delete", apply: true } });

		expect(result.pruneEmptySessions?.skippedActive).toBe(0);
		expect(result.pruneEmptySessions?.skipped).toEqual([]);
		expect(result.pruneEmptySessions?.deleted).toBe(1);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	test("backup, broken, compressed, and nested subagent files are ignored", async () => {
		const agentDir = path.join(root, "agent");
		const file = await writeSession(agentDir, "top-level", session => {
			session.appendMessage(assistantMsg("answered"));
		});
		const content = await Bun.file(file).text();
		await Bun.write(`${file}.bak`, content);
		await Bun.write(file.replace(/\.jsonl$/, ".broken.jsonl"), content);
		await Bun.write(`${file}.gz`, content);
		const nested = path.join(artifactsPath(file), "subagents", "nested.jsonl");
		await Bun.write(nested, content);
		await fs.utimes(nested, OLD_DATE, OLD_DATE);

		const result = await runGcCommand({ flags: { agentDir, pruneEmptySessions: "archive" } });

		expect(result.pruneEmptySessions?.scanned).toBe(1);
		expect(result.pruneEmptySessions?.empty).toBe(0);
		expect(result.pruneEmptySessions?.candidates).toEqual([]);
	});

	test("skips and names a session held open by another process", async () => {
		const agentDir = path.join(root, "agent");
		const file = await writeSession(agentDir, "live", session => {
			session.appendMessage(userMsg("hello?"));
		});
		const holder = await holdFileOpen(file);
		try {
			const result = await runGcCommand({ flags: { agentDir, pruneEmptySessions: "delete", apply: true } });

			expect(result.pruneEmptySessions?.skippedActive).toBe(1);
			expect(result.pruneEmptySessions?.candidates).toEqual([]);
			expect(result.pruneEmptySessions?.skipped[0]?.signals).toContain("open-handle");
			expect(result.pruneEmptySessions?.skipped[0]?.holders.some(value => value.pid === holder.pid)).toBe(true);
			expect(await Bun.file(file).exists()).toBe(true);
			expect(stdout).toContain(`empty sessions skipped: ${file} held open by pid ${holder.pid} (`);
		} finally {
			await holder.close();
		}
	});
});
