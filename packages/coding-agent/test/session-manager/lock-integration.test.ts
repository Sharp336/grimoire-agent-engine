import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportFromFile } from "../../src/export/html";
import {
	inspectSessionLock,
	lockPathForSession,
	SESSION_LOCK_HEARTBEAT_MS,
	SessionLockError,
} from "../../src/session/session-lock";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

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

	it("allows lock-free snapshots and exports while the writer is active", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		manager.appendMessage({ role: "user", content: "snapshot", timestamp: Date.now() });
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");

		const snapshot = await SessionManager.openSnapshot(sessionFile);
		expect(snapshot.getEntries().some(entry => entry.type === "message")).toBe(true);
		const outputPath = path.join(path.dirname(cwd), "session.html");
		expect(await exportFromFile(sessionFile, { outputPath, includeSubSessions: false })).toBe(outputPath);
		expect(fs.existsSync(outputPath)).toBe(true);
		await expect(SessionManager.open(sessionFile)).rejects.toBeInstanceOf(SessionLockError);
		await manager.close();
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

	it("releases a replacement lock when the previous lock cannot be removed", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const previousFile = manager.getSessionFile();
		if (!previousFile) throw new Error("missing previous session file");

		const targetManager = SessionManager.create(cwd, sessions);
		targetManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("missing target session file");
		await targetManager.close();

		const previousLockPath = lockPathForSession(previousFile);
		const unlinkSync = fs.unlinkSync;
		let failed = false;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (!failed && String(target) === previousLockPath) {
				failed = true;
				const error = new Error("unlink failed") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return unlinkSync(target);
		});
		await expect(manager.setSessionFile(targetFile)).rejects.toBeInstanceOf(SessionLockError);
		unlinkSpy.mockRestore();

		expect(fs.existsSync(lockPathForSession(targetFile))).toBe(false);
		await manager.close();
	});

	it("keeps canonical ownership through symlink rewrites and deletion", async () => {
		const { cwd, sessions } = fixture();
		const created = SessionManager.create(cwd, sessions);
		await created.ensureOnDisk();
		const sessionFile = created.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		await created.close();

		const alias = path.join(sessions, "alias.jsonl");
		fs.symlinkSync(sessionFile, alias);
		const manager = await SessionManager.open(alias);
		await manager.rewriteEntries();
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
		await expect(SessionManager.open(alias)).rejects.toBeInstanceOf(SessionLockError);
		await expect(SessionManager.open(sessionFile)).rejects.toBeInstanceOf(SessionLockError);
		const managedSessionFile = manager.getSessionFile();
		if (!managedSessionFile) throw new Error("missing managed session file");
		await manager.dropSession(managedSessionFile);
		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(false);
		expect(() => fs.lstatSync(alias)).toThrow();
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

	it("rolls back a move when source ownership cannot be released", async () => {
		const { cwd, sessions } = fixture();
		const targetCwd = path.join(path.dirname(cwd), "target-cwd");
		const targetSessions = path.join(path.dirname(sessions), "target-sessions");
		fs.mkdirSync(targetCwd);
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const oldFile = manager.getSessionFile();
		if (!oldFile) throw new Error("missing session file");
		const newFile = path.join(targetSessions, path.basename(oldFile));
		const oldLockPath = lockPathForSession(oldFile);
		const unlinkSync = fs.unlinkSync;
		let failed = false;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (!failed && String(target) === oldLockPath) {
				failed = true;
				const error = new Error("source lock cleanup failed") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return unlinkSync(target);
		});
		await expect(manager.moveTo(targetCwd, targetSessions)).rejects.toBeInstanceOf(SessionLockError);
		unlinkSpy.mockRestore();

		expect(manager.getSessionFile()).toBe(oldFile);
		expect(fs.existsSync(oldFile)).toBe(true);
		expect(fs.existsSync(newFile)).toBe(false);
		expect(fs.existsSync(lockPathForSession(newFile))).toBe(false);
		expect(inspectSessionLock(oldFile).status).toBe("live");
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

	it("keeps current ownership when deleting a different session", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		const otherSession = path.join(sessions, "other.jsonl");
		fs.writeFileSync(otherSession, "other");

		await manager.dropSession(otherSession);
		expect(fs.existsSync(otherSession)).toBe(false);
		await expect(SessionManager.open(sessionFile)).rejects.toBeInstanceOf(SessionLockError);
		manager.appendMessage({ role: "user", content: "still owned", timestamp: Date.now() });
		await manager.flush();
		await manager.close();
	});

	it("refuses to delete a session owned by another manager", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		const otherManager = SessionManager.create(cwd, sessions);
		await otherManager.ensureOnDisk();
		const otherSession = otherManager.getSessionFile();
		if (!otherSession) throw new Error("missing other session file");

		await expect(manager.dropSession(otherSession)).rejects.toBeInstanceOf(SessionLockError);
		expect(fs.existsSync(otherSession)).toBe(true);
		expect(inspectSessionLock(otherSession).status).toBe("live");
		await expect(SessionManager.open(sessionFile)).rejects.toBeInstanceOf(SessionLockError);
		await otherManager.close();

		// Once the owner is gone the same deletion succeeds.
		await manager.dropSession(otherSession);
		expect(fs.existsSync(otherSession)).toBe(false);
		expect(fs.existsSync(lockPathForSession(otherSession))).toBe(false);
		await manager.close();
	});

	it("still deletes a session whose lock cannot be guaranteed", async () => {
		const { cwd, sessions } = fixture();
		fs.mkdirSync(sessions, { recursive: true });
		const target = path.join(sessions, "hard-linked.jsonl");
		fs.writeFileSync(target, "session");
		fs.linkSync(target, path.join(sessions, "alias.jsonl"));

		// With no sidecar owner to protect, deletion may unlink one hard-link path.
		const manager = SessionManager.create(cwd, sessions);
		await manager.dropSession(target);
		expect(fs.existsSync(target)).toBe(false);
		await manager.close();
	});

	it("refuses hard-link deletion when the target acquired ownership first", async () => {
		const { cwd, sessions } = fixture();
		const owner = SessionManager.create(cwd, sessions);
		await owner.ensureOnDisk();
		const target = owner.getSessionFile();
		if (!target) throw new Error("missing target session file");
		fs.linkSync(target, path.join(sessions, "alias.jsonl"));

		const deleter = SessionManager.create(cwd, sessions);
		await expect(deleter.dropSession(target)).rejects.toBeInstanceOf(SessionLockError);
		expect(fs.existsSync(target)).toBe(true);
		expect(inspectSessionLock(target).status).toBe("live");
		await deleter.close();
		await owner.close();
	});

	it("holds ownership until session deletion finishes", async () => {
		const { cwd, sessions } = fixture();
		const { promise: started, resolve: deletionStarted } = Promise.withResolvers<void>();
		const { promise: finish, resolve: finishDeletion } = Promise.withResolvers<void>();
		class DelayedDeleteStorage extends FileSessionStorage {
			override async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
				deletionStarted();
				await finish;
				await super.deleteSessionWithArtifacts(sessionPath);
			}
		}
		const manager = SessionManager.create(cwd, sessions, new DelayedDeleteStorage());
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");

		const dropping = manager.dropSession(sessionFile);
		await started;
		await expect(SessionManager.open(sessionFile)).rejects.toBeInstanceOf(SessionLockError);
		finishDeletion();
		await dropping;
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(false);
	});

	it("requires reacquisition after a heartbeat loses ownership", async () => {
		vi.useFakeTimers();
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		let lockPath: string | undefined;
		try {
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("missing session file");
			lockPath = lockPathForSession(sessionFile);
			const record = inspectSessionLock(sessionFile).record;
			if (!record) throw new Error("missing session lock record");
			fs.writeFileSync(lockPath, JSON.stringify({ ...record, ownerId: Bun.randomUUIDv7() }));
			const sessionBeforeRecovery = fs.readFileSync(sessionFile, "utf8");

			vi.advanceTimersByTime(SESSION_LOCK_HEARTBEAT_MS);
			await Promise.resolve();

			await expect(manager.recoverPersistenceFromCurrentState()).rejects.toBeInstanceOf(SessionLockError);
			expect(fs.readFileSync(sessionFile, "utf8")).toBe(sessionBeforeRecovery);

			fs.unlinkSync(lockPath);
			await manager.recoverPersistenceFromCurrentState();
			expect(inspectSessionLock(sessionFile).status).toBe("live");
		} finally {
			await manager.close().catch(error => {
				if (!(error instanceof SessionLockError)) throw error;
			});
			if (lockPath && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
			vi.useRealTimers();
		}
	});
});
