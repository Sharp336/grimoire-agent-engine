Enter plan mode: switch to read-only planning before making any code changes.

Call this on your own initiative when a task is complex, multi-step, or ambiguous enough that an upfront plan reduces risk — or when the user asks you to plan, design, scope, or investigate before implementing. In plan mode the working tree is read-only (you may write ONLY the plan file), so you research, ground every claim in the real code, draft a plan, and then submit it for the user's approval. On approval, full write access is restored and implementation begins.

- `reason` (optional): one short sentence on why planning is warranted.

Do NOT call this when:
- the change is small and well-specified enough to implement directly, or
- you are already in plan mode, or
- you are in goal mode (exit it first).

After entering, follow the plan-mode workflow: draft the plan to `local://<slug>-plan.md`, then `resolve` with `action: "apply"` and `extra: { title: "<slug>" }` to submit it. You NEVER ask the user to switch modes in prose — call this tool instead.
