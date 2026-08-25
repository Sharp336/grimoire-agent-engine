/**
 * Append-only journal of prompt-cache observations, and the TTL feedback loop it feeds.
 *
 * The keepalive can only schedule a touch against a lifetime it believes; without
 * persistence that belief resets every process and `resolveTtl` never clears its
 * sample gate, so the learned tier can never win. This closes the loop:
 *
 *   {"at":<epochMs>,"kind":"request","fingerprint":..,"routeKey":..,"outcome":..,..}
 *
 * Two sources write here, and the second is the important one:
 *
 *   - `"touch"` — a keepalive decision, via `CacheKeepalivePolicy.onDecision`.
 *   - `"request"` — every ordinary assistant message. Its `usage.cacheRead` /
 *     `usage.cacheWrite` is exactly what `classifyCacheOutcome` consumes, so miss
 *     attribution for normal traffic comes from here rather than from touches,
 *     which only ever observe idle gaps the keepalive itself created.
 *
 * Rows carry hashes and numbers only — never prompt content, never a credential, and
 * never a filesystem path.
 *
 * Newline-delimited JSON opened with O_APPEND so concurrent appenders (parallel
 * agents/subagents) never interleave a partial line. Writes are best-effort: a
 * failure is logged at debug and never propagates into the request path, because a
 * telemetry outage must not cost a turn.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { CacheOutcome, CacheRetention, TtlProfile } from "@oh-my-pi/pi-ai/cache";
import { emptyTtlProfile, normalizeEndpoint, observeTtl, routeProfileKey } from "@oh-my-pi/pi-ai/cache";
import { resolveCacheRetention } from "@oh-my-pi/pi-ai/utils";
import { getStatsDbPath, isEnoent, isRecord, logger, parseJsonlLenient } from "@oh-my-pi/pi-utils";

/** Which of the two observation sources produced a row. */
export type CacheObservationKind = "request" | "touch";

/** One observed interaction with a physical provider cache entry. */
export interface CacheObservation {
	/** Epoch milliseconds. Monotonic enough to order rows and difference them. */
	at: number;
	kind: CacheObservationKind;
	/** `cacheFingerprint(identity)` — names the physical entry, never a session. */
	fingerprint: string;
	/** `routeProfileKey(...)` — the coarse key TTL is learned against. */
	routeKey: string;
	outcome: CacheOutcome;
	cacheRead: number;
	cacheWrite: number;
	inputTokens: number;
	costUsd: number;
	/**
	 * Idle seconds since the previous observation of the same {@link fingerprint}.
	 *
	 * Supplied by the caller only when it measures the gap more precisely than the
	 * journal can — a keepalive touch knows the true age of the entry it just probed,
	 * including for the first touch of a chain, where the journal has no predecessor
	 * to difference against. Left undefined otherwise and filled in by
	 * {@link CacheTelemetryStore.recordObservation}; still undefined for the first
	 * observation of a fingerprint, which is honest: one point has no gap.
	 */
	idleSeconds?: number;
	/** Opaque provider session id. Never a filesystem path. */
	sessionId: string;
}

/** `~/.omp/.../cache-observations.jsonl`, colocated with stats.db. */
export function cacheObservationsJournalPath(): string {
	return path.join(path.dirname(getStatsDbPath()), "cache-observations.jsonl");
}

/**
 * Most recent bytes parsed on read. TTL learning needs a handful of samples per
 * route, not history: `resolveTtl`'s gate clears at 3, and rows are ~250 bytes, so
 * this tail holds thousands of them. Bounding the read also makes `loadProfile` cost
 * the same whether the journal is new or a year old.
 */
const JOURNAL_READ_TAIL_BYTES = 512 * 1024;

/**
 * Size at which the journal is rewritten down to {@link JOURNAL_READ_TAIL_BYTES}.
 * Growth is therefore bounded, not merely bounded on read: bytes below the read
 * window are unreachable evidence, so keeping them would cost disk for nothing.
 */
const JOURNAL_MAX_BYTES = 4 * 1024 * 1024;

/** Appends between size checks, so the common append costs no extra `stat`. */
const JOURNAL_SIZE_CHECK_INTERVAL = 64;

/**
 * Reader/writer for the observation journal.
 *
 * One instance per process (see {@link cacheTelemetryStore}): the fingerprint clock
 * that produces `idleSeconds` is per-instance state.
 */
export class CacheTelemetryStore {
	readonly #journalPath: string;
	/** Latest `at` per fingerprint — the origin every computed idle gap measures from. */
	readonly #lastAtByFingerprint = new Map<string, number>();
	#hydration: Promise<void> | undefined;
	#dirEnsured = false;
	#appendsSinceSizeCheck = 0;
	#cache: { key: string; rows: CacheObservation[] } | undefined;
	/** In-flight appends, so callers that float this work can still await it. */
	readonly #inFlight = new Set<Promise<void>>();

	constructor(journalPath: string = cacheObservationsJournalPath()) {
		this.#journalPath = journalPath;
	}

	/**
	 * Append one observation, filling in `idleSeconds` when the caller did not measure
	 * it. Never rejects and never throws: every failure degrades to a debug log, so a
	 * caller on the request path can await this without a guard — or float it and reach
	 * for {@link settle}.
	 */
	async recordObservation(observation: CacheObservation): Promise<void> {
		const task = this.#write(observation);
		this.#inFlight.add(task);
		try {
			await task;
		} finally {
			this.#inFlight.delete(task);
		}
	}

	/**
	 * Await every append started so far.
	 *
	 * Both production callers float `recordObservation` — the request path must not pay
	 * journal latency at the end of a turn — which leaves no other way to observe that a
	 * row landed. Loops because an append may be enqueued while an earlier one drains.
	 */
	async settle(): Promise<void> {
		while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
	}

	async #write(observation: CacheObservation): Promise<void> {
		try {
			const supplied = observation.idleSeconds;
			const idleSeconds =
				typeof supplied === "number" && Number.isFinite(supplied) && supplied >= 0
					? supplied
					: await this.#idleGap(observation.fingerprint, observation.at);
			// Advance the clock even when the gap came from the caller, so the next
			// observation of this fingerprint can difference against this one.
			const previous = this.#lastAtByFingerprint.get(observation.fingerprint);
			if (previous === undefined || observation.at > previous) {
				this.#lastAtByFingerprint.set(observation.fingerprint, observation.at);
			}
			const row: CacheObservation = { ...observation };
			if (idleSeconds === undefined) delete row.idleSeconds;
			else row.idleSeconds = idleSeconds;
			await this.#append(JSON.stringify(row));
		} catch (err) {
			logger.debug("cache telemetry: observation not recorded", { err: String(err) });
		}
	}

	/**
	 * Fold every persisted observation for `routeKey` through `observeTtl`, or
	 * `undefined` when the route has none — which `resolveTtl` correctly reads as "no
	 * profile" and answers from its default tier.
	 *
	 * Both kinds are evidence. Rows are handed to `observeTtl` unfiltered on purpose:
	 * it already distinguishes a bound-moving sample from a `success-unverified` row
	 * (confidence only) and from a row with no idle gap (neither). Pre-filtering here
	 * would silently discard the confidence signal that a drifting route emits.
	 */
	async loadProfile(routeKey: string): Promise<TtlProfile | undefined> {
		const matching = (await this.#read()).filter(row => row.routeKey === routeKey);
		if (matching.length === 0) return undefined;
		// Rows from concurrent processes interleave in append order; fold in time order
		// so one profile does not depend on which process flushed first.
		matching.sort((left, right) => left.at - right.at);
		let profile = emptyTtlProfile();
		for (const row of matching) {
			profile = observeTtl(profile, { outcome: row.outcome, idleSeconds: row.idleSeconds });
		}
		return profile;
	}

	/** All parsed rows in the read window. Malformed lines are skipped. */
	async readObservations(): Promise<CacheObservation[]> {
		return await this.#read();
	}

	async #idleGap(fingerprint: string, at: number): Promise<number | undefined> {
		// Memoized on the promise, not a boolean: fire-and-forget callers overlap, and a
		// boolean flag set before the read completes would let the second caller read an
		// empty clock and report a first-observation gap for a fingerprint with history.
		this.#hydration ??= this.#seedFingerprintClock();
		await this.#hydration;
		const previous = this.#lastAtByFingerprint.get(fingerprint);
		// A non-monotonic pair (clock step, out-of-order flush) cannot describe an idle
		// age, and `observeTtl` would reject the negative anyway — report it as unknown.
		if (previous === undefined || at < previous) return undefined;
		return (at - previous) / 1000;
	}

	/**
	 * Seed the fingerprint clock from the journal once, so the first observation of a
	 * fingerprint that a previous process already saw still yields a real gap.
	 *
	 * The in-process map is authoritative afterwards. A second live process appending
	 * for the *same* fingerprint would make it stale, but a fingerprint covers the full
	 * history hash, so two processes sharing one is essentially unreachable — and the
	 * cost would be one imprecise sample, not a fault.
	 */
	async #seedFingerprintClock(): Promise<void> {
		for (const row of await this.#read()) {
			const previous = this.#lastAtByFingerprint.get(row.fingerprint);
			if (previous === undefined || row.at > previous) this.#lastAtByFingerprint.set(row.fingerprint, row.at);
		}
	}

	async #append(line: string): Promise<void> {
		if (!this.#dirEnsured) {
			await fs.mkdir(path.dirname(this.#journalPath), { recursive: true });
			this.#dirEnsured = true;
		}
		if (this.#appendsSinceSizeCheck === 0) await this.#rotateIfOversized();
		this.#appendsSinceSizeCheck = (this.#appendsSinceSizeCheck + 1) % JOURNAL_SIZE_CHECK_INTERVAL;
		await fs.appendFile(this.#journalPath, `${line}\n`);
	}

	/**
	 * Rewrite the journal to its most recent complete lines once it exceeds
	 * {@link JOURNAL_MAX_BYTES}. Staged through a temp file and renamed so a concurrent
	 * reader observes either the old file or the new one, never a half-written one.
	 * A concurrent appender in another process can lose a row to the swap; that is an
	 * acceptable price for a bounded file, and no row is load-bearing on its own.
	 */
	async #rotateIfOversized(): Promise<void> {
		let stat: Stats;
		try {
			stat = await fs.stat(this.#journalPath);
		} catch (err) {
			if (!isEnoent(err)) logger.debug("cache telemetry: journal stat failed", { err: String(err) });
			return;
		}
		if (stat.size <= JOURNAL_MAX_BYTES) return;
		const tail = await Bun.file(this.#journalPath)
			.slice(stat.size - JOURNAL_READ_TAIL_BYTES)
			.text();
		const boundary = tail.indexOf("\n");
		if (boundary === -1) return;
		const staged = `${this.#journalPath}.${process.pid}.tmp`;
		await Bun.write(staged, tail.slice(boundary + 1));
		await fs.rename(staged, this.#journalPath);
		this.#cache = undefined;
	}

	async #read(): Promise<CacheObservation[]> {
		let stat: Stats;
		try {
			stat = await fs.stat(this.#journalPath);
		} catch (err) {
			// A journal that was never written is zero observations, not a fault.
			if (!isEnoent(err)) logger.debug("cache telemetry: journal stat failed", { err: String(err) });
			return [];
		}

		const key = `${stat.mtimeMs}:${stat.size}`;
		const cached = this.#cache;
		if (cached?.key === key) return cached.rows;

		const start = stat.size > JOURNAL_READ_TAIL_BYTES ? stat.size - JOURNAL_READ_TAIL_BYTES : 0;
		let text: string;
		try {
			const file = Bun.file(this.#journalPath);
			text = await (start === 0 ? file.text() : file.slice(start).text());
		} catch (err) {
			if (!isEnoent(err)) logger.debug("cache telemetry: journal read failed", { err: String(err) });
			return [];
		}
		if (start > 0) {
			// The window opens mid-line; that leading fragment is not a record.
			const boundary = text.indexOf("\n");
			text = boundary === -1 ? "" : text.slice(boundary + 1);
		}

		let malformed = 0;
		const rows: CacheObservation[] = [];
		// Framing is `parseJsonlLenient`'s job (it drives `Bun.JSONL.parseChunk` and skips
		// torn or corrupt records); this loop only validates the parsed values.
		for (const value of parseJsonlLenient<unknown>(text, { onMalformedRecord: () => (malformed += 1) })) {
			const row = toObservation(value);
			if (row !== undefined) rows.push(row);
		}
		if (malformed > 0) {
			logger.debug("cache telemetry: skipped malformed journal records", { malformed });
		}
		this.#cache = { key, rows };
		return rows;
	}
}

/**
 * Accepted outcome values. Typed as a total `Record` over the union so adding a
 * `CacheOutcome` upstream fails to compile here until this reader handles it, rather
 * than silently dropping every row carrying the new value.
 */
const KNOWN_CACHE_OUTCOMES: Record<CacheOutcome, true> = {
	"confirmed-hit": true,
	"miss-rebuilt": true,
	"success-unverified": true,
	failed: true,
};

/** Numeric fields that default to 0 when absent or non-finite. */
const OBSERVATION_COUNTERS = ["cacheRead", "cacheWrite", "inputTokens", "costUsd"] as const;

/**
 * Validate one already-parsed record, or `undefined` when it cannot be trusted.
 *
 * Framing failures — a torn final line from a process that died mid-append, or a
 * corrupted record — are handled upstream by `parseJsonlLenient`. A record can still
 * parse cleanly and be unusable, though: a row missing its outcome would fold into a
 * profile as garbage. Every field the fold reads is therefore checked here, and a row
 * that fails any check is skipped rather than repaired.
 */
function toObservation(value: unknown): CacheObservation | undefined {
	if (!isRecord(value)) return undefined;
	const row = value as Partial<CacheObservation>;
	if (typeof row.at !== "number" || !Number.isFinite(row.at)) return undefined;
	if (row.kind !== "request" && row.kind !== "touch") return undefined;
	if (typeof row.fingerprint !== "string" || row.fingerprint.length === 0) return undefined;
	if (typeof row.routeKey !== "string" || row.routeKey.length === 0) return undefined;
	const outcome = row.outcome;
	if (outcome === undefined || KNOWN_CACHE_OUTCOMES[outcome] !== true) return undefined;

	const counters = { cacheRead: 0, cacheWrite: 0, inputTokens: 0, costUsd: 0 };
	for (const field of OBSERVATION_COUNTERS) {
		const raw = row[field];
		if (typeof raw === "number" && Number.isFinite(raw)) counters[field] = raw;
	}

	const parsed: CacheObservation = {
		at: row.at,
		kind: row.kind,
		fingerprint: row.fingerprint,
		routeKey: row.routeKey,
		outcome,
		...counters,
		sessionId: typeof row.sessionId === "string" ? row.sessionId : "",
	};
	// An idle age that is absent, non-numeric, or negative is *unknown*, and
	// `observeTtl` must see it as unknown rather than as zero — zero would pin the
	// lower bound at 0 and assert the entry died immediately.
	if (typeof row.idleSeconds === "number" && Number.isFinite(row.idleSeconds) && row.idleSeconds >= 0) {
		parsed.idleSeconds = row.idleSeconds;
	}
	return parsed;
}

/** Route dimensions shared by the per-message recorder and the keepalive policy. */
export interface CacheTelemetryRoute {
	/** `routeProfileKey(...)` for this model/retention pair. */
	routeKey: string;
	/** Normalized endpoint, reused as a {@link CacheObservation} identity field. */
	endpoint: string;
	retention: Exclude<CacheRetention, "none">;
}

/**
 * Resolve the route a request will cache under, or `undefined` for
 * `retention: "none"` — no entry is created then, so there is nothing to learn from
 * and nothing to keep warm.
 *
 * `retentionSetting` is the raw `providers.cacheRetention` value; `"auto"` means "no
 * override", which `resolveCacheRetention` maps to the same `"short"` default the
 * providers apply, so the key matches the entry the provider actually wrote.
 */
export function resolveCacheTelemetryRoute(
	model: Model,
	retentionSetting: CacheRetention | "auto" | undefined,
): CacheTelemetryRoute | undefined {
	const retention = resolveCacheRetention(retentionSetting === "auto" ? undefined : retentionSetting);
	if (retention === "none") return undefined;
	const endpoint = normalizeEndpoint(model.baseUrl);
	return {
		endpoint,
		retention,
		routeKey: routeProfileKey({
			provider: model.provider,
			api: model.api,
			modelId: model.id,
			endpoint,
			// No transport we read here reports which gateway/region served the request,
			// so this dimension stays empty rather than guessed: a fabricated route would
			// shard one profile into fragments that each stay below the sample gate.
			route: "",
			retention,
		}),
	};
}

let sharedStore: CacheTelemetryStore | undefined;

/**
 * Process-wide store. The keepalive policy (`sdk.ts`) and the per-message recorder
 * (`agent-session.ts`) must share one instance: the fingerprint clock behind
 * `idleSeconds` is per-instance, so two stores would each difference against half the
 * observations and report gaps twice as long as the truth.
 */
export function cacheTelemetryStore(): CacheTelemetryStore {
	sharedStore ??= new CacheTelemetryStore();
	return sharedStore;
}
