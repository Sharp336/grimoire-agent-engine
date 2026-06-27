Op-based `glab` wrapper: repositories, merge request creation/checkout, and CI/CD pipeline status/listing. Read GitLab issues and merge requests via `issue://` and `pr://`; backend is inferred from the checkout remote.

<instruction>
Pick op via `op`. Beyond the field descriptions, per op:
- `repo_view` — omit `repo` to view the current GitLab checkout; `repo` accepts `GROUP/PROJECT`, nested namespaces, full URL, or Git URL.
- `mr_create` — `head`/`sourceBranch` selects the source branch; `base`/`targetBranch` selects the target branch; `fill: true` uses commit history and pushes through glab.
- `mr_checkout` — checks out an open merge request in the current worktree; use `branch` to override the local branch name.
- `pipeline_status` — reads current/latest pipeline status; `branch` selects the ref.
- `pipeline_list` — lists pipelines; `branch` maps to `--ref`, and `status` maps to GitLab pipeline status.
</instruction>

<output>
Concise markdown summary per op with source URLs when `glab` returns them.
</output>
