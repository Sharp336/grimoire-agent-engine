import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type DoctorReport, runDoctorCommand } from "@oh-my-pi/pi-coding-agent/cli/doctor-cli";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getAgentDbPath, getHistoryDbPath, getModelDbPath } from "@oh-my-pi/pi-utils";
import { runCli } from "../src/cli";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let root: string;
let writes: string[] = [];
let stderrWrites: string[] = [];
let stdoutSpy: { mockRestore(): void } | undefined;
let stderrSpy: { mockRestore(): void } | undefined;
let settingsState: SettingsTestState | undefined;
const originalExitCode = process.exitCode;

beforeAll(async () => {
	// The human renderer dereferences the theme singleton, which is unassigned until initTheme resolves.
	await initTheme(false);
});

beforeEach(async () => {
	settingsState = beginSettingsTest();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-doctor-"));
	writes = [];
	stderrWrites = [];
	process.exitCode = 0;
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(String(chunk));
		return true;
	});
	stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderrWrites.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	stderrSpy?.mockRestore();
	stderrSpy = undefined;
	process.exitCode = originalExitCode;
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	await fs.rm(root, { recursive: true, force: true });
});

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Create a DELETE-journal database with `rows` ~1 KiB rows so freelist/corruption fixtures are deterministic. */
async function createDatabaseWithRows(dbPath: string, rows: number): Promise<void> {
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode=DELETE");
	db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
	const insert = db.prepare("INSERT INTO t (blob) VALUES (?)");
	for (let index = 0; index < rows; index++) insert.run("x".repeat(1024));
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
		// The first range missed live pages; widen it, still leaving the header intact.
		const wider = await fs.open(dbPath, "r+");
		try {
			await wider.write(Buffer.alloc(16384 - 4096, 0xff), 0, 16384 - 4096, 4096);
		} finally {
			await wider.close();
		}
	}
	expect(quickCheck(dbPath)).not.toBe("ok");
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

/** Mirrors the engine's runtime behavior: `--ignore-freelist` exists only on newer sqlite3 CLIs (CI runners may ship an older one). */
async function recoverSupportsIgnoreFreelist(): Promise<boolean> {
	const sqlite = Bun.which("sqlite3");
	if (sqlite === null) return false;
	const probe = Bun.spawn([sqlite, ":memory:", ".recover --ignore-freelist"], { stdout: "ignore", stderr: "ignore" });
	return (await probe.exited) === 0;
}

describe("omp doctor", () => {
	test("free pages warn without --fix and are reclaimed with --fix", async () => {
		const dbPath = getHistoryDbPath(root);
		await createDatabaseWithRows(dbPath, 2000);
		const db = new Database(dbPath);
		db.run("DELETE FROM t");
		db.close();

		const before = await runDoctorCommand({ flags: { agentDir: root } });
		const warning = before.findings.find(finding => finding.id === "storage.history.db");
		expect(warning?.status).toBe("warning");
		expect(warning?.summary).toMatch(/% free pages/);

		const sizeBefore = (await fs.stat(dbPath)).size;
		const after = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const fixed = after.findings.find(finding => finding.id === "storage.history.db");
		expect(fixed?.status).toBe("ok");
		expect(fixed?.fixed).toBe(true);
		expect(fixed?.summary).toContain("vacuumed");
		expect((await fs.stat(dbPath)).size).toBeLessThan(sizeBefore);
	});

	test("corrupt regenerable database is quarantined under --fix", async () => {
		const dbPath = getModelDbPath(root);
		await createDatabaseWithRows(dbPath, 500);
		await corruptInteriorPages(dbPath);

		const before = await runDoctorCommand({ flags: { agentDir: root } });
		expect(before.findings.find(finding => finding.id === "storage.models.db")?.status).toBe("error");

		const after = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const finding = after.findings.find(entry => entry.id === "storage.models.db");
		expect(finding?.status).toBe("ok");
		expect(finding?.fixed).toBe(true);
		expect(await pathExists(dbPath)).toBe(false);
		const siblings = await fs.readdir(path.dirname(dbPath));
		expect(siblings.filter(name => name.startsWith("models.db.corrupt-"))).toHaveLength(1);
	});

	test("data-destroying corruption refuses the swap but preserves a recovery dump", async () => {
		const dbPath = getAgentDbPath(root);
		await createDatabaseWithRows(dbPath, 500);
		// Destroying the table's root page strands every row in lost_and_found,
		// so no faithful candidate exists and the original must stay in place.
		await corruptInteriorPages(dbPath);

		const after = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const finding = after.findings.find(entry => entry.id === "storage.agent.db");
		expect(finding?.status).toBe("error");
		expect(finding?.fixed).toBeUndefined();
		expect(finding?.details.join("\n")).toContain("recovery dump preserved at");
		// The corrupt original is untouched, and the dump keeps the orphaned rows for manual salvage.
		expect(await pathExists(dbPath)).toBe(true);
		expect(quickCheck(dbPath)).not.toBe("ok");
		const backupRoot = path.join(path.dirname(dbPath), ".omp-doctor-backups");
		const backups = (await fs.readdir(backupRoot)).filter(name => name.startsWith("agent.db."));
		expect(backups).toHaveLength(1);
		const dump = await Bun.file(path.join(backupRoot, backups[0] as string, "recovery.sql")).text();
		expect(dump).toContain("INSERT INTO lost_and_found");
	});

	test("freelist-only corruption: salvaged when the CLI supports it, refused safely otherwise", async () => {
		const dbPath = getAgentDbPath(root);
		await createDatabaseWithRows(dbPath, 500);
		const db = new Database(dbPath);
		db.run("DELETE FROM t");
		db.close();
		// The deleted pages are now freelist; corrupting them loses no user rows.
		await corruptInteriorPages(dbPath);

		const after = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const finding = after.findings.find(entry => entry.id === "storage.agent.db");
		if (await recoverSupportsIgnoreFreelist()) {
			// Modern sqlite3: freelist pages are skipped, nothing strands, swap proceeds.
			expect(finding?.fixed).toBe(true);
			expect(finding?.summary).toMatch(/salvaged|rescued/);
			expect(quickCheck(dbPath)).toBe("ok");
		} else {
			// Older sqlite3: plain .recover strands the deleted rows in
			// lost_and_found, so the fidelity guard must refuse the swap and keep
			// the original plus the dump.
			expect(finding?.status).toBe("error");
			expect(finding?.fixed).toBeUndefined();
			expect(quickCheck(dbPath)).not.toBe("ok");
			expect(finding?.details.join("\n")).toContain("recovery dump preserved at");
		}
		const backups = await fs.readdir(path.join(path.dirname(dbPath), ".omp-doctor-backups"));
		expect(backups.some(name => name.startsWith("agent.db."))).toBe(true);
	});

	test("interrupted swap marker: warning read-only, restored under --fix", async () => {
		const dbPath = getAgentDbPath(root);
		await createDatabaseWithRows(dbPath, 10);
		// Simulate a crashed repair: a verified archive of the good database
		// alongside a swap marker, with the live file damaged afterwards.
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		await fs.copyFile(dbPath, path.join(archiveDir, "agent.db"));
		await Bun.write(dbPath, "garbage-not-sqlite");
		const marker = path.join(root, ".agent.db.omp-doctor-swap.json");
		await Bun.write(marker, JSON.stringify({ archive: archiveDir }));

		const readOnly = await runDoctorCommand({ flags: { agentDir: root } });
		const warning = readOnly.findings.find(entry => entry.id === "storage.agent.db");
		expect(warning?.status).toBe("warning");
		expect(warning?.summary).toContain("interrupted swap detected");
		expect(await pathExists(marker)).toBe(true);

		const fixed = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		expect(quickCheck(dbPath)).toBe("ok");
		expect(await pathExists(marker)).toBe(false);
		const finding = fixed.findings.find(entry => entry.id === "storage.agent.db");
		expect(finding?.details.join("\n")).toContain("restored from archive");
	});

	test("WAL is reported uncheckpointed and truncated under --fix", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		// The writer stays open for the whole test: a clean close auto-checkpoints
		// and removes the WAL (gc's fixtures use the same pattern). Our own
		// process holding it is fine — the holder gate excludes self.
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, prompt TEXT)");
		db.run("INSERT INTO t (prompt) VALUES ('hello')");
		const walPath = `${dbPath}-wal`;
		expect((await fs.stat(walPath)).size).toBeGreaterThan(0);

		const before = await runDoctorCommand({ flags: { agentDir: root } });
		const warning = before.findings.find(entry => entry.id === "storage.history.db");
		expect(warning?.status).toBe("warning");
		expect(warning?.summary).toContain("uncheckpointed");

		const after = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const fixed = after.findings.find(entry => entry.id === "storage.history.db");
		expect(fixed?.status).toBe("ok");
		expect(fixed?.summary).toContain("checkpointed");
		expect((await fs.stat(walPath)).size).toBe(0);
		db.close();
	});

	test("a foreign process holding the database blocks repair with a busy warning", async () => {
		const dbPath = getHistoryDbPath(root);
		await createDatabaseWithRows(dbPath, 100);
		const holder = Bun.spawn({
			cmd: [
				"bun",
				"-e",
				`import { Database } from "bun:sqlite"; const db = new Database(${JSON.stringify(dbPath)}); const { promise } = Promise.withResolvers(); await promise;`,
			],
			stdout: "ignore",
			stderr: "ignore",
		});
		const foreignHolders = (): boolean => {
			const result = Bun.spawnSync(["fuser", dbPath]);
			return result.stdout
				.toString()
				.split(/\s+/)
				.some(pid => Number.parseInt(pid, 10) !== process.pid && Number.isFinite(Number.parseInt(pid, 10)));
		};
		try {
			// Real cross-process wait: the condition is an OS-level holder reported by
			// fuser, not wall-clock time, so fake timers cannot drive it. Poll the
			// condition itself instead of sleeping a fixed delay.
			let held = false;
			for (let attempt = 0; attempt < 50 && !held; attempt++) {
				await Bun.sleep(100);
				held = foreignHolders();
			}
			expect(held).toBe(true);

			const report = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
			const finding = report.findings.find(entry => entry.id === "storage.history.db");
			expect(finding?.status).toBe("warning");
			expect(finding?.summary).toContain("busy");
			expect(finding?.fixed).toBeUndefined();
		} finally {
			holder.kill();
		}
		// Once the holder is gone, the same repair proceeds.
		let released = false;
		for (let attempt = 0; attempt < 50 && !released; attempt++) {
			await Bun.sleep(100);
			released = !foreignHolders();
		}
		expect(released).toBe(true);
		const after = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const finding = after.findings.find(entry => entry.id === "storage.history.db");
		expect(finding?.status).toBe("ok");
		expect(finding?.fixed).toBe(true);
	});

	test("foreign-key violations are reported as a warning", async () => {
		const dbPath = getAgentDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=DELETE");
		db.run("PRAGMA foreign_keys=OFF");
		db.run("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
		db.run("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))");
		db.run("INSERT INTO child (parent_id) VALUES (999)");
		db.close();

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "storage.agent.db");
		expect(finding?.status).toBe("warning");
		expect(finding?.summary).toContain("1 foreign-key violations");
	});

	test("missing databases produce no storage findings", async () => {
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		expect(report.findings.filter(finding => finding.category === "storage")).toHaveLength(0);
	});

	test("JSON report shape is stable", async () => {
		await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const parsed = JSON.parse(writes.join("")) as DoctorReport;
		expect(parsed.schemaVersion).toBe(1);
		expect(typeof parsed.generatedAt).toBe("string");
		expect(parsed.fix).toBe(false);
		expect(["ok", "warning", "error"]).toContain(parsed.overallStatus);
		for (const finding of parsed.findings) {
			expect(typeof finding.id).toBe("string");
			expect(["environment", "tools", "storage", "plugins"]).toContain(finding.category);
			expect(["ok", "warning", "error"]).toContain(finding.status);
			expect(typeof finding.summary).toBe("string");
			expect(Array.isArray(finding.details)).toBe(true);
		}
	});

	test("CLI exits nonzero when a finding is an error", async () => {
		const dbPath = getModelDbPath(root);
		await createDatabaseWithRows(dbPath, 500);
		await corruptInteriorPages(dbPath);

		await runCli(["doctor", "--agent-dir", root]);
		expect(process.exitCode).toBe(1);
	});
});
