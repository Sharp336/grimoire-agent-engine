import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectSessionLock, lockPathForSession, SessionLockError } from "../../src/session/session-lock";
import { SessionManager } from "../../src/session/session-manager";

describe("SessionManager persistent lock integration", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function fixture(): { cwd: string; sessions: string } {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-manager-lock-"));
		dirs.push(dir);
		const cwd = path.join(dir, "cwd");
		fs.mkdirSync(cwd);
		return { cwd, sessions: path.join(dir, "sessions") };
	}

	it("blocks a second writer until the first manager closes", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");

		expect(inspectSessionLock(sessionFile).status).toBe("live");
		await expect(SessionManager.open(sessionFile)).rejects.toBeInstanceOf(SessionLockError);

		await manager.close();
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(false);

		const reopened = await SessionManager.open(sessionFile);
		await reopened.close();
	});

	it("keeps a shared lock while a detached session clone can still persist", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");

		const detached = manager.cloneCurrentSession();
		await manager.newSession();
		expect(inspectSessionLock(sessionFile).status).toBe("live");
		await expect(SessionManager.open(sessionFile)).rejects.toBeInstanceOf(SessionLockError);

		await detached.close();
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(false);
		await manager.close();
	});

	it("moves ownership to the relocated session path", async () => {
		const { cwd, sessions } = fixture();
		const targetCwd = path.join(path.dirname(cwd), "target-cwd");
		fs.mkdirSync(targetCwd);
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const oldFile = manager.getSessionFile();
		if (!oldFile) throw new Error("missing session file");

		await manager.moveTo(targetCwd, path.join(path.dirname(sessions), "target-sessions"));
		const newFile = manager.getSessionFile();
		if (!newFile) throw new Error("missing moved session file");

		expect(fs.existsSync(lockPathForSession(oldFile))).toBe(false);
		expect(inspectSessionLock(newFile).status).toBe("live");
		await manager.close();
	});
});
