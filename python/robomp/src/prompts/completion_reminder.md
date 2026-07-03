You ended your turn before finishing.

Issue: {{repo.full_name}}#{{issue.number}} — {{issue.title}}
Branch: `{{workspace.branch}}`

You classified this issue and reproduced the bug, but did NOT reach a turn-ending action. Acceptable turn-ending actions for a `bug` / `documentation` issue are exactly one of:

1. `gh_open_pr` — you committed the fix; `gh_open_pr` pushes the branch, runs the duplicate-PR guard, and opens the PR (do NOT call `gh_push_branch` separately first).
2. `gh_post_reference_comment` — an existing fix already covers this issue (e.g. another open PR, or the duplicate-PR guard refused `gh_open_pr` because a fix is already in flight). Post a comment referencing the existing fix; this ends the task cleanly without opening a duplicate PR.
3. `mark_unable_to_reproduce` — you genuinely cannot reproduce after a real attempt and need reporter-provided reproduction details.
4. `abort_task` — unrecoverable environment failure.

Review your TodoList and the prior tool calls, then continue from where you stopped. Do NOT re-classify, do NOT re-post the same preamble comment. If your fix is already drafted in the worktree, commit, push, and open the PR now. If the duplicate-PR guard refused `gh_open_pr`, do NOT retry `gh_open_pr` — discard any drafted duplicate fix (revert or delete uncommitted changes, drop the branch if you created one) so the worktree reflects the existing fix, then call `gh_post_reference_comment` instead. If you have not yet edited any source files, do the fix and continue through to PR.

You MUST end this turn by calling one of the four turn-ending tools listed above.
