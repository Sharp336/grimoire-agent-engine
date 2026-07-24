# ctx_search

> Search managed session history, notes, Git commits, facts, and Mnemopi memory.

## Source
- Entry: `packages/coding-agent/src/tools/context-manager.ts` (`CtxSearchTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ctx-search.md`
- Search implementation: `packages/coding-agent/src/context-manager/search.ts`

## Availability
The tool is discoverable only while managed context is active. Sources that are disabled or unavailable are reported rather than fabricated.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Non-empty keyword or natural-language query. |
| `sources` | array | No | Any of `memory`, `session_fact`, `compartment`, `note`, or `git_commit`. |
| `limit` | `number` | No | Result cap, clamped to `1..100`. |

## Behavior
1. The query is matched against the SQLite FTS index for derived session records and indexed Git commits.
2. Mnemopi is queried only when its adapter is active and `memory` is selected.
3. Optional embeddings add semantic candidates; reciprocal-rank fusion combines lexical and semantic ranks deterministically.
4. Hits preserve stable source IDs, canonical IDs where available, snippets, scores, and tag ranges.

## Outputs
Returns JSON text and equivalent structured `details` containing `query`, ranked `hits`, searched sources, and unavailable sources. Use returned IDs with `ctx_expand`, `ctx_note`, or `ctx_memory`; never guess identifiers.

## Side effects and limits
Search is read-only. A caller-provided abort signal cancels outstanding work. Git and embedding indexing are maintained separately by `/ctx-embed` and background maintenance.
