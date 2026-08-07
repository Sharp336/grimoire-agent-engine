# OMP Session Protocol

The OMP session protocol exposes OMP-owned coding sessions to host-neutral clients without transferring execution or persistence authority.

## Language

**Semantic profile**:
A negotiated set of protocol meanings and guarantees, independent of physical frame encoding. RPC v3 is the `omp.session` semantic profile at major version 3.
_Avoid_: Protocol version when referring only to framing, execution contract

**Framing version**:
The JSONL transport encoding selected for physical frames, including chunking and byte limits. It does not imply semantic capabilities or replay guarantees.
_Avoid_: Semantic version, application API version

**Session host**:
The OMP-owned module that discovers, opens, observes, commands, and settles one or more coding sessions through a host-neutral interface.
_Avoid_: App server, editor server

**Session authority**:
The paired `AgentSession` execution authority and `SessionManager` journal authority for one durable coding session. Clients observe and command this authority; they do not replace it.
_Avoid_: Client state, transcript model
**Session lifecycle projection**:
Authoritative catalog metadata expressed on independent axes: live activity (`active` or `closed`), durable continuation (`complete`, `incomplete`, `failed`, or `ambiguous`), resumability, recoverability, and live reconnectability. A persisted session may be both closed and resumable; these terms are not aliases.
_Avoid_: Inferring lifecycle from transcript text, treating closed as deleted


**Observation**:
An ordered envelope describing authoritative or transient session activity. An observation sequence is process-local unless the envelope also carries a durable cursor.
_Avoid_: Journal event for transient activity, transport frame

**Observation epoch**:
An opaque process-instance identity paired with a monotonic sequence. It detects reconnects and gaps but is not durable session state.
_Avoid_: Journal generation

**Durable cursor**:
An opaque `SessionManager`-backed position bound to a session and leaf. It identifies persisted replay state and must not be synthesized from transport order.
_Avoid_: Sequence number, frame offset

**Snapshot watermark**:
The observation position captured with an authoritative execution snapshot. Live delivery begins strictly after this watermark.
_Avoid_: Best-effort timestamp

**Interaction**:
A correlated request for host participation whose typed outcome is accepted, cancelled, timed out, unsupported, failed, or disconnected.
_Avoid_: Prompt when referring to approvals or host UI generally

**Settlement**:
The terminal proof that accepted commands and interactions resolved, final observations drained, durable state and artifacts finalized, and owned resources disposed.
_Avoid_: Process exit, stream close

**Artifact**:
A session-related, content-addressed or stable-ID byte resource whose metadata and bounded reads are authoritative. Large output is referenced as an artifact instead of being truncated into an event.
_Avoid_: Terminal attachment, oversized frame


## Architecture decisions

### Semantic negotiation is independent from framing

`omp.session` major 3 is selected by `initialize` after, and independently from, JSONL framing negotiation. Framing v1 or v2 transports the same semantic profile. A v3-only command requires an explicitly negotiated capability; incompatibility is typed and never silently downgrades to legacy behavior.

### The session-host seam is transport-neutral

`SessionHost` owns observation epochs, monotonic delivery sequence, bounded replay, acknowledgement, gaps, snapshot handoff, command settlement, and close semantics. It depends only on `SessionAuthority`; it does not import RPC, TUI, ACP, or client code. Presentation adapters translate their wire format at this seam.

### Existing authorities remain authoritative

`AgentSessionAuthority` adapts live `AgentSession` events and `SessionManager` journal entries. `AgentSession` remains the only execution authority. `SessionManager` remains the only journal writer and durable branch authority. The adapter never parses transcript text, writes session files, or treats a transmitted frame as proof of persistence.

### Durable and transport recovery are distinct

An observation epoch plus sequence supports bounded replay within one live host. A durable cursor names a session, branch ancestor, and persisted entry. Restart recovery validates that cursor against the active `SessionManager` branch and re-emits persisted entries with stable event IDs. Overflow produces a typed resnapshot requirement; it never silently drops or splices history.
### Catalog lifecycle dimensions are independent

The session catalog projects persisted status from `SessionManager` metadata and overlays only the currently hosted durable session as active and reconnectable. Every cataloged durable identity is resumable. Interrupted, aborted, pending, and failed sessions are recoverable; unknown status remains explicitly ambiguous. Non-active sessions are closed, not deleted. Tree projection exposes authoritative IDs, parents, entry kinds, labels, and the active branch without copying journal payloads.


### RPC is a presentation adapter, not a second runtime

RPC v3 reuses the validated command registry and routes accepted work through the existing RPC operation lifecycle, but the session-host adapter adds revision preconditions, causation, cancellation, terminal outcomes, replay, and settlement. It does not duplicate queue, goal, todo, child-agent, compaction, resource, or session mutation logic.

### Settlement is stronger than transport close

Explicit `session_shutdown` stops command acceptance, rejects pending interactions, cancels or drains accepted operations, emits final observations, persists through the authoritative session layer, disposes owned resources, and writes one final settlement response. Protocol output is latched after that response. EOF remains a transport disconnect: it drains the adapter and preserves the durable session for later resume.

### Public seams are tested before transport integration

Contract tests target semantic negotiation, authority ordering, durable replay, snapshot-to-live handoff, bounded gaps, revision conflict, operation settlement, adapter mapping, shutdown command admission, and unknown outcomes. RPC and client tests then prove presentation compatibility without replacing those host-level contracts.