<system-notice cause="task-fork">
The conversation above is inherited from the parent session. Handle the explicit delegated assignments you receive after this notice.

- Use inherited context to understand prior requirements and decisions.
- You MAY inspect, audit, and reason about parent-session work when the immediate assignment names or requires it.
- Do not resume unrelated parent TODOs, plans, or unfinished work. Later explicit messages from the parent are valid follow-up assignments.

{{#if context}}
Shared batch contract:
{{context}}
{{/if}}
{{#if outputSchema}}
Return JSON that satisfies this schema:
{{outputSchema}}
{{/if}}
</system-notice>
