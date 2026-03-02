# Codebase Concerns

**Analysis Date:** 2026-03-02

## Confidence Legend
- **Confirmed:** Directly observed in repository files.
- **Hypothesis:** Plausible risk inferred from current implementation; validate before scheduling invasive fixes.

## Tech Debt

**Session state management is concentrated in one very large unit (Confirmed):**
- Issue: `packages/coding-agent/src/session/session-manager.ts` contains branch/append tree behavior past line 2000 (`appendXXX` APIs at lines 1999, 2056, 2069), indicating high cognitive load and change blast radius.
- Files: `packages/coding-agent/src/session/session-manager.ts`
- Impact: Small edits can introduce branch-history regressions that are hard to detect without deep scenario coverage.
- Fix approach: Split branch navigation, persistence, and mutation APIs into focused modules with invariant tests at each boundary.

**Vendored shell layers carry a visible unresolved backlog (Confirmed):**
- Issue: Multiple `TODO` markers in vendored shell crates, including missing builtins and variable behavior.
- Files: `crates/brush-builtins-vendored/src/factory.rs`, `crates/brush-core-vendored/src/wellknownvars.rs`, `crates/brush-core-vendored/src/sys/stubs/pipes.rs`
- Impact: Behavioral drift versus expected shell semantics and harder upstream syncing.
- Fix approach: Track TODOs in prioritized issue buckets, then either upstream patches or isolate unsupported behavior behind explicit capability flags.

## Known Bugs

**Cursor provider has explicit unimplemented branches (Confirmed):**
- Symptoms: Runtime paths return `"Not implemented"` placeholders.
- Files: `packages/ai/src/providers/cursor.ts` (lines 911, 924, 938)
- Trigger: Exercising those provider response branches.
- Workaround: Feature-gate code paths until implementation is complete; fail with actionable user-facing messages.

**Provider stream test indicates unresolved 422 behavior (Confirmed):**
- Symptoms: Test explicitly skipped with FIXME due to HTTP 422 behavior.
- Files: `packages/ai/test/stream.test.ts` (line 943)
- Trigger: Running stream behavior against current SDK/test harness path.
- Workaround: Add deterministic fixture or mock contract matching official SDK error semantics, then unskip.

## Security Considerations

**Credential material is stored as plaintext JSON in local auth DB (Confirmed, Sensitive-Data Risk):**
- Risk: API keys and OAuth payloads are serialized directly (`JSON.stringify({ key: credential.key })`, `JSON.stringify(rest)`) before database write.
- Files: `packages/ai/src/auth-storage.ts` (lines 1718, 1725, 1796+)
- Current mitigation: File-permission hardening with `chmod 0o600` where supported (`packages/ai/src/auth-storage.ts`, line 1826), with best-effort behavior on Windows.
- Recommendations: Encrypt secrets at rest (OS keychain/DPAPI/libsecret), isolate refresh tokens from general credential rows, and add explicit secret-rotation tooling.

**Debug bundle env sanitization is name-pattern based (Hypothesis, Sensitive-Data Risk):**
- Risk: `sanitizeEnv` redacts by variable-name regex (`key|secret|token|pass|auth|credential|api|private`). Non-matching secret names could be exported in diagnostics.
- Files: `packages/coding-agent/src/debug/system-info.ts` (lines 97-104), `packages/coding-agent/src/debug/report-bundle.ts` (line 95)
- Current mitigation: Standard redaction list and bundle generation path.
- Recommendations: Add allowlist mode for env export, plus denylist tests with adversarial variable names.

## Performance Bottlenecks

**OAuth usage ranking fans out parallel upstream calls (Confirmed core behavior, Hypothesis on saturation impact):**
- Problem: `#rankOAuthSelections` pre-fetches usage reports in parallel via `Promise.all`.
- Files: `packages/ai/src/auth-storage.ts` (lines 1361, 1390-1391, 1482)
- Cause: Multi-credential ranking requests usage endpoints concurrently.
- Improvement path: Apply bounded concurrency and short-circuit thresholds; cache usage windows per provider.

**Single giant generated provider file increases maintenance and tooling overhead (Confirmed):**
- Problem: Generated Cursor protobuf file reaches very high line indices (>14k).
- Files: `packages/ai/src/providers/cursor/gen/agent_pb.ts` (lines 2748, 11190, 14918)
- Cause: Monolithic generated output committed as one file.
- Improvement path: Regenerate in segmented modules if generator supports it, or isolate type-check scope for generated artifacts.

## Fragile Areas

**System prompt tool selection includes unresolved rationale marker (Confirmed):**
- Files: `packages/coding-agent/src/system-prompt.ts` (line 477)
- Why fragile: Hardcoded fallback tool list includes `// TODO: Why?`, signaling unclear contract and higher risk of accidental behavior changes.
- Safe modification: Add invariant tests for tool exposure per mode/provider before refactoring this branch.
- Test coverage: No direct assertion referenced in current concern scan.

**Session tree mutation semantics are dense and stateful (Confirmed):**
- Files: `packages/coding-agent/src/session/session-manager.ts`
- Why fragile: Append/branch/root-pointer semantics coexist in one implementation span.
- Safe modification: Introduce property-based tests around branching and leaf-pointer moves before decomposition.
- Test coverage: Needs targeted history graph invariants.

## Scaling Limits

**AST editing has a hard default file cap (Confirmed):**
- Current capacity: Default max of 1000 files per AST edit operation.
- Limit: Larger repos or broad globs can hit cap and silently constrain operations without careful tuning.
- Files: `packages/coding-agent/src/tools/ast-edit.ts` (line 97)
- Scaling path: Expose cap telemetry and adaptive batching instead of static threshold only.

## Dependencies at Risk

**Vendored brush forks require continuous manual divergence management (Confirmed):**
- Risk: Extensive TODO backlog in vendored copies increases drift from upstream behavior and security fixes.
- Impact: Shell behavior inconsistencies and delayed patch uptake.
- Files: `crates/brush-builtins-vendored/src/factory.rs`, `crates/brush-core-vendored/src/wellknownvars.rs`, `crates/brush-core-vendored/src/sys/stubs/pipes.rs`
- Migration plan: Establish regular upstream sync cadence and conflict budget, or encapsulate unsupported features as explicit non-goals.

## Missing Critical Features

**Stubbed platform/system behavior remains unimplemented (Confirmed):**
- Problem: Stub modules include explicit `TODO: implement` markers.
- Blocks: Full parity across environments that rely on those pipe/user/system behaviors.
- Files: `crates/brush-core-vendored/src/sys/stubs/pipes.rs`, `crates/brush-builtins-vendored/src/factory.rs`

## Test Coverage Gaps

**Key failure paths remain under-tested (Confirmed):**
- What's not tested: Python kernel gateway exit behavior and parts of native module coverage.
- Files: `packages/coding-agent/test/core/python-kernel.test.ts` (line 441), `packages/natives/test/native.test.ts` (lines 28, 37)
- Risk: Runtime failures in process lifecycle and native integration can regress undetected.
- Priority: High

**Coverage enforcement appears policy-light (Hypothesis):**
- What's not enforced: The mapped testing doc indicates threshold enforcement is not wired.
- Files: `.planning/codebase/TESTING.md` (line 146)
- Risk: Broad regressions can pass CI if not exercised by targeted tests.
- Priority: Medium

---

*Concerns audit: 2026-03-02*