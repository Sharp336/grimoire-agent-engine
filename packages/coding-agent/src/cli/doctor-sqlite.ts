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

/** Result of scanning the autoresearch state directory for `*.db` files. */
export interface AutoresearchDatabaseScan {
	names: string[];
	/** Non-ENOENT failure while scanning; missing directory yields `null`. */
	error: string | null;
}

/**
 * Autoresearch database filenames under the state dir.
 * A missing directory is normal (empty list, no error). Permission/I/O failures
 * return an error string so the storage collector can emit a finding without
 * aborting other database probes.
 */
export function scanAutoresearchDatabases(): AutoresearchDatabaseScan {
	try {
		return {
			names: Array.from(new Bun.Glob("*.db").scanSync({ cwd: getAutoresearchDir() })).sort(),
			error: null,
		};
	} catch (error) {
		if (isEnoent(error)) return { names: [], error: null };
		return { names: [], error: messageOf(error) };
	}
}

/** Result of resolving known mnemopi databases under the agent-scoped memories tree. */
interface MnemopiDatabaseScan {
	databases: DoctorDatabase[];
	/** Non-ENOENT failure while scanning bank databases; missing directory yields `null`. */
	error: string | null;
}

/**
 * Mnemopi databases under the agent-scoped memories tree.
 * A missing directory is normal (top-level entry only, no error). Permission/I/O
 * failures scanning bank databases under banks/ return an error string so the
 * storage collector can emit a finding without aborting other database probes.
 */
function listMnemopiDatabases(agentDir: string | undefined): MnemopiDatabaseScan {
	const mnemopiDir = path.join(getMemoriesDir(agentDir), "mnemopi");
	const databases: DoctorDatabase[] = [
		{ label: "mnemopi/mnemopi.db", path: path.join(mnemopiDir, "mnemopi.db"), policy: "precious" },
	];
	try {
		for (const entry of new Bun.Glob("banks/*/mnemopi.db").scanSync({ cwd: mnemopiDir })) {
			databases.push({ label: `mnemopi/${entry}`, path: path.join(mnemopiDir, entry), policy: "precious" });
		}
		return { databases, error: null };
	} catch (error) {
		if (isEnoent(error)) return { databases, error: null };
		return { databases, error: messageOf(error) };
	}
}

/** Databases to probe plus optional discovery failures for optional/agent trees. */
export interface ResolvedDoctorDatabases {
	databases: DoctorDatabase[];
	/**
	 * Non-ENOENT failures discovering optional database trees (e.g. autoresearch, mnemopi banks).
	 * Present so the storage collector can emit an error finding and still probe
	 * every other database.
	 */
	discoveryErrors: Array<{ label: string; message: string }>;
}

export function resolveDoctorDatabases(
	agentDir: string | undefined,
	scopedToAgentDir: boolean,
): ResolvedDoctorDatabases {
	const databases: DoctorDatabase[] = [
		{ label: "agent.db", path: getAgentDbPath(agentDir), policy: "precious" },
		{ label: "history.db", path: getHistoryDbPath(agentDir), policy: "precious" },
		{ label: "models.db", path: getModelDbPath(agentDir), policy: "regenerable" },
	];
	const discoveryErrors: Array<{ label: string; message: string }> = [];
	// Mnemopi databases follow agentDir; always agent-scoped.
	const mnemopi = listMnemopiDatabases(agentDir);
	databases.push(...mnemopi.databases);
	if (mnemopi.error !== null) {
		discoveryErrors.push({ label: "mnemopi", message: mnemopi.error });
	}
	if (scopedToAgentDir) return { databases, discoveryErrors };
	// Root-scoped paths resolve through dirs.rootSubdir, which --agent-dir does
	// not redirect; only include them for a real (unscoped) run.
	databases.push(
		{ label: "stats.db", path: getStatsDbPath(), policy: "precious" },
		{ label: "autoqa.db", path: getAutoQaDbPath(), policy: "precious" },
		{ label: "cache/github-cache.db", path: getGithubCacheDbPath(), policy: "regenerable" },
	);
	const autoresearch = scanAutoresearchDatabases();
	if (autoresearch.error !== null) {
		discoveryErrors.push({ label: "autoresearch", message: autoresearch.error });
	} else {
		for (const name of autoresearch.names) {
			databases.push({
				label: `autoresearch/${name}`,
				path: `${getAutoresearchDir()}/${name}`,
				policy: "precious",
			});
		}
	}
	return { databases, discoveryErrors };
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
export async function fileExistsOr(filePath: string): Promise<boolean> {
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
	try {
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
	} catch (error) {
		await fs.rm(archiveDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
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

/** Durable crash marker written once before any destructive swap work. Never rewritten. */
interface SwapMarker {
	archive: string;
	/** Verified original trio snapshot (`snapshotTrio`) at marker publication. */
	source: TrioSnapshotEntry[];
	/** Candidate main-file identity after final mode, validation, and fsync. */
	candidateMain: { size: number; hash: string };
}

function isTrioMainEntry(entry: TrioSnapshotEntry, dbPath: string): boolean {
	return entry.name === path.basename(dbPath);
}

function mainEntryOf(entries: TrioSnapshotEntry[], dbPath: string): TrioSnapshotEntry | null {
	return entries.find(entry => isTrioMainEntry(entry, dbPath)) ?? null;
}

/** True when every live trio member is an exact archived original member; missing archived sidecars (retired) are allowed. */
function isRecognizedSourceSubset(live: TrioSnapshotEntry[], source: TrioSnapshotEntry[], dbPath: string): boolean {
	const sourceMain = mainEntryOf(source, dbPath);
	const liveMain = mainEntryOf(live, dbPath);
	if (sourceMain === null || liveMain === null) return false;
	if (liveMain.size !== sourceMain.size || liveMain.hash !== sourceMain.hash) return false;
	const sourceByName = new Map(source.map(entry => [entry.name, entry]));
	for (const entry of live) {
		if (isTrioMainEntry(entry, dbPath)) continue;
		const expected = sourceByName.get(entry.name);
		if (expected === undefined || expected.size !== entry.size || expected.hash !== entry.hash) return false;
	}
	return true;
}

function parseSwapMarker(payload: unknown, markerPath: string): { archive: string; modern: SwapMarker | null } {
	if (
		payload === null ||
		typeof payload !== "object" ||
		!("archive" in payload) ||
		typeof payload.archive !== "string"
	) {
		throw new Error(`interrupted swap marker has no archive path: ${markerPath}`);
	}
	const archive = payload.archive;
	if (!("source" in payload) || !("candidateMain" in payload)) return { archive, modern: null };
	const sourceRaw = payload.source;
	const candidateRaw = payload.candidateMain;
	if (!Array.isArray(sourceRaw) || candidateRaw === null || typeof candidateRaw !== "object") {
		return { archive, modern: null };
	}
	if (
		!("size" in candidateRaw) ||
		!("hash" in candidateRaw) ||
		typeof candidateRaw.size !== "number" ||
		typeof candidateRaw.hash !== "string"
	) {
		return { archive, modern: null };
	}
	const source: TrioSnapshotEntry[] = [];
	for (const entry of sourceRaw) {
		if (
			entry === null ||
			typeof entry !== "object" ||
			!("name" in entry) ||
			!("size" in entry) ||
			!("hash" in entry) ||
			typeof entry.name !== "string" ||
			typeof entry.size !== "number" ||
			typeof entry.hash !== "string"
		) {
			return { archive, modern: null };
		}
		source.push({ name: entry.name, size: entry.size, hash: entry.hash });
	}
	return {
		archive,
		modern: {
			archive,
			source,
			candidateMain: { size: candidateRaw.size, hash: candidateRaw.hash },
		},
	};
}

async function clearSwapMarker(marker: string, dbPath: string): Promise<void> {
	await fs.rm(marker, { force: true });
	await fsyncDir(path.dirname(dbPath));
}

function manualSwapRecoveryError(archiveDir: string, marker: string): string {
	return `interrupted swap left an unrecognized live database state; verify the live database then either keep it and remove ${marker}, or restore manually from ${archiveDir}`;
}

/**
 * Atomically swap a rebuilt candidate into place behind an immutable crash
 * marker that records the original trio snapshot and the candidate main-file
 * identity. Recovery classifies by those identities — never by rewriting a
 * `swapped` flag or by integrity_check alone.
 *
 * `lockHandle` holds a RESERVED write lock on the live database. Uniform on
 * ALL platforms: while the lock is held, run a fresh holder + trio re-check,
 * retire sidecars, then release the lock (sync) and rename
 * (fsSync.renameSync) as a synchronous pair with no await between them.
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
	const resolvedArchive = path.resolve(archiveDir);
	// Capture the original mode and apply it to the candidate before exposure
	// so a 0600 credentials-bearing database does not become world-readable
	// after the rename, and so the marker records the final candidate bytes.
	let originalMode: number | null = null;
	try {
		originalMode = (await fs.stat(dbPath)).mode & 0o777;
	} catch {
		// original may not exist — the candidate's default mode is acceptable
	}
	if (originalMode !== null) await fs.chmod(candidate, originalMode);
	validateCandidate(candidate);
	await fsyncFile(candidate);
	const candidateStat = await fs.stat(candidate);
	const candidateMain = { size: candidateStat.size, hash: await sha256File(candidate) };
	const markerPayload: SwapMarker = {
		archive: resolvedArchive,
		source: expected,
		candidateMain,
	};
	// One immutable wx publication before any retirement or rename. Never rewrite.
	await fs.writeFile(marker, JSON.stringify(markerPayload), { flag: "wx" });
	await fsyncFile(marker);
	await fsyncDir(path.dirname(dbPath));

	const retired: string[] = [];
	let swapCommitted = false;
	let lockReleased = false;
	let rollbackFailed = false;
	let retainMarker = false;
	let markerRemovalError: Error | null = null;
	try {
		// Under-lock re-check: prove no writer appeared and the trio is unchanged.
		if (lockHandle !== null) {
			if ((await hasHolders(dbPath)) === true) throw new Error("database acquired a holder during swap; aborting");
			try {
				if (!snapshotsEqual(expected, await snapshotTrio(dbPath)))
					throw new Error("database changed during swap; aborting");
			} catch (error) {
				throw error instanceof Error ? error : new Error(messageOf(error));
			}
		}
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
		releaseWriteLock(lockHandle);
		lockHandle = null;
		lockReleased = true;
		fsSync.renameSync(candidate, dbPath);
		await fsyncDir(path.dirname(dbPath));
		// Post-exposure verification must not roll the live path back — the
		// candidate may already have been opened. Leave the marker for
		// provenance-based recovery if verification fails.
		const check = new Database(dbPath, { readonly: true });
		try {
			const row = check.query("PRAGMA integrity_check").get() as Pick<PragmaRow, "integrity_check"> | null;
			if (row?.integrity_check !== "ok") throw new Error("swapped database failed integrity_check");
		} finally {
			check.close();
		}
		swapCommitted = true;
	} catch (error) {
		if (lockReleased) {
			// Rename was attempted (or the lock was already dropped). Do not
			// archive-restore over a potentially exposed live path.
			retainMarker = true;
			throw new Error(
				`replacement interrupted after lock release; marker retained for provenance recovery (${marker}); archive at ${resolvedArchive}: ${messageOf(error)}`,
			);
		}
		// Still exclusive under the write lock: exact-restore the archived trio.
		try {
			const rollbackPlan = await stageRestoreFromArchive(dbPath, archiveDir);
			releaseWriteLock(lockHandle);
			lockHandle = null;
			commitRestoreFromArchive(rollbackPlan);
			const restored = await snapshotTrio(dbPath);
			if (!snapshotsEqual(restored, expected)) {
				rollbackFailed = true;
				retainMarker = true;
				throw new Error(
					`replacement failed and rollback did not restore the verified snapshot; restore manually from ${archiveDir}`,
				);
			}
		} catch (rollbackError) {
			rollbackFailed = true;
			retainMarker = true;
			throw new Error(
				`replacement failed and rollback failed; restore manually from ${archiveDir}: ${messageOf(rollbackError)}`,
			);
		}
		throw error;
	} finally {
		releaseWriteLock(lockHandle);
		if (swapCommitted || (!retainMarker && !rollbackFailed)) {
			for (const retiredPath of retired) await fs.rm(retiredPath, { force: true }).catch(() => undefined);
		}
		// Clear the marker only after a verified swap or a completed under-lock
		// rollback. A post-exposure failure or failed rollback keeps it.
		if (!retainMarker && !rollbackFailed) {
			try {
				await fs.rm(marker, { force: true });
				await fsyncDir(path.dirname(dbPath));
			} catch (error) {
				if (swapCommitted)
					markerRemovalError = new Error(
						`swap succeeded but swap marker could not be removed; the database is repaired but a stale marker remains at ${marker}: ${messageOf(error)}`,
					);
			}
		}
	}
	if (markerRemovalError !== null) throw markerRemovalError;
}

/**
 * Handle a marker left by a crashed swap. Always reports whether a marker was
 * found; only restores when `restore` is true (a `--fix` run), so read-only
 * runs stay read-only. Classification uses marker provenance identities, never
 * integrity_check alone.
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
		const parsed = parseSwapMarker(JSON.parse(await Bun.file(marker).text()), marker);
		const archiveDir = path.resolve(path.dirname(marker), parsed.archive);
		const archivedMain = path.join(archiveDir, path.basename(db.path));
		if (!(await pathExists(archivedMain)))
			throw new Error(`interrupted swap archive is missing the database: ${archivedMain}`);

		const liveExists = await pathExists(db.path);
		if (!liveExists) {
			return {
				found: true,
				restored: false,
				error: `interrupted swap database main file is missing; automatic recovery cannot exclude a concurrent creator. Restore manually from ${archiveDir}; marker retained at ${marker}`,
			};
		}
		let decision: "restore" | "preserve" | "manual";
		if (parsed.modern === null) {
			// Older markers without identities: any live database is ambiguous.
			decision = "manual";
		} else {
			const live = await snapshotTrio(db.path);
			const liveMain = mainEntryOf(live, db.path);
			const sourceMain = mainEntryOf(parsed.modern.source, db.path);
			if (liveMain === null || sourceMain === null) {
				decision = "manual";
			} else if (
				liveMain.size === parsed.modern.candidateMain.size &&
				liveMain.hash === parsed.modern.candidateMain.hash &&
				(liveMain.size !== sourceMain.size || liveMain.hash !== sourceMain.hash)
			) {
				decision = "preserve";
			} else if (isRecognizedSourceSubset(live, parsed.modern.source, db.path)) {
				decision = "restore";
			} else {
				decision = "manual";
			}
		}

		if (decision === "preserve") {
			await clearSwapMarker(marker, db.path);
			return { found: true, restored: false, error: null };
		}
		if (decision === "manual") {
			return { found: true, restored: false, error: manualSwapRecoveryError(archiveDir, marker) };
		}

		// Modern restore: archive bytes must still match the recorded source.
		if (parsed.modern !== null) {
			const archiveSnap = await snapshotTrio(archivedMain);
			if (!snapshotsEqual(archiveSnap, parsed.modern.source)) {
				return {
					found: true,
					restored: false,
					error: `interrupted swap archive no longer matches the recorded source snapshot; restore manually from ${archiveDir}`,
				};
			}
		}

		if ((await hasHolders(db.path)) === true)
			return { found: true, restored: false, error: "database busy; close running omp sessions and re-run" };
		const before = await snapshotTrio(db.path);
		await Bun.sleep(QUIESCENCE_WINDOW_MS);
		if ((await hasHolders(db.path)) === true)
			return { found: true, restored: false, error: "database busy; close running omp sessions and re-run" };
		if (!snapshotsEqual(before, await snapshotTrio(db.path)))
			return { found: true, restored: false, error: "database changed during quiescence check" };

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

		// Recheck the classified snapshot under the recovery write lock so a
		// commit in the pre-lock gap cannot be overwritten.
		const lockedLive = await snapshotTrio(db.path);
		if (parsed.modern === null || !isRecognizedSourceSubset(lockedLive, parsed.modern.source, db.path)) {
			releaseWriteLock(lockHandle);
			return { found: true, restored: false, error: manualSwapRecoveryError(archiveDir, marker) };
		}

		try {
			const restorePlan = await stageRestoreFromArchive(db.path, archiveDir);
			releaseWriteLock(lockHandle);
			lockHandle = null;
			commitRestoreFromArchive(restorePlan);
		} finally {
			releaseWriteLock(lockHandle);
		}

		const restored = await snapshotTrio(db.path);
		if (parsed.modern !== null) {
			if (!snapshotsEqual(restored, parsed.modern.source)) {
				return {
					found: true,
					restored: false,
					error: `interrupted swap restore did not reproduce the recorded source trio; marker retained at ${marker}; archive at ${archiveDir}`,
				};
			}
		} else {
			const archiveSnap = await snapshotTrio(archivedMain);
			if (!snapshotsEqual(restored, archiveSnap)) {
				return {
					found: true,
					restored: false,
					error: `interrupted swap restore did not match the archive trio; marker retained at ${marker}; archive at ${archiveDir}`,
				};
			}
		}

		await clearSwapMarker(marker, db.path);
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
export async function headerJournalMode(dbPath: string): Promise<"wal" | "non-wal" | null> {
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

/**
 * Open a database read-only without mutating its directory. A cleanly closed
 * WAL-mode database with sidecars removed gains -wal and -shm when opened via
 * the default path; when no -wal sidecar exists and the header says WAL, open
 * through an immutable URI instead — SQLite creates no files. When a -wal
 * sidecar IS present, use the normal read-only open: immutable would ignore
 * committed WAL frames and read a stale snapshot. In the partial-sidecar
 * state (-wal without -shm — a crashed writer) that open recreates -shm;
 * this is deliberate: the -shm is a rebuildable index, recreating it is
 * SQLite's own recovery path, and the alternatives are worse (immutable
 * silently drops committed transactions; refusing blinds the doctor on the
 * database that most needs checking). An unwritable directory surfaces as
 * the open error, which the callers report. `immutable: true` also means
 * PRAGMA journal_mode is masked by SQLite — the header already proved WAL,
 * so callers should report it directly.
 */
export async function openReadonlyNonMutating(dbPath: string): Promise<{ handle: Database; immutable: boolean }> {
	const walSidecarExists = await fileExistsOr(`${dbPath}-wal`);
	const headerMode = await headerJournalMode(dbPath);
	const immutable = !walSidecarExists && headerMode === "wal";
	// Percent-escape each path segment for SQLite URI form; immutable=1 tells
	// SQLite the file cannot change, so it skips -wal/-shm creation.
	const handle = immutable
		? new Database(
				`file:${dbPath.split(/[\\/]/).map(encodeURIComponent).join("/")}?immutable=1`,
				constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
			)
		: new Database(dbPath, { readonly: true });
	return { handle, immutable };
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
	let immutable = false;
	try {
		({ handle, immutable } = await openReadonlyNonMutating(db.path));
		// busy_timeout must precede the first lock-taking statement (issue #2421).
		handle.run("PRAGMA busy_timeout = 5000");
		const pageCount = handle.query("PRAGMA page_count").get() as Pick<PragmaRow, "page_count"> | null;
		const freelist = handle.query("PRAGMA freelist_count").get() as Pick<PragmaRow, "freelist_count"> | null;
		const pageSize = handle.query("PRAGMA page_size").get() as Pick<PragmaRow, "page_size"> | null;
		probe.pageCount = pageCount?.page_count ?? null;
		probe.freelistCount = freelist?.freelist_count ?? null;
		probe.pageSize = pageSize?.page_size ?? null;
		if (immutable) {
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
		// Match acquireWriteLock: never create a replacement if the file vanished
		// between probe and repair.
		handle = new Database(probe.path, { readwrite: true, create: false });
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
	if (probe.policy === "regenerable") {
		// Rebuildable caches still preserve bytes first. The verified archive and
		// re-snapshot catch every change through the backup window; the final
		// gap before rename is deliberately best effort.
		let expected: TrioSnapshotEntry[];
		try {
			expected = await snapshotTrio(probe.path);
		} catch (error) {
			repair.error = messageOf(error);
			return;
		}
		if (mainEntryOf(expected, probe.path) === null) {
			repair.error = "database disappeared before backup";
			return;
		}
		let archiveDir: string;
		try {
			archiveDir = await archiveTrio(probe.path, expected);
		} catch (error) {
			repair.error = `backup failed, database left in place: ${messageOf(error)}`;
			return;
		}
		repair.quarantinePath = archiveDir;
		let current: TrioSnapshotEntry[];
		try {
			current = await snapshotTrio(probe.path);
		} catch (error) {
			repair.error = messageOf(error);
			return;
		}
		if (!snapshotsEqual(expected, current)) {
			repair.error = "database changed after the verified backup; not quarantined";
			return;
		}
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const quarantinePath = `${probe.path}.corrupt-${stamp}`;
		try {
			await quarantineFiles(probe.path, quarantinePath);
			repair.actions.push("quarantined");
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
		// Match acquireWriteLock / repairHealthyDatabase: a vanished path must not
		// create an empty database that looks like a successful journal rollback.
		handle = new Database(dbPath, { readwrite: true, create: false });
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
