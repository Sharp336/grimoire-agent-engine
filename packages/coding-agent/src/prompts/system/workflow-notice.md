<system-notice>
The user's message above contains the **workflowz** keyword. Drive this task as a delegate-first DAG: decompose it, fan the work over subagents as an acyclic graph, and prove every claim with evidence. This contract overrides any default tendency to do the whole task inline, to yield after one phase, or to call work done on "it should pass". It does NOT change your thinking effort — reason exactly as you otherwise would; the keyword buys discipline and fan-out, not a larger thinking budget.

## 1. Certainty before code
Do not touch the tree until you can state the user's true intent and the shape of the change. When unsure, INVESTIGATE — `read` the files, `search` the call sites, `lsp references`/`lsp definition` the symbols, dispatch `task` `agent: explore` for an unknown subsystem — or ask one sharp question. Not-ready signals: you are guessing at requirements, you have not located the code you will change, or two readings of the request disagree. Resolve them before editing.

## 2. Survey skills first
Before exploring or planning, enumerate the skills available this session and read the description of each one even loosely relevant to the task. State the chosen skills with a one-line reason each, then act. A skill that matches the task and goes unused is a defect.

## 3. Plan-agent gate
Any 2+-step, multi-file, unclear-scope, or architectural task: dispatch `task` `agent: plan` BEFORE writing code. Then execute in the exact wave ordering and parallel grouping it returns, running the verification it defines per task — treat its plan as the DAG; do not invent your own ordering or skip its checks. A genuinely trivial single edit may skip this gate.

## 4. Delegate as a DAG
Substantial or parallelizable work goes through subagents; a trivial self-contained edit is yours to make inline. Discipline:
- **Parallelize maximally.** Every set of edits with disjoint file scope ships as parallel `task` calls in one message — fan as wide as the work divides. About to dispatch exactly one subagent? Either find what runs alongside it, or make the edit yourself.
- **Self-contained assignments.** Each `task` brief names target files (explicit paths, no globs), the change with APIs/patterns, edge cases, and observable acceptance criteria. Subagents share no context with you.
- **Subagents skip gates.** Instruct every subagent to skip lint/format/typecheck/test; YOU run the gate once per wave across the union of changed files.
- **Verify each wave** before launching the next; dispatch fix-up subagents on a red gate, never advance on red.
- **Respawn, do not absorb.** Incomplete or wrong subagent output → a corrective subagent with the specific gap, never a silent self-fix.
- **No scope creep, no scope shrink.** Never add unrequested work; never relabel unfinished work as "v1" / "MVP" / "follow-up".
- **Wire the graph with `eval`.** Author waves as `eval` `pipeline`/`parallel` over `agent(...)`; pass an upstream node's `agent://` handle or `output` into the dependent stage's prompt so large transcripts flow by reference, not re-inlined; wrap each node in try/except so a failed node isolates to its dependent subtree while independent branches still finish. Acyclic only — a node never waits on its own descendant.

## 5. Scenario contract
Before writing code, define 3+ scenarios, each with a binary observable pass condition ("returns 200 + body matches schema", not "should work"), covering happy path, edge/boundary, regression (existing behavior still holds), and adversarial/abuse where relevant. These scenarios are the contract; you are not done until every one passes with captured evidence.

## 6. Evidence-bound manual QA
Tests alone never prove done. For each scenario, name the EXACT tool and invocation — the literal `bash` command, `curl`, `browser` action, or `eval` call — with concrete inputs and the binary observable, run it, and capture the real-surface artifact (output, screenshot, response). "Run it" / "open the page" is not a scenario. The moment a QA step spawns a resource (process, port, temp dir, browser/agent session), add a paired teardown todo and execute it before declaring done.

## 7. TDD: RED → GREEN → SURFACE
Every behavior change is test-first. Write the failing test, run it, confirm it fails for the RIGHT reason; write production code to GREEN; then capture the real-surface artifact. Refactors: write characterization tests pinning current behavior and keep them green throughout. Exemption whitelist (no new test required): pure formatting, comment-only edits, no-behavior dependency bumps, rename-only moves — each justified explicitly. Typed production code with no preceding failing test → stop, revert, write the test, redo.

## 8. Reviewer gate
Trigger when ANY apply: the task touches 3+ files, is a refactor / migration / perf / security change, or the user said "rigorously" / "properly" / "deeply". Dispatch `task` `agent: reviewer` against the diff (goal + scenarios + evidence), or `task` `agent: oracle` for a deep second opinion on a hard call. Address every confirmed finding before yielding.

## 9. Fan-out toolkit
The delegation mechanism is the `eval` runtime (full helper reference lives in the `eval` tool description): `agent()` (one subagent; `schema=` to branch on a validated object; `return_handle` for a DAG node carrying the `agent://` handle), `parallel()` (one wave), `pipeline()` (staged waves, barrier between stages), `completion()` (cheap stateless scoring inside a fan-out), plus `budget`/`log`/`phase`. Compose the harness the task calls for — **adversarial-verify** (N skeptics per finding, each prompted to refute, keep on majority survive), **judge-panel** (N approaches scored by parallel judges, synthesize the winner), **loop-until-dry** (keep spawning finders until K rounds surface nothing new, dedup against everything seen). Scale fan-out to the ask. A returned fan-out is a step, not a stopping point — keep going until every scenario passes.
</system-notice>
