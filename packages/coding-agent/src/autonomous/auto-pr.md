--auto-pr is enabled.

After every completed, verified work unit:
- Ensure local changes are committed on a pull-request branch; `--auto-pr` implies committing completed work first.
- NEVER treat a local commit alone as complete when `--auto-pr` is enabled. Push the branch and create or update a pull request before continuing.
- Do not commit completed autonomous work directly to the default/main branch when `--auto-pr` is enabled; it must be merged through the pull request.
- Use the existing GitHub pull-request path: prefer the `github` tool `pr_create`; use `gh pr` only when the tool is unavailable.
- NEVER create a duplicate pull request for the same branch. If one already exists, report or update that PR instead.
- No local changes and no new commits? skip pull-request work.
