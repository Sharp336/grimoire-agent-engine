import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ImageContent, TextContent, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;
const VETO_SENTINEL = "__vetoed__";
let unhashableCounter = 0;

/**
 * Keys stripped from tool-result `details` before hashing so per-call timings
 * and volatile identifiers don't defeat the no-progress hash. A repeated dead
 * endpoint returns structurally identical output but with a fresh timestamp /
 * requestId each call — without stripping, every result hashes unique and the
 * no-progress streak never trips.
 *
 * Ported from atomic-agent's `VOLATILE_RESULT_KEYS`.
 */
const VOLATILE_RESULT_KEYS: Record<string, true> = {
	timestamp: true,
	ts: true,
	date: true,
	time: true,
	timeTotal: true,
	timeTotalSeconds: true,
	durationMs: true,
	sizeDownload: true,
	requestId: true,
	request_id: true,
	traceId: true,
	trace_id: true,
	sentAt: true,
	createdAt: true,
	deliveredAt: true,
};

/**
 * Tools where scanning many distinct arguments is a wandering failure mode
 * (probing endless URLs / selectors / pages) rather than legitimate bulk work.
 * Reads over distinct files are deliberately NOT prone.
 */
const DEFAULT_PRONE_TOOLS: Record<string, true> = {
	"web.fetch": true,
	fetch: true,
	"http.request": true,
	browser: true,
	"browser.click": true,
	"browser.navigate": true,
	"browser.type": true,
};

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	/** Args-only repeat count that fires an advisory warning. */
	readonly threshold: number;
	readonly exemptTools: readonly string[];
	/** Args+result no-progress count that fires a pre-call veto. 0 disables. */
	readonly noProgressThreshold?: number;
	/** Distinct-args spread on prone tools that fires a wandering warning. 0 disables. */
	readonly wanderingThreshold?: number;
	/** Distinct-args spread on prone tools that escalates to a breaker veto. */
	readonly wanderingEscalation?: number;
	/** Consecutive critical vetoes before the breaker forces a graceful reply. */
	readonly breakerVetoStreak?: number;
	/** Tools considered wandering-prone (defaults to a built-in set). */
	readonly proneTools?: readonly string[];
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

/** A tool call about to execute, offered to the guard for a pre-call veto. */
export interface ToolCallCheckInput {
	readonly toolName: string;
	readonly args: unknown;
}

/**
 * Pre-call verdict. `critical` vetoes the call (synthetic error result, tool
 * never runs). `breaker` signals the runtime to end the turn gracefully.
 */
export type ToolCallCheckVerdict =
	| { kind: "allow" }
	| { kind: "wandering"; toolName: string; spread: number; argumentsSummary: string }
	| {
			kind: "critical";
			toolName: string;
			count: number;
			argumentsSummary: string;
			source: "no_progress" | "wandering";
	  }
	| { kind: "breaker"; toolName: string; reason: string };

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

/**
 * A wandering-loop detection: the model is probing many distinct arguments on a
 * prone tool (endless URLs, selectors) without converging.
 */
export interface WanderingToolCallDetection {
	readonly kind: "wandering_tool_call";
	readonly toolName: string;
	readonly spread: number;
	readonly argumentsSummary: string;
}

/** Any detection the runtime must surface (advisory or veto). */
export type ToolCallLoopDetection = RepeatedToolCallDetection | WanderingToolCallDetection;

/**
 * Result fields the guard needs to hash a tool outcome. Both the agent's
 * `AgentToolResult` (content + details + isError) and a `ToolResultMessage`
 * satisfy this shape, so the live-loop and the post-turn recordTurn path share
 * one hashing path without a bridge.
 */
export interface ToolCallOutcome {
	readonly content: readonly (TextContent | ImageContent)[];
	readonly details?: unknown;
	readonly isError?: boolean;
}

function canonicalizeToolCallValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = canonicalizeToolCallValue(input[key]);
	}
	return output;
}

/**
 * Recursively strips volatile keys from a value so per-call timings and
 * transient identifiers don't defeat the no-progress result hash.
 */
function stripVolatile(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
	if (Array.isArray(value)) {
		return value.map(item => stripVolatile(item, seen));
	}
	if (!value || typeof value !== "object") {
		// Primitives (including bigint) pass through — JSON.stringify handles them.
		return value;
	}
	// Only recurse into plain records (Object.prototype or null proto).
	// Built-ins like Date, Map, Set, RegExp have no enumerable own keys
	// via Object.keys but carry meaningful state — pass them through so
	// JSON.stringify's toJSON / default serialization preserves them.
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) {
		return value;
	}
	const obj = value as object;
	if (seen.has(obj)) return undefined; // cycle guard
	seen.add(obj);
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (VOLATILE_RESULT_KEYS[key]) continue;
		output[key] = stripVolatile(input[key], seen);
	}
	return output;
}

function summarizeText(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

/**
 * Builds a stable hash of a tool result for no-progress detection. Joins text
 * content with volatile keys stripped from `details` so structurally identical
 * outputs (modulo timestamps / request ids) hash equal. Accepts the shared
 * {@link ToolCallOutcome} shape so both the live loop (AgentToolResult) and the
 * post-turn recordTurn path (ToolResultMessage) feed the same hasher.
 */
function hashOutcome(outcome: ToolCallOutcome): string {
	const parts: string[] = [];
	for (const block of outcome.content) {
		if (block.type === "text") {
			// Only strip volatile patterns from error text — error strings
			// routinely embed wall-clock times and request IDs (e.g. "request
			// req-abc123 failed at 2026-07-26T12:00:01Z") that make each failure
			// hash differently, breaking the no-progress streak on flaky
			// endpoints. Successful results may contain timestamps as semantic
			// data (e.g. polling a build log), so they are hashed verbatim.
			const text = outcome.isError
				? block.text
						.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<ts>")
						.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
						.replace(/\breq-[a-zA-Z0-9]+\b/g, "<req-id>")
				: block.text;
			parts.push(`t:${text}`);
		} else if (block.type === "image") {
			// Hash the full image data so two screenshots with identical headers
			// but different pixels don't falsely match. A prefix-only comparison
			// would miss differences past the first ~48 bytes (common for
			// same-resolution PNGs sharing a header).
			parts.push(`i:${block.mimeType}:${Bun.hash(block.data).toString(36)}`);
		}
	}
	const contentHash = parts.join("\n");
	// Serialize details with a bigint-aware replacer so { value: 1n } and
	// { value: 2n } produce distinct hashes (JSON.stringify throws on
	// bigint by default). For any genuinely-unhashable remainder (cyclic
	// structures that slip past the WeakSet guard), use a unique counter
	// so they never falsely match — treating them as non-comparable.
	let detailsHash = "";
	if (outcome.details !== undefined) {
		try {
			detailsHash = JSON.stringify(stripVolatile(outcome.details), (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
		} catch {
			detailsHash = `<unhashable:${unhashableCounter++}>`;
		}
	}
	return `${contentHash}\u0000${detailsHash}\u0000${outcome.isError ? "e" : "o"}`;
}

interface CallRecord {
	/** args-only hash: `${name}:${canonicalArgs}` */
	readonly argsHash: string;
	/** Tool-call ID from the assistant message — stable across pre/post-transform args. */
	readonly toolCallId: string | undefined;
	resultHash: string | undefined;
}

/**
 * Detects consecutive identical assistant tool calls across model turns, and
 * vetoes stuck no-progress loops before the tool re-executes.
 *
 * Three detection layers (ported from atomic-agent's ToolLoopTracker):
 *
 * 1. **Args-only repeat** (advisory): identical `name+args` across consecutive
 *    turns fires a `repeated_tool_call` redirect at `threshold`. Post-turn,
 *    does not block execution.
 * 2. **No-progress streak** (pre-call veto): identical `name+args+result` across
 *    consecutive turns fires `critical` at `noProgressThreshold`; the pre-call
 *    `check()` returns a veto so the tool never runs. Vetoed calls are excluded
 *    from the streak so the veto itself doesn't inflate it.
 * 3. **Wandering detector** (warn → breaker): for prone tools (web.fetch,
 *    http.request, browser.*), counts distinct `argsHash`es. Warns at
 *    `wanderingThreshold`; escalates to a breaker veto at `wanderingEscalation`.
 *
 * A `breaker` verdict (consecutive critical vetoes ≥ `breakerVetoStreak`, or a
 * wandering escalation) signals the runtime to end the turn gracefully — the
 * session stays pending; no hard failure.
 *
 * **Dual-path invariant.** Tracking can be driven two ways:
 * - **Live path**: `check()` → `recordCall()` → `recordOutcome()` per tool,
 *   wired to `beforeToolCall` / `afterToolCall`. This is the primary path.
 * - **Post-turn path**: `recordTurn()` alone, used by tests and any caller that
 *   doesn't wire the live hooks.
 *
 * When the live path is active, `recordTurn` MUST NOT re-increment the shared
 * counters (`#repeatCount`, `#noProgressStreak`, `#lastArgsHash`) — that would
 * double-count and fire the guard at half the configured threshold. The
 * `#liveTrackingActive` flag (set by `recordCall`, cleared by `resetForTurn`)
 * gates this: if live tracking ran this turn, `recordTurn` reads current state
 * for the advisory detection return without re-incrementing.
 */
export class ToolCallLoopGuard {
	#threshold: number;
	#noProgressThreshold: number;
	#wanderingThreshold: number;
	#wanderingEscalation: number;
	#breakerVetoStreak: number;
	#exemptTools: ReadonlySet<string>;
	#proneTools: Record<string, true>;

	// Args-only repeat tracking (layer 1).
	#lastArgsHash: string | undefined;
	#repeatCount = 0;

	// No-progress streak tracking (layer 2). Keyed on argsHash + resultHash.
	#lastNoProgressKey: string | undefined;
	#noProgressStreak = 0;
	#consecutiveVetoes = 0;
	// Wandering-specific veto counter (layer 3). Separate from
	// #consecutiveVetoes so a genuine non-prone call (e.g. a `read` between
	// browser attempts) doesn't reset the wandering breaker progress — the
	// browser wandering is still ongoing even if the model interleaved a read.
	#wanderingVetoes = new Map<string, number>();

	// Wandering tracking (layer 3). Distinct argsHashes per prone tool this turn-window.
	#wanderingHashes = new Map<string, Set<string>>();

	// Ring buffer of recent call records (args + result), capped for bounded memory.
	#history: CallRecord[] = [];
	readonly #historySize = 40;

	/**
	 * True once `recordCall` runs this turn — signals that the live
	 * beforeToolCall/afterToolCall path is active, so `recordTurn` must NOT
	 * re-increment the shared counters (it would double-count). Cleared by
	 * `resetForTurn` at the next turn boundary.
	 */
	#liveTrackingActive = false;

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#noProgressThreshold = Math.max(0, Math.trunc(options.noProgressThreshold ?? 0));
		this.#wanderingThreshold = Math.max(0, Math.trunc(options.wanderingThreshold ?? 0));
		this.#wanderingEscalation = Math.max(this.#wanderingThreshold, Math.trunc(options.wanderingEscalation ?? 0));
		this.#breakerVetoStreak = Math.max(1, Math.trunc(options.breakerVetoStreak ?? 3));
		this.#exemptTools = new Set(options.exemptTools);
		if (options.proneTools) {
			this.#proneTools = {};
			for (const t of options.proneTools) this.#proneTools[t] = true;
		} else {
			this.#proneTools = { ...DEFAULT_PRONE_TOOLS };
		}
	}

	/**
	 * Pre-call veto gate. Called BEFORE a tool executes. Returns `critical` to
	 * veto (the runtime emits a synthetic error result and the tool never runs),
	 * or `breaker` to end the turn gracefully. `warn` / `wandering` are advisory.
	 *
	 * The caller MUST invoke {@link recordCall} after `check` (whether allowed or
	 * vetoed) to commit the call to the tracker, then {@link recordOutcome} once
	 * the result is known (vetoed calls record a sentinel).
	 */
	check(input: ToolCallCheckInput): ToolCallCheckVerdict {
		const { toolName, args } = input;
		if (this.#exemptTools.has(toolName)) return { kind: "allow" };

		const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(args));
		const argsHash = `${toolName}:${canonicalArgs}`;

		// Layer 2: no-progress streak (args + result). Veto only when the streak
		// has crossed the threshold — the streak itself is advanced in
		// recordOutcome, so check() reads the current value.
		if (this.#noProgressThreshold > 0 && this.#noProgressStreak >= this.#noProgressThreshold) {
			// Only veto if this call's args match the streak's args.
			const streakArgsHash =
				this.#lastNoProgressKey !== undefined
					? this.#lastNoProgressKey.slice(0, this.#lastNoProgressKey.indexOf("\u0000"))
					: undefined;
			if (argsHash === streakArgsHash) {
				this.#consecutiveVetoes++;
				if (this.#consecutiveVetoes >= this.#breakerVetoStreak) {
					// Clear no-progress state so the next user request gets a fresh
					// start. agent.abort() skips onTurnEnd, so recordTurn can't
					// clear it — without this, the next same-args call would go
					// straight to breaker again.
					this.#lastNoProgressKey = undefined;
					this.#noProgressStreak = 0;
					this.#consecutiveVetoes = 0;
					return {
						kind: "breaker",
						toolName,
						reason: `tool-call loop breaker: ${toolName} vetoed ${this.#breakerVetoStreak} consecutive times`,
					};
				}
				return {
					kind: "critical",
					toolName,
					count: this.#noProgressStreak,
					argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
					source: "no_progress",
				};
			}
		}

		// Layer 3: wandering detector for prone tools.
		if (this.#wanderingThreshold > 0 && this.#isProneTool(toolName)) {
			const spread = this.#effectiveSpread(toolName, argsHash);
			if (this.#wanderingEscalation > 0 && spread >= this.#wanderingEscalation) {
				const vetoes = (this.#wanderingVetoes.get(toolName) ?? 0) + 1;
				this.#wanderingVetoes.set(toolName, vetoes);
				if (vetoes >= this.#breakerVetoStreak) {
					// Clear this tool's wandering set so the breaker doesn't
					// permanently veto all future calls to it — the model gets
					// a fresh start after the graceful turn end.
					this.#wanderingHashes.delete(toolName);
					this.#wanderingVetoes.delete(toolName);
					return {
						kind: "breaker",
						toolName,
						reason: `wandering loop breaker: ${toolName} probed ${spread} distinct argument sets`,
					};
				}
				return {
					kind: "critical",
					toolName,
					count: spread,
					argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
					source: "wandering",
				};
			}
			if (spread >= this.#wanderingThreshold) {
				return {
					kind: "wandering",
					toolName,
					spread,
					argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
				};
			}
		}

		return { kind: "allow" };
	}

	/**
	 * Commits a call to the tracker (post-`check`). Synchronous so a duplicate
	 * later in the same batch observes the earlier sibling. Sets the
	 * `#liveTrackingActive` flag so `recordTurn` knows not to re-increment.
	 */
	recordCall(toolName: string, args: unknown, toolCallId?: string): void {
		if (this.#exemptTools.has(toolName)) return;
		this.#liveTrackingActive = true;
		const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(args));
		const argsHash = `${toolName}:${canonicalArgs}`;

		// Layer 1: args-only repeat.
		if (argsHash === this.#lastArgsHash) {
			this.#repeatCount++;
		} else {
			this.#lastArgsHash = argsHash;
			this.#repeatCount = 1;
		}

		// Layer 3: track distinct argsHashes for prone tools (bounded per tool).
		if (this.#isProneTool(toolName)) {
			let set = this.#wanderingHashes.get(toolName);
			if (!set) {
				set = new Set();
				this.#wanderingHashes.set(toolName, set);
			}
			set.add(argsHash);
			// Bound each per-tool set so it can't grow unboundedly: cap at
			// wanderingEscalation * 2, evicting oldest (FIFO via iterator).
			const cap = Math.max(this.#wanderingEscalation * 2, this.#wanderingThreshold * 2, 24);
			if (set.size > cap) {
				const first = set.values().next().value;
				if (first !== undefined) set.delete(first);
			}
		}

		// History ring buffer — keyed by toolCallId for stable matching across
		// pre/post-transform args (secret deobfuscation, timeout capping).
		this.#history.push({ argsHash, toolCallId, resultHash: undefined });
		if (this.#history.length > this.#historySize) this.#history.shift();
	}

	/**
	 * Records the outcome of a call. Updates the no-progress streak (layer 2).
	 * Pass `vetoed: true` for vetoed calls so they're excluded from the streak.
	 *
	 * Accepts the agent's native result shape ({@link ToolCallOutcome}) so the
	 * `afterToolCall` hook can pass `ctx.result` without bridging.
	 */
	recordOutcome(
		toolName: string,
		args: unknown,
		outcome: { result?: ToolCallOutcome; vetoed?: boolean; toolCallId?: string },
	): void {
		if (this.#exemptTools.has(toolName)) return;
		const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(args));
		const argsHash = `${toolName}:${canonicalArgs}`;

		// Find the in-flight record for this call. Prefer matching by toolCallId
		// (stable across pre/post-transform args) so secret deobfuscation or
		// timeout capping doesn't break the no-progress streak. Fall back to
		// argsHash for callers that don't pass a toolCallId (tests / recordTurn).
		const record = outcome.toolCallId
			? this.#history.findLast(r => r.toolCallId === outcome.toolCallId && r.resultHash === undefined)
			: this.#history.findLast(r => r.argsHash === argsHash && r.resultHash === undefined);
		if (!record) return;

		if (outcome.vetoed) {
			// Vetoed calls don't count toward the no-progress streak — they never ran.
			record.resultHash = VETO_SENTINEL;
			return;
		}

		const resultHash = outcome.result ? hashOutcome(outcome.result) : "";
		record.resultHash = resultHash;

		// Layer 2: no-progress streak. Key on the RECORD's argsHash (from
		// recordCall, which saw the pre-transform args) + resultHash. Using the
		// record's argsHash instead of recomputing from post-transform args
		// ensures check() — which also uses pre-transform args — can match the
		// streak even when transformToolCallArguments changed the args.
		const streakArgsHash = record.argsHash;
		const noProgressKey = `${streakArgsHash}\u0000${resultHash}`;
		if (noProgressKey === this.#lastNoProgressKey) {
			this.#noProgressStreak++;
		} else {
			this.#lastNoProgressKey = noProgressKey;
			this.#noProgressStreak = 1;
		}
		// Reset the no-progress consecutive-veto counter on every genuine call.
		// Vetoed calls early-return above (line 470) without reaching this, so
		// the counter only accumulates across consecutive vetoes of the same
		// stuck tool — a genuine call between vetoes means the model tried
		// something else, which breaks the "consecutive" chain.
		// The wandering veto counter is NOT reset here — a `read` between
		// browser attempts doesn't mean the browser wandering resolved.
		this.#consecutiveVetoes = 0;
	}

	/**
	 * Records one completed turn and returns the threshold hit, if any.
	 *
	 * When the live path (`recordCall` + `recordOutcome`) is active for this
	 * turn, the shared counters (`#repeatCount`, `#noProgressStreak`) were already
	 * advanced — so this method MUST NOT re-increment them. It reads the current
	 * state to decide whether to emit an advisory detection. When the live path
	 * is NOT active (tests / callers that use `recordTurn` standalone), this
	 * method performs the increments itself for back-compat.
	 */
	recordTurn(turn: ToolCallLoopTurn): ToolCallLoopDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length !== 1 || this.#exemptTools.has(toolCalls[0]!.name)) {
			// The qualifying sequence was interrupted (prose turn, multiple calls,
			// or exempt tool). Reset ALL cross-turn streak state so an intervening
			// turn doesn't leave a stale no-progress streak that vetoes the next
			// same-args call. This runs on BOTH paths — the live path's
			// recordCall/recordOutcome will re-increment on the next genuine call.
			this.#lastArgsHash = undefined;
			this.#repeatCount = 0;
			this.#lastNoProgressKey = undefined;
			this.#noProgressStreak = 0;
			this.#consecutiveVetoes = 0;
			this.#wanderingVetoes.clear();
			return null;
		}

		const toolCall = toolCalls[0]!;
		const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(toolCall.arguments));
		const argsHash = `${toolCall.name}:${canonicalArgs}`;

		if (this.#liveTrackingActive) {
			// Live path already advanced #repeatCount / #noProgressStreak via
			// recordCall + recordOutcome. Read current state for the detection
			// return — do NOT re-increment.
			return this.#detectFromCurrentState(toolCall, argsHash, canonicalArgs, turn);
		}

		// --- Standalone path (no live hooks wired): increment counters here. ---
		if (argsHash === this.#lastArgsHash) {
			this.#repeatCount++;
		} else {
			this.#lastArgsHash = argsHash;
			this.#repeatCount = 1;
		}

		// Layer 3: track distinct argsHashes for prone tools (standalone path).
		if (this.#isProneTool(toolCall.name)) {
			let set = this.#wanderingHashes.get(toolCall.name);
			if (!set) {
				set = new Set();
				this.#wanderingHashes.set(toolCall.name, set);
			}
			set.add(argsHash);
			const cap = Math.max(this.#wanderingEscalation * 2, this.#wanderingThreshold * 2, 24);
			if (set.size > cap) {
				const first = set.values().next().value;
				if (first !== undefined) set.delete(first);
			}
		}

		if (this.#noProgressThreshold > 0) {
			const result = turn.toolResults.find(r => r.toolCallId === toolCall.id);
			if (result) {
				const outcome: ToolCallOutcome = {
					content: result.content,
					details: result.details,
					isError: result.isError,
				};
				const resultHash = hashOutcome(outcome);
				const noProgressKey = `${argsHash}\u0000${resultHash}`;
				if (noProgressKey === this.#lastNoProgressKey) {
					this.#noProgressStreak++;
				} else {
					this.#lastNoProgressKey = noProgressKey;
					this.#noProgressStreak = 1;
				}
			}
		}

		return this.#detectFromCurrentState(toolCall, argsHash, canonicalArgs, turn);
	}

	/**
	 * Builds the advisory detection (if any) from current counter state. Shared
	 * by both the live path and the standalone path so neither duplicates the
	 * detection logic.
	 */
	#detectFromCurrentState(
		toolCall: ToolCall,
		argsHash: string,
		canonicalArgs: string,
		turn: ToolCallLoopTurn,
	): ToolCallLoopDetection | null {
		// Args-only repeat: fires once at the threshold (deduped).
		if (this.#repeatCount === this.#threshold) {
			return {
				kind: "repeated_tool_call",
				toolName: toolCall.name,
				count: this.#repeatCount,
				resultSummary: summarizeToolResult(turn.toolResults, toolCall.id),
				argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
			};
		}

		// Wandering: if this is a prone tool and the spread has crossed the
		// threshold, emit a wandering detection. On the live path, the spread is
		// already tracked via recordCall; on the standalone path it's 0 (wandering
		// only fires via the live path's recordCall). Check regardless so the
		// standalone path can still surface it if wanderingHashes was populated.
		if (this.#wanderingThreshold > 0 && this.#isProneTool(toolCall.name)) {
			const spread = this.#effectiveSpread(toolCall.name, argsHash);
			if (spread >= this.#wanderingThreshold) {
				return {
					kind: "wandering_tool_call",
					toolName: toolCall.name,
					spread,
					argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
				};
			}
		}

		return null;
	}

	/**
	 * Resets per-turn state. Call at turn start. Wandering hashes PERSIST across
	 * turns (the detector needs to accumulate spread across multiple turns to
	 * reach the threshold — clearing every turn made it dead code). Each per-tool
	 * set is bounded individually in {@link recordCall} (cap = wanderingEscalation
	 * * 2, FIFO eviction) so a single tool can't permanently sit at the escalation
	 * threshold.
	 */
	/**
	 * Checks whether a tool name is prone to wandering. Matches exact entries
	 * (e.g. "web.fetch") and dotted prefixes (e.g. "browser" matches
	 * "browser.scroll", "browser.screenshot") so the documented `browser.*`
	 * coverage works without enumerating every sub-tool.
	 */
	#isProneTool(toolName: string): boolean {
		if (this.#proneTools[toolName]) return true;
		const dot = toolName.indexOf(".");
		if (dot > 0) {
			const prefix = toolName.slice(0, dot);
			return !!this.#proneTools[prefix];
		}
		return false;
	}

	/**
	 * Resets no-progress streak state without touching wandering hashes.
	 * Called when a turn ends abnormally (terminal yield abort, breaker) —
	 * where `recordTurn` won't run to clear the streak. Without this, a
	 * sequence of identical terminal yields across separate prompts would
	 * accumulate a no-progress streak that vetoes the next yield.
	 */
	resetStreaks(): void {
		this.#lastArgsHash = undefined;
		this.#repeatCount = 0;
		this.#lastNoProgressKey = undefined;
		this.#noProgressStreak = 0;
		this.#consecutiveVetoes = 0;
		this.#wanderingVetoes.clear();
		this.#liveTrackingActive = false;
	}

	resetForTurn(): void {
		this.#liveTrackingActive = false;
		// Wandering hashes persist across turns — they ARE cross-turn detectors.
		// Per-tool sets are bounded in recordCall; no global clear needed here.
	}

	#effectiveSpread(toolName: string, prospectiveArgsHash: string): number {
		const set = this.#wanderingHashes.get(toolName);
		if (!set) return 1;
		return set.has(prospectiveArgsHash) ? set.size : set.size + 1;
	}
}
