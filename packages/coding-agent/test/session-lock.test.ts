import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__internalsForTesting,
	acquireSessionLock,
	inspectSessionLock,
	lockPathForSession,
	SessionLockError,
} from "../src/session/session-lock";

const OWNER_A = "00000000-0000-4000-8000-000000000001";
const OWNER_B = "00000000-0000-4000-8000-000000000002";

function probe(alive: boolean | "unknown") {
	return {
		processStartMarker: () => "marker",
		isAlive: () => alive,
	};
}

describe("session lock", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function fixture() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-lock-"));
		dirs.push(dir);
		return { dir, session: path.join(dir, "session.jsonl") };
	}

	it("acquires, heartbeats, and releases only its own record", () => {
		const { session } = fixture();
		let now = 1000;
		const lock = acquireSessionLock(session, {
			now: () => now,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		expect(
			inspectSessionLock(session, {
				now: () => now,
				pid: 43,
				processStartMarker: "other",
				processProbe: probe(true),
			}).status,
		).toBe("live");
		now += 5000;
		lock.heartbeat();
		expect(
			inspectSessionLock(session, {
				now: () => now,
				pid: 43,
				processStartMarker: "other",
				processProbe: probe(true),
			}).heartbeatAgeMs,
		).toBe(0);
		lock.release();
		lock.release();
		expect(fs.existsSync(lockPathForSession(session))).toBe(false);
	});

	it("removes a partially written lock record", () => {
		const { session } = fixture();
		const writeSync = fs.writeSync;
		let writes = 0;
		const partialWrite = (fd: number, buffer: Uint8Array, offset: number, length: number): number => {
			if (writes++ === 0) return writeSync(fd, buffer, offset, Math.max(1, length - 1));
			const error = new Error("write failed") as NodeJS.ErrnoException;
			error.code = "EIO";
			throw error;
		};
		const writeSpy = vi.spyOn(fs, "writeSync").mockImplementation(partialWrite as unknown as typeof fs.writeSync);
		try {
			expect(() =>
				acquireSessionLock(session, {
					ownerId: OWNER_A,
					pid: 42,
					processStartMarker: "marker",
					processProbe: probe(true),
				}),
			).toThrow(SessionLockError);
			expect(fs.existsSync(lockPathForSession(session))).toBe(false);
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("retries release after transient read and unlink failures", () => {
		const { session } = fixture();
		const lock = acquireSessionLock(session, {
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		const lockPath = lockPathForSession(session);
		const readFileSync = fs.readFileSync;
		const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((target, options) => {
			if (String(target) === lockPath) {
				const error = new Error("read failed") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return readFileSync(target, options as never);
		}) as typeof fs.readFileSync);
		expect(() => lock.release()).toThrow(SessionLockError);
		expect(lock.released).toBe(false);
		readSpy.mockRestore();

		const unlinkSync = fs.unlinkSync;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (String(target) === lockPath) {
				const error = new Error("unlink failed") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return unlinkSync(target);
		});
		expect(() => lock.release()).toThrow(SessionLockError);
		expect(lock.released).toBe(false);
		unlinkSpy.mockRestore();

		lock.release();
		expect(lock.released).toBe(true);
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it("prevents competing writers and classifies suspect locks", () => {
		const { session } = fixture();
		const now = 20_000;
		const first = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		expect(() =>
			acquireSessionLock(session, {
				now: () => now,
				ownerId: OWNER_B,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(true),
			}),
		).toThrow(SessionLockError);
		expect(
			inspectSessionLock(session, {
				now: () => 15_000,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(true),
			}).status,
		).toBe("suspect");
		first.release();
	});

	it("steals only a dead owner after the threshold", () => {
		const { session } = fixture();
		const first = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
		});
		const second = acquireSessionLock(session, {
			now: () => 20_001,
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			processProbe: probe(false),
		});
		expect(second.record.ownerId).toBe(OWNER_B);
		first.release();
		expect(
			inspectSessionLock(session, {
				now: () => 20_001,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(false),
			}).record?.ownerId,
		).toBe(OWNER_B);
		second.release();
	});

	it("does not leak the replacement lock when stale-claim cleanup fails", () => {
		const { session } = fixture();
		const first = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
		});
		const unlinkSync = fs.unlinkSync;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (String(target).endsWith(".steal")) {
				const error = new Error("claim cleanup denied") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return unlinkSync(target);
		});
		try {
			expect(() =>
				acquireSessionLock(session, {
					now: () => 20_001,
					ownerId: OWNER_B,
					pid: 43,
					processStartMarker: "marker-b",
					processProbe: probe(false),
				}),
			).toThrow(SessionLockError);
			expect(fs.existsSync(lockPathForSession(session))).toBe(false);
		} finally {
			unlinkSpy.mockRestore();
			first.release();
		}
	});

	it("does not steal before twenty seconds even when the owner is dead", () => {
		const { session } = fixture();
		const first = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
		});
		expect(() =>
			acquireSessionLock(session, {
				now: () => 19_999,
				ownerId: OWNER_B,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(false),
			}),
		).toThrow(SessionLockError);
		first.release();
	});

	it("fails closed for foreign hosts, unknown liveness, and malformed records", () => {
		const { session } = fixture();
		const first = acquireSessionLock(session, {
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
			hostname: "foreign-host",
		});
		const inspection = inspectSessionLock(session, {
			now: () => 30_000,
			hostname: "local-host",
			pid: 43,
			processStartMarker: "marker-b",
			processProbe: probe(false),
		});
		expect(inspection.processAlive).toBe("unknown");
		expect(inspection.stealable).toBe(false);
		first.release();

		fs.writeFileSync(lockPathForSession(session), JSON.stringify({ protocolVersion: 1, ownerId: OWNER_A }));
		expect(
			inspectSessionLock(session, { pid: 43, processStartMarker: "marker-b", processProbe: probe(false) }).status,
		).toBe("malformed");
	});

	it("keeps the lock path stable when an opened symlink is atomically replaced", () => {
		const { dir, session } = fixture();
		fs.writeFileSync(session, "session");
		const alias = path.join(dir, "alias.jsonl");
		fs.symlinkSync(session, alias);
		const aliasLockPath = lockPathForSession(alias);
		const lock = acquireSessionLock(alias, {
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		expect(fs.statSync(aliasLockPath).mode & 0o777).toBe(0o600);

		fs.unlinkSync(alias);
		fs.writeFileSync(alias, "rewritten session");
		expect(lockPathForSession(alias)).toBe(aliasLockPath);
		expect(() =>
			acquireSessionLock(alias, {
				ownerId: OWNER_B,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(true),
			}),
		).toThrow(SessionLockError);
		lock.release();
	});

	it("serializes a heartbeat against an explicit stale-steal claim", () => {
		const { session } = fixture();
		const old = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
		});
		const claimPath = __internalsForTesting.claimPathFor(lockPathForSession(session));
		const claim = {
			protocolVersion: 1,
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			hostname: "claim-host",
			createdAt: 20_000,
			sessionFile: lockPathForSession(session).slice(0, -".lock".length),
		};
		expect(__internalsForTesting.writeClaim(claimPath, claim as never)).toBe(true);
		expect(__internalsForTesting.parseClaim(fs.readFileSync(claimPath, "utf8"), session)).not.toBeNull();
		expect(() => old.heartbeat()).toThrow(SessionLockError);
		fs.unlinkSync(claimPath);
		old.release();
	});

	it("recovers only dead local orphan claims, never live or unknown claims", () => {
		const { session } = fixture();
		const claimPath = __internalsForTesting.claimPathFor(lockPathForSession(session));
		const claim = {
			protocolVersion: 1,
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			hostname: "local",
			createdAt: 0,
			sessionFile: lockPathForSession(session).slice(0, -".lock".length),
		};
		const rt = {
			now: () => 20_001,
			hostname: "local",
			processProbe: probe(false),
		} as never;
		__internalsForTesting.writeClaim(claimPath, claim as never);
		__internalsForTesting.recoverClaim(claimPath, session, rt);
		expect(fs.existsSync(claimPath)).toBe(false);
		__internalsForTesting.writeClaim(claimPath, { ...claim, hostname: "foreign" } as never);
		__internalsForTesting.recoverClaim(claimPath, session, rt);
		expect(fs.existsSync(claimPath)).toBe(true);
		fs.unlinkSync(claimPath);
	});

	it("treats start-marker mismatch and unknown probes as non-stealable", () => {
		const { session } = fixture();
		const lock = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker-a",
			processProbe: { processStartMarker: () => "marker-b", isAlive: () => "unknown" },
		});
		expect(
			inspectSessionLock(session, {
				now: () => 30_000,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe("unknown"),
			}).stealable,
		).toBe(false);
		lock.release();
	});

	it("identifies the current process instance", () => {
		const marker = __internalsForTesting.defaultProcessStartMarker(process.pid);
		expect(marker).not.toBeNull();
		if (!marker) throw new Error("missing process start marker");
		expect(__internalsForTesting.defaultProcessProbe.isAlive(process.pid, marker)).toBe(true);
	});

	it("accepts Bun's UUIDv7 owner ids", () => {
		const { session } = fixture();
		const lock = acquireSessionLock(session);
		expect(inspectSessionLock(session).record?.ownerId).toBe(lock.record.ownerId);
		lock.release();
	});
});
