# Prime Agent ↔ OMP P2B Live Tool Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Prime's persistent IPython kernel call an explicitly allowlisted, session-scoped subset of a live OMP session's tools through stock Prime `McpIntegration`.

**Architecture:** An in-process OMP host adapter registers live tool schemas over an authenticated WebSocket to the detached bridge. The bridge exposes each OMP session as a distinct streamable-HTTP MCP endpoint. Baseline results are final-only: Prime's current MCP client does not surface progress notifications or guarantee cancellation propagation.

**Prerequisite:** P1 is merged and its authenticated bridge server/token/state patterns are reused.

**Tech Stack:** Bun, TypeScript, WebSocket, MCP SDK already used by OMP, Python `McpIntegration` already shipped by Prime.

## Global Constraints

- Never synthesize a `BUILTIN_TOOLS` registry. The source of truth is the live OMP `ToolSession`.
- Namespacing is endpoint/session based: `/mcp/v1/sessions/{sessionId}`. Same-named tools in different sessions cannot collide.
- Default allowlist is read-oriented: `read`, `grep`, `glob`, `web_search`. OMP `read` also accepts HTTP(S) URLs, so enabling the bridge grants Prime that same outbound fetch surface; document this explicitly. User settings may add tools. `write`, `edit`, `bash`, `task`, `hub`, `todo`, and every `xd://` device remain denied unless individually named.
- Host invocation must use the wrapped tool from `ToolSession.getToolByName()` and `ToolSession.getToolContext()` so OMP approval and extension hooks remain active.
- Approval timeout defaults to 60 seconds. Timeout/deny/disconnect returns MCP `isError`; never drops the HTTP connection or silently auto-approves.
- Final-result-only baseline. Do not advertise MCP progress or cancellation capabilities.
- No commits unless asked.

---

### Task 1: Define the authenticated host-channel protocol

**Files:**
- Create: `packages/prime-bridge/src/protocol/tool-host.ts`
- Create: `packages/prime-bridge/src/tool-host/registry.ts`
- Test: `packages/prime-bridge/test/tool-host-protocol.test.ts`
- Test: `packages/prime-bridge/test/tool-host-registry.test.ts`

**Interfaces:**

```ts
export type ToolHostFrame =
  | { type: "register"; hostId: string; sessionId: string; tools: RegisteredTool[] }
  | { type: "tools_changed"; sessionId: string; tools: RegisteredTool[] }
  | { type: "call_tool"; requestId: string; sessionId: string; toolName: string; arguments: unknown }
  | { type: "tool_result"; requestId: string; result: McpToolResult }
  | { type: "tool_error"; requestId: string; code: string; message: string }
  | { type: "unregister"; sessionId: string };
```

- [ ] Test schema rejection, duplicate host/session replacement, per-session name isolation, stale-socket unregister, and no cross-session lookup fallback.
- [ ] Run both tests; expect failure.
- [ ] Implement omptype contracts and an in-memory registry. One session has exactly one live host owner; reconnect replaces the previous owner and rejects its late frames.
- [ ] Re-run tests; expect PASS.

### Task 2: Add bridge WebSocket host endpoint

**Files:**
- Create: `packages/prime-bridge/src/tool-host/server.ts`
- Modify: `packages/prime-bridge/src/server.ts`
- Modify: `packages/prime-bridge/src/config.ts`
- Test: `packages/prime-bridge/test/tool-host-server.test.ts`

**Interfaces:**
- Endpoint: `GET /v1/tool-host` WebSocket upgrade.
- Token and Origin policy exactly match P1 `/v1/*` routes.

- [ ] Test missing/invalid bearer, disallowed Origin, successful registration, heartbeat timeout, reconnect replacement, 1 MiB frame rejection, and pending call failure on disconnect.
- [ ] Run focused test; expect failure.
- [ ] Add authenticated upgrade, ping/pong liveness, bounded outbound queue, request correlation, and audit rows for register/call/result/error/disconnect.
- [ ] Re-run test; expect PASS.

### Task 3: Add OMP in-process `PrimeBridgeHostAdapter`

**Files:**
- Create: `packages/coding-agent/src/integrations/prime-bridge/tool-host-adapter.ts`
- Modify: `packages/coding-agent/src/integrations/prime-bridge/index.ts`
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Modify: `packages/coding-agent/src/sdk.ts`
- Test: `packages/coding-agent/test/prime-bridge-tool-host.test.ts`

**Interfaces:**
- Produces `PrimeBridgeHostAdapter.start(session, config)`, `refreshTools()`, `stop()`.
- Settings: `primeBridge.toolHost.enabled`, `allowTools`, `approvalTimeoutMs`.

- [ ] Write tests with a fake WebSocket server: registration uses active session ID and JSON schemas; disabled/restricted tools are omitted; `tools_changed` follows session/tool changes; same-name sessions are independent.
- [ ] Test invocation through wrapped `AgentTool.execute(toolCallId, args, signal, onUpdate, toolContext)`, not native implementation. Approval deny/timeout/disconnect produces `tool_error` and aborts the pending call.
- [ ] Run focused test; expect failure.
- [ ] Resolve design unknown #6 here: create the attached adapter after `AgentSession` and `ToolSession` exist in `createAgentSession()`; register its `stop()` on session disposal. Implement with existing `ToolSession` hooks, opaque `prime-bridge:` call IDs, and no argument logs for secret-bearing tools.
- [ ] Re-run test; expect PASS.

### Task 4: Implement session-scoped streamable-HTTP MCP server

**Files:**
- Create: `packages/prime-bridge/src/mcp/server.ts`
- Create: `packages/prime-bridge/src/mcp/result-map.ts`
- Modify: `packages/prime-bridge/src/server.ts`
- Test: `packages/prime-bridge/test/mcp-server.test.ts`
- Test: `packages/prime-bridge/test/mcp-result-map.test.ts`

**Interfaces:**
- Endpoint: `/mcp/v1/sessions/{sessionId}`.
- MCP methods: `initialize`, `tools/list`, `tools/call`.
- Capabilities advertise tools only; no progress/cancellation declaration.

- [ ] Test bearer/Origin rules, unknown/offline session errors, session-isolated `tools/list`, invalid arguments, JSON/text/image output mapping, host errors as `isError:true`, and 1 MiB limits.
- [ ] Test disconnect while awaiting approval: host request aborts; HTTP returns an MCP error if still writable.
- [ ] Run both tests; expect failure.
- [ ] Implement using OMP's installed MCP SDK transport types; inspect `node_modules` APIs rather than guessing. Serialize final `AgentToolResult` content blocks without lossy text concatenation.
- [ ] Re-run tests; expect PASS.

### Task 5: Ship Prime `omp_tools` skill

**Files:**
- Create: `packages/prime-bridge/prime-skill-tools/SKILL.md`
- Create: `packages/prime-bridge/prime-skill-tools/pyproject.toml`
- Create: `packages/prime-bridge/prime-skill-tools/src/omp_tools/__init__.py`
- Test: `packages/prime-bridge/prime-skill-tools/test/test_omp_tools.py`

**Interfaces:**
- `class OmpTools(McpIntegration)` with `server = "omp-tools"`.
- `connect(session_id)` constructs `/mcp/v1/sessions/{quotedSessionId}` only from a validated session ID.

- [ ] Mock Prime `McpIntegration`; verify URL/header config, tool discovery, offline-session error, and final result/error behavior.
- [ ] Run `python -m unittest discover -s test -v`; expect failure.
- [ ] Implement a thin subclass; no custom MCP client and no Python tool wrappers per OMP tool.
- [ ] Re-run test; expect PASS.

### Task 6: Verify end-to-end compatibility and document limits

**Files:**
- Create: `packages/prime-bridge/test/integration/live-tools.test.ts`
- Modify: `packages/prime-bridge/README.md`
- Modify: `packages/prime-bridge/CHANGELOG.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

- [ ] Start a real OMP `AgentSession` with temp cwd, adapter, bridge, and Prime Python MCP client against the live endpoint. Call `read`, verify output; deny `write`, verify `isError`; run two OMP sessions with same tool names, verify isolation.
- [ ] Interrupt a Prime-side call during an approval wait. Record observed client behavior. Keep advertised contract final-only unless the stock client demonstrably emits MCP cancellation and consumes progress.
- [ ] Run focused integration test, package tests, `bun check`, and `omp --smoke-test`; expect PASS.
- [ ] Document exact allowlist, the `read` URL-fetch capability, approval timeout, no-progress/no-cancel baseline, session endpoint selection, and offline behavior. Do not commit unless asked.
