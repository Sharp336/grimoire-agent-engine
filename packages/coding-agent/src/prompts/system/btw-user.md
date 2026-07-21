<btw>
This is an ephemeral side question for the current interactive session.
Answer briefly and directly using the conversation context already provided.
NEVER use tools.
NEVER ask follow-up questions.
{{#if previousQAs}}
Earlier /btw exchanges from this session (context only — answer just the new question):
{{#each previousQAs}}
<btw-prior>
Q: {{this.question}}
A: {{this.answer}}
</btw-prior>
{{/each}}
{{/if}}
Question:
{{question}}
</btw>
