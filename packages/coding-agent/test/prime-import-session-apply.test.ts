import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyPrimeSessions,
	canonicalPrimeImportOsPath,
	type PrimeSessionApplyInput,
	type PrimeSessionApplyReport,
} from "../src/import/prime/session-import";
import { discoverPrimeSource } from "../src/import/prime/source";
import type { PrimeNormalizedSession, PrimeRollbackManifestEntry, PrimeSourceFile } from "../src/import/prime/types";
import { persistConvertedSession } from "../src/session/foreign-session-import";
import { SessionManager } from "../src/session/session-manager";

const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

type Fixture = {
	readonly sourceRoot: string;
	readonly sessionRoot: string;
	readonly cwd: string;
	readonly file: PrimeSourceFile;
};

async function sourceFile(root: string, sourceRef: string, content: string): Promise<Fixture> {
	const sourceRootRaw = path.join(root, "prime");
	const sessionRootRaw = path.join(sourceRootRaw, "sessions");
	const cwdRaw = path.join(root, "source-project");
	await fs.mkdir(sessionRootRaw, { recursive: true });
	await fs.mkdir(cwdRaw, { recursive: true });
	const sourceRoot = await fs.realpath(sourceRootRaw);
	const sessionRoot = await fs.realpath(sessionRootRaw);
	const cwd = await fs.realpath(cwdRaw);
	const canonicalPath = path.join(sessionRoot, path.basename(sourceRef));
	const header = {
		type: "session",
		version: 3,
		id: path.basename(sourceRef, ".jsonl"),
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
	};
	const bytes = Buffer.from(`${JSON.stringify(header)}\n${content}`);
	await fs.writeFile(canonicalPath, bytes, { mode: 0o600 });
	const discovery = await discoverPrimeSource({ sourceRoot, cwd, sessionRoot });
	const file = discovery.inventory.files.find(candidate => candidate.sourceRef === sourceRef);
	if (!file) throw new Error(`fixture source was not discovered: ${sourceRef}`);
	return { sourceRoot, sessionRoot, cwd, file };
}

function session(
	sourceRef: string,
	id: string,
	sourceSha256: string,
	cwd: string,
	title = "Imported title",
): PrimeNormalizedSession {
	return {
		kind: "session",
		sourceRef,
		sourceSha256,
		header: {
			type: "session",
			version: 3,
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
			title,
			lineage: { child: false },
		},
		entries: [
			{
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
			},
		],
	};
}

function input(
	sessionValue: PrimeNormalizedSession,
	fixture: Fixture,
	extraFiles: readonly PrimeSourceFile[] = [],
	snapshotId = "snapshot-1",
): PrimeSessionApplyInput {
	return {
		snapshot: {
			schemaVersion: 1,
			snapshotId,
			sourceRoot: fixture.sourceRoot,
			cwd: fixture.cwd,
			sessionRoot: fixture.sessionRoot,
			maxFileBytes: 1_000_000,
			maxTotalBytes: 1_000_000,
			maxEntries: 100,
			files: [fixture.file, ...extraFiles].map(({ contentBase64: _contentBase64, ...metadata }) => metadata),
			treeEntries: [],
		},
		sessions: [sessionValue],
		sourceFiles: [fixture.file, ...extraFiles],
	};
}

async function destination(root: string) {
	const sessionDir = path.join(root, "sessions");
	const blobDir = path.join(root, "blobs");
	const destinationCwd = path.join(root, "project");
	await fs.mkdir(destinationCwd);
	return { sessionDir, blobDir, destinationCwd };
}

describe("applyPrimeSessions", () => {
	it("canonicalizes Darwin private temp aliases without rewriting Linux paths", () => {
		expect(canonicalPrimeImportOsPath("/tmp/import", "darwin")).toBe("/private/tmp/import");
		expect(canonicalPrimeImportOsPath("/var/import", "darwin")).toBe("/private/var/import");
		expect(canonicalPrimeImportOsPath("/tmp/import", "linux")).toBe("/tmp/import");
		expect(canonicalPrimeImportOsPath("/var/import", "linux")).toBe("/var/import");
	});

	it("persists fresh session IDs, CAS image bytes, title, destination cwd, and provenance manifest", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-"));
		const fixture = await sourceFile(root, "sessions/current/root.jsonl", "source-bytes");
		const paths = await destination(root);
		const parsed = session(fixture.file.sourceRef, "prime-root", fixture.file.sha256, fixture.cwd);
		const report = await applyPrimeSessions(input(parsed, fixture), paths);

		expect(report.partialApply, JSON.stringify(report, null, 2)).toBe(false);
		expect(report.items).toEqual([expect.objectContaining({ outcome: "imported", kind: "sessions" })]);
		expect(report.rollbackManifest?.source).toMatchObject({
			sourceRoot: fixture.sourceRoot,
			sessionRoot: fixture.sessionRoot,
		});
		const importedPath = report.items[0]?.destinationRef;
		expect(importedPath).toBeString();
		const reopened = await SessionManager.open(importedPath!, paths.sessionDir);
		expect(reopened.getSessionId()).not.toBe("prime-root");
		expect(reopened.getCwd()).toBe(fixture.cwd);
		expect(reopened.getSessionName()).toBe("Imported title");
		expect(reopened.getEntries().length).toBeGreaterThanOrEqual(3);
		const provenance = reopened
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === "prime_session_import");
		expect(provenance).toMatchObject({
			data: {
				sourceRef: fixture.file.sourceRef,
				sourcePath: fixture.file.canonicalPath,
				sourceSha256: fixture.file.sha256,
				snapshotId: "snapshot-1",
				sourceRoot: fixture.sourceRoot,
				sessionRoot: fixture.sessionRoot,
				sourceCwd: fixture.cwd,
				destinationCwd: paths.destinationCwd,
				child: false,
			},
		});
		expect(JSON.stringify(reopened.getEntries())).toContain("blob:sha256:");
		expect(await fs.readdir(paths.blobDir)).toContain(digest(Buffer.from("image-bytes")));
	});

	it("revalidates the physical source and performs no destination writes after drift", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-loss-"));
		const fixture = await sourceFile(root, "sessions/current/corrupt.jsonl", "original");
		const paths = await destination(root);
		const parsed = session(fixture.file.sourceRef, "prime-corrupt", fixture.file.sha256, fixture.cwd);
		await fs.writeFile(
			fixture.file.canonicalPath,
			`${JSON.stringify({ type: "session", version: 3, id: "corrupt", timestamp: "2026-01-01T00:00:00.000Z", cwd: fixture.cwd })}\n{} `,
		);
		const report = await applyPrimeSessions(input(parsed, fixture), paths);

		expect(report.items[0]?.outcome).toBe("lost");
		expect(report.losses).toEqual(expect.arrayContaining([expect.objectContaining({ code: "source-drift" })]));
		expect(await fs.stat(paths.sessionDir).catch(() => undefined)).toBeUndefined();
		expect(await fs.stat(paths.blobDir).catch(() => undefined)).toBeUndefined();
	});

	it("is repeat-safe and serializes concurrent reruns", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-repeat-"));
		const fixture = await sourceFile(root, "sessions/current/repeat.jsonl", "source-bytes");
		const paths = await destination(root);
		const parsed = session(fixture.file.sourceRef, "prime-repeat", fixture.file.sha256, fixture.cwd);
		const [first, second] = await Promise.all([
			applyPrimeSessions(input(parsed, fixture), paths),
			applyPrimeSessions(input(parsed, fixture), paths),
		]);
		const outcomes = [first, second].map(report => report.items[0]?.outcome).sort();
		expect(outcomes).toEqual(["imported", "skipped"]);
		expect(first.partialApply).toBe(false);
		expect(second.partialApply).toBe(false);
	});
	it("does not report skipped success when a provenance-bearing destination transcript is truncated", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-destination-drift-"));
		const fixture = await sourceFile(root, "sessions/current/destination-drift.jsonl", "source-bytes");
		const paths = await destination(root);
		const parsed = session(fixture.file.sourceRef, "prime-destination-drift", fixture.file.sha256, fixture.cwd);
		const first = await applyPrimeSessions(input(parsed, fixture), paths);
		expect(first.items[0]?.outcome).toBe("imported");
		const importedPath = first.items[0]?.destinationRef;
		if (!importedPath) throw new Error("First import did not return a destination path");
		const lines = (await fs.readFile(importedPath, "utf8")).trimEnd().split("\n"),
			provenanceIndex = lines.findIndex(line => line.includes('"customType":"prime_session_import"'));
		if (provenanceIndex < 1) throw new Error("First import did not persist provenance");
		await fs.writeFile(importedPath, `${lines[0]}\n${lines[provenanceIndex]}\n`, { mode: 0o600 });

		const second = await applyPrimeSessions(input(parsed, fixture), paths);
		expect(second.items[0]?.outcome).not.toBe("skipped");
		if (second.items[0]?.outcome === "lost")
			expect(second.losses.some(value => value.domain === "sessions" && value.code.startsWith("destination-"))).toBe(
				true,
			);
	});

	it("preserves malformed and headerless destination JSONL during duplicate scans", async () => {
		const cases = [
			["malformed", Buffer.from('{"type":"session","id":"broken"}\nnot-json\n')],
			[
				"headerless",
				Buffer.from(
					`${JSON.stringify({
						type: "custom",
						id: "headerless",
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						customType: "prime_session_import",
						data: { sourceRef: "unrelated", sourceSha256: "unrelated" },
					})}\n`,
				),
			],
		] as const;
		for (const [kind, bytes] of cases) {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-prime-session-${kind}-existing-`));
			const fixture = await sourceFile(root, `sessions/current/${kind}.jsonl`, `source-${kind}`);
			const paths = await destination(root);
			await fs.mkdir(paths.sessionDir, { recursive: true });
			const existingPath = path.join(paths.sessionDir, `000-${kind}.jsonl`);
			await fs.writeFile(existingPath, bytes, { mode: 0o600 });
			const before = await fs.readFile(existingPath);
			const report = await applyPrimeSessions(
				input(session(fixture.file.sourceRef, `prime-${kind}`, fixture.file.sha256, fixture.cwd), fixture),
				paths,
			);

			expect(report.items[0]?.outcome).toBe("imported");
			expect(await fs.readFile(existingPath)).toEqual(before);
		}
	});
	it("fails closed when destination duplicate scans exceed the snapshot byte budget", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-scan-budget-"));
		const fixture = await sourceFile(root, "sessions/current/scan-budget.jsonl", "source-bytes");
		const paths = await destination(root);
		const parsed = session(fixture.file.sourceRef, "prime-scan-budget", fixture.file.sha256, fixture.cwd);
		const boundedInput = input(parsed, fixture);
		const boundedSnapshot: PrimeSessionApplyInput["snapshot"] = {
			...boundedInput.snapshot,
			maxTotalBytes: fixture.file.size,
		};
		const destinationHeader = (id: string): Buffer =>
			Buffer.from(
				`${JSON.stringify({
					type: "session",
					version: 3,
					id,
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: fixture.cwd,
				})}\n`,
			);
		await fs.mkdir(paths.sessionDir, { recursive: true });
		const existingPaths = [0, 1].map(index => path.join(paths.sessionDir, `00${index}-unrelated.jsonl`));
		for (const [index, existingPath] of existingPaths.entries())
			await fs.writeFile(existingPath, destinationHeader(`existing-${index}`), { mode: 0o600 });
		const before = await Promise.all(existingPaths.map(existingPath => fs.readFile(existingPath)));
		const manifestPath = path.join(paths.sessionDir, ".prime-rollback-snapshot-1.json");

		const report = await applyPrimeSessions({ ...boundedInput, snapshot: boundedSnapshot }, paths);

		expect(report.partialApply).toBe(false);
		expect(report.items).toEqual([
			expect.objectContaining({
				itemId: "session:prime-scan-budget",
				outcome: "lost",
				lossCodes: ["destination-apply-failed"],
			}),
		]);
		expect(report.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "destination-apply-failed", domain: "sessions" })]),
		);
		expect(await Promise.all(existingPaths.map(existingPath => fs.readFile(existingPath)))).toEqual(before);
		expect(await fs.stat(paths.blobDir).catch(() => undefined)).toBeUndefined();
		expect(await fs.stat(manifestPath).catch(() => undefined)).toBeUndefined();
	});
	it("counts every destination entry against the exact streaming entry budget", async () => {
		const cases = [
			{ label: "two-jsonl", names: ["000-one.jsonl", "001-two.jsonl"], directory: false },
			{ label: "non-jsonl-entry", names: ["000-not-jsonl", "001-one.jsonl"], directory: true },
		] as const;
		for (const testCase of cases) {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-prime-session-entry-budget-${testCase.label}-`));
			const fixture = await sourceFile(root, "sessions/current/entry-budget.jsonl", "source-bytes");
			const paths = await destination(root);
			await fs.mkdir(paths.sessionDir, { recursive: true });
			const header = (id: string): Buffer =>
				Buffer.from(
					`${JSON.stringify({
						type: "session",
						version: 3,
						id,
						timestamp: "2026-01-01T00:00:00.000Z",
						cwd: fixture.cwd,
					})}\n`,
				);
			if (testCase.directory) {
				await fs.mkdir(path.join(paths.sessionDir, testCase.names[0]));
				await fs.writeFile(path.join(paths.sessionDir, testCase.names[1]), header("existing"));
			} else {
				for (const [index, name] of testCase.names.entries())
					await fs.writeFile(path.join(paths.sessionDir, name), header(`existing-${index}`));
			}
			const bounded = input(
				session(fixture.file.sourceRef, "prime-entry-budget", fixture.file.sha256, fixture.cwd),
				fixture,
			);
			const report = await applyPrimeSessions(
				{
					...bounded,
					snapshot: { ...bounded.snapshot, maxEntries: 1 },
				},
				paths,
			);
			expect(report.partialApply).toBe(false);
			expect(report.items).toEqual([
				expect.objectContaining({
					itemId: "session:prime-entry-budget",
					outcome: "lost",
					lossCodes: ["destination-invalid"],
				}),
			]);
			expect(report.losses).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "destination-invalid", domain: "sessions" })]),
			);
			expect((await fs.readdir(paths.sessionDir)).sort()).toEqual([...testCase.names].sort());
			expect(await fs.stat(paths.blobDir).catch(() => undefined)).toBeUndefined();
			expect(
				await fs.stat(path.join(paths.sessionDir, ".prime-rollback-snapshot-1.json")).catch(() => undefined),
			).toBeUndefined();
		}
	});
	it("bounds directory enumeration in latestManifestPath for maxEntries+1 hostile unrelated names before mutation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-manifest-hostile-entries-"));
		const fixture = await sourceFile(root, "sessions/current/hostile-manifest.jsonl", "source-bytes");
		const paths = await destination(root);
		await fs.mkdir(paths.sessionDir, { recursive: true });
		const maxEntries = 5;
		const hostileNames = Array.from({ length: maxEntries + 1 }, (_, index) => `unrelated-file-${index}.txt`);
		for (const name of hostileNames) {
			await fs.writeFile(path.join(paths.sessionDir, name), "unrelated content", { mode: 0o600 });
		}
		const bounded = input(
			session(fixture.file.sourceRef, "prime-hostile-manifest", fixture.file.sha256, fixture.cwd),
			fixture,
		);
		const report = await applyPrimeSessions(
			{
				...bounded,
				snapshot: { ...bounded.snapshot, maxEntries },
			},
			paths,
		);
		expect(report.partialApply).toBe(false);
		expect(report.items).toEqual([
			expect.objectContaining({
				itemId: "session:prime-hostile-manifest",
				outcome: "lost",
				lossCodes: ["destination-invalid"],
			}),
		]);
		expect(report.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "destination-invalid", domain: "sessions" })]),
		);
		expect(await fs.stat(paths.blobDir).catch(() => undefined)).toBeUndefined();
		expect((await fs.readdir(paths.sessionDir)).sort()).toEqual(hostileNames.sort());
	});
	it.skipIf(process.platform === "win32")(
		"does not block duplicate scans on a destination FIFO",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-fifo-scan-"));
			const fixture = await sourceFile(root, "sessions/current/fifo-scan.jsonl", "source-bytes");
			const paths = await destination(root);
			await fs.mkdir(paths.sessionDir, { recursive: true });
			const fifo = path.join(paths.sessionDir, "000-destination-fifo");
			const created = Bun.spawnSync(["mkfifo", fifo]);
			expect(created.exitCode).toBe(0);

			const report = await applyPrimeSessions(
				input(session(fixture.file.sourceRef, "prime-fifo-scan", fixture.file.sha256, fixture.cwd), fixture),
				paths,
			);
			expect(report.items[0]?.outcome).toBe("imported");
		},
		{ timeout: 1_000 },
	);

	it("fails closed when a mismatched image display sidecar exists without its canonical blob", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-display-sidecar-"));
		const fixture = await sourceFile(root, "sessions/current/display-sidecar.jsonl", "source-bytes");
		const paths = await destination(root);
		await fs.mkdir(paths.blobDir, { recursive: true });
		const hash = digest(Buffer.from("image-bytes"));
		const display = path.join(paths.blobDir, `${hash}.png`);
		const mismatched = Buffer.from("not-the-canonical-image");
		await fs.writeFile(display, mismatched, { mode: 0o600 });

		const report = await applyPrimeSessions(
			input(session(fixture.file.sourceRef, "prime-display-sidecar", fixture.file.sha256, fixture.cwd), fixture),
			paths,
		);

		expect(report.partialApply).toBe(false);
		expect(report.items).toEqual([
			expect.objectContaining({
				itemId: "session:prime-display-sidecar",
				outcome: "lost",
				lossCodes: ["destination-apply-failed"],
			}),
		]);
		expect(report.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "destination-apply-failed", domain: "artifacts" })]),
		);
		expect(await fs.stat(path.join(paths.blobDir, hash)).catch(() => undefined)).toBeUndefined();
		expect(await fs.readFile(display)).toEqual(mismatched);
		expect(
			await fs.stat(path.join(paths.sessionDir, ".prime-rollback-snapshot-1.json")).catch(() => undefined),
		).toBeUndefined();
	});

	it("rejects a blob symlink without touching its target", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-symlink-"));
		const fixture = await sourceFile(root, "sessions/current/symlink.jsonl", "source-bytes");
		const paths = await destination(root);
		await fs.mkdir(paths.blobDir, { recursive: true });
		const target = path.join(root, "outside");
		await fs.writeFile(target, "safe");
		const hash = digest(Buffer.from("image-bytes"));
		await fs.symlink(target, path.join(paths.blobDir, hash));
		const report = await applyPrimeSessions(
			input(session(fixture.file.sourceRef, "prime-symlink", fixture.file.sha256, fixture.cwd), fixture),
			paths,
		);
		expect(report.items[0]?.outcome).toBe("lost");
		expect(await fs.readFile(target, "utf8")).toBe("safe");
	});

	it("writes an initial rollback manifest even when no session is planned", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-manifest-"));
		const fixture = await sourceFile(root, "sessions/current/empty.jsonl", "source-bytes");
		const paths = await destination(root);
		const guarded = path.join(paths.sessionDir, "prior.jsonl");
		await fs.mkdir(paths.sessionDir, { recursive: true });
		await fs.writeFile(guarded, "prior");
		const entry: PrimeRollbackManifestEntry = {
			itemId: "prior",
			kind: "sessions",
			destinationRef: guarded,
			created: false,
			priorExists: true,
			priorSha256: digest(Buffer.from("prior")),
			preconditionSha256: digest(Buffer.from("prior")),
			currentSha256: digest(Buffer.from("prior")),
			nodeType: "regular-file",
		};
		const logicalEntry: PrimeRollbackManifestEntry = {
			itemId: "setting:theme",
			kind: "settings",
			destinationRef: "setting:theme",
			created: false,
			priorExists: true,
			currentSha256: digest(Buffer.from("theme")),
			nodeType: "regular-file",
		};
		const report = await applyPrimeSessions(
			{
				...input(session(fixture.file.sourceRef, "unused", fixture.file.sha256, fixture.cwd), fixture),
				sessions: [],
			},
			{
				...paths,
				initialRollbackEntries: [entry, logicalEntry],
				validateDestinationRollbackEntry: async () => true,
			},
		);
		expect(report.items).toEqual([]);
		expect(report.rollbackManifest?.entries).toEqual([entry, logicalEntry]);
	});

	it("rejects logical rollback entries without a live validator", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-validator-"));
		const fixture = await sourceFile(root, "sessions/current/empty.jsonl", "source-bytes");
		const paths = await destination(root);
		const entry: PrimeRollbackManifestEntry = {
			itemId: "setting:theme",
			kind: "settings",
			destinationRef: "setting:theme",
			created: false,
			priorExists: true,
			currentSha256: digest(Buffer.from("theme")),
			nodeType: "regular-file",
		};
		const report = await applyPrimeSessions(
			{
				...input(session(fixture.file.sourceRef, "unused", fixture.file.sha256, fixture.cwd), fixture),
				sessions: [],
			},
			{ ...paths, initialRollbackEntries: [entry] },
		);
		expect(report.rollbackManifest).toBeUndefined();
		expect(report.partialApply).toBe(true);
		expect(report.losses).toEqual(expect.arrayContaining([expect.objectContaining({ code: "destination-invalid" })]));
	});

	it("rethrows unknown validator failures", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-validator-error-"));
		const fixture = await sourceFile(root, "sessions/current/error.jsonl", "source-bytes");
		const paths = await destination(root);
		const entry: PrimeRollbackManifestEntry = {
			itemId: "setting:theme",
			kind: "settings",
			destinationRef: "setting:theme",
			created: false,
			priorExists: true,
			currentSha256: digest(Buffer.from("theme")),
			nodeType: "regular-file",
		};
		await expect(
			applyPrimeSessions(
				{
					...input(session(fixture.file.sourceRef, "error", fixture.file.sha256, fixture.cwd), fixture),
					sessions: [],
				},
				{
					...paths,
					initialRollbackEntries: [entry],
					validateDestinationRollbackEntry: async () => {
						throw new Error("validator fault");
					},
				},
			),
		).rejects.toThrow("validator fault");
	});
	it("does not orphan a session when post-persist digest capture fails operationally", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-post-persist-digest-"));
		const fixture = await sourceFile(root, "sessions/current/post-persist-digest.jsonl", "source-bytes");
		const paths = await destination(root);
		const original = SessionManager.prototype.getSessionFile;
		let calls = 0;
		SessionManager.prototype.getSessionFile = function () {
			calls += 1;
			if (calls === 2) throw Object.assign(new Error("post-persist digest capture fault"), { code: "EIO" });
			return original.call(this);
		};
		let report: PrimeSessionApplyReport | undefined;
		try {
			report = await applyPrimeSessions(
				input(
					session(fixture.file.sourceRef, "prime-post-persist-digest", fixture.file.sha256, fixture.cwd),
					fixture,
				),
				paths,
			);
		} finally {
			SessionManager.prototype.getSessionFile = original;
		}
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(report).toBeDefined();
		const applied = report!;
		expect(applied.items).toEqual([
			expect.objectContaining({
				itemId: "session:prime-post-persist-digest",
				outcome: "lost",
				lossCodes: ["destination-apply-failed"],
			}),
		]);
		expect(applied.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "destination-apply-failed", domain: "sessions" })]),
		);
		expect((await fs.readdir(paths.sessionDir).catch(() => [])).filter(name => name.endsWith(".jsonl"))).toEqual([]);
		if (applied.partialApply) {
			expect(applied.rollbackManifest).toBeDefined();
			expect(applied.rollbackManifest?.entries.length).toBeGreaterThan(0);
		}
	});
	it("returns a terminal loss and rolls back when the manifest races to malformed under the apply lock", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-manifest-race-"));
		const fixture = await sourceFile(root, "sessions/current/manifest-race.jsonl", "source-bytes");
		const paths = await destination(root);
		const manifestPath = path.join(paths.sessionDir, ".prime-rollback-snapshot-1.json");
		const logicalEntry: PrimeRollbackManifestEntry = {
			itemId: "setting:theme",
			kind: "settings",
			destinationRef: "setting:theme",
			created: false,
			priorExists: true,
			currentSha256: digest(Buffer.from("theme")),
			nodeType: "regular-file",
		};
		const seeded = await applyPrimeSessions(
			{
				...input(session(fixture.file.sourceRef, "unused", fixture.file.sha256, fixture.cwd), fixture),
				sessions: [],
			},
			{
				...paths,
				initialRollbackEntries: [logicalEntry],
				validateDestinationRollbackEntry: async () => true,
			},
		);
		expect(seeded.rollbackManifest?.entries).toEqual([logicalEntry]);
		expect(JSON.parse(await fs.readFile(manifestPath, "utf8")).entries).toEqual([logicalEntry]);

		let validations = 0;
		const report = await applyPrimeSessions(
			input(session(fixture.file.sourceRef, "prime-manifest-race", fixture.file.sha256, fixture.cwd), fixture),
			{
				...paths,
				validateDestinationRollbackEntry: async () => {
					validations += 1;
					if (validations === 2) await fs.writeFile(manifestPath, '{"schemaVersion":1}\n', { mode: 0o600 });
					return true;
				},
			},
		);

		expect(validations).toBeGreaterThanOrEqual(2);
		expect(report.partialApply).toBe(false);
		expect(report.items).toEqual([
			expect.objectContaining({
				itemId: "session:prime-manifest-race",
				outcome: "lost",
				lossCodes: ["destination-apply-failed"],
			}),
		]);
		expect(report.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "destination-apply-failed", domain: "sessions" })]),
		);
		expect((await fs.readdir(paths.sessionDir)).filter(name => name.endsWith(".jsonl"))).toEqual([]);
		expect(await fs.readdir(paths.blobDir).catch(() => [])).toEqual([]);
	});
	it("returns a normal lost report when a CAS race installs a valid manifest with a malformed entry", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-manifest-entry-race-"));
		const fixture = await sourceFile(root, "sessions/current/manifest-entry-race.jsonl", "source-bytes");
		const paths = await destination(root);
		const manifestPath = path.join(paths.sessionDir, ".prime-rollback-snapshot-1.json");
		const logicalEntry: PrimeRollbackManifestEntry = {
			itemId: "setting:theme",
			kind: "settings",
			destinationRef: "setting:theme",
			created: false,
			priorExists: true,
			currentSha256: digest(Buffer.from("theme")),
			nodeType: "regular-file",
		};
		const seeded = await applyPrimeSessions(
			{
				...input(session(fixture.file.sourceRef, "unused", fixture.file.sha256, fixture.cwd), fixture),
				sessions: [],
			},
			{ ...paths, initialRollbackEntries: [logicalEntry], validateDestinationRollbackEntry: async () => true },
		);
		expect(seeded.rollbackManifest?.entries).toEqual([logicalEntry]);

		let validations = 0;
		const report = await applyPrimeSessions(
			input(session(fixture.file.sourceRef, "prime-manifest-entry-race", fixture.file.sha256, fixture.cwd), fixture),
			{
				...paths,
				validateDestinationRollbackEntry: async () => {
					validations += 1;
					if (validations === 6) {
						await fs.writeFile(
							manifestPath,
							JSON.stringify({
								schemaVersion: 1,
								snapshotId: "snapshot-1",
								source: { sourceRoot: fixture.sourceRoot, sessionRoot: fixture.sessionRoot, cwd: fixture.cwd },
								destination: {
									cwd: paths.destinationCwd,
									sessionDir: paths.sessionDir,
									blobDir: paths.blobDir,
								},
								entries: [{ kind: "sessions", destinationRef: 1 }],
							}),
							{ mode: 0o600 },
						);
					}
					return true;
				},
			},
		);
		expect(validations).toBeGreaterThanOrEqual(6);
		expect(report.partialApply).toBe(false);
		expect(report.items).toEqual([
			expect.objectContaining({
				itemId: "session:prime-manifest-entry-race",
				outcome: "lost",
				lossCodes: ["destination-apply-failed"],
			}),
		]);
		expect(report.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "destination-apply-failed", domain: "sessions" })]),
		);
		expect((await fs.readdir(paths.sessionDir)).filter(name => name.endsWith(".jsonl"))).toEqual([]);
		expect(await fs.readdir(paths.blobDir).catch(() => [])).toEqual([]);
	});

	it("reports partial apply and retained recovery when final-manifest rollback cleanup fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-final-manifest-cleanup-"));
		const fixture = await sourceFile(root, "sessions/current/final-manifest-cleanup.jsonl", "source-bytes");
		const paths = await destination(root);
		const manifestPath = path.join(paths.sessionDir, ".prime-rollback-snapshot-1.json");
		const logicalEntry: PrimeRollbackManifestEntry = {
			itemId: "setting:theme",
			kind: "settings",
			destinationRef: "setting:theme",
			created: false,
			priorExists: true,
			currentSha256: digest(Buffer.from("theme")),
			nodeType: "regular-file",
		};
		const seeded = await applyPrimeSessions(
			{
				...input(session(fixture.file.sourceRef, "unused", fixture.file.sha256, fixture.cwd), fixture),
				sessions: [],
			},
			{ ...paths, initialRollbackEntries: [logicalEntry], validateDestinationRollbackEntry: async () => true },
		);
		expect(seeded.rollbackManifest?.entries).toEqual([logicalEntry]);

		const cleanupError = Object.assign(new Error("final-manifest cleanup failed"), { code: "EACCES" });
		const originalLink = fs.link;
		const originalUnlink = fs.unlink;
		const canonicalSessionDir = await fs.realpath(paths.sessionDir);
		let finalManifestWriteFailed = false;
		const linkSpy = vi.spyOn(fs, "link").mockImplementation((async (...args: Parameters<typeof fs.link>) => {
			const candidate = path.resolve(String(args[1]));
			if (
				!finalManifestWriteFailed &&
				candidate.startsWith(`${path.resolve(paths.sessionDir)}${path.sep}`) &&
				path.basename(candidate).startsWith(`.${path.basename(manifestPath)}.generation-`)
			) {
				finalManifestWriteFailed = true;
				throw Object.assign(new Error("final manifest write failed"), { code: "EIO" });
			}
			return originalLink(...args);
		}) as typeof fs.link);
		const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation((async (...args: Parameters<typeof fs.unlink>) => {
			const candidate = path.resolve(String(args[0]));
			if (
				finalManifestWriteFailed &&
				candidate.startsWith(`${canonicalSessionDir}${path.sep}`) &&
				candidate.includes(".jsonl.cleanup-")
			)
				throw cleanupError;
			return originalUnlink(...args);
		}) as typeof fs.unlink);

		let report: PrimeSessionApplyReport | undefined;
		try {
			report = await applyPrimeSessions(
				input(
					session(fixture.file.sourceRef, "prime-final-manifest-cleanup", fixture.file.sha256, fixture.cwd),
					fixture,
				),
				{ ...paths, validateDestinationRollbackEntry: async () => true },
			);
		} finally {
			linkSpy.mockRestore();
			unlinkSpy.mockRestore();
		}

		expect(report).toBeDefined();
		const applied = report!;
		expect(finalManifestWriteFailed).toBe(true);
		expect(applied.partialApply).toBe(true);
		expect(applied.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "destination-apply-failed", domain: "sessions" }),
				expect.objectContaining({ code: "destination-cleanup-failed", domain: "sessions" }),
			]),
		);
		expect(applied.rollbackManifest?.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ itemId: "session:prime-final-manifest-cleanup", created: true }),
			]),
		);
	});
	it("retains published blobs when final manifest publication and blob cleanup both fail", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-blob-cleanup-"));
		const fixture = await sourceFile(root, "sessions/current/blob-cleanup.jsonl", "source-bytes");
		const paths = await destination(root);
		const manifestPath = path.join(paths.sessionDir, ".prime-rollback-snapshot-1.json");
		const logicalEntry: PrimeRollbackManifestEntry = {
			itemId: "setting:theme",
			kind: "settings",
			destinationRef: "setting:theme",
			created: false,
			priorExists: true,
			currentSha256: digest(Buffer.from("theme")),
			nodeType: "regular-file",
		};
		await applyPrimeSessions(
			{
				...input(session(fixture.file.sourceRef, "unused", fixture.file.sha256, fixture.cwd), fixture),
				sessions: [],
			},
			{ ...paths, initialRollbackEntries: [logicalEntry], validateDestinationRollbackEntry: async () => true },
		);
		const originalLink = fs.link;
		const originalUnlink = fs.unlink;
		const canonicalBlobDir = path.join(await fs.realpath(path.dirname(paths.blobDir)), path.basename(paths.blobDir));
		let finalManifestWriteFailed = false;
		const linkSpy = vi.spyOn(fs, "link").mockImplementation((async (...args: Parameters<typeof fs.link>) => {
			const candidate = path.resolve(String(args[1]));
			if (
				!finalManifestWriteFailed &&
				path.basename(candidate).startsWith(`.${path.basename(manifestPath)}.generation-`)
			) {
				finalManifestWriteFailed = true;
				throw Object.assign(new Error("final manifest write failed"), { code: "EIO" });
			}
			return originalLink(...args);
		}) as typeof fs.link);
		const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation((async (...args: Parameters<typeof fs.unlink>) => {
			const candidate = path.resolve(String(args[0]));
			if (finalManifestWriteFailed && candidate.startsWith(`${canonicalBlobDir}${path.sep}`))
				throw Object.assign(new Error("blob cleanup failed"), { code: "EACCES" });
			return originalUnlink(...args);
		}) as typeof fs.unlink);
		let report: PrimeSessionApplyReport | undefined;
		try {
			report = await applyPrimeSessions(
				input(session(fixture.file.sourceRef, "prime-blob-cleanup", fixture.file.sha256, fixture.cwd), fixture),
				{ ...paths, validateDestinationRollbackEntry: async () => true },
			);
		} finally {
			linkSpy.mockRestore();
			unlinkSpy.mockRestore();
		}
		expect(report?.partialApply).toBe(true);
		expect(report?.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "destination-cleanup-failed", domain: "artifacts" })]),
		);
		expect(report?.rollbackManifest?.entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "artifacts", created: true })]),
		);
	});
	it("preserves an unrelated session created after the pre-persist snapshot when import fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-concurrent-unrelated-"));
		const fixture = await sourceFile(root, "sessions/current/concurrent-unrelated.jsonl", "source-bytes");
		const paths = await destination(root);
		const unrelatedPath = path.join(paths.sessionDir, "unrelated-concurrent.jsonl");
		const unrelatedBytes = Buffer.from("unrelated session created concurrently\n");
		const originalAppend = SessionManager.prototype.appendCustomEntry;
		SessionManager.prototype.appendCustomEntry = function (customType: string, data?: unknown) {
			if (customType === "prime_session_import" && this.getSessionFile()) {
				fsSync.writeFileSync(unrelatedPath, unrelatedBytes, { mode: 0o600 });
				throw Object.assign(new Error("concurrent import failure"), { code: "EIO" });
			}
			return originalAppend.call(this, customType, data);
		};
		let report: PrimeSessionApplyReport | undefined;
		try {
			report = await applyPrimeSessions(
				input(
					session(fixture.file.sourceRef, "prime-concurrent-unrelated", fixture.file.sha256, fixture.cwd),
					fixture,
				),
				paths,
			);
		} finally {
			SessionManager.prototype.appendCustomEntry = originalAppend;
		}
		expect(report).toBeDefined();
		expect(report!.items).toEqual([
			expect.objectContaining({
				itemId: "session:prime-concurrent-unrelated",
				outcome: "lost",
				lossCodes: ["destination-apply-failed"],
			}),
		]);
		expect(await fs.readFile(unrelatedPath)).toEqual(unrelatedBytes);
	});
	it("removes the exact persisted inode when provenance append fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-post-persist-"));
		const paths = await destination(root);
		await fs.mkdir(paths.sessionDir, { recursive: true });
		const converted = SessionManager.inMemory(paths.destinationCwd);
		const original = SessionManager.prototype.appendCustomEntry;
		SessionManager.prototype.appendCustomEntry = function (customType: string, data?: unknown) {
			if (customType === "foreign_session_import") throw new Error("provenance fault");
			return original.call(this, customType, data);
		};
		try {
			await expect(
				persistConvertedSession(
					converted,
					{
						source: "claude",
						sourceId: "fault",
						sourcePath: "/source/session.jsonl",
						sourceCwd: paths.destinationCwd,
					},
					{ sessionDir: paths.sessionDir, suppressBreadcrumb: true },
				),
			).rejects.toThrow("provenance fault");
		} finally {
			SessionManager.prototype.appendCustomEntry = original;
		}
		expect((await fs.readdir(paths.sessionDir)).filter(name => name.endsWith(".jsonl"))).toEqual([]);
	});
	it("uses create-only session publication instead of generic overwrite persistence", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-create-only-"));
		const paths = await destination(root);
		const converted = SessionManager.inMemory(paths.destinationCwd);
		const original = SessionManager.prototype.persistCopy;
		SessionManager.prototype.persistCopy = async () => {
			throw new Error("generic overwrite-capable persistence was used");
		};
		try {
			await expect(
				persistConvertedSession(
					converted,
					{
						source: "claude",
						sourceId: "create-only",
						sourcePath: "/source/session.jsonl",
						sourceCwd: paths.destinationCwd,
					},
					{ sessionDir: paths.sessionDir, suppressBreadcrumb: true },
				),
			).resolves.toBeDefined();
		} finally {
			SessionManager.prototype.persistCopy = original;
		}
	});
	it("rejects an invalid destination before creating blobs", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-destination-"));
		const fixture = await sourceFile(root, "sessions/current/invalid.jsonl", "source-bytes");
		const paths = await destination(root);
		const outside = path.join(root, "outside");
		await fs.mkdir(outside);
		await fs.symlink(outside, paths.sessionDir);
		const report = await applyPrimeSessions(
			input(session(fixture.file.sourceRef, "prime-invalid", fixture.file.sha256, fixture.cwd), fixture),
			paths,
		);
		expect(report.items[0]?.outcome).toBe("lost");
		expect(report.items[0]?.lossCodes).toEqual(["destination-invalid"]);
		expect(await fs.readdir(outside)).toEqual([]);
		expect(await fs.stat(paths.blobDir).catch(() => undefined)).toBeUndefined();
	});

	it("rejects forged manifest entries and changed initial guards", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-forged-"));
		const fixture = await sourceFile(root, "sessions/current/forged.jsonl", "source-bytes");
		const paths = await destination(root);
		await fs.mkdir(paths.sessionDir, { recursive: true });
		const forgedPath = path.join(paths.sessionDir, "forged.jsonl");
		await fs.writeFile(forgedPath, "forged");
		const forgedDigest = digest(Buffer.from("forged"));
		const manifestPath = path.join(paths.sessionDir, ".prime-rollback-snapshot-1.json");
		await fs.writeFile(
			manifestPath,
			JSON.stringify({
				schemaVersion: 1,
				snapshotId: "snapshot-1",
				source: { sourceRoot: fixture.sourceRoot, sessionRoot: fixture.sessionRoot, cwd: fixture.cwd },
				destination: { cwd: paths.destinationCwd, sessionDir: paths.sessionDir, blobDir: paths.blobDir },
				entries: [
					{
						itemId: "session:forged",
						kind: "sessions",
						destinationRef: forgedPath,
						created: true,
						priorExists: false,
						currentSha256: forgedDigest,
						nodeType: "regular-file",
					},
				],
			}),
		);
		const report = await applyPrimeSessions(
			input(session(fixture.file.sourceRef, "prime-forged", fixture.file.sha256, fixture.cwd), fixture),
			paths,
		);
		expect(report.items[0]?.outcome).toBe("lost");
		expect(report.items[0]?.lossCodes).toEqual(["destination-invalid"]);
	});

	it("does not skip same source identity from a distinct canonical root", async () => {
		const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-root-a-"));
		const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-root-b-"));
		const fixtureA = await sourceFile(rootA, "sessions/current/same.jsonl", "same-bytes");
		const fixtureB = await sourceFile(rootB, "sessions/current/same.jsonl", "same-bytes");
		const paths = await destination(await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-roots-")));
		const first = await applyPrimeSessions(
			input(
				session(fixtureA.file.sourceRef, "same-id", fixtureA.file.sha256, fixtureA.cwd),
				fixtureA,
				[],
				"snapshot-a",
			),
			paths,
		);
		const second = await applyPrimeSessions(
			input(
				session(fixtureB.file.sourceRef, "same-id", fixtureB.file.sha256, fixtureB.cwd),
				fixtureB,
				[],
				"snapshot-b",
			),
			paths,
		);
		expect(first.items[0]?.outcome).toBe("imported");
		expect(second.items[0]?.outcome).toBe("imported");
	});

	it("skips unchanged content when only the source snapshot audit id changes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-snapshot-audit-"));
		const fixture = await sourceFile(root, "sessions/current/snapshot-audit.jsonl", "source-bytes");
		const paths = await destination(root);
		const parsed = session(fixture.file.sourceRef, "snapshot-audit", fixture.file.sha256, fixture.cwd);
		const first = await applyPrimeSessions(input(parsed, fixture, [], "snapshot-a"), paths);
		const second = await applyPrimeSessions(input(parsed, fixture, [], "snapshot-b"), paths);
		expect(first.items[0]?.outcome).toBe("imported");
		expect(second.items[0]?.outcome).toBe("skipped");
	});

	it("does not skip matching provenance when existing transcript content differs", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-content-mismatch-"));
		const fixture = await sourceFile(root, "sessions/current/content-mismatch.jsonl", "source-bytes");
		const paths = await destination(root);
		await fs.mkdir(paths.sessionDir, { recursive: true });
		const existingPath = path.join(paths.sessionDir, "000-content-mismatch.jsonl");
		await fs.writeFile(
			existingPath,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "existing",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: fixture.cwd,
				}),
				JSON.stringify({
					type: "message",
					id: "wrong-entry",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "wrong", timestamp: 1 },
				}),
				JSON.stringify({
					type: "custom",
					customType: "prime_session_import",
					id: "provenance",
					parentId: "wrong-entry",
					timestamp: "2026-01-01T00:00:02.000Z",
					data: {
						sourceRef: fixture.file.sourceRef,
						sourceSha256: fixture.file.sha256,
						sourceRoot: fixture.sourceRoot,
						sessionRoot: fixture.sessionRoot,
						sourceCwd: fixture.cwd,
					},
				}),
			].join("\n")}\n`,
			{ mode: 0o600 },
		);
		const report = await applyPrimeSessions(
			input(
				session(fixture.file.sourceRef, "content-mismatch", fixture.file.sha256, fixture.cwd),
				fixture,
				[],
				"snapshot",
			),
			paths,
		);
		expect(report.items[0]?.outcome).toBe("imported");
		expect(await fs.readFile(existingPath, "utf8")).toContain('"wrong-entry"');
	});

	it("marks parser-fatal all-lost sessions as lost instead of importing an empty transcript", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-all-lost-"));
		const fixture = await sourceFile(root, "sessions/current/all-lost.jsonl", "source-bytes");
		const paths = await destination(root);
		const parsed = session(fixture.file.sourceRef, "all-lost", fixture.file.sha256, fixture.cwd);
		const report = await applyPrimeSessions(
			input({ ...parsed, entries: [], fatalLossCodes: ["sessions-invalid-entry"] }, fixture),
			paths,
		);
		expect(report.items[0]).toEqual(
			expect.objectContaining({
				itemId: "session:all-lost",
				outcome: "lost",
				lossCodes: ["sessions-invalid-entry"],
			}),
		);
	});

	it("revalidates full-output artifacts live", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-output-"));
		const fixture = await sourceFile(root, "sessions/current/output.jsonl", "source-bytes");
		const outputRef = "artifacts/output-session/full.txt";
		const outputPath = path.join(
			path.dirname(fixture.sessionRoot),
			"session-artifacts",
			"output-session",
			"full.txt",
		);
		const outputBytes = Buffer.from("complete output");
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, outputBytes, { mode: 0o600 });
		const outputStat = await fs.stat(outputPath);
		const outputFile: PrimeSourceFile = {
			kind: "file",
			domain: "artifacts",
			sourceRef: outputRef,
			canonicalPath: await fs.realpath(outputPath),
			mode: outputStat.mode & 0o777,
			mtimeMs: outputStat.mtimeMs,
			size: outputBytes.length,
			sha256: digest(outputBytes),
			contentBase64: outputBytes.toString("base64"),
		};
		const paths = await destination(root);
		const base = session(fixture.file.sourceRef, "output-session", fixture.file.sha256, fixture.cwd);
		const baseMessageEntry = base.entries.find(entry => entry.type === "message");
		if (baseMessageEntry?.type !== "message") throw new Error("fixture message missing");
		const outputSession: PrimeNormalizedSession = {
			...base,
			entries: [
				{
					...baseMessageEntry,
					message: {
						role: "bashExecution",
						command: "run",
						output: "complete output",
						exitCode: 0,
						cancelled: false,
						truncated: true,
						fullOutputSourceRef: outputRef,
						fullOutputSha256: outputFile.sha256,
						timestamp: 1,
					},
				},
			],
		};
		await fs.writeFile(outputPath, "drifted");
		const report = await applyPrimeSessions(input(outputSession, fixture, [outputFile]), paths);
		expect(report.items[0]?.outcome).toBe("lost");
		expect(report.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "source-drift", domain: "artifacts" })]),
		);
	});

	it("preserves branch lineage and tree metadata without activating child behavior", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-tree-"));
		const fixture = await sourceFile(root, "sessions/current/tree.jsonl", "source-bytes");
		const paths = await destination(root);
		const base = session(fixture.file.sourceRef, "tree-session", fixture.file.sha256, fixture.cwd);
		const treeSession: PrimeNormalizedSession = {
			...base,
			header: {
				...base.header,
				parentSession: "inactive-parent",
				rlmDepth: 2,
				lineage: { parentSession: "inactive-parent", rlmDepth: 2, child: true },
			},
			entries: [
				...base.entries,
				{
					type: "branch_summary",
					id: "branch",
					parentId: "user",
					timestamp: "2026-01-01T00:00:02.000Z",
					fromId: "user",
					summary: "branch",
				},
				{
					type: "label",
					id: "label",
					parentId: "branch",
					timestamp: "2026-01-01T00:00:03.000Z",
					targetId: "user",
					label: "important",
				},
			],
		};
		const report = await applyPrimeSessions(input(treeSession, fixture), paths);
		expect(report.items[0]?.outcome).toBe("imported");
		const reopened = await SessionManager.open(report.items[0]!.destinationRef!, paths.sessionDir);
		expect(reopened.getEntries().some(entry => entry.type === "branch_summary")).toBe(true);
		const provenance = reopened
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === "prime_session_import");
		expect(provenance).toMatchObject({ data: { parentSession: "inactive-parent", rlmDepth: 2, child: true } });
	});

	it("marks every candidate lost exactly once when blob CAS fails before commit", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-blob-before-"));
		const fixture = await sourceFile(root, "sessions/current/one.jsonl", "source-bytes");
		const fixtureTwo = await sourceFile(root, "sessions/current/two.jsonl", "source-bytes-two");
		const paths = await destination(root);
		await fs.mkdir(paths.blobDir, { recursive: true });
		const imageHash = digest(Buffer.from("image-bytes"));
		await fs.writeFile(path.join(paths.blobDir, imageHash), "wrong");
		const first = session(fixture.file.sourceRef, "one", fixture.file.sha256, fixture.cwd);
		const second = session(fixtureTwo.file.sourceRef, "two", fixtureTwo.file.sha256, fixtureTwo.cwd);
		const report = await applyPrimeSessions(
			{ ...input(first, fixture, [fixtureTwo.file]), sessions: [first, second] },
			paths,
		);
		expect(report.partialApply).toBe(false);
		expect(report.items).toHaveLength(2);
		expect(report.items.every(item => item.outcome === "lost")).toBe(true);
		expect(new Set(report.items.map(item => item.itemId)).size).toBe(2);
	});

	it("reports a true partial apply when a later blob CAS fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-blob-after-"));
		const fixtureA = await sourceFile(root, "sessions/current/one.jsonl", "source-one");
		const fixtureB = await sourceFile(root, "sessions/current/two.jsonl", "source-two");
		const paths = await destination(root);
		const first = session(fixtureA.file.sourceRef, "one", fixtureA.file.sha256, fixtureA.cwd);
		const secondBase = session(fixtureB.file.sourceRef, "two", fixtureB.file.sha256, fixtureB.cwd);
		const secondMessageEntry = secondBase.entries.find(entry => entry.type === "message");
		if (secondMessageEntry?.type !== "message") throw new Error("fixture message missing");
		const second: PrimeNormalizedSession = {
			...secondBase,
			entries: [
				{
					...secondMessageEntry,
					message: {
						role: "user",
						content: [
							{ type: "text", text: "other" },
							{ type: "image", data: Buffer.from("other-image").toString("base64"), mimeType: "image/png" },
						],
						timestamp: 1,
					},
				},
			],
		};
		const otherHash = digest(Buffer.from("other-image"));
		await fs.mkdir(paths.blobDir, { recursive: true });
		await fs.writeFile(path.join(paths.blobDir, otherHash), "wrong");
		const report = await applyPrimeSessions(
			{ ...input(first, fixtureA, [fixtureB.file]), sessions: [first, second] },
			paths,
		);
		expect(report.partialApply).toBe(true);
		expect(report.items).toHaveLength(2);
		expect(report.items.every(item => item.outcome === "lost")).toBe(true);
		expect(new Set(report.items.map(item => item.itemId)).size).toBe(2);
		expect((await fs.readdir(paths.sessionDir).catch(() => [])).filter(name => name.endsWith(".jsonl"))).toEqual([]);
		const artifactEntry = report.rollbackManifest?.entries.find(entry => entry.kind === "artifacts" && entry.created);
		expect(artifactEntry?.currentSha256).toBe(digest(Buffer.from("image-bytes")));
	});

	it("rejects a changed initial session digest guard", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-guard-"));
		const fixture = await sourceFile(root, "sessions/current/guard.jsonl", "source-bytes");
		const paths = await destination(root);
		await fs.mkdir(paths.sessionDir, { recursive: true });
		const guarded = path.join(paths.sessionDir, "guard.jsonl");
		await fs.writeFile(guarded, "changed");
		const entry: PrimeRollbackManifestEntry = {
			itemId: "guard",
			kind: "sessions",
			destinationRef: guarded,
			created: false,
			priorExists: true,
			currentSha256: digest(Buffer.from("prior")),
			nodeType: "regular-file",
		};
		const report = await applyPrimeSessions(
			{
				...input(session(fixture.file.sourceRef, "guard", fixture.file.sha256, fixture.cwd), fixture),
				sessions: [],
			},
			{ ...paths, initialRollbackEntries: [entry] },
		);
		expect(report.rollbackManifest).toBeUndefined();
		expect(report.losses).toEqual(expect.arrayContaining([expect.objectContaining({ code: "destination-invalid" })]));
	});
	it("accepts an external sibling session root bound to the snapshot", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-external-root-"));
		const sourceRootRaw = path.join(root, "prime");
		const sessionRootRaw = path.join(root, "prime-sessions");
		const cwdRaw = path.join(root, "source-project");
		await fs.mkdir(sourceRootRaw, { recursive: true });
		await fs.mkdir(sessionRootRaw, { recursive: true });
		await fs.mkdir(cwdRaw, { recursive: true });
		const sourceRoot = await fs.realpath(sourceRootRaw);
		const sessionRoot = await fs.realpath(sessionRootRaw);
		const cwd = await fs.realpath(cwdRaw);
		const sessionPath = path.join(sessionRoot, "sibling.jsonl");
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		const bytes = Buffer.from(
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "sibling",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
			})}\n${JSON.stringify({
				type: "message",
				id: "user",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			})}`,
		);
		await fs.writeFile(sessionPath, bytes, { mode: 0o600 });
		const discovery = await discoverPrimeSource({ sourceRoot, cwd, sessionRoot });
		const file = discovery.inventory.files.find(
			candidate => candidate.sourceRef === "sessions/current/sibling.jsonl",
		);
		if (!file) throw new Error("external sibling session was not discovered");
		await fs.mkdir(path.join(root, "destination"));
		const paths = await destination(path.join(root, "destination"));
		const report = await applyPrimeSessions(
			{
				snapshot: discovery.snapshot,
				sessions: [
					{
						kind: "session",
						sourceRef: file.sourceRef,
						sourceSha256: file.sha256,
						header: {
							type: "session",
							version: 3,
							id: "sibling",
							timestamp: "2026-01-01T00:00:00.000Z",
							cwd,
							lineage: { child: false },
						},
						entries: [
							{
								type: "message",
								id: "user",
								parentId: null,
								timestamp: "2026-01-01T00:00:01.000Z",
								message: { role: "user", content: "hello", timestamp: 1 },
							},
						],
					},
				],
				sourceFiles: discovery.inventory.files,
			},
			paths,
		);
		expect(report.items[0]?.outcome).toBe("imported");
		expect(report.losses).not.toContainEqual(expect.objectContaining({ code: "source-path-escape" }));
	});

	it("allocates collision-free deterministic item IDs for raw header ID collisions", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prime-session-item-ids-"));
		const fixtureA = await sourceFile(root, "sessions/current/a.jsonl", "source-a");
		const fixtureB = await sourceFile(root, "sessions/current/b.jsonl", "source-b");
		const fixtureC = await sourceFile(root, "sessions/current/c.jsonl", "source-c");
		const paths = await destination(root);
		const first = session(fixtureA.file.sourceRef, "x", fixtureA.file.sha256, fixtureA.cwd);
		const second = session(fixtureB.file.sourceRef, "x", fixtureB.file.sha256, fixtureB.cwd);
		const literal = session(fixtureC.file.sourceRef, "x:1", fixtureC.file.sha256, fixtureC.cwd);
		const report = await applyPrimeSessions(
			{
				...input(first, fixtureA, [fixtureB.file, fixtureC.file]),
				sessions: [first, second, literal],
			},
			paths,
		);
		expect(report.items).toHaveLength(3);
		expect(report.items.every(item => item.outcome === "imported")).toBe(true);
		expect(report.items.map(item => item.itemId)).toEqual(["session:x", "session:x:1", "session:x:1:1"]);
		expect(new Set(report.items.map(item => item.itemId)).size).toBe(3);
	});
});
