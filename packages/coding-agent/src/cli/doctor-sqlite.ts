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
import { Database } from "bun:sqlite";
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

export function resolveDoctorDatabases(agentDir: string | undefined, scopedToAgentDir: boolean): DoctorDatabase[] {
	const databases: DoctorDatabase[] = [
		{ label: "agent.db", path: getAgentDbPath(agentDir), policy: "precious" },
		{ label: "history.db", path: getHistoryDbPath(agentDir), policy: "precious" },
		{ label: "models.db", path: getModelDbPath(agentDir), policy: "regenerable" },
	];
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

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
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

/** Content snapshot of the database trio (main, -wal, -shm), skipping files that do not exist. */
async function snapshotTrio(dbPath: string): Promise<TrioSnapshotEntry[]> {
	const entries: TrioSnapshotEntry[] = [];
	for (const suffix of ["", "-wal", "-shm"]) {
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
	for (const suffix of ["", "-wal", "-shm"]) {
		const file = `${dbPath}${suffix}`;
		if (await pathExists(file)) files.push(file);
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

/** Quarantine a database and its WAL companions under one stamp; rolls partial moves back so the trio never splits. */
async function quarantineFiles(dbPath: string, quarantinePath: string): Promise<void> {
	const moved: Array<readonly [string, string]> = [];
	try {
		for (const [from, to] of [
			[dbPath, quarantinePath],
			[`${dbPath}-wal`, `${quarantinePath}-wal`],
			[`${dbPath}-shm`, `${quarantinePath}-shm`],
		] as const) {
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

/** Restore the trio from a verified archive, removing sidecars the archive does not have. */
async function restoreFromArchive(dbPath: string, archiveDir: string): Promise<void> {
	const directory = path.dirname(dbPath);
	for (const suffix of ["", "-wal", "-shm"]) {
		const name = `${path.basename(dbPath)}${suffix}`;
		const source = path.join(archiveDir, name);
		const target = path.join(directory, name);
		try {
			const staging = path.join(directory, `.${name}.restore-${process.pid}-${Date.now()}`);
			await fs.copyFile(source, staging);
			await fsyncFile(staging);
			await fs.rename(staging, target);
		} catch (error) {
			if (suffix !== "" && isEnoent(error)) {
				await fs.rm(target, { force: true }).catch(() => undefined);
				continue;
			}
			throw error;
		}
	}
	await fsyncDir(directory);
}

function swapMarkerPath(dbPath: string): string {
	return path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.omp-doctor-swap.json`);
}

/**
 * Atomically swap a rebuilt candidate into place behind a crash marker.
 * Any failure after the marker lands restores the archived originals; a crash
 * leaves the marker for `recoverInterruptedSwap` on the next run.
 */
async function swapInCandidate(dbPath: string, candidate: string, archiveDir: string): Promise<void> {
	const marker = swapMarkerPath(dbPath);
	await fs.writeFile(marker, JSON.stringify({ archive: archiveDir }), { flag: "wx" });
	await fsyncDir(path.dirname(dbPath));
	const retired: string[] = [];
	// The marker is the only pointer back to the archive; clear it only once
	// the swap or a full rollback has succeeded, never after a failed rollback.
	let clearMarker = false;
	try {
		for (const suffix of ["-wal", "-shm"]) {
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
		await fs.rename(candidate, dbPath);
		await fsyncDir(path.dirname(dbPath));
		const check = new Database(dbPath, { readonly: true });
		try {
			const row = check.query("PRAGMA integrity_check").get() as Pick<PragmaRow, "integrity_check"> | null;
			if (row?.integrity_check !== "ok") throw new Error("swapped database failed integrity_check");
		} finally {
			check.close();
		}
		clearMarker = true;
	} catch (error) {
		try {
			await restoreFromArchive(dbPath, archiveDir);
			clearMarker = true;
		} catch (rollbackError) {
			throw new Error(
				`replacement failed and rollback failed; restore manually from ${archiveDir}: ${messageOf(rollbackError)}`,
			);
		}
		throw error;
	} finally {
		for (const retiredPath of retired) await fs.rm(retiredPath, { force: true }).catch(() => undefined);
		if (clearMarker) {
			await fs.rm(marker, { force: true }).catch(() => undefined);
			await fsyncDir(path.dirname(dbPath));
		}
	}
}

/**
 * Handle a marker left by a crashed swap. Always reports whether a marker was
 * found; only restores when `restore` is true (a `--fix` run), so read-only
 * runs stay read-only.
 */
export async function recoverInterruptedSwap(db: DoctorDatabase, restore: boolean): Promise<SwapRecovery> {
	const marker = swapMarkerPath(db.path);
	if (!(await pathExists(marker))) return { found: false, restored: false, error: null };
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
		const archivedMain = path.join(payload.archive, path.basename(db.path));
		if (!(await pathExists(archivedMain)))
			throw new Error(`interrupted swap archive is missing the database: ${archivedMain}`);
		await restoreFromArchive(db.path, payload.archive);
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
		const stderr = await new Response(recover.stderr as ReadableStream<Uint8Array>).text();
		if ((await recover.exited) === 0) {
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
async function salvageViaRecover(dbPath: string, archiveDir: string): Promise<string> {
	const sqlite = $which("sqlite3");
	if (sqlite === null) throw new Error("sqlite3 CLI not found for .recover salvage");
	const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-doctor-salvage-"));
	try {
		const archivedMain = path.join(archiveDir, path.basename(dbPath));
		const workDb = path.join(workDir, path.basename(dbPath));
		await fs.copyFile(archivedMain, workDb);
		if (await pathExists(`${archivedMain}-wal`)) await fs.copyFile(`${archivedMain}-wal`, `${workDb}-wal`);
		const dumpPath = path.join(workDir, "recovery.sql");
		await runRecoverDump(sqlite, workDb, dumpPath);
		const candidate = path.join(workDir, "candidate.db");
		const load = Bun.spawn([sqlite, candidate, `.read ${dumpPath}`], { stderr: "pipe" });
		if ((await load.exited) !== 0) {
			const stderr = await new Response(load.stderr as ReadableStream<Uint8Array>).text();
			throw new Error(`recovery SQL could not load: ${stderr.trim().slice(0, 300)}`);
		}
		const check = new Database(candidate, { readonly: true });
		try {
			const integrity = check.query("PRAGMA integrity_check").get() as Pick<PragmaRow, "integrity_check"> | null;
			if (integrity?.integrity_check !== "ok") throw new Error("salvaged candidate failed integrity_check");
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
		const copy = new Database(rescuePath, { readonly: true });
		let copyOk = false;
		try {
			copy.run("PRAGMA busy_timeout = 5000");
			const row = copy.query("PRAGMA quick_check(1)").get() as Pick<PragmaRow, "quick_check"> | null;
			copyOk = row?.quick_check === "ok";
		} finally {
			copy.close();
		}
		if (!copyOk) throw new Error("rescue copy failed quick_check");
		await fsyncFile(rescuePath);
		return rescuePath;
	} catch (error) {
		await fs.rm(rescuePath, { force: true }).catch(() => undefined);
		throw error;
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
	try {
		handle = new Database(db.path, { readonly: true });
		// busy_timeout must precede the first lock-taking statement (issue #2421).
		handle.run("PRAGMA busy_timeout = 5000");
		const pageCount = handle.query("PRAGMA page_count").get() as Pick<PragmaRow, "page_count"> | null;
		const freelist = handle.query("PRAGMA freelist_count").get() as Pick<PragmaRow, "freelist_count"> | null;
		const pageSize = handle.query("PRAGMA page_size").get() as Pick<PragmaRow, "page_size"> | null;
		const journalMode = handle.query("PRAGMA journal_mode").get() as Pick<PragmaRow, "journal_mode"> | null;
		probe.pageCount = pageCount?.page_count ?? null;
		probe.freelistCount = freelist?.freelist_count ?? null;
		probe.pageSize = pageSize?.page_size ?? null;
		probe.journalMode = journalMode?.journal_mode ?? null;
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
		const dbBytes = (probe.pageCount ?? 0) * (probe.pageSize ?? 0);
		if (
			probe.pageCount !== null &&
			probe.pageCount > 0 &&
			probe.freelistCount !== null &&
			probe.freelistCount / probe.pageCount >= FREE_PAGE_VACUUM_RATIO &&
			dbBytes >= VACUUM_MIN_BYTES
		) {
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
	// Precious: prove the file is offline and stable, archive the trio with a
	// verified content snapshot, then climb the salvage ladder. The originals
	// stay in the archive no matter how the swap ends.
	if ((await hasHolders(probe.path)) === true) {
		repair.busy = true;
		return;
	}
	const expected = await snapshotTrio(probe.path);
	await Bun.sleep(QUIESCENCE_WINDOW_MS);
	if ((await hasHolders(probe.path)) === true) {
		repair.busy = true;
		return;
	}
	if (!snapshotsEqual(expected, await snapshotTrio(probe.path))) {
		repair.error = "database changed while checking quiescence";
		return;
	}
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
	try {
		candidate = await salvageViaRecover(probe.path, archiveDir);
		await swapInCandidate(probe.path, candidate, archiveDir);
		repair.actions.push("salvaged");
		candidate = null;
	} catch (error) {
		salvageError = messageOf(error);
	} finally {
		if (candidate !== null) await fs.rm(candidate, { force: true }).catch(() => undefined);
	}
	if (repair.actions.length > 0) return;
	try {
		candidate = await vacuumIntoRescue(probe.path);
		await swapInCandidate(probe.path, candidate, archiveDir);
		repair.actions.push("rescued");
		candidate = null;
	} catch (error) {
		repair.error = `Salvage failed: ${salvageError ?? "not attempted"}; rescue failed: ${messageOf(error)}`;
	} finally {
		if (candidate !== null) await fs.rm(candidate, { force: true }).catch(() => undefined);
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
		await repairCorruptDatabase(probe, repair);
	}
	repair.bytesAfter = await statSizeOr(probe.path, repair.bytesBefore);
	return repair;
}
