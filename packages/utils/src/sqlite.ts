import type { Database } from "bun:sqlite";
import * as fs from "node:fs";

/** Row returned by PRAGMA wal_checkpoint */
type CheckpointRow = { busy: number; log: number; checkpointed: number };

/**
 * Checkpoints and closes a WAL-mode SQLite database, then removes the
 * sidecar files (.db-wal, .db-shm) on macOS where SQLite does not delete
 * them automatically after close.
 *
 * PRAGMA wal_checkpoint(TRUNCATE) returns a row with a `busy` flag that is
 * non-zero when active readers or writers prevented a full checkpoint.  The
 * sidecar files are only unlinked when `busy === 0`, meaning no other
 * connection holds frames that still live in the WAL.  Deleting sidecars
 * while they are in use by another connection would corrupt that connection
 * with SQLITE_IOERR/short-read errors.
 */
export function closeWalDb(db: Database): void {
	let checkpointClean = false;
	try {
		const row = db.query<CheckpointRow, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
		// busy === 0 means no active connections blocked the checkpoint.
		checkpointClean = row !== null && row.busy === 0;
	} catch {
		// Best-effort; proceed with close even if checkpoint fails.
	}
	db.close();
	if (process.platform === "darwin" && checkpointClean) {
		const { filename } = db;
		if (filename && filename !== ":memory:") {
			for (const suffix of ["-wal", "-shm"]) {
				try {
					fs.unlinkSync(filename + suffix);
				} catch {
					// File may not exist; ignore.
				}
			}
		}
	}
}
