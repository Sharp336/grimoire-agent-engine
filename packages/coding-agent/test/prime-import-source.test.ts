import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverPrimeSource, revalidatePrimeSource } from "../src/import/prime/source";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prime-import-source-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeText(filePath: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, text, "utf8");
}

async function writeSession(filePath: string, id: string): Promise<void> {
	await writeText(
		filePath,
		`${JSON.stringify({ type: "session", id })}\n${JSON.stringify({ type: "message", id: `${id}-message` })}\n`,
	);
}

async function digest(filePath: string): Promise<string> {
	return crypto
		.createHash("sha256")
		.update(await fs.readFile(filePath))
		.digest("hex");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("discoverPrimeSource", () => {
	it("uses explicit roots and records canonical metadata and content digests", async () => {
		const root = await temporaryDirectory();
		const cwd = path.join(root, "project");
		const sourceRoot = path.join(root, "prime");
		const configPath = path.join(root, "prime-cli.json");
		const settingsPath = path.join(sourceRoot, "settings.json");
		await writeText(settingsPath, '{"theme":"dark"}\n');
		await writeText(path.join(sourceRoot, "models.json"), '{"model":"x"}\n');
		await writeText(path.join(sourceRoot, "auth.json"), '{"auth":"redacted"}\n');
		await writeText(path.join(sourceRoot, "oauth.json"), '{"oauth":"redacted"}\n');
		await writeText(path.join(sourceRoot, "skills", "global-skill.txt"), "global skill\n");
		await writeText(path.join(cwd, ".prime", "agent", "settings.json"), '{"project":true}\n');
		await writeText(path.join(cwd, ".prime", "agent", "skills", "project-skill.txt"), "project skill\n");
		await writeText(configPath, '{"cli":true}\n');
		const discovered = await discoverPrimeSource({ sourceRoot, cwd, primeCliConfigPath: configPath });
		const settings = discovered.inventory.files.find(file => file.sourceRef === "global/settings.json");
		expect(settings?.kind).toBe("file");
		expect(settings?.domain).toBe("settings");
		expect(settings?.canonicalPath).toBe(await fs.realpath(settingsPath));
		expect(settings?.size).toBe((await fs.stat(settingsPath)).size);
		expect(settings?.mode).toBe((await fs.stat(settingsPath)).mode & 0o7777);
		expect(settings?.mtimeMs).toBe((await fs.stat(settingsPath)).mtimeMs);
		expect(settings?.sha256).toBe(await digest(settingsPath));
		expect(discovered.inventory.files.map(file => file.sourceRef)).toEqual([
			"cli-config/config",
			"global/auth.json",
			"global/models.json",
			"global/oauth.json",
			"global/settings.json",
			"global/skills/global-skill.txt",
			"project/settings.json",
			"project/skills/project-skill.txt",
		]);
		expect(discovered.snapshot.schemaVersion).toBe(1);
		expect(discovered.snapshot.maxFileBytes).toBe(16 * 1024 * 1024);
		expect(discovered.snapshot.maxTotalBytes).toBe(256 * 1024 * 1024);
		expect(discovered.snapshot.maxEntries).toBe(100_000);
		expect(discovered.snapshot.snapshotId).toMatch(/^[a-f0-9]{64}$/);
	});

	it("discovers current, legacy root, and legacy nested session layouts", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		const sessionRoot = path.join(root, "custom-sessions");
		await writeSession(path.join(sessionRoot, "current.jsonl"), "current");
		await writeSession(path.join(sessionRoot, "--project--", "nested.jsonl"), "legacy-nested");
		await writeSession(path.join(sourceRoot, "legacy.jsonl"), "legacy-root");
		await writeText(path.join(sourceRoot, "not-a-session.jsonl"), '{"type":"message"}\n');
		const discovered = await discoverPrimeSource({ sourceRoot, cwd, sessionRoot });
		expect(discovered.inventory.files.map(file => file.sourceRef)).toEqual([
			"legacy-nested/--project--/nested.jsonl",
			"legacy-root/legacy.jsonl",
			"sessions/current/current.jsonl",
		]);
		expect(discovered.inventory.files.some(file => file.sourceRef === "legacy-root/not-a-session.jsonl")).toBe(false);
		expect(discovered.losses.some(loss => loss.sourceRef === "legacy-root/not-a-session.jsonl")).toBe(false);
	});
	it("deduplicates a root-level transcript when explicit session and source roots canonicalize equally", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		await writeText(
			path.join(sourceRoot, "root.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "root",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
			})}\n`,
		);

		const discovered = await discoverPrimeSource({
			sourceRoot,
			cwd,
			sessionRoot: sourceRoot,
		});
		const expectedPath = await fs.realpath(path.join(sourceRoot, "root.jsonl"));

		expect(discovered.inventory.files).toHaveLength(1);
		expect(discovered.inventory.files.map(file => file.sourceRef)).toEqual(["sessions/current/root.jsonl"]);
		expect(discovered.inventory.files[0]?.canonicalPath).toBe(expectedPath);
		expect(discovered.snapshot.files.map(file => file.sourceRef)).toEqual(["sessions/current/root.jsonl"]);
		expect(discovered.snapshot.files[0]?.canonicalPath).toBe(expectedPath);
	});
	it("deduplicates a transcript when an explicit session root contains the source root", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "--agent--");
		const sessionRoot = path.dirname(sourceRoot);
		const cwd = path.join(root, "project");
		const transcriptPath = path.join(sourceRoot, "x.jsonl");
		await writeSession(transcriptPath, "contained");

		const discovered = await discoverPrimeSource({ sourceRoot, cwd, sessionRoot });
		const expectedPath = await fs.realpath(transcriptPath);
		const inventoryMatches = discovered.inventory.files.filter(file => file.canonicalPath === expectedPath);
		const snapshotMatches = discovered.snapshot.files.filter(file => file.canonicalPath === expectedPath);

		expect(inventoryMatches).toHaveLength(1);
		expect(inventoryMatches[0]?.sourceRef).toBe("legacy-nested/--agent--/x.jsonl");
		expect(snapshotMatches).toHaveLength(1);
		expect(snapshotMatches[0]?.sourceRef).toBe("legacy-nested/--agent--/x.jsonl");
	});
	it("charges a transcript once when an explicit session root contains the source root", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "--agent--");
		const sessionRoot = path.dirname(sourceRoot);
		const cwd = path.join(root, "project");
		const transcriptPath = path.join(sourceRoot, "x.jsonl");
		await writeSession(transcriptPath, "contained");

		const discovered = await discoverPrimeSource({
			sourceRoot,
			cwd,
			sessionRoot,
			maxTotalBytes: (await fs.stat(transcriptPath)).size,
			maxEntries: 2,
		});
		const expectedPath = await fs.realpath(transcriptPath);

		expect(discovered.losses.filter(loss => loss.code === "source-budget-exceeded")).toEqual([]);
		expect(discovered.inventory.files).toHaveLength(1);
		expect(discovered.inventory.files[0]?.canonicalPath).toBe(expectedPath);
		expect(discovered.inventory.files[0]?.sourceRef).toBe("legacy-nested/--agent--/x.jsonl");
	});

	it("inventories artifacts and records excluded runtime state without importing it", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		await writeText(path.join(sourceRoot, "session-artifacts", "session-a", "image.bin"), "artifact");
		await writeText(path.join(sourceRoot, "session-artifacts", "session-a", "kernel-state.dill"), "kernel");
		await writeText(path.join(sourceRoot, "session-artifacts", "session-a", "kernel-state.json"), "kernel");
		await writeText(path.join(sourceRoot, "session-artifacts", "session-a", "scheduled-jobs.json"), "schedule");
		await writeText(path.join(sourceRoot, "session-artifacts", "session-a", "scheduled-jobs.json.lock"), "schedule");
		await writeText(path.join(sourceRoot, "session-artifacts", "session-a", "rlm-subagents.jsonl"), "rlm");
		await writeText(path.join(sourceRoot, "session-artifacts", "session-a", "harness", "nested.json"), "harness");
		await writeText(path.join(sourceRoot, "cron-jobs.json"), '{"jobs":[]}');
		await writeText(path.join(sourceRoot, "kernel", "state.dill"), "kernel");
		const discovered = await discoverPrimeSource({ sourceRoot, cwd });
		expect(discovered.inventory.files.map(file => file.sourceRef)).toEqual(["artifacts/session-a/image.bin"]);
		expect(discovered.snapshot.files.map(file => file.sourceRef)).toEqual(["artifacts/session-a/image.bin"]);
		expect(discovered.inventory.excluded.map(entry => [entry.sourceRef, entry.kind, entry.reason])).toEqual([
			["artifacts/session-a/harness", "directory", "harness"],
			["artifacts/session-a/harness/nested.json", "file", "harness"],
			["artifacts/session-a/kernel-state.dill", "file", "kernel"],
			["artifacts/session-a/kernel-state.json", "file", "kernel"],
			["artifacts/session-a/rlm-subagents.jsonl", "file", "rlm"],
			["artifacts/session-a/scheduled-jobs.json", "file", "schedule"],
			["artifacts/session-a/scheduled-jobs.json.lock", "file", "schedule"],
			["global/excluded/cron-jobs.json", "file", "schedule"],
			["global/excluded/kernel", "directory", "kernel"],
			["global/excluded/kernel/state.dill", "file", "kernel"],
		]);
		expect(discovered.losses.map(item => [item.code, item.sourceRef])).toEqual([
			["source-excluded", "artifacts/session-a/harness"],
			["source-excluded", "artifacts/session-a/harness/nested.json"],
			["source-excluded", "artifacts/session-a/kernel-state.dill"],
			["source-excluded", "artifacts/session-a/kernel-state.json"],
			["source-excluded", "artifacts/session-a/rlm-subagents.jsonl"],
			["source-excluded", "artifacts/session-a/scheduled-jobs.json"],
			["source-excluded", "artifacts/session-a/scheduled-jobs.json.lock"],
			["source-excluded", "global/excluded/cron-jobs.json"],
			["source-excluded", "global/excluded/kernel"],
			["source-excluded", "global/excluded/kernel/state.dill"],
		]);
	});

	it.skipIf(process.platform === "win32")("refuses symlinks without traversing their targets", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		const outside = path.join(root, "outside.json");
		const outsideDirectory = path.join(root, "outside-directory");
		const link = path.join(sourceRoot, "settings.json");
		await writeText(outside, "secret-looking content");
		await writeText(path.join(outsideDirectory, "agent", "skills", "leak.txt"), "secret-looking content");
		await fs.mkdir(sourceRoot, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await fs.symlink(outside, link);
		await fs.symlink(outsideDirectory, path.join(sourceRoot, "skills"));
		await fs.symlink(outsideDirectory, path.join(cwd, ".prime"));
		const discovered = await discoverPrimeSource({ sourceRoot, cwd });
		expect(discovered.inventory.files.some(file => file.canonicalPath === outside)).toBe(false);
		expect(discovered.inventory.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "symlink",
					sourceRef: "global/settings.json",
					canonicalPath: path.resolve(link),
				}),
				expect.objectContaining({ kind: "symlink", sourceRef: "global/skills" }),
			]),
		);
		expect(discovered.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "source-external-symlink", sourceRef: "global/settings.json" }),
				expect.objectContaining({ code: "source-symlink", sourceRef: "project/skills" }),
			]),
		);
	});

	it.skipIf(process.platform === "win32")(
		"classifies relative symlinks inside a lexically aliased root as internal",
		async () => {
			const realRoot = await temporaryDirectory();
			const aliasContainer = await temporaryDirectory();
			const aliasRoot = path.join(aliasContainer, "alias");
			const sourceRoot = path.join(aliasRoot, "prime");
			const cwd = path.join(aliasContainer, "project");
			const targetPath = path.join(realRoot, "prime", "skills", "target.txt");
			const linkPath = path.join(sourceRoot, "skills", "link.txt");
			await writeText(targetPath, "target");
			await fs.mkdir(cwd, { recursive: true });
			await fs.symlink(realRoot, aliasRoot);
			await fs.symlink("target.txt", linkPath);
			const discovered = await discoverPrimeSource({ sourceRoot, cwd });
			expect(discovered.inventory.records).toContainEqual(
				expect.objectContaining({
					kind: "symlink",
					sourceRef: "global/skills/link.txt",
					target: "target.txt",
					external: false,
				}),
			);
			expect(discovered.losses).toContainEqual(
				expect.objectContaining({ code: "source-symlink", sourceRef: "global/skills/link.txt" }),
			);
			expect(discovered.losses).not.toContainEqual(
				expect.objectContaining({ code: "source-external-symlink", sourceRef: "global/skills/link.txt" }),
			);
		},
	);

	it.skipIf(process.platform === "win32")(
		"does not derive default session or artifact roots through a symlinked source root",
		async () => {
			const root = await temporaryDirectory();
			const realSourceRoot = path.join(root, "real-prime");
			const sourceRoot = path.join(root, "prime-link");
			const cwd = path.join(root, "project");
			await writeSession(path.join(realSourceRoot, "sessions", "current.jsonl"), "outside");
			await writeText(path.join(realSourceRoot, "session-artifacts", "session-a", "image.bin"), "outside");
			await fs.mkdir(cwd, { recursive: true });
			await fs.symlink(realSourceRoot, sourceRoot);
			const discovered = await discoverPrimeSource({ sourceRoot, cwd });
			expect(discovered.inventory.files.some(file => file.canonicalPath.startsWith(realSourceRoot))).toBe(false);
			expect(discovered.losses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "source-symlink", sourceRef: "source-root" }),
					expect.objectContaining({ code: "source-symlink", sourceRef: "sessions" }),
					expect.objectContaining({ code: "source-symlink", sourceRef: "artifacts" }),
				]),
			);
		},
	);
	it("reports unreadable files on POSIX non-root environments", async () => {
		if (process.platform === "win32" || process.getuid?.() === 0) return;
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		const settingsPath = path.join(sourceRoot, "settings.json");
		await writeText(settingsPath, '{"secret":true}\n');
		await fs.chmod(settingsPath, 0);
		try {
			const discovered = await discoverPrimeSource({ sourceRoot, cwd });
			expect(discovered.losses).toContainEqual(
				expect.objectContaining({ code: "source-unreadable", sourceRef: "global/settings.json" }),
			);
		} finally {
			await fs.chmod(settingsPath, 0o600);
		}
	});

	it("rejects invalid numeric budgets", async () => {
		const root = await temporaryDirectory();
		const options = { sourceRoot: path.join(root, "prime"), cwd: path.join(root, "project") };
		await expect(discoverPrimeSource({ ...options, maxFileBytes: 0 })).rejects.toThrow();
		await expect(discoverPrimeSource({ ...options, maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow();
		await expect(discoverPrimeSource({ ...options, maxEntries: 1.5 })).rejects.toThrow();
		await expect(discoverPrimeSource({ ...options, maxEntries: 100_001 })).rejects.toThrow();
	});

	it("shares byte and entry budgets across discovery domains", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		await writeText(path.join(sourceRoot, "models.json"), "abc");
		await writeText(path.join(sourceRoot, "settings.json"), "def");
		const byteLimited = await discoverPrimeSource({ sourceRoot, cwd, maxTotalBytes: 5 });
		expect(byteLimited.inventory.files.map(file => file.sourceRef)).toEqual(["global/models.json"]);
		expect(byteLimited.losses.filter(item => item.code === "source-budget-exceeded")).toEqual([
			expect.objectContaining({ sourceRef: "global/settings.json" }),
		]);
		const entryLimited = await discoverPrimeSource({ sourceRoot, cwd, maxEntries: 1 });
		expect(entryLimited.losses.filter(item => item.code === "source-budget-exceeded")).toEqual([
			expect.objectContaining({ sourceRef: "global/settings.json" }),
		]);
		expect(entryLimited.inventory.files.map(file => file.sourceRef)).toEqual(["global/models.json"]);
		const enumerationRoot = path.join(root, "enumeration-prime");
		await writeText(path.join(enumerationRoot, "sessions", "a.txt"), "a");
		await writeText(path.join(enumerationRoot, "sessions", "b.txt"), "b");
		await writeText(path.join(enumerationRoot, "sessions", "c.txt"), "c");
		const enumerationLimited = await discoverPrimeSource({ sourceRoot: enumerationRoot, cwd, maxEntries: 2 });
		expect(enumerationLimited.losses.filter(item => item.code === "source-budget-exceeded")).toEqual([
			expect.objectContaining({ sourceRef: "sessions/current" }),
		]);
	});

	it("orders Unicode source refs by code unit and keeps snapshot identity deterministic", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		await writeText(path.join(sourceRoot, "skills", "z.txt"), "z");
		await writeText(path.join(sourceRoot, "skills", "a.txt"), "a");
		await writeText(path.join(sourceRoot, "skills", "\u{1f600}.txt"), "emoji");
		await writeText(path.join(sourceRoot, "skills", "\uE000.txt"), "private");
		const first = await discoverPrimeSource({ sourceRoot, cwd });
		const second = await discoverPrimeSource({ sourceRoot, cwd });
		expect(first.inventory.files.map(file => file.sourceRef)).toEqual([
			"global/skills/a.txt",
			"global/skills/z.txt",
			"global/skills/😀.txt",
			"global/skills/.txt",
		]);
		expect(second.inventory.files.map(file => file.sourceRef)).toEqual(
			first.inventory.files.map(file => file.sourceRef),
		);
		expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
	});
	it("binds snapshot identity to canonical roots beyond file metadata", async () => {
		const root = await temporaryDirectory();
		const cwd = path.join(root, "project");
		const sourceRootA = path.join(root, "prime-a");
		const sourceRootB = path.join(root, "prime-b");
		const settingsA = path.join(sourceRootA, "settings.json");
		const settingsB = path.join(sourceRootB, "settings.json");
		await writeText(settingsA, '{"same":true}\n');
		await writeText(settingsB, '{"same":true}\n');
		const fixedTime = new Date("2020-01-02T03:04:05.000Z");
		for (const settingsPath of [settingsA, settingsB]) {
			await fs.chmod(settingsPath, 0o644);
			await fs.utimes(settingsPath, fixedTime, fixedTime);
		}
		const firstA = await discoverPrimeSource({ sourceRoot: sourceRootA, cwd });
		const secondA = await discoverPrimeSource({ sourceRoot: sourceRootA, cwd });
		const firstB = await discoverPrimeSource({ sourceRoot: sourceRootB, cwd });
		const fileA = firstA.inventory.files.find(file => file.sourceRef === "global/settings.json");
		const fileB = firstB.inventory.files.find(file => file.sourceRef === "global/settings.json");
		expect(fileA?.size).toBe(fileB?.size);
		expect(fileA?.mode).toBe(fileB?.mode);
		expect(fileA?.mtimeMs).toBe(fileB?.mtimeMs);
		expect(fileA?.sha256).toBe(fileB?.sha256);
		expect(firstA.snapshot.snapshotId).not.toBe(firstB.snapshot.snapshotId);
		expect(secondA.snapshot.snapshotId).toBe(firstA.snapshot.snapshotId);
		expect(await revalidatePrimeSource(firstA.snapshot)).toEqual({ ok: true, losses: [] });
	});

	it.skipIf(process.platform === "win32")("reports typed symlink replacement during revalidation", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		const settingsPath = path.join(sourceRoot, "settings.json");
		const outsidePath = path.join(root, "outside.json");
		await writeText(settingsPath, '{"stable":true}\n');
		await writeText(outsidePath, "outside");
		const snapshot = (await discoverPrimeSource({ sourceRoot, cwd })).snapshot;
		await fs.rm(settingsPath);
		await fs.symlink(outsidePath, settingsPath);
		const revalidated = await revalidatePrimeSource(snapshot);
		expect(revalidated.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "source-type-changed", sourceRef: "global/settings.json" }),
				expect.objectContaining({ code: "source-external-symlink", sourceRef: "global/settings.json" }),
			]),
		);
	});

	it.skipIf(process.platform === "win32")("detects retargeted accepted skill symlinks", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		const skillRoot = path.join(sourceRoot, "skills", "example");
		const linkPath = path.join(skillRoot, "link.md");
		await writeText(path.join(skillRoot, "target-a.md"), "a");
		await writeText(path.join(skillRoot, "target-b.md"), "b");
		await fs.symlink("target-a.md", linkPath);
		const snapshot = (await discoverPrimeSource({ sourceRoot, cwd })).snapshot;
		await fs.rm(linkPath);
		await fs.symlink("target-b.md", linkPath);
		const revalidated = await revalidatePrimeSource(snapshot);
		expect(revalidated.ok).toBe(false);
		expect(revalidated.losses).toContainEqual(
			expect.objectContaining({ code: "source-changed", sourceRef: "global/skills/example/link.md" }),
		);
	});

	it.skipIf(process.platform === "win32")("detects accepted skill directory mode changes", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		const skillRoot = path.join(sourceRoot, "skills", "example");
		await writeText(path.join(skillRoot, "SKILL.md"), "skill");
		await fs.chmod(skillRoot, 0o755);
		const snapshot = (await discoverPrimeSource({ sourceRoot, cwd })).snapshot;
		await fs.chmod(skillRoot, 0o700);
		const revalidated = await revalidatePrimeSource(snapshot);
		expect(revalidated.ok).toBe(false);
		expect(revalidated.losses).toContainEqual(
			expect.objectContaining({ code: "source-changed", sourceRef: "global/skills/example" }),
		);
	});

	it("keeps accepted skill tree entries stable across unchanged rediscovery", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		await writeText(path.join(sourceRoot, "skills", "example", "SKILL.md"), "skill");
		const first = await discoverPrimeSource({ sourceRoot, cwd });
		const second = await discoverPrimeSource({ sourceRoot, cwd });
		expect(second.snapshot.treeEntries).toEqual(first.snapshot.treeEntries);
		expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
		expect(await revalidatePrimeSource(first.snapshot)).toEqual({ ok: true, losses: [] });
	});

	it("reports malformed layout inputs", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		await writeText(path.join(sourceRoot, "sessions", "broken.jsonl"), "not json\n");
		await fs.mkdir(path.join(sourceRoot, "models.json"), { recursive: true });
		const discovered = await discoverPrimeSource({ sourceRoot, cwd });
		expect(discovered.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "source-invalid-layout", sourceRef: "sessions/current/broken.jsonl" }),
				expect.objectContaining({ code: "source-invalid-layout", sourceRef: "global/models.json" }),
			]),
		);
	});

	it("does not create missing source roots or destination state during discovery", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "missing-prime");
		const cwd = path.join(root, "missing-project");
		const sessionRoot = path.join(root, "missing-sessions");
		const discovered = await discoverPrimeSource({ sourceRoot, cwd, sessionRoot });
		expect(discovered.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "source-missing", sourceRef: "source-root" }),
				expect.objectContaining({ code: "source-missing", sourceRef: "sessions" }),
			]),
		);
		await expect(fs.access(sourceRoot)).rejects.toThrow();
		await expect(fs.access(cwd)).rejects.toThrow();
		await expect(fs.access(sessionRoot)).rejects.toThrow();
	});

	it("does not mutate source bytes and detects apply-time digest drift", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		const settingsPath = path.join(sourceRoot, "settings.json");
		await writeText(settingsPath, '{"stable":true}\n');
		const before = await digest(settingsPath);
		const first = await discoverPrimeSource({ sourceRoot, cwd });
		expect(await digest(settingsPath)).toBe(before);
		await writeText(path.join(sourceRoot, "models.json"), '{"new":true}\n');
		const addition = await revalidatePrimeSource(first.snapshot);
		expect(addition.losses).toContainEqual(
			expect.objectContaining({ code: "source-changed", sourceRef: "global/models.json" }),
		);
		await fs.rm(path.join(sourceRoot, "models.json"));
		const second = await discoverPrimeSource({ sourceRoot, cwd });
		expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
		await writeText(settingsPath, '{"stable":false}\n');
		const drift = await revalidatePrimeSource(first.snapshot);
		expect(drift.ok).toBe(false);
		expect(drift.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "source-drift", sourceRef: "global/settings.json" })]),
		);
		await fs.rm(settingsPath);
		const missing = await revalidatePrimeSource(first.snapshot);
		expect(missing.losses).toContainEqual(
			expect.objectContaining({ code: "source-missing", sourceRef: "global/settings.json" }),
		);
	});

	it("ignores drift outside explicitly revalidated domains", async () => {
		const root = await temporaryDirectory();
		const sourceRoot = path.join(root, "prime");
		const cwd = path.join(root, "project");
		const sessionPath = path.join(sourceRoot, "sessions", "session.jsonl");
		await writeText(path.join(sourceRoot, "settings.json"), '{"stable":true}\n');
		await writeText(sessionPath, '{"type":"session"}\n');
		const discovered = await discoverPrimeSource({ sourceRoot, cwd });

		await writeText(sessionPath, '{"type":"session","changed":true}\n');
		expect(
			await revalidatePrimeSource(discovered.snapshot, {
				domains: ["config", "settings", "models", "credentials"],
			}),
		).toEqual({ ok: true, losses: [] });
	});
});
