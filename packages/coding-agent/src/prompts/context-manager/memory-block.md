{{#if project}}
<project-memory{{#if project.bank}} bank="{{project.bank}}"{{/if}}>
{{#each project.records}}
<memory id="{{id}}" score="{{score}}"{{#if source}} source="{{source}}"{{/if}}>
{{content}}
</memory>
{{/each}}
</project-memory>
{{/if}}
{{#if user}}
<user-profile{{#if user.bank}} bank="{{user.bank}}"{{/if}}>
{{#each user.records}}
<memory id="{{id}}" score="{{score}}"{{#if source}} source="{{source}}"{{/if}}>
{{content}}
</memory>
{{/each}}
</user-profile>
{{/if}}
