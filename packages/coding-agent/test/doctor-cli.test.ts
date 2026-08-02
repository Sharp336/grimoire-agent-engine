import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type DoctorFinding,
	type DoctorReport,
	renderDoctorReport,
	runDoctorCommand,
} from "@oh-my-pi/pi-coding-agent/cli/doctor-cli";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getAgentDbPath, getHistoryDbPath, getModelDbPath } from "@oh-my-pi/pi-utils";
import { runCli } from "../src/cli";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let root: string;
let writes: string[] = [];
let stderrWrites: string[] = [];
let stdoutSpy: { mockRestore(): void } | undefined;
let stderrSpy: { mockRestore(): void } | undefined;
let pluginDoctorSpy: { mockRestore(): void } | undefined;
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
	pluginDoctorSpy?.mockRestore();
	pluginDoctorSpy = undefined;
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
	// Wrap in one transaction: autocommit (DELETE-journal mode) fsyncs per row,
	// making 2000 inserts take ~21s and time out under default settings.
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
		// The dump's INSERT spelling varies across sqlite3 versions; the contract
		// is that the 500 orphaned rows survive as data. `.dbconfig` lines are CLI
		// dot-commands, not SQL, so strip them before loading.
		const dump = await Bun.file(path.join(backupRoot, backups[0] as string, "recovery.sql")).text();
		const salvageDb = new Database(path.join(root, "salvage-check.db"));
		try {
			salvageDb.exec(
				dump
					.split("\n")
					.filter(line => !line.startsWith("."))
					.join("\n"),
			);
			const stranded = salvageDb.query("SELECT count(*) AS n FROM lost_and_found").get() as { n: number };
			expect(stranded.n).toBe(500);
		} finally {
			salvageDb.close();
		}
	});

	test("freelist-only corruption is salvaged on any supported sqlite3 CLI", async () => {
		const dbPath = getAgentDbPath(root);
		await createDatabaseWithRows(dbPath, 500);
		const db = new Database(dbPath);
		db.run("DELETE FROM t");
		db.close();
		// The deleted pages are now freelist; corrupting them loses no user rows.
		await corruptInteriorPages(dbPath);

		const after = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const finding = after.findings.find(entry => entry.id === "storage.agent.db");
		// Newer CLIs take `--ignore-freelist`; older ones never walk freelist
		// pages at all (the walk and the flag arrived together). Either way the
		// salvage yields a clean candidate and the swap proceeds.
		expect(finding?.fixed).toBe(true);
		expect(finding?.summary).toMatch(/salvaged|rescued/);
		expect(quickCheck(dbPath)).toBe("ok");
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
		expect(finding?.summary).toContain("restored from archive");
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
		// fuser is Linux-only and absent on Windows and minimal containers; skip
		// where it is unavailable rather than failing the suite on those hosts.
		if (Bun.which("fuser") === null) return;
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
			expect(["environment", "config", "tools", "storage", "plugins"]).toContain(finding.category);
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

	test("broken settings yaml surfaces a config error and leaves the file untouched", async () => {
		const configPath = path.join(root, "config.yml");
		const broken = "theme:\n  dark: [unterminated\n  : : :\n";
		await fs.writeFile(configPath, broken, "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings");
		expect(finding?.status).toBe("error");
		expect(finding?.details.length).toBeGreaterThan(0);
		// The JSON report carries the loader's classify message.
		const parsed = JSON.parse(writes.join("")) as DoctorReport;
		const jsonFinding = parsed.findings.find(entry => entry.id === "config.settings");
		expect(jsonFinding?.status).toBe("error");
		expect(typeof jsonFinding?.details[0]).toBe("string");
		expect((jsonFinding?.details[0] ?? "").length).toBeGreaterThan(0);
		// Read-only probe: the file is byte-identical after the run.
		expect(await fs.readFile(configPath, "utf8")).toBe(broken);
	});

	test("a quarantined config sibling is reported as an error", async () => {
		await fs.writeFile(path.join(root, "settings.yaml.broken-1700000000000-12345-deadbeef"), "garbage", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const quarantine = report.findings.find(entry => entry.id === "config.quarantined");
		expect(quarantine?.status).toBe("error");
		expect(quarantine?.summary).toContain("quarantined");
		expect(quarantine?.details).toContain("settings.yaml.broken-1700000000000-12345-deadbeef");
	});

	test("a broken legacy models.json surfaces a config error, not absent", async () => {
		const modelsJson = path.join(root, "models.json");
		const broken = "{ not valid json ";
		await fs.writeFile(modelsJson, broken, "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.models");
		expect(finding?.status).toBe("error");
		expect(finding?.details.length).toBeGreaterThan(0);
		// Read-only probe: the file is byte-identical after the run.
		expect(await fs.readFile(modelsJson, "utf8")).toBe(broken);
	});

	test("a broken models.yaml surfaces a config error, not absent", async () => {
		const modelsYaml = path.join(root, "models.yaml");
		const broken = "providers:\n  openai: [unterminated\n";
		await fs.writeFile(modelsYaml, broken, "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.models");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).not.toContain("absent");
		expect(finding?.details.length).toBeGreaterThan(0);
		// Read-only probe: the file is byte-identical after the run.
		expect(await fs.readFile(modelsYaml, "utf8")).toBe(broken);
	});

	test("a readdir failure on the agent dir surfaces a quarantine error", async () => {
		const realReaddir = nodeFs.promises.readdir.bind(nodeFs.promises);
		const readdirSpy = spyOn(nodeFs.promises, "readdir").mockImplementation((async (
			dirPath: unknown,
			options: unknown,
		) => {
			if (path.resolve(String(dirPath)) === path.resolve(root)) {
				throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
			}
			return realReaddir(dirPath as never, options as never);
		}) as never);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
			const quarantine = report.findings.find(entry => entry.id === "config.quarantined");
			expect(quarantine?.status).toBe("error");
			expect(quarantine?.summary).toContain("cannot read agent directory");
			expect((quarantine?.details[0] ?? "").length).toBeGreaterThan(0);
		} finally {
			readdirSpy.mockRestore();
		}
	});

	test("an unreadable settings file surfaces an error, not absent", async () => {
		// root bypasses Unix file permissions, so this cannot exercise EACCES.
		if (process.getuid?.() === 0) return;
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, "theme:\n  dark: true\n", "utf8");
		await fs.chmod(configPath, 0o000);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
			const finding = report.findings.find(entry => entry.id === "config.settings");
			expect(finding?.status).toBe("error");
			expect(finding?.summary).toContain("unreadable");
		} finally {
			// Restore permissions so afterEach cleanup can remove the file.
			await fs.chmod(configPath, 0o644);
		}
	});

	test("two broken backups of the same config produce one finding with both files", async () => {
		await fs.writeFile(path.join(root, "models.yml.broken-1700000000000-aaa"), "garbage1", "utf8");
		await fs.writeFile(path.join(root, "models.yml.broken-1700000000001-bbb"), "garbage2", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const quarantine = report.findings.filter(entry => entry.id === "config.quarantined");
		expect(quarantine).toHaveLength(1);
		expect(quarantine[0]?.details).toHaveLength(2);
		expect(quarantine[0]?.details).toContain("models.yml.broken-1700000000000-aaa");
		expect(quarantine[0]?.details).toContain("models.yml.broken-1700000000001-bbb");
	});

	test("an unrelated broken file is ignored by the quarantine scan", async () => {
		await fs.writeFile(path.join(root, "foo.broken-1700000000000-xyz"), "garbage", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const quarantine = report.findings.filter(entry => entry.id === "config.quarantined");
		expect(quarantine).toHaveLength(0);
	});

	test("a clean temp dir yields ok config findings", async () => {
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const configFindings = report.findings.filter(entry => entry.category === "config");
		expect(configFindings.length).toBeGreaterThan(0);
		for (const finding of configFindings) expect(finding.status).toBe("ok");
	});

	test("FK violations stay warning after --fix ran maintenance", async () => {
		const dbPath = getAgentDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=DELETE");
		db.run("PRAGMA foreign_keys=OFF");
		db.run("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
		db.run("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))");
		db.run("INSERT INTO child (parent_id) VALUES (999)");
		db.close();

		const report = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const finding = report.findings.find(entry => entry.id === "storage.agent.db");
		// Maintenance actions (optimize) ran but FK violations are unresolved;
		// the finding must stay warning, not collapse to ok. The FK issue itself
		// was not repaired, so no fixed flag even though actions ran.
		expect(finding?.status).toBe("warning");
		expect(finding?.summary).toContain("foreign-key violations");
		expect(finding?.fixed).toBeUndefined();
	});

	test("plugin doctor throw produces a plugins error finding without aborting the report", async () => {
		pluginDoctorSpy = spyOn(PluginManager.prototype, "doctor").mockImplementation(() => {
			throw new Error("malformed plugins/package.json");
		});
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const pluginFinding = report.findings.find(entry => entry.category === "plugins");
		expect(pluginFinding?.status).toBe("error");
		expect(pluginFinding?.summary).toContain("plugin doctor failed");
		// Other sections still collected — environment and tools are present.
		expect(report.findings.some(entry => entry.category === "environment")).toBe(true);
		expect(report.findings.some(entry => entry.category === "tools")).toBe(true);
	});

	test("a small free-heavy database does not warn (threshold alignment)", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=DELETE");
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
		db.run("BEGIN");
		const insert = db.prepare("INSERT INTO t (blob) VALUES (?)");
		for (let index = 0; index < 20; index++) insert.run("x".repeat(100));
		db.run("COMMIT");
		db.run("DELETE FROM t");
		db.close();
		// The db is well under the 1 MiB vacuum floor; vacuumEligible returns
		// false, so the free-page warning must NOT fire.
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "storage.history.db");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).not.toContain("free pages");
	});

	test("renderer sanitizes a finding id containing a tab", async () => {
		// A tab in an id tail (plugin name or autoresearch filename) would break
		// terminal alignment; the renderer must replaceTabs it before emitting.
		const report: DoctorReport = {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			ompVersion: "test",
			fix: false,
			overallStatus: "ok",
			findings: [
				{
					id: "plugins.bad\tname",
					category: "plugins",
					status: "ok",
					summary: "ok",
					details: [],
				} satisfies DoctorFinding,
			],
		};
		const rendered = renderDoctorReport(report);
		expect(rendered).not.toContain("\t");
	});

	test("a salvage swap preserves the original file mode", async () => {
		const dbPath = getAgentDbPath(root);
		await createDatabaseWithRows(dbPath, 500);
		const db = new Database(dbPath);
		db.run("DELETE FROM t");
		db.close();
		await corruptInteriorPages(dbPath);
		await fs.chmod(dbPath, 0o600);

		await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		// The swapped-in candidate must inherit the original 0600 mode, not the
		// process umask default (which could be world-readable).
		const mode = (await fs.stat(dbPath)).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test("a successful swap cleans up the marker and does not trigger a false rollback", async () => {
		const dbPath = getAgentDbPath(root);
		await createDatabaseWithRows(dbPath, 500);
		const db = new Database(dbPath);
		db.run("DELETE FROM t");
		db.close();
		await corruptInteriorPages(dbPath);

		await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		// The marker must be gone after a successful swap.
		const marker = path.join(path.dirname(dbPath), ".agent.db.omp-doctor-swap.json");
		expect(await pathExists(marker)).toBe(false);
		// A subsequent read-only run must NOT report an interrupted swap.
		const readOnly = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = readOnly.findings.find(entry => entry.id === "storage.agent.db");
		expect(finding?.summary).not.toContain("interrupted swap");
	});

	test("a non-ENOENT stat error surfaces as an error finding, not silently skipped", async () => {
		const dbPath = getHistoryDbPath(root);
		await createDatabaseWithRows(dbPath, 10);
		const realStat = fs.stat.bind(fs);
		const statSpy = spyOn(fs, "stat").mockImplementation((async (target: unknown) => {
			if (path.resolve(String(target)) === path.resolve(dbPath)) {
				throw Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" });
			}
			return realStat(target as never);
		}) as never);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "storage.history.db");
			// The engine marks non-ENOENT stat failures as present+openError;
			// the collector must surface it as an error, not skip it.
			expect(finding?.status).toBe("error");
			expect(finding?.summary).toContain("cannot open");
		} finally {
			statSpy.mockRestore();
		}
	});
});
