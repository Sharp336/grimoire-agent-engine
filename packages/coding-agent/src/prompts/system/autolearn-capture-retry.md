{{#if unnamed}}
No procedure was stored.
{{else}}
Nothing was stored for: {{#each families}}`{{this}}`{{#unless @last}}, {{/unless}}{{/each}}.
{{/if}}

Call `manage_skill` now to store it, or — if there is genuinely nothing reusable — say so in one sentence and stop. Do not repeat the analysis.
