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
   - Anchor model:
     - one `goalState` entry for current aim/plan state;
     - zero or more `constraintDecision` entries for independent unresolved user constraints or decisions.
   - Source of truth:
     1. if a structured session artifact exists, derive the baseline `goalState` from its latest aim/plan content;
     2. otherwise, synthesize `goalState` from the latest explicit user-authored task statement still in force;
     3. newer explicit user-authored constraints or decisions create or update `constraintDecision` entries;
     4. when a newer explicit user-authored statement contradicts the baseline, record it as a `constraintDecision` override and recompute the effective `goalState` before prompt emission.
   - Entry identity:
     - `goalState` always uses `topicKey = global`;
     - each `constraintDecision` entry carries a separate `topicKey` for the constrained subject plus a stable source reference;
     - only entries with the same `class` and `topicKey` replace one another; different `topicKey`s coexist;
     - if no stable `topicKey` can be derived confidently, do not create an anchored `constraintDecision` entry for that statement; leave it to the ordinary recent-conversation path instead of risking a duplicate or contradictory anchor.
   - Entry fields in the emitted `AnchorSummary`:
     - `goalState` is always present and carries the source reference used to derive it;
     - `constraintDecision` entries carry `status = active` and optional `overrides`, which points at the superseded baseline subject such as `goalState/global`;
     - the emitted `goalState.summaryText` is the effective merged state after applying all active overrides, so stale baseline text is never rendered in the prompt.
   - Lifetime rules:
     - a `constraintDecision` entry remains active until one of three events occurs: a newer entry with the same `topicKey` supersedes it, the user explicitly withdraws or resolves it, or the underlying artifact updates so the override is now reflected in `goalState`;
     - there is no silent time-based expiry for active `constraintDecision` entries.
   - Output format:
     - the selector emits a single aggregated `AnchorSummary` message containing one mandatory `goalState` entry plus zero or more whole bounded `constraintDecision` entries;
     - each entry is pre-summarized to a fixed max length before packing.
   - Overflow rule:
     - anchors have a target internal sub-budget inside the total assembly budget and reserve a minimum slice for `goalState`;
     - `goalState` may be compacted to a one-line minimal form but is never evicted;
     - active `constraintDecision` entries are also mandatory once created and may borrow budget from the recent-conversation window, older-conversation window, and recalled-evidence lane before any active constraint is dropped;
     - if the full active anchor set still cannot fit inside the total assembly budget after that borrowing, emit only the minimal `AnchorSummary` plus the current turn, drop all optional history/evidence lanes for that turn, and emit `anchor_budget_exhausted` telemetry.
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
- `ToolResultBridge` is the source of truth for selecting recent tool evidence for passive hydration.
- The bridge emits compact `ToolEvidenceRef` records containing:
  - a tool/result reference,
  - summary text suitable for embedding,
  - touched paths and symbols when available,
  - `mutation` and `unresolvedFailure` flags,
  - invalidation state.
- Horizon mapping and bounds:
  - each `ToolEvidenceRef` is attached to the assistant message that initiated its tool execution;
  - candidate refs are only those whose parent assistant message survives inside the retained recent-conversation window;
  - multiple tool executions under the same assistant message may each contribute one compact ref, but never more than one ref per execution;
  - apply a fixed internal cap of 4 recent refs, prioritized by `unresolvedFailure`, then `mutation`, then newest remaining refs;
  - allow one extra unresolved failure chain whose parent assistant message fell just outside the retained window if that chain is still active.

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
- Convert every conversational and recalled-evidence candidate to a canonical `normalizedRelevance` score on `[0, 1]`, where higher is more relevant.
- For both older conversational candidates and vector-search recall results, compute `normalizedRelevance` from raw embedding distance as `1 / (1 + distance)` before floor checks and observability reporting.
- Any additional lexical, path, or symbol heuristics may only break ties between candidates that already cleared the same floor; they do not alter `normalizedRelevance`.
- Use bridge-produced `ToolEvidenceRef` records plus recent conversation to construct the recall query; old raw `tool_result` transcript must not re-enter as an independent base-window input.
- Apply `assembler.relevanceFloor` to this canonical `normalizedRelevance` scale for older conversational candidates.
- Add an explicit recalled-evidence floor on the same `[0, 1]` scale, derived from `assembler.relevanceFloor` by a fixed internal uplift.

#### Injection

- Inject recalled evidence separately from the base conversation window.
- Treat recalled evidence as optional support, not as hidden continuation of the main transcript.
- Keep observability on what was recalled and why.

### 5. Configuration surface

Public settings after cutover:

- Remove `assembler.hotWindowTurns`, `assembler.messageBudgetPercent`, `assembler.hydrationBudgetPercent`, `assembler.safetyMarginPercent`, and `assembler.turnBufferPercent` from the public schema.
- Add `assembler.recentMessageCap` as the sole public recency knob for base conversation assembly.
- Add `assembler.relevanceFloor` as a canonical `normalizedRelevance` threshold on `[0, 1]` for admitting older conversational history.
- Old configs using removed keys should fail validation rather than silently aliasing to the new policy.

Keep the following internal unless dogfooding proves they must be tunable:

- total assembly safety margin,
- the internal budget split between base conversation and recalled evidence,
- the anchor sub-budget,
- the exact recalled-evidence uplift above `assembler.relevanceFloor`,
- reranking details.

This makes the settings surface match the design: users control the size and strictness of retained history, while the assembler owns the internal packing policy.

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

6. **Anchor identity and overflow contract**
   - Distinct `constraintDecision.topicKey` entries coexist without overwriting one another.
   - Only entries with the same `class` and `topicKey` replace one another.
   - When anchor pressure exceeds the target anchor sub-budget, active anchors borrow budget from optional history/evidence lanes before anything else is dropped.
   - If the active anchor set still cannot fit inside total assembly budget, the assembler emits only the minimal `AnchorSummary` plus the current turn for that request.

7. **Config cutover contract**
   - Removed assembler keys are rejected by schema validation.
   - `assembler.recentMessageCap` and `assembler.relevanceFloor` are accepted and flow through to assembly behavior.

8. **Observability contract**
   - Exclusion reasons distinguish floor rejection from budget rejection.
   - Anchor exhaustion emits `anchor_budget_exhausted` telemetry.

Prefer targeted package-local tests in the existing assembler/recall/config test suites rather than new broad integration scaffolding.

## Likely Implementation Surfaces

Primary files likely touched by the implementation:

- `packages/coding-agent/src/context/assembler/message-transform.ts`
- `packages/coding-agent/src/context/recall/passive-hydration.ts`
- `packages/coding-agent/src/context/bridge/bridge.ts`
- `packages/coding-agent/src/context/recall/ingest.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- package-local assembler, recall, and config validation tests

The implementation should prefer consolidating the current overlapping recency decisions into a single canonical policy rather than layering new heuristics on top of the existing ones.

## Dogfood Success Signals

Use these signals to validate the design before broader cutover:

- the number of transformed messages in the base conversation window plateaus around `assembler.recentMessageCap` instead of growing with session length,
- the number of old raw `tool_result` messages in the base conversation window outside the recent horizon is zero,
- recalled evidence injections become rarer and more selective, with below-floor candidates visibly rejected,
- across at least 3 dogfood sessions of 50+ turns, there is no increase in explicit user re-briefing or repeated rediscovery of already-resolved decisions.

## Acceptance Criteria

This design is successful when:

- the live prompt remains smaller and more focused during long sessions,
- old raw tool transcript no longer lingers in the base conversation window,
- older context enters only when it is relevant enough to justify the cost,
- the model can still recover needed evidence through passive hydration and tools,
- dogfooding shows less prompt ballooning without more user re-briefing.
