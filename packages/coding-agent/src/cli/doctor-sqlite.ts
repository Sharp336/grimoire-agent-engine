/**
 * Per-database integrity probe and repair engine for `omp doctor`.
 *
 * Reads and repairs every omp-owned SQLite database. `probeDatabase` never
 * rejects: a doctor that dies on the first locked database reports nothing
 * about the rest. `repairDatabase` only runs under `--fix` and never deletes
 * a precious database — corruption is quarantined or rescued, data is kept.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { isSqliteBusyError } from "@oh-my-pi/pi-ai/auth-storage";
import {
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

export type DbRepairAction = "checkpointed" | "optimized" | "vacuumed" | "quarantined" | "rescued";

export interface DbRepair {
	label: string;
	path: string;
	actions: DbRepairAction[];
	bytesBefore: number;
	bytesAfter: number;
	/** Set when a repair was attempted and failed; the file is left untouched. */
	error: string | null;
	busy: boolean;
	/** Path the original was moved to by `quarantined` / `rescued`. */
	quarantinePath: string | null;
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
		const pageCount = handle.query("PRAGMA page_count").get() as { page_count: number } | null;
		const freelist = handle.query("PRAGMA freelist_count").get() as { freelist_count: number } | null;
		const pageSize = handle.query("PRAGMA page_size").get() as { page_size: number } | null;
		const journalMode = handle.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
		probe.pageCount = pageCount?.page_count ?? null;
		probe.freelistCount = freelist?.freelist_count ?? null;
		probe.pageSize = pageSize?.page_size ?? null;
		probe.journalMode = journalMode?.journal_mode ?? null;
		// quick_check, not integrity_check: integrity_check is O(database size) and doctor must stay bounded.
		const quickCheck = handle.query("PRAGMA quick_check(1)").get() as { quick_check: string } | null;
		probe.quickCheck = quickCheck?.quick_check ?? null;
		probe.foreignKeyViolations = handle.query("PRAGMA foreign_key_check").all().length;
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
			handle.run("PRAGMA wal_checkpoint(TRUNCATE)");
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
			handle.run("VACUUM");
			repair.actions.push("vacuumed");
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
	const quarantinePath = `${probe.path}.corrupt-${stamp}`;
	if (probe.policy === "regenerable") {
		// Caches rebuild on next use (model-cache.ts getDb, github-cache.ts openGithubCacheDb).
		try {
			await quarantineFiles(probe.path, quarantinePath);
			repair.actions.push("quarantined");
			repair.quarantinePath = quarantinePath;
		} catch (error) {
			repair.error = messageOf(error);
		}
		return;
	}
	const rescuePath = `${probe.path}.rescue-${stamp}`;
	try {
		const source = new Database(probe.path, { readonly: true });
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
			const row = copy.query("PRAGMA quick_check(1)").get() as { quick_check: string } | null;
			copyOk = row?.quick_check === "ok";
		} finally {
			copy.close();
		}
		if (!copyOk) throw new Error("rescue copy failed quick_check");
		await quarantineFiles(probe.path, quarantinePath);
		await fs.rename(rescuePath, probe.path);
		repair.actions.push("rescued");
		repair.quarantinePath = quarantinePath;
	} catch (error) {
		// A failed rescue leaves a partial copy; drop it so later runs start clean.
		try {
			await fs.rm(rescuePath, { force: true });
		} catch {
			// best effort; the rescue file is not precious
		}
		repair.error = `Rescue failed: ${messageOf(error)}`;
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
	if (probe.busy) {
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
