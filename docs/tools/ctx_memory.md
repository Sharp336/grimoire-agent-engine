# ctx_memory

> Manage the canonical Mnemopi project and user-profile memory used by managed context.

## Source
- Entry: `packages/coding-agent/src/tools/context-manager.ts` (`CtxMemoryTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ctx-memory.md`
- Adapter: `packages/coding-agent/src/context-manager/memory.ts`

## Availability
The tool is exposed only when managed context is active, `memory.backend` is `mnemopi`, and the session has an available Mnemopi adapter. Managed context does not maintain a second long-term-memory store.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `write \| read \| update \| archive \| forget \| merge` | Yes | Memory operation. |
| `category` | enum | Depends | `project`, `preference`, `instruction`, `personality`, or `relationship`. |
| `ids` | `string[]` | Depends | IDs returned by memory reads or search. |
| `content` | `string` | Depends | Content for `write` or `update`. |
| `reason` | `string` | No | Evidence explaining a write. |

## Operations
- `write`: requires category and content. `project` uses project scope; all profile categories use user scope.
- `read`: requires one or more IDs.
- `update`: requires exactly one ID and replacement content.
- `archive`: invalidates one or more memories without erasing history.
- `forget`: permanently deletes editable working memories.
- `merge`: requires at least two IDs from one scope, or an explicit matching category.

## Outputs
Returns JSON text plus structured `details` with the action, IDs, records, missing IDs, edit results, or newly created ID as applicable.

## Safety
Project/session facts are read-only derived records and cannot be edited through this tool. Never invent memory IDs. Prefer `archive` to `forget` when historical provenance may remain useful.
