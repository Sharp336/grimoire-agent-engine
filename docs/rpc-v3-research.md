# RPC v3 protocol research

Design input for a durable, host-neutral session interface. This note compares primary protocol specifications with the current Oh My Pi (OMP) seams. It is research, not an implementation. External claims are linked to the specification that owns them.

## Scope and repository baseline

The v3 problem is larger than JSONL framing: a host must negotiate semantic features, submit typed work, observe ordered events, reconnect and replay durable history, exchange artifacts/resources, cancel work, and settle teardown without confusing a transport cursor for session state.

Current OMP already has useful seams:

- The RPC ready frame advertises framing limits and supported transport versions, while `negotiate_protocol` selects the encoder version ([`rpc-types.ts`](../packages/coding-agent/src/modes/rpc/rpc-types.ts#L28-L37), [`rpc-types.ts`](../packages/coding-agent/src/modes/rpc/rpc-types.ts#L144-L159)).
- Framing v2 emits one logical JSON object as ordered physical `rpc_chunk` lines and rejects interrupted, mismatched, or over-limit sequences. The chunk index is a reassembly detail, not a session journal ([`rpc-frame.ts`](../packages/coding-agent/src/modes/rpc/rpc-frame.ts#L87-L189)).
- Ordinary RPC commands are serialized, while long-running `bash` and side-channel control frames can run concurrently; clients already correlate concurrent responses by command ID ([`rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L304-L405)).
- `AgentSession` owns event subscription and idempotent disposal; `SessionManager` owns persisted entries, branch ancestry, leaf state, and flush/close. Adapters must not create a competing session journal ([`agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts#L3463-L3478), [`agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts#L3637-L3689), [`agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts#L3767-L3839), [`session-entries.ts`](../packages/coding-agent/src/session/session-entries.ts#L58-L68), [`session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts#L195-L223)).
- Artifacts are session-scoped external files with stable numeric IDs; blobs are content-addressed separately. These are resource handles, not event payloads that should be repeated in every frame ([`artifacts.ts`](../packages/coding-agent/src/session/artifacts.ts#L29-L154), [`blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts#L25-L34)).
- The ACP adapter demonstrates the intended authority boundary: it negotiates capabilities, loads/replays through `SessionManager`, maps live `AgentSession` events, and routes cancellation/close through `AgentSession` ([`acp-agent.ts`](../packages/coding-agent/src/modes/acp/acp-agent.ts#L471-L621), [`acp-agent.ts`](../packages/coding-agent/src/modes/acp/acp-agent.ts#L1041-L1148)).

## Primary-source comparison

| Precedent | Source-backed pattern | OMP design implication |
| --- | --- | --- |
| **JSON-RPC 2.0** | JSON-RPC is transport-agnostic and defines request IDs for correlation. A notification has no ID and must not receive a response. A response contains exactly one of `result` or `error`; errors have a numeric code, concise message, and optional data. Batches may be processed concurrently and responses may be returned in a different order, so IDs—not emission order—carry correlation. [JSON-RPC overview, requests, notifications, responses, errors, and batches](https://www.jsonrpc.org/specification#overview) | Keep request correlation separate from event ordering. Require IDs for operations whose acceptance or settlement matters; reserve notifications for deliberately unconfirmable signals. Give every failure a stable machine code and structured data. Permit concurrent independent operations, but serialize mutations at the authoritative session seam. |
| **LSP** | Capabilities are exchanged during a one-time `initialize` request. The peer waits for the initialize result before sending normal traffic. Cancellation is a notification naming the request ID, but a cancelled request still returns a response; a cancellation error is advised rather than leaving the request hanging. Progress uses a token distinct from the request ID. LSP allows response reordering when independent work remains correct. Shutdown is two-phase: `shutdown` returns before `exit`; after shutdown, new requests are invalid. [LSP 3.18 capabilities, cancellation/progress, ordering, initialize, shutdown, and exit](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/) | Treat semantic negotiation as a session state machine, not as a side effect of selecting a frame encoding. Use separate operation IDs and progress/event handles. Make cancellation a semantic outcome with a settlement barrier, not a dropped promise. Define which operations serialize and which may reorder. Use a drain/close phase that can still deliver its final response. |
| **ACP v1** | Initialization negotiates one major protocol version, capabilities, and authentication; omitted capabilities are unsupported. A session has its own conversation context/history/state and a unique session ID. `session/load` must replay the full conversation as ordered updates before its response; `session/resume` restores without replay when the advertised resume capability is used. A prompt ends with a typed `StopReason` (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, or `cancelled`). Cancellation must abort work, send pending updates first, then complete the original prompt with `cancelled`, not a generic error. `session/close` cancels active work and frees resources. [ACP v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization), [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), and [prompt turns/cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn) | Model acceptance and completion separately. Make replay an explicit barrier: the replay response follows all events in the requested durable range. Preserve typed stop reasons and interaction outcomes through RPC instead of translating expected cancellation into an error string. Keep session identity durable and independent of the process/connection. |
| **ACP v2 draft** | The draft makes replay explicit with `replayFrom`: resume does not replay by default, while an inclusive start cursor requests full replay and the response follows the replay. Updates are upserts keyed by opaque message IDs; full content replaces, same-ID chunks append, and clients apply them in receive order. Tool content chunks append, while a later full update replaces the accumulated content. Binary terminal output chunks are independently base64-decoded and appended in received order; boundaries may split UTF-8 or escape sequences. The announcement labels v2 docs/schema as draft and advises gating them by version negotiation/feature flags. [ACP v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft), [v2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup), and [v2 tool-call/chunk semantics](https://agentclientprotocol.com/protocol/v2/tool-calls) | Use an explicit inclusive/exclusive replay cursor and a replay watermark. Define append-versus-replace semantics per artifact/message field; do not infer them from a generic update. Decode each artifact chunk independently before appending raw bytes, preserving parser state across boundaries. Keep draft-only behavior behind semantic capability negotiation and retain a v1-compatible path. |
| **MCP** | The current 2026-07-28 revision has no handshake: each request carries protocol version, identity, and capabilities in `_meta`; unsupported versions produce a typed error listing supported versions, and optional extensions are capability-negotiated. MCP also explicitly says a connection/process is not a conversation: state spanning requests must use explicit IDs. Results are typed with `resultType` such as `complete` or `input_required`. Resources are URI-identified; a server advertises a resources capability, supports list/read, and may paginate, cache, or subscribe to changes. Cancellation is raced with completion: the server should stop/free work and normally sends no response for a cancelled request, while peers tolerate late cancellation or late responses. [MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [basic message/statelessness/result types](https://modelcontextprotocol.io/specification/2026-07-28/basic/index), [resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources), and [cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation) | Treat MCP's per-request metadata as a useful contrast, not a reason to derive OMP session identity from a stream. Put `sessionId`, operation/interaction IDs, and durable replay cursors in the semantic envelope. Use typed `complete`/`requires_action`/`input_required`-like outcomes for multi-round interactions. Represent large output as URI/resource references and bounded reads. Choose and document OMP's cancellation response rule explicitly: for confirmable operations, retain the original response and settle it as `cancelled`; for notifications, emit only the terminal event. |
| **MCP legacy lifecycle** | The 2025-06-18 revision uses an initialize/initialized capability handshake and has no protocol shutdown method: shutdown is signaled by closing the underlying stdio or HTTP transport, with bounded process termination for stdio. [MCP legacy lifecycle, initialization, and shutdown](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) | Preserve backward compatibility without pretending transport close is a durable session close. On disconnect, fail pending host interactions, drain accepted work, flush the authoritative session, and close idempotently; make an explicit semantic `session.close` stronger than merely losing the stream. |
| **WHATWG Server-Sent Events** | EventSource reconnects after a disconnect and sends the last received event `id` as `Last-Event-ID`. The parser updates that ID only when an `id` field is processed, dispatches an event at a blank-line boundary, and discards an incomplete event at end of stream. The standard defines client reconnect state and parsing, not a durable server event journal or replay retention policy. [HTML Standard §9.2.3–9.2.5](https://html.spec.whatwg.org/multipage/server-sent-events.html#server-sent-events) | A transport sequence/cursor is only a delivery aid. It is not proof that an OMP session entry was persisted, nor does it identify a branch after a session switch. Durable replay must use a `SessionManager`-backed event/entry ID plus session/leaf snapshot, and must reject or restart stale cursors. Physical JSONL/chunk indexes must never be accepted as durable replay cursors. |

## Derived v3 invariants

The following are the actionable protocol invariants implied by the comparison and the current OMP authority seams.

### 1. Separate semantic-v3 negotiation from framing-v2

- The ready frame may advertise physical framing versions and byte limits, but a successful framing choice **MUST NOT** imply semantic v3 support.
- A semantic negotiation request **MUST** carry the client's supported semantic majors and capability set. The response **MUST** name exactly one selected semantic major and the effective capabilities. An unsupported major returns a machine-readable error containing supported majors; the connection remains usable for a mutually supported fallback when possible.
- Negotiation is an ordered barrier: no v3-only request, event, artifact operation, or interaction outcome may appear before the semantic result. Existing v1/v2 clients continue to use the legacy command/event surface.
- Unknown optional capability names are ignored; omitted capabilities mean unsupported. A capability can gate a method, notification, parameter subset, or behavior, and an adapter **MUST** validate the peer's capability before emitting that surface.

Illustrative wire shape (not implementation):

```ts
interface SemanticHello {
  requestId: string;
  supportedSemanticMajors: readonly number[];
  capabilities: Record<string, unknown>;
}

interface SemanticHelloResult {
  semanticMajor: 3;
  capabilities: Record<string, unknown>;
}
```

The framing handshake remains a different state variable. In particular, `rpc_chunk.index` identifies contiguous physical lines inside one logical frame; it is not a semantic event ID, durable entry ID, or replay watermark.

### 2. Preserve `AgentSession`/`SessionManager` authority

- The adapter is a projection: it subscribes to `AgentSession`, calls `AgentSession` operations, and reads/replays through `SessionManager`.
- A semantic event **MUST** identify the durable session and branch context. A process-local connection ID, request ID, stream sequence, or chunk ID is insufficient.
- Session changes, branch changes, compaction boundaries, and disposal invalidate any cursor that is not anchored to the current durable session/leaf snapshot.

A useful envelope is:

```ts
interface DurableCursor {
  sessionId: string;
  leafId: string | null;
  entryId: string | null; // last included durable entry; null means branch start
}

interface SessionEvent<T> {
  sessionId: string;
  eventId: string;        // durable identity, stable across replay
  cursor: DurableCursor;  // authority snapshot after this event
  replay: boolean;
  payload: T;
  transportSeq?: string;  // optional local delivery sequence; never durable
}
```

`eventId` and `cursor` are semantic fields. `transportSeq` is diagnostic/reconnect state only and may reset after process restart or reconnect.

### 3. Ordered replay has a barrier and a watermark

- Replay requests **MUST** state the session and an optional durable cursor; cursors are opaque to clients and bound to session/leaf identity.
- The server reads the authoritative ordered journal, emits events in journal order, and sends the replay response only after the requested range is delivered. A response **MUST** include a watermark identifying the latest durable state represented by the replay.
- If live work appends while replay is running, the implementation chooses one explicit rule: include through a captured watermark and then switch to live events after it, or extend the replay to a new watermark. It **MUST NOT** silently interleave unmarked live events into a replay range.
- Replayed events retain the same durable IDs and payload semantics as live events. Clients can deduplicate by `eventId`; duplicate delivery is harmless, but reordering events for one session is not.
- A stale cursor (different session ID, leaf, or journal generation) returns a typed `stale_cursor` error or a fresh-snapshot instruction; it must not silently splice two histories.

### 4. Acceptance, progress, interaction, and settlement are distinct

A request response confirms acceptance or returns a terminal result; events carry progress and durable state transitions. Do not overload one boolean such as `success` to represent all stages.

```ts
type OperationState = "accepted" | "running" | "requires_action" | "settled";

type OperationSettlement =
  | { outcome: "completed"; stopReason: "end_turn" | "max_tokens" | "refusal"; result?: unknown }
  | { outcome: "cancelled"; reason?: string }
  | { outcome: "failed"; code: string; message: string; data?: unknown };

type InteractionOutcome =
  | { outcome: "selected"; value: unknown }
  | { outcome: "rejected"; reason?: string }
  | { outcome: "cancelled"; reason?: string }
  | { outcome: "timed_out"; reason?: string };
```

- `requires_action` identifies a typed pending interaction, with a stable interaction ID and allowed outcome schema. It is not an error and is not completion.
- Every accepted confirmable operation settles exactly once. A local-only operation can settle immediately; a model/tool turn settles only after its terminal event and all required side-channel deliveries are drained.
- Expected cancellation is a typed settlement, not a generic exception. An adapter must not leave the original request hanging merely because the underlying provider/host API throws on abort.

### 5. Artifacts and resources use handles plus byte-level chunk rules

- Large output is referenced by an `ArtifactRef`/resource URI and fetched with bounded reads; it is not forced into one event or one physical frame. Artifact identity is durable and session-scoped; a resource URI may outlive a transport connection.
- Append chunks and authoritative snapshots are different operations. An append chunk adds bytes to one artifact version; a snapshot replaces the complete retained byte sequence. A client must never merge a replacement with bytes from an older version.
- Each chunk is independently encoded and decoded. For base64 transport, decode the chunk before appending; never concatenate base64 strings first. Byte offsets/lengths and an optional digest make truncation and corruption detectable.
- Chunk ordering is per artifact handle and semantic operation, not global JSONL order. A physical `rpc_chunk` sequence only reassembles a JSON event and must not be persisted as the artifact's chunk journal.

Illustrative wire shape (not implementation):

```ts
interface ArtifactRef {
  artifactId: string;
  uri: string;
  mediaType?: string;
  byteLength?: number;
  digest?: string;
}

interface ArtifactAppendChunk {
  artifactId: string;
  version: string;
  index: number;
  byteOffset: number;
  byteLength: number;
  encoding: "base64";
  data: string;
  final: boolean;
}
```

### 6. Cancellation is a race with exactly-once settlement

- A cancellation request names an operation/interaction ID, not merely the current connection. Unknown or already-settled IDs are harmless no-ops (or typed `unknown_operation` errors where a response exists).
- Cancellation marks intent immediately, aborts provider/tool/URI work, cancels pending permission/interaction requests, and waits for cleanup up to a bounded deadline. Late provider or host results cannot overwrite a settled outcome.
- The server may deliver late progress/tool updates caused by the race, but **MUST** deliver them before the final `cancelled` settlement/event. After settlement, late updates are ignored or recorded as diagnostics, never applied as new work.
- For a request with an ID, the original request still receives one terminal response/event with `outcome: "cancelled"`; a cancellation notification itself has no response. This gives OMP the reliable ACP/LSP behavior while keeping fire-and-forget notifications honest.

### 7. Graceful shutdown is drain, settle, close

Use one idempotent lifecycle for explicit shutdown, stdin EOF, transport failure, and process signals:

1. **Open**: accept negotiated operations and interactions.
2. **Draining**: reject new work with a typed `session_closing` error; cancel or finish accepted work according to operation policy; fail pending host interactions; stop new event production.
3. **Settled**: emit the final session-shutdown event, flush `SessionManager`, and close authoritative storage only after all branches that can append entries have settled.
4. **Closed**: send the shutdown response if a request remains deliverable, then close the transport/process. Repeated shutdown/close calls return the same settled promise/result.

A transport disconnect is not a durable session deletion. It triggers the drain/close path for the live adapter while the session remains resumable if its journal was flushed. This follows OMP's existing idempotent `AgentSession.dispose()` and the two-phase shutdown precedent without making stream closure a session identity.

### 8. Error and ordering vocabulary is machine-readable

At minimum, v3 needs stable codes for `unsupported_semantic_version`, `unsupported_capability`, `invalid_request_state`, `session_busy`, `stale_cursor`, `session_closing`, `operation_not_found`, `interaction_not_found`, `artifact_not_found`, `artifact_chunk_mismatch`, `frame_limit_exceeded`, and `cancelled` (when an error envelope is required by a legacy caller).

- Error envelopes follow JSON-RPC's mutually exclusive result/error rule; `code` is stable, `message` is concise, and `data` carries structured recovery information.
- Event order is guaranteed per session and operation, not globally across independent sessions or unrelated requests. Response emission order is not a substitute for event order.
- A replay or artifact read that cannot be completed must identify whether the failure is stale state, missing data, cancellation, or transport/frame rejection. Clients should not parse human-readable messages to choose recovery.

## Non-negotiable distinction: transport sequence is not durable state

The following values are delivery-local and may reset, repeat, or be absent after reconnect:

- JSONL line position, physical `rpc_chunk.index`, `chunkId`, and an encoder counter.
- A connection/socket/process identity.
- A request ID used only to correlate one RPC response.
- A progress token or in-memory subscription ID.

The following values are session state and must be backed by `AgentSession`/`SessionManager` or the durable artifact store:

- `sessionId`, branch/leaf identity, durable entry/event ID, replay watermark, artifact ID/version, and the persisted payload that produced an event.

A reconnect may use a local last-seen sequence to optimize delivery, but correctness requires replaying from a durable cursor and proving that the session/leaf snapshot still matches. This is the central guard against treating a successfully transmitted frame as proof of a committed session transition.

## Performance and locality constraints

- Keep framing lazy and backpressure-aware, as the existing v2 encoder does; do not materialize a base64 copy of a large logical frame when a bounded chunk iterator can stream it.
- Replay and resource reads are paged/bounded. Work is proportional to the requested event range and artifact bytes, not the full lifetime of the session; stale cursors fail before expensive cross-branch scans.
- Maintain O(1) correlation maps for pending operations/interactions and per-artifact chunk state. Serialize only operations that touch the same authoritative session/branch; independent host tools, resource reads, and notifications may proceed concurrently.
- Keep the adapter thin: event projection, capability checks, correlation, replay paging, and transport backpressure belong at the seam; session mutation, persistence, branching, compaction, and disposal remain in the authority modules.

## Source index

- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [LSP 3.18 Specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/)
- [ACP v1 Initialization](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP v1 Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP v1 Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- [ACP v2 Draft Announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)
- [ACP v2 Session Setup](https://agentclientprotocol.com/protocol/v2/session-setup)
- [ACP v2 Tool Calls and Chunk Semantics](https://agentclientprotocol.com/protocol/v2/tool-calls)
- [MCP 2026-07-28 Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP 2026-07-28 Basic Protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)
- [MCP 2026-07-28 Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- [MCP 2026-07-28 Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)
- [MCP 2025-06-18 Lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [WHATWG HTML Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
