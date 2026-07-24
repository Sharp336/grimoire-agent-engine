Manage derived project or session notes used by managed-context search.

Actions:
- `write`: requires `category` and `content`; defaults to session scope.
- `read`: returns visible notes, optionally by ID or filters.
- `filter`: filters by category, scope, or status.
- `update`: requires an ID and at least one changed field.
- `dismiss`: requires an ID and removes the note from active search without deleting it.

`surface_condition` records when an active note should be surfaced. Project notes cross sessions in the same stable worktree project; session notes remain bound to the current session.