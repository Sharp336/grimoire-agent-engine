import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBlobsDir } from "@oh-my-pi/pi-utils";
import {
	formatPrimeImportHuman,
	type PrimeImportCliExecution,
	primeImportExitCode,
	runPrimeImportCommand,
	serializePrimeImportReport,
} from "../src/cli/prime-import-cli";
import { commands, isSubcommand, resolveCliArgv } from "../src/cli-commands";
import { type PrimeDestinationPaths, validatePrimeDestinationRollbackEntry } from "../src/import/prime/destination";
import * as sessionImport from "../src/import/prime/session-import";
import type { PrimeImportReport, PrimeRollbackManifestEntry, PrimeSourceSnapshot } from "../src/import/prime/types";
import { SessionManager } from "../src/session/session-manager";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

type CliProcessResult = { exitCode: number; output: string; error: string };

async function runCliProcess(args: string[], cwd: string): Promise<CliProcessResult> {
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOME: cwd, NO_COLOR: "1", PI_CODING_AGENT_DIR: path.join(cwd, "agent") },
	});
	const output = new Response(proc.stdout).text();
	const error = new Response(proc.stderr).text();
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, output, error]);
	return { exitCode, output: stdout, error: stderr };
}
interface PrimeCliFixture {
	readonly root: string;
	readonly source: string;
	readonly project: string;
	readonly agent: string;
}

async function makeFixture(): Promise<PrimeCliFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-cli-"));
	const source = path.join(root, "prime", "agent");
	const project = path.join(root, "project");
	const agent = path.join(root, "omp-agent");
	await fs.mkdir(source, { recursive: true });
	await fs.mkdir(project, { recursive: true });
	await fs.writeFile(path.join(source, "settings.json"), '{"defaultThinkingLevel":"high"}\n');
	await fs.writeFile(path.join(source, "auth.json"), '{"openai":{"type":"api_key","key":"literal-api-key"}}\n');
	const session = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "prime-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: project,
		}),
		JSON.stringify({
			type: "message",
			id: "user",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" },
				],
				timestamp: 1,
			},
		}),
	].join("\n");
	await fs.mkdir(path.join(source, "sessions"), { recursive: true });
	await fs.writeFile(path.join(source, "sessions", "prime-session.jsonl"), `${session}\n`);
	await fs.mkdir(path.join(project, ".prime"), { recursive: true });
	await fs.writeFile(path.join(project, ".prime", "config.json"), "{}\n");
	return { root, source, project, agent };
}

async function makeSessionIdCollisionFixture(): Promise<PrimeCliFixture> {
	const fixture = await makeFixture();
	const sessionsRoot = path.join(fixture.source, "sessions");
	await fs.rm(path.join(sessionsRoot, "prime-session.jsonl"));
	for (const [fileName, id] of [
		["a.jsonl", "x"],
		["b.jsonl", "x"],
		["c.jsonl", "x:1"],
	] as const) {
		await fs.writeFile(
			path.join(sessionsRoot, fileName),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: fixture.project,
			})}\n`,
		);
	}
	return fixture;
}

async function sha256File(file: string): Promise<string> {
	return createHash("sha256")
		.update(await fs.readFile(file))
		.digest("hex");
}

const destination = (
	agentDir: string,
	cwd = path.dirname(agentDir),
): PrimeDestinationPaths & PrimeImportCliExecution["destination"] => ({
	agentDir,
	cwd,
	settingsCandidates: [path.join(agentDir, "config.yml")],
	modelsPath: path.join(agentDir, "models.yml"),
	agentDbPath: path.join(agentDir, "agent.db"),
	skillsRoot: path.join(agentDir, "skills"),
	sessionsRoot: path.join(agentDir, "sessions"),
	blobsRoot: path.join(agentDir, "blobs"),
});

const emptyReport = (losses: PrimeImportReport["losses"] = []): PrimeImportReport => ({
	schemaVersion: 1,
	snapshotId: "a".repeat(64),
	items: [],
	losses,
	partialApply: false,
});

const makeManifestSnapshot = (
	fixture: PrimeCliFixture,
	budgets: Pick<PrimeSourceSnapshot, "maxFileBytes" | "maxEntries">,
): PrimeSourceSnapshot => ({
	schemaVersion: 1,
	snapshotId: "b".repeat(64),
	sourceRoot: fixture.source,
	cwd: fixture.project,
	sessionRoot: path.join(fixture.source, "sessions"),
	maxFileBytes: budgets.maxFileBytes,
	maxTotalBytes: 1024 * 1024,
	maxEntries: budgets.maxEntries,
	files: [],
	treeEntries: [],
});

describe("omp import prime registration", () => {
	it("is registered lazily and resolves without launching", () => {
		expect(commands.some(command => command.name === "import")).toBe(true);
		expect(isSubcommand("import")).toBe(true);
		expect(resolveCliArgv(["import", "prime"])).toEqual({ argv: ["import", "prime"] });
	});
});

describe("omp import prime child CLI", () => {
	it("emits one conservative JSON report when command execution throws", async () => {
		const fixture = await makeFixture();
		try {
			const result = await runCliProcess(["import", "prime", "--json", "unexpected"], fixture.project);
			expect(result.exitCode).toBe(1);
			expect(result.error).toBe("");
			const reports = result.output.trim().split("\n").filter(Boolean);
			expect(reports).toHaveLength(1);
			expect(JSON.parse(reports[0]!) as PrimeImportReport).toEqual({
				schemaVersion: 1,
				snapshotId: "serialization-failed",
				items: [],
				losses: [{ code: "destination-apply-failed", domain: "config", sourceRef: "output" }],
				partialApply: true,
			});
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
	it("defaults to a no-write dry run and emits the stable report JSON", async () => {
		const fixture = await makeFixture();
		try {
			const sourceDigest = await sha256File(path.join(fixture.source, "settings.json"));
			const result = await runCliProcess(
				[
					"import",
					"prime",
					"--source",
					fixture.source,
					"--cwd",
					fixture.project,
					"--agent-dir",
					fixture.agent,
					"--json",
				],
				fixture.project,
			);
			expect(result.exitCode, `${result.error}\n${result.output}`).toBe(0);
			expect(result.error).toBe("");
			const report = JSON.parse(result.output) as PrimeImportReport;
			expect(report.items, JSON.stringify(report, null, 2)).toHaveLength(3);
			expect(report).toMatchObject({ schemaVersion: 1, partialApply: false });
			expect(report.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ itemId: "setting:defaultThinkingLevel", outcome: "planned" }),
					expect.objectContaining({ itemId: "credential:openai", outcome: "planned" }),
					expect.objectContaining({ itemId: "session:prime-session", outcome: "planned" }),
				]),
			);
			expect(report).not.toHaveProperty("rollbackManifest");
			expect(result.output).not.toContain("literal-api-key");
			expect(report).not.toHaveProperty("destination");
			expect(report).not.toHaveProperty("human");
			expect(report).not.toHaveProperty("exitCode");
			expect(await sha256File(path.join(fixture.source, "settings.json"))).toBe(sourceDigest);
			expect(
				await fs.stat(fixture.agent).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("applies configuration only when legacy sessions cannot be imported", async () => {
		const fixture = await makeFixture();
		try {
			await fs.writeFile(path.join(fixture.source, "sessions", "prime-session.jsonl"), "{not-json}\n");
			await fs.writeFile(
				path.join(fixture.source, "models.json"),
				JSON.stringify({
					providers: {
						broken: {
							api: "openai-completions",
							models: [{ id: "invalid-without-provider-auth" }],
						},
					},
				}),
			);
			const args = [
				"import",
				"prime",
				"--source",
				fixture.source,
				"--cwd",
				fixture.project,
				"--agent-dir",
				fixture.agent,
				"--apply",
				"--json",
			];

			const refused = await runCliProcess(args, fixture.project);
			expect(refused.exitCode).toBe(1);
			expect(
				await fs.stat(fixture.agent).then(
					() => true,
					() => false,
				),
			).toBe(false);

			const applied = await runCliProcess([...args, "--config-only"], fixture.project);
			expect(applied.exitCode, `${applied.error}\n${applied.output}`).toBe(0);
			const report = JSON.parse(applied.output) as PrimeImportReport;
			expect(report.losses.some(loss => loss.domain === "sessions")).toBe(false);
			expect(report.losses).toContainEqual(
				expect.objectContaining({ code: "models-invalid-value", domain: "models" }),
			);
			expect(report.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ itemId: "setting:defaultThinkingLevel", outcome: "imported" }),
					expect.objectContaining({ itemId: "credential:openai", outcome: "imported" }),
					expect.objectContaining({
						itemId: "model:broken:definition:invalid-without-provider-auth",
						outcome: "lost",
					}),
				]),
			);
			expect(report.items.some(item => item.kind === "sessions")).toBe(false);
			await expect(fs.stat(path.join(fixture.agent, "config.yml"))).resolves.toBeDefined();
			await expect(fs.stat(path.join(fixture.agent, "agent.db"))).resolves.toBeDefined();
			await expect(fs.stat(path.join(fixture.agent, "models.yml"))).rejects.toThrow();
			for (const excludedPath of ["skills", "sessions", "blobs", ".prime-import"])
				await expect(fs.stat(path.join(fixture.agent, excludedPath))).rejects.toThrow();
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("falls back to the legacy ~/.pi/agent source when ~/.prime/agent is absent", async () => {
		const fixture = await makeFixture();
		const legacySource = path.join(fixture.project, ".pi", "agent");
		try {
			await fs.mkdir(legacySource, { recursive: true });
			await fs.writeFile(path.join(legacySource, "settings.json"), '{"defaultThinkingLevel":"high"}\n');
			const result = await runCliProcess(
				["import", "prime", "--cwd", fixture.project, "--agent-dir", fixture.agent, "--json"],
				fixture.project,
			);
			expect(result.exitCode, `${result.error}\n${result.output}`).toBe(0);
			const report = JSON.parse(result.output) as PrimeImportReport;
			expect(report.items).toContainEqual(
				expect.objectContaining({ itemId: "setting:defaultThinkingLevel", outcome: "planned" }),
			);
			expect(report.losses).not.toContainEqual(expect.objectContaining({ code: "source-missing" }));
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("keeps colliding session IDs visible with globally unique dry-run item IDs", async () => {
		const fixture = await makeSessionIdCollisionFixture();
		try {
			const args = [
				"import",
				"prime",
				"--source",
				fixture.source,
				"--cwd",
				fixture.project,
				"--agent-dir",
				fixture.agent,
				"--json",
			];
			const first = await runCliProcess(args, fixture.project);
			const second = await runCliProcess(args, fixture.project);
			expect(first.exitCode, `${first.error}\n${first.output}`).toBe(0);
			expect(first.error).toBe("");
			expect(second).toEqual(first);

			const report = JSON.parse(first.output) as PrimeImportReport;
			const sessionItems = report.items.filter(item => item.kind === "sessions");
			expect(sessionItems).toHaveLength(3);
			expect(new Set(sessionItems.map(item => item.itemId)).size).toBe(3);
			expect(sessionItems.map(item => ({ itemId: item.itemId, sourceRefs: item.sourceRefs }))).toEqual([
				{ itemId: "session:x", sourceRefs: ["sessions/current/a.jsonl"] },
				{ itemId: "session:x:1", sourceRefs: ["sessions/current/b.jsonl"] },
				{ itemId: "session:x:1:1", sourceRefs: ["sessions/current/c.jsonl"] },
			]);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("applies settings, credentials, sessions, CAS images, and one complete manifest", async () => {
		const fixture = await makeFixture();
		try {
			const first = await runCliProcess(
				[
					"import",
					"prime",
					"--source",
					fixture.source,
					"--cwd",
					fixture.project,
					"--agent-dir",
					fixture.agent,
					"--apply",
					"--json",
				],
				fixture.project,
			);
			expect(first.exitCode, `${first.error}\n${first.output}`).toBe(0);
			expect(first.error).toBe("");
			const report = JSON.parse(first.output) as PrimeImportReport;
			expect(report.items).toHaveLength(3);
			const itemIds = report.items.map(item => item.itemId);
			expect(new Set(itemIds).size).toBe(itemIds.length);
			expect(report.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						itemId: "setting:defaultThinkingLevel",
						kind: "settings",
						outcome: "imported",
					}),
					expect.objectContaining({ itemId: "credential:openai", kind: "credentials", outcome: "imported" }),
					expect.objectContaining({ itemId: "session:prime-session", kind: "sessions", outcome: "imported" }),
				]),
			);
			expect(first.output).not.toContain("literal-api-key");

			const sessionInfos = await SessionManager.list(fixture.project, path.join(fixture.agent, "sessions"));
			expect(sessionInfos).toHaveLength(1);
			const reopened = await SessionManager.open(sessionInfos[0]!.path);
			try {
				expect(JSON.stringify(reopened.getEntries())).toContain("prime_session_import");
				expect(JSON.stringify(reopened.getEntries())).toContain("blob:sha256:");
			} finally {
				await reopened.close();
			}
			const imageDigest = createHash("sha256").update("image-bytes").digest("hex");
			expect(await fs.readFile(path.join(getBlobsDir(fixture.agent), imageDigest), "utf8")).toBe("image-bytes");

			const manifestPath = path.join(fixture.agent, ".prime-import", `rollback-${report.snapshotId}.json`);
			const manifestText = await fs.readFile(manifestPath, "utf8");
			const manifest = JSON.parse(manifestText) as {
				entries: Array<Record<string, unknown>>;
			};
			expect(manifest.entries.length).toBeGreaterThan(2);
			expect(manifest.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						itemId: "setting:defaultThinkingLevel",
						currentSha256: expect.any(String),
						priorExists: false,
						created: true,
					}),
					expect.objectContaining({
						itemId: "session:prime-session",
						currentSha256: expect.any(String),
						nodeType: "regular-file",
						created: true,
					}),
				]),
			);
			expect(manifestText).not.toContain("literal-api-key");
			const rollbackDestination = destination(fixture.agent, await fs.realpath(fixture.project));
			const logicalValidation = await Promise.all(
				manifest.entries
					.filter(entry => entry.kind === "settings" || entry.kind === "credentials")
					.map(async entry => [
						entry.itemId,
						await validatePrimeDestinationRollbackEntry(
							entry as unknown as PrimeRollbackManifestEntry,
							rollbackDestination,
						),
					]),
			);
			expect(logicalValidation, JSON.stringify(logicalValidation)).toEqual([
				["credential:openai", true],
				["setting:defaultThinkingLevel", true],
			]);
			const physicalValidation = await Promise.all(
				manifest.entries
					.filter(entry => entry.kind === "sessions" || entry.kind === "artifacts")
					.map(async entry => {
						const paths = new Set(
							[entry.destinationRef, entry.canonicalDestinationRef, entry.logicalDestinationRef].filter(
								(value): value is string => typeof value === "string",
							),
						);
						return [
							entry.itemId,
							(
								await Promise.all(
									[...paths].map(async candidate => (await sha256File(candidate)) === entry.currentSha256),
								)
							).every(Boolean),
						];
					}),
			);
			expect(physicalValidation, JSON.stringify(physicalValidation)).toEqual(
				physicalValidation.map(([itemId]) => [itemId, true]),
			);

			const second = await runCliProcess(
				[
					"import",
					"prime",
					"--source",
					fixture.source,
					"--cwd",
					fixture.project,
					"--agent-dir",
					fixture.agent,
					"--apply",
					"--json",
				],
				fixture.project,
			);
			const afterLogicalValidation = await Promise.all(
				manifest.entries
					.filter(entry => entry.kind === "settings" || entry.kind === "credentials")
					.map(async entry => [
						entry.itemId,
						await validatePrimeDestinationRollbackEntry(
							entry as unknown as PrimeRollbackManifestEntry,
							rollbackDestination,
						),
					]),
			);
			const afterPhysicalValidation = await Promise.all(
				manifest.entries
					.filter(entry => entry.kind === "sessions" || entry.kind === "artifacts")
					.map(async entry => [
						entry.itemId,
						(
							await Promise.all(
								[
									...new Set(
										[entry.destinationRef, entry.canonicalDestinationRef, entry.logicalDestinationRef].filter(
											(value): value is string => typeof value === "string",
										),
									),
								].map(async candidate => (await sha256File(candidate)) === entry.currentSha256),
							)
						).every(Boolean),
					]),
			);
			expect(
				second.exitCode,
				`${second.error}\n${second.output}\n${JSON.stringify({ afterLogicalValidation, afterPhysicalValidation })}`,
			).toBe(0);
			const rerun = JSON.parse(second.output) as PrimeImportReport;
			expect(rerun.items.some(item => item.outcome === "skipped")).toBe(true);
			expect(new Set(rerun.items.map(item => item.itemId)).size).toBe(rerun.items.length);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects an existing structurally valid rollback manifest over the snapshot byte budget", async () => {
		const fixture = await makeFixture();
		try {
			const snapshot = makeManifestSnapshot(fixture, { maxFileBytes: 1, maxEntries: 4 });
			const sessionDir = path.join(fixture.agent, "sessions");
			const blobDir = path.join(fixture.agent, "blobs");
			const manifestPath = path.join(fixture.agent, ".prime-import", `rollback-${snapshot.snapshotId}.json`);
			const manifest = {
				schemaVersion: 1 as const,
				snapshotId: snapshot.snapshotId,
				source: { sourceRoot: snapshot.sourceRoot, sessionRoot: snapshot.sessionRoot, cwd: snapshot.cwd },
				destination: { cwd: fixture.project, sessionDir, blobDir },
				entries: [],
			};
			const manifestText = `${JSON.stringify(manifest)}\n`;
			await fs.mkdir(path.dirname(manifestPath), { recursive: true });
			await fs.writeFile(manifestPath, manifestText);

			const loss = await sessionImport.preflightPrimeSessionRollbackManifest(snapshot, {
				destinationCwd: fixture.project,
				sessionDir,
				blobDir,
				rollbackManifestPath: manifestPath,
			});

			expect(loss).toEqual(expect.objectContaining({ code: "destination-invalid" }));
			expect(await fs.readFile(manifestPath, "utf8")).toBe(manifestText);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects an existing structurally valid rollback manifest over the snapshot entry budget", async () => {
		const fixture = await makeFixture();
		try {
			const snapshot = makeManifestSnapshot(fixture, { maxFileBytes: 1024 * 1024, maxEntries: 1 });
			const sessionDir = path.join(fixture.agent, "sessions");
			const blobDir = path.join(fixture.agent, "blobs");
			const manifestPath = path.join(fixture.agent, ".prime-import", `rollback-${snapshot.snapshotId}.json`);
			const entry = (itemId: string): PrimeRollbackManifestEntry => ({
				itemId,
				kind: "settings",
				destinationRef: itemId,
				canonicalDestinationRef: itemId,
				created: true,
				priorExists: false,
				currentSha256: "a".repeat(64),
				nodeType: "regular-file",
			});
			const manifest = {
				schemaVersion: 1 as const,
				snapshotId: snapshot.snapshotId,
				source: { sourceRoot: snapshot.sourceRoot, sessionRoot: snapshot.sessionRoot, cwd: snapshot.cwd },
				destination: { cwd: fixture.project, sessionDir, blobDir },
				entries: [entry("setting:first"), entry("setting:second")],
			};
			const manifestText = `${JSON.stringify(manifest)}\n`;
			await fs.mkdir(path.dirname(manifestPath), { recursive: true });
			await fs.writeFile(manifestPath, manifestText);

			const loss = await sessionImport.preflightPrimeSessionRollbackManifest(snapshot, {
				destinationCwd: fixture.project,
				sessionDir,
				blobDir,
				rollbackManifestPath: manifestPath,
				validateDestinationRollbackEntry: () => true,
			});

			expect(loss).toEqual(expect.objectContaining({ code: "destination-invalid" }));
			expect(await fs.readFile(manifestPath, "utf8")).toBe(manifestText);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects an existing invalid rollback manifest before mutating destination state", async () => {
		const fixture = await makeFixture();
		try {
			const args = [
				"import",
				"prime",
				"--source",
				fixture.source,
				"--cwd",
				fixture.project,
				"--agent-dir",
				fixture.agent,
				"--json",
			];
			const dryRun = await runCliProcess(args, fixture.project);
			expect(dryRun.exitCode, `${dryRun.error}\n${dryRun.output}`).toBe(0);
			const snapshotId = (JSON.parse(dryRun.output) as PrimeImportReport).snapshotId;
			const manifestPath = path.join(fixture.agent, ".prime-import", `rollback-${snapshotId}.json`);
			const corruptManifest = "{not-json}\n";
			await fs.mkdir(path.dirname(manifestPath), { recursive: true });
			await fs.writeFile(manifestPath, corruptManifest);

			const applied = await runCliProcess([...args, "--apply"], fixture.project);
			expect(applied.exitCode, `${applied.error}\n${applied.output}`).toBe(1);
			expect(applied.error).toBe("");
			const report = JSON.parse(applied.output) as PrimeImportReport;
			expect(report.snapshotId).toBe(snapshotId);
			expect(report.partialApply).toBe(false);
			expect(await fs.readFile(manifestPath, "utf8")).toBe(corruptManifest);

			for (const destinationPath of [
				path.join(fixture.agent, "config.yml"),
				path.join(fixture.agent, "models.yml"),
				path.join(fixture.agent, "agent.db"),
				path.join(fixture.agent, "skills"),
				path.join(fixture.agent, "sessions"),
				path.join(fixture.agent, "blobs"),
			]) {
				expect(
					await fs.stat(destinationPath).then(
						() => true,
						() => false,
					),
					destinationPath,
				).toBe(false);
			}
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
	it("rejects destination roots equal to, containing, or contained by the Prime source before writing", async () => {
		const fixture = await makeFixture();
		try {
			const sourceDigest = await sha256File(path.join(fixture.source, "settings.json"));
			for (const agentDir of [fixture.source, path.dirname(fixture.source), path.join(fixture.source, "nested")]) {
				const result = await runCliProcess(
					[
						"import",
						"prime",
						"--source",
						fixture.source,
						"--cwd",
						fixture.project,
						"--agent-dir",
						agentDir,
						"--apply",
						"--json",
					],
					fixture.project,
				);
				expect(result.exitCode, `${result.error}\n${result.output}`).toBe(1);
				expect(result.error).toBe("");
				expect(JSON.parse(result.output)).toMatchObject({
					partialApply: false,
					losses: expect.arrayContaining([expect.objectContaining({ code: "destination-invalid" })]),
				});
				expect(await sha256File(path.join(fixture.source, "settings.json"))).toBe(sourceDigest);
			}
			expect(
				await fs.stat(path.join(fixture.source, "nested")).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("rejects a destination symlink alias before writing", async () => {
		const fixture = await makeFixture();
		const alias = path.join(fixture.root, "agent-alias");
		try {
			await fs.symlink(fixture.source, alias);
			const result = await runCliProcess(
				[
					"import",
					"prime",
					"--source",
					fixture.source,
					"--cwd",
					fixture.project,
					"--agent-dir",
					alias,
					"--apply",
					"--json",
				],
				fixture.project,
			);
			expect(result.exitCode, `${result.error}\n${result.output}`).toBe(1);
			expect(result.error).toBe("");
			expect(JSON.parse(result.output)).toMatchObject({
				partialApply: false,
				losses: expect.arrayContaining([expect.objectContaining({ code: "destination-invalid" })]),
			});
			expect(await fs.realpath(alias)).toBe(await fs.realpath(fixture.source));
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("reports every known planned candidate as lost when manifest preflight fails", async () => {
		const fixture = await makeFixture();
		try {
			const args = [
				"import",
				"prime",
				"--source",
				fixture.source,
				"--cwd",
				fixture.project,
				"--agent-dir",
				fixture.agent,
				"--apply",
				"--json",
			];
			const dryRun = await runCliProcess(
				args.filter(value => value !== "--apply"),
				fixture.project,
			);
			const snapshotId = (JSON.parse(dryRun.output) as PrimeImportReport).snapshotId;
			const manifestPath = path.join(fixture.agent, ".prime-import", `rollback-${snapshotId}.json`);
			await fs.mkdir(path.dirname(manifestPath), { recursive: true });
			await fs.writeFile(manifestPath, "{not-json}\n");
			const result = await runCliProcess(args, fixture.project);
			expect(result.exitCode, `${result.error}\n${result.output}`).toBe(1);
			const report = JSON.parse(result.output) as PrimeImportReport;
			expect(report.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ itemId: "setting:defaultThinkingLevel", outcome: "lost" }),
					expect.objectContaining({ itemId: "credential:openai", outcome: "lost" }),
					expect.objectContaining({ itemId: "session:prime-session", outcome: "lost" }),
				]),
			);
			expect(report.items).not.toHaveLength(0);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
	it("retains destination accounting when session apply throws after destination commit", async () => {
		const fixture = await makeFixture();
		const primeCliConfigPath = path.join(fixture.root, "prime-cli-config.json");
		await fs.writeFile(primeCliConfigPath, "{}\n");
		const sessionApply = vi
			.spyOn(sessionImport, "applyPrimeSessions")
			.mockRejectedValueOnce(new Error("post-commit session failure"));
		try {
			const result = await runPrimeImportCommand({
				source: fixture.source,
				cwd: fixture.project,
				primeCliConfigPath,
				agentDir: fixture.agent,
				apply: true,
			});
			expect(result.exitCode).toBe(1);
			expect(result.report.partialApply).toBe(true);
			expect(result.report.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ itemId: "setting:defaultThinkingLevel", outcome: "imported" }),
					expect.objectContaining({ itemId: "session:prime-session", outcome: "lost" }),
				]),
			);
			expect(result.report.rollbackManifest).toBeUndefined();
		} finally {
			sessionApply.mockRestore();
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("rejects a symlinked destination ancestor without writes", async () => {
		const fixture = await makeFixture(),
			victim = path.join(fixture.root, "victim"),
			link = path.join(fixture.root, "link");
		try {
			await fs.mkdir(victim);
			await fs.symlink(victim, link);
			const result = await runCliProcess(
				[
					"import",
					"prime",
					"--source",
					fixture.source,
					"--cwd",
					fixture.project,
					"--agent-dir",
					path.join(link, "omp"),
					"--apply",
					"--json",
				],
				fixture.project,
			);
			expect(result.exitCode, `${result.error}\n${result.output}`).toBe(1);
			expect(result.error).toBe("");
			const report = JSON.parse(result.output) as PrimeImportReport;
			expect(report.partialApply).toBe(false);
			expect(report.losses).toContainEqual(expect.objectContaining({ code: "destination-invalid" }));
			expect(await fs.readdir(victim)).toEqual([]);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("reports source failures with exit 1 and no destination writes", async () => {
		const fixture = await makeFixture();
		try {
			const result = await runCliProcess(
				[
					"import",
					"prime",
					"--source",
					path.join(fixture.root, "missing"),
					"--cwd",
					fixture.project,
					"--agent-dir",
					fixture.agent,
					"--json",
				],
				fixture.project,
			);
			expect(result.exitCode).toBe(1);
			expect(JSON.parse(result.output)).toMatchObject({ schemaVersion: 1, partialApply: false });
			expect(
				await fs.stat(fixture.agent).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("escapes terminal controls in child JSON output while preserving missing source paths", async () => {
		const fixture = await makeFixture();
		try {
			const controlCodes = ["0085", "061c", "200e", "200f", "2028", "2029", "2066", "2067", "2068", "2069"] as const;
			const missingSource = path.join(
				fixture.root,
				`missing-${String.fromCodePoint(...controlCodes.map(code => Number.parseInt(code, 16)))}`,
			);
			const result = await runCliProcess(
				[
					"import",
					"prime",
					"--source",
					missingSource,
					"--cwd",
					fixture.project,
					"--agent-dir",
					fixture.agent,
					"--json",
				],
				fixture.project,
			);

			expect(result.exitCode, `${result.error}\n${result.output}`).toBe(1);
			expect(result.error).toBe("");
			for (const code of controlCodes) {
				expect(result.output).toContain(`\\u${code}`);
				expect(result.output).not.toContain(String.fromCodePoint(Number.parseInt(code, 16)));
			}
			const report = JSON.parse(result.output) as PrimeImportReport;
			expect(report.losses).toContainEqual(
				expect.objectContaining({ sourceRef: "source-root", path: missingSource }),
			);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
	it("keeps Task5 state and publishes its manifest when sessions are rejected", async () => {
		const fixture = await makeFixture();
		try {
			await fs.mkdir(fixture.agent, { recursive: true });
			const sessionSentinel = path.join(fixture.agent, "sessions");
			await fs.writeFile(sessionSentinel, "not-a-directory");
			const result = await runCliProcess(
				[
					"import",
					"prime",
					"--source",
					fixture.source,
					"--cwd",
					fixture.project,
					"--agent-dir",
					fixture.agent,
					"--apply",
					"--json",
				],
				fixture.project,
			);
			expect(result.exitCode, `${result.error}\n${result.output}`).toBe(1);
			expect(result.error).toBe("");
			const report = JSON.parse(result.output) as PrimeImportReport;
			expect(report.partialApply).toBe(true);
			expect(report.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ itemId: "setting:defaultThinkingLevel", outcome: "imported" }),
					expect.objectContaining({ itemId: "session:prime-session", outcome: "lost" }),
				]),
			);
			const manifestPath = path.join(fixture.agent, ".prime-import", `rollback-${report.snapshotId}.json`);
			const manifestText = await fs.readFile(manifestPath, "utf8");
			expect(manifestText).toContain("setting:defaultThinkingLevel");
			expect(await fs.readFile(sessionSentinel, "utf8")).toBe("not-a-directory");
			expect(
				await fs.stat(getBlobsDir(fixture.agent)).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects unsupported syntax before running the importer", async () => {
		const fixture = await makeFixture();
		try {
			for (const args of [
				["import", "claude"],
				["import", "prime", "--force"],
				["import", "prime", "extra"],
				["import", "prime", "--dry-run"],
			]) {
				const result = await runCliProcess(args, fixture.project);
				expect(result.exitCode).toBe(1);
				expect(result.output).toBe("");
				expect(result.error).toContain("error:");
			}
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("does not require the implicit Prime CLI config for a dry run", async () => {
		const fixture = await makeFixture();
		try {
			await fs.rm(path.join(fixture.project, ".prime", "config.json"));
			const result = await runCliProcess(
				[
					"import",
					"prime",
					"--source",
					fixture.source,
					"--cwd",
					fixture.project,
					"--agent-dir",
					fixture.agent,
					"--json",
				],
				fixture.project,
			);
			expect(result.exitCode, `${result.error}\n${result.output}`).toBe(0);
			const report = JSON.parse(result.output) as PrimeImportReport;
			expect(report.losses.some(loss => loss.sourceRef === "cli-config/config")).toBe(false);
			expect(
				await fs.stat(fixture.agent).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("keeps an explicitly missing Prime CLI config fatal", async () => {
		const fixture = await makeFixture();
		try {
			const result = await runCliProcess(
				[
					"import",
					"prime",
					"--source",
					fixture.source,
					"--cwd",
					fixture.project,
					"--agent-dir",
					fixture.agent,
					"--prime-cli-config",
					path.join(fixture.root, "missing-config.json"),
					"--json",
				],
				fixture.project,
			);
			expect(result.exitCode).toBe(1);
			const report = JSON.parse(result.output) as PrimeImportReport;
			expect(report.losses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "source-missing", sourceRef: "cli-config/config" }),
				]),
			);
			expect(
				await fs.stat(fixture.agent).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
	it("deduplicates an explicit source/session root through dry-run and apply", async () => {
		const fixture = await makeFixture();
		try {
			await fs.rm(path.join(fixture.source, "sessions", "prime-session.jsonl"));
			await fs.writeFile(
				path.join(fixture.source, "root.jsonl"),
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "root-session",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: fixture.project,
				})}\n`,
			);
			const args = [
				"import",
				"prime",
				"--source",
				fixture.source,
				"--session-root",
				fixture.source,
				"--cwd",
				fixture.project,
				"--agent-dir",
				fixture.agent,
				"--json",
			];

			const dryRun = await runCliProcess(args, fixture.project);
			expect(dryRun.exitCode, `${dryRun.error}\n${dryRun.output}`).toBe(0);
			const dryReport = JSON.parse(dryRun.output) as PrimeImportReport;
			const drySessionItems = dryReport.items.filter(item => item.kind === "sessions");
			expect(drySessionItems).toHaveLength(1);
			expect(drySessionItems[0]).toMatchObject({
				itemId: "session:root-session",
				outcome: "planned",
				sourceRefs: ["sessions/current/root.jsonl"],
			});

			const applied = await runCliProcess([...args, "--apply"], fixture.project);
			expect(applied.exitCode, `${applied.error}\n${applied.output}`).toBe(0);
			const applyReport = JSON.parse(applied.output) as PrimeImportReport;
			const applySessionItems = applyReport.items.filter(item => item.kind === "sessions");
			expect(applySessionItems).toHaveLength(1);
			expect(applySessionItems[0]).toMatchObject({
				itemId: "session:root-session",
				outcome: "imported",
				sourceRefs: ["sessions/current/root.jsonl"],
			});

			const sessionInfos = await SessionManager.list(fixture.project, path.join(fixture.agent, "sessions"));
			expect(sessionInfos).toHaveLength(1);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("Prime import report presentation", () => {
	it("keeps typed losses successful and redacts all secret payloads", () => {
		const report: PrimeImportReport = {
			...emptyReport([
				{ code: "credentials-oauth-relogin", domain: "credentials", sourceRef: "global/auth.json:7" },
				{ code: "credentials-command-ref", domain: "credentials", sourceRef: "global/auth.json:8" },
				{ code: "credentials-env-ref", domain: "credentials", sourceRef: "global/auth.json:9" },
			]),
			items: [
				{
					itemId: "credential:openai",
					kind: "credentials",
					sourceRefs: ["global/auth.json:7"],
					outcome: "skipped",
					lossCodes: ["credentials-oauth-relogin"],
				},
			],
		};
		expect(primeImportExitCode(report)).toBe(0);
		const human = formatPrimeImportHuman({ report, destination: destination("/tmp/omp-agent") }, false);
		expect(human).toContain("OAuth re-login:");
		expect(human).toContain("credential:openai");
		for (const secret of [
			"literal-api-key",
			"oauth-access-token",
			"oauth-refresh-token",
			"command-secret",
			"env-secret",
		])
			expect(human).not.toContain(secret);
	});
	it("fails for a material session loss even when no loss record is present", () => {
		const report: PrimeImportReport = {
			...emptyReport(),
			items: [
				{
					itemId: "session:lost",
					kind: "sessions",
					sourceRefs: ["sessions/current/lost.jsonl"],
					outcome: "lost",
				},
			],
		};
		expect(primeImportExitCode(report)).toBe(1);
	});

	it("summarizes repeated human losses instead of printing every record", () => {
		const losses = Array.from({ length: 500 }, (_, index) => ({
			code: "sessions-broken-parent" as const,
			domain: "sessions" as const,
			sourceRef: "legacy/session.jsonl",
			path: "legacy/session.jsonl",
			line: index + 1,
		}));
		const human = formatPrimeImportHuman(
			{ report: emptyReport(losses), destination: destination("/tmp/omp-agent") },
			false,
		);
		expect(human).toContain("sessions-broken-parent\tsessions\t500");
		expect(human).not.toContain("legacy/session.jsonl");
	});

	it("serializes JSON controls in values without changing the report", () => {
		const report: PrimeImportReport = {
			...emptyReport([
				{
					code: "source-missing",
					domain: "config",
					sourceRef:
						"source\u0000\u0008\u0009\u000a\u000b\u000c\u000d\u001f\u007f\u0085\u061c\u2028\u2029\u202e\u2066\u2069",
					path: "path\u0000\u001b",
				},
			]),
			snapshotId: "snapshot\u0000\u001f",
			items: [
				{
					itemId: "session:item\u000a",
					kind: "sessions",
					sourceRefs: ["session\u000d"],
					outcome: "lost",
				},
			],
		};
		const serialized = serializePrimeImportReport(report);
		expect(JSON.parse(serialized)).toEqual(report);
		expect(serialized).toContain("\\u0000");
		expect(serialized).toContain("\\u0008");
		expect(serialized).toContain("\\u0009");
		expect(serialized).toContain("\\u000a");
		expect(serialized).toContain("\\u000b");
		expect(serialized).toContain("\\u000c");
		expect(serialized).toContain("\\u000d");
		expect(serialized).toContain("\\u001b");
		expect(serialized).toContain("\\u007f");
		expect(serialized).toContain("\\u0085");
		expect(serialized).toContain("\\u061c");
		expect(serialized).toContain("\\u202e");
		expect(serialized).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u2028\u2029\u202e\u2066\u2069]/);
	});

	it("includes all deterministic human summary fields", () => {
		const report = emptyReport();
		const execution = { report, destination: destination("/tmp/omp-agent") };
		const human = formatPrimeImportHuman(execution, false);
		expect(formatPrimeImportHuman(execution, false)).toBe(human);
		expect(human).toContain("settings:");
		expect(human).toContain("models:");
		expect(human).toContain("auth DB:");
		expect(human).toContain("skills:");
		expect(human).toContain("sessions:");
		expect(human).toContain("blobs:");
		expect(human).toContain("Counts: planned=0 imported=0 skipped=0 lost=0");
		expect(human).toContain("Losses:");
		expect(human).toContain("Manifest: not written");
		expect(human).toContain("Partial apply: no");
	});
	it("escapes terminal controls from every dynamic human field", () => {
		const report: PrimeImportReport = {
			...emptyReport([
				{
					code: "source-missing",
					domain: "config",
					sourceRef: "source\u001b[31m-ref\u202e\u2028\u2029\u2066\u2069",
					path: "/tmp/source\u0007-path",
				},
			]),
			snapshotId: "snap\u001b[31mshot\u202e",
			items: [
				{
					itemId: "credential:item\u007f\u2069",
					kind: "credentials",
					sourceRefs: ["auth\u0085-ref\u2028"],
					outcome: "skipped",
					lossCodes: ["credentials-oauth-relogin"],
				},
			],
		};
		const execution = {
			report,
			destination: destination("/tmp/omp\u0009-agent\u2066"),
			manifestPath: "/tmp/manifest\u000b.json\u2029",
		};
		const human = formatPrimeImportHuman(execution, false);
		expect(human).toContain("\\u001b");
		expect(human).toContain("\\u007f");
		expect(human).toContain("\\u0085");
		expect(human).toContain("\\u0009");
		expect(human).toContain("\\u000b");
		expect(human).toContain("\\u202e");
		expect(human).toContain("\\u2028");
		expect(human).toContain("\\u2029");
		expect(human).toContain("\\u2066");
		expect(human).toContain("\\u2069");
		expect(human).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202e\u2066\u2069]/);
		expect(human).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
	});
});
