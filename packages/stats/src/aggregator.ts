import * as fs from "node:fs";
import * as path from "node:path";
import { getRoutingAuditLogPath, getSessionsDir, getStatsDbPath, workerHostEntry } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import {
	applyObservabilityProjection,
	applyRoutingAuditRecords,
	getAuditOffset,
	getRecentErrors as dbGetRecentErrors,
	getRecentRequests as dbGetRecentRequests,
	getBehaviorByModel,
	getBehaviorOverall,
	getBehaviorTimeSeries,
	getCostTimeSeries,
	getFileOffset,
	getMessageCount,
	getModelPerformanceSeries,
	getModelTimeSeries,
	getObservabilitySessionIdByFile,
	getObservabilitySessionSnapshot,
	getOverallStats,
	getProviderHourlyBurn,
	getProviderTimeSeries,
	getStatsByAgentType,
	getStatsByFolder,
	getStatsByModel,
	getStatsByProvider,
	getTimeSeries,
	getToolStats,
	getToolStatsByModel,
	getToolTimeSeries,
	hasPendingObservabilityBackfill,
	initDb,
	insertMessageStats,
	insertToolCalls,
	insertUserMessageStats,
	markSessionBackfillsComplete,
	runStatsTransaction,
	setFileOffset,
	updateToolResults,
	updateUserMessageLinks,
	type FileOffset,
	type FileOffsetIdentity,
	type ObservabilitySessionSnapshot,
} from "./db";
import { listAllSessionFiles, listSessionFiles, type ParseSessionResult, parseSessionFile } from "./parser";
import type { SyncWorkerRequest, SyncWorkerResponse } from "./sync-worker";
// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so the compiled binary and npm bundle only need one
// JavaScript entry. Standalone source `omp-stats` keeps using this package's
// own sync-worker source file.
import type {
	BehaviorDashboardStats,
	DashboardStats,
	MessageStats,
	ProviderDashboardStats,
	ToolDashboardStats,
} from "./types";
import { computeUsageWindowStats, fetchUsageSnapshots } from "./usage-windows";
import { getRequestBySqliteId } from "./query";

const STATS_SYNC_LOCK_RETRY_MS = 25;
const STATS_SYNC_LOCK_WAIT_MS = 60 * 60 * 1000;

/**
 * Serialize stats ingestion and archive reconciliation across processes.
 * The lock covers file discovery, parsing, and the final SQLite write so a
 * parse result for a session moved by GC can never commit after cleanup.
 * The native lock is owned by an operating-system primitive, so an interrupted
 * owner is released automatically and a live owner is never displaced.
 */
export async function withStatsSyncLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
	await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
	return await withFileLock(`${dbPath}.sync`, fn, {
		retryDelayMs: STATS_SYNC_LOCK_RETRY_MS,
		retries: Math.ceil(STATS_SYNC_LOCK_WAIT_MS / STATS_SYNC_LOCK_RETRY_MS),
	});
}

export async function tryWithStatsSyncLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T | null> {
	await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
	let acquired = false;
	try {
		return await withFileLock(
			`${dbPath}.sync`,
			async () => {
				acquired = true;
				return await fn();
			},
			{ retries: 1 },
		);
	} catch (error) {
		if (!acquired) return null;
		throw error;
	}
}

interface SourcePlan {
	stat: fs.Stats;
	fromOffset: number;
	identity: FileOffsetIdentity;
	unchanged: boolean;
}

async function planSourceRead(sessionFile: string, stored: FileOffset | null): Promise<SourcePlan> {
	const stat = await fs.promises.stat(sessionFile);
	let generation = stored?.generation ?? 0;
	let fromOffset = stored?.offset ?? 0;
	const inodeChanged =
		stored !== null &&
		stored.inode !== null &&
		stored.dev !== null &&
		(stored.inode !== stat.ino || stored.dev !== stat.dev);
	let boundaryBroken = false;
	if (stored && stored.offset > 0 && stored.offset <= stat.size) {
		const boundary = new Uint8Array(await Bun.file(sessionFile).slice(stored.offset - 1, stored.offset).arrayBuffer());
		boundaryBroken = boundary[0] !== 0x0a;
	}
	if (stored && (stat.size < stored.offset || inodeChanged || boundaryBroken)) {
		generation++;
		fromOffset = 0;
	}
	const identity = { inode: stat.ino, dev: stat.dev, size: stat.size, generation };
	const unchanged =
		stored !== null &&
		fromOffset === stored.offset &&
		stored.lastModified >= stat.mtimeMs &&
		stored.size === stat.size &&
		!inodeChanged &&
		!boundaryBroken;
	return { stat, fromOffset, identity, unchanged };
}

function transcriptRelation(sessionFile: string): {
	relatedKind?: "nested" | "advisor";
	leadFile?: string;
} {
	const basename = path.basename(sessionFile);
	const advisor = basename === "__advisor.jsonl" || (basename.startsWith("__advisor.") && basename.endsWith(".jsonl"));
	const relative = path.relative(getSessionsDir(), sessionFile).split(path.sep);
	if (relative.length > 2) {
		return {
			relatedKind: advisor ? "advisor" : "nested",
			leadFile: path.join(getSessionsDir(), relative[0], `${relative[1]}.jsonl`),
		};
	}
	return advisor ? { relatedKind: "advisor" } : {};
}

function statsFolder(sessionFile: string): string {
	const project = path.relative(getSessionsDir(), sessionFile).split(path.sep)[0] ?? "";
	return project.replace(/^--/, "/").replace(/--/g, "/");
}

/**
 * Commit all projections for one parsed file together with its source cursor.
 */
function applyParseResult(
	sessionFile: string,
	result: ParseSessionResult,
	source: SourcePlan,
	leadSessionId?: string,
	persistOffset = true,
): number {
	const relation = transcriptRelation(sessionFile);
	return runStatsTransaction(() => {
		if (result.stats.length > 0) insertMessageStats(result.stats);
		if (result.userStats.length > 0) insertUserMessageStats(result.userStats);
		if (result.userLinks.length > 0) updateUserMessageLinks(result.userLinks);
		if (result.toolCalls.length > 0) insertToolCalls(result.toolCalls);
		if (result.toolResults.length > 0) updateToolResults(result.toolResults);
		applyObservabilityProjection({
			sessionFile,
			folder: statsFolder(sessionFile),
			leadSessionId,
			relatedKind: relation.relatedKind,
			header: result.header,
			sessionExit: result.sessionExit,
			observability: result.observability,
			indexedThrough: result.newOffset,
			sourceMtime: source.stat.mtimeMs,
			sourceSize: source.stat.size,
			generation: source.identity.generation,
		});
		if (persistOffset) {
			setFileOffset(sessionFile, result.newOffset, source.stat.mtimeMs, source.identity);
		}
		return result.stats.length + result.userStats.length;
	});
}

/**
 * Progress event emitted after each session file is fully processed.
 * `current` is the number of files completed (skipped + parsed),
 * `total` is the size of the work set. `processed` is the running total
 * of inserted rows.
 */
export interface SyncProgress {
	current: number;
	total: number;
	processed: number;
	sessionFile: string;
}

export interface SyncOptions {
	/** Called after each file completes. Synchronous; keep it cheap. */
	onProgress?: (event: SyncProgress) => void;
	/**
	 * Worker pool size. Defaults to a sensible value derived from the host
	 * (capped to avoid drowning a small machine in workers). Set to `1` to
	 * force serial parsing without spawning workers.
	 */
	workers?: number;
}

function defaultWorkerCount(): number {
	// Bun 1.3.x can abort the macOS process when stats sync workers re-enter
	// the compiled `omp` binary. Keep macOS on the documented serial path.
	if (process.platform === "darwin") return 1;
	// `navigator.hardwareConcurrency` is the portable answer in Bun; fall
	// back to a small fixed pool if it's somehow unavailable.
	const hw = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 0) : 0;
	const raw = hw > 0 ? hw : 4;
	// Cap at 8 - parse is JSON-bound, and SQLite writes serialize on main
	// thread anyway, so more workers stop helping.
	return Math.min(8, Math.max(2, Math.floor(raw)));
}

interface WorkerHandle {
	worker: Worker;
	busy: boolean;
	resolve: ((res: ParseSessionResult) => void) | null;
	reject: ((err: Error) => void) | null;
}

/**
 * Create a fresh sync worker. When the process was started from a
 * self-dispatching CLI entry (omp in source, npm-bundle, or compiled form),
 * re-enter that entry with a worker argv selector; otherwise (standalone
 * omp-stats, bun test, SDK embedding) load the worker module directly, so this
 * package keeps zero runtime dependency on `@oh-my-pi/pi-coding-agent`.
 */
function createSyncWorker(): Worker {
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return new Worker(hostEntry, { type: "module", argv: ["__omp_worker_stats_sync"] });
	}
	return new Worker(new URL("./sync-worker.ts", import.meta.url).href, { type: "module" });
}

function spawnWorker(): WorkerHandle {
	const worker = createSyncWorker();
	const handle: WorkerHandle = { worker, busy: false, resolve: null, reject: null };
	worker.onmessage = (event: MessageEvent<SyncWorkerResponse>) => {
		const { resolve, reject } = handle;
		handle.resolve = null;
		handle.reject = null;
		handle.busy = false;
		if (!resolve || !reject) return;
		const data = event.data;
		if (!data.ok) {
			reject(new Error(data.error));
			return;
		}
		if (data.kind === "pong") {
			reject(new Error("sync worker: unexpected pong on parse channel"));
			return;
		}
		resolve(data.result);
	};
	worker.onerror = (event: ErrorEvent) => {
		const { reject } = handle;
		handle.resolve = null;
		handle.reject = null;
		handle.busy = false;
		reject?.(event.error instanceof Error ? event.error : new Error(event.message || "worker error"));
	};
	return handle;
}

function dispatch(handle: WorkerHandle, request: SyncWorkerRequest): Promise<ParseSessionResult> {
	if (handle.busy) {
		return Promise.reject(new Error("worker is busy - this is a bug in the dispatcher"));
	}
	const { promise, resolve, reject } = Promise.withResolvers<ParseSessionResult>();
	handle.busy = true;
	handle.resolve = resolve;
	handle.reject = reject;
	handle.worker.postMessage(request);
	return promise;
}

/**
 * Smoke test: spawns one sync worker, pings it, asserts the pong response,
 * then terminates. Used by `omp --smoke-test` so the install-method CI jobs
 * catch the silent worker-load failure that hit compiled binaries in #1011
 * and #1027 — neither `--version` nor `stats --summary` exercises the worker
 * spawn path on a fresh install (no session files = early return), so a
 * dedicated probe is the only reliable signal.
 *
 * No-op on darwin: `syncAllSessions` keeps macOS on the serial parser path
 * (see {@link defaultWorkerCount}) so the worker spawn surface is unreachable
 * from the CLI, and probing it under the hardened runtime in
 * `scripts/ci-macos-sign.sh` would re-enter the Bun-worker abort surface that
 * motivated the darwin serial default in the first place.
 *
 * Rejects on transport error, error response, or timeout.
 */
export async function smokeTestSyncWorker({ timeoutMs = 5_000 }: { timeoutMs?: number } = {}): Promise<void> {
	if (process.platform === "darwin") return;
	const worker = createSyncWorker();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`sync worker did not pong within ${timeoutMs}ms`)), timeoutMs);
	worker.onmessage = (event: MessageEvent<SyncWorkerResponse>) => {
		const data = event.data;
		if (!data.ok) {
			reject(new Error(data.error));
			return;
		}
		if (data.kind !== "pong") {
			reject(new Error(`sync worker: expected pong, got ${JSON.stringify(data)}`));
			return;
		}
		resolve();
	};
	worker.onerror = (event: ErrorEvent) => {
		reject(event.error instanceof Error ? event.error : new Error(event.message || "worker error"));
	};
	try {
		worker.postMessage({ kind: "ping" } satisfies SyncWorkerRequest);
		await promise;
	} finally {
		clearTimeout(timer);
		worker.terminate();
	}
}

interface ParsedAuditTail {
	records: Array<{ decisionId: string; kind: string; timestamp: string; payload: unknown }>;
	newOffset: number;
}

async function parseRoutingAuditTail(logPath: string, fromOffset: number): Promise<ParsedAuditTail> {
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(logPath).bytes();
	} catch {
		return { records: [], newOffset: fromOffset };
	}
	const start = Math.max(0, Math.min(fromOffset, bytes.length));
	const records: ParsedAuditTail["records"] = [];
	let cursor = start;
	let read = 0;
	while (cursor < bytes.length) {
		const newline = bytes.indexOf(0x0a, cursor);
		if (newline === -1) break;
		try {
			const payload: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(cursor, newline)));
			if (
				typeof payload === "object" &&
				payload !== null &&
				"decisionId" in payload &&
				typeof payload.decisionId === "string" &&
				"kind" in payload &&
				typeof payload.kind === "string" &&
				"timestamp" in payload &&
				typeof payload.timestamp === "string"
			) {
				records.push({
					decisionId: payload.decisionId,
					kind: payload.kind,
					timestamp: payload.timestamp,
					payload,
				});
			}
		} catch {
			// A malformed complete line is skipped; later lines remain readable.
		}
		read = newline + 1 - start;
		cursor = newline + 1;
	}
	return { records, newOffset: start + read };
}

async function ingestRoutingAudit(persist: boolean): Promise<void> {
	const logPath = getRoutingAuditLogPath();
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(logPath);
	} catch {
		return;
	}
	const stored = getAuditOffset(logPath);
	let fromOffset = stored?.offset ?? 0;
	let generation = stored?.generation ?? 0;
	if (stored && stat.size < stored.offset) {
		fromOffset = 0;
		generation++;
	} else if (stored && stored.offset > 0) {
		const boundary = new Uint8Array(await Bun.file(logPath).slice(stored.offset - 1, stored.offset).arrayBuffer());
		if (boundary[0] !== 0x0a) {
			fromOffset = 0;
			generation++;
		}
	}
	if (stored && stored.lastModified >= stat.mtimeMs && fromOffset === stored.offset) return;
	const parsed = await parseRoutingAuditTail(logPath, fromOffset);
	if (!persist) return;
	runStatsTransaction(() => {
		applyRoutingAuditRecords(logPath, parsed.records, parsed.newOffset, stat.mtimeMs, generation);
	});
}

async function relatedLeadId(sessionFile: string): Promise<string | undefined> {
	const leadFile = transcriptRelation(sessionFile).leadFile;
	if (!leadFile) return undefined;
	const indexed = getObservabilitySessionIdByFile(leadFile);
	if (indexed) return indexed;
	return (await parseSessionFile(leadFile, 0)).header?.id;
}

/**
 * Sync all session files to the database.
 *
 * `workers: 1` parses inline. Larger pools fan parsing out across workers
 * (one in-flight job per worker) while DB writes and offset bookkeeping stay on
 * the calling thread so the single SQLite handle stays uncontended.
 * `onProgress` fires once per completed file (skipped files included so the
 * bar walks at a steady rate).
 */
export async function syncAllSessions(opts?: SyncOptions): Promise<{ processed: number; files: number }> {
	return withStatsSyncLock(getStatsDbPath(), () => syncAllSessionsLocked(opts));
}

async function syncAllSessionsLocked(opts?: SyncOptions): Promise<{ processed: number; files: number }> {
	await initDb();

	const pendingObservability = hasPendingObservabilityBackfill();
	const files = (await listAllSessionFiles()).sort((left, right) => {
		const leftDepth = path.relative(getSessionsDir(), left).split(path.sep).length;
		const rightDepth = path.relative(getSessionsDir(), right).split(path.sep).length;
		return leftDepth - rightDepth || left.localeCompare(right);
	});
	let totalProcessed = 0;
	let filesProcessed = 0;
	let completed = 0;
	let cursor = 0;
	const finish = async () => {
		await ingestRoutingAudit(true);
		markSessionBackfillsComplete();
		return { processed: totalProcessed, files: filesProcessed };
	};
	if (files.length === 0) return await finish();

	const report = (sessionFile: string) => {
		completed++;
		opts?.onProgress?.({
			current: completed,
			total: files.length,
			processed: totalProcessed,
			sessionFile,
		});
	};

	const processFile = async (
		sessionFile: string,
		parse: (sessionFile: string, fromOffset: number) => Promise<ParseSessionResult>,
	): Promise<void> => {
		let source: SourcePlan;
		try {
			source = await planSourceRead(sessionFile, pendingObservability ? null : getFileOffset(sessionFile));
		} catch {
			report(sessionFile);
			return;
		}
		if (source.unchanged) {
			report(sessionFile);
			return;
		}

		const result = await parse(sessionFile, source.fromOffset);
		const inserted = applyParseResult(sessionFile, result, source, await relatedLeadId(sessionFile));
		if (inserted > 0) {
			totalProcessed += inserted;
			filesProcessed++;
		}
		report(sessionFile);
	};

	const requestedWorkers = Math.max(1, Math.floor(opts?.workers ?? defaultWorkerCount()));
	if (requestedWorkers === 1) {
		for (const sessionFile of files) {
			await processFile(sessionFile, parseSessionFile);
		}
		return await finish();
	}

	const poolSize = Math.min(files.length, requestedWorkers);
	const handles: WorkerHandle[] = [];
	for (let i = 0; i < poolSize; i++) handles.push(spawnWorker());

	async function drain(handle: WorkerHandle): Promise<void> {
		while (true) {
			const idx = cursor++;
			if (idx >= files.length) return;
			const sessionFile = files[idx];
			await processFile(sessionFile, (file, fromOffset) => dispatch(handle, { sessionFile: file, fromOffset }));
		}
	}

	try {
		await Promise.all(handles.map(drain));
	} finally {
		for (const handle of handles) handle.worker.terminate();
	}

	return await finish();
}

export async function resolveLeadSessionFile(sessionId: string): Promise<string | null> {
	await initDb();
	const indexed = getObservabilitySessionSnapshot(sessionId)?.sessionFile;
	if (indexed) {
		try {
			if ((await fs.promises.stat(indexed)).isFile()) return indexed;
		} catch {
			// The locator moved; fall through to the bounded project-folder scan.
		}
	}
	let projects: fs.Dirent[];
	try {
		projects = await fs.promises.readdir(getSessionsDir(), { withFileTypes: true });
	} catch {
		return null;
	}
	const suffix = `_${sessionId}.jsonl`;
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const projectPath = path.join(getSessionsDir(), project.name);
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
		} catch {
			continue;
		}
		const match = entries.find(entry => entry.isFile() && entry.name.endsWith(suffix));
		if (match) return path.join(projectPath, match.name);
	}
	return null;
}

export type IngestDetailResult =
	| {
			ok: true;
			sessionFile: string;
			snapshot: ObservabilitySessionSnapshot | null;
			observability: ParseSessionResult["observability"];
	  }
	| {
			ok: false;
			reason: "not_found" | "lock_busy";
			snapshot?: ObservabilitySessionSnapshot | null;
	  };

export async function ingestSessionDetail(sessionId: string): Promise<IngestDetailResult> {
	const resolved = await resolveLeadSessionFile(sessionId);
	if (!resolved) return { ok: false, reason: "not_found" };
	const priorSnapshot = getObservabilitySessionSnapshot(sessionId);
	const result = await tryWithStatsSyncLock(getStatsDbPath(), async (): Promise<IngestDetailResult> => {
		const leadFile = await resolveLeadSessionFile(sessionId);
		if (!leadFile) return { ok: false, reason: "not_found" };
		const pending = hasPendingObservabilityBackfill();
		const stemDirectory = leadFile.slice(0, -".jsonl".length);
		const related = await listSessionFiles(stemDirectory);
		const files = [leadFile, ...related.filter(file => path.resolve(file) !== path.resolve(leadFile))];
		const parsedObservability: ParseSessionResult["observability"] = [];
		let leadId = sessionId;
		for (const sessionFile of files) {
			let source: SourcePlan;
			try {
				source = await planSourceRead(sessionFile, pending ? null : getFileOffset(sessionFile));
			} catch {
				continue;
			}
			if (source.unchanged) continue;
			const parsed = await parseSessionFile(sessionFile, source.fromOffset);
			if (sessionFile === leadFile && parsed.header) leadId = parsed.header.id;
			parsedObservability.push(...parsed.observability);
			applyParseResult(sessionFile, parsed, source, sessionFile === leadFile ? undefined : leadId, !pending);
		}
		await ingestRoutingAudit(!pending);
		return {
			ok: true,
			sessionFile: leadFile,
			snapshot: getObservabilitySessionSnapshot(sessionId),
			observability: parsedObservability,
		};
	});
	return result ?? { ok: false, reason: "lock_busy", snapshot: priorSnapshot };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_MIN_MS = 5 * 60 * 1000;

type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

interface TimeRangeConfig {
	timeSeriesHours: number;
	timeSeriesBucketMs: number;
	modelSeriesDays: number;
	modelSeriesBucketMs: number;
	modelPerformanceDays: number;
	modelPerformanceBucketMs: number;
	costSeriesDays: number;
	cutoff: number | null;
}

const DEFAULT_TIME_RANGE: TimeRange = "24h";

const TIME_RANGE_TO_CONFIG: Record<TimeRange, Omit<TimeRangeConfig, "cutoff">> = {
	"1h": {
		timeSeriesHours: 1,
		timeSeriesBucketMs: FIVE_MIN_MS,
		modelSeriesDays: 1,
		modelSeriesBucketMs: FIVE_MIN_MS,
		modelPerformanceDays: 1,
		modelPerformanceBucketMs: FIVE_MIN_MS,
		costSeriesDays: 1,
	},
	"24h": {
		timeSeriesHours: 24,
		timeSeriesBucketMs: HOUR_MS,
		modelSeriesDays: 1,
		modelSeriesBucketMs: HOUR_MS,
		modelPerformanceDays: 1,
		modelPerformanceBucketMs: HOUR_MS,
		costSeriesDays: 1,
	},
	"7d": {
		timeSeriesHours: 24 * 7,
		timeSeriesBucketMs: DAY_MS,
		modelSeriesDays: 7,
		modelSeriesBucketMs: DAY_MS,
		modelPerformanceDays: 7,
		modelPerformanceBucketMs: DAY_MS,
		costSeriesDays: 7,
	},
	"30d": {
		timeSeriesHours: 24 * 30,
		timeSeriesBucketMs: DAY_MS,
		modelSeriesDays: 30,
		modelSeriesBucketMs: DAY_MS,
		modelPerformanceDays: 30,
		modelPerformanceBucketMs: DAY_MS,
		costSeriesDays: 30,
	},
	"90d": {
		timeSeriesHours: 24 * 90,
		timeSeriesBucketMs: DAY_MS,
		modelSeriesDays: 90,
		modelSeriesBucketMs: DAY_MS,
		modelPerformanceDays: 90,
		modelPerformanceBucketMs: DAY_MS,
		costSeriesDays: 90,
	},
	all: {
		timeSeriesHours: 24 * 3650,
		timeSeriesBucketMs: DAY_MS,
		modelSeriesDays: 3650,
		modelSeriesBucketMs: DAY_MS,
		modelPerformanceDays: 3650,
		modelPerformanceBucketMs: DAY_MS,
		costSeriesDays: 3650,
	},
};

export function getTimeRangeConfig(range?: string | null): TimeRangeConfig {
	const normalized = range?.trim().toLowerCase() ?? DEFAULT_TIME_RANGE;
	const config = TIME_RANGE_TO_CONFIG[normalized as TimeRange];
	if (config) {
		const cutoff = normalized === "all" ? null : Date.now() - Math.max(1, config.timeSeriesHours * 60 * 60 * 1000);
		return { ...config, cutoff };
	}

	const fallbackConfig = TIME_RANGE_TO_CONFIG[DEFAULT_TIME_RANGE];
	return {
		...fallbackConfig,
		cutoff: Date.now() - fallbackConfig.timeSeriesHours * 60 * 60 * 1000,
	};
}

/**
 * Get all dashboard stats.
 */
export async function getDashboardStats(range?: string | null): Promise<DashboardStats> {
	await initDb();
	const {
		timeSeriesHours,
		timeSeriesBucketMs,
		modelSeriesDays,
		modelSeriesBucketMs,
		modelPerformanceDays,
		modelPerformanceBucketMs,
		costSeriesDays,
		cutoff,
	} = getTimeRangeConfig(range);

	return {
		overall: getOverallStats(cutoff ?? undefined),
		byModel: getStatsByModel(cutoff ?? undefined),
		byFolder: getStatsByFolder(cutoff ?? undefined),
		byAgentType: getStatsByAgentType(cutoff ?? undefined),
		timeSeries: getTimeSeries(timeSeriesHours, cutoff, timeSeriesBucketMs),
		modelSeries: getModelTimeSeries(modelSeriesDays, cutoff, modelSeriesBucketMs),
		modelPerformanceSeries: getModelPerformanceSeries(modelPerformanceDays, cutoff, modelPerformanceBucketMs),
		costSeries: getCostTimeSeries(costSeriesDays, cutoff),
	};
}

export async function getOverviewStats(
	range?: string | null,
): Promise<Pick<DashboardStats, "overall" | "byAgentType" | "timeSeries">> {
	await initDb();
	const { timeSeriesHours, timeSeriesBucketMs, cutoff } = getTimeRangeConfig(range);

	return {
		overall: getOverallStats(cutoff ?? undefined),
		byAgentType: getStatsByAgentType(cutoff ?? undefined),
		timeSeries: getTimeSeries(timeSeriesHours, cutoff, timeSeriesBucketMs),
	};
}

export async function getModelDashboardStats(
	range?: string | null,
): Promise<Pick<DashboardStats, "byModel" | "modelSeries" | "modelPerformanceSeries">> {
	await initDb();
	const { modelSeriesDays, modelSeriesBucketMs, modelPerformanceDays, modelPerformanceBucketMs, cutoff } =
		getTimeRangeConfig(range);

	return {
		byModel: getStatsByModel(cutoff ?? undefined),
		modelSeries: getModelTimeSeries(modelSeriesDays, cutoff, modelSeriesBucketMs),
		modelPerformanceSeries: getModelPerformanceSeries(modelPerformanceDays, cutoff, modelPerformanceBucketMs),
	};
}

export async function getCostDashboardStats(range?: string | null): Promise<Pick<DashboardStats, "costSeries">> {
	await initDb();
	const { costSeriesDays, cutoff } = getTimeRangeConfig(range);

	return {
		costSeries: getCostTimeSeries(costSeriesDays, cutoff),
	};
}
export async function getRecentRequests(limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentRequests(limit);
}

export async function getRecentErrors(range?: string | null, limit?: number): Promise<MessageStats[]> {
	await initDb();
	const { cutoff } = getTimeRangeConfig(range);
	return dbGetRecentErrors(limit, cutoff);
}

export async function getRequestDetails(id: number) {
	return getRequestBySqliteId(id);
}

/**
 * Get the current message count in the database.
 */
export async function getTotalMessageCount(): Promise<number> {
	await initDb();
	return getMessageCount();
}

export async function getBehaviorDashboardStats(range?: string | null): Promise<BehaviorDashboardStats> {
	await initDb();
	const { cutoff } = getTimeRangeConfig(range);
	return {
		overall: getBehaviorOverall(cutoff),
		byModel: getBehaviorByModel(cutoff),
		behaviorSeries: getBehaviorTimeSeries(cutoff),
	};
}

/**
 * Get the tools dashboard payload: per-tool totals, per-(tool, model)
 * breakdown, and the call time series (bucketed like the model series).
 */
export async function getToolDashboardStats(range?: string | null): Promise<ToolDashboardStats> {
	await initDb();
	const { modelSeriesDays, modelSeriesBucketMs, cutoff } = getTimeRangeConfig(range);
	return {
		byTool: getToolStats(cutoff ?? undefined),
		byToolModel: getToolStatsByModel(cutoff ?? undefined),
		series: getToolTimeSeries(modelSeriesDays, cutoff, modelSeriesBucketMs),
	};
}

/**
 * Get the providers dashboard payload: per-provider totals, peak-burn-hours
 * histogram, provider token time series, and subscription-window analytics
 * (utilization series + insights) derived from recorded usage-limit snapshots.
 */
export async function getProviderDashboardStats(range?: string | null): Promise<ProviderDashboardStats> {
	await initDb();
	const { modelSeriesDays, modelSeriesBucketMs, cutoff } = getTimeRangeConfig(range);
	const providers = getStatsByProvider(cutoff ?? undefined);
	const tokensByProvider = new Map(providers.map(p => [p.provider, p.totalTokens]));
	const snapshots = await fetchUsageSnapshots(cutoff ?? 0);
	const { usageSeries, windowInsights } = computeUsageWindowStats(snapshots, tokensByProvider);
	return {
		providers,
		hourly: getProviderHourlyBurn(cutoff ?? undefined),
		series: getProviderTimeSeries(modelSeriesDays, cutoff, modelSeriesBucketMs),
		usageSeries,
		windowInsights,
	};
}
