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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

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
	/** Set when the prompt was loaded via `add-file`. */
	sourceFile?: string;
	status: TaskStatus;
	addedAt: string;
	dispatchedAt?: string;
	endedAt?: string;
	attempts: number;
	lastError?: string;
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
}

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
		| "notice";
	taskId?: string;
	status?: TaskStatus;
	attempt?: number;
	resumed?: boolean;
	error?: string;
	durationMs?: number;
	resumeAt?: string;
	detail?: string;
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
}

/**
 * Opaque handle returned by setTimeout (number under DOM typings, Timeout
 * object under Node/Bun); only ever passed back to clearTimeout.
 */
type TimerHandle = number;

/** Opaque handle returned by setInterval; only ever passed back to clearInterval. */
type IntervalHandle = number;

// ---------------------------------------------------------------------------
// Data dir + defaults
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * settings.md § "Where settings live": PI_CODING_AGENT_DIR relocates the
 * ~/.omp/agent base directory; honor it so scheduler data moves with it.
 */
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
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

const DEFAULT_PROMPT_PREAMBLE = [
	"[scheduler] Unattended queued task — no human is watching this session.",
	"Rules for this task:",
	"- Never ask questions or wait for confirmation; make every decision autonomously.",
	"- Do not narrate progress. Do not produce summaries unless the task explicitly asks for one.",
	"- Keep all output terse: results, file paths, and errors only.",
	"- End with a single final line noting any assumptions you made.",
].join("\n");

const DEFAULT_RESUME_PREAMBLE = [
	"[scheduler] RESUME: this task was interrupted before completion (error, rate limit, or abort).",
	"Continue exactly where you left off; do not repeat completed work.",
	"Inspect the current state of files/artifacts to verify what is already done, then finish only the remainder.",
].join("\n");

/**
 * Default quota profiles: Anthropic Claude subscription auth is metered in
 * 5-hour session windows (max 4 per rolling 24h); every other provider —
 * OpenAI, Google, local models, API-key billing — has no such windows and
 * dispatches ungated. First match wins; edit config.json to adjust.
 */
const DEFAULT_QUOTA_PROFILES: QuotaProfile[] = [
	{ match: "anthropic|claude", sessionHours: 5, maxSessionsPer24h: 4 },
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

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
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

/**
 * Migrate persisted state to the current shape. v1 stored windows as plain
 * ISO strings under the then-global (Claude-only) quota; they are re-tagged
 * with the first gated profile so a mid-upgrade day keeps counting them.
 */
function migrateState(raw: unknown, cfg: SchedulerConfig): SchedulerState | null {
	if (!raw || typeof raw !== "object") return null;
	const st = raw as SchedulerState & { windows?: unknown[] };
	const legacyKey =
		cfg.quotaProfiles.find(p => typeof p.sessionHours === "number" && typeof p.maxSessionsPer24h === "number")
			?.match ?? DEFAULT_QUOTA_PROFILES[0].match;
	st.windows = (Array.isArray(st.windows) ? st.windows : []).map(w =>
		typeof w === "string" ? { startedAt: w, profile: legacyKey } : (w as WindowRecord),
	);
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
 * Best-effort effective `tools.approvalMode` from persisted settings.
 *
 * settings.md § "Where settings live" / § "Precedence": project
 * `<cwd>/.omp/config.yml` (and legacy `settings.json`) overrides global
 * `~/.omp/agent/config.yml` (and legacy `settings.json`). Runtime flags
 * (`--yolo`, `--approval-mode`) are in-memory only and CANNOT be detected
 * here — callers must treat a non-yolo result as a warning, not a hard fact.
 * Returns null when no layer sets the key (schema default is `yolo`,
 * approval-mode.md § "Modes").
 */
function detectApprovalMode(cwd: string): string | null {
	const candidates = [
		path.join(cwd, ".omp", "config.yml"),
		path.join(cwd, ".omp", "settings.json"),
		path.join(agentDir(), "config.yml"),
		path.join(agentDir(), "settings.json"),
	];
	for (const file of candidates) {
		const mode = readApprovalModeFrom(file);
		if (mode) return mode;
	}
	return null;
}

function readApprovalModeFrom(file: string): string | null {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	if (file.endsWith(".json")) {
		try {
			const parsed = JSON.parse(text) as { tools?: { approvalMode?: unknown } };
			const mode = parsed?.tools?.approvalMode;
			return typeof mode === "string" ? mode : null;
		} catch {
			return null;
		}
	}
	// Narrow YAML scan: in the settings schema `approvalMode` only exists under
	// `tools:` (settings.md § "Tools and approvals"), so a single-key match is
	// unambiguous without a YAML parser.
	const match = /^\s*approvalMode:\s*["']?([A-Za-z-]+)["']?\s*(?:#.*)?$/m.exec(text);
	return match ? match[1] : null;
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
		if (stop === "error" || stop === "aborted") {
			const errText = typeof msg.errorMessage === "string" && msg.errorMessage ? `: ${msg.errorMessage}` : "";
			return `turn ${stop}${errText}`;
		}
		return null; // last assistant message looks normal
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
	let cfg: SchedulerConfig = structuredClone(DEFAULT_CONFIG);
	let liveCtx: CtxLike | null = null;
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

	function startTimer(ms: number, fn: () => void): TimerHandle {
		return setTimeout(fn, ms) as unknown as TimerHandle;
	}
	function stopTimer(handle: TimerHandle | null): null {
		clearTimeout(handle as TimerHandle); // spec no-op for null/stale handles
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
		const st = getState();
		if (st.run !== "running") return;
		if (st.currentTaskId !== null) {
			const task = st.tasks.find(t => t.id === st.currentTaskId);
			const dispatchedAt = task?.dispatchedAt ? Date.parse(task.dispatchedAt) : Number.NaN;
			const stale = !Number.isFinite(dispatchedAt) || Date.now() - dispatchedAt > cfg.stallTimeoutMs;
			if (stale && liveCtx?.isIdle() === true) {
				const id = st.currentTaskId;
				logEvent({ event: "recovered", taskId: id, detail: "watchdog: task in flight but agent idle" });
				notify(
					null,
					`scheduler: watchdog — ${id} stalled with an idle agent; re-queued (attempt not counted).`,
					"warning",
				);
				settleCurrentTask("stalled: agent idle with task in flight", true);
				scheduleDispatch(cfg.dispatchDelayMs);
			}
			return;
		}
		if (dispatchTimer === null && resumeTimer === null && !agentActive && nextPendingTask(st)) {
			logEvent({ event: "notice", detail: "watchdog: pending work with no armed timer — re-arming dispatch" });
			scheduleDispatch(cfg.dispatchDelayMs);
		}
	}
	function startWatchdog(): void {
		if (watchdogTimer !== null) return;
		const handle = setInterval(watchdogTick, cfg.watchdogIntervalMs);
		handle.unref?.(); // Node/Bun: don't keep the host process alive for the watchdog
		watchdogTimer = handle as unknown as IntervalHandle; // same opaque-handle convention as TimerHandle
	}
	function stopWatchdog(): void {
		if (watchdogTimer !== null) {
			clearInterval(watchdogTimer as IntervalHandle);
			watchdogTimer = null;
		}
	}

	// ---- persistence -------------------------------------------------------
	function getState(): SchedulerState {
		if (state === null) {
			state = migrateState(readJson<unknown>(stateFile()), cfg) ?? structuredClone(EMPTY_STATE);
		}
		return state;
	}
	function saveState(): void {
		if (state !== null) writeJson(stateFile(), state);
	}
	function loadConfig(): void {
		const onDisk = readJson<Partial<SchedulerConfig> & { windowHours?: unknown; maxWindowsPer24h?: unknown }>(
			configFile(),
		);
		if (onDisk === null) {
			cfg = structuredClone(DEFAULT_CONFIG);
			writeJson(configFile(), cfg); // seed an editable config file
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
		return quota;
	}

	// ---- dispatch loop -------------------------------------------------------
	function scheduleDispatch(delayMs: number): void {
		dispatchTimer = stopTimer(dispatchTimer);
		dispatchTimer = startTimer(delayMs, () => {
			dispatchTimer = null;
			tryDispatch();
		});
	}

	function armResumeTimer(atMs: number): void {
		resumeTimer = stopTimer(resumeTimer);
		const delay = Math.max(1000, atMs - Date.now());
		resumeTimer = startTimer(delay, () => {
			resumeTimer = null;
			logEvent({ event: "resume_timer" });
			tryDispatch();
		});
	}

	function tryDispatch(): void {
		const st = getState();
		if (st.run !== "running") return;
		if (st.currentTaskId !== null) return; // a task is already in flight
		if (agentActive) return; // manual/other turn in progress
		// extensions.md § "2) Handler context": isIdle(), hasPendingMessages().
		// Defer to user-queued messages; re-check after the next agent_end.
		if (liveCtx && (!liveCtx.isIdle() || liveCtx.hasPendingMessages())) {
			scheduleDispatch(cfg.dispatchDelayMs);
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
		logEvent({ event: "dispatch", taskId: task.id, attempt: task.attempts, resumed: resuming });

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
			task.status = "interrupted";
			task.lastError = `dispatch failed: ${String(err)}`;
			st.currentTaskId = null;
			saveState();
			logEvent({ event: "end", taskId: task.id, status: "interrupted", error: task.lastError });
			scheduleDispatch(30_000);
		}
		updateStatus();
	}

	function settleCurrentTask(error: string | null, refundAttempt = false): void {
		const st = getState();
		if (st.currentTaskId === null) return;
		const task = st.tasks.find(t => t.id === st.currentTaskId);
		st.currentTaskId = null;
		if (task) {
			task.endedAt = new Date().toISOString();
			const durationMs = task.dispatchedAt ? Date.now() - Date.parse(task.dispatchedAt) : undefined;
			if (error) {
				task.lastError = error;
				if (refundAttempt) {
					// Rate limits and outages are not the task's fault: refund
					// the attempt so they can never exhaust maxAttempts.
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
			logEvent({ event: "end", taskId: task.id, status: task.status, error: error ?? undefined, durationMs });
		}
		saveState();
	}

	// ---- events ----------------------------------------------------------------
	// Event names below are from extensions.md § "Event surface".

	pi.on("session_start", async (_event, ctx) => {
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
		// Window accounting: ANY agent turn (scheduled or typed manually)
		// consumes the provider session window, so a new local window record
		// starts whenever a turn begins outside an active one — but only for
		// gated profiles; unlimited providers record no windows at all.
		const quota = currentQuota(liveCtx);
		if (quota.limits === null) return;
		const st = getState();
		const now = Date.now();
		if (activeWindowStart(st, quota.key, quota.limits.sessionHours, now) === null) {
			st.windows.push({ startedAt: new Date(now).toISOString(), profile: quota.key });
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
		agentActive = false;
		const fromRetryExhaustion = retryFailure !== null;
		const error = retryFailure ?? detectTurnError(event);
		retryFailure = null;
		const waitMs = error === null ? null : parseRetryAfterMs(error);
		const rateLimited =
			error !== null && (waitMs !== null || (fromRetryExhaustion && /rate.?limit|\b429\b|quota/i.test(error)));
		const outage = !rateLimited && error !== null && fromRetryExhaustion && isTransientNetworkError(error);
		// A user abort of a *scheduled* turn means the human wants the seat:
		// pause the queue instead of fighting them for the next turn.
		const userAbort =
			!rateLimited && !outage && error !== null && /\baborted\b/i.test(error) && getState().currentTaskId !== null;
		settleCurrentTask(error, rateLimited || outage || userAbort);
		const st = getState();
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
				typeof ev.error === "string" && ev.error ? ev.error : "provider retries exhausted (rate limit or outage)";
			logEvent({ event: "retry_failed", taskId: getState().currentTaskId ?? undefined, error: retryFailure });
		}
	});

	pi.on("session_shutdown", async () => {
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
			"Quota-aware prompt queue: add|add-file|list|status|start|pause|stop|remove|retry|clear|export|log|config",
		handler: async (args, ctx) => {
			const cctx = ctx as unknown as CtxLike;
			liveCtx = cctx;
			loadConfig();
			const trimmed = (args ?? "").trim();
			const space = trimmed.search(/\s/);
			const sub = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
			const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

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
				case "config":
					return cmdConfig(cctx);
				default:
					notify(
						cctx,
						[
							"scheduler — session-quota-aware prompt queue",
							"  /scheduler add <prompt>      queue a task",
							'  /scheduler add-file <path>   queue task(s) from a file (multi: {prompt: "…"}, {prompt: "…"})',
							"  /scheduler list | status     queue + session-window state",
							"  /scheduler start             begin draining the queue when idle",
							"  /scheduler pause             finish current task, then hold",
							"  /scheduler stop              abort current task and hold",
							"  /scheduler remove <id>       remove one task",
							"  /scheduler retry [id]        re-queue failed task(s) with a fresh attempt budget",
							"  /scheduler clear             remove all pending tasks",
							"  /scheduler export [path]     write the queue to a markdown file (default scheduler-queue.md)",
							"  /scheduler log [n]           show last n log entries (default 10)",
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
			sourceFile,
			status: "queued",
			addedAt: new Date().toISOString(),
			attempts: 0,
		};
		st.tasks.push(task);
		emptyQueueNotified = false;
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
		const batch = parsePromptBatch(content);
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
		const mode = detectApprovalMode(ctx.cwd);
		if (mode && mode !== "yolo") {
			const warning =
				`tools.approvalMode is "${mode}" (not "yolo"): overnight tasks WILL stall on approval prompts. ` +
				`Fix: relaunch with --yolo, or run: omp config set tools.approvalMode yolo. ` +
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
		st.tasks = st.tasks.filter(t => t.id === st.currentTaskId);
		saveState();
		notify(
			ctx,
			`scheduler: cleared ${before - st.tasks.length} task(s)${st.currentTaskId ? " (in-flight task kept; /scheduler stop to abort it)" : ""}`,
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
			if (e.status) bits.push(e.status);
			if (e.attempt !== undefined) bits.push(`attempt=${e.attempt}`);
			if (e.durationMs !== undefined) bits.push(`took=${fmtDuration(e.durationMs)}`);
			if (e.resumeAt) bits.push(`resumeAt=${e.resumeAt}`);
			if (e.error) bits.push(`error=${truncate(e.error, 60)}`);
			if (e.detail) bits.push(e.detail);
			return `  ${bits.join("  ")}`;
		});
		notify(ctx, [`scheduler: last ${entries.length} log entries (${logFile()}):`, ...lines].join("\n"));
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
