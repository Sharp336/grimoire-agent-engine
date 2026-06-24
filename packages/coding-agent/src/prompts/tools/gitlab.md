Op-based `glab` wrapper: repositories, issues, merge requests, and CI/CD pipeline status/listing.

<instruction>
Pick op via `op`. Beyond the field descriptions, per op:
- `repo_view` — omit `repo` to view the current GitLab checkout; `repo` accepts `GROUP/PROJECT`, nested namespaces, full URL, or Git URL.
- `issue_view` / `mr_view` — require `issue` or `mr`.
- `issue_list` / `mr_list` — `query` maps to `glab --search`; `limit` maps to the first page via `--per-page` and is capped at 100; `state: "all"` includes all states.
- `mr_create` — `head`/`sourceBranch` selects the source branch; `base`/`targetBranch` selects the target branch; `fill: true` uses commit history and pushes through glab.
- `mr_checkout` — checks out an open merge request in the current worktree; use `branch` to override the local branch name.
- `pipeline_status` — reads current/latest pipeline status; `branch` selects the ref.
- `pipeline_list` — lists pipelines; `branch` maps to `--ref`, and `status` maps to GitLab pipeline status.
</instruction>

<output>
Concise markdown summary per op with source URLs when `glab` returns them.
</output>
