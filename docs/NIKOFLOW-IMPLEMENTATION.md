# Nikoflow → oh-my-pi — Implementation Spec (hand to Codex)

> **AS-BUILT:** see `NIKOFLOW-STATUS.md` for what actually shipped. Key divergence: the binding
> reviewer is the **native advisor**, not a spawned sub-agent (that mechanism proved unreliable
> and was deleted). This file remains the design/build rationale.

This is the **build order**. The full analysis + why is in `docs/NIKOFLOW-ROADMAP.md`
(read its "READ FIRST — Reality check" section). This file tells you *what to build, where,
in what order, and what must never break*. All architecture claims were audited against the
real code; file:line refs are load-bearing.

**Executor:** Codex (GPT-5.5). **Architect/reviewer of your output:** the human + Claude.
Work on the branch `nikoflow-integration` in this fork. Additive changes only — do NOT fork
or rewrite `agent-loop.ts`.

---

## 0. Mission

Add a phase-gated methodology mode `nikoflow` (Grilling → ADR → PRD → Ticketization →
TDD/Execute → Verify) whose gates the primary model **cannot self-approve**, so a cheap
executor kept on rails set by a strong architect produces high-quality output. Build it as a
**stateful mode object driven through existing agent callbacks** — never a loop fork.

Port the pure cores from the reference implementation (already written, TypeScript):
`~/.claude/plugins/marketplaces/omc/src/hooks/nikoflow/` on branch `feature/nikoflow`
(`loop.ts` phase machine + role routing, `gates.ts` gate detection, `tickets.ts` DAG,
`prompts.ts` phase prompts, `pbt.ts`). They port almost verbatim; the *enforcement wiring*
is the new oh-my-pi-specific work.

---

## 1. HARD INVARIANTS — never violate these (they encode the audit findings)

1. **Anti-self-approval (the whole point).**
   - Human gates (depth/grilling/prd/tickets) advance ONLY after a real user turn that
     happens *after* the gate's `gateRequestId` was minted. A tag/text the primary emits
     before the user replies is void; rotate the id.
   - Execute/Verify gates advance ONLY on an **independent reviewer's verdict delivered as a
     `tool_result`** carrying the current `gateRequestId`. NOT the advisor `blocker` (it is
     only advisory — `advise-tool.ts:50`, and dedupe prevents re-emission), NOT the primary's
     own text. Fail-closed: no verdict / no id → gate does NOT pass.
2. **Reviewer prompt is harness-owned.** The primary must NEVER author or influence the
   reviewer sub-agent's prompt or input selection (else self-approval is laundered through a
   puppet). The gate-id must not appear in any reviewer-readable file/diff content.
3. **Capability rails (per-phase model binding).** Strong `plan` role owns Grilling/ADR/PRD/
   Ticketization; cheap `default` role runs only Execute; strong `advisor`/`slow` runs Verify.
   An unconfigured `plan` role silently falls to the primary (`model-resolver.ts:875-892`) —
   so **fail-fast at activation** if `plan` resolves to the same model as `default` or is
   unset. Re-assert the phase→role binding after any `retry_fallback_applied` event
   (`agent-session.ts:13197`), not only at activation (retry with `fallbackRevertPolicy:never`
   can silently demote the architect, `settings-schema.ts:1373`).
4. **Durability — never leave the plan as transcript prose.** There is no message pinning;
   transcript-only ADR/PRD/tickets are compacted away (`docs/compaction.md:81-99`, snapcompact
   bitmaps them into a lossy middle). Only three channels survive compaction: todo phase-state
   (rebuilt from session entries), an approved plan written to a `local://` disk file (re-read
   + re-injected each turn, `approved-plan.ts:110`, issue #1246), and the compaction summary.
   → Persist the **ticket-DAG into the todo-state** (via the `todo` tool) and **ADR/PRD into
   `local://` disk files** (reuse plan-mode's approved-plan machinery). Never set a weak
   `compactionModel`/`modelRoles.smol` while a run is active.
5. **Every architectural decision must be a VISIBLE artifact, never left in thinking.** A
   model swap does NOT carry thinking across the provider seam (anthropic demotes/drops it
   `anthropic.ts:3461-3491`; openai-completions replays only per compat flags `:1799-1849`).
   So the strong architect's reasoning behind ADR/PRD/tickets must be materialized to a
   tool_result / disk file before the boundary; treat thinking as non-load-bearing across
   phases.
6. **Chain callbacks, never clobber; hold gates via the follow-up queue.** `onTurnEnd`,
   `beforeToolCall`, `getToolChoice`, `onBeforeYield` are single-slot scalar setters
   (`agent.ts:750-758`) — the session already owns `onTurnEnd` (the advisor). Capture the
   prior handler, call it, then run nikoflow logic. `onBeforeYield` returns `void` and CANNOT
   block a yield — hold the turn by enqueuing a follow-up message (`agent-loop.ts:1120`), not
   by returning.
7. **The reviewer must see the real plan, not a one-liner.** Non-whitelisted custom message
   types collapse to one line for the model; the whitelist is exactly
   `{"plan-mode-context","plan-mode-reference"}` (`session-history-format.ts:230`). Register
   nikoflow's artifact custom-types there (or write artifacts as `plan-mode-reference`-style
   files) so the reviewer/executor get them in full.
8. **Tool-choice forcing degrades silently on the target models.** Forcing a tool call is
   silently dropped to `auto` on DeepSeek/Kimi (`openai-completions.ts:1454`; Kimi force
   disables reasoning `compat/openai.ts:269`). NEVER trust that a forced artifact tool was
   called — **validate post-hoc** ("was the artifact tool actually called + well-formed?"),
   escalate on absence.
9. **Additive + rebase-safe.** No edits to `agent-loop.ts`. If you must touch
   `interactive-mode.ts` (its `#abortPlanApprovalTurnSilently` is private), add a public entry
   point instead of reaching into privates. Ship a **gate self-test canary** (see T-CANARY)
   that asserts a BLOCK actually blocks — run it on every upstream rebase.

---

## 2. Layout

```
packages/coding-agent/src/nikoflow/
  state.ts        # pure phase machine + gate id + per-phase role map (T1)
  gates.ts        # verdict correlation, fail-closed matching (T2)
  tickets.ts      # ticket DAG validate/status (T3)
  roles.ts        # phase->role resolution, fail-fast, retry re-assert (T4)
  prompts.ts      # phase prompts (port from OMC), minimal per-turn injection (T9)
  artifacts.ts    # ADR/PRD -> local:// files; tickets -> todo-state (T8)
  reviewer.ts     # harness-owned reviewer sub-agent + verdict protocol (T7)
  mode.ts         # wires everything into agent-session via chained callbacks (T5/T6)
  __tests__/…     # vitest per module
```

---

## 3. Build order — lean first. Ship + test each before the next.

### T0 (recommended first, cheap): zero-code thesis spike
Before writing the harness, prove the thesis. Configure `modelRoles` (strong `plan` + cheap
`default` + strong `advisor`) + a nikoflow **prompt** (no code) and run the 4-arm benchmark
(`packages/terminal-bench` / `typescript-edit-benchmark`): (a) cheap bare, (b) cheap + prompt
rails all-cheap, (c) cheap executor + strong plan/advisor, (d) SOTA bare. Metric = quality
AND blended $/solved-task + gate-tag malformation rate + observed self-approval events. Kill
criteria: if (b)≈(c) the strong-architect rail isn't needed; if malformation makes cheap
models unusable under gates, stop. Only build T1+ if the numbers justify it.

### T1 — `state.ts` (pure phase machine). START HERE for the harness.
Immutable, no fs/Date/random. Exports:
`NIKOFLOW_DEPTHS`, `NikoflowDepth`; `NikoflowPhase = "grilling"|"adr"|"prd"|"tickets"|
"execute"|"verify"`; `NIKOFLOW_PHASES` (tactical=[grilling,execute,verify], standard/deep=
[grilling,adr,prd,tickets,execute,verify]); `NikoflowRole="plan"|"default"|"advisor"`;
`PHASE_ROLE` (grilling/adr/prd/tickets→plan, execute→default, verify→advisor);
`NikoflowState {depth, phaseIndex, gateRequestId:string|null}`; `createState`,
`materializePhases`, `currentPhase`, `currentRole`, `advancePhase` (clears gate),
`isComplete`, `mintGateRequest(state,id)`, `rotateGateRequest(state,id)`, `clearGateRequest`,
`gateMatches(state,id)` **fail-closed: true only if state.gateRequestId===id && id!=null**.
All mutators return NEW objects. **Test:** phases per depth, advance to complete, role map,
gate mint/rotate(old id no longer matches)/clear, gateMatches fail-closed on null, immutability.

### T2 — `gates.ts` (verdict correlation)
Detect a reviewer verdict from a `tool_result`: parse `{gateId, verdict:"pass"|"block",
score?}`, accept only if `gateId===state.gateRequestId`. Human-gate acceptance: a real user
turn timestamp > mint timestamp (caller supplies both; keep it pure). Fail-closed everywhere.
Port `gates.ts` detection ideas from OMC but drive it off a **structured verdict**, not tag
text. **Test:** stale/missing gateId rejected; block never passes; pass only with matching id.

### T3 — `tickets.ts` (DAG)
Port OMC `tickets.ts`: `NikoflowTicket {id, acceptance[], blocked_by[], implementation_notes,
status:"todo"|"red"|"green"|"review"|"done"}`, DAG validation (no cycles, no dangling
blocked_by), `getNextTicket`, `markStatus`. **Add `implementation_notes`** (from the strong
architect, to shrink the cheap executor's design latitude). **Test:** cycle detection, next-
ticket ordering, status transitions.

### T4 — `roles.ts` (capability rails)
Resolve phase→omp model role: `plan`/`default`/`advisor`. **Fail-fast on activation** if
`plan` resolves == `default` or unset (throw a clear error). Provide a re-assert hook to call
on `retry_fallback_applied`. Reuse omp's existing per-phase model swap
(`resolveRoleModelWithThinking`, `interactive-mode.ts:1956` pattern). **Test:** fail-fast when
plan==default; correct role per phase.

### T5 — `mode.ts` wiring (chain callbacks) + phase-legal toolsets
Register nikoflow on a session. **Chain** (capture-prior-then-run) `onTurnEnd` (advisor stays
alive), `beforeToolCall` (block phase-illegal tools: Grilling read-only — and **also block
bash-writes in Grilling**, not just edit/write; TDD blocks impl-write before a failing test),
`getToolChoice`. Swap primary to the phase role at each boundary — but **batch same-role
phases**: swap to `plan` once for Grilling→Tickets, once to `default` for Execute, once to
`advisor` for Verify (H1 — each swap resets the provider session/cache). **Test:** integration
with a mock model: illegal tool blocked; advisor onTurnEnd still fires.

### T6 — gate-hold via follow-up queue
On `onBeforeYield`, if the current phase's gate is unmet, enqueue a follow-up "gate X not
satisfied, do Y" message so the loop continues (do NOT try to return-to-block). **Test:** an
unmet gate re-prompts instead of stopping; a met gate yields.

### T7 — `reviewer.ts` (the binding gate — the product)
Spawn an independent reviewer via `TaskTool`/child `Agent` on the `advisor`/`slow` role.
**Harness owns the prompt** (fixed template, primary cannot influence it) and selects the diff
+ acceptance + ADR/PRD as input. The reviewer returns a structured verdict `tool_result`
carrying the current `gateRequestId`. Anti-drift: the reviewer checks "consistent with
ADR/PRD", not just "AC met". Advisor-silence/circuit-breaker (`runtime.ts:355` sets
success=true on failure) must be treated as **escalate**, never pass. **Test:** primary text
never satisfies the gate; only the sub-agent's verdict tool_result does; false-block →
human override path (T-EXPAND).

### T8 — `artifacts.ts` (durability)
Write ADR/PRD to `local://<slug>-adr.md`/`-prd.md` (reuse approved-plan disk machinery, re-
injected each turn); render the ticket-DAG into the `todo` tool state (compaction-durable).
Register nikoflow artifact custom-types in the `session-history-format` whitelist so the
reviewer sees them in full. **Test:** artifacts survive a simulated compaction (state rebuilt
from entries / re-read from disk).

### T9 — `prompts.ts` + minimal injection
Port OMC phase prompts. Inject the phase protocol **only for the current phase's active
model**, minimal per turn (cheap models have a tight instruction budget — H9). **Test:**
prompt for each phase; no architecture-phase protocol leaks into Execute.

### T10 — CLI entry
`omp nikoflow[:tactical|standard|deep] [--exec …] [--architect …] [--qa …] "<task>"`; map
flags onto `modelRoles`; activate the mode. **Test:** activation writes state, sets phase=
grilling, fails fast on plan==default.

### T-CANARY — gate self-test (cheap insurance, do NOT skip)
A scripted session (mock model + mock reviewer) that asserts a gate actually BLOCKS before a
required turn/verdict and PASSES after. Run in CI and on every upstream rebase — a rebase can
silently regress the gate to fail-open with all other tests green.

### T-EXPAND (only after the core proves out) — deferred, not v1
Autonomous/batch mode (Grilling → a spec-completeness gate since there's no human to
interrogate); human override/abort; per-ticket executor-failure escalation ladder (retry →
re-run implementation-notes on `plan` → escalate ticket to `plan`/`advisor` → human);
property-based tests (no-self-approve, rotation, no-deadlock); parallel tickets via worktrees;
the full benchmark harness.

---

## 4. Definition of done (per ticket + overall)
- Each ticket: its vitest green, typecheck clean, additive diff.
- Never leave the tree red. Wrap/chain, never overwrite, session callbacks.
- Overall: T-CANARY proves BLOCK→PASS end-to-end; a live `omp nikoflow:tactical "fix a typo"`
  run shows a human gate blocking until reply and a reviewer verdict gating Execute→Verify,
  quoted from the transcript.
- Upstream-merge: keep every enforcement point behind a documented callback; if you touched an
  internal, note it for the rebase canary.

Reference implementation to port from: `~/.claude/plugins/marketplaces/omc/src/hooks/nikoflow/`
(branch `feature/nikoflow`). Full rationale + every audit finding: `docs/NIKOFLOW-ROADMAP.md`.
