<system-reminder>
These incomplete todos remain after compaction. Continue them; do not treat the summary or a text-only stop as completion.
{{#each phases}}
- {{name}}
{{#each tasks}}
  - [{{status}}] {{content}}
{{/each}}
{{/each}}
</system-reminder>
