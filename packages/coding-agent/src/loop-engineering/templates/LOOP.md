# {{title}} Loop

Inspired by cobusgreyling/loop-engineering: https://github.com/cobusgreyling/loop-engineering

## Goal

{{goal}}

## Non-goals

{{#each non_goals}}
- {{this}}
{{/each}}

## Operating level

{{level}}

## Scope

{{#each scope_paths}}
- {{this}}
{{/each}}

## Budget and stop rules

- Max iterations per run: {{max_iterations}}
- Max files changed: {{max_files_changed}}
- Human approval required for protected paths, pushes, deploys, and ambiguous instructions.

## Verifier contract

The implementer cannot mark its own work done. `omp loop run {{name}}` runs verifier commands after the agent iteration and records the outcome in `{{run_log}}`.
