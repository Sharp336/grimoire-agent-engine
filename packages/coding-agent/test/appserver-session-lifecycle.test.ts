import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decodeServerFrame, hostId, projectId, sessionId } from "@oh-my-pi/app-wire";
import {
	FileSessionDiscovery,
	type SessionDiscovery,
	SessionProjection,
	type SessionRecord,
} from "@oh-my-pi/appserver";
import { createAppserverRuntime } from "../src/session/appserver-authority";
import { AppserverSessionLifecycleStore } from "../src/session/appserver-session-lifecycle";
import { acquireSessionLock, lockPathForSession, type SessionLockHandle } from "../src/session/session-lock";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; sessionsDir: string; metadataPath: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-appserver-lifecycle-"));
	roots.push(root);
	const sessionsDir = path.join(root, "sessions");
	await fs.mkdir(sessionsDir, { recursive: true });
	return {
		root,
		sessionsDir,
		metadataPath: path.join(root, "profile", "appserver", "session-lifecycle.json"),
	};
}

async function writeSession(sessionsDir: string, id: string): Promise<string> {
	const transcript = path.join(sessionsDir, `${id}.jsonl`);
	await fs.writeFile(
		transcript,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-07-13T12:00:00.000Z",
			cwd: sessionsDir,
		})}\n`,
	);
	const artifacts = transcript.slice(0, -6);
	await fs.mkdir(artifacts);
	await fs.writeFile(path.join(artifacts, "artifact.txt"), "artifact");
	return transcript;
}

function acquireLockWithPersistentReleaseFailure(sessionPath: string): SessionLockHandle {
	const delegate = acquireSessionLock(sessionPath);
	let failuresRemaining = 4;
	return {
		record: delegate.record,
		lockPath: delegate.lockPath,
		heartbeat: () => delegate.heartbeat(),
		release: () => {
			if (failuresRemaining > 0) {
				failuresRemaining -= 1;
				throw new Error("injected persistent release failure");
			}
			delegate.release();
		},
		get released() {
			return delegate.released;
		},
	};
}

async function acquireCompetitorEventually(sessionPath: string): Promise<SessionLockHandle> {
	let failure: unknown;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return acquireSessionLock(sessionPath);
		} catch (error) {
			failure = error;
			await Bun.sleep(10);
		}
	}
	throw failure;
}

class GatedSnapshotDiscovery implements SessionDiscovery {
	#nextGate?: {
		started: PromiseWithResolvers<void>;
		released: PromiseWithResolvers<void>;
	};
	constructor(private readonly delegate: SessionDiscovery) {}
	blockNext(): { started: Promise<void>; release(): void } {
		if (this.#nextGate) throw new Error("a discovery gate is already pending");
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		this.#nextGate = { started, released };
		return { started: started.promise, release: () => released.resolve() };
	}
	async list(): Promise<SessionRecord[]> {
		const snapshot = (await this.delegate.list()).map(record => ({
			...record,
			entries: [...record.entries],
		}));
		const gate = this.#nextGate;
		if (!gate) return snapshot;
		this.#nextGate = undefined;
		gate.started.resolve();
		await gate.released.promise;
		return snapshot;
	}
}

describe("appserver session lifecycle authority", () => {
	test("new-session authority projects raw manager metadata before attach snapshots", async () => {
		const { root, sessionsDir, metadataPath } = await fixture();
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd);
		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const created = await runtime.sessionAuthority.create(cwd, "Fresh remote session");
		const transcript = (await fs.readFile(created.path, "utf8"))
			.split(/\r?\n/u)
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);

		expect(transcript.some(entry => entry.type === "title_change")).toBe(true);
		expect(transcript.some(entry => entry.type === "title_change" && entry.data === undefined)).toBe(true);
		expect(created.entries).toEqual([]);

		const projection = new SessionProjection(
			hostId("new-session-projection-test"),
			{
				...created,
				projectId: projectId("new-session-project"),
				projectName: "workspace",
				title: created.title ?? "Session",
				updatedAt: "2026-07-13T12:00:00.000Z",
				status: "idle",
			},
			"new-session-epoch",
		);
		const snapshot = projection.snapshot();
		expect(snapshot).toMatchObject({ type: "snapshot", entries: [] });
		expect(decodeServerFrame(snapshot)).toMatchObject({ type: "snapshot", entries: [] });
	});

	test("archive and restore survive runtime restart with private atomic metadata", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		await writeSession(sessionsDir, "session-durable");
		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const [record] = await runtime.discovery.list();
		expect(record).toBeDefined();
		const archivedAt = "2026-07-13T12:34:56.000Z";
		await runtime.sessionAuthority.archive(record!, archivedAt);

		const restarted = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		expect(await restarted.discovery.list()).toEqual([
			expect.objectContaining({ sessionId: record!.sessionId, archivedAt }),
		]);
		expect((await fs.stat(metadataPath)).mode & 0o777).toBe(0o600);
		expect((await fs.stat(path.dirname(metadataPath))).mode & 0o777).toBe(0o700);

		const [archived] = await restarted.discovery.list();
		await restarted.sessionAuthority.restore(archived!);
		const restored = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		expect((await restored.discovery.list())[0]?.archivedAt).toBeUndefined();
	});

	test("runtime authority reconciles committed archive, restore, and delete failures", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-authority-committed");
		const baseDiscovery = new GatedSnapshotDiscovery(
			new FileSessionDiscovery(sessionsDir, undefined, hostId("authority-race-discovery")),
		);
		const runtime = createAppserverRuntime({
			sessionsDir,
			lifecycleMetadataPath: metadataPath,
			lifecycleStoreOptions: { acquireLock: acquireLockWithPersistentReleaseFailure },
			baseDiscovery,
		});
		const [initial] = await runtime.discovery.list();
		if (!initial) throw new Error("session was not discovered");
		const archivedAt = "2026-07-13T12:34:56.000Z";

		const archiveGate = baseDiscovery.blockNext();
		const staleArchiveRefresh = runtime.discovery.list();
		await archiveGate.started;
		await expect(runtime.sessionAuthority.archive(initial, archivedAt)).rejects.toMatchObject({
			committed: true,
			operation: "archive",
		});
		let competitor = await acquireCompetitorEventually(transcript);
		competitor.release();
		archiveGate.release();
		const [archived] = await staleArchiveRefresh;
		expect(archived?.archivedAt).toBe(archivedAt);

		const restoreGate = baseDiscovery.blockNext();
		const staleRestoreRefresh = runtime.discovery.list();
		await restoreGate.started;
		await expect(runtime.sessionAuthority.restore(archived!)).rejects.toMatchObject({
			committed: true,
			operation: "restore",
		});
		competitor = await acquireCompetitorEventually(transcript);
		competitor.release();
		restoreGate.release();
		const [restored] = await staleRestoreRefresh;
		expect(restored?.archivedAt).toBeUndefined();

		const deleteGate = baseDiscovery.blockNext();
		const staleDeleteRefresh = runtime.discovery.list();
		await deleteGate.started;
		await expect(runtime.sessionAuthority.delete(restored!)).rejects.toMatchObject({
			committed: true,
			operation: "delete",
		});
		const filesList = runtime.operationsAuthority.filesList;
		if (!filesList) throw new Error("files.list authority is unavailable");
		await expect(
			filesList(
				{},
				{
					hostId: hostId("authority-committed-host"),
					sessionId: initial.sessionId,
					deviceId: "authority-committed-device",
					connectionId: "authority-committed-connection",
					capabilities: new Set(["files.list"]),
					abortSignal: new AbortController().signal,
				},
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		competitor = await acquireCompetitorEventually(transcript);
		competitor.release();
		deleteGate.release();
		expect(await staleDeleteRefresh).toEqual([]);
	});

	test("archive holds the real session lock across its metadata commit", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-archive-lock");
		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const [record] = await runtime.discovery.list();
		const competing = acquireSessionLock(transcript);
		try {
			await expect(runtime.sessionAuthority.archive(record!, "2026-07-13T12:34:56.000Z")).rejects.toThrow();
			expect((await runtime.discovery.list())[0]?.archivedAt).toBeUndefined();
		} finally {
			competing.release();
		}
	});

	test("archive safely recovers an unchanged old malformed lock instead of remaining permanently blocked", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-old-malformed-lock");
		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const [record] = await runtime.discovery.list();
		if (!record) throw new Error("session was not discovered");
		const lockPath = lockPathForSession(transcript);
		await fs.writeFile(lockPath, "truncated", { mode: 0o600 });
		const old = new Date(Date.now() - 21_000);
		await fs.utimes(lockPath, old, old);

		expect(() => runtime.lockCheck(record)).not.toThrow();
		const archivedAt = "2026-07-13T12:34:56.000Z";
		await runtime.sessionAuthority.archive(record, archivedAt);
		expect((await runtime.discovery.list())[0]?.archivedAt).toBe(archivedAt);
		await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("restore holds the real session lock and leaves archive metadata unchanged under contention", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-restore-lock");
		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const [record] = await runtime.discovery.list();
		if (!record) throw new Error("session was not discovered");
		const archivedAt = "2026-07-13T12:34:56.000Z";
		await runtime.sessionAuthority.archive(record, archivedAt);
		const [archived] = await runtime.discovery.list();
		if (!archived) throw new Error("archived session was not discovered");

		const competing = acquireSessionLock(transcript);
		try {
			await expect(runtime.sessionAuthority.restore(archived)).rejects.toThrow();
			expect((await runtime.discovery.list())[0]?.archivedAt).toBe(archivedAt);
		} finally {
			competing.release();
		}
		await runtime.sessionAuthority.restore(archived);
		expect((await runtime.discovery.list())[0]?.archivedAt).toBeUndefined();
	});

	test("delete holds the real session lock and removes transcript plus artifacts through a tombstone", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-delete");
		const runtime = createAppserverRuntime({ sessionsDir, lifecycleMetadataPath: metadataPath });
		const [record] = await runtime.discovery.list();
		expect(record?.path).toBe(transcript);
		const competing = acquireSessionLock(transcript);
		try {
			await expect(runtime.sessionAuthority.delete(record!)).rejects.toThrow();
			expect(await fs.readFile(transcript, "utf8")).toContain("session-delete");
			expect(await fs.readFile(path.join(transcript.slice(0, -6), "artifact.txt"), "utf8")).toBe("artifact");
		} finally {
			competing.release();
		}

		await runtime.sessionAuthority.delete(record!);
		await expect(fs.stat(transcript)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(transcript.slice(0, -6))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await runtime.discovery.list()).map(value => value.sessionId)).not.toContain(record!.sessionId);
		expect((await fs.readdir(sessionsDir)).some(name => name.startsWith(".omp-appserver-delete-"))).toBe(false);
	});

	test("restart rolls back an uncommitted same-filesystem tombstone", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const id = sessionId("session-recover");
		const transcript = await writeSession(sessionsDir, id);
		const artifacts = transcript.slice(0, -6);
		const tombstone = path.join(sessionsDir, ".omp-appserver-delete-interrupted");
		await fs.mkdir(tombstone, { mode: 0o700 });
		await fs.writeFile(
			path.join(tombstone, "manifest.json"),
			`${JSON.stringify({
				version: 1,
				sessionId: id,
				transcriptName: path.basename(transcript),
				artifactsName: path.basename(artifacts),
			})}\n`,
			{ mode: 0o600 },
		);
		await fs.rename(artifacts, path.join(tombstone, path.basename(artifacts)));
		await fs.rename(transcript, path.join(tombstone, path.basename(transcript)));

		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir);
		await store.recoverDeletes();
		expect(await fs.readFile(transcript, "utf8")).toContain(id);
		expect(await fs.readFile(path.join(artifacts, "artifact.txt"), "utf8")).toBe("artifact");
		await expect(fs.stat(tombstone)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("restart finishes committed tombstones and clears present or already-absent pending metadata idempotently", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const committedId = sessionId("session-committed-delete");
		const absentId = sessionId("session-already-cleaned");
		const committedName = ".omp-appserver-delete-committed";
		const absentName = ".omp-appserver-delete-already-absent";
		const committed = path.join(sessionsDir, committedName);
		await fs.mkdir(committed, { mode: 0o700 });
		await fs.writeFile(
			path.join(committed, "manifest.json"),
			`${JSON.stringify({
				version: 1,
				sessionId: committedId,
				transcriptName: `${committedId}.jsonl`,
				artifactsName: committedId,
			})}\n`,
			{ mode: 0o600 },
		);
		await fs.writeFile(path.join(committed, `${committedId}.jsonl`), "committed transcript");
		await fs.mkdir(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
		await fs.writeFile(
			metadataPath,
			`${JSON.stringify({
				version: 1,
				archived: [],
				pendingDeletes: [
					{ sessionId: committedId, tombstone: committedName },
					{ sessionId: absentId, tombstone: absentName },
				],
			})}\n`,
			{ mode: 0o600 },
		);

		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir);
		await store.recoverDeletes();
		await expect(fs.stat(committed)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(sessionsDir, `${committedId}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });
		const afterRecovery = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
			pendingDeletes: unknown[];
		};
		expect(afterRecovery.pendingDeletes).toEqual([]);

		await store.recoverDeletes();
		const afterRetry = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { pendingDeletes: unknown[] };
		expect(afterRetry.pendingDeletes).toEqual([]);
	});

	test("restart preserves a committed tombstone whose manifest names a different session", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const expectedId = sessionId("session-expected-delete");
		const otherId = sessionId("session-other-delete");
		const tombstoneName = ".omp-appserver-delete-mismatched";
		const tombstone = path.join(sessionsDir, tombstoneName);
		await fs.mkdir(tombstone, { mode: 0o700 });
		await fs.writeFile(
			path.join(tombstone, "manifest.json"),
			`${JSON.stringify({
				version: 1,
				sessionId: otherId,
				transcriptName: `${otherId}.jsonl`,
				artifactsName: otherId,
			})}\n`,
			{ mode: 0o600 },
		);
		await fs.writeFile(path.join(tombstone, `${otherId}.jsonl`), "must survive");
		await fs.mkdir(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
		await fs.writeFile(
			metadataPath,
			`${JSON.stringify({
				version: 1,
				archived: [],
				pendingDeletes: [{ sessionId: expectedId, tombstone: tombstoneName }],
			})}\n`,
			{ mode: 0o600 },
		);

		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir);
		await store.recoverDeletes();
		expect(await fs.readFile(path.join(tombstone, `${otherId}.jsonl`), "utf8")).toBe("must survive");
		const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
			pendingDeletes: Array<{ sessionId: string; tombstone: string }>;
		};
		expect(metadata.pendingDeletes).toEqual([{ sessionId: expectedId, tombstone: tombstoneName }]);
	});

	test("rejects a transcript reached through a symlink that escapes the sessions root", async () => {
		const { root, sessionsDir, metadataPath } = await fixture();
		const outside = path.join(root, "outside");
		await fs.mkdir(outside);
		const transcript = await writeSession(outside, "session-escape");
		const alias = path.join(sessionsDir, "-alias");
		await fs.symlink(outside, alias, "dir");
		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir);
		await expect(
			store.deleteSession(sessionId("session-escape"), path.join(alias, path.basename(transcript))),
		).rejects.toThrow(/symlink|outside/);
		expect(await fs.readFile(transcript, "utf8")).toContain("session-escape");
		expect(await fs.readFile(path.join(transcript.slice(0, -6), "artifact.txt"), "utf8")).toBe("artifact");
	});

	test("a persistent lock release failure after archive commit is surfaced without reversing metadata", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-archive-release-failure");
		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir, {
			acquireLock: acquireLockWithPersistentReleaseFailure,
		});
		const id = sessionId("session-archive-release-failure");
		await expect(store.archiveSession(id, "2026-07-13T12:34:56.000Z", transcript)).rejects.toMatchObject({
			committed: true,
			operation: "archive",
		});
		expect((await store.archivedSessions()).get(id)).toBe("2026-07-13T12:34:56.000Z");
		expect(await fs.stat(lockPathForSession(transcript))).toBeDefined();
		const competitor = await acquireCompetitorEventually(transcript);
		competitor.release();
		await expect(fs.stat(lockPathForSession(transcript))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a persistent lock release failure after restore commit is surfaced and managed to completion", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-restore-release-failure");
		const id = sessionId("session-restore-release-failure");
		const initial = new AppserverSessionLifecycleStore(metadataPath, sessionsDir);
		await initial.archiveSession(id, "2026-07-13T12:34:56.000Z", transcript);
		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir, {
			acquireLock: acquireLockWithPersistentReleaseFailure,
		});

		await expect(store.restoreSession(id, transcript)).rejects.toMatchObject({
			committed: true,
			operation: "restore",
		});
		expect((await store.archivedSessions()).has(id)).toBe(false);
		const competitor = await acquireCompetitorEventually(transcript);
		competitor.release();
	});

	test("a primary lifecycle failure remains first while its failed lock release is managed", async () => {
		const { root, sessionsDir } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-primary-release-failure");
		const invalidMetadataPath = path.join(root, "metadata-directory");
		await fs.mkdir(invalidMetadataPath);
		const store = new AppserverSessionLifecycleStore(invalidMetadataPath, sessionsDir, {
			acquireLock: acquireLockWithPersistentReleaseFailure,
		});

		let failure: unknown;
		try {
			await store.archiveSession(
				sessionId("session-primary-release-failure"),
				"2026-07-13T12:34:56.000Z",
				transcript,
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		if (!(failure instanceof AggregateError)) throw new Error("expected aggregate lifecycle failure");
		expect(String(failure.errors[0])).toContain("EISDIR");
		expect(String(failure.errors[1])).toContain("injected persistent release failure");
		const competitor = await acquireCompetitorEventually(transcript);
		competitor.release();
	});

	test("a persistent lock release failure after deletion commit is surfaced and restart cleanup preserves truth", async () => {
		const { sessionsDir, metadataPath } = await fixture();
		const transcript = await writeSession(sessionsDir, "session-release-failure");
		const store = new AppserverSessionLifecycleStore(metadataPath, sessionsDir, {
			acquireLock: acquireLockWithPersistentReleaseFailure,
		});
		await expect(store.deleteSession(sessionId("session-release-failure"), transcript)).rejects.toMatchObject({
			committed: true,
			operation: "delete",
		});
		await expect(fs.stat(transcript)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(transcript.slice(0, -6))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.stat(lockPathForSession(transcript))).toBeDefined();
		let metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { pendingDeletes: unknown[] };
		expect(metadata.pendingDeletes).toHaveLength(1);
		const competitor = await acquireCompetitorEventually(transcript);
		competitor.release();
		await store.recoverDeletes();
		metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { pendingDeletes: unknown[] };
		expect(metadata.pendingDeletes).toEqual([]);
	});
});
