/** Filter choices for the all-or-nothing user-message preservation verdict. */
export const PRESERVE_USER_MESSAGES_FILTERS = ["heuristic", "llm", "pinned", "all"] as const;

/** Verdict source for the all-or-nothing user-message preservation. */
export type PreserveUserMessagesFilter = (typeof PRESERVE_USER_MESSAGES_FILTERS)[number];

/** Long preserved-user-message handling choices. */
export const PRUNE_LONG_USER_MESSAGE_MODES = ["no", "middle-out", "head-only", "tail-only", "exclude"] as const;

/** How an over-limit preserved user message is handled before re-emission. */
export type PruneLongUserMessageMode = (typeof PRUNE_LONG_USER_MESSAGE_MODES)[number];

/** Default limit used after long-message pruning is enabled. */
export const DEFAULT_MAX_TOKENS_PER_USER_MESSAGE = 2_000;
