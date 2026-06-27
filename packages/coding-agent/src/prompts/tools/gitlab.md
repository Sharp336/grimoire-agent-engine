Op-based `glab` wrapper for merge request creation and checkout. Read GitLab issues and merge requests via `issue://` and `pr://`; backend is inferred from the checkout remote.

<instruction>
Pick op via `op`. Beyond the field descriptions, per op:
- `mr_create` — `head`/`sourceBranch` selects the source branch; `base`/`targetBranch` selects the target branch; `fill: true` uses commit history and pushes through glab.
- `mr_checkout` — checks out an open merge request in the current worktree; use `branch` to override the local branch name.
</instruction>

<output>
Concise markdown summary per op with source URLs when `glab` returns them.
</output>
