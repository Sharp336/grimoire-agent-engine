Audit what is consuming the model context window before deciding to compact, drop images, or restructure the conversation.

Use when context is running low, when you want to justify a compaction, or when you need to know which specific messages or categories (system prompt, tool schemas, skills, conversation) dominate the window. Do NOT use for general session statistics — only for context-window composition.

## Parameters
- `min_tokens` (optional): only list rows estimated at or above this many tokens.
- `max_items` (optional): cap on rows returned (default 40, max 200).
- `query` (optional): only list rows whose label or content contain this substring (content is searchable even when `include_previews` is false).
- `include_previews` (optional): include a short text preview per row (default true).

## Output
- Window usage and free space (authoritative, anchored on the provider's last reported prompt-token count when available).
- Category breakdown in real tokens: system prompt, tool schemas, system context, skills, conversation messages.
- Heaviest individual message rows (estimated tokens), filtered and ranked.
- Largest groups aggregated by label.

The category breakdown is authoritative; per-row token counts are estimates. Use the breakdown to decide IF action is needed and the row ranking to decide WHAT to act on.
