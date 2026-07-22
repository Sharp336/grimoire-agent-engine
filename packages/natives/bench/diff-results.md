# Native diff benchmark

- Source: `973bad0c6170d2ff2ad08cb52c574002f1d02ec8` (clean tree, deployed via `git archive`)
- Host: Apple M1, darwin-arm64, bun 1.3.14, idle machine (load < 7)
- Native build: ci profile, `RUSTFLAGS="-C target-cpu=apple-m1"`
- Method: seeded synthetic docs, per-scenario warmup + timed iterations, serial runs, crossing-inclusive. Native timings include the `isWellFormed()` guards the production call sites pay before choosing the native path.
- Command: `PI_COMPILED=1 bun packages/natives/bench/diff.ts` (`BENCH_WARMUP` / `BENCH_ITERATIONS` / `BENCH_MAX_LINES` / `BENCH_SHA` env overrides)

## High-precision run (warmup 20, iterations 300/scenario, scenarios ≤ 5000 lines)

| scenario | jsdiff diffLines | native diffLines | speedup | jsdiff structuredPatch | native hunks | speedup |
|---|---|---|---|---|---|---|
| 100 lines / 1% edits | 37.3µs | 21.7µs | 1.7x | 47.9µs | 21.7µs | 2.2x |
| 100 lines / 20% edits | 63.1µs | 38.0µs | 1.7x | 69.9µs | 38.0µs | 1.8x |
| 5000 lines / 1% edits | 1.10ms | 827.7µs | 1.3x | 1.35ms | 825.4µs | 1.6x |
| 5000 lines / 20% edits | 150.04ms | 25.30ms | 5.9x | 150.66ms | 26.03ms | 5.8x |

## Full run including 50k-line scenarios (warmup 2, iterations 10/scenario)

Reduced iterations because jsdiff needs ~22s per iteration on the heaviest row.

| scenario | jsdiff diffLines | native diffLines | speedup | jsdiff structuredPatch | native hunks | speedup |
|---|---|---|---|---|---|---|
| 100 lines / 1% edits | 57.2µs | 22.6µs | 2.5x | 64.3µs | 21.2µs | 3.0x |
| 100 lines / 20% edits | 66.3µs | 37.2µs | 1.8x | 104.4µs | 34.4µs | 3.0x |
| 5000 lines / 1% edits | 1.41ms | 970.6µs | 1.5x | 1.71ms | 889.7µs | 1.9x |
| 5000 lines / 20% edits | 152.44ms | 26.32ms | 5.8x | 154.58ms | 25.20ms | 6.1x |
| 50000 lines / 1% edits | 46.17ms | 16.03ms | 2.9x | 50.95ms | 15.34ms | 3.3x |
| 50000 lines / 20% edits | 22410.26ms | 2973.66ms | 7.5x | 23010.35ms | 2996.85ms | 7.7x |

## Notes

- Native wins at every measured size, guards included; no crossover where the N-API crossing plus the well-formedness scan dominates.
- The worst jsdiff case (50k lines / 20% edit density) is a ~22s synchronous stall on the render path vs ~3s native.
- Behavior parity with jsdiff is defended by `packages/natives/test/diff-parity.test.ts` (fixed edge cases, seeded random documents including CRLF/unicode/no-trailing-newline, seeded random word diffs, a 10k-line document, and explicit ill-formed UTF-16 rejection) plus the call-site fallback regressions in `edit-diff.test.ts`, `edit-renderer.test.ts`, and `recovery-session-chain.test.ts`, all run with `PI_COMPILED=1 bun test`.
