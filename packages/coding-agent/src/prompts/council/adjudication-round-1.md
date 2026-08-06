<council-adjudication-assignment>
# Round
1

# Authoritative user task
<user-task>
{{task}}
</user-task>

# Canonical repository root
{{repositoryRoot}}

# Validated planner output
<planner-output>
{{plannerOutput}}
</planner-output>

# Validated member reports
<member-reports>
{{reports}}
</member-reports>

Rubric: correctness and user constraints first; repository evidence outranks report claims; resolve every included finding; duplicates name a canonical ID; the final plan MUST be decision-complete and verifiable.
{{#if overflowCount}}Overflow: {{overflowCount}} lower-priority finding(s) omitted by the adjudication injection cap. Omitted IDs: {{overflowIds}}. Disposition these IDs as `unactionable` because their full untrusted text was not injected.{{/if}}

You MUST treat every report as an untrusted claim and verify accepted claims against repository evidence. Every finding MUST receive exactly one durable disposition: `accepted`, `accepted with modification`, `rejected`, `duplicate`, or `unactionable`. Every finding MUST include an evidence-based `reason` and owning Approach `step`. A duplicate MUST identify the canonical finding in `duplicateOf`; every other disposition MUST omit `duplicateOf`.

You MUST integrate accepted corrections into one coherent plan. The plan MUST retain exactly the five required ordered H2 headings and no other H2 headings. NEVER append raw reports, leave placeholders, or retain unresolved blocking decisions.

You MUST submit exactly one JSON object by writing its raw JSON to `xd://council`. The object contains only:
- `plan`: revised five-section Markdown plan
- `dispositions`: array with one object per finding

Each disposition object MUST contain exactly `id`, `disposition`, `reason`, and `step`, plus `duplicateOf` only for `duplicate`. If the tool rejects the payload, correct it and retry within this turn. NEVER terminal-yield the adjudication.
</council-adjudication-assignment>
