# Prime Agent ↔ OMP P2A True Session Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert a persisted Prime or OMP session into a native destination session that loads, preserves the full branch tree, constructs a provider-valid request at every branch tip, and completes representative faux-provider follow-up turns.

**Architecture:** `SessionSpecV1` is a canonical tree plus content-addressed original-byte store and explicit loss ledger. Readers parse each native schema into the canonical form. Projectors write fresh destination-native sessions atomically. Original tool/provider payloads are restored from CAS on round-trip; synthesized destination records never replace originals.

**Prerequisite:** P1 package exists. P2A and P2B are independent after P1; the converter publishes a historical tool map without requiring a live tool bridge.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, OMP `SessionManager`, native JSONL, SHA-256 CAS, hermetic loopback faux provider.

## Global Constraints

- Prime session `version:3` and OMP session `version:3` are unrelated schemas. Dispatch readers by `originHarness` plus structural validation, never by version label alone.
- Never write into the source file. Destination install is temp file/directory → validate → fsync → atomic rename.
- Preserve full tree. A selected leaf is metadata, not permission to discard siblings.
- Original raw bytes present in source storage must be stored byte-exact in CAS and survive A→B→A. If raw bytes never existed or were already normalized/truncated by the source, record `missing_source_bytes` in `lossLedger`.
- Thinking signatures carry only when provider, model, and request prefix are byte-identical; otherwise demote to text and ledger it.
- A conversion is not accepted because a loader parses it. The destination must construct a valid provider request and complete a faux-provider follow-up.
- No commits unless asked.

---

### Task 1: Define `SessionSpecV1`, loss taxonomy, and CAS

**Files:**
- Create: `packages/prime-bridge/src/session/spec.ts`
- Create: `packages/prime-bridge/src/session/schema.ts`
- Create: `packages/prime-bridge/src/session/cas.ts`
- Create: `packages/prime-bridge/src/session/loss-ledger.ts`
- Test: `packages/prime-bridge/test/session-spec.test.ts`

**Interfaces:**

```ts
export interface SessionSpecV1 {
  specVersion: 1;
  header: SessionSpecHeader;
  nodes: SessionSpecNode[];
  activeLeafId: string | null;
  nativeIdMap: Record<string, { prime?: string; omp?: string }>;
  lossLedger: SessionLoss[];
}

export interface CanonicalToolPair {
  toolName: string;
  callId: string;
  argsSnapshot: unknown;
  originalCallRef?: CasRef;
  synthesizedCallRef?: CasRef;
  resultRef?: CasRef;
}
```

- [ ] Test tree invariants: unique IDs, all parents exist, no cycles, active leaf exists, tool result refers to preceding call on the same path, CAS hashes bytes, duplicate blobs dedupe.
- [ ] Test loss codes: `missing_source_bytes`, `unsupported_role`, `thinking_demoted`, `provider_payload_demoted`, `blob_unavailable`, `entry_metadata_unrepresentable`.
- [ ] Run focused test; expect failure.
- [ ] Implement omptype schema and CAS under bridge state `cas/sha256/<prefix>/<hash>`. Use `new Bun.CryptoHasher("sha256")`; verify hash on every read.
- [ ] Re-run test; expect PASS.

### Task 2: Implement Prime v3 reader

**Files:**
- Create: `packages/prime-bridge/src/session/prime-reader.ts`
- Create: `packages/prime-bridge/src/session/prime-types.ts`
- Test: `packages/prime-bridge/test/prime-session-reader.test.ts`
- Create: `packages/prime-bridge/test/fixtures/sessions/prime-v3.jsonl`

**Interfaces:**
- Produces `readPrimeSession(path, cas): Promise<SessionSpecV1>`.

- [ ] Fixture must include two branches, user/assistant/toolResult, `ipython` tool call, thinking, compaction, model/thinking changes, custom entry, image, provider payload if present, and an intentionally absent raw payload class.
- [ ] Test first physical object must be `type:"session"`; preserve all `id/parentId`; preserve call IDs; copy available source line/message/tool bytes to CAS; ledger missing/unsupported classes.
- [ ] Run focused test; expect failure.
- [ ] Implement against Prime `packages/coding-agent/docs/session-format.md` and `packages/coding-agent/src/core/session-manager.ts` v3 unions. Reject malformed parents/cycles before canonical output.
- [ ] Re-run test; expect PASS.

### Task 3: Implement OMP v3 reader with title/blob handling

**Files:**
- Create: `packages/prime-bridge/src/session/omp-reader.ts`
- Create: `packages/prime-bridge/src/session/omp-types.ts`
- Test: `packages/prime-bridge/test/omp-session-reader.test.ts`
- Create: `packages/prime-bridge/test/fixtures/sessions/omp-v3.jsonl`

**Interfaces:**
- Produces `readOmpSession(path, cas, { ompAgentDir? }): Promise<SessionSpecV1>`.

- [ ] Fixture includes the 256-byte title slot, branches, compaction, custom/provider payload entries, read/edit/bash/eval tool calls, image/blob reference, and one unavailable blob. During the test, create the available blob through exported `BlobStore.put()` under `getBlobsDir(tempAgentDir)` and pass that same `tempAgentDir` to the reader; do not invent a per-session blob layout.
- [ ] Test title slot is peeled before JSONL parsing, blob bytes enter CAS, unavailable blobs ledger, and full tree/active leaf survive.
- [ ] Run focused test; expect failure.
- [ ] Reuse exported OMP session loader/entry types, `BlobStore`, and `getBlobsDir`; do not duplicate the title parser or blob resolver. Add a narrow export if the package lacks one.
- [ ] Re-run test; expect PASS.

### Task 4: Publish and test the tool-continuity map

**Files:**
- Create: `packages/prime-bridge/src/session/tool-map.ts`
- Create: `packages/prime-bridge/src/session/tool-synthesis.ts`
- Test: `packages/prime-bridge/test/session-tool-map.test.ts`

**Mapping contract:**

- OMP `read|grep|glob|web_search|write|edit|bash|lsp|hub|task|todo|<other>` → a Prime `ipython` call containing a deterministic, non-executing descriptive Python snippet. Every snippet begins `# bridged:omp/<tool> <originalRef>` and represents the historical operation with inert data; it never invokes `omp_tools`, the network, or the filesystem. Preserve original call/result bytes in CAS.
- Prime `ipython` → OMP `eval` with `{language:"py", code}`. Only an IPython cell containing exactly one top-level `!command` line maps to OMP `bash`; mixed Python/shell stays `eval` and is ledgered as a semantic demotion. Synthesized OMP source begins `# bridged:prime/ipython <originalRef>`.
- Call IDs remain verbatim. Result tool name always matches synthesized call name. Images remain image blocks where target supports them; other MIME blocks become CAS references plus ledger entries.

- [ ] Table-drive every mapping, arguments, call/result pairing, image result, error result, unknown tool, shell magic, and round-trip CAS restoration.
- [ ] Run focused test; expect failure.
- [ ] Implement pure deterministic functions. Generated code is stable for identical input and never embeds credentials.
- [ ] Re-run test; expect PASS.

### Task 5: Project canonical sessions to native Prime v3

**Files:**
- Create: `packages/prime-bridge/src/session/prime-projector.ts`
- Create: `packages/prime-bridge/src/session/atomic-install.ts`
- Test: `packages/prime-bridge/test/prime-session-projector.test.ts`

**Interfaces:**
- Produces `projectToPrime(spec, options): Promise<{path; report}>`.
- Destination: `${primeHome}/agent/sessions/<new-uuid>.jsonl`; first physical line is the Prime header.

- [ ] Test deterministic topological write, stable native ID map, full parent tree, active-leaf selection metadata, Prime role/tool schema, unobtrusive custom message for losses, no partial destination after injected write failure, and A→B→A original-byte restoration.
- [ ] Run focused test; expect failure.
- [ ] Write Prime v3 JSONL to a sibling temp file, fsync, validate with the Prime reader, then rename. Use 8-hex entry IDs derived collision-safely from canonical IDs; retain mapping in a bridge sidecar custom entry.
- [ ] Re-run test; expect PASS.

### Task 6: Project canonical sessions to native OMP v3

**Files:**
- Create: `packages/prime-bridge/src/session/omp-projector.ts`
- Modify: `packages/coding-agent/src/session/session-manager.ts`
- Modify: `packages/coding-agent/src/index.ts`
- Test: `packages/prime-bridge/test/omp-session-projector.test.ts`
- Test: `packages/coding-agent/test/session-import-api.test.ts`

**Interfaces:**
- Add a narrow public `SessionManager.importTree(cwd, nodes, activeLeafId, options)` API. It uses normal persistence transforms/title/blob storage and returns native ID mapping; no raw JSONL writer in bridge.
- Dependency direction is fixed: `@oh-my-pi/prime-bridge` may depend on coding-agent; coding-agent depends only on `@oh-my-pi/prime-bridge-protocol`, never on the bridge runtime.

- [ ] First add coding-agent tests: imports full branched tree, active leaf, custom loss marker, and rolls back on invalid node. Run; expect failure.
- [ ] Implement `importTree` by topological order: select mapped parent with `branch()`, append native entry, record minted ID; write title only through existing title API. Export the import types.
- [ ] Run coding-agent test; expect PASS.
- [ ] Write projector tests for Prime→OMP and A→B→A CAS restoration; run, expect failure.
- [ ] Implement projector against public API; validate by `SessionManager.open()` before returning.
- [ ] Re-run projector test; expect PASS.

### Task 7: Add conversion CLI and non-destructive reports

**Files:**
- Create: `packages/prime-bridge/src/session/convert.ts`
- Modify: `packages/prime-bridge/src/cli.ts`
- Create: `packages/prime-bridge/src/session/report.ts`
- Test: `packages/prime-bridge/test/session-convert-cli.test.ts`

**CLI:**

```text
omp-prime-bridge session inspect <path>
omp-prime-bridge session convert <path> --to prime|omp [--output <dir>] [--activate]
```

`--activate` only selects the destination leaf in destination-native metadata; it never changes a live harness process.

- [ ] Test source auto-detection by structure, explicit ambiguity error, default non-overwrite, JSON report, exit nonzero on invalid/loss-policy violation, and source unchanged checksum.
- [ ] Run focused test; expect failure.
- [ ] Implement orchestration and human/JSON reports listing every loss, CAS reference, native destination path, and branch counts.
- [ ] Re-run test; expect PASS.

### Task 8: Prove true follow-up resume in both harnesses

**Files:**
- Create: `packages/prime-bridge/test/integration/session-resume.test.ts`
- Create: `packages/prime-bridge/test/fixtures/faux-provider/server.ts`
- Modify: `packages/prime-bridge/README.md`
- Modify: `packages/prime-bridge/CHANGELOG.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

- [ ] Faux provider validates role ordering, every tool-call/result ID+name pair, and returns one deterministic assistant response. It runs on loopback and records requests; no API key or paid provider.
- [ ] Exhaustive gate: for every branch tip in every fixture, use the destination provider adapter to construct and schema-validate the complete request offline. Any invalid role order, missing/duplicate call ID, or call/result name mismatch fails the test and blocks merge.
- [ ] Follow-up gate: for every representative branch class, convert OMP→Prime, start configured Prime RPC (`PRIME_AGENT_BIN`, `switch_session`), select branch, prompt, assert faux response and no schema error. Convert Prime→OMP, open through OMP SDK, navigate branch, prompt same faux provider, assert response.
- [ ] Convert each result back to origin. Assert raw-preserved tool bytes equal originals; all remaining differences are exactly enumerated in loss ledger.
- [ ] Run focused integration test, all bridge session tests, affected coding-agent tests, `bun check`, and `omp --smoke-test`; expect PASS.
- [ ] Document supported native schema revisions, backup/install paths, loss policy, model/provider continuity limits, and the exact definition of true resume. Do not commit unless asked.
