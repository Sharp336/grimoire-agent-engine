import {
	getMessageByEntryId,
	getMessageById,
	getObservabilityDecision,
	getObservabilityRun,
	getObservabilityRunIdsForSession,
	getObservabilitySession,
	getToolStatsForSessionFiles,
	initDb,
	listMessagesForSessionFiles,
	listObservabilityRelatedTranscripts,
	listObservabilityRuns,
	listObservabilitySessions,
	listObservabilityTimeline,
	summarizeMessagesForSessionFiles,
	type ObservabilityRunRow,
	type ObservabilitySessionRow,
	type ObservabilityTimelineRow,
} from "./db";
import { getSessionEntry } from "./parser";
import type {
	HardRedaction,
	ObservabilityFreshness,
	ObservabilityOutcome,
	ObservabilityPage,
	ObservabilityRequest,
	RoutingDecision,
	RunDetail,
	RunSummary,
	SessionDetail,
	SessionSummary,
	SessionUsageSummary,
	TimelineItem,
	ToolUsageStats,
} from "./shared-types";
import type { MessageStats } from "./types";

const HARD: HardRedaction = { redacted: "hard", reason: "credential" };
const UNKNOWN: ObservabilityOutcome = {
	execution: "unknown",
	contract: "unknown",
	verification: "unknown",
	humanAcceptance: "unknown",
};
const CREDENTIAL_KEYS = new Set(["apikey", "authorization", "password", "secret", "token", "privatekey", "credential"]);
const SOFT_KEYS = new Set([
	"prompt", "prompts", "response", "responses", "assistanttext", "assistantmessage", "toolargs", "arguments", "args",
	"toolresult", "toolresults", "result", "results", "output", "outputs", "email", "emails", "cwd", "path", "filepath", "sessionfile",
]);
const PEM = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/i;
const AUTH = /(?:authorization\s*[:=]\s*|\b(?:bearer|basic)\s+)[^\s,;}]+/i;
const NAMED_SECRET = /\b(?:api[_-]?key|password|secret|token|private[_-]?key|credential)\s*[:=]\s*[^\s,;}]+/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PRIVATE_PATH = /(?:^|[\s"'])(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+)(?:\/[^\s"']*)?/;

export class ObservabilityQueryError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = "ObservabilityQueryError";
		this.status = status;
	}
}

function credentialKey(key: string): boolean {
	const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
	if (CREDENTIAL_KEYS.has(normalized)) return true;
	return normalized.endsWith("token") && !/^(?:input|output|cache|total|reasoning)tokens?$/.test(normalized);
}

export function hardRedact(value: unknown): unknown {
	const seen = new WeakSet<object>();
	const visit = (candidate: unknown, key?: string): unknown => {
		if (key && credentialKey(key)) return { ...HARD };
		if (typeof candidate === "string") return PEM.test(candidate) || AUTH.test(candidate) || NAMED_SECRET.test(candidate) ? { ...HARD } : candidate;
		if (candidate === null || typeof candidate !== "object") return candidate;
		if (candidate instanceof Error) return visit(candidate.message);
		if (seen.has(candidate)) return "[Circular]";
		seen.add(candidate);
		if (Array.isArray(candidate)) return candidate.map(item => visit(item));
		const output: Record<string, unknown> = {};
		for (const [childKey, child] of Object.entries(candidate)) output[childKey] = visit(child, childKey);
		return output;
	};
	return visit(value);
}

export function toJsonSafe(value: unknown): unknown {
	try {
		return JSON.parse(JSON.stringify(hardRedact(value))) as unknown;
	} catch {
		return { error: "Internal error" };
	}
}

interface SoftResult { value: unknown; available: string[] }
function redactSoft(value: unknown, reveal: ReadonlySet<string> = new Set(), root = ""): SoftResult {
	const available = new Set<string>();
	const visit = (candidate: unknown, path: string, key = ""): unknown => {
		const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
		const selected = reveal.has(path) || reveal.has(key);
		const privateString = typeof candidate === "string" && (EMAIL.test(candidate) || PRIVATE_PATH.test(candidate));
		if ((SOFT_KEYS.has(normalized) || privateString) && !selected) {
			available.add(path || key || "value");
			return undefined;
		}
		if (candidate === null || typeof candidate !== "object") return candidate;
		if (Array.isArray(candidate)) return candidate.map((item, i) => visit(item, path ? `${path}.${i}` : String(i))).filter(item => item !== undefined);
		const output: Record<string, unknown> = {};
		for (const [childKey, child] of Object.entries(candidate)) {
			const childPath = path ? `${path}.${childKey}` : childKey;
			const result = visit(child, childPath, childKey);
			if (result !== undefined) output[childKey] = result;
		}
		return output;
	};
	return { value: visit(hardRedact(value), root), available: [...available].sort() };
}

interface CursorPayload {
	v: 1; kind: string; id: string; generation: number; lastEntryId: string; lastTimestamp: number; indexedThrough: number;
}
function encodeCursor(cursor: CursorPayload): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function decodeCursor(value: string, kind: string, id: string): CursorPayload {
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
		if (parsed.v !== 1 || parsed.kind !== kind || parsed.id !== id || typeof parsed.generation !== "number" ||
			typeof parsed.lastEntryId !== "string" || typeof parsed.lastTimestamp !== "number" || typeof parsed.indexedThrough !== "number") {
			throw new Error("shape");
		}
		return parsed as unknown as CursorPayload;
	} catch {
		throw new ObservabilityQueryError("Invalid cursor");
	}
}

export interface PageOptions { limit?: number; after?: string; before?: string }
function pageLimit(options: PageOptions, fallback: number, max: number): number {
	if (options.after && options.before) throw new ObservabilityQueryError("after and before are mutually exclusive");
	const limit = options.limit ?? fallback;
	if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new ObservabilityQueryError(`limit must be between 1 and ${max}`);
	return limit;
}
function freshness(rows: ObservabilitySessionRow[], indexedAt = 0): ObservabilityFreshness {
	if (rows.length === 0) return { indexedAt, indexedThrough: 0, sourceModifiedAt: 0, sourceSize: 0, generation: 0 };
	return {
		indexedAt: Math.max(...rows.map(row => row.indexedAt)),
		indexedThrough: Math.min(...rows.map(row => row.indexedThrough)),
		sourceModifiedAt: Math.max(...rows.map(row => row.sourceMtime)),
		sourceSize: rows.reduce((sum, row) => sum + row.sourceSize, 0),
		generation: Math.max(...rows.map(row => row.generation)),
	};
}
function parsePayload(json: string): unknown {
	try { return JSON.parse(json) as unknown; } catch { return {}; }
}
function outcome(rows: ObservabilityTimelineRow[]): ObservabilityOutcome {
	const result = { ...UNKNOWN };
	for (const row of rows) {
		if (row.kind !== "outcome") continue;
		const payload = parsePayload(row.payloadJson);
		if (!payload || typeof payload !== "object") continue;
		for (const axis of ["execution", "contract", "verification", "humanAcceptance"] as const) {
			const key = axis === "humanAcceptance" && !(axis in payload) ? "human_acceptance" : axis;
			const value = key in payload ? payload[key as keyof typeof payload] : undefined;
			if (typeof value === "string") result[axis] = value;
		}
	}
	return result;
}
function sessionSummary(row: ObservabilitySessionRow): SessionSummary {
	const timeline = listObservabilityTimeline({ sessionId: row.id });
	return {
		sessionId: row.id, executionId: row.id, folder: row.folder, title: row.title, status: row.status,
		startedAt: row.startedAt, endedAt: row.endedAt, outcome: outcome(timeline),
		softAvailable: [...new Set(timeline.flatMap(item => redactSoft(parsePayload(item.payloadJson)).available))].sort(),
		...freshness([row]),
	};
}
function rangeStart(range?: string | null): number | undefined {
	if (!range || range === "all") return undefined;
	const match = /^(\d+)(h|d)$/.exec(range);
	if (!match) throw new ObservabilityQueryError("Invalid range");
	return Date.now() - Number(match[1]) * (match[2] === "h" ? 3_600_000 : 86_400_000);
}

export interface SessionListOptions extends PageOptions {
	range?: string | null; status?: string | null; project?: string | null; failure?: boolean; q?: string | null;
}
export async function listSessions(options: SessionListOptions = {}): Promise<ObservabilityPage<SessionSummary>> {
	await initDb();
	const limit = pageLimit(options, 20, 100);
	const rows = listObservabilitySessions({
		status: options.status || undefined, project: options.project || undefined, q: options.q || undefined,
		failure: options.failure, since: rangeStart(options.range),
	});
	const meta = freshness(rows);
	const cursor = options.after || options.before ? decodeCursor((options.after ?? options.before)!, "sessions", "*") : undefined;
	if (cursor && cursor.generation !== meta.generation) return { items: [], truncated: true, softAvailable: [], ...meta };
	let start = 0;
	if (cursor) {
		const index = rows.findIndex(row => row.id === cursor.lastEntryId && row.startedAt === cursor.lastTimestamp);
		start = index < 0 ? rows.length : options.after ? index + 1 : Math.max(0, index - limit);
	}
	const selected = rows.slice(start, start + limit);
	const items = selected.map(sessionSummary);
	const last = selected.at(-1);
	return {
		items, truncated: start > 0 || start + selected.length < rows.length,
		softAvailable: [...new Set(items.flatMap(item => item.softAvailable))].sort(), ...meta,
		...(last && start + selected.length < rows.length ? { nextCursor: encodeCursor({ v: 1, kind: "sessions", id: "*", generation: meta.generation, lastEntryId: last.id, lastTimestamp: last.startedAt, indexedThrough: meta.indexedThrough }) } : {}),
	};
}
export async function getSession(sessionId: string): Promise<SessionDetail | null> {
	await initDb();
	const row = getObservabilitySession(sessionId);
	if (!row) return null;
	return {
		...sessionSummary(row),
		truncated: row.indexedThrough < row.sourceSize,
		runIds: getObservabilityRunIdsForSession(sessionId),
		relatedExecutions: listObservabilityRelatedTranscripts(sessionId),
		usage: summarizeMessagesForSessionFiles([row.sessionFile]),
	};
}

function runSummary(row: ObservabilityRunRow): RunSummary {
	const sessions = row.sessionIds.map(id => getObservabilitySession(id)).filter((item): item is ObservabilitySessionRow => item !== null);
	const timeline = listObservabilityTimeline({ runId: row.runId });
	return {
		runId: row.runId, startedAt: row.startedAt, sessionIds: row.sessionIds, executionIds: sessions.map(item => item.id),
		status: sessions.length > 0 && sessions.every(item => item.status !== "active") ? "completed" : "active",
		outcome: outcome(timeline),
		softAvailable: [...new Set(timeline.flatMap(item => redactSoft(parsePayload(item.payloadJson)).available))].sort(),
		...freshness(sessions, row.indexedAt),
	};
}
export interface RunListOptions extends PageOptions {
	range?: string | null; status?: string | null; project?: string | null; failure?: boolean; q?: string | null;
}
export async function listRuns(options: RunListOptions = {}): Promise<ObservabilityPage<RunSummary>> {
	await initDb();
	const limit = pageLimit(options, 20, 100);
	const since = rangeStart(options.range);
	let rows = listObservabilityRuns().filter(row => since === undefined || row.startedAt >= since);
	if (options.q) rows = rows.filter(row => row.runId.includes(options.q ?? ""));
	if (options.project) rows = rows.filter(row => row.sessionIds.some(id => getObservabilitySession(id)?.folder === options.project));
	let summaries = rows.map(runSummary);
	if (options.status) summaries = summaries.filter(item => item.status === options.status);
	if (options.failure) summaries = summaries.filter(item => listObservabilityTimeline({ runId: item.runId }).some(event => ["failure", "model_attempt"].includes(event.kind)));
	const sessions = rows.flatMap(row => row.sessionIds.map(id => getObservabilitySession(id))).filter((item): item is ObservabilitySessionRow => item !== null);
	const meta = freshness(sessions, Math.max(0, ...rows.map(row => row.indexedAt)));
	const cursor = options.after || options.before ? decodeCursor((options.after ?? options.before)!, "runs", "*") : undefined;
	if (cursor && cursor.generation !== meta.generation) return { items: [], truncated: true, softAvailable: [], ...meta };
	let start = 0;
	if (cursor) {
		const index = summaries.findIndex(item => item.runId === cursor.lastEntryId && item.startedAt === cursor.lastTimestamp);
		start = index < 0 ? summaries.length : options.after ? index + 1 : Math.max(0, index - limit);
	}
	const items = summaries.slice(start, start + limit);
	const last = items.at(-1);
	return {
		items, truncated: start > 0 || start + items.length < summaries.length,
		softAvailable: [...new Set(items.flatMap(item => item.softAvailable))].sort(), ...meta,
		...(last && start + items.length < summaries.length ? { nextCursor: encodeCursor({ v: 1, kind: "runs", id: "*", generation: meta.generation, lastEntryId: last.runId, lastTimestamp: last.startedAt, indexedThrough: meta.indexedThrough }) } : {}),
	};
}
export async function getRun(runId: string): Promise<RunDetail | null> {
	await initDb();
	const row = getObservabilityRun(runId);
	if (!row) return null;
	const summary = runSummary(row);
	const sessions = row.sessionIds.map(id => getObservabilitySession(id)).filter((item): item is ObservabilitySessionRow => item !== null);
	return {
		...summary,
		truncated: summary.indexedThrough < summary.sourceSize,
		usage: summarizeMessagesForSessionFiles(sessions.map(item => item.sessionFile)),
	};
}

export interface TimelineOptions extends PageOptions { sessionId?: string; runId?: string }
async function timelinePage(options: TimelineOptions, kinds: string[] | undefined, fallback: number, max: number, kind: string): Promise<ObservabilityPage<TimelineItem> | null> {
	await initDb();
	const id = options.sessionId ?? options.runId;
	if (!id || Boolean(options.sessionId) === Boolean(options.runId)) throw new ObservabilityQueryError("Exactly one resource id is required");
	const session = options.sessionId ? getObservabilitySession(options.sessionId) : null;
	const run = options.runId ? getObservabilityRun(options.runId) : null;
	if (!session && !run) return null;
	const sessions = session ? [session] : (run?.sessionIds ?? []).map(value => getObservabilitySession(value)).filter((item): item is ObservabilitySessionRow => item !== null);
	const meta = freshness(sessions, run?.indexedAt ?? 0);
	const limit = pageLimit(options, fallback, max);
	const cursor = options.after || options.before ? decodeCursor((options.after ?? options.before)!, kind, id) : undefined;
	if (cursor && cursor.generation !== meta.generation) return { items: [], truncated: true, softAvailable: [], ...meta };
	const rows = listObservabilityTimeline({ sessionId: options.sessionId, runId: options.runId, kinds });
	let start = 0;
	if (cursor) {
		const index = rows.findIndex(row => row.entryId === cursor.lastEntryId && row.timestamp === cursor.lastTimestamp);
		start = index < 0 ? rows.length : options.after ? index + 1 : Math.max(0, index - limit);
	}
	const selected = rows.slice(start, start + limit);
	const items = selected.map(row => {
		const soft = redactSoft(parsePayload(row.payloadJson));
		return { entryId: row.entryId, parentId: row.parentId, timestamp: row.timestamp, kind: row.kind, runId: row.runId,
			decisionId: row.decisionId, executionId: row.executionId, payload: soft.value, softAvailable: soft.available };
	});
	const last = selected.at(-1);
	return {
		items, truncated: start > 0 || start + items.length < rows.length || meta.indexedThrough < meta.sourceSize,
		softAvailable: [...new Set(items.flatMap(item => item.softAvailable))].sort(), ...meta,
		...(last && start + items.length < rows.length ? { nextCursor: encodeCursor({ v: 1, kind, id, generation: meta.generation, lastEntryId: last.entryId, lastTimestamp: last.timestamp, indexedThrough: meta.indexedThrough }) } : {}),
	};
}
export async function listTimeline(options: TimelineOptions): Promise<ObservabilityPage<TimelineItem> | null> {
	return timelinePage(options, undefined, 50, 100, "timeline");
}
export async function listEvents(options: TimelineOptions): Promise<ObservabilityPage<TimelineItem> | null> {
	return timelinePage(options, undefined, 20, 50, "events");
}
export async function listLogs(options: TimelineOptions): Promise<ObservabilityPage<TimelineItem> | null> {
	return timelinePage(options, ["session_boundary", "model_request", "model_attempt", "failure"], 20, 50, "logs");
}

function requestDto(message: MessageStats): ObservabilityRequest {
	return {
		id: message.id,
		requestId: message.entryId, entryId: message.entryId, folder: message.folder, model: message.model, provider: message.provider,
		api: message.api, timestamp: message.timestamp, duration: message.duration, ttft: message.ttft, stopReason: message.stopReason,
		errorMessage: hardRedact(message.errorMessage), usage: hardRedact(message.usage), agentType: message.agentType,
		softAvailable: ["messages", "output"],
	};
}

function resourceSessions(kind: "sessions" | "runs", id: string): { sessions: ObservabilitySessionRow[]; indexedAt: number } | null {
	if (kind === "sessions") {
		const row = getObservabilitySession(id);
		return row ? { sessions: [row], indexedAt: row.indexedAt } : null;
	}
	const run = getObservabilityRun(id);
	if (!run) return null;
	return {
		sessions: run.sessionIds.map(sessionId => getObservabilitySession(sessionId)).filter((item): item is ObservabilitySessionRow => item !== null),
		indexedAt: run.indexedAt,
	};
}

export interface ResourceQueryOptions extends PageOptions {
	errorsOnly?: boolean;
}

export async function listResourceRequests(
	kind: "sessions" | "runs",
	id: string,
	options: ResourceQueryOptions = {},
): Promise<ObservabilityPage<ObservabilityRequest> | null> {
	await initDb();
	const resource = resourceSessions(kind, id);
	if (!resource) return null;
	const limit = pageLimit(options, 100, 200);
	const files = resource.sessions.map(item => item.sessionFile);
	const messages = listMessagesForSessionFiles(files, { limit, errorsOnly: options.errorsOnly });
	const meta = freshness(resource.sessions, resource.indexedAt);
	return {
		items: messages.map(requestDto),
		truncated: messages.length >= limit,
		softAvailable: ["messages", "output"],
		...meta,
	};
}

export async function listResourceTools(
	kind: "sessions" | "runs",
	id: string,
): Promise<(ObservabilityPage<ToolUsageStats> & { usage: SessionUsageSummary }) | null> {
	await initDb();
	const resource = resourceSessions(kind, id);
	if (!resource) return null;
	const files = resource.sessions.map(item => item.sessionFile);
	const items = getToolStatsForSessionFiles(files);
	const meta = freshness(resource.sessions, resource.indexedAt);
	return { items, truncated: false, softAvailable: [], usage: summarizeMessagesForSessionFiles(files), ...meta };
}

export async function getResourceUsage(
	kind: "sessions" | "runs",
	id: string,
): Promise<(SessionUsageSummary & ObservabilityFreshness) | null> {
	await initDb();
	const resource = resourceSessions(kind, id);
	if (!resource) return null;
	const files = resource.sessions.map(item => item.sessionFile);
	return { ...summarizeMessagesForSessionFiles(files), ...freshness(resource.sessions, resource.indexedAt) };
}
export async function getRequest(requestId: string): Promise<ObservabilityRequest | null> {
	await initDb();
	const message = getMessageByEntryId(requestId);
	return message ? requestDto(message) : null;
}
export async function getRequestBySqliteId(id: number): Promise<ObservabilityRequest | null> {
	await initDb();
	if (!Number.isSafeInteger(id) || id <= 0) return null;
	const message = getMessageById(id);
	return message ? requestDto(message) : null;
}
export async function getDecision(decisionId: string): Promise<RoutingDecision | null> {
	await initDb();
	const row = getObservabilityDecision(decisionId);
	if (!row) return null;
	const soft = redactSoft(parsePayload(row.payloadJson));
	return { decisionId: row.decisionId, kind: row.kind, timestamp: row.timestamp, payload: soft.value, softAvailable: soft.available };
}
export async function reveal(kind: "session" | "run" | "request", id: string, fields: string[]): Promise<unknown | null> {
	await initDb();
	if (!Array.isArray(fields) || fields.length === 0 || fields.some(field => typeof field !== "string" || !field)) throw new ObservabilityQueryError("fields must be a non-empty string array");
	const selected = new Set(fields);
	if (kind === "request") {
		const message = getMessageByEntryId(id);
		if (!message) return null;
		const entry = await getSessionEntry(message.sessionFile, message.entryId);
		const raw = { messages: entry ? [entry] : [], output: entry && "message" in entry ? entry.message : undefined };
		const result = redactSoft(raw, selected);
		return { requestId: id, fields: result.value, softAvailable: result.available };
	}
	const exists = kind === "session" ? getObservabilitySession(id) : getObservabilityRun(id);
	if (!exists) return null;
	const rows = kind === "session" ? listObservabilityTimeline({ sessionId: id }) : listObservabilityTimeline({ runId: id });
	return { [`${kind}Id`]: id, fields: rows.map(row => ({ entryId: row.entryId, payload: redactSoft(parsePayload(row.payloadJson), selected).value })) };
}
