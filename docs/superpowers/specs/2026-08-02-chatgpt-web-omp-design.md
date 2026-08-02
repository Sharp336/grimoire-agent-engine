# ChatGPT Web Provider for oh-my-pi — Design

**Status:** Approved local design for implementation and testing in `Nou4r/oh-my-pi`. No upstream PR, issue, Discord post, or push is part of this phase.

## Decision summary

Integrate the browser-backed ChatGPT Web capability as a first-party optional OMP workspace package, exposed through OMP's existing custom provider API. The provider will appear in the native model picker after the package extension is enabled, emit standard OMP assistant/tool events, and preserve OMP's existing tool execution, approval, session, and TUI behavior.

Do not add a new `KnownApi`, do not import the Codex configuration journal, and do not make `oh-my-pi` depend on the `codex-chatgpt-web` repository or fork at runtime. The fork is a source/reference checkout while the implementation is developed locally.

## Goals

- Make `chatgpt-web/light`, `medium`, `high`, `extra-high`, and account-gated `pro` selectable as OMP models.
- Reuse the proven browser/session behavior from `codex-chatgpt-web`: fresh Temporary Chats, native image attachments, fixed effort mapping, bounded parallel tabs, DOM/completion health checks, cancellation, and fail-closed behavior.
- Translate ChatGPT Web output into OMP `AssistantMessageEvent` events, including reasoning, text, tool calls, usage, terminal status, and errors.
- Let OMP's existing agent loop execute local tools and feed `ToolResultMessage` values back into the browser turn through a capability-bound broker.
- Provide a local CLI login/status/doctor flow before adding desktop packaging.
- Preserve all source and third-party attribution required by the two MIT projects and the bridge's existing `LICENSES` files.
- Reach a locally tested, upstream-reviewable state before any maintainer contact.

## Non-goals

- No immediate upstream PR or push.
- No direct dependency on `Nou4r/codex-chatgpt-web`.
- No direct reuse of Codex's `~/.codex` configuration, `openai_base_url` journal, Codex model catalog, or Codex request envelope.
- No new general-purpose OMP wire API in `packages/ai/src/types.ts` or `ApiOptionsMap`.
- No Electron launcher in the first provider milestone.
- No silent fallback from ChatGPT Web to another model, no retry loop intended to evade account limits, and no behavior that weakens OMP tool approval or sandbox policy.

## Why this boundary

`codex-chatgpt-web` is a complete executable system rather than a normal provider: it owns a Bun Responses daemon, a Playwright browser worker, ChatGPT Temporary Chat lifecycle, optional MCP/tunnel capability routing, Codex-specific request parsing, Codex config mutation, and a cross-platform Electron supervisor. The reusable behavior is concentrated in the ChatGPT browser adapter, prompt/attachment handling, turn-session lifecycle, model effort mapping, and lifecycle/security tests.

OMP already has the required host seam:

- `ExtensionAPI.registerProvider()` accepts `streamSimple`, custom models, headers, and OAuth login.
- `ModelRegistry.registerProvider()` registers the custom API and manages source cleanup.
- `@oh-my-pi/pi-ai` dispatches non-built-in API identifiers through `registerCustomApi()` before built-in APIs.
- `AssistantMessageEvent` already represents text, thinking, tool-call, completion, abort, and error events.
- The agent loop already executes returned tool calls and provides the resulting `ToolResultMessage` entries on the next provider request.

A new built-in `KnownApi` would expand exhaustive type and dispatch surfaces for no functional benefit. A separate package keeps Playwright, MCP, browser selectors, and platform lifecycle code out of the core provider matrix while retaining native OMP UX.

## Package ownership

### `packages/chatgpt-web`

Owns the browser-backed runtime and the OMP provider adapter.

- ChatGPT account login verification and durable browser profile state.
- ChatGPT model routes and account-gated Pro capability detection.
- Playwright browser worker, Temporary Chat navigation, effort selection, attachment/send readiness, DOM completion tracking, Markdown conversion, and bounded concurrency.
- OMP context-to-browser prompt compilation.
- OMP assistant-event conversion.
- Per-session turn state and capability-bound broker.
- Full-mode MCP server and tunnel client integration after browser-only mode is stable.
- Local `login`, `status`, `doctor`, `serve`, and `uninstall` commands.
- Package-local tests, security documentation, and third-party notices.

The first-party extension entry point is fixed at `packages/chatgpt-web/src/extension.ts`. The `omp chatgpt-web enable` command resolves that module through the package export and writes its absolute path to the existing `settings.extensions` list. This keeps provider discovery explicit, makes disabled installs incur no browser startup, and gives source checkouts and published packages the same activation contract.

The package may use `@oh-my-pi/pi-ai` types and event-stream utilities. It must not import private coding-agent execution internals to run tools.

### `packages/coding-agent`

Only owns the host-facing enablement surface:

- `src/commands/chatgpt-web.ts` resolves the package extension and implements `enable`, `disable`, `status`, `login`, and `doctor` dispatch.
- `src/cli-commands.ts` adds one lazy top-level `chatgpt-web` entry.
- Settings/help documentation explains the existing `settings.extensions` activation path.

The host must not duplicate browser selectors, prompt parsing, MCP protocol code, or launcher supervision.

### `packages/chatgpt-web-launcher` (later local phase)

Owns the Electron control center and process supervisor. It will consume the runtime package's versioned CLI/control contract and will not be embedded into `packages/coding-agent`.

## Provider contract

The extension registers one custom API identifier, `chatgpt-web`, and a fixed model set derived from the source routes:

| Model ID | Display label | Effort | Local tools |
| --- | --- | --- | --- |
| `chatgpt-web/light` | ChatGPT Web — Instant | `low` | yes in full mode |
| `chatgpt-web/medium` | ChatGPT Web — Medium | `medium` | yes in full mode |
| `chatgpt-web/high` | ChatGPT Web — High | `high` | yes in full mode |
| `chatgpt-web/extra-high` | ChatGPT Web — Extra High | `xhigh` | yes in full mode |
| `chatgpt-web/pro` | ChatGPT Web — Pro | `max` | no |

The provider model metadata uses a `256_000` context window, `64_000` maximum output tokens, zero API cost, no service tiers, no native OpenAI WebSocket support, and no native server-side compaction. Pro remains account-gated and read-only for local tools.

The extension's `streamSimple(model, context, options)` is the only provider entry point. It must:

1. Require a stable `options.sessionId` for full-mode continuation.
2. Resolve the local browser profile without sending the opaque login/profile identifier to ChatGPT or any network endpoint.
3. Reuse a provider-session object from `options.providerSessionState` when present.
4. Start or resume the turn session for the selected model route.
5. Convert browser trace/text/tool events into OMP `AssistantMessageEvent` values.
6. Return `toolUse` after emitting tool calls so the existing OMP agent loop executes them.
7. On the next call, match `ToolResultMessage.toolCallId` values to pending broker invocations and resume the same browser turn.
8. Fail explicitly on missing session identity, stale capability handles, unknown tool names, unsupported Pro tool calls, malformed browser output, selector drift, or closed tabs.

The login flow is represented as an OMP OAuth registration only because the extension API already provides durable credential lifecycle and `/login` integration. The stored `access` value is an opaque local profile identifier, not a bearer token; `getApiKey` returns it only to the in-process provider adapter, and the adapter never sends it as an HTTP header. Browser state is stored below `${agentDir}/chatgpt-web/browser-profile`, while configuration and control tokens are stored below `${agentDir}/chatgpt-web` with restrictive permissions. `${agentDir}` is OMP's existing `PI_CODING_AGENT_DIR`/`~/.omp/agent` root.


## Data flow

```mermaid
flowchart TD
  A[OMP agent loop] -->|Context + model + sessionId| B[chatgpt-web custom stream]
  B --> C[Prompt compiler]
  C --> D[ChatGPT Web browser worker]
  D -->|trace/text/tool events| B
  B -->|AssistantMessageEvent| A
  A -->|executes approved OMP tools| E[OMP tool runner]
  E -->|ToolResultMessage next turn| B
  B --> F[Turn broker]
  F --> G[ChatGPT MCP connector]
  G --> D
```

Browser-only mode omits the broker and MCP connector. Full mode keeps the broker state keyed to the OMP session and turn identity. The broker never grants a tool based solely on a browser-provided name: every invocation must match the current OMP tool declaration and active turn capability.

## Source porting map

### Reuse and adapt

- `codex-chatgpt-web/src/adapters/chatgpt-web/browser-worker.ts` → package browser worker; replace `CodexProviderConfig` with package-owned runtime config and preserve bounded tab/completion invariants.
- `src/adapters/chatgpt-web/chatgpt-session.ts`, `browser-login.ts`, `markdown.ts`, `process-line-writer.ts` → package browser/login support.
- `src/adapters/chatgpt-web/prompt.ts` → OMP context prompt compiler; remove Codex-only envelope fields and preserve attachment/retired-handle rules.
- `src/adapters/chatgpt-web/turn-execution.ts` → OMP provider-session/trace feeds.
- `src/adapters/chatgpt-web/concurrency.ts`, `usage.ts`, `model.ts` → package model/concurrency/usage modules, with OMP event and usage types.
- `src/chatgpt-web-models.ts`, `src/model-catalog.ts` → OMP model route definitions and model metadata.
- `src/adapters/chatgpt-web/turn-broker.ts`, `mcp-server.ts`, `mcp-main.ts` → full-mode broker/MCP, after replacing Codex request identity with OMP session/turn identity.
- `src/tunnel.ts`, `tunnel-service.ts` → later full-mode tunnel lifecycle, subject to the same checksum and secret-storage requirements.

### Do not port directly

- `src/types.ts` Codex wire types.
- `src/responses/schema.ts`, `parser.ts`, `state.ts`, and `compaction.ts` as Codex request parsing; only their protocol-independent lifecycle ideas may be reimplemented against OMP `Context`/`Message`.
- `src/server.ts`, `bridge.ts`, and `native-passthrough.ts` for the initial native provider path; OMP consumes event streams directly rather than routing through a Codex loopback Responses daemon.
- `src/codex-integration.ts`, `setup.ts`, and `service.ts`; they mutate or supervise Codex configuration and are not valid OMP integration points.
- Electron launcher files until the provider has passed local live smoke tests.

## Security invariants

- Browser state, profile identifiers, tunnel credentials, and control tokens stay under the OMP-owned application directory with restrictive permissions.
- Loopback control endpoints bind only to loopback and require a random bearer token.
- Browser turns are capped at five active documents; a sixth request fails explicitly.
- Every full-mode tool call is bound to one OMP session, turn, declared tool set, and expiry.
- OMP approval, sandbox, and write-gating remain authoritative; ChatGPT Web cannot bypass them.
- Secrets never appear in process arguments, logs, prompts, generated config, or repository files.
- ChatGPT Web model/selector/completion drift fails closed with an actionable error.
- Pro never receives local tool capabilities.
- No fallback or retry changes the selected ChatGPT mode to evade usage controls.

## Licensing and provenance

Both repositories are MIT. The port must retain the bridge's attribution and third-party notices, including `LICENSES/NOTICE.md`, `LICENSES/OpenCodex-MIT.txt`, and `LICENSES/Bun-1.3.11.md`, updated for any dependency/version changes. Each copied/adapted source file must retain required upstream copyright notices. The final package must generate a complete third-party notice file from the OMP lockfile and package metadata.

## Validation gates

No upstream action is allowed until all local gates pass:

1. Static checks and focused unit tests for the new package and host registration.
2. Browser fixture tests for login, prompt/attachment compilation, model effort selection, selector/completion tracking, tab cap, cancellation, and malformed output.
3. Live browser-only smoke: login, every non-Pro effort, text, reasoning, image, cancellation, restart, and sixth-turn rejection.
4. Live full-mode smoke: MCP connection, read tool, write tool with OMP approval, tool error, cancellation while a tool is pending, and continuation after tool results.
5. Local package/build smoke on Windows, macOS, and Linux runners; launcher smoke only after provider gates pass.
6. Rebase against `upstream/main`, repeat all gates, inspect the diff for generated noise, and prepare a draft PR body without pushing or submitting it.

The implementation is rejected as not ready if any path silently falls back to another model, bypasses OMP approvals, leaks browser credentials, or loses tool/session identity across a continuation.
