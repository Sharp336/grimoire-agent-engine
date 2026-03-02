# Codebase Structure

**Analysis Date:** 2026-03-02

## Directory Layout

```text
oh-my-pi/
├── packages/              # Bun workspace packages (runtime, libs, extensions)
├── crates/                # Rust crates (native execution/bindings)
├── docs/                  # Internal architecture and runtime docs
├── scripts/               # Release/setup/sync automation scripts
├── .planning/codebase/    # Codebase mapping docs consumed by GSD workflows
├── assets/                # Shared static assets
├── types/                 # Shared ambient type declarations
├── package.json           # Workspace scripts and task orchestration
└── Cargo.toml             # Rust workspace manifest
```

## Directory Purposes

**`packages/coding-agent`:**
- Purpose: Main product package and composition root.
- Contains: CLI entrypoints, command adapters, runtime modes, session management, tools, MCP/LSP/extensibility integrations.
- Key files: `packages/coding-agent/src/cli.ts`, `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/tools/index.ts`.

**`packages/ai`:**
- Purpose: Model/provider layer and auth/discovery for AI APIs.
- Contains: Provider adapters, OAuth flows, schema compatibility utilities, model descriptors.
- Key files: `packages/ai/src/index.ts`, `packages/ai/src/providers/*.ts`, `packages/ai/src/utils/oauth/*.ts`.

**`packages/agent`:**
- Purpose: Core agent loop primitives independent of CLI/TUI.
- Contains: Agent loop, proxy types, loop orchestration.
- Key files: `packages/agent/src/agent-loop.ts`, `packages/agent/src/agent.ts`.

**`packages/tui`:**
- Purpose: Terminal UI components and interaction primitives.
- Contains: Core `tui` runtime plus composable components.
- Key files: `packages/tui/src/tui.ts`, `packages/tui/src/components/*.ts`.

**`packages/natives`:**
- Purpose: TypeScript bindings for native Rust-backed operations.
- Contains: Binding bootstrap plus feature modules (`grep`, `glob`, `pty`, `shell`, etc.).
- Key files: `packages/natives/src/native.ts`, `packages/natives/src/bindings.ts`, `packages/natives/src/*/index.ts`.

**`packages/stats`:**
- Purpose: Telemetry parsing, aggregation, and server/client presentation.
- Contains: Parser/aggregator/server and React client UI.
- Key files: `packages/stats/src/parser.ts`, `packages/stats/src/aggregator.ts`, `packages/stats/src/server.ts`, `packages/stats/src/client/App.tsx`.

**`packages/swarm-extension`:**
- Purpose: Extension package implementing DAG/pipeline swarm behavior.
- Contains: Extension entry plus swarm state/pipeline/executor modules.
- Key files: `packages/swarm-extension/src/extension.ts`, `packages/swarm-extension/src/swarm/*.ts`.

**`crates`:**
- Purpose: Rust-native implementation layer.
- Contains: `crates/pi-natives`, plus vendored brush crates.
- Key files: `crates/pi-natives`, `crates/brush-core-vendored`, `crates/brush-builtins-vendored`.

## Key File Locations

**Entry Points:**
- `packages/coding-agent/src/cli.ts`: CLI process entry for `omp`.
- `packages/coding-agent/src/main.ts`: Root runtime orchestration.
- `packages/stats/src/server.ts`: Stats server entry.
- `packages/swarm-extension/src/cli.ts`: Swarm extension command entry.

**Configuration:**
- `package.json`: Workspace scripts, package orchestration.
- `biome.json`: TS lint/format policy.
- `tsconfig.base.json` and `tsconfig.json`: TypeScript project references.
- `Cargo.toml` and `rust-toolchain.toml`: Rust workspace/toolchain config.

**Core Logic:**
- `packages/coding-agent/src/session/*.ts`: Session history/storage/branching.
- `packages/coding-agent/src/task/*.ts`: Subagent and process execution.
- `packages/coding-agent/src/mcp/*.ts`: MCP runtime and transport management.
- `packages/ai/src/providers/*.ts`: Provider protocol implementations.

**Testing:**
- `packages/coding-agent/test/*`: Coding-agent tests.
- `packages/ai/test/*`: AI package tests.
- `packages/agent/test/*`: Agent-core tests.
- `packages/tui/test/*`: TUI package tests.
- `packages/natives/test/*`: Native binding tests.

## Naming Conventions

**Files:**
- Use kebab-case for most source modules: `agent-session.ts`, `oauth-flow.ts`, `model-resolver.ts`.
- Use `index.ts` as package/folder barrel exports: `packages/coding-agent/src/modes/index.ts`, `packages/natives/src/index.ts`.
- Use suffixes for role clarity: `*-client.ts`, `*-manager.ts`, `*-types.ts`, `*.generated.*`.

**Directories:**
- Feature-first organization under `src/` by domain (`session`, `tools`, `mcp`, `lsp`, `extensibility`, `web`).
- Provider folders group protocol variants (`packages/ai/src/providers/openai-codex`, `packages/ai/src/providers/cursor`).

## Where to Add New Code

**New CLI Feature:**
- Primary code: `packages/coding-agent/src/commands/<feature>.ts` and `packages/coding-agent/src/cli/<feature>-cli.ts`.
- Runtime/session integration: `packages/coding-agent/src/main.ts` or `packages/coding-agent/src/session/*.ts` as needed.
- Tests: `packages/coding-agent/test/`.

**New Integration Adapter:**
- MCP transport/runtime: `packages/coding-agent/src/mcp/`.
- LSP support: `packages/coding-agent/src/lsp/clients/`.
- AI provider: `packages/ai/src/providers/` plus auth in `packages/ai/src/utils/oauth/`.

**New Shared Utility:**
- Cross-package utility: `packages/utils/src/`.
- Coding-agent-only helper: `packages/coding-agent/src/utils/`.

## Special Directories

**`docs/`:**
- Purpose: Design/runtime references (`docs/mcp-runtime-lifecycle.md`, `docs/tui-runtime-internals.md`, `docs/natives-architecture.md`).
- Generated: No.
- Committed: Yes.

**`.planning/codebase/`:**
- Purpose: Mapping outputs (`CONVENTIONS.md`, `TESTING.md`, plus architecture/structure docs).
- Generated: Maintained by mapping workflows.
- Committed: Yes.

**`packages/stats/src/embedded-client.generated.txt`:**
- Purpose: Embedded generated client artifact for stats package.
- Generated: Yes.
- Committed: Yes.

---

*Structure analysis: 2026-03-02*