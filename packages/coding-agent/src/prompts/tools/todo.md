**Tasks referenced by verbatim content string, NEVER an auto-generated ID — no "task-1"/"task-N" exists. Pass the content text in the `task` field.**

On each completion the earliest still-open task (in phase order) auto-promotes to `in_progress`.
Completing tasks out of phase order can move this pointer **back** to an earlier phase — expected; completed tasks are never reverted.

## Operations

|`op`|Required fields|Effect|
|---|---|---|
|`init`|`list: [{phase, items: string[]}]`|Initialize full list (replaces existing)|
|`init`|`items: string[]`|Flattened single-phase init|
|`start`|`task`|Mark in progress|
|`done`|`task` or `phase` (optional)|Mark completed; omit both to affect all tasks|
|`drop`|`task` or `phase` (optional)|Mark abandoned; omit both to affect all tasks|
|`block`|`task` or `phase`, optional `reason`|Mark **blocked** — open but waiting on external input; excluded from the stop-time incomplete-todo reminder|
|`unblock`|`task` or `phase`|Return a blocked task to `pending`|
|`rm`|`task` or `phase` (optional)|Remove task or phase; omit both to clear|
|`append`|`phase`, `items: string[]`|Append tasks to `phase`; lazily creates phase|
|`view`|—|Read-only: echo list|
Fields are operation-specific: `init` takes `list` or flattened `items` (at least one task); `append` takes `phase` plus `items` (at least one task); `start`/`block`/`unblock` take `task` or `phase`; `block` may include `reason`. `view` is read-only, and `done`/`drop`/`rm` may omit a target to affect everything.

## Anatomy
- **Task content**: 5–10 words; what, not how. Unique identifier.
- **Phase name**: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`). Unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.

## Rules
- Mark tasks done immediately after finishing. Complete phases in order.
- NEVER make a todo call your turn's only tool call while actionable work remains — batch it with the real work: `init` with the first reads/edits, each `done`/`start` with the next action. A final bookkeeping-only call is allowed when no actionable tool work remains.
- Waiting on something you can't act on (a user decision, another agent, an external service)? `block` the task (optional `reason`) — it stays in the tracker but won't trip the stop reminder; `unblock` when it's actionable again. If the blocker is itself agent-actionable, `append` an unblocking task instead.
- Keep `task`/`phase` strings stable once introduced.
- Lost the exact task text? `view` echoes the list — NEVER guess from memory.

## When to create a list
- Task requires 3+ distinct steps
- User explicitly requests one
- User provides a set of tasks
- New instructions arrive mid-task — capture before proceeding

<critical>
User hands you a multi-step plan — phased todo, numbered/bulleted checklist, or "N bugs/items/tasks":
- You MUST `init` the list with EVERY item as its own task before working.
- Enumerate all; NEVER summarize into fewer tasks, sample "the important ones", drop items, or track the rest from memory.
</critical>
