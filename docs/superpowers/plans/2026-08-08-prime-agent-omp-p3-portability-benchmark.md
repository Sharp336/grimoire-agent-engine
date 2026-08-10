# Prime Agent ↔ OMP P3 Model/Auth Portability and RLM Benchmark Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Provide explicit model-registry conversion, safe credential import, and a measured decision gate for whether typed Prime RLM RPC is worth adding.

**Architecture:** `ModelSpecV1` is a neutral, versioned interchange consumed by separate Prime and OMP adapters. Credentials are never shared live: API keys may be copied one selected provider at a time with confirmation; OAuth always defaults to target-harness re-login. The benchmark compares N Prime RPC sessions with prompt-mediated in-session Prime RLM on identical workloads; it does not claim equivalent semantics.

**Prerequisites:** P1 is merged. Session conversion is not required for model/auth conversion; P2A metrics may be reused if available.

**Tech Stack:** Bun, TypeScript, YAML/JSON parsers already in OMP, SQLite auth store public API, Prime JSON auth/model formats, benchmark JSONL.

## Global Constraints

- Never modify generated model catalogs in either repository. Convert only user-defined provider/model configuration.
- Never write credentials into model config, logs, audit previews, reports, or benchmark artifacts.
- OAuth tokens are not portable merely because field shapes overlap. Anthropic endpoints/client flows differ between the products; emit a re-login action instead of copying OAuth.
- API-key import is opt-in, provider-scoped, identity-aware where metadata exists, no-overwrite by default, atomic, and mode 0600.
- Benchmark paid calls require a quoted estimate and explicit `--confirm-paid`; fixture mode is the CI default.
- No commits unless asked.

---

### Task 1: Define and validate `ModelSpecV1`

**Files:**
- Create: `packages/prime-bridge/src/model/spec.ts`
- Create: `packages/prime-bridge/src/model/schema.ts`
- Create: `packages/prime-bridge/src/model/aliases.ts`
- Test: `packages/prime-bridge/test/model-spec.test.ts`

**Interfaces:**

```ts
export interface ModelSpecV1 {
  specVersion: 1;
  providers: ModelSpecProvider[];
  warnings: ConversionWarning[];
}

export interface ModelSpecProvider {
  id: string;
  displayName?: string;
  baseUrl?: string;
  api?: string;
  headers?: Record<string, string>;
  authMode: "api-key" | "oauth" | "none" | "unknown";
  models: ModelSpecModel[];
}
```

- [ ] Test duplicate provider/model rejection, secret-like header rejection, stable normalization, explicit warning preservation, and alias table entries for known divergences (`azure`/`azure-openai-responses`, `kimi-code`/`kimi-coding`).
- [ ] Run focused test; expect failure.
- [ ] Implement omptype schema. Alias conversion must be directional and table-driven; unknown provider/API values pass through with warnings, not guessed remaps.
- [ ] Re-run test; expect PASS.

### Task 2: Implement Prime custom-model reader/projector

**Files:**
- Create: `packages/prime-bridge/src/model/prime-adapter.ts`
- Test: `packages/prime-bridge/test/model-prime-adapter.test.ts`
- Create: `packages/prime-bridge/test/fixtures/models/prime-models.jsonc`

**Contract:**
- Read Prime `{providers}` JSON/JSONC using its comment/trailing-comma rules.
- Map `thinkingLevelMap` into canonical reasoning aliases only where deterministic.
- Prime projection drops OMP-only `discovery`, `transport`, remote compaction, and auth-broker metadata with warnings.

- [ ] Test comments/trailing commas, provider+model inheritance, headers without secrets, reasoning map, unknown APIs, and no-overwrite atomic output.
- [ ] Run focused test; expect failure.
- [ ] Implement reader/projector and structural validation; never import Prime generated model registry.
- [ ] Re-run test; expect PASS.

### Task 3: Implement OMP custom-model reader/projector

**Files:**
- Create: `packages/prime-bridge/src/model/omp-adapter.ts`
- Test: `packages/prime-bridge/test/model-omp-adapter.test.ts`
- Create: `packages/prime-bridge/test/fixtures/models/omp-models.yml`

**Contract:**
- Read OMP YAML with the same parser/normalizer as `ModelRegistry` where public.
- Map canonical reasoning to OMP `thinking`; preserve `supportsTools` and `premiumMultiplier` only in OMP-native sidecar metadata.
- Project valid OMP user YAML; `auth:none` or required API-key placeholder decisions must be explicit warnings, never silent repair.

- [ ] Test provider inheritance, YAML semantics, API/base URL requirements, OMP-only fields, unknown auth, and no-overwrite output.
- [ ] Run focused test; expect failure.
- [ ] Implement using exported OMP config types/validation. Add a narrow parser export rather than copying registry logic.
- [ ] Re-run test; expect PASS.

### Task 4: Add model conversion CLI and round-trip report

**Files:**
- Create: `packages/prime-bridge/src/model/convert.ts`
- Modify: `packages/prime-bridge/src/cli.ts`
- Test: `packages/prime-bridge/test/model-convert-cli.test.ts`

**CLI:**

```text
omp-prime-bridge model inspect <path>
omp-prime-bridge model convert <path> --to prime|omp --output <path> [--force]
```

- [ ] Test source detection, dry-run default, explicit output, existing-target refusal, warning report, and source checksum unchanged.
- [ ] Add A→B→A test: all common fields stable; every dropped/changed field appears exactly once in warnings.
- [ ] Run focused test; expect failure.
- [ ] Implement orchestration. `--force` still creates a timestamped backup before atomic replacement.
- [ ] Re-run test; expect PASS.

### Task 5: Implement credential inspection and API-key import

**Files:**
- Create: `packages/prime-bridge/src/auth/inspect.ts`
- Create: `packages/prime-bridge/src/auth/import.ts`
- Create: `packages/prime-bridge/src/auth/redaction.ts`
- Test: `packages/prime-bridge/test/auth-import.test.ts`
- Create: `packages/prime-bridge/test/fixtures/auth/README.txt`

**Interfaces:**
- `inspectCredentials(source): CredentialSummary[]` returns provider/type/identity metadata only.
- `importApiKey({source, target, provider, credentialId?, overwrite:false})` performs one selected copy.
- OAuth summary is `{portable:false, action:"relogin"}`; no OAuth copy function exists.

- [ ] Build auth fixtures at runtime from fake tokens; never commit token-shaped values. Test redacted reports, multi-credential ambiguity error, provider selection, no overwrite, atomic Prime 0600 write, and OMP insertion through `SqliteAuthCredentialStore` public API.
- [ ] Test reverse OMP→Prime requires choosing exactly one active API-key credential because Prime stores one credential per provider.
- [ ] Run focused test; expect failure.
- [ ] Implement Prime file locking/atomic replacement compatible with its migration rules; use OMP public store methods, not direct SQL.
- [ ] Re-run test; expect PASS.

### Task 6: Add credential CLI with confirmation boundary

**Files:**
- Create: `packages/prime-bridge/src/auth/cli.ts`
- Modify: `packages/prime-bridge/src/cli.ts`
- Test: `packages/prime-bridge/test/auth-cli.test.ts`

**CLI:**

```text
omp-prime-bridge auth inspect --from prime|omp
omp-prime-bridge auth import --from prime|omp --to omp|prime --provider <id> [--credential <id>] [--yes]
```

- [ ] Test non-TTY without `--yes` refuses; OAuth returns re-login instructions; API key preview shows fingerprint only; destination conflict refuses; success prints provider+target only.
- [ ] Run focused test; expect failure.
- [ ] Implement prompt/`--yes` flow and source/destination locking. Never accept `--all`.
- [ ] Re-run test; expect PASS.

### Task 7: Build reproducible RPC-vs-RLM benchmark harness

**Files:**
- Create: `packages/prime-bridge/src/benchmark/rlm-fanout.ts`
- Create: `packages/prime-bridge/src/benchmark/workloads.ts`
- Create: `packages/prime-bridge/src/benchmark/metrics.ts`
- Create: `packages/prime-bridge/src/benchmark/report.ts`
- Test: `packages/prime-bridge/test/rlm-fanout-benchmark.test.ts`

**Workloads:** five read-only repository tasks with deterministic answer predicates and identical source snapshots. Run concurrency 2, 4, and 8; five repetitions per cell after one warm-up.

**Compared paths:**
1. OMP launches N independent `prime-agent --mode rpc` sessions, sends the same locked context+task contract to each, collects each terminal response.
2. One Prime session receives a locked prompt that invokes `rlm()` with the same N task contracts and returns correlated child results.

**Metrics:** success predicate, input/output/cache tokens, wall time, first-result latency, peak RSS, context re-establishment bytes, orphaned child count, and cancellation settle time.

- [ ] Fixture test uses fake RPC/RLM adapters and proves identical workload sets, warm-up exclusion, metric math, failure accounting, and no token contents in report.
- [ ] Run focused test; expect failure.
- [ ] Implement adapters behind interfaces so CI is hermetic and a live run is explicit.
- [ ] Re-run test; expect PASS.

### Task 8: Add live benchmark command and typed-RLM decision gate

**Files:**
- Modify: `packages/prime-bridge/src/cli.ts`
- Create: `packages/prime-bridge/src/benchmark/decision.ts`
- Test: `packages/prime-bridge/test/rlm-decision.test.ts`
- Modify: `packages/prime-bridge/README.md`
- Modify: `packages/prime-bridge/CHANGELOG.md`

**CLI:**

```text
omp-prime-bridge benchmark rlm-fanout --profile <name> --estimate
omp-prime-bridge benchmark rlm-fanout --profile <name> --confirm-paid --output <json>
```

**Decision rule:** Mark typed RLM RPC `reconsider` only when, at equal-or-better success rate, RPC fan-out has either (a) median total input tokens >1.5× in-session RLM or (b) p95 wall time >2× in-session RLM in at least two concurrency cells. Otherwise mark `keep-prompt-mediated`. The report is advisory; this phase never adds typed RLM RPC.

- [ ] Test quote binding, no live run without exact quote+confirmation, sample-size rejection, threshold boundaries, and result labels.
- [ ] Run focused test; expect failure.
- [ ] Implement estimate/confirmation and JSON report with environment/model/version fingerprints but no credentials or prompt contents.
- [ ] Run focused test, all model/auth/benchmark tests, `bun check`, and `omp --smoke-test`; expect PASS.
- [ ] Document conversion losses, OAuth re-login policy, benchmark methodology, and decision result. Do not commit unless asked.
