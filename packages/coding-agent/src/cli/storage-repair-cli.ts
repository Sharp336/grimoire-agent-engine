import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDbPath, getHistoryDbPath } from "@oh-my-pi/pi-utils";
import {
	type AgentRepairDiagnosis,
	buildAgentCandidate,
	diagnoseAgentSnapshot,
	verifyAgentCandidate,
	verifyPublishedAgentCandidate,
} from "./storage-repair-agent";
import type { PublishedFile, RawSchemaDefinition } from "./storage-repair-files";
import {
	cleanupSnapshot,
	errorMessage,
	exclusiveStage,
	manualNextStep,
	preparePristineSnapshot,
	publishBackup,
	publishCandidate,
	rawSchemaDefinitions,
	removeCandidateSidecars,
	removeOwnedFile,
	resolveArtifactPaths,
	sealCandidate,
	sourceStillMatches,
	verifyCandidateSeal,
} from "./storage-repair-files";
import {
	buildHistoryCandidate,
	closePromptManifest,
	freezePromptManifest,
	type PromptManifest,
	promptManifestStillMatches,
	verifyHistoryCandidate,
	verifyPublishedHistoryCandidate,
} from "./storage-repair-history";
import type {
	HistoryRepairSource,
	PristineSnapshot,
	StorageRepairFlags,
	StorageRepairResult,
	StorageRepairTestHooks,
} from "./storage-repair-types";

export type {
	HistoryRepairSource,
	StorageRepairAction,
	StorageRepairChecksum,
	StorageRepairFlags,
	StorageRepairObjectResult,
	StorageRepairResult,
	StorageRepairTarget,
	StorageRepairTestHooks,
} from "./storage-repair-types";

function initialArtifacts(source: string, output?: string) {
	const slug = `${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${crypto.randomUUID().slice(0, 8)}`;
	return {
		backup: path.resolve(`${source}.salvage-${slug}.tar`),
		candidate: path.resolve(output ?? `${source}.salvage-${slug}.db`),
	};
}

function refusedObject(result: StorageRepairResult) {
	return {
		name: result.target,
		kind: "repair",
		owner: result.target,
		action: "refused" as const,
		detail: result.refusal,
	};
}

async function cleanupOwnedStages(candidateStage: string | null, backupStage: string | null) {
	await removeOwnedFile(candidateStage);
	if (candidateStage) await removeCandidateSidecars(candidateStage);
	await removeOwnedFile(backupStage);
}

function historySourceFor(flags: StorageRepairFlags): HistoryRepairSource | undefined {
	return flags.target === "history" ? (flags.historySource ?? "sessions") : undefined;
}

function publishedWarning(primary: string | undefined, cleanupErrors: unknown[]): string {
	return `Storage repair published with warning: ${JSON.stringify({
		primary: primary ?? null,
		cleanupInvariant: cleanupErrors.map(errorMessage),
	})}`;
}

export async function runStorageRepair(
	flags: StorageRepairFlags,
	hooks: StorageRepairTestHooks = {},
): Promise<StorageRepairResult> {
	const source = path.resolve(
		flags.target === "agent" ? getAgentDbPath(flags.agentDir) : getHistoryDbPath(flags.agentDir),
	);
	const historySource = historySourceFor(flags);
	const planned = initialArtifacts(source, flags.output);
	const result: StorageRepairResult = {
		target: flags.target,
		...(historySource ? { historySource } : {}),
		apply: flags.apply,
		dataLoss: historySource !== undefined,
		diagnosedOmittedTables: [],
		status: "ready",
		source,
		backup: planned.backup,
		candidate: planned.candidate,
		backupCreated: false,
		backupVerified: false,
		candidatePublished: false,
		candidatePathTrusted: false,
		checksums: [],
		objects: [],
		manualNextStep: "",
	};
	let snapshot: PristineSnapshot | null = null;
	let prompts: PromptManifest | null = null;
	let backupStage: string | null = null;
	let candidateStage: string | null = null;
	let expectedSchema: RawSchemaDefinition[] | null = null;
	let candidateSeal: PublishedFile | null = null;
	try {
		if (flags.target === "agent" && flags.historySource !== undefined) {
			throw new Error("--history-source is only valid with --repair-storage history");
		}
		const artifacts = await resolveArtifactPaths(source, flags.output);
		result.backup = artifacts.backup;
		result.candidate = artifacts.candidate;
		snapshot = await preparePristineSnapshot(source, flags.target === "agent", hooks.afterPristineCopy);

		let diagnosis: AgentRepairDiagnosis | null = null;
		if (flags.target === "agent") {
			if (!snapshot.immutable) throw new Error("Agent immutable SQLite snapshot is missing");
			const expectedPath = path.join(snapshot.tempDir, "expected-agent.db");
			const expected = await fs.promises.open(expectedPath, "wx", 0o600);
			await expected.close();
			diagnosis = diagnoseAgentSnapshot(snapshot.immutable, expectedPath);
			result.diagnosedOmittedTables = diagnosis.omitTables;
			result.dataLoss = diagnosis.omitTables.length > 0;
		} else if (historySource === "sessions") {
			prompts = await freezePromptManifest(snapshot.tempDir, flags.agentDir, hooks.afterSessionManifestParse);
		}

		if (flags.apply) {
			backupStage = await exclusiveStage(artifacts.backup, "backup");
			await hooks.beforeBackupWrite?.();
			await publishBackup(
				backupStage,
				artifacts.backup,
				snapshot,
				() => {
					result.backupCreated = true;
				},
				checksum => {
					result.backupVerified = true;
					result.checksums.push(checksum);
				},
				hooks.afterBackupLink,
				hooks.isWindows,
				hooks.onDirectorySync,
			);
			backupStage = null;
			candidateStage = await exclusiveStage(artifacts.candidate, "candidate");
		} else {
			candidateStage = path.join(snapshot.tempDir, "candidate.db");
			const candidate = await fs.promises.open(candidateStage, "wx", 0o600);
			await candidate.close();
		}

		if (flags.target === "agent") {
			if (!diagnosis || !snapshot.immutable) throw new Error("Agent schema diagnosis is missing");
			result.objects = buildAgentCandidate(snapshot.immutable.db, candidateStage, diagnosis);
			expectedSchema = rawSchemaDefinitions(candidateStage);
			await hooks.beforeCandidateVerification?.();
			verifyAgentCandidate(candidateStage, snapshot.immutable.db, diagnosis.omitTables, expectedSchema);
		} else {
			if (!historySource) throw new Error("History source is missing");
			result.objects = buildHistoryCandidate(candidateStage, historySource, prompts);
			expectedSchema = rawSchemaDefinitions(candidateStage);
			await hooks.beforeCandidateVerification?.();
			verifyHistoryCandidate(candidateStage, historySource, prompts, expectedSchema);
		}

		const seal = await sealCandidate(candidateStage);
		candidateSeal = seal;
		if (!expectedSchema) throw new Error("Candidate schema seal is missing");
		if (flags.target === "agent") {
			if (!diagnosis || !snapshot.immutable) throw new Error("Agent schema diagnosis is missing");
			verifyAgentCandidate(candidateStage, snapshot.immutable.db, diagnosis.omitTables, expectedSchema);
		} else {
			if (!historySource) throw new Error("History source is missing");
			verifyHistoryCandidate(candidateStage, historySource, prompts, expectedSchema);
		}
		await verifyCandidateSeal(candidateStage, seal);
		const candidateChecksum = {
			path: candidateStage,
			sha256: seal.sha256,
			size: Number(seal.size),
			ephemeral: true,
		};
		result.checksums.push(candidateChecksum);
		await sourceStillMatches(snapshot.manifest);
		if (historySource === "sessions") await promptManifestStillMatches(prompts);
		if (flags.apply) {
			await hooks.beforeCandidatePublication?.();
			if (!candidateStage) throw new Error("Candidate publication stage is missing");
			await verifyCandidateSeal(candidateStage, seal);
			await sourceStillMatches(snapshot.manifest);
			if (historySource === "sessions") await promptManifestStillMatches(prompts);
			await publishCandidate(
				candidateStage,
				artifacts.candidate,
				seal,
				() => {
					result.candidatePublished = true;
					candidateChecksum.path = artifacts.candidate;
					candidateChecksum.ephemeral = false;
				},
				{
					afterLink: hooks.afterCandidatePublication,
					beforeStageUnlink: hooks.beforeCandidateStageUnlink,
					beforeDirectorySync: hooks.beforeCandidateDirectorySync,
					isWindows: hooks.isWindows,
					onDirectorySync: hooks.onDirectorySync,
				},
			);
			candidateStage = null;
			await sourceStillMatches(snapshot.manifest);
		}
	} catch (error) {
		if (result.candidatePublished) {
			result.status = "published-with-warning";
			result.candidatePathTrusted = false;
			result.warning = errorMessage(error);
		} else {
			result.status = "refused";
			result.refusal = errorMessage(error);
		}
	} finally {
		const cleanupErrors: unknown[] = [];
		try {
			await cleanupOwnedStages(candidateStage, backupStage);
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			closePromptManifest(prompts);
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			if (snapshot) await sourceStillMatches(snapshot.manifest);
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			if (prompts) await promptManifestStillMatches(prompts);
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await cleanupSnapshot(snapshot);
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (result.candidatePublished && result.status === "ready" && cleanupErrors.length === 0) {
			if (!candidateSeal || !expectedSchema) {
				cleanupErrors.push(new Error("Published candidate verification data is missing"));
			} else {
				try {
					if (flags.target === "agent") verifyPublishedAgentCandidate(result.candidate, expectedSchema);
					else verifyPublishedHistoryCandidate(result.candidate, expectedSchema);
					await hooks.beforeFinalCandidateSeal?.();
					await verifyCandidateSeal(result.candidate, candidateSeal);
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
		}
		if (cleanupErrors.length > 0) {
			if (result.candidatePublished) {
				result.status = "published-with-warning";
				result.candidatePathTrusted = false;
				result.warning = publishedWarning(result.warning, cleanupErrors);
			} else {
				result.status = "refused";
				result.refusal = `Storage repair refusal: ${JSON.stringify({
					primary: result.refusal ?? null,
					cleanupInvariant: cleanupErrors.map(errorMessage),
				})}`;
			}
		} else if (result.candidatePublished && result.status === "ready") {
			result.candidatePathTrusted = true;
		}
	}
	if (result.status === "refused") result.objects.push(refusedObject(result));
	result.manualNextStep = manualNextStep(result.source, result.candidate, result.backup, result);
	return result;
}
