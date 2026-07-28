# feat: main-session agent persona selection (`--agent`, `/agent`, TUI picker)

## Why

Both Copilot and OpenCode support selecting a different agent definition as the main-session persona via `--agent {name}` and `/switch-agent {name}`. Oh My Pi claims feature parity with these tools and can already parse their agent definition files (`.omp/agents/*.md`), but had no way to *select* one as the main persona — the definitions were only usable as subagent task types.

This closes that gap: a discovered agent definition can become the main-session persona, with its system prompt appended to the default prompt, its tool list applied as a filter (not a restriction), and its model/thinking/spawns resolved through the same policy engine subagents use.

## What

- **`--agent <name>` CLI flag** — selects a persona at startup. Precedence: CLI flags for model/thinking/tools win over agent frontmatter.
- **`/agent` slash command** (alias `/switch-agent`) — live-switch mid-session. Opens a TUI picker on no args, direct switch with a name.
- **`AgentPersonaPickerComponent`** — bottom-anchored overlay with search, source badges, active-agent highlighting.
- **Persistence** — `agent_change` session entries written on startup (`--agent`) and live switch (`/agent`), re-resolved on resume.
- **Availability gating** — `mode: primary` / `mode: subagent` / Copilot aliases (`user-invocable`, `disable-model-invocation`). Subagent-only agents are hidden from the picker and rejected by CLI. Primary-only agents are hidden from task spawn lists.
- **Tool overlay** — `applyToolOverlay(toolNames)` on `AgentSession` with `restrictToolNames: false` (main personas never restrict — the tool list is a filter, not a cage).
- **Rollback** — `switchAgentPersona` snapshots tools/spawns/model/thinking before mutation and restores them on failure.

## Code reuse

The feature reuses existing subagent infrastructure rather than inventing new mechanisms:

| Mechanism | Source | How reused |
|---|---|---|
| Agent definition parsing | `discovery/helpers.ts` `parseAgentFields()` | Same parser, new `availability` field |
| Tool restriction | `AgentSession.applyToolOverlay()` | Same method, `restrictToolNames: false` |
| Spawns resolution | `task/agent-policy.ts` `resolveAgentSessionPolicy()` | Same function, absent spawns → `"*"` (main persona default) |
| Model resolution | `config/model-resolver.ts` `resolveModelOverride()` | Same pattern resolution from frontmatter patterns |
| System prompt appending | `sdk.ts` `rebuildSystemPrompt` `appendParts` chain | Agent body joins memory/auto-learn/MCP instructions — no new template |
| Session persistence | `session/session-entries.ts` `AgentChangeEntry` | New entry type, same `SessionManager.append*` pattern |
| Agent discovery | `task/discovery.ts` `discoverAgents()` | Same directory scan, same `.md` loading |
| Availability gating | `task/structured-subagent.ts` `resolveEffectiveSubagentPolicy` | Same `availability` field, same rejection logic |

## Files changed

- `packages/coding-agent/src/task/types.ts` — `AgentAvailability` type, `availability?` on `AgentDefinition`
- `packages/coding-agent/src/discovery/helpers.ts` — `parseAgentFields()` availability parsing
- `packages/coding-agent/src/task/agent-policy.ts` — `resolveAgentSessionPolicy()` main-persona defaults
- `packages/coding-agent/src/session/agent-session.ts` — `applyToolOverlay()`, `switchAgentPersona()`, `#getSessionSpawns`
- `packages/coding-agent/src/sdk.ts` — `CreateAgentSessionOptions.agentPersona`, mutable holders, startup persistence
- `packages/coding-agent/src/cli/args.ts` + `flag-tables.ts` + `main.ts` — `--agent` flag, `buildSessionOptions` resume path
- `packages/coding-agent/src/slash-commands/builtin-registry.ts` — `/agent` + `/switch-agent` commands
- `packages/coding-agent/src/modes/components/agent-persona-picker.ts` — TUI picker component
- `packages/coding-agent/src/modes/controllers/selector-controller.ts` — `showAgentPersonaSelector()`
- `packages/coding-agent/src/session/session-entries.ts` + `packages/agent/src/compaction/entries.ts` — `AgentChangeEntry`
- `packages/coding-agent/src/session/session-manager.ts` — `appendAgentChange()`
- `packages/coding-agent/src/session/session-context.ts` — `agentPersona` in `SessionContext`
- `packages/coding-agent/src/task/index.ts` — spawn list filters `availability !== "primary"`
- `packages/coding-agent/src/task/structured-subagent.ts` — `resolveEffectiveSubagentPolicy` rejects primary-only
- Various test files — 57 tests across 9 files
