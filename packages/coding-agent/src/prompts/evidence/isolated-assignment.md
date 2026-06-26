# Evidence investigation in an isolated snapshot

You are running in a disposable repo snapshot. Produce evidence only.

You may mutate only this disposable worktree. Do not attempt to apply changes to the parent repository. Do not create commits, branches, pull requests, or persistent side effects outside this snapshot.

Use the selected empirical lane to answer the question. Run the smallest commands, code experiments, compatibility checks, benchmarks, reproductions, or browser probes that directly answer it.

## Question
{{question}}

## Objective
{{objective}}

## Mode
{{mode}}

## Risk
{{risk}}

{{#if constraintsBlock}}
## Constraints
{{constraintsBlock}}
{{/if}}

Return only the structured output requested by the runtime. Include concise findings, commands run with observed outputs, sources or paths with excerpts, and caveats. Do not propose applying changes to the parent repo.
