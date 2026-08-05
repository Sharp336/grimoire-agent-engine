import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	findMostRecentProjectSession,
	resolveResumableSession,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, getSessionsDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

function hashedSessionDir(sessionsRoot: string, cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	const digest = Bun.SHA256.hash(resolvedCwd.replaceAll("\\", "/"), "hex");
	return path.join(sessionsRoot, `tmp-${path.basename(resolvedCwd)}-${digest}`);
}

function legacySessionDir(sessionsRoot: string, cwd: string): string {
	const relative = path.relative(os.tmpdir(), path.resolve(cwd)).replace(/[/\\:]/g, "-");
	return path.join(sessionsRoot, `-tmp-${relative}`);
}

function writeSession(
	file: string,
	sessionId: string,
	cwd: string,
	entryIds: readonly string[],
	options: { title?: string; contentById?: Readonly<Record<string, string>> } = {},
): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const entries = [
		{
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
			...(options.title ? { title: options.title } : {}),
		},
		...entryIds.map((id, index) => ({
			type: "message",
			id,
			parentId: index === 0 ? null : entryIds[index - 1],
			timestamp: `2026-01-01T00:00:0${index + 1}.000Z`,
			message: { role: "user", content: options.contentById?.[id] ?? id, timestamp: index + 1 },
		})),
	];
	fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

describe("session candidate resolution", () => {
	let agentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-candidates-"));
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-candidate-cwd-"));
		setAgentDir(agentDir);
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(agentDir);
		removeSyncWithRetries(cwd);
	});

	test("selects the legacy candidate when it strictly dominates the hashed copy", async () => {
		const sessionsRoot = getSessionsDir();
		const sessionId = "019fcandidate-dominates";
		const fileName = `${sessionId}.jsonl`;
		const hashedFile = path.join(hashedSessionDir(sessionsRoot, cwd), fileName);
		const legacyFile = path.join(legacySessionDir(sessionsRoot, cwd), fileName);
		writeSession(hashedFile, sessionId, cwd, ["entry-1"]);
		writeSession(legacyFile, sessionId, cwd, ["entry-1", "entry-2"]);

		const sessions = await SessionManager.list(cwd);
		expect(sessions.map(session => session.path)).toEqual([legacyFile]);
		expect((await resolveResumableSession(sessionId, cwd))?.session.path).toBe(legacyFile);
		expect(
			(await SessionManager.listAll()).filter(session => session.id === sessionId).map(session => session.path),
		).toEqual([legacyFile]);
	});

	test("selects the hashed candidate when it strictly dominates the legacy copy", async () => {
		const sessionsRoot = getSessionsDir();
		const sessionId = "019fcandidate-hashed-dominates";
		const fileName = `${sessionId}.jsonl`;
		const hashedFile = path.join(hashedSessionDir(sessionsRoot, cwd), fileName);
		const legacyFile = path.join(legacySessionDir(sessionsRoot, cwd), fileName);
		writeSession(hashedFile, sessionId, cwd, ["entry-1", "entry-2"]);
		writeSession(legacyFile, sessionId, cwd, ["entry-1"]);

		expect((await SessionManager.list(cwd)).map(session => session.path)).toEqual([hashedFile]);
	});

	test("treats title-only differences as equivalent and prefers hashed storage", async () => {
		const sessionsRoot = getSessionsDir();
		const sessionId = "019fcandidate-title-only";
		const fileName = `${sessionId}.jsonl`;
		const hashedFile = path.join(hashedSessionDir(sessionsRoot, cwd), fileName);
		const legacyFile = path.join(legacySessionDir(sessionsRoot, cwd), fileName);
		writeSession(hashedFile, sessionId, cwd, ["entry-1"], { title: "New title" });
		writeSession(legacyFile, sessionId, cwd, ["entry-1"], { title: "Old title" });

		expect((await SessionManager.list(cwd)).map(session => session.path)).toEqual([hashedFile]);
	});

	test("keeps projects with colliding legacy bucket names isolated", async () => {
		const sessionsRoot = getSessionsDir();
		const firstCwd = path.join(cwd, "project", "hail-mary");
		const secondCwd = path.join(cwd, "project-hail", "mary");
		fs.mkdirSync(firstCwd, { recursive: true });
		fs.mkdirSync(secondCwd, { recursive: true });
		const sharedLegacyDir = legacySessionDir(sessionsRoot, firstCwd);
		expect(sharedLegacyDir).toBe(legacySessionDir(sessionsRoot, secondCwd));
		const firstFile = path.join(sharedLegacyDir, "first.jsonl");
		const secondFile = path.join(sharedLegacyDir, "second.jsonl");
		writeSession(firstFile, "first-session", firstCwd, ["first-entry"]);
		writeSession(secondFile, "second-session", secondCwd, ["second-entry"]);

		expect((await SessionManager.list(firstCwd)).map(session => session.path)).toEqual([firstFile]);
		expect((await SessionManager.list(secondCwd)).map(session => session.path)).toEqual([secondFile]);
		expect(hashedSessionDir(sessionsRoot, firstCwd)).not.toBe(hashedSessionDir(sessionsRoot, secondCwd));
	});

	test("keeps divergent candidates visible and refuses to choose one implicitly", async () => {
		const sessionsRoot = getSessionsDir();
		const sessionId = "019fcandidate-diverged";
		const fileName = `${sessionId}.jsonl`;
		const hashedFile = path.join(hashedSessionDir(sessionsRoot, cwd), fileName);
		const legacyFile = path.join(legacySessionDir(sessionsRoot, cwd), fileName);
		writeSession(hashedFile, sessionId, cwd, ["entry-1", "entry-2"], {
			contentById: { "entry-2": "hashed content" },
		});
		writeSession(legacyFile, sessionId, cwd, ["entry-1", "entry-2"], {
			contentById: { "entry-2": "legacy content" },
		});

		const sessions = await SessionManager.list(cwd);
		expect(sessions).toHaveLength(2);
		expect(sessions.map(session => session.candidateLocation).sort()).toEqual(["hashed", "legacy"]);
		expect(sessions.every(session => session.candidateConflict === true)).toBe(true);
		await expect(resolveResumableSession(sessionId, cwd)).rejects.toThrow(
			`Session "${sessionId}" has divergent candidates at ${hashedFile} and ${legacyFile}`,
		);
		await expect(findMostRecentProjectSession(cwd, undefined)).rejects.toThrow(
			`Session "${sessionId}" has divergent candidates at ${hashedFile} and ${legacyFile}`,
		);
		expect((await resolveResumableSession(hashedFile, cwd))?.session.path).toBe(hashedFile);
	});
});
