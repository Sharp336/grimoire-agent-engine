# OMP Loop Engineering

`omp loop` is an out-of-process loop runtime for scheduled-safe agent iterations. It is inspired by [cobusgreyling/loop-engineering](https://github.com/cobusgreyling/loop-engineering), but the templates and runtime here are OMP-native and written for this repository.

It does not replace the interactive `/loop` slash command. `/loop` repeats the next prompt inside a live TUI session. `omp loop ...` manages durable loop specs, readiness checks, one-shot scheduled runs, verifier commands, and run logs that an external scheduler can call repeatedly.

## Commands

```bash
omp loop init daily-triage
omp loop check daily-triage
omp loop run daily-triage --dry-run
omp loop run daily-triage
omp loop status --json
```

## Files

`omp loop init <name>` creates:

- `.omp/loops/<name>.loop.yaml` — machine-readable loop spec
- `LOOP.md` — human-readable loop contract
- `STATE.md` — durable state/handoff notes
- `loop-budget.md` — caps and kill switch
- `loop-run-log.md` — append-only Markdown run log

`omp loop run <name>` also appends JSONL records under `.omp/loop-runs/<name>.jsonl`.

## Runtime model

One `omp loop run <name>` call performs exactly one iteration:

1. Parse and validate `.omp/loops/<name>.loop.yaml`.
2. Build the agent prompt from a static Markdown template.
3. Run one OMP agent turn in-process.
4. Run verifier commands from the loop spec for assisted/autonomous loops only.
5. Inspect changed files since the pre-run git baseline for scope, max-file, and denylist guardrails.
6. Append redacted durable JSONL and Markdown run records.

Schedulers stay outside OMP. Use cron, launchd, GitHub Actions, PM2, or another supervisor to repeat `omp loop run <name>` on a cadence. Use single-flight scheduler settings so two runs never share the same worktree at once.

## Safety levels

- `report` — report-only loops. OMP disables MCP, extension discovery, and project custom-tool discovery, restricts active tools to read/grep/glob/web search, and does not run verifier commands.
- `assisted` — may make bounded local changes, but verifier commands and approval gates are required.
- `autonomous` — requires verifier results, explicit human-approval guardrails for protected actions, and a clean observable git worktree.

## Spec shape

```yaml
loop:
  name: ci-sweeper
  goal: Fix one failing CI issue and report the result.
  level: assisted
  non_goals:
    - Do not deploy.
  scope:
    paths: ["."]
  trigger:
    type: manual
    cadence: daily
  runner:
    prompt: Inspect CI and make one safe fix.
  verifier:
    separate: true
    commands:
      - ["bun", "run", "check"]
  guardrails:
    max_iterations: 1
    max_files_changed: 5
    require_human_approval:
      - protected_paths
      - push
      - deploy
  state:
    file: STATE.md
    run_log: loop-run-log.md
    budget: loop-budget.md
```

Verifier commands must be argv arrays (or objects with an `argv` array) and, by default, must use package-script forms such as `["bun", "run", "check"]`, `["pnpm", "run", "test"]`, or `["npm", "test"]`. Shell strings, shell executables, custom binaries, and arbitrary absolute paths are intentionally not accepted. OMP reads the selected package script, validates it fail-closed, snapshots verifier inputs, then executes the parsed local runtime command directly with a minimal verifier environment and sanitized `PATH` instead of delegating to package-manager script `PATH` lookup. The selected package script must execute a local verifier entrypoint through an approved runtime such as `node verify.js` or `bun ./verify.ts`; selected `pre<name>`/`post<name>` lifecycle hooks, nested package-manager invocations, runner subcommands, pre-entrypoint flags, shell metacharacters, bare package imports, dynamic import/require forms, dangerous builtins, dynamic-code APIs, process-execution APIs, URL operands, directories, symlinks, unsafe `PATH` values, and verifier references that escape the project are rejected before the agent runs. Treat loop specs and their package scripts as trusted executable configuration: do not run specs modified by untrusted PRs or branches.

## Exit codes and guardrails

- `passed` and `dry_run` exit 0.
- `failed` and `needs_approval` exit non-zero so external schedulers can page or stop.
- Assisted/autonomous loops require git status visibility. A missing git worktree, unobservable changed-file status, out-of-scope edit, denylist hit, or dirty pre-run baseline moves the run to `needs_approval`.
- State paths and verifier working directories must stay inside the project. Markdown run logs are limited to `loop-run-log.md` or `.omp/loop-runs/*.md`, and run logs reject symlink targets.
