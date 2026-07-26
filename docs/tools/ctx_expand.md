# ctx_expand

> Read canonical session history for stable managed-context tags.

## Source
- Entry: `packages/coding-agent/src/tools/context-manager.ts` (`CtxExpandTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ctx-expand.md`
- Controller: `packages/coding-agent/src/context-manager/controller.ts`

## Availability
The tool is discoverable only while managed context is active. It is read-only and does not cancel queued or active reductions.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `tags` | `string[]` | Yes | Stable tags such as `§12§`; bare positive ordinals are accepted. |
| `max_chars` | `number` | No | Maximum characters shown in the returned preview, clamped to `1..200000`. |

## Behavior
1. Tags are parsed, validated, and deduplicated.
2. The manager resolves each tag to its persisted session entry and reads canonical message content.
3. Large expansions are stored as a session artifact; the result includes its `artifact://` URI.
4. `max_chars` truncates only the displayed preview. It never changes the canonical artifact or session log.

## Outputs
The result reports found and missing tags, cancelled-drop count, optional artifact ID, preview truncation, and canonical content. Structured `details` contains those fields without duplicating the full text.

## Errors and limits
- At least one positive, safe-integer tag is required.
- Missing or superseded tags are listed explicitly.
- Expansion never makes reduced content live again; it is a bounded read operation.
