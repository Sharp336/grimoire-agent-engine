import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { COUNCIL_ROLE_ID, type CouncilConfig } from "./config";
import { sha256CouncilContent } from "./hash";
import { DEFAULT_COUNCIL_INSTRUCTION_BYTES } from "./instructions";

export const COUNCIL_MANIFEST_VERSION = 1 as const;

export const COUNCIL_RUN_STATES = [
	"dispatching",
	"planning",
	"reviewing",
	"awaiting-main",
	"adjudicating",
	"round-transition",
	"cancelling",
	"interrupted",
	"failed",
	"completed",
	"completed-degraded",
] as const;

export type CouncilRunState = (typeof COUNCIL_RUN_STATES)[number];
export type CouncilTerminalRunState = "interrupted" | "failed" | "completed" | "completed-degraded";
export type CouncilMemberStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type CouncilRoundStatus = "pending" | "running" | "settled" | "interrupted";

export interface CouncilArtifactReference {
	url: string;
	sha256: string;
	bytes: number;
}

export interface CouncilPublishedArtifact {
	path: string;
	sha256: string;
	bytes: number;
	publishedAt: string;
}

export interface CouncilTimestamps {
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	interruptedAt?: string;
}

export interface CouncilResolvedRosterMember {
	role: string;
	enabled: boolean;
	order: number;
	requestedSelector: string;
	resolvedModel: string;
	effort: string | null;
	lens: string;
}

export interface CouncilPlannerSnapshot {
	requestedSelector: string;
	resolvedModel: string;
	effort: string | null;
}

export interface CouncilMainSnapshot {
	model: string;
	effort: string | null;
	capturedAt: string;
	instructionSha256?: string;
}

export interface CouncilInstructionContextFile {
	path: string;
	content: string;
	depth?: number;
}

export interface CouncilInstructionFileRecord {
	path: string;
	sha256: string;
}

export interface CouncilInstructionSnapshot {
	repoRoot: string;
	contextFiles: CouncilInstructionContextFile[];
	files: CouncilInstructionFileRecord[];
	totalBytes: number;
}

export interface CouncilInstructionSnapshotReference {
	artifact: CouncilArtifactReference;
	sha256: string;
}

/** Durable slot state. Every field is explicit; filesystem presence never implies a phase or outcome. */
export interface CouncilRoundMemberRecord {
	role: string;
	order: number;
	status: CouncilMemberStatus;
	attempts: number;
	startedAt: string | null;
	finishedAt: string | null;
	artifact: CouncilArtifactReference | null;
	resolvedModel: string | null;
	authFallbackUsed: boolean;
	failureReason: string | null;
	findingIds: string[];
}

export interface CouncilRoundRecord {
	round: number;
	status: CouncilRoundStatus;
	startedAt: string | null;
	finishedAt: string | null;
	members: CouncilRoundMemberRecord[];
}

export interface CouncilPlanVersion {
	version: number;
	round: number;
	kind: "draft" | "round" | "final";
	artifact: CouncilArtifactReference;
	createdAt: string;
}

export interface CouncilUsage {
	requests: number;
	tokens: number;
	cost: number;
}

export interface CouncilAdjudicationBudget {
	injectedChars: number;
	cap: number;
}

export interface CouncilFailure {
	phase: string;
	reason: string;
	code?: string;
	time?: string;
}

/** Versioned source of truth for a council run. */
export interface CouncilManifestV1 {
	version: typeof COUNCIL_MANIFEST_VERSION;
	runId: string;
	sessionId: string;
	mainAgentId: string;
	state: CouncilRunState;
	task: string;
	repoRoot: string;
	/** Collision-free repo-relative promise, resolved before model spend. */
	outputPath: string;
	published?: CouncilPublishedArtifact;
	timestamps: CouncilTimestamps;
	config: CouncilConfig;
	roster: CouncilResolvedRosterMember[];
	planner: CouncilPlannerSnapshot;
	/** Informational only. Main is intentionally excluded from resume compatibility. */
	mainSnapshot: CouncilMainSnapshot;
	instructionSnapshot: CouncilInstructionSnapshotReference;
	rounds: CouncilRoundRecord[];
	planVersions: CouncilPlanVersion[];
	usage: CouncilUsage;
	adjudicationBudget: CouncilAdjudicationBudget;
	warnings: string[];
	degraded: boolean;
	failure?: CouncilFailure;
}

export type CouncilManifest = CouncilManifestV1;

const RUN_STATES: Record<CouncilRunState, true> = {
	dispatching: true,
	planning: true,
	reviewing: true,
	"awaiting-main": true,
	adjudicating: true,
	"round-transition": true,
	cancelling: true,
	interrupted: true,
	failed: true,
	completed: true,
	"completed-degraded": true,
};
const MEMBER_STATUSES: Record<CouncilMemberStatus, true> = {
	pending: true,
	running: true,
	succeeded: true,
	failed: true,
	cancelled: true,
	interrupted: true,
};
const ROUND_STATUSES: Record<CouncilRoundStatus, true> = {
	pending: true,
	running: true,
	settled: true,
	interrupted: true,
};
const PLAN_KINDS: Record<CouncilPlanVersion["kind"], true> = { draft: true, round: true, final: true };
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OUTPUT_PATH_PATTERN = /^plans\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

export class CouncilManifestError extends Error {
	readonly code = "COUNCIL_MANIFEST_CORRUPT";
	readonly spending = false;

	constructor(
		readonly field: string,
		message: string,
	) {
		super(`Council manifest ${field}: ${message}`);
		this.name = "CouncilManifestError";
	}
}

function invalid(field: string, message: string): never {
	throw new CouncilManifestError(field, message);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) invalid(field, "expected an object");
	return value;
}

function assertExactKeys(record: Record<string, unknown>, field: string, allowed: readonly string[]): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) invalid(`${field}.${key}`, "unknown field");
	}
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) invalid(field, "expected a non-empty string");
	return value;
}

function requireNullableString(value: unknown, field: string): string | null {
	if (value === null) return null;
	return requireString(value, field);
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") invalid(field, "expected a boolean");
	return value;
}

function requireCount(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		invalid(field, "expected a non-negative safe integer");
	}
	return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
	const count = requireCount(value, field);
	if (count === 0) invalid(field, "expected a positive safe integer");
	return count;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		invalid(field, "expected a finite non-negative number");
	}
	return value;
}

function requireTimestamp(value: unknown, field: string): string {
	const timestamp = requireString(value, field);
	const parsed = Date.parse(timestamp);
	if (!ISO_TIMESTAMP_PATTERN.test(timestamp) || Number.isNaN(parsed) || new Date(parsed).toISOString() !== timestamp) {
		invalid(field, "expected an ISO-8601 UTC timestamp");
	}
	return timestamp;
}

function requireNullableTimestamp(value: unknown, field: string): string | null {
	if (value === null) return null;
	return requireTimestamp(value, field);
}

function validateOptionalTimestamp(record: Record<string, unknown>, key: string, field: string): string | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	return requireTimestamp(record[key], `${field}.${key}`);
}

function requireSha256(value: unknown, field: string): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		invalid(field, "expected a lowercase SHA-256 digest");
	}
	return value;
}

function assertOrderedTimes(
	startedAt: string | null | undefined,
	finishedAt: string | null | undefined,
	field: string,
): void {
	if (startedAt && finishedAt && Date.parse(finishedAt) < Date.parse(startedAt)) {
		invalid(field, "finishedAt precedes startedAt");
	}
}

function validateArtifact(value: unknown, field: string, nullable = false): CouncilArtifactReference | null {
	if (nullable && value === null) return null;
	const artifact = requireRecord(value, field);
	assertExactKeys(artifact, field, ["url", "sha256", "bytes"]);
	const url = requireString(artifact.url, `${field}.url`);
	const sha256 = requireSha256(artifact.sha256, `${field}.sha256`);
	const bytes = requireCount(artifact.bytes, `${field}.bytes`);
	return { url, sha256, bytes };
}

function validateConfigMember(value: unknown, field: string, index: number): CouncilConfig["members"][number] {
	const member = requireRecord(value, field);
	assertExactKeys(member, field, ["role", "enabled", "order"]);
	const role = requireString(member.role, `${field}.role`);
	if (!COUNCIL_ROLE_ID.test(role)) invalid(`${field}.role`, "invalid council role identifier");
	const enabled = requireBoolean(member.enabled, `${field}.enabled`);
	const order = requireCount(member.order, `${field}.order`);
	if (order !== index) invalid(`${field}.order`, `expected ordered slot ${index}`);
	return { role, enabled, order };
}

function validateRosterMember(value: unknown, field: string): CouncilResolvedRosterMember {
	const member = requireRecord(value, field);
	assertExactKeys(member, field, ["role", "enabled", "order", "requestedSelector", "resolvedModel", "effort", "lens"]);
	const role = requireString(member.role, `${field}.role`);
	if (!COUNCIL_ROLE_ID.test(role)) invalid(`${field}.role`, "invalid council role identifier");
	return {
		role,
		enabled: requireBoolean(member.enabled, `${field}.enabled`),
		order: requireCount(member.order, `${field}.order`),
		requestedSelector: requireString(member.requestedSelector, `${field}.requestedSelector`),
		resolvedModel: requireString(member.resolvedModel, `${field}.resolvedModel`),
		effort: requireNullableString(member.effort, `${field}.effort`),
		lens: requireString(member.lens, `${field}.lens`),
	};
}

function validateInstructionPath(value: unknown, field: string, manifestRoot: string): string {
	const instructionPath = requireString(value, field);
	if (!path.isAbsolute(instructionPath)) invalid(field, "expected an absolute path");
	if (path.normalize(instructionPath) !== instructionPath) invalid(field, "expected a normalized path");
	const relative = path.relative(manifestRoot, instructionPath);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		invalid(field, "resolves outside manifest repoRoot");
	}
	return instructionPath;
}

export function parseCouncilInstructionSnapshot(value: unknown, manifestRoot: string): CouncilInstructionSnapshot {
	const snapshot = requireRecord(value, "instructionSnapshot");
	assertExactKeys(snapshot, "instructionSnapshot", ["repoRoot", "contextFiles", "files", "totalBytes"]);
	const snapshotRoot = requireString(snapshot.repoRoot, "instructionSnapshot.repoRoot");
	if (snapshotRoot !== manifestRoot) invalid("instructionSnapshot.repoRoot", "must equal repoRoot");
	if (!Array.isArray(snapshot.contextFiles)) invalid("instructionSnapshot.contextFiles", "expected an array");
	if (!Array.isArray(snapshot.files)) invalid("instructionSnapshot.files", "expected an array");

	const contents = new Map<string, string>();
	const contextFiles: CouncilInstructionContextFile[] = [];
	let totalBytes = 0;
	for (const [index, entryValue] of snapshot.contextFiles.entries()) {
		const field = `instructionSnapshot.contextFiles[${index}]`;
		const entry = requireRecord(entryValue, field);
		assertExactKeys(entry, field, ["path", "content", "depth"]);
		const entryPath = validateInstructionPath(entry.path, `${field}.path`, manifestRoot);
		if (contents.has(entryPath)) invalid(`${field}.path`, "duplicate instruction path");
		if (typeof entry.content !== "string") invalid(`${field}.content`, "expected a string");
		const depth = Object.hasOwn(entry, "depth") ? requireCount(entry.depth, `${field}.depth`) : undefined;
		contents.set(entryPath, entry.content);
		contextFiles.push({ path: entryPath, content: entry.content, ...(depth === undefined ? {} : { depth }) });
		totalBytes += Buffer.byteLength(entry.content);
		if (!Number.isSafeInteger(totalBytes))
			invalid("instructionSnapshot.totalBytes", "instruction contents exceed safe integer range");
	}

	const hashes = new Map<string, string>();
	const files: CouncilInstructionFileRecord[] = [];
	for (const [index, fileValue] of snapshot.files.entries()) {
		const field = `instructionSnapshot.files[${index}]`;
		const file = requireRecord(fileValue, field);
		assertExactKeys(file, field, ["path", "sha256"]);
		const filePath = validateInstructionPath(file.path, `${field}.path`, manifestRoot);
		if (hashes.has(filePath)) invalid(`${field}.path`, "duplicate instruction path");
		const digest = requireSha256(file.sha256, `${field}.sha256`);
		const content = contents.get(filePath);
		if (content === undefined) invalid(`${field}.path`, "has no corresponding context file");
		if (sha256CouncilContent(content) !== digest) invalid(`${field}.sha256`, "does not match captured content");
		hashes.set(filePath, digest);
		files.push({ path: filePath, sha256: digest });
	}
	for (const entryPath of contents.keys()) {
		if (!hashes.has(entryPath))
			invalid("instructionSnapshot.files", `missing hash record for ${JSON.stringify(entryPath)}`);
	}
	if (hashes.size !== contents.size)
		invalid("instructionSnapshot.files", "must correspond one-to-one with contextFiles");
	const declaredBytes = requireCount(snapshot.totalBytes, "instructionSnapshot.totalBytes");
	if (declaredBytes > DEFAULT_COUNCIL_INSTRUCTION_BYTES) {
		invalid(
			"instructionSnapshot.totalBytes",
			`exceeds ${DEFAULT_COUNCIL_INSTRUCTION_BYTES} byte council instruction limit`,
		);
	}
	if (declaredBytes !== totalBytes) invalid("instructionSnapshot.totalBytes", `expected ${totalBytes}`);
	return { repoRoot: snapshotRoot, contextFiles, files, totalBytes };
}

function validateInstructionSnapshotReference(value: unknown): string {
	const reference = requireRecord(value, "instructionSnapshot");
	assertExactKeys(reference, "instructionSnapshot", ["artifact", "sha256"]);
	const artifact = validateArtifact(reference.artifact, "instructionSnapshot.artifact");
	const digest = requireSha256(reference.sha256, "instructionSnapshot.sha256");
	if (!artifact || artifact.sha256 !== digest) {
		invalid("instructionSnapshot.sha256", "must match instructionSnapshot.artifact.sha256");
	}
	return digest;
}

function validateMemberRecord(
	value: unknown,
	field: string,
	rosterMember: CouncilResolvedRosterMember,
): CouncilMemberStatus {
	const member = requireRecord(value, field);
	assertExactKeys(member, field, [
		"role",
		"order",
		"status",
		"attempts",
		"startedAt",
		"finishedAt",
		"artifact",
		"resolvedModel",
		"authFallbackUsed",
		"failureReason",
		"findingIds",
	]);
	const role = requireString(member.role, `${field}.role`);
	const order = requireCount(member.order, `${field}.order`);
	if (role !== rosterMember.role || order !== rosterMember.order)
		invalid(field, "does not match the persisted roster slot");
	if (typeof member.status !== "string" || !Object.hasOwn(MEMBER_STATUSES, member.status)) {
		invalid(`${field}.status`, "unknown member status");
	}
	const status = member.status as CouncilMemberStatus;
	const attempts = requireCount(member.attempts, `${field}.attempts`);
	const startedAt = requireNullableTimestamp(member.startedAt, `${field}.startedAt`);
	const finishedAt = requireNullableTimestamp(member.finishedAt, `${field}.finishedAt`);
	const artifact = validateArtifact(member.artifact, `${field}.artifact`, true);
	const resolvedModel = requireNullableString(member.resolvedModel, `${field}.resolvedModel`);
	const authFallbackUsed = requireBoolean(member.authFallbackUsed, `${field}.authFallbackUsed`);
	const failureReason = requireNullableString(member.failureReason, `${field}.failureReason`);
	if (!Array.isArray(member.findingIds)) invalid(`${field}.findingIds`, "expected an array");
	const findingIds = new Set<string>();
	for (const [index, id] of member.findingIds.entries()) {
		const findingId = requireString(id, `${field}.findingIds[${index}]`);
		if (findingIds.has(findingId)) invalid(`${field}.findingIds[${index}]`, "duplicate finding id");
		findingIds.add(findingId);
	}
	assertOrderedTimes(startedAt, finishedAt, field);

	if (status === "pending") {
		if (attempts !== 0 || startedAt !== null || finishedAt !== null || artifact !== null || resolvedModel !== null) {
			invalid(field, "pending member has attempt, timestamp, model, or artifact state");
		}
		if (authFallbackUsed || failureReason !== null || findingIds.size !== 0)
			invalid(field, "pending member has terminal metadata");
	} else if (status === "running") {
		if (attempts === 0 || startedAt === null || finishedAt !== null || artifact !== null || failureReason !== null) {
			invalid(field, "running member has inconsistent attempts, timestamps, artifact, or failure");
		}
		if (findingIds.size !== 0) invalid(`${field}.findingIds`, "running member cannot have findings");
	} else if (status === "succeeded") {
		if (attempts === 0 || startedAt === null || finishedAt === null || artifact === null || resolvedModel === null) {
			invalid(field, "succeeded member requires attempts, timestamps, artifact, and resolvedModel");
		}
		if (failureReason !== null) invalid(`${field}.failureReason`, "succeeded member cannot have a failure reason");
		if (authFallbackUsed)
			invalid(`${field}.authFallbackUsed`, "succeeded member cannot use an authentication fallback");
		if (resolvedModel !== rosterMember.resolvedModel && !resolvedModel.startsWith(`${rosterMember.resolvedModel}:`)) {
			invalid(`${field}.resolvedModel`, `does not match pinned roster model ${rosterMember.resolvedModel}`);
		}
	} else if (status === "failed") {
		if (attempts === 0 || startedAt === null || finishedAt === null || artifact !== null || failureReason === null) {
			invalid(field, "failed member requires attempts, timestamps, and failureReason but no artifact");
		}
		if (findingIds.size !== 0) invalid(`${field}.findingIds`, "failed member cannot have findings");
	} else {
		if (finishedAt === null || artifact !== null || findingIds.size !== 0) {
			invalid(field, `${status} member requires finishedAt and cannot have an artifact or findings`);
		}
		if ((attempts === 0) !== (startedAt === null)) invalid(field, "attempts and startedAt disagree");
	}
	return status;
}

function validateRoundRecord(
	value: unknown,
	field: string,
	roundIndex: number,
	roster: readonly CouncilResolvedRosterMember[],
): CouncilRoundStatus {
	const round = requireRecord(value, field);
	assertExactKeys(round, field, ["round", "status", "startedAt", "finishedAt", "members"]);
	const roundNumber = requirePositiveInteger(round.round, `${field}.round`);
	if (roundNumber !== roundIndex + 1) invalid(`${field}.round`, `expected ordered round ${roundIndex + 1}`);
	if (typeof round.status !== "string" || !Object.hasOwn(ROUND_STATUSES, round.status)) {
		invalid(`${field}.status`, "unknown round status");
	}
	const status = round.status as CouncilRoundStatus;
	const startedAt = requireNullableTimestamp(round.startedAt, `${field}.startedAt`);
	const finishedAt = requireNullableTimestamp(round.finishedAt, `${field}.finishedAt`);
	assertOrderedTimes(startedAt, finishedAt, field);
	if (!Array.isArray(round.members)) invalid(`${field}.members`, "expected an array");
	if (round.members.length !== roster.length)
		invalid(`${field}.members`, "must contain each roster slot exactly once");
	const memberStatuses = round.members.map((member, index) =>
		validateMemberRecord(member, `${field}.members[${index}]`, roster[index]!),
	);

	if (status === "pending") {
		if (startedAt !== null || finishedAt !== null || memberStatuses.some(member => member !== "pending")) {
			invalid(field, "pending round has timestamps or non-pending members");
		}
	} else if (status === "running") {
		if (startedAt === null || finishedAt !== null)
			invalid(field, "running round requires startedAt and no finishedAt");
		if (!memberStatuses.some(member => member === "running")) invalid(field, "running round has no running member");
	} else if (status === "settled") {
		if (startedAt === null || finishedAt === null) invalid(field, "settled round requires startedAt and finishedAt");
		if (memberStatuses.some(member => member === "pending" || member === "running")) {
			invalid(field, "settled round has an active member");
		}
	} else {
		if (startedAt === null || finishedAt === null)
			invalid(field, "interrupted round requires startedAt and finishedAt");
		if (memberStatuses.some(member => member === "running")) invalid(field, "interrupted round has a running member");
	}
	return status;
}

export function isValidCouncilOutputPath(value: string): boolean {
	const match = OUTPUT_PATH_PATTERN.exec(value);
	if (!match) return false;
	const slug = match[1]!;
	return slug.length <= 80 && slug !== "plan" && !slug.endsWith("-plan");
}

function validateOutputPath(value: unknown): string {
	const outputPath = requireString(value, "outputPath");
	if (!isValidCouncilOutputPath(outputPath)) {
		invalid("outputPath", "expected plans/<lowercase-kebab-slug>.md with a 1..80 character slug not ending in -plan");
	}
	return outputPath;
}

/** Strictly parses the durable envelope. Referenced artifact content is verified by CouncilStorage.load. */
export function parseCouncilManifest(value: unknown): CouncilManifest {
	const manifest = requireRecord(value, "root");
	assertExactKeys(manifest, "root", [
		"version",
		"runId",
		"sessionId",
		"mainAgentId",
		"state",
		"task",
		"repoRoot",
		"outputPath",
		"published",
		"timestamps",
		"config",
		"roster",
		"planner",
		"mainSnapshot",
		"instructionSnapshot",
		"rounds",
		"planVersions",
		"usage",
		"adjudicationBudget",
		"warnings",
		"degraded",
		"failure",
	]);
	if (manifest.version !== COUNCIL_MANIFEST_VERSION) {
		invalid("version", `expected ${COUNCIL_MANIFEST_VERSION}, received ${String(manifest.version)}`);
	}
	for (const field of ["runId", "sessionId", "mainAgentId", "task"] as const) requireString(manifest[field], field);
	requireString(manifest.repoRoot, "repoRoot");
	const outputPath = validateOutputPath(manifest.outputPath);
	if (typeof manifest.state !== "string" || !Object.hasOwn(RUN_STATES, manifest.state))
		invalid("state", "unknown run state");
	const state = manifest.state as CouncilRunState;

	const timestamps = requireRecord(manifest.timestamps, "timestamps");
	assertExactKeys(timestamps, "timestamps", ["createdAt", "updatedAt", "startedAt", "finishedAt", "interruptedAt"]);
	const createdAt = requireTimestamp(timestamps.createdAt, "timestamps.createdAt");
	const updatedAt = requireTimestamp(timestamps.updatedAt, "timestamps.updatedAt");
	const startedAt = validateOptionalTimestamp(timestamps, "startedAt", "timestamps");
	const finishedAt = validateOptionalTimestamp(timestamps, "finishedAt", "timestamps");
	const interruptedAt = validateOptionalTimestamp(timestamps, "interruptedAt", "timestamps");
	if (Date.parse(updatedAt) < Date.parse(createdAt)) invalid("timestamps.updatedAt", "precedes createdAt");
	assertOrderedTimes(startedAt, finishedAt, "timestamps");

	if (Object.hasOwn(manifest, "published")) {
		const published = requireRecord(manifest.published, "published");
		assertExactKeys(published, "published", ["path", "sha256", "bytes", "publishedAt"]);
		if (requireString(published.path, "published.path") !== outputPath)
			invalid("published.path", "must equal outputPath");
		requireSha256(published.sha256, "published.sha256");
		requireCount(published.bytes, "published.bytes");
		requireTimestamp(published.publishedAt, "published.publishedAt");
	}

	const config = requireRecord(manifest.config, "config");
	assertExactKeys(config, "config", ["rounds", "members"]);
	if (config.rounds !== 1 && config.rounds !== 2) invalid("config.rounds", "expected 1 or 2");
	if (!Array.isArray(config.members)) invalid("config.members", "expected an array");
	const configuredRoles = new Set<string>();
	const configMembers = config.members.map((member, index) => {
		const validated = validateConfigMember(member, `config.members[${index}]`, index);
		if (configuredRoles.has(validated.role)) invalid(`config.members[${index}].role`, "duplicate role");
		configuredRoles.add(validated.role);
		return validated;
	});

	if (!Array.isArray(manifest.roster)) invalid("roster", "expected an array");
	const roster = manifest.roster.map((member, index) => validateRosterMember(member, `roster[${index}]`));
	const enabledConfigMembers = configMembers.filter(member => member.enabled);
	if (roster.length !== enabledConfigMembers.length)
		invalid("roster", "must contain every enabled config slot exactly once");
	for (const [index, member] of roster.entries()) {
		const configured = enabledConfigMembers[index]!;
		if (!member.enabled || member.role !== configured.role || member.order !== configured.order) {
			invalid(`roster[${index}]`, "role, enabled, or order does not match enabled config slot");
		}
		if (index > 0 && roster[index - 1]!.order >= member.order)
			invalid(`roster[${index}].order`, "roster slots are not ordered");
	}

	const planner = requireRecord(manifest.planner, "planner");
	assertExactKeys(planner, "planner", ["requestedSelector", "resolvedModel", "effort"]);
	requireString(planner.requestedSelector, "planner.requestedSelector");
	requireString(planner.resolvedModel, "planner.resolvedModel");
	requireNullableString(planner.effort, "planner.effort");

	const mainSnapshot = requireRecord(manifest.mainSnapshot, "mainSnapshot");
	assertExactKeys(mainSnapshot, "mainSnapshot", ["model", "effort", "capturedAt", "instructionSha256"]);
	requireString(mainSnapshot.model, "mainSnapshot.model");
	requireNullableString(mainSnapshot.effort, "mainSnapshot.effort");
	requireTimestamp(mainSnapshot.capturedAt, "mainSnapshot.capturedAt");
	const mainInstructionSha = Object.hasOwn(mainSnapshot, "instructionSha256")
		? requireSha256(mainSnapshot.instructionSha256, "mainSnapshot.instructionSha256")
		: undefined;
	const instructionSha = validateInstructionSnapshotReference(manifest.instructionSnapshot);
	if (mainInstructionSha !== undefined && mainInstructionSha !== instructionSha) {
		invalid("mainSnapshot.instructionSha256", "must match instructionSnapshot.sha256");
	}

	if (!Array.isArray(manifest.rounds)) invalid("rounds", "expected an array");
	if (manifest.rounds.length !== config.rounds) invalid("rounds", `expected ${config.rounds} ordered round records`);
	const roundStatuses = manifest.rounds.map((round, index) =>
		validateRoundRecord(round, `rounds[${index}]`, index, roster),
	);
	if (isCouncilTerminalState(state) && roundStatuses.some(status => status === "running")) {
		invalid("rounds", "terminal run cannot contain an active round");
	}

	if (!Array.isArray(manifest.planVersions)) invalid("planVersions", "expected an array");
	const canonicalPlanSequence: ReadonlyArray<Pick<CouncilPlanVersion, "round" | "kind">> =
		config.rounds === 1
			? [
					{ round: 0, kind: "draft" },
					{ round: 1, kind: "final" },
				]
			: [
					{ round: 0, kind: "draft" },
					{ round: 1, kind: "round" },
					{ round: 2, kind: "final" },
				];
	if (manifest.planVersions.length > canonicalPlanSequence.length) {
		invalid("planVersions", `exceeds canonical ${config.rounds}-round sequence length`);
	}
	for (const [index, versionValue] of manifest.planVersions.entries()) {
		const field = `planVersions[${index}]`;
		const version = requireRecord(versionValue, field);
		assertExactKeys(version, field, ["version", "round", "kind", "artifact", "createdAt"]);
		const versionNumber = requirePositiveInteger(version.version, `${field}.version`);
		if (versionNumber !== index + 1) invalid(`${field}.version`, `expected ordered version ${index + 1}`);
		const round = requireCount(version.round, `${field}.round`);
		if (typeof version.kind !== "string" || !Object.hasOwn(PLAN_KINDS, version.kind))
			invalid(`${field}.kind`, "unknown plan kind");
		const kind = version.kind as CouncilPlanVersion["kind"];
		const expected = canonicalPlanSequence[index]!;
		if (round !== expected.round || kind !== expected.kind) {
			invalid(field, `expected canonical ${expected.kind} version for round ${expected.round}`);
		}
		validateArtifact(version.artifact, `${field}.artifact`);
		requireTimestamp(version.createdAt, `${field}.createdAt`);
	}

	const usage = requireRecord(manifest.usage, "usage");
	assertExactKeys(usage, "usage", ["requests", "tokens", "cost"]);
	requireCount(usage.requests, "usage.requests");
	requireCount(usage.tokens, "usage.tokens");
	requireNonNegativeNumber(usage.cost, "usage.cost");
	const budget = requireRecord(manifest.adjudicationBudget, "adjudicationBudget");
	assertExactKeys(budget, "adjudicationBudget", ["injectedChars", "cap"]);
	const injectedChars = requireCount(budget.injectedChars, "adjudicationBudget.injectedChars");
	const cap = requireCount(budget.cap, "adjudicationBudget.cap");
	if (injectedChars > cap) invalid("adjudicationBudget.injectedChars", "exceeds cap");
	if (!Array.isArray(manifest.warnings)) invalid("warnings", "expected an array");
	for (const [index, warning] of manifest.warnings.entries()) requireString(warning, `warnings[${index}]`);
	const degraded = requireBoolean(manifest.degraded, "degraded");

	if (Object.hasOwn(manifest, "failure")) {
		const failure = requireRecord(manifest.failure, "failure");
		assertExactKeys(failure, "failure", ["phase", "reason", "code", "time"]);
		requireString(failure.phase, "failure.phase");
		requireString(failure.reason, "failure.reason");
		if (Object.hasOwn(failure, "code")) requireString(failure.code, "failure.code");
		if (Object.hasOwn(failure, "time")) requireTimestamp(failure.time, "failure.time");
	}
	const completed = state === "completed" || state === "completed-degraded";
	if (completed) {
		if (roundStatuses.some(status => status !== "settled")) {
			invalid("rounds", "completed run requires every round to be settled");
		}
		if (manifest.planVersions.length !== canonicalPlanSequence.length) {
			invalid("planVersions", "completed run requires the full canonical version sequence");
		}
		if (!Object.hasOwn(manifest, "published")) {
			invalid("published", "completed run requires a published record matching outputPath");
		}
	}

	if (isCouncilTerminalState(state)) {
		if (!finishedAt) invalid("timestamps.finishedAt", "terminal run requires finishedAt");
	} else if (finishedAt || interruptedAt) {
		invalid("timestamps", "nonterminal run cannot have finishedAt or interruptedAt");
	}
	if (state === "interrupted" && (!interruptedAt || interruptedAt !== finishedAt)) {
		invalid("timestamps.interruptedAt", "interrupted run requires matching interruptedAt and finishedAt");
	}
	if (state === "failed" && !Object.hasOwn(manifest, "failure"))
		invalid("failure", "failed run requires failure details");
	if (state === "completed" && degraded) invalid("degraded", "completed run cannot be degraded");
	if (state === "completed-degraded" && !degraded) invalid("degraded", "completed-degraded run must be degraded");
	return manifest as unknown as CouncilManifest;
}

export function isCouncilTerminalState(state: CouncilRunState): state is CouncilTerminalRunState {
	return state === "interrupted" || state === "failed" || state === "completed" || state === "completed-degraded";
}

/** Recovery is inert: every unfinished state becomes interrupted and no phase is inferred from artifacts. */
export function normalizeRecoveredCouncilManifest(
	manifest: CouncilManifest,
	now = new Date().toISOString(),
): CouncilManifest {
	if (isCouncilTerminalState(manifest.state)) return structuredClone(manifest);
	const recovered = structuredClone(manifest);
	recovered.state = "interrupted";
	recovered.timestamps.updatedAt = now;
	recovered.timestamps.finishedAt = now;
	recovered.timestamps.interruptedAt = now;
	for (const round of recovered.rounds) {
		if (round.status === "running") {
			round.status = "interrupted";
			round.finishedAt = now;
		}
		for (const member of round.members) {
			if (member.status === "running") {
				member.status = "interrupted";
				member.finishedAt = now;
			}
		}
	}
	return recovered;
}

export interface CouncilResumeIdentity {
	roster: readonly CouncilResolvedRosterMember[];
	planner: CouncilPlannerSnapshot;
}

/** Main is deliberately absent: changing Main does not make an otherwise identical run incompatible. */
export function isCouncilResumeCompatible(
	manifest: Pick<CouncilManifest, "roster" | "planner">,
	candidate: CouncilResumeIdentity,
): boolean {
	if (manifest.roster.length !== candidate.roster.length) return false;
	for (const [index, persisted] of manifest.roster.entries()) {
		const current = candidate.roster[index];
		if (
			!current ||
			persisted.role !== current.role ||
			persisted.order !== current.order ||
			persisted.requestedSelector !== current.requestedSelector ||
			persisted.resolvedModel !== current.resolvedModel ||
			persisted.effort !== current.effort ||
			persisted.lens !== current.lens
		) {
			return false;
		}
	}
	return (
		manifest.planner.requestedSelector === candidate.planner.requestedSelector &&
		manifest.planner.resolvedModel === candidate.planner.resolvedModel &&
		manifest.planner.effort === candidate.planner.effort
	);
}

export function councilManifestArtifactReferences(manifest: CouncilManifest): CouncilArtifactReference[] {
	return [
		manifest.instructionSnapshot.artifact,
		...manifest.planVersions.map(version => version.artifact),
		...manifest.rounds.flatMap(round => round.members.flatMap(member => (member.artifact ? [member.artifact] : []))),
	];
}
