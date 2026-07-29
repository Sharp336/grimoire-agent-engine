Workflow: {{workflowId}}
Objective: {{objective}}
Node: {{nodeId}}
{{#if hasDependencies}}
Dependencies:
{{#each dependencies}}
- {{id}}: {{status}}{{#if references}} ({{references}}){{/if}}
{{/each}}
{{else}}
Dependencies: none
{{/if}}
Use the dependency references for prior results; do not assume their full transcripts were inlined.
