--auto-group-pr is enabled.

After completed, verified work:
- Publish through one shared pull request for this autonomous run, not one pull request per work unit.
- Ensure local changes are committed to the shared PR branch and pushed before continuing.
- If the shared pull request already exists, update that PR by pushing new commits and reporting or updating the same PR. NEVER create a duplicate pull request for the same autonomous run.
- `--auto-group-pr` overrides `--auto-pr` when both are enabled.
- No local changes and no new commits? skip pull-request work.
