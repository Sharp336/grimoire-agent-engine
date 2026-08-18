/**
 * Bounded failure-episode tracking for Auto-Learn.
 *
 * Reads only FINALIZED turn data (`AgentTurnEndContext`) and keeps a small,
 * session-local view of "which tool family keeps failing, and did it later
 * succeed". Nothing here talks to a model, a provider, or the network.
 *
 * Three properties matter more than completeness:
 *
 *  1. **Only genuine tool-contract failures count.** Policy denial, user
 *     cancellation, interrupted execution, and aborted/errored assistant stops
 *     are host or user decisions — learning from them would mint procedures
 *     about OMP's own refusals. They are excluded STRUCTURALLY via
 *     `details.__synthetic` / `details.__interrupted`, never by matching error
 *     text.
 *  2. **Families are independent.** A successful `read` between two failing
 *     `bash` calls must not reset the `bash` episode; that interleaving is the
 *     normal shape of a debugging loop.
 *  3. **Evidence stays small and redacted.** At most the latest three failures
 *     per family, each capped, secret-redacted, and never appended to the
 *     primary conversation.
 */
import type { AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { canonicalizeToolCallValue } from "@oh-my-pi/pi-ai";
import { redactSecrets } from "../utils/redact";
import type { RecoveredFamily, RecoveryEvidence } from "./capture-request";

/** Detailed evidence retained per family; older failures are dropped. */
const MAX_EVIDENCE_PER_FAMILY = 3;

/** Eligible results from OTHER families before an unfinished episode expires. */
const FAMILY_EXPIRY_GAP = 8;

/** Cap on canonicalized arguments retained as evidence. */
const ARGUMENTS_SUMMARY_LIMIT = 1_200;

/** Cap on a text-result summary retained as evidence. */
const RESULT_SUMMARY_LIMIT = 400;

/**
 * Control-plane tools excluded from failure accounting.
 *
 * These do not describe a procedure that can be learned: `ask`/`yield` are
 * conversation control, `goal`/`todo` are bookkeeping, and `learn`/`manage_skill`
 * are Auto-Learn's own writers (counting their failures would let the feature
 * observe itself).
 */
const CONTROL_TOOLS: Record<string, true> = {
	ask: true,
	goal: true,
	learn: true,
	manage_skill: true,
	todo: true,
	yield: true,
};

/**
 * `write` targets that resolve a pending preview rather than write a file.
 *
 * A failed `xd://resolve` is a protocol mismatch in OMP's own preview handshake,
 * not a procedure worth recording.
 */
const PREVIEW_RESOLUTION_PATHS: Record<string, true> = {
	"xd://propose": true,
	"xd://reject": true,
	"xd://resolve": true,
};

/**
 * Resolves the raw MCP server name owning `toolName`, or undefined for a native
 * tool. Read from the ACTIVE tool object's `mcpServerName` — never by parsing an
 * `mcp__…` name, which is lossy for servers whose names contain the separator.
 */
export type ToolFamilyResolver = (toolName: string) => string | undefined;

/** Per-family episode state. */
interface FamilyEpisode {
	family: string;
	/** Eligible same-family failures observed since the last reset. */
	failureCount: number;
	/** Latest failures, oldest first, capped at {@link MAX_EVIDENCE_PER_FAMILY}. */
	evidence: RecoveryEvidence[];
	/** Eligible results from other families since this family last appeared. */
	idleResults: number;
	/** Whether the threshold hit has already been reported (recall fires once per episode). */
	thresholdReported: boolean;
}

/** A family that reached the threshold for the first time in this turn. */
export interface ThresholdHit {
	family: string;
	failureCount: number;
	platform: string;
	/** Latest failures for the family, oldest first. */
	evidence: RecoveryEvidence[];
}

/** What one finalized turn produced. */
export interface TurnObservation {
	/** Families that crossed the threshold for the first time. */
	thresholdHits: ThresholdHit[];
	/** Families that were at or above the threshold and then returned a non-error result. */
	recoveries: RecoveredFamily[];
	/** Eligible non-error results, keyed by family — used to close a recalled requirement. */
	recoveredFamilies: Set<string>;
}

/** Collapse whitespace and cap length, matching the loop guard's summary style. */
function summarize(text: string, limit: number): string {
	const collapsed = redactSecrets(text).replace(/\s+/g, " ").trim();
	return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** Concatenated text blocks of a tool result. */
function resultText(result: ToolResultMessage): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * Whether a tool result may advance a failure episode.
 *
 * Excludes every host-synthesized or interrupted result. `__synthetic` covers
 * aborted/errored/skipped assistant stops and (after the agent-loop change)
 * host-blocked execution — approval denial and user cancellation included.
 * `__interrupted` covers a call that started and was cut off.
 */
function isEligibleResult(result: ToolResultMessage, args: unknown): boolean {
	const details = result.details;
	if (details && typeof details === "object") {
		const record = details as Record<string, unknown>;
		if (record.__synthetic === true || record.__interrupted === true) return false;
	}
	if (CONTROL_TOOLS[result.toolName] === true) return false;
	if (result.toolName === "write" && isPreviewResolutionArgs(args)) return false;
	return true;
}

/** Whether a `write` call targets the preview-resolution device rather than a file. */
function isPreviewResolutionArgs(args: unknown): boolean {
	if (!args || typeof args !== "object") return false;
	const target = (args as Record<string, unknown>).path;
	if (typeof target !== "string") return false;
	const normalized = target.trim().toLowerCase().replace(/\/+$/, "");
	return PREVIEW_RESOLUTION_PATHS[normalized] === true;
}

/**
 * Whether the assistant turn completed normally.
 *
 * An aborted or errored stop means the tool results are a mix of real and
 * synthesized outcomes produced under teardown; nothing in such a turn is
 * evidence about a tool's contract.
 */
function isNormalAssistantTurn(message: AgentTurnEndContext["message"]): boolean {
	if (message.role !== "assistant") return false;
	const stopReason = (message as AssistantMessage).stopReason;
	return stopReason !== "aborted" && stopReason !== "error";
}

/**
 * Session-local failure-episode tracker.
 *
 * One instance per top-level session. `observeTurn` is the only entry point that
 * mutates state; everything else is a read or an explicit lifecycle reset.
 */
export class RecoveryTracker {
	readonly #resolveFamily: ToolFamilyResolver;
	readonly #platform: string;
	#threshold: number;
	readonly #families = new Map<string, FamilyEpisode>();

	constructor(options: { resolveFamily: ToolFamilyResolver; threshold: number; platform?: string }) {
		this.#resolveFamily = options.resolveFamily;
		this.#threshold = options.threshold;
		this.#platform = options.platform ?? process.platform;
	}

	/**
	 * Apply the live threshold. Read lazily from settings each turn so a
	 * mid-session change takes effect without restarting the session.
	 */
	setThreshold(threshold: number): void {
		this.#threshold = threshold;
	}

	/** Whether any family currently holds unfinished episode state. */
	get hasOpenEpisodes(): boolean {
		return this.#families.size > 0;
	}

	/** Failure count currently recorded for `family`, or 0. */
	failureCount(family: string): number {
		return this.#families.get(family)?.failureCount ?? 0;
	}

	/** Drop all episode state. Called at a true terminal `agent_end`. */
	clear(): void {
		this.#families.clear();
	}

	/**
	 * Fold one finalized turn into the episode state.
	 *
	 * Returns the threshold hits and recoveries this turn produced. The caller
	 * decides what to do with them; the tracker never schedules anything.
	 */
	observeTurn(context: AgentTurnEndContext): TurnObservation {
		const observation: TurnObservation = { thresholdHits: [], recoveries: [], recoveredFamilies: new Set() };
		if (!isNormalAssistantTurn(context.message)) return observation;

		const callsById = new Map<string, ToolCall>();
		for (const part of (context.message as AssistantMessage).content) {
			if (part.type === "toolCall") callsById.set(part.id, part);
		}

		// Per-family eligible-result counts for this turn. Expiry is measured in
		// OTHER families' eligible results, so a family that keeps appearing never
		// ages out while an abandoned one does.
		const perFamily = new Map<string, number>();
		let eligibleTotal = 0;

		for (const result of context.toolResults) {
			const call = callsById.get(result.toolCallId);
			if (!isEligibleResult(result, call?.arguments)) continue;

			const server = this.#resolveFamily(result.toolName);
			const family = server ? `mcp:${server}` : result.toolName;
			perFamily.set(family, (perFamily.get(family) ?? 0) + 1);
			eligibleTotal++;

			if (result.isError === true) {
				this.#recordFailure(family, result, call, observation);
				continue;
			}
			this.#recordSuccess(family, result, observation);
		}

		this.#ageFamilies(perFamily, eligibleTotal);
		return observation;
	}

	#recordFailure(
		family: string,
		result: ToolResultMessage,
		call: ToolCall | undefined,
		observation: TurnObservation,
	): void {
		let episode = this.#families.get(family);
		if (!episode) {
			episode = { family, failureCount: 0, evidence: [], idleResults: 0, thresholdReported: false };
			this.#families.set(family, episode);
		}
		episode.idleResults = 0;
		// Cap the counter at the threshold: the episode only needs to know it is
		// armed, and an unbounded count would keep growing through a long loop.
		if (episode.failureCount < this.#threshold) episode.failureCount++;
		episode.evidence.push({
			family,
			toolName: result.toolName,
			argumentsSummary: summarize(
				JSON.stringify(canonicalizeToolCallValue(call?.arguments ?? {})),
				ARGUMENTS_SUMMARY_LIMIT,
			),
			resultSummary: summarize(resultText(result), RESULT_SUMMARY_LIMIT),
		});
		if (episode.evidence.length > MAX_EVIDENCE_PER_FAMILY) episode.evidence.shift();

		if (episode.failureCount >= this.#threshold && !episode.thresholdReported) {
			episode.thresholdReported = true;
			observation.thresholdHits.push({
				family,
				failureCount: episode.failureCount,
				platform: this.#platform,
				evidence: [...episode.evidence],
			});
		}
	}

	#recordSuccess(family: string, result: ToolResultMessage, observation: TurnObservation): void {
		const episode = this.#families.get(family);
		if (!episode) return;
		observation.recoveredFamilies.add(family);
		if (episode.failureCount >= this.#threshold) {
			observation.recoveries.push({
				family,
				platform: this.#platform,
				failureCount: episode.failureCount,
				evidence: [...episode.evidence],
				recoveredToolName: result.toolName,
				recoverySummary: summarize(resultText(result), RESULT_SUMMARY_LIMIT),
			});
		}
		// Below threshold this was a transient hiccup, at or above it the episode
		// is now resolved: either way the family starts clean.
		this.#families.delete(family);
	}

	/**
	 * Expire families that have gone quiet.
	 *
	 * Without this, two failures early in a long session would still be sitting
	 * in state when an unrelated third failure arrived an hour later and would
	 * fabricate an "episode" out of coincidence. A family's own results reset the
	 * gap; every other eligible result advances it.
	 */
	#ageFamilies(perFamily: ReadonlyMap<string, number>, eligibleTotal: number): void {
		if (eligibleTotal === 0) return;
		for (const [family, episode] of this.#families) {
			const own = perFamily.get(family) ?? 0;
			if (own > 0) continue;
			episode.idleResults += eligibleTotal;
			if (episode.idleResults >= FAMILY_EXPIRY_GAP) this.#families.delete(family);
		}
	}
}
