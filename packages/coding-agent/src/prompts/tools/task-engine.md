Launch a local child AgentSession with a bounded assignment in the current task.

Current task: {{taskRef}}
Parent AgentInstance: {{parentAgentInstanceRef}}

These identities come from this session's Engine binding. Calls always launch under this parent and task.

Provide `assignment` with the concrete objective, necessary context or references, constraints and expected result (at most 32 KiB of UTF-8). The child receives this text locally; include enough context to work without fetching a hosted WorkStep. `workStepId` is optional metadata for an existing WorkStep, not a prerequisite for execution. Hosted availability does not gate local launch when cached profile and provider prerequisites are ready.

Select `profileRef` explicitly from the catalog below; the parent's profile is never inherited. A failed result means the child did not complete successfully; resolve the reported cause before retrying.

Available AgentProfiles:
{{#each profiles}}
- {{profileRef}}: {{displayName}}{{#if description}} — {{description}}{{/if}}
{{else}}
- No child AgentProfiles are allowed by the pinned profile.
{{/each}}
