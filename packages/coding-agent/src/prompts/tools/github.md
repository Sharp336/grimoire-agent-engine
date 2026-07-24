`gh` op wrapper: repos/files, issue creation/state, PRs, search, checkout, push, Actions watch. Read specific issues/PRs: `issue://<N>`/`pr://<N>`. PR diffs: `pr://<N>/diff` (files); `pr://<N>/diff/<i>` (file slice, 1-indexed); `pr://<N>/diff/all` (full).

<instruction>
Select via `op`.
- Specific issue or hierarchy? Read its `issue://` URL first. Read parent once for direct-child status/progress; follow only returned child links for nested descendants or child body, comments, or assignees.
- Use `search_issues` for repository-wide discovery or assignee queries. GitHub “assigned” means assignees, NEVER attached/sub-issues.
- `repo_view`: omit `repo` → current checkout.
- `file_read`: read `path` from `repo`; omit `repo` → current checkout, `branch` → default branch.
- `issue_create`: nonblank `title` required. `parent` attaches new issue beneath one existing issue; `subIssues` attaches up to 100 deduplicated existing issues directly beneath new issue. References accept positive issue numbers or canonical HTTP(S) issue URLs on target repository's GitHub origin; same issue cannot be both parent and child.
- `issue_create` reparenting is destructive. `replaceParent` defaults `false`; only `replaceParent: true` explicitly opts existing `subIssues` into reparenting. `replaceParent` without `subIssues` is invalid. Parent assignment never reparents.
- Hierarchy attachment occurs after creation. Returned `WARNING` with `details.status: "partial"`: issue remains created; zero or more requested relationships may have applied. Surface URL, inspect hierarchy before retrying attachments, NEVER retry issue creation.
- Close/reopen with `issue_state`, NEVER raw `gh issue close`/`reopen`. `issue_state` mutates only explicitly listed issue numbers. Singular close/reopen targets only that issue; NEVER include sub-issues or descendants unless user explicitly requests. Group returned child numbers by repository; pass each same-repo batch as one `issue` array. Operation invalidates cached parent summaries. Updated/Already/Failed summary is verification; reread parent once only for refreshed hierarchy rollup, not every child. Use `?fresh=1` only after external/raw mutation or uncertain cache state.
- `pr_create`: `head` defaults current branch.
- `pr_checkout`: PR(s) → dedicated git worktrees, never working tree; array `pr` batches multiple in one call.
- `pr_push`: requires prior `op: pr_checkout`.
- `search_issues`/`search_prs`/`search_commits`/`search_repos`: `query` optional with `since`/`until`; omit for date-only filter. `search_code`: `query` required; rejects `since`/`until`.
- `search_*`: `repo` defaults current checkout's `owner/repo`; search elsewhere with `repo:`/`org:`/`user:` in `query`. `search_repos`: ignores `repo`; scope via `org:`/`language:` in `query`.
- `since`/`until`: relative `<n>` + `m`/`h`/`d`/`w`/`mo`/`y` (e.g. `3d`, `2w`), ISO date `YYYY-MM-DD`, or ISO datetime. `dateField: "updated"`: update time (issues/PRs), push time (repos), never creation.
- `run_watch`: omit `run` → every run for current HEAD; `branch` defaults current. Fast-fails first job failure.
</instruction>

<output>
Concise summary per op. `run_watch` failures save full logs to a session artifact.
</output>

<critical>
GitHub-hosted repository file: MUST use `file_read`; NEVER `curl`/`wget`.
</critical>
