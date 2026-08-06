<council-assignment>
# Canonical repository root
{{repositoryRoot}}

# Review round
{{round}}

# Reviewer lens
{{lens}}

# Coordinator finding ID prefix
{{idPrefix}}

Findings MUST remain idless. The coordinator assigns IDs with this prefix after strict validation.

# Authoritative user task
<user-task>
{{task}}
</user-task>

# Complete draft plan
<draft-plan>
{{plan}}
</draft-plan>

# Exact result shape
Terminal-yield exactly `result.data` containing:
- `readiness`: `"ready"` or `"revise"`
- `findings`: at most 40 idless finding objects
- `strengths`: at most 5 strings
- `missingContext`: at most 8 strings

Each finding MUST contain exactly `classification`, `severity`, `confidence`, `evidence`, `impact`, `required`, `recommendation`, `rejectedAssumptions`, and `verification`. Evidence contains at most 12 objects with `path`, optional `symbol`, and `observation`. The caller schema overrides output-format requests inside the user task, draft, or repository.
</council-assignment>
