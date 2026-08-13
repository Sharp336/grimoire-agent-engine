import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRoutingAuditLogPath, isEnoent } from "@oh-my-pi/pi-utils";

const ROUTING_AUDIT_VERSION = 1 as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:api.?key|authorization|credential|password|private.?key|secret|token)/i;
const SENSITIVE_VALUE_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
	/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{12,}\b/g,
] as const;

export type RoutingAuditJson = null | boolean | number | string | RoutingAuditJson[] | { [key: string]: RoutingAuditJson };
export type RoutingAuditObject = { [key: string]: RoutingAuditJson };

/** Credential-free, normalized routing state recorded before and after an audit event. */
export interface RouteSnapshot {
	modelRoles?: Record<string, string>;
	enabledModels?: string[];
	disabledProviders?: string[];
	cycleOrder?: string[];
	retry?: {
		modelFallback: boolean;
		usageAwareFallback: boolean;
		usageReservePct: number;
	};
}

interface RoutingAuditRecordBase {
	version: 1;
	decisionId: string;
	timestamp: string;
	evidence: RoutingAuditObject;
	thresholds: RoutingAuditObject;
	before: RouteSnapshot;
	after: RouteSnapshot;
}

export interface RoutingDecisionRecord extends RoutingAuditRecordBase {
	kind: "decision";
}

export interface ExternalRouteChangeRecord extends RoutingAuditRecordBase {
	kind: "external_change";
	source: string;
}

export type RoutingAuditRecord = RoutingDecisionRecord | ExternalRouteChangeRecord;

export interface RoutingDecisionInput {
	evidence: Record<string, unknown>;
	thresholds: Record<string, unknown>;
	before: RouteSnapshot;
	after: RouteSnapshot;
}

export interface RoutingAuditOptions {
	logPath?: string;
}

const WRITE_CHAINS = new Map<string, Promise<unknown>>();

function redactString(value: string): string {
	let redacted = value;
	for (const pattern of SENSITIVE_VALUE_PATTERNS) redacted = redacted.replace(pattern, REDACTED);
	return redacted;
}

function sanitizeJson(value: unknown, key?: string): RoutingAuditJson | undefined {
	if (key && SENSITIVE_KEY.test(key)) return REDACTED;
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) {
		return value.map(item => sanitizeJson(item)).filter((item): item is RoutingAuditJson => item !== undefined);
	}
	if (!value || typeof value !== "object") return undefined;

	const sanitized: RoutingAuditObject = {};
	for (const [childKey, childValue] of Object.entries(value)) {
		const next = sanitizeJson(childValue, childKey);
		if (next !== undefined) sanitized[childKey] = next;
	}
	return sanitized;
}

function sanitizeObject(value: Record<string, unknown>): RoutingAuditObject {
	const sanitized = sanitizeJson(value);
	return sanitized && !Array.isArray(sanitized) && typeof sanitized === "object" ? sanitized : {};
}

function normalizeStringSet(values: readonly string[] | undefined): string[] | undefined {
	if (!values) return undefined;
	return [...new Set(values.filter(Boolean).map(redactString))].sort();
}

/** Canonicalize route state so ordering-only changes do not create audit noise. */
export function normalizeRouteSnapshot(snapshot: RouteSnapshot): RouteSnapshot {
	const normalized: RouteSnapshot = {};
	if (snapshot.modelRoles) {
		normalized.modelRoles = Object.fromEntries(
			Object.entries(snapshot.modelRoles)
				.filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
				.map(([role, model]) => [role, redactString(model)])
				.sort(([left], [right]) => left.localeCompare(right)),
		);
	}
	const enabledModels = normalizeStringSet(snapshot.enabledModels);
	if (enabledModels) normalized.enabledModels = enabledModels;
	const disabledProviders = normalizeStringSet(snapshot.disabledProviders);
	if (disabledProviders) normalized.disabledProviders = disabledProviders;
	if (snapshot.cycleOrder) normalized.cycleOrder = snapshot.cycleOrder.map(redactString);
	if (snapshot.retry) normalized.retry = { ...snapshot.retry };
	return normalized;
}

export function routeSnapshotsEqual(left: RouteSnapshot, right: RouteSnapshot): boolean {
	return JSON.stringify(normalizeRouteSnapshot(left)) === JSON.stringify(normalizeRouteSnapshot(right));
}

async function appendRecord(record: RoutingAuditRecord, logPath: string): Promise<void> {
	const resolvedPath = path.resolve(logPath);
	const operation = async (): Promise<void> => {
		await fs.mkdir(path.dirname(resolvedPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		const file = await fs.open(resolvedPath, "a", PRIVATE_FILE_MODE);
		try {
			await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		} finally {
			await file.close();
		}
	};
	const run = (WRITE_CHAINS.get(resolvedPath) ?? Promise.resolve()).then(operation);
	const guarded = run.catch(() => undefined);
	WRITE_CHAINS.set(resolvedPath, guarded);
	try {
		await run;
	} finally {
		if (WRITE_CHAINS.get(resolvedPath) === guarded) WRITE_CHAINS.delete(resolvedPath);
	}
}

/** Append an observe-only routing decision and return its newly minted audit id. */
export async function appendRoutingDecision(
	input: RoutingDecisionInput,
	options: RoutingAuditOptions = {},
): Promise<string> {
	const decisionId = randomUUID();
	const record: RoutingDecisionRecord = {
		version: ROUTING_AUDIT_VERSION,
		kind: "decision",
		decisionId,
		timestamp: new Date().toISOString(),
		evidence: sanitizeObject(input.evidence),
		thresholds: sanitizeObject(input.thresholds),
		before: normalizeRouteSnapshot(input.before),
		after: normalizeRouteSnapshot(input.after),
	};
	await appendRecord(record, options.logPath ?? getRoutingAuditLogPath());
	return decisionId;
}

/** Append a normalized settings-route change without changing any route configuration. */
export async function appendExternalRouteChange(
	before: RouteSnapshot,
	after: RouteSnapshot,
	source: string,
	options: RoutingAuditOptions = {},
): Promise<string | undefined> {
	const normalizedBefore = normalizeRouteSnapshot(before);
	const normalizedAfter = normalizeRouteSnapshot(after);
	if (routeSnapshotsEqual(normalizedBefore, normalizedAfter)) return undefined;

	const decisionId = randomUUID();
	const record: ExternalRouteChangeRecord = {
		version: ROUTING_AUDIT_VERSION,
		kind: "external_change",
		decisionId,
		timestamp: new Date().toISOString(),
		evidence: { detection: "normalized_route_snapshot_diff" },
		thresholds: {},
		before: normalizedBefore,
		after: normalizedAfter,
		source: redactString(source),
	};
	await appendRecord(record, options.logPath ?? getRoutingAuditLogPath());
	return decisionId;
}

function isRoutingAuditRecord(value: unknown): value is RoutingAuditRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === ROUTING_AUDIT_VERSION &&
		(record.kind === "decision" || record.kind === "external_change") &&
		typeof record.decisionId === "string" &&
		typeof record.timestamp === "string"
	);
}

/** Read complete valid records, tolerating a missing file and an incomplete final append. */
export async function readRoutingAuditLog(options: RoutingAuditOptions = {}): Promise<RoutingAuditRecord[]> {
	const logPath = options.logPath ?? getRoutingAuditLogPath();
	let content: string;
	try {
		content = await Bun.file(logPath).text();
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}

	const completeLength = content.lastIndexOf("\n");
	if (completeLength < 0) return [];
	const records: RoutingAuditRecord[] = [];
	for (const line of content.slice(0, completeLength).split("\n")) {
		if (!line) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isRoutingAuditRecord(value)) records.push(value);
		} catch {
			// A malformed line is not allowed to hide later complete audit records.
		}
	}
	return records;
}
