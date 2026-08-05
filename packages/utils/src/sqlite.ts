/**
 * Shared SQLite helpers for omp's local databases.
 *
 * The corruption classifier lives here (rather than beside any single store)
 * because every package that opens a SQLite file needs to tell unrecoverable
 * file damage apart from transient lock contention.
 */
import { Database } from "bun:sqlite";
import { powershellQuote, shellQuote } from "./shell";

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
/**
 * SQLite's busy result code family — base `SQLITE_BUSY` plus the extended
 * variants `SQLITE_BUSY_RECOVERY` (concurrent WAL recovery), `SQLITE_BUSY_SNAPSHOT`,
 * and `SQLITE_BUSY_TIMEOUT`. All warrant the same backoff-and-retry treatment.
 */
export function isSqliteBusyError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

export interface SqliteRepairGuidanceOptions {
	/**
	 * Restrict recovered secret-store permissions: POSIX uses `umask 077`;
	 * Windows applies a current-user ACL after installation because there is no
	 * umask and the recovered file inherits the containing directory ACL.
	 */
	restrictPermissions?: boolean;
	/** Target shell platform. Defaults to the host platform. */
	platform?: NodeJS.Platform;
}

/**
 * Build copy-pasteable SQLite repair guidance that recovers, verifies, backs
 * up the original database and sidecars, then installs the repaired file.
 * POSIX guidance uses `umask` and `&&`-chained steps so failed recovery cannot
 * reach installation. Windows guidance targets PowerShell, where the recovered
 * file inherits the containing directory ACL; restricted credential stores add
 * an explicit current-user ACL after installation.
 */
export function sqliteRepairGuidance(dbPath: string | undefined, options: SqliteRepairGuidanceOptions = {}): string {
	if (dbPath === undefined) return "Repair the store file with sqlite3's .recover and restart.";

	const platform = options.platform ?? process.platform;
	const fixedPath = `${dbPath}.fixed`;
	const backupPath = `${dbPath}.bak`;
	const walPath = `${dbPath}-wal`;
	const shmPath = `${dbPath}-shm`;
	const backupWalPath = `${backupPath}-wal`;
	const backupShmPath = `${backupPath}-shm`;
	if (platform === "win32") {
		const psDbPath = powershellQuote(dbPath);
		const psFixedPath = powershellQuote(fixedPath);
		const psBackupPath = powershellQuote(backupPath);
		const psWalPath = powershellQuote(walPath);
		const psBackupWalPath = powershellQuote(backupWalPath);
		const psShmPath = powershellQuote(shmPath);
		const psBackupShmPath = powershellQuote(backupShmPath);
		const hardening = options.restrictPermissions
			? `; icacls ${psDbPath} /inheritance:r /grant:r ("{0}\\{1}:(F)" -f $env:USERDOMAIN, $env:USERNAME) | Out-Null`
			: "";
		const command =
			`sqlite3 ${psDbPath} '.recover --ignore-freelist' | sqlite3 ${psFixedPath}; ` +
			`if ($LASTEXITCODE -eq 0 -and (sqlite3 ${psFixedPath} 'PRAGMA integrity_check') -eq 'ok') { ` +
			`Move-Item -Force ${psDbPath} ${psBackupPath}; ` +
			`Move-Item -Force -ErrorAction SilentlyContinue ${psWalPath} ${psBackupWalPath}; ` +
			`Move-Item -Force -ErrorAction SilentlyContinue ${psShmPath} ${psBackupShmPath}; ` +
			`Move-Item -Force ${psFixedPath} ${psDbPath}${hardening} }`;
		return `Stop omp, then repair the database in place in PowerShell with: ${command}`;
	}
	const recover = `sqlite3 ${shellQuote(dbPath)} '.recover --ignore-freelist' | sqlite3 ${shellQuote(fixedPath)}`;
	const recoverStep = options.restrictPermissions ? `(umask 077 && ${recover})` : recover;
	const sidecarBackup = `{ mv ${shellQuote(walPath)} ${shellQuote(backupWalPath)} 2>/dev/null; mv ${shellQuote(shmPath)} ${shellQuote(backupShmPath)} 2>/dev/null; true; }`;
	const command =
		`${recoverStep} && sqlite3 ${shellQuote(fixedPath)} 'PRAGMA integrity_check' | grep -qx 'ok'` +
		` && mv ${shellQuote(dbPath)} ${shellQuote(backupPath)} && ${sidecarBackup} && mv ${shellQuote(fixedPath)} ${shellQuote(dbPath)}`;
	return `Stop omp, then repair the database in place with: ${command}`;
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
