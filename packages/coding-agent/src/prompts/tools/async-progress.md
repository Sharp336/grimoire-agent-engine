{{#if multiple}}The following background jobs are STILL RUNNING.{{else}}The following background job is STILL RUNNING.{{/if}} This is a progress update only; no action is required.

{{#each jobs}}
### {{jobId}} ({{elapsed}})

{{text}}
{{/each}}
