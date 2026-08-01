/**
 * Shared SQLite helpers for omp's local databases.
 *
 * The corruption classifier lives here (rather than beside any single store)
 * because every package that opens a SQLite file needs to tell unrecoverable
 * file damage apart from transient lock contention.
 */
import { Database } from "bun:sqlite";

/**
 * SQLite's unrecoverable-file result codes: the `SQLITE_CORRUPT` family plus
 * `SQLITE_NOTADB`. Unlike the BUSY family, retrying cannot help — the database
 * file itself is damaged, so callers latch off instead of backing off.
 */
export function isSqliteCorruptError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB");
}

export interface SqlitePragmaSettings {
	/** Open-only option; rejected here so open settings cannot silently flow into configure. */
	readonly?: never;
	/**
	 * Busy-handler timeout in milliseconds. Installed BEFORE any lock-taking
	 * statement (`journal_mode=WAL` acquires an exclusive lock during WAL
	 * recovery), per the issue-#2421 invariant. Default 5000.
	 */
	busyTimeoutMs?: number;
	/** Set `PRAGMA journal_mode = WAL` (writers on multi-process databases). Default false. */
	wal?: boolean;
	/** Set `PRAGMA foreign_keys = ON`. Default false (SQLite default). */
	foreignKeys?: boolean;
	/** Set `PRAGMA secure_delete = ON`. Default false. */
	secureDelete?: boolean;
	/** Set `PRAGMA synchronous = NORMAL`. Default false. */
	synchronousNormal?: boolean;
}

export interface SqliteOpenSettings extends Omit<SqlitePragmaSettings, "readonly"> {
	/** Open read-only. Default false. */
	readonly?: boolean;
}

/**
 * Install pragmas on an existing handle, in an order that honours the
 * issue-#2421 invariant: the busy handler always runs first, non-locking
 * pragmas next, and `journal_mode = WAL` (which takes an exclusive lock
 * during recovery) last.
 */
export function configureSqliteDatabase(db: Database, settings: SqlitePragmaSettings = {}): void {
	const busyTimeoutMs = settings.busyTimeoutMs ?? 5000;
	// Interpolated into SQL (PRAGMA takes no bind parameters), so reject
	// anything that cannot fit the native sqlite3_busy_timeout(int) contract
	// before it reaches the statement.
	if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 2_147_483_647) {
		throw new RangeError(`busyTimeoutMs must be an integer in [0, 2147483647], got ${busyTimeoutMs}`);
	}
	db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
	if (settings.foreignKeys) db.run("PRAGMA foreign_keys = ON");
	if (settings.secureDelete) db.run("PRAGMA secure_delete = ON");
	if (settings.wal) db.run("PRAGMA journal_mode = WAL");
	if (settings.synchronousNormal) db.run("PRAGMA synchronous = NORMAL");
}

/**
 * Open and configure a SQLite database in one call.
 *
 * Does NOT create the parent directory: each store owns its directory mode
 * (e.g. 0o700 for credential stores) and must create it beforehand.
 *
 * Total at the resource boundary: returns one fully configured live
 * connection, or — when any pragma fails — closes the handle and rethrows,
 * leaving no open handle behind.
 */
export function openSqliteDatabase(dbPath: string, settings: SqliteOpenSettings = {}): Database {
	const { readonly, ...pragmas } = settings;
	const db = readonly ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
	try {
		configureSqliteDatabase(db, pragmas);
	} catch (err) {
		db.close();
		throw err;
	}
	return db;
}
