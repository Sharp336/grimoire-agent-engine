# Architecture

**Analysis Date:** 2026-03-02

## Pattern Overview

**Overall:** Workspace-oriented modular monolith, with `packages/coding-agent` as orchestration layer and sibling packages as bounded libraries.

**Key Characteristics:**
- CLI-first control plane starts in `packages/coding-agent/src/cli.ts` and routes to command handlers in `packages/coding-agent/src/commands/*.ts`.
- Runtime state is session-centric: `packages/coding-agent/src/session/agent-session.ts` composes storage, tool wiring, and branch-aware history from `packages/coding-agent/src/session/session-manager.ts`.
- Capability expansion is adapter-based: MCP (`packages/coding-agent/src/mcp/*.ts`), LSP (`packages/coding-agent/src/lsp/*.ts`), extensibility (`packages/coding-agent/src/extensibility/*`), and internal URLs (`packages/coding-agent/src/internal-urls/*.ts`).

## Layers

**CLI / Command Layer:**
- Purpose: Parse argv, select top-level command, and bootstrap runtime mode.
- Location: `packages/coding-agent/src/cli.ts`, `packages/coding-agent/src/cli/*.ts`, `packages/coding-agent/src/commands/*.ts`.
- Contains: Argument parsing, command dispatch, command adapters.
- Depends on: Runtime orchestration in `packages/coding-agent/src/main.ts`.
- Used by: `omp` bin entry declared in `packages/coding-agent/package.json`.

**Runtime Orchestration Layer:**
- Purpose: Build session options, create session manager, run RPC/interactive/print execution paths.
- Location: `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/modes/index.ts`, `packages/coding-agent/src/modes/*.ts`.
- Contains: `runRootCommand` flow, mode switching, mode-specific UI/runtime hooks.
- Depends on: Session and tool layers.
- Used by: CLI command layer.

**Session & State Layer:**
- Purpose: Persist conversation tree, branching, compaction, artifacts, auth storage.
- Location: `packages/coding-agent/src/session/*.ts`, `packages/coding-agent/src/session/compaction/*.ts`.
- Contains: `AgentSession`, `SessionManager`, blob/history/session storage.
- Depends on: Storage helpers and model/tool integrations.
- Used by: Runtime orchestration and task execution.

**Tooling & Execution Layer:**
- Purpose: Provide built-in tool registry and execution guards; run subprocess and subagent tasks.
- Location: `packages/coding-agent/src/tools/index.ts`, `packages/coding-agent/src/tools/*.ts`, `packages/coding-agent/src/task/*.ts`, `packages/coding-agent/src/exec/*.ts`.
- Contains: `BUILTIN_TOOLS`, `HIDDEN_TOOLS`, task executor, tool proxies.
- Depends on: Session context, MCP bridge, filesystem/shell helpers.
- Used by: Agent loop and user-invoked tool calls.

**Integration Adapters Layer:**
- Purpose: Connect external protocols and providers.
- Location: MCP in `packages/coding-agent/src/mcp/*.ts`, LSP in `packages/coding-agent/src/lsp/*.ts`, web search/scrapers in `packages/coding-agent/src/web/*`, extension loading in `packages/coding-agent/src/extensibility/*`.
- Contains: Transport clients, adapter contracts, loader pipelines.
- Depends on: Config and capability checks in `packages/coding-agent/src/capability/*.ts`.
- Used by: Tooling layer and runtime orchestration.

## Data Flow

**Interactive Agent Flow:**
1. CLI entry `packages/coding-agent/src/cli.ts` parses argv and invokes launch path.
2. `packages/coding-agent/src/main.ts` constructs options (`buildSessionOptions`), creates manager/session (`createSessionManager`, `createAgentSession`), and selects mode.
3. Mode implementation in `packages/coding-agent/src/modes/interactive-mode.ts` drives render/controller loop with components in `packages/coding-agent/src/modes/components/*.ts`.
4. Tool calls are resolved by `packages/coding-agent/src/tools/index.ts`; protocol-specific tools delegate to MCP (`packages/coding-agent/src/mcp/tool-bridge.ts`), shell/exec (`packages/coding-agent/src/exec/bash-executor.ts`), or task executor (`packages/coding-agent/src/task/executor.ts`).
5. Outputs, artifacts, and history persist through `packages/coding-agent/src/session/*.ts` and are surfaced to TUI/RPC/print modes.

**Package-level Architectural Differences:**
- `packages/coding-agent` is the composition root and runtime coordinator.
- `packages/ai` is provider abstraction and auth/discovery infrastructure (`packages/ai/src/providers/*.ts`, `packages/ai/src/utils/oauth/*.ts`).
- `packages/agent` is minimal agent loop core (`packages/agent/src/agent-loop.ts`) reused by orchestrators.
- `packages/tui` is terminal UI primitives/components (`packages/tui/src/components/*.ts`) with no command parsing concerns.
- `packages/natives` is FFI wrapper surface (`packages/natives/src/native.ts`, `packages/natives/src/bindings.ts`) over Rust crate `crates/pi-natives`.
- `packages/stats` is telemetry pipeline with parser/aggregator/server plus React client (`packages/stats/src/client/*.tsx`).
- `packages/swarm-extension` is extension-scoped DAG/pipeline engine (`packages/swarm-extension/src/swarm/*.ts`).

**State Management:**
- Conversation and branch state are centralized under `packages/coding-agent/src/session/session-manager.ts` and mutation APIs on `packages/coding-agent/src/session/agent-session.ts`.

## Key Abstractions

**Agent Session Abstraction:**
- Purpose: Runtime context + lifecycle API for messages, branching, compaction, handoff.
- Examples: `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/session-manager.ts`.
- Pattern: Stateful façade over append-only history + storage backends.

**Tool Registry Abstraction:**
- Purpose: Normalize tool definition, visibility, and guardrails.
- Examples: `packages/coding-agent/src/tools/index.ts`, `packages/coding-agent/src/tools/tool-result.ts`.
- Pattern: Central registry plus per-tool adapters.

**Protocol Adapter Abstraction:**
- Purpose: Isolate transport/protocol concerns from agent logic.
- Examples: `packages/coding-agent/src/mcp/transports/*.ts`, `packages/coding-agent/src/lsp/client.ts`, `packages/coding-agent/src/internal-urls/router.ts`.
- Pattern: Adapter + manager/loader pairs.

## Entry Points

**CLI Entry Point:**
- Location: `packages/coding-agent/src/cli.ts`
- Triggers: `omp` binary (`packages/coding-agent/package.json` -> `bin.omp`).
- Responsibilities: Top-level argv handling and command routing.

**SDK Entry Point:**
- Location: `packages/coding-agent/src/sdk.ts`
- Triggers: External consumers importing package exports from `packages/coding-agent/package.json`.
- Responsibilities: Programmatic surface for embedding agent functionality.

**Stats Service Entry Point:**
- Location: `packages/stats/src/server.ts`
- Triggers: Stats command path (`package.json` root script `stats`).
- Responsibilities: Serve aggregated telemetry and client assets.

## Error Handling

**Strategy:** Boundary-local handling with typed error modules and fallback routing.

**Patterns:**
- Git/commit-specific error typing in `packages/coding-agent/src/commit/git/errors.ts`.
- Tool-level normalization helpers in `packages/coding-agent/src/tools/tool-errors.ts` and result wrappers in `packages/coding-agent/src/tools/tool-result.ts`.
- Task/process isolation in `packages/coding-agent/src/task/executor.ts` and `packages/coding-agent/src/exec/exec.ts` to prevent process failures from corrupting session state.

## Cross-Cutting Concerns

**Logging:** Shared logger/util patterns in `packages/utils/src/logger.ts` and debug bundle/report tools in `packages/coding-agent/src/debug/*.ts`.

**Validation:** Schema and config validation in `packages/coding-agent/src/config/settings-schema.ts`, model resolution in `packages/coding-agent/src/config/model-resolver.ts`, and AI schema compatibility logic in `packages/ai/src/utils/schema/*.ts`.

**Authentication:** Auth storage and token flow in `packages/coding-agent/src/session/auth-storage.ts`, `packages/ai/src/auth-storage.ts`, and provider OAuth adapters in `packages/ai/src/utils/oauth/*.ts`.

*Architecture analysis: 2026-03-02*