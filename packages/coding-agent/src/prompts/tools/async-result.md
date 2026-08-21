<system-notice>
{{#if multiple}}{{jobs.length}} background jobs have finished. Resume your work using the results below.

{{else}}Background job {{jobs.[0].jobId}}{{#if jobs.[0].label}} ({{jobs.[0].label}}){{/if}} {{#if jobs.[0].failed}}failed{{else}}completed{{/if}}{{#if jobs.[0].bash}}{{#if jobs.[0].hasExitCode}} with exit code {{jobs.[0].exitCode}}{{else}}{{#if jobs.[0].failed}} without an exit code{{#if jobs.[0].timedOut}} (timed out){{/if}}{{/if}}{{/if}}{{/if}}. Resume your work using the result below.
{{/if}}{{#each jobs}}{{#if @root.multiple}}── Job {{this.jobId}}{{#if this.label}} ({{this.label}}){{/if}}: {{#if this.failed}}failed{{else}}completed{{/if}}{{#if this.bash}}{{#if this.hasExitCode}}, exit {{this.exitCode}}{{else}}{{#if this.failed}}, no exit code{{#if this.timedOut}} (timed out){{/if}}{{/if}}{{/if}}{{/if}} ──
{{/if}}{{this.result}}{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>
