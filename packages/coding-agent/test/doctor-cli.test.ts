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
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import * as browserLaunch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import * as piUtils from "@oh-my-pi/pi-utils";
import { getAgentDbPath, getHistoryDbPath, getModelDbPath, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { Browser, computeExecutablePath, detectBrowserPlatform, resolveBuildId } from "@puppeteer/browsers";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";
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
const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "modes", "theme", "dark.json");

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
		const corruptBytes = await fs.readFile(dbPath);

		const before = await runDoctorCommand({ flags: { agentDir: root } });
		expect(before.findings.find(finding => finding.id === "storage.models.db")?.status).toBe("error");

		const after = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const finding = after.findings.find(entry => entry.id === "storage.models.db");
		expect(finding?.status).toBe("ok");
		expect(finding?.fixed).toBe(true);
		expect(
			finding?.details.some(
				detail => detail.includes("originals preserved at") && detail.includes(".omp-doctor-backups"),
			),
		).toBe(true);
		expect(await pathExists(dbPath)).toBe(false);
		const siblings = await fs.readdir(path.dirname(dbPath));
		expect(siblings.filter(name => name.startsWith("models.db.corrupt-"))).toHaveLength(1);
		const backupRoot = path.join(path.dirname(dbPath), ".omp-doctor-backups");
		const backups = (await fs.readdir(backupRoot)).filter(name => name.startsWith("models.db."));
		const [backup] = backups;
		if (!backup) throw new Error("missing model database backup");
		expect((await fs.readFile(path.join(backupRoot, backup, "models.db"))).equals(corruptBytes)).toBe(true);
	});

	test("destructive repair supersedes stale foreign-key violations", async () => {
		const dbPath = getModelDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=DELETE");
		db.run("CREATE TABLE filler (id INTEGER PRIMARY KEY, blob TEXT)");
		const insert = db.prepare("INSERT INTO filler (blob) VALUES (?)");
		db.run("BEGIN");
		for (let index = 0; index < 200; index++) insert.run("x".repeat(1024));
		db.run("COMMIT");
		db.run("PRAGMA foreign_keys=OFF");
		db.run("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
		db.run("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))");
		db.run("INSERT INTO child (parent_id) VALUES (999)");
		db.close();
		await corruptInteriorPages(dbPath);

		const before = await runDoctorCommand({ flags: { agentDir: root } });
		const staleFinding = before.findings.find(entry => entry.id === "storage.models.db");
		expect(staleFinding?.status).toBe("warning");
		expect(staleFinding?.summary).toContain("foreign-key violations");

		const after = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const repairedFinding = after.findings.find(entry => entry.id === "storage.models.db");
		expect(repairedFinding?.status).toBe("ok");
		expect(repairedFinding?.fixed).toBe(true);
		expect(repairedFinding?.summary).toContain("quarantined");
		expect(repairedFinding?.summary).not.toContain("foreign-key violations");
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

	test("interrupted legacy marker with unrecognized live data requires manual recovery", async () => {
		const dbPath = getAgentDbPath(root);
		await createDatabaseWithRows(dbPath, 10);
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
		const finding = fixed.findings.find(entry => entry.id === "storage.agent.db");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("recovery did not complete");
		expect(finding?.details.join("\n")).toContain("unrecognized live database state");
		expect(await Bun.file(dbPath).text()).toBe("garbage-not-sqlite");
		expect(await pathExists(marker)).toBe(true);
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
			expect(["environment", "config", "tools", "storage", "mcp", "browser", "auth", "setup", "plugins"]).toContain(
				finding.category,
			);
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
			expect(quarantine?.summary).toContain("cannot read config directory");
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

	test("uses the configured Mnemopi database path", async () => {
		const dbPath = path.join(root, "configured-mnemopi", "custom.db");
		await fs.writeFile(path.join(root, "config.yml"), `mnemopi:\n  dbPath: ${JSON.stringify(dbPath)}\n`, "utf8");
		await createDatabaseWithRows(dbPath, 1);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "storage.mnemopi/mnemopi.db");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toContain("mnemopi/mnemopi.db");
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

	test("malformed plugin lockfile is reported without suppressing other plugin checks", async () => {
		setAgentDir(root);
		setProjectDir(root);
		const lockfile = path.join(root, "omp-plugins.lock.json");
		const original = "{ broken";
		await fs.writeFile(lockfile, original, "utf8");
		const lockfileSpy = spyOn(piUtils, "getPluginsLockfile").mockReturnValue(lockfile);
		pluginDoctorSpy = spyOn(PluginManager.prototype, "doctor").mockResolvedValue([
			{ name: "remaining-check", status: "ok", message: "remaining plugin check ran" },
		]);
		try {
			const report = await runDoctorCommand({ flags: { fix: true, json: true } });
			const lockfileFinding = report.findings.find(entry => entry.id === "plugins.lockfile");
			expect(lockfileFinding?.status).toBe("error");
			expect(lockfileFinding?.details.some(detail => detail.includes("omp-plugins.lock.json"))).toBe(true);
			expect(report.findings.find(entry => entry.id === "plugins.remaining-check")?.status).toBe("ok");
			expect(pluginDoctorSpy).toHaveBeenCalledWith({ fix: false });
			expect(await Bun.file(lockfile).text()).toBe(original);
		} finally {
			lockfileSpy.mockRestore();
		}
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

	test("renderer strips terminal controls; JSON keeps raw finding text", async () => {
		// Untrusted finding fields (plugin messages) may embed ANSI/C0. Human
		// output must strip them; --json must leave the report payload raw.
		const rawMessage = "plugin\u001b[31m red\u001b[0m \u0007bell";
		pluginDoctorSpy = spyOn(PluginManager.prototype, "doctor").mockImplementation(async () => [
			{ name: "evil\u001b[31m", status: "error", message: rawMessage },
		]);

		writes = [];
		const jsonReport = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const jsonOut = writes.join("");
		expect(jsonOut).toContain("\\u001b[31m");
		expect(jsonOut).toContain("\\u0007bell");
		const jsonFinding = jsonReport.findings.find(entry => entry.summary === rawMessage);
		expect(jsonFinding?.status).toBe("error");
		expect(jsonFinding?.summary).toBe(rawMessage);

		writes = [];
		await runDoctorCommand({ flags: { agentDir: root } });
		const humanOut = writes.join("");
		expect(humanOut).not.toContain("\u001b");
		expect(humanOut).not.toContain("\u0007");
		expect(humanOut).toContain("plugin red bell");
	});

	test("mnemopi bank scan failure surfaces as storage.mnemopi alongside other probes", async () => {
		// Agent-scoped mnemopi bank discovery must not swallow non-ENOENT failures,
		// and must not prevent probing other databases in the same report.
		setAgentDir(root);
		await createDatabaseWithRows(getHistoryDbPath(root), 10);
		const memories = path.join(root, "memories");
		await fs.mkdir(memories, { recursive: true });
		await fs.writeFile(path.join(memories, "mnemopi"), "x");
		const memSpy = spyOn(piUtils, "getMemoriesDir").mockReturnValue(memories);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
			const scanFinding = report.findings.find(entry => entry.id === "storage.mnemopi");
			expect(scanFinding?.status).toBe("error");
			expect(scanFinding?.summary).toContain("cannot scan");
			expect(scanFinding?.details.some(detail => /ENOTDIR|EACCES/.test(detail))).toBe(true);
			const history = report.findings.find(entry => entry.id === "storage.history.db");
			expect(history).toBeDefined();
			expect(history?.status).toBe("ok");
		} finally {
			memSpy.mockRestore();
		}
	});

	test("autoresearch scan failure surfaces alongside another storage finding", async () => {
		// Root-scoped autoresearch discovery must not swallow non-ENOENT failures,
		// and must not prevent probing other databases in the same report.
		setAgentDir(root);
		await createDatabaseWithRows(getHistoryDbPath(root), 10);
		const notADir = path.join(root, "autoresearch-file");
		await fs.writeFile(notADir, "x");
		const autoSpy = spyOn(piUtils, "getAutoresearchDir").mockReturnValue(notADir);
		const statsSpy = spyOn(piUtils, "getStatsDbPath").mockReturnValue(path.join(root, "stats.db"));
		const autoqaSpy = spyOn(piUtils, "getAutoQaDbPath").mockReturnValue(path.join(root, "autoqa.db"));
		const ghSpy = spyOn(piUtils, "getGithubCacheDbPath").mockReturnValue(path.join(root, "github-cache.db"));
		try {
			const report = await runDoctorCommand({ flags: { json: true } });
			const scanFinding = report.findings.find(entry => entry.id === "storage.autoresearch");
			expect(scanFinding?.status).toBe("error");
			expect(scanFinding?.summary).toContain("cannot scan");
			expect(scanFinding?.details.some(detail => /ENOTDIR|EACCES/.test(detail))).toBe(true);
			const history = report.findings.find(entry => entry.id === "storage.history.db");
			expect(history).toBeDefined();
			expect(history?.status).toBe("ok");
		} finally {
			autoSpy.mockRestore();
			statsSpy.mockRestore();
			autoqaSpy.mockRestore();
			ghSpy.mockRestore();
		}
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

	test("MCP server with an invalid spec is an error", async () => {
		// validateServerConfig rejects a stdio server missing "command".
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(mcpJson, JSON.stringify({ mcpServers: { broken: { type: "stdio" } } }), "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "mcp.broken");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("invalid spec");
		expect(finding?.details.length).toBeGreaterThan(0);
		// Read-only: the file is untouched.
		expect(await fs.readFile(mcpJson, "utf8")).toBe(JSON.stringify({ mcpServers: { broken: { type: "stdio" } } }));
	});

	test("MCP stdio server with a nonexistent command is an error", async () => {
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: { ghost: { type: "stdio", command: "this-binary-does-not-exist-anywhere-xyz" } },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.ghost");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("command not found");
	});

	test("MCP denylisted server reports disabled without probing its command", async () => {
		setProjectDir(root);
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				disabledServers: ["ghost"],
				mcpServers: { ghost: { type: "stdio", command: "this-binary-does-not-exist-anywhere-xyz" } },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.ghost");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toContain("disabled");
	});

	test("MCP enabledServers restores probing for a source-disabled server", async () => {
		setProjectDir(root);
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				enabledServers: ["ghost"],
				mcpServers: {
					ghost: { type: "stdio", command: "this-binary-does-not-exist-anywhere-xyz", enabled: false },
				},
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.ghost");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("command not found");
	});

	test("MCP stdio server with env.PATH restricting to a dir without the command → error, not process-PATH fallback", async () => {
		// When a server sets env.PATH to an authoritative restricted path that
		// does not contain its bare command, the real transport merges
		// config.env over Bun.env so that PATH replaces the process value and
		// the spawn fails. The doctor must mirror that: resolve via the
		// config PATH only and report "command not found" — NOT fall back to
		// the doctor's own process PATH (where e.g. `node` exists).
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: {
					restricted: { type: "stdio", command: "node", env: { PATH: "/nonexistent-restricted-path" } },
				},
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.restricted");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("command not found");
	});

	test("MCP http server with a valid URL is ok", async () => {
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://mcp.example.com/sse" } } }),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.remote");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toContain("https://mcp.example.com");
	});

	test("no MCP config yields a single ok finding", async () => {
		// Scope both user and project dirs to the empty temp root so the real
		// project dir's configs (if any) don't pollute the finding count.
		setProjectDir(root);
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const mcpFindings = report.findings.filter(entry => entry.category === "mcp");
		expect(mcpFindings).toHaveLength(1);
		expect(mcpFindings[0]?.status).toBe("ok");
		expect(mcpFindings[0]?.summary).toContain("no MCP servers configured");
	});

	test("MCP server from a project .mcp.json is diagnosed", async () => {
		// The real loader scans project-level .mcp.json, not just the user-level
		// omp mcp.json. A server defined only in .mcp.json must be visible to doctor.
		// setProjectDir(root) so the mcp-json provider finds root/.mcp.json.
		setProjectDir(root);
		const projectMcp = path.join(root, ".mcp.json");
		await fs.writeFile(
			projectMcp,
			JSON.stringify({
				mcpServers: { projServer: { type: "http", url: "https://project-mcp.example.com" } },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.projServer");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toContain("https://project-mcp.example.com");
	});

	test("a null MCP server entry produces an error finding without crashing", async () => {
		// A malformed entry (null instead of an object) must not crash the report;
		// the provider throw is caught by the capability loader and surfaced as a
		// warning, which the collector turns into an error finding.
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(mcpJson, JSON.stringify({ mcpServers: { broken: null } }), "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		// The report must still be emitted — no crash.
		expect(report.findings.some(entry => entry.category === "environment")).toBe(true);
		// The malformed entry must surface as an error, not be silently ignored.
		const mcpErrors = report.findings.filter(entry => entry.category === "mcp" && entry.status === "error");
		expect(mcpErrors.length).toBeGreaterThan(0);
		expect(mcpErrors.some(entry => entry.details.length > 0)).toBe(true);
	});

	test("MCP server with malformed optional field shapes is an error", async () => {
		// validateServerConfig only checks transport endpoints; args/env/headers
		// shapes pass malformed. The doctor's shape validation must catch them.
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: { badShape: { type: "stdio", command: "node", args: "not-an-array" } },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.badShape");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("invalid spec");
		expect(finding?.details.some(d => d.includes("args"))).toBe(true);
	});

	test("MCP server with malformed enabled field is an error", async () => {
		// The native provider normalizes enabled:{} → undefined before
		// diagnoseMcpServer sees it. The doctor must validate the RAW entry
		// so the malformation is caught.
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: { badEnabled: { type: "stdio", command: "node", enabled: {} } },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.badEnabled");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("enabled"))).toBe(true);
	});

	test("MCP server with malformed timeout field is an error", async () => {
		// The native provider normalizes timeout:{} → undefined before
		// diagnoseMcpServer sees it. The doctor must validate the RAW entry.
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: { badTimeout: { type: "stdio", command: "node", timeout: "not-a-number" } },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.badTimeout");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("timeout"))).toBe(true);
	});

	test("disabled MCP server with malformed spec is an error, not ok", async () => {
		// Shape validation must run BEFORE the disabled shortcut so a disabled
		// server with a broken spec still reports the error.
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: { disabledBad: { type: "stdio", command: 7, enabled: false } },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.disabledBad");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("command"))).toBe(true);
	});

	test("MCP server with non-string env value is an error", async () => {
		// env values must be strings; a numeric value would crash the spawn path.
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: { badEnv: { type: "stdio", command: "node", env: { KEY: 7 } } },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.badEnv");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("env.KEY"))).toBe(true);
	});

	test("MCP server with null enabled is an error, not absent", async () => {
		// null is malformed, not absent — the doctor must report it.
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: { nullEnabled: { type: "stdio", command: "node", enabled: null } },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.nullEnabled");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("enabled") && d.includes("null"))).toBe(true);
	});

	test("MCP server with null timeout is an error, not absent", async () => {
		// null is malformed, not absent — the doctor must report it.
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: { nullTimeout: { type: "stdio", command: "node", timeout: null } },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "mcp.nullTimeout");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("timeout") && d.includes("null"))).toBe(true);
	});

	test("browser: PUPPETEER_EXECUTABLE_PATH pointing at a missing file is an error", async () => {
		// Spy on the resolution seams (not process.env) so the test is hermetic.
		// resolveSystemChromium returns undefined so the env override is actually evaluated.
		const chromeSpy = spyOn(browserLaunch, "resolveSystemChromium").mockReturnValue(undefined);
		const envSpy = spyOn(browserLaunch, "readChromiumEnvOverride").mockReturnValue(
			path.join(root, "nonexistent-chrome"),
		);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "browser.chromium");
			expect(finding?.category).toBe("browser");
			expect(finding?.status).toBe("error");
			expect(finding?.summary).toContain("missing file");
			expect(finding?.remedy).toBeDefined();
		} finally {
			chromeSpy.mockRestore();
			envSpy.mockRestore();
		}
	});

	test("browser: system Chrome resolution returns a path → ok", async () => {
		const fakePath = path.join(root, "fake-chrome");
		await fs.writeFile(fakePath, "fake", "utf8");
		const chromeSpy = spyOn(browserLaunch, "resolveSystemChromium").mockReturnValue(fakePath);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "browser.chromium");
			expect(finding?.category).toBe("browser");
			expect(finding?.status).toBe("ok");
			expect(finding?.summary).toBe(fakePath);
		} finally {
			chromeSpy.mockRestore();
		}
	});

	test("browser: nothing resolvable → warning", async () => {
		const chromeSpy = spyOn(browserLaunch, "resolveSystemChromium").mockReturnValue(undefined);
		const envSpy = spyOn(browserLaunch, "readChromiumEnvOverride").mockReturnValue(undefined);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "browser.chromium");
			expect(finding?.category).toBe("browser");
			expect(finding?.status).toBe("warning");
			expect(finding?.summary).toContain("no system Chrome/Chromium");
			expect(finding?.remedy).toBeDefined();
		} finally {
			chromeSpy.mockRestore();
			envSpy.mockRestore();
		}
	});
	test("browser: PUPPETEER_EXECUTABLE_PATH pointing at an existing file → ok", async () => {
		const fakePath = path.join(root, "env-chrome");
		await fs.writeFile(fakePath, "fake", "utf8");
		await fs.chmod(fakePath, 0o755);
		const chromeSpy = spyOn(browserLaunch, "resolveSystemChromium").mockReturnValue(undefined);
		const envSpy = spyOn(browserLaunch, "readChromiumEnvOverride").mockReturnValue(fakePath);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "browser.chromium");
			expect(finding?.category).toBe("browser");
			expect(finding?.status).toBe("ok");
			expect(finding?.summary).toBe(fakePath);
			expect(finding?.details).toContain("resolved via PUPPETEER_EXECUTABLE_PATH");
		} finally {
			chromeSpy.mockRestore();
			envSpy.mockRestore();
		}
	});

	test("browser: PUPPETEER_EXECUTABLE_PATH pointing at a non-executable file → error (POSIX)", async () => {
		if (process.platform === "win32") return; // X_OK not enforced on win32
		const fakePath = path.join(root, "env-chrome-noexec");
		await fs.writeFile(fakePath, "fake", "utf8");
		await fs.chmod(fakePath, 0o644); // readable but not executable
		const chromeSpy = spyOn(browserLaunch, "resolveSystemChromium").mockReturnValue(undefined);
		const envSpy = spyOn(browserLaunch, "readChromiumEnvOverride").mockReturnValue(fakePath);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "browser.chromium");
			expect(finding?.category).toBe("browser");
			expect(finding?.status).toBe("error");
			expect(finding?.summary).toContain("not executable");
			expect(finding?.remedy).toBeDefined();
		} finally {
			chromeSpy.mockRestore();
			envSpy.mockRestore();
		}
	});

	// ── auth section ────────────────────────────────────────────────────────
	// Fixtures build the REAL auth_credentials layout that SqliteAuthCredentialStore
	// owns (same DDL, same `data` JSON shape serializeCredential writes), so the
	// doctor's read-only probe reads exactly what a real store would persist.

	/** Create agent.db with the real auth_credentials schema and one credential row. */
	async function createAuthCredential(
		dbPath: string,
		provider: string,
		credentialType: "api_key" | "oauth",
		data: Record<string, unknown>,
	): Promise<void> {
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=DELETE");
		db.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		db.run("INSERT INTO auth_schema_version (id, version) VALUES (1, 7)");
		db.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)", [
			provider,
			credentialType,
			JSON.stringify(data),
		]);
		db.close();
	}

	/** Create agent.db with a legacy v0 auth_credentials schema (no disabled_cause). */
	async function createAuthCredentialV0(
		dbPath: string,
		provider: string,
		credentialType: "api_key" | "oauth",
		data: Record<string, unknown>,
		disabled?: boolean,
	): Promise<void> {
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=DELETE");
		db.run(`
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		db.run("INSERT INTO auth_credentials (provider, credential_type, data, disabled) VALUES (?, ?, ?, ?)", [
			provider,
			credentialType,
			JSON.stringify(data),
			disabled ? 1 : 0,
		]);
		db.close();
	}

	test("auth: expired OAuth token with non-empty refresh → ok (refreshable at runtime)", async () => {
		const dbPath = getAgentDbPath(root);
		// Real OAuth `data` shape: { refresh, access, expires, ... } (type stripped by serializeCredential).
		// An expired access token with a non-empty refresh field is usable at runtime
		// — the runtime refreshes transparently — so doctor must report ok, not a
		// re-login warning. The remote sentinel ("__remote__") also counts as non-empty.
		await createAuthCredential(dbPath, "anthropic", "oauth", {
			refresh: "r",
			access: "a",
			expires: Date.now() - 1000,
		});
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "auth.anthropic");
		expect(finding).toBeDefined();
		if (finding === undefined) return;
		expect(finding.category).toBe("auth");
		expect(finding.status).toBe("ok");
		expect(finding.summary).toContain("credentials present");
		// Never surface secret material.
		expect(JSON.stringify(finding)).not.toContain("refresh");
		expect(JSON.stringify(finding)).not.toContain('"a"');
	});

	test("auth: expired OAuth token with empty/whitespace refresh → warning", async () => {
		const dbPath = getAgentDbPath(root);
		// An expired OAuth token whose refresh field is empty or whitespace-only
		// cannot be refreshed at runtime — doctor must warn (re-login required).
		await createAuthCredential(dbPath, "anthropic", "oauth", {
			refresh: "   ",
			access: "a",
			expires: Date.now() - 1000,
		});
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "auth.anthropic");
		expect(finding).toBeDefined();
		if (finding === undefined) return;
		expect(finding.category).toBe("auth");
		expect(finding.status).toBe("warning");
		expect(finding.summary).toContain("expired");
		expect(finding.remedy).toContain("omp login");
		// Never surface secret material.
		expect(JSON.stringify(finding)).not.toContain("refresh");
		expect(JSON.stringify(finding)).not.toContain('"a"');
	});

	test("auth: v0 legacy schema with active row → ok with migration-pending warning", async () => {
		const dbPath = getAgentDbPath(root);
		// Legacy v0 schema: no disabled_cause, has disabled integer column.
		// An active row (disabled=0) must be recognized as usable, and the
		// pending migration must be reported as a warning finding.
		await createAuthCredentialV0(dbPath, "openai", "api_key", { key: "sk-v0" });
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const providerFinding = report.findings.find(entry => entry.id === "auth.openai");
		expect(providerFinding).toBeDefined();
		expect(providerFinding?.status).toBe("ok");
		expect(providerFinding?.summary).toContain("credentials present");
		const migrationFinding = report.findings.find(entry => entry.id === "auth.storage");
		expect(migrationFinding).toBeDefined();
		expect(migrationFinding?.status).toBe("warning");
		expect(migrationFinding?.summary).toContain("pending automatic migration");
		// Never surface the secret key.
		expect(JSON.stringify(report)).not.toContain("sk-v0");
	});

	test("auth: v0 legacy schema with disabled row → no-credentials warning with migration-pending warning", async () => {
		const dbPath = getAgentDbPath(root);
		// Legacy v0 schema: a disabled row (disabled=1) must be recognized as a
		// soft-deleted tombstone (matching v0→v1 migration semantics), so the
		// provider has no active credentials. Both the no-credentials warning and
		// the migration-pending warning must appear.
		await createAuthCredentialV0(
			dbPath,
			"anthropic",
			"oauth",
			{ refresh: "r", access: "a", expires: Date.now() + 60000 },
			true,
		);
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const providerFinding = report.findings.find(entry => entry.id === "auth.anthropic");
		expect(providerFinding).toBeDefined();
		expect(providerFinding?.status).toBe("warning");
		expect(providerFinding?.summary).toContain("no credentials");
		const migrationFinding = report.findings.find(entry => entry.id === "auth.storage");
		expect(migrationFinding).toBeDefined();
		expect(migrationFinding?.status).toBe("warning");
		expect(migrationFinding?.summary).toContain("pending automatic migration");
	});

	test("auth: valid stored credential → ok", async () => {
		const dbPath = getAgentDbPath(root);
		// Real api_key `data` shape: { key }.
		await createAuthCredential(dbPath, "openai", "api_key", { key: "sk-test" });
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "auth.openai");
		expect(finding).toBeDefined();
		if (finding === undefined) return;
		expect(finding.category).toBe("auth");
		expect(finding.status).toBe("ok");
		expect(finding.summary).toContain("credentials present");
		// Never surface the secret key.
		expect(JSON.stringify(finding)).not.toContain("sk-test");
	});

	test("auth: no auth storage → single ok finding", async () => {
		// Fresh temp root: no agent.db, no config.yml, no broker env.
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const authFindings = report.findings.filter(entry => entry.category === "auth");
		expect(authFindings).toHaveLength(1);
		const authFinding = authFindings[0];
		expect(authFinding).toBeDefined();
		if (authFinding === undefined) return;
		expect(authFinding.status).toBe("ok");
		expect(authFinding.summary).toContain("no credentials stored");
	});

	test("auth: !command-backed broker URL is not executed and reports command-backed", async () => {
		// Write a real config.yml under the temp agent dir with a !-prefixed
		// broker URL. The doctor-specific resolver must NOT execute the command;
		// if it did, "PWNED" (the command stdout) would become the broker URL.
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, `${["auth:", "  broker:", '    url: "!echo PWNED"'].join("\n")}\n`, "utf8");
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const brokerFinding = report.findings.find(entry => entry.id === "auth.broker");
		expect(brokerFinding).toBeDefined();
		if (brokerFinding === undefined) return;
		expect(brokerFinding.category).toBe("auth");
		expect(brokerFinding.status).toBe("warning");
		expect(brokerFinding.summary).toContain("command-backed");
		// The command stdout must never appear anywhere in the report.
		expect(JSON.stringify(report)).not.toContain("PWNED");
	});

	test("auth: broker URL with userinfo is sanitized in JSON output", async () => {
		// A broker URL carrying embedded credentials (user:secret@) must have
		// the userinfo stripped before reaching any finding; the password must
		// not appear in the human or JSON report.
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(
			configPath,
			`${["auth:", "  broker:", '    url: "https://user:secret@broker.example"', '    token: "tok"'].join("\n")}\n`,
			"utf8",
		);
		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const brokerFinding = report.findings.find(entry => entry.id === "auth.broker");
		expect(brokerFinding).toBeDefined();
		if (brokerFinding === undefined) return;
		expect(brokerFinding.category).toBe("auth");
		expect(brokerFinding.status).toBe("ok");
		// The origin (scheme://host) should appear in details, not the full URL.
		expect(brokerFinding.details.some(d => d === "https://broker.example")).toBe(true);
		// The password must not appear anywhere in the report.
		expect(JSON.stringify(report)).not.toContain("secret");
		expect(JSON.stringify(report)).not.toContain("user:secret");
	});

	test("auth: broker URL with query-string token is sanitized in JSON output", async () => {
		// A broker URL carrying a token in the query string (?token=secret) must
		// have the query stripped (origin-only) before reaching any finding.
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(
			configPath,
			`${["auth:", "  broker:", '    url: "https://broker.example?token=secret"', '    token: "tok"'].join("\n")}\n`,
			"utf8",
		);
		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const brokerFinding = report.findings.find(entry => entry.id === "auth.broker");
		expect(brokerFinding).toBeDefined();
		if (brokerFinding === undefined) return;
		expect(brokerFinding.category).toBe("auth");
		expect(brokerFinding.status).toBe("ok");
		expect(brokerFinding.details.some(d => d === "https://broker.example")).toBe(true);
		// The query-string token must not appear anywhere in the report.
		expect(JSON.stringify(report)).not.toContain("token=secret");
		expect(JSON.stringify(report)).not.toContain("=secret");
	});

	test("auth: unusable broker URL is an error without leaking the configured value", async () => {
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(
			configPath,
			`${["auth:", "  broker:", '    url: "ftp://user:broker-secret@broker.example"', '    token: "token"'].join("\n")}\n`,
			"utf8",
		);
		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const brokerFinding = report.findings.find(entry => entry.id === "auth.broker");
		expect(brokerFinding?.status).toBe("error");
		expect(brokerFinding?.summary).toContain("unusable");
		expect(JSON.stringify(report)).not.toContain("broker-secret");
		expect(JSON.stringify(report)).not.toContain("ftp://");
	});

	test("auth: scoped run with broker URL but no scoped token does not see the global token file", async () => {
		// When --agent-dir is set, the global broker token file
		// (~/.omp/auth-broker.token) is outside scope. A broker URL in the
		// scoped config.yml with NO scoped token (env or config) must NOT
		// resolve via the global file — the broker finding is suppressed and
		// the local store is probed instead.
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(
			configPath,
			`${["auth:", "  broker:", '    url: "https://broker.example"'].join("\n")}\n`,
			"utf8",
		);
		// No OMP_AUTH_BROKER_TOKEN env, no auth.broker.token in config.yml.
		// Even if a global token file exists, the scoped run must not read it.
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const brokerFinding = report.findings.find(entry => entry.id === "auth.broker");
		// The broker finding must NOT be an ok "credentials served by remote
		// auth broker" — that would mean the global token file was read.
		expect(brokerFinding?.status).not.toBe("ok");
		expect(brokerFinding?.summary).not.toContain("credentials served by remote auth broker");
	});

	test("auth: !command-backed broker token with literal URL reports command-backed, not missing-token", async () => {
		// A literal broker URL with a !command-backed token and no token file
		// fallback makes resolveAuthBrokerConfig throw (no token resolved). The
		// catch must classify the command-backed field BEFORE emitting a
		// missing-token error, so the finding is a warning, not an error.
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(
			configPath,
			`${["auth:", "  broker:", '    url: "https://broker.example"', '    token: "!echo ZKQMCMD"'].join("\n")}\n`,
			"utf8",
		);
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const brokerFinding = report.findings.find(entry => entry.id === "auth.broker");
		expect(brokerFinding).toBeDefined();
		if (brokerFinding === undefined) return;
		expect(brokerFinding.category).toBe("auth");
		expect(brokerFinding.status).toBe("warning");
		expect(brokerFinding.summary).toContain("command-backed");
		// The command stdout must never appear anywhere in the report.
		expect(JSON.stringify(report)).not.toContain("ZKQMCMD");
	});

	test("auth: WAL-mode agent.db is probed without creating -wal/-shm sidecars", async () => {
		// A cleanly closed WAL-mode database with sidecars removed must be
		// probed via the immutable URI so the read-only doctor run creates no
		// -wal/-shm files. Skip under root (chmod cannot restrict a directory
		// the uid-0 process owns), mirroring the EACCES test guard.
		if (process.getuid?.() === 0) return;
		const dbPath = getAgentDbPath(root);
		await createAuthCredential(dbPath, "openai", "api_key", { key: "sk-test" });
		// Reopen in WAL mode, write a row, and close cleanly — the close
		// auto-checkpoints and removes the sidecars, leaving a WAL-header db
		// with no -wal/-shm.
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)", [
			"anthropic",
			"api_key",
			JSON.stringify({ key: "sk-second" }),
		]);
		db.close();
		// Confirm the sidecars are gone after the clean close.
		expect(await pathExists(`${dbPath}-wal`)).toBe(false);
		expect(await pathExists(`${dbPath}-shm`)).toBe(false);
		const dir = path.dirname(dbPath);
		const before = new Set(await fs.readdir(dir));
		// Make the directory read-only so a mutating open (which creates
		// -wal/-shm) would fail with EACCES — proving the immutable path is used.
		await fs.chmod(dir, 0o500);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "auth.openai");
			expect(finding).toBeDefined();
			expect(finding?.status).toBe("ok");
			expect(finding?.summary).toContain("credentials present");
			// No new files (no -wal/-shm) were created in the directory.
			const after = new Set(await fs.readdir(dir));
			const created = [...after].filter(name => !before.has(name));
			expect(created).toHaveLength(0);
		} finally {
			await fs.chmod(dir, 0o700);
		}
	});

	test("tools section includes a fuser finding on Linux", async () => {
		// fuser is Linux-only; the finding must be present on Linux and absent elsewhere.
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const fuserFinding = report.findings.find(entry => entry.id === "tools.fuser");
		if (process.platform === "linux") {
			expect(fuserFinding).toBeDefined();
			if (fuserFinding === undefined) return; // narrows type for the status assertion below
			expect(fuserFinding.category).toBe("tools");
			// Status depends on whether fuser is installed on the test host.
			expect(["ok", "warning"]).toContain(fuserFinding.status);
		} else {
			expect(fuserFinding).toBeUndefined();
		}
	});
	// ── setup section ────────────────────────────────────────────────────────

	test("setup: agent .md with missing description → error naming the file", async () => {
		const agentsDir = path.join(root, "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(path.join(agentsDir, "broken.md"), "---\nname: broken\ntools: read\n---\nBody\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.agents");
		expect(finding?.category).toBe("setup");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("broken.md"))).toBe(true);
	});

	test("setup: agent referencing a nonexistent spawns target → warning", async () => {
		const agentsDir = path.join(root, "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "spawner.md"),
			"---\nname: spawner\ndescription: test\nspawns: [nonexistent-agent]\ntools: task\n---\nBody\n",
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.agents");
		expect(finding?.category).toBe("setup");
		expect(finding?.status).toBe("warning");
		expect(finding?.details.some(d => d.includes("nonexistent-agent"))).toBe(true);
	});

	test("setup: runtime-only agent references are validated", async () => {
		setAgentDir(root);
		setProjectDir(root);
		const runtimeAgent: AgentDefinition = {
			name: "runtime-only",
			description: "test agent",
			systemPrompt: "",
			source: "project",
			tools: ["not-a-real-tool"],
		};
		const discoverySpy = spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [runtimeAgent],
			projectAgentsDir: null,
		});
		try {
			const report = await runDoctorCommand({ flags: {} });
			const finding = report.findings.find(entry => entry.id === "setup.agents");
			expect(finding?.status).toBe("warning");
			expect(finding?.details).toContain('runtime-only: unknown tool "not-a-real-tool"');
		} finally {
			discoverySpy.mockRestore();
		}
	});

	test("setup: keybindings.yml with an unknown action → warning", async () => {
		await fs.writeFile(path.join(root, "keybindings.yml"), "nonexistent.action: ctrl+a\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.keybindings");
		expect(finding?.category).toBe("setup");
		expect(finding?.status).toBe("warning");
		expect(finding?.details.some(d => d.includes("nonexistent.action"))).toBe(true);
	});

	test("setup: two actions bound to the same chord → conflict warning", async () => {
		await fs.writeFile(path.join(root, "keybindings.yml"), "app.interrupt: ctrl+x\napp.clear: ctrl+x\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.keybindings");
		expect(finding?.category).toBe("setup");
		expect(finding?.status).toBe("warning");
		expect(finding?.details.some(d => d.includes("ctrl+x"))).toBe(true);
	});

	test("setup: WATCHDOG.yml failing the schema → error", async () => {
		await fs.writeFile(path.join(root, "WATCHDOG.yml"), "advisors:\n  - name: test\n    tools: 123\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.watchdog");
		expect(finding?.category).toBe("setup");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("WATCHDOG.yml"))).toBe(true);
	});

	test("setup: unreadable WATCHDOG.yml is an error, not absent", async () => {
		if (process.getuid?.() === 0) return;
		setProjectDir(root);
		const watchdogPath = path.join(root, "WATCHDOG.yml");
		await fs.writeFile(watchdogPath, "advisors: []\n", "utf8");
		const originalMode = (await fs.stat(watchdogPath)).mode & 0o777;
		try {
			await fs.chmod(watchdogPath, 0o000);
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "setup.watchdog");
			expect(finding?.status).toBe("error");
			expect(finding?.details.some(detail => detail.includes("WATCHDOG.yml"))).toBe(true);
		} finally {
			await fs.chmod(watchdogPath, originalMode);
		}
	});

	test("setup: valid SKILL.md via runtime capability path → ok", async () => {
		setProjectDir(root);
		const skillsDir = path.join(root, "skills", "good-skill");
		await fs.mkdir(skillsDir, { recursive: true });
		await fs.writeFile(
			path.join(skillsDir, "SKILL.md"),
			"---\nname: good-skill\ndescription: test\n---\nBody\n",
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.skills");
		expect(finding?.category).toBe("setup");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toMatch(/skills: \d+ valid/);
		expect(Number(finding?.summary.match(/(\d+)/)?.[1] ?? 0)).toBeGreaterThanOrEqual(1);
	});

	test("setup: skills.customDirectories warning is surfaced", async () => {
		setProjectDir(root);
		const customPath = path.join(root, "not-a-skills-dir.txt");
		await fs.writeFile(customPath, "not a directory\n", "utf8");
		await fs.writeFile(
			path.join(root, "config.yml"),
			`${["skills:", "  customDirectories:", `    - ${customPath}`].join("\n")}\n`,
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.skills");
		expect(finding?.category).toBe("setup");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("Failed to read skills directory") && d.includes(customPath))).toBe(
			true,
		);
	});

	test("setup: honors runtime skills.enablePiUser filtering", async () => {
		setProjectDir(root);
		const skillsDir = path.join(root, "skills", "filtered-skill");
		await fs.mkdir(skillsDir, { recursive: true });
		await fs.writeFile(
			path.join(skillsDir, "SKILL.md"),
			"---\nname: filtered-skill\ndescription: test\n---\nBody\n",
			"utf8",
		);
		await fs.writeFile(path.join(root, "config.yml"), "skills:\n  enablePiUser: false\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.skills");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toBe("skills: 0 valid");
	});

	test("setup: theme json failing themeJsonSchema → error", async () => {
		const themesDir = path.join(root, "themes");
		await fs.mkdir(themesDir, { recursive: true });
		// Missing required "colors" and "name" fields.
		await fs.writeFile(path.join(themesDir, "bad.json"), '{"foo": "bar"}', "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.themes");
		expect(finding?.category).toBe("setup");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("bad.json"))).toBe(true);
	});

	test("setup: theme variable resolution errors are invalid", async () => {
		const themesDir = path.join(root, "themes");
		await fs.mkdir(themesDir, { recursive: true });
		const baseTheme = await Bun.file(DARK_THEME_PATH).json();
		await fs.writeFile(
			path.join(themesDir, "missing-var.json"),
			JSON.stringify({
				...baseTheme,
				name: "missing-var",
				colors: { ...baseTheme.colors, text: "missing" },
			}),
			"utf8",
		);
		await fs.writeFile(
			path.join(themesDir, "cycle.json"),
			JSON.stringify({
				...baseTheme,
				name: "cycle",
				vars: { ...baseTheme.vars, first: "second", second: "first" },
				colors: { ...baseTheme.colors, text: "first" },
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.themes");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(detail => detail.includes("missing-var.json"))).toBe(true);
		expect(finding?.details.some(detail => detail.includes("cycle.json"))).toBe(true);
	});

	test("setup: extension with a broken manifest → error detail", async () => {
		const extDir = path.join(root, "extensions", "broken-ext");
		await fs.mkdir(extDir, { recursive: true });
		await fs.writeFile(path.join(extDir, "package.json"), "{ not valid json ", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.extensions");
		expect(finding?.category).toBe("setup");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("broken-ext"))).toBe(true);
	});

	test("setup: extension manifest with a non-string extensions entry → error naming the package, report completes", async () => {
		// A syntactically valid JSON manifest with a malformed extensions
		// array (e.g. [null]) must not crash the diagnostic. readExtensionManifest
		// casts pkg.omp to ExtensionManifest without shape-checking entries, so
		// the doctor must reject the non-string entry before path.resolve
		// throws — producing an error finding naming the package while the
		// rest of the report still completes.
		const extDir = path.join(root, "extensions", "null-entry-ext");
		await fs.mkdir(extDir, { recursive: true });
		await fs.writeFile(
			path.join(extDir, "package.json"),
			JSON.stringify({ name: "null-entry-ext", omp: { extensions: [null] } }),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.extensions");
		expect(finding?.category).toBe("setup");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("null-entry-ext") && d.includes("not a string"))).toBe(true);
		// The report still completes — other categories are present.
		expect(report.findings.some(entry => entry.category === "browser")).toBe(true);
	});

	test("setup: clean temp dirs → all six ok", async () => {
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const setupFindings = report.findings.filter(entry => entry.category === "setup");
		expect(setupFindings).toHaveLength(6);
		for (const finding of setupFindings) expect(finding.status).toBe("ok");
	});

	test("setup: agent referencing a custom tool from an extension → no false unknown-tool warning", async () => {
		// A custom tool defined under <agentDir>/tools/ must be discovered by the
		// same static tool-discovery the runtime uses, so an agent referencing it
		// does NOT produce a false "unknown tool" warning.
		const toolsDir = path.join(root, "tools");
		await fs.mkdir(toolsDir, { recursive: true });
		await fs.writeFile(
			path.join(toolsDir, "my-custom-tool.json"),
			'{"name":"my-custom-tool","description":"test tool"}',
			"utf8",
		);
		const agentsDir = path.join(root, "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "good.md"),
			"---\nname: good\ndescription: test\ntools: [my-custom-tool]\n---\nBody\n",
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.agents");
		expect(finding?.status).toBe("ok");
		expect(finding?.details.some(d => d.includes("unknown tool"))).toBe(false);
	});

	test("setup: non-ENOENT readdir on extension agents dir → error finding", async () => {
		// A non-ENOENT readdir failure (e.g. EACCES) on an extension agents dir
		// must surface as an error, not be silently swallowed.
		const extDir = path.join(root, "extensions", "my-ext", "agents");
		await fs.mkdir(extDir, { recursive: true });
		const realReaddir = nodeFs.promises.readdir.bind(nodeFs.promises);
		const readdirSpy = spyOn(nodeFs.promises, "readdir").mockImplementation((async (
			dirPath: unknown,
			_options: unknown,
		) => {
			if (typeof dirPath === "string" && path.resolve(dirPath) === path.resolve(extDir)) {
				const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
			return realReaddir(dirPath as string, _options as object);
		}) as typeof nodeFs.promises.readdir);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "setup.agents");
			expect(finding?.status).toBe("error");
			expect(finding?.details.some(d => d.includes("EACCES"))).toBe(true);
		} finally {
			readdirSpy.mockRestore();
		}
	});

	test("setup: non-ENOENT readdir on hooks dir → error finding", async () => {
		// A non-ENOENT readdir failure on a hooks dir must surface as an error,
		// not be silently discarded.
		const hooksDir = path.join(root, "hooks", "pre");
		await fs.mkdir(hooksDir, { recursive: true });
		const realReaddir = nodeFs.promises.readdir.bind(nodeFs.promises);
		const readdirSpy = spyOn(nodeFs.promises, "readdir").mockImplementation((async (
			dirPath: unknown,
			_options: unknown,
		) => {
			if (typeof dirPath === "string" && path.resolve(dirPath) === path.resolve(hooksDir)) {
				const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
			return realReaddir(dirPath as string, _options as object);
		}) as typeof nodeFs.promises.readdir);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "setup.extensions");
			expect(finding?.status).toBe("error");
			expect(finding?.details.some(d => d.includes("EACCES"))).toBe(true);
		} finally {
			readdirSpy.mockRestore();
		}
	});

	test("setup: tool name from JSON name field, not basename → no false unknown-tool warning", async () => {
		// A JSON tool file named foo.json with {name:"bar"} must register tool
		// name "bar" (matching runtime loadTools), not "foo".
		const toolsDir = path.join(root, "tools");
		await fs.mkdir(toolsDir, { recursive: true });
		await fs.writeFile(path.join(toolsDir, "foo.json"), '{"name":"bar","description":"test tool"}', "utf8");
		const agentsDir = path.join(root, "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "good.md"),
			"---\nname: good\ndescription: test\ntools: [bar]\n---\nBody\n",
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.agents");
		expect(finding?.status).toBe("ok");
		expect(finding?.details.some(d => d.includes("unknown tool"))).toBe(false);
	});

	test("setup: empty tools subdir without index file → no false known-tool suppression", async () => {
		// A tools/ subdir without index.ts/index.js must NOT register as a known
		// tool — the runtime loadTools only registers subdirs with an index file.
		const toolsDir = path.join(root, "tools");
		await fs.mkdir(path.join(toolsDir, "empty-subdir"), { recursive: true });
		const agentsDir = path.join(root, "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "good.md"),
			"---\nname: good\ndescription: test\ntools: [empty-subdir]\n---\nBody\n",
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.agents");
		expect(finding?.status).toBe("warning");
		expect(finding?.details.some(d => d.includes("unknown tool") && d.includes("empty-subdir"))).toBe(true);
	});

	test("setup: custom tool from non-native runtime provider (.claude/tools) → no false unknown-tool warning", async () => {
		// A custom tool discoverable only through a non-native runtime provider
		// (e.g. Claude's .claude/tools/) must be recognized via
		// loadCapability(toolCapability.id, …), not just the literal
		// <agentDir>/tools and <project>/.omp/tools dirs.
		setProjectDir(root);
		setAgentDir(root);
		const claudeToolsDir = path.join(root, ".claude", "tools");
		await fs.mkdir(claudeToolsDir, { recursive: true });
		await fs.writeFile(path.join(claudeToolsDir, "claude-only-tool.ts"), "export default {};", "utf8");
		const agentsDir = path.join(root, ".omp", "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "good.md"),
			"---\nname: good\ndescription: test\ntools: [claude-only-tool]\n---\nBody\n",
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { json: true } });
		const finding = report.findings.find(entry => entry.id === "setup.agents");
		expect(finding?.details.some(d => d.includes("unknown tool") && d.includes("claude-only-tool"))).toBe(false);
	}, 30000);

	test("setup: SKILL.md deleted between readdir and readFile → skip, not error", async () => {
		// An ENOENT race on SKILL.md (file removed after readdir) must be silently
		// skipped, not surfaced as an error.
		const skillsDir = path.join(root, "skills", "race-skill");
		await fs.mkdir(skillsDir, { recursive: true });
		await fs.writeFile(
			path.join(skillsDir, "SKILL.md"),
			"---\nname: race-skill\ndescription: test\n---\nBody\n",
			"utf8",
		);
		const realReadFile = fs.readFile.bind(fs);
		const readFileSpy = spyOn(fs, "readFile").mockImplementation((async (filePath: unknown) => {
			if (
				typeof filePath === "string" &&
				filePath.endsWith("SKILL.md") &&
				path.basename(path.dirname(filePath)) === "race-skill"
			) {
				await fs.unlink(filePath);
				const err = new Error("ENOENT") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return realReadFile(filePath as string);
		}) as typeof fs.readFile);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "setup.skills");
			expect(finding?.status).toBe("ok");
			expect(finding?.details.some(d => d.includes("ENOENT"))).toBe(false);
		} finally {
			readFileSpy.mockRestore();
		}
	});
	test("setup: theme .json deleted between readdir and read → skip, not error", async () => {
		// An ENOENT race on a theme .json file (removed after readdir) must be
		// silently skipped, not surfaced as an error.
		const themesDir = path.join(root, "themes");
		await fs.mkdir(themesDir, { recursive: true });
		const themePath = path.join(themesDir, "race.json");
		await fs.writeFile(themePath, '{"name":"race","colors":{}}', "utf8");
		// Intercept readdir on the themes dir: after returning the entries,
		// delete the file so the subsequent Bun.file().json() hits ENOENT.
		const realReaddir = nodeFs.promises.readdir.bind(nodeFs.promises);
		const readdirSpy = spyOn(nodeFs.promises, "readdir").mockImplementation((async (
			dirPath: unknown,
			options: unknown,
		) => {
			const result = await realReaddir(dirPath as string, options as object);
			if (typeof dirPath === "string" && path.resolve(dirPath) === path.resolve(themesDir)) {
				await fs.unlink(themePath).catch(() => {});
			}
			return result;
		}) as typeof nodeFs.promises.readdir);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "setup.themes");
			expect(finding?.status).toBe("ok");
			expect(finding?.details.some(d => d.includes("ENOENT"))).toBe(false);
		} finally {
			readdirSpy.mockRestore();
		}
	});

	test("setup: extensions scoped scan validates extension package → ok", async () => {
		// When scoped (--agent-dir set), extensions are scanned from explicit dirs.
		// This test verifies the scoped path still works after the unscoped refactor.
		const extDir = path.join(root, "extensions", "test-ext");
		await fs.mkdir(extDir, { recursive: true });
		await fs.writeFile(
			path.join(extDir, "package.json"),
			JSON.stringify({ name: "test-ext", omp: { extensions: ["./index.ts"] } }),
			"utf8",
		);
		await fs.writeFile(path.join(extDir, "index.ts"), "export {};", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.extensions");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toContain("1 valid");
	});

	test("gc lock contention produces a storage warning without aborting the report", async () => {
		// Pre-create gc.lock with a live PID so withGcLock cannot acquire it.
		// The lock is only broken when the PID is dead; a spawned child stays alive.
		const holder = Bun.spawn({
			cmd: ["bun", "-e", "const { promise } = Promise.withResolvers(); await promise;"],
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const lockPath = path.join(root, "gc.lock");
			await fs.writeFile(lockPath, `${holder.pid}\n${new Date().toISOString()}\n`, "utf8");

			const report = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
			const lockFinding = report.findings.find(entry => entry.id === "storage.gc-lock");
			expect(lockFinding?.status).toBe("warning");
			expect(lockFinding?.summary).toContain("maintenance lock");
			// Other sections still report — the lock contention did not abort collection.
			expect(report.findings.some(entry => entry.category === "environment")).toBe(true);
			expect(report.findings.some(entry => entry.category === "config")).toBe(true);
		} finally {
			holder.kill();
		}
	});

	test("gc lock non-contention filesystem error produces a storage error, not a warning", async () => {
		// A regular file cannot serve as the agent directory on any platform.
		// withGcLock fails during mkdir before it can classify a contention.
		const agentDirFile = path.join(root, "not-an-agent-dir");
		await fs.writeFile(agentDirFile, "not a directory", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: agentDirFile, fix: true } });
		const errFinding = report.findings.find(entry => entry.id === "storage.maintenance-error");
		expect(errFinding?.status).toBe("error");
		expect(errFinding?.summary).toContain("storage maintenance failed");
		// The gc-lock warning must NOT appear — this is not contention.
		const lockFinding = report.findings.find(entry => entry.id === "storage.gc-lock");
		expect(lockFinding).toBeUndefined();
	});

	// ── Item A: settings schema validation ──────────────────────────────────

	test('settings: wrong-typed boolean (autoResume: "yes") is an error, not valid', async () => {
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, 'autoResume: "yes"\n', "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("autoResume") && d.includes("boolean"))).toBe(true);
	});

	test("settings: non-iterable array (disabledProviders: false) is an error, not valid", async () => {
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, "disabledProviders: false\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("disabledProviders") && d.includes("array"))).toBe(true);
	});

	test("settings: array with null element (bashInterceptor.patterns: [null]) is an error naming the index", async () => {
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, "bashInterceptor:\n  patterns:\n    - null\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("bashInterceptor.patterns[0]") && d.includes("object"))).toBe(true);
	});

	test("settings: valid typed array (bashInterceptor.patterns with real rules) passes", async () => {
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(
			configPath,
			"bashInterceptor:\n  patterns:\n    - pattern: '^cat '\n      tool: read\n      message: use read\n",
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings");
		expect(finding?.status).not.toBe("error");
	});

	test("settings: string array with non-string element is an error naming the index", async () => {
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, "extensions:\n  - valid-ext\n  - 42\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("extensions[1]") && d.includes("string"))).toBe(true);
	});

	test("invalid PI_CONFIG_FILES overlay is reported before the main settings result", async () => {
		setProjectDir(root);
		const overlayPath = path.join(root, "overlay.yml");
		await fs.writeFile(overlayPath, "disabledProviders: false\n", "utf8");
		process.env.PI_CONFIG_FILES = overlayPath;
		Bun.env.PI_CONFIG_FILES = overlayPath;

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const overlayIndex = report.findings.findIndex(entry => entry.id === "config.settings.overlay");
		const settingsIndex = report.findings.findIndex(entry => entry.id === "config.settings");
		const overlayFinding = report.findings[overlayIndex];
		const settingsFinding = report.findings[settingsIndex];
		expect(overlayFinding?.status).toBe("error");
		expect(overlayFinding?.details.some(detail => detail.includes("overlay.yml"))).toBe(true);
		expect(settingsFinding?.status).toBe("ok");
		expect(settingsIndex).toBeGreaterThan(overlayIndex);
	});

	// ── Project settings diagnosis ──────────────────────────────────────────

	test("malformed project .omp/config.yml surfaces a config.settings.project error", async () => {
		setProjectDir(root);
		const projectConfigDir = path.join(root, ".omp");
		await fs.mkdir(projectConfigDir, { recursive: true });
		await fs.writeFile(path.join(projectConfigDir, "config.yml"), "theme:\n  dark: [unterminated\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings.project");
		expect(finding?.status).toBe("error");
		expect(finding?.details.length).toBeGreaterThan(0);
	});

	test("missing project .omp/config.yml yields no project settings error", async () => {
		setProjectDir(root);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings.project");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toContain("absent");
	});

	test("valid project .omp/config.yml yields an ok project settings finding", async () => {
		setProjectDir(root);
		const projectConfigDir = path.join(root, ".omp");
		await fs.mkdir(projectConfigDir, { recursive: true });
		await fs.writeFile(path.join(projectConfigDir, "config.yml"), "autoResume: true\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings.project");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toContain("valid");
	});

	// ── Project settings capability-source diagnosis ───────────────────────

	test("invalid non-native project settings source (.claude/settings.json) is surfaced", async () => {
		// Settings.#loadProjectSettings merges project-level items from all
		// registered settings providers, not just .omp/config.yml. A broken
		// .claude/settings.json at the project level must be surfaced.
		setProjectDir(root);
		setAgentDir(root);
		const claudeDir = path.join(root, ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(path.join(claudeDir, "settings.json"), '{"extensions":["valid-ext",42]}', "utf8");

		const report = await runDoctorCommand({ flags: { json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings.project");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("extensions[1]") && d.includes("string"))).toBe(true);
		// Source path must be reported so the user knows which file to fix.
		expect(finding?.details.some(d => d.includes("settings.json"))).toBe(true);
	}, 30000);

	test("malformed non-native project settings source is surfaced", async () => {
		setProjectDir(root);
		setAgentDir(root);
		const claudeDir = path.join(root, ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(path.join(claudeDir, "settings.json"), "{ broken json", "utf8");

		const report = await runDoctorCommand({ flags: { json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings.project");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("Failed to parse JSON") && d.includes("settings.json"))).toBe(true);
	}, 30000);

	test("malformed project capability settings redact a home-directory path", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.homedir(), "omp-doctor-capability-"));
		try {
			setProjectDir(projectDir);
			setAgentDir(root);
			const claudeDir = path.join(projectDir, ".claude");
			await fs.mkdir(claudeDir, { recursive: true });
			await fs.writeFile(path.join(claudeDir, "settings.json"), "{ broken json", "utf8");

			const report = await runDoctorCommand({ flags: { json: true } });
			const finding = report.findings.find(entry => entry.id === "config.settings.project");
			const detail = finding?.details.find(d => d.includes("Failed to parse JSON"));
			expect(detail).toContain("~");
			expect(detail).not.toContain(projectDir);
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	}, 30000);

	test("valid non-native project settings source remains clean", async () => {
		setProjectDir(root);
		setAgentDir(root);
		const claudeDir = path.join(root, ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(path.join(claudeDir, "settings.json"), '{"extensions":["valid-ext"]}', "utf8");

		const report = await runDoctorCommand({ flags: { json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings.project");
		expect(finding?.status).toBe("ok");
	}, 30000);

	// ── Item B: malformed MCP JSON invisible ─────────────────────────────────

	test("malformed MCP JSON in scoped agent dir produces an error, not mcp.none ok", async () => {
		setProjectDir(root);
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(mcpJson, "{ broken json !!! }", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const mcpFindings = report.findings.filter(entry => entry.category === "mcp");
		// Must NOT be the single ok "no MCP servers configured" finding.
		const noneOk = mcpFindings.find(entry => entry.id === "mcp.none" && entry.status === "ok");
		expect(noneOk).toBeUndefined();
		// Must have an error finding naming the file and the parse error.
		const errorFinding = mcpFindings.find(entry => entry.status === "error");
		expect(errorFinding).toBeDefined();
		expect(errorFinding?.details.some(d => d.includes("invalid JSON"))).toBe(true);
	});

	test("scoped doctor probes both project-root MCP config candidates once", async () => {
		setProjectDir(root);
		const scopedAgentDir = path.join(root, "scoped-agent");
		await fs.mkdir(scopedAgentDir, { recursive: true });
		const rootMcpJson = path.join(root, "mcp.json");
		const rootDotMcpJson = path.join(root, ".mcp.json");
		await Promise.all([
			fs.writeFile(rootMcpJson, "{ broken mcp json", "utf8"),
			fs.writeFile(rootDotMcpJson, "{ broken dot mcp json", "utf8"),
		]);

		const report = await runDoctorCommand({ flags: { agentDir: scopedAgentDir, json: true } });
		const finding = report.findings.find(entry => entry.id === "mcp.config-source");
		const details = finding?.details ?? [];
		expect(finding?.status).toBe("error");
		expect(details.filter(detail => detail.includes(rootMcpJson))).toHaveLength(1);
		expect(details.filter(detail => detail.includes(rootDotMcpJson))).toHaveLength(1);
	});

	test("primitive mcpServers produces an MCP error finding, not mcp.none", async () => {
		setProjectDir(root);
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(mcpJson, JSON.stringify({ mcpServers: true }), "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const mcpFindings = report.findings.filter(entry => entry.category === "mcp");
		const noneOk = mcpFindings.find(entry => entry.id === "mcp.none" && entry.status === "ok");
		expect(noneOk).toBeUndefined();
		const mapError = mcpFindings.find(
			entry =>
				entry.status === "error" &&
				entry.details.some(
					d => d.includes("mcpServers") && (d.includes("object map") || d.includes("Invalid mcpServers")),
				),
		);
		expect(mapError).toBeDefined();
	});

	test("array mcpServers produces an MCP error finding, not mcp.none", async () => {
		setProjectDir(root);
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(mcpJson, JSON.stringify({ mcpServers: [{ name: "x" }] }), "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const mcpFindings = report.findings.filter(entry => entry.category === "mcp");
		const noneOk = mcpFindings.find(entry => entry.id === "mcp.none" && entry.status === "ok");
		expect(noneOk).toBeUndefined();
		const mapError = mcpFindings.find(
			entry =>
				entry.status === "error" &&
				entry.details.some(
					d => d.includes("mcpServers") && (d.includes("object map") || d.includes("Invalid mcpServers")),
				),
		);
		expect(mapError).toBeDefined();
	});

	// ── Item C: legacy marker requires manual recovery ────────────────────────

	test("legacy swapped marker under --fix requires manual recovery", async () => {
		const dbPath = getAgentDbPath(root);
		await createDatabaseWithRows(dbPath, 10);
		// Simulate a crash AFTER the swap committed but BEFORE marker removal:
		// the marker has swapped:true, the live database is the repaired candidate.
		const marker = path.join(path.dirname(dbPath), ".agent.db.omp-doctor-swap.json");
		const archiveDir = path.join(root, ".omp-doctor-backups", "agent.db.test");
		await fs.mkdir(archiveDir, { recursive: true });
		await fs.writeFile(path.join(archiveDir, "agent.db"), "archive-content", "utf8");
		await Bun.write(marker, JSON.stringify({ archive: archiveDir, swapped: true }));

		const report = await runDoctorCommand({ flags: { agentDir: root, fix: true } });
		const finding = report.findings.find(entry => entry.id === "storage.agent.db");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("recovery did not complete");
		expect(finding?.details.join("\n")).toContain("unrecognized live database state");
		expect(await pathExists(marker)).toBe(true);
		expect(quickCheck(dbPath)).toBe("ok");
	});

	// ── Item D: MCP URL credential leak ──────────────────────────────────────

	test("MCP http server URL with userinfo and query token is sanitized in JSON output", async () => {
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: {
					leaky: { type: "http", url: "https://user:secret@mcp.example.com/sse?token=hidden" },
				},
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const json = JSON.stringify(report);
		// Neither the userinfo secret nor the query token may appear anywhere.
		expect(json).not.toContain("user:secret");
		expect(json).not.toContain("hidden");
		expect(json).not.toContain("=hidden");
		// The origin should still be present so the server is identifiable.
		expect(json).toContain("https://mcp.example.com");
	});

	// ── Item E: stdio command resolution context ─────────────────────────────

	test("MCP stdio server with cwd + relative command that exists → ok, not command not found", async () => {
		// Create a relative binary under a cwd directory in the temp root.
		const serverBinDir = path.join(root, "serverbin");
		await fs.mkdir(serverBinDir, { recursive: true });
		const serverBin = path.join(serverBinDir, "server");
		await fs.writeFile(serverBin, "#!/bin/sh\nexit 0\n", "utf8");
		await fs.chmod(serverBin, 0o755);

		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: {
					local: { type: "stdio", command: "./server", cwd: serverBinDir },
				},
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "mcp.local");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).not.toContain("command not found");
	});

	test("MCP stdio server without cwd resolves relative commands from the project directory", async () => {
		setProjectDir(root);
		const serverBin = path.join(root, "project-server.exe");
		await fs.writeFile(serverBin, "fixture", "utf8");
		await fs.chmod(serverBin, 0o755);
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: {
					projectDefault: { type: "stdio", command: "./project-server.exe" },
				},
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "mcp.projectDefault");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).not.toContain("command not found");
	});

	test("MCP stdio server command naming a directory reports command not found", async () => {
		setProjectDir(root);
		await fs.mkdir(path.join(root, "not-a-server"), { recursive: true });
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: {
					directory: { type: "stdio", command: "./not-a-server" },
				},
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "mcp.directory");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("command not found");
	});

	test.skipIf(process.platform === "win32")(
		"MCP stdio server command naming a non-executable file reports command not found",
		async () => {
			setProjectDir(root);
			const serverPath = path.join(root, "not-executable");
			await fs.writeFile(serverPath, "fixture", "utf8");
			await fs.chmod(serverPath, 0o644);
			const mcpJson = path.join(root, "mcp.json");
			await fs.writeFile(
				mcpJson,
				JSON.stringify({
					mcpServers: {
						nonExecutable: { type: "stdio", command: "./not-executable" },
					},
				}),
				"utf8",
			);

			const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
			const finding = report.findings.find(entry => entry.id === "mcp.nonExecutable");
			expect(finding?.status).toBe("error");
			expect(finding?.summary).toContain("command not found");
		},
	);

	test("MCP stdio server with a missing configured cwd is an error", async () => {
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: {
					missingCwd: {
						type: "stdio",
						command: process.execPath,
						cwd: path.join(root, "missing-cwd"),
					},
				},
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "mcp.missingCwd");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("working directory unavailable");
		expect(finding?.details.some(detail => detail.includes("does not exist or is not a directory"))).toBe(true);
	});

	// ── Item G: invalid URL must not leak credentials through validation ─────

	test("MCP http server with a malformed URL containing credentials never leaks them in the report", async () => {
		// `validateServerConfig` must reject this malformed URL with a generic
		// detail, never the raw input or the URL parser's echoed error.
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: {
					badUrl: { type: "http", url: "https://user:secret@bad host/sse?token=hidden" },
				},
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "mcp.badUrl");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("invalid spec");
		// Neither the userinfo secret nor the query token may appear anywhere.
		const json = JSON.stringify(report);
		expect(json).not.toContain("user:secret");
		expect(json).not.toContain("hidden");
		expect(json).not.toContain("=hidden");
		expect(json).not.toContain("bad host");
	});

	test("MCP http server with an unsupported URL scheme is invalid", async () => {
		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({ mcpServers: { ftp: { type: "http", url: "ftp://example.com/mcp" } } }),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "mcp.ftp");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("invalid spec");
		expect(finding?.details.some(detail => detail.includes("http or https"))).toBe(true);
	});

	// ── Item H: non-string cwd on a stdio server is an error ─────────────────

	test("MCP stdio server with a non-string cwd is an invalid-spec error, not a silent project-cwd fallback", async () => {
		// A non-string cwd (e.g. a number) is malformed. The provider may drop
		// it, leaving doctor to silently fall back to project cwd while the
		// runtime spawn would fail. The shape validator must catch it first.
		const serverBinDir = path.join(root, "serverbin");
		await fs.mkdir(serverBinDir, { recursive: true });
		const serverBin = path.join(serverBinDir, "server");
		await fs.writeFile(serverBin, "#!/bin/sh\nexit 0\n", "utf8");
		await fs.chmod(serverBin, 0o755);

		const mcpJson = path.join(root, "mcp.json");
		await fs.writeFile(
			mcpJson,
			JSON.stringify({
				mcpServers: {
					badCwd: { type: "stdio", command: "./server", cwd: 7 },
				},
			}),
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "mcp.badCwd");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("invalid spec");
		expect(finding?.details.some(d => d.includes("cwd") && d.includes("string"))).toBe(true);
	});

	// ── Item F: skills known-set too narrow ──────────────────────────────────

	test("setup: agent referencing a skill discoverable via capability loader → no unknown skill warning", async () => {
		// Create a skill under <agentDir>/skills/ (which the capability loader
		// discovers) and an agent that autoloads it. The capability loader
		// discovers skills from more sources than the old three-dir list, but
		// this test verifies the loader-based discovery works for the basic case
		// and does not produce a false "unknown skill" warning.
		const skillsDir = path.join(root, "skills", "my-cap-skill");
		await fs.mkdir(skillsDir, { recursive: true });
		await fs.writeFile(
			path.join(skillsDir, "SKILL.md"),
			"---\nname: my-cap-skill\ndescription: test skill\n---\nBody\n",
			"utf8",
		);
		const agentsDir = path.join(root, "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "skilluser.md"),
			"---\nname: skilluser\ndescription: test\nautoloadSkills: [my-cap-skill]\ntools: read\n---\nBody\n",
			"utf8",
		);

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "setup.agents");
		expect(finding?.details.some(d => d.includes("unknown skill"))).toBe(false);
	});

	// ── Item G: managed Chromium cache ───────────────────────────────────────

	/**
	 * Compute the REAL exact Browser.CHROME target @puppeteer/browsers
	 * produces on this host (platform + puppeteer-core-pinned
	 * PUPPETEER_REVISIONS.chrome build id) under `cacheDir`, plus the
	 * chrome-headless-shell path sharing that build id. Mirrors
	 * `resolveManagedChromiumTarget` in launch.ts so the fixture lands at the
	 * path the launcher actually probes — not a stale chrome-1234/linux-64
	 * layout that only satisfied the old directory walk.
	 */
	async function resolveManagedChromeTarget(cacheDir: string): Promise<{
		chromePath: string;
		shellPath: string;
	}> {
		const platform = detectBrowserPlatform();
		if (!platform) throw new Error("detectBrowserPlatform returned undefined on test host");
		const buildId = await resolveBuildId(Browser.CHROME, platform, PUPPETEER_REVISIONS.chrome);
		const chromePath = computeExecutablePath({
			browser: Browser.CHROME,
			buildId,
			cacheDir,
			platform,
		});
		const shellPath = computeExecutablePath({
			browser: Browser.CHROMEHEADLESSSHELL,
			buildId,
			cacheDir,
			platform,
		});
		return { chromePath, shellPath };
	}

	test("browser: cached Chromium executable → ok, not first-use warning", async () => {
		// Place a binary at the REAL exact path @puppeteer/browsers computes
		// for Browser.CHROME + this platform + the pinned build id, under the
		// mocked getPuppeteerDir. System Chrome and env override are absent so
		// the cache probe is reached.
		const fakeCacheDir = path.join(root, "fake-puppeteer-cache");
		const { chromePath } = await resolveManagedChromeTarget(fakeCacheDir);
		await fs.mkdir(path.dirname(chromePath), { recursive: true });
		await fs.writeFile(chromePath, "fake-binary", "utf8");

		const chromeSpy = spyOn(browserLaunch, "resolveSystemChromium").mockReturnValue(undefined);
		const envSpy = spyOn(browserLaunch, "readChromiumEnvOverride").mockReturnValue(undefined);
		const cacheSpy = spyOn(piUtils, "getPuppeteerDir").mockReturnValue(fakeCacheDir);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "browser.chromium");
			expect(finding?.status).toBe("ok");
			expect(finding?.summary).toBe(chromePath);
			expect(finding?.details.some(d => d.includes("Puppeteer cache"))).toBe(true);
		} finally {
			chromeSpy.mockRestore();
			envSpy.mockRestore();
			cacheSpy.mockRestore();
		}
	});

	test("browser: mismatched Chrome-family artifact → warning, not ok", async () => {
		// A chrome-headless-shell download (a different Browser.* target) must
		// NOT satisfy the Browser.CHROME cache probe. The old directory walk
		// matched `headless_shell` by name and reported ok; the exact-target
		// probe correctly falls through to the first-use download warning.
		const fakeCacheDir = path.join(root, "fake-puppeteer-cache-shell");
		const { shellPath } = await resolveManagedChromeTarget(fakeCacheDir);
		await fs.mkdir(path.dirname(shellPath), { recursive: true });
		await fs.writeFile(shellPath, "fake-headless-shell", "utf8");

		const chromeSpy = spyOn(browserLaunch, "resolveSystemChromium").mockReturnValue(undefined);
		const envSpy = spyOn(browserLaunch, "readChromiumEnvOverride").mockReturnValue(undefined);
		const cacheSpy = spyOn(piUtils, "getPuppeteerDir").mockReturnValue(fakeCacheDir);
		try {
			const report = await runDoctorCommand({ flags: { agentDir: root } });
			const finding = report.findings.find(entry => entry.id === "browser.chromium");
			expect(finding?.status).toBe("warning");
			expect(finding?.summary.toLowerCase()).toContain("download");
		} finally {
			chromeSpy.mockRestore();
			envSpy.mockRestore();
			cacheSpy.mockRestore();
		}
	});

	test("resolveCachedChromiumExecutable: empty cache → undefined (no download)", async () => {
		// An empty or absent cache must resolve to undefined without throwing
		// or triggering a download. Thread the cacheDir through the option.
		const emptyCacheDir = path.join(root, "empty-puppeteer-cache");
		await fs.mkdir(emptyCacheDir, { recursive: true });
		expect(await browserLaunch.resolveCachedChromiumExecutable(emptyCacheDir)).toBeUndefined();
		// A nonexistent cache dir is also undefined, never a throw.
		expect(await browserLaunch.resolveCachedChromiumExecutable(path.join(root, "no-such-cache"))).toBeUndefined();
	});

	// ── Round-5 regression tests ─────────────────────────────────────────────

	test("settings: legacy inlineToolDescriptors:true is valid after migration (not an invalid enum)", async () => {
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, "inlineToolDescriptors: true\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toContain("valid");
	});

	test("settings: legacy boolean task.eager is valid after migration", async () => {
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, "task:\n  eager: true\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings");
		expect(finding?.status).not.toBe("error");
	});

	test("settings: namespace prefix with non-object value (task: string) is an error", async () => {
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, 'task: "not-a-mapping"\n', "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("task") && d.includes("mapping"))).toBe(true);
	});

	test("settings: namespace prefix with array value (statusLine: []) is an error", async () => {
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, "statusLine: []\n", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const finding = report.findings.find(entry => entry.id === "config.settings");
		expect(finding?.status).toBe("error");
		expect(finding?.details.some(d => d.includes("statusLine") && d.includes("mapping"))).toBe(true);
	});

	test("auth: malformed api_key payload ({} missing key) → error finding naming the row id", async () => {
		const dbPath = getAgentDbPath(root);
		await createAuthCredential(dbPath, "openai", "api_key", {});
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "auth.openai");
		expect(finding).toBeDefined();
		if (finding === undefined) return;
		expect(finding.category).toBe("auth");
		expect(finding.status).toBe("error");
		expect(finding.summary).toContain("malformed");
		expect(finding.details.some(d => d.includes("row id") && d.includes("api_key"))).toBe(true);
		// Never surface the secret payload.
		expect(JSON.stringify(finding)).not.toContain("sk-");
	});

	test("auth: invalid JSON credential payload is a provider-level malformed finding", async () => {
		const dbPath = getAgentDbPath(root);
		await createAuthCredential(dbPath, "openai", "api_key", { key: "sk-valid" });
		const db = new Database(dbPath);
		db.run("UPDATE auth_credentials SET data = ?", ["{not-json"]);
		db.close();

		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "auth.openai");
		expect(finding?.status).toBe("error");
		expect(finding?.summary).toContain("malformed");
		expect(finding?.details.some(d => d.includes("row id") && d.includes("api_key"))).toBe(true);
		expect(report.findings.find(entry => entry.id === "auth.storage")).toBeUndefined();
	});

	test("auth: valid api_key payload with data.key → ok, not malformed", async () => {
		const dbPath = getAgentDbPath(root);
		await createAuthCredential(dbPath, "openai", "api_key", { key: "sk-valid" });
		const report = await runDoctorCommand({ flags: { agentDir: root } });
		const finding = report.findings.find(entry => entry.id === "auth.openai");
		expect(finding?.status).toBe("ok");
		expect(finding?.summary).toContain("credentials present");
	});

	test("a quarantined project .omp/config.yml.broken-* is reported alongside agent-dir backups", async () => {
		setProjectDir(root);
		const projectOmpDir = path.join(root, ".omp");
		await fs.mkdir(projectOmpDir, { recursive: true });
		await fs.writeFile(path.join(projectOmpDir, "config.yml.broken-123"), "garbage", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const quarantine = report.findings.find(entry => entry.id === "config.quarantined");
		expect(quarantine?.status).toBe("error");
		expect(quarantine?.details).toContain(".omp/config.yml.broken-123");
	});

	test("a quarantined agent-dir config.yml.broken-* is still reported when project .omp has none", async () => {
		setProjectDir(root);
		await fs.writeFile(path.join(root, "config.yml.broken-456"), "garbage", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const quarantine = report.findings.find(entry => entry.id === "config.quarantined");
		expect(quarantine?.status).toBe("error");
		expect(quarantine?.details).toContain("config.yml.broken-456");
	});

	test("agent quarantines remain visible when the project .omp scan fails", async () => {
		setProjectDir(root);
		await fs.writeFile(path.join(root, "config.yml.broken-456"), "garbage", "utf8");
		// A regular file makes project `.omp` readdir fail on every platform.
		await fs.writeFile(path.join(root, ".omp"), "not a directory", "utf8");

		const report = await runDoctorCommand({ flags: { agentDir: root, json: true } });
		const quarantine = report.findings.find(entry => entry.id === "config.quarantined");
		expect(quarantine?.status).toBe("error");
		expect(quarantine?.details).toContain("config.yml.broken-456");
		expect(quarantine?.summary).not.toContain("cannot read config directory");
	});
});
