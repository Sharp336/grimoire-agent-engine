/**
 * Identity constants for `/side` conversations, shared by the controller, the
 * persisted-agent scan, and tests. Kept out of session/messages.ts, which is
 * message schema; this module is registry/file identity.
 */

/**
 * Registry id for the live side conversation. The dot makes it
 * collision-proof: task-id sanitization strips everything outside
 * `[A-Za-z0-9_-]` (structured-subagent.ts), so no user task can produce it.
 */
export const SIDE_AGENT_ID = "side.internal";

/** Filename prefix for side session files (`side.internal-<snowflake>.jsonl`). */
export const SIDE_SESSION_FILE_PREFIX = `${SIDE_AGENT_ID}-`;
