# User-Facing Packages

This page indexes README-only user-facing package CLIs and features that need root docs coverage beyond package-local READMEs/manifests.

## Root-docs policy

- **Include** root docs coverage for package-local CLIs, extension features, dashboards, and benchmark runners that users can run directly or through `omp`.
- **Exclude explicitly** when a package/crate is internal implementation only; point to the architecture doc that owns it.
- Package READMEs and manifests remain the source of truth for package-local setup and flags; root docs make the feature discoverable and link to exact source paths.
- Internal Rust crates remain covered by native architecture docs unless promoted as standalone user-facing commands or APIs. The contributor-facing map lives at [`native-crates.md`](./native-crates.md); today every `crates/*` entry is internal to `@oh-my-pi/pi-natives` and the embedded shell, so [`natives-architecture.md`](./natives-architecture.md) and the surrounding native docs own them.

## Package CLIs and features

### `packages/swarm-extension` — swarm orchestration

Sources: [`packages/swarm-extension/README.md`](../packages/swarm-extension/README.md), [`packages/swarm-extension/package.json`](../packages/swarm-extension/package.json), [`packages/swarm-extension/src/cli.ts`](../packages/swarm-extension/src/cli.ts), [`packages/swarm-extension/src/extension.ts`](../packages/swarm-extension/src/extension.ts).

- Package: `@oh-my-pi/swarm-extension`; bin: `omp-swarm`.
- Feature: multi-agent DAG orchestration from YAML swarms, supporting `pipeline`, `parallel`, and `sequential` modes.
- Standalone CLI: `omp-swarm path/to/swarm.yaml` runs until completion or process termination.
- TUI extension mode: add the package path to `extensions`, then use `/swarm run <file.yaml>`, `/swarm status <name>`, or `/swarm help`.
- Inputs: YAML under top-level `swarm` with `name`, `workspace`, `mode`, optional `target_count`/`model`, and `agents` with `role`, `task`, optional `model`, `waits_for`, and `reports_to`.
- Side effects/output: creates the workspace if needed and persists state/logs under `<workspace>/.swarm_<name>/`.
- Limits/errors: validates the YAML definition, dependency graph, and cycles before execution; standalone runs have no built-in timeout.

### `packages/metaharness` — Terminal-Bench 2 runner

Sources: [`packages/metaharness/README.md`](../packages/metaharness/README.md), [`packages/metaharness/package.json`](../packages/metaharness/package.json), [`packages/metaharness/src/runner.ts`](../packages/metaharness/src/runner.ts), [`packages/metaharness/agent/omp_local.py`](../packages/metaharness/agent/omp_local.py).

- Package: `@oh-my-pi/pi-metaharness`; bin: `metaharness` (dashboard/API); Harbor CLI via `bun packages/metaharness/src/runner.ts`.
- Feature: runs `harbor-framework/terminal-bench-2` against a local or published `omp` build with a live progress, spend, token, ETA, and pass/fail dashboard.
- CLI: `bun packages/metaharness/src/runner.ts harbor [options] [-- <extra harbor args>]`.
- Modes: default `omp` agent, `oracle`/`nop`/any Harbor agent via `--agent`; local source packing by default, published npm install via `--install published`; `cleanup` command removes leftover Harbor Docker resources.
- Key inputs: `--model`, `--tasks`, `--concurrency`, `--attempts`, `--include`, `--exclude`, `--dataset`, `--thinking` (alias `--effort`; in-container omp still receives `--thinking <level>` for published-build compat), `--advisor-model`, gateway options, `--tarball`, `--no-build`, `--dry-run`, and passthrough Harbor args.
- Outputs: Harbor job directories plus `_bench/<jobName>/report.md`, `harbor.log`, and generated `models.yml` under `--jobs-dir`.
- Side effects/limits: requires Docker, Harbor, and usually the host auth gateway; local install packs `packages/coding-agent`; web search is off by default because it cannot authenticate through the gateway; Alpine/musl task images are unsupported by the native prebuilds.

### `packages/stats` — local usage dashboard

Sources: [`packages/stats/README.md`](../packages/stats/README.md), [`packages/stats/package.json`](../packages/stats/package.json), [`packages/coding-agent/src/cli/stats-cli.ts`](../packages/coding-agent/src/cli/stats-cli.ts).

- Package: `@oh-my-pi/omp-stats`; bin: `omp-stats`; main user path: `omp stats`.
- Feature: local observability dashboard for AI usage statistics from session JSONL logs.
- CLI modes: `omp stats` starts the dashboard server, opens `http://localhost:3847`, and keeps running; `omp stats --port <port>` changes the port; `omp stats --summary` prints a console summary; `omp stats --json` prints JSON and exits.
- Programmatic API: exports helpers such as `syncAllSessions()` and `getDashboardStats()` for embedding.
- Inputs/storage: reads `~/.omp/agent/sessions/`; stores aggregates in `~/.omp/stats.db`.
- Outputs: dashboard metrics and API endpoints including `/api/stats`, `/api/stats/models`, `/api/stats/folders`, `/api/stats/timeseries`, and `/api/sync`.
- Side effects/limits: syncs session files before output; long-running dashboard stops on `Ctrl+C` and closes the stats database.

### `packages/typescript-edit-benchmark` — TypeScript edit benchmark

Sources: [`packages/typescript-edit-benchmark/package.json`](../packages/typescript-edit-benchmark/package.json), [`packages/typescript-edit-benchmark/src/index.ts`](../packages/typescript-edit-benchmark/src/index.ts), [`packages/typescript-edit-benchmark/src/runner.ts`](../packages/typescript-edit-benchmark/src/runner.ts), [`packages/typescript-edit-benchmark/src/tasks.ts`](../packages/typescript-edit-benchmark/src/tasks.ts), [`packages/typescript-edit-benchmark/src/report.ts`](../packages/typescript-edit-benchmark/src/report.ts).

There is no package README at this path today; the manifest and CLI entrypoint help are the cited package-local sources.

- Package: private `@oh-my-pi/typescript-edit-benchmark`; bin: `typescript-edit-benchmark`.
- Feature: benchmark suite for evaluating coding-agent edit success on TypeScript source-code mutation fixtures.
- CLI: `bun run bench:edit [options]` in source help; package scripts also expose `bun run src/index.ts` through `start`.
- Key inputs: provider/model, thinking level, runs per task, timeout, task concurrency, task IDs, max tasks, fixture directory or `.tar.gz`, edit variant/fuzzy settings, guided mode, retry/turn limits, output path, report format, fixture validation, and required tool-call flags.
- Fixtures: each task directory contains `prompt.md`, `input/`, `expected/`, and `metadata.json`; bundled distribution can use `fixtures.tar.gz`.
- Outputs: markdown or JSON benchmark reports under `runs/` by default, with live progress and optional conversation dumps.
- Side effects/limits: creates the repository `runs/` directory, extracts fixture archives to temp space, and runs agent sessions against copied fixtures; `--check-fixtures` validates fixture structure and exits.

### `packages/metaharness` — unified benchmark manager

Sources: [`packages/metaharness/README.md`](../packages/metaharness/README.md), [`packages/metaharness/package.json`](../packages/metaharness/package.json), [`packages/metaharness/src/server.ts`](../packages/metaharness/src/server.ts).

- Package: private `@oh-my-pi/pi-metaharness`; bin: `metaharness`.
- Feature: one dashboard, SQLite store, REST/SSE API, and normalized run/trace model for Harbor,
  TypeScript edit, and SnapCompact benchmarks.
- CLI: `bun run serve --port 4700` (or the package bin) starts the dashboard and API.
- Storage: state lives under `<jobs-dir>/_manager/metaharness.sqlite`; benchmark-native artifacts
  remain the filesystem source of truth and historical CLI runs are auto-discovered.
- Limits: deleting an experiment or run also deletes its job directories and is rejected while the
  target is running.

### `packages/browser-relay` — drive existing Chrome tabs

Sources: [`packages/browser-relay/README.md`](../packages/browser-relay/README.md), [`packages/browser-relay/package.json`](../packages/browser-relay/package.json), [`packages/coding-agent/src/tools/browser/relay/`](../packages/coding-agent/src/tools/browser/relay/).

- Package: private `@oh-my-pi/browser-relay`; user command: `omp browser-relay`.
- Setup: run `omp browser-relay install`, load the unpacked extension from
  `~/.omp/browser-relay/extension`, then set `browser.relay` or use `app.relay: true`.
- Behavior: the relay auto-starts through the global daemon broker; `app.target` selects a tab by
  URL/title substring, otherwise the visible tab is adopted.
- Security/limits: it binds loopback; use `--token` when local processes are untrusted. Chrome
  internal pages, DevTools, Web Store, extension pages, and tabs with DevTools open cannot attach.

### `packages/collab-web` — browser client for collaborative sessions

Sources: [`packages/collab-web/README.md`](../packages/collab-web/README.md), [`packages/collab-web/package.json`](../packages/collab-web/package.json), [`docs/collab.md`](./collab.md).

- Package: private `@oh-my-pi/collab-web`; production client: <https://my.omp.sh/>.
- Feature: browser guest UI for `/collab` sessions, including streaming transcript, tool cards,
  subagent views, prompts, and host interruption.
- Local paths: `bun run dev` serves the UI on port 3000; `bun run mock-host` runs an offline relay
  and scripted host; `bun run build` emits a static SPA under `dist/`.
- Constraints: non-local deployments require HTTPS and a reachable secure WebSocket relay. The room
  key stays in the URL fragment and is not sent to the relay.

### `packages/snapcompact` — bitmap context-compression API

Sources: [`packages/snapcompact/README.md`](../packages/snapcompact/README.md), [`packages/snapcompact/package.json`](../packages/snapcompact/package.json), [`packages/snapcompact/src/index.ts`](../packages/snapcompact/src/index.ts).

- Package: public `@oh-my-pi/snapcompact`; install with `bun add @oh-my-pi/snapcompact`; requires
  Bun 1.3.14 or newer.
- Feature: deterministic local serialization and PNG rendering of discarded conversation history
  for vision-model context compaction; no model call or API key is required.
- Public entrypoint includes `compact`, `render`, `renderMany`, `frames`, shape selection, text
  normalization/serialization, image budgets, and file-operation helpers.
- Runtime constraint: rasterization and PNG encoding require `@oh-my-pi/pi-natives`.
