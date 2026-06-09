# Subagent View — Design & Implementation Plan

> Goal: view **any** subagent (any `task` item, any `workflowz`/eval `agent()` fan-out, any nested
> child) exactly the way the main harness agent is viewed — same transcript, same tool cards, same
> streaming — and navigate the whole tree.

## TL;DR

- **A v1 already ships.** It's the **"Session Observer"** (`app.session.observe` keybinding, ~Ctrl+S →
  `interactive-mode.ts:showSessionObserver()`). It already reads a subagent's session JSONL and renders a
  scrollable, expand/collapse transcript, and lets you cycle between sibling subagents.
- **The work is to *evolve* it, not build from scratch.** It falls short of "view any subagent like the
  main agent" in four concrete, fixable ways (below).
- **Command name:** use **`/observe`** (matches the existing "Session Observer" branding and the
  `app.session.observe` keybinding). `/agents` is already taken — it opens the *Agent Control Center*
  (`showAgentsDashboard()`), which manages agent **definitions**, a different thing. Alternatives if
  `/observe` is disliked: `/watch`, `/subagents`, `/trace`.

---

## What already exists today (the v1 "Session Observer")

Three pieces, all real and wired:

**1. `SessionObserverRegistry`** — `modes/session-observer-registry.ts`
A flat `Map<id, ObservableSession>` populated by subscribing to two event-bus channels:
```ts
interface ObservableSession {
  id: string
  kind: "main" | "subagent"
  label: string
  agent?: string
  description?: string
  status: "active" | "completed" | "failed" | "aborted"
  sessionFile?: string          // ← key for reading the transcript
  lastUpdate: number
  progress?: AgentProgress      // ← latest snapshot (tokens, cost, currentTool…)
}
```
It listens on `TASK_SUBAGENT_LIFECYCLE_CHANNEL` and `TASK_SUBAGENT_PROGRESS_CHANNEL` (see
`task/types.ts`). It feeds `statusLine.setSubagentCount(...)` so the active-subagent count already shows
in the footer. **It does *not* listen on `TASK_SUBAGENT_EVENT_CHANNEL`** (the full event stream), and it
has **no `parentId`** — it's a flat list, not a tree.

**2. `SessionObserverOverlayComponent`** — `modes/components/session-observer-overlay.ts` (852 lines)
The viewer. On open it jumps straight to the most-recently-active subagent and:
- Reads that subagent's `sessionFile` **incrementally** (`readFileIncremental` + `parseSessionEntries`),
  caching bytes read so live refreshes only parse the new tail.
- **Hand-rolls the transcript rendering** — its own `#buildTranscriptLines`, `#renderThinkingLines`,
  `#renderTextLines`, `#renderToolCallLines`, `#renderToolResultLines`, `#formatToolArgs`, with its own
  expand/collapse and truncation heuristics. It renders via `ScrollView` + `DynamicBorder` + `Markdown`.
- Keys: `j/k`/↑↓ select entry, `Enter` expand/collapse, `g/G` top/bottom, `PageUp/Down`,
  `[`/`]`/Tab/arrows cycle between sibling subagents, `Esc`/observe-key close.
- `refreshFromRegistry()` re-reads the tail and auto-scrolls if you were at the bottom (live tailing).

**3. Wiring** — `selector-controller.ts:1081 showSessionObserver()`, triggered from
`input-controller.ts:238` via `app.session.observe` (`config/keybindings.ts:169`). The registry is owned
by `InteractiveMode` (`#observerRegistry`), subscribed to the bus, reset on session switch.

So the v1 is: **"peek at the most-recent subagent's transcript, read-only, file-polled, cycle siblings."**

---

## Gap analysis: v1 vs. "view any subagent like the main agent"

| Dimension | v1 today | Target |
|---|---|---|
| **Render fidelity** | Hand-rolled, simplified lines. No streaming token-reveal, no real tool cards, no bash/python/eval execution components, no images. **Does not look like the main agent.** | Reuse the *exact* main-agent components (`AssistantMessageComponent`, `ToolExecutionComponent`, `BashExecutionComponent`, `EvalExecutionComponent`, `TranscriptContainer`). |
| **Hierarchy** | Flat list; `[`/`]` cycles all subagents as siblings. | Real tree: main → task → nested task → workflow phase → leaf. `AgentRegistry` **already has `parentId`** — it's just unused by the observer. |
| **Nested drill-down** | Stubbed: `#navigationStack` is *popped* (line 633) and *read* (line 258) but **never pushed** — you can't descend into a subagent's own children. | Enter on a `task`/`agent()` tool call descends into that child's transcript; breadcrumb tracks the chain. |
| **Picker** | None. Auto-jumps to most-recent; the file's own doc-comment claims a "picker mode" that isn't implemented. | A proper list+detail **browser** (mirror `SessionSelectorComponent`) with search and phase grouping. |
| **Live source** | File-polling on registry pings (latency tied to disk flush). | Same file read as *backlog seed* + optional live attach to `TASK_SUBAGENT_EVENT_CHANNEL` for main-grade liveness. |
| **Entry points** | Keybinding only. | `/observe` command + keybinding + **drill-in from the inline progress tree / task card** (the highest-value, most contextual entry). |

---

## The two facts that make the gap cheap to close

1. **There's already a unified agent tree — in a *different* registry.** `AgentRegistry.global()`
   (`registry/agent-registry.ts`) holds an `AgentRef` for *every* live agent — main and every subagent —
   with `id`, `displayName`, `kind: "main"|"sub"`, **`parentId`**, `status`, `session`, `sessionFile`,
   timestamps, and an `onChange` subscription. It's registered for all sessions at creation
   (`sdk.ts:1991`, with `parentId: options.parentTaskPrefix`). The tree the observer lacks already exists
   here — the two registries just aren't joined.

2. **A parent can already observe a subagent's *full* live event stream.** `executor.ts:912` emits
   **every** raw `AgentEvent` (message_start/update/end, tool_execution_start/update/end, thinking, …) on
   `TASK_SUBAGENT_EVENT_CHANNEL`. All three spawn paths funnel through the same `runSubprocess` with the
   same `eventBus` — the `task` tool **and** the eval/`workflowz` `agent()` bridge
   (`eval/agent-bridge.ts:282` passes `eventBus: options.session.eventBus`). **So workflow agents are not
   a separate system** — same `AgentRef`, same channels, same JSONL. One viewer covers all three. The v1
   only consumes LIFECYCLE+PROGRESS; the richer EVENT channel is available but unused.

And the main-agent rendering components are **data-driven and session-agnostic** — they render whatever
message objects you feed them, regardless of which session produced them.

The **one mandatory small change**: the `TASK_SUBAGENT_EVENT_CHANNEL` payload is
`{ index, agent, agentSource, task, assignment, event }` — **no stable agent `id`**. `index` is unique
only *within one batch*, so concurrent fan-outs cross-contaminate. Add `id` (and `sessionFile`) to the
payload (`executor.ts:913`; type in `task/types.ts`) — the executor already has both in scope.

---

## Target architecture (evolve the observer)

Four layers. Two of them already exist in skeleton form and get *extended*; two are *new but small*.

```
┌─ SubagentBrowser (NEW) ────┬─ TranscriptView (UPGRADE of overlay) ──────┐
│  tree · search · detail    │  breadcrumb · status · transcript          │
└────────────┬───────────────┴───────────────┬─────────────────────────────┘
             │ selects AgentNode              │ drives
   ┌─────────▼────────────────┐   ┌───────────▼───────────────┐
   │ AgentTreeProvider        │   │ TranscriptRenderer (NEW)   │ ← extracted from EventController
   │ = SessionObserverRegistry│   │ (TranscriptContainer +     │   so the view is byte-identical
   │   + AgentRegistry.parentId│  │  StreamingReveal + the     │   to the main agent's
   └─────────┬────────────────┘   │  real message components)  │
             │                     └───────────┬───────────────┘
   ┌─────────▼────────────────┐   ┌───────────▼───────────────┐
   │ AgentRegistry +          │   │ TranscriptSource (NEW)     │
   │ 3 event-bus channels     │◄──┤ Replay │ Live │ Hybrid     │
   └──────────────────────────┘   └────────────────────────────┘
```

### 1. `AgentTreeProvider` — extend the registry into a tree
Don't add a third registry. **Join the two that exist:** keep `SessionObserverRegistry` as the UI view-
model (it already has `sessionFile` + `progress` + live status), and enrich each `ObservableSession` with
`parentId` (and `phase`) read from `AgentRegistry.global()`. Add `getTree()` that returns roots →
children by `parentId`, plus disk fallback (parent artifacts dir → child `<id>.jsonl`) for completed
agents whose `AgentRef` has been unregistered. Caveat: `AgentRegistry.parentId` is currently
`options.parentTaskPrefix` (a dotted prefix), not the parent's `id` — canonicalize the edge so the tree
joins cleanly (see Gotchas).

### 2. `TranscriptSource` — where a transcript's events come from
A small interface so the renderer is agnostic to alive-vs-dead:
```ts
interface TranscriptSource {
  backlog(): AgentEvent[]                              // replayed from JSONL (the v1 already does this)
  subscribe(cb: (e: AgentEvent) => void): () => void   // live; no-op if completed
  meta(): { status; tokens; cost; model; durationMs }
}
```
- **ReplaySource** — completed agent: read `sessionFile`, synthesize `AgentEvent`s. *The v1's
  `readFileIncremental` + `parseSessionEntries` is already 80% of this.*
- **LiveSource** — running agent: subscribe to `TASK_SUBAGENT_EVENT_CHANNEL` filtered by `id` (needs the
  payload fix).
- **HybridSource** — the common case (open a fan-out mid-flight): seed `backlog()` from JSONL-so-far,
  then attach `LiveSource`, de-dup by sequence. Without this, attaching mid-run shows a transcript that
  starts at "now" with no history.

### 3. `TranscriptRenderer` — the real refactor (and the biggest fidelity win)
Today the render pipeline is welded to the main session: `EventController` writes into `ctx.chatContainer`,
owns the one `StreamingRevealController`, reads `InteractiveModeContext`. Extract a `TranscriptRenderer`
that owns *its own* `TranscriptContainer` + `StreamingRevealController` + message-component map, exposes
`feed(event)` / `seed(events)` / `getContainer()`, and has **zero** dependency on the editor/input/session
control. Then:
- The **main view** = `TranscriptRenderer` + input + session control (behaviorally identical — that's the
  regression surface).
- The **transcript view** = `TranscriptRenderer` + read-only chrome, fed by a `TranscriptSource`.

This is what makes a subagent *look exactly like the main agent* — it's the same renderer, and it
**replaces the overlay's hand-rolled `#buildTranscriptLines`/`#renderToolCallLines`/… entirely.**

### 4. The screens
- **`SubagentBrowser` (new)** — the missing picker. Mirror `SessionSelectorComponent`
  (`modes/components/session-selector.ts`): list+detail, fuzzy search, status icons; rendered as a tree
  grouped by parent (and `phase` for workflows).
- **`TranscriptView` (upgrade of `SessionObserverOverlayComponent`)** — keep its scroll/keymap/breadcrumb
  scaffolding; swap the body for a mounted `TranscriptRenderer`; wire the stubbed `#navigationStack` for
  real drill-down.

---

## UX design

**Entry points (meet the user where agents already surface):**
- **`/observe`** slash command → opens the browser (register in `slash-commands/builtin-registry.ts`).
- The existing **`app.session.observe`** keybinding → opens the browser (or, with the cursor on a row,
  the transcript directly).
- **Drill-in from where subagents already render** — the inline `task` tool card and the `workflowz`
  progress tree (`tools/eval-render.ts`). That tree already lists agents by id/phase with live status;
  make a row *selectable* → open that agent's transcript. **Highest-value entry point** because it's
  contextual: you watch `verify:foo ⟳` churn and press Enter to dive in.

**The browser (the missing picker):**
```
 Agents (3 running · 12 done)                    [/ search]
 ▸ Main                                    running   1.2M tok
   ├─ ⟳ review:bugs        phase:Review    running    340k  · Read src/auth.ts
   ├─ ✓ review:perf        phase:Review    done       210k
   └─ Review › Verify
      ├─ ⟳ verify:auth.ts                  running     45k  · grep "token"
      └─ ⏳ verify:db.ts                    pending
 ───────────────────────────────────────────────────────────
  review:bugs · code-reviewer · opus · 340k tok · $0.12 · 0:48
  "Review changed files for correctness bugs…"
  ↵ open transcript   ›/‹ expand   x stop   f follow
```
- Indent by `parentId`; workflow `phase` is an intermediate grouping node.
- Live rows: spinner + `currentTool`/`lastIntent` (already in `AgentProgress`). Done rows: ✓ + totals.
- Status icons reuse the session-picker vocabulary (✓ done · ⟳ running · ✗ failed · ⏳ pending · ⊘ aborted).

**The transcript view (the payoff — identical to main):**
```
 Main › Review › verify:auth.ts                      ⟳ running
 code-reviewer · opus · 45k ctx · $0.02 · 0:12        [f]ollow ●
 ─────────────────────────────────────────────────────────────
 ⏺ I'll check the token validation path first.
 ⏺ Read(src/auth.ts)
   ⎿ 1: import { verify } from "jsonwebtoken"  …
 ⏺ Grep("token", src/)  ⟳
 ─────────────────────────────────────────────────────────────
 ↑↓ scroll · ‹ back · u parent · ↵ descend · f follow-live · esc close
```
- **Same components, same streaming.** Because it's the same `TranscriptRenderer`: token-reveal, tool
  cards, thinking blocks, bash/python/eval execution all render exactly as the main loop. A completed
  agent shows the same thing, static.
- **Header = breadcrumb + live identity.** The breadcrumb (`Main › Review › verify:auth.ts`) is the chain
  of `parentId`s — the thing the v1 can't give you. The v1 already has a `#buildBreadcrumb` and
  `#navigationStack`; wire it to the tree.
- **Drill-down (wire the stub):** `Enter`/`›` on a `task` or `agent()` tool call whose child `sessionFile`
  is resolvable → `#navigationStack.push(...)` and load the child. `‹`/`u`/`Esc` pops back. This is the
  one-line-of-intent change that turns the dead `#navigationStack` into nested navigation.
- **"Follow live"** (`f`): auto-scroll to tail as events stream vs. free scroll to read history. Default
  ON for running, OFF for completed. (The v1's `#wasAtBottom` auto-tail is the seed of this.)
- **Navigation/focus:** moves via `TUI.setFocus`, restored on close — same pattern as every selector.

**Principles:**
- **Read-only and non-destructive.** Opening a view never touches the main loop; it overlays a still-
  running session. (Future: an "interject/steer" affordance is feasible since `AgentRef.session` is live,
  but it's a separate feature with real safety questions — out of v1.)
- **Lazy.** Only the open transcript holds a mounted `TranscriptRenderer`; the browser holds the
  lightweight tree. Closing disposes the renderer and unsubscribes. Don't keep N renderers alive.
- **One vocabulary.** Same status icons, tool-card rendering, and breadcrumb style everywhere agents
  appear (browser, progress tree, transcript header) so it reads as one feature.

---

## Implementation plan (phased, mapped onto existing files)

**Phase 0 — payload fix + tree join (no new UI).**
- Add `id` + `sessionFile` to the `TASK_SUBAGENT_EVENT_CHANNEL` payload (`executor.ts:913`, `task/types.ts`).
- Teach `SessionObserverRegistry` to carry `parentId`/`phase` (join from `AgentRegistry.global()`), and add
  `getTree()`. Unit-test the tree. *Ships nothing user-facing; de-risks correlation + hierarchy.*

**Phase 1 — extract `TranscriptRenderer`.**
Pull container/reveal/component-lifecycle out of `EventController` into a standalone renderer; refactor the
main view to consume it. **Regression-sensitive** — gate behind "main view renders byte-identically"
(snapshot before/after). Reconcile the one type seam: `AgentEvent` (bus) vs. the `AgentSessionEvent` the
controller consumes today — pick `AgentEvent` as the renderer input, adapt the main path once.

**Phase 2 — swap the overlay body + add sources.**
Implement Replay/Live/Hybrid `TranscriptSource` (ReplaySource largely reuses the v1's incremental reader).
Replace `SessionObserverOverlayComponent`'s hand-rolled `#build*`/`#render*` methods with a mounted
`TranscriptRenderer` fed by a source. Keep its scroll/keymap/header scaffolding. **At this point the
existing keybinding already opens a main-grade transcript.**

**Phase 3 — browser + drill-down + entry points.**
Build `SubagentBrowser` (clone `SessionSelectorComponent`) over `getTree()`. Wire the stubbed
`#navigationStack` for nested descent. Register `/observe`. Make rows in `eval-render` / the `task` card
selectable → open the transcript view.

**Phase 4 — live polish.**
Follow-live toggle, phase grouping, status transitions, `x` to stop a running agent (you hold
`AgentRef.session`), seamless handoff when an agent completes while you're watching (LiveSource →
ReplaySource).

---

## Gotchas

- **Two registries to reconcile.** `AgentRegistry` (IRC routing; has `parentId`+`sessionFile`) vs.
  `SessionObserverRegistry` (observer UI; has `progress`+`sessionFile`, flat). Don't add a third — join
  these. Canonicalize the parent edge: `AgentRegistry.parentId` is `options.parentTaskPrefix` (dotted
  prefix), not the parent's `id`; map prefix→id when building the tree.
- **Event correlation is mandatory (Phase 0).** Without an `id` on the EVENT payload, concurrent fan-outs
  cross-contaminate. Everything live downstream assumes it.
- **Render divergence is the real fidelity bug.** The v1 *looks* like a transcript but isn't the main
  renderer; users will notice it diverges (no streaming, different tool formatting). The
  `EventController → TranscriptRenderer` extraction is the only risky refactor but it's what closes this —
  snapshot-test the main view around it.
- **Late attach is the normal case.** Users open mid-flight → HybridSource (seed-from-disk + attach-live,
  de-dup) is not optional polish.
- **Drill-down is one wiring change away.** `#navigationStack` already exists and is popped/read but never
  pushed; wiring the push on Enter-into-child is most of the nested-navigation work.
- **Don't conflate the ids.** `AgentRef.id`, the `task` item `id`, and the output-manager `agent://<id>`
  are related but distinct; canonicalize on the registry `id`.
- **`/agents` is taken** (Agent Control Center, agent *definitions*). Use `/observe`.
```
