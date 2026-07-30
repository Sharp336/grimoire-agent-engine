---
title: SDK & RPC
description: Embed omp in-process with the SDK, or drive it from another process with the newline-delimited JSON RPC protocol.
coverage: B
---

omp ships two embedding surfaces. The **SDK** runs omp inside your own Bun or Node process so you can drive an `AgentSession` directly, subscribe to its events, and call into the model. **RPC mode** runs omp as a separate process you talk to over newline-delimited JSON on stdio — useful for cross-language drivers, IDE integrations, and isolated workers.

## SDK at a glance

Install the package and create a session in a few lines:

```bash
bun add @oh-my-pi/pi-coding-agent
```

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession();

if (modelFallbackMessage) {
  process.stderr.write(`${modelFallbackMessage}\n`);
}

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Summarize this repository in 3 bullets.");
unsubscribe();
await session.dispose();
```

### Entry points

`@oh-my-pi/pi-coding-agent` exports the SDK APIs from the package root (and also via `@oh-my-pi/pi-coding-agent/sdk`). The core exports for embedders are:

- `createAgentSession`
- `SessionManager`
- `Settings`
- `AuthStorage`
- `ModelRegistry`
- `discoverAuthStorage`
- Discovery helpers — `discoverExtensions`, `discoverSkills`, `discoverContextFiles`, `discoverPromptTemplates`, `discoverSlashCommands`, `discoverCustomTSCommands`, `discoverMCPServers`
- Tool factory surface — `createTools`, `BUILTIN_TOOLS`, tool classes

### What `createAgentSession()` discovers

`createAgentSession()` follows "provide to override, omit to discover". With no overrides it resolves:

- `cwd` — `getProjectDir()`
- `agentDir` — `~/.omp/agent` (via `getAgentDir()`)
- `authStorage` — `discoverAuthStorage(agentDir)`
- `modelRegistry` — `new ModelRegistry(authStorage)` plus background `refreshInBackground()` when not supplied
- `settings` — `await Settings.init({ cwd, agentDir })`
- `sessionManager` — `SessionManager.create(cwd)` (file-backed)
- Skills, context files, prompt templates, slash commands, extensions, and custom TS commands
- Built-in tools via `createTools(...)`
- MCP tools (enabled by default; Exa MCP servers are folded into native Exa integration, and browser-automation MCP servers are filtered when the built-in browser tool is enabled)
- LSP integration (enabled by default)
- `eventBus` — a new `EventBus` unless supplied

A minimal session needs no arguments; embedders usually pass `sessionManager`, `authStorage` + `modelRegistry`, `model` or `modelPattern`, and `settings` when they need deterministic control.

### Session managers

`AgentSession` always uses a `SessionManager`. Two factories are available:

```ts
// File-backed (default): persists to <cwd>/...jsonl
const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});
console.log(session.sessionFile); // absolute .jsonl path

// In-memory: no filesystem persistence — useful for tests and ephemeral workers
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
console.log(session.sessionFile); // undefined
```

Resume / open / list helpers:

```ts
const recent = await SessionManager.continueRecent(process.cwd());
const listed = await SessionManager.list(process.cwd());
const opened = listed[0] ? await SessionManager.open(listed[0].path) : null;
```

### Model selection

When `model` is omitted, the SDK picks in this order:

1. Restore the model from an existing session (if restorable and the API key is available).
2. The settings default model role (`default`).
3. The first available model with valid auth.

If restore fails, `modelFallbackMessage` explains the fallback.

`AuthStorage.getApiKey(...)` resolves in this order:

1. Runtime override (`setRuntimeApiKey`, used by `omp --api-key`).
2. Config-sourced API key override (`models.yml` provider `apiKey`).
3. Stored OAuth credential, including refresh when needed.
4. API key persisted by a successful `/login`.
5. Provider environment variables.
6. Other stored API-key credentials in `agent.db` / broker-backed storage.
7. Custom-provider resolver fallback.

### Prompt lifecycle

`session.prompt(text, options?)` is the primary entry point. When the agent is streaming, `streamingBehavior: "steer" | "followUp"` chooses how the prompt queues. Extension `sendUserMessage(content)` defaults to steer when `deliverAs` is omitted. Queued messages are preserved instead of thrown away.

Related APIs:

- `sendUserMessage(content, { deliverAs? })`
- `steer(text, images?)`
- `followUp(text, images?)`
- `sendCustomMessage({ customType, content, ... }, { deliverAs?, triggerTurn? })`
- `abort()`

### Event subscription

`subscribe(listener)` returns an unsubscribe function. `AgentSessionEvent` covers the core `AgentEvent` types plus session-level events: `auto_compaction_start` / `auto_compaction_end`, `auto_retry_start` / `auto_retry_end`, `retry_fallback_applied` / `retry_fallback_succeeded`, `ttsr_triggered`, `todo_reminder` / `todo_auto_clear`, and `irc_message`.

### Tools and extensions

Built-in tools come from `createTools(...)` and `BUILTIN_TOOLS`. `toolNames` acts as an allowlist for built-ins; `customTools` and extension-registered tools are still included. Hidden tools such as `yield` are opt-in unless required.

Extension options on `createAgentSession`:

- `extensions` — inline `ExtensionFactory[]`
- `additionalExtensionPaths` — load extra extension files
- `disableExtensionDiscovery` — disable automatic scanning
- `preloadedExtensions` — reuse an already-loaded set

Runtime tool-set updates: `getActiveToolNames()`, `getAllToolNames()`, `setActiveToolsByName(names)`, `refreshMCPTools(mcpTools)`. The system prompt is rebuilt to reflect active-tool changes.

### Return value

```ts
type CreateAgentSessionResult = {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
  mcpManager?: MCPManager;
  modelFallbackMessage?: string;
  lspServers?: Array<{
    name: string;
    status: "connecting" | "ready" | "error" | "available";
    fileTypes: string[];
    error?: string;
  }>;
  eventBus: EventBus;
};
```

Use `setToolUIContext(...)` only when your embedder provides UI capabilities that tools and extensions should call into.

## RPC mode at a glance

```bash
omp --mode rpc
```

omp reads commands from stdin as newline-delimited JSON and writes responses, session events, and extension-UI requests on stdout. Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- Automatic session-title generation is disabled to avoid an extra model call.
- Workflow-altering settings (`todo.*`, `task.*`, `memory.backend`/`memories.enabled`, `advisor.*`, `async.*`, `bash.autoBackground.*`) are reset to built-in defaults instead of inheriting user overrides.
- At startup omp writes a `ready` frame before processing commands; the frame advertises supported protocol versions and transport limits.
- When stdin closes, pending host-tool calls and host-URI requests are rejected and the process exits with code `0`.

### Ready frame and protocol negotiation

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864
}
```

Clients that support protocol v2 should send a negotiation request immediately:

```json
{ "id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2 }
```

After the success response, oversized stdout objects are emitted losslessly as an uninterrupted sequence of `rpc_chunk` frames carrying base64 segments of the original UTF-8 JSON. Clients must validate `chunkId`, `index`, `count`, and `byteLength`, reject interleaved or interrupted sequences, enforce the reassembly limit, concatenate decoded bytes in index order, decode them as strict UTF-8, and parse the result as one JSON object. The exported TypeScript `RpcFrameDecoder` implements this validation; the bundled TypeScript and Python `RpcClient` implementations negotiate v2 automatically when the ready frame advertises it. Legacy clients may ignore the added ready fields and remain on v1.

### Driving a session over RPC

```text
you → stdin
  {"id":"1","type":"prompt","message":"Find TODOs in this repo"}
  {"id":"2","type":"get_state"}

omp → stdout
  {"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
  {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Looking…"}}
  …
  {"id":"1","type":"response","command":"prompt","success":true,"data":{"agentInvoked":true}}
  {"id":"2","type":"response","command":"get_state","success":true,"data":{…}}
```

`RpcClient` (TypeScript and Python) handles framing, ready-frame negotiation, v2 chunk reassembly, and the paged message-walk fallback so most callers never see raw frames. Use raw protocol frames if you need the full surface.

### Command reference (highlights)

The full `RpcCommand` schema lives in `src/modes/rpc/rpc-types.ts`. The categories:

| Group | Commands |
| --- | --- |
| Prompting | `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session` |
| Protocol | `negotiate_protocol` |
| State | `get_state`, `set_fast_mode`, `get_available_commands`, `set_todos`, `set_host_tools`, `set_host_uri_schemes`, `set_subagent_subscription`, `get_subagents`, `get_subagent_messages` |
| Model | `set_model`, `cycle_model`, `get_available_models` |
| Thinking | `set_thinking_level`, `cycle_thinking_level` |
| Queue modes | `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode` |
| Compaction | `compact`, `set_auto_compaction` |
| Retry | `set_auto_retry`, `abort_retry` |
| Bash | `bash`, `abort_bash` |
| Session | `get_session_stats`, `export_html`, `switch_session`, `branch`, `get_branch_messages`, `get_last_assistant_text`, `set_session_name`, `handoff` |
| Messages | `get_messages`, `get_messages_page` |
| Login | `get_login_providers`, `login` |

`bash` runs concurrently: the RPC server keeps reading commands while the shell runs, so `abort_bash` (or any other command) sent during a long-running `bash` is handled without waiting for it to finish on its own. Ordering across concurrent commands is not guaranteed — match responses on `id`, not on emission order.

### Response schema

Every command returns an `RpcResponse`:

```json
// success
{ "id": "req_1", "type": "response", "command": "prompt", "success": true, "data": { … } }

// failure
{ "id": "req_1", "type": "response", "command": "compact", "success": false, "error": "…" }
```

`prompt` is acknowledged after the command is accepted, not after a model turn finishes. `data.agentInvoked: false` is a completion signal for local-only prompts (slash commands that produce output without starting an agent turn). `data.agentInvoked: true` means the prompt produced agent lifecycle events. Older runtimes may omit `data`; rely on `agent_end`, custom-message completion, or `prompt_result` then.

### Hosting tools and URI schemes

A driver can register host-owned tools with `set_host_tools`. The server may call them back via `host_tool_call`/`host_tool_cancel`, and the driver responds on stdin with `host_tool_update` / `host_tool_result`. The same pattern applies to URL schemes with `set_host_uri_schemes`, `host_uri_request`, `host_uri_cancel`, and `host_uri_result`. Re-sending either replaces the previous set.

### Events

RPC mode forwards every `AgentSessionEvent` from `AgentSession.subscribe(...)`. Common types: `agent_start` / `agent_end`, `turn_start` / `turn_end`, `message_start` / `message_update` / `message_end`, `tool_execution_start` / `tool_execution_update` / `tool_execution_end`, `auto_compaction_start` / `auto_compaction_end`, `auto_retry_start` / `auto_retry_end`, `ttsr_triggered`, `todo_reminder`, `todo_auto_clear`. Extension runner errors arrive separately as `{ "type": "extension_error", "extensionPath", "event", "error" }`.

## Sharp edges

:::caution
**SDK and RPC run an in-process agent.** Long-running sessions hold MCP and LSP processes open — always call `session.dispose()` (or close stdin and let the RPC process exit) before tearing down your host.
:::

- **`prompt` and `abort_and_prompt` ack immediately**, not on turn completion. Track completion via `agent_end`, custom-message completion, `data.agentInvoked`, or `prompt_result`.
- **Concurrent RPC commands are unordered.** Correlate responses by `id`, not by emission order.
- **Hosts that don't speak v2 still work** — v1 retains its bounded fallback. Frames above the v2 reassembly ceiling still fail explicitly; paginate history rather than relying on arbitrarily large logical frames.
- **In-memory `SessionManager` is non-persistent.** `session.sessionFile` is `undefined`, so resume/fork paths that depend on files do not apply.
