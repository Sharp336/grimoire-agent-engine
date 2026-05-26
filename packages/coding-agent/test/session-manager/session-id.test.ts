import { describe, expect, it, setSystemTime } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function expectUuidV7SessionId(session: SessionManager): string {
	const sessionId = session.getSessionId();
	expect(sessionId).toMatch(UUID_V7_RE);
	const header = session.getHeader();
	if (!header) throw new Error("Expected session header");
	expect(header.id).toBe(sessionId);
	return sessionId;
}

function withTimezoneOffset(minutesWestOfUtc: number, callback: () => void): void {
	const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
	Date.prototype.getTimezoneOffset = function getTimezoneOffset(): number {
		return minutesWestOfUtc;
	};
	try {
		callback();
	} finally {
		Date.prototype.getTimezoneOffset = originalGetTimezoneOffset;
	}
}

describe("SessionManager session ids", () => {
	it("generates UUIDv7 ids for new in-memory sessions", () => {
		const session = SessionManager.inMemory();

		expectUuidV7SessionId(session);
	});

	it("generates a fresh UUIDv7 when starting a new session", async () => {
		const session = SessionManager.inMemory();
		const firstId = expectUuidV7SessionId(session);

		await session.newSession();

		const secondId = expectUuidV7SessionId(session);
		expect(secondId).not.toBe(firstId);
	});

	it("generates a UUIDv7 when branching a session", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const branchPointId = session.appendMessage({ role: "user", content: "follow up", timestamp: 2 });
		const firstId = expectUuidV7SessionId(session);

		session.createBranchedSession(branchPointId);

		const branchedId = expectUuidV7SessionId(session);
		expect(branchedId).not.toBe(firstId);
	});

	it("generates a UUIDv7 when forking a persisted session", async () => {
		using tempDir = TempDir.createSync("@pi-session-id-fork-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();
		const firstId = expectUuidV7SessionId(session);

		const forkResult = await session.fork();
		if (!forkResult) throw new Error("Expected fork result");

		const forkedId = expectUuidV7SessionId(session);
		expect(forkedId).not.toBe(firstId);
		expect(session.getHeader()?.parentSession).toBe(firstId);
	});

	it("uses local timezone in persisted session filenames while keeping UTC header timestamps", () => {
		setSystemTime(new Date("2025-01-15T18:07:08.009Z"));
		try {
			withTimezoneOffset(-330, () => {
				using tempDir = TempDir.createSync("@pi-session-id-local-time-");
				const session = SessionManager.create(tempDir.path(), tempDir.path());
				const sessionFile = session.getSessionFile();
				if (!sessionFile) throw new Error("Expected persisted session file");

				expect(path.basename(sessionFile)).toMatch(
					/^2025-01-15T23-37-08-009\+05-30_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/,
				);
				expect(session.getHeader()?.timestamp).toBe("2025-01-15T18:07:08.009Z");
			});
		} finally {
			setSystemTime();
		}
	});

	it("uses local timezone offsets west of UTC in persisted session filenames", () => {
		setSystemTime(new Date("2025-01-15T18:07:08.009Z"));
		try {
			withTimezoneOffset(480, () => {
				using tempDir = TempDir.createSync("@pi-session-id-local-time-west-");
				const session = SessionManager.create(tempDir.path(), tempDir.path());
				const sessionFile = session.getSessionFile();
				if (!sessionFile) throw new Error("Expected persisted session file");

				expect(path.basename(sessionFile)).toMatch(
					/^2025-01-15T10-07-08-009-08-00_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/,
				);
				expect(session.getHeader()?.timestamp).toBe("2025-01-15T18:07:08.009Z");
			});
		} finally {
			setSystemTime();
		}
	});

	it("preserves existing session ids when reopening a saved session", async () => {
		using tempDir = TempDir.createSync("@pi-session-id-open-");
		const sessionFile = path.join(tempDir.path(), "existing.jsonl");
		const existingId = "existing-session-id";
		await Bun.write(
			sessionFile,
			`${JSON.stringify({ type: "session", id: existingId, timestamp: new Date().toISOString(), cwd: tempDir.path() })}\n`,
		);

		const session = await SessionManager.open(sessionFile, tempDir.path());

		expect(session.getSessionId()).toBe(existingId);
		expect(session.getHeader()?.id).toBe(existingId);
	});
});
