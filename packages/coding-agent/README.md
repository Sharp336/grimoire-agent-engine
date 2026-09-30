# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `oh-my-pi` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Managed Artel execution contracts

Managed execution uses runtime revision **17** and storage revision **21**.
The runtime JSON is byte-identical in Core, Engine, and UI; the Core storage
JSON and Engine fixture share one exact hash. Revision and hash must both
match before admission. Native CLI configuration is not an execution profile
for this boundary.

`EngineStartRequest` is the pre-admission command: normalized dispatch,
binding, verified origin receipt, and the complete authorized route roster.
Engine selects and acquires capacity atomically. Its accepted receipt supplies
the frozen `ExecutorChoice`; ClientHost seals `ImmutableAttemptStart` with the
execution and continuation digests. There is no extra operation or guessed
pre-admission selection. Only the admitted candidate list permits fallback.

Storage writes may carry `runtime.routing_admission` with
`acquire|renew|release|transfer|enqueue|cancel|dequeue`. The routing revision,
lease/queue/wait rows, and exact command receipt commit together. Approval
requests and decisions use the same existing durable effect/receipt namespace.
Current writes reject profile fields; frozen historical records are read-only.

The Core package-sequence floor is intentionally unallocated during source
implementation. Release must assign the registry sequence before enabling
Task v5, profile-free dispatch, and binding capabilities; pending floors deny
new admission.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
