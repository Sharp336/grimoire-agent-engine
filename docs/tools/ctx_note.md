# ctx_note

> Manage searchable derived notes scoped to the current project or session.

## Source
- Entry: `packages/coding-agent/src/tools/context-manager.ts` (`CtxNoteTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ctx-note.md`
- Storage: `packages/coding-agent/src/context-manager/storage.ts`

## Availability
The tool is discoverable only while managed context is active. Notes are derived SQLite state; they do not modify canonical session JSONL or Mnemopi memory.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `write \| read \| filter \| update \| dismiss` | Yes | Note operation. |
| `id` | `string` | Depends | ID returned by a prior note or search result. |
| `category` | `string` | Depends | Note category. |
| `content` | `string` | Depends | Note body. |
| `surface_condition` | `string` | No | Condition under which the note should be surfaced. |
| `scope` | `project \| session` | No | Lifetime scope; writes default to session. |
| `status` | `pending \| active \| dismissed` | No | Filter or replacement status. |

## Operations
- `write`: requires category and non-empty content.
- `read`: reads visible notes, optionally narrowed by ID or filters.
- `filter`: filters by category, scope, or status.
- `update`: requires an ID and at least one replacement field.
- `dismiss`: requires an ID and removes the note from active search without deleting it.

## Outputs
Returns JSON text and equivalent structured `ContextNoteResult` details. Project notes are visible across sessions bound to the same stable project identity; session notes remain session-local.

## Safety
Notes are branch-aware derived context. Rewinds and session switches rebind visibility through the managed-context controller.
