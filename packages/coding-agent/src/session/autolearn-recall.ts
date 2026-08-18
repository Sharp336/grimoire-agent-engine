/**
 * Delivery of Auto-Learn recall cards into the CURRENT run.
 *
 * A recall card is a compact descriptor list (`name` + `description` +
 * `skill://<name>`) — never a procedure body. It rides the session's
 * `YieldQueue` as a hidden aside so the agent loop's existing aside polling
 * folds it into the run's immediate next provider turn instead of waiting for
 * the user's next prompt.
 *
 * `skipIdleFlush` is deliberate: an unread suggestion must never start a turn of
 * its own. If the run already stopped, the card is simply dropped with the
 * episode.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import recallTemplate from "../prompts/system/autolearn-recall.md" with { type: "text" };
import type { CustomMessage } from "./messages";

/** YieldQueue kind for Auto-Learn recall cards. */
export const AUTOLEARN_RECALL_MESSAGE_TYPE = "autolearn-recall";

/** One recalled descriptor, already ranked and eligible. */
export interface AutolearnRecallCard {
	name: string;
	description: string;
}

/** One queued recall card batch for a single failure episode. */
export interface AutolearnRecallEntry {
	/** Failure family that armed the episode (`bash`, `mcp:<server>`). */
	family: string;
	/** Eligible failures counted when the episode hit the threshold. */
	failureCount: number;
	/** Descriptors to surface; at most three in `suggest` mode, exactly one in `require` mode. */
	cards: readonly AutolearnRecallCard[];
	/** Name whose body the model is soft-required to read; unset in `suggest` mode. */
	requiredName?: string;
	/** Episode generation, so a card queued for a resolved episode can be dropped. */
	epoch: number;
}

/** Details attached to the hidden custom message for transcript rebuilds/telemetry. */
export interface AutolearnRecallDetails {
	family: string;
	names: string[];
	requiredName?: string;
}

/**
 * Render one hidden recall aside.
 *
 * Only the FIRST entry is rendered: each entry already describes a complete
 * episode with its own required read, and merging two episodes' cards would
 * produce a soft requirement the reminder text no longer matches.
 */
export function buildAutolearnRecallMessage(
	entries: AutolearnRecallEntry[],
): CustomMessage<AutolearnRecallDetails> | null {
	const entry = entries[0];
	if (!entry || entry.cards.length === 0) return null;
	const names = entry.cards.map(card => card.name);
	return {
		role: "custom",
		customType: AUTOLEARN_RECALL_MESSAGE_TYPE,
		content: prompt.render(recallTemplate, {
			count: entry.cards.length,
			single: entry.cards.length === 1,
			failureCount: entry.failureCount,
			singleFailure: entry.failureCount === 1,
			family: entry.family,
			procedures: entry.cards,
			required: entry.requiredName !== undefined,
			requiredName: entry.requiredName,
		}),
		// Hidden: the card is host-authored guidance, not conversation the user
		// asked for, and it must not appear as an agent turn in the transcript.
		display: false,
		attribution: "agent",
		details: { family: entry.family, names, requiredName: entry.requiredName },
		timestamp: Date.now(),
	};
}
