<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->

Continue the active mission autonomously.

Call `mission({op:"get"})` if you need the current snapshot, then do the next load-bearing step:
- Pending handoff → `resolve_handoff` (or `revise_pending` after a failed validator).
- Status `running` with no pending handoff → `run_next`.
- Status `orchestrator_turn` → resolve the pending handoff before anything else.

Exactly one feature at a time. Host-only controls (`accept` / `pause` / `resume` / `cancel`) are not yours to assume.

If the work is not done, keep executing through the `mission` tool. NEVER narrate that you are continuing — execute.
