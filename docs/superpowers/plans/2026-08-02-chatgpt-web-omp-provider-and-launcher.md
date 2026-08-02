# ChatGPT Web Provider and Launcher Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a locally tested, first-party OMP ChatGPT Web provider and then a separately packaged Electron launcher without opening or pushing an upstream PR.

**Architecture:** Create `packages/chatgpt-web` as an OMP-native custom API provider. Its extension registers `chatgpt-web/*` models through `ExtensionAPI.registerProvider`, while its browser worker, prompt compiler, session state, MCP broker, and tunnel code remain package-owned. The first milestone uses the provider directly in the OMP process; the second adds `packages/chatgpt-web-launcher` behind the same runtime host interface.

**Tech Stack:** Bun `>=1.3.14`, TypeScript, `@oh-my-pi/pi-ai` custom API registry, `@oh-my-pi/pi-coding-agent` extension API, Playwright Core, Chromium BiDi, MCP SDK, Turndown/GFM, Zod, Electron, React, Vite, and electron-builder.

## Global Constraints

- Work only in the local `Nou4r/oh-my-pi` checkout; do not push, open a PR, open an issue, or contact maintainers during implementation.
- Keep `codex-chatgpt-web` as a source/reference checkout only; do not add it as a runtime dependency, submodule, or package registry dependency.
- Do not add a `KnownApi` or modify `ApiOptionsMap`; use the existing custom API identifier `chatgpt-web` and `streamSimple` registration path.
- Do not port Codex configuration mutation, Codex request-envelope parsing, native Codex passthrough, or Codex service management.
- Preserve five concurrent browser turns, fresh Temporary Chats, image reattachment, fixed effort mapping, explicit Pro read-only behavior, fail-closed browser checks, and OMP approval/sandbox authority.
- Store browser state below `${PI_CODING_AGENT_DIR:-~/.omp/agent}/chatgpt-web/browser-profile`; never place credentials in argv, logs, prompts, generated config, or Git.
- Retain `codex-chatgpt-web/LICENSES/NOTICE.md`, `LICENSES/OpenCodex-MIT.txt`, and `LICENSES/Bun-1.3.11.md`; regenerate notices for the OMP lockfile and current dependency versions.
- Every task ends with its focused test/check command before the next task begins.

---

## File and package map

### New runtime package

- Create: `packages/chatgpt-web/package.json` — `@oh-my-pi/pi-chatgpt-web` workspace package, CLI bin, scripts, and isolated browser/MCP dependencies.
- Create: `packages/chatgpt-web/tsconfig.json` — package TypeScript settings extending the workspace base.
- Create: `packages/chatgpt-web/src/index.ts` — public exports for provider, extension, config, model routes, and runtime lifecycle.
- Create: `packages/chatgpt-web/src/extension.ts` — the only OMP extension entry point.
- Create: `packages/chatgpt-web/src/cli.ts` — `login`, `status`, `doctor`, `serve`, and `uninstall` commands.
- Create: `packages/chatgpt-web/src/config.ts` — secure path resolution, atomic config/control-token persistence, and lifecycle settings.
- Create: `packages/chatgpt-web/src/models.ts` — route table and OMP `ProviderModelConfig` conversion.
- Create: `packages/chatgpt-web/src/provider/stream.ts` — `streamSimple` implementation and OMP event conversion.
- Create: `packages/chatgpt-web/src/provider/prompt.ts` — OMP `Context` to browser prompt/attachment compilation.
- Create: `packages/chatgpt-web/src/provider/session.ts` — session identity, continuation, pending tool calls, and cleanup.
- Create: `packages/chatgpt-web/src/provider/types.ts` — package-owned runtime/event contracts; no Codex wire types.
- Create: `packages/chatgpt-web/src/browser/browser-worker.ts` — adapted ChatGPT browser worker.
- Create: `packages/chatgpt-web/src/browser/chatgpt-session.ts` — selectors, Temporary Chat checks, effort selection, and login capability checks.
- Create: `packages/chatgpt-web/src/browser/login.ts` — interactive login and account capability marker.
- Create: `packages/chatgpt-web/src/browser/markdown.ts` — ChatGPT HTML-to-Markdown conversion.
- Create: `packages/chatgpt-web/src/browser/concurrency.ts` — five-tab lease cap.
- Create: `packages/chatgpt-web/src/browser/process-line-writer.ts` — helper-process JSONL output safety.
- Create: `packages/chatgpt-web/src/runtime/host.ts` — local/launcher-neutral browser host interface.
- Create: `packages/chatgpt-web/src/runtime/local-host.ts` — system-Chrome local host used in provider milestone one.
- Create: `packages/chatgpt-web/src/mcp/broker.ts` — full-mode capability and tool-result broker.
- Create: `packages/chatgpt-web/src/mcp/server.ts` — stdio MCP server for the ChatGPT connector.
- Create: `packages/chatgpt-web/src/mcp/tunnel.ts` — pinned tunnel-client download, checksum verification, and lifecycle.

### Host changes

- Modify: `packages/coding-agent/src/cli-commands.ts` — one lazy `chatgpt-web` command entry.
- Create: `packages/coding-agent/src/commands/chatgpt-web.ts` — extension enable/disable/status/login/doctor wrapper.
- Modify: `packages/coding-agent/package.json` — add the workspace dependency used by `src/commands/chatgpt-web.ts`.
- Modify: `docs/models.md` — native model setup and model metadata.
- Modify: `docs/providers.md` — browser profile, login, privacy, and tool-mode behavior.
- Modify: `docs/user-facing-packages.md` — package index entry.

### Launcher package (provider gate required)

- Create: `packages/chatgpt-web-launcher/package.json` — Electron/React/Vite/electron-builder package.
- Create: `packages/chatgpt-web-launcher/electron/main.cjs` — Electron main process.
- Create: `packages/chatgpt-web-launcher/electron/browser-host.cjs` — persistent partition and five-tab surface host.
- Create: `packages/chatgpt-web-launcher/electron/control-server.cjs` — authenticated loopback control API.
- Create: `packages/chatgpt-web-launcher/electron/runtime-supervisor.cjs` — runtime/tunnel health, drain, restart, and shutdown.
- Create: `packages/chatgpt-web-launcher/electron/runtime-install.cjs` — atomic runtime bundle installation.
- Create: `packages/chatgpt-web-launcher/src/App.tsx` — setup/browser/activity/settings UI.
- Create: `packages/chatgpt-web-launcher/src/preload.cjs` — narrow authenticated IPC surface.
- Create: `packages/chatgpt-web-launcher/src/types.ts` — renderer/control contracts.
- Create: `packages/chatgpt-web-launcher/src/i18n.ts` and styling files — user-facing copy and tokens.

### Root metadata and provenance

- Modify: `package.json` — add catalog entries and `chatgpt-web:*`/`chatgpt-web:launcher:*` scripts for the user-facing package commands.
- Modify: `bun.lock` — lock the workspace dependency graph after package manifests are complete.
- Create: `packages/chatgpt-web/LICENSES/NOTICE.md`, `OpenCodex-MIT.txt`, and `Bun-1.3.11.md` — preserved/adapted notices.
- Create: `packages/chatgpt-web/test/` — focused unit/fixture tests.
- Create: `packages/chatgpt-web-launcher/test/` — focused launcher tests.

---

## Task 1: Create the isolated workspace package

**Files:**
- Create: `packages/chatgpt-web/package.json`
- Create: `packages/chatgpt-web/tsconfig.json`
- Create: `packages/chatgpt-web/src/index.ts`
- Create: `packages/chatgpt-web/src/provider/types.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `packages/chatgpt-web/test/package-contract.test.ts`

**Interfaces:**
- Produces `ChatGptWebRuntimeConfig`, `ChatGptWebModelRoute`, `ChatGptWebEvent`, and `createChatGptWebStream` declarations consumed by Tasks 2–5.
- Exposes package export `@oh-my-pi/pi-chatgpt-web/extension` resolving to `src/extension.ts`.

- [ ] **Step 1: Add the package manifest and workspace dependencies.**

Use the root catalog rather than a second lockfile. Add these package dependencies with the source project's compatible versions, then raise the package engine floor to the monorepo floor:

```json
{
  "name": "@oh-my-pi/pi-chatgpt-web",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "bin": { "omp-chatgpt-web": "./src/cli.ts" },
  "engines": { "bun": ">=1.3.14" },
  "exports": {
    ".": { "types": "./src/index.ts", "import": "./src/index.ts" },
    "./extension": { "types": "./src/extension.ts", "import": "./src/extension.ts" },
    "./cli": { "types": "./src/cli.ts", "import": "./src/cli.ts" }
  },
  "scripts": {
    "check": "bun run check:types && bun run test",
    "check:types": "tsgo -p tsconfig.json --noEmit",
    "test": "bun test test/**/*.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "catalog:",
    "chromium-bidi": "catalog:",
    "fflate": "catalog:",
    "playwright-core": "catalog:",
    "turndown": "catalog:",
    "turndown-plugin-gfm": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "@types/turndown": "catalog:"
  }
}
```

Add the missing package names to the root catalog using the locked source-compatible versions: `@modelcontextprotocol/sdk` `^1.26.0`, `chromium-bidi` `12.1.0`, `fflate` `^0.8.2`, `playwright-core` `^1.62.0`; reuse the root `turndown`, `turndown-plugin-gfm`, `zod`, and Bun type entries.

- [ ] **Step 2: Add the package TypeScript boundary.**

`packages/chatgpt-web/tsconfig.json` must extend the workspace base, include only `src` and `test`, and use the same module/resolution settings as sibling TypeScript packages. Do not add a second compiler configuration or a package-local formatter configuration.

- [ ] **Step 3: Define the package-owned event contract.**

Create `src/provider/types.ts` with an explicit event union. The core shape is:

```ts
export type ChatGptWebEvent =
  | { type: "start"; responseId: string }
  | { type: "reasoning"; text: string; continuation?: boolean }
  | { type: "commentary"; text: string; continuation?: boolean }
  | { type: "text"; text: string; continuation?: boolean }
  | { type: "tool_call"; callId: string; name: string; argumentsJson: string; freeform: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: "done"; reason: "stop" | "toolUse" | "length" }
  | { type: "error"; error: Error };

export interface ChatGptWebTurnIdentity {
  sessionId: string;
  turnId: string;
}
```

The OMP stream adapter in Task 4 is the only translator into OMP events; no later adapter may import Codex types.

- [ ] **Step 4: Add public exports and a contract test.**

Export the event/config/model/provider symbols from `src/index.ts`. The package contract test must import the package entry and extension subpath, assert that the route table contains the four non-Pro routes plus Pro, and assert that the custom API identifier is exactly `chatgpt-web`.

- [ ] **Step 5: Install and run the focused check.**

Run:

```text
bun install --frozen-lockfile
bun --cwd=packages/chatgpt-web check
```

Expected: dependency resolution succeeds; the package contract test passes; no application/browser code is loaded yet.

- [ ] **Step 6: Commit the package boundary.**

```text
git add packages/chatgpt-web package.json bun.lock
git commit -m "feat: add ChatGPT Web provider package boundary"
```

---

## Task 2: Implement secure config, model routes, and browser login

**Files:**
- Create: `packages/chatgpt-web/src/config.ts`
- Create: `packages/chatgpt-web/src/models.ts`
- Create: `packages/chatgpt-web/src/browser/login.ts`
- Create: `packages/chatgpt-web/test/config.test.ts`
- Create: `packages/chatgpt-web/test/models.test.ts`
- Create: `packages/chatgpt-web/test/login.test.ts`

**Interfaces:**
- Consumes: `ChatGptWebRuntimeConfig` and `ChatGptWebModelRoute` from Task 1.
- Produces:
  - `resolveChatGptWebPaths(agentDir?: string): ChatGptWebPaths`
  - `availableChatGptWebModelRoutes(proAvailable: boolean)`
  - `createChatGptWebProviderModels(proAvailable: boolean, fullMode: boolean)`
  - `loginChatGptWeb(options): Promise<ChatGptWebLoginResult>`
  - `hasChatGptWebLogin(): boolean`

- [ ] **Step 1: Port the fixed route table.**

Adapt `codex-chatgpt-web/src/chatgpt-web-models.ts` into `src/models.ts`. Keep IDs and efforts exactly:

```ts
export const CHATGPT_WEB_MODEL_ROUTES = [
  { id: "chatgpt-web/light", displayName: "ChatGPT Web — Instant", effort: "low", requiresPro: false },
  { id: "chatgpt-web/medium", displayName: "ChatGPT Web — Medium", effort: "medium", requiresPro: false },
  { id: "chatgpt-web/high", displayName: "ChatGPT Web — High", effort: "high", requiresPro: false },
  { id: "chatgpt-web/extra-high", displayName: "ChatGPT Web — Extra High", effort: "xhigh", requiresPro: false },
  { id: "chatgpt-web/pro", displayName: "ChatGPT Web — Pro", effort: "max", requiresPro: true },
] as const;
```

`createChatGptWebProviderModels()` must use context window `256_000`, maximum output `64_000`, zero costs, `input: ["text", "image"]`, reasoning enabled, and `supportsTools: false` for Pro or browser-only mode. It must omit service-tier claims and native WebSocket claims.

- [ ] **Step 2: Implement OMP-owned paths and atomic persistence.**

`resolveChatGptWebPaths()` must derive `${agentDir}/chatgpt-web`, with `agentDir` defaulting through the existing OMP `PI_CODING_AGENT_DIR` behavior. Return explicit paths for `config.json`, `control-token`, `browser-profile`, `verification.json`, and `logs`. Create files with restrictive permissions, write JSON through a sibling temporary file plus atomic rename, and reject profile/config paths outside the resolved package directory.

- [ ] **Step 3: Adapt the source login flow.**

Port `codex-chatgpt-web/src/browser-login.ts` to `src/browser/login.ts`. Login must:

1. Open a headed temporary ChatGPT page through the local browser host.
2. Verify an authenticated Temporary Chat page.
3. Detect Pro availability and write only a versioned boolean marker.
4. Never write cookies or tokens to logs.
5. Return an opaque profile ID for OMP OAuth storage; it is not an HTTP credential.

The stored marker must include `version: 1`, `authenticated: true`, `verifiedAt`, and `proAvailable`. Invalid or missing markers make the provider unavailable.

- [ ] **Step 4: Add deterministic model/config/login tests.**

Tests must cover:

- Windows path case normalization and traversal rejection.
- Atomic config replacement and restrictive file mode on POSIX.
- Pro omission/inclusion based on the verification marker.
- Exact effort mapping and Pro tool omission.
- Corrupt marker rejection and relogin requirement.
- Login cancellation closing the temporary browser context.

Use a fake browser host; no test may contact ChatGPT.

- [ ] **Step 5: Run focused tests.**

```text
bun test packages/chatgpt-web/test/config.test.ts packages/chatgpt-web/test/models.test.ts packages/chatgpt-web/test/login.test.ts
```

Expected: all deterministic tests pass with network disabled.

- [ ] **Step 6: Commit config and login.**

```text
git add packages/chatgpt-web/src/config.ts packages/chatgpt-web/src/models.ts packages/chatgpt-web/src/browser/login.ts packages/chatgpt-web/test
git commit -m "feat: add ChatGPT Web profile and model configuration"
```

---

## Task 3: Port the browser worker behind a runtime-host interface

**Files:**
- Create: `packages/chatgpt-web/src/runtime/host.ts`
- Create: `packages/chatgpt-web/src/runtime/local-host.ts`
- Create: `packages/chatgpt-web/src/browser/browser-worker.ts`
- Create: `packages/chatgpt-web/src/browser/chatgpt-session.ts`
- Create: `packages/chatgpt-web/src/browser/markdown.ts`
- Create: `packages/chatgpt-web/src/browser/concurrency.ts`
- Create: `packages/chatgpt-web/src/browser/process-line-writer.ts`
- Create: `packages/chatgpt-web/test/browser-worker.test.ts`
- Create: `packages/chatgpt-web/test/browser-contract.test.ts`

**Interfaces:**
- Consumes: config, login marker, model routes, and event types from Tasks 1–2.
- Produces:

```ts
export interface BrowserHost {
  lease(request: BrowserLeaseRequest): Promise<BrowserLease>;
  release(lease: BrowserLease): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserLease {
  id: string;
  page: unknown;
  close(): Promise<void>;
}
```

`local-host.ts` is the only implementation in the provider milestone. The launcher milestone will implement the same interface through a descriptor/control client.

- [ ] **Step 1: Define the host boundary before porting selectors.**

Keep `BrowserHost` free of Electron, coding-agent, and Codex types. The request must contain only profile path, headed/headless mode, turn ID, and abort signal. A lease must be independently closable so cancellation destroys the corresponding page without affecting other turns.

- [ ] **Step 2: Adapt the browser worker.**

Port `codex-chatgpt-web/src/adapters/chatgpt-web/browser-worker.ts` and related selector code. Preserve:

- fresh `CHATGPT_TEMPORARY_CHAT_URL` navigation for each turn;
- exact effort selection from the model route;
- attachment validation before send;
- user/assistant/generation evidence before treating a response as submitted;
- completion action plus settled text before completion;
- heartbeat and abort propagation;
- five active tab cap, with an explicit sixth-turn error;
- Markdown conversion that removes controls/scripts/styles and keeps fenced code/GFM lists.

The worker emits `ChatGptWebEvent` values through callbacks; it must not know about OMP `AssistantMessageEventStream`.

- [ ] **Step 3: Port process-line and launcher-neutral helper behavior.**

Keep `process-line-writer.ts` error listeners and EOF handling from the source. The provider milestone keeps any helper process package-local; the launcher milestone uses `BrowserHost` through its authenticated descriptor and does not add a second OMP worker entrypoint.

- [ ] **Step 4: Add browser fixture tests.**

Use a fake page/locator implementation to verify selector contracts without a live browser. Cover effort selection, attachment/send readiness, completion tracker settle delay, DOM health failure, abort, five leases, sixth rejection, and helper EOF. Add one fixture per source regression represented by recent commits `2441ff6`, `2dfc791`, and `20c21b0`.

- [ ] **Step 5: Run focused browser tests.**

```text
bun test packages/chatgpt-web/test/browser-worker.test.ts packages/chatgpt-web/test/browser-contract.test.ts
```

Expected: tests pass without `Chrome` or network access.

- [ ] **Step 6: Commit the browser runtime.**

```text
git add packages/chatgpt-web/src/runtime packages/chatgpt-web/src/browser packages/chatgpt-web/test
git commit -m "feat: add ChatGPT Web browser runtime"
```

---

## Task 4: Adapt prompts, turns, and output into native OMP events

**Files:**
- Create: `packages/chatgpt-web/src/provider/prompt.ts`
- Create: `packages/chatgpt-web/src/provider/session.ts`
- Create: `packages/chatgpt-web/src/provider/stream.ts`
- Create: `packages/chatgpt-web/test/provider/prompt.test.ts`
- Create: `packages/chatgpt-web/test/provider/stream.test.ts`
- Create: `packages/chatgpt-web/test/provider/continuation.test.ts`
- Create: `packages/chatgpt-web/test/fixtures/chatgpt-events.ts`

**Interfaces:**
- Consumes: `BrowserHost`, browser worker events, OMP `Context`, `Message`, `Model`, `SimpleStreamOptions`, and `AssistantMessageEventStream`.
- Produces:

```ts
export function createChatGptWebStream(options?: ChatGptWebStreamOptions):
  (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) => AssistantMessageEventStream;

export interface ChatGptWebStreamOptions {
  config?: ChatGptWebRuntimeConfig;
  host?: BrowserHost;
  now?: () => number;
}
```

- [ ] **Step 1: Define the OMP prompt envelope.**

Adapt `src/adapters/chatgpt-web/prompt.ts` to serialize `Context.systemPrompt`, `Context.messages`, tool schemas, model route, and OMP session identity. Do not serialize Codex metadata, Codex prompt hashes, or retired Codex request fields. Keep images out of the JSON body and represent them as stable attachment references. Reattach current-turn images on every fresh Temporary Chat. Enforce the source limits of at most 10 attachments and 50 MB total, failing explicitly on overflow.

- [ ] **Step 2: Implement session keys and continuation.**

Use `options.sessionId` as the stable outer session key and generate a random per-turn ID. Keep active sessions in `providerSessionState` under a package-prefixed key. The session stores browser lease, trace feed, text feed, pending tool-call IDs, model route, and expiry. It must reject a model/effort change while a browser turn is active and must close leases on abort, error, or session shutdown.

- [ ] **Step 3: Convert browser events to OMP events.**

Build the partial `AssistantMessage` incrementally:

- `reasoning` → `thinking_start`/`thinking_delta`/`thinking_end`;
- `commentary` and `text` → `text_start`/`text_delta`/`text_end`;
- browser tool request → `toolcall_start`/`toolcall_delta`/`toolcall_end` with the original call ID and exact JSON arguments;
- `done` → `done` with `reason: "stop"`, `"toolUse"`, or `"length"`;
- abort/provider failure → `error` with `"aborted"` or `"error"`.

Do not emit a tool call unless its name is present in the current `Context.tools` set and its arguments parse against the tool schema. Do not execute tools inside this package.

- [ ] **Step 4: Implement browser-only continuation.**

In browser-only mode, return the browser answer as a normal assistant response. In full mode, when the broker produces tool calls, end the provider stream with `toolUse`; on the next invocation, consume matching `ToolResultMessage` entries from `context.messages` and resume the pending ChatGPT turn. A missing, duplicate, expired, or mismatched result is a hard provider error.

- [ ] **Step 5: Make compaction behavior explicit.**

Use OMP's existing local compaction path for the `256_000` provider window. If `streamOptions.codexCompaction` is received by the custom stream, return a clear unsupported-operation error rather than opening a hidden ChatGPT summarizer turn. This prevents accidental double compaction and preserves the source's fail-closed rule.

- [ ] **Step 6: Test event and continuation contracts.**

Tests must assert exact event order for reasoning/text, partial tool JSON, tool-use termination, OMP tool-result continuation, abort, malformed event, image attachment references, retired-handle redaction, and Pro tool rejection. The continuation test must prove that a tool result is consumed exactly once and cannot resolve a different session.

- [ ] **Step 7: Run focused provider tests.**

```text
bun test packages/chatgpt-web/test/provider/**/*.test.ts
```

Expected: all event/continuation tests pass with fake browser events and no network.

- [ ] **Step 8: Commit the native provider adapter.**

```text
git add packages/chatgpt-web/src/provider packages/chatgpt-web/test/provider packages/chatgpt-web/test/fixtures
git commit -m "feat: expose ChatGPT Web as an OMP stream provider"
```

---

## Task 5: Register the provider and add local CLI enablement

**Files:**
- Create: `packages/chatgpt-web/src/extension.ts`
- Create: `packages/coding-agent/src/commands/chatgpt-web.ts`
- Modify: `packages/coding-agent/src/cli-commands.ts`
- Modify: `packages/coding-agent/package.json`
- Create: `packages/coding-agent/test/chatgpt-web-command.test.ts`
- Modify: `packages/coding-agent/test/model-registry-runtime-provider.test.ts`

**Interfaces:**
- Consumes: `createChatGptWebStream`, route/model/config/login APIs from `packages/chatgpt-web`.
- Produces the provider registration:

```ts
pi.registerProvider("chatgpt-web", {
  baseUrl: "chatgpt-web://local",
  api: "chatgpt-web",
  oauth: createChatGptWebOAuth(),
  models: createChatGptWebProviderModels(proAvailable, fullMode),
  streamSimple: createChatGptWebStream(),
});
```

- [ ] **Step 1: Implement the extension factory.**

`packages/chatgpt-web/src/extension.ts` must export a default `ExtensionFactory`. It reads the package marker/config, registers the custom API and static routes, and uses the existing OAuth callback shape only to persist the opaque local profile identifier. It must not import coding-agent execution internals.

- [ ] **Step 2: Add the lazy host command.**

Add one `chatgpt-web` command entry to `packages/coding-agent/src/cli-commands.ts`. `src/commands/chatgpt-web.ts` must:

- resolve `@oh-my-pi/pi-chatgpt-web/extension` with the package export;
- `enable`: append the resolved absolute extension path to `settings.extensions` exactly once;
- `disable`: remove only that path;
- `status`: report activation, login marker, Pro availability, and browser runtime health without printing secrets;
- `login`: invoke the package login flow;
- `doctor`: run the non-destructive checks consumed by the launcher health tests in Task 10.

Do not change general extension discovery or add an always-on provider.

- [ ] **Step 3: Add host dependency and model-registry coverage.**

Add the workspace package dependency required by the command wrapper. Extend `model-registry-runtime-provider.test.ts` with a source-scoped registration case that asserts `chatgpt-web` is removed after `clearSourceRegistrations()` and that no built-in API registration is left behind.

- [ ] **Step 4: Test enable/disable behavior.**

The command test must use a temporary settings directory and assert idempotent enable, exact disable, no unrelated extension removal, no secret output, and model discovery after loading the extension.

- [ ] **Step 5: Run host-focused checks.**

```text
bun test packages/coding-agent/test/chatgpt-web-command.test.ts packages/coding-agent/test/model-registry-runtime-provider.test.ts
bun --cwd=packages/coding-agent check:types
```

Expected: custom API registration, cleanup, command behavior, and type checks pass.

- [ ] **Step 6: Commit host enablement.**

```text
git add packages/chatgpt-web/src/extension.ts packages/coding-agent/src/commands/chatgpt-web.ts packages/coding-agent/src/cli-commands.ts packages/coding-agent/package.json packages/coding-agent/test
git commit -m "feat: register ChatGPT Web in the OMP model picker"
```

---

## Task 6: Complete and validate browser-only mode locally

**Files:**
- Modify: `packages/chatgpt-web/src/cli.ts`
- Modify: `packages/chatgpt-web/src/provider/stream.ts`
- Create: `packages/chatgpt-web/test/browser-only-e2e.test.ts`
- Modify: `docs/models.md`
- Modify: `docs/providers.md`
- Modify: `docs/user-facing-packages.md`

**Interfaces:**
- Consumes: native provider and login command from Tasks 2–5.
- Produces: a documented browser-only mode with no MCP server, tunnel, or Electron dependency.

- [ ] **Step 1: Add explicit browser-only mode selection.**

Use package config, not an environment-only hidden flag, to select `browser-only` versus `full`. `browser-only` must never start the broker, MCP server, tunnel, or launcher helper. Pro must remain selectable only when the login marker reports capability.

- [ ] **Step 2: Add the local smoke harness.**

Create a harness that uses the package-owned local browser profile and real OMP CLI/model selection, but injects fake ChatGPT pages for deterministic CI tests. The harness must expose text, reasoning, image, cancellation, and tab-limit scenarios without mocking OMP's agent loop.

- [ ] **Step 3: Exercise the real local profile manually.**

Run:

```text
bun run --cwd=packages/coding-agent src/cli.ts chatgpt-web enable
bun run --cwd=packages/coding-agent src/cli.ts chatgpt-web login
bun run --cwd=packages/coding-agent src/cli.ts models find "ChatGPT Web"
bun run --cwd=packages/coding-agent src/cli.ts --model chatgpt-web/light --smoke-test
```

Then manually use each non-Pro model for one text turn, one reasoning-visible turn, one image turn, one cancellation, and five parallel turns. Start a sixth turn and verify the explicit bounded-concurrency error. Record the exact result locally before moving to full mode.

- [ ] **Step 4: Run package and host checks.**

```text
bun --cwd=packages/chatgpt-web check
bun --cwd=packages/coding-agent check
bun run ci:test:smoke
```

Expected: package checks, host checks, and the OMP smoke command pass; no MCP/tunnel process is started in browser-only mode.

- [ ] **Step 5: Commit the browser-only milestone.**

```text
git add packages/chatgpt-web packages/coding-agent docs/models.md docs/providers.md docs/user-facing-packages.md
 git commit -m "feat: validate ChatGPT Web browser-only mode"
```

Do not begin launcher work until this manual smoke has passed.

---

## Task 7: Add full-mode MCP capability routing

**Files:**
- Create: `packages/chatgpt-web/src/mcp/broker.ts`
- Create: `packages/chatgpt-web/src/mcp/server.ts`
- Create: `packages/chatgpt-web/src/mcp/main.ts`
- Create: `packages/chatgpt-web/test/mcp/broker.test.ts`
- Create: `packages/chatgpt-web/test/mcp/server.test.ts`
- Modify: `packages/chatgpt-web/src/provider/session.ts`
- Modify: `packages/chatgpt-web/src/provider/stream.ts`

**Interfaces:**
- Consumes: OMP `Tool`, `Context`, `ToolCall`, `ToolResultMessage`, session IDs, and the browser-only provider session.
- Produces:

```ts
export interface OmpTurnBinding {
  sessionId: string;
  turnId: string;
  bindingId: string;
  expiresAt: number;
  tools: readonly Tool[];
}

export interface OmpTurnBroker {
  claim(binding: OmpTurnBinding): Promise<void>;
  nextInvocation(bindingId: string, signal?: AbortSignal): Promise<BrokerToolRequest>;
  resolve(bindingId: string, callId: string, result: ToolResultMessage): Promise<void>;
  release(bindingId: string): Promise<void>;
}
```

- [ ] **Step 1: Adapt the source broker to OMP identity.**

Port the source `TurnBroker` state machine, replacing Codex trace IDs and request envelopes with `sessionId`, generated `turnId`, opaque `bindingId`, expiry, and the current OMP tool declaration set. Bind each browser MCP invocation to exactly one active turn. Retain line-size caps, duplicate-call rejection, abort handling, retired-handle bounds, and close-time rejection.

- [ ] **Step 2: Map MCP tools to OMP tools.**

The MCP server must expose only the tools in the active `OmpTurnBinding`. Match exact OMP tool name and `customWireName` rules. Reject names absent from the binding before touching the broker. Never let ChatGPT supply a filesystem path or approval decision outside the OMP tool arguments.

- [ ] **Step 3: Return tool calls to the OMP agent loop.**

When MCP invokes a tool, the provider stream emits an OMP tool call and returns `toolUse`. The OMP agent loop performs approval and execution. The next provider call finds the matching `ToolResultMessage.toolCallId` and resolves the broker invocation. A missing/duplicate/mismatched result expires the binding and fails the turn.

- [ ] **Step 4: Add MCP tests without a tunnel.**

Test claim expiry, unknown tool rejection, duplicate call IDs, multiple parallel calls, result matching, abort while waiting, release cleanup, JSON size cap, and a Pro model attempting an invocation. Use an in-memory transport; do not spawn ChatGPT or a real tunnel.

- [ ] **Step 5: Run focused full-mode broker tests.**

```text
bun test packages/chatgpt-web/test/mcp/**/*.test.ts packages/chatgpt-web/test/provider/continuation.test.ts
```

Expected: all capability and continuation tests pass, including parallel invocation ordering.

- [ ] **Step 6: Commit the full-mode broker.**

```text
git add packages/chatgpt-web/src/mcp packages/chatgpt-web/src/provider packages/chatgpt-web/test/mcp packages/chatgpt-web/test/provider/continuation.test.ts
git commit -m "feat: bind ChatGPT Web MCP calls to OMP turns"
```

---

## Task 8: Add the pinned tunnel and full-mode lifecycle

**Files:**
- Create: `packages/chatgpt-web/src/mcp/tunnel.ts`
- Modify: `packages/chatgpt-web/src/config.ts`
- Modify: `packages/chatgpt-web/src/cli.ts`
- Create: `packages/chatgpt-web/test/mcp/tunnel.test.ts`
- Create: `packages/chatgpt-web/test/lifecycle.test.ts`
- Modify: `docs/providers.md`

**Interfaces:**
- Consumes: `OmpTurnBroker`, secure paths, package CLI, and source tunnel behavior.
- Produces: explicit `full` lifecycle with tunnel-first startup and authenticated drain/shutdown.

- [ ] **Step 1: Define the tunnel artifact manifest.**

Pin one `openai/tunnel-client` version per supported OS/architecture in a checked-in manifest containing URL, SHA-256, executable name, and expected version. Do not put account keys or tunnel IDs in the repository. Download into a temporary file, verify SHA-256 before rename, and make the installed file non-writable by ordinary runtime code where the platform permits.

- [ ] **Step 2: Implement tunnel lifecycle.**

Start the tunnel before the MCP server, wait for healthy/ready evidence, and expose a versioned local health payload. Stop through the process handle, not a shell-wide kill. Bound shutdown and report a hard failure if the tunnel remains active after the deadline.

- [ ] **Step 3: Add authenticated runtime lifecycle controls.**

Implement loopback-only authenticated HTTP endpoints for health, drain, resume, cancel-browser-turns, and shutdown. Use a random control token from `resolveChatGptWebPaths()`. Drain rejects new turns and waits for both active browser sessions and active MCP calls to reach zero.

- [ ] **Step 4: Make browser-only/full mode mutually explicit.**

`browser-only` must reject full-mode-only commands; `full` must fail closed if tunnel credentials, MCP configuration, or tunnel checksum verification are missing. No mode switch may happen mid-turn.

- [ ] **Step 5: Test lifecycle and artifact security.**

Test checksum mismatch, corrupt executable, ready timeout, drain with active browser turn, drain with pending MCP result, shutdown timeout, restart budget, token mismatch, loopback bind, and mode-specific startup. Tests use fake child processes and fake clocks.

- [ ] **Step 6: Run full-mode package checks.**

```text
bun test packages/chatgpt-web/test/mcp/tunnel.test.ts packages/chatgpt-web/test/lifecycle.test.ts
bun --cwd=packages/chatgpt-web check
```

Expected: lifecycle tests pass without downloading a real tunnel binary.

- [ ] **Step 7: Commit full-mode lifecycle.**

```text
git add packages/chatgpt-web/src/mcp/tunnel.ts packages/chatgpt-web/src/config.ts packages/chatgpt-web/src/cli.ts packages/chatgpt-web/test docs/providers.md
 git commit -m "feat: add ChatGPT Web full-mode lifecycle"
```

---

## Task 9: Validate full mode with real OMP tools

**Files:**
- Create: `packages/chatgpt-web/test/full-mode-e2e.test.ts`
- Modify: `packages/chatgpt-web/src/provider/stream.ts`
- Modify: `packages/chatgpt-web/src/mcp/server.ts`

**Interfaces:**
- Consumes: full-mode broker/tunnel lifecycle from Tasks 7–8.
- Produces: a repeatable local acceptance scenario covering tool calls, approvals, errors, cancellation, and continuation.

- [ ] **Step 1: Add a real OMP tool fixture.**

Use the existing OMP read/write tool definitions and approval path, not a fake executor. The fixture must expose one read-only tool and one write-gated tool in a temporary workspace, record invocations, and return deterministic results/errors.

- [ ] **Step 2: Run the real full-mode login/setup.**

```text
bun run --cwd=packages/coding-agent src/cli.ts chatgpt-web enable
bun run --cwd=packages/coding-agent src/cli.ts chatgpt-web login
bun run --cwd=packages/coding-agent src/cli.ts chatgpt-web status
```

Configure the ChatGPT custom connector/tunnel using the package's documented full-mode flow. Verify the tunnel and MCP server identify the same local runtime before starting a model turn.

- [ ] **Step 3: Exercise the acceptance matrix.**

Run a real OMP session with `chatgpt-web/medium` and verify:

1. ChatGPT invokes the read tool and OMP executes it.
2. ChatGPT invokes the write tool and OMP approval is required.
3. Denying the write leaves the workspace unchanged and returns an error result.
4. A tool failure is returned to ChatGPT without losing the turn binding.
5. Cancellation while a tool is pending aborts the browser turn and releases the binding.
6. The next model call consumes the exact tool result once and continues the same ChatGPT turn.
7. Pro never advertises or accepts the local tools.

- [ ] **Step 4: Run all local checks.**

```text
bun --cwd=packages/chatgpt-web check
bun --cwd=packages/coding-agent check
bun run ci:test:smoke
```

Record the exact manual scenario and outcome in the local development log; do not include account identifiers, cookies, or tunnel secrets.

- [ ] **Step 5: Commit full-mode validation.**

```text
git add packages/chatgpt-web packages/coding-agent
 git commit -m "test: validate ChatGPT Web full mode with OMP tools"
```

Launcher work is blocked until this acceptance matrix passes.

---

## Task 10: Add the Electron launcher as a second local package

**Files:**
- Create: `packages/chatgpt-web-launcher/package.json`
- Create: `packages/chatgpt-web-launcher/electron/main.cjs`
- Create: `packages/chatgpt-web-launcher/electron/browser-host.cjs`
- Create: `packages/chatgpt-web-launcher/electron/control-server.cjs`
- Create: `packages/chatgpt-web-launcher/electron/runtime-supervisor.cjs`
- Create: `packages/chatgpt-web-launcher/electron/runtime-install.cjs`
- Create: `packages/chatgpt-web-launcher/src/App.tsx`
- Create: `packages/chatgpt-web-launcher/src/preload.cjs`
- Create: `packages/chatgpt-web-launcher/src/types.ts`
- Create: `packages/chatgpt-web-launcher/src/i18n.ts`
- Create: `packages/chatgpt-web-launcher/vite.config.ts`
- Create: `packages/chatgpt-web-launcher/index.html`
- Create: `packages/chatgpt-web-launcher/test/browser-host.test.cjs`
- Create: `packages/chatgpt-web-launcher/test/control-server.test.cjs`
- Create: `packages/chatgpt-web-launcher/test/runtime-supervisor.test.cjs`
- Create: `packages/chatgpt-web-launcher/test/runtime-install.test.cjs`

- Modify: `packages/chatgpt-web/src/runtime/host.ts` — add the authenticated descriptor-backed host implementation without changing the provider-facing interface.
- Create: `packages/chatgpt-web/src/runtime/launcher-host.ts` — control client for launcher leases, turn start/end, and descriptor refresh.
**Interfaces:**
- Consumes the `BrowserHost` interface and lifecycle controls from Tasks 3 and 8.
- Produces a launcher that can supervise the same provider runtime without changing `streamSimple` or OMP model semantics.

- [ ] **Step 1: Create the launcher package and package-local build.**

Adapt the source launcher manifest to the OMP workspace, using the current OMP React/Vite conventions and Electron targets for macOS, Windows, and Linux. Keep Electron dependencies isolated to this package. Do not add Electron to `packages/coding-agent`.

- [ ] **Step 2: Port the persistent browser host.**

Adapt `launcher/electron/browser-host.cjs` to expose the `BrowserHost` lease contract through an authenticated descriptor. Update `packages/chatgpt-web/src/runtime/launcher-host.ts` to validate the descriptor, authenticate every lease request, and close a single surface on cancellation. Keep one persistent partition and at most five task-bound `WebContentsView` surfaces. A closed or cancelled surface must terminate only its own browser turn.

- [ ] **Step 3: Port the control server and supervisor.**

Adapt the source control server and runtime supervisor. The supervisor starts tunnel first in full mode, waits for versioned health, starts the runtime, drains before replacement, uses bounded restart recovery, and reports crash loops explicitly. Every control request requires the random bearer token.

- [ ] **Step 4: Port durable runtime installation.**

Copy only the runtime-install contract needed for packaged apps. Validate bundle identity, copy atomically into a versioned private directory, and never persist an AppImage mount path or ASAR path in OMP settings.

- [ ] **Step 5: Build the UI around health evidence.**

The UI must show setup/login status, browser-only/full mode, runtime health, active turns, MCP connection, logs with secrets redacted, and explicit failure state. It must not expose raw cookies, control tokens, or tunnel credentials through preload IPC.

- [ ] **Step 6: Add launcher tests.**

Test descriptor authentication, five-tab lease/release, sixth-tab rejection, process ordering, drain counters, crash-loop budget, atomic runtime installation, AppImage/ASAR path handling, IPC allow-list, and secret redaction. Use fake Electron/process adapters.

- [ ] **Step 7: Run launcher package checks and smoke packaging.**

```text
bun --cwd=packages/chatgpt-web-launcher check
bun --cwd=packages/chatgpt-web-launcher build
bun --cwd=packages/chatgpt-web-launcher test
```

Expected: package build/test succeeds without a signed release or account credentials. Run platform packaging on macOS, Windows, and Linux CI runners before considering the launcher locally complete.

- [ ] **Step 8: Commit the launcher separately.**

```text
git add packages/chatgpt-web-launcher packages/chatgpt-web/src/runtime/host.ts packages/chatgpt-web/src/runtime/launcher-host.ts
 git commit -m "feat: add ChatGPT Web desktop launcher"
```

This commit is intentionally separate from the native provider milestone so the provider can be reviewed and reverted independently.

---

## Task 11: Finish documentation, notices, CI, and local release checks

**Files:**
- Modify: `docs/models.md`
- Modify: `docs/providers.md`
- Modify: `docs/user-facing-packages.md`
- Create: `packages/chatgpt-web/README.md`
- Create: `packages/chatgpt-web/docs/security-model.md`
- Create: `packages/chatgpt-web/docs/architecture.md`
- Create: `packages/chatgpt-web/LICENSES/NOTICE.md`
- Create: `packages/chatgpt-web/LICENSES/OpenCodex-MIT.txt`
- Create: `packages/chatgpt-web/LICENSES/Bun-1.3.11.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml` — add the launcher packaging matrix for macOS, Windows, and Linux after Task 10 is complete.
- Modify: `package.json` — add the package check/build/test scripts used by local and CI commands.

**Interfaces:**
- Consumes all finalized provider and launcher contracts.
- Produces user-facing setup documentation, security boundaries, third-party attribution, focused CI jobs, and no generated noise in unrelated packages.

- [ ] **Step 1: Document the native setup path.**

Document exactly:

```text
omp chatgpt-web enable
omp chatgpt-web login
omp models find "ChatGPT Web"
omp --model chatgpt-web/medium
```

Explain browser-only versus full mode, profile location, Pro limitations, five-tab cap, cancellation, local tool approval, and the fact that the browser automation depends on ChatGPT UI stability and account capability.

- [ ] **Step 2: Document security and data flow.**

Add package architecture and security docs covering loopback binding, control tokens, browser profile storage, tunnel credentials, MCP capability binding, OMP approval authority, logging redaction, and fail-closed behavior. Do not copy Codex-specific setup instructions.

- [ ] **Step 3: Preserve and regenerate notices.**

Copy/adapt the source notices and add every dependency actually present in `bun.lock`. Verify that OpenCodex attribution remains separate from OMP's own MIT notice.

- [ ] **Step 4: Add focused CI jobs.**

Run package type checks/unit tests on the existing OMP CI matrix. Add browser fixtures without requiring ChatGPT credentials. Gate live browser and tunnel smoke behind an explicit local/manual workflow; never put account secrets in the normal PR workflow.

- [ ] **Step 5: Run final local validation.**

```text
bun install --frozen-lockfile
bun --cwd=packages/chatgpt-web check
bun --cwd=packages/coding-agent check
bun run check
bun run ci:test:smoke
bun run --workspaces --if-present build
```

For the launcher, also run its package check/build/test commands from Task 10 on each supported OS runner.

- [ ] **Step 6: Commit documentation and CI separately.**

```text
git add packages/chatgpt-web packages/chatgpt-web-launcher docs .github/workflows package.json bun.lock
 git commit -m "docs: document and validate ChatGPT Web integration"
```

---

## Task 12: Rebase and prepare, but do not submit, the upstream contribution

**Files:**
- No source files unless rebase conflicts expose a real integration defect.
- Review: all commits and generated lockfile/notice changes.

**Interfaces:**
- Consumes the tested local branch and both remotes.
- Produces a clean, reviewable local branch and a draft change summary without pushing or opening a PR.

- [ ] **Step 1: Rebase against the current upstream main.**

```text
git fetch upstream main
git rebase upstream/main
```

Resolve only integration conflicts; do not merge unrelated upstream changes or regenerate the whole repository.

- [ ] **Step 2: Repeat every verification gate after rebase.**

Run all commands from Tasks 6, 9, 10, and 11. Repeat the live browser-only and full-mode matrices because upstream changes may alter model/session/tool behavior.

- [ ] **Step 3: Inspect the local diff.**

Check that the diff contains only the new packages, required host seams, docs, notices, lockfile/catalog entries, and focused tests. Remove generated artifacts, account-specific files, cookies, logs, and temporary bundles before any future review.

- [ ] **Step 4: Build a local PR packet without submitting it.**

Prepare a local summary containing: problem, architecture, file ownership, security model, manual smoke scenarios/results, platform packaging results, dependency/license changes, known risks, and exact test commands. Do not use GitHub CLI to create a PR, issue, comment, or review.

- [ ] **Step 5: Stop at the maintainer-review gate.**

Only after the local branch is green and the packet is reviewed by the project owner should the work be considered ready for a future upstream discussion. Until then, keep both forks unchanged remotely.

---

## Final acceptance checklist

- [ ] Both forks remain private to `Nou4r`; no upstream PR or issue exists.
- [ ] `omp chatgpt-web enable` activates exactly one extension path.
- [ ] The native model picker lists all non-Pro routes after login and Pro only when entitled.
- [ ] Text, reasoning, image, cancellation, restart, and five-way parallel browser-only scenarios pass.
- [ ] A sixth concurrent browser turn fails explicitly.
- [ ] Full-mode MCP calls map only to current OMP tools and require OMP approval.
- [ ] Tool results resume the same session exactly once.
- [ ] Pro cannot invoke local tools.
- [ ] Browser/tunnel secrets are never logged or sent as API headers.
- [ ] Launcher health, drain, restart, and atomic installation tests pass on all target platforms.
- [ ] Licenses/notices are complete and generated from the current lockfile.
- [ ] Rebase verification passes against `upstream/main`.
- [ ] No GitHub PR, issue, push, or maintainer request is made before owner approval.
