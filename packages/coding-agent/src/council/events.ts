import type { CouncilRunStats } from "./stats";

/**
 * Single owner of the Council transcript-message contract.
 *
 * This module is deliberately a leaf: it imports nothing from the TUI, so the council layer and the
 * presentation layer can share one definition of the durable `customType` strings, the lifecycle
 * event kinds, and the reserved live-progress coordinates instead of keeping mirrored copies in
 * sync by comment. There is one `customType` namespace, so these literals are also the journal
 * entry types.
 */

/** Durable custom-message type for one immutable run-lifecycle event. */
export const COUNCIL_RUN_MESSAGE_TYPE = "council-run";

/** Durable custom-message type for the single end-of-run summary card. */
export const COUNCIL_SUMMARY_MESSAGE_TYPE = "council-summary";

/** Lifecycle events a run persists, each once, keyed by `{ runId, kind, round }`. */
export type CouncilRunEventKind = "kickoff" | "round-start" | "round-settle" | "cancel" | "terminal";

/**
 * Reserved live-progress round for the two lead roles. Real review rounds are 1-based, so round 0
 * can never collide with a reviewer slot.
 */
export const COUNCIL_PLANNER_PROGRESS_ROUND = 0;

/**
 * Reserved live-progress order for planner telemetry. Roster orders are non-negative counts, so a
 * negative sentinel can never collide with a member slot.
 */
export const COUNCIL_PLANNER_PROGRESS_ORDER = -1;

/**
 * Reserved live-progress order for adjudication telemetry, filed under the same round-0 key space.
 * In `main` mode the adjudicator is not a child agent, so the coordinator samples its spend and
 * publishes it here; in `delegated` mode the child's own progress lands on the same coordinates.
 */
export const COUNCIL_ADJUDICATOR_PROGRESS_ORDER = -2;

/**
 * Producer-side `details` payload for a `council-run` card.
 *
 * The coordinator annotates its literals with `satisfies` against this type. Consumers decode
 * persisted JSON, which is untrusted, and therefore keep their own `unknown`-field interfaces and
 * their malformed/missing/foreign-metadata checks.
 */
export interface CouncilRunEventPayload {
	runId: string;
	eventKind: CouncilRunEventKind;
	round?: number;
	manifestUrl?: string;
	/** `summarizeCouncilRun` projection, persisted only on the `terminal` event. */
	stats?: CouncilRunStats;
}

/** Producer-side `details` payload for the `council-summary` card. */
export interface CouncilSummaryPayload {
	runId: string;
	manifestUrl: string;
	/** The `Final:` value already rendered into the card's immediate content. */
	finalUrl: string;
}
