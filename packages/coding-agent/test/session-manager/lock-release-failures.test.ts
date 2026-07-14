import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AdvisoryLock } from "@oh-my-pi/pi-natives";
import { acquireSessionLock, guardPathForSession, lockPathForSession } from "../../src/session/session-lock";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage, type SessionStorageWriter } from "../../src/session/session-storage";

const OWNER_A = "00000000-0000-4000-8000-000000000021";
const OWNER_B = "00000000-0000-4000-8000-000000000022";

function probe() {
	return { processStartMarker: () => "marker", isAlive: () => true as const };
}

class FailureStorage extends FileSessionStorage {
	failAppends = false;
	failDrain = false;

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const delegate = super.openWriter(filePath, options);
		return {
			append: line => {
				if (!this.failAppends) return delegate.append(line);
				const error = new Error("injected append failure");
				options?.onError?.(error);
				return Promise.reject(error);
			},
			flush: () => delegate.flush(),
			isOpen: () => delegate.isOpen(),
			close: () => delegate.close(),
			getError: () => delegate.getError(),
		};
	}

	override async drain(): Promise<void> {
		if (this.failDrain) throw new Error("injected drain failure");
		await super.drain();
	}
}

describe("SessionManager failure lock release", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function fixture() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-manager-lock-failure-"));
		dirs.push(dir);
		const cwd = path.join(dir, "cwd");
		fs.mkdirSync(cwd);
		return { cwd, sessions: path.join(dir, "sessions") };
	}

	function managerFor(storage: FailureStorage, cwd: string, sessions: string): SessionManager {
		return SessionManager.create(cwd, sessions, storage, {
			enabled: true,
			ownerId: OWNER_A,
			pid: 201,
			processStartMarker: "marker",
			processProbe: probe(),
		});
	}

	function proveLockIsAvailable(sessionFile: string): void {
		const competitor = acquireSessionLock(sessionFile, {
			ownerId: OWNER_B,
			pid: 202,
			processStartMarker: "marker-b",
			processProbe: probe(),
		});
		competitor.release();
	}

	async function waitForLockRelease(sessionFile: string): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (!fs.existsSync(lockPathForSession(sessionFile))) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
		}
		throw new Error(`session lock was not released: ${sessionFile}`);
	}

	it("releases its lock in close even when storage drain fails", async () => {
		const { cwd, sessions } = fixture();
		const storage = new FailureStorage();
		const manager = managerFor(storage, cwd, sessions);
		await manager.ensureOnDisk();
		manager.appendMessage({ role: "user", content: "keep the session", timestamp: Date.now() });
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(true);

		storage.failDrain = true;
		await expect(manager.close()).rejects.toThrow("injected drain failure");

		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(false);
		proveLockIsAvailable(sessionFile);
	});

	it("preserves the close failure when native lock release is also busy", async () => {
		const { cwd, sessions } = fixture();
		const storage = new FailureStorage();
		const manager = managerFor(storage, cwd, sessions);
		await manager.ensureOnDisk();
		manager.appendMessage({ role: "user", content: "keep the session", timestamp: Date.now() });
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		const guard = AdvisoryLock.tryAcquire(guardPathForSession(sessionFile));
		if (!guard) throw new Error("failed to acquire test session guard");

		storage.failDrain = true;
		try {
			let failure: unknown;
			try {
				await manager.close();
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(AggregateError);
			if (!(failure instanceof AggregateError)) throw new Error("expected aggregate close failure");
			expect(failure.errors.map(error => String(error))).toEqual([
				"Error: injected drain failure",
				expect.stringContaining("Session lock guard is busy"),
			]);
			expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(true);
		} finally {
			guard.release();
		}

		storage.failDrain = false;
		await manager.close();
		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(false);
	});

	it("relinquishes ownership when an asynchronous append makes persistence unwritable", async () => {
		const { cwd, sessions } = fixture();
		const storage = new FailureStorage();
		const manager = managerFor(storage, cwd, sessions);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");

		storage.failAppends = true;
		manager.appendMessage({ role: "user", content: "fail this append", timestamp: Date.now() });
		await waitForLockRelease(sessionFile);

		expect(fs.existsSync(lockPathForSession(sessionFile))).toBe(false);
		proveLockIsAvailable(sessionFile);
		await expect(manager.close()).rejects.toThrow("injected append failure");
	});
});
