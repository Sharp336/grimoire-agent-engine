# Thread Goals

Thread goals are an opt-in coding-agent feature for persisting one objective per session thread with token and active-turn time accounting.

Enable them in `~/.omp/config.yml`:

```yaml
goals:
  enabled: true
  continuationEnabled: true
  continuationModes: ["interactive"]
  defaultTokenBudget: 0
  recordContinuationsInTranscript: false
  statusInFooter: false
```

`defaultTokenBudget: 0` means no default budget. A positive value is used when a goal is created without an explicit budget.

## Commands

- `/goal set <objective> [--budget N]` creates or replaces the current thread goal and resets usage.
- `/goal show` displays objective, status, and token usage.
- `/goal pause` and `/goal resume` change status without changing objective or usage.
- `/goal budget <N|off>` updates the budget.
- `/goal clear` removes the goal.

## Model Tools

When `goals.enabled` is true, the model gets:

- `get_goal` to inspect current goal state. It returns `null` when no goal exists.
- `create_goal` to create a goal only after an explicit user or developer request.
- `update_goal` with only `{ "status": "complete" }`. Pause, resume, budget-limit, and abort transitions are system or user owned.

## Accounting

The implementation stores goals in `goals.sqlite` under the agent directory. Usage is keyed by `AgentSession.sessionId`, so sub-agent sessions and separate threads do not share goal state.

Token accounting includes non-cached input, output, and cache-write tokens. This intentionally diverges from Codex, whose token model does not have a separate cache-write bucket. Wall-clock accounting charges active agent turn windows only, not user idle time between turns.

## Continuation

After a normal assistant turn finishes with an active goal, no queued messages, and continuation enabled, the session can inject a developer continuation prompt rendered from `src/prompts/goals/continuation.md`. The objective is XML-escaped before interpolation. Empty continuation turns are suppressed until the goal changes or the user sends another prompt.

When token usage reaches the budget, the goal is marked `budget_limited`, a notice is emitted, and the session steers a one-shot developer wrap-up prompt rendered from `src/prompts/goals/budget_limit.md`.

## Codex Parity Notes

Documented divergences from `../codex/codex-rs/core/src/goals.rs`:

- OMP includes `cacheWrite` in goal token deltas because providers can bill cache creation separately.
- OMP charges active-turn wall time only, avoiding long human idle windows.
- OMP bypasses continuation during plan mode. Print mode uses one-shot session execution and is always bypassed.
- OMP emits goal update events to the extension event stream and supports a `goal_status_change` veto hook for status and budget transitions.
