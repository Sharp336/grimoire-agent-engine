Wake this session later with a one-shot timer.

Timers stop when the process exits. A pending intent can re-arm when this same session is resumed with scheduling enabled.

## Create

Supply **exactly one** of:

- `delayMs` — relative delay in milliseconds (non-negative integer, at most 2_147_483_647)
- `atIso` — absolute due time as an ISO-8601 timestamp, at most about 24.8 days ahead

Plus a non-empty `prompt` that will be enqueued as a hidden next-turn message when the timer fires. Returns the created schedule `id`.

## Cancel

Pass `cancel` with a schedule id to cancel a pending wake. Do not combine cancel with create fields.

## Rules

- One-shot only — no recurrence or cron.
- No wake runs while the session process is offline.
- Cancelling an unknown id records a tombstone so an older create entry cannot reappear.
