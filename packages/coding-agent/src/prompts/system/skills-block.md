<skills>
{{#if custom}}
{{#each skills}}
<skill name="{{name}}">
{{description}}
</skill>
{{/each}}
{{else}}
{{#each skills}}
- {{name}}: {{description}}
{{/each}}
{{/if}}
</skills>
