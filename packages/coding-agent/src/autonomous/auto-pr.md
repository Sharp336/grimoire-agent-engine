--auto-pr is enabled.

After every completed, verified work unit:
- Ensure local changes are committed; `--auto-pr` implies committing completed work first.
- Ensure the branch is pushed to a remote head branch.
- Use the existing GitHub pull-request path: prefer the `github` tool `pr_create`; use `gh pr` only when the tool is unavailable.
- NEVER create a duplicate pull request for the same branch. If one already exists, report or update that PR instead.
- No local changes and no new commits? skip pull-request work.
