/**
 * Host-owned assignment of capture write slots to `manage_skill` calls.
 *
 * A bounded capture is asked to write one procedure per candidate (one per
 * recovered family, or exactly one for a manual capture). The host — not the
 * model — decides how many writes may land and which candidate each is accounted
 * against:
 *
 *   1. The first `manage_skill` call claims the first free slot, the second the
 *      next, and so on, in the order the prompt lists them. Claims are memoized
 *      per tool-call id so one call never consumes two slots.
 *   2. That call's trusted `AgentToolContext.autolearnCapture` carries EXACTLY
 *      that slot's family, so the persisted `ompManaged.toolFamilies` matches the
 *      slot instead of being the union of every family in the request.
 *   3. `manage_skill` echoes the assignment back in its result details, so the
 *      runner computes remaining coverage from its own assignment rather than
 *      from procedure names, write counts, or model-supplied claims.
 *   4. A call with NO slot is refused by the host before it can write. The prompt
 *      asks for one procedure per candidate, but a prompt is not a limit.
 *
 * Why not trust the model's `match.toolFamilies`? Because coverage drives a
 * corrective retry and the final "stored" report. A capture that wrote two
 * procedures about family A must not be able to make family B look covered, and
 * a name like `msvc-setup` carries no reliable relation to `bash`.
 */
import type { CaptureMetadataContext } from "./capture-request";

/** Minimal tool-call identity needed to assign a slot. */
export interface CaptureToolCall {
	id: string;
	name: string;
}

/** One write the host is willing to accept. */
interface CaptureSlot {
	/** Candidate family, or undefined for a manual capture's single unnamed slot. */
	family?: string;
}

export class CaptureAssignments {
	readonly #base: CaptureMetadataContext;
	readonly #candidates: readonly string[];
	readonly #writerToolName: string;
	/** Total writes the host will accept for this capture. */
	readonly #budget: number;
	/** toolCallId → granted slot. Memoized so one call never consumes two. */
	readonly #granted = new Map<string, CaptureSlot>();
	/** Slots still unclaimed, in prompt order. */
	#queue: CaptureSlot[];

	constructor(options: {
		base: CaptureMetadataContext;
		/** Candidate families in prompt order; empty for a manual capture. */
		candidates: readonly string[];
		writerToolName: string;
	}) {
		this.#base = options.base;
		this.#candidates = options.candidates;
		this.#writerToolName = options.writerToolName;
		// A manual capture names no candidate but still gets exactly one write.
		this.#queue = options.candidates.length > 0 ? options.candidates.map(family => ({ family })) : [{}];
		this.#budget = this.#queue.length;
	}

	/** Candidates this capture was asked to cover; empty for a manual capture. */
	get candidates(): readonly string[] {
		return this.#candidates;
	}

	/** Total writes the host will accept. */
	get budget(): number {
		return this.#budget;
	}

	/**
	 * Whether `toolCallId` holds a host-granted write slot.
	 *
	 * The bounded writer wrapper consults this to refuse an over-budget call. The
	 * slot is granted while the tool context is built, which the agent loop does
	 * before invoking `execute`, so this is already settled by the time the write
	 * would happen.
	 */
	hasSlot(toolCallId: string): boolean {
		return this.#granted.has(toolCallId);
	}

	/**
	 * Trusted per-call context, claiming the next free slot.
	 *
	 * Non-writer calls still receive the base metadata — that is what marks them as
	 * part of the private capture — but claim no slot, so the wrapper refuses them
	 * if they somehow reach the writer. Calls past the budget also claim nothing.
	 */
	contextFor(toolCall: CaptureToolCall): CaptureMetadataContext {
		if (toolCall.name !== this.#writerToolName) return { ...this.#base, toolFamilies: [] };
		let slot = this.#granted.get(toolCall.id);
		if (slot === undefined) {
			const next = this.#queue.shift();
			if (next === undefined) return { ...this.#base, toolFamilies: [] };
			slot = next;
			this.#granted.set(toolCall.id, slot);
		}
		if (slot.family === undefined) return { ...this.#base, toolFamilies: [] };
		return { ...this.#base, toolFamilies: [slot.family], assignedFamily: slot.family };
	}

	/**
	 * Refill the queue with only the slots still unwritten, before a retry.
	 *
	 * `covered` is the set of families proven written by trusted result details, so
	 * a retry's calls can only be assigned candidates that genuinely still need one
	 * — and the budget shrinks to what remains. Returns the remaining candidate
	 * names for the retry prompt.
	 */
	reopenUncovered(covered: ReadonlySet<string>): string[] {
		const remaining = this.#candidates.filter(candidate => !covered.has(candidate));
		this.#queue = this.#candidates.length > 0 ? remaining.map(family => ({ family })) : [{}];
		this.#granted.clear();
		return remaining;
	}
}
