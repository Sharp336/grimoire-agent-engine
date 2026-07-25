<!-- Hidden planning turn. role=user, suppressed from visible transcript. -->

Plan this mission, then call `mission({op:"set_plan", plan})` once with a complete plan.

{{#if goal}}
<goal>
{{goal}}
</goal>
{{else}}
No goal was supplied. Ask for one through the existing UI bridge (`ask` / parent approval UI). Do not call `set_plan` until the goal is nonempty.
{{/if}}

<procedure>
1. Take the goal above, or obtain a nonempty goal via the UI when empty.
2. Build one complete plan: `goal`, `runbook` (`setup`, `services`, `userTests`), ordered `milestones`, and ordered `features`.
3. Every implementation feature appears in exactly one milestone's `featureIds`, and that milestone id equals the feature's `milestoneId`.
4. Default every milestone's `validators` to `scrutiny` plus `user-testing` when the runbook supports user-testing (at least one `userTests` command or service); otherwise `scrutiny` alone.
5. Give each feature concrete `preconditions`, nonempty `expectedBehavior`, and optional `skillName` only when an existing loaded skill applies.
6. Call `mission({op:"set_plan", ...})` with that full plan. This turn's job ends at a successful `set_plan`.
</procedure>

<critical>
- You NEVER start workers or call `run_next` on this turn.
- You NEVER submit a partial plan. Empty goals, empty validator lists, mismatched milestone membership, or `user-testing` without runbook support will be rejected.
- You NEVER invent skills that are not in the session inventory.
</critical>
