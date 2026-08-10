# Prime Agent ↔ OMP P1 Control Plane and Mesh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a detached local bridge that lets OMP list/create/attach/prompt Prime sessions and exchange durable messages with them.

**Architecture:** A new `@oh-my-pi/prime-bridge` Bun package owns Prime daemon protocol v7, bridge SQLite state, authenticated loopback API, and the Prime Python skill. OMP session behavior stays in `packages/coding-agent`: an `ExternalPeerProvider` feeds Prime peers into `hub` without placing them in `AgentRegistry`.

**Tech Stack:** Bun 1.3.14, TypeScript, `bun:sqlite`, `Bun.serve`, Bun Unix sockets, omptype, Python 3.10 stdlib.

## Global Constraints

- Follow `/Users/ahpramesi/repos/oh-my-pi/AGENTS.md`: Bun APIs, centralized logger, ES `#private`, `Promise.withResolvers()`, no `any`, no `ReturnType<>`, no inline imports.
- Prime daemon source of truth: `/Users/ahpramesi/repos/prime-agent/packages/coding-agent/src/modes/daemon/daemon-protocol.ts`, protocol 7/schema 14.
- Prime recovery journal guarantees completed same-ID retries return stored results; received-without-result returns `command_result_uncertain`. Persist exact envelopes; never issue a new ID for an uncertain mutation.
- Socket trust is owner-only 0600/0700. Every HTTP route except `/health` requires a bearer header and rejects non-empty, non-allowlisted `Origin`.
- Preserve Prime `delivered|queued` and OMP `injected|woken|revived|failed` receipts separately.
- Detached bridge survives broker exit, but `restart:"always"` cannot restart a later crash while the broker is down. Document this exact limit.
- Do not commit unless explicitly asked.

---

### Task 1: Create dependency-neutral protocol package

**Files:**
- Create: `packages/prime-bridge-protocol/package.json`
- Create: `packages/prime-bridge-protocol/tsconfig.json`
- Create: `packages/prime-bridge-protocol/src/index.ts`
- Create: `packages/prime-bridge-protocol/src/protocol.ts`
- Test: `packages/prime-bridge-protocol/test/protocol.test.ts`

**Interfaces:**
- Produces `BridgeMessage`, `BridgeReceipt`, `ExternalPeer`, `PrimeDaemonCursor`, `PrimeDaemonHello`, `PrimeDaemonCommandEnvelope`, `PrimeDaemonOutbound`.

- [ ] Write fixture tests that accept protocol-7 hello/response/event frames, preserve unknown optional fields, reject wrong protocol names, and require generation+sequence together.
- [ ] Run `bun test packages/prime-bridge-protocol/test/protocol.test.ts`; expect module-not-found failure.
- [ ] Add the dependency-free `@oh-my-pi/prime-bridge-protocol` workspace package and contracts. Neither coding-agent nor prime-bridge owns duplicate wire DTOs; both depend on this package, preventing a coding-agent ⇄ prime-bridge runtime cycle:

```ts
export interface BridgeMessage {
  meshMessageId: string;
  idempotencyKey: string;
  originHarness: "omp" | "prime";
  originSessionId: string;
  targetHarness: "omp" | "prime";
  targetId: string;
  body: string;
  replyTo?: string;
  projectRoot: string;
  createdAt: string;
}
```

- [ ] Re-run the focused test; expect PASS.

### Task 2: Create bridge runtime package and durable state

**Files:**
- Create: `packages/prime-bridge/package.json`
- Create: `packages/prime-bridge/tsconfig.json`
- Create: `packages/prime-bridge/src/index.ts`
- Create: `packages/prime-bridge/src/store.ts`
- Test: `packages/prime-bridge/test/store.test.ts`

**Interfaces:**
- Produces `BridgeStore.open(path)`, `getOrCreateClientId()`, `getCursor()/setCursor()`, `enqueueMessage()`, `claimPendingMessages()`, `recordReceipt()`, `putInbox()`, `dedupe()`, `appendAudit()`.

- [ ] Write restart/dedupe tests: clientId and cursor survive reopen; duplicate idempotency keys yield one row; expired claims become claimable; audit previews cannot contain bearer values.
- [ ] Run `bun test packages/prime-bridge/test/store.test.ts`; expect failure.
- [ ] Add `@oh-my-pi/prime-bridge` (workspace version, binary `omp-prime-bridge`) with a dependency on `@oh-my-pi/prime-bridge-protocol`. Implement `bun:sqlite` tables `metadata`, `prime_cursors`, `outbox`, `inbox`, `receipts`, `audit`, with WAL, busy timeout, and transaction-per-transition.
- [ ] Re-run the test; expect PASS.

### Task 3: Implement Prime daemon v7 client

**Files:**
- Create: `packages/prime-bridge/src/prime/socket-path.ts`
- Create: `packages/prime-bridge/src/prime/snapshot-assembler.ts`
- Create: `packages/prime-bridge/src/prime/client.ts`
- Test: `packages/prime-bridge/test/prime-client.test.ts`

**Interfaces:**
- Produces `PrimeDaemonClient.connect()`, `listSessions()`, `createSession()`, `attach()`, `prompt()`, `sendMessage()`, `detach()`, `subscribe()`, `close()`.

- [ ] Write a fake daemon with `Bun.listen({unix})`. Test capability intersection, persisted clientId, duplicate-event rejection only within the same generation, chunk completeness, reconnect attach using stored cursor, and that bridge-originated `send_message` always omits `fromActiveSessionId` and `agentOrigin`.
- [ ] Add explicit journal tests: result delivered → `ack_result`; crash after result/before ack → exact same envelope returns stored result → ack; crash after `received`/before result → `command_result_uncertain`, no new-ID retry.
- [ ] Run `bun test packages/prime-bridge/test/prime-client.test.ts`; expect failure.
- [ ] Implement strict LF JSONL with `Bun.JSONL.parseChunk()`, hello-before-write, exact mutation-envelope persistence, bounded reconnect, response/event demux, snapshot validation, ack only after durable local receipt, and CLI-origin messaging only: never populate Prime family-identity fields.
- [ ] Re-run the test; expect PASS.

### Task 4: Implement authenticated bridge HTTP service

**Files:**
- Create: `packages/prime-bridge/src/config.ts`
- Create: `packages/prime-bridge/src/token.ts`
- Create: `packages/prime-bridge/src/server.ts`
- Create: `packages/prime-bridge/src/cli.ts`
- Test: `packages/prime-bridge/test/server-auth.test.ts`
- Test: `packages/prime-bridge/test/server-messages.test.ts`

**Interfaces:**
- Routes: `GET /health`, `GET /v1/peers`, `POST /v1/messages`, `GET /v1/inbox`, `POST /v1/wait`, `GET /v1/audit`.

- [ ] Test `/health` unauthenticated; all `/v1/*` routes 401 without `Authorization: Bearer`, 403 for unallowlisted non-empty Origin, success with token/no Origin. Assert token and `~/.prime/agent/omp-bridge.json` are mode 0600 and stable across restart.
- [ ] Test receipt preservation, durable inbox, idempotent duplicate delivery, and first-message/timeout wait behavior.
- [ ] Run both test files; expect failure.
- [ ] Implement `Bun.serve` on `127.0.0.1`; default state under `~/.omp/agent/prime-bridge/`; atomically provision Prime's 0600 config file with `{url, tokenFile}` paths only (never token contents); shared code logs only through `logger`.
- [ ] Re-run both tests; expect PASS.

### Task 5: Add OMP bridge client and external-peer provider

**Files:**
- Create: `packages/coding-agent/src/integrations/prime-bridge/client.ts`
- Create: `packages/coding-agent/src/integrations/prime-bridge/external-peer-provider.ts`
- Create: `packages/coding-agent/src/integrations/prime-bridge/index.ts`
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Test: `packages/coding-agent/test/prime-bridge-external-provider.test.ts`

**Interfaces:**

```ts
export interface ExternalPeerProvider {
  list(): Promise<ExternalPeer[]>;
  send(target: string, message: string, replyTo?: string): Promise<BridgeReceipt>;
  inbox(peek: boolean): Promise<BridgeMessage[]>;
  wait(from: string | undefined, timeoutMs: number): Promise<BridgeMessage | null>;
}
```

Import all wire DTOs from `@oh-my-pi/prime-bridge-protocol`; coding-agent must not depend on the bridge runtime package.

- [ ] Test bearer loading, HTTP error mapping, verbatim receipts, wait timeout, and disabled/default settings.
- [ ] Run `bun test packages/coding-agent/test/prime-bridge-external-provider.test.ts`; expect failure.
- [ ] Add the protocol-package dependency, HTTP client/provider, and settings `primeBridge.enabled` (default false), `url`, `tokenPath`, `autoStart`.
- [ ] Re-run the focused test; expect PASS.

### Task 6: Integrate external peers into Hub

**Files:**
- Modify: `packages/coding-agent/src/tools/index.ts`
- Modify: `packages/coding-agent/src/tools/hub/index.ts`
- Modify: `packages/coding-agent/src/tools/hub/types.ts`
- Modify: `packages/coding-agent/src/sdk.ts`
- Test: `packages/coding-agent/test/hub-prime-external-peers.test.ts`

`ToolSession.externalPeerProvider?` is optional. External IDs must be `prime:<activeSessionId>` and never enter `AgentRegistry`.

- [ ] Write Hub contract tests: external rows are separate; namespaced send uses provider; local send remains IrcBus; `queued` stays queued; restricted/no-provider sessions retain existing behavior.
- [ ] Run the focused test; expect failure.
- [ ] Wire the provider through `createAgentSession` only when enabled and unrestricted. Merge list/send/inbox/wait results without changing existing local paths; sanitize all remote rendering with OMP helpers.
- [ ] Re-run the test; expect PASS.

### Task 7: Add detached launch supervision

**Files:**
- Create: `packages/coding-agent/src/integrations/prime-bridge/lifecycle.ts`
- Test: `packages/coding-agent/test/prime-bridge-lifecycle.test.ts`

**Interfaces:**
- Produces `ensurePrimeBridge(settings): Promise<void>`.

- [ ] Write a fake launch-client test asserting stable name `prime-bridge`, application `omp-prime-bridge`, `detached:true`, `persist:true`, `restart:"always"`, loopback readiness, and idempotent ensure.
- [ ] Assert documented state: broker exit does not kill the detached process; a later crash is not promised to restart until broker recovery.
- [ ] Run focused test; expect failure.
- [ ] Implement using existing launch client helpers; do not duplicate broker protocol or spawn directly.
- [ ] Re-run test; expect PASS.

### Task 8: Ship Prime Python `omp_message` skill

**Files:**
- Create: `packages/prime-bridge/prime-skill/SKILL.md`
- Create: `packages/prime-bridge/prime-skill/pyproject.toml`
- Create: `packages/prime-bridge/prime-skill/src/omp_message/__init__.py`
- Test: `packages/prime-bridge/prime-skill/test/test_omp_message.py`

**Interfaces:**
- Async API: `list_peers()`, `send(target, message, reply_to=None)`, `inbox(peek=False)`, `wait(from_peer=None, timeout=None)`.

- [ ] Mock `urllib.request.urlopen`; assert bearer header, origin Prime session ID, explicit 401/403 exceptions, verbatim receipts, env override, and default 0600 config-file discovery.
- [ ] Run from `packages/prime-bridge/prime-skill`: `python -m unittest discover -s test -v`; expect failure.
- [ ] Implement with `asyncio.to_thread` + Python stdlib only. Default to `~/.prime/agent/omp-bridge.json`; let `OMP_PRIME_BRIDGE_URL` and `OMP_PRIME_BRIDGE_TOKEN_FILE` override it; never print token. Document both paths in `SKILL.md`.
- [ ] Re-run Python test; expect PASS.

### Task 9: Prove P1 end to end and document it

**Files:**
- Create: `packages/prime-bridge/test/integration/control-mesh.test.ts`
- Create: `packages/prime-bridge/README.md`
- Create: `packages/prime-bridge/CHANGELOG.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

- [ ] Start fake Prime daemon + real bridge on temp socket/port + OMP provider; send both directions, assert Prime envelopes never claim `fromActiveSessionId`/`agentOrigin`, restart bridge with same DB, verify no duplicate and cursor continuity.
- [ ] Run `bun test packages/prime-bridge/test/integration/control-mesh.test.ts`; expect PASS.
- [ ] Run `bun test packages/prime-bridge/test`, the focused coding-agent tests, `bun check`, and `omp --smoke-test` if CLI/worker wiring changed; expect all PASS.
- [ ] Document enable/start/token/recovery/supervision limits. Add `[Unreleased]` changelog entries. Do not commit unless asked.
