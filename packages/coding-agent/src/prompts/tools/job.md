Inspects, waits, or cancels async jobs.

Results arrive automatically on completion; automatic delivery is the norm. Reach for this tool only to recover or intervene.

# Operations

## `list: true`
Inspect what's running.

## `poll: [id, …]`
Fallback wait. Block until specified jobs finish or the wait window elapses. Omit `poll` (no `list`/`cancel`) to wait on ALL running jobs — NEVER enumerate ids you don't need to filter.
- **Fallback only.** Use when no useful work remains and progress is impossible without the result.
- **NEVER poll defensively.** Spawn → continue; completed results arrive automatically.
- Completed jobs include final output.

## `cancel: [id, …]`
Stop running jobs.
- Use when a job is stalled, hung, or no longer needed.
