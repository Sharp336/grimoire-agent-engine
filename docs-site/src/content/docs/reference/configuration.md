---
title: Configuration Reference
description: Every omp setting key, with its type, default, and allowed values.
coverage: A
---

This page is the exhaustive catalog of settings defined by the `omp` settings schema. Each key, its type, its default, and the values it accepts come directly from the schema. For the user-facing guide — where settings live, how the layers merge, `omp config` workflow, profiles, path-scoped arrays, and legacy migration — see [Settings](/configuration/settings/).

The catalog is generated from the same schema `omp config list` reads. If a key is missing here, run `omp config list` to confirm it exists; keys must match a schema path exactly, with no shorthand. Defaults and enum values are taken from the schema; environment-variable and CLI-flag overrides are process-local and never persisted.

## Models

`modelRoles`, `modelTags`, and `cycleOrder` work together to define the models you can switch between. Role values may carry a thinking suffix (`:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`).

| Key | Type | Default | Description |
|---|---|---|---|
| `modelRoles` | record | `{}` | Map of role name to model id. Built-in roles: `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor`. The `tiny` role overrides the online model for lightweight background tasks (titles, memory, auto-thinking, unexpected-stop), else `@smol`. Per-role env/flags exist only for `--model`/`--smol`/`--slow`/`--plan`; configure the advisor with `modelRoles.advisor`. |
| `modelTags` | record | `{}` | Custom role/tag metadata; can introduce additional roles. |
| `modelProviderOrder` | array | `[]` | Preferred provider order when a model id is ambiguous. |
| `cycleOrder` | array | `["smol","default","slow"]` | Roles cycled by the model switcher. |
| `enabledModels` | array | `[]` | Allow-list of models; supports [path-scoped entries](/configuration/settings/#path-scoped-arrays). Empty means all available models. |
| `disabledProviders` | array | `[]` | Disabled model/discovery providers; supports path-scoped entries. See [Provider and source disabling](/configuration/settings/#provider-and-source-disabling). |
| `includeModelInPrompt` | boolean | `true` | Include the active model name in the system prompt. |

## Advisor

The advisor is a second model that reviews each completed turn and can inject advice into the primary session. Assign a model with `modelRoles.advisor`, then enable it with `advisor.enabled`, `/advisor on`, or by launching with the `--advisor` flag. See [Advisor](/features/advisor/) for runtime behavior, `WATCHDOG.md` discovery, and bounded catch-up semantics.

| Key | Type | Default | Description |
|---|---|---|---|
| `advisor.enabled` | boolean | `false` | Enable the advisor runtime when `modelRoles.advisor` resolves to an available model. |
| `advisor.subagents` | boolean | `false` | Also enable advisor runtimes for spawned task/eval subagents. |
| `advisor.syncBacklog` | enum | `off` | Bounded advisor catch-up delay: `off`, `1`, `3`, or `5`. The primary waits up to 30 seconds only while advisor backlog is at or above the threshold. |
| `advisor.immuneTurns` | number | `3` | After a `concern`/`blocker` interrupts, route further concerns/blockers as non-interrupting asides for this many completed primary turns. |

## Thinking

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultThinkingLevel` | enum | `high` | One of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`. Override per run with `--thinking`. |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output. `--hide-thinking` sets it for the run (display only). |
| `thinkingBudgets.minimal` | number | `1024` | Token budget for the `minimal` level. |
| `thinkingBudgets.low` | number | `2048` | Token budget for `low`. |
| `thinkingBudgets.medium` | number | `8192` | Token budget for `medium`. |
| `thinkingBudgets.high` | number | `16384` | Token budget for `high`. |
| `thinkingBudgets.xhigh` | number | `32768` | Token budget for `xhigh`. |
| `thinkingBudgets.max` | number | `32768` | Token budget for `max`. |
| `providers.autoThinkingMaxEffort` | enum | `xhigh` | Highest effort `defaultThinkingLevel: auto` may resolve. `xhigh` keeps the classifier one tier below the top, so only `ultrathink` reaches `max`; `max` lets the classifier bill the top tier on models that expose it. The local on-device classifier stays capped at `xhigh` either way. This governs what `auto` *resolves*: a model whose ladder offers nothing under the ceiling gets no auto level at all, and one that also sets `thinking.requiresEffort` still receives its lowest supported effort from the transport — on a `["max"]` ladder that is `max`, because the model accepts nothing else. |

## Sampling

A value of `-1` means "use the provider/model default" — `omp` does not send that parameter.

| Key | Type | Default | Description |
|---|---|---|---|
| `temperature` | number | `-1` | Sampling temperature. |
| `topP` | number | `-1` | Nucleus sampling. |
| `topK` | number | `-1` | Top-K sampling. |
| `minP` | number | `-1` | Minimum-probability cutoff. |
| `presencePenalty` | number | `-1` | Presence penalty. |
| `repetitionPenalty` | number | `-1` | Repetition penalty. |
| `tier.openai` | enum | `none` | One of `none`, `auto`, `default`, `flex`, `scale`, `priority`. Sent as `service_tier` for OpenAI / OpenAI-Codex and OpenAI-family OpenRouter models. |
| `tier.anthropic` | enum | `none` | One of `none`, `priority`. `priority` realizes fast mode on supported direct Claude models (ignored on Bedrock/Vertex and via OpenRouter). |
| `tier.google` | enum | `none` | One of `none`, `flex`, `priority`. Gemini API sends it in the body; Vertex sends `priority` via header (`flex` is a no-op on Vertex). |
| `tier.subagent` | enum | `inherit` | One of `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`. Applied to the spawned model's family; `inherit` tracks the main agent. |
| `tier.advisor` | enum | `none` | One of `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`. Applied to the advisor model's family. |
| `personality` | enum | `default` | One of `default`, `friendly`, `pragmatic`, `none`. |

## Retry and fallback

```yaml
retry:
  enabled: true
  maxRetries: 10
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    default:
      - anthropic/claude-opus-4-5
      - openai/gpt-5.5
      - google/gemini-3-pro
    smol:
      - openai/gpt-5.5-mini
      - anthropic/claude-haiku-4-5
    google/gemini-3-pro:
      - google-vertex/gemini-3-pro
    google-antigravity/*:
      - google/*
      - google-vertex/*
```

| Key | Type | Default | Description |
|---|---|---|---|
| `retry.enabled` | boolean | `true` | Retry transient provider errors. |
| `retry.maxRetries` | number | `10` | Max retries per request. |
| `retry.baseDelayMs` | number | `500` | Initial backoff. |
| `retry.maxDelayMs` | number | `300000` | Backoff ceiling (5 min). |
| `retry.modelFallback` | boolean | `true` | Fall back to another model when one is unavailable. |
| `retry.fallbackChains` | record | `{}` | Maps roles, model selectors, or `provider/*` wildcards to ordered fallback selectors. Keys containing `/` are model-oriented and win over roles: `provider/model-id` matches that exact model, `provider/*` matches every model of the provider. A `provider/*` *entry* keeps the failing model's id and swaps the provider. The `default` chain covers every assigned role without its own chain. Unknown models/providers or malformed chains are reported as config warnings at startup. |
| `retry.fallbackRevertPolicy` | enum | `cooldown-expiry` | One of `cooldown-expiry`, `never`. `cooldown-expiry` returns to the primary model once its suppression window ends; `never` stays on the fallback until switched manually. |

When the active model keeps failing (429s, quota walls, provider outages) and `retry.modelFallback` is on, the session picks the chain that owns the failing model, by specificity: an exact `provider/model-id` key, then a `provider/*` wildcard, then the current role's chain, then `default`. It skips models whose selectors are still cooling down and switches for the rest of the turn. Subagents get their own per-spawn chains when their agent definition lists multiple model patterns — the first resolvable pattern is primary and the rest become its fallbacks; there is no `agent:<name>` key in `fallbackChains`.

## Tools and approvals

| Key | Type | Default | Description |
|---|---|---|---|
| `tools.approvalMode` | enum | `yolo` | One of `always-ask` (auto-approve read-only), `write` (auto-approve read + workspace-write), `yolo` (auto-approve all tiers). `--approval-mode` and `--auto-approve`/`--yolo` override per run. |
| `tools.approval` | record | `{}` | Per-tool policy keyed by tool name; each value is `allow`, `deny`, or `prompt`. |
| `tools.maxTimeout` | number | `0` | Max tool runtime in seconds; `0` = no cap. |
| `tools.intentTracing` | boolean | `true` | Record per-call intent strings. |
| `tools.outputMaxColumns` | number | `768` | Per-line byte cap for streaming output; `0` disables. |
| `tools.artifactSpillThreshold` | number | `50` | KB of tool output above which output spills to an artifact. |
| `tools.artifactHeadBytes` | number | `20` | KB of head kept inline on spill; `0` = tail-only. |
| `tools.artifactTailBytes` | number | `20` | KB of tail kept inline on spill. |
| `tools.artifactTailLines` | number | `500` | Max tail lines kept inline on spill. |

Individual built-in tools are toggled by their own keys: `bash.enabled`, `launch.enabled`, `eval.py`, `eval.js`, `glob.enabled`, `grep.enabled`, `fetch.enabled`, `browser.enabled`, `computer.enabled`, `astEdit.enabled`, `astGrep.enabled`, and `web_search.enabled`. The `inspect_image` tool is controlled by the tri-state `inspect_image.mode` (`auto` | `on` | `off`, default `auto`): `auto` exposes it only when the active model lacks native image input, and the `/vision` slash command overrides the mode per session.

## Native computer use

The disabled-by-default `computer` essential tool captures and controls the real host desktop through native OS APIs. It is separate from `browser`: `computer` can drive IDEs, terminals, native applications, browser windows, and system dialogs, while `browser` manages Chromium/CDP tabs and structured page automation.

| Key | Type | Default | Description |
|---|---|---|---|
| `computer.enabled` | boolean | `false` | Enable the native computer tool. Natively capable OpenAI GA models use the `{ "type": "computer" }` wire form; every other function-calling model gets `computer` as a regular function tool. The `/computer` slash command toggles this for the current session only. |
| `computer.backend` | enum | `auto` | One of `auto`, `native`; both require native capture/input and never fall back to browser automation. |
| `computer.display` | string | `all` | Composite all active displays, or use a numeric display ID reported by a successful computer result. |
| `computer.maxWidth` | number | `1920` | Maximum composite screenshot width in pixels. Image transports that cannot preserve original detail, including GitHub Copilot Responses and xAI OAuth, cap the effective width at `1280`; Claude-family models use the same cap as a compatibility fallback. |
| `computer.maxHeight` | number | `1200` | Maximum composite screenshot height in pixels. Those coordinate-safe transports cap the effective height at `896`; other models retain the configured limit. |

Computer settings are captured when the desktop controller is created. A model switch that crosses the coordinate-safe sizing boundary recreates the controller and resnapshots those settings; changing config alone does not, so start a new session after a settings change. The recreated controller has no prior coordinate frame, so capture a fresh screenshot before the next pointer action. Before enabling input, configure `tools.approvalMode` or `tools.approval.computer` and grant platform permissions.

## Shell, eval, and LSP

| Key | Type | Default | Description |
|---|---|---|---|
| `bash.enabled` | boolean | `true` | Enable the bash tool. |
| `launch.enabled` | boolean | `true` | Enable the launch tool for shared long-running project processes. |
| `bash.autoBackground.enabled` | boolean | `false` | Auto-background long-running commands. |
| `bash.autoBackground.thresholdMs` | number | `60000` | Threshold before auto-backgrounding. |
| `eval.py` | boolean | `true` | Python eval backend. `PI_PY=0` disables for the process. |
| `eval.js` | boolean | `true` | JavaScript eval backend. `PI_JS=0` disables for the process. |
| `python.kernelMode` | enum | `session` | One of `session` (persistent kernel), `per-call`. |
| `python.interpreter` | string | `""` | Path to a Python interpreter; empty = auto-detect. |
| `lsp.enabled` | boolean | `true` | Language-server integration. `--no-lsp` disables for the run. |
| `lsp.lazy` | boolean | `true` | Start servers on demand. |
| `lsp.diagnosticsOnWrite` | boolean | `true` | Run diagnostics after a write. |
| `lsp.diagnosticsOnEdit` | boolean | `false` | Run diagnostics after an edit. |
| `lsp.formatOnWrite` | boolean | `false` | Format files on write. |
| `lsp.diagnosticsDeduplicate` | boolean | `true` | Collapse duplicate diagnostics. |
| `shellPath` | string | _(unset)_ | Override the shell binary used by bash. |

## Files: editing and reading

| Key | Type | Default | Description |
|---|---|---|---|
| `edit.mode` | enum | `hashline` | One of `apply_patch`, `hashline`, `patch`, `replace`. |
| `edit.fuzzyMatch` | boolean | `true` | Allow fuzzy anchor matching. |
| `edit.fuzzyThreshold` | number | `0.95` | Similarity threshold for fuzzy matching. |
| `edit.blockAutoGenerated` | boolean | `true` | Refuse to edit generated/lockfile-like files. |
| `edit.streamingAbort` | boolean | `false` | Abort on streaming edit mismatch. |
| `read.defaultLimit` | number | `300` | Default line count for `read` without a selector. |
| `read.summarize.enabled` | boolean | `true` | Structural summaries for code reads. |
| `read.summarize.prose` | boolean | `false` | Summarize prose files too. |
| `read.toolResultPreview` | boolean | `false` | Inline preview of tool results. |
| `readLineNumbers` | boolean | `false` | Show plain line numbers. |

## Context, compaction, and memory

| Key | Type | Default | Description |
|---|---|---|---|
| `contextPromotion.enabled` | boolean | `false` | Promote to the active model's explicit `contextPromotionTarget` on context overflow. |
| `compaction.enabled` | boolean | `true` | Automatic conversation compaction. |
| `compaction.midTurnEnabled` | boolean | `true` | Check thresholds at safe mid-turn tool-loop boundaries before the next provider request. |
| `compaction.strategy` | enum | `snapcompact` | One of `context-full`, `handoff`, `shake`, `snapcompact`, `off`. |
| `compaction.thresholdPercent` | number | `-1` | Percent-of-context trigger; `-1` = reserve-based default. |
| `compaction.thresholdTokens` | number | `-1` | Fixed token trigger when `> 0`. |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for the next turn. |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens always preserved. |
| `compaction.remoteEnabled` | boolean | `true` | Allow remote compaction service. |
| `compaction.autoContinue` | boolean | `true` | Continue automatically after compaction. |
| `memory.backend` | enum | `off` | One of `off`, `local`, `hindsight`, `mnemopi`. Each backend has its own `hindsight.*` / `mnemopi.*` / `memories.*` tuning keys. |
| `autolearn.enabled` | boolean | `false` | Experimental: after the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills under `~/.omp/agent/managed-skills`. Enables the `manage_skill` tool (and `learn` when a memory backend is active). |
| `autolearn.autoContinue` | boolean | `false` | When `autolearn.enabled`, auto-run one capture turn at stop (uses extra tokens). Off = a passive reminder rides your next turn. |
| `autolearn.minToolCalls` | number | `5` | Only nudge after a turn that used at least this many tools. |

`compaction` has additional tuning keys (idle compaction, supersede/drop heuristics) visible in `omp config list`. See [Compaction](/features/compaction/) for the full strategy reference.

## Appearance and terminal

| Key | Type | Default | Description |
|---|---|---|---|
| `theme.dark` | string | `titanium` | Theme used on a dark terminal background. |
| `theme.light` | string | `light` | Theme used on a light terminal background. |
| `symbolPreset` | enum | `unicode` | One of `unicode`, `nerd`, `ascii`. |
| `colorBlindMode` | boolean | `false` | Use blue instead of green for diff additions. |
| `showHardwareCursor` | boolean | `true` | Show the terminal hardware cursor. |
| `statusLine.preset` | enum | `default` | One of `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, `custom`. |
| `statusLine.separator` | enum | `powerline-thin` | One of `powerline`, `powerline-thin`, `slash`, `pipe`, `block`, `none`, `ascii`. |
| `statusLine.sessionAccent` | boolean | `true` | Tint the editor border with the session color. |
| `statusLine.transparent` | boolean | `false` | Use the terminal background for the status line. |
| `statusLine.showHookStatus` | boolean | `true` | Show hook status messages. |
| `terminal.showImages` | boolean | `true` | Render images inline (when the terminal supports it). |
| `images.autoResize` | boolean | `true` | Resize large images for model compatibility. |
| `images.blockImages` | boolean | `false` | Never send images to providers. |
| `tui.hyperlinks` | enum | `auto` | One of `off`, `auto`, `always`. |

For a custom status line, set `statusLine.preset: custom` and configure `statusLine.leftSegments`, `statusLine.rightSegments`, and `statusLine.segmentOptions`. See [Themes](/configuration/themes/) for theme selection.

## Interaction

| Key | Type | Default | Description |
|---|---|---|---|
| `steeringMode` | enum | `one-at-a-time` | One of `all`, `one-at-a-time`. How queued steering messages are delivered. |
| `followUpMode` | enum | `one-at-a-time` | One of `all`, `one-at-a-time`. |
| `interruptMode` | enum | `immediate` | One of `immediate`, `wait`. |
| `doubleEscapeAction` | enum | `tree` | One of `branch`, `tree`, `none`. |
| `autoResume` | boolean | `false` | Auto-resume the most recent session in the cwd. |
| `ask.timeout` | number | `0` | Seconds before an `ask` prompt times out; `0` = no timeout. (Legacy ms values are migrated to seconds.) |
| `ask.notify` | enum | `on` | One of `on`, `off`. |

## Providers and services

Provider credentials and custom model definitions are configured separately — see [Providers](/models/providers/) and [Model roles](/models/model-roles/).

| Key | Type | Default | Description |
|---|---|---|---|
| `providers.webSearchOrder` | array | `[]` | Provider IDs in priority order for `web_search` (`perplexity`, `gemini`, `anthropic`, `codex`, `zai`, `exa`, `jina`, `kagi`, `tavily`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`, …). Duplicates and unknown IDs are ignored; unlisted providers retain their built-in relative order afterward. Empty = built-in order. Replaces the removed `providers.webSearch` enum (a legacy value migrates to the head of this list). |
| `providers.webSearchGeminiModel` | string | _(unset)_ | Gemini model ID for Google Search grounding when `web_search` uses Gemini; defaults to `gemini-2.5-flash`, overridden by `GEMINI_SEARCH_MODEL`. |
| `providers.imageOrder` | array | `[]` | Image-generation provider IDs in priority order (`openai`, `openai-codex`, `antigravity`, `xai`, `gemini`, `openrouter`). Unlisted providers follow the active session provider and the built-in order. Replaces the removed `providers.image` enum (a legacy value migrates to the head of this list). |
| `providers.fetch` | enum | `auto` | One of `auto`, `native`, `trafilatura`, `lynx`, `parallel`, `jina`. |
| `providers.tinyModel` | enum | `online` | One of `online`, `lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`. |
| `providers.tinyModelDevice` | enum | `default` | ONNX execution provider for local tiny models. Overridden by `PI_TINY_DEVICE`. |
| `providers.tinyModelDtype` | enum | `default` | ONNX precision for local tiny models. Overridden by `PI_TINY_DTYPE`. |
| `providers.openaiWebsockets` | enum | `auto` | One of `auto`, `off`, `on`. |
| `providers.openrouterVariant` | enum | `default` | One of `default`, `nitro`, `floor`, `online`, `exacto`. |
| `providers.kimiApiFormat` | enum | `anthropic` | One of `openai`, `anthropic`. |
| `provider.appendOnlyContext` | enum | `auto` | One of `auto`, `on`, `off`. |
| `exa.enabled` | boolean | `true` | Enable Exa integration. |
| `exa.enableSearch` | boolean | `true` | Exa search. |
| `exa.enableResearcher` | boolean | `false` | Exa researcher. |
| `exa.enableWebsets` | boolean | `false` | Exa websets. |
| `searxng.endpoint` | string | _(unset)_ | SearXNG instance URL. |
| `searxng.token` | string | _(unset)_ | SearXNG token; also `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`. |
| `auth.broker.url` | string | _(unset)_ | Auth-broker URL. Overridden by `OMP_AUTH_BROKER_URL`. |
| `auth.broker.token` | string | _(unset)_ | Auth-broker token. Overridden by `OMP_AUTH_BROKER_TOKEN`. |

## Other setting groups

`omp config list` exposes many more grouped settings, including: `task.*` (subagent concurrency, isolation, model overrides), `skills.*` and `commands.*` (discovery toggles), `mcp.*`, `github.*`, `async.*`, `goal.*`, `loop.*`, `todo.*`, `magicKeywords.*`, `ttsr.*` (time-traveling stream rules), `display.*`, `startup.*`, `share.*`, `collab.*`, `stt.*` / `tts.*`, `memories.*` / `hindsight.*` / `mnemopi.*` (memory backends), and `bashInterceptor.*`. Each follows the same type/default rules shown above — run `omp config list` to enumerate every valid key under each prefix.

## Legacy key migrations

Applied whenever raw settings are loaded (global, project, overlays, and runtime overrides):

| Old | New |
|---|---|
| `inspect_image.enabled` boolean | `inspect_image.mode` (`true` → `on`, `false` → `off`) |
| `queueMode` | `steeringMode` |
| `ask.timeout` in milliseconds (value `> 1000`) | seconds (divided by 1000) |
| flat `theme: "<name>"` string | `theme.dark` / `theme.light` (slot chosen by luminance; built-in `light`/`dark` are dropped to use defaults) |
| `task.isolation.enabled: true/false` | `task.isolation.mode: auto/none` |
| `task.simple` | removed |
| legacy `task.isolation.mode` (`worktree`, `fuse-overlay`, `fuse-projfs`) | `rcopy`, `overlayfs`, `projfs` |
| `lastChangelogVersion` | moved to a marker file and stripped from `config.yml` |
