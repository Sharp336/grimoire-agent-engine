# Goal Feature — Adaptation Plan for oh-my-pi from codex

## 1. Recap

Per-thread persisted **Objective** w/ optional **token budget** + **wall-clock** accounting. Lifecycle:

- User/RPC creates → `Active` (one per thread).
- Each turn accounts non-cached input + output tokens + active-turn elapsed seconds.
- User turn finishes & goal still `Active` → runtime auto-spawns **continuation turn** w/ hidden developer prompt asking model to do completion audit.
- Usage ≥ budget → `BudgetLimited`; one-shot dev steer ("wrap up").
- Interrupt → auto-pause. Resume → restore active.
- Model can only flip `Complete` (`update_goal{status:complete}`); pause/budget/resume = system-owned.
- Plan + Print modes bypass everything; RPC/ACP off-by-default but settable.
- Objective XML-escaped in prompts (untrusted).

---

## 2. Mapping Codex → OMP

| Codex | OMP |
|---|---|
| `Session` (core) | `AgentSession` (`coding-agent/src/session/agent-session.ts`) |
| `TurnContext` / `Op::UserTurn` | `AgentSession.prompt(...)` + agent-loop run |
| `Codex.submit` / `inject_response_items` | `agent.steer()`, `AgentSession.continueGoal()` |
| `EventMsg::ThreadGoalUpdated` | New `AgentSessionEvent` variant `goal_updated` |
| `state_db` (sqlite) | `bun:sqlite` under agent dir (mirrors `memories/storage.ts`) |
| `get_goal` / `create_goal` / `update_goal` tools | New `AgentTool`s under `coding-agent/src/tools/goal/` |
| `Feature::Goals` | `goals.enabled` in `Settings` (default `false`) |
| `should_ignore_goal_for_mode(Plan)` | `planMode.enabled === true` OR mode == `print` short-circuit |
| `templates/goals/*.md` | `prompts/goals/{continuation,budget_limit}.md` (Handlebars) |
| Telemetry `GOAL_*_METRIC` | Deferred; TODO before stats integration |
| Continuation turn (`start_task` w/ developer msg) | `AgentSession.continueGoal()` synthetic path |
| Interrupt → pause | Hook in `agent.abort()` path inside `AgentSession` |
| Resume hook | `AgentSession` constructor / session-load path |

---

## 3. Where the code lives

**New module:** `packages/coding-agent/src/goals/`

```
goals/
  index.ts
  storage.ts         // bun:sqlite schema + CRUD
  runtime.ts         // GoalRuntime — accounting state + lifecycle dispatch
  accounting.ts      // token + wall-clock snapshot helpers (pure)
  prompts.ts         // render continuation/budget templates
  validate.ts        // objective + budget validation
  events.ts          // GoalRuntimeEvent union, GoalUpdatedEvent
  hooks.ts           // veto + observer hook plumbing (Q15)
  tools/
    create-goal.ts   + create-goal.md
    get-goal.ts      + get-goal.md
    update-goal.ts   + update-goal.md
    spec.ts
prompts/goals/
  continuation.md
  budget_limit.md
```

**Touch points (kept thin):**
- `coding-agent/src/session/agent-session.ts` — wire `GoalRuntime`, dispatch lifecycle events from existing handlers, expose `session.goals.*` API, emit `goal_updated`, implement `continueGoal()`.
- `coding-agent/src/tools/index.ts` — register goal tools when `goals.enabled`.
- `coding-agent/src/config/settings.ts` — `goals.enabled`, `goals.defaultTokenBudget?`, `goals.continuationEnabled`, `goals.statusInFooter`, `goals.recordContinuationsInTranscript`, `goals.continuationModes` (set of mode names where continuation runs; default `["interactive"]`).
- `coding-agent/src/slash-commands/` — new `/goal` command.
- `coding-agent/src/extensibility/extensions/types.ts` — add `goal_updated` to event union; add `goal_status_change` veto hook.

**Not touched:**
- `packages/agent` — `Agent` core stays goal-agnostic.
- `packages/ai` — no provider plumbing.
- `packages/stats` — telemetry deferred.

---

## 4. Storage (`goals/storage.ts`)

Single `bun:sqlite` file at `getAgentDir()/goals.sqlite` (separate from `memories.sqlite` to isolate locks/migrations). WAL + `busy_timeout=5000` like `memories/storage.ts`. One connection per session, lazily opened.

```sql
CREATE TABLE IF NOT EXISTS thread_goals (
  thread_id TEXT PRIMARY KEY,        -- AgentSession.sessionId  [Q1: session-scoped]
  goal_id TEXT NOT NULL,             -- snowflake; rotates on objective replace
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','budget_limited','complete')),
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_seconds INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Operations:
- `getGoal(threadId)` → `ThreadGoal | null`
- `insertGoal(threadId, objective, tokenBudget)` → fails if exists
- `replaceGoal(threadId, objective, status, tokenBudget)` → resets usage + new `goal_id`
- `updateGoal(threadId, { status?, tokenBudget?, expectedGoalId? })` → preserves usage; CAS via `expectedGoalId`
- `accountUsage(threadId, deltaTokens, deltaSeconds, mode, expectedGoalId)` → `{outcome:"updated"|"unchanged", goal}`; `mode` ∈ `ActiveOnly` (charge only Active) | `ActiveStatusOnly` (cap status only — interrupt path)
- `pauseActiveGoal(threadId)` → `Active → Paused`
- `clearGoal(threadId)` → `boolean`

Status transition inside `accountUsage`:
- `Active` + `tokens_used + delta ≥ budget` → `BudgetLimited` (only if budget set).
- All other transitions = explicit ops.

**Why separate DB, not JSONL row:** JSONL append-only + replayed on load; goal mutates per tool completion + needs fast point-read by `threadId`. Same as Codex + same as OMP `memories/`.

---

## 5. Runtime (`goals/runtime.ts`)

One `GoalRuntime` per `AgentSession`:

```ts
class GoalRuntime {
  #db: Database | null;                            // lazy open
  #threadId: string;
  #accounting: GoalAccountingSnapshot;             // turn baseline + active-turn wall-clock
  #budgetLimitReportedGoalId: string | null;       // debounce steering
  #continuationLock = new Mutex();
  #accountingLock = new Mutex();
  #continuationTurnId: string | null = null;       // marks synthetic turns
  #fizzledForGoalId: string | null = null;         // [Q5: empty-turn guard]
  #activeTurnStartedAt: number | null = null;      // [Q8: only charge active windows]
}
```

Dispatcher (Codex parity):

```ts
type GoalRuntimeEvent =
  | { kind: "turn_started"; turnId: string; usage: Usage }
  | { kind: "tool_completed"; turnId: string; toolName: string }
  | { kind: "tool_completed_goal"; turnId: string }
  | { kind: "turn_finished"; turnId: string; completed: boolean }
  | { kind: "maybe_continue_if_idle" }
  | { kind: "task_aborted"; turnId: string | null; reason: "interrupted" | "error" | "user" }
  | { kind: "external_mutation_starting" }
  | { kind: "external_set"; goal: ThreadGoal; previous: GoalStatus | "new" }
  | { kind: "external_clear" }
  | { kind: "thread_resumed" };

apply(event: GoalRuntimeEvent): Promise<void>
```

### Token-delta math [Q7: include `cacheWrite`]
```
nonCachedInput = max(usage.input - usage.cacheRead - last.input + last.cacheRead, 0)
cacheWriteDelta = max(usage.cacheWrite - last.cacheWrite, 0)
outputDelta = max(usage.output - last.output, 0)
delta = nonCachedInput + cacheWriteDelta + outputDelta
```
Document divergence from Codex (Codex has no `cacheWrite` concept; including it prevents agents gaming budget via cache-rewrite churn).

### Wall-clock [Q8: active-turn only]
- On `turn_started` → `#activeTurnStartedAt = Date.now()`.
- On `turn_finished` / `task_aborted` → `delta = (now - activeTurnStartedAt) / 1000`, account, then null out.
- During paused/idle/user-typing → no time accrues.
- Document divergence from Codex (Codex charges across pauses; OMP doesn't, because typical OMP sessions have long human-think windows).

### Fizzle suppression [Q5]
- On `turn_finished` for the continuation turn:
  - If assistant message has 0 tool calls AND token-delta ≤ 0 → set `#fizzledForGoalId = goalId`.
- `#fizzledForGoalId` cleared on:
  - any `external_set` / `external_clear`,
  - any user-attributed `prompt()` (non-synthetic),
  - any successful tool result other than from a continuation turn.
- `maybe_continue_if_idle` checks `#fizzledForGoalId !== currentGoalId` as a guard.

---

## 6. Hookup into `AgentSession`

| Existing site | New call |
|---|---|
| Start of `#runLoop` / first stream chunk | `goals.apply({kind:"turn_started", turnId, usage})` |
| `tool_execution_end` event | `goals.apply({kind:"tool_completed", turnId, toolName})` |
| `update_goal` tool result | `goals.apply({kind:"tool_completed_goal", turnId})` |
| `agent_end` handler | `goals.apply({kind:"turn_finished",...})` then `apply({kind:"maybe_continue_if_idle"})` |
| `agent.abort()` | `goals.apply({kind:"task_aborted", reason:"interrupted"})` |
| Session load / construct | `goals.apply({kind:"thread_resumed"})` |
| `setGoal/clearGoal/createGoal` public API | `external_mutation_starting → mutate → external_set/clear` |

### Continuation [Q3: option (c)]

New method:
```ts
class AgentSession {
  async continueGoal(developerText: string, opts: { goalId: string }): Promise<void>
}
```
Behavior:
1. Acquire `runtime.#continuationLock`.
2. Re-check guards: feature on, mode in `goals.continuationModes`, no active turn, no queued steer/follow-up, goal still `Active`, not fizzled.
3. Render `prompts/goals/continuation.md` (Handlebars; objective XML-escaped).
4. Build a developer-role message; tag with internal marker `__goalContinuation: { goalId }`.
5. Run agent-loop directly (NOT via `prompt()` — bypasses transcript persistence by default).
6. If `settings.goals.recordContinuationsInTranscript === true` → also append to JSONL transcript.
7. Always emit a TUI marker event `{ type: "notice", level: "info", message: "⟳ goal continuation", source: "goals" }` so the user sees the synthetic turn.
8. `runtime.#continuationTurnId = turnId`.

### Budget-limit steering [Q9: invisible]
When `accountUsage` flips to `BudgetLimited` mid-turn:
- Render `prompts/goals/budget_limit.md`.
- `agent.steer({ role: "developer", content: [{type:"text", text}] })` (depends on `agent.interruptMode === "immediate"` to land between tool calls; document).
- Set `#budgetLimitReportedGoalId = goalId` to debounce.
- Emit TUI notice `"⚠ goal budget reached"` (one-line marker, not the full prompt).

### Continuation visibility [Q9: visible]
The continuation developer message *is* shown in transcript (so user can see what model is asked). Setting `goals.recordContinuationsInTranscript` toggles whether it's also persisted to JSONL.

---

## 7. Tools (`goals/tools/`) [Q6: separate from todo-write]

Three `AgentTool`s registered in `tools/index.ts` only when `settings.goals.enabled`:

- **`get_goal`** — no params. Returns `{ goal, remainingTokens, completionBudgetReport: null }`.
- **`create_goal`** `{ objective: string; tokenBudget?: number }` — fails if a goal exists. Description = verbatim port from Codex: only on explicit user/dev request.
- **`update_goal`** `{ status: "complete" }` — enum **only** allows `"complete"`. Description forbids using to pause/budget/abort. Response includes `completionBudgetReport` for model to surface.

Tool descriptions live in `.md` files (per AGENTS.md "no inline prompts"); load via `import desc from "./create-goal.md" with { type: "text" }`.

Handler shape:
```ts
async run({ args, context }) {
  const session = context.session as AgentSession;
  await session.goals.applyExternalMutationStarting();
  const goal = await session.goals.create({ objective: args.objective, tokenBudget: args.token_budget });
  await session.goals.applyExternalSet(goal, "new");
  return goalToolResponse(goal, /* includeCompletionReport */ false);
}
```

Goal completion via `update_goal{complete}` does **not** auto-archive the session [Q16: option (c)] — user stays in same session; can follow up freely.

---

## 8. Sub-agents [Q2: option (a) — none]

The `task` tool's spawned sub-agent sessions:
- Do **not** inherit parent's goal.
- `get_goal` returns `null` (no goal exists for sub-agent's session id).
- `create_goal` is exposed but discouraged in sub-agent tool descriptions (we will not deny by default; users can still set one if they want).
- Token usage in sub-agent does **not** count against parent's budget.

Implementation: sub-agent sessions get their own `GoalRuntime` keyed by their own `sessionId`; storage row keyed independently.

Future flag (read-only inherit) not implemented now.

---

## 9. IRC / multi-thread [Q10]

No implicit goal transfer across IRC. Goal RPC is per-session. If agent A IRCs B about a goal, the textual reference is just text — B has no live goal state about A's goal.

---

## 10. Mode bypass [Q4]

`maybe_continue_if_idle` and budget-limit steering check:
```ts
if (planMode.enabled) return;                               // always bypass
if (mode === "print") return;                               // always bypass
if (!settings.goals.continuationModes.includes(mode)) return;
```
`goals.continuationModes` defaults to `["interactive"]`. Operators can opt-in `"rpc"` / `"acp"` via settings.

Account/state mutations (token deltas, status flips) still happen in all modes — only the *automatic continuation* + *budget steer injection* are gated. This matches Codex's behavior of always tracking but only auto-driving in non-Plan modes.

---

## 11. Slash commands & UX

`/goal` subcommands:
- `/goal set <objective> [--budget N]` → create/replace.
- `/goal show` → render w/ progress bar.
- `/goal clear` → drop.
- `/goal pause` / `/goal resume` → status flip (user-owned).
- `/goal budget <N|off>` → adjust budget without touching objective.

TUI (behind `goals.statusInFooter`):
- Footer pill: `🎯 active · 4.2k/10k · 03:41`.
- Toast on `BudgetLimited` and `Complete`.

---

## 12. Hooks / extensions [Q15: all three]

### (a) Observer
Add to `AgentSessionEvent` union:
```ts
| { type: "goal_updated"; goal: ThreadGoal | null; previous?: ThreadGoal | null }
```
Emitted on every status change, create, replace, clear, accounting flip.

### (b) Veto hook
New extension event `goal_status_change` (fires before commit):
```ts
type GoalStatusChangeEvent = {
  type: "goal_status_change";
  goal: ThreadGoal;          // current persisted state
  proposed: { status?: GoalStatus; tokenBudget?: number | null };
  reason: "tool" | "system" | "user" | "rpc";
};
type GoalStatusChangeResult = { allow: true } | { allow: false; reason?: string };
```
- Runtime calls `extensionRunner.emit(...)` before persisting any status transition.
- If any handler returns `allow:false`:
  - Tool path: surface error to model via `FunctionCallError` with handler's reason.
  - System path (auto budget-limit): swallow the transition, log warning, leave status as-is, do **not** debounce (so it can re-fire on next accounting).
  - User path (`/goal pause` etc.): surface error to user via TUI notice.
- Veto applies only to `status` and `tokenBudget`; `objective` replacement is not vetoable (it's a fresh goal).

### (c) Programmatic pause/resume
Extensions get `session.goals` accessor exposing:
```ts
{
  get(): Promise<ThreadGoal | null>;
  pause(): Promise<ThreadGoal | null>;
  resume(): Promise<ThreadGoal | null>;
  setBudget(n: number | null): Promise<ThreadGoal | null>;
  clear(): Promise<boolean>;
}
```
Each call goes through the normal `external_mutation_starting` → mutate → `external_set/clear` sequence (so veto hooks fire and observers see the change).

---

## 13. Settings [Q12: setting-based, no nudge]

```ts
interface GoalsSettings {
  enabled: boolean;                              // default false
  defaultTokenBudget?: number;                   // default unset
  continuationEnabled: boolean;                  // default true
  continuationModes: string[];                   // default ["interactive"]
  recordContinuationsInTranscript: boolean;      // default false
  statusInFooter: boolean;                       // default false
}
```
No first-run nudge. Discovery via docs + `/goal` typeahead.

---

## 14. Telemetry [Q13: deferred]

TODO: Add goals telemetry only when there is a concrete `packages/stats` integration. Keep the goal runtime free of no-op telemetry shims until metric names, attributes, and transport are defined.

---

## 15. Compaction / crash semantics [Q11, Q14]

- **Compaction**: token accounting independent — tracks billed tokens, not context. Compaction has zero effect on `tokens_used`. Confirmed.
- **Crash mid-turn**: partial token delta from last in-flight tool call lost. Same as Codex. Accepted.

---

## 16. Implementation phases

1. **Foundation** — schema + storage CRUD + types + validation + tests.
2. **Runtime** — `GoalRuntime` + accounting + lifecycle dispatcher (no continuation) + tests including cache-write delta and active-turn-only wall-clock.
3. **Session wiring** — events, public `session.goals.*` API, `goal_updated` variant. Continuation off.
4. **Tools** — three tools + descriptions + register behind feature flag.
5. **Continuation engine** — `continueGoal()`, fizzle suppression, mode bypass.
6. **Budget steering** — mid-turn dev message via `agent.steer()`.
7. **Pause-on-interrupt + resume restore.**
8. **Hooks/extensions** — observer event + veto hook + `session.goals` accessor.
9. **Slash commands** — `/goal …`.
10. **TUI footer + toasts** (behind setting).
11. **Telemetry TODO.**
12. **Docs** — README section + `docs/goals.md`.
13. **§17 Codex parity validation** (see below).

Acceptance per phase = test file (per AGENTS.md "test the contract").

---

## 17. Final validation — Codex parity audit

Before marking the feature done, run a checklist diff against `../codex/codex-rs/core/src/goals.rs`. For each Codex behavior, assert OMP either matches or has a documented divergence with rationale.

### Checklist (auto-generated from Codex source review)

| # | Codex behavior | OMP expectation | How to verify |
|---|---|---|---|
| 1 | One goal per thread; replace resets usage | Same | Test: replace goal → usage zeroed |
| 2 | `update_goal` only allows `complete` | Same | Test: tool schema enum = `["complete"]` |
| 3 | `create_goal` fails if goal exists | Same | Test: second `create_goal` errors |
| 4 | Validate objective non-empty + bounded | Same | Test + reuse Codex's validator semantics |
| 5 | Validate budget > 0 when set | Same | Test |
| 6 | Token delta = non-cached input + max(output, 0) | OMP adds `cacheWrite` (divergence #A — documented) | Unit test on accounting helper |
| 7 | Wall-clock advances by accounted seconds across pauses | OMP charges only active-turn windows (divergence #B — documented) | Unit test |
| 8 | Plan mode bypass | OMP also bypasses `print` (divergence #C — documented) | Integration test in plan + print modes |
| 9 | Continuation injects developer message after user turn finishes if Active + idle | Same via `continueGoal()` | E2E test: prompt → tool → end → continuation fires |
| 10 | Continuation suppressed if any queued user input / mailbox / active turn | Same — OMP checks `agent.hasQueuedMessages()` + `isStreaming` | Test |
| 11 | Empty continuation turn = fizzle, no further auto-continue until reset | Same | Test: model returns no tool calls + 0 tokens → no second continuation |
| 12 | Budget-limit steer injected once per goal_id; reset when status leaves BudgetLimited | Same | Test: two budget-overshoot ticks → only one steer |
| 13 | Interrupt → goal auto-paused | Same — `task_aborted{interrupted}` → `pauseActiveGoal` | Test: ctrl-c equivalent → goal pauses |
| 14 | Resume → restore active wall-clock baseline | Same | Test: load session w/ Active goal → next turn accounts correctly |
| 15 | Objective XML-escaped in continuation + budget prompts | Same | Test: objective containing `</untrusted_objective>` → escaped |
| 16 | `update_goal{complete}` returns final-budget report string | Same | Test on tool response shape |
| 17 | Account before external mutation (best-effort) | Same — `external_mutation_starting` triggers wall-clock + token account | Test: set goal mid-turn → usage charged before status flip |
| 18 | Status flip to non-Active clears active-goal accounting | Same | Test |
| 19 | `tokens_used` and `time_used_seconds` persisted on every tool completion | Same | Test: count sqlite writes per turn |
| 20 | Continuation prompt template includes completion-audit instructions verbatim | Same — `prompts/goals/continuation.md` is text-port of `templates/goals/continuation.md` | Diff prompts side-by-side |
| 21 | Budget-limit prompt template forbids calling `update_goal` unless complete | Same | Diff prompts |
| 22 | `get_goal` returns `null` when none exists (not error) | Same | Test |
| 23 | All goal mutations emit `ThreadGoalUpdated` event | OMP emits `goal_updated` | Test: subscribe → assert sequence |
| 24 | Sub-agents not goal-aware | Same — sub-agent sessions get own runtime, no inherit | Test: sub-agent's `get_goal` → null |
| 25 | Per-session sqlite isolation | OMP uses single shared sqlite keyed by `thread_id` (acceptable since PK isolates) | Test: two sessions in parallel don't cross-contaminate |

### Documented divergences (intentional)

- **#A — `cacheWrite` included in token delta.** Provider-billed; excluding lets agents game budget. OMP includes it.
- **#B — Wall-clock charges active-turn windows only.** OMP human-think windows can be hours; Codex charges across pauses. OMP doesn't.
- **#C — `print` mode also bypasses continuation.** OMP `print` mode is one-shot; continuation makes no sense.
- **#D — Veto hook for status transitions.** OMP exposes `goal_status_change` extension hook (Codex has none).
- **#E — Continuation visible in transcript by default; persisted only on opt-in.** Codex hides continuation from transcript; OMP shows so user sees what model is asked, but doesn't persist unless `goals.recordContinuationsInTranscript=true`.

### Validation procedure

1. Run all tests added in phases 1-12.
2. Run `bun test` at the workspace root — full suite must pass (per AGENTS.md, no test-isolation regressions).
3. Walk through the 25-item table above; for each row, point at the test file + line that asserts the contract. Open issue for any unchecked row.
4. Manual smoke: in interactive mode, set a goal w/ small budget (1000 tokens), run a real task, observe:
   - continuation fires when user is idle,
   - budget-limit steer arrives once,
   - interrupt → status `paused`,
   - `/goal resume` → next turn accounts correctly,
   - `update_goal{complete}` → final budget report shown,
   - session stays active afterward.
5. Diff `prompts/goals/continuation.md` and `prompts/goals/budget_limit.md` against the Codex versions; assert text equivalence except for OMP-specific phrasing where applicable. Document any divergence in `docs/goals.md`.
6. Sign off: tag PR with `goals-parity-audited`.

---

## 18. Risks / non-obvious

- **Continuation infinite loop** without fizzle suppression — load-bearing per §5.
- **Steer mid-turn race**: `agent.steer()` only lands between tool calls under `interruptMode === "immediate"`. Document.
- **Sqlite write contention**: WAL + busy_timeout=5000; single connection per session.
- **Test isolation**: temp sqlite file per test; no global mutation per AGENTS.md.
- **Veto hook surface area**: status veto can deadlock auto budget-limit if a buggy extension always denies. Mitigation: log + leave status as-is + don't debounce (so it stays detectable).

---

**Ready to start phase 1 on user signoff.**
