import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { councilTempPath } from "@oh-my-pi/pi-coding-agent/council/durable-fs";
import { sha256CouncilContent } from "@oh-my-pi/pi-coding-agent/council/hash";
import {
	COUNCIL_RUN_STATES,
	type CouncilArtifactReference,
	type CouncilManifest,
	normalizeRecoveredCouncilManifest,
} from "@oh-my-pi/pi-coding-agent/council/state";
import {
	COUNCIL_ARTIFACT_NAME_PATTERN,
	CouncilStorage,
	type CouncilStorageDurabilityOperation,
	CouncilStorageError,
	type CouncilStorageFileSystem,
	councilArtifactFilename,
	councilArtifactUrl,
	councilPlanRoot,
} from "@oh-my-pi/pi-coding-agent/council/storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { directorySymlinkType, durableOps, symlinksSupported } from "./helpers/platform";

interface JournalEntry {
	type: string;
	data: unknown;
}

const checkpointTime = "2026-08-05T12:01:00.000Z";

function storageSession(
	root: string,
	localSessionId: string | (() => string) = "parent-session",
	managerSessionId: string | (() => string) = "parent-session",
) {
	const journal: JournalEntry[] = [];
	const session = {
		localProtocolOptions: {
			getArtifactsDir: () => root,
			getSessionId: () => (typeof localSessionId === "string" ? localSessionId : localSessionId()),
		},
		sessionManager: {
			getSessionId: () => (typeof managerSessionId === "string" ? managerSessionId : managerSessionId()),
			appendCustomEntry: (type: string, data: unknown) => {
				journal.push({ type, data });
				return `${journal.length}`;
			},
		},
	} as unknown as Pick<ToolSession, "localProtocolOptions" | "sessionManager">;
	return { session, journal };
}

function storageHarness(root: string, operations?: CouncilStorageDurabilityOperation[]) {
	const { session, journal } = storageSession(root);
	const storage = new CouncilStorage(session, {
		now: () => checkpointTime,
		onDurabilityOperation: operation => operations?.push(operation),
	});
	return { storage, journal };
}

function instructionSnapshotContent(repoRoot: string): string {
	const snapshot = { repoRoot, contextFiles: [], files: [], totalBytes: 0 };
	return `${JSON.stringify(snapshot)}\n`;
}

function instructionSnapshotReference(runId: string, repoRoot: string): CouncilManifest["instructionSnapshot"] {
	const content = instructionSnapshotContent(repoRoot);
	const artifact = {
		url: councilArtifactUrl(runId, "instructions.json"),
		sha256: sha256CouncilContent(content),
		bytes: Buffer.byteLength(content),
	};
	return { artifact, sha256: artifact.sha256 };
}

async function stageInstructions(storage: CouncilStorage, value: CouncilManifest): Promise<void> {
	const content = instructionSnapshotContent(value.repoRoot);
	const artifact = await storage.createArtifact(value.runId, "instructions.json", content);
	value.instructionSnapshot = { artifact, sha256: artifact.sha256 };
	value.adjudicator.instructionSha256 = artifact.sha256;
}

async function createRun(storage: CouncilStorage, value: CouncilManifest): Promise<CouncilManifest> {
	await stageInstructions(storage, value);
	return storage.create(value);
}

function manifest(repoRoot: string, state: CouncilManifest["state"] = "dispatching"): CouncilManifest {
	const now = "2026-08-05T12:00:00.000Z";
	const configMembers = [{ role: "council1", enabled: true, order: 0 }];
	const roster = [
		{
			role: "council1",
			enabled: true,
			order: 0,
			rounds: [1],
			advisor: false,
			requestedSelector: "openai/gpt-5",
			resolvedModel: "openai/gpt-5",
			effort: "high",
			lens: "Adversarial correctness",
		},
	];
	return {
		version: 2,
		runId: "run-1",
		sessionId: "parent-session",
		mainAgentId: "Main",
		state,
		task: "Review the implementation",
		repoRoot,
		outputPath: "council-review-the-implementation-plan.md",
		timestamps: { createdAt: now, updatedAt: now, startedAt: now },
		config: { rounds: 1, members: configMembers, advisor: { planner: false, reviewers: false, adjudicator: false } },
		roster,
		planner: {
			role: "slow",
			requestedSelector: "openai/gpt-5",
			resolvedModel: "openai/gpt-5",
			effort: "high",
			advisor: false,
		},
		adjudicator: {
			mode: "main",
			requestedSelector: "@main",
			resolvedModel: "openai/gpt-5",
			effort: "high",
			advisor: false,
			capturedAt: now,
		},
		instructionSnapshot: instructionSnapshotReference("run-1", repoRoot),
		rounds: [
			{
				round: 1,
				status: "running",
				startedAt: now,
				finishedAt: null,
				members: [
					{
						role: "council1",
						order: 0,
						status: "running",
						attempts: 1,
						startedAt: now,
						finishedAt: null,
						artifact: null,
						resolvedModel: null,
						authFallbackUsed: false,
						failureReason: null,
						findingIds: [],
					},
				],
			},
		],
		planVersions: [],
		usage: { requests: 0, tokens: 0, cost: 0 },
		adjudicationBudget: { injectedChars: 0, cap: 10_000 },
		warnings: [],
		degraded: false,
	};
}

function addSecondSettledMember(
	value: CouncilManifest,
	artifacts: [CouncilArtifactReference, CouncilArtifactReference],
): void {
	const now = value.timestamps.createdAt;
	value.config.members.push({ role: "council2", enabled: true, order: 1 });
	value.roster.push({
		role: "council2",
		enabled: true,
		order: 1,
		rounds: Array.from({ length: value.config.rounds }, (_unused, index) => index + 1),
		advisor: false,
		requestedSelector: "openai/gpt-5",
		resolvedModel: "openai/gpt-5",
		effort: "high",
		lens: "Independent verification",
	});
	value.state = "reviewing";
	const round = value.rounds[0]!;
	round.status = "settled";
	round.finishedAt = now;
	round.members = ["council1", "council2"].map((role, order) => ({
		role,
		order,
		status: "succeeded" as const,
		attempts: 1,
		startedAt: now,
		finishedAt: now,
		artifact: artifacts[order]!,
		resolvedModel: "openai/gpt-5",
		authFallbackUsed: false,
		failureReason: null,
		findingIds: [order === 0 ? "A1" : "B1"],
	}));
}

const validPlan = [
	"## Context",
	"Context.",
	"## Approach",
	"Approach.",
	"## Critical files & anchors",
	"Files.",
	"## Verification",
	"Verification.",
	"## Assumptions & contingencies",
	"Assumptions.",
].join("\n\n");

function persistedReport(id: string): string {
	const report = {
		readiness: "revise",
		findings: [
			{
				id,
				classification: "must-fix",
				severity: "high",
				confidence: "high",
				evidence: [{ path: "src/example.ts", observation: "Observed behavior." }],
				impact: "Incorrect behavior.",
				required: true,
				recommendation: "Correct the behavior.",
				rejectedAssumptions: [],
				verification: ["Exercise the corrected path."],
			},
		],
		strengths: [],
		missingContext: [],
	};
	return JSON.stringify(report);
}

function persistedPlan(marker: string, metadata: unknown, plan = validPlan): string {
	const encoded = Buffer.from(JSON.stringify(metadata)).toString("base64");
	return `${plan}\n\n<!-- ${marker}:${encoded} -->\n`;
}

function persistedAdjudication(ids: readonly string[], plan = validPlan): string {
	const adjudication = {
		plan,
		dispositions: ids.map(id => ({
			id,
			disposition: "accepted",
			reason: "The evidence is actionable.",
			step: "Apply the correction.",
		})),
	};
	return persistedPlan("council-adjudication-metadata", { adjudication }, plan);
}

async function createTwoRoundAdjudicated(
	storage: CouncilStorage,
	repoRoot: string,
	plan = validPlan,
): Promise<CouncilManifest> {
	const value = await createRun(storage, manifest(repoRoot));
	const roundOneArtifacts = await Promise.all([
		storage.writeArtifact("run-1", "council1-r1.json", persistedReport("A1")),
		storage.writeArtifact("run-1", "council2-r1.json", persistedReport("B1")),
	]);
	addSecondSettledMember(value, roundOneArtifacts);
	value.config.rounds = 2;
	for (const member of value.roster) member.rounds = [1, 2];
	const roundTwoArtifacts = await Promise.all([
		storage.writeArtifact("run-1", "council1-r2.json", persistedReport("C1")),
		storage.writeArtifact("run-1", "council2-r2.json", persistedReport("D1")),
	]);
	const now = value.timestamps.createdAt;
	value.rounds.push({
		round: 2,
		status: "settled",
		startedAt: now,
		finishedAt: now,
		members: ["council1", "council2"].map((role, order) => ({
			role,
			order,
			status: "succeeded" as const,
			attempts: 1,
			startedAt: now,
			finishedAt: now,
			artifact: roundTwoArtifacts[order]!,
			resolvedModel: "openai/gpt-5",
			authFallbackUsed: false,
			failureReason: null,
			findingIds: [order === 0 ? "C1" : "D1"],
		})),
	});
	const draft = await storage.writeArtifact(
		"run-1",
		"draft.md",
		persistedPlan(
			"council-planner-metadata",
			{
				assumptions: [],
				blockers: [],
				evidenceVersion: "1.0.0",
			},
			plan,
		),
	);
	const roundOne = await storage.writeArtifact("run-1", "round1.md", persistedAdjudication(["A1", "B1"], plan));
	const roundTwo = await storage.writeArtifact("run-1", "round2.md", persistedAdjudication(["C1", "D1"], plan));
	value.planVersions = [
		{ version: 1, round: 0, kind: "draft", artifact: draft, createdAt: now },
		{ version: 2, round: 1, kind: "round", artifact: roundOne, createdAt: now },
		{ version: 3, round: 2, kind: "final", artifact: roundTwo, createdAt: now },
	];
	value.state = "awaiting-main";
	await storage.checkpoint(value);
	return value;
}

describe("council artifact naming", () => {
	it.each([
		"instructions.json",
		"draft.md",
		"round1.md",
		"round2.md",
		"council1-r1.json",
		"council1-r2.json",
		"manifest.json",
	])("accepts %s", name => expect(COUNCIL_ARTIFACT_NAME_PATTERN.test(name)).toBeTrue());

	it.each([
		"plan.md",
		"review-plan.md",
		"round0.md",
		"round27.md",
		`round${"1".repeat(1000)}.md`,
		"Council-r1.json",
		"council-r0.json",
		"council-r3.json",
		`council-r${"1".repeat(1000)}.json`,
		"../draft.md",
	])("rejects %s", name => {
		expect(COUNCIL_ARTIFACT_NAME_PATTERN.test(name)).toBeFalse();
		expect(() => councilArtifactFilename("run-1", name)).toThrow();
	});

	it("accepts 64-character role artifacts, rejects 65, and keeps its temp decoration bounded", () => {
		const acceptedRole = `a${"1".repeat(63)}`;
		const rejectedRole = `a${"1".repeat(64)}`;
		const acceptedArtifact = `${acceptedRole}-r1.json`;
		const rejectedArtifact = `${rejectedRole}-r1.json`;

		expect(COUNCIL_ARTIFACT_NAME_PATTERN.test(acceptedArtifact)).toBeTrue();
		expect(COUNCIL_ARTIFACT_NAME_PATTERN.test(rejectedArtifact)).toBeFalse();
		const filename = councilArtifactFilename(`r${"1".repeat(127)}`, acceptedArtifact);
		expect(filename).toHaveLength(209);
		// A staged temp file adds exactly 18 characters: `.` + name + `.` + 12 hex + `.tmp`. The full
		// 36-character UUID this replaced added 42 and pushed ordinary runs past the Windows path ceiling.
		expect(councilTempPath("", filename, "00000000-0000-4000-8000-000000000000")).toHaveLength(227);
		expect(() => councilArtifactFilename("run-1", rejectedArtifact)).toThrow();
	});

	it("builds only flat, exact session-root URLs whose shipped names do not look like plans", () => {
		const urls = [
			councilArtifactUrl("run-1", "instructions.json"),
			councilArtifactUrl("run-1", "draft.md"),
			councilArtifactUrl("run-1", "round2.md"),
			councilArtifactUrl("run-1", "council1-r2.json"),
			councilArtifactUrl("run-1", "manifest.json"),
		];
		expect(urls).toEqual([
			"local://council-run-1-instructions.json",
			"local://council-run-1-draft.md",
			"local://council-run-1-round2.md",
			"local://council-run-1-council1-r2.json",
			"local://council-run-1-manifest.json",
		]);
		expect(urls.every(url => !/plan\.md$/i.test(url))).toBeTrue();
		expect(/plan\.md$/i.test("local://council-run-1-council1-r1-plan.md")).toBeTrue();
		expect(councilArtifactFilename("run-1", "draft.md")).toBe("council-run-1-draft.md");
		expect(() => councilArtifactFilename("../run", "draft.md")).toThrow();
	});
});

describe("durable council storage", () => {
	it("captures one active identity from both session sources", () => {
		using temp = TempDir.createSync("@omp-council-identity-");
		const disagreement = storageSession(temp.path(), "session-a", "session-b");
		expect(() => new CouncilStorage(disagreement.session)).toThrow("identities disagree");
		const missing = storageSession(temp.path(), "", "");
		expect(() => new CouncilStorage(missing.session)).toThrow("session identity");
	});

	it("atomically installs a create before journaling while checkpoints retain rename replacement", async () => {
		using temp = TempDir.createSync("@omp-council-order-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const operations: CouncilStorageDurabilityOperation[] = [];
		const { storage, journal } = storageHarness(temp.join("artifacts"), operations);
		const value = manifest(repoRoot);
		const created = await createRun(storage, value);

		const createSequence = durableOps("file-sync", "link", "directory-sync", "unlink", "directory-sync", "journal");
		expect(operations.slice(-createSequence.length)).toEqual(createSequence);
		expect(value.timestamps.updatedAt).toBe("2026-08-05T12:00:00.000Z");
		expect((journal[0]!.data as CouncilManifest).timestamps.updatedAt).toBe(checkpointTime);
		expect(fs.existsSync(path.join(temp.path(), "artifacts", "local", "council-run-1-manifest.json"))).toBeTrue();
		expect(fs.existsSync(path.join(temp.path(), "artifacts", "local", "council"))).toBeFalse();

		operations.length = 0;
		await storage.checkpoint(created);
		expect(operations).toEqual(durableOps("file-sync", "rename", "directory-sync", "journal"));
	});

	it("allows exactly one concurrent creator without replacing the winning manifest", async () => {
		using temp = TempDir.createSync("@omp-council-create-race-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage, journal } = storageHarness(artifactsRoot);
		const first = manifest(repoRoot);
		first.task = "first contender";
		const second = manifest(repoRoot);
		second.task = "second contender";
		await stageInstructions(storage, first);
		second.instructionSnapshot = structuredClone(first.instructionSnapshot);
		second.adjudicator.instructionSha256 = first.adjudicator.instructionSha256;

		const results = await Promise.allSettled([storage.create(first), storage.create(second)]);
		const successes = results.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));
		const failures = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		expect(successes).toHaveLength(1);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ code: "COUNCIL_RUN_EXISTS" });
		expect(journal).toHaveLength(1);

		const manifestPath = path.join(artifactsRoot, "local", "council-run-1-manifest.json");
		const installed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		expect(installed).toEqual(successes[0]);
		expect(journal[0]!.data).toEqual(installed);
		expect(fs.readdirSync(path.dirname(manifestPath)).sort()).toEqual([
			"council-run-1-instructions.json",
			"council-run-1-manifest.json",
		]);
	});

	it("checkpoints a deep snapshot and advances updatedAt itself", async () => {
		using temp = TempDir.createSync("@omp-council-storage-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const { storage, journal } = storageHarness(temp.join("artifacts"));
		const value = await createRun(storage, manifest(repoRoot));
		const member = value.rounds[0]!.members[0]!;
		value.state = "awaiting-main";
		value.degraded = true;
		value.rounds[0]!.status = "settled";
		value.rounds[0]!.finishedAt = checkpointTime;
		member.status = "failed";
		member.attempts = 2;
		member.startedAt = checkpointTime;
		member.finishedAt = checkpointTime;
		member.resolvedModel = "openai/gpt-5.1";
		member.authFallbackUsed = true;
		member.failureReason = "first attempt timed out";
		value.timestamps.updatedAt = "2026-08-05T12:00:30.000Z";
		const persisted = await storage.checkpoint(value);
		member.failureReason = "mutated after checkpoint";

		expect(journal.map(entry => entry.type)).toEqual(["council-run", "council-run"]);
		const saved = journal.at(-1)!.data as CouncilManifest;
		expect(saved.timestamps.updatedAt).toBe(checkpointTime);
		expect(persisted.timestamps.updatedAt).toBe(checkpointTime);
		expect(value.timestamps.updatedAt).toBe("2026-08-05T12:00:30.000Z");
		expect(saved.rounds[0]!.members[0]).toMatchObject({
			attempts: 2,
			resolvedModel: "openai/gpt-5.1",
			authFallbackUsed: true,
			failureReason: "first attempt timed out",
			findingIds: [],
		});
	});

	it("does not append a late durable checkpoint to a replacement session journal", async () => {
		using temp = TempDir.createSync("@omp-council-session-race-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		let managerSessionId = "parent-session";
		const { session, journal } = storageSession(artifactsRoot, "parent-session", () => managerSessionId);
		const initialStorage = new CouncilStorage(session, { now: () => checkpointTime });
		const value = await createRun(initialStorage, manifest(repoRoot));
		value.task = "late old-session checkpoint";

		const renameStarted = Promise.withResolvers<void>();
		const releaseRename = Promise.withResolvers<void>();
		const filesystem: CouncilStorageFileSystem = {
			open: fs.promises.open,
			lstat: fs.promises.lstat,
			realpath: fs.promises.realpath,
			mkdir: fs.promises.mkdir,
			link: fs.promises.link,
			rename: async (oldPath, newPath) => {
				renameStarted.resolve();
				await releaseRename.promise;
				await fs.promises.rename(oldPath, newPath);
			},
			unlink: fs.promises.unlink,
			readdir: fs.promises.readdir,
		};
		const delayedStorage = new CouncilStorage(session, { filesystem, now: () => checkpointTime });
		const checkpoint = delayedStorage.checkpoint(value);
		await renameStarted.promise;
		managerSessionId = "replacement-session";
		releaseRename.resolve();

		await expect(checkpoint).rejects.toMatchObject({ code: "COUNCIL_STORAGE_UNAVAILABLE" });
		expect(journal).toHaveLength(1);
		const persisted: unknown = JSON.parse(
			fs.readFileSync(path.join(artifactsRoot, "local", "council-run-1-manifest.json"), "utf8"),
		);
		expect(persisted).toMatchObject({ task: "late old-session checkpoint" });
	});

	it("creates a run on a filesystem that refuses hard links, and keeps a collision terminal", async () => {
		using temp = TempDir.createSync("@omp-council-no-hardlink-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		// What FAT/exFAT volumes, most SMB shares, and non-NTFS Windows targets return for CreateHardLinkW.
		const filesystem: CouncilStorageFileSystem = {
			open: fs.promises.open,
			lstat: fs.promises.lstat,
			realpath: fs.promises.realpath,
			mkdir: fs.promises.mkdir,
			link: async () => {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			},
			rename: fs.promises.rename,
			unlink: fs.promises.unlink,
			readdir: fs.promises.readdir,
		};
		const { session } = storageSession(artifactsRoot);
		const storage = new CouncilStorage(session, { filesystem, now: () => checkpointTime });
		const created = await createRun(storage, manifest(repoRoot));

		expect(created.runId).toBe("run-1");
		const manifestPath = path.join(artifactsRoot, "local", "council-run-1-manifest.json");
		expect(JSON.parse(fs.readFileSync(manifestPath, "utf8"))).toMatchObject({ runId: "run-1" });
		expect(fs.readdirSync(path.join(artifactsRoot, "local")).filter(name => name.endsWith(".tmp"))).toEqual([]);

		await expect(storage.create(manifest(repoRoot))).rejects.toMatchObject({ code: "COUNCIL_RUN_EXISTS" });
		expect(JSON.parse(fs.readFileSync(manifestPath, "utf8"))).toMatchObject({ runId: "run-1" });
	});

	it("rejects manifest identity mismatch before filesystem writes or journal entries", async () => {
		using temp = TempDir.createSync("@omp-council-manifest-identity-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifacts = temp.join("artifacts");
		const { storage, journal } = storageHarness(artifacts);
		const value = manifest(repoRoot);
		value.sessionId = "foreign-session";
		await expect(storage.create(value)).rejects.toMatchObject({ code: "COUNCIL_RECOVERY_CORRUPT" });
		expect(fs.existsSync(path.join(artifacts, "local"))).toBeFalse();
		expect(journal).toEqual([]);
	});

	it("rejects checkpoint and loaded manifest identity mismatch without appending a journal entry", async () => {
		using temp = TempDir.createSync("@omp-council-active-identity-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifacts = temp.join("artifacts");
		const { storage, journal } = storageHarness(artifacts);
		const value = await createRun(storage, manifest(repoRoot));
		const manifestPath = path.join(artifacts, "local", "council-run-1-manifest.json");
		const before = fs.readFileSync(manifestPath, "utf8");
		const mismatched = structuredClone(value);
		mismatched.sessionId = "foreign-session";
		await expect(storage.checkpoint(mismatched)).rejects.toMatchObject({ code: "COUNCIL_RECOVERY_CORRUPT" });
		expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
		expect(journal).toHaveLength(1);

		fs.writeFileSync(manifestPath, JSON.stringify(mismatched));
		await expect(storage.load("run-1")).rejects.toMatchObject({ code: "COUNCIL_RECOVERY_CORRUPT" });
		expect(journal).toHaveLength(1);
	});

	it("writes hashed artifacts, verifies them on read, and lists flat manifests", async () => {
		using temp = TempDir.createSync("@omp-council-artifacts-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const { storage } = storageHarness(temp.join("artifacts"));
		await createRun(storage, manifest(repoRoot));
		const reference = await storage.writeArtifact("run-1", "round1.md", "round one");

		expect(reference).toMatchObject({
			url: "local://council-run-1-round1.md",
			bytes: Buffer.byteLength("round one"),
		});
		expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(await storage.readArtifact(reference)).toBe("round one");
		await expect(storage.writeArtifact("run-1", "instructions.json", "replacement")).rejects.toMatchObject({
			code: "COUNCIL_ARTIFACT_INVALID",
		});
		expect(await storage.list()).toHaveLength(1);
	});

	it.each(["missing", "tampered", "malformed"] as const)(
		"blocks load when the instruction snapshot artifact is %s",
		async damage => {
			using temp = TempDir.createSync(`@omp-council-instructions-${damage}-`);
			const repoRoot = temp.join("repo");
			fs.mkdirSync(repoRoot);
			const artifactsRoot = temp.join("artifacts");
			const { storage } = storageHarness(artifactsRoot);
			const value = await createRun(storage, manifest(repoRoot));
			const instructionPath = path.join(artifactsRoot, "local", "council-run-1-instructions.json");
			if (damage === "missing") {
				fs.unlinkSync(instructionPath);
			} else if (damage === "tampered") {
				fs.writeFileSync(instructionPath, '{"tampered":true}\n');
			} else {
				const malformed = '{"tampered":true}\n';
				fs.writeFileSync(instructionPath, malformed);
				const artifact = {
					url: councilArtifactUrl("run-1", "instructions.json"),
					sha256: sha256CouncilContent(malformed),
					bytes: Buffer.byteLength(malformed),
				};
				value.instructionSnapshot = { artifact, sha256: artifact.sha256 };
				value.adjudicator.instructionSha256 = artifact.sha256;
				await storage.checkpoint(value);
			}

			await expect(storage.load("run-1")).rejects.toMatchObject({
				code: damage === "tampered" ? "COUNCIL_ARTIFACT_HASH_MISMATCH" : "COUNCIL_RECOVERY_CORRUPT",
			});
		},
	);

	it("stores a bounded instruction snapshot once without repeating its contents in manifests or journals", async () => {
		using temp = TempDir.createSync("@omp-council-instruction-size-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage, journal } = storageHarness(artifactsRoot);
		const value = manifest(repoRoot);
		const instructions = "x".repeat(400_000);
		const snapshot = {
			repoRoot,
			contextFiles: [{ path: path.join(repoRoot, "AGENTS.md"), content: instructions, depth: 0 }],
			files: [{ path: path.join(repoRoot, "AGENTS.md"), sha256: sha256CouncilContent(instructions) }],
			totalBytes: Buffer.byteLength(instructions),
		};
		const content = `${JSON.stringify(snapshot)}\n`;
		const artifact = await storage.createArtifact("run-1", "instructions.json", content);
		value.instructionSnapshot = { artifact, sha256: artifact.sha256 };
		value.adjudicator.instructionSha256 = artifact.sha256;
		await storage.create(value);

		const manifestPath = path.join(artifactsRoot, "local", "council-run-1-manifest.json");
		const instructionPath = path.join(artifactsRoot, "local", "council-run-1-instructions.json");
		expect(fs.statSync(instructionPath).size).toBeGreaterThan(400_000);
		expect(fs.statSync(manifestPath).size).toBeLessThan(10_000);
		expect(JSON.stringify(journal[0]!.data).length).toBeLessThan(10_000);
		expect(JSON.stringify(journal[0]!.data)).not.toContain(instructions.slice(0, 1024));
	});

	it("adopts a valid orphan planner draft before interrupted normalization", async () => {
		using temp = TempDir.createSync("@omp-council-orphan-draft-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const { storage } = storageHarness(temp.join("artifacts"));
		await createRun(storage, manifest(repoRoot));
		const draft = await storage.writeArtifact(
			"run-1",
			"draft.md",
			persistedPlan("council-planner-metadata", {
				assumptions: [],
				blockers: [],
				evidenceVersion: "1.0.0",
			}),
		);

		const recovered = await storage.load("run-1");
		expect(recovered.planVersions).toEqual([
			{ version: 1, round: 0, kind: "draft", artifact: draft, createdAt: checkpointTime },
		]);
		expect(recovered.state).toBe("interrupted");
	});

	it("adopts valid orphan member evidence into its durable running slot", async () => {
		using temp = TempDir.createSync("@omp-council-orphan-member-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const { storage } = storageHarness(temp.join("artifacts"));
		const value = await createRun(storage, manifest(repoRoot));
		const draft = await storage.writeArtifact(
			"run-1",
			"draft.md",
			persistedPlan("council-planner-metadata", {
				assumptions: [],
				blockers: [],
				evidenceVersion: "1.0.0",
			}),
		);
		value.planVersions.push({ version: 1, round: 0, kind: "draft", artifact: draft, createdAt: checkpointTime });
		value.rounds[0]!.members[0]!.resolvedModel = "openai/gpt-5";
		await storage.checkpoint(value);
		const report = await storage.writeArtifact("run-1", "council1-r1.json", persistedReport("A1"));

		const recovered = await storage.load("run-1");
		expect(recovered.rounds[0]).toMatchObject({
			status: "settled",
			members: [{ status: "succeeded", artifact: report, findingIds: ["A1"] }],
		});
	});

	it("adopts a valid orphan adjudication only after its round evidence is settled", async () => {
		using temp = TempDir.createSync("@omp-council-orphan-round-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const { storage } = storageHarness(temp.join("artifacts"));
		const value = await createRun(storage, manifest(repoRoot));
		const draft = await storage.writeArtifact(
			"run-1",
			"draft.md",
			persistedPlan("council-planner-metadata", {
				assumptions: [],
				blockers: [],
				evidenceVersion: "1.0.0",
			}),
		);
		const report = await storage.writeArtifact("run-1", "council1-r1.json", persistedReport("A1"));
		value.planVersions.push({ version: 1, round: 0, kind: "draft", artifact: draft, createdAt: checkpointTime });
		const round = value.rounds[0]!;
		const member = round.members[0]!;
		round.status = "settled";
		round.finishedAt = checkpointTime;
		member.status = "succeeded";
		member.finishedAt = checkpointTime;
		member.artifact = report;
		member.resolvedModel = "openai/gpt-5";
		member.findingIds = ["A1"];
		await storage.checkpoint(value);
		const final = await storage.writeArtifact("run-1", "round1.md", persistedAdjudication(["A1"]));

		const recovered = await storage.load("run-1");
		expect(recovered.planVersions).toEqual([
			value.planVersions[0],
			{ version: 2, round: 1, kind: "final", artifact: final, createdAt: checkpointTime },
		]);
	});

	it("blocks malformed deterministic orphans without deleting or adopting them", async () => {
		using temp = TempDir.createSync("@omp-council-orphan-invalid-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		await createRun(storage, manifest(repoRoot));
		await storage.writeArtifact("run-1", "draft.md", "malformed draft");

		await expect(storage.load("run-1")).rejects.toMatchObject({ code: "COUNCIL_RECOVERY_CORRUPT" });
		expect(fs.readFileSync(path.join(artifactsRoot, "local", "council-run-1-draft.md"), "utf8")).toBe(
			"malformed draft",
		);
	});

	it("does not adopt a downstream orphan before its prerequisite evidence exists", async () => {
		using temp = TempDir.createSync("@omp-council-orphan-downstream-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		await createRun(storage, manifest(repoRoot));
		await storage.writeArtifact("run-1", "round1.md", "unknown downstream output");

		const recovered = await storage.load("run-1");
		expect(recovered.planVersions).toEqual([]);
		expect(fs.readFileSync(path.join(artifactsRoot, "local", "council-run-1-round1.md"), "utf8")).toBe(
			"unknown downstream output",
		);
	});

	it.skipIf(!symlinksSupported())("rejects symlink roots and never replaces an occupied final path", async () => {
		using temp = TempDir.createSync("@omp-council-symlink-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifacts = temp.join("artifacts");
		fs.mkdirSync(artifacts);
		const outside = temp.join("outside");
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(artifacts, "local"), directorySymlinkType);
		const { storage } = storageHarness(artifacts);
		await expect(createRun(storage, manifest(repoRoot))).rejects.toThrow("local root is not a real directory");

		fs.unlinkSync(path.join(artifacts, "local"));
		fs.mkdirSync(path.join(artifacts, "local"));
		fs.symlinkSync(path.join(outside, "manifest.json"), path.join(artifacts, "local", "council-run-1-manifest.json"));
		await expect(createRun(storage, manifest(repoRoot))).rejects.toMatchObject({ code: "COUNCIL_RUN_EXISTS" });
	});

	it("normalizes every nonterminal state and active member to interrupted on load", async () => {
		using temp = TempDir.createSync("@omp-council-recovery-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const { storage } = storageHarness(temp.join("artifacts"));
		await createRun(storage, manifest(repoRoot, "reviewing"));

		const recovered = await storage.load("run-1");
		expect(recovered.state).toBe("interrupted");
		expect(recovered.rounds[0]!.status).toBe("interrupted");
		expect(recovered.rounds[0]!.members[0]!.status).toBe("interrupted");
		expect(recovered.timestamps.interruptedAt).toBeDefined();
		expect(recovered.timestamps.finishedAt).toBe(recovered.timestamps.interruptedAt!);
		expect(recovered.timestamps.updatedAt).toBe(recovered.timestamps.interruptedAt!);
		for (const state of COUNCIL_RUN_STATES) {
			const normalized = normalizeRecoveredCouncilManifest(manifest(repoRoot, state), checkpointTime);
			const terminal = ["interrupted", "failed", "completed", "completed-degraded"].includes(state);
			expect(normalized.state).toBe(terminal ? state : "interrupted");
		}
	});

	it("preserves trailing plan spaces and newlines while semantically loading planner and adjudication artifacts", async () => {
		using temp = TempDir.createSync("@omp-council-plan-framing-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const { storage } = storageHarness(temp.join("artifacts"));
		const planWithTrailingWhitespace = `${validPlan}  \n`;
		const value = await createTwoRoundAdjudicated(storage, repoRoot, planWithTrailingWhitespace);

		const recovered = await storage.load("run-1");
		expect(recovered.planVersions).toEqual(value.planVersions);
		expect(recovered.failure).toBeUndefined();
		for (const version of recovered.planVersions) {
			expect(await storage.readArtifact(version.artifact)).toStartWith(planWithTrailingWhitespace);
		}
	});

	it("reconciles one missing owned member artifact without discarding verified settled members", async () => {
		using temp = TempDir.createSync("@omp-council-member-recovery-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage, journal } = storageHarness(artifactsRoot);
		const value = await createRun(storage, manifest(repoRoot));
		const first = await storage.writeArtifact("run-1", "council1-r1.json", persistedReport("A1"));
		const second = await storage.writeArtifact("run-1", "council2-r1.json", persistedReport("B1"));
		addSecondSettledMember(value, [first, second]);
		await storage.checkpoint(value);
		fs.unlinkSync(path.join(artifactsRoot, "local", "council-run-1-council2-r1.json"));

		const recovered = await storage.load("run-1");
		expect(recovered.rounds[0]!.members[0]).toMatchObject({
			status: "succeeded",
			artifact: first,
			findingIds: ["A1"],
		});
		expect(recovered.rounds[0]!.members[1]).toMatchObject({
			status: "interrupted",
			artifact: null,
			findingIds: [],
			failureReason: expect.stringContaining("is missing"),
		});
		expect(recovered.rounds[0]!.status).toBe("interrupted");
		expect(recovered.state).toBe("interrupted");
		expect(journal.at(-1)!.data).toEqual(recovered);
	});

	it("rejects referenced draft tamper without clearing immutable evidence", async () => {
		using temp = TempDir.createSync("@omp-council-plan-recovery-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		const value = await createRun(storage, manifest(repoRoot));
		const draft = await storage.writeArtifact("run-1", "draft.md", "draft");
		value.planVersions.push({
			version: 1,
			round: 0,
			kind: "draft",
			artifact: draft,
			createdAt: value.timestamps.createdAt,
		});
		await storage.checkpoint(value);
		fs.writeFileSync(path.join(artifactsRoot, "local", "council-run-1-draft.md"), "truncated");

		await expect(storage.load("run-1")).rejects.toMatchObject({ code: "COUNCIL_ARTIFACT_HASH_MISMATCH" });
		const persisted = JSON.parse(
			fs.readFileSync(path.join(artifactsRoot, "local", "council-run-1-manifest.json"), "utf8"),
		) as CouncilManifest;
		expect(persisted.planVersions).toEqual(value.planVersions);
		expect(fs.readFileSync(path.join(artifactsRoot, "local", "council-run-1-draft.md"), "utf8")).toBe("truncated");
	});

	it("rejects a referenced schema-invalid member report without erasing its evidence", async () => {
		using temp = TempDir.createSync("@omp-council-semantic-member-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const { storage } = storageHarness(temp.join("artifacts"));
		const value = await createRun(storage, manifest(repoRoot));
		const invalidReport = await storage.writeArtifact(
			"run-1",
			"council1-r1.json",
			JSON.stringify({ readiness: "ready", findings: [] }),
		);
		const round = value.rounds[0]!;
		const member = round.members[0]!;
		round.status = "settled";
		round.finishedAt = checkpointTime;
		member.status = "succeeded";
		member.finishedAt = checkpointTime;
		member.artifact = invalidReport;
		member.resolvedModel = "openai/gpt-5";
		await storage.checkpoint(value);

		await expect(storage.load("run-1")).rejects.toMatchObject({ code: "COUNCIL_RECOVERY_CORRUPT" });
		expect(await storage.readArtifact(invalidReport)).toBe(JSON.stringify({ readiness: "ready", findings: [] }));
	});

	it("removes an adjudication based on missing evidence and resets only dependent later rounds", async () => {
		using temp = TempDir.createSync("@omp-council-adjudication-recovery-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		const value = await createTwoRoundAdjudicated(storage, repoRoot);
		fs.unlinkSync(path.join(artifactsRoot, "local", "council-run-1-council2-r1.json"));

		const recovered = await storage.load("run-1");
		expect(recovered.planVersions).toEqual([value.planVersions[0]]);
		expect(recovered.rounds[0]!.status).toBe("interrupted");
		expect(recovered.rounds[0]!.members[0]).toMatchObject({
			status: "succeeded",
			findingIds: ["A1"],
			artifact: value.rounds[0]!.members[0]!.artifact,
		});
		expect(recovered.rounds[0]!.members[1]).toMatchObject({
			status: "interrupted",
			findingIds: [],
			artifact: null,
		});
		expect(recovered.rounds[1]).toMatchObject({
			status: "pending",
			startedAt: null,
			finishedAt: null,
			members: [
				{ status: "pending", attempts: 0, artifact: null, resolvedModel: null },
				{ status: "pending", attempts: 0, artifact: null, resolvedModel: null },
			],
		});
	});

	it("truncates at a missing draft and resets all adjudicated rounds", async () => {
		using temp = TempDir.createSync("@omp-council-draft-chain-recovery-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		await createTwoRoundAdjudicated(storage, repoRoot);
		fs.unlinkSync(path.join(artifactsRoot, "local", "council-run-1-draft.md"));

		const recovered = await storage.load("run-1");
		expect(recovered.planVersions).toEqual([]);
		expect(recovered.rounds).toEqual(
			recovered.rounds.map((round, index) => ({
				round: index + 1,
				status: "pending",
				startedAt: null,
				finishedAt: null,
				members: round.members.map((member, order) => ({
					role: member.role,
					order,
					status: "pending",
					attempts: 0,
					startedAt: null,
					finishedAt: null,
					artifact: null,
					resolvedModel: null,
					authFallbackUsed: false,
					failureReason: null,
					findingIds: [],
				})),
			})),
		);
	});

	it("truncates at a missing round-one adjudication while preserving its safe reviews", async () => {
		using temp = TempDir.createSync("@omp-council-round-chain-recovery-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		const value = await createTwoRoundAdjudicated(storage, repoRoot);
		fs.unlinkSync(path.join(artifactsRoot, "local", "council-run-1-round1.md"));

		const recovered = await storage.load("run-1");
		expect(recovered.planVersions).toEqual([value.planVersions[0]]);
		expect(recovered.rounds[0]).toEqual(value.rounds[0]);
		expect(recovered.rounds[1]).toMatchObject({
			status: "pending",
			startedAt: null,
			finishedAt: null,
			members: [
				{ status: "pending", attempts: 0, artifact: null },
				{ status: "pending", attempts: 0, artifact: null },
			],
		});
	});

	it("combines member and predecessor damage by applying the earliest dependency reset", async () => {
		using temp = TempDir.createSync("@omp-council-combined-recovery-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		await createTwoRoundAdjudicated(storage, repoRoot);
		fs.unlinkSync(path.join(artifactsRoot, "local", "council-run-1-council2-r1.json"));
		fs.unlinkSync(path.join(artifactsRoot, "local", "council-run-1-draft.md"));

		const recovered = await storage.load("run-1");
		expect(recovered.planVersions).toEqual([]);
		expect(recovered.failure).toMatchObject({ phase: "planVersions[0]", code: "COUNCIL_RECOVERY_CORRUPT" });
		expect(recovered.rounds.every(round => round.status === "pending")).toBeTrue();
		expect(recovered.rounds.every(round => round.members.every(member => member.status === "pending"))).toBeTrue();
	});

	it("skips corrupt historical manifests in list while explicit load still reports corruption", async () => {
		using temp = TempDir.createSync("@omp-council-list-isolation-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		await createRun(storage, manifest(repoRoot));
		const newest = manifest(repoRoot);
		newest.runId = "run-2";
		await createRun(storage, newest);
		fs.writeFileSync(path.join(artifactsRoot, "local", "council-run-1-manifest.json"), "{ damaged");

		await expect(storage.load("run-1")).rejects.toMatchObject({ code: "COUNCIL_RECOVERY_CORRUPT" });
		expect((await storage.list()).map(value => value.runId)).toEqual(["run-2"]);
	});

	it("retains completed history after the user plan evolves while incomplete publication remains hash-strict", async () => {
		using temp = TempDir.createSync("@omp-council-completed-history-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		const value = await createRun(storage, manifest(repoRoot));
		const originalPlan = validPlan;
		const planRoot = await storage.canonicalPlanRoot();
		const outputPath = path.join(planRoot, value.outputPath);
		fs.writeFileSync(outputPath, originalPlan);
		const round = value.rounds[0]!;
		const member = round.members[0]!;
		round.status = "settled";
		round.finishedAt = checkpointTime;
		member.status = "failed";
		member.finishedAt = checkpointTime;
		member.failureReason = "No report was produced";
		const draft = await storage.writeArtifact(
			"run-1",
			"draft.md",
			persistedPlan("council-planner-metadata", {
				assumptions: [],
				blockers: [],
				evidenceVersion: "1.0.0",
			}),
		);
		const final = await storage.writeArtifact("run-1", "round1.md", persistedAdjudication([]));
		value.planVersions = [
			{ version: 1, round: 0, kind: "draft", artifact: draft, createdAt: checkpointTime },
			{ version: 2, round: 1, kind: "final", artifact: final, createdAt: checkpointTime },
		];
		value.state = "completed";
		value.timestamps.finishedAt = checkpointTime;
		value.published = {
			path: value.outputPath,
			sha256: sha256CouncilContent(originalPlan),
			bytes: Buffer.byteLength(originalPlan),
			publishedAt: checkpointTime,
		};
		await storage.checkpoint(value);
		fs.writeFileSync(outputPath, "User revised this plan after council completion.\n");

		const recovered = await storage.load("run-1");
		expect(recovered.state).toBe("completed");
		expect(recovered.published).toEqual(value.published);
		const incomplete = manifest(repoRoot);
		incomplete.runId = "run-2";
		incomplete.published = structuredClone(value.published);
		await createRun(storage, incomplete);
		await expect(storage.load("run-2")).rejects.toMatchObject({ code: "COUNCIL_ARTIFACT_HASH_MISMATCH" });
		expect((await storage.list()).map(entry => entry.runId)).toEqual(["run-1"]);
		expect(fs.readdirSync(repoRoot)).toEqual([]);
	});

	it("keeps foreign references and structurally invalid planner identity as whole-run corruption", async () => {
		using temp = TempDir.createSync("@omp-council-corrupt-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		const value = await createRun(storage, manifest(repoRoot));
		const draft = await storage.writeArtifact("run-1", "draft.md", "draft");
		value.planVersions.push({
			version: 1,
			round: 0,
			kind: "draft",
			artifact: { ...draft, url: "local://council-foreign-draft.md" },
			createdAt: value.timestamps.createdAt,
		});
		await storage.checkpoint(value);
		await expect(storage.load("run-1")).rejects.toMatchObject({ code: "COUNCIL_RECOVERY_CORRUPT" });

		const manifestPath = path.join(artifactsRoot, "local", "council-run-1-manifest.json");
		const invalid = structuredClone(value) as Partial<CouncilManifest>;
		delete invalid.planner;
		fs.writeFileSync(manifestPath, JSON.stringify(invalid));
		try {
			await storage.load("run-1");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CouncilStorageError);
			expect(error).toMatchObject({ code: "COUNCIL_RECOVERY_CORRUPT", spending: false });
			expect((error as Error).message).toContain("planner");
		}
	});

	it("resolves one canonical session plan root through both entry points", async () => {
		using temp = TempDir.createSync("@omp-council-plan-root-");
		const artifactsRoot = temp.join("artifacts");
		const { session } = storageSession(artifactsRoot);
		const storage = new CouncilStorage(session, { now: () => checkpointTime });

		const planRoot = await storage.canonicalPlanRoot();
		expect(planRoot).toBe(fs.realpathSync(path.join(artifactsRoot, "local")));
		expect(await councilPlanRoot(session)).toBe(planRoot);
	});

	it("verifies a legacy plans/<slug>.md publication inside the session cache, never the repository", async () => {
		using temp = TempDir.createSync("@omp-council-legacy-output-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		const legacy = manifest(repoRoot);
		legacy.outputPath = "plans/review-the-implementation.md";
		const value = await createRun(storage, legacy);

		const legacyDirectory = path.join(await storage.canonicalPlanRoot(), "plans");
		fs.mkdirSync(legacyDirectory, { recursive: true });
		fs.writeFileSync(path.join(legacyDirectory, "review-the-implementation.md"), validPlan);
		value.published = {
			path: value.outputPath,
			sha256: sha256CouncilContent(validPlan),
			bytes: Buffer.byteLength(validPlan),
			publishedAt: checkpointTime,
		};
		await storage.checkpoint(value);

		const recovered = await storage.load("run-1");
		expect(recovered.outputPath).toBe("plans/review-the-implementation.md");
		expect(recovered.published).toEqual(value.published);
		expect((await storage.list()).map(entry => entry.runId)).toEqual(["run-1"]);
		expect(fs.readdirSync(repoRoot)).toEqual([]);

		// The verified copy is the one in the session cache: damaging it, and nothing in the
		// repository, is what turns the run hash-strict.
		fs.writeFileSync(path.join(legacyDirectory, "review-the-implementation.md"), "user revised the legacy plan\n");
		await expect(storage.load("run-1")).rejects.toMatchObject({ code: "COUNCIL_ARTIFACT_HASH_MISMATCH" });
	});

	it("reads one adjudication per round, each carrying only that round's dispositions", async () => {
		using temp = TempDir.createSync("@omp-council-adjudications-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const { storage } = storageHarness(temp.join("artifacts"));
		const value = await createTwoRoundAdjudicated(storage, repoRoot);

		const adjudications = await storage.readAdjudications(value);
		expect([...adjudications.keys()]).toEqual([1, 2]);
		expect(adjudications.get(1)!.dispositions.map(entry => entry.id)).toEqual(["A1", "B1"]);
		expect(adjudications.get(2)!.dispositions.map(entry => entry.id)).toEqual(["C1", "D1"]);
		expect(adjudications.get(1)!.plan).toBe(validPlan);
	});

	it("rejects an adjudication whose disposition ids do not match its own round's findings", async () => {
		using temp = TempDir.createSync("@omp-council-adjudication-ids-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const artifactsRoot = temp.join("artifacts");
		const { storage } = storageHarness(artifactsRoot);
		const value = await createTwoRoundAdjudicated(storage, repoRoot);
		const foreign = persistedAdjudication(["Z9"]);
		fs.writeFileSync(path.join(artifactsRoot, "local", "council-run-1-round2.md"), foreign);
		value.planVersions[2]!.artifact = {
			url: councilArtifactUrl("run-1", "round2.md"),
			sha256: sha256CouncilContent(foreign),
			bytes: Buffer.byteLength(foreign),
		};

		try {
			await storage.readAdjudications(value);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CouncilStorageError);
			expect(error).toMatchObject({ code: "COUNCIL_RECOVERY_CORRUPT" });
			expect((error as Error).message).toContain("council-run-1-round2.md");
		}
	});
});
