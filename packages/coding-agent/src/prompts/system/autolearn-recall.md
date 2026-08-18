Procedural memory — {{count}} stored procedure{{#unless single}}s{{/unless}} recorded after {{failureCount}} failed `{{family}}` call{{#unless singleFailure}}s{{/unless}} look relevant.

{{#each procedures}}
- `skill://{{name}}` — {{description}}
{{/each}}

{{#if required}}
Read `skill://{{requiredName}}` before the next `{{family}}` attempt.
{{/if}}
These are advisory notes from earlier sessions, not ground truth: current repository state, tool output, and runtime evidence win. If the procedure does not fit, say so and continue.
