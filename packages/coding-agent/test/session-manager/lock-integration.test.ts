import { afterEach, describe, expect, it, vi } from "bun:test";
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

	it("keeps manager ownership retryable when close cannot remove the lock", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		const lockPath = lockPathForSession(sessionFile);
		const unlinkSync = fs.unlinkSync;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (String(target) === lockPath) {
				const error = new Error("unlink failed") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return unlinkSync(target);
		});
		await expect(manager.close()).rejects.toBeInstanceOf(SessionLockError);
		expect(inspectSessionLock(sessionFile).status).toBe("live");
		unlinkSpy.mockRestore();

		await manager.close();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it("keeps ownership through an atomic rewrite of an opened symlink", async () => {
		const { cwd, sessions } = fixture();
		const created = SessionManager.create(cwd, sessions);
		await created.ensureOnDisk();
		const sessionFile = created.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		await created.close();

		const alias = path.join(path.dirname(sessionFile), "alias.jsonl");
		fs.symlinkSync(sessionFile, alias);
		const manager = await SessionManager.open(alias);
		await manager.setSessionName("rewritten");
		await expect(SessionManager.open(alias)).rejects.toBeInstanceOf(SessionLockError);
		await manager.close();
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

	it("releases target ownership when move rollback fails", async () => {
		const { cwd, sessions } = fixture();
		const targetCwd = path.join(path.dirname(cwd), "target-cwd");
		const targetSessions = path.join(path.dirname(sessions), "target-sessions");
		fs.mkdirSync(targetCwd);
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const oldFile = manager.getSessionFile();
		if (!oldFile) throw new Error("missing session file");
		const oldArtifactsDir = oldFile.slice(0, -".jsonl".length);
		fs.mkdirSync(oldArtifactsDir);
		const newFile = path.join(targetSessions, path.basename(oldFile));
		const newArtifactsDir = newFile.slice(0, -".jsonl".length);
		const rename = fs.promises.rename;
		const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			if (String(source) === oldArtifactsDir && String(target) === newArtifactsDir) {
				const error = new Error("artifact move failed") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			if (String(source) === newFile && String(target) === oldFile) {
				const error = new Error("session rollback failed") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return rename(source, target);
		});
		try {
			await expect(manager.moveTo(targetCwd, targetSessions)).rejects.toThrow("session rollback failed");
			expect(fs.existsSync(lockPathForSession(newFile))).toBe(false);
		} finally {
			renameSpy.mockRestore();
			await manager.close();
		}
	});
});
