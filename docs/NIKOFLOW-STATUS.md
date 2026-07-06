# Nikoflow — as-built status

This is the **implemented** architecture (what actually shipped on `nikoflow-integration`),
which diverged from the speculative plan in `NIKOFLOW-ROADMAP.md` / `NIKOFLOW-IMPLEMENTATION.md`
in one major way: **the binding reviewer is the native advisor, not a spawned sub-agent.**
Read this first; the roadmap/implementation docs are the design rationale + audit history.

## What nikoflow is

A phase-gated methodology mode for the oh-my-pi coding agent that lets **cheap models**
(DeepSeek / GLM / MiniMax / Qwen — any subscription's models) produce production-grade output
by keeping them on rails set by a stronger architect model, with a **binding,
non-self-approvable** review gate. Activate: `omp nikoflow[:tactical|standard|deep] [--exec …]
[--architect …] [--qa …] "<task>"`.

Phases: **Grilling → (ADR → PRD → Ticketization) → Execute → Verify**. `tactical` =
Grilling→Execute→Verify (monolithic); `standard`/`deep` add ADR/PRD/Ticketization + a
per-ticket execute loop.

## Capability rails (per-phase model roles)

`--architect`→`modelRoles.plan` (strong): owns Grilling/ADR/PRD/Ticketization.
`--exec`→`modelRoles.default` (cheap): only Execute.
`--qa`→`modelRoles.advisor` (strong): Verify + per-ticket review.
Fail-fast at activation if `plan` == `default` or unset. Fully **model-agnostic** — no model
names or provider branching anywhere in the nikoflow code; roles resolve through `modelRoles`.

## The binding gate — native advisor (the key design decision)

The verify gate is satisfied **only** by an independent verdict from the **native oh-my-pi
advisor** (its own model, harness-owned prompt, emits `nit`/`concern`/`blocker`). The primary
can never self-approve. On entering verify (and per ticket), the harness triggers a **fresh**
advisor review of the **final diff**; pass = no `blocker`, hold = blocker (executor fixes,
re-review), **escalate (never auto-pass)** if the advisor is absent/circuit-broken. Stale
blockers from earlier phases are superseded and correlated to the current gate id.

*History:* the original design spawned a dedicated reviewer sub-agent; that mechanism was
unreliable across 3 fixes. Replacing it with the native advisor (still independent + harness-
owned) closed the crux. `reviewer.ts` was deleted.

## Anti-self-approval invariants (property-tested, 36k assertions)

- `gateMatches` fail-closed (a null/mismatched id never satisfies a gate).
- Human gates advance only on a genuine user turn *after* the gate was minted.
- Grilling advances only on a structured **convergence marker** (`nikoflow_grilling
  {open_questions:[]}`) + a user turn — no more "any message advances" (closed hole #7).
- Verify advances only on a fresh independent advisor verdict — never the primary's text.
- Callbacks are **chained**, never clobbered (the advisor's `onTurnEnd` survives); gate-hold
  is a **follow-up-queue yield** (not a blocking return); for human/exhausted gates it yields
  to the user rather than looping (livelock-free, bounded).

## Ticketization (standard/deep) — real per-ticket loop

The architect decomposes the spec by calling a structured **`nikoflow_define_tickets`** tool
(`{tickets:[{id,acceptance,blocked_by,implementation_notes}]}`) — validated into a DAG,
persisted to the compaction-durable todo-state. Execute then **loops** over tickets in
topological order: per ticket the cheap executor implements against its acceptance, a fresh
independent advisor review gates that ticket's diff (pass→done, blocker→fix, bounded→escalate),
then the next ticket. A final verify reviews the whole.

**Enforcement:** pre-execute phases (grilling/adr/prd/ticketization) use a read-only tool
**allowlist** — only read/search/planning tools (+`nikoflow_define_tickets`, advisory, todo)
are permitted; writes **and code-execution** (edit/write/`node_repl`/`python_repl`/bash) are
blocked, unknown tools default to blocked. This stops the cheap executor from implementing
eagerly (via `node_repl`/bash) before an approved ticket DAG exists, so tickets actually
*constrain* execution.

## Proven live (cheap CN models, keyless, $0.05–0.09/task)

| Scale | Result |
|---|---|
| tactical (typo, 1 file) | grilling→execute→verify(advisor)→done, autonomous |
| tactical (multi-file, calc) | 3 coordinated files, tests pass, advisor-gated |
| standard (string-utils) | 5-question interview → per-ticket loop → 26 tests |
| bigger (4-module CLI) | 5-ticket DAG, per-ticket review, 17 tests |

The advisor catches **real spec violations** (e.g. `truncate` negative-`n` against the ADR/PRD
acceptance) — the "hardened spec → cheap executor drifts → advisor catches" loop working.

## Honest limitations

- Verified live only on DeepSeek/GLM (code is model-agnostic; other subscriptions untested).
- Interactive human gates need a real user; **autonomous batch mode** (advisor replaces the
  human at gates) is the current in-progress addition.
- Not yet exercised at 15+ file scale.
- The grilling convergence-marker is unit-tested; a live interactive dogfood of it is pending.

## Tests

`bun test packages/coding-agent/src/nikoflow/__tests__/` — 64+ tests, incl. property-based
anti-self-approval invariants, per-ticket loop, allowlist, convergence marker, advisor gate.
