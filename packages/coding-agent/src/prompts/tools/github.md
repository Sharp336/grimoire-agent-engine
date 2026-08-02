Op-based `gh` wrapper: repos, repository files, PRs, search, checkout, push, Actions watch. Read an issue/PR via `issue://<N>`/`pr://<N>`. PR diffs: `pr://<N>/diff` (file listing), `pr://<N>/diff/<i>` (file slice, 1-indexed), `pr://<N>/diff/all` (full diff).

<instruction>
Pick op via `op`. Beyond the field descriptions, per op:
- `repo_view` — omit `repo` to view the current checkout.
- `file_read` — reads `path` from `repo`; omit `repo` for the current checkout and `branch` for its default branch.
- `pr_create` — `head` defaults to the current branch.
- `pr_checkout` — checks PR(s) out into dedicated git worktrees, not your working tree; pass an array of `pr` to batch multiple in one call.
- `pr_push` — requires the branch to have been checked out first via `op: pr_checkout`.
- `search_issues`/`search_prs`/`search_commits`/`search_repos` — `query` is optional when `since`/`until` is set (omit it for a date-only filter). `search_code` supports neither: `query` is required and `since`/`until` are rejected.
- `search_*` default `repo` to the current checkout's `owner/repo`; pass a `repo:`/`org:`/`user:` qualifier in `query` to search elsewhere. `search_repos` is the exception — it ignores `repo`; scope it with `org:`/`language:` qualifiers in `query`.
- `since`/`until` — relative duration (`<n>` + `m`/`h`/`d`/`w`/`mo`/`y`, e.g. `3d`, `2w`), ISO date (`YYYY-MM-DD`), or ISO datetime. `dateField: "updated"` filters on update time (issues/PRs) or push time (repos), not creation.
- `run_watch` — omit `run` to watch every run for the current HEAD (`branch` falls back to current). Fast-fails on the first job failure.
- `project_view` (read) — show the kanban board. `project` is a bare number (needs `owner`) or a full project URL; `field` selects the single-select column field (defaults to `Status`); `limit` caps items (default 30, max 100). Every item line carries its node id `[PVTI_…]` for use in edits.
- `project_item_add` — add an existing issue/PR (`contentUrl`) to the project.
- `project_item_create` — create a draft item (`title`, optional `body`).
- `project_item_edit` — pass `itemId` OR `contentUrl` (resolved to the backing item), then at least one of `itemStatus` (column name within `field`, default `Status`), `title`, `body`. Title/body only work on draft items; issue/PR-backed items reject them (edit those via `gh issue edit`/`gh pr edit`).
- `project_item_delete` — pass `itemId` OR `contentUrl`; `archive: true` archives instead of deleting.
- `project_create` — create a project (`owner` + `title` required). `template` applies one of: `kanban`, `team_planning`, `feature_release`, `bug_tracker`, `iterative_development`, `product_launch`, `roadmap`, `team_retrospective`; omit/`blank` for a bare project. Templates are EMULATED, not cloned: the default Status field's options are rewritten and the template's signature fields are created (e.g. bug_tracker → Priority + Severity single-selects; feature_release/roadmap → a DATE field; iterative_development → a NUMBER field). Only ITERATION fields aren't supported (iterative templates substitute a NUMBER field). GitHub's built-in views/automations/insights are NOT replicated. For EXACT fidelity pass `copyFrom` (source project number/URL + `sourceOwner`) to clone via `gh project copy` — at most one of `template`/`copyFrom`; prepare a reusable source with `gh project mark-template`.
</instruction>

GitHub Projects V2 needs the `project` OAuth scope. If a project op fails with a missing-scope error, tell the user to run `gh auth refresh -s project`.

<output>
Concise summary per op. `run_watch` failures save full logs to a session artifact.
</output>

<critical>
GitHub-hosted repository file? MUST use `file_read`; NEVER `curl`/`wget`.
</critical>
