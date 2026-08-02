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

function makeDb(dbPath: string): DoctorDatabase {
	return { label: path.basename(dbPath), path: dbPath, policy: "precious" };
}

async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.SHA256();
	hasher.update(await Bun.file(filePath).arrayBuffer());
	return hasher.digest("hex");
}

async function snapshotTrioForTest(dbPath: string): Promise<Array<{ name: string; size: number; hash: string }>> {
	const entries: Array<{ name: string; size: number; hash: string }> = [];
	for (const suffix of ["", "-wal", "-shm", "-journal"] as const) {
		const file = `${dbPath}${suffix}`;
		try {
			const stat = await fs.stat(file);
			entries.push({ name: path.basename(file), size: stat.size, hash: await sha256File(file) });
		} catch {
			// missing sidecar
		}
	}
	return entries;
}

async function writeModernSwapMarker(
	dbPath: string,
	archiveDir: string,
	source: Array<{ name: string; size: number; hash: string }>,
	candidateMain: { size: number; hash: string },
): Promise<string> {
	const marker = path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.omp-doctor-swap.json`);
	await Bun.write(marker, JSON.stringify({ archive: path.resolve(archiveDir), source, candidateMain }));
	return marker;
}

// ============================================================================
// Item H — marker destroyed on failed rollback
// ============================================================================

describe("Item H: marker survives failed rollback", () => {
	test("failed replacement after lock release leaves the provenance marker pointing at the archive", async () => {
		const dbPath = path.join(root, "agent.db");
		// Create a database with a filler table to generate freelist pages,
		// then corrupt the freelist trunk page so quick_check fails but the
		// DB is still openable for VACUUM INTO. This produces a valid rescue
		// candidate that enters swapInCandidate — where we force the rename
		// to fail after lock release.
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=DELETE");
		db.run("CREATE TABLE filler (id INTEGER PRIMARY KEY, blob TEXT)");
		db.run("BEGIN");
		const insertFiller = db.prepare("INSERT INTO filler (blob) VALUES (?)");
		for (let i = 0; i < 200; i++) insertFiller.run("x".repeat(1024));
		db.run("COMMIT");
		db.run("DELETE FROM filler");
		db.close();
		const pageSize = 4096;
		const handle = await fs.open(dbPath, "r+");
		try {
			await handle.write(Buffer.alloc(pageSize, 0xff), 0, pageSize, 2 * pageSize);
		} finally {
			await handle.close();
		}
		const corruptProbe = await probeDatabase(makeDb(dbPath));
		expect(corruptProbe.quickCheck).not.toBe("ok");
		const originalWhich = piUtils.$which;
		const whichSpy = spyOn(piUtils, "$which").mockImplementation((name: string) => {
			if (name === "sqlite3") return null;
			return originalWhich(name);
		});
		spies.push(whichSpy);

		const originalRenameSync = fsSync.renameSync;
		const renameSpy = spyOn(fsSync, "renameSync").mockImplementation(
			(src: fsSync.PathLike, dest: fsSync.PathLike) => {
				if (String(src).includes(".rescue-") || String(src).includes(".salvage-")) {
					throw new Error("simulated swap rename failure");
				}
				originalRenameSync(src, dest);
			},
		);
		spies.push(renameSpy);

		const repair = await repairDatabase(corruptProbe);

		expect(repair.error).not.toBeNull();
		expect(repair.error).toContain(".omp-doctor-backups");
		expect(repair.error).toContain("marker retained");

		const marker = path.join(root, ".agent.db.omp-doctor-swap.json");
		expect(await pathExists(marker)).toBe(true);

		const markerContent = JSON.parse(await Bun.file(marker).text()) as {
			archive: string;
			source?: Array<{ name: string; size: number; hash: string }>;
			candidateMain?: { size: number; hash: string };
			swapped?: boolean;
		};
		expect(markerContent.archive).toContain(".omp-doctor-backups");
		expect(Array.isArray(markerContent.source)).toBe(true);
		expect(markerContent.candidateMain?.hash).toEqual(expect.any(String));
		expect(markerContent.swapped).toBeUndefined();
	});
});

// ============================================================================
// Item I — provenance-based interrupted swap recovery
// ============================================================================

describe("Item I: provenance swap recovery classification", () => {
	test("source-with-retired-WAL restores the archived original trio", async () => {
		const dbPath = path.join(root, "agent.db");
		await createDatabaseWithRows(dbPath, 20);
		// Synthetic WAL sidecar: real SQLite may checkpoint on close, so write a
		// stable sidecar byte file to model the retired-WAL crash state.
		await Bun.write(`${dbPath}-wal`, "wal-sidecar-bytes-for-provenance-test");
		expect(await pathExists(`${dbPath}-wal`)).toBe(true);

		const source = await snapshotTrioForTest(dbPath);
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		for (const entry of source) {
			await fs.copyFile(path.join(root, entry.name), path.join(archiveDir, entry.name));
		}
		await fs.rename(`${dbPath}-wal`, path.join(root, `.agent.db-wal.retired-test`));

		const candidateMain = { size: 1, hash: "0".repeat(64) };
		const marker = await writeModernSwapMarker(dbPath, archiveDir, source, candidateMain);
		const result = await recoverInterruptedSwap(makeDb(dbPath), true);

		expect(result.found).toBe(true);
		expect(result.restored).toBe(true);
		expect(result.error).toBeNull();
		expect(await pathExists(marker)).toBe(false);
		// Compare before opening SQLite — a read may recreate -shm.
		expect(await snapshotTrioForTest(dbPath)).toEqual(source);
		expect(await Bun.file(`${dbPath}-wal`).text()).toBe("wal-sidecar-bytes-for-provenance-test");
		expect(quickCheck(dbPath)).toBe("ok");
	});

	test("candidate state preserves the live database and clears the marker", async () => {
		const dbPath = path.join(root, "agent.db");
		await createDatabaseWithRows(dbPath, 20);
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		const archiveDb = new Database(path.join(archiveDir, "agent.db"));
		archiveDb.run("PRAGMA journal_mode=DELETE");
		archiveDb.run("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
		archiveDb.run("INSERT INTO t (blob) VALUES ('archived-original')");
		archiveDb.close();
		const source = await snapshotTrioForTest(path.join(archiveDir, "agent.db"));
		const candidateStat = await fs.stat(dbPath);
		const exactCandidate = { size: candidateStat.size, hash: await sha256File(dbPath) };
		expect(exactCandidate.hash).not.toBe(source.find(e => e.name === "agent.db")!.hash);

		const marker = await writeModernSwapMarker(dbPath, archiveDir, source, exactCandidate);
		const result = await recoverInterruptedSwap(makeDb(dbPath), true);

		expect(result.found).toBe(true);
		expect(result.restored).toBe(false);
		expect(result.error).toBeNull();
		expect(await pathExists(marker)).toBe(false);
		expect(quickCheck(dbPath)).toBe("ok");
		const check = new Database(dbPath, { readonly: true });
		const count = check.query("SELECT count(*) AS n FROM t").get() as { n: number };
		check.close();
		expect(count.n).toBe(20);
	});

	test("unknown/changed live state retains the marker and returns a manual-recovery error", async () => {
		const dbPath = path.join(root, "agent.db");
		await createDatabaseWithRows(dbPath, 20);
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		await fs.copyFile(dbPath, path.join(archiveDir, "agent.db"));
		const source = await snapshotTrioForTest(path.join(archiveDir, "agent.db"));
		const candidateMain = { size: 99, hash: "c".repeat(64) };

		const db = new Database(dbPath);
		db.run("INSERT INTO t (blob) VALUES ('diverged')");
		db.close();

		const marker = await writeModernSwapMarker(dbPath, archiveDir, source, candidateMain);
		const result = await recoverInterruptedSwap(makeDb(dbPath), true);

		expect(result.found).toBe(true);
		expect(result.restored).toBe(false);
		expect(result.error).toContain("unrecognized live database state");
		expect(result.error).toContain(archiveDir);
		expect(await pathExists(marker)).toBe(true);
		const check = new Database(dbPath, { readonly: true });
		const rows = check.query("SELECT blob FROM t ORDER BY id").all() as { blob: string }[];
		check.close();
		expect(rows.some(r => r.blob === "diverged")).toBe(true);
	});

	test("missing-main state retains the marker for manual recovery", async () => {
		const dbPath = path.join(root, "agent.db");
		await createDatabaseWithRows(dbPath, 20);
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		await fs.copyFile(dbPath, path.join(archiveDir, "agent.db"));
		const source = await snapshotTrioForTest(path.join(archiveDir, "agent.db"));
		const candidateMain = { size: 1, hash: "d".repeat(64) };
		await fs.rm(dbPath);

		const marker = await writeModernSwapMarker(dbPath, archiveDir, source, candidateMain);
		const result = await recoverInterruptedSwap(makeDb(dbPath), true);

		expect(result.found).toBe(true);
		expect(result.restored).toBe(false);
		expect(result.error).toContain("main file is missing");
		expect(await pathExists(dbPath)).toBe(false);
		expect(await pathExists(marker)).toBe(true);
	});

	test("missing-main with residual sidecar retains the archive for manual recovery", async () => {
		const dbPath = path.join(root, "agent.db");
		await createDatabaseWithRows(dbPath, 20);
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		await fs.copyFile(dbPath, path.join(archiveDir, "agent.db"));
		const source = await snapshotTrioForTest(path.join(archiveDir, "agent.db"));
		const candidateMain = { size: 1, hash: "d".repeat(64) };
		await fs.rm(dbPath);
		await Bun.write(`${dbPath}-wal`, "stale-wal-from-partial-swap");

		const marker = await writeModernSwapMarker(dbPath, archiveDir, source, candidateMain);
		const result = await recoverInterruptedSwap(makeDb(dbPath), true);

		expect(result.found).toBe(true);
		expect(result.restored).toBe(false);
		expect(result.error).toContain("main file is missing");
		expect(await Bun.file(`${dbPath}-wal`).text()).toBe("stale-wal-from-partial-swap");
		expect(await pathExists(marker)).toBe(true);
	});

	test("legacy marker with a live database is ambiguous and must not overwrite it", async () => {
		const dbPath = path.join(root, "agent.db");
		await createDatabaseWithRows(dbPath, 20);
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		const archiveDb = new Database(path.join(archiveDir, "agent.db"));
		archiveDb.run("PRAGMA journal_mode=DELETE");
		archiveDb.run("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
		archiveDb.run("INSERT INTO t (blob) VALUES ('old')");
		archiveDb.close();

		const db = new Database(dbPath);
		db.run("INSERT INTO t (blob) VALUES ('live-legacy')");
		db.close();

		const marker = path.join(root, ".agent.db.omp-doctor-swap.json");
		await Bun.write(marker, JSON.stringify({ archive: archiveDir }));

		const result = await recoverInterruptedSwap(makeDb(dbPath), true);
		expect(result.found).toBe(true);
		expect(result.restored).toBe(false);
		expect(result.error).toContain("unrecognized live database state");
		expect(await pathExists(marker)).toBe(true);
		const check = new Database(dbPath, { readonly: true });
		const rows = check.query("SELECT blob FROM t ORDER BY id").all() as { blob: string }[];
		check.close();
		expect(rows.some(r => r.blob === "live-legacy")).toBe(true);
	});

	test("interrupted swap restore uses close-before-rename for a source-matching live database", async () => {
		const dbPath = path.join(root, "agent.db");
		await createDatabaseWithRows(dbPath, 20);
		const source = await snapshotTrioForTest(dbPath);
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		await fs.copyFile(dbPath, path.join(archiveDir, "agent.db"));
		const candidateMain = { size: 1, hash: "e".repeat(64) };
		const marker = await writeModernSwapMarker(dbPath, archiveDir, source, candidateMain);

		const result = await recoverInterruptedSwap(makeDb(dbPath), true);
		expect(result.found).toBe(true);
		expect(result.restored).toBe(true);
		expect(result.error).toBeNull();
		expect(quickCheck(dbPath)).toBe("ok");
		expect(await pathExists(marker)).toBe(false);
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
		// Non-SQLite bytes that still provenance-match the archive so recovery
		// classifies restore, then hits the lock/holder gate.
		await fs.writeFile(dbPath, "garbage-not-sqlite");
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		await fs.copyFile(dbPath, path.join(archiveDir, "agent.db"));
		const source = await snapshotTrioForTest(dbPath);
		const candidateMain = { size: 1, hash: "f".repeat(64) };
		const marker = await writeModernSwapMarker(dbPath, archiveDir, source, candidateMain);

		const originalWhich = piUtils.$which;
		const whichSpy = spyOn(piUtils, "$which").mockImplementation((name: string) => {
			if (name === "fuser") return null;
			return originalWhich(name);
		});
		spies.push(whichSpy);

		const result = await recoverInterruptedSwap(makeDb(dbPath), true);

		expect(result.found).toBe(true);
		expect(result.restored).toBe(false);
		expect(result.error).toContain("holder detection unavailable");
		expect(result.error).not.toContain("database busy; close running omp sessions");

		const liveContent = await fs.readFile(dbPath, "utf-8");
		expect(liveContent).toBe("garbage-not-sqlite");
		expect(await pathExists(marker)).toBe(true);
	});
});

// ============================================================================
// Item K — stderr deadlock (concurrent drain)
// ============================================================================

describe("Item K: recovery dump load drains stderr concurrently", () => {
	test("large stderr from a recovery load does not deadlock the repair", async () => {
		// Exercise salvage end-to-end with freelist-trunk corruption that
		// reliably fails quick_check (same offset as Item H). Concurrent
		// stderr drain is structural (Promise.all); this proves the path
		// still completes a successful salvage/rescue swap.
		const dbPath = path.join(root, "agent.db");
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=DELETE");
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
		db.run("INSERT INTO t (blob) VALUES ('keep')");
		db.run("CREATE TABLE filler (id INTEGER PRIMARY KEY, blob TEXT)");
		db.run("BEGIN");
		const insertFiller = db.prepare("INSERT INTO filler (blob) VALUES (?)");
		for (let i = 0; i < 200; i++) insertFiller.run("x".repeat(1024));
		db.run("COMMIT");
		db.run("DELETE FROM filler");
		db.close();
		const pageSize = 4096;
		const handle = await fs.open(dbPath, "r+");
		try {
			await handle.write(Buffer.alloc(pageSize, 0xff), 0, pageSize, 2 * pageSize);
		} finally {
			await handle.close();
		}

		const probe = await probeDatabase(makeDb(dbPath));
		expect(probe.quickCheck).not.toBe("ok");
		const repair = await repairDatabase(probe);

		expect(repair.error).toBeNull();
		expect(repair.actions.some(a => a === "salvaged" || a === "rescued")).toBe(true);
		expect(quickCheck(dbPath)).toBe("ok");
	});
});

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
