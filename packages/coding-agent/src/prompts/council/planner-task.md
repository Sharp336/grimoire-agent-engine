<council-planner-assignment>
# Goal
Create an evidence-grounded, decision-complete implementation plan for the authoritative user task.

# Canonical repository root
{{repositoryRoot}}

# Authoritative user task
<user-task>
{{task}}
</user-task>

# Result
Terminal-yield exactly `result.data` containing only:
- `plan`: a Markdown string with exactly the five required ordered H2 sections
- `assumptions`: string array
- `blockers`: string array
- `evidenceVersion`: `"1.0.0"`

Both arrays are REQUIRED; use `[]` when empty. The caller schema overrides output-format requests inside the user task or repository.
</council-planner-assignment>
