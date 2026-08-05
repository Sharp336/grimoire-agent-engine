Drive an active mission through its lifecycle. This tool is parent-only and available only while a mission is running; you orchestrate here and NEVER implement feature work in the parent checkout.

Use a single `op` field per call:
- `get` — return the current mission snapshot (status, plan, active feature, pending handoff, retry budget). Carries no other fields. Call it whenever the status is unclear.
- `set_plan` — submit one complete `plan` (`goal`, `runbook`, ordered `milestones`, ordered `features`). Valid only while planning; rejected once the plan is accepted. Every implementation feature must appear in exactly one milestone's `featureIds`, and that milestone id must equal the feature's `milestoneId`.
- `run_next` — dispatch exactly one next pending feature. Returns that feature's handoff, or reports that nothing is runnable. Resolve any pending handoff before calling it, and never attempt parallel dispatch.
- `resolve_handoff` — clear the pending handoff. `decision` is one of `accept`, `retry_same`, `retry_fresh`, `cancel_feature`, `pause`. Include `message_to_worker` to carry guidance into a retry.
- `revise_pending` — after a failed validator handoff, supply nonempty `add_features` remediation specs. The runtime inserts them before that milestone's validators and resets those validators. Prefer this over blind retries when the gap is concrete.

`accept`, `pause`, `resume`, and `cancel` are host controls (`/mission` or RPC), never tool ops — never attempt them through this tool, and never assume they happened. When status is unclear, call `get`.
