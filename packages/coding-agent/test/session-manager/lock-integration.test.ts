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
import { SessionManager, SessionPersistenceIndeterminateError } from "../../src/session/session-manager";
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

	it("retries lock cleanup when a failed open cannot release immediately", async () => {
		const { cwd, sessions } = fixture();
		const source = SessionManager.create(cwd, sessions);
		source.appendMessage({ role: "user", content: "open cleanup", timestamp: Date.now() });
		await source.ensureOnDisk();
		const sessionFile = source.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		await source.close();

		class FailingLoadStorage extends FileSessionStorage {
			#reads = 0;
			override readText(filePath: string): Promise<string> {
				this.#reads++;
				if (this.#reads === 2) return Promise.reject(new Error("load after lock failed"));
				return super.readText(filePath);
			}
		}
		const lockPath = lockPathForSession(sessionFile);
		const unlinkSync = fs.unlinkSync;
		let releaseFailed = false;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (!releaseFailed && String(target) === lockPath) {
				releaseFailed = true;
				const error = new Error("transient unlink failure") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return unlinkSync(target);
		});
		try {
			await expect(SessionManager.open(sessionFile, undefined, new FailingLoadStorage())).rejects.toThrow(
				"load after lock failed",
			);
			expect(fs.existsSync(lockPath)).toBe(false);
		} finally {
			unlinkSpy.mockRestore();
		}
	});

	it("retries lock cleanup when continueRecent fails after acquisition", async () => {
		const { cwd, sessions } = fixture();
		const source = SessionManager.create(cwd, sessions);
		source.appendMessage({ role: "user", content: "continue cleanup", timestamp: Date.now() });
		await source.ensureOnDisk();
		const sessionFile = source.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		await source.close();

		class FailingContinueStorage extends FileSessionStorage {
			override readText(filePath: string): Promise<string> {
				if (fs.existsSync(lockPathForSession(filePath))) {
					return Promise.reject(new Error("continue load after lock failed"));
				}
				return super.readText(filePath);
			}
		}
		const lockPath = lockPathForSession(sessionFile);
		const unlinkSync = fs.unlinkSync;
		let releaseFailed = false;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (!releaseFailed && String(target) === lockPath) {
				releaseFailed = true;
				const error = new Error("transient unlink failure") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return unlinkSync(target);
		});
		try {
			await expect(SessionManager.continueRecent(cwd, sessions, new FailingContinueStorage())).rejects.toThrow(
				"continue load after lock failed",
			);
			expect(fs.existsSync(lockPath)).toBe(false);
		} finally {
			unlinkSpy.mockRestore();
		}

		const reopened = await SessionManager.open(sessionFile);
		await reopened.close();
	});

	it("preserves source state when branching cannot release its lock", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		const branchPoint = manager.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "source tail", timestamp: 2 });
		await manager.ensureOnDisk();
		const sourceFile = manager.getSessionFile();
		if (!sourceFile) throw new Error("missing source session file");
		const sourceState = manager.snapshotForReplication();
		const lockPath = lockPathForSession(sourceFile);
		const unlinkSync = fs.unlinkSync;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (String(target) === lockPath) {
				const error = new Error("unlink failed") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return unlinkSync(target);
		});
		try {
			expect(() => manager.createBranchedSession(branchPoint)).toThrow(SessionLockError);
			expect(manager.getSessionFile()).toBe(sourceFile);
			expect(manager.snapshotForReplication()).toEqual(sourceState);
		} finally {
			unlinkSpy.mockRestore();
			await manager.close();
		}
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

	it("pins canonical ownership when a symlink alias is removed or retargeted", async () => {
		const { cwd, sessions } = fixture();
		const created = SessionManager.create(cwd, sessions);
		await created.ensureOnDisk();
		const sessionFile = created.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		await created.close();

		const alias = path.join(sessions, "alias.jsonl");
		fs.symlinkSync(sessionFile, alias);
		const manager = await SessionManager.open(alias);
		expect(manager.getSessionFile()).toBe(fs.realpathSync(sessionFile));
		await expect(SessionManager.open(alias)).rejects.toBeInstanceOf(SessionLockError);
		await expect(SessionManager.open(sessionFile)).rejects.toBeInstanceOf(SessionLockError);

		fs.unlinkSync(alias);
		const retargeted = path.join(sessions, "retargeted.jsonl");
		fs.writeFileSync(retargeted, "sentinel");
		fs.symlinkSync(retargeted, alias);
		manager.appendMessage({ role: "user", content: "canonical target", timestamp: Date.now() });
		await manager.flush();
		expect(fs.readFileSync(retargeted, "utf8")).toBe("sentinel");
		expect(
			(await SessionManager.openSnapshot(sessionFile)).getEntries().some(entry => entry.type === "message"),
		).toBe(true);

		await manager.dropSession(manager.getSessionFile()!);
		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(false);
		expect(fs.realpathSync(alias)).toBe(fs.realpathSync(retargeted));
		await manager.close();
	});

	it("does not follow a symlink installed over the pinned session path", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");

		const foreignSession = path.join(sessions, "foreign.jsonl");
		fs.writeFileSync(foreignSession, "foreign sentinel");
		fs.unlinkSync(sessionFile);
		fs.symlinkSync(foreignSession, sessionFile);

		manager.appendMessage({ role: "user", content: "pinned rewrite", timestamp: Date.now() });
		await manager.recoverPersistenceFromCurrentState();

		expect(fs.readFileSync(foreignSession, "utf8")).toBe("foreign sentinel");
		expect(fs.lstatSync(sessionFile).isSymbolicLink()).toBe(false);
		expect(
			(await SessionManager.openSnapshot(sessionFile))
				.getEntries()
				.some(entry => entry.type === "message" && entry.message.role === "user"),
		).toBe(true);
		await manager.close();
	});

	it("does not follow a replacement symlink during append or title updates", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");

		const foreignSession = path.join(sessions, "foreign-direct-mutation.jsonl");
		fs.writeFileSync(foreignSession, "foreign sentinel");
		fs.unlinkSync(sessionFile);
		fs.symlinkSync(foreignSession, sessionFile);

		manager.appendMessage({ role: "user", content: "repair pinned path", timestamp: Date.now() });
		await manager.flush();

		expect(fs.readFileSync(foreignSession, "utf8")).toBe("foreign sentinel");
		expect(fs.lstatSync(sessionFile).isSymbolicLink()).toBe(false);
		expect(
			(await SessionManager.openSnapshot(sessionFile))
				.getEntries()
				.some(entry => entry.type === "message" && entry.message.role === "user"),
		).toBe(true);
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

	it("refuses deletion while a detached clone shares write ownership", async () => {
		const { cwd, sessions } = fixture();
		const manager = SessionManager.create(cwd, sessions);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		const detached = manager.cloneCurrentSession();

		await expect(manager.dropSession(sessionFile)).rejects.toBeInstanceOf(SessionLockError);
		expect(fs.existsSync(sessionFile)).toBe(true);
		detached.appendMessage({ role: "user", content: "still valid", timestamp: Date.now() });
		await detached.flush();
		const snapshot = await SessionManager.openSnapshot(sessionFile);
		expect(snapshot.getEntries().some(entry => entry.type === "message")).toBe(true);

		await detached.close();
		await manager.dropSession(sessionFile);
		expect(fs.existsSync(sessionFile)).toBe(false);
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
		const alias = path.join(sessions, "moved-inode-alias.jsonl");
		fs.linkSync(newFile, alias);
		fs.unlinkSync(newFile);
		await expect(SessionManager.open(alias)).rejects.toBeInstanceOf(SessionLockError);
		await manager.close();
		const aliasManager = await SessionManager.open(alias);
		await aliasManager.close();
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
		const alias = path.join(sessions, "rollback-inode-alias.jsonl");
		fs.linkSync(oldFile, alias);
		fs.unlinkSync(oldFile);
		await expect(SessionManager.open(alias)).rejects.toBeInstanceOf(SessionLockError);
		await manager.close();
		const aliasManager = await SessionManager.open(alias);
		await aliasManager.close();
	});

	it("keeps target ownership when move rollback leaves the journal there", async () => {
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
		const oldLockPath = lockPathForSession(oldFile);
		const unlinkSync = fs.unlinkSync;
		let releaseFailed = false;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (!releaseFailed && String(target) === oldLockPath) {
				releaseFailed = true;
				const error = new Error("source lock cleanup failed") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return unlinkSync(target);
		});
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
			await expect(manager.moveTo(targetCwd, targetSessions)).rejects.toBeInstanceOf(
				SessionPersistenceIndeterminateError,
			);
			expect(manager.getSessionFile()).toBe(newFile);
			expect(fs.existsSync(oldFile)).toBe(false);
			expect(fs.existsSync(newFile)).toBe(true);
			expect(inspectSessionLock(oldFile).status).toBe("live");
			expect(inspectSessionLock(newFile).status).toBe("live");
			expect(() =>
				manager.appendMessage({ role: "user", content: "must not recreate source", timestamp: Date.now() }),
			).toThrow(SessionPersistenceIndeterminateError);
			expect(fs.existsSync(oldFile)).toBe(false);
		} finally {
			renameSpy.mockRestore();
			unlinkSpy.mockRestore();
		}

		await manager.recoverPersistenceFromCurrentState();
		expect(fs.existsSync(oldLockPath)).toBe(false);
		expect(inspectSessionLock(newFile).status).toBe("live");
		await manager.close();
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

	it("releases a fork target lock when initial publication fails", async () => {
		const { cwd, sessions } = fixture();
		const storage = new FileSessionStorage();
		const source = SessionManager.create(cwd, sessions, storage);
		source.appendMessage({ role: "user", content: "fork source", timestamp: Date.now() });
		await source.ensureOnDisk();
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("missing source session file");
		await source.close();

		const targetFile = path.join(sessions, "failed-fork.jsonl");
		const writeSpy = vi.spyOn(storage, "writeTextAtomic").mockRejectedValueOnce(new Error("publish failed"));
		await expect(
			SessionManager.forkFrom(sourceFile, cwd, sessions, storage, { sessionFile: targetFile }),
		).rejects.toThrow("publish failed");
		writeSpy.mockRestore();

		expect(fs.existsSync(lockPathForSession(targetFile))).toBe(false);
	});

	it("refuses deletion after a heartbeat loses ownership", async () => {
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

			vi.advanceTimersByTime(SESSION_LOCK_HEARTBEAT_MS);
			await Promise.resolve();

			await expect(manager.dropSession(sessionFile)).rejects.toBeInstanceOf(SessionLockError);
			expect(fs.existsSync(sessionFile)).toBe(true);
		} finally {
			await manager.close().catch(error => {
				if (!(error instanceof SessionLockError)) throw error;
			});
			if (lockPath && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
			vi.useRealTimers();
		}
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
