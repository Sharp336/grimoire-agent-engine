/**
 * Auto-learn session controller (experimental).
 *
 * Owns the whole failure-aware loop for one top-level session:
 *
 *   finalized turn  →  RecoveryTracker  →  threshold hit  →  catalog search
 *                                       →  recall card / soft `read` requirement
 *                                       →  later same-family success
 *                                       →  outcome record OR one private capture
 *
 * Everything except the capture agent itself is deterministic and offline, so a
 * capable local model gets the same behavior as a hosted one.
 *
 * Installed once per top-level session (taskDepth 0). The session event
 * subscription lives for the session's lifetime — `newSession` resets the
 * session in place without re-running startup — while {@link dispose} detaches
 * the seams the controller installed ON the session.
 */
import type { AgentMessage, AgentTurnEndContext, SoftToolRequirement } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import autolearnGuidance from "../prompts/system/autolearn-guidance.md" with { type: "text" };
import autolearnGuidanceLearn from "../prompts/system/autolearn-guidance-learn.md" with { type: "text" };
import autolearnNudgeAutoContinue from "../prompts/system/autolearn-nudge-autocontinue.md" with { type: "text" };
import autolearnRecallReminder from "../prompts/system/autolearn-recall-reminder.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import {
	type AutoLearnCaptureRequest,
	type AutoLearnCaptureResult,
	CAPTURE_REFERENCE_BODY_BUDGET,
	type CaptureMetadataContext,
	type CaptureReferenceProcedure,
	MAX_RECOVERED_FAMILIES_PER_CAPTURE,
	type ManualAutoLearnResult,
	type RecoveredFamily,
} from "./capture-request";
import {
	isSpecificToken,
	MAX_SUGGESTED_PROCEDURES,
	type ProcedureDescriptor,
	type ProcedureDescriptorRow,
	type ProcedureMatch,
	type ProcedureOutcome,
	type ProcedureSearchQuery,
	rankProcedureCandidates,
	tokenizeProcedureText,
} from "./catalog";
import { RecoveryTracker, type ThresholdHit, type ToolFamilyResolver } from "./recovery";

/** The legacy substantive nudge, still used verbatim for `kind: "substantive"`. */
export const AUTOLEARN_SUBSTANTIVE_NUDGE = autolearnNudgeAutoContinue.trim();

const DEFAULT_MIN_TOOL_CALLS = 5;
const DEFAULT_FAILURE_THRESHOLD = 3;

/** Stable soft-requirement id prefix; the suffix keys one episode. */
const PROCEDURAL_REQUIREMENT_PREFIX = "autolearn-procedure";

/** Custom-message type of the soft requirement's hidden reminder. */
const RECALL_REMINDER_MESSAGE_TYPE = "autolearn-recall-reminder";

/** Distinct symptom tokens carried into one catalog query. */
const MAX_QUERY_TOKENS = 32;

/**
 * Clamp `autolearn.substantiveMinToolCalls` to a usable integer.
 *
 * The setting is user-writable from config.yml and the CLI, so `0`, `2.9`,
 * `1e9`, and `NaN` all reach this boundary. `0`/negative would make every stop
 * substantive; a fractional value would compare against an integer counter.
 */
export function normalizeSubstantiveMinToolCalls(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MIN_TOOL_CALLS;
	return Math.max(1, Math.min(100, Math.trunc(value)));
}

/**
 * Clamp `autolearn.failureThreshold` to a usable integer.
 *
 * A threshold below 2 would treat a single transient failure as an episode; a
 * very large one would keep evidence alive long past its usefulness.
 */
export function normalizeFailureThreshold(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FAILURE_THRESHOLD;
	return Math.max(2, Math.min(10, Math.trunc(value)));
}

/**
 * Build the standing auto-learn guidance for the system prompt from the tools
 * actually present in the active set, or null when `manage_skill` is absent.
 *
 * Driven by tool presence rather than live settings: the `learn`/`manage_skill`
 * registry is built ONCE at session start (and only for top-level sessions), so
 * keying the guidance on `autolearn.enabled` would let a mid-session enable — or
 * a subagent that filtered the tools out — inject guidance pointing at tools the
 * session never built. The `learn` addendum is included only when the `learn`
 * tool is present (it requires a memory backend).
 */
export function buildAutoLearnInstructions(available: { manageSkill: boolean; learn: boolean }): string | null {
	if (!available.manageSkill) return null;
	const parts = [autolearnGuidance.trim()];
	if (available.learn) parts.push(autolearnGuidanceLearn.trim());
	return parts.join("\n\n");
}

/** Lookup + outcome surface the controller needs from the descriptor cache. */
export interface ProcedureCatalog {
	search(query: ProcedureSearchQuery): { rows: ProcedureDescriptorRow[]; lexicalRank: Map<string, number> };
	recordOutcome(name: string, outcome: ProcedureOutcome): void;
	/** Full SKILL.md body for a matched procedure, or null when unreadable. */
	readBody(name: string): Promise<string | null>;
}

export interface AutoLearnControllerOptions {
	session: AgentSession;
	settings: Settings;
	/** Runs one isolated capture request; resolves with what was actually stored. */
	capture: (request: AutoLearnCaptureRequest) => Promise<AutoLearnCaptureResult>;
	/** Descriptor catalog. Absent (e.g. storage unavailable) disables recall, not capture. */
	catalog?: ProcedureCatalog;
	/** MCP ownership lookup over the ACTIVE tool set. */
	resolveToolFamily: ToolFamilyResolver;
	/** Whether `read` is in the active tool set; a restricted session must not be widened. */
	hasReadTool: () => boolean;
	/** Current project identity for scoping and ranking affinity. */
	projectIdentity: () => { key: string; label: string };
	/** Selects the bounded `/learn` window from the live branch. */
	selectManualWindow: (turns: number) => readonly AgentMessage[];
}

/** State for the single in-flight require-mode recall episode. */
interface RecallState {
	family: string;
	/** Procedure whose body the model was asked to read. */
	name: string;
	/** Whether the targeted `read` has been observed (successful or failed). */
	read: boolean;
}

/** Concatenated text content of one message, for token extraction. */
function messageText(message: AgentMessage | undefined): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (!("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * The `skill://<name>` path a tool call must target, lowercased for comparison.
 *
 * A `read` may legitimately carry a selector suffix (`skill://name/file:1-20`),
 * so the check is a prefix match on the exact procedure host rather than string
 * equality — but it must never accept `skill://name-other`.
 */
function readsProcedureBody(toolCall: { name: string; arguments?: Record<string, unknown> }, name: string): boolean {
	if (toolCall.name !== "read") return false;
	const requested = toolCall.arguments?.path;
	if (typeof requested !== "string") return false;
	const normalized = requested.trim().toLowerCase();
	const target = `skill://${name.toLowerCase()}`;
	if (normalized === target) return true;
	// Only a path/selector separator may follow the name; anything else is a
	// different procedure whose name merely starts with this one.
	const next = normalized.startsWith(target) ? normalized.charAt(target.length) : "";
	return next === "/" || next === ":";
}

export class AutoLearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #capture: (request: AutoLearnCaptureRequest) => Promise<AutoLearnCaptureResult>;
	readonly #catalog: ProcedureCatalog | undefined;
	readonly #hasReadTool: () => boolean;
	readonly #projectIdentity: () => { key: string; label: string };
	readonly #selectManualWindow: (turns: number) => readonly AgentMessage[];
	readonly #tracker: RecoveryTracker;
	readonly #unsubscribeTurnEnd: () => void;

	#toolCalls = 0;
	/**
	 * Whether the in-flight turn BEGAN while goal mode was active. Captured at
	 * agent_start because a `goal` tool can complete or drop the goal mid-turn,
	 * clearing the live flag before agent_end — so the end-of-turn state alone
	 * would let a goal-continuation turn slip through and get nudged.
	 */
	#turnStartedInGoalMode = false;
	/** Prevent overlapping private capture runs while real primary turns continue. */
	#captureInFlight = false;
	/** Newest pending automatic capture; a recovery request replaces a substantive one. */
	#pendingCapture: AutoLearnCaptureRequest | undefined;
	/** At most one queued explicit `/learn`, kept separate so it is never coalesced away. */
	#pendingManual: { request: AutoLearnCaptureRequest; resolve: (result: ManualAutoLearnResult) => void } | undefined;
	/** The single armed require-mode recall episode, if any. */
	#recall: RecallState | undefined;
	/** Families whose recalled procedure was read and which then recovered. */
	readonly #recoveredAfterRead = new Set<string>();
	/** Recovered families awaiting the terminal capture decision. */
	#pendingRecoveries: RecoveredFamily[] = [];
	/** Episode counter, so each requirement gets a distinct stable id. */
	#episode = 0;
	#disposed = false;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#capture = options.capture;
		this.#catalog = options.catalog;
		this.#hasReadTool = options.hasReadTool;
		this.#projectIdentity = options.projectIdentity;
		this.#selectManualWindow = options.selectManualWindow;
		this.#tracker = new RecoveryTracker({
			resolveFamily: options.resolveToolFamily,
			threshold: normalizeFailureThreshold(this.#settings.get("autolearn.failureThreshold")),
		});
		// The listener closure captures `this`, so the session's listener array
		// keeps the controller alive — no stored unsubscribe needed for events.
		this.#session.subscribe(event => this.#onEvent(event));
		// The agent loop awaits this hook BEFORE polling asides, which is what lets
		// a recall card reach the current run's next provider turn.
		this.#unsubscribeTurnEnd = this.#session.registerTurnEndHook(context => this.#onTurnEnd(context));
		this.#session.setManualAutoLearnHandler(request => this.#runManualCapture(request));
	}

	/** Detach session-owned installations. Safe to call twice. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeTurnEnd();
		this.#session.setManualAutoLearnHandler(undefined);
		this.#clearRecall();
		this.#tracker.clear();
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			// Capture goal-mode state at the turn boundary, before any tool runs.
			this.#turnStartedInGoalMode = this.#session.getGoalModeState()?.enabled === true;
			return;
		}
		if (event.type === "tool_execution_end") {
			this.#toolCalls++;
			return;
		}
		if (event.type === "agent_end") {
			this.#onAgentEnd(event);
		}
	}

	/**
	 * Fold one finalized turn into episode state and, at the first threshold hit,
	 * arm recall.
	 *
	 * Runs inside the agent loop's awaited turn-end hook. The session's fan-out
	 * isolates throws, but keep this defensive: it is on the primary run's path.
	 */
	async #onTurnEnd(context: AgentTurnEndContext): Promise<void> {
		if (this.#disposed || !this.#settings.get("autolearn.enabled")) return;
		this.#tracker.setThreshold(normalizeFailureThreshold(this.#settings.get("autolearn.failureThreshold")));

		const observation = this.#tracker.observeTurn(context);
		// Order matters: a turn may both read the procedure and recover, and the
		// recovery below must see the read that happened in the same turn.
		this.#observeTargetedRead(context);

		for (const family of observation.recoveredFamilies) {
			if (this.#recall?.family !== family) continue;
			// Attribution is unknowable — the model may have fixed it on its own —
			// so the conservative persisted update is the procedure's success record,
			// and no new procedure is minted for this family.
			if (this.#recall.read) {
				this.#catalog?.recordOutcome(this.#recall.name, "success");
				this.#recoveredAfterRead.add(family);
			}
			this.#clearRecall();
		}

		for (const recovery of observation.recoveries) {
			if (this.#recoveredAfterRead.has(recovery.family)) continue;
			if (this.#pendingRecoveries.some(pending => pending.family === recovery.family)) continue;
			this.#pendingRecoveries.push(recovery);
		}

		if (observation.thresholdHits.length > 0) this.#armRecall(observation.thresholdHits);
	}

	/**
	 * Note whether the model actually opened the required body.
	 *
	 * Both success and failure close the requirement: a failed read means the
	 * procedure file is gone or unreadable, and re-forcing it would loop.
	 */
	#observeTargetedRead(context: AgentTurnEndContext): void {
		const recall = this.#recall;
		if (!recall || recall.read) return;
		if (context.message.role !== "assistant") return;
		for (const part of context.message.content) {
			if (part.type !== "toolCall") continue;
			if (!readsProcedureBody(part, recall.name)) continue;
			recall.read = true;
			// Satisfied: drop the requirement so a later turn is not steered again.
			this.#session.setProceduralMemoryRequirement(undefined);
			return;
		}
	}

	/**
	 * Search the catalog for the newest threshold hit and deliver at most one
	 * recall for the episode.
	 */
	#armRecall(hits: readonly ThresholdHit[]): void {
		const catalog = this.#catalog;
		const mode = this.#settings.get("autolearn.recallMode");
		if (mode === "off" || !catalog) return;
		// One armed require-mode episode at a time: a second requirement would
		// compete with the first reminder and make the soft contract ambiguous.
		if (mode === "require" && this.#recall) return;
		if (this.#session.getPlanModeState()?.enabled || this.#session.getGoalModeState()?.enabled) return;
		// Never widen a restricted session, and never emit a card whose only action
		// the model cannot perform. Lookup is simply unavailable for this episode;
		// a later recovery still reaches the normal capture path.
		if (!this.#hasReadTool()) return;

		const hit = hits[hits.length - 1];
		if (!hit) return;

		const matches = this.#searchForHit(catalog, hit);
		const cards = matches.slice(0, mode === "require" ? 1 : MAX_SUGGESTED_PROCEDURES).map(match => ({
			name: match.descriptor.name,
			description: match.descriptor.description,
		}));
		const top = cards[0];
		if (!top) return;

		this.#episode++;
		this.#session.enqueueAutolearnRecall({
			family: hit.family,
			failureCount: hit.failureCount,
			cards,
			requiredName: mode === "require" ? top.name : undefined,
		});
		if (mode !== "require") return;

		this.#recall = { family: hit.family, name: top.name, read: false };
		this.#session.setProceduralMemoryRequirement(
			this.#buildRequirement(`${PROCEDURAL_REQUIREMENT_PREFIX}:${this.#episode}`, top.name, hit.family),
		);
	}

	/**
	 * One soft `read` requirement targeting exactly one `skill://` path.
	 *
	 * `satisfies` accepts only that exact procedure: a `read` of anything else is
	 * a detour, and the agent loop escalates to a forced `read` after one normal
	 * chance to comply — so a compliant turn pays no `tool_choice` change and no
	 * prompt-cache invalidation.
	 */
	#buildRequirement(requirementId: string, name: string, family: string): SoftToolRequirement {
		return {
			soft: true,
			id: requirementId,
			toolName: "read",
			satisfies: toolCall => readsProcedureBody(toolCall, name),
			reminder: [
				{
					role: "custom",
					customType: RECALL_REMINDER_MESSAGE_TYPE,
					content: prompt.render(autolearnRecallReminder, { name, family, target: `skill://${name}` }),
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				},
			],
		};
	}

	/** Build and run the deterministic catalog query for one threshold hit. */
	#searchForHit(catalog: ProcedureCatalog, hit: ThresholdHit): ProcedureMatch[] {
		const identity = this.#projectIdentity();
		const tokens = new Set<string>();
		for (const evidence of hit.evidence) {
			for (const token of tokenizeProcedureText(evidence.resultSummary)) {
				if (!isSpecificToken(token)) continue;
				tokens.add(token);
				if (tokens.size >= MAX_QUERY_TOKENS) break;
			}
			if (tokens.size >= MAX_QUERY_TOKENS) break;
		}
		// Tool intent: the family itself is a searchable term, so `mcp:playwright`
		// contributes both `mcp` and `playwright`.
		for (const token of tokenizeProcedureText(hit.family)) tokens.add(token);
		const query: ProcedureSearchQuery = {
			toolFamily: hit.family,
			platform: hit.platform,
			projectKey: identity.key,
			tokens: [...tokens],
		};
		const { rows, lexicalRank } = catalog.search(query);
		return rankProcedureCandidates(rows, query, lexicalRank);
	}

	#clearRecall(): void {
		this.#recall = undefined;
		this.#session.setProceduralMemoryRequirement(undefined);
		this.#session.invalidateAutolearnRecall();
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// Snapshot and reset every turn: the counter describes only the
		// just-finished turn, so below-threshold, disabled, and plan-mode stops
		// must not let tool calls accumulate into a later turn.
		const toolCalls = this.#toolCalls;
		this.#toolCalls = 0;
		// Snapshot the turn-start goal flag alongside the counter so a turn that
		// observed no agent_start can never inherit a stale value.
		const startedInGoalMode = this.#turnStartedInGoalMode;
		this.#turnStartedInGoalMode = false;

		// A non-terminal end means an async delivery will resume this run, so
		// episode state must survive for a recovery after the continuation.
		const isTerminal = event.isTerminal !== false;

		// Never capture from a turn that ended in an abort (ESC, cancel, etc.). The
		// abort flag on the session is unreliable by the time agent_end is
		// deferred to subscribers; read stopReason from the event messages.
		let aborted = false;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				aborted = "stopReason" in message && message.stopReason === "aborted";
				break;
			}
		}

		if (isTerminal) {
			// A true terminal boundary ends every unfinished episode: keeping them
			// would let tomorrow's unrelated failure inherit today's count.
			this.#tracker.clear();
			// A body that was read whose family never recovered is a miss — recorded
			// only here, so a still-running episode is not prematurely penalised, and
			// never on an abort, which proves nothing about the procedure.
			if (this.#recall?.read && !aborted) this.#catalog?.recordOutcome(this.#recall.name, "miss");
			this.#clearRecall();
			this.#recoveredAfterRead.clear();
		}

		if (aborted) {
			this.#pendingRecoveries = [];
			return;
		}
		if (!isTerminal) return;

		const recoveries = this.#pendingRecoveries;
		this.#pendingRecoveries = [];

		// Honor a live opt-out: the subscription outlives the setting, so re-check
		// the current flag rather than trusting install-time state.
		if (!this.#settings.get("autolearn.enabled")) return;
		// Never interrupt plan-mode review.
		if (this.#session.getPlanModeState()?.enabled) return;
		// Never divert a goal loop. Skip when the turn STARTED in goal mode — a
		// `goal` tool may have completed/dropped the goal before this stop — or is
		// still in it: an automatic capture would compete with the continuation.
		if (startedInGoalMode || this.#session.getGoalModeState()?.enabled) return;
		// `manual` delivery records no deferred hidden nudge and schedules no
		// automatic capture; the standing system guidance plus `/learn` remain.
		if (this.#settings.get("autolearn.captureDelivery") !== "automatic") return;

		const request = this.#chooseCapture(recoveries, toolCalls);
		if (request) this.#scheduleCapture(request);
	}

	/**
	 * Pick at most ONE capture action for this terminal stop.
	 *
	 * Recovery capture takes precedence: it is evidence-backed and transcript-free.
	 * Substantive capture is the fallback, and only when its mode is enabled and
	 * the turn actually did enough work.
	 */
	#chooseCapture(recoveries: readonly RecoveredFamily[], toolCalls: number): AutoLearnCaptureRequest | undefined {
		const mode = this.#settings.get("autolearn.captureMode");
		if (mode === "off") return undefined;
		if ((mode === "recovery" || mode === "both") && recoveries.length > 0) {
			const families = recoveries.slice(0, MAX_RECOVERED_FAMILIES_PER_CAPTURE);
			return { kind: "recovery", families, references: [], metadata: this.#buildMetadata(families) };
		}
		if (mode !== "substantive" && mode !== "both") return undefined;
		const minToolCalls = normalizeSubstantiveMinToolCalls(this.#settings.get("autolearn.substantiveMinToolCalls"));
		if (toolCalls < minToolCalls) return undefined;
		return { kind: "substantive" };
	}

	/** Trusted catalog metadata the capture agent cannot omit or forge. */
	#buildMetadata(recoveries: readonly RecoveredFamily[], focus?: string): CaptureMetadataContext {
		const identity = this.#projectIdentity();
		const scope = this.#settings.get("autolearn.procedureScope");
		const tagged = scope === "project-tagged";
		const triggers = new Set<string>();
		for (const recovery of recoveries) {
			for (const evidence of recovery.evidence) {
				for (const token of tokenizeProcedureText(evidence.resultSummary)) {
					if (isSpecificToken(token)) triggers.add(token);
				}
			}
		}
		if (focus) {
			for (const token of tokenizeProcedureText(focus)) {
				if (isSpecificToken(token)) triggers.add(token);
			}
		}
		return {
			scope,
			projectKey: tagged ? identity.key : undefined,
			projectLabel: tagged ? identity.label : undefined,
			toolFamilies: recoveries.map(recovery => recovery.family),
			platforms: [process.platform],
			triggers: [...triggers],
		};
	}

	/**
	 * Merge a new automatic request into the pending slot and start the runner.
	 *
	 * Only ONE private capture runs at a time; a newer recovery request replaces a
	 * pending substantive one, and duplicate families collapse.
	 */
	#scheduleCapture(request: AutoLearnCaptureRequest): void {
		this.#pendingCapture = mergeCaptureRequests(this.#pendingCapture, request);
		void this.#drainCaptures();
	}

	/**
	 * Run queued captures one at a time until both slots are empty.
	 *
	 * Manual requests are serialized behind an in-flight automatic capture but
	 * never coalesced into one: the user asked about a specific window and needs a
	 * specific answer about it.
	 */
	async #drainCaptures(): Promise<void> {
		if (this.#captureInFlight) return;
		this.#captureInFlight = true;
		try {
			while (this.#pendingManual || this.#pendingCapture) {
				const manual = this.#pendingManual;
				if (manual) {
					this.#pendingManual = undefined;
					manual.resolve(await this.#runOneManual(manual.request));
					continue;
				}
				const request = this.#pendingCapture;
				this.#pendingCapture = undefined;
				if (!request) continue;
				try {
					await this.#capture(request);
				} catch (error) {
					logger.warn("auto-learn capture failed", { kind: request.kind, error: String(error) });
				}
			}
		} finally {
			this.#captureInFlight = false;
		}
	}

	/** Run one manual capture and translate it into an operator-facing result. */
	async #runOneManual(request: AutoLearnCaptureRequest): Promise<ManualAutoLearnResult> {
		try {
			const captured = await this.#capture(request);
			if (captured.stored.length > 0) return { ok: true, stored: captured.stored };
			// Never claim a memory was stored: surface the concrete capture or
			// approval error, or say plainly that the agent wrote nothing.
			return { ok: false, error: captured.error ?? "The capture agent stored nothing." };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** `/learn` entry point installed on the session. */
	async #runManualCapture(request: { turns: number; focus?: string }): Promise<ManualAutoLearnResult> {
		if (this.#disposed || !this.#settings.get("autolearn.enabled")) {
			return {
				ok: false,
				error: "Auto-Learn is disabled for this session. Enable autolearn.enabled and start a new session.",
			};
		}
		if (this.#pendingManual) return { ok: false, error: "A manual Auto-Learn capture is already queued." };
		const messages = this.#selectManualWindow(request.turns);
		if (messages.length === 0) return { ok: false, error: "Nothing to learn from the current session." };

		const captureRequest: AutoLearnCaptureRequest = {
			kind: "manual",
			messages,
			focus: request.focus,
			turns: request.turns,
			references: await this.#collectManualReferences(request.focus, messages),
			metadata: this.#buildMetadata([], request.focus),
		};
		const settled = Promise.withResolvers<ManualAutoLearnResult>();
		this.#pendingManual = { request: captureRequest, resolve: settled.resolve };
		void this.#drainCaptures();
		return settled.promise;
	}

	/**
	 * Existing procedures close enough to the requested window that the capture
	 * agent should improve one instead of minting a duplicate.
	 */
	async #collectManualReferences(
		focus: string | undefined,
		messages: readonly AgentMessage[],
	): Promise<CaptureReferenceProcedure[]> {
		const catalog = this.#catalog;
		if (!catalog) return [];
		const identity = this.#projectIdentity();
		const tokens = new Set<string>();
		if (focus) {
			for (const token of tokenizeProcedureText(focus)) {
				if (isSpecificToken(token)) tokens.add(token);
			}
		}
		// Newest-first so a long window's oldest filler cannot crowd out the terms
		// that actually describe what the user just did.
		for (let i = messages.length - 1; i >= 0 && tokens.size < MAX_QUERY_TOKENS; i--) {
			for (const token of tokenizeProcedureText(messageText(messages[i]))) {
				if (!isSpecificToken(token)) continue;
				tokens.add(token);
				if (tokens.size >= MAX_QUERY_TOKENS) break;
			}
		}
		if (tokens.size === 0) return [];
		const query: ProcedureSearchQuery = {
			platform: process.platform,
			projectKey: identity.key,
			tokens: [...tokens],
		};
		const { rows, lexicalRank } = catalog.search(query);
		const matches = rankProcedureCandidates(rows, query, lexicalRank).slice(0, MAX_SUGGESTED_PROCEDURES);
		return await loadReferenceBodies(
			catalog,
			matches.map(match => match.descriptor),
		);
	}
}

/**
 * Load reference bodies under the shared byte budget.
 *
 * The budget is shared across all references so three long procedures cannot
 * balloon the private capture prompt; procedures load best-first and the first
 * one that would overflow ends the list.
 */
async function loadReferenceBodies(
	catalog: ProcedureCatalog,
	descriptors: readonly ProcedureDescriptor[],
): Promise<CaptureReferenceProcedure[]> {
	const references: CaptureReferenceProcedure[] = [];
	let remaining = CAPTURE_REFERENCE_BODY_BUDGET;
	for (const descriptor of descriptors) {
		if (remaining <= 0) break;
		const body = await catalog.readBody(descriptor.name);
		if (!body) continue;
		const bytes = Buffer.byteLength(body, "utf8");
		if (bytes > remaining) break;
		remaining -= bytes;
		references.push({ name: descriptor.name, description: descriptor.description, body });
	}
	return references;
}

/**
 * Collapse two automatic capture requests into one.
 *
 * A recovery request always wins over a substantive one: it is evidence-backed,
 * cheaper, and does not copy the transcript. Two recovery requests merge their
 * families, deduplicated and capped.
 */
function mergeCaptureRequests(
	pending: AutoLearnCaptureRequest | undefined,
	incoming: AutoLearnCaptureRequest,
): AutoLearnCaptureRequest {
	if (!pending) return incoming;
	if (pending.kind === "recovery" && incoming.kind === "recovery") {
		const families = [...pending.families];
		for (const family of incoming.families) {
			if (families.some(existing => existing.family === family.family)) continue;
			families.push(family);
		}
		return {
			kind: "recovery",
			families: families.slice(0, MAX_RECOVERED_FAMILIES_PER_CAPTURE),
			references: incoming.references.length > 0 ? incoming.references : pending.references,
			metadata: incoming.metadata,
		};
	}
	if (incoming.kind === "recovery") return incoming;
	if (pending.kind === "recovery") return pending;
	return incoming;
}
