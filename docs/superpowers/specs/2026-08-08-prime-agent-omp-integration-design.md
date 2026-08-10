# Design: prime-agent ↔ OMP full integration

- Status: approved by user (2026-08-08), pending spec review
- Date: 2026-08-08
- Author: OMP top-level session (synthesized from six-track research fleet)

## Goal

Full bidirectional integration between prime-agent (Prime Intellect RLM agent) and OMP/Oh-My-Pi: cross-harness orchestration, agent mesh messaging, typed tool reach, and true two-way session resume.

## Context

Both harnesses descend from `badlogic/pi-mono` and diverged:

| | prime-agent (v0.7.1) | OMP (17.2.11) |
|---|---|---|
| npm scope | `@earendil-works/pi-*` | `@oh-my-pi/pi-*` |
| Runtime | Node, vitest | Bun, Rust natives |
| Config dir | `~/.prime/agent` | `~/.omp/agent` |
| Env prefix | `PRIME_AGENT_*` | `OMP_*` (PI_* aliases) |
| Auth store | `auth.json` (JSON file, one cred/provider) | `agent.db` (bun:sqlite, multi-cred, identities) |
| Settings | settings.json (global+project JSON) | config.yml (YAML) |
| Models config | `models.json` (thinkingLevelMap) | `models.yml` (thinking object) |
| Model tool surface | single `ipython` tool (persistent kernel) | ~20 typed tools + MCP client (stdio/http/sse) |
| Subagents | `rlm()` via Jupyter host_request | `task` tool subagents |
| Sessions live in | daemon supervisor + per-root workers | in-process per session |
| Public control plane | daemon Unix socket, protocol v7/schema 14 | none daemon-equivalent; `--mode rpc` stdio |
| Messaging | daemon `send_message` (family-graph reach) | `hub`/IrcBus (process-global, flat roster) |
| Mutation discipline | direct workspace writes | Shepherd candidate-bound verified proposals |

Detailed evidence: `~/pa-omp-research/track-{daemon,modes,state,tools,mesh,ai}.md`.

Prime and OMP both label current session files “v3,” but these are unrelated schemas. No converter path may infer compatibility from the shared version number.

## Locked decisions

1. **Two-way true session resume is in scope** (see §5 revision + acceptance criteria).
2. **No typed RLM RPC exposure.** OMP fans out over N `prime-agent --mode rpc` sessions for deterministic parallel decomposition; RLM stays prompt-mediated opportunistic. P3 measures that RPC-session fan-out *against* prompt-mediated in-session RLM on the same workload; it does not claim equivalent semantics. Revisit typed RLM RPC only after a measured penalty (context re-establishment cost or lost telemetry attribution). (Advisor: fable.)
3. **Trust model, tiered** (advisor: fable):
   - Unix-socket control planes: raw trust; 0600/0700 perms are the authority. No tokens there.
   - HTTP listeners only (MCP-HTTP tool server, inbound mesh endpoint): bearer token in a header (blocks simple-request CSRF), reject non-allowlisted non-empty `Origin`, token file 0600, read per-request, no restart rotation.
   - Shepherd: only where a proof-bindable candidate exists (a diff/artifact a PASS proof binds to); Prime's own workspace edits stay unfenced.
4. **Architecture A: central bridge service** over peer-extensions or offline-only.

## Architecture: `pa-omp-bridge`

One Bun process per machine, launched by OMP's launch broker with `detached: true` and `restart: "always"`. The detached process survives OMP/broker exit; `restart:"always"` applies only while the broker is running, so a later crash while the broker is down remains unrestarted until OMP/broker recovery. An OS-level supervisor is an optional deployment mode, not part of P1.

```
OMP sessions ── in-process host channel ──┐
                                          ├── Bridge core: identity map, cursor store,
OMP hub ─────── bridge client ────────────┤    durable outbox/inbox (SQLite), audit log
prime daemon (Unix socket v7) ── Prime driver ┤
omp --mode rpc subprocess ──── OMP client ───┤
Prime kernel (McpIntegration) ── MCP-HTTP server (127.0.0.1, auth'd)
Both sides ───────────────── Session converter (SessionSpecV1)
```

- Repo placement: `packages/prime-bridge` in oh-my-pi (Bun, follows OMP conventions: pi-utils logger, bun:sqlite, Bun.serve, no inline prompts).
- Prime-side artifacts: one Python skill `omp-message` (SKILL.md + pyproject, McpIntegration + bridge HTTP client pattern), shipped via `~/.agents/skills/` or prime package dir.

## Sections

### 1. Control planes

**OMP→Prime — Prime driver module.** Hand-maintained protocol-7 DTOs (versioned single module). Implements: socket-path resolver (explicit > `${tmpdir()}/prime-agent-${uid}/daemon.sock`), daemon_hello validation (name == `prime-agent.daemon`, protocol >= 7, record schemaRevision), capability intersection from `{attach_snapshot, event_sequence, slim_attach, chunked_snapshot, extension_ui}`, persisted logical clientId, and Prime's documented durable command-recovery journal semantics: mutations are keyed by `(clientId,commandId)`, completed retries return the stored result, and received-without-result returns `command_result_uncertain`. The bridge persists the exact envelope before send, retries only that exact envelope, never creates a new ID for a lost-response mutation, and surfaces uncertainty to the operator. It sends `ack_result` only after durable local receipt, stores `{generation,sequence}` cursors (generation change retires old sequence), validates 512 KiB chunked snapshots, reconnects with attach+cursor, and routes `extension_ui_request` through an operator or headless auto-cancel policy.

Subprocess fallback: `prime-agent --mode rpc` when no daemon answers; model its daemon-promotion side effect (schedules/heartbeats promote the session to resident) — bridge warns on those commands.

**Prime→OMP — OMP client module.** `omp --mode rpc` subprocess (protocol v1, strict LF JSONL; upgrade to v2 chunking for large outputs). Commands: prompt, abort, get_state. Framing handled in-process; no dependency on Prime's rpc-client.

### 2. Mesh messaging

Envelope: `{meshMessageId, originHarness, originSessionId, targetHarness, targetId, body, replyTo, projectRoot, createdAt, idempotencyKey}`.
Receipts preserved verbatim per harness — Prime `delivered|queued` and OMP `injected|woken|revived|failed` are never collapsed. Delivery is at-least-once from the bridge's durable SQLite outbox; receivers dedupe on `idempotencyKey`. Prime peer table entry exists only via the `omp-message` skill target; OMP external peers appear in `hub list` under a distinct `external` section (never in `AgentRegistry.listVisibleTo`). Herdr pane IDs are correlation/status metadata only — not message transport.

### 3. Tool bridge (Phase 2B)

The standalone bridge cannot access a live OMP session's process-local tool registry directly. An in-process OMP `PrimeBridgeHostAdapter` opens an authenticated WebSocket to the bridge and registers `{sessionId, toolNames, JSON schemas}`; it emits `tools_changed` and handles `call_tool` through the live `ToolSession`. Tool namespaces are session-scoped, so same-named tools from concurrent OMP sessions cannot collide.

The bridge exposes those registered tools as a loopback MCP-over-HTTP **server** (`Bun.serve`). Prime's stock Python `McpIntegration` inside IPython is the client. Its current implementation opens a fresh MCP session per call and returns final results; it does not surface progress notifications or promise protocol cancellation, so P2B's baseline contract is final-result-only. Host-side streaming remains internal until a Prime client compatibility test proves end-to-end progress/cancel support. Bearer-in-header + Origin policy per §trust. The bridge allowlists tools per live OMP session; mutating tools (`write/edit/bash/...`) are denied by default, and any approval wait has a hard timeout that returns an MCP `isError` result rather than dropping the connection. Not exported: `xd://` devices, IrcBus, or fleet proposal tools unless wrapped as explicit audited methods.

### 4. Audit

Append-only per-crossing event: `ts, direction, tokenId, originSessionId, verb/tool, argPreview (token-redacted), result, proposalId?, verdict?`. Queryable via bridge `hub` op or CLI. One schema, one file (`~/.omp/agent/prime-bridge/audit.jsonl`).

### 5. Session converter — true resume both ways

**Canonical interchange `SessionSpecV1`** (bridge-internal, versioned):
- header: `{originHarness, sourceSessionId, title, cwd, createdAt, sourceSchema}`
- full branch tree (id/parentId nodes), active-branch marker
- message entries projected to canonical roles: user, assistant, toolresult, developer-as-system-prefixed-user, custom
- thinking blocks with `signaturePolicy: carry | demote`; `carry` is legal only for a byte-identical request prefix on the same provider/model, otherwise the block is demoted and ledgered
- tool pairs `{toolName, callId, argsSnapshot, originalRef, synthesizedRef, resultRef}` with call IDs preserved verbatim
- every original tool call/result and provider payload available from the source store is stored byte-exact in the bridge CAS (`sha256`), referenced from the canonical entry
- `lossLedger`: structured list reserved for declared-unrepresentable classes. Missing raw source bytes are explicitly unrepresentable and ledgered; tool traffic with available originals must round-trip through preserved originals instead of entering the ledger

**Tool-continuity map** (versioned table, `packages/prime-bridge/src/session/tool-map.ts`):
- OMP tool calls → Prime `ipython` ToolCall entries synthesizing equivalent code (read → pathlib snippet; bash → subprocess code; edit → patch-application snippet). Every cell starts with a fixed marker such as `# bridged:omp/read <originalRef>` so the generated provenance is visible.
- Prime `ipython` cells → OMP `eval`/bash tool calls carrying cell source and a reciprocal marker; rich mime outputs demote to text/markdown while originals remain in CAS.
- A reverse conversion restores the original tool call/result byte-exact from `originalRef`; it never reverse-engineers the synthesized cell.
- Provider payloads (`providerPayload`, redacted-thinking, server-tool blocks) are never guess-converted; originals remain in CAS and any visible demotion is ledgered.

**Emission:** destination session is built fresh through destination-owned machinery (OMP: SessionManager create + append entries; Prime: `import_jsonl` daemon path or file construction matching Prime's distinct session-format v3). OMP's title slot is synthesized only after semantic conversion. Prime requires `type:"session"` as the first parsed object.

**Acceptance criteria (both directions must hold):**
1. Converted session loads in the destination harness; the full branch tree is navigable and the active branch is preserved.
2. At every branch tip, the destination provider adapter can construct and schema-validate the full request with valid role ordering and tool call/result pairing. A hermetic faux provider executes one follow-up turn on each representative branch class; no paid provider calls are required.
3. For sessions whose source store retained raw tool payload bytes, all original tool calls/results are byte-stable across A→B→A via CAS restoration.
4. Missing raw bytes and every other declared-unrepresentable item surface in the ledger plus an unobtrusive in-session marker; nothing silently drops.
5. Round-trip A→B→A is byte-stable for available original tool traffic and stable modulo ledgered degradations for the remaining declared classes.

Any criterion failure on a supported session fixture blocks merge.

**Fallback:** when a session fails conversion, offer context-injection handoff (generated summary + key files) labeled honestly as a handoff.

### 6. Config/credential converters (Phase 3)

Neutral `ModelSpecV1` interchange with alias table (`azure`↔`azure-openai-responses`, `kimi-code`↔`kimi-coding`, `moonshot`↔`moonshotai`, `opencode-zen`↔`opencode`, plan-specific MiniMax). Prime `thinkingLevelMap` → OMP `thinking.efforts/effortMap` (lossy, warn); unknown fields preserved under `extensions.{prime,omp}`. Round-trip tested at neutral-object level.

Credential importer: user-confirmed, provider-aware, one-way (auth.json → agent.db via public store APIs), OAuth defaults to forced re-login when client/redirect metadata cannot be validated. Never a shared store, symlink, or file copy.

### 7. Security summary

- Socket planes: same-user trust via 0600/0700.
- HTTP listeners: `#trust` tier B (header bearer, Origin rejection, no token rotation on restart).
- Shepherd: mutations of host repos routed through proposals only when a proof-bindable candidate exists; bridge output (diff/artifact) is the candidate.
- Nothing from a Prime session ever claims Prime family identity toward OMP (`fromActiveSessionId` forging prohibited); bridge sends are CLI-origin.
- Audit per §4.

### 8. Failure modes

| Failure | Behavior |
|---|---|
| Bridge down | Both harnesses run natively; no session damage. Outbox drains on restart. |
| Prime socket loss mid-mutation | Retry only the exact persisted envelope; use Prime's recovery-journal result or surface `command_result_uncertain`, never replay under a new ID. |
| Generation change | Retire old sequence; resync via snapshot. |
| Extension UI request headless | Auto-cancel policy with audit entry; configurable to surface to operator. |
| OMP or launch broker exits | Detached bridge remains alive and continues Prime/outbox work; `restart:"always"` is unavailable until the broker returns. OMP-bound tool calls return target-unavailable until a host adapter reconnects. |
| Session conversion failure | Labeled context-injection handoff; no partial session installs. |

### 9. Testing strategy

- Wire-level fixtures: recorded daemon_hello/attach/session_event streams replayed against the driver (no live daemon needed for unit scope).
- Compatibility matrix: protocol-7/schema-14 current peer; unknown optional fields ignored; schema-bump peer; supervisor replacement; worker generation change; durable recovery-journal crash windows.
- Session converter: representative fixtures on both sides (two distinct v3 schemas, title-slot presence, branches, compactions, provider payloads, images, tool calls across the whole tool-continuity map); every branch tip passes request construction/schema validation, and original tool traffic round-trips byte-exact through CAS.
- Tool bridge: live host-channel registration, per-session tool namespaces, tool-change notifications, allowlist enforcement, Origin/bearer rejection, final-result mapping, approval timeout as MCP `isError`, host disconnects, and backpressure. Progress/cancel is tested separately and remains outside the baseline contract unless Prime's client proves it end to end.
- Mesh: at-least-once + dedupe across bridge restart; receipt non-collapse.

### 10. Phasing

- **P1 — bridge skeleton + control planes + mesh + audit.** Driver + OMP client + envelope router + SQLite state + `omp-message` Prime skill + detached launch-broker supervision.
- **P2B — live OMP host channel + MCP-HTTP tool server.** The host channel is the first P2B deliverable; the MCP surface cannot claim live tools before it exists.
- **P2A — true session resume both ways.** CAS-preserved original tool traffic, every-branch-tip request validation, and loss-ledger acceptance gates. P2A and P2B are independent after P1.
- **P3 — ModelSpecV1 + credential importer + comparative fan-out benchmark.** Compare N Prime RPC sessions against prompt-mediated in-session RLM on the same workload; the result gates, but does not itself implement, typed RLM RPC.

## Open unknowns (runtime-measured)

1. Prime CLI RPC startup latency daemon-absent vs daemon-present (informs fallback policy).
2. Whether queued Prime agent messages survive ordinary worker crash (only coordinated-update snapshot path is proven in source).
3. Codex/Anthropic OAuth token cross-product refresh acceptance (disposable-account test only).
4. Prime Mistral native API fidelity through OMP Mistral provider path.
5. OMP `providerPayload` continuation requirements per model (some Responses models may require it).

## References

- Research reports: `~/pa-omp-research/track-{daemon,modes,state,tools,mesh,ai}.md`
- prime-agent: `/Users/ahpramesi/repos/prime-agent` — daemon protocol source of truth `packages/coding-agent/src/modes/daemon/daemon-protocol.ts` (v7/schema 14; docs' "v4" prose is stale)
- OMP RPC surface: `~/repos/oh-my-pi/docs/rpc.md`; SDK: `packages/coding-agent/src/sdk.ts`
