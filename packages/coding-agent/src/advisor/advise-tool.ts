import { type } from "@oh-my-pi/omptype";
import type {
	AgentIdentity,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText } from "@oh-my-pi/pi-utils";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };

const adviseSchema = type({
	note: type("string").describe(
		"One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	),
	"severity?": type("'nit' | 'concern' | 'blocker'").describe("How strongly to weigh this. Omit for a plain nit."),
});

export type AdviseParams = typeof adviseSchema.infer;

export type AdvisorSeverity = "nit" | "concern" | "blocker";
export type AdvisorSteerLevel = "concern" | "blocker";

export interface AdviseDetails {
	note: string;
	severity?: AdvisorSeverity;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/** One queued advice note. */
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/** Details payload on the batched `advisor` custom message rendered in the transcript. */
export interface AdvisorMessageDetails {
	notes: AdvisorNote[];
}

/**
 * Behavioral framing for the watched agent — advice, not orders. Carried as a
 * tag attribute (rather than a prose header) so the rendered agent-facing output
 * stays a clean `<advisory>` block. The primary agent's system prompt never
 * mentions advisories, so this is its only cue for how to treat them.
 */
const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

/**
 * Render a batch of advisor notes as the agent-facing message body: one
 * `<advisory>` element per note, severity as an attribute. Shared by the
 * non-interrupting YieldQueue dispatcher and the interrupting steer path so both
 * build byte-identical content.
 */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
	return notes
		.map(n => {
			const severity = n.severity ? ` severity="${n.severity}"` : "";
			const who = n.advisor ? ` advisor="${escapeXmlAttribute(n.advisor)}"` : "";
			return `<advisory${who}${severity} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
		})
		.join("\n");
}

/** Rank advisor severities so threshold and dedupe comparisons share one order. */
const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };

function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
	return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}

/** Whether advice meets the configured minimum severity for primary-agent steering. */
export function shouldSteerAdvisorSeverity(
	severity: AdvisorSeverity | undefined,
	steerLevel: AdvisorSteerLevel,
): boolean {
	return advisorSeverityRank(severity) >= ADVISOR_SEVERITY_RANK[steerLevel];
}

/** How an advisor note is routed to the primary. */
export type AdvisorDeliveryChannel = "aside" | "steer" | "preserve";
/** Half-open turn-count fence for the post-interrupt cooldown. */
export function isAdvisorInterruptImmuneTurnActive(opts: {
	completedTurns: number;
	immuneTurnStart: number | undefined;
	immuneTurns: number;
}): boolean {
	if (opts.immuneTurnStart === undefined || opts.immuneTurns <= 0) return false;
	return opts.completedTurns < opts.immuneTurnStart + opts.immuneTurns;
}

/**
 * Decide how one advisor note reaches the primary agent.
 *
 * `steerLevel` is the minimum severity that must interrupt a live primary turn
 * or trigger an idle one. A late concern below that threshold remains visible
 * without waking a primary that already returned a terminal answer. Safety
 * constraints still win: headless preservation, deliberate user interrupts,
 * and the post-interrupt immune-turn window can prevent an automatic turn.
 */
export function resolveAdvisorDeliveryChannel(opts: {
	severity: AdvisorSeverity | undefined;
	steerLevel: AdvisorSteerLevel;
	autoResumeSuppressed: boolean;
	streaming: boolean;
	aborting: boolean;
	terminalAnswerNoQueuedWork?: boolean;
	interruptImmuneTurnActive?: boolean;
	preserveOnly?: boolean;
}): AdvisorDeliveryChannel {
	if (opts.preserveOnly && !opts.streaming) return "preserve";
	const shouldSteer = shouldSteerAdvisorSeverity(opts.severity, opts.steerLevel);
	if (
		opts.autoResumeSuppressed &&
		(opts.aborting || !opts.streaming) &&
		(shouldSteer || opts.severity === "concern")
	) {
		return "preserve";
	}
	if (
		opts.terminalAnswerNoQueuedWork &&
		opts.severity === "concern" &&
		!shouldSteer &&
		!opts.streaming &&
		!opts.aborting
	) {
		return "preserve";
	}
	if (!shouldSteer) return "aside";
	if (opts.interruptImmuneTurnActive && opts.severity !== "blocker") return "aside";
	return "steer";
}

/**
 * Derive the advisor loop's telemetry from the primary session's config so the
 * advisor model's GenAI spans and usage/cost hooks (onChatUsage, onCostDelta,
 * costEstimator) fire under the same pipeline as every other model call —
 * stamped with the advisor's own agent identity. `conversationId` is cleared so
 * the advisor loop falls back to its own `-advisor` session id for
 * `gen_ai.conversation.id` instead of inheriting the primary's conversation.
 *
 * Returns undefined when the primary has no telemetry (instrumentation off), so
 * the advisor `Agent` stays a zero-overhead no-op as well.
 */
export function deriveAdvisorTelemetry(
	primaryTelemetry: AgentTelemetryConfig | undefined,
	identity: AgentIdentity,
): AgentTelemetryConfig | undefined {
	if (!primaryTelemetry) return undefined;
	return { ...primaryTelemetry, agent: identity, conversationId: undefined };
}

/**
 * The tools an advisor receives by default when its config omits `tools` — the
 * read-only investigative set. The full available pool is every built tool the
 * session has (the advisor is a full agent); a config's `tools` selects from it.
 */
export const ADVISOR_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "glob"]);

function advisorNoteDedupeKey(note: string): string {
	return note.trim().replace(/\s+/g, " ");
}

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description = adviseDescription;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;
	/** Highest delivered severity rank per normalized note. A new call passes
	 *  through only when its rank strictly exceeds the recorded one (a real
	 *  escalation: nit → concern → blocker), so an advisor cannot bypass dedupe
	 *  by retagging the same text at a lower or equal severity. */
	#deliveredNoteSeverities = new Map<string, number>();
	#inProgressUpdate = false;
	/** Notes withheld while the primary was mid-turn, in arrival order. Flushed
	 *  deterministically on the first completed update so delivery does not depend
	 *  on the advisor model choosing to re-raise. Cleared on reset alongside the
	 *  delivered-rank map. */
	#deferredNotes: { key: string; note: string; severity?: AdviseDetails["severity"] }[] = [];
	#steerLevel: AdvisorSteerLevel = "blocker";

	constructor(private readonly onAdvice: (note: string, severity?: AdviseDetails["severity"]) => void) {}

	/**
	 * Mark whether the next advisor prompt reviews an in-progress primary turn.
	 * Advice below the steering threshold is deferred while reviewing partial
	 * work so it cannot interrupt before the primary finishes its planned steps.
	 */
	beginUpdate(options: { inProgress: boolean; steerLevel?: AdvisorSteerLevel }): void {
		const wasInProgress = this.#inProgressUpdate;
		this.#inProgressUpdate = options.inProgress;
		this.#steerLevel = options.steerLevel ?? "blocker";
		// Turn just completed: flush everything withheld mid-turn, oldest first.
		// Each flush re-enters the normal dedupe path so already-delivered notes
		// stay suppressed while genuinely new deferred notes are delivered once.
		if (wasInProgress && !options.inProgress && this.#deferredNotes.length > 0) {
			const pending = this.#deferredNotes;
			this.#deferredNotes = [];
			for (const { note, severity } of pending) this.#deliver(note, severity);
		}
	}

	/** Clear delivered-note memory when the advisor starts a fresh conversation. */
	resetDeliveredNotes(): void {
		this.#deliveredNoteSeverities.clear();
		this.#inProgressUpdate = false;
		this.#deferredNotes = [];
		this.#steerLevel = "blocker";
	}

	async execute(
		_toolCallId: string,
		args: AdviseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdviseDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdviseDetails>> {
		if (this.#inProgressUpdate && !shouldSteerAdvisorSeverity(args.severity, this.#steerLevel)) {
			// Queue below-threshold advice for deterministic delivery on the next
			// completed update. De-duplicate pending notes while retaining escalation.
			const key = advisorNoteDedupeKey(args.note);
			const pending = this.#deferredNotes.find(item => item.key === key);
			if (!pending) {
				this.#deferredNotes.push({ key, note: args.note, severity: args.severity });
			} else if (advisorSeverityRank(args.severity) > advisorSeverityRank(pending.severity)) {
				pending.severity = args.severity;
			}
			return {
				content: [
					{
						type: "text",
						text: "Deferred — primary is mid-turn; this note will be delivered automatically when the turn completes. Do not re-raise the same point.",
					},
				],
				details: { note: args.note, severity: args.severity },
				useless: true,
			};
		}
		const delivered = this.#deliver(args.note, args.severity);
		return {
			content: [{ type: "text", text: delivered ? "Recorded." : "Duplicate advice ignored." }],
			details: { note: args.note, severity: args.severity },
			useless: true,
		};
	}

	/** Run one note through the escalation-rank dedupe and, if it passes, route it
	 *  to the primary. Returns true when the note was actually delivered. Shared by
	 *  the live path (`execute`) and the completed-update deferred flush. */
	#deliver(note: string, severity?: AdviseDetails["severity"]): boolean {
		const key = advisorNoteDedupeKey(note);
		const rank = advisorSeverityRank(severity);
		const previousRank = this.#deliveredNoteSeverities.get(key) ?? 0;
		if (rank <= previousRank) return false;
		this.#deliveredNoteSeverities.set(key, rank);
		this.onAdvice(note, severity);
		return true;
	}
}
