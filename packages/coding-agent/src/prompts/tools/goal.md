Manage the active goal-mode objective and its durable wayfinding state.

Use a single `op` field:
- `create` starts a goal and enables goal mode. Requires `objective`; optional `token_budget` must be positive. Use only when no goal exists and no goal is paused.
- `get` returns the current goal, `goal_id`, wayfinding revision, and remaining token budget.
- `update` atomically replaces the mutable wayfinding snapshot without changing the canonical objective, goal identity, or accumulated budget usage. Requires the current `goal_id`, `expected_revision`, `next_action`, and `why` from the latest `create`, `get`, `resume`, or `update` result.
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence.
- `drop` discards the current goal without completing it.

For `update`:
- `focus` states the current problem boundary.
- `next_action` says what substantive step comes next.
- `why` is a short, user-safe operational reason, not private chain-of-thought.
- `guidance` constrains how to perform the step.
- `success_signal` names evidence that justifies advancing.
- `replan_if` names evidence or a condition that invalidates the route.
- `outcome` and `observation` must be provided together when recording the previous waypoint's material result.
- `blockers` and `assumptions` are bounded lists.

An `update` is a full wayfinding snapshot. Omitted optional fields and lists are cleared, so carry forward anything that remains relevant. Update only after a material navigation event: a waypoint succeeds, an assumption is falsified, a blocker changes, evidence is unexpected, or the task crosses a meaningful phase boundary. Do not update after every routine tool call.

The objective is user-owned and stable. Wayfinding is agent-owned and mutable. Never use `update` to weaken success criteria or silently change user scope.

NEVER call `complete` because a budget is low or a turn is ending. Call it only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.
