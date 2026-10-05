import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import * as path from "node:path";

// Private, opt-in `artel.perf.v1` diagnostics. Enabled only by ARTEL_LATENCY_AUDIT_ROOT.
// Never pass payloads, prompts, tool output, URLs with queries, tokens or file contents here.

export type PerfScalar = string | number | boolean;
/** Correlation ids of the `artel.perf.v1` contract (flat scalars only). */
export interface PerfIds {
	commandId?: string;
	clientMessageId?: string;
	agentInstanceRef?: string;
	agentInstanceId?: string;
	attemptId?: string;
	sessionId?: string;
	executionId?: string;
	engineGeneration?: number;
	effectId?: string;
	modelCallId?: string;
}
export type PerfAttrs = Readonly<Record<string, PerfScalar | undefined>>;
export type PerfEnd = (extra?: PerfAttrs) => void;

const root = process.env.ARTEL_LATENCY_AUDIT_ROOT || undefined;
export const perfEnabled = root !== undefined;

const FLUSH_MS = 250;
const COUNTER_FLUSH_MS = 2000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const noop: PerfEnd = () => {};

let file: string | undefined;
let buffer: string[] = [];
let inflight = "";
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let counterTimer: ReturnType<typeof setInterval> | undefined;
let fileBytes = 0;
let dropped = false;
let exitHooked = false;
let writing: Promise<void> = Promise.resolve();

function wallMs(): number {
	return performance.timeOrigin + performance.now();
}

function clean(values: PerfIds | PerfAttrs | undefined): Record<string, PerfScalar> | undefined {
	if (!values) return undefined;
	let out: Record<string, PerfScalar> | undefined;
	for (const [key, value] of Object.entries(values) as Array<[string, PerfScalar | undefined]>) {
		if (value === undefined) continue;
		out ??= {};
		if (typeof value === "string") out[key] = value.slice(0, 200);
		else if (typeof value === "number") out[key] = Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
		else out[key] = value;
	}
	return out;
}

function sinkFile(): string {
	if (!file) {
		file = path.join(root!, `artel-perf-engine-${process.pid}.jsonl`);
		try {
			mkdirSync(root!, { recursive: true });
		} catch {
			/* Diagnostics never change execution. */
		}
	}
	return file;
}

function flushAsync(): void {
	flushTimer = undefined;
	if (!buffer.length) return;
	const text = buffer.join("");
	buffer = [];
	inflight += text;
	writing = writing
		.then(() => appendFile(sinkFile(), text))
		.catch(() => {})
		.then(() => {
			inflight = inflight.slice(text.length);
		});
}

function flushSync(): void {
	try {
		flushCounters();
		const text = inflight + buffer.join("");
		inflight = "";
		buffer = [];
		if (text) appendFileSync(sinkFile(), text);
	} catch {
		/* Diagnostics never change execution. */
	}
}

function emit(record: Record<string, unknown>): void {
	try {
		if (dropped) return;
		const head = { schema: "artel.perf.v1", component: "engine", pid: process.pid };
		let line = `${JSON.stringify({ ...head, ...record })}\n`;
		fileBytes += line.length;
		if (fileBytes > MAX_FILE_BYTES) {
			dropped = true;
			line = `${JSON.stringify({ ...head, kind: "event", name: "engine.perf.dropped", wallMs: wallMs() })}\n`;
		}
		buffer.push(line);
		if (!exitHooked) {
			exitHooked = true;
			process.on("exit", flushSync);
		}
		flushTimer ??= setTimeout(flushAsync, FLUSH_MS);
		flushTimer.unref?.();
	} catch {
		/* Diagnostics never change execution. */
	}
}

export function perfSpan(name: string, ids?: PerfIds, attrs?: PerfAttrs): PerfEnd {
	if (!perfEnabled) return noop;
	const start = performance.now();
	let ended = false;
	return extra => {
		if (ended) return;
		ended = true;
		const end = performance.now();
		emit({
			kind: "span",
			name,
			wallMs: performance.timeOrigin + end,
			durMs: end - start,
			ids: clean(ids),
			attrs: clean(extra ? { ...attrs, ...extra } : attrs),
		});
	};
}

export function perfEvent(name: string, ids?: PerfIds, attrs?: PerfAttrs): void {
	if (!perfEnabled) return;
	emit({ kind: "event", name, wallMs: wallMs(), ids: clean(ids), attrs: clean(attrs) });
}

/** Span over an async body; a throw ends it with `outcome: "error"`. */
export function perfWrap<T>(
	name: string,
	ids: PerfIds | undefined,
	attrs: PerfAttrs | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	if (!perfEnabled) return fn();
	const end = perfSpan(name, ids, attrs);
	return fn().then(
		value => {
			end();
			return value;
		},
		error => {
			end({ outcome: "error" });
			throw error;
		},
	);
}

interface CounterCell {
	name: string;
	key: string;
	ids?: PerfIds;
	count: number;
	totalMs: number;
	maxMs: number;
	sums?: Record<string, number>;
}

const counters = new Map<string, CounterCell>();

/** Aggregates hot-path work. `sums` are additive numeric attrs (e.g. replays, lockWaitMs). */
export function perfCount(name: string, key: string, ms: number, ids?: PerfIds, sums?: Record<string, number>): void {
	if (!perfEnabled) return;
	const merged = ids?.attemptId === undefined && scopeStore.getStore() ? scopeStore.getStore()!.ids : ids;
	const attemptId = merged?.attemptId;
	const id = `${name}\u0000${key}\u0000${attemptId ?? ""}`;
	let cell = counters.get(id);
	if (!cell) {
		cell = { name, key, ids: merged, count: 0, totalMs: 0, maxMs: 0 };
		counters.set(id, cell);
	}
	cell.count++;
	cell.totalMs += ms;
	if (ms > cell.maxMs) cell.maxMs = ms;
	if (sums) {
		cell.sums ??= {};
		for (const k in sums) cell.sums[k] = (cell.sums[k] ?? 0) + sums[k]!;
	}
	counterTimer ??= setInterval(flushCounters, COUNTER_FLUSH_MS);
	counterTimer.unref?.();
}

/** Flushes non-zero counters; with `attemptId` only that Attempt's cells (Attempt end). */
export function flushCounters(attemptId?: string): void {
	if (!perfEnabled || !counters.size) return;
	for (const [id, cell] of counters) {
		if (attemptId !== undefined && cell.ids?.attemptId !== attemptId) continue;
		counters.delete(id);
		emit({
			kind: "counter",
			name: cell.name,
			wallMs: wallMs(),
			durMs: cell.totalMs,
			ids: clean(cell.ids),
			attrs: clean({ key: cell.key, count: cell.count, maxMs: cell.maxMs, ...cell.sums }),
		});
	}
}

/** Times an async or sync body as an aggregated counter. */
export function perfTimed<T>(name: string, key: string, ids: PerfIds | undefined, fn: () => T): T {
	if (!perfEnabled) return fn();
	const start = performance.now();
	try {
		const result = fn();
		if (result instanceof Promise) {
			return result.finally(() => perfCount(name, key, performance.now() - start, ids)) as T;
		}
		perfCount(name, key, performance.now() - start, ids);
		return result;
	} catch (error) {
		perfCount(name, key, performance.now() - start, ids);
		throw error;
	}
}

export interface PerfScope {
	readonly ids: PerfIds;
	storageRequests: number;
	lifecycleQueries: number;
}

// Attributes nested storage requests to the enclosing query / Start span.
const scopeStore = new AsyncLocalStorage<PerfScope>();

export function perfCurrentScope(): PerfScope | undefined {
	return perfEnabled ? scopeStore.getStore() : undefined;
}

/**
 * Span over a (sync or async) body that owns a storage-attribution scope. The span ends with the scope's
 * `storageRequests`, and the totals roll up into the enclosing scope. `end` may be called early with extra attrs.
 */
export function perfScopedSpan<T>(
	name: string,
	ids: PerfIds | undefined,
	attrs: PerfAttrs | undefined,
	fn: (scope: PerfScope, end: PerfEnd) => T,
): T {
	if (!perfEnabled) return fn({ ids: ids ?? {}, storageRequests: 0, lifecycleQueries: 0 }, noop);
	const parent = scopeStore.getStore();
	const scope: PerfScope = { ids: { ...parent?.ids, ...ids }, storageRequests: 0, lifecycleQueries: 0 };
	const end = perfSpan(name, scope.ids, attrs);
	let done = false;
	const finish: PerfEnd = extra => {
		if (done) return;
		done = true;
		if (parent) {
			parent.storageRequests += scope.storageRequests;
			parent.lifecycleQueries += scope.lifecycleQueries;
		}
		end({ storageRequests: scope.storageRequests, ...extra });
	};
	return scopeStore.run(scope, () => {
		let result: T;
		try {
			result = fn(scope, finish);
		} catch (error) {
			finish({ outcome: "error" });
			throw error;
		}
		if (result instanceof Promise) {
			return result.then(
				value => {
					finish();
					return value;
				},
				error => {
					finish({ outcome: "error" });
					throw error;
				},
			) as T;
		}
		finish();
		return result;
	});
}

/** Records one storage client round trip: global counter + enclosing scope tally. */
export function perfStorageRequest(op: string, ms: number, sums?: Record<string, number>): void {
	if (!perfEnabled) return;
	const scope = scopeStore.getStore();
	if (scope) scope.storageRequests++;
	perfCount("engine.storage.request", op, ms, scope?.ids, sums);
}

/** Times `fn` as a storage request of kind `op`. */
export function perfStorage<T>(op: string, fn: () => T): T {
	if (!perfEnabled) return fn();
	const start = performance.now();
	try {
		const result = fn();
		if (result instanceof Promise) {
			return result.finally(() => perfStorageRequest(op, performance.now() - start)) as T;
		}
		perfStorageRequest(op, performance.now() - start);
		return result;
	} catch (error) {
		perfStorageRequest(op, performance.now() - start);
		throw error;
	}
}

const firstFetch = new Map<string, PerfEnd>();

/** Arms `engine.turn.dispatch_to_first_fetch` for an Attempt; the first physical fetch ends it. */
export function perfArmFirstFetch(attemptId: string, ids?: PerfIds): void {
	if (!perfEnabled) return;
	firstFetch.get(attemptId)?.({ outcome: "superseded" });
	firstFetch.set(attemptId, perfSpan("engine.turn.dispatch_to_first_fetch", ids));
}

/** Ends the armed span at the first physical fetch start, or with `outcome` when none happened. */
export function perfFirstFetch(attemptId: string | undefined, extra?: PerfAttrs): void {
	if (!perfEnabled || attemptId === undefined) return;
	const end = firstFetch.get(attemptId);
	if (!end) return;
	firstFetch.delete(attemptId);
	end(extra);
}

const reasonStore = new AsyncLocalStorage<string>();

/** Labels mutations made inside `fn` (diagnostic invalidation reason). */
export function perfWithReason<T>(reason: string, fn: () => T): T {
	return perfEnabled ? reasonStore.run(reason, fn) : fn();
}

export function perfReason(): string | undefined {
	return perfEnabled ? reasonStore.getStore() : undefined;
}

/** Name of the function `depth` frames above the caller of this helper (depth 1 = the caller itself). */
export function perfCallerName(depth = 1): string {
	if (!perfEnabled) return "";
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = depth + 2;
	const stack = new Error().stack ?? "";
	Error.stackTraceLimit = limit;
	const frame = stack.split("\n")[depth + 1] ?? "";
	return /at (?:async )?(?:new )?(?:[\w$]+\.)*([#\w$<>]+)/.exec(frame)?.[1] ?? "unknown";
}
