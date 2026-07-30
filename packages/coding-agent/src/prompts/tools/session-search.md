Search persisted OMP session transcripts, including pre-compaction content.

<instruction>
- `scope` defaults to the current project; use `all` for cross-project history.
- `session` narrows to one exact or uniquely prefixed session ID.
- `role` filters persisted user, assistant, tool, or summary entries.
- Results are newest-first. Continue with the returned `offset`.
</instruction>

<critical>
- Use this for transcript contents; `history://session` only filters metadata.
- Read a matched transcript with `history://session/<id>`.
- Search covers persisted content only; an unflushed live turn is absent.
</critical>
