/**
 * scheduler — session-quota-aware prompt queue for oh-my-pi (omp).
 *
 * Queue prompts, then let the scheduler drain them unattended (e.g. overnight):
 * it dispatches the next task whenever the agent goes idle, tracks Claude's
 * 5-hour session windows (max N per rolling 24h) when — and only when — the
 * active model matches a gated quota profile (Anthropic Claude subscription
 * auth), dispatches ungated for every other provider, waits for the next
 * window when a gated quota is exhausted, and RESUMES interrupted tasks
 * instead of skipping them.
 *
 * Extension shape per omp docs (extensions.md § "What an extension is"):
 * a TS module exporting a default factory that receives ExtensionAPI.
 * Ships as @oh-my-pi/scheduler-extension (packages/scheduler-extension);
 * also installable standalone by copying into ~/.omp/agent/extensions/scheduler
 * (skills/authoring-extensions.md § "Discovery paths").
 *
 * Every runtime API used below is cited against the omp docs:
 *   - extensions.md            (runtime reference; "§" quotes its headings)
 *   - authoring-extensions.md  (the authoring skill)
 *   - settings.md              (config file locations / precedence)
 *   - approval-mode.md         (tools.approvalMode semantics)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import CONTEXT_RESET_COMPACT_INSTRUCTION from "./prompts/context-reset-compact.md" with { type: "text" };
import DEFAULT_PROMPT_PREAMBLE from "./prompts/prompt-preamble.md" with { type: "text" };
import DEFAULT_RESUME_PREAMBLE from "./prompts/resume-preamble.md" with { type: "text" };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle of one queued prompt. */
export type TaskStatus =
	| "queued" // waiting for dispatch
	| "running" // dispatched, turn in progress
	| "interrupted" // turn ended in error/rate-limit/abort — will be re-sent with resume preamble
	| "done" // turn completed normally
	| "failed"; // exceeded maxAttempts; will not be retried

/** One queued prompt. */
export interface SchedulerTask {
	id: string;
	prompt: string;
	/**
	 * Stable SHA-256 (first 12 hex) of the prompt. Identifies a prompt across
	 * runs/queues independent of the volatile `id`, and keys the ledger table so
	 * re-queuing the same prompt tracks to the same row.
	 */
	promptHash?: string;
	/**
	 * Code-generated one-line outcome (≤100 chars) recorded at settle: the final
	 * assistant line for a pass, or `classification: error` for a fail. No LLM
	 * call — reuses the turn's own last message / the classifier's verdict.
	 */
	summary?: string;
	/** Set when the prompt was loaded via `add-file`. */
	sourceFile?: string;
	status: TaskStatus;
	addedAt: string;
	dispatchedAt?: string;
	endedAt?: string;
	attempts: number;
	lastError?: string;
	/**
	 * Times this task's turn ended in an Anthropic content-policy violation
	 * ("cyber"/usage-policy classifier). Each such hit purges the poisoned
	 * conversation context and re-dispatches with the attempt refunded; only
	 * after `maxContextResets` of them (a genuinely un-runnable prompt) is the
	 * task marked failed. Distinct from `attempts`, which counts task-fault errors.
	 */
	policyResets?: number;
	/**
	 * Consecutive watchdog stall recoveries — a dispatched turn that never
	 * materialized (no `agent_start`). Reset to 0 the moment a turn actually
	 * starts. After `maxAttempts` consecutive stalls the task is failed rather
	 * than re-queued forever, so a persistently undeliverable prompt (no model /
	 * API key, a rejecting pre-turn hook) can't loop indefinitely on refunded
	 * attempts. Distinct from `attempts` (task-fault) and `policyResets`.
	 */
	stalls?: number;
}

/** Scheduler run mode set by start/pause/stop. */
export type RunMode = "stopped" | "running" | "paused";

/** One locally observed provider session window (state.json). */
export interface WindowRecord {
	/** ISO timestamp of the window start. */
	startedAt: string;
	/** `match` pattern of the quota profile the window was recorded under. */
	profile: string;
}

/** Persisted state (state.json in the data dir). */
export interface SchedulerState {
	version: 2;
	run: RunMode;
	tasks: SchedulerTask[];
	/**
	 * Provider session windows observed locally, tagged with the quota
	 * profile they were recorded under so counts survive model switches
	 * (v1 stored plain ISO strings; migrated on load).
	 */
	windows: WindowRecord[];
	/** Task currently in flight, if any (survives crashes for resume-not-skip). */
	currentTaskId: string | null;
	/**
	 * Provider-declared rate-limit hold (ISO): no dispatch until this time.
	 * Set from the 429 retry-after when provider retries are exhausted;
	 * cleared on expiry or by any turn that ends without a rate limit.
	 */
	rateLimitedUntil?: string | null;
	nextTaskSeq: number;
}

/**
 * One quota profile: which models it applies to and its window policy.
 * Only Anthropic Claude *subscription* auth meters usage in session windows;
 * API-key billing and other providers have no such windows.
 */
export interface QuotaProfile {
	/**
	 * Case-insensitive regex tested against the provider id, the model id,
	 * and "provider/modelId" of the active model. First match wins.
	 */
	match: string;
	/** Length of one session window, in hours. null = unlimited (no windows). */
	sessionHours: number | null;
	/** Maximum session windows per rolling 24 hours. null = unlimited. */
	maxSessionsPer24h: number | null;
}

/** User-editable configuration (config.json in the data dir). */
export interface SchedulerConfig {
	/**
	 * Ordered quota profiles; the first whose `match` hits the active
	 * provider/model applies. No match (or undetectable model) = unlimited.
	 */
	quotaProfiles: QuotaProfile[];
	/** Attempts (initial + resumes) before a task is marked failed. */
	maxAttempts: number;
	/** Idle settle delay before dispatching the next task, in ms. */
	dispatchDelayMs: number;
	/** Extra slack added when arming the next-window resume timer, in ms. */
	windowSlackMs: number;
	/** Prepended to every dispatched prompt (token-efficiency / autonomy rules). */
	promptPreamble: string;
	/** Additionally prepended when re-dispatching an interrupted task. */
	resumePreamble: string;
	/** First retry delay after a network/outage interruption, in ms (doubles each consecutive outage). */
	outageBackoffBaseMs: number;
	/** Ceiling for the outage retry delay, in ms. */
	outageBackoffMaxMs: number;
	/** Watchdog tick interval, in ms; self-heals lost timers and stalled dispatches. */
	watchdogIntervalMs: number;
	/** How long a dispatched task may sit with an idle agent before the watchdog re-queues it, in ms. */
	stallTimeoutMs: number;
	/**
	 * Content-policy ("cyber") violations that purge the context and re-dispatch
	 * a task before it is finally marked failed. Refunded like rate limits, so a
	 * poison cascade never burns the normal attempt budget; the cap only guards
	 * against an infinite loop on a prompt that trips the classifier every time.
	 */
	maxContextResets: number;
}

/**
 * How a turn that ended in error was classified. Determines the recovery path:
 * `rate_limit`/`outage`/`content_policy` refund the attempt (not the task's
 * fault) and hold/backoff/reset; `user_abort` pauses the queue; `task_fault`
 * is the only class that counts against `maxAttempts` and can end in `failed`.
 * `stalled`/`shutdown` are watchdog/lifecycle settlements.
 */
export type TurnOutcome =
	| "rate_limit"
	| "outage"
	| "content_policy"
	| "user_abort"
	| "task_fault"
	| "stalled"
	| "shutdown";

/** One JSONL log record (task-log.jsonl in the data dir). */
export interface SchedulerLogEntry {
	ts: string;
	event:
		| "start"
		| "pause"
		| "stop"
		| "dispatch"
		| "end"
		| "blocked"
		| "resume_timer"
		| "window_start"
		| "recovered"
		| "retry_failed"
		| "notice"
		| "context_reset";
	taskId?: string;
	status?: TaskStatus;
	attempt?: number;
	resumed?: boolean;
	error?: string;
	durationMs?: number;
	resumeAt?: string;
	detail?: string;
	/**
	 * How an errored turn was classified — the single fact that used to require
	 * cross-referencing the source regexes to reconstruct. Drives whether the
	 * attempt is refunded and whether the task can ever fail.
	 */
	classification?: TurnOutcome;
	/** True when the attempt was refunded (transient fault, not the task's). */
	refunded?: boolean;
	/** Attempt budget at the moment of logging, e.g. 3 of maxAttempts. */
	attempts?: number;
	maxAttempts?: number;
	/** True when this end is terminal (status "failed"): no auto-retry follows. */
	terminal?: boolean;
	/** Truncated prompt, so the log is self-describing without opening state.json. */
	prompt?: string;
	/** Stable prompt fingerprint (SHA-256/12) for cross-run tracking. */
	promptHash?: string;
	/** Code-generated ≤100-char outcome summary recorded at settle. */
	summary?: string;
}

/**
 * Structural subset of the handler context this extension uses.
 * All members are documented in extensions.md § "2) Handler context
 * (ExtensionContext)" and § "UI integration points"; commands additionally
 * receive ExtensionCommandContext (§ "3) Command context") which is a
 * superset, so this shape fits both.
 */
interface CtxLike {
	ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		confirm(title: string, message: string): Promise<boolean>;
		setStatus(key: string, text: string): void;
	};
	hasUI: boolean;
	cwd: string;
	/** extensions.md § "2) Handler context": `model`, `models` (read-only model query). */
	model?: unknown;
	models?: { current?(): unknown };
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	abort(): void | Promise<void>;
	getContextUsage(): { tokens: number; contextWindow: number; percent: number } | undefined;
	/**
	 * Runtime session control. `newSession` starts a fresh, empty conversation
	 * (purging the history the content-policy classifier flagged) with no LLM
	 * call, but the host wires it ONLY onto the command context
	 * (createCommandContext) — so it is read from the retained command context,
	 * never the event/timer context. `compact` lives on the base context and is
	 * the reduce-in-place fallback. Optional so headless / older hosts degrade.
	 */
	newSession?(options?: unknown): Promise<unknown> | undefined;
	compact?(instructionsOrOptions?: unknown): Promise<void> | undefined;
	/**
	 * Managed background timers (runner ManagedTimers / ExtensionContext). Unlike
	 * raw globals, a throw inside the callback is contained and routed through the
	 * extension error channel instead of escaping as a process-fatal
	 * `uncaughtException` that would tear down the whole session (issue #5664);
	 * handles are unref'd and auto-cleared on `session_shutdown`. Optional so a
	 * host that predates them degrades to the guarded global-timer fallback.
	 */
	setTimeout?(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer;
	setInterval?(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer;
	clearTimer?(timer: Timer): void;
}

/**
 * Timer handle. Managed timers (`ctx.setTimeout`/`ctx.setInterval`) and the
 * global fallback both return a Bun `Timer`; only ever passed back to the
 * matching clear (`ctx.clearTimer`, or `clearTimeout`/`clearInterval`).
 */
type TimerHandle = Timer;
type IntervalHandle = Timer;

// ---------------------------------------------------------------------------
// Data dir + defaults
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Base agent directory. Delegates to the shared resolver so `PI_CODING_AGENT_DIR`,
 * `PI_CONFIG_DIR`, named profiles, and the XDG layout all resolve exactly as
 * omp's own config loader does (settings.md § "Where settings live");
 * reconstructing the path here drifts from the host on any non-default layout.
 */
function agentDir(): string {
	return getAgentDir();
}

function dataDir(): string {
	return path.join(agentDir(), "scheduler");
}
function stateFile(): string {
	return path.join(dataDir(), "state.json");
}
function configFile(): string {
	return path.join(dataDir(), "config.json");
}
function logFile(): string {
	return path.join(dataDir(), "task-log.jsonl");
}
function ledgerFile(): string {
	return path.join(dataDir(), "task-ledger.md");
}

/**
 * Default quota profiles: only the Anthropic *provider* (Claude subscription
 * auth) is metered in 5-hour session windows (max 4 per rolling 24h). The match
 * is ANCHORED to the provider id (`^anthropic$`), never a bare model id — so a
 * third-party catalog serving a `claude`/`anthropic.*` model under another
 * provider (Bedrock, OpenRouter, API-key gateways) does NOT match and falls
 * through to the unlimited `.*` profile. First match wins; edit config.json.
 */
const DEFAULT_QUOTA_PROFILES: QuotaProfile[] = [
	{ match: "^anthropic$", sessionHours: 5, maxSessionsPer24h: 4 },
	{ match: ".*", sessionHours: null, maxSessionsPer24h: null },
];

const DEFAULT_CONFIG: SchedulerConfig = {
	quotaProfiles: DEFAULT_QUOTA_PROFILES,
	maxAttempts: 3,
	dispatchDelayMs: 4000,
	windowSlackMs: 60_000,
	promptPreamble: DEFAULT_PROMPT_PREAMBLE,
	resumePreamble: DEFAULT_RESUME_PREAMBLE,
	outageBackoffBaseMs: 30_000,
	outageBackoffMaxMs: 15 * 60_000,
	watchdogIntervalMs: 60_000,
	stallTimeoutMs: 10 * 60_000,
	maxContextResets: 5,
};

const EMPTY_STATE: SchedulerState = {
	version: 2,
	run: "stopped",
	tasks: [],
	windows: [],
	currentTaskId: null,
	rateLimitedUntil: null,
	nextTaskSeq: 1,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
	fs.mkdirSync(dataDir(), { recursive: true });
}

/** Atomic-ish JSON write: temp file then rename. */
function writeJson(file: string, value: unknown): void {
	ensureDataDir();
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (isEnoent(err)) return undefined; // file ABSENT (ENOENT) — callers may seed defaults
		throw err; // permission/IO error: surface it, never masquerade as "missing"
	}
	// Returns the parsed value as-is — including a literal `null`, primitive, or
	// array. Callers must route a present-but-non-object value through their
	// validation/malformed path, NOT treat it like an absent file.
	return JSON.parse(text) as T;
}

/** Limits of a gated quota profile (both bounds present and positive). */
interface GatedLimits {
	sessionHours: number;
	maxSessionsPer24h: number;
}

/** The quota situation of the active provider/model, resolved at use time. */
interface ActiveQuota {
	/** Profile `match` pattern; also the key window records are tagged with. */
	key: string;
	provider: string;
	modelId: string;
	/** False when the extension API exposed no readable model. */
	detected: boolean;
	/** null = unlimited: no window tracking, no dispatch gating. */
	limits: GatedLimits | null;
}

/**
 * Active provider/model, read defensively from the handler context.
 * extensions.md § "Model selection (ctx.models)": "current() — the live
 * session model (read lazily, so it reflects /model switches)", with
 * ctx.model (§ "2) Handler context") as fallback. Model strings are
 * documented as "provider/id", so only those two fields are relied on;
 * anything unreadable resolves to null (= unknown).
 */
function detectModel(ctx: CtxLike | null): { provider: string; modelId: string } | null {
	if (!ctx) return null;
	let m: unknown;
	try {
		m = ctx.models?.current?.();
	} catch {
		m = undefined;
	}
	if (!m) m = ctx.model;
	const rec = m as { provider?: unknown; id?: unknown } | null | undefined;
	const provider = typeof rec?.provider === "string" ? rec.provider : "";
	const modelId = typeof rec?.id === "string" ? rec.id : "";
	return provider || modelId ? { provider, modelId } : null;
}

/** First matching quota profile for the active model; no match/unknown = unlimited. */
function resolveQuota(ctx: CtxLike | null, cfg: SchedulerConfig): ActiveQuota {
	const detected = detectModel(ctx);
	if (!detected) return { key: "unknown", provider: "", modelId: "", detected: false, limits: null };
	const { provider, modelId } = detected;
	for (const p of cfg.quotaProfiles) {
		let re: RegExp;
		try {
			re = new RegExp(p.match, "i");
		} catch {
			continue; // invalid user pattern — skip; later profiles still apply
		}
		if (!(re.test(provider) || re.test(modelId) || re.test(`${provider}/${modelId}`))) continue;
		if (
			typeof p.sessionHours === "number" &&
			p.sessionHours > 0 &&
			typeof p.maxSessionsPer24h === "number" &&
			p.maxSessionsPer24h > 0
		) {
			return {
				key: p.match,
				provider,
				modelId,
				detected: true,
				limits: { sessionHours: p.sessionHours, maxSessionsPer24h: p.maxSessionsPer24h },
			};
		}
		return { key: p.match, provider, modelId, detected: true, limits: null };
	}
	return { key: "unmatched", provider, modelId, detected: true, limits: null };
}

/** Start (epoch ms) of the profile's session window covering `now`, or null. */
function activeWindowStart(state: SchedulerState, key: string, sessionHours: number, now: number): number | null {
	const len = sessionHours * HOUR_MS;
	for (const w of state.windows) {
		if (w.profile !== key) continue;
		const t = Date.parse(w.startedAt);
		if (Number.isFinite(t) && now >= t && now < t + len) return t;
	}
	return null;
}

/** The profile's window starts (epoch ms, ascending) within the last rolling 24h. */
function windowStartsInLast24h(state: SchedulerState, key: string, now: number): number[] {
	return state.windows
		.filter(w => w.profile === key)
		.map(w => Date.parse(w.startedAt))
		.filter(t => Number.isFinite(t) && now - t < DAY_MS && t <= now)
		.sort((a, b) => a - b);
}

/** Drop window records too old to matter for the rolling 24h math. */
function pruneWindows(state: SchedulerState, now: number): void {
	state.windows = state.windows.filter(w => {
		const t = Date.parse(w.startedAt);
		return Number.isFinite(t) && now - t < 2 * DAY_MS;
	});
}

const RUN_MODES: Record<string, true> = { stopped: true, running: true, paused: true };
const TASK_STATUSES: Record<string, true> = {
	queued: true,
	running: true,
	interrupted: true,
	done: true,
	failed: true,
};

/**
 * Full structural check of one persisted task row. A syntactically-valid
 * state.json whose task objects miss/mistype required fields (id, prompt,
 * status, addedAt, attempts) — or carry a wrong-typed optional — would otherwise
 * be accepted, then crash hashPrompt/ledger or hide from the status filters.
 * Required fields must be present and correctly typed; optionals are validated
 * only when present.
 */
function isValidTaskRow(row: unknown): boolean {
	if (row === null || typeof row !== "object") return false;
	const r = row as Record<string, unknown>;
	if (typeof r.id !== "string" || typeof r.prompt !== "string") return false;
	if (typeof r.status !== "string" || !Object.hasOwn(TASK_STATUSES, r.status)) return false;
	if (typeof r.addedAt !== "string") return false;
	if (typeof r.attempts !== "number" || !Number.isFinite(r.attempts)) return false;
	for (const k of ["promptHash", "summary", "sourceFile", "dispatchedAt", "endedAt", "lastError"]) {
		if (r[k] !== undefined && typeof r[k] !== "string") return false;
	}
	for (const k of ["policyResets", "stalls"]) {
		if (r[k] !== undefined && typeof r[k] !== "number") return false;
	}
	return true;
}

/**
 * Name of the first config field whose value has the wrong type, or null when
 * every present field matches SchedulerConfig. Missing fields are fine (defaults
 * fill them); only a present-but-mistyped field is rejected, so a hand-edited
 * `config.json` like `{ "promptPreamble": 123 }` never reaches a string/number
 * helper as the wrong type. Legacy `windowHours`/`maxWindowsPer24h` are ignored
 * (migrated separately with their own guards).
 */
function configShapeError(onDisk: unknown): string | null {
	if (onDisk === null || typeof onDisk !== "object") return null;
	const c = onDisk as Record<string, unknown>;
	const numeric = [
		"maxAttempts",
		"dispatchDelayMs",
		"windowSlackMs",
		"outageBackoffBaseMs",
		"outageBackoffMaxMs",
		"watchdogIntervalMs",
		"stallTimeoutMs",
		"maxContextResets",
	];
	for (const k of numeric) {
		if (c[k] !== undefined && (typeof c[k] !== "number" || !Number.isFinite(c[k]))) return k;
	}
	for (const k of ["promptPreamble", "resumePreamble"]) {
		if (c[k] !== undefined && typeof c[k] !== "string") return k;
	}
	if (c.quotaProfiles !== undefined) {
		if (!Array.isArray(c.quotaProfiles)) return "quotaProfiles";
		for (const p of c.quotaProfiles) {
			if (p === null || typeof p !== "object") return "quotaProfiles[]";
			const pr = p as Record<string, unknown>;
			if (typeof pr.match !== "string") return "quotaProfiles[].match";
			if (pr.sessionHours !== null && typeof pr.sessionHours !== "number") return "quotaProfiles[].sessionHours";
			if (pr.maxSessionsPer24h !== null && typeof pr.maxSessionsPer24h !== "number")
				return "quotaProfiles[].maxSessionsPer24h";
		}
	}
	return null;
}
/**
 * Migrate persisted state to the current shape. v1 stored windows as plain
 * ISO strings under the then-global (Claude-only) quota; they are re-tagged
 * with the first gated profile so a mid-upgrade day keeps counting them.
 */
function migrateState(raw: unknown, cfg: SchedulerConfig): SchedulerState | null {
	if (!raw || typeof raw !== "object") return null;
	const st = raw as SchedulerState & { windows?: unknown[] };
	// Reject a present-but-wrong-shape file (e.g. `{}` or hand-mangled JSON):
	// returning null on a non-absent file routes it through the unreadable-state
	// path rather than coercing it (which later crashes iterating tasks / clobbers it).
	if (
		!Array.isArray(st.tasks) ||
		typeof st.run !== "string" ||
		!Object.hasOwn(RUN_MODES, st.run) ||
		typeof st.nextTaskSeq !== "number" ||
		!Number.isFinite(st.nextTaskSeq) ||
		(st.currentTaskId !== null && typeof st.currentTaskId !== "string")
	) {
		return null;
	}
	for (const row of st.tasks as unknown[]) {
		// Full row validation (id/prompt/status/addedAt/attempts + optional types).
		// A partial row like `{id,prompt}` would otherwise be accepted, then crash
		// hashPrompt/ledger or hide from the status filters.
		if (!isValidTaskRow(row)) return null;
	}
	const legacyKey =
		cfg.quotaProfiles.find(p => typeof p.sessionHours === "number" && typeof p.maxSessionsPer24h === "number")
			?.match ?? DEFAULT_QUOTA_PROFILES[0].match;
	const windows: WindowRecord[] = [];
	for (const w of (Array.isArray(st.windows) ? st.windows : []) as unknown[]) {
		if (typeof w === "string") {
			windows.push({ startedAt: w, profile: legacyKey }); // v1 plain-ISO window
		} else if (w !== null && typeof w === "object") {
			const wr = w as Record<string, unknown>;
			if (typeof wr.startedAt !== "string" || typeof wr.profile !== "string") return null;
			windows.push({ startedAt: wr.startedAt, profile: wr.profile });
		} else {
			return null; // neither a legacy string nor a {startedAt, profile} record
		}
	}
	st.windows = windows;
	st.rateLimitedUntil ??= null;
	st.version = 2;
	return st;
}

interface QuotaVerdict {
	ok: boolean;
	/** When blocked: epoch ms at which the oldest counted window falls out of the 24h horizon. */
	nextAt?: number;
	reason?: string;
}

/** Can a prompt be dispatched now without exceeding the gated profile's quota? */
function quotaCheck(state: SchedulerState, key: string, limits: GatedLimits, now: number): QuotaVerdict {
	if (activeWindowStart(state, key, limits.sessionHours, now) !== null) return { ok: true };
	const used = windowStartsInLast24h(state, key, now);
	if (used.length < limits.maxSessionsPer24h) return { ok: true };
	return {
		ok: false,
		nextAt: used[0] + DAY_MS,
		reason: `all ${limits.maxSessionsPer24h} session windows used in the last 24h (profile "${key}")`,
	};
}

function nextPendingTask(state: SchedulerState): SchedulerTask | undefined {
	// Resume-not-skip: an interrupted task keeps its queue position and is
	// simply the first pending task again on the next dispatch.
	return state.tasks.find(t => t.status === "queued" || t.status === "interrupted");
}

function truncate(text: string, max: number): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** Stable prompt fingerprint: first 12 hex of SHA-256. Same prompt → same id. */
function hashPrompt(prompt: string): string {
	return crypto.createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 12);
}

/**
 * Plain text of the final assistant message in an agent_end payload, or null.
 * Lets a successful turn be summarized for free — the text was already produced,
 * so no extra LLM call. Defensive reads mirror detectTurnError (the payload
 * shape is not a documented contract): narrow with `in`/`typeof`, never cast.
 */
function lastAssistantText(event: unknown): string | null {
	if (!event || typeof event !== "object" || !("messages" in event)) return null;
	const { messages } = event;
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg: unknown = messages[i];
		if (!msg || typeof msg !== "object" || !("role" in msg) || msg.role !== "assistant") continue;
		if (!("content" in msg) || !Array.isArray(msg.content)) return null;
		const parts: string[] = [];
		for (const b of msg.content) {
			if (
				b &&
				typeof b === "object" &&
				"type" in b &&
				b.type === "text" &&
				"text" in b &&
				typeof b.text === "string"
			) {
				parts.push(b.text);
			}
		}
		const text = parts.join(" ").trim();
		return text || null;
	}
	return null;
}

/**
 * Code-generated ≤100-char outcome line for the ledger — zero LLM cost. A pass
 * reuses the turn's own last assistant line (falling back to a duration note);
 * any non-pass reports its classification and the truncated error.
 */
function buildSummary(
	status: TaskStatus,
	classification: TurnOutcome | undefined,
	error: string | null,
	assistantText: string | null,
	durationMs: number | undefined,
): string {
	if (status === "done") {
		const base =
			assistantText ?? (durationMs !== undefined ? `completed in ${fmtDuration(durationMs)}` : "completed");
		return truncate(base, 100);
	}
	const cls = classification ?? "task_fault";
	return truncate(error ? `${cls}: ${error}` : cls, 100);
}

function fmtDuration(ms: number): string {
	if (ms < 0) ms = 0;
	const totalMin = Math.round(ms / 60_000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

function fmtClock(epochMs: number): string {
	const d = new Date(epochMs);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Best-effort scan of persisted settings for an approval policy that could block
 * an unattended run. settings.md § Precedence: project `<cwd>/.omp/config.{yml,
 * yaml}` + legacy `settings.json`, plus the project files other settings providers merge verbatim (`.claude/settings*.json`, `.cursor`/`.gemini` `settings.json`, `opencode.json`, `.codex/config.toml`), then global
 * `~/.omp/agent/…`. Runtime flags (`--yolo`) are in-memory and invisible here, so
 * callers treat a hit as a warning, not a hard fact. The extension can't see the
 * host's merged effective settings or provider precedence, so rather than guess
 * which layer wins it flags a concern if ANY layer sets one — it never
 * under-warns (a false warning is harmless; a missed one stalls). Returns a short
 * description of the first blocking setting, or null when none is found.
 */
function detectApprovalConcern(cwd: string): string | null {
	const candidates = [
		path.join(cwd, ".omp", "config.yml"),
		path.join(cwd, ".omp", "config.yaml"),
		path.join(cwd, ".omp", "settings.json"),
		path.join(cwd, ".claude", "settings.json"),
		path.join(cwd, ".claude", "settings.local.json"),
		path.join(cwd, ".cursor", "settings.json"),
		path.join(cwd, ".gemini", "settings.json"),
		path.join(cwd, "opencode.json"),
		path.join(cwd, ".codex", "config.toml"),
		path.join(agentDir(), "config.yml"),
		path.join(agentDir(), "config.yaml"),
		path.join(agentDir(), "settings.json"),
	];
	for (const file of candidates) {
		const concern = readApprovalConcern(file);
		if (concern) return concern;
	}
	return null;
}

/**
 * A `tools` approval setting in one file that could block a tool call, or null.
 * Covers BOTH `tools.approvalMode` (non-yolo) AND per-tool `tools.approval`
 * policies — settings-schema.ts marks any non-`allow` entry as honored in EVERY
 * approval mode, so it can prompt/deny even under yolo. Parses JSON+YAML via
 * Bun.YAML and TOML (`.codex/config.toml`) via Bun.TOML, matching the core loaders.
 */
function readApprovalConcern(file: string): string | null {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed: unknown = file.endsWith(".toml") ? Bun.TOML.parse(text) : Bun.YAML.parse(text);
		if (!parsed || typeof parsed !== "object" || !("tools" in parsed)) return null;
		const tools = parsed.tools;
		if (!tools || typeof tools !== "object") return null;
		// Per-tool policies apply in every mode, so check them even under yolo.
		if ("approval" in tools && tools.approval && typeof tools.approval === "object") {
			for (const [name, policy] of Object.entries(tools.approval)) {
				if (typeof policy === "string" && policy !== "allow") return `tools.approval.${name} = "${policy}"`;
			}
		}
		if ("approvalMode" in tools) {
			const mode = tools.approvalMode;
			if (typeof mode === "string" && mode !== "yolo") return `tools.approvalMode = "${mode}"`;
		}
	} catch {
		// unreadable / malformed — treat as "no blocking setting present"
	}
	return null;
}

/**
 * Best-effort error/abort detection from an `agent_end` payload.
 *
 * extensions.md § "Prompt and turn lifecycle" documents `agent_end` as a
 * notification-only lifecycle event; rpc.md shows it carrying `messages`.
 * The message internals are not part of the documented extension contract,
 * so this inspects them defensively and returns null (= assume success)
 * when nothing recognizable is present. Rate-limit/retry failures are
 * caught separately via `auto_retry_end` (extensions.md § "Reliability/
 * runtime signals").
 */
function detectTurnError(event: unknown): string | null {
	const ev = event as { messages?: unknown } | null | undefined;
	const messages = Array.isArray(ev?.messages) ? (ev.messages as Record<string, unknown>[]) : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") continue;
		if (msg.role !== "assistant") continue;
		const stop = typeof msg.stopReason === "string" ? msg.stopReason : "";
		// Non-success terminal stop reasons: hard errors, user aborts, and output
		// truncation the core could not auto-continue (length / max_tokens /
		// incomplete). A recoverable truncation arrives as `willContinue` and is
		// handled before this runs, so reaching here with one is terminal.
		if (
			stop === "error" ||
			stop === "aborted" ||
			stop === "length" ||
			stop === "max_tokens" ||
			stop === "incomplete"
		) {
			const errText = typeof msg.errorMessage === "string" && msg.errorMessage ? `: ${msg.errorMessage}` : "";
			return `turn ${stop}${errText}`;
		}
		return null; // last assistant message is a normal completion
	}
	return null;
}

/**
 * Provider-requested wait extracted from a retry/rate-limit error string,
 * in ms (clamped to 1s..24h), or null when the error names no wait.
 * Recognized shapes (surfaced through auto_retry_end on provider 429s):
 *   "retry-after-ms=13448000", "Provider requested 13448000ms wait",
 *   "retry-after: 3600" (seconds).
 */
function parseRetryAfterMs(error: string): number | null {
	let ms: number | null = null;
	const msMatch = /retry-after-ms=(\d+)/i.exec(error) ?? /requested (\d+)\s*ms wait/i.exec(error);
	if (msMatch) {
		ms = Number.parseInt(msMatch[1], 10);
	} else {
		const secMatch = /retry[- ]after["':\s]+(\d+)/i.exec(error);
		if (secMatch) ms = Number.parseInt(secMatch[1], 10) * 1000;
	}
	if (ms === null || !Number.isFinite(ms)) return null;
	return Math.min(Math.max(ms, 1000), DAY_MS);
}

/**
 * True when the error smells like a connectivity/provider outage rather
 * than a task fault: transport failures, DNS, timeouts, and 5xx/overload.
 * Such interruptions must never burn task attempts — the task did nothing
 * wrong — and are retried on a capped exponential backoff instead.
 */
function isTransientNetworkError(error: string): boolean {
	return /fetch failed|network|socket|connection (?:refused|reset|closed|error)|ECONN\w+|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|offline|dns|timed? ?out|overloaded|\b5\d{2}\b/i.test(
		error,
	);
}

/**
 * True when the turn was rejected by Anthropic's content/usage-policy
 * classifier (the "cyber"/malicious-code category and its siblings) rather
 * than failing for a task reason. Unlike a task fault, this is a property of
 * the *conversation*: once one turn's content trips the classifier it stays
 * in the transcript, so every later request — the resume, the next task, even
 * a manually typed message — is rejected identically until the context is
 * purged. Detection is deliberately broad (the wire text is not a documented
 * contract) but excludes rate-limit/quota wording, which parseRetryAfterMs and
 * isTransientNetworkError own. Matching here routes the turn to a context
 * reset with the attempt refunded instead of a doomed same-context retry.
 */
function isContentPolicyError(error: string): boolean {
	if (/rate.?limit|\b429\b|retry-after|quota|overloaded/i.test(error)) return false;
	return (
		/\b(?:usage|content|acceptable[- ]use)[- ]polic/i.test(error) ||
		/policy[- ]violation|violat\w* (?:of |the )?(?:our )?(?:usage|content|acceptable)/i.test(error) ||
		/\bcyber\w*/i.test(error) ||
		/malicious (?:code|use|cyber)|malware|cyberweapon/i.test(error) ||
		/flagged (?:as|for|by)|content (?:filter|moderation)|prohibited content|disallowed content/i.test(error) ||
		/recognized as a violation/i.test(error)
	);
}

/** Hard cap on prompts loaded from one batch file. */
const MAX_BATCH_PROMPTS = 30;

/**
 * Parse a multi-prompt batch file: a comma-separated sequence of
 * `{prompt: "..."}` objects. Whitespace/newlines between tokens are
 * irrelevant; the `prompt` key may be bare or quoted; a surrounding
 * `[...]` and a trailing comma are tolerated. Values are JSON strings
 * (use \n for a newline inside a prompt).
 *
 * Hand-rolled scanner rather than regex-normalize-then-JSON.parse: a
 * prompt whose *text* contains `{prompt:` or `, }` must never be mangled
 * by normalization, so string contents are only ever consumed by the
 * JSON string rules.
 *
 * Returns:
 *   - string[]        parsed prompts (1..MAX_BATCH_PROMPTS, each non-empty)
 *   - {error}         batch-shaped content that fails syntax/shape checks
 *   - null            not batch-shaped — treat the file as one plain prompt
 */
function parsePromptBatch(content: string): string[] | { error: string } | null {
	const s = content.trim();
	// Batch detection: starts like an object/array AND names a prompt key.
	// A plain-text prompt that merely begins with "{" won't match the key
	// probe and still queues as a single task.
	if (!/^[[{]/.test(s) || !/[[{,]\s*["']?prompt["']?\s*:/.test(s)) return null;
	let i = 0;
	const ws = () => {
		while (i < s.length && /\s/.test(s[i])) i++;
	};
	const fail = (msg: string) => ({ error: `invalid batch syntax at offset ${i}: ${msg}` });
	const prompts: string[] = [];
	ws();
	const bracketed = s[i] === "[";
	if (bracketed) {
		i++;
		ws();
	}
	for (;;) {
		if (i >= s.length) {
			if (bracketed) return fail('expected "]"');
			break; // trailing comma after the last object is fine
		}
		if (bracketed && s[i] === "]") {
			i++;
			break;
		}
		if (s[i] !== "{") return fail('expected "{"');
		i++;
		ws();
		const key = /^(?:"prompt"|'prompt'|prompt)/.exec(s.slice(i));
		if (!key) return fail('expected a "prompt" key');
		i += key[0].length;
		ws();
		if (s[i] !== ":") return fail('expected ":"');
		i++;
		ws();
		if (s[i] !== '"') return fail("expected a double-quoted string value");
		const strStart = i;
		i++;
		while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
		if (i >= s.length) return fail("unterminated string");
		i++;
		let value: string;
		try {
			value = JSON.parse(s.slice(strStart, i)) as string;
		} catch {
			return fail("bad escape sequence in string");
		}
		ws();
		if (s[i] !== "}") return fail('expected "}" (exactly one "prompt" key per object)');
		i++;
		ws();
		const prompt = value.trim();
		if (!prompt) return { error: `batch entry ${prompts.length + 1}: empty prompt` };
		if (prompts.length >= MAX_BATCH_PROMPTS)
			return { error: `batch has more than ${MAX_BATCH_PROMPTS} prompts — max ${MAX_BATCH_PROMPTS} per file` };
		prompts.push(prompt);
		if (s[i] === ",") {
			i++;
			ws();
			continue;
		}
		if (bracketed) {
			if (s[i] === "]") {
				i++;
				break;
			}
			return fail('expected "," or "]"');
		}
		break; // unbracketed: end of input expected next
	}
	ws();
	if (i < s.length) return fail("unexpected trailing content");
	if (prompts.length === 0) return { error: "batch contains no prompts" };
	return prompts;
}

/**
 * Parse a **verbatim** multi-prompt batch file — the robust, escaping-free
 * format. Prompt bodies are taken exactly as written: quotes, back/forward
 * slashes, newlines, JSON, and pasted code all pass through untouched.
 *
 * The format is opt-in via a header on the first line, so plain prompt
 * files (including Markdown with `---` frontmatter, code, or raw JSON) are
 * never misread as a batch:
 *
 *   @@prompts                 split on the default "---" separator line
 *   @@prompts sep=%%%%%       split on a custom separator line
 *
 * Everything after the header is split on lines whose *trimmed* text equals
 * the separator; each block between separators is one prompt (its outer
 * whitespace trimmed, inner content verbatim). Because any fixed separator
 * could in principle occur inside a prompt, the user picks one that does not
 * — the same escape hatch heredocs and MIME boundaries use. Blank segments
 * (a leading/trailing separator, or doubled separators) are dropped rather
 * than rejected, so the format stays forgiving.
 *
 * `@@batch` is accepted as an alias of `@@prompts`; `delim`/`delimiter` as
 * aliases of `sep`. Matching is case-insensitive. CRLF and a leading BOM
 * are tolerated (Windows editors).
 *
 * Returns:
 *   - string[]   parsed prompts (1..MAX_BATCH_PROMPTS, each non-empty)
 *   - {error}    header present but the shape/limit checks fail
 *   - null       no header — not a verbatim batch
 */
function parseVerbatimBatch(content: string): string[] | { error: string } | null {
	const text = content.replace(/^\uFEFF/, "");
	const lines = text.split(/\r?\n/);
	const header = (lines[0] ?? "").trim();
	const m = /^@@(?:prompts|batch)\b(.*)$/i.exec(header);
	if (!m) return null;
	let sep = "---";
	const rest = m[1].trim();
	if (rest) {
		const sm = /^(?:sep|delim|delimiter)\s*=\s*(.+)$/i.exec(rest);
		if (!sm) return { error: `bad @@prompts header — expected "sep=<token>", got ${JSON.stringify(rest)}` };
		sep = sm[1].trim();
		if (!sep) return { error: "empty separator token in @@prompts header" };
	}
	const prompts: string[] = [];
	let buf: string[] = [];
	const flush = () => {
		const p = buf.join("\n").trim();
		buf = [];
		if (p) prompts.push(p);
	};
	for (let li = 1; li < lines.length; li++) {
		if (lines[li].trim() === sep) flush();
		else buf.push(lines[li]);
	}
	flush();
	if (prompts.length === 0) return { error: "batch contains no non-empty prompts" };
	if (prompts.length > MAX_BATCH_PROMPTS)
		return { error: `batch has more than ${MAX_BATCH_PROMPTS} prompts — max ${MAX_BATCH_PROMPTS} per file` };
	return prompts;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * Default factory export — extensions.md § "What an extension is".
 * Registration happens here; runtime actions (sendUserMessage, abort, …)
 * only run from event/command handlers, per extensions.md § "Constraints
 * and pitfalls" ("Runtime actions are unavailable during extension load").
 */
export default function schedulerExtension(pi: ExtensionAPI) {
	// extensions.md § "1) Registration and actions": setLabel
	pi.setLabel("Scheduler");

	// ---- in-memory runtime -------------------------------------------------
	let state: SchedulerState | null = null;
	// Set when state.json exists but can't be read/parsed. Blocks saves so a
	// corrupt file is never clobbered by an empty/replacement write.
	let stateReadError = false;
	let cfg: SchedulerConfig = structuredClone(DEFAULT_CONFIG);
	let liveCtx: CtxLike | null = null;
	/**
	 * Last context that carried command-only session controls (`newSession`).
	 * Captured whenever a `/scheduler` command runs and never clobbered by event
	 * contexts, so the autonomous content-policy purge — which fires from a timer
	 * where only the base event context is live — still has a real `newSession`.
	 */
	let cmdCtx: CtxLike | null = null;
	/**
	 * ISO start of the session window this turn's `agent_start` optimistically
	 * recorded, or null when it reused an active window. A turn that then fails as
	 * a transient provider fault (outage / rate-limit rejection) opened no real
	 * session, so `agent_end` drops that window — otherwise a long outage accrues
	 * phantom windows and eventually trips the rolling-24h cap.
	 */
	let currentTurnWindowAt: string | null = null;
	let agentActive = false;
	/** Set by auto_retry_end when retries were exhausted during the current turn. */
	let retryFailure: string | null = null;
	let dispatchTimer: TimerHandle | null = null;
	let resumeTimer: TimerHandle | null = null;
	let emptyQueueNotified = false;
	/** Consecutive outage interruptions; sets the backoff step, reset on any healthy turn. */
	let outageStreak = 0;
	/** Watchdog interval handle (unref'd — never holds the host process open). */
	let watchdogTimer: IntervalHandle | null = null;
	/** One-shot guard for the unknown-provider notice (reset per process). */
	let unknownModelNoticed = false;
	/** One-shot guard for the gated-profile (subscription-assumption) notice. */
	let gatedProfileNoticed = false;
	/**
	 * A content-policy ("cyber") violation poisoned the conversation; the next
	 * dispatch must purge the context (newSession) before sending, or every
	 * request keeps tripping the same classifier. Set in agent_end, consumed in
	 * tryDispatch. In-memory: a process restart starts/resumes a session anyway,
	 * and a lingering poison self-heals (re-detected → reset on the next turn).
	 */
	let pendingContextReset = false;
	// True while resetContext() is purging the poisoned conversation. A slow
	// compact()/hook-delayed newSession() leaves no timer armed until `.finally`,
	// so guard dispatch (and the watchdog re-arm) from sending the interrupted
	// task back into the not-yet-purged transcript mid-reset.
	let resetInFlight = false;
	// Set once session_shutdown begins. A content-policy purge (newSession/compact)
	// can still be in flight then; its `.finally` must not arm a fresh dispatch
	// timer against the torn-down session. Reset on a new session_start.
	let shuttingDown = false;

	/**
	 * Run a timer callback so a throw can never escape as a process-fatal
	 * `uncaughtException`. Managed timers already isolate the callback inside the
	 * runner; this only backstops the global-timer fallback used before a managed
	 * context is available.
	 */
	function guardTick(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			try {
				logEvent({ event: "notice", detail: `timer callback error: ${String(err)}` });
			} catch {}
		}
	}
	function startTimer(ms: number, fn: () => void): TimerHandle {
		const ctx = liveCtx;
		// Prefer the runner's managed timer surface: a throw in `fn` (e.g. an I/O
		// error while persisting state/logs from a dispatch tick) is contained and
		// reported instead of taking down the omp session (issue #5664), and the
		// handle is unref'd + auto-cleared on session_shutdown.
		if (ctx?.setTimeout) return ctx.setTimeout(fn, ms);
		const handle = setTimeout(() => guardTick(fn), ms);
		handle.unref?.();
		return handle;
	}
	function stopTimer(handle: TimerHandle | null): null {
		if (handle === null) return null;
		// clearTimer / clearTimeout are spec no-ops for already-fired handles.
		if (liveCtx?.clearTimer) liveCtx.clearTimer(handle);
		else clearTimeout(handle);
		return null;
	}
	function clearTimers(): void {
		dispatchTimer = stopTimer(dispatchTimer);
		resumeTimer = stopTimer(resumeTimer);
	}

	// ---- watchdog ------------------------------------------------------------
	/**
	 * Last line of defense so "running" can never silently stall for hours.
	 * Heals two failure shapes one-shot timers cannot survive:
	 *   1) a dispatched task whose turn never materialized (prompt swallowed
	 *      or agent_end lost) — re-queued without burning an attempt;
	 *   2) pending work with no armed timer (a timer died with an exception).
	 * Long-running turns are untouched: recovery requires an *idle* agent.
	 */
	function watchdogTick(): void {
		if (shuttingDown) return; // session torn down — the watchdog must not act
		const st = getState();
		if (st.run !== "running") return;
		if (st.currentTaskId !== null) {
			const task = st.tasks.find(t => t.id === st.currentTaskId);
			const dispatchedAt = task?.dispatchedAt ? Date.parse(task.dispatchedAt) : Number.NaN;
			const stale = !Number.isFinite(dispatchedAt) || Date.now() - dispatchedAt > cfg.stallTimeoutMs;
			if (stale && liveCtx?.isIdle() === true) {
				const id = st.currentTaskId;
				if (task) task.stalls = (task.stalls ?? 0) + 1;
				const stalls = task?.stalls ?? 0;
				if (task && stalls >= cfg.maxAttempts) {
					// A dispatched turn that never materializes this many times running is
					// not a transient swallow — it's undeliverable (no model/API key, a
					// rejecting pre-turn hook, a send that rejects async). Fail it instead
					// of looping on refunded attempts forever.
					logEvent({
						event: "recovered",
						taskId: id,
						detail: `watchdog: ${stalls} consecutive stalls — dispatched turn never started; task undeliverable`,
					});
					notify(
						null,
						`scheduler: ${id} FAILED — dispatched turn never started after ${stalls} watchdog recoveries (no model/API key, or a rejecting pre-turn hook?) — /scheduler retry ${id} to re-queue.`,
						"error",
					);
					settleCurrentTask("stalled: dispatched turn never started (undeliverable)", false, true, "stalled");
				} else {
					logEvent({
						event: "recovered",
						taskId: id,
						detail: `watchdog: task in flight but agent idle (stall ${stalls}/${cfg.maxAttempts})`,
					});
					notify(
						null,
						`scheduler: watchdog — ${id} stalled with an idle agent; re-queued (attempt not counted, stall ${stalls}/${cfg.maxAttempts}).`,
						"warning",
					);
					settleCurrentTask("stalled: agent idle with task in flight", true, false, "stalled");
				}
				scheduleDispatch(cfg.dispatchDelayMs);
			}
			return;
		}
		if (dispatchTimer === null && resumeTimer === null && !agentActive && !resetInFlight && nextPendingTask(st)) {
			logEvent({ event: "notice", detail: "watchdog: pending work with no armed timer — re-arming dispatch" });
			scheduleDispatch(cfg.dispatchDelayMs);
		}
	}
	function startWatchdog(): void {
		if (watchdogTimer !== null) return;
		const ctx = liveCtx;
		// Same isolation rationale as startTimer: a throw in a watchdog tick must
		// be contained by the runner, not crash the session (issue #5664).
		if (ctx?.setInterval) {
			watchdogTimer = ctx.setInterval(watchdogTick, cfg.watchdogIntervalMs);
			return;
		}
		const handle = setInterval(() => guardTick(watchdogTick), cfg.watchdogIntervalMs);
		handle.unref?.(); // Node/Bun: don't keep the host process alive for the watchdog
		watchdogTimer = handle;
	}
	function stopWatchdog(): void {
		if (watchdogTimer === null) return;
		if (liveCtx?.clearTimer) liveCtx.clearTimer(watchdogTimer);
		else clearInterval(watchdogTimer);
		watchdogTimer = null;
	}

	// ---- persistence -------------------------------------------------------
	function getState(): SchedulerState {
		// Re-read while a prior read failed (stateReadError) so fixing/deleting a
		// corrupt state.json mid-session clears the block without a restart.
		if (state !== null && !stateReadError) return state;
		let raw: unknown;
		try {
			raw = readJson<unknown>(stateFile());
		} catch (err) {
			// state.json exists but is corrupt/unreadable: do NOT run on top of it —
			// a later save would clobber the queue. Preserve the file, block saves,
			// and surface the problem once per corruption episode.
			if (!stateReadError) {
				pi.logger?.warn?.(`scheduler: state.json unreadable — leaving it untouched: ${String(err)}`);
				notify(
					null,
					"scheduler: state.json is corrupt/unreadable — queue paused and the file left untouched; fix or delete it to resume.",
					"error",
				);
			}
			stateReadError = true;
			state ??= structuredClone(EMPTY_STATE);
			return state;
		}
		if (raw === undefined) {
			// file ABSENT (ENOENT) → fresh queue, seeded on the first save. A present
			// file that parsed to `null`/primitive/array falls through to migrateState,
			// which rejects it as malformed (preserve + refuse), not seed.
			stateReadError = false;
			state = structuredClone(EMPTY_STATE);
			return state;
		}
		const migrated = migrateState(raw, cfg);
		if (migrated === null) {
			// present but not a valid SchedulerState → same handling as corruption:
			// preserve the file, block saves, surface once.
			if (!stateReadError) {
				pi.logger?.warn?.("scheduler: state.json is not a valid scheduler state — leaving it untouched");
				notify(
					null,
					"scheduler: state.json is malformed (not a valid scheduler state) — queue paused and the file left untouched; fix or delete it to resume.",
					"error",
				);
			}
			stateReadError = true;
			state ??= structuredClone(EMPTY_STATE);
			return state;
		}
		stateReadError = false; // readable + valid — first load, or recovered after a fix
		state = migrated;
		// Backfill the prompt fingerprint for tasks queued before hashing existed.
		for (const t of state.tasks) if (!t.promptHash) t.promptHash = hashPrompt(t.prompt);
		return state;
	}
	function saveState(): void {
		if (stateReadError) return; // never overwrite a state.json we refused to load
		if (state !== null) writeJson(stateFile(), state);
	}
	function loadConfig(): void {
		let raw: unknown;
		try {
			raw = readJson<unknown>(configFile());
		} catch (err) {
			// Corrupt/unreadable config.json: use defaults in memory but DO NOT
			// overwrite the user's file — surface it so they can fix it.
			cfg = structuredClone(DEFAULT_CONFIG);
			pi.logger?.warn?.(`scheduler: config.json unreadable — using defaults without overwriting: ${String(err)}`);
			notify(
				null,
				"scheduler: config.json is corrupt/unreadable — using defaults this session; the file was left untouched (fix or delete it).",
				"error",
			);
			return;
		}
		if (raw === undefined) {
			cfg = structuredClone(DEFAULT_CONFIG);
			writeJson(configFile(), cfg); // absent → seed an editable config file
			return;
		}
		if (raw === null || typeof raw !== "object") {
			// present but not a JSON object (literal null / primitive / array):
			// malformed — use defaults for the session, leave the file untouched.
			cfg = structuredClone(DEFAULT_CONFIG);
			pi.logger?.warn?.("scheduler: config.json is not a JSON object — using defaults without overwriting");
			notify(
				null,
				"scheduler: config.json is malformed (not a JSON object) — using defaults this session; the file was left untouched (fix or delete it).",
				"error",
			);
			return;
		}
		const onDisk = raw as Partial<SchedulerConfig> & { windowHours?: unknown; maxWindowsPer24h?: unknown };
		const badField = configShapeError(onDisk);
		if (badField) {
			// A present config field has the wrong type — using it would crash a
			// string/number helper (e.g. `.trim()` on a number). Fall back to defaults
			// for the session WITHOUT overwriting the user's file (same safe path as an
			// unreadable config).
			cfg = structuredClone(DEFAULT_CONFIG);
			pi.logger?.warn?.(
				`scheduler: config.json field '${badField}' has the wrong type — using defaults without overwriting`,
			);
			notify(
				null,
				`scheduler: config.json is malformed ('${badField}' has the wrong type) — using defaults this session; the file was left untouched (fix or delete it).`,
				"error",
			);
			return;
		}
		cfg = { ...structuredClone(DEFAULT_CONFIG), ...onDisk } as SchedulerConfig;
		const legacy = !Array.isArray(onDisk.quotaProfiles) || onDisk.quotaProfiles.length === 0;
		if (legacy) {
			// Pre-quotaProfiles config: windowHours/maxWindowsPer24h were global
			// and only ever described Claude subscription windows — carry them
			// into the gated anthropic profile, then persist the migrated shape.
			cfg.quotaProfiles = structuredClone(DEFAULT_QUOTA_PROFILES);
			if (typeof onDisk.windowHours === "number") cfg.quotaProfiles[0].sessionHours = onDisk.windowHours;
			if (typeof onDisk.maxWindowsPer24h === "number")
				cfg.quotaProfiles[0].maxSessionsPer24h = onDisk.maxWindowsPer24h;
		}
		delete (cfg as unknown as Record<string, unknown>).windowHours;
		delete (cfg as unknown as Record<string, unknown>).maxWindowsPer24h;
		if (legacy) writeJson(configFile(), cfg);
	}
	function logEvent(entry: Omit<SchedulerLogEntry, "ts">): void {
		try {
			ensureDataDir();
			fs.appendFileSync(logFile(), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
		} catch (err) {
			// pi.logger — extensions.md § "1) Registration and actions" ("Also exposed: pi.logger")
			pi.logger?.warn?.(`scheduler: failed to append log: ${String(err)}`);
		}
	}
	/**
	 * Rewrite the human-readable outcome table (task-ledger.md) from current
	 * state — one row per task keyed by prompt hash: hash | status | prompt(100)
	 * | summary(100). Regenerated after every pass/fail so the ledger always
	 * mirrors the latest results, entirely from code (no LLM tokens).
	 */
	function writeLedger(): void {
		const st = getState();
		const rows = st.tasks.map(t => {
			const hash = t.promptHash || hashPrompt(t.prompt);
			const cell = (s: string) => truncate(s, 100).replace(/\|/g, "\\|");
			return `| \`${hash}\` | ${t.status} | ${cell(t.prompt)} | ${t.summary ? cell(t.summary) : "—"} |`;
		});
		const body = [
			"# Scheduler task ledger",
			"",
			`_Auto-generated ${new Date().toISOString()} — one row per task, in queue order._`,
			"",
			"| hash | status | prompt | summary |",
			"| --- | --- | --- | --- |",
			...rows,
			"",
		].join("\n");
		try {
			ensureDataDir();
			fs.writeFileSync(ledgerFile(), body, "utf8");
		} catch (err) {
			pi.logger?.warn?.(`scheduler: failed to write ledger: ${String(err)}`);
		}
	}
	function readLogTail(n: number): SchedulerLogEntry[] {
		try {
			const lines = fs.readFileSync(logFile(), "utf8").split("\n").filter(Boolean);
			return lines.slice(-n).flatMap(line => {
				try {
					return [JSON.parse(line) as SchedulerLogEntry];
				} catch {
					return [];
				}
			});
		} catch {
			return [];
		}
	}

	// ---- UI helpers ----------------------------------------------------------
	function notify(ctx: CtxLike | null, message: string, level: "info" | "warning" | "error" = "info"): void {
		// ctx.ui.notify — authoring-extensions.md § "Minimum viable extension";
		// no-op safe when headless (extensions.md § "Print/headless/subagent paths").
		try {
			(ctx ?? liveCtx)?.ui.notify(message, level);
		} catch {
			/* headless */
		}
	}
	function updateStatus(): void {
		const ctx = liveCtx;
		if (!ctx?.hasUI) return;
		const st = getState();
		const pending = st.tasks.filter(t => t.status === "queued" || t.status === "interrupted").length;
		try {
			// ctx.ui.setStatus — authoring-extensions.md § "Subscribing to events" example.
			ctx.ui.setStatus("scheduler", st.run === "stopped" && pending === 0 ? "" : `sched:${st.run} q:${pending}`);
		} catch {
			/* mode without status support */
		}
	}

	/**
	 * Resolve the active model's quota profile; when the model cannot be
	 * detected, gate nothing (contract: unknown provider = unlimited) but
	 * log a one-shot notice so the choice is visible in the task log.
	 */
	function currentQuota(ctx: CtxLike | null): ActiveQuota {
		const quota = resolveQuota(ctx ?? liveCtx, cfg);
		if (!quota.detected && !unknownModelNoticed) {
			unknownModelNoticed = true;
			logEvent({
				event: "notice",
				detail: "active provider/model not detectable — treating as unlimited (no session-window gating)",
			});
			notify(null, "scheduler: provider/model unknown — dispatching without session-window gating.", "warning");
		}
		if (quota.limits !== null && !gatedProfileNoticed) {
			gatedProfileNoticed = true;
			// The extension API exposes no credential kind (ExtensionModelQuery →
			// Model carries provider/id only), so a gated profile is a subscription
			// *assumption*. Surface it once: API-key/pay-as-you-go Anthropic has no
			// session windows and should run ungated.
			logEvent({
				event: "notice",
				detail: `gating ${quota.provider}/${quota.modelId} at ${quota.limits.sessionHours}h×${quota.limits.maxSessionsPer24h} (Claude subscription assumption)`,
			});
			notify(
				null,
				`scheduler: gating ${quota.provider || "this model"} at ${quota.limits.sessionHours}h×${quota.limits.maxSessionsPer24h} session windows — assumes Claude subscription auth. API-key/pay-as-you-go billing has no such windows; set the profile's limits to null in config.json to run ungated.`,
				"info",
			);
		}
		return quota;
	}

	// ---- dispatch loop -------------------------------------------------------
	function scheduleDispatch(delayMs: number): void {
		if (shuttingDown) return; // session torn down — never arm a timer against a dead session
		dispatchTimer = stopTimer(dispatchTimer);
		dispatchTimer = startTimer(delayMs, () => {
			dispatchTimer = null;
			tryDispatch();
		});
	}

	function armResumeTimer(atMs: number): void {
		if (shuttingDown) return; // don't arm a resume timer against a dead session
		resumeTimer = stopTimer(resumeTimer);
		const delay = Math.max(1000, atMs - Date.now());
		resumeTimer = startTimer(delay, () => {
			resumeTimer = null;
			logEvent({ event: "resume_timer" });
			tryDispatch();
		});
	}

	/**
	 * Purge a conversation poisoned by a content-policy violation. `newSession`
	 * drops all history with no LLM call, so the flagged text is never re-scanned
	 * — the only reliable purge. But newSession lives ONLY on the command context
	 * (host createCommandContext); the event/timer context this runs from exposes
	 * just `compact`. So reset through the retained command context (cmdCtx) and
	 * fall back to compacting the live context — a best-effort reduce-in-place
	 * that must summarize the poisoned transcript and MAY re-trip the classifier,
	 * hence newSession is strongly preferred. newSession does not re-fire
	 * session_start (agent session.newSession emits only
	 * session_before_switch/session_switch), so the scheduler's own lifecycle,
	 * queue, and state are untouched. On total failure the next dispatch simply
	 * re-enters the context, re-detects, and retries — a stall, never a lost task.
	 */
	async function resetContext(reason: string): Promise<void> {
		const purgeCtx = typeof cmdCtx?.newSession === "function" ? cmdCtx : null;
		let method = "none";
		let purged = false;
		try {
			if (purgeCtx?.newSession) {
				const res = await purgeCtx.newSession();
				// newSession resolves `{ cancelled: true }` when a hook vetoes the
				// session switch — the poisoned transcript is then still live, so this
				// must NOT count as a purge.
				const cancelled = res !== null && typeof res === "object" && "cancelled" in res && res.cancelled === true;
				if (cancelled) {
					method = "newSession-cancelled";
				} else {
					method = "newSession";
					purged = true;
				}
			}
			if (!purged && typeof liveCtx?.compact === "function") {
				await liveCtx.compact(CONTEXT_RESET_COMPACT_INSTRUCTION.trim());
				method = method === "newSession-cancelled" ? "compact (newSession cancelled)" : "compact";
				purged = true;
			}
		} catch (err) {
			pi.logger?.warn?.(`scheduler: context reset failed: ${String(err)}`);
			method = "failed";
		}
		// If nothing actually purged the context, keep the reset pending so the next
		// dispatch retries instead of sending the task back into flagged history.
		pendingContextReset = !purged; // clear on success; keep pending to retry on failure
		logEvent({ event: "context_reset", detail: `${reason} — ${method}${purged ? "" : " (still pending)"}` });
		notify(
			null,
			purged
				? `scheduler: content-policy violation — cleared conversation context (${method}) before continuing.`
				: "scheduler: content-policy violation — context purge unavailable (reset kept pending); will retry.",
			"warning",
		);
	}

	function tryDispatch(): void {
		const st = getState();
		if (st.run !== "running") return;
		if (st.currentTaskId !== null) return; // a task is already in flight
		if (agentActive) return; // manual/other turn in progress
		if (resetInFlight) return; // a context purge is running — don't dispatch until it completes
		if (shuttingDown) return; // session torn down — no timer callback may dispatch
		// extensions.md § "2) Handler context": isIdle(), hasPendingMessages().
		// Defer to user-queued messages; re-check after the next agent_end.
		if (liveCtx && (!liveCtx.isIdle() || liveCtx.hasPendingMessages())) {
			scheduleDispatch(cfg.dispatchDelayMs);
			return;
		}
		// A content-policy ("cyber") violation poisoned the conversation: purge it
		// BEFORE anything else — even with an empty queue or a rate-limit hold — so a
		// manual turn or a terminal cap-fail doesn't strand the user in the flagged
		// context. Reset is async; re-arm the loop to dispatch into the clean context.
		if (pendingContextReset) {
			resetInFlight = true;
			void resetContext("content-policy violation").finally(() => {
				resetInFlight = false;
				scheduleDispatch(cfg.dispatchDelayMs);
			});
			return;
		}
		const task = nextPendingTask(st);
		if (!task) {
			if (!emptyQueueNotified) {
				emptyQueueNotified = true;
				notify(null, "scheduler: queue drained — still running; new tasks dispatch automatically.");
			}
			updateStatus();
			return;
		}
		const now = Date.now();
		// A provider-declared hold wins over local window math: the provider
		// named its own reset clock, so wait it out before dispatching anything.
		const holdUntil = st.rateLimitedUntil ? Date.parse(st.rateLimitedUntil) : Number.NaN;
		if (Number.isFinite(holdUntil) && holdUntil > now) {
			armResumeTimer(holdUntil);
			return;
		}
		if (st.rateLimitedUntil) {
			st.rateLimitedUntil = null;
			saveState();
		}
		// Provider-aware gating: only a gated profile (Anthropic Claude
		// subscription windows) can block dispatch; unlimited profiles skip
		// window bookkeeping entirely.
		const quota = currentQuota(null);
		if (quota.limits !== null) {
			const verdict = quotaCheck(st, quota.key, quota.limits, now);
			if (!verdict.ok) {
				const resumeAt = (verdict.nextAt ?? now + HOUR_MS) + cfg.windowSlackMs;
				logEvent({ event: "blocked", detail: verdict.reason, resumeAt: new Date(resumeAt).toISOString() });
				notify(null, `scheduler: ${verdict.reason}; auto-resuming at ${fmtClock(resumeAt)}.`, "warning");
				armResumeTimer(resumeAt);
				return;
			}
		}

		const resuming = task.status === "interrupted";
		task.status = "running";
		task.attempts += 1;
		task.dispatchedAt = new Date(now).toISOString();
		st.currentTaskId = task.id;
		emptyQueueNotified = false;
		saveState();
		logEvent({
			event: "dispatch",
			taskId: task.id,
			attempt: task.attempts,
			maxAttempts: cfg.maxAttempts,
			resumed: resuming,
			prompt: truncate(task.prompt, 120),
		});

		const parts = [cfg.promptPreamble.trim()];
		if (resuming) parts.push(cfg.resumePreamble.trim());
		parts.push(task.prompt);
		try {
			// extensions.md § "Message delivery semantics":
			// "pi.sendUserMessage(content, { deliverAs }) always goes through
			// prompt flow" — when the agent is idle this starts a turn.
			pi.sendUserMessage(parts.filter(Boolean).join("\n\n"));
			notify(null, `scheduler: dispatched ${task.id}${resuming ? " (resume)" : ""} — ${truncate(task.prompt, 60)}`);
		} catch (err) {
			// Delivery failed before a turn started (e.g. a host mode rejects prompt
			// flow). This path bypasses settleCurrentTask, so apply the same
			// maxAttempts terminal check here — otherwise an undeliverable prompt
			// retries every 30s forever instead of failing after the budget.
			const terminal = task.attempts >= cfg.maxAttempts;
			task.status = terminal ? "failed" : "interrupted";
			task.lastError = `dispatch failed: ${String(err)}`;
			task.summary = truncate(`task_fault: ${task.lastError}`, 100);
			st.currentTaskId = null;
			writeLedger();
			saveState();
			logEvent({
				event: "end",
				taskId: task.id,
				status: task.status,
				error: task.lastError,
				classification: "task_fault",
				refunded: false,
				attempts: task.attempts,
				maxAttempts: cfg.maxAttempts,
				terminal,
				prompt: truncate(task.prompt, 120),
				promptHash: task.promptHash,
				summary: task.summary,
				detail: terminal
					? `sendUserMessage failed on attempt ${task.attempts}/${cfg.maxAttempts} — task failed; /scheduler retry ${task.id} to re-queue`
					: "sendUserMessage threw before the turn started",
			});
			if (terminal) {
				notify(
					null,
					`scheduler: ${task.id} FAILED — delivery failed after ${task.attempts} attempts (${truncate(String(err), 80)}) — /scheduler retry ${task.id} to re-queue.`,
					"error",
				);
			} else {
				scheduleDispatch(30_000);
			}
		}
		updateStatus();
	}

	function settleCurrentTask(
		error: string | null,
		refundAttempt = false,
		forceFail = false,
		classification?: TurnOutcome,
		assistantText: string | null = null,
	): void {
		const st = getState();
		if (st.currentTaskId === null) return;
		const task = st.tasks.find(t => t.id === st.currentTaskId);
		st.currentTaskId = null;
		if (task) {
			task.endedAt = new Date().toISOString();
			const durationMs = task.dispatchedAt ? Date.now() - Date.parse(task.dispatchedAt) : undefined;
			if (error) {
				task.lastError = error;
				if (forceFail) {
					task.status = "failed";
					// Only the content-policy cap surfaces its verdict here; other forced
					// failures (e.g. the watchdog's undeliverable-stall path) emit their
					// own reason-specific notice at the call site, so a non-policy
					// forced-fail must NOT also claim a content-policy violation.
					if (classification === "content_policy") {
						// A content-policy violation that survived maxContextResets purges:
						// the prompt trips the classifier even in a clean context, so it is
						// genuinely un-runnable — fail it rather than loop forever.
						notify(
							null,
							`scheduler: ${task.id} FAILED — content-policy violation persisted across ${task.policyResets ?? 0} context resets (${truncate(error, 80)}) — /scheduler retry ${task.id} to re-queue.`,
							"error",
						);
					}
				} else if (refundAttempt) {
					// Rate limits, outages, and content-policy resets are not the
					// task's fault: refund the attempt so they never exhaust maxAttempts.
					task.attempts = Math.max(0, task.attempts - 1);
					task.status = "interrupted";
				} else {
					task.status = task.attempts >= cfg.maxAttempts ? "failed" : "interrupted";
					notify(
						null,
						task.status === "failed"
							? `scheduler: ${task.id} FAILED after ${task.attempts} attempts (${truncate(error, 80)}) — /scheduler retry ${task.id} to re-queue.`
							: `scheduler: ${task.id} interrupted (${truncate(error, 80)}) — will resume, attempt ${task.attempts}/${cfg.maxAttempts}.`,
						"warning",
					);
				}
			} else {
				task.status = "done";
				notify(null, `scheduler: ${task.id} done — ${truncate(task.prompt, 60)}`);
			}
			const terminal = task.status === "failed";
			// One self-contained record: WHY it ended (classification), whether the
			// attempt was refunded, where the attempt budget stands, whether it is
			// terminal (no auto-retry), and WHAT the prompt was — so reading the log
			// alone answers "what happened" without opening state.json or the source.
			const outcome: TurnOutcome | undefined = error
				? (classification ?? (forceFail ? "content_policy" : refundAttempt ? "outage" : "task_fault"))
				: undefined;
			// Code-generated (no LLM): reuse the turn's own last line / the verdict.
			task.summary = buildSummary(task.status, outcome, error, assistantText, durationMs);
			logEvent({
				event: "end",
				taskId: task.id,
				status: task.status,
				error: error ?? undefined,
				durationMs,
				classification: outcome,
				refunded: error ? refundAttempt : undefined,
				attempts: task.attempts,
				maxAttempts: cfg.maxAttempts,
				terminal: terminal || undefined,
				prompt: truncate(task.prompt, 120),
				promptHash: task.promptHash,
				summary: task.summary,
				detail: terminal ? `terminal — not auto-retried; run /scheduler retry ${task.id} to re-queue` : undefined,
			});
		}
		writeLedger();
		saveState();
	}

	// ---- events ----------------------------------------------------------------
	// Event names below are from extensions.md § "Event surface".

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		liveCtx = ctx as unknown as CtxLike;
		ensureDataDir();
		loadConfig();
		const st = getState();
		// Crash/restart recovery: a task left "running" by a previous process
		// was interrupted mid-flight — resume it, don't skip it.
		if (st.currentTaskId !== null) {
			const task = st.tasks.find(t => t.id === st.currentTaskId);
			if (task && task.status === "running") {
				task.status = "interrupted";
				task.lastError = "process restarted mid-task";
				task.endedAt = new Date().toISOString();
				logEvent({ event: "recovered", taskId: task.id, status: "interrupted" });
			}
			st.currentTaskId = null;
			saveState();
		}
		startWatchdog();
		if (st.run === "running") {
			const pending = st.tasks.filter(t => t.status === "queued" || t.status === "interrupted").length;
			notify(ctx as unknown as CtxLike, `scheduler: active — ${pending} task(s) pending. /scheduler stop to halt.`);
			scheduleDispatch(cfg.dispatchDelayMs);
		}
		updateStatus();
	});

	pi.on("agent_start", async (_event, ctx) => {
		liveCtx = ctx as unknown as CtxLike;
		agentActive = true;
		// A turn actually started — the previous dispatch was delivered, so clear
		// the in-flight task's consecutive-stall counter.
		{
			const inflight = getState();
			const running = inflight.tasks.find(t => t.id === inflight.currentTaskId);
			if (running?.stalls) {
				running.stalls = 0;
				saveState();
			}
		}
		currentTurnWindowAt = null; // reset per turn; set below only when a new window opens
		// Window accounting: ANY agent turn (scheduled or typed manually)
		// consumes the provider session window, so a new local window record
		// starts whenever a turn begins outside an active one — but only for
		// gated profiles; unlimited providers record no windows at all.
		const quota = currentQuota(liveCtx);
		if (quota.limits === null) return;
		const st = getState();
		const now = Date.now();
		if (activeWindowStart(st, quota.key, quota.limits.sessionHours, now) === null) {
			const startedAt = new Date(now).toISOString();
			st.windows.push({ startedAt, profile: quota.key });
			// Provisional: refunded in agent_end if the turn turns out to be a
			// transient provider failure that opened no real session.
			currentTurnWindowAt = startedAt;
			pruneWindows(st, now);
			saveState();
			logEvent({
				event: "window_start",
				detail: `${windowStartsInLast24h(st, quota.key, now).length}/${quota.limits.maxSessionsPer24h} in last 24h (profile "${quota.key}")`,
			});
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		liveCtx = ctx as unknown as CtxLike;
		// A continuation end (willContinue: auto-retry, unexpected-stop retry, or
		// auto-compaction) is NOT the terminal end of the prompt — the same turn
		// resumes. Settling or dispatching here would double-run (settle the task
		// and fire the next one while the continuation is still coming). Leave the
		// task in flight and wait for the final agent_end where willContinue is
		// falsy; agentActive stays true because the agent is still working.
		if (event && typeof event === "object" && "willContinue" in event && event.willContinue === true) return;
		agentActive = false;
		const fromRetryExhaustion = retryFailure !== null;
		const error = retryFailure ?? detectTurnError(event);
		retryFailure = null;
		const waitMs = error === null ? null : parseRetryAfterMs(error);
		const rateLimited =
			error !== null && (waitMs !== null || (fromRetryExhaustion && /rate.?limit|\b429\b|quota/i.test(error)));
		const outage = !rateLimited && error !== null && fromRetryExhaustion && isTransientNetworkError(error);
		// A content-policy ("cyber") rejection poisons the whole conversation, not
		// just this turn: re-sending into the same context re-trips the classifier
		// forever. Route it to a context purge with the attempt refunded instead.
		const contentPolicy = error !== null && !rateLimited && !outage && isContentPolicyError(error);
		// A user abort of a *scheduled* turn means the human wants the seat:
		// pause the queue instead of fighting them for the next turn.
		const userAbort =
			!rateLimited &&
			!outage &&
			!contentPolicy &&
			error !== null &&
			/\baborted\b/i.test(error) &&
			getState().currentTaskId !== null;
		// contentPolicy settles inside its own branch (it needs the task's running
		// reset count to decide refund-and-retry vs. give-up); everyone else here.
		const outcome: TurnOutcome | undefined =
			error === null
				? undefined
				: rateLimited
					? "rate_limit"
					: outage
						? "outage"
						: contentPolicy
							? "content_policy"
							: userAbort
								? "user_abort"
								: "task_fault";
		// For a clean pass, reuse the turn's final assistant line as the summary.
		const assistantText = error === null ? lastAssistantText(event) : null;
		if (!contentPolicy) settleCurrentTask(error, rateLimited || outage || userAbort, false, outcome, assistantText);
		const st = getState();
		// A turn that failed before opening a real provider session (transient
		// outage or rate-limit rejection) must not keep the window agent_start
		// optimistically recorded — drop it so a long outage can't accrue phantom
		// windows that later trip the 24h cap. Healthy/other endings keep it.
		if ((rateLimited || outage) && currentTurnWindowAt) {
			st.windows = st.windows.filter(w => w.startedAt !== currentTurnWindowAt);
			saveState();
		}
		currentTurnWindowAt = null;
		if (rateLimited) {
			// Trust the provider's own reset clock over local window math and
			// hold ALL dispatch until then — immediate retries only burn attempts.
			outageStreak = 0;
			const resumeAt = Date.now() + (waitMs ?? HOUR_MS) + cfg.windowSlackMs;
			st.rateLimitedUntil = new Date(resumeAt).toISOString();
			saveState();
			logEvent({ event: "blocked", detail: "provider rate limit", resumeAt: st.rateLimitedUntil });
			notify(
				null,
				`scheduler: provider rate-limited — holding dispatch until ${fmtClock(resumeAt)} (${fmtDuration(resumeAt - Date.now())}).`,
				"warning",
			);
			if (st.run === "running") armResumeTimer(resumeAt);
		} else if (outage) {
			// Connectivity is down; back off exponentially and probe forever —
			// an overnight outage must resume work, not fail the queue.
			outageStreak += 1;
			const backoff = Math.min(cfg.outageBackoffBaseMs * 2 ** (outageStreak - 1), cfg.outageBackoffMaxMs);
			const resumeAt = Date.now() + backoff;
			logEvent({
				event: "blocked",
				detail: `network/provider outage #${outageStreak}`,
				resumeAt: new Date(resumeAt).toISOString(),
			});
			notify(
				null,
				`scheduler: provider unreachable — retrying in ${fmtDuration(backoff)} (outage #${outageStreak}, attempt not counted).`,
				"warning",
			);
			if (st.run === "running") armResumeTimer(resumeAt);
		} else if (contentPolicy) {
			// The conversation is poisoned; purge it before the next dispatch so
			// this and every following task run in a clean context. The hit is not
			// the task's fault, so refund the attempt — a poison cascade must never
			// burn the maxAttempts budget. maxContextResets guards the pathological
			// case where a single prompt trips the classifier even when alone.
			outageStreak = 0;
			pendingContextReset = true;
			const cur = st.currentTaskId ? st.tasks.find(t => t.id === st.currentTaskId) : undefined;
			if (cur) {
				cur.policyResets = (cur.policyResets ?? 0) + 1;
				const capped = cur.policyResets > cfg.maxContextResets;
				settleCurrentTask(error, !capped, capped, "content_policy");
				logEvent({
					event: "blocked",
					taskId: cur.id,
					detail: capped
						? `content-policy violation persisted across ${cur.policyResets} context resets — task failed`
						: `content-policy violation #${cur.policyResets} — purging context, attempt refunded`,
				});
				if (!capped)
					notify(
						null,
						`scheduler: ${cur.id} hit a content-policy violation (#${cur.policyResets}) — clearing context and resuming (attempt not counted).`,
						"warning",
					);
			} else {
				// A manual/non-scheduled turn poisoned the shared context; clear it
				// before the scheduler dispatches its next task into the same history.
				logEvent({
					event: "blocked",
					detail: "content-policy violation on a non-scheduled turn — context reset queued",
				});
			}
			if (st.rateLimitedUntil) {
				st.rateLimitedUntil = null;
				saveState();
			}
			if (st.run === "running") scheduleDispatch(cfg.dispatchDelayMs);
		} else if (userAbort) {
			st.run = "paused";
			saveState();
			clearTimers();
			logEvent({ event: "pause", detail: "user aborted the in-flight scheduled task" });
			notify(
				null,
				"scheduler: turn aborted by user — queue paused, task kept as interrupted (attempt not counted). /scheduler start to resume.",
				"warning",
			);
		} else {
			outageStreak = 0;
			if (st.rateLimitedUntil) {
				// A turn ended without a rate limit: the provider is healthy again.
				st.rateLimitedUntil = null;
				saveState();
			}
			if (st.run === "running") scheduleDispatch(cfg.dispatchDelayMs);
		}
		updateStatus();
	});

	// extensions.md § "Reliability/runtime signals": auto_retry_start / auto_retry_end.
	// Payload shape is not part of the documented contract → defensive reads only.
	pi.on("auto_retry_end", async event => {
		const ev = event as unknown as Record<string, unknown> | null | undefined;
		if (ev && ev.success === false) {
			retryFailure =
				(typeof ev.finalError === "string" && ev.finalError) ||
				(typeof ev.error === "string" && ev.error) ||
				"provider retries exhausted (rate limit or outage)";
			logEvent({
				event: "retry_failed",
				taskId: getState().currentTaskId ?? undefined,
				error: retryFailure,
				detail:
					"provider auto-retries exhausted mid-turn; the following end event classifies and refunds/counts the attempt",
			});
		}
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		// Persist in-flight work as interrupted so the next launch resumes it.
		const st = getState();
		if (st.currentTaskId !== null) {
			const task = st.tasks.find(t => t.id === st.currentTaskId);
			if (task && task.status === "running") {
				task.status = "interrupted";
				task.lastError = "session shutdown mid-task";
				task.endedAt = new Date().toISOString();
				logEvent({ event: "recovered", taskId: task.id, status: "interrupted", detail: "session_shutdown" });
			}
			st.currentTaskId = null;
			saveState();
		}
		clearTimers();
		stopWatchdog();
	});

	// ---- command -----------------------------------------------------------
	// pi.registerCommand — authoring-extensions.md § "Registering commands".
	pi.registerCommand("scheduler", {
		description:
			"Quota-aware prompt queue: add|add-file|list|status|start|pause|stop|remove|retry|clear|export|log|ledger|config",
		handler: async (args, ctx) => {
			const cctx = ctx as unknown as CtxLike;
			liveCtx = cctx;
			cmdCtx = cctx;
			loadConfig();
			const trimmed = (args ?? "").trim();
			const space = trimmed.search(/\s/);
			const sub = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
			const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
			// state.json is corrupt/unreadable → saves are disabled (stateReadError),
			// so accepting a mutating command would change only in-memory state and
			// silently lose it on restart. Refuse those until the file is fixed;
			// read-only commands (status/list/log/ledger/config/export) still work.
			if (["add", "add-file", "remove", "retry", "clear", "start", "pause", "stop"].includes(sub)) {
				getState(); // populate stateReadError if the persisted state can't be read
				if (stateReadError) {
					notify(
						cctx,
						"scheduler: state.json is unreadable/corrupt — refusing to modify the queue until it is fixed or deleted (see the session-start error).",
						"error",
					);
					return;
				}
			}

			switch (sub) {
				case "add":
					return cmdAdd(cctx, rest, undefined);
				case "add-file":
					return cmdAddFile(cctx, rest);
				case "list":
				case "status":
					return cmdStatus(cctx);
				case "start":
					return cmdStart(cctx);
				case "pause":
					return cmdPause(cctx);
				case "stop":
					return cmdStop(cctx);
				case "remove":
					return cmdRemove(cctx, rest);
				case "retry":
					return cmdRetry(cctx, rest);
				case "clear":
					return cmdClear(cctx);
				case "export":
					return cmdExport(cctx, rest);
				case "log":
					return cmdLog(cctx, rest);
				case "ledger":
					return cmdLedger(cctx);
				case "config":
					return cmdConfig(cctx);
				default:
					notify(
						cctx,
						[
							"scheduler — session-quota-aware prompt queue",
							"  /scheduler add <prompt>      queue a task",
							'  /scheduler add-file <path>   queue task(s) from a file (multi: "@@prompts" header, "---"-separated)',
							"  /scheduler list | status     queue + session-window state",
							"  /scheduler start             begin draining the queue when idle",
							"  /scheduler pause             finish current task, then hold",
							"  /scheduler stop              abort current task and hold",
							"  /scheduler remove <id>       remove one task",
							"  /scheduler retry [id]        re-queue failed task(s) with a fresh attempt budget",
							"  /scheduler clear             remove all pending tasks",
							"  /scheduler export [path]     write the queue to a markdown file (default scheduler-queue.md)",
							"  /scheduler log [n]           show last n log entries (default 10)",
							"  /scheduler ledger            show the prompt-hash outcome table (prompt · summary · status)",
							"  /scheduler config            show config file path + values",
						].join("\n"),
					);
			}
		},
	});

	// ---- subcommand implementations -----------------------------------------

	/** Create + queue one task; caller is responsible for saveState/notify. */
	function enqueueTask(prompt: string, sourceFile: string | undefined): SchedulerTask {
		const st = getState();
		const task: SchedulerTask = {
			id: `t${st.nextTaskSeq++}`,
			prompt,
			promptHash: hashPrompt(prompt),
			sourceFile,
			status: "queued",
			addedAt: new Date().toISOString(),
			attempts: 0,
		};
		st.tasks.push(task);
		emptyQueueNotified = false;
		writeLedger();
		return task;
	}

	function cmdAdd(ctx: CtxLike, prompt: string, sourceFile: string | undefined): void {
		if (!prompt) {
			notify(ctx, "scheduler: usage — /scheduler add <prompt>", "warning");
			return;
		}
		const st = getState();
		const task = enqueueTask(prompt, sourceFile);
		saveState();
		notify(
			ctx,
			`scheduler: queued ${task.id} — ${truncate(prompt, 60)}${st.run === "stopped" ? " (scheduler stopped; /scheduler start to begin)" : ""}`,
		);
		if (st.run === "running") scheduleDispatch(cfg.dispatchDelayMs);
		updateStatus();
	}

	function cmdAddFile(ctx: CtxLike, fileArg: string): void {
		if (!fileArg) {
			notify(ctx, "scheduler: usage — /scheduler add-file <path>", "warning");
			return;
		}
		// ctx.cwd — extensions.md § "2) Handler context".
		const resolved = path.isAbsolute(fileArg) ? fileArg : path.join(ctx.cwd, fileArg);
		let content: string;
		try {
			content = fs.readFileSync(resolved, "utf8").trim();
		} catch (err) {
			notify(ctx, `scheduler: cannot read ${resolved}: ${String(err)}`, "error");
			return;
		}
		if (!content) {
			notify(ctx, `scheduler: ${resolved} is empty`, "warning");
			return;
		}
		// Verbatim format first (opt-in @@prompts header, escaping-free), then
		// the legacy JSON `{prompt:"…"}` batch, then a plain single prompt.
		const batch = parseVerbatimBatch(content) ?? parsePromptBatch(content);
		if (batch === null) {
			cmdAdd(ctx, content, resolved); // plain file = one prompt (unchanged behavior)
			return;
		}
		if (!Array.isArray(batch)) {
			// Batch-shaped but broken: refuse the whole file — queueing a
			// malformed batch as one giant prompt would waste a real turn.
			notify(ctx, `scheduler: ${resolved}: ${batch.error} — nothing queued`, "error");
			return;
		}
		const st = getState();
		const tasks = batch.map(p => enqueueTask(p, resolved));
		saveState();
		const idRange = tasks.length === 1 ? tasks[0].id : `${tasks[0].id}…${tasks[tasks.length - 1].id}`;
		notify(
			ctx,
			`scheduler: queued ${tasks.length} task(s) from batch file (${idRange})${st.run === "stopped" ? " (scheduler stopped; /scheduler start to begin)" : ""}`,
		);
		if (st.run === "running") scheduleDispatch(cfg.dispatchDelayMs);
		updateStatus();
	}

	function cmdStatus(ctx: CtxLike): void {
		const st = getState();
		const now = Date.now();
		const lines: string[] = [];
		lines.push(`scheduler: ${st.run}`);

		// Detected model + applied quota profile, e.g.
		// "model: anthropic/claude-fable-5 — quota: 5h×4 (anthropic)".
		const quota = currentQuota(ctx);
		const modelName = quota.detected
			? quota.provider && quota.modelId
				? `${quota.provider}/${quota.modelId}`
				: quota.provider || quota.modelId
			: "unknown";
		const providerLabel = quota.detected ? quota.provider || quota.modelId : "unknown provider";
		lines.push(
			quota.limits
				? `model: ${modelName} — quota: ${quota.limits.sessionHours}h×${quota.limits.maxSessionsPer24h} (${providerLabel})`
				: `model: ${modelName} — quota: none (${providerLabel})`,
		);

		if (quota.limits === null) {
			lines.push("windows: not tracked (unlimited profile)");
		} else {
			const used = windowStartsInLast24h(st, quota.key, now);
			const active = activeWindowStart(st, quota.key, quota.limits.sessionHours, now);
			let windowLine = `windows: ${used.length}/${quota.limits.maxSessionsPer24h} used in last 24h`;
			if (active !== null) {
				windowLine += `; active window ends in ${fmtDuration(active + quota.limits.sessionHours * HOUR_MS - now)}`;
			} else if (used.length >= quota.limits.maxSessionsPer24h) {
				windowLine += `; next window at ${fmtClock(used[0] + DAY_MS)}`;
			} else {
				windowLine += "; a new window starts with the next prompt";
			}
			lines.push(windowLine);
		}

		const holdUntil = st.rateLimitedUntil ? Date.parse(st.rateLimitedUntil) : Number.NaN;
		if (Number.isFinite(holdUntil) && holdUntil > now) {
			lines.push(`hold: provider rate-limited until ${fmtClock(holdUntil)} (${fmtDuration(holdUntil - now)})`);
		}

		const current = st.currentTaskId ? st.tasks.find(t => t.id === st.currentTaskId) : undefined;
		lines.push(
			current
				? `current: ${current.id} (attempt ${current.attempts}) — ${truncate(current.prompt, 60)}`
				: "current: none",
		);

		const pending = st.tasks.filter(t => t.status === "queued" || t.status === "interrupted");
		if (pending.length === 0) {
			lines.push("queue: empty");
		} else {
			lines.push("queue:");
			for (const t of pending) {
				const extra =
					t.status === "interrupted"
						? ` (attempt ${t.attempts}, ${truncate(t.lastError ?? "interrupted", 40)})`
						: "";
				lines.push(`  ${t.id}  ${t.status.padEnd(11)} ${truncate(t.prompt, 56)}${extra}`);
			}
		}
		const done = st.tasks.filter(t => t.status === "done").length;
		const failed = st.tasks.filter(t => t.status === "failed").length;
		if (done + failed > 0) lines.push(`finished: ${done} done, ${failed} failed (/scheduler log for details)`);

		// ctx.getContextUsage() — extensions.md § "2) Handler context"; payload
		// mirrors rpc.md § "get_state" contextUsage {tokens, contextWindow, percent}.
		const usage = ctx.getContextUsage?.();
		if (usage)
			lines.push(`context: ${Math.round(usage.percent)}% of ${Math.round(usage.contextWindow / 1000)}k tokens`);

		notify(ctx, lines.join("\n"));
	}

	async function cmdStart(ctx: CtxLike): Promise<void> {
		const st = getState();
		if (st.run === "running") {
			notify(ctx, "scheduler: already running");
			return;
		}
		// Permissions upfront: unattended tasks must never block on approval
		// prompts. approval-mode.md § "Modes": only `yolo` auto-approves all
		// tiers; `--yolo`/`--auto-approve` force it per session.
		const concern = detectApprovalConcern(ctx.cwd);
		if (concern) {
			const warning =
				`a tool-approval setting may block unattended runs (${concern}; not fully "yolo"/"allow"): overnight tasks can stall on approval prompts. ` +
				`Fix: relaunch with --yolo and clear non-"allow" tools.approval entries, or run: omp config set tools.approvalMode yolo. ` +
				`(If you launched with --yolo just now, this check cannot see runtime flags.)`;
			if (ctx.hasUI) {
				let proceed = false;
				try {
					// ctx.ui.confirm — extensions.md § "UI integration points" (dialogs).
					proceed = await ctx.ui.confirm("scheduler: approval mode warning", `${warning}\n\nStart anyway?`);
				} catch {
					notify(ctx, `scheduler WARNING: ${warning}`, "warning");
					proceed = true; // dialog unsupported in this mode — warn and continue
				}
				if (!proceed) {
					notify(ctx, "scheduler: start cancelled");
					return;
				}
			} else {
				notify(ctx, `scheduler WARNING: ${warning}`, "warning");
			}
		}
		st.run = "running";
		emptyQueueNotified = false;
		saveState();
		logEvent({ event: "start" });
		const pending = st.tasks.filter(t => t.status === "queued" || t.status === "interrupted").length;
		notify(ctx, `scheduler: running — ${pending} task(s) pending; dispatching when idle.`);
		scheduleDispatch(500);
		updateStatus();
	}

	function cmdPause(ctx: CtxLike): void {
		const st = getState();
		if (st.run !== "running") {
			notify(ctx, `scheduler: not running (state: ${st.run})`);
			return;
		}
		st.run = "paused";
		saveState();
		clearTimers();
		logEvent({ event: "pause" });
		notify(ctx, st.currentTaskId ? "scheduler: paused — current task will finish, then hold." : "scheduler: paused.");
		updateStatus();
	}

	async function cmdStop(ctx: CtxLike): Promise<void> {
		const st = getState();
		clearTimers();
		const hadCurrent = st.currentTaskId !== null;
		if (hadCurrent) {
			const task = st.tasks.find(t => t.id === st.currentTaskId);
			if (task) {
				// Stop aborts the in-flight task but keeps it resumable
				// (resume-not-skip): it stays at the head of the queue as
				// "interrupted" for the next /scheduler start.
				task.status = "interrupted";
				task.lastError = "stopped by user";
				task.endedAt = new Date().toISOString();
				logEvent({ event: "end", taskId: task.id, status: "interrupted", error: task.lastError });
			}
			st.currentTaskId = null;
		}
		st.run = "stopped";
		saveState();
		logEvent({ event: "stop" });
		if (hadCurrent) {
			try {
				// ctx.abort() — extensions.md § "2) Handler context".
				await ctx.abort();
			} catch {
				/* nothing streaming */
			}
		}
		notify(
			ctx,
			hadCurrent ? "scheduler: stopped — current task aborted (kept as interrupted)." : "scheduler: stopped.",
		);
		updateStatus();
	}

	function cmdRemove(ctx: CtxLike, id: string): void {
		if (!id) {
			notify(ctx, "scheduler: usage — /scheduler remove <id>", "warning");
			return;
		}
		const st = getState();
		const idx = st.tasks.findIndex(t => t.id === id);
		if (idx === -1) {
			notify(ctx, `scheduler: no task ${id}`, "warning");
			return;
		}
		if (st.currentTaskId === id) {
			notify(ctx, `scheduler: ${id} is in flight — /scheduler stop first`, "warning");
			return;
		}
		st.tasks.splice(idx, 1);
		saveState();
		notify(ctx, `scheduler: removed ${id}`);
		updateStatus();
	}

	function cmdRetry(ctx: CtxLike, id: string): void {
		const st = getState();
		const targets = st.tasks.filter(t => t.status === "failed" && (!id || t.id === id));
		if (targets.length === 0) {
			const existing = id ? st.tasks.find(t => t.id === id) : undefined;
			const msg = existing
				? `scheduler: ${id} is ${existing.status} — only failed tasks can be retried`
				: id
					? `scheduler: no failed task ${id}`
					: "scheduler: no failed tasks to retry";
			notify(ctx, msg, "warning");
			return;
		}
		for (const t of targets) {
			// Back to "interrupted", not "queued": the task already ran
			// partially, so the resume preamble applies on re-dispatch.
			t.status = "interrupted";
			t.attempts = 0;
			t.policyResets = 0;
			t.stalls = 0;
			logEvent({ event: "notice", taskId: t.id, detail: "failed task re-queued via /scheduler retry" });
		}
		emptyQueueNotified = false;
		saveState();
		notify(
			ctx,
			`scheduler: re-queued ${targets.map(t => t.id).join(", ")}${st.run === "running" ? "" : " (scheduler stopped; /scheduler start to begin)"}`,
		);
		if (st.run === "running") scheduleDispatch(cfg.dispatchDelayMs);
		updateStatus();
	}

	function cmdClear(ctx: CtxLike): void {
		const st = getState();
		const before = st.tasks.length;
		// "clear" empties only *pending* work (queued/interrupted). The in-flight
		// task and finished rows (done/failed) survive so /scheduler status, export,
		// and ledger keep their outcome history.
		st.tasks = st.tasks.filter(
			t => t.id === st.currentTaskId || (t.status !== "queued" && t.status !== "interrupted"),
		);
		saveState();
		notify(
			ctx,
			`scheduler: cleared ${before - st.tasks.length} pending task(s)${st.currentTaskId ? " (in-flight task kept; /scheduler stop to abort it)" : ""}`,
		);
		updateStatus();
	}

	function cmdLog(ctx: CtxLike, arg: string): void {
		const n = Math.max(1, Math.min(100, Number.parseInt(arg, 10) || 10));
		const entries = readLogTail(n);
		if (entries.length === 0) {
			notify(ctx, `scheduler: log empty (${logFile()})`);
			return;
		}
		const lines = entries.map(e => {
			const bits = [e.ts.replace("T", " ").slice(0, 19), e.event];
			if (e.taskId) bits.push(e.taskId);
			if (e.promptHash) bits.push(`#${e.promptHash}`);
			if (e.status) bits.push(e.status);
			if (e.classification) bits.push(e.classification);
			if (e.refunded !== undefined) bits.push(e.refunded ? "refunded" : "counted");
			if (e.attempt !== undefined) bits.push(`attempt=${e.attempt}`);
			if (e.attempts !== undefined && e.maxAttempts !== undefined)
				bits.push(`attempts=${e.attempts}/${e.maxAttempts}`);
			if (e.terminal) bits.push("TERMINAL");
			if (e.durationMs !== undefined) bits.push(`took=${fmtDuration(e.durationMs)}`);
			if (e.resumeAt) bits.push(`resumeAt=${e.resumeAt}`);
			if (e.error) bits.push(`error=${truncate(e.error, 60)}`);
			if (e.detail) bits.push(e.detail);
			if (e.summary) bits.push(`= ${truncate(e.summary, 70)}`);
			if (e.prompt) bits.push(`» ${truncate(e.prompt, 70)}`);
			return `  ${bits.join("  ")}`;
		});
		notify(ctx, [`scheduler: last ${entries.length} log entries (${logFile()}):`, ...lines].join("\n"));
	}

	/** Print the per-prompt outcome table (also persisted at task-ledger.md). */
	function cmdLedger(ctx: CtxLike): void {
		const st = getState();
		writeLedger(); // ensure the file reflects the latest state before we point at it
		if (st.tasks.length === 0) {
			notify(ctx, `scheduler: ledger empty (${ledgerFile()})`);
			return;
		}
		const lines = st.tasks.map(t => {
			const hash = t.promptHash || hashPrompt(t.prompt);
			return `  #${hash}  ${t.status.padEnd(11)} ${truncate(t.prompt, 60)}  = ${t.summary ? truncate(t.summary, 60) : "—"}`;
		});
		notify(ctx, [`scheduler: task ledger (${ledgerFile()}):`, ...lines].join("\n"));
	}

	/**
	 * Human-workable escape hatch: dump every task (any status) to markdown so
	 * the queue survives outside the harness — the user can re-run prompts by
	 * hand, edit them, or re-import via /scheduler add-file.
	 */
	function cmdExport(ctx: CtxLike, fileArg: string): void {
		const st = getState();
		const resolved = fileArg
			? path.isAbsolute(fileArg)
				? fileArg
				: path.join(ctx.cwd, fileArg)
			: path.join(ctx.cwd, "scheduler-queue.md");
		const lines: string[] = [
			"# scheduler queue export",
			"",
			`- exported: ${new Date().toISOString()}`,
			`- state file: ${stateFile()}`,
			`- run mode: ${st.run}`,
			"",
		];
		if (st.tasks.length === 0) lines.push("_queue empty_", "");
		for (const t of st.tasks) {
			lines.push(`## ${t.id} — ${t.status}`, "");
			lines.push(`- added: ${t.addedAt}  attempts: ${t.attempts}${t.sourceFile ? `  source: ${t.sourceFile}` : ""}`);
			if (t.lastError) lines.push(`- last error: ${truncate(t.lastError, 200)}`);
			lines.push("", "```text", t.prompt, "```", "");
		}
		try {
			fs.writeFileSync(resolved, `${lines.join("\n")}\n`, "utf8");
		} catch (err) {
			notify(ctx, `scheduler: export failed: ${String(err)}`, "error");
			return;
		}
		logEvent({ event: "notice", detail: `queue exported to ${resolved}` });
		notify(ctx, `scheduler: exported ${st.tasks.length} task(s) → ${resolved}`);
	}

	function cmdConfig(ctx: CtxLike): void {
		loadConfig();
		const profiles = cfg.quotaProfiles.map(p => {
			const policy =
				typeof p.sessionHours === "number" && typeof p.maxSessionsPer24h === "number"
					? `${p.sessionHours}h×${p.maxSessionsPer24h}`
					: "unlimited";
			return `    ${p.match} → ${policy}`;
		});
		notify(
			ctx,
			[
				`scheduler: config file — ${configFile()}`,
				"  quotaProfiles (first match on provider/model wins):",
				...profiles,
				`  maxAttempts: ${cfg.maxAttempts}`,
				`  dispatchDelayMs: ${cfg.dispatchDelayMs}`,
				`  outageBackoff: ${fmtDuration(cfg.outageBackoffBaseMs)} … ${fmtDuration(cfg.outageBackoffMaxMs)} (doubling)`,
				`  watchdog: every ${fmtDuration(cfg.watchdogIntervalMs)}, stall timeout ${fmtDuration(cfg.stallTimeoutMs)}`,
				`  windowSlackMs: ${cfg.windowSlackMs}`,
				`  promptPreamble: ${truncate(cfg.promptPreamble, 70)}`,
				`  resumePreamble: ${truncate(cfg.resumePreamble, 70)}`,
				"edit the file, then re-run /scheduler start (config reloads on start and session start)",
			].join("\n"),
		);
	}
}
