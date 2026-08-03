# wakeup

Schedules a session-owned, one-shot delayed wakeup. When the timer expires, OMP delivers the saved prompt as a follow-up turn and the agent resumes automatically.

The tool accepts:

- `delaySeconds`: integer delay from 1 through 86,400 seconds, inclusive.
- `prompt`: non-empty instruction to resume with when the delay elapses.

```json
{
  "delaySeconds": 600,
  "prompt": "Check CI again and report any remaining failures."
}
```

The call returns immediately with a background job id. Use `hub` with `op="jobs"` to inspect pending wakeups, or `op="cancel"` with the job id to cancel one.

`wakeup` is registered only for a top-level session with async job delivery. Task and eval subagents do not expose it because their remaining jobs are cancelled when the assignment settles, so they cannot promise a post-yield delayed turn. It is classified as an execution tool and follows the session's execution-approval policy.

Wakeups use a passive-job quota separate from execution capacity: pending timers do not occupy bash/task execution slots, but excess registrations reject at the configured manager limit. Wakeups require the owning OMP process and session to remain open and do not persist across restarts. For recurring checks, schedule another one-shot wakeup only after the current wakeup fires and the agent decides more waiting is needed.
