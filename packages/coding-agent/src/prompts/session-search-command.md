Search past session transcripts for this question.

Question: {{question}}

Transcript DB: `{{dbPath}}`
Project session directory: `{{sessionDir}}`

<instruction>
- Spawn the bundled `session-search` agent via the `task` tool with `agent: "session-search"`. Put the question, `{{dbPath}}`, and `{{sessionDir}}` in the task brief so the agent can query the index and open session JSONL.
- Default scope is this project's session directory only (`{{sessionDir}}`). Do not search other projects.
- Broaden scope ONLY when the user explicitly asks about other projects: reindex with `sessionDirs` spanning the subdirectories of `getSessionsDir()`, then spawn again. Never broaden otherwise.
- Relay the agent's cited answer to the user. Keep `{sessionId, entryId, quote}` citations intact. If nothing matched, say so plainly.
</instruction>
