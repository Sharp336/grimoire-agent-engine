# Context-Bounding Design

Date: 2026-03-14
Session: `.oh/context-bounding.md`

## Summary

The assembler should keep a smaller, more decision-useful live prompt by separating three concerns that are currently blurred together:

1. explicit live session state that must not be forgotten,
2. recent conversational continuity,
3. older evidence that can be recalled only when it earns its way back into context.

The approved direction is an anchor-first bounded assembly policy:

- keep a bounded recent window measured in transformed messages,
- admit older conversational history only when it clears a relevance floor,
- keep old raw tool transcript out of the base conversation window,
- allow recent tool evidence to participate in passive hydration as a separate evidence lane,
- stop at budget and rely on tools/locators for recovery instead of carrying marginal history forward.

This design is intended to reduce prompt ballooning without increasing re-briefing or forgotten decisions during long coding sessions.

## Aim

In long sessions, the agent stays competent and oriented without bloating the active context window or forcing the user to re-brief.

## Current Implementation

The current flow is split across several components:

- `packages/coding-agent/src/context/assembler/message-transform.ts`
  - Builds the base message array sent to the model.
  - Keeps a recent window of transformed history.
  - Replaces older tool results with bridge-backed stubs.
- `packages/coding-agent/src/context/recall/passive-hydration.ts`
  - Builds a recent hot-window query from user, assistant, and tool-result text.
  - Searches the recall store and MMR-reranks candidates.
  - Injects recalled context as a developer message.
- `packages/coding-agent/src/context/recall/ingest.ts`
  - Ingests message text into recall storage.
  - Tool-result text is part of that searchable store today.
- `packages/coding-agent/src/context/bridge/bridge.ts`
  - Tracks tool-result locators, touched paths/symbols, unresolved errors, and invalidation after mutations.

Observed design issues:

- Multiple recency knobs exist with no single canonical policy.
- Old raw tool transcript is removed from the base conversation window, but tool-result text still influences passive hydration implicitly.
- Passive hydration has ranking, but no explicit minimum relevance floor.
- The system does not cleanly separate conversational continuity from evidence retrieval.

## Problem Statement

Context assembly currently carries too much low-value prior history forward. The result is a larger live prompt with more noise, more token pressure, and more competition between stale transcript and the current task.

The fix is not to disable recall. The fix is to make the base prompt deliberately smaller and to require older context to justify its inclusion.

## Goals

- Keep the live prompt small, stable, and decision-oriented.
- Preserve explicit live session state even when ordinary history is pruned.
- Treat older conversational history and older tool evidence as different classes with different admission rules.
- Preserve tool-based recovery and locator-driven evidence recall.
- Make inclusion/exclusion decisions observable.
- Expose only high-level tuning knobs unless dogfooding proves more are needed.

## Non-Goals

- Replacing the recall store or vector search stack.
- Replacing the tool-result bridge with a new persistence mechanism.
- Introducing a second active context manager.
- Carrying old raw tool transcript in the live conversation window for convenience.
- Expanding public settings to every internal heuristic.

## Approved Design

### 1. Canonical assembly policy

Assemble past context in this order:

1. **Mandatory anchors**
   - Explicit live session state that should not be forgotten while applicable.
   - Initial anchor classes:
     - current aim/plan state,
     - unresolved user constraints/decisions.
   - Anchors do not compete with ordinary relevance ranking.

2. **Recent conversation window**
   - Select the most recent transformed non-tool messages up to a configured recent-message cap.
   - The cap is measured in transformed messages, not raw user/assistant turns.

3. **Older conversational candidates**
   - Consider only transformed non-tool messages outside the recent window.
   - Rank them by relevance to the current turn and active task state.
   - Reject any candidate below the minimum relevance floor.
   - Admit survivors only while budget remains.

4. **Budget stop**
   - Stop once the active-assembly budget is exhausted.
   - Do not compensate by dragging additional low-value history forward.
   - Recovery remains tool- and locator-driven.

This policy is budget-adaptive, but only after anchors and recent conversation have been satisfied.

### 2. Tool-result treatment

Prior tool usage must not behave like ordinary conversation.

#### Base conversation window

- Exclude old raw tool call/result transcript from the ordinary recent-message window.
- Preserve only compact tool-derived live state when it is still applicable through anchors or other explicit summaries.
- The base conversation prompt should optimize for decisions, constraints, and causal conversational continuity, not execution chatter.

#### Evidence lane

- Recent tool evidence may participate in passive hydration as a separate evidence lane.
- Old raw tool transcript should not remain in the base conversation prompt merely because it happened.
- Recent tool evidence can still help recall when it is tied to the active loop.

Examples of evidence that may matter:

- the current unresolved failure chain,
- the latest state-changing action the current turn builds on,
- a tightly scoped ongoing debug loop.

This preserves the model’s ability to recover evidence without paying the steady-state cost of carrying old tool transcript forward.

### 3. Component split

Use four focused responsibilities inside the existing assembler flow:

#### Anchor selector

Produces explicit live state that bypasses normal recency/relevance competition.

Responsibilities:
- determine whether an anchor class is currently applicable,
- emit compact, decision-oriented anchor payloads,
- avoid fuzzy scoring.

#### Recent-message selector

Builds the default backbone of conversational continuity.

Responsibilities:
- operate on transformed messages,
- include recent non-tool messages up to the configured cap,
- avoid admitting raw old tool transcript.

#### Older-message scorer

Handles only transformed non-tool messages outside the recent window.

Responsibilities:
- score older conversational candidates,
- sort by relevance,
- apply the minimum floor,
- return eligible candidates for budgeted packing.

#### Assembly packer

Produces the final bounded prompt payload.

Responsibilities:
- combine anchors, recent conversation, and eligible older conversation,
- leave evidence injection to the passive-hydration lane,
- stop at budget,
- emit observability about why items were included or excluded.

### 4. Passive hydration redesign

Passive hydration remains a separate recall/evidence lane, but its inputs become more disciplined.

#### Query construction

Build the hydration query from:
- the current turn,
- the approved recent conversation window,
- recent tool evidence only.

Do not let old raw tool transcript remain part of the base conversational continuity policy.

#### Candidate selection

- Search the recall store as today.
- Rerank results as today.
- Add an explicit relevance floor for recalled evidence.
- Use a stricter bar for recalled evidence than for the base recent window.

#### Injection

- Inject recalled evidence separately from the base conversation window.
- Treat recalled evidence as optional support, not as hidden continuation of the main transcript.
- Keep observability on what was recalled and why.

### 5. Configuration surface

Expose only high-level knobs publicly:

- **recent message cap**
- **minimum relevance floor**

Keep the following internal unless dogfooding proves they must be tunable:

- evidence-specific thresholds,
- exact budget share between recent conversation and recalled evidence,
- anchor-class internals,
- reranking details.

This avoids a public settings explosion while still enabling meaningful control over prompt size and strictness.

### 6. Observability

The design requires first-class explanations for inclusion and exclusion decisions.

At minimum, emit counts and reasons for:

- anchors included,
- recent non-tool messages included,
- older conversational candidates considered,
- older conversational candidates rejected by floor,
- older conversational candidates rejected by budget,
- recalled evidence candidates rejected by floor,
- recalled evidence injected into the final prompt.

If dogfooding reports “forgetfulness,” this data must tell us whether the cause was cap, floor, budget pressure, or evidence-lane suppression.

## Failure Modes and Guardrails

### Failure mode: over-pruning

Risk:
- the focused prompt drops a causal dependency the model still needed.

Guardrail:
- anchors preserve explicit live session state,
- older conversational history can still enter when it genuinely scores above the floor,
- evidence remains retrievable via passive hydration and tools.

### Failure mode: evidence spam

Risk:
- passive hydration repeatedly injects noisy tool output.

Guardrail:
- keep old raw tool transcript out of the base window,
- build the evidence query from recent tool evidence only,
- apply a strict evidence floor.

### Failure mode: knob drift

Risk:
- multiple overlapping recency defaults diverge again.

Guardrail:
- define one canonical recent-message cap policy and one canonical relevance floor policy,
- make other heuristics internal derivatives of that design instead of separate product concepts.

### Failure mode: hidden exclusion

Risk:
- the team cannot tell why a needed item disappeared.

Guardrail:
- inclusion/exclusion telemetry is part of the design, not an afterthought.

## Testing Strategy

Add or update tests to defend these contracts:

1. **Cap contract**
   - The recent window is capped by transformed messages, not raw turns.

2. **Conversation/tool separation contract**
   - Old raw tool results do not remain in the base conversation window by default.

3. **Evidence-lane contract**
   - Recent tool evidence can still contribute to passive hydration.

4. **Relevance-floor contract**
   - Older conversational candidates below the floor are excluded.
   - Recalled evidence below the evidence floor is excluded.

5. **Budget contract**
   - Eligible older context is still dropped when the final budget is exhausted.

6. **Observability contract**
   - Exclusion reasons distinguish floor rejection from budget rejection.

Prefer targeted package-local tests in the existing assembler/recall test suites rather than new broad integration scaffolding.

## Likely Implementation Surfaces

Primary files likely touched by the implementation:

- `packages/coding-agent/src/context/assembler/message-transform.ts`
- `packages/coding-agent/src/context/recall/passive-hydration.ts`
- `packages/coding-agent/src/context/bridge/bridge.ts`
- `packages/coding-agent/src/context/recall/ingest.ts`
- `packages/coding-agent/src/sdk.ts`
- relevant settings schema and package-local tests

The implementation should prefer consolidating the current overlapping recency decisions into a single canonical policy rather than layering new heuristics on top of the existing ones.

## Acceptance Criteria

This design is successful when:

- the live prompt remains smaller and more focused during long sessions,
- old raw tool transcript no longer lingers in the base conversation window,
- older context enters only when it is relevant enough to justify the cost,
- the model can still recover needed evidence through passive hydration and tools,
- dogfooding shows less prompt ballooning without more user re-briefing.
