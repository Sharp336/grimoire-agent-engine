/**
 * Shared inline guidance for hashline `edit` — surfaced on parse failures and bash
 * interceptor blocks (not model-specific system prompts).
 */
export const HASHLINE_EDIT_INPUT_GUIDANCE =
	"Call `edit` with a hashline `input` string: copy a `[PATH#TAG]` header from your latest `read`/`search`, then add ops (`replace N..M:`, `insert after N:`, `delete N`, …) with `+` body rows. Do not edit files via `bash` (`python -c`, `node -e`, `bun -e`, `sed`) or `eval` when `edit` is available.";

/** Message body when bash blocks scripted file IO in favor of `edit`. */
export function bashInterceptScriptedEditMessage(shellHint: string): string {
	return `Use the \`edit\` tool instead of ${shellHint} to change files. ${HASHLINE_EDIT_INPUT_GUIDANCE}`;
}
