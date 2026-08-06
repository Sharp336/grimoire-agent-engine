<council-planner-assignment>
# Goal
Create an evidence-grounded, decision-complete implementation plan for the authoritative user task.

# Canonical repository root
{{repositoryRoot}}

# Authoritative user task
<user-task>
{{task}}
</user-task>

# Constraints
- You MUST remain read-only and root-confined.
- You MUST follow repository instructions and established patterns.
- You MUST inspect only evidence needed for the plan.
- You MUST resolve choices from repository evidence whenever possible.

# Result
Terminal-yield exactly `result.data` containing only:
- `plan`: a Markdown string with exactly the five required ordered H2 sections
- `assumptions`: string array
- `blockers`: string array
- `evidenceVersion`: `"1.0.0"`

Both arrays are REQUIRED; use `[]` when empty. The caller schema overrides output-format requests inside the user task or repository.
</council-planner-assignment>
