import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AdvisoryLock } from "@oh-my-pi/pi-natives";
import {
	__internalsForTesting,
	acquireSessionLock,
	guardPathForSession,
	inspectSessionLock,
	lockPathForSession,
	SessionLockError,
} from "../src/session/session-lock";

const OWNER_A = "00000000-0000-4000-8000-000000000001";
const OWNER_B = "00000000-0000-4000-8000-000000000002";
const OWNER_C = "00000000-0000-4000-8000-000000000003";
const CONTENDER_FIXTURE = path.join(import.meta.dir, "fixtures", "session-lock-contender.ts");

function probe(alive: boolean | "unknown") {
	return {
		processStartMarker: () => "marker",
		isAlive: () => alive,
	};
}

interface ContenderResult {
	status: "acquired" | "locked" | "error";
	ownerId: string;
	code?: string;
	message?: string;
}

async function readContenderResult(stdout: ReadableStream<Uint8Array>): Promise<ContenderResult> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
	const line = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : undefined);
	if (!line) throw new Error("session lock contender exited without a result");
	return JSON.parse(line) as ContenderResult;
}

async function runStaleContenderRace(session: string, now: number): Promise<ContenderResult[]> {
	const children = [OWNER_B, OWNER_C].map(ownerId =>
		Bun.spawn([process.execPath, CONTENDER_FIXTURE, session, ownerId, String(now)], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	try {
		for (const child of children) {
			child.stdin.write("go\n");
			child.stdin.flush();
		}
		const results = await Promise.all(children.map(child => readContenderResult(child.stdout)));
		for (let index = 0; index < children.length; index++) {
			if (results[index]?.status === "acquired") children[index].stdin.write("release\n");
			children[index].stdin.end();
		}
		const exitCodes = await Promise.all(children.map(child => child.exited));
		expect(exitCodes).toEqual([0, 0]);
		return results;
	} finally {
		for (const child of children) {
			try {
				child.stdin.end();
			} catch {
				// The contender already exited.
			}
			if (child.exitCode === null) child.kill();
		}
	}
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
		expect(fs.existsSync(guardPathForSession(session))).toBe(true);
		expect(fs.statSync(guardPathForSession(session)).mode & 0o777).toBe(0o600);
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

	it("allows exactly one of two cross-process contenders to replace a stale owner", async () => {
		const { session } = fixture();
		const stale = acquireSessionLock(session, {
			now: () => 0,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(false),
			heartbeatIntervalMs: 60_000,
		});
		try {
			const results = await runStaleContenderRace(session, 20_001);
			expect(results.map(result => result.status).sort()).toEqual(["acquired", "locked"]);
			expect(results.find(result => result.status === "locked")?.code).toBe("locked");
			expect(fs.existsSync(lockPathForSession(session))).toBe(false);
			expect(fs.existsSync(guardPathForSession(session))).toBe(true);
		} finally {
			stale.release();
		}
	});

	it("allows exactly one of two cross-process contenders to replace an old malformed owner", async () => {
		const { session } = fixture();
		const lockPath = lockPathForSession(session);
		fs.writeFileSync(lockPath, "truncated", { mode: 0o600 });
		const modifiedAt = fs.lstatSync(lockPath).mtimeMs;
		const results = await runStaleContenderRace(session, modifiedAt + 20_001);
		expect(results.map(result => result.status).sort()).toEqual(["acquired", "locked"]);
		expect(results.find(result => result.status === "locked")?.code).toBe("locked");
		expect(fs.existsSync(lockPath)).toBe(false);
		expect(fs.existsSync(guardPathForSession(session))).toBe(true);
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

	it("rejects a fresh malformed lock and recovers the unchanged file after twenty seconds", () => {
		const { session } = fixture();
		const lockPath = lockPathForSession(session);
		fs.writeFileSync(lockPath, "");
		const modifiedAt = fs.lstatSync(lockPath).mtimeMs;
		const contender = {
			ownerId: OWNER_B,
			pid: 43,
			processStartMarker: "marker-b",
			processProbe: probe(false),
		};

		expect(() => acquireSessionLock(session, { ...contender, now: () => modifiedAt + 19_999 })).toThrow(
			SessionLockError,
		);
		expect(fs.readFileSync(lockPath, "utf8")).toBe("");

		const recovered = acquireSessionLock(session, { ...contender, now: () => modifiedAt + 20_001 });
		expect(recovered.record.ownerId).toBe(OWNER_B);
		expect(inspectSessionLock(session, { ...contender, now: () => modifiedAt + 20_001 }).status).toBe("live");
		recovered.release();
	});

	it("fails closed for foreign hosts, unknown liveness, malformed records, and path mismatches", () => {
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

	it("uses canonical real paths for symlink aliases and preserves 0600 owner and guard files", () => {
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
		expect(fs.statSync(guardPathForSession(session)).mode & 0o777).toBe(0o600);
		expect(() =>
			acquireSessionLock(session, {
				ownerId: OWNER_B,
				pid: 43,
				processStartMarker: "marker-b",
				processProbe: probe(true),
			}),
		).toThrow(SessionLockError);
		lock.release();
		expect(fs.existsSync(guardPathForSession(session))).toBe(true);
	});

	it("skips a busy heartbeat and preserves the owner when acquire or release sees a busy guard", () => {
		const { session } = fixture();
		let now = 0;
		const owner = acquireSessionLock(session, {
			now: () => now,
			ownerId: OWNER_A,
			pid: 42,
			processStartMarker: "marker",
			processProbe: probe(true),
		});
		const guard = AdvisoryLock.tryAcquire(guardPathForSession(session));
		expect(guard).not.toBeNull();
		if (!guard) throw new Error("failed to acquire test guard");
		try {
			now = 5_000;
			owner.heartbeat();
			expect(owner.record.heartbeatAt).toBe(0);
			expect(() =>
				acquireSessionLock(session, {
					now: () => now,
					ownerId: OWNER_B,
					pid: 43,
					processStartMarker: "marker-b",
					processProbe: probe(true),
				}),
			).toThrow(SessionLockError);
			try {
				owner.release();
				throw new Error("expected busy release to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(SessionLockError);
				expect((error as SessionLockError).code).toBe("locked");
			}
			expect(owner.released).toBe(false);
			expect(JSON.parse(fs.readFileSync(lockPathForSession(session), "utf8")).ownerId).toBe(OWNER_A);
		} finally {
			guard.release();
		}
		owner.heartbeat();
		expect(owner.record.heartbeatAt).toBe(5_000);
		owner.release();
		expect(fs.existsSync(lockPathForSession(session))).toBe(false);
	});

	it("uses a stable start marker for the current native process", () => {
		const marker = __internalsForTesting.defaultProcessStartMarker(process.pid);
		expect(marker).not.toBeNull();
		if (!marker) throw new Error("missing current process marker");
		expect(__internalsForTesting.defaultProcessProbe.isAlive(process.pid, marker)).toBe(true);
		expect(__internalsForTesting.defaultProcessProbe.isAlive(process.pid, `${marker}:reused`)).toBe(false);
	});

	it("compares only compatible process marker sources", () => {
		expect(__internalsForTesting.compareProcessStartMarkers("darwin:1:2", "darwin:3:4")).toBe(false);
		expect(__internalsForTesting.compareProcessStartMarkers("darwin:1:2", "fallback-darwin-ps:Mon Jul 14")).toBe(
			"unknown",
		);
		expect(__internalsForTesting.compareProcessStartMarkers("fallback-linux-proc:42", "fallback-linux-proc:42")).toBe(
			true,
		);
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
});
