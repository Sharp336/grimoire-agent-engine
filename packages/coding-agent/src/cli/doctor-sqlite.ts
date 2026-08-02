/**
 * Per-database integrity probe and repair engine for `omp doctor`.
 *
 * Reads and repairs every omp-owned SQLite database. `probeDatabase` never
 * rejects: a doctor that dies on the first locked database reports nothing
 * about the rest. `repairDatabase` only runs under `--fix` and never destroys
 * data: before any non-transactional file surgery the database trio is
 * archived with a verified content snapshot, the swap of a rebuilt candidate
 * is marker-backed so a crash mid-swap rolls back on the next run, and
 * corruption salvage climbs a ladder (sqlite3 `.recover` rebuild first,
 * `VACUUM INTO` second) with the originals always preserved in the archive.
 * The quiescence/archive/marker protocol mirrors the proven design of
 * ~/.omp/agent/scripts/fix_sqlite_databases.py.
 */
import { constants, Database } from "bun:sqlite";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isSqliteBusyError } from "@oh-my-pi/pi-ai/auth-storage";
import {
	$which,
	getAgentDbPath,
	getAutoQaDbPath,
	getAutoresearchDir,
	getGithubCacheDbPath,
	getHistoryDbPath,
	getMemoriesDir,
	getModelDbPath,
	getStatsDbPath,
	isEnoent,
} from "@oh-my-pi/pi-utils";

/** Vacuum only when at least this share of pages is free. Exported for the doctor report's free-page warning. */
export const FREE_PAGE_VACUUM_RATIO = 0.25;
/** Vacuum only when the database is at least this large; rewriting smaller files costs more than it reclaims. */
const VACUUM_MIN_BYTES = 1_048_576;
/** Quiescence proof waits this long between the two content snapshots. */
const QUIESCENCE_WINDOW_MS = 200;
/** Suffixes for the database file and all its sidecars (WAL, shared-memory, rollback journal). */
const TRIO_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

/**
 * True when a database has enough free pages and is large enough that a VACUUM
 * reclaims more space than it costs. Exported so doctor-cli.ts uses one source
 * of truth for the free-page warning and the repair vacuum decision.
 */
export function vacuumEligible(probe: DbProbe): boolean {
	return (
		probe.pageCount !== null &&
		probe.pageCount > 0 &&
		probe.freelistCount !== null &&
		probe.freelistCount / probe.pageCount >= FREE_PAGE_VACUUM_RATIO &&
		probe.pageCount * (probe.pageSize ?? 0) >= VACUUM_MIN_BYTES
	);
}

export type DoctorDbPolicy = "precious" | "regenerable";

export interface DoctorDatabase {
	/** Display label, e.g. "agent.db" or "autoresearch/abc1234.db". */
	label: string;
	path: string;
	policy: DoctorDbPolicy;
}

export interface DbProbe {
	label: string;
	path: string;
	policy: DoctorDbPolicy;
	/** false when the file does not exist; the caller skips these entirely. */
	present: boolean;
	dbBytes: number;
	walBytes: number;
	/** null when the file could not be opened at all. */
	pageCount: number | null;
	freelistCount: number | null;
	pageSize: number | null;
	journalMode: string | null;
	/** "ok" when healthy; the raw first row otherwise; null when unopenable. */
	quickCheck: string | null;
	/** Count of `PRAGMA foreign_key_check` rows; 0 when no FK constraints. */
	foreignKeyViolations: number;
	/** Message from a failed open, or a BUSY-family failure during probing. */
	openError: string | null;
	busy: boolean;
}

export type DbRepairAction = "checkpointed" | "optimized" | "vacuumed" | "quarantined" | "rescued" | "salvaged";

export interface DbRepair {
	label: string;
	path: string;
	actions: DbRepairAction[];
	bytesBefore: number;
	bytesAfter: number;
	/** Set when a repair was attempted and failed; the file is left untouched. */
	error: string | null;
	busy: boolean;
	/** Where the originals were preserved: the verified archive dir (salvage/rescue) or the `.corrupt-*` path (quarantine). */
	quarantinePath: string | null;
}

export interface SwapRecovery {
	/** A marker from a crashed swap exists next to the database. */
	found: boolean;
	/** Set only when restoration was requested and succeeded. */
	restored: boolean;
	error: string | null;
}

interface TrioSnapshotEntry {
	name: string;
	size: number;
	hash: string;
}

/** Row shapes for the SQLite pragmas this engine reads; the column names are part of SQLite's documented interface. */
interface PragmaRow {
	page_count: number;
	freelist_count: number;
	page_size: number;
	journal_mode: string;
	quick_check: string;
	integrity_check: string;
	busy: number;
	log: number;
	checkpointed: number;
	n: number;
	name: string;
}

/** Error carrying a SQLite-style code so `isSqliteBusyError` classifies it without string matching. */
interface CodedError extends Error {
	code?: string;
}

/** Autoresearch database filenames under the state dir; a missing directory is normal, not an error. */
function listAutoresearchDatabases(): string[] {
	try {
		return Array.from(new Bun.Glob("*.db").scanSync({ cwd: getAutoresearchDir() })).sort();
	} catch {
		return [];
	}
}

/** Mnemopi databases under the agent-scoped memories tree; a missing directory yields no entries. */
function listMnemopiDatabases(agentDir: string | undefined): DoctorDatabase[] {
	const mnemopiDir = path.join(getMemoriesDir(agentDir), "mnemopi");
	const databases: DoctorDatabase[] = [
		{ label: "mnemopi/mnemopi.db", path: path.join(mnemopiDir, "mnemopi.db"), policy: "precious" },
	];
	try {
		for (const entry of new Bun.Glob("banks/*/mnemopi.db").scanSync({ cwd: mnemopiDir })) {
			databases.push({ label: `mnemopi/${entry}`, path: path.join(mnemopiDir, entry), policy: "precious" });
		}
	} catch {
		// missing mnemopi directory — no bank databases
	}
	return databases;
}

export function resolveDoctorDatabases(agentDir: string | undefined, scopedToAgentDir: boolean): DoctorDatabase[] {
	const databases: DoctorDatabase[] = [
		{ label: "agent.db", path: getAgentDbPath(agentDir), policy: "precious" },
		{ label: "history.db", path: getHistoryDbPath(agentDir), policy: "precious" },
		{ label: "models.db", path: getModelDbPath(agentDir), policy: "regenerable" },
	];
	// Mnemopi databases follow agentDir; always agent-scoped.
	databases.push(...listMnemopiDatabases(agentDir));
	if (scopedToAgentDir) return databases;
	// Root-scoped paths resolve through dirs.rootSubdir, which --agent-dir does
	// not redirect; only include them for a real (unscoped) run.
	databases.push(
		{ label: "stats.db", path: getStatsDbPath(), policy: "precious" },
		{ label: "autoqa.db", path: getAutoQaDbPath(), policy: "precious" },
		{ label: "cache/github-cache.db", path: getGithubCacheDbPath(), policy: "regenerable" },
	);
	for (const name of listAutoresearchDatabases()) {
		databases.push({ label: `autoresearch/${name}`, path: `${getAutoresearchDir()}/${name}`, policy: "precious" });
	}
	return databases;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** File size, or `fallback` when the file is missing or unreadable. */
async function statSizeOr(filePath: string, fallback: number): Promise<number> {
	try {
		return (await fs.stat(filePath)).size;
	} catch {
		return fallback;
	}
}

/** True only when the file exists; non-ENOENT errors (EACCES, EIO) propagate. */
async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** True when the file exists or is merely inaccessible; false only on ENOENT. Use when probing for optional files under partially-accessible dirs. */
async function fileExistsOr(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch (error) {
		return !isEnoent(error);
	}
}

/** wal_checkpoint reports a reader-blocked checkpoint in its result tuple instead of throwing; map it onto the BUSY classification. */
function busyError(message: string): Error {
	const error: CodedError = new Error(message);
	error.code = "SQLITE_BUSY";
	return error;
}

async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.SHA256();
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function fsyncFile(filePath: string): Promise<void> {
	const handle = await fs.open(filePath, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Directory fsync where the platform allows it; the rename is atomic regardless, so unsupported platforms degrade silently. */
async function fsyncDir(directory: string): Promise<void> {
	try {
		const handle = await fs.open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// best effort: some platforms cannot fsync a directory handle
	}
}

/** Content snapshot of the database file and all sidecars, skipping files that do not exist. */
async function snapshotTrio(dbPath: string): Promise<TrioSnapshotEntry[]> {
	const entries: TrioSnapshotEntry[] = [];
	for (const suffix of TRIO_SUFFIXES) {
		const file = `${dbPath}${suffix}`;
		try {
			const stat = await fs.stat(file);
			entries.push({ name: path.basename(file), size: stat.size, hash: await sha256File(file) });
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return entries;
}

function snapshotsEqual(left: TrioSnapshotEntry[], right: TrioSnapshotEntry[]): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => {
			const other = right[index];
			return (
				other !== undefined && entry.name === other.name && entry.size === other.size && entry.hash === other.hash
			);
		})
	);
}

/**
 * True when a FOREIGN process holds the database files open, false when
 * provably none do, null when the platform cannot answer (no `fuser`).
 * `fuser -s` is useless here: it reports exit 0 with an empty PID list even
 * when the only holder is this process, whose own probe handles legitimately
 * touch the file during a doctor run. Parse the PID list instead and exclude
 * ourselves; callers treat null as "proceed and let SQLite's locks decide".
 */
async function hasHolders(dbPath: string): Promise<boolean | null> {
	const fuser = $which("fuser");
	if (fuser === null) return null;
	const files: string[] = [];
	for (const suffix of TRIO_SUFFIXES) {
		const file = `${dbPath}${suffix}`;
		if (await fileExistsOr(file)) files.push(file);
	}
	if (files.length === 0) return false;
	const result = Bun.spawnSync([fuser, ...files]);
	if (result.exitCode !== 0 && result.exitCode !== 1) return null;
	const pids = result.stdout
		.toString()
		.split(/\s+/)
		.map(token => Number.parseInt(token, 10))
		.filter(pid => Number.isFinite(pid));
	return pids.some(pid => pid !== process.pid);
}

/** Quarantine a database and all its sidecars under one stamp; rolls partial moves back so the set never splits. */
async function quarantineFiles(dbPath: string, quarantinePath: string): Promise<void> {
	const moved: Array<readonly [string, string]> = [];
	try {
		for (const suffix of TRIO_SUFFIXES) {
			const from = `${dbPath}${suffix}`;
			const to = `${quarantinePath}${suffix}`;
			try {
				await fs.rename(from, to);
				moved.push([from, to]);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	} catch (error) {
		for (const [from, to] of moved) {
			try {
				await fs.rename(to, from);
			} catch {
				// keep the original failure; a rollback failure is secondary
			}
		}
		throw error;
	}
}

/** Copy the trio into a timestamped archive directory and prove the copy matches the expected snapshot. */
async function archiveTrio(dbPath: string, expected: TrioSnapshotEntry[]): Promise<string> {
	const archiveDir = path.join(
		path.dirname(dbPath),
		".omp-doctor-backups",
		`${path.basename(dbPath)}.${Date.now()}-${process.pid}`,
	);
	await fs.mkdir(archiveDir, { recursive: true });
	await fsyncDir(path.dirname(archiveDir));
	for (const entry of expected) {
		const copied = path.join(archiveDir, entry.name);
		await fs.copyFile(path.join(path.dirname(dbPath), entry.name), copied);
		await fsyncFile(copied);
	}
	await fsyncDir(archiveDir);
	const verify = await snapshotTrio(path.join(archiveDir, path.basename(dbPath)));
	if (!snapshotsEqual(verify, expected)) throw new Error("backup does not match the verified database snapshot");
	return archiveDir;
}

/** One trio member's staged restore: a fsynced staging file to rename over the target, or a target to remove when the archive lacks that sidecar. */
interface RestoreCommitEntry {
	target: string;
	/** Staging path to rename over the target; null when the archive lacks this sidecar and the target should be removed instead. */
	staging: string | null;
	remove: boolean;
}

/** A staged restore ready for synchronous commit: the directory to fsync and the per-member rename/remove plan. */
interface RestoreCommitPlan {
	directory: string;
	entries: RestoreCommitEntry[];
}

/**
 * Stage the trio restore: copy each archive member to a fsynced staging path
 * next to the target. Writes go to NEW staging files, never the live target,
 * so this is safe to run while a write lock is still held. Returns the plan
 * {@link commitRestoreFromArchive} renames into place synchronously after the
 * lock is released — the same close-before-rename protocol `swapInCandidate`
 * uses (Windows rejects replacing an open SQLite file). Cleans up partial
 * staging files on failure.
 */
async function stageRestoreFromArchive(dbPath: string, archiveDir: string): Promise<RestoreCommitPlan> {
	const directory = path.dirname(dbPath);
	const entries: RestoreCommitEntry[] = [];
	for (const suffix of TRIO_SUFFIXES) {
		const name = `${path.basename(dbPath)}${suffix}`;
		const source = path.join(archiveDir, name);
		const target = path.join(directory, name);
		let staging: string | null = null;
		try {
			staging = path.join(directory, `.${name}.restore-${process.pid}-${Date.now()}`);
			await fs.copyFile(source, staging);
			await fsyncFile(staging);
		} catch (error) {
			if (suffix !== "" && isEnoent(error)) {
				// The archive lacks this sidecar — remove the live target at commit.
				if (staging !== null) await fs.rm(staging, { force: true }).catch(() => undefined);
				entries.push({ target, staging: null, remove: true });
				continue;
			}
			if (staging !== null) await fs.rm(staging, { force: true }).catch(() => undefined);
			throw error;
		}
		entries.push({ target, staging, remove: false });
	}
	return { directory, entries };
}

/**
 * Synchronously commit a staged restore: rename each fsynced staging file
 * over its target (or remove absent sidecars), then fsync the directory. No
 * `await` between the caller's `releaseWriteLock` and these renames — the
 * microsecond gap is bounded by the re-check that proved no holders, matching
 * `swapInCandidate`'s close+renameSync protocol. Best-effort directory fsync
 * where the platform allows it; the rename is atomic regardless.
 */
function commitRestoreFromArchive(plan: RestoreCommitPlan): void {
	for (const entry of plan.entries) {
		if (entry.staging !== null) {
			fsSync.renameSync(entry.staging, entry.target);
		} else if (entry.remove) {
			try {
				fsSync.rmSync(entry.target, { force: true });
			} catch {
				// best effort — a missing sidecar is the intended end state
			}
		}
	}
	try {
		const handle = fsSync.openSync(plan.directory, "r");
		try {
			fsSync.fsyncSync(handle);
		} finally {
			fsSync.closeSync(handle);
		}
	} catch {
		// best effort: some platforms cannot fsync a directory handle
	}
}

function swapMarkerPath(dbPath: string): string {
	return path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.omp-doctor-swap.json`);
}

/**
 * Atomically swap a rebuilt candidate into place behind a crash marker.
 * Any failure after the marker lands restores the archived originals; a crash
 * leaves the marker for `recoverInterruptedSwap` on the next run.
 *
 * `lockHandle` holds a RESERVED write lock on the live database. Uniform on
 * ALL platforms: while the lock is held, run a fresh holder + main-file
 * re-check, retire sidecars, then release the lock (sync) and rename
 * (fsSync.renameSync) as a synchronous pair with no await between them —
 * a microsecond gap bounded by the re-check that just proved no holders,
 * the durable marker, and the armed rollback. No platform special case.
 * `expected` is the verified trio snapshot from before the lock was acquired.
 */
async function swapInCandidate(
	dbPath: string,
	candidate: string,
	archiveDir: string,
	lockHandle: Database | null,
	expected: TrioSnapshotEntry[],
): Promise<void> {
	const marker = swapMarkerPath(dbPath);
	// Resolve the archive path so a recovery run from a different cwd can find it.
	const resolvedArchive = path.resolve(archiveDir);
	await fs.writeFile(marker, JSON.stringify({ archive: resolvedArchive }), { flag: "wx" });
	// Fsync the marker FILE itself — fsyncing only the directory entry would
	// persist an empty/truncated marker on power loss, breaking rollback.
	await fsyncFile(marker);
	await fsyncDir(path.dirname(dbPath));
	const retired: string[] = [];
	// Capture the original file mode so a 0600 credentials-bearing database
	// does not become world-readable after the candidate (created with the
	// process umask) is renamed into place.
	let originalMode: number | null = null;
	try {
		originalMode = (await fs.stat(dbPath)).mode & 0o777;
	} catch {
		// original may not exist — the candidate's default mode is acceptable
	}
	let swapCommitted = false;
	let rollbackFailed = false;
	let markerRemovalError: Error | null = null;
	try {
		// Under-lock re-check: prove no writer appeared and the main file is
		// unchanged since quiescence. Sidecars are not yet retired, so the
		// full trio is comparable against `expected`.
		if (lockHandle !== null) {
			if ((await hasHolders(dbPath)) === true) throw new Error("database acquired a holder during swap; aborting");
			try {
				if (!snapshotsEqual(expected, await snapshotTrio(dbPath)))
					throw new Error("database changed during swap; aborting");
			} catch (error) {
				throw error instanceof Error ? error : new Error(messageOf(error));
			}
		}
		// Retire sidecars while the lock is still held.
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			const sidecar = `${dbPath}${suffix}`;
			try {
				const retiredPath = path.join(
					path.dirname(dbPath),
					`.${path.basename(sidecar)}.retired-${process.pid}-${Date.now()}`,
				);
				await fs.rename(sidecar, retiredPath);
				retired.push(retiredPath);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		await fsyncDir(path.dirname(dbPath));
		// Synchronous close + rename: microsecond gap, no await between.
		// The re-check just proved no holders; the marker is durable; rollback
		// is armed. This is uniform on all platforms — no rename-with-handle-
		// open attempt, no fallback, no platform special case.
		releaseWriteLock(lockHandle);
		lockHandle = null;
		fsSync.renameSync(candidate, dbPath);
		if (originalMode !== null) await fs.chmod(dbPath, originalMode);
		await fsyncDir(path.dirname(dbPath));
		const check = new Database(dbPath, { readonly: true });
		try {
			const row = check.query("PRAGMA integrity_check").get() as Pick<PragmaRow, "integrity_check"> | null;
			if (row?.integrity_check !== "ok") throw new Error("swapped database failed integrity_check");
		} finally {
			check.close();
		}
		// Record swap-committed state in the marker before attempting removal.
		// If removal fails, the marker still says swapped:true and recovery
		// will NOT restore the old archive over new commits.
		await fs.writeFile(marker, JSON.stringify({ archive: resolvedArchive, swapped: true }));
		await fsyncFile(marker);
		swapCommitted = true;
	} catch (error) {
		// Rollback uses the same close-before-rename protocol as the swap:
		// stage the archive copies (writes go to staging files, not the live
		// target), release the write lock, then rename synchronously. Renaming
		// over the live file while the lock handle is still open fails on
		// Windows (open SQLite file cannot be replaced).
		try {
			const rollbackPlan = await stageRestoreFromArchive(dbPath, archiveDir);
			releaseWriteLock(lockHandle);
			lockHandle = null;
			commitRestoreFromArchive(rollbackPlan);
		} catch (rollbackError) {
			rollbackFailed = true;
			throw new Error(
				`replacement failed and rollback failed; restore manually from ${archiveDir}: ${messageOf(rollbackError)}`,
			);
		}
		throw error;
	} finally {
		releaseWriteLock(lockHandle);
		for (const retiredPath of retired) await fs.rm(retiredPath, { force: true }).catch(() => undefined);
		// The marker is the durable pointer the next doctor run needs for
		// recovery. Clear it only after a verified swap (swapCommitted) or a
		// completed rollback — never when rollback failed, or the archive
		// pointer is lost in exactly the path that most needs it.
		if (!rollbackFailed) {
			try {
				await fs.rm(marker, { force: true });
				await fsyncDir(path.dirname(dbPath));
			} catch (error) {
				if (swapCommitted)
					markerRemovalError = new Error(
						`swap succeeded but swap marker could not be removed; the database is repaired but a stale marker remains at ${marker}: ${messageOf(error)}`,
					);
				// Rollback succeeded; a leftover marker without swapped:true causes
				// the next --fix to re-restore the same archive (a benign no-op).
			}
		}
	}
	if (markerRemovalError !== null) throw markerRemovalError;
}

/**
 * Handle a marker left by a crashed swap. Always reports whether a marker was
 * found; only restores when `restore` is true (a `--fix` run), so read-only
 * runs stay read-only.
 */
export async function recoverInterruptedSwap(db: DoctorDatabase, restore: boolean): Promise<SwapRecovery> {
	const marker = swapMarkerPath(db.path);
	let markerExists: boolean;
	try {
		markerExists = await pathExists(marker);
	} catch (error) {
		return { found: true, restored: false, error: `cannot check swap marker: ${messageOf(error)}` };
	}
	if (!markerExists) return { found: false, restored: false, error: null };
	if (!restore) return { found: true, restored: false, error: null };
	try {
		const payload: unknown = JSON.parse(await Bun.file(marker).text());
		if (
			payload === null ||
			typeof payload !== "object" ||
			!("archive" in payload) ||
			typeof payload.archive !== "string"
		) {
			throw new Error(`interrupted swap marker has no archive path: ${marker}`);
		}
		// If the swap was committed before the crash, the live database IS the
		// repaired candidate — do NOT restore the old archive over new commits.
		if ("swapped" in payload && payload.swapped === true) {
			await fs.rm(marker, { force: true });
			await fsyncDir(path.dirname(db.path));
			return { found: true, restored: false, error: null };
		}
		// Resolve relative archive paths against the marker's directory so a
		// recovery run from a different cwd can find the archive.
		const archiveDir = path.resolve(path.dirname(marker), payload.archive);
		const archivedMain = path.join(archiveDir, path.basename(db.path));
		if (!(await pathExists(archivedMain)))
			throw new Error(`interrupted swap archive is missing the database: ${archivedMain}`);
		// Gate the restore the same way the corrupt-repair path does: if a live
		// omp process holds the database, restoring would overwrite an inode
		// that process is still writing to. Report busy instead of restoring.
		if ((await hasHolders(db.path)) === true)
			return { found: true, restored: false, error: "database busy; close running omp sessions and re-run" };
		const before = await snapshotTrio(db.path);
		await Bun.sleep(QUIESCENCE_WINDOW_MS);
		if ((await hasHolders(db.path)) === true)
			return { found: true, restored: false, error: "database busy; close running omp sessions and re-run" };
		if (!snapshotsEqual(before, await snapshotTrio(db.path)))
			return { found: true, restored: false, error: "database changed during quiescence check" };
		// Hold a RESERVED write lock through the restore so no writer commits
		// between the quiescence proof and the file swap. If the file is not a
		// valid SQLite database (NOTADB), acquireWriteLock returns null — an
		// unopenable file can't take a SQLite lock, but a process may still
		// hold it open from before it became garbage. Gate on hasHolders:
		// proceed only when it returns exactly false. A `true` result refuses
		// as busy; a `null` result (fuser unavailable, e.g. macOS/Windows)
		// refuses as an unsupported repair naming the missing dependency.
		// BEGIN IMMEDIATE failures throw and are caught above (refuse).
		let lockHandle: Database | null = null;
		try {
			lockHandle = await acquireWriteLock(db.path);
		} catch {
			return { found: true, restored: false, error: "database busy; close running omp sessions and re-run" };
		}
		if (lockHandle === null) {
			let holders: boolean | null;
			try {
				holders = await hasHolders(db.path);
			} catch {
				holders = null;
			}
			// Distinguish "another process holds it" from "holder detection is
			// unavailable on this platform" (no fuser). The latter is an
			// unsupported repair, not a generic busy — surface what to install
			// so the dependency is actionable on every platform where this path
			// is used, not only where the tools-section warning mentions it.
			if (holders === true)
				return {
					found: true,
					restored: false,
					error: "database busy; close running omp sessions and re-run",
				};
			if (holders === null)
				return {
					found: true,
					restored: false,
					error: "holder detection unavailable on this platform (fuser not found); install psmisc or close all omp sessions and re-run — automatic recovery of an unopenable database is unsupported without holder detection",
				};
		}
		// Stage the archive copies while the lock is held (writes go to staging
		// files, not the live target), then release the lock and commit the
		// rename synchronously — the same close-before-rename protocol
		// swapInCandidate uses. Renaming over the live file while the lock
		// handle is still open fails on Windows (open SQLite file cannot be
		// replaced); no reopen, no await between release and rename.
		try {
			const restorePlan = await stageRestoreFromArchive(db.path, archiveDir);
			releaseWriteLock(lockHandle);
			lockHandle = null;
			commitRestoreFromArchive(restorePlan);
		} finally {
			releaseWriteLock(lockHandle);
		}
		await fs.rm(marker, { force: true });
		await fsyncDir(path.dirname(db.path));
		return { found: true, restored: true, error: null };
	} catch (error) {
		return { found: true, restored: false, error: messageOf(error) };
	}
}

/**
 * Write a `.recover` dump of `workDb` to `dumpPath`. Prefers `--ignore-freelist`
 * (older sqlite3 builds reject it — CI runners ship one); on an
 * "unexpected option" rejection, truncates the partial dump and retries plain
 * `.recover`. Plain recovery can resurrect deleted rows from freelist pages,
 * but those land in lost_and_found, which the stranded-rows guard in
 * `salvageViaRecover` refuses to swap in — fidelity is enforced either way.
 */
async function runRecoverDump(sqlite: string, workDb: string, dumpPath: string): Promise<void> {
	for (const recoverCommand of [".recover --ignore-freelist", ".recover"]) {
		await fs.rm(dumpPath, { force: true }).catch(() => undefined);
		const recover = Bun.spawn([sqlite, workDb, recoverCommand], {
			stdout: Bun.file(dumpPath),
			stderr: "pipe",
		});
		// Drain stderr concurrently with awaiting exit: a large dump can
		// produce more stderr than the pipe buffer holds, and awaiting exit
		// before draining deadlocks the process on stderr write.
		const [stderr, exitCode] = await Promise.all([
			new Response(recover.stderr as ReadableStream<Uint8Array>).text(),
			recover.exited,
		]);
		if (exitCode === 0) {
			if ((await fs.stat(dumpPath)).size === 0) throw new Error("sqlite .recover produced no SQL");
			return;
		}
		if (!/unexpected option/i.test(stderr)) {
			throw new Error(`sqlite .recover failed: ${stderr.trim().slice(0, 300)}`);
		}
		// older sqlite3 without --ignore-freelist; fall through to the plain form
	}
	throw new Error("sqlite .recover failed: CLI rejects --ignore-freelist and plain form");
}

/** Result of probing whether the installed sqlite3 CLI can `.recover` a corrupted database. */
export interface SqliteRecoverCapability {
	available: boolean;
	detail: string;
}

let recoverCapabilityCache: SqliteRecoverCapability | null = null;

/**
 * Probe whether the installed sqlite3 CLI can `.recover` a deliberately
 * corrupted fixture database. Memoized so the cost is paid once per process.
 * doctor-cli.ts consumes this export for a tools-section finding.
 */
export async function probeSqliteRecoverCapability(): Promise<SqliteRecoverCapability> {
	if (recoverCapabilityCache !== null) return recoverCapabilityCache;
	const sqlite = $which("sqlite3");
	if (sqlite === null) {
		recoverCapabilityCache = { available: false, detail: "sqlite3 CLI not found" };
		return recoverCapabilityCache;
	}
	const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-doctor-cap-"));
	try {
		const fixtureDb = path.join(workDir, "fixture.db");
		const db = new Database(fixtureDb);
		db.run("PRAGMA journal_mode=DELETE");
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
		db.run("INSERT INTO t (v) VALUES ('hello')");
		db.close();
		// Corrupt a page past the header (bytes [4096, 6144)) — never touch
		// the first 100 bytes or the file becomes unopenable.
		const fd = await fs.open(fixtureDb, "r+");
		await fd.write(Buffer.alloc(2048, 0xff), 0, 2048, 4096);
		await fd.close();
		const dumpPath = path.join(workDir, "recovery.sql");
		const recover = Bun.spawn([sqlite, fixtureDb, ".recover"], {
			stdout: Bun.file(dumpPath),
			stderr: "pipe",
		});
		// Drain stderr concurrently with exit to avoid a pipe-buffer deadlock
		// when the corrupt fixture produces more stderr than the buffer holds.
		const [stderr, exitCode] = await Promise.all([
			new Response(recover.stderr as ReadableStream<Uint8Array>).text(),
			recover.exited,
		]);
		const dumpSize = await statSizeOr(dumpPath, 0);
		if (exitCode === 0 && dumpSize > 0) {
			recoverCapabilityCache = { available: true, detail: "sqlite3 .recover available" };
		} else {
			recoverCapabilityCache = {
				available: false,
				detail: `sqlite3 .recover failed on test fixture: ${stderr.trim().slice(0, 200) || `exit ${exitCode}`}`,
			};
		}
	} catch (error) {
		recoverCapabilityCache = { available: false, detail: `capability probe failed: ${messageOf(error)}` };
	} finally {
		await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
	return recoverCapabilityCache;
}
/**
 * Validate a rescue/salvage candidate before swapping it in: full
 * `integrity_check` plus `pragma_foreign_key_check`. Both the `.recover` and
 * `VACUUM INTO` rescue paths call this — a candidate that drops or omits a
 * parent row can pass `quick_check`/`integrity_check` alone while carrying
 * relational corruption. Throws on any violation; the caller refuses the
 * swap and keeps the archive.
 */
function validateCandidate(candidatePath: string): void {
	const check = new Database(candidatePath, { readonly: true });
	try {
		check.run("PRAGMA busy_timeout = 5000");
		const integrity = check.query("PRAGMA integrity_check").get() as Pick<PragmaRow, "integrity_check"> | null;
		if (integrity?.integrity_check !== "ok") throw new Error("candidate failed integrity_check");
		const fkCount = check.query("SELECT count(*) AS n FROM pragma_foreign_key_check").get() as Pick<
			PragmaRow,
			"n"
		> | null;
		if ((fkCount?.n ?? 0) > 0) throw new Error(`candidate has ${fkCount?.n ?? 0} foreign-key violations`);
	} finally {
		check.close();
	}
}
async function salvageViaRecover(dbPath: string, archiveDir: string): Promise<string> {
	const sqlite = $which("sqlite3");
	if (sqlite === null) throw new Error("sqlite3 CLI not found for .recover salvage");
	const cap = await probeSqliteRecoverCapability();
	if (!cap.available) throw new Error(`sqlite3 CLI cannot recover on this system (${cap.detail})`);
	const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-doctor-salvage-"));
	try {
		const archivedMain = path.join(archiveDir, path.basename(dbPath));
		const workDb = path.join(workDir, path.basename(dbPath));
		await fs.copyFile(archivedMain, workDb);
		if (await fileExistsOr(`${archivedMain}-wal`)) await fs.copyFile(`${archivedMain}-wal`, `${workDb}-wal`);
		const dumpPath = path.join(workDir, "recovery.sql");
		await runRecoverDump(sqlite, workDb, dumpPath);
		const candidate = path.join(workDir, "candidate.db");
		const load = Bun.spawn([sqlite, candidate], { stdin: Bun.file(dumpPath), stderr: "pipe" });
		// Drain stderr concurrently with exit: a large damaged recovery dump
		// can produce more stderr than the pipe buffer holds, and awaiting
		// exit before draining deadlocks the process on stderr write.
		const [stderr, exitCode] = await Promise.all([
			new Response(load.stderr as ReadableStream<Uint8Array>).text(),
			load.exited,
		]);
		if (exitCode !== 0) {
			throw new Error(`recovery SQL could not load: ${stderr.trim().slice(0, 300)}`);
		}
		// Salvage-specific checks: schema presence and stranded rows. The
		// shared integrity + FK gate runs via validateCandidate below.
		const check = new Database(candidate, { readonly: true });
		try {
			const schema = check.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as Pick<
				PragmaRow,
				"n"
			>;
			if (schema.n === 0) throw new Error("salvage recovered no schema");
			// Rows that lost their table land in lost_and_found. A candidate with
			// stranded rows is a partial database: keep the dump for manual
			// salvage instead of silently installing it over the original.
			const tables = check.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Pick<
				PragmaRow,
				"name"
			>[];
			if (tables.some(table => table.name === "lost_and_found")) {
				const stranded = check.query("SELECT count(*) AS n FROM lost_and_found").get() as Pick<PragmaRow, "n">;
				if (stranded.n > 0) {
					const keptDump = path.join(archiveDir, "recovery.sql");
					await fs.copyFile(dumpPath, keptDump);
					throw new Error(
						`salvage left ${stranded.n} rows orphaned outside their tables; recovery dump preserved at ${keptDump}`,
					);
				}
			}
		} finally {
			check.close();
		}
		// Shared integrity + foreign-key gate (same as the VACUUM INTO fallback).
		// .recover can drop damaged parent rows while keeping child rows,
		// producing a relationally inconsistent candidate that passes
		// integrity_check alone. Refuse the swap when violations remain and
		// preserve the dump for manual salvage.
		try {
			validateCandidate(candidate);
		} catch (error) {
			const keptDump = path.join(archiveDir, "recovery.sql");
			await fs.copyFile(dumpPath, keptDump).catch(() => undefined);
			throw new Error(`${messageOf(error)}; recovery dump preserved at ${keptDump}`);
		}
		// Stage next to the target so the swap rename is same-filesystem.
		const staging = path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.salvage-${process.pid}-${Date.now()}`);
		await fs.copyFile(candidate, staging);
		await fsyncFile(staging);
		return staging;
	} finally {
		await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** `VACUUM INTO` a verified copy of a corrupt-but-openable database. Cheaper than `.recover` when it works. */
async function vacuumIntoRescue(dbPath: string): Promise<string> {
	const rescuePath = path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.rescue-${process.pid}-${Date.now()}`);
	try {
		const source = new Database(dbPath, { readonly: true });
		try {
			source.run("PRAGMA busy_timeout = 5000");
			// VACUUM INTO takes no bind parameters; double single quotes in the path literal.
			source.run(`VACUUM INTO '${rescuePath.replaceAll("'", "''")}'`);
		} finally {
			source.close();
		}
		// Shared candidate gate: integrity_check + foreign_key_check. A
		// VACUUM INTO copy preserves orphaned child rows, so a rescue that
		// drops a parent row can pass quick_check while carrying relational
		// corruption — refuse the swap when FK violations remain, matching the
		// `.recover` path which calls the same helper.
		validateCandidate(rescuePath);
		await fsyncFile(rescuePath);
		return rescuePath;
	} catch (error) {
		await fs.rm(rescuePath, { force: true }).catch(() => undefined);
		throw error;
	}
}

/**
 * Acquire a RESERVED write lock (BEGIN IMMEDIATE) on the live database to
 * exclude concurrent writers during repair. Returns an open handle holding
 * the transaction, or null when the file does not exist (ENOENT) or is not
 * a valid SQLite database (SQLITE_NOTADB) — neither can have SQLite writers,
 * so the caller may proceed without a lock (gated by hasHolders). Throws on
 * EACCES, BUSY, or any other failure: exclusion is unavailable and the
 * caller must refuse.
 *
 * `new Database(path)` with default options CREATES a missing file. Opening
 * with `{ readwrite: true, create: false }` prevents that atomically (no
 * stat-then-open window). SQLite collapses all open failures into
 * SQLITE_CANTOPEN ("unable to open database file"), so a post-failure
 * `fs.stat` classifies the error: ENOENT → null, everything else → throw.
 * NOTADB surfaces at BEGIN IMMEDIATE (lazy open), not at the constructor.
 */
async function acquireWriteLock(dbPath: string): Promise<Database | null> {
	let handle: Database;
	try {
		handle = new Database(dbPath, { readwrite: true, create: false });
	} catch (error) {
		// CANTOPEN covers ENOENT, EACCES, EIO, … — classify via stat.
		if (isEnoent(await fs.stat(dbPath).catch(error2 => error2))) return null;
		throw error;
	}
	try {
		handle.run("PRAGMA busy_timeout = 2000");
		handle.run("BEGIN IMMEDIATE");
	} catch (error) {
		try {
			handle.close();
		} catch {
			// secondary to the lock failure
		}
		// bun:sqlite opens lazily: NOTADB surfaces here, not at the constructor.
		// A non-database file can't have SQLite writers → return null (holder-gated).
		if (/not a database/i.test(messageOf(error))) return null;
		// BUSY or any other failure on a real database → refuse.
		throw error;
	}
	return handle;
}

/** Roll back and close a handle returned by `acquireWriteLock`. */
function releaseWriteLock(handle: Database | null): void {
	if (handle === null) return;
	try {
		handle.run("ROLLBACK");
	} catch {
		// best effort — the lock is released on close regardless
	}
	try {
		handle.close();
	} catch {
		// best effort
	}
}
/**
 * Read the journal mode from the SQLite header (bytes 18-19): both `2` → WAL,
 * else non-WAL. Avoids opening a handle that would create WAL sidecars on a
 * cleanly closed database. Returns `"wal"`, `"non-wal"`, or `null` when the
 * header cannot be read (missing file or non-SQLite content).
 */
async function headerJournalMode(dbPath: string): Promise<"wal" | "non-wal" | null> {
	try {
		const handle = await fs.open(dbPath, "r");
		try {
			const buf = Buffer.alloc(2);
			await handle.read(buf, 0, 2, 18);
			return buf[0] === 2 && buf[1] === 2 ? "wal" : "non-wal";
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isEnoent(error)) return null;
		// A non-SQLite file or unreadable header → treat as non-WAL so the
		// normal read-only open is used (and fails with the real error).
		return "non-wal";
	}
}

export async function probeDatabase(db: DoctorDatabase): Promise<DbProbe> {
	const probe: DbProbe = {
		label: db.label,
		path: db.path,
		policy: db.policy,
		present: false,
		dbBytes: 0,
		walBytes: 0,
		pageCount: null,
		freelistCount: null,
		pageSize: null,
		journalMode: null,
		quickCheck: null,
		foreignKeyViolations: 0,
		openError: null,
		busy: false,
	};
	try {
		probe.dbBytes = (await fs.stat(db.path)).size;
	} catch (error) {
		if (isEnoent(error)) return probe;
		// A non-ENOENT stat failure (EACCES, EIO, …) means the file exists but
		// is inaccessible — report it as present-but-broken, not as absent, so
		// the collector surfaces it instead of silently skipping it.
		probe.present = true;
		probe.openError = messageOf(error);
		return probe;
	}
	probe.present = true;
	probe.walBytes = await statSizeOr(`${db.path}-wal`, 0);
	let handle: Database | null = null;
	// A cleanly closed WAL-mode database with sidecars removed gains -wal and
	// -shm when opened read-only via the default path, mutating the directory
	// and contradicting the read-only contract. When no -wal sidecar exists
	// and the header says WAL, open via an immutable URI instead — SQLite
	// creates no files and reads the main file directly. When a -wal sidecar
	// IS present, use the normal read-only open (the sidecars already exist,
	// so nothing new is created; immutable would ignore the WAL and read a
	// stale snapshot).
	const walSidecarExists = await fileExistsOr(`${db.path}-wal`);
	const headerMode = await headerJournalMode(db.path);
	const useImmutable = !walSidecarExists && headerMode === "wal";
	try {
		if (useImmutable) {
			// Percent-escape each path segment for SQLite URI form; immutable=1
			// tells SQLite the file cannot change, so it skips -wal/-shm creation.
			handle = new Database(
				"file:" + db.path.split(/[\\/]/).map(encodeURIComponent).join("/") + "?immutable=1",
				constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
			);
		} else {
			handle = new Database(db.path, { readonly: true });
		}
		// busy_timeout must precede the first lock-taking statement (issue #2421).
		handle.run("PRAGMA busy_timeout = 5000");
		const pageCount = handle.query("PRAGMA page_count").get() as Pick<PragmaRow, "page_count"> | null;
		const freelist = handle.query("PRAGMA freelist_count").get() as Pick<PragmaRow, "freelist_count"> | null;
		const pageSize = handle.query("PRAGMA page_size").get() as Pick<PragmaRow, "page_size"> | null;
		probe.pageCount = pageCount?.page_count ?? null;
		probe.freelistCount = freelist?.freelist_count ?? null;
		probe.pageSize = pageSize?.page_size ?? null;
		if (useImmutable) {
			// immutable=1 masks PRAGMA journal_mode (reports the default, not
			// WAL); the header already proved WAL, so report it directly.
			probe.journalMode = "wal";
		} else {
			const journalMode = handle.query("PRAGMA journal_mode").get() as Pick<PragmaRow, "journal_mode"> | null;
			probe.journalMode = journalMode?.journal_mode ?? null;
		}
		// quick_check performs a full table/index scan but returns only the
		// first error row — the (1) argument caps the result set, not the scan.
		// integrity_check is even heavier and unbounded in result rows; doctor
		// stays bounded by using quick_check and capping its output.
		const quickCheck = handle.query("PRAGMA quick_check(1)").get() as Pick<PragmaRow, "quick_check"> | null;
		probe.quickCheck = quickCheck?.quick_check ?? null;
		// Count FK violations inside SQLite instead of materializing every row;
		// the table-valued form is available in SQLite ≥ 3.16 (bun:sqlite ≥ 3.40).
		const fkCount = handle.query("SELECT count(*) AS n FROM pragma_foreign_key_check").get() as Pick<
			PragmaRow,
			"n"
		> | null;
		probe.foreignKeyViolations = fkCount?.n ?? 0;
	} catch (error) {
		probe.openError = messageOf(error);
		probe.busy = isSqliteBusyError(error);
	} finally {
		handle?.close();
	}
	return probe;
}

async function repairHealthyDatabase(probe: DbProbe, repair: DbRepair): Promise<void> {
	let handle: Database | null = null;
	try {
		handle = new Database(probe.path);
		handle.run("PRAGMA busy_timeout = 5000");
		if (probe.walBytes > 0) {
			const checkpoint = handle.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as Pick<
				PragmaRow,
				"busy" | "log" | "checkpointed"
			> | null;
			if (checkpoint === null || checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
				throw busyError("WAL checkpoint incomplete");
			}
			repair.actions.push("checkpointed");
		}
		// optimize analyzes only tables with stale statistics, replacing a blind ANALYZE.
		handle.run("PRAGMA optimize");
		repair.actions.push("optimized");
		if (vacuumEligible(probe)) {
			// VACUUM is transactional: a crash leaves the original intact, so no archive is taken on this path.
			handle.run("VACUUM");
			repair.actions.push("vacuumed");
			const integrity = handle.query("PRAGMA integrity_check").get() as Pick<PragmaRow, "integrity_check"> | null;
			if (integrity?.integrity_check !== "ok") throw new Error("database failed integrity_check after VACUUM");
		}
	} catch (error) {
		if (isSqliteBusyError(error)) repair.busy = true;
		else repair.error = messageOf(error);
	} finally {
		handle?.close();
	}
}

async function repairCorruptDatabase(probe: DbProbe, repair: DbRepair): Promise<void> {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	if (probe.policy === "regenerable") {
		// Caches rebuild on next use (model-cache.ts getDb, github-cache.ts openGithubCacheDb).
		const quarantinePath = `${probe.path}.corrupt-${stamp}`;
		try {
			await quarantineFiles(probe.path, quarantinePath);
			repair.actions.push("quarantined");
			repair.quarantinePath = quarantinePath;
		} catch (error) {
			repair.error = messageOf(error);
		}
		return;
	}
	// Precious: prove the file is offline and stable, archive with a verified
	// content snapshot, then climb the salvage ladder under a RESERVED write
	// lock that excludes concurrent writers. The originals stay in the archive
	// no matter how the swap ends.
	if ((await hasHolders(probe.path)) === true) {
		repair.busy = true;
		return;
	}
	let expected: TrioSnapshotEntry[];
	try {
		expected = await snapshotTrio(probe.path);
	} catch (error) {
		repair.error = messageOf(error);
		return;
	}
	await Bun.sleep(QUIESCENCE_WINDOW_MS);
	if ((await hasHolders(probe.path)) === true) {
		repair.busy = true;
		return;
	}
	try {
		if (!snapshotsEqual(expected, await snapshotTrio(probe.path))) {
			repair.error = "database changed while checking quiescence";
			return;
		}
	} catch (error) {
		repair.error = messageOf(error);
		return;
	}
	// Hold a RESERVED write lock from the quiescence proof through the entire
	// swap (marker, sidecar retirement, rename, verify). swapInCandidate
	// releases the lock in its finally. If BEGIN IMMEDIATE fails, the throw
	// is caught below (busy/error, refuse). A null lock (unopenable file)
	// gates on hasHolders: proceed only when exactly false; true or
	// unavailable → refuse (a process may hold the file open from before it
	// became garbage).
	let lockHandle: Database | null = null;
	try {
		lockHandle = await acquireWriteLock(probe.path);
	} catch (error) {
		if (isSqliteBusyError(error)) {
			repair.busy = true;
			return;
		}
		repair.error = messageOf(error);
		return;
	}
	if (lockHandle === null) {
		let holders: boolean | null;
		try {
			holders = await hasHolders(probe.path);
		} catch {
			holders = null;
		}
		// Distinguish "another process holds it" from "holder detection
		// unavailable on this platform" (no fuser). The latter is an
		// unsupported repair, not a generic busy — surface the missing
		// dependency so it is actionable wherever this path runs.
		if (holders === true) {
			repair.busy = true;
			repair.error = "database busy; close running omp sessions and re-run";
			return;
		}
		if (holders === null) {
			repair.error =
				"holder detection unavailable on this platform (fuser not found); install psmisc or close all omp sessions and re-run — automatic repair of an unopenable database is unsupported without holder detection";
			return;
		}
	}
	try {
		let archiveDir: string;
		try {
			archiveDir = await archiveTrio(probe.path, expected);
		} catch (error) {
			repair.error = messageOf(error);
			return;
		}
		repair.quarantinePath = archiveDir;
		let salvageError: string | null = null;
		let candidate: string | null = null;
		// Salvage ladder: .recover first, VACUUM INTO second. Build the
		// candidate under the lock, then re-validate and release before swap.
		try {
			candidate = await salvageViaRecover(probe.path, archiveDir);
		} catch (error) {
			salvageError = messageOf(error);
		}
		if (candidate === null) {
			try {
				candidate = await vacuumIntoRescue(probe.path);
			} catch (error) {
				repair.error = `Salvage failed: ${salvageError ?? "not attempted"}; rescue failed: ${messageOf(error)}`;
				return;
			}
		}
		// Belt-and-braces: re-snapshot under the lock. The lock should prevent
		// any change; if the snapshot differs, abort without swapping.
		try {
			if (!snapshotsEqual(expected, await snapshotTrio(probe.path))) {
				repair.error = "database changed during repair despite write lock";
				return;
			}
		} catch (error) {
			repair.error = messageOf(error);
			return;
		}
		// Hold the lock through the entire swap: marker write, sidecar
		// retirement, rename, and verify. swapInCandidate releases the lock
		// in its finally (or closes it on Windows rename retry).
		const swapLockHandle = lockHandle;
		lockHandle = null;
		try {
			await swapInCandidate(probe.path, candidate, archiveDir, swapLockHandle, expected);
			repair.actions.push(salvageError === null ? "salvaged" : "rescued");
			candidate = null;
		} catch (error) {
			repair.error = messageOf(error);
		} finally {
			if (candidate !== null) await fs.rm(candidate, { force: true }).catch(() => undefined);
		}
	} finally {
		releaseWriteLock(lockHandle);
	}
}

/**
 * Open the database read-write with a busy_timeout so SQLite can roll back a
 * hot rollback journal left by a crash. A read-only probe fails with
 * SQLITE_READONLY on a hot journal and gets misclassified as corrupt; this
 * lets the repair path recover the journal data before attempting salvage.
 * Returns true when the open succeeded (journal rolled back or none present).
 */
async function rollbackHotJournal(dbPath: string): Promise<boolean> {
	let handle: Database | null = null;
	try {
		handle = new Database(dbPath);
		handle.run("PRAGMA busy_timeout = 5000");
		// A trivial read triggers hot-journal rollback on open.
		handle.query("PRAGMA journal_mode").get();
		return true;
	} catch {
		return false;
	} finally {
		handle?.close();
	}
}

export async function repairDatabase(probe: DbProbe): Promise<DbRepair> {
	const repair: DbRepair = {
		label: probe.label,
		path: probe.path,
		actions: [],
		bytesBefore: probe.dbBytes,
		bytesAfter: probe.dbBytes,
		error: null,
		busy: false,
		quarantinePath: null,
	};
	if (!probe.present) return repair;
	if (probe.busy || (await hasHolders(probe.path)) === true) {
		repair.busy = true;
		return repair;
	}
	if (probe.quickCheck === "ok" && probe.openError === null) {
		await repairHealthyDatabase(probe, repair);
	} else {
		// A DELETE-journal database with a hot journal after a crash fails the
		// read-only probe (SQLITE_READONLY). Open read-write so SQLite rolls
		// back the journal, then re-probe before declaring corruption.
		if (await rollbackHotJournal(probe.path)) {
			const reprobed = await probeDatabase({ label: probe.label, path: probe.path, policy: probe.policy });
			if (reprobed.quickCheck === "ok" && reprobed.openError === null) {
				await repairHealthyDatabase(reprobed, repair);
				repair.bytesAfter = await statSizeOr(probe.path, repair.bytesBefore);
				return repair;
			}
			await repairCorruptDatabase(reprobed, repair);
		} else {
			await repairCorruptDatabase(probe, repair);
		}
	}
	repair.bytesAfter = await statSizeOr(probe.path, repair.bytesBefore);
	return repair;
}
