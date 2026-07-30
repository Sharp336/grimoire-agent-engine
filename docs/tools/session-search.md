# session_search

> Search persisted OMP session transcript content, including entries hidden behind compaction boundaries.

## Source
- Entry: `packages/coding-agent/src/tools/session-search.ts`
- Search and archive service: `packages/coding-agent/src/session/session-archive.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/session-search.md`
- Transcript reader primitives: `packages/coding-agent/src/session/session-listing.ts`, `packages/utils/src/stream.ts`
- Related archive URLs: `packages/coding-agent/src/internal-urls/history-protocol.ts`

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Literal transcript text to find. Maximum 500 characters. Matching is case-insensitive by default. |
| `scope` | `"project" \| "all"` | No | Session scope. Defaults to `project`, matched against the active session's resolved working directory. |
| `session` | `string` | No | Restrict search to an exact or uniquely prefixed archived session header ID. |
| `role` | `"all" \| "user" \| "assistant" \| "tool" \| "summary"` | No | Restrict matches by persisted entry role. Defaults to `all`. |
| `case` | `boolean` | No | Enable case-sensitive matching. Defaults to `false`. |
| `limit` | `number` | No | Matches returned per page. Integer from 1 through 100; default 20. |
| `offset` | `number` | No | Matches skipped from the stable result order. Integer from 0 through 10,000; default 0. |

## Outputs

The tool returns one text block in `content[0].text` and structured `details`.

Text output:
- Groups matches under `history://session/<session-id>` headings.
- Shows the persisted role, timestamp, entry ID, and a bounded single-line snippet for each match.
- Prints `nextOffset` guidance when another page exists.
- Reports scanned and unreadable session counts.

`details` contains:
- normalized `query`, `scope`, `role`, `offset`, and `limit`;
- `matches`, each with `sessionId`, title, project label, modified timestamp, entry ID, entry timestamp, role, and snippet;
- `hasMore` and optional `nextOffset`;
- `scannedSessions` and `unreadableSessions`.

## Flow
1. `SessionSearchTool.execute()` validates integer bounds and applies defaults.
2. `listArchivedSessions()` calls the canonical global session listing, deduplicates physical transcript paths, and applies current-project scope unless `scope: "all"` was requested.
3. A `session` selector resolves only against transcript header IDs. Exact matches win; prefixes must identify one session. Filesystem paths are rejected.
4. The query is escaped and compiled as a literal Unicode regular expression.
5. Each selected JSONL transcript is streamed line by line. Search reads persisted entries directly rather than the compacted model-context view, so pre-compaction turns remain searchable.
6. Searchable surfaces include user and assistant text, tool calls/results, shell and Python execution text, file mentions, visible custom messages, compaction summaries, and branch summaries.
7. Sessions are ordered newest-first. Matches within each transcript are ordered newest-first. Pagination applies to that stable combined order.
8. Bounded per-file buffers and early termination prevent result collection from growing with archive size.

## Role Mapping
- `user`: user messages, shell executions, Python executions, and file mentions.
- `assistant`: assistant messages, including tool-call names and serialized arguments.
- `tool`: tool-result messages.
- `summary`: compaction and branch-summary entries.
- `all`: every role above plus other visible persisted message kinds.

## Side Effects
- Read-only. No session file, registry entry, lock, or active conversation state is changed.
- Cancellation propagates through `untilAborted(...)` and the transcript stream readers.

## Limits & Ordering
- Query length: 500 characters.
- Page size: 1–100 matches; default 20.
- Offset: 0–10,000.
- Snippets retain at most 180 characters of context on either side of the first match, then the renderer truncates to 420 terminal columns.
- Search covers persisted bytes only. A live turn not yet flushed to its JSONL transcript cannot appear.
- Unreadable transcripts are skipped and counted; an aborted read is rethrown rather than counted.

## Errors
- Empty or overlong queries are rejected.
- Non-integer or out-of-range `limit` and `offset` values are rejected.
- Unknown session IDs report that no archived session matched.
- Ambiguous exact IDs or prefixes report bounded candidate descriptions.
- Direct `.jsonl` and path-shaped selectors are rejected; discover sessions through `history://session` first.

## Related URLs
- `history://session` lists current-project archived sessions with bounded metadata filtering and pagination.
- `history://session?scope=all` lists archives across projects.
- `history://session/<id>` renders one exact or uniquely prefixed session transcript.
- `history://agent/<id>` reads an agent transcript and is intentionally separate from the archived-session namespace.
