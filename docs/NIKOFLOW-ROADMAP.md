# Nikoflow → oh-my-pi Integration Roadmap

> Written using the **Nikoflow methodology it describes**: Grilling → ADR → PRD →
> Ticketization → TDD → Verification. Every ticket is an atomic vertical slice with
> acceptance criteria, dependencies, and a self-verify step.

## North Star

Make **cheap models (esp. Chinese: DeepSeek / GLM / Qwen / Kimi) produce SOTA-level
output** by wrapping them in **enforced process rails** — a phase-gated methodology
whose gates the model *cannot self-approve* — with the built-in **advisor as a hard QA
gate**. Delivered as a **native `omp` mode**, not a plugin bolted onto someone else's
runtime.

Thesis: a cheap model underperforms less because it is "dumb" and more because it
**skips structure and self-deceives** ("done ✅" on unfinished work). Rails that (a)
force the engineering process and (b) make an independent reviewer's blocker
*binding* raise the *process* to SOTA — at ~1/10 the token cost.

---

## Fable-5 QA — verdict & mandatory revisions (v2)

Adversarial review audited every Appendix-A ref against the live code. **Verdict: TAKE** —
the crux is buildable without forking the loop, and the refs are honest. Applied
revisions (they change the plan, not just annotate it):

**M1 — The reviewer verdict, not the advisor blocker, is the real gate.** The advisor can
never signal "resolved," and two dedupe layers (`advise-tool.ts:169,185` + `emission-guard`
one-note-per-cycle) physically prevent it from re-emitting an unmet blocker. So a raw
`blocker` latch is **unsound** as a "block until cleared" gate. → **TSK-008 (independent
reviewer whose verdict arrives as a `tool_result` with a unique gate-id) is THE execute/
verify gate; the advisor `blocker` is only a soft steering signal. Dependency inverted:
007 now depends on 008.**

**M2 — Fail-closed, not fail-open.** `waitForCatchup(30000,…)` resolves on a timer
regardless of backlog, and the 3-fail circuit-breaker drops backlog and counts success
(`runtime.ts:356`). "Advisor silent" must NOT read as "approved." The gate requires an
explicit per-turn reviewer ACK (verdict tool_result carrying the current gate-id); absence
of a verdict = gate not passed → escalate to the user after bounded attempts. Never
promote on a timeout.

**M3 — De-risk the thesis FIRST (new TSK-000 spike, before TSK-001).** 1–2 days: existing
advisor + `advisor.syncBacklog` + *prompt-level* (non-enforced) phase rules, cheap primary
(DeepSeek/GLM) vs bare, on ~10 `typescript-edit-benchmark` tasks. Measure pass-rate **and
tokens/time/gate-thrash**. If a cheap primary can't follow even soft rails → do not build
the harness. This is the cheapest falsifier of the whole cheap→SOTA thesis.

**Added/fixed tickets** (fold into Phase 4): **TSK-013** NikoflowState persistence across
save/resume/compaction (a resume mid-Execute must not reset gates); **TSK-014** the
*methodology-mode registry itself* — `modes/` is UI transport, no methodology-mode slot
exists, so "register the mode" is hidden design work; **TSK-015** headless/RPC/print scope
— human gates currently sit on interactive-mode plan-approval, so either add an RPC gate
path or explicitly scope v1 as *interactive-only*; **TSK-016** inject phase rules into the
primary prompt (port `prompts.ts` via `PRIMARY_CONTEXT_CUSTOM_TYPES`); **TSK-017** the
upstream rebase procedure (`origin=can1357/oh-my-pi`, we work in a fork). **Fixes:** TSK-004
uses the Soft-ladder (`setForcedToolChoice` *ends* the turn — wrong mechanism for "don't
yield until artifact"); TSK-012 `blocked-by` = 000–011 (not 009); bounded-attempts→escalate
must be a real PBT invariant (the "no-deadlock" property today covers advisor failure but
NOT a cheap primary that never emits the exact tag).

**TSK-018 — Live plan surface via the native `todo` tool.** oh-my-pi already ships a
phase-grouped, harness-pinned plan surface — `tools/todo.ts` (`{phase, items[]}`, tree-
rendered "Updated Plan") + `modes/components/todo-reminder.ts` (re-pins incomplete items
into the transcript every turn). nikoflow's phases + tickets map onto it 1:1 (the todo
tool is *already* phase-grouped). **Render nikoflow's phase list + the current
`tickets.json` slice into the todo surface** so the user sees a live "Updated Plan □"
(current phase, tickets, statuses, stop condition), kept alive by `todo-reminder`, backed
by the stricter validated ticket-DAG underneath. This is transparency/UX for near-free and
a gap the v1 draft missed. *Acceptance:* an active nikoflow run shows a live phase/ticket
plan via the todo surface that updates as phases/tickets advance. *Blocked-by:* 002/014,
Ticketization (010). *Self-verify:* integration asserts the todo surface reflects
state after a phase/ticket transition.

**Verify-before-build checks** (do in TSK-000/001, not after): (a) per-provider — does
DeepSeek/GLM/Qwen/Kimi support hard `tool_choice` forcing? `buildNamedToolChoice` throws
"model does not support forcing a specific tool" on some, so the Soft-ladder's top rung may
be absent — the gate design must degrade to escalate, not hang. (b) Grilling "read-only" by
tool-name does NOT stop `bash echo > file`; either ban bash-writes in Grilling or sandbox.
(c) `onTurnEnd`/`beforeToolCall`/`onBeforeYield` are single-slot last-writer-wins fields and
the session already owns `onTurnEnd` — chain, don't overwrite (R2 was understated).

**Scope reality:** DEEP + full ticket set + PBT + benchmark ≈ **4–8 weeks**, not a "feature."
Minimal thesis-proving core: **TSK-000 spike → 001, 002/014, 003, 005, 006, 008-as-gate**;
PBT/011/012 are the tail.

---

## 🔥 Phase 1 — Grilling (interrogate before any code)

**Why this, why now.** oh-my-pi already owns its agent loop and ships a strong
per-turn advisor. That is the missing substrate the Claude-Code plugin version of
nikoflow never had (there it rides Stop-hooks — a *reactor* that only gates at turn
boundaries, so the model can self-drive every phase in one turn). Owning the loop lets
gates be enforced at *orchestration* time.

**Why native, not a plugin / not a loop fork.**
- Plugin/hook (rejected): weak enforcement, the self-drive bypass, non-portable.
- Fork the loop (rejected): permanent merge pain against a fast-moving upstream.
- **Native mode via existing callbacks (chosen):** the loop already exposes every hook
  a phase gate needs; `plan-mode` is a working precedent for a human-gated phase.

**The one real gap (the crux).** The advisor's `blocker` severity is still *advisory*
(`guidance="weigh, don't blindly obey"`, `advise-tool.ts`). The primary can self-approve
past it. **Closing that — making a reviewer verdict binding — is the core of nikoflow's
value and the single hardest thing to build here.**

**Risks to carry through every phase.**
- R1 — self-approval: the primary emitting an "approved" tag/text must never advance a
  gate; only a real user turn (human gates) or an independent reviewer tool_result
  (execute/verify gates) may.
- R2 — no loop fork: all enforcement through documented callbacks, phase-state as a
  separate object (mirror `plan-mode/state.ts`).
- R3 — cheap-model tool-calling reliability: some cheap models emit malformed tool
  calls; the `SoftToolRequirement` remind→escalate→force ladder must degrade sanely.
- R4 — upstream mergeability: keep the diff additive; do not rewrite `agent-loop.ts`.
- R5 — advisor flooding / cost: reuse `emission-guard` + severity routing; the hard-gate
  must not turn the advisor into a lockstep bottleneck (bound with `waitForCatchup`).

**Depth tier: DEEP** — architectural change + property-based tests + a benchmark as
evidence.

**GATE (human):** owner confirms the North Star, the "advisor-blocker becomes binding"
crux, and the DEEP tier before ADR.

---

## 📋 Phase 2 — ADR (architecture decisions)

Record only hard-to-reverse, surprising-without-context, real-trade-off decisions.

### ADR-001 — Nikoflow is a stateful *mode object*, driven through existing loop callbacks
- **Options:** (a) fork `agent-loop.ts`; (b) new mode object + callbacks; (c) implement as an advisor-only construct.
- **Decision:** (b). A `NikoflowState` object (per session, mirror of `packages/coding-agent/src/plan-mode/state.ts`) holds `{phase, depth, gateRequestId, tickets[]}`; the loop is driven, never forked, via the five hooks (Appendix A).
- **Consequences:** additive diff, upstream-mergeable; no control over anything the callbacks don't expose (accept).

### ADR-002 — The advisor is the reviewer/QA rail; add a *binding-gate* layer on top
- **Decision:** reuse `AdvisorRuntime` (`advisor/runtime.ts`) as the reviewer. Add a thin **gate enforcer** that reads `blocker` notes off the advisor channel and refuses phase promotion until cleared. Do NOT re-implement review.
- **Rationale:** the advisor already runs a strong reasoner (`advisor→slow` role), reads hidden reasoning + diffs, is code-throttled (`emission-guard`), and has a failure circuit-breaker. Only its *bindingness* is missing.
- **Consequences:** nikoflow's differentiator (anti-self-approval) is delivered as a small enforcement layer, not a new subsystem.

### ADR-003 — Human gates reuse the plan-approval machinery
- **Decision:** depth/interview/prd/tickets gates capture a real human turn via the plan-review path (`interactive-mode.ts#abortPlanApprovalTurnSilently` + `ClientMode.handlePlanApproval` + `session.prompt`), correlated by a minted `gateRequestId` that rotates on any premature tag (closes R1).
- **Consequences:** no new UI; reuses a proven human-in-the-loop overlay.

### ADR-004 — Cheap-model rails are pure `modelRoles` config, no code change
- **Decision:** ship presets that set `modelRoles.task = <cheap primary>` and `modelRoles.advisor = <strong/specialized rail>` via `WATCHDOG.yml` + settings; rely on the existing provider/catalog layer (DeepSeek/GLM/Qwen/Kimi are first-class, host-quirks auto-detected).
- **Consequences:** "cheap→SOTA" is a config surface + the rails, not a provider rewrite.

### ADR-005 — Phase-legal toolsets enforced at `beforeToolCall`
- **Decision:** each phase declares a legal toolset; `beforeToolCall` blocks illegal tools (Grilling = read-only; TDD = a failing test must exist before impl writes) — mirroring `enforcePlanModeWrite`.

**GATE (human):** owner records/《skips》each ADR.

---

## 📄 Phase 3 — PRD

**[Developer] can run a phase-gated build that a cheap model cannot fake its way through.**

- **US-1 — Activate.** *Given* a repo, *when* I run `omp nikoflow[:tactical|standard|deep] "<task>"`, *then* the session enters Grilling and cannot touch the working tree until the depth gate is confirmed by me.
- **US-2 — Human gate.** *Given* a human gate is open, *when* the model emits the confirm tag without my reply, *then* it is rejected (request-id rotated) and the phase does not advance.
- **US-3 — Binding reviewer.** *Given* the execute/verify gate, *when* the advisor (or a spawned reviewer sub-agent) emits `blocker`, *then* the phase cannot promote until the blocker is cleared, regardless of what the primary claims.
- **US-4 — Phase-legal tools.** *Given* the Grilling phase, *when* the model attempts a write/edit tool, *then* it is blocked with a reason.
- **US-5 — Cheap rails.** *Given* a cheap-model preset, *when* I run a deep task, *then* the cheap model executes and the strong advisor gates quality, at a fraction of SOTA cost.
- **US-6 — Evidence.** *Given* a completed run, *then* `omp stats` shows the phase transitions, gate outcomes, and reviewer verdicts.

**Test seams (highest, fewest):**
1. `NikoflowState` transition function (pure) — phase machine + gate acceptance/rotation.
2. The gate-enforcer that maps advisor `blocker` → phase-block (pure, fed synthetic advisor notes).
3. `beforeToolCall` phase-legality predicate (pure).
4. Integration: a scripted session that drives Grilling→…→Verify with a mock model + mock advisor, asserting BLOCK→PASS at each gate.

**GATE (human):** owner confirms the seams (`SEAMS_CONFIRMED`).

---

## 🎫 Phase 4 — Ticketization (atomic, vertical, demoable)

> Each ticket: acceptance criteria · blocked-by · self-verify. IDs stable.

- **TSK-001 — Phase-state object.** `NikoflowState` (`{phase, depth, gateRequestId, tickets}`), a pure transition fn `advance(state, event)`, and mint/rotate for `gateRequestId`. Mirror `plan-mode/state.ts`.
  - *Acceptance:* transitions match the depth's phase list; a tag with a stale request-id is ignored; no request-id → no advance. *Blocked-by:* —. *Self-verify:* unit tests on the transition fn.
- **TSK-002 — Mode wiring & CLI entry.** `omp nikoflow[:tier]` activates the mode; register the mode object; hold state per session. *Acceptance:* activation writes state, sets phase=grilling. *Blocked-by:* 001. *Self-verify:* `omp nikoflow "x"` → state present.
- **TSK-003 — Phase-legal toolset via `beforeToolCall`.** Per-phase legal toolset; block illegal tools with a reason. *Acceptance:* Grilling blocks edit/write; TDD blocks impl-write before a failing test exists. *Blocked-by:* 001. *Self-verify:* unit on the predicate + a blocked tool call in integration.
- **TSK-004 — Forced artifacts via `SoftToolRequirement`.** Use `ToolChoiceQueue`/`setForcedToolChoice` to require the ADR/PRD/tickets artifact before advancing. *Acceptance:* the loop will not yield the phase until the artifact tool is called. *Blocked-by:* 001. *Self-verify:* integration with a mock model.
- **TSK-005 — Gate enforcement via `onBeforeYield`.** Refuse to yield until the current phase's gate predicate passes. *Acceptance:* a completed turn with an unmet gate re-prompts instead of stopping. *Blocked-by:* 001, 003. *Self-verify:* integration BLOCK case.
- **TSK-006 — Human gates via plan-approval.** depth/interview/prd/tickets require a real user turn after mint; premature tag rotates the id (R1). *Acceptance:* self-confirm rejected; user reply advances. *Blocked-by:* 005. *Self-verify:* integration: no-reply→blocked, reply→pass.
- **TSK-007 — Binding advisor gate.** Read advisor `blocker` off its channel; execute/verify cannot promote while an unresolved blocker exists. Bound with `waitForCatchup` (no lockstep). *Acceptance:* synthetic `blocker` blocks promotion; cleared → passes; advisor down (circuit-breaker) → escalate to user, never deadlock. *Blocked-by:* 005. *Self-verify:* unit on the enforcer + integration.
- **TSK-008 — Reviewer sub-agent at gates.** Spawn an independent reviewer (`TaskTool`/child `Agent`) whose tool_result carries the verdict; the primary's own text never satisfies the gate (R1). *Acceptance:* gate accepts only the sub-agent's result. *Blocked-by:* 007. *Self-verify:* integration.
- **TSK-009 — Per-role cheap-model rails preset.** `WATCHDOG.yml` + `modelRoles` presets: cheap `task` primary + strong `advisor`. *Acceptance:* `omp nikoflow --preset cheap-cn` routes roles correctly; run completes. *Blocked-by:* 002. *Self-verify:* config test + a live smoke on DeepSeek/GLM.
- **TSK-010 — Depth tiers & phase lists.** tactical (Grilling→Execute→Verify) / standard (+ADR+PRD+Tickets) / deep (+PBT+evidence). *Blocked-by:* 001. *Self-verify:* unit on phase materialization.
- **TSK-011 — Evidence surface.** phase transitions + gate outcomes + reviewer verdicts into `omp stats` / advisor JSONL. *Blocked-by:* 005–008. *Self-verify:* stats shows a run.
- **TSK-012 — Benchmark: cheap+rails vs SOTA-bare.** Run `terminal-bench` / `typescript-edit-benchmark` with (a) cheap model bare, (b) cheap model + nikoflow rails, (c) SOTA bare. *Acceptance:* reproducible numbers; (b) closes most of the (a)→(c) gap. *Blocked-by:* 009. *Self-verify:* committed benchmark report.

**GATE (human):** owner iterates until the breakdown is `APPROVED`.

---

## 🔴🟢 Phase 5 — TDD strategy (test-first per ticket)

- **RED before GREEN** at the pre-agreed seams (§PRD). One vertical slice at a time.
- Pure cores first (`NikoflowState.advance`, the gate enforcer, the phase-legality
  predicate) — deterministic, fast, property-testable.
- **Property-based tests (deep tier):** invariants —
  - *no-self-approve*: for any sequence of primary-emitted tags without an interleaved user turn / reviewer result, the phase never advances;
  - *rotation soundness*: a rotated request-id is never re-accepted;
  - *no-deadlock*: for any advisor failure/timeout, the flow escalates within bounded steps.
- Integration harness: a scripted `AgentSession` with a **mock model** + **mock advisor**
  asserting the BLOCK→PASS transition at every gate (mirrors the plan-approval tests).
- Reuse the repo's existing vitest/bun test setup; keep each ticket's slice green before
  the next.

---

## ✅ Phase 6 — Verification

- **Per ticket:** its own tests green; `bun build`/typecheck clean; an independent
  reviewer (the advisor itself, dogfooded) scores the slice.
- **Feature-level DoD:**
  1. All property invariants hold (no-self-approve, rotation, no-deadlock).
  2. Integration harness shows BLOCK→PASS at each gate end-to-end.
  3. **Live dogfood:** run `omp nikoflow:tactical "fix a typo"` on a real repo; observe a
     real human gate blocking until reply, and a binding reviewer verdict — quoted from
     the transcript.
  4. **The benchmark (TSK-012):** cheap+rails materially closes the gap to SOTA-bare —
     the headline evidence for the whole thesis.
- **Escalation:** anything touching the anti-self-approval enforcement (TSK-006/007/008)
  is design-then-STOP — owner sign-off before it ships.

---

## Appendix A — Integration points (audited against source)

| Need | Hook / symbol | File |
|---|---|---|
| Block phase-illegal tools | `beforeToolCall(ctx)→{block,reason}` | `packages/agent/src/agent-loop.ts` (enforced), `types.ts:380` |
| Force an artifact before advancing | `getToolChoice`/`SoftToolRequirement`, `ToolChoiceQueue`, `setForcedToolChoice` | `agent-session.ts:2876/2906`, `types.ts:59` |
| Gate before stop | `onTurnEnd` + async `onBeforeYield` | `types.ts:390/236` |
| Capture a real human turn | `#abortPlanApprovalTurnSilently`, `ClientMode.handlePlanApproval`, `session.prompt` | `interactive-mode.ts:2690`, `modes/types.ts:399` |
| Reviewer as a real step | `TaskTool` → `task/executor.ts`, or child `new Agent` | `task/executor.ts:2215`, `agent-session.ts:2444` |
| Human-gated phase precedent | `plan-mode/state.ts` + `enforcePlanModeWrite` | `plan-mode/` |
| Reviewer/QA rail | `AdvisorRuntime.onTurnEnd`, `advise` tool, `emission-guard`, circuit-breaker | `advisor/runtime.ts:99`, `advise-tool.ts`, `emission-guard.ts:157` |
| Cheap-model routing | `ModelRole` (`task`,`advisor`,`smol`,`slow`), `model-resolver.ts`, `priority.json` | `config/model-roles.ts`, `model-resolver.ts` |
| Chinese providers (built-in) | `CATALOG_PROVIDERS` (deepseek, moonshot, zai, zhipu-coding-plan, qwen-portal, minimax) | `packages/catalog/src/provider-models/descriptors.ts:61` |

**Traps (do NOT build on these):** `packages/utils/src/loop-phase.ts` is a stall
watchdog breadcrumb, not phases; `packages/coding-agent/src/modes/` is UI transport, not
methodology phases.

## Appendix B — What ports directly from the existing nikoflow (TS)

The Claude-Code nikoflow's pure cores are reusable almost verbatim (already TS):
`loop.ts` phase machine + request-id mint/rotate, `gates.ts` gate detection,
`tickets.ts` DAG/validation, `prompts.ts` phase prompts, role routing. They plug into
the mode object (TSK-001) and the callbacks above; the *enforcement wiring* is the new,
OMP-specific work.
