# @oh-my-pi/scheduler-extension

Session-quota-aware prompt queue for [oh-my-pi](https://github.com/can1357/oh-my-pi)
(omp). Queue prompts before bed; `/scheduler` drains them unattended: it
dispatches the next task whenever the agent goes idle, tracks Claude's
**5-hour session windows** (max **4 per rolling 24 h**) when the active model
runs on Claude subscription auth, dispatches ungated for every other
provider, waits out provider-declared rate limits and network outages — and
when a task dies mid-flight (rate limit, error, abort, crash) it **resumes
that task instead of skipping it**.

One extension entry (`src/extension.ts`), no daemon, no external process, no
new dependencies. It adds one slash command: `/scheduler`.

## Why

Claude subscriptions meter usage in 5-hour session windows, with a cap on how
many windows you can open per rolling 24 hours. If you only use omp at your
desk, most of those windows expire unused. `scheduler` lets you bank real
work for the hours you are asleep:

1. Queue tasks with `/scheduler add ...`.
2. `/scheduler start` and go to bed.
3. The extension sends the next prompt each time the agent goes idle, opens
   session windows only when the quota allows it, sleeps until the next
   window (or until a provider-named rate-limit reset) when it doesn't, and
   retries interrupted tasks with a "continue where you left off" preamble.
4. Wake up, read `/scheduler log`.

## Enabling

The package manifest declares the extension under the `omp.extensions` key,
so pointing omp at this package is enough:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /path/to/oh-my-pi/packages/scheduler-extension
```

or per launch:

```bash
omp --extension packages/scheduler-extension
```

> **Windows path gotcha:** in a **bash** shell (Git Bash/WSL/MSYS), an
> unquoted backslash path is mangled before omp ever sees it —
> `omp --extension D:\Projects\oh-my-pi\packages\scheduler-extension`
> arrives as `D:Projectsoh-my-pi...` (`\P`, `\o`, … are escape sequences)
> and the extension silently fails to load (the error only lands in
> `~/.omp/logs/`). Use **forward slashes** — they work in every shell on
> Windows (`D:/Projects/oh-my-pi/packages/scheduler-extension`) — or quote
> the path. cmd/PowerShell pass backslashes through fine.

Restart omp. `/scheduler` (with no arguments) prints usage.

## ⚠️ Prerequisite: approval mode must be `yolo`

Overnight runs are unattended. If omp asks "Allow tool: bash?" at 3 AM,
nobody answers and the whole night is wasted. Before starting the scheduler,
make sure every tool call is auto-approved:

```bash
omp --yolo                                  # per launch, or:
omp config set tools.approvalMode yolo      # persistent
```

`/scheduler start` checks the persisted `tools.approvalMode` in your omp
config files and shows a confirmation warning when it is set to something
other than `yolo`. It **cannot** see runtime flags (they are in-memory only),
so if you launched with `--yolo` you can safely confirm through the warning.

Also disable OS sleep for the machine — the queue runs inside the omp
process; a sleeping laptop dispatches nothing.

## Usage

```text
/scheduler add <prompt>        queue a task
/scheduler add-file <path>     queue task(s) from a file (single prompt or batch)
/scheduler list                show queue, current task, session-window state
/scheduler status              alias of list
/scheduler start               begin draining the queue when the agent is idle
/scheduler pause               finish the current task, then hold
/scheduler stop                abort the current task (kept as resumable) and hold
/scheduler remove <id>         remove one task (not the in-flight one)
/scheduler retry [id]          re-queue failed task(s) with a fresh attempt budget
/scheduler clear               remove all pending tasks
/scheduler export [path]       write the queue to markdown (default scheduler-queue.md)
/scheduler log [n]             show the last n JSONL log entries (default 10)
/scheduler ledger              show the per-prompt outcome table (hash · status · prompt · summary)
/scheduler config              show the config file path and current values
```

Examples:

```text
/scheduler add Refactor src/parser.ts to a recursive-descent parser; keep tests green
/scheduler add-file prompts/nightly-refactor.md
/scheduler start
/scheduler status
```

### Batch files

`add-file` queues one or many tasks from a file, and picks the format
automatically:

1. **Verbatim batch** (recommended for anything non-trivial) — a file whose
   first line is the `@@prompts` header. Prompt bodies are taken **exactly
   as written**: quotes, back/forward slashes, newlines, JSON objects, and
   pasted code all pass through untouched — there is **no escaping**.
2. **Legacy JSON batch** — a comma-separated sequence of `{prompt: "..."}`
   objects (kept for backward compatibility; values are JSON strings).
3. **Plain text** — no header and not JSON-batch-shaped: the whole file
   becomes a single task.

#### Verbatim batch

Put `@@prompts` on the first line. Everything after it is split into prompts
on lines that contain only the separator (default `---`):

```text
@@prompts
Refactor src/parser.ts to recursive descent.
Keep the existing tests green.
---
Fix the Windows path bug: C:\Users\me\project must load,
and JSON like {"retries": 3, "path": "a/b\\c"} must survive verbatim.
---
Add a "Troubleshooting" section to the docs.
Quotes, slashes /\, and code blocks are all fine here:

    const x = `${a}/${b}`;
```

- No escaping — content is copied byte-for-byte between separators.
- A prompt can contain multiple lines, blank lines, quotes, `\`, `/`, JSON,
  and code. Only a line equal to the separator ends a prompt.
- If your prompts contain a `---` line, choose a separator that they don't,
  via the header — `@@prompts sep=<<<<` (heredoc/MIME-boundary style). Any
  token works; `sep`, `delim`, and `delimiter` are accepted, as is `@@batch`.
- Leading/trailing and doubled separators are ignored (no empty tasks).
- Up to **30** prompts per file; queued **atomically**.

#### Legacy JSON batch

```text
{prompt: "Refactor src/parser.ts to recursive descent"},
{prompt: "Write integration tests for the auth flow"},{prompt: "Port CI to GitHub Actions"},
  {prompt: "Update the architecture doc.\nMention the new parser."},
```

- Newlines/spaces between objects are irrelevant; a trailing comma and a
  surrounding `[...]` are both fine; the `prompt` key may be bare or quoted.
- Prompt values are JSON strings: use `\n` for a newline, `\\` for a
  literal backslash, `\"` for a quote. (This escaping is exactly why the
  verbatim format above exists — prefer it for real-world prompts.)
- The file is syntax-checked first and queued **atomically** — a malformed
  batch (bad syntax, wrong key, empty prompt, >30 entries) queues nothing
  and reports the exact offending entry.
- A plain prompt that merely starts with `{` is still treated as a single
  task; batch parsing only kicks in when the content names a `prompt` key.

`status` output looks like:

```text
scheduler: running
model: anthropic/claude-fable-5 — quota: 5h×4 (anthropic)
windows: 2/4 used in last 24h; active window ends in 3h12m
current: t3 (attempt 2) — Migrate the database layer to Drizzle…
queue:
  t4  queued      Write integration tests for the auth flow
  t5  interrupted Port CI to GitHub Actions (attempt 1, rate limited)
finished: 3 done, 0 failed (/scheduler log for details)
context: 45% of 200k tokens
```

## How it works

```mermaid
flowchart TD
    A[/scheduler start/] --> B{agent idle?}
    B -- no --> W1[wait for agent_end] --> B
    B -- yes --> H{provider hold\nactive?}
    H -- "yes (429 retry-after)" --> T2[sleep until provider\nreset clock] --> B
    H -- no --> P{quota profile\ngated?}
    P -- "no (openai, local, …)" --> D[dispatch next task\nwith unattended preamble]
    P -- "yes (anthropic/claude)" --> C{session window\navailable?}
    C -- "no (4/4 in 24h)" --> T[arm timer for\nnext window] --> C
    C -- yes --> D
    D --> E{turn outcome}
    E -- success --> F[mark done] --> B
    E -- "rate limit / outage" --> R[refund attempt,\nhold or back off] --> B
    E -- "user abort" --> U[pause queue,\nkeep task resumable]
    E -- "error / crash" --> G[mark interrupted] --> B
```

- **Dispatch loop** — the extension listens to omp's `agent_start` /
  `agent_end` session events. While running, each `agent_end` (plus an idle
  check) triggers the next dispatch via omp's user-prompt flow
  (`sendUserMessage`), exactly as if you had typed the prompt.
- **Quota tracking** — applies only when the active model matches a *gated*
  quota profile (by default: anthropic/claude — see
  [Model awareness](#model-awareness)). Every agent turn that begins outside
  an active window records a new window start in `state.json`, tagged with
  the profile it was tracked under (manual prompts count too). A dispatch is
  only allowed when a window is active or fewer than the profile's
  `maxSessionsPer24h` windows started in the rolling 24 h. When blocked, a
  timer fires at the moment the oldest window ages out (+ configurable
  slack) and dispatching resumes automatically. Ungated models record no
  windows and dispatch whenever the agent is idle.
- **Provider rate limits are ground truth** — when provider retries are
  exhausted on a 429 (`auto_retry_end`), the `retry-after` in the error is
  parsed and **all** dispatch is held until the provider's own reset clock
  (persisted in `state.json`, so the hold survives restarts). The attempt is
  refunded: an exhausted quota elsewhere can never burn a task's attempt
  budget. Any turn that later ends healthy clears the hold early.
- **Outage backoff** — transport/DNS/timeout/5xx failures probe on
  exponential backoff (default 30 s doubling to a 15 min cap, forever), so an
  overnight outage resumes work instead of failing the queue. Outage
  interruptions don't count attempts either.
- **Watchdog** — a low-frequency interval re-arms lost timers and re-queues a
  dispatched task whose turn never materialized (agent idle past the stall
  timeout). `running` can never silently stall for hours.
- **Resume, not skip** — a task whose turn ends in a genuine error is marked
  `interrupted`, keeps its place at the head of the queue, and is re-sent
  with a resume preamble ("Continue exactly where you left off; do not
  repeat completed work"). After `maxAttempts` such attempts it is marked
  `failed` and the queue moves on (`/scheduler retry` revives it). Tasks left
  `running` by a crashed or closed omp process are recovered as
  `interrupted` on the next launch.
- **Content-policy recovery** — a turn rejected by Anthropic's usage-policy
  classifier (the "cyber"/malicious-code category) poisons the *whole
  conversation*: because the classifier scans the full transcript, re-sending
  into the same context re-trips it forever — and later tasks, even a message
  you type yourself, fail identically. When such a rejection is detected the
  extension purges the poisoned history with a fresh context
  (`ctx.newSession`, falling back to `compact`) *before* re-dispatching the
  task with the resume preamble, and refunds the attempt so the cascade never
  burns the `maxAttempts` budget. The reset never re-fires `session_start`, so
  the queue and window history are untouched. A prompt that trips the
  classifier even in a freshly reset context is failed after `maxContextResets`
  (default 5) resets rather than looping forever. Every purge is logged as a
  `context_reset` event.
- **The human wins** — aborting a *scheduled* turn (Esc) pauses the queue
  instead of re-dispatching over you; the task stays resumable and the
  attempt is refunded. `/scheduler start` resumes.
- **Prompt wrapper** — every dispatched prompt is prefixed with a
  token-efficiency/autonomy preamble (no summaries, no progress narration,
  never ask questions — decide autonomously and note assumptions in a final
  line). Both preambles live in `config.json`; edit them to taste.

## Model awareness

Only **Anthropic Claude subscription auth** meters usage in 5-hour session
windows (max 4 per rolling 24 h). API-key billing and every other provider
(OpenAI, Google, local models, …) have no such windows — gating them would
just waste idle hours. The scheduler therefore resolves the active
provider/model at dispatch time (and at every turn start) and matches it
against the ordered `quotaProfiles` list in `config.json`; the first match
wins:

```json
"quotaProfiles": [
	{ "match": "^anthropic$", "sessionHours": 5, "maxSessionsPer24h": 4 },
	{ "match": ".*", "sessionHours": null, "maxSessionsPer24h": null }
]
```

- `match` is a case-insensitive regex tested against the provider id, the
  model id, and `provider/modelId` of the active model.
- The shipped default matches the **`anthropic` provider**, not the string
  `claude`, so a third-party catalog that serves Claude models (Bedrock,
  OpenRouter, other API-key gateways) is **not** gated by the subscription
  window — it bills per key and falls through to the unlimited `.*` profile.
  Widen the pattern yourself if your setup genuinely meters those.
- `sessionHours`/`maxSessionsPer24h` set the window policy; `null` (either
  field) means **unlimited**: no windows are recorded and dispatch is never
  quota-blocked for that model.
- A model that matches no profile — or a provider/model the extension cannot
  detect at all — runs **unlimited**, and a `notice` line is written to the
  task log so the decision is visible.
- Each window record in `state.json` stores the profile it was tracked
  under, so switching models mid-day (e.g. `/model` from Claude to GPT and
  back) never corrupts the Claude window counts.
- `/scheduler status` shows the detected model and the applied profile:
  `model: anthropic/claude-fable-5 — quota: 5h×4 (anthropic)` vs
  `model: openai/gpt-5 — quota: none (openai)`.

> **Note:** the extension cannot see *how* you authenticate. If you use
> Anthropic models via API-key billing (no session windows), replace the
> first profile's limits with `null`/`null` to run ungated.

Legacy configs (`windowHours`/`maxWindowsPer24h`) are migrated automatically:
their values become the gated anthropic profile's limits.

## Configuration

`/scheduler config` prints the file path. Default location:
`~/.omp/agent/scheduler/config.json` (respects `PI_CODING_AGENT_DIR`).
The file is created with defaults on first load and re-read on every
`/scheduler start` and session start.

| Key | Default | Meaning |
|---|---|---|
| `quotaProfiles` | anthropic/claude → 5h×4, `.*` → unlimited | Ordered provider/model → window-policy map; see [Model awareness](#model-awareness). |
| `maxAttempts` | `3` | Genuine-error attempts (first + resumes) before a task is marked `failed`. Rate-limit/outage/abort interruptions are refunded and never count. |
| `dispatchDelayMs` | `4000` | Idle settle delay before dispatching the next task. |
| `windowSlackMs` | `60000` | Extra wait added to next-window and rate-limit resume timers. |
| `outageBackoffBaseMs` | `30000` | First retry delay after a network/provider outage. |
| `outageBackoffMaxMs` | `900000` | Outage backoff ceiling (doubles each consecutive outage up to this). |
| `watchdogIntervalMs` | `60000` | Watchdog tick interval; self-heals lost timers and stalled dispatches. |
| `stallTimeoutMs` | `600000` | How long a dispatched task may sit with an idle agent before the watchdog re-queues it. |
| `maxContextResets` | `5` | Content-policy ("cyber") violations that purge the context and re-dispatch a task before it is finally marked `failed`. Refunded like rate limits, so a poison cascade never burns the attempt budget; the cap only guards against a prompt that trips the classifier every time. |
| `promptPreamble` | see file | Prepended to **every** dispatched prompt. |
| `resumePreamble` | see file | Additionally prepended when resuming an interrupted task. |

## State files

Everything lives under `~/.omp/agent/scheduler/`
(or `$PI_CODING_AGENT_DIR/scheduler/`):

| File | Contents |
|---|---|
| `state.json` | Queue, task statuses/attempts (plus per-task `promptHash` and `policyResets`), run mode, observed session-window start times (each tagged with its quota profile), in-flight task id, provider rate-limit hold (`rateLimitedUntil`). Written atomically on every change; survives restarts. |
| `config.json` | User-editable configuration (table above). |
| `task-log.jsonl` | Append-only log: one JSON object per event — `start`, `pause`, `stop`, `dispatch`, `end` (with status, `classification`, error, duration), `blocked` (quota, rate limit, outage, or content-policy violation, with resume time), `context_reset` (poisoned-conversation purge, with method), `resume_timer`, `window_start`, `recovered`, `retry_failed`, `notice`. Every `end` carries its `classification` (`rate_limit`/`outage`/`content_policy`/`user_abort`/`task_fault`/`stalled`/`shutdown`) so the log line alone explains why a turn ended and whether it cost an attempt. `/scheduler log [n]` pretty-prints the tail. |
| `task-ledger.md` | Human-readable outcome table, one row per task keyed by `promptHash` (hash · status · prompt · code-generated summary). Regenerated from state after every pass/fail — zero LLM tokens. `/scheduler ledger` prints it and refreshes the file. |

Deleting `state.json` resets the queue and window history; deleting
`config.json` restores defaults on next load.

## Limitations

Honest list — these follow from what omp's documented extension API can and
cannot express:

1. **Window accounting is a local approximation.** A window is recorded when
   *this* omp process observes an agent turn start outside an active window
   (gated profiles only; ungated models record nothing). Usage from other
   machines, the Claude apps, or other omp instances is invisible;
   Anthropic's server is the source of truth. If you burned windows
   elsewhere, the scheduler dispatches into a 429 — the provider's
   `retry-after` then becomes the hold clock, the attempt is refunded, and
   work is still not lost. The auth mode is equally invisible: profiles
   match on provider/model id, not on subscription-vs-API-key, so API-key
   Anthropic users should edit `quotaProfiles` (see
   [Model awareness](#model-awareness)).
2. **Turn-failure detection is best-effort.** omp documents `agent_end` as a
   notification-only lifecycle event and does not specify a typed error
   payload for extensions. The extension inspects the final assistant
   message defensively (`stopReason` of `error`/`aborted`, `errorMessage`)
   and listens to `auto_retry_end` for exhausted provider retries. An
   unrecognizable payload is treated as success. Crash/shutdown recovery is
   independent of this and always resumes tasks that never finished.
   Content-policy ("cyber") rejections are likewise recognized by matching the
   error text (the wire wording is not a documented contract); an unrecognized
   variant falls through to the normal resume path rather than a context purge.
3. **The `--yolo` runtime flag cannot be verified.** omp keeps runtime flag
   overrides in memory only, so the pre-start check reads the persisted
   config files. A non-`yolo` result is a *warning with a confirm dialog*,
   not a hard block.
4. **No OS-level scheduling.** This is an in-process extension, not a
   daemon: the omp session must stay open and the machine awake. Disable
   sleep/hibernation for overnight runs.
5. **Shared session context.** Queued tasks run sequentially in the current
   omp session, so later tasks see earlier tasks' conversation (usually a
   feature; occasionally not). Long nights may trigger omp's automatic
   compaction — that is normal and handled by omp itself.
6. **Manual use while running.** The dispatcher fires after *any* agent turn
   ends, so finishing a manual turn can trigger the next queued task
   (aborting a scheduled turn pauses the queue, but a *completed* manual
   turn does not). Interacting for a while? `/scheduler pause` first.
7. **Content-policy purge is strongest once a command has run.** The reliable
   no-LLM context purge (`newSession`) is exposed by omp only on the command
   context, so the scheduler reuses the context captured from your last
   `/scheduler` command. In the normal flow — you run `/scheduler start` — that
   context is captured, so an overnight content-policy ("cyber") hit is purged
   with a fresh session. If a run is resumed purely from persisted state (omp
   relaunched with `run: running` and no `/scheduler` command issued yet), no
   command context exists, so the purge falls back to `compact`, which must
   summarize the poisoned transcript and may re-trip the classifier. Running any
   `/scheduler` command (e.g. `/scheduler status`) after launch restores the
   full `newSession` purge.

## Development

```bash
bun run check     # biome + typecheck (tsgo --noEmit)
bun run test      # behavioral smoke test against a mocked ExtensionAPI
```

The smoke test (`test/smoke.ts`) uses a throwaway `PI_CODING_AGENT_DIR`, so
it never touches your real queue or config. It covers dispatch/settle flow,
quota gating and window accounting, rate-limit holds, outage backoff,
watchdog recovery, abort-pause, crash recovery, retry, export, content-policy
context reset, batch parsing (verbatim + legacy JSON), self-describing `end`
log classification, and routing timers through the managed context.

## License

MIT — see the repository root [LICENSE](../../LICENSE).
