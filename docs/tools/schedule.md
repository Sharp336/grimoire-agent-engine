# schedule

> Arm a one-shot wake that re-enters the model with a stored prompt later in this same session.

## Surface

The public surface is the `schedule` tool. There is no `/session schedules` slash command; create and cancel calls use the tool fields described below.

## Source
- Entry: `packages/coding-agent/src/tools/schedule.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/schedule.md`
- Key collaborators:
  - `packages/coding-agent/src/session/session-schedule.ts` — entry shape, newest-per-id fold, timer arming, `SessionScheduleController`.
  - `packages/coding-agent/src/session/agent-session.ts` — owns the controller, samples `schedule.enabled` when re-arming on construction and after every branch swap, exposes `getSessionSchedule()`.
  - `packages/coding-agent/src/extensibility/extensions/managed-timers.ts` — the contained timer pool the wakes are armed on.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and limits it to an enabled top-level session.
  - `packages/coding-agent/src/config/settings-schema.ts` — defines the disabled-by-default flag.

## Inputs

One call is either a **create** or a **cancel**; `cancel` may not be combined with the create fields.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `delayMs` | `number` (integer ≥ 0) | Exactly one of `delayMs` / `atIso` for a create | Relative delay in milliseconds. |
| `atIso` | `string` | Exactly one of `delayMs` / `atIso` for a create | Future absolute due time as ISO-8601. |
| `prompt` | `string` | For a create | Text enqueued when the wake fires. |
| `cancel` | `string` | For a cancel | Id of a pending schedule. |

Supplying both `delayMs` and `atIso`, or neither, is a validation error rather than a silent default.

## Outputs
A single text result plus structured details.

- create → `Scheduled <id> for <ISO due time>.`, details `{ op: "create", id, dueAtMs, prompt, createdAt }`
- cancel → `Cancelled schedule <id>.`, or `No pending schedule <id>; cancel recorded.` when nothing matched, details `{ op: "cancel", id, cancelled }`

## Flow
1. Intent is persisted through `SessionManager.appendCustomEntry` under customType `session-schedule`, payload `{ id, dueAtMs, prompt, createdAt }`.
2. `SessionScheduleController` arms one timeout per pending schedule on a `ManagedTimers` pool dedicated to schedules.
3. On fire, the controller appends a `{ id, fired: true }` tombstone and enqueues the stored prompt as a hidden next-turn message — the same continuation mechanism goal mode uses. It never invokes a tool directly, so the model decides what the wake means.
4. Cancelling appends `{ id, cancelled: true }` for the same id.
5. `foldPendingSessionSchedules` takes the newest entry per id and drops cancelled and fired ids, so a restored session re-arms what is still pending and never re-fires what already ran on the active branch.
6. A schedule whose `dueAtMs` has already passed stays pending through the fold and fires once at the next turn boundary rather than being dropped or fired repeatedly.

## Side Effects
- Appends `session-schedule` custom entries to the transcript (create, cancel, and fired tombstones).
- Arms and clears timers on the session's dedicated `ManagedTimers` pool.
- Enqueues one hidden next-turn message per fired wake, which starts a normal model turn under normal approvals.

## Limits & Caps
- Gated by `schedule.enabled`, default `false`, and limited to top-level sessions. Enablement is sampled when the controller is constructed or re-armed, not observed live.
- **One-shot only.** There is no recurrence and no cron expression.
- **In-session only.** Timers live in the process. A wake never fires in a process the user did not start, and nothing is scheduled across restarts beyond re-arming still-pending intents when that same session is resumed.
- Approval tier is `write`: creating a schedule mutates session state but runs nothing external at call time.
- The schedule pool is deliberately not the extension runner's `ManagedTimers`; that pool's `clearAll()` on extension teardown would silently disarm every pending wake.
- A future wake may be at most `2_147_483_647` ms (about 24.8 days) away. Longer delays are rejected instead of overflowing the runtime timer.

## Errors
- `ToolError("cancel must be a non-empty schedule id.")` — blank `cancel`.
- `ToolError("cancel cannot be combined with delayMs, atIso, or prompt.")` — mixed create/cancel call.
- `ToolError("prompt is required when creating a schedule.")` — missing or blank create prompt.
- `ToolError` from `resolveScheduleDueAtMs` — both or neither of `delayMs` / `atIso`, an unparsable or non-future `atIso`, or a due time more than 24.8 days ahead.
- `ToolError("Session schedule controller is unavailable.")` — the session cannot own live wake timers.

## Notes
- Unknown or malformed `session-schedule` payloads are ignored by the fold rather than throwing, so a hand-edited transcript cannot break session restore.
