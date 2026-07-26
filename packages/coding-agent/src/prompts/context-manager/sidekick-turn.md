{{#if language}}
Write the augmentation in {{language}}.
{{/if}}

Find context that would materially help the primary agent answer this pending user prompt:

<user-prompt>
{{prompt}}
</user-prompt>

Return only the concise augmentation or `NO_RELEVANT_CONTEXT`.