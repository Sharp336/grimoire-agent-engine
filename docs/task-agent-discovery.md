# Task Agent Discovery and Selection

This document describes how the task subsystem discovers agent definitions, merges multiple sources, and resolves a requested agent at execution time.

It covers runtime behavior as implemented today, including precedence, invalid-definition handling, and spawn/depth constraints that can make an agent effectively unavailable.

## Implementation files

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/structured-subagent.ts`](../packages/coding-agent/src/task/structured-subagent.ts)
- [`src/task/spawn-policy.ts`](../packages/coding-agent/src/task/spawn-policy.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/task.md`](../packages/coding-agent/src/prompts/agents/task.md)
- [`src/prompts/tools/task.md`](../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/discovery/omp-extension-roots.ts`](../packages/coding-agent/src/discovery/omp-extension-roots.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

## Agent definition shape

Task agents normalize into `AgentDefinition` (`src/task/types.ts`):

- required `name`, `description`, and `systemPrompt`
- optional `tools`, `spawns`, prioritized `model` list, `thinkingLevel`, `output`, `blocking`, `autoloadSkills`, `readSummarize`, `prewalk`, `advisor`
- `source`: `"bundled" | "user" | "project"` (extension agents are tagged with their extension root's project/user level)
- optional `filePath`

Parsing comes from frontmatter via `parseAgentFields()` (`src/discovery/helpers.ts`):

- missing `name` or `description` => invalid (`null`), caller treats as parse failure
- `tools` accepts CSV or array; if provided, `yield` is auto-added
- `spawns` accepts `*`, CSV, or array
- backward-compat behavior: if `spawns` missing but `tools` includes `task`, `spawns` becomes `*`
- `output` is passed through as opaque schema data
- `read-summarize: false` (normalized to `readSummarize`) forces the subagent's `read` tool to return verbatim file content instead of structural summaries — `runSubprocess` applies it as a `read.summarize.enabled: false` override on the subagent's isolated settings (`src/task/executor.ts`). `scout` and `librarian` ship with it disabled. Defaults to enabled when the field is absent.
- `model` accepts one selector, CSV, or an array. Entries are tried in order after role aliases are expanded.
- `thinking-level` / `thinking` selects the agent's configured effort. When `task.enableEffort` (default `false`) exposes it, a task item's coarse `effort` (`lo`, `med`, `hi`) takes precedence at launch. OMP maps that hint to the selected model's lowest, middle, or highest supported effort, then clamps it to `task.maxEffort` (default `max`). The ceiling is carried across retry-fallback model switches. If the selected model has no supported effort at or below the ceiling, the spawn fails; models without a controllable effort surface instead fall back to their normal selector.
- `blocking: true` makes the parent wait for that agent even when async task execution is enabled
- `autoloadSkills` names skills from the parent session to inject before the first child prompt; unknown names are ignored
- `prewalk: true` starts the subagent on its resolved model and hands off to the default prewalk target (the `smol` role) at its first edit/write, exactly like the session-level `--prewalk`; a string value (e.g. `prewalk: "@smol"` or `prewalk: "openai/gpt-5-mini"`) picks a custom target. The `task.agentPrewalk` settings record (agent name → `"on"` / `"off"` / pattern, configured per agent from the `/agents` hub via its prewalk strip) overrides the frontmatter. Resolution happens in `runSubprocess` (`src/task/executor.ts`). An unavailable target is skipped instead of failing the spawn. A resolved target is skipped only when both its model identity and its effective thinking mode/level match the starting selection after model clamping; a same-model effort downgrade is a real hand-off and still arms and switches at the first edit/write.
- `advisor: true` pairs spawned sessions of the agent with an advisor running the model resolved for the `advisor` role; a string value (e.g. `advisor: "deepseek/deepseek-v4-flash"` or `advisor: "@smol:high"`) sets an explicit advisor model pattern (optional `:level` suffix), applied as the spawned session's `modelRoles.advisor`. The `task.agentAdvisor` settings record (agent name → `"on"` / `"off"` / pattern, configured per agent from the `/agents` hub via its advisor strip) overrides the frontmatter. Resolution happens in `runSubprocess` (`src/task/executor.ts`); subagents default to no advisor, and the effective opt-in is persisted in `session_init` so cold revival restores it.

## Role-backed custom agents

OMP discovers user agents from `~/.omp/agent/agents/*.md` and project agents from `.omp/agents/*.md`.

Give the agent a role alias in frontmatter, then dispatch it by name. For model routing, task dispatch sets only `agent`; it does not set a worker model:

`~/.omp/agent/agents/reviewer.md`:

```md
---
name: reviewer
description: Review a change for correctness.
model: "@review"
---

Review the assigned change and report concrete findings.
```

Set the role mapping in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  review: openai/gpt-5.4:high
```

`@review` resolves through `modelRoles.review`. Each `modelRoles.<role>` value stores a concrete model selector and may append a thinking suffix such as `:high` (`src/config/model-resolver.ts`). Changing that mapping affects subsequent task resolutions without editing agent definitions.

For a dispatch, set the agent name and task:

```json
{
  "context": "Review the current change in this repository.",
  "tasks": [
    { "agent": "reviewer", "task": "Report concrete correctness findings." }
  ]
}
```

`/model`'s Roles view can assign and persist custom role mappings such as `review`, `fast`, and `good`. Changing only the active or default session selection does not remap those roles.

## Watch running agents

After dispatch, press `Alt+A` to open [Agent Hub](./agent-hub.md). Its live roster shows each task agent's status, current activity, model, age, and usage. Select an agent to read its transcript and steer it directly; parked agents can be revived from the same view.

### `vibe_spawn` tier routing

`vibe_spawn` maps `fast` to bundled `sonic` and `good` to bundled `task`. Both resolve through `task.agentModelOverrides` before their bundled agent model defaults (`src/vibe/runtime.ts`, `src/task/agents.ts`).

Route these tiers through roles by keeping aliases in `task.agentModelOverrides` and concrete selectors only in `modelRoles`:

```yaml
task:
  agentModelOverrides:
    sonic: "@fast_worker"
    task: "@good_worker"
modelRoles:
  fast_worker: openai/gpt-5-mini
  good_worker: openai/gpt-5.4:high
```

The `vibe_spawn` `cli` remains `fast` or `good`; update `modelRoles` to change the worker model.

## Bundled agents

Bundled agents are embedded at build time (`src/task/agents.ts`) using text imports.

`EMBEDDED_AGENT_DEFS` defines:

- `scout`, `designer`, `reviewer`, `security-reviewer`, and `librarian` from prompt files
- `task` and `sonic` from the shared `task.md` body plus injected frontmatter; no bundled agent sets `prewalk` — the generic `task` agent's hand-off is armed by the `task.prewalk` setting (default off), or per agent via `/agents` / `task.agentPrewalk` / user agent frontmatter

Loading path:

1. `loadBundledAgents()` parses embedded markdown with `parseAgent(..., "bundled", "fatal")`
2. results are cached in-memory (`bundledAgentsCache`)
3. `clearBundledAgentsCache()` is test-only cache reset

Because bundled parsing uses `level: "fatal"`, malformed bundled frontmatter throws and can fail discovery entirely.

## Filesystem and plugin discovery

`discoverAgents(cwd, home)` (`src/task/discovery.ts`) merges agents from OMP-native roots, OMP extension packages, and Claude marketplace plugin roots before appending bundled definitions. Direct cross-harness roots such as `.claude/agents`, `.codex/agents`, and `.gemini/agents` are intentionally skipped — their frontmatter schema is not the OMP task-agent contract (`TASK_AGENT_CONFIG_SOURCE = ".omp"` filters the native config-dir lists).

### Discovery inputs and precedence

1. Nearest project `.omp/agents` dir from `findAllNearestProjectConfigDirs("agents", cwd)` (first `.omp` hit only)
2. User `.omp/agents` dir from `getConfigDirs("agents", { project: false })` (first `.omp` hit only)
3. `<extension-root>/agents` for every enabled OMP extension package returned by `listOmpExtensionRoots(...)`, in this order:
   - CLI `--extension` roots
   - project `extensions:` settings
   - user `extensions:` settings
   - installed npm/link plugins
4. Claude marketplace plugin roots (`listClaudePluginRoots(home, cwd)`) with `agents/` subdirs — only when `isProviderEnabled("claude-plugins")`; project-scope plugins sort before user-scope
5. Bundled agents (`loadBundledAgents()`)

The OMP extension-package surface is disabled when the `omp-plugins` capability provider is disabled. Marketplace roots are excluded from `listOmpExtensionRoots` and enter only through the separately gated Claude-plugin path.

## Merge and collision rules

Discovery uses first-wins dedup by exact `agent.name`:

- A `Set<string>` tracks seen names.
- Loaded agents are flattened in directory order and kept only if name unseen.
- Bundled agents are filtered against the same set and only added if still unseen.

Implications:

- Project `.omp` overrides user `.omp`.
- Earlier extension roots override later extension roots, Claude marketplace plugins, and bundled agents.
- Non-bundled agents override bundled agents with the same name.
- Name matching is case-sensitive (`Task` and `task` are distinct).
- Within one directory, markdown files are read in lexicographic filename order before dedup.

## Invalid/missing agent file behavior

Per directory (`loadAgentsFromDir`):

- unreadable/missing directory: treated as empty (`readdir(...).catch(() => [])`)
- file read or parse failure: warning logged, file skipped
- parse path uses `parseAgent(..., level: "warn")`

Frontmatter failure behavior comes from `parseFrontmatter`:

- parse error at `warn` level logs warning
- parser falls back to a simple `key: value` line parser
- if required fields are still missing, `parseAgentFields` fails, then `AgentParsingError` is thrown and caught by caller (file skipped)

Net effect: one bad custom agent file does not abort discovery of other files.

## Agent lookup and selection

Lookup is exact-name linear search:

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`
- unrestricted sessions default an omitted `agent` field to `task`
- a restricted parent `spawns` list defaults an omitted `agent` field to the first listed agent

`resolveEffectiveSubagentPolicy()` is shared by task and eval-backed subagent launches. Before allocating artifacts it:

1. resolves the omitted or explicit agent name from the parent spawn policy
2. enforces depth, blocked-self-recursion, and parent spawn-policy guards
3. rediscovers agents with `discoverAgents(session.cwd)` and performs exact lookup
4. checks `task.disabledAgents`
5. resolves plan-mode restrictions, output schema, model policy, and isolation policy

A missing name fails preflight with `Unknown agent "...". Available: ...`; no subprocess runs.

### Description vs execution-time discovery

`TaskTool.create()` memoizes discovery per resolved working directory when building the model-facing tool description. Execution rediscovers agents, so the runtime set can differ from the earlier description if agent or extension files changed mid-session. Blocking behavior is determined after policy resolution rather than from a stale description-time agent object.

## Model and structured-output precedence (including dynamic worker routing)

For task dispatch, the authoritative routing precedence is:

1. **Explicit per-invocation model pin** (`request.model` from the eval/agent bridge, e.g. `agent("scout", model="…")`) — router **bypassed entirely**.
2. **Per-spawn routing constraints** from the task call — `intent` on the item and `routing: { excludePools, preferPools, allowParentPool }` on the batch.
3. **Sticky session routing policy** — the same constraints persisted for the session via runtime `settings.override` when `routing.sticky` is used. Never a global/persisted config write.
4. **Dynamic router defaults** — `task.routing.*` settings (`enabled`, `avoidParentPool`, `parentPoolFallback`, `excludePools`, `preferPools`, `agentIntents`, `workerModels`) plus the `task.agentModelOverrides` *preference* and candidate scoring described below.
5. **Existing auth/retry fallback recovery** — unchanged, runs last (including `retry.usageAwareFallback`).

`task.agentModelOverrides[agent]` is an **agent default, not a hard pin**: it enters routing as a preference (`preferredRank = 0` for the matching candidate in `buildRoutingSnapshot`) so ordinary capabilities stay dynamically routable across pools. When the router is bypassed by an explicit per-invocation pin (case 1), that is recorded as `routingBypassReason`. If the pinned model lands in the parent pool despite `avoidParentPool`, it is reported as an intentional anti-affinity override (`routingParentPoolFallback` / parent-pool fallback exception).

Role aliases in pinned selectors are still expanded through `modelRoles`; the shared eval bridge's invocation-local `model` sits ahead of `task.agentModelOverrides`. The task wire schema does not expose a separate `model` field — per-item `intent` and batch-level `routing` are the model-facing surface.
Runtime output schema precedence is unchanged:

1. the task item's explicit `outputSchema`
2. agent frontmatter `output`
3. parent session `outputSchema`

The task item's optional `schemaMode` overrides the parent session mode; the default is `permissive`.

The model-facing prompt (`src/prompts/tools/task.md`) tags read-only agents and warns against offloading reasoning to `scout`/`sonic`.

### Dynamic worker routing

#### Routing intent

Per item `intent` (`src/task/routing/types.ts: RoutingIntent`):

```
"default" | "cheap" | "normal" | "strong" | "vision" | "large-context" | "same-pool-ok"
```

`agentIntents` in settings maps agent name → intent; the per-item field overrides it. `same-pool-ok` explicitly permits the parent pool; every other intent is subject to anti-affinity when `avoidParentPool` is true.

#### Candidate eligibility (`src/task/routing/snapshot.ts: buildRoutingSnapshot`)

Candidates are not the whole catalog. `buildRoutingSnapshot` starts from `modelRegistry.getAvailable()` filtered by `hasConfiguredAuth`, then keeps only models matching **intentional worker sources**: the explicit roster `task.routing.workerModels` and any concrete provider-qualified selector (`provider/model`) configured in `modelRoles` or `task.agentModelOverrides`. Bare aliases like `flash`, `mini`, `pro`, `haiku`, `codex` are **never** globally eligible — they would admit stale catalog models such as the former `google/gemini-1.5-flash` (404). When no intentional roster is configured, the fallback is the curated concrete priority roster (only provider-qualified selectors from `priority.json`: `slow`/`designer`/`smol` filtered to contain `/`), never bare aliases. Position in that combined list becomes the candidate's `preferredRank` (roster entries intentionally rank first), so OMP's existing quality ordering carries into scoring. Usage health comes from cached/last-good reports only — building a snapshot performs no network fetch and no credential refresh.

#### Hard-filter order (`src/task/routing/candidates.ts: filterRoutingCandidates`)

Applied in order; first-match removals are final for that candidate:

1. `usage === "depleted"` — removed.
2. **Dead routes** (`deadSelectors` from observed `404 / not found / invalid model / deprecated` launch failures this run) — exact selector match (provider-qualified or bare id suffix) removed. Bounded to 20 per `TaskTool` instance, so a known-dead route is not immediately retried by a sibling. Reuses the same hard-filter path as depleted/exclusions.
3. **Exclusion patterns** (`task.routing.excludePools` + effective per-spawn/session `excludePools`) — removed. **Always enforced, never relaxed**, even to satisfy anti-affinity recovery.
4. **Requirement filters** from `RoutingRequirements`: `vision` requires `candidate.vision`, `minContextWindow` requires `candidate.contextWindow !== null && >= min`, `structuredOutput` requires `candidate.supportsTools`.
5. **Intent-implied requirements**: `intent === "vision"` implies `vision`; `intent === "large-context"` implies `minContextWindow` of at least 200_000 unless the request specifies a larger minimum; `intent === "strong"` removes non-`reasoning` candidates whenever at least one `reasoning` candidate survives — a capability floor, so no combination of cheapness/headroom/preference bonuses can downgrade a strong task.
6. **Parent-pool anti-affinity** — when `policy.avoidParentPool && intent !== "same-pool-ok"` and `parentPool` is set, drop parent-pool candidates **only if** at least one non-parent candidate survives steps 1–5. Otherwise this step is skipped (so the failure mode is handled by step 7, not by silent elimination).
7. **Fail-closed guard** — if the viable set after steps 1–6 contains only parent-pool candidates and `policy.parentPoolFallback === "deny"`, the selector returns `parent_pool_fail_closed` instead of choosing one.
`RoutingUsageState: "healthy" | "reserve" | "depleted" | "unknown"`. `unknown` is **never hard-filtered** and never bypasses dead/exclusion/anti-affinity hard filters (steps 2, 3 and 6).

#### Scoring summary (`src/task/routing/select.ts: scoreRoutingCandidate`)

Additive, small/understandable; higher wins:

- **Usage:** `healthy` +30, `unknown` +10, `reserve` −40. Unknown ranks **below healthy and above reserve** — it is never treated as unlimited headroom.
- **Pool preference:** `preferPools` match +25.
- **Sibling diversity:** pool key already in `siblingPools` (in-flight siblings) → −30 — outweighs `preferredRank` (+8) and `unknown→healthy` (+20) so a healthy alternative pool beats a preferred repeat, but not a depleted/reserve one (handled by hard filters).
- **Intent fit:** `cheap` adds `40 / (1 + costPerMTokenTotal)` and `normal`/`default` add `10 / (1 + costPerMTokenTotal)`, so a materially cheaper candidate wins outright rather than landing inside the tie-break band; `strong` is enforced as a hard capability floor (step 4 above) and additionally rewards `reasoning`; `vision`/`large-context` are neutral (already hard-filtered).
- **`preferredRank`** (the agent's configured default model; 0 = highest) contributes a small bonus so existing configuration still wins among otherwise-equal candidates, but it **must not** override usage/exclusion/anti-affinity outcomes.
- **Bounded tie-break:** candidates within 5 points of the top score are shuffled via `request.random ?? Math.random`; `random: () => 0` makes the result fully deterministic (first of the band) and is used by tests. Task dispatch supplies `seededRandom(agent + assignment)` so the batch-preflight and dispatch resolutions of the same spawn pick the same candidate.

`routeWorker` (`src/task/routing/router.ts`) returns `policy.enabled === false` → `{ ok:false, code:"routing_disabled" }`, empty viable set → `no_viable_candidate`, otherwise a `RoutingDecision` whose `selectors` are **all** viable candidates sorted best-first and deduped by selector. The `reason` is one concise UI line like `` `cursor/composer-2.5 (cursor pool; parent pool anthropic excluded; headroom healthy)` ``; `trace` is verbose debug/log only.

#### Unknown-usage rule

`unknown` is viable but **ranks below `healthy` and above `reserve`** (`healthy +30 > unknown +10 > reserve −40`). It is never treated as unlimited headroom and never bypasses hard exclusions or parent-pool anti-affinity. The router's `usageInfluenced` flag is set when a `reserve`/`depleted`/`unknown` signal changes which candidate is chosen.

#### Bounded contract-failure reroute

Routing treats the agent's required execution/output contract as a hard compatibility constraint (tool support, vision, context, structured output). Beyond hard filtering, when a child launches but fails its **structured-output contract** before returning useful work (the mandatory regression is Composer 2.5 + `scout`: `` `schema_violation: (root): expected object, received string` ``), that route is classified distinctly from ordinary task failure and the router automatically retries the next eligible external-pool candidate.

- Reroutes are bounded by `task.routing.maxContractReroutes` (default `1`) and the existing task/retry limits — never an unbounded loop.
- The failed pool is never re-selected for the same requirement without evidence of compatibility.
- The failure, replacement route, and reason are surfaced concisely in `routingReroutes` / `routingReason`; verbose traces stay in logs. The parent receives the final useful result or a clear bounded failure without needing to probe models or inspect raw transcripts.

## Command discovery interaction

`src/task/commands.ts` is parallel infrastructure for workflow commands (not agent definitions), but it follows the same overall pattern:

- discover from capability providers first
- deduplicate by name with first-wins
- append bundled commands if still unseen
- exact-name lookup via `getCommand`

In `src/task/index.ts`, command helpers are re-exported with agent discovery helpers. Agent discovery itself does not depend on command discovery at runtime.

## Availability constraints beyond discovery

An agent can be discoverable but still unavailable to run because of execution guardrails.

### Disabled-agent settings

`resolveEffectiveSubagentPolicy()` checks `task.disabledAgents` after resolving the agent. A disabled name fails preflight and lists enabled alternatives when available.

### Parent spawn policy

The resolver checks `session.getSessionSpawns()`:

- `"*"` (also `true`, `null`, or absent) => allow any; omitted `agent` defaults to `task`
- `""` or `false` => deny all
- CSV list => allow only listed names; omitted `agent` defaults to its first name

If denied: `Cannot spawn '...'. Allowed: ...`.

### Blocked self-recursion env guard

`PI_BLOCKED_AGENT` (or the internal request override) rejects an attempt to spawn the same blocked agent before discovery.

### Recursion-depth gating

`task.maxRecursionDepth` defaults to `2`; a negative value disables the cap. The shared policy rejects a spawn when the current task depth has already reached the cap. When a child reaches the cap, `runSubprocess` also removes `task` from its tool list and sets its spawn policy empty.

For a restricted agent tool list, `runSubprocess` auto-adds `task` when `spawns` is declared and depth permits it. It also retains the host's `hub` collaboration tool unless the session is explicitly restricting tool names.

## Plan mode behavior

When parent plan mode is enabled, `resolveEffectiveSubagentPolicy()` builds an `effectiveAgent` before launching subprocesses:

- prepends the plan-mode subagent system prompt
- restricts tools to `read`, `grep`, `glob`, and `web_search`, plus `ast_grep` when the agent's own tool list declares it
- clears child spawns
- clears `prewalk` (read-only exploration must not receive the prewalk plan/implement nudges)

Plan mode also rejects per-spawn isolation, apply, and merge controls. The same `effectiveAgent` is used for subprocess launch, model/thinking overrides, and output-schema selection.
