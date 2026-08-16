# Dreaming

Dreaming is idle-time background memory consolidation, inspired by OpenClaw's
feature of the same name. While you are away from an interactive session, the
agent "dreams": it reviews recent session history, promotes durable signal into
long-term memory through the active [memory backend](./memory.md), and records
what it did in a human-readable dream diary (`DREAMS.md`).

Dreaming is on by default but inert until a memory backend is selected
(`memory.backend` is `off` by default). It never interrupts live work: any
agent activity cancels the idle timer and aborts an in-flight dream.

## How it triggers

- **Idle timer** — every completed turn arms a timer (`dream.idleMinutes`,
  default 30). If the session stays quiet until it fires — no streaming, no
  compaction — a dreaming pass runs.
- **Cooldown** — idle dreams run at most once per `dream.minIntervalHours`
  (default 6). The cooldown persists across restarts by reading the newest
  diary entry timestamp. During a long idle stretch the timer re-arms for the
  remaining cooldown, so walking away overnight dreams once the cooldown
  lapses, not once per idle window. A pass that found nothing new backs off
  for a shorter suppression window instead of burning the full cooldown.
- **Manual** — `/dream now` runs a pass immediately, bypassing the cooldown.

Dreaming is installed for top-level sessions only; subagents never dream.

## What a dream does

Per backend:

| `memory.backend` | Dreaming pass                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `local`          | Runs the [two-phase pipeline](./memory.md#how-it-works) incrementally, now instead of at next startup: extracts changed sessions, then consolidates into `MEMORY.md`, `memory_summary.md`, and generated skills. |
| `mnemopi`        | Forces retention of the current session, flushes pending fact extractions, and runs Mnemopi sleep/consolidation (same as `/memory enqueue`).                              |
| `hindsight`      | Flushes queued retains to the remote service (same as `/memory enqueue`).                                                                                                |
| `off`            | Nothing; dreaming reports itself inactive.                                                                                                                               |

For the `local` backend the pass reuses the startup pipeline unchanged — the
SQLite lease/watermark machinery makes it incremental, idempotent, and safe
against a concurrently starting `omp` process claiming the same work.

**Prompt-cache neutrality:** unlike the startup pipeline, a dream never
refreshes the live session's injected memory snapshot or base system prompt.
Like the `learn` tool, dreams benefit the *next* session; the active
conversation's prompt-cache prefix is left untouched.

## The dream diary

With `dream.diary` enabled (default), each productive pass appends an entry to
`DREAMS.md` in the project's memory root, next to `MEMORY.md`:

```md
## 2026-08-16T09:12:44Z — idle dream

- Backend: local
- Sessions reviewed: 3 (2 yielded new memories)
- Long-term memory updated (MEMORY.md)

I reviewed the auth refactor sessions and the flaky CI investigation. ...

Session synopses:

- Migrated token refresh to the new broker; retry logic now lives in one place.
- Tracked the flaky integration test to an unawaited teardown.
```

- Entries are newest-first and capped at `dream.diaryMaxEntries`.
- For the `local` backend, the italicised paragraph is written by the memory
  consolidation model (`smol` role) from the freshly extracted session
  synopses; if no model is available the entry keeps just the facts.
- Anything you hand-write *above* the first `## ` heading survives every
  append.
- The diary is never injected into prompts — it exists for you. Idle dreams on
  `mnemopi`/`hindsight` skip the diary (their engines report no stats); manual
  `/dream now` always records one.
- `/memory clear` deletes it along with the rest of the memory artifacts.

## `/dream` command

| Subcommand           | Effect                                              |
| -------------------- | --------------------------------------------------- |
| `status` _(default)_ | Show enabled state, backend, last result, cooldown  |
| `now`                | Run a dreaming pass immediately (bypasses cooldown) |
| `diary`              | Show the newest dream diary entries                 |

`/dreaming` is an alias.

## Configuration

| Setting                     | Default | Description                                                                     |
| --------------------------- | ------- | ------------------------------------------------------------------------------- |
| `dream.enabled`             | `true`  | Master switch; inert while `memory.backend` is `off`                            |
| `dream.idleMinutes`         | `30`    | Idle minutes before a pass may start (clamped to 5–720)                         |
| `dream.minIntervalHours`    | `6`     | Minimum hours between idle passes (clamped to 0.25–168)                         |
| `dream.diary`               | `true`  | Write `DREAMS.md` entries                                                       |
| `dream.diaryMaxEntries`     | `50`    | Newest-first cap on retained diary entries                                      |
| `dream.maxSessionsPerDream` | `16`    | Cap on sessions extracted per pass (`local` backend)                            |
| `dream.minSessionIdleHours` | `1`     | Sessions active more recently than this are skipped (`local` backend)           |

```yaml
memory:
  backend: local
dream:
  idleMinutes: 60
  minIntervalHours: 12
```

## Key files

- `packages/coding-agent/src/dream/controller.ts` — idle scheduling, cooldown, manual trigger
- `packages/coding-agent/src/dream/runner.ts` — per-backend dispatch and reflection generation
- `packages/coding-agent/src/dream/diary.ts` — `DREAMS.md` read/append/trim
- `packages/coding-agent/src/memories/index.ts` — `runMemoryDreamPass` (local pipeline entry)
- `packages/coding-agent/src/prompts/dream/` — reflection prompt templates
