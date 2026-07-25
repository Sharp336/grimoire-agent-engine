Wake this session later with a one-shot timer.

Schedules live only while this process is alive — they do not survive exit.

## Create

Supply **exactly one** of:

- `delayMs` — relative delay in milliseconds (non-negative integer)
- `atIso` — absolute due time as an ISO-8601 timestamp

Plus a non-empty `prompt` that will be enqueued as a hidden next-turn message when the timer fires. Returns the created schedule `id`.

## Cancel

Pass `cancel` with a schedule id to cancel a pending wake. Do not combine cancel with create fields.

## Rules

- One-shot only — no recurrence or cron.
- Never rely on a schedule after the session process exits.
- Cancelling an unknown id is a no-op that still records the cancel tombstone.
