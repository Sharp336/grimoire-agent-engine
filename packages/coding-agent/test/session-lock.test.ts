import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
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

	it("completes partial heartbeat writes before publication", () => {
		const { session } = fixture();
		let now = 1;
		const lock = acquireSessionLock(session, {
			now: () => now,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		const writeSync = fs.writeSync;
		let writes = 0;
		const partialWrite = (fd: number, buffer: Uint8Array, offset: number, length: number): number => {
			const writeLength = writes++ === 0 ? Math.max(1, length - 1) : length;
			return writeSync(fd, buffer, offset, writeLength);
		};
		const writeSpy = vi.spyOn(fs, "writeSync").mockImplementation(partialWrite as unknown as typeof fs.writeSync);
		try {
			now = 2;
			lock.heartbeat();
			expect(inspectSessionLock(session).record?.heartbeatAt).toBe(2);
		} finally {
			writeSpy.mockRestore();
			lock.release();
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

	it("retains ownership when release cannot remove its mutation claim", () => {
		const { session } = fixture();
		const lock = acquireSessionLock(session, {
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		const lockPath = lockPathForSession(session);
		const claimPath = `${lockPath}.steal`;
		fs.writeFileSync(
			claimPath,
			JSON.stringify({
				protocolVersion: 1,
				ownerId: OWNER_A,
				pid: 42,
				processStartMarker: "marker",
				hostname: os.hostname(),
				createdAt: 0,
				sessionFile: lock.record.sessionFile,
			}),
		);
		const unlinkSync = fs.unlinkSync;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (String(target) === claimPath) {
				const error = new Error("claim cleanup denied") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return unlinkSync(target);
		});
		try {
			expect(() => lock.release()).toThrow(SessionLockError);
			expect(lock.released).toBe(false);
			expect(fs.existsSync(lockPath)).toBe(true);
		} finally {
			unlinkSpy.mockRestore();
		}

		lock.release();
		expect(lock.released).toBe(true);
		expect(fs.existsSync(lockPath)).toBe(false);
		expect(fs.existsSync(claimPath)).toBe(false);
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

	it("recovers confirmed-dead records and claims after a backward clock correction", () => {
		const { session } = fixture();
		const futureOwner = acquireSessionLock(session, {
			now: () => 50_000,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker-a",
			processProbe: probe(false),
		});
		const replacement = acquireSessionLock(session, {
			now: () => 1_000,
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			processProbe: probe(false),
		});
		expect(replacement.record.ownerId).toBe(OWNER_B);
		futureOwner.release();
		replacement.release();

		const lockPath = lockPathForSession(session);
		fs.writeFileSync(
			`${lockPath}.steal`,
			JSON.stringify({
				protocolVersion: 1,
				ownerId: OWNER_A,
				pid: 42,
				processStartMarker: "marker-a",
				hostname: os.hostname(),
				createdAt: 50_000,
				sessionFile: futureOwner.record.sessionFile,
			}),
		);
		const afterClaim = acquireSessionLock(session, {
			now: () => 1_000,
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			processProbe: probe(false),
		});
		expect(afterClaim.record.ownerId).toBe(OWNER_B);
		expect(fs.existsSync(`${lockPath}.steal`)).toBe(false);
		afterClaim.release();
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
		let claimRemovals = 0;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (String(target).endsWith(".steal") && ++claimRemovals === 2) {
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

	it("uses canonical real paths for symlink aliases and preserves 0600 claims", () => {
		const { dir, session } = fixture();
		fs.writeFileSync(session, "session");
		const alias = path.join(dir, "alias.jsonl");
		fs.symlinkSync(session, alias);
		expect(lockPathForSession(alias)).toBe(lockPathForSession(session));
		const lock = acquireSessionLock(alias, {
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		expect(fs.statSync(lockPathForSession(session)).mode & 0o777).toBe(0o600);
		expect(() =>
			acquireSessionLock(session, {
				ownerId: OWNER_B,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(true),
			}),
		).toThrow(SessionLockError);
		lock.release();
	});

	it("rejects writable ownership through hard-link aliases", () => {
		const { dir, session } = fixture();
		fs.writeFileSync(session, "session");
		const alias = path.join(dir, "alias.jsonl");
		fs.linkSync(session, alias);

		expect(() => acquireSessionLock(session)).toThrow(
			expect.objectContaining({ name: "SessionLockError", code: "unsupported" }),
		);
		expect(() => acquireSessionLock(alias)).toThrow(SessionLockError);
		expect(fs.existsSync(lockPathForSession(session))).toBe(false);
		expect(fs.existsSync(lockPathForSession(alias))).toBe(false);

		// Removing the extra link restores a guaranteeable single writer.
		fs.unlinkSync(alias);
		const lock = acquireSessionLock(session);
		expect(inspectSessionLock(session).status).toBe("live");
		lock.release();
	});

	it("keeps file-identity ownership after the original hard-link path is removed", () => {
		const { dir, session } = fixture();
		fs.writeFileSync(session, "session");
		const options = {
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		};
		const lock = acquireSessionLock(session, options);
		const alias = path.join(dir, "late-alias.jsonl");
		fs.linkSync(session, alias);
		fs.unlinkSync(session);
		expect(fs.statSync(alias).nlink).toBe(1);

		expect(() => acquireSessionLock(alias, { ...options, ownerId: OWNER_B })).toThrow(
			expect.objectContaining({ name: "SessionLockError", code: "locked" }),
		);

		lock.release();
		const aliasLock = acquireSessionLock(alias, { ...options, ownerId: OWNER_B });
		aliasLock.release();
	});

	it("rejects ownership when the session inode changes during acquisition", () => {
		const { dir, session } = fixture();
		fs.writeFileSync(session, "original");
		const replacement = path.join(dir, "replacement.jsonl");
		fs.writeFileSync(replacement, "replacement");
		const linkSync = fs.linkSync;
		let publications = 0;
		const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((existingPath, newPath) => {
			publications++;
			if (publications === 2) fs.renameSync(replacement, session);
			return linkSync(existingPath, newPath);
		});
		try {
			expect(() =>
				acquireSessionLock(session, {
					pid: 42,
					processStartMarker: "marker",
					processProbe: probe(true),
				}),
			).toThrow(expect.objectContaining({ name: "SessionLockError", code: "locked" }));
			expect(fs.readFileSync(session, "utf8")).toBe("replacement");
			expect(fs.existsSync(lockPathForSession(session))).toBe(false);
		} finally {
			linkSpy.mockRestore();
		}
	});

	it("claims the inode published after locking a missing session path", () => {
		const { dir, session } = fixture();
		const options = {
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		};
		const lock = acquireSessionLock(session, options);
		const staged = path.join(dir, "staged.jsonl");
		fs.writeFileSync(staged, "session");
		const claim = lock.prepareFileIdentity(staged);
		fs.renameSync(staged, session);
		claim.commit();

		const alias = path.join(dir, "published-alias.jsonl");
		fs.linkSync(session, alias);
		fs.unlinkSync(session);
		expect(() => acquireSessionLock(alias, { ...options, ownerId: OWNER_B })).toThrow(
			expect.objectContaining({ name: "SessionLockError", code: "locked" }),
		);

		lock.release();
	});

	it("does not publish ownership while another mutation claim is live", () => {
		const { session } = fixture();
		const claimPath = `${lockPathForSession(session)}.steal`;
		fs.writeFileSync(
			claimPath,
			JSON.stringify({
				protocolVersion: 1,
				ownerId: OWNER_B,
				pid: 43,
				processStartMarker: "marker-b",
				hostname: "claim-host",
				createdAt: 20_000,
				sessionFile: lockPathForSession(session).slice(0, -".lock".length),
			}),
			{ flag: "wx", mode: 0o600 },
		);

		expect(() =>
			acquireSessionLock(session, {
				now: () => 20_001,
				ownerId: OWNER_A,
				pid: 42,
				processStartMarker: "marker-a",
				processProbe: probe(true),
				hostname: "claim-host",
			}),
		).toThrow(SessionLockError);
		expect(fs.existsSync(lockPathForSession(session))).toBe(false);
	});

	it("skips a heartbeat while another mutation claim is live", () => {
		const { session } = fixture();
		let now = 0;
		const lock = acquireSessionLock(session, {
			now: () => now,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
		});
		const claimPath = `${lockPathForSession(session)}.steal`;
		const claim = {
			protocolVersion: 1,
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			hostname: "claim-host",
			createdAt: 20_000,
			sessionFile: lockPathForSession(session).slice(0, -".lock".length),
		};
		fs.writeFileSync(claimPath, JSON.stringify(claim), { flag: "wx", mode: 0o600 });
		now = 1;
		expect(() => lock.heartbeat()).not.toThrow();
		expect(inspectSessionLock(session).record?.heartbeatAt).toBe(0);
		fs.unlinkSync(claimPath);
		lock.heartbeat();
		expect(inspectSessionLock(session).record?.heartbeatAt).toBe(1);
		lock.release();
	});

	it("clears its claim when releasing after heartbeat cleanup fails", () => {
		const { session } = fixture();
		const lock = acquireSessionLock(session);
		const claimPath = `${lockPathForSession(session)}.steal`;
		const unlinkSync = fs.unlinkSync;
		let failed = false;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
			if (!failed && String(target) === claimPath) {
				failed = true;
				const error = new Error("claim cleanup failed") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return unlinkSync(target);
		});
		expect(() => lock.heartbeat()).toThrow(SessionLockError);
		expect(fs.existsSync(lockPathForSession(session))).toBe(true);
		expect(fs.existsSync(claimPath)).toBe(true);
		unlinkSpy.mockRestore();

		lock.release();
		expect(fs.existsSync(lockPathForSession(session))).toBe(false);
		expect(fs.existsSync(claimPath)).toBe(false);
	});

	it("recovers only dead local orphan claims, never foreign claims", () => {
		const { session } = fixture();
		const claimPath = `${lockPathForSession(session)}.steal`;
		const lock = acquireSessionLock(session, {
			now: () => 20_001,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker-a",
			processProbe: probe(false),
			hostname: "local",
		});
		const claim = {
			protocolVersion: 1,
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			hostname: "local",
			createdAt: 0,
			sessionFile: lockPathForSession(session).slice(0, -".lock".length),
		};

		fs.writeFileSync(claimPath, JSON.stringify(claim), { flag: "wx", mode: 0o600 });
		lock.heartbeat();
		expect(fs.existsSync(claimPath)).toBe(false);

		fs.writeFileSync(claimPath, JSON.stringify({ ...claim, hostname: "foreign" }), { flag: "wx", mode: 0o600 });
		expect(() => lock.heartbeat()).not.toThrow();
		expect(fs.existsSync(claimPath)).toBe(true);
		fs.unlinkSync(claimPath);
		lock.release();
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

	it("does not probe process liveness during an owner heartbeat", () => {
		const { session } = fixture();
		let probeCalls = 0;
		const lock = acquireSessionLock(session, {
			processStartMarker: "marker",
			processProbe: {
				processStartMarker: () => "marker",
				isAlive: () => {
					probeCalls++;
					return true;
				},
			},
		});
		lock.heartbeat();
		expect(probeCalls).toBe(0);
		lock.release();
	});

	it("accepts Bun's UUIDv7 owner ids", () => {
		const { session } = fixture();
		const lock = acquireSessionLock(session);
		expect(inspectSessionLock(session).record?.ownerId).toBe(lock.record.ownerId);
		lock.release();
	});
});
