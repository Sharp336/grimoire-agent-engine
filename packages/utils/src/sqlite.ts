/**
 * Shared SQLite helpers for omp's local databases.
 *
 * The corruption classifier lives here (rather than beside any single store)
 * because every package that opens a SQLite file needs to tell unrecoverable
 * file damage apart from transient lock contention.
 */

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
