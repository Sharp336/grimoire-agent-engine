import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type DoctorDatabase,
	probeDatabase,
	recoverInterruptedSwap,
	repairDatabase,
} from "@oh-my-pi/pi-coding-agent/cli/doctor-sqlite";
import * as piUtils from "@oh-my-pi/pi-utils";

let root: string;
let spies: Array<{ mockRestore(): void }> = [];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-doctor-sqlite-"));
	spies = [];
});

afterEach(async () => {
	for (const spy of spies) spy.mockRestore();
	spies = [];
	await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function quickCheck(dbPath: string): string | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.query("PRAGMA quick_check(1)").get() as { quick_check: string } | null;
		return row?.quick_check ?? null;
	} finally {
		db.close();
	}
}

/** Create a DELETE-journal database with `rows` ~1 KiB rows so freelist/corruption fixtures are deterministic. */
async function createDatabaseWithRows(dbPath: string, rows: number): Promise<void> {
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode=DELETE");
	db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
	const insert = db.prepare("INSERT INTO t (blob) VALUES (?)");
	db.run("BEGIN");
	for (let index = 0; index < rows; index++) insert.run("x".repeat(1024));
	db.run("COMMIT");
	db.close();
}

/** Overwrite interior pages with 0xFF; never touch bytes [0, 100) so the header stays openable. */
async function corruptInteriorPages(dbPath: string): Promise<void> {
	const handle = await fs.open(dbPath, "r+");
	try {
		await handle.write(Buffer.alloc(2048, 0xff), 0, 2048, 4096);
	} finally {
		await handle.close();
	}
	if (quickCheck(dbPath) === "ok") {
		const wider = await fs.open(dbPath, "r+");
		try {
			await wider.write(Buffer.alloc(16384 - 4096, 0xff), 0, 16384 - 4096, 4096);
		} finally {
			await wider.close();
		}
	}
	expect(quickCheck(dbPath)).not.toBe("ok");
}

/** Create a precious database with a parent→child FK relationship and insert one valid child row. */
async function createFkDatabase(dbPath: string): Promise<void> {
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode=DELETE");
	db.run("PRAGMA foreign_keys=ON");
	db.run("CREATE TABLE parent (id INTEGER PRIMARY KEY, v TEXT)");
	db.run("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))");
	db.run("INSERT INTO parent (v) VALUES ('p1')");
	db.run("INSERT INTO child (parent_id) VALUES (1)");
	db.close();
}

/** Create a database with an FK violation: a child row referencing a non-existent parent. */
async function createFkViolatingDatabase(dbPath: string): Promise<void> {
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode=DELETE");
	db.run("PRAGMA foreign_keys=OFF");
	db.run("CREATE TABLE parent (id INTEGER PRIMARY KEY, v TEXT)");
	db.run("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))");
	db.run("INSERT INTO child (parent_id) VALUES (999)");
	db.close();
}

function makeDb(dbPath: string): DoctorDatabase {
	return { label: path.basename(dbPath), path: dbPath, policy: "precious" };
}

// ============================================================================
// Item H — marker destroyed on failed rollback
// ============================================================================

describe("Item H: marker survives failed rollback", () => {
	test("failed replacement + failed rollback leaves the marker pointing at the archive", async () => {
		const dbPath = path.join(root, "agent.db");
		// Create a database with a filler table to generate freelist pages,
		// then corrupt the freelist trunk page so quick_check fails but the
		// DB is still openable for VACUUM INTO. This produces a valid rescue
		// candidate that enters swapInCandidate — where we force the
		// rollback to fail.
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=DELETE");
		db.run("CREATE TABLE filler (id INTEGER PRIMARY KEY, blob TEXT)");
		db.run("BEGIN");
		const insertFiller = db.prepare("INSERT INTO filler (blob) VALUES (?)");
		for (let i = 0; i < 200; i++) insertFiller.run("x".repeat(1024));
		db.run("COMMIT");
		db.run("DELETE FROM filler");
		db.close();
		// Corrupt the freelist trunk page (page 5 at offset 4*page_size).
		const pageSize = 4096;
		const handle = await fs.open(dbPath, "r+");
		try {
			await handle.write(Buffer.alloc(pageSize, 0xff), 0, pageSize, 2 * pageSize);
		} finally {
			await handle.close();
		}
		const corruptProbe = await probeDatabase(makeDb(dbPath));
		expect(corruptProbe.quickCheck).not.toBe("ok");
		// Force .recover to be unavailable so the VACUUM INTO fallback runs.
		const originalWhich = piUtils.$which;
		const whichSpy = spyOn(piUtils, "$which").mockImplementation((name: string) => {
			if (name === "sqlite3") return null;
			return originalWhich(name);
		});
		spies.push(whichSpy);

		// Spy on fsSync.renameSync to fail the SWAP rename (candidate → live
		// path). The source path contains ".rescue-" (from vacuumIntoRescue).
		// This forces swapInCandidate into the catch block, which attempts a
		// rollback via stageRestoreFromArchive + commitRestoreFromArchive.
		const originalRenameSync = fsSync.renameSync;
		const renameSpy = spyOn(fsSync, "renameSync").mockImplementation(
			(src: fsSync.PathLike, dest: fsSync.PathLike) => {
				if (String(src).includes(".rescue-")) {
					throw new Error("simulated swap rename failure");
				}
				// Allow other renames (sidecar retirement, etc.) via the original.
				originalRenameSync(src, dest);
			},
		);
		spies.push(renameSpy);

		// Spy on fs.copyFile to fail when staging the rollback (copying FROM
		// the archive directory). This makes the rollback fail after the swap
		// rename fails. The marker must survive so the next doctor run can
		// retry recovery.
		const originalCopyFile = fs.copyFile;
		const copyFileSpy = spyOn(fs, "copyFile").mockImplementation(async (src: unknown, dest: unknown) => {
			const srcStr = String(src);
			if (srcStr.includes(".omp-doctor-backups")) {
				throw new Error("simulated rollback copy failure");
			}
			return originalCopyFile(src as string, dest as string);
		});
		spies.push(copyFileSpy);

		const repair = await repairDatabase(corruptProbe);

		// The repair must have failed.
		expect(repair.error).not.toBeNull();
		// The error must name the archive directory for manual restore.
		expect(repair.error).toContain("restore manually from");
		expect(repair.error).toContain(".omp-doctor-backups");

		// The marker must survive — it is the durable pointer the next
		// doctor run needs for recovery. Before the fix, the finally block
		// deleted it unconditionally, losing the archive pointer in exactly
		// the path that most needs it.
		const marker = path.join(root, ".agent.db.omp-doctor-swap.json");
		expect(await pathExists(marker)).toBe(true);

		// The marker must still point at the archive.
		const markerContent = JSON.parse(await Bun.file(marker).text()) as { archive: string; swapped?: boolean };
		expect(markerContent.archive).toContain(".omp-doctor-backups");
		// The marker must NOT say swapped:true (the swap was not verified).
		expect(markerContent.swapped).not.toBe(true);
	});
});

// ============================================================================
// Item I — restore renames under an open handle (close-before-rename)
// ============================================================================

describe("Item I: interrupted swap restore uses close-before-rename", () => {
	test("interrupted swap restore succeeds and archive bytes land at the live path", async () => {
		const dbPath = path.join(root, "agent.db");
		await createDatabaseWithRows(dbPath, 20);

		// Simulate a crashed swap: archive the good database, write a marker,
		// then damage the live file.
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		await fs.copyFile(dbPath, path.join(archiveDir, "agent.db"));
		await fs.writeFile(dbPath, "garbage-not-sqlite");
		const marker = path.join(root, ".agent.db.omp-doctor-swap.json");
		await Bun.write(marker, JSON.stringify({ archive: archiveDir }));

		// Run recovery with restore=true (--fix mode).
		const result = await recoverInterruptedSwap(makeDb(dbPath), true);

		expect(result.found).toBe(true);
		expect(result.restored).toBe(true);
		expect(result.error).toBeNull();

		// The live file should now be the archived good database.
		expect(quickCheck(dbPath)).toBe("ok");
		// The marker should be cleaned up after a successful restore.
		expect(await pathExists(marker)).toBe(false);

		// Verify the content matches the archive.
		const archivedBytes = await fs.readFile(path.join(archiveDir, "agent.db"));
		const liveBytes = await fs.readFile(dbPath);
		expect(liveBytes.equals(archivedBytes)).toBe(true);
	});
});

// ============================================================================
// Item J — holder check unavailable off-Linux
// ============================================================================

describe("Item J: unavailable holder detection refuses with actionable message", () => {
	test("unopenable database with fuser unavailable refuses with unsupported message, not generic busy", async () => {
		const dbPath = path.join(root, "agent.db");
		await createDatabaseWithRows(dbPath, 10);

		// Create a swap marker pointing at a valid archive, then make the
		// live file unopenable (garbage) so acquireWriteLock returns null.
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		await fs.copyFile(dbPath, path.join(archiveDir, "agent.db"));
		await fs.writeFile(dbPath, "garbage-not-sqlite");
		const marker = path.join(root, ".agent.db.omp-doctor-swap.json");
		await Bun.write(marker, JSON.stringify({ archive: archiveDir }));

		// Force fuser to be unavailable so hasHolders returns null.
		const originalWhich = piUtils.$which;
		const whichSpy = spyOn(piUtils, "$which").mockImplementation((name: string) => {
			if (name === "fuser") return null;
			return originalWhich(name);
		});
		spies.push(whichSpy);

		const result = await recoverInterruptedSwap(makeDb(dbPath), true);

		expect(result.found).toBe(true);
		expect(result.restored).toBe(false);
		// The message must name the unavailable detection, not a generic busy.
		expect(result.error).toContain("holder detection unavailable");
		expect(result.error).not.toContain("database busy; close running omp sessions");

		// The original (garbage) file must be untouched.
		const liveContent = await fs.readFile(dbPath, "utf-8");
		expect(liveContent).toBe("garbage-not-sqlite");
		// The marker must survive (no restore was attempted).
		expect(await pathExists(marker)).toBe(true);
	});
});

// ============================================================================
// Item K — stderr deadlock (concurrent drain)
// ============================================================================

describe("Item K: recovery dump load drains stderr concurrently", () => {
	test("large stderr from a recovery load does not deadlock the repair", async () => {
		// This test exercises the salvage path end-to-end. A database with
		// freelist-only corruption is salvaged; the .recover dump loads
		// successfully. If stderr were drained after exit, a large dump
		// would deadlock — but the dump here is small, so this test mainly
		// proves the concurrent-drain path does not break the happy path.
		// The deadlock fix is structural (Promise.all of stderr+exit).
		const dbPath = path.join(root, "agent.db");
		await createDatabaseWithRows(dbPath, 100);
		const db = new Database(dbPath);
		db.run("DELETE FROM t");
		db.close();
		await corruptInteriorPages(dbPath);

		const probe = await probeDatabase(makeDb(dbPath));
		const repair = await repairDatabase(probe);

		// The salvage should succeed (freelist-only corruption, no data loss).
		expect(repair.error).toBeNull();
		expect(repair.actions.some(a => a === "salvaged" || a === "rescued")).toBe(true);
		expect(quickCheck(dbPath)).toBe("ok");
	});
});

// ============================================================================
// Item L — VACUUM INTO candidate skips FK check
// ============================================================================

describe("Item L: VACUUM INTO candidate with FK violation is refused", () => {
	test("corrupt db whose VACUUM INTO candidate carries an FK violation refuses the swap", async () => {
		// Create a database with an FK violation and enough data to have
		// freelist pages. Corrupting only freelist pages makes quick_check
		// fail (so the salvage ladder runs) while the live pages — including
		// the orphaned child row — survive intact. VACUUM INTO copies the
		// live pages, producing a candidate that passes integrity_check but
		// still carries the FK violation, which validateCandidate must catch.
		const dbPath = path.join(root, "agent.db");
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=DELETE");
		db.run("PRAGMA foreign_keys=OFF");
		db.run("CREATE TABLE parent (id INTEGER PRIMARY KEY, v TEXT)");
		db.run("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))");
		db.run("CREATE TABLE filler (id INTEGER PRIMARY KEY, blob TEXT)");
		db.run("BEGIN");
		const insertFiller = db.prepare("INSERT INTO filler (blob) VALUES (?)");
		for (let i = 0; i < 200; i++) insertFiller.run("x".repeat(1024));
		db.run("COMMIT");
		// Delete filler rows to create freelist pages.
		db.run("DELETE FROM filler");
		// Insert the FK violation into a live page.
		db.run("INSERT INTO child (parent_id) VALUES (999)");
		db.close();
		// Corrupt the freelist trunk page (page 5 at offset 4*page_size) so
		// quick_check fails ("Freelist: freelist page count is out of
		// range") while live data pages survive. VACUUM INTO rebuilds from
		// live pages, producing a candidate that passes integrity_check but
		// still carries the FK violation — validateCandidate must catch it.
		const pageSize = 4096;
		const trunkPageOffset = 4 * pageSize;
		const handle = await fs.open(dbPath, "r+");
		try {
			await handle.write(Buffer.alloc(pageSize, 0xff), 0, pageSize, trunkPageOffset);
		} finally {
			await handle.close();
		}
		const probe = await probeDatabase(makeDb(dbPath));
		expect(probe.quickCheck).not.toBe("ok");
		// Force .recover to be unavailable so the VACUUM INTO fallback runs.
		const originalWhich = piUtils.$which;
		const whichSpy = spyOn(piUtils, "$which").mockImplementation((name: string) => {
			if (name === "sqlite3") return null;
			return originalWhich(name);
		});
		spies.push(whichSpy);

		const repair = await repairDatabase(probe);

		// The VACUUM INTO candidate should carry the FK violation, and the
		// shared validateCandidate gate should refuse the swap.
		expect(repair.error).not.toBeNull();
		expect(repair.error).toContain("foreign-key violations");

		// The original (corrupt) file must be untouched — no swap occurred.
		// The archive should exist with the original.
		expect(repair.quarantinePath).not.toBeNull();
		const backupRoot = path.join(root, ".omp-doctor-backups");
		const backups = await fs.readdir(backupRoot).catch(() => []);
		expect(backups.some(name => name.startsWith("agent.db."))).toBe(true);
	});
});

// ============================================================================
// Item M — read-only probe creates WAL sidecars
// ============================================================================

describe("Item M: read-only probe does not create WAL sidecars", () => {
	test("cleanly closed WAL db with sidecars removed gains no -wal/-shm after a default probe", async () => {
		const dbPath = path.join(root, "agent.db");
		// Create a WAL-mode database, checkpoint, close, and remove sidecars.
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
		db.run("INSERT INTO t (v) VALUES ('hello')");
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		db.close();
		// Remove sidecars to simulate a cleanly closed database.
		await fs.rm(`${dbPath}-wal`).catch(() => undefined);
		await fs.rm(`${dbPath}-shm`).catch(() => undefined);

		// Verify no sidecars exist before the probe.
		const before = (await fs.readdir(root)).sort();
		expect(before).toEqual(["agent.db"]);

		// Run a default (read-only) probe.
		const probe = await probeDatabase(makeDb(dbPath));

		// The probe should report journal mode "wal" (from the header).
		expect(probe.journalMode).toBe("wal");
		expect(probe.pageCount).not.toBeNull();
		expect(probe.pageCount).toBeGreaterThan(0);
		expect(probe.quickCheck).toBe("ok");

		// No -wal or -shm files should exist after the probe.
		const after = (await fs.readdir(root)).sort();
		expect(after).toEqual(["agent.db"]);
		expect(await pathExists(`${dbPath}-wal`)).toBe(false);
		expect(await pathExists(`${dbPath}-shm`)).toBe(false);
	});

	test("WAL db with pre-existing sidecar uses normal readonly open", async () => {
		const dbPath = path.join(root, "agent.db");
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
		db.run("INSERT INTO t (v) VALUES ('hello')");
		db.close();
		// The -wal and -shm sidecars exist after close (WAL mode).

		const walExists = await pathExists(`${dbPath}-wal`);
		// On some systems the WAL is auto-checkpointed on close; if it
		// doesn't exist, create a placeholder to exercise the pre-existing
		// sidecar branch.
		if (!walExists) {
			await fs.writeFile(`${dbPath}-wal`, "");
		}
		await fs.writeFile(`${dbPath}-shm`, "").catch(() => undefined);

		const probe = await probeDatabase(makeDb(dbPath));

		// With a pre-existing WAL, the normal readonly open is used; the
		// journal mode should be reported as "wal" from the pragma.
		expect(probe.journalMode).toBe("wal");
		expect(probe.quickCheck).toBe("ok");
	});
});
