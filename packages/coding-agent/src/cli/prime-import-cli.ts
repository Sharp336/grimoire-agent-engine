import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDbPath,
	getAgentDir,
	getBlobsDir,
	getProjectDir,
	getSessionsDir,
	MAIN_CONFIG_FILENAMES,
} from "@oh-my-pi/pi-utils";
import { parsePrimeConfig } from "../import/prime/config-parser";
import {
	applyPrimeDestination,
	type PrimeDestinationApplyResult,
	type PrimeDestinationInput,
	type PrimeDestinationPlan,
	planPrimeDestination,
	validatePrimeDestinationRollbackEntry,
} from "../import/prime/destination";
import {
	applyPrimeSessions,
	canonicalPrimeImportOsPath,
	preflightPrimeSessionRollbackManifest,
} from "../import/prime/session-import";
import { parsePrimeSessions } from "../import/prime/session-parser";
import { parsePrimeSkills } from "../import/prime/skill-parser";
import { discoverPrimeSource } from "../import/prime/source";
import {
	PRIME_IMPORT_SCHEMA_VERSION,
	type PrimeImportDomain,
	type PrimeImportItemResult,
	type PrimeImportLoss,
	type PrimeImportReport,
	type PrimeImportSourceDiscovery,
	type PrimeNormalizedSession,
} from "../import/prime/types";

export interface PrimeImportCommandArgs {
	readonly source?: string;
	readonly cwd?: string;
	readonly sessionRoot?: string;
	readonly primeCliConfigPath?: string;
	readonly agentDir?: string;
	readonly apply: boolean;
	readonly configOnly?: boolean;
}

export interface PrimeImportDestinationDisplay {
	readonly agentDir: string;
	readonly settingsCandidates: readonly string[];
	readonly modelsPath: string;
	readonly agentDbPath: string;
	readonly skillsRoot: string;
	readonly sessionsRoot: string;
	readonly blobsRoot: string;
}

export interface PrimeImportCliExecution {
	readonly report: PrimeImportReport;
	readonly destination: PrimeImportDestinationDisplay;
	readonly manifestPath?: string;
}

export interface PrimeImportCliResult extends PrimeImportCliExecution {
	readonly human: string;
	readonly exitCode: 0 | 1;
}

const FATAL_CODES: Partial<Record<PrimeImportLoss["code"], true>> = {
	"source-missing": true,
	"source-unreadable": true,
	"source-invalid-layout": true,
	"source-path-escape": true,
	"source-oversized": true,
	"source-budget-exceeded": true,
	"source-drift": true,
	"source-type-changed": true,
	"source-changed": true,
	"destination-invalid": true,
	"destination-drift": true,
	"destination-apply-failed": true,
	"destination-cleanup-failed": true,
	"config-malformed": true,
	"models-malformed": true,
	"credentials-malformed": true,
	"skills-malformed": true,
	"skills-invalid-frontmatter": true,
	"sessions-malformed": true,
};

const CONFIG_ONLY_DOMAINS: readonly PrimeImportDomain[] = ["config", "settings", "models", "credentials"];

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function lossKey(loss: PrimeImportLoss): string {
	return JSON.stringify([
		loss.code,
		loss.domain,
		loss.sourceRef,
		loss.path ?? "",
		loss.line ?? null,
		loss.byteOffset ?? null,
	]);
}

function uniqueLosses(losses: readonly PrimeImportLoss[]): PrimeImportLoss[] {
	const seen = new Set<string>();
	return losses.filter(loss => {
		const key = lossKey(loss);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function sortItems(items: readonly PrimeImportItemResult[]): PrimeImportItemResult[] {
	return [...items].sort((a, b) => compare(a.itemId, b.itemId));
}

async function implicitPrimeCliConfigPath(): Promise<string | undefined> {
	const candidate = path.join(os.homedir(), ".prime", "config.json");
	try {
		await fs.lstat(candidate);
		return candidate;
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		return candidate;
	}
}

async function implicitPrimeSourceRoot(): Promise<string> {
	const primary = path.join(os.homedir(), ".prime", "agent");
	try {
		await fs.lstat(primary);
		return primary;
	} catch (error) {
		if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") return primary;
	}
	const legacy = path.join(os.homedir(), ".pi", "agent");
	try {
		await fs.lstat(legacy);
		return legacy;
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code !== "ENOENT") return legacy;
		return primary;
	}
}

function fallbackDiscovery(
	sourceRoot: string,
	cwd: string,
	sessionRoot: string,
	primeCliConfigPath: string | undefined,
	loss: PrimeImportLoss,
): PrimeImportSourceDiscovery {
	const snapshot = {
		schemaVersion: PRIME_IMPORT_SCHEMA_VERSION,
		snapshotId: createHash("sha256")
			.update(`${sourceRoot}\n${cwd}\n${sessionRoot}\n${primeCliConfigPath ?? ""}`)
			.digest("hex"),
		sourceRoot,
		cwd,
		sessionRoot,
		maxFileBytes: 0,
		maxTotalBytes: 0,
		maxEntries: 0,
		...(primeCliConfigPath ? { primeCliConfigPath } : {}),
		files: [],
		treeEntries: [],
	} as const;
	return { snapshot, inventory: { records: [], files: [], excluded: [] }, losses: [loss] };
}
function destinationDisplay(agentDir: string): PrimeImportDestinationDisplay {
	return {
		agentDir,
		settingsCandidates: MAIN_CONFIG_FILENAMES.map(file => path.join(agentDir, file)),
		modelsPath: path.join(agentDir, "models.yml"),
		agentDbPath: getAgentDbPath(agentDir),
		skillsRoot: path.join(agentDir, "skills"),
		sessionsRoot: getSessionsDir(agentDir),
		blobsRoot: getBlobsDir(agentDir),
	};
}
async function safeDestinationCanonicalPath(candidate: string): Promise<string | undefined> {
	const resolved = canonicalPrimeImportOsPath(candidate);
	const root = path.parse(resolved).root;
	const relative = path.relative(root, resolved);
	const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
	let current = root;
	for (let index = 0; index < segments.length; index += 1) {
		const next = path.join(current, segments[index]!);
		let stat: Stats;
		try {
			stat = await fs.lstat(next);
		} catch (error) {
			if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
				return undefined;
			try {
				const canonicalParent = await fs.realpath(current);
				if (canonicalParent !== current) return undefined;
				return path.join(canonicalParent, ...segments.slice(index));
			} catch {
				return undefined;
			}
		}
		if (stat.isSymbolicLink()) return undefined;
		current = next;
	}
	try {
		const canonical = await fs.realpath(resolved);
		return canonical === resolved ? canonical : undefined;
	} catch {
		return undefined;
	}
}

function pathsOverlap(left: string, right: string): boolean {
	const resolvedLeft = path.resolve(left);
	const resolvedRight = path.resolve(right);
	return (
		resolvedLeft === resolvedRight ||
		resolvedLeft.startsWith(`${resolvedRight}${path.sep}`) ||
		resolvedRight.startsWith(`${resolvedLeft}${path.sep}`)
	);
}

async function destinationIsolationLoss(
	discovery: PrimeImportSourceDiscovery,
	destination: PrimeImportDestinationDisplay,
): Promise<PrimeImportLoss | undefined> {
	const destinationCandidates = [
		destination.agentDir,
		...destination.settingsCandidates,
		destination.modelsPath,
		destination.agentDbPath,
		destination.skillsRoot,
		destination.sessionsRoot,
		destination.blobsRoot,
		path.join(destination.agentDir, ".prime-import"),
	];
	const destinationPaths: string[] = [];
	for (const candidate of destinationCandidates) {
		const canonical = await safeDestinationCanonicalPath(candidate);
		if (canonical === undefined)
			return { code: "destination-invalid", domain: "config", sourceRef: "destination", path: candidate };
		destinationPaths.push(canonical);
	}
	const artifactRoot = path.join(path.dirname(discovery.snapshot.sessionRoot), "session-artifacts");
	const sourcePaths = [
		discovery.snapshot.sourceRoot,
		discovery.snapshot.sessionRoot,
		discovery.snapshot.cwd,
		artifactRoot,
		...discovery.snapshot.files.map(file => file.canonicalPath),
		...discovery.snapshot.treeEntries.map(entry => entry.canonicalPath),
		...discovery.inventory.records.map(record => record.canonicalPath),
		...discovery.inventory.excluded.map(entry => entry.canonicalPath),
	];
	for (const destinationPath of destinationPaths)
		for (const sourcePath of sourcePaths)
			if (pathsOverlap(destinationPath, sourcePath))
				return {
					code: "destination-invalid",
					domain: "config",
					sourceRef: "destination",
					path: destinationPath,
				};
	return undefined;
}

function markItemsLost(
	items: readonly PrimeImportItemResult[],
	lossCode: PrimeImportLoss["code"],
): PrimeImportItemResult[] {
	return items.map(item => ({
		...item,
		...(item.outcome === "planned"
			? {
					outcome: "lost" as const,
					lossCodes: [...new Set([...(item.lossCodes ?? []), lossCode])],
				}
			: {}),
	}));
}

function isOperationalError(error: unknown): boolean {
	if (error === null || typeof error !== "object" || !("code" in error)) return false;
	const code = error.code;
	return (
		typeof code === "string" &&
		["EACCES", "EISDIR", "EINVAL", "EIO", "ENFILE", "ENOENT", "ENOTDIR", "EROFS"].includes(code)
	);
}

function mergeItems(items: readonly PrimeImportItemResult[]): PrimeImportItemResult[] {
	const merged = new Map<string, PrimeImportItemResult>();
	for (const item of items) {
		const current = merged.get(item.itemId);
		if (!current) {
			merged.set(item.itemId, item);
			continue;
		}
		const sourceRefs = [...new Set([...current.sourceRefs, ...item.sourceRefs])];
		const lossCodes = [...new Set([...(current.lossCodes ?? []), ...(item.lossCodes ?? [])])];
		merged.set(item.itemId, {
			...current,
			...item,
			sourceRefs,
			...(lossCodes.length ? { lossCodes } : {}),
		});
	}
	return sortItems([...merged.values()]);
}

function reportFrom(
	snapshotId: string,
	items: readonly PrimeImportItemResult[],
	losses: readonly PrimeImportLoss[],
	partialApply = false,
	rollbackManifest?: PrimeImportReport["rollbackManifest"],
): PrimeImportReport {
	return {
		schemaVersion: PRIME_IMPORT_SCHEMA_VERSION,
		snapshotId,
		items: mergeItems(items),
		losses: uniqueLosses(losses),
		partialApply,
		...(rollbackManifest ? { rollbackManifest } : {}),
	};
}

function orderedSessions(sessions: readonly PrimeNormalizedSession[]): PrimeNormalizedSession[] {
	return [...sessions].sort((left, right) =>
		compare(`${left.sourceRef}\u0000${left.header.id}`, `${right.sourceRef}\u0000${right.header.id}`),
	);
}
function allocateItemId(baseItemId: string, usedItemIds: Set<string>): string {
	let itemId = baseItemId;
	let suffix = 1;
	while (usedItemIds.has(itemId)) itemId = `${baseItemId}:${suffix++}`;
	usedItemIds.add(itemId);
	return itemId;
}

function sessionItems(
	sessions: readonly PrimeNormalizedSession[],
	outcome: PrimeImportItemResult["outcome"],
	lossCode?: PrimeImportLoss["code"],
): PrimeImportItemResult[] {
	const usedItemIds = new Set<string>();
	return orderedSessions(sessions).map(session => {
		const itemId = allocateItemId(`session:${session.header.id}`, usedItemIds);
		return {
			itemId,
			kind: "sessions",
			sourceRefs: [session.sourceRef],
			outcome,
			...(lossCode ? { lossCodes: [lossCode] } : {}),
		};
	});
}

function sessionPlanItems(sessions: readonly PrimeNormalizedSession[]): PrimeImportItemResult[] {
	return sessionItems(sessions, "planned");
}

function sessionLostItems(
	sessions: readonly PrimeNormalizedSession[],
	lossCode: PrimeImportLoss["code"],
): PrimeImportItemResult[] {
	return sessionItems(sessions, "lost", lossCode);
}

function destinationFailureCode(losses: readonly PrimeImportLoss[]): PrimeImportLoss["code"] {
	return (
		losses.find(loss => loss.code === "destination-apply-failed")?.code ??
		losses.find(loss => loss.code === "destination-drift")?.code ??
		losses.find(loss => loss.code === "destination-invalid")?.code ??
		"destination-apply-failed"
	);
}

export function primeImportExitCode(report: PrimeImportReport): 0 | 1 {
	return report.partialApply ||
		report.items.some(item => item.kind === "sessions" && item.outcome === "lost") ||
		report.losses.some(
			loss =>
				FATAL_CODES[loss.code] === true ||
				(loss.code === "source-symlink" && (loss.sourceRef === "source-root" || loss.sourceRef === "sessions")),
		)
		? 1
		: 0;
}

export async function runPrimeImportCommand(args: PrimeImportCommandArgs): Promise<PrimeImportCliResult> {
	const configOnly = args.configOnly === true;
	const sourceRoot = path.resolve(args.source ?? (await implicitPrimeSourceRoot()));
	const cwd = path.resolve(args.cwd ?? getProjectDir());
	const sessionRoot = args.sessionRoot === undefined ? undefined : path.resolve(args.sessionRoot);
	const resolvedSessionRoot = sessionRoot ?? path.join(sourceRoot, "sessions");
	const primeCliConfigPath =
		args.primeCliConfigPath === undefined
			? await implicitPrimeCliConfigPath()
			: path.resolve(args.primeCliConfigPath);
	const agentDir = path.resolve(args.agentDir ?? getAgentDir());
	let destination = destinationDisplay(agentDir);

	let discovery: PrimeImportSourceDiscovery;
	try {
		discovery = await discoverPrimeSource({
			sourceRoot,
			cwd,
			...(sessionRoot ? { sessionRoot } : {}),
			...(primeCliConfigPath ? { primeCliConfigPath } : {}),
		});
	} catch (error) {
		if (!isOperationalError(error)) throw error;
		discovery = fallbackDiscovery(sourceRoot, cwd, resolvedSessionRoot, primeCliConfigPath, {
			code: "source-unreadable",
			domain: "config",
			sourceRef: "source-root",
			path: sourceRoot,
		});
	}

	const sourceDomains = configOnly ? CONFIG_ONLY_DOMAINS : undefined;
	const sourceLosses = sourceDomains
		? discovery.losses.filter(loss => sourceDomains.includes(loss.domain))
		: discovery.losses;
	const parserDiscovery = configOnly ? { ...discovery, losses: sourceLosses } : discovery;
	const config = parsePrimeConfig(parserDiscovery);
	const skills = configOnly ? { candidates: [], losses: [] } : parsePrimeSkills(discovery);
	const sessions = configOnly ? { sessions: [], losses: [] } : parsePrimeSessions(discovery);
	let report: PrimeImportReport;
	const initialIsolationLoss = await destinationIsolationLoss(discovery, destination);
	if (initialIsolationLoss) {
		report = reportFrom(
			discovery.snapshot.snapshotId,
			[],
			[...sourceLosses, ...config.losses, ...skills.losses, ...sessions.losses, initialIsolationLoss],
		);
		const execution = { report, destination };
		return {
			...execution,
			human: formatPrimeImportHuman(execution, args.apply),
			exitCode: primeImportExitCode(report),
		};
	}
	const input: PrimeDestinationInput = {
		snapshot: discovery.snapshot,
		config,
		skills,
		...(configOnly ? { allowModelLosses: true } : {}),
		...(sourceDomains ? { sourceDomains } : {}),
	};
	let destinationPlan: PrimeDestinationPlan;
	try {
		destinationPlan = await planPrimeDestination(input, { agentDir, cwd });
	} catch (error) {
		if (!isOperationalError(error)) throw error;
		report = reportFrom(
			discovery.snapshot.snapshotId,
			[],
			[
				...sourceLosses,
				...config.losses,
				...skills.losses,
				...sessions.losses,
				{ code: "destination-invalid", domain: "config", sourceRef: "destination", path: agentDir },
			],
		);
		const human = formatPrimeImportHuman({ report, destination }, args.apply);
		return { report, destination, human, exitCode: primeImportExitCode(report) };
	}
	destination = destinationDisplay(destinationPlan.destination.agentDir);

	const plannedSessionItems = configOnly ? [] : sessionPlanItems(sessions.sessions);
	const plannedReport = reportFrom(
		discovery.snapshot.snapshotId,
		[...destinationPlan.items, ...plannedSessionItems],
		[...sourceLosses, ...config.losses, ...skills.losses, ...sessions.losses, ...destinationPlan.losses],
	);
	if (!args.apply || primeImportExitCode(plannedReport) !== 0) {
		report = plannedReport;
	} else {
		const rollbackManifestPath = path.join(
			destinationPlan.destination.agentDir,
			".prime-import",
			`rollback-${discovery.snapshot.snapshotId}.json`,
		);
		const manifestPreflightLoss = configOnly
			? undefined
			: await preflightPrimeSessionRollbackManifest(discovery.snapshot, {
					destinationCwd: destinationPlan.destination.cwd,
					sessionDir: destination.sessionsRoot,
					blobDir: destination.blobsRoot,
					rollbackManifestPath,
					validateDestinationRollbackEntry: entry =>
						validatePrimeDestinationRollbackEntry(entry, destinationPlan.destination),
				});
		if (manifestPreflightLoss) {
			report = reportFrom(
				discovery.snapshot.snapshotId,
				[
					...markItemsLost(destinationPlan.items, manifestPreflightLoss.code),
					...sessionLostItems(sessions.sessions, manifestPreflightLoss.code),
				],
				[
					...sourceLosses,
					...config.losses,
					...skills.losses,
					...sessions.losses,
					...destinationPlan.losses,
					manifestPreflightLoss,
				],
			);
			const execution = { report, destination };
			return {
				...execution,
				human: formatPrimeImportHuman(execution, args.apply),
				exitCode: primeImportExitCode(report),
			};
		}
		const preApplyIsolationLoss = await destinationIsolationLoss(discovery, destination);
		if (preApplyIsolationLoss) {
			report = reportFrom(
				discovery.snapshot.snapshotId,
				[
					...markItemsLost(destinationPlan.items, preApplyIsolationLoss.code),
					...sessionLostItems(sessions.sessions, preApplyIsolationLoss.code),
				],
				[
					...sourceLosses,
					...config.losses,
					...skills.losses,
					...sessions.losses,
					...destinationPlan.losses,
					preApplyIsolationLoss,
				],
			);
			const execution = { report, destination };
			return {
				...execution,
				human: formatPrimeImportHuman(execution, args.apply),
				exitCode: primeImportExitCode(report),
			};
		}
		let destinationApplied: PrimeDestinationApplyResult;
		try {
			destinationApplied = await applyPrimeDestination(destinationPlan, input);
		} catch {
			const lossCode = "destination-apply-failed" as const;
			report = reportFrom(
				discovery.snapshot.snapshotId,
				markItemsLost([...destinationPlan.items, ...plannedSessionItems], lossCode),
				[
					...sourceLosses,
					...config.losses,
					...skills.losses,
					...sessions.losses,
					...destinationPlan.losses,
					{ code: lossCode, domain: "config", sourceRef: "destination", path: destination.agentDir },
				],
				true,
			);
			const execution = { report, destination };
			return {
				...execution,
				human: formatPrimeImportHuman(execution, args.apply),
				exitCode: primeImportExitCode(report),
			};
		}
		const destinationReport = destinationApplied.report;
		const destinationFailed = primeImportExitCode(destinationReport) !== 0;
		const hasInitialRollbackEntries = destinationApplied.rollbackEntries.length > 0;
		const shouldFinalizeSessions =
			!configOnly && (hasInitialRollbackEntries || (!destinationFailed && sessions.sessions.length > 0));
		let sessionReport: PrimeImportReport | undefined;
		let manifestPath: string | undefined;
		if (shouldFinalizeSessions) {
			try {
				const applied = await applyPrimeSessions(
					{
						snapshot: discovery.snapshot,
						sessions: destinationFailed ? [] : sessions.sessions,
						sourceFiles: discovery.inventory.files,
						losses: sessions.losses,
					},
					{
						destinationCwd: destinationPlan.destination.cwd,
						sessionDir: destination.sessionsRoot,
						blobDir: destination.blobsRoot,
						rollbackManifestPath: path.join(
							destinationPlan.destination.agentDir,
							".prime-import",
							`rollback-${discovery.snapshot.snapshotId}.json`,
						),
						initialRollbackEntries: destinationApplied.rollbackEntries,
						validateDestinationRollbackEntry: entry =>
							validatePrimeDestinationRollbackEntry(entry, destinationPlan.destination),
					},
				);
				manifestPath = applied.rollbackManifest?.path;
				sessionReport = {
					schemaVersion: applied.schemaVersion,
					snapshotId: applied.snapshotId,
					items: applied.items,
					losses: applied.losses,
					partialApply: applied.partialApply,
					...(applied.rollbackManifest
						? {
								rollbackManifest: {
									schemaVersion: applied.rollbackManifest.schemaVersion,
									snapshotId: applied.rollbackManifest.snapshotId,
									entries: applied.rollbackManifest.entries.map(entry => ({ ...entry })),
								},
							}
						: {}),
				};
			} catch {
				const lossCode = "destination-apply-failed" as const;
				report = reportFrom(
					discovery.snapshot.snapshotId,
					[...destinationReport.items, ...sessionLostItems(sessions.sessions, lossCode)],
					[
						...sourceLosses,
						...config.losses,
						...skills.losses,
						...sessions.losses,
						...destinationReport.losses,
						{ code: lossCode, domain: "sessions", sourceRef: "sessions", path: destination.sessionsRoot },
					],
					true,
				);
				const execution = { report, destination };
				return {
					...execution,
					human: formatPrimeImportHuman(execution, args.apply),
					exitCode: primeImportExitCode(report),
				};
			}
		}
		const laterSessionItems =
			destinationFailed && sessions.sessions.length
				? sessionLostItems(sessions.sessions, destinationFailureCode(destinationReport.losses))
				: [];
		const reports = sessionReport ? [destinationReport, sessionReport] : [destinationReport];
		const reportItems = reports.flatMap(value => value.items);
		const reportLosses = reports.flatMap(value => value.losses);
		const sessionItemsById = new Map(sessionReport?.items.map(item => [item.itemId, item] as const));
		const hasLostPlannedSession =
			sessionReport !== undefined &&
			plannedSessionItems.some(item => {
				const applied = sessionItemsById.get(item.itemId);
				return applied === undefined || applied.outcome === "lost";
			});
		const sessionFinalizationFailed =
			hasInitialRollbackEntries &&
			sessionReport !== undefined &&
			(!sessionReport.rollbackManifest ||
				hasLostPlannedSession ||
				sessionReport.losses.some(loss => FATAL_CODES[loss.code] === true));
		report = reportFrom(
			discovery.snapshot.snapshotId,
			[...reportItems, ...laterSessionItems],
			[...sourceLosses, ...config.losses, ...skills.losses, ...sessions.losses, ...reportLosses],
			reports.some(value => value.partialApply) ||
				(destinationFailed && hasInitialRollbackEntries) ||
				sessionFinalizationFailed,
			sessionReport?.rollbackManifest,
		);
		const execution = { report, destination, ...(manifestPath ? { manifestPath } : {}) };
		return {
			...execution,
			human: formatPrimeImportHuman(execution, args.apply),
			exitCode: primeImportExitCode(report),
		};
	}
	const execution = { report, destination };
	return { ...execution, human: formatPrimeImportHuman(execution, args.apply), exitCode: primeImportExitCode(report) };
}
function escapeTerminal(value: string): string {
	return value.replace(
		/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
		character => {
			const code = character.codePointAt(0) ?? 0;
			return `\\u${code.toString(16).padStart(4, "0")}`;
		},
	);
}
function escapeJsonStringValues(serialized: string): string {
	let inString = false;
	let output = "";
	for (let index = 0; index < serialized.length; index++) {
		const character = serialized[index];
		if (!inString) {
			output += character;
			if (character === '"') inString = true;
			continue;
		}
		if (character === "\\") {
			const escaped = serialized[index + 1];
			if (escaped === undefined) {
				output += character;
				continue;
			}
			if (escaped === "b") output += "\\u0008";
			else if (escaped === "t") output += "\\u0009";
			else if (escaped === "n") output += "\\u000a";
			else if (escaped === "f") output += "\\u000c";
			else if (escaped === "r") output += "\\u000d";
			else if (escaped === "u") {
				output += `\\u${serialized.slice(index + 2, index + 6).toLowerCase()}`;
				index += 5;
			} else output += `${character}${escaped}`;
			if (escaped !== "u") index++;
			continue;
		}
		output += escapeTerminal(character);
		if (character === '"') inString = false;
	}
	return output;
}

export function serializePrimeImportReport(report: PrimeImportReport): string {
	const serialized = JSON.stringify(report);
	if (serialized === undefined) throw new Error("Failed to serialize Prime import report");
	return escapeJsonStringValues(serialized);
}

export function formatPrimeImportHuman(execution: PrimeImportCliExecution, apply: boolean): string {
	const { report, destination } = execution;
	const status = primeImportExitCode(report) ? "failed" : apply ? "applied" : "dry-run";
	const counts = { planned: 0, imported: 0, skipped: 0, lost: 0 };
	for (const item of report.items) counts[item.outcome]++;
	const lines = [
		`Prime import: ${status}`,
		`Snapshot: ${escapeTerminal(report.snapshotId)}`,
		"Destinations:",
		`  agent root: ${escapeTerminal(destination.agentDir)}`,
		...destination.settingsCandidates.map(value => `  settings: ${escapeTerminal(value)}`),
		`  models: ${escapeTerminal(destination.modelsPath)}`,
		`  auth DB: ${escapeTerminal(destination.agentDbPath)}`,
		`  skills: ${escapeTerminal(destination.skillsRoot)}`,
		`  sessions: ${escapeTerminal(destination.sessionsRoot)}`,
		`  blobs: ${escapeTerminal(destination.blobsRoot)}`,
		`Counts: planned=${counts.planned} imported=${counts.imported} skipped=${counts.skipped} lost=${counts.lost}`,
		"Losses:",
		"  CODE\tDOMAIN\tCOUNT",
	];
	if (report.losses.length === 0) lines.push("  none");
	else {
		const summaries = new Map<string, { code: string; domain: string; count: number }>();
		for (const loss of report.losses) {
			const key = JSON.stringify([loss.code, loss.domain]);
			const summary = summaries.get(key);
			if (summary) summary.count++;
			else summaries.set(key, { code: loss.code, domain: loss.domain, count: 1 });
		}
		for (const summary of summaries.values())
			lines.push(`  ${escapeTerminal(summary.code)}\t${escapeTerminal(summary.domain)}\t${summary.count}`);
	}
	lines.push("OAuth re-login:");
	const oauth = report.items.filter(
		item => item.kind === "credentials" && item.lossCodes?.includes("credentials-oauth-relogin"),
	);
	if (oauth.length === 0) lines.push("  none");
	else
		for (const item of oauth)
			lines.push(`  ${escapeTerminal(item.itemId)}\t${item.sourceRefs.map(escapeTerminal).join(",")}`);
	lines.push(`Manifest: ${execution.manifestPath ? escapeTerminal(execution.manifestPath) : "not written"}`);
	lines.push(`Partial apply: ${report.partialApply ? "yes" : "no"}`);
	return `${lines.join("\n")}\n`;
}
