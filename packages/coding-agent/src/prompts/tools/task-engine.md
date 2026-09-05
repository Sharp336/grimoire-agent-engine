Launch a child AgentSession for an existing Grimoire WorkStep in the current task.

Current task: {{taskRef}}
Parent AgentInstance: {{parentAgentInstanceRef}}

These identities come from this session's Engine binding. Calls always launch under this parent and task.

Use the mounted Grimoire `grimoire_task_context_get` tool to read this task's work tree, using the project_id and task_id from the current task ref. Select an existing WorkStep by its exact `id`, or use `grimoire_task_update` with the current revision to add the requested child WorkStep and its objective to this same task. Read each tool's mounted docs/schema before calling it through the available MCP or eval route; `read xd://` lists mounted devices. Do not invent a work-step tool or create a separate task to satisfy this launch.

Pass the WorkStep's `id` as `workStepId`, not a URI. Select `profileRef` explicitly from the catalog below; the parent's profile is never inherited. A failed result means the child did not complete successfully; resolve the reported cause before retrying.

Available AgentProfiles:
{{#each profiles}}
- {{profileRef}}: {{displayName}}{{#if description}} — {{description}}{{/if}}
{{else}}
- No child AgentProfiles are allowed by the pinned profile.
{{/each}}
