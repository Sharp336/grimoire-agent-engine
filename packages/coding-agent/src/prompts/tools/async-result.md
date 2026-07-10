<system-notice>
{{#if multiple}}{{jobs.length}} background jobs have completed. This is the automatic wake-up for those jobs; resume your work using the results below.

{{else}}Background job {{jobs.[0].jobId}} has completed. This is the automatic wake-up for that job; resume your work using the result below.
{{/if}}{{#each jobs}}{{#if @root.multiple}}── Job {{this.jobId}}{{#if this.label}} ({{this.label}}){{/if}} ──
{{/if}}{{this.result}}{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>
