# ctx_reduce

> Queue protocol-safe managed-context reduction by stable transcript tag.

## Source
- Entry: `packages/coding-agent/src/tools/context-manager.ts` (`CtxReduceTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ctx-reduce.md`
- Reduction planning: `packages/coding-agent/src/context-manager/reduction-units.ts`

## Availability
The tool is exposed only while managed context is active for the session. It is an essential tool and uses read approval because it changes derived context state, not the canonical session log.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `tags` | `string[]` | Yes | Stable tags such as `§12§`; bare positive ordinals are also accepted. |
| `reason` | `string` | No | Why the history may leave live provider context. |

## Behavior
1. Tags are parsed, validated, and deduplicated.
2. Every requested message expands to the smallest valid user/assistant/tool-loop unit.
3. Incomplete tool batches, the protected tail, and other protected messages are rejected.
4. Accepted drops are queued with an eligibility time. They activate only after the configured cache TTL and a later materialization boundary.
5. Canonical JSONL messages are never deleted or rewritten.

## Outputs
The text result reports status, requested tags, protocol-expanded tags, eligibility time, and rejected tags with reasons. Structured `details` contains the full `ContextReduceResult`, including requested, expanded, queued, and rejected tag sets.

## Errors and limits
- At least one positive, safe-integer tag is required.
- Unknown tags and protected units are returned as rejected results rather than silently removed.
- Use `ctx_expand` to retrieve canonical content after its wire-context copy has been reduced.
