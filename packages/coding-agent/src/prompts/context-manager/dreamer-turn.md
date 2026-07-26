{{#if language}}
Write natural-language JSON fields in {{language}}.
{{/if}}

Task: {{task}}

<task-instructions>
{{instructions}}
</task-instructions>

<input-json>
{{payload}}
</input-json>

Analyze only the supplied input and evidence obtained through granted tools. Return the required JSON object.