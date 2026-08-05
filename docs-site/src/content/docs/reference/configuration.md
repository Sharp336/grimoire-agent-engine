---
title: Configuration Reference
description: Reference for the omp settings documented across this site — type, default, and values per key, with links to the user-facing guide.
coverage: B
---

This page is a reference for the settings that have a documented user-facing surface in this site. The settings are split into one page per domain; the index below lists every key in alphabetical order with a link to where it lives.

For the workflow and the layered config model, start with [Settings](/oh-my-pi/configuration/settings/). For the exhaustive, generated list of every key the schema accepts, run `omp config list` in a terminal.

Defaults and enum values are taken from the settings schema. Environment-variable and CLI-flag overrides are process-local and never persisted. Keys must match a schema path exactly — there is no shorthand.

::::note
Several sections in the [Generation](/oh-my-pi/reference/settings/generation/) page use a `Default` of `-1` to mean "use the provider or model default; `omp` does not send that parameter". This applies to every numeric sampling key and to a few integer triggers that opt into the reserve-based default.
::::

## Settings domains

- [Settings — Models](/oh-my-pi/reference/settings/models/) — `modelRoles`, `cycleOrder`, `enabledModels`, `advisor.*`
- [Settings — Generation](/oh-my-pi/reference/settings/generation/) — thinking budgets, sampling, provider tiers, retry and fallback
- [Settings — Tools](/oh-my-pi/reference/settings/tools/) — `tools.approval*`, `computer.*`, `bash.*`, `eval.*`, `lsp.*`, `edit.*`, `read.*`
- [Settings — Context](/oh-my-pi/reference/settings/context/) — `contextPromotion.*`, `compaction.*`, `memory.*`, `autolearn.*`
- [Settings — Interface](/oh-my-pi/reference/settings/interface/) — `theme.*`, `statusLine.*`, terminal, TUI hyperlinks
- [Settings — Interaction](/oh-my-pi/reference/settings/interaction/) — `steeringMode`, `interruptMode`, `ask.*`, `autoResume`
- [Settings — Providers](/oh-my-pi/reference/settings/providers/) — `providers.*`, `exa.*`, `searxng.*`, `auth.broker.*`



## Documented keys (alphabetical)
This list reflects the schema as of the 2026-08 audit. Run `omp config list` for the current schema.

| Key | Domain |
| `advisor.enabled` | [Models](/oh-my-pi/reference/settings/models/#advisor) |
| `advisor.immuneTurns` | [Models](/oh-my-pi/reference/settings/models/#advisor) |
| `advisor.subagents` | [Models](/oh-my-pi/reference/settings/models/#advisor) |
| `advisor.syncBacklog` | [Models](/oh-my-pi/reference/settings/models/#advisor) |
| `ask.notify` | [Interaction](/oh-my-pi/reference/settings/interaction/#interaction) |
| `ask.timeout` | [Interaction](/oh-my-pi/reference/settings/interaction/#interaction) |
| `auth.broker.token` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `auth.broker.url` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `autoResume` | [Interaction](/oh-my-pi/reference/settings/interaction/#interaction) |
| `bash.autoBackground.enabled` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `bash.autoBackground.thresholdMs` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `bash.enabled` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `colorBlindMode` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `compaction.autoContinue` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `compaction.enabled` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `compaction.keepRecentTokens` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `compaction.midTurnEnabled` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `compaction.remoteEnabled` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `compaction.reserveTokens` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `compaction.strategy` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `compaction.thresholdPercent` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `compaction.thresholdTokens` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `computer.backend` | [Tools](/oh-my-pi/reference/settings/tools/#native-computer-use) |
| `computer.display` | [Tools](/oh-my-pi/reference/settings/tools/#native-computer-use) |
| `computer.enabled` | [Tools](/oh-my-pi/reference/settings/tools/#native-computer-use) |
| `computer.maxHeight` | [Tools](/oh-my-pi/reference/settings/tools/#native-computer-use) |
| `computer.maxWidth` | [Tools](/oh-my-pi/reference/settings/tools/#native-computer-use) |
| `contextPromotion.enabled` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `cycleOrder` | [Models](/oh-my-pi/reference/settings/models/#models) |
| `defaultThinkingLevel` | [Generation](/oh-my-pi/reference/settings/generation/#thinking) |
| `disabledProviders` | [Models](/oh-my-pi/reference/settings/models/#models) |
| `doubleEscapeAction` | [Interaction](/oh-my-pi/reference/settings/interaction/#interaction) |
| `edit.blockAutoGenerated` | [Tools](/oh-my-pi/reference/settings/tools/#files-editing-and-reading) |
| `edit.fuzzyMatch` | [Tools](/oh-my-pi/reference/settings/tools/#files-editing-and-reading) |
| `edit.fuzzyThreshold` | [Tools](/oh-my-pi/reference/settings/tools/#files-editing-and-reading) |
| `edit.mode` | [Tools](/oh-my-pi/reference/settings/tools/#files-editing-and-reading) |
| `edit.streamingAbort` | [Tools](/oh-my-pi/reference/settings/tools/#files-editing-and-reading) |
| `enabledModels` | [Models](/oh-my-pi/reference/settings/models/#models) |
| `eval.js` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `eval.py` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `exa.enableResearcher` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `exa.enableSearch` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `exa.enableWebsets` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `exa.enabled` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `followUpMode` | [Interaction](/oh-my-pi/reference/settings/interaction/#interaction) |
| `hideThinkingBlock` | [Generation](/oh-my-pi/reference/settings/generation/#thinking) |
| `images.autoResize` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `images.blockImages` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `includeModelInPrompt` | [Models](/oh-my-pi/reference/settings/models/#models) |
| `interruptMode` | [Interaction](/oh-my-pi/reference/settings/interaction/#interaction) |
| `launch.enabled` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `lsp.diagnosticsDeduplicate` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `lsp.diagnosticsOnEdit` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `lsp.diagnosticsOnWrite` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `lsp.enabled` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `lsp.formatOnWrite` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `lsp.lazy` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `memory.backend` | [Context](/oh-my-pi/reference/settings/context/#context-compaction-and-memory) |
| `minP` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `modelProviderOrder` | [Models](/oh-my-pi/reference/settings/models/#models) |
| `modelRoles` | [Models](/oh-my-pi/reference/settings/models/#models) |
| `modelTags` | [Models](/oh-my-pi/reference/settings/models/#models) |
| `personality` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `presencePenalty` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `provider.appendOnlyContext` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `providers.autoThinkingMaxEffort` | [Generation](/oh-my-pi/reference/settings/generation/#thinking) |
| `providers.fetch` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `providers.imageOrder` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `providers.kimiApiFormat` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `providers.openaiWebsockets` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `providers.openrouterVariant` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `providers.tinyModel` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `providers.tinyModelDevice` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `providers.tinyModelDtype` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `providers.webSearchGeminiModel` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `providers.webSearchOrder` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `python.interpreter` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `python.kernelMode` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `read.defaultLimit` | [Tools](/oh-my-pi/reference/settings/tools/#files-editing-and-reading) |
| `read.summarize.enabled` | [Tools](/oh-my-pi/reference/settings/tools/#files-editing-and-reading) |
| `read.summarize.prose` | [Tools](/oh-my-pi/reference/settings/tools/#files-editing-and-reading) |
| `read.toolResultPreview` | [Tools](/oh-my-pi/reference/settings/tools/#files-editing-and-reading) |
| `readLineNumbers` | [Tools](/oh-my-pi/reference/settings/tools/#files-editing-and-reading) |
| `repetitionPenalty` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `retry.baseDelayMs` | [Generation](/oh-my-pi/reference/settings/generation/#retry-and-fallback) |
| `retry.enabled` | [Generation](/oh-my-pi/reference/settings/generation/#retry-and-fallback) |
| `retry.fallbackChains` | [Generation](/oh-my-pi/reference/settings/generation/#retry-and-fallback) |
| `retry.fallbackRevertPolicy` | [Generation](/oh-my-pi/reference/settings/generation/#retry-and-fallback) |
| `retry.maxDelayMs` | [Generation](/oh-my-pi/reference/settings/generation/#retry-and-fallback) |
| `retry.maxRetries` | [Generation](/oh-my-pi/reference/settings/generation/#retry-and-fallback) |
| `retry.modelFallback` | [Generation](/oh-my-pi/reference/settings/generation/#retry-and-fallback) |
| `searxng.endpoint` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `searxng.token` | [Providers](/oh-my-pi/reference/settings/providers/#providers-and-services) |
| `shellPath` | [Tools](/oh-my-pi/reference/settings/tools/#shell-eval-and-lsp) |
| `showHardwareCursor` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `statusLine.preset` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `statusLine.separator` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `statusLine.sessionAccent` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `statusLine.showHookStatus` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `statusLine.transparent` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `steeringMode` | [Interaction](/oh-my-pi/reference/settings/interaction/#interaction) |
| `symbolPreset` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `temperature` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `terminal.showImages` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `theme.dark` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `theme.light` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |
| `thinkingBudgets.high` | [Generation](/oh-my-pi/reference/settings/generation/#thinking) |
| `thinkingBudgets.low` | [Generation](/oh-my-pi/reference/settings/generation/#thinking) |
| `thinkingBudgets.max` | [Generation](/oh-my-pi/reference/settings/generation/#thinking) |
| `thinkingBudgets.medium` | [Generation](/oh-my-pi/reference/settings/generation/#thinking) |
| `thinkingBudgets.minimal` | [Generation](/oh-my-pi/reference/settings/generation/#thinking) |
| `thinkingBudgets.xhigh` | [Generation](/oh-my-pi/reference/settings/generation/#thinking) |
| `tier.advisor` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `tier.anthropic` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `tier.google` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `tier.openai` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `tier.subagent` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `tools.approval` | [Tools](/oh-my-pi/reference/settings/tools/#tools-and-approvals) |
| `tools.approvalMode` | [Tools](/oh-my-pi/reference/settings/tools/#tools-and-approvals) |
| `tools.artifactHeadBytes` | [Tools](/oh-my-pi/reference/settings/tools/#tools-and-approvals) |
| `tools.artifactSpillThreshold` | [Tools](/oh-my-pi/reference/settings/tools/#tools-and-approvals) |
| `tools.artifactTailBytes` | [Tools](/oh-my-pi/reference/settings/tools/#tools-and-approvals) |
| `tools.artifactTailLines` | [Tools](/oh-my-pi/reference/settings/tools/#tools-and-approvals) |
| `tools.intentTracing` | [Tools](/oh-my-pi/reference/settings/tools/#tools-and-approvals) |
| `tools.maxTimeout` | [Tools](/oh-my-pi/reference/settings/tools/#tools-and-approvals) |
| `tools.outputMaxColumns` | [Tools](/oh-my-pi/reference/settings/tools/#tools-and-approvals) |
| `topK` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `topP` | [Generation](/oh-my-pi/reference/settings/generation/#sampling) |
| `tui.hyperlinks` | [Interface](/oh-my-pi/reference/settings/interface/#appearance-and-terminal) |

## Other setting groups

`omp config list` exposes additional grouped settings that this reference does not enumerate one-by-one. They follow the same type/default rules shown on the domain pages. Inspect them in a terminal with `omp config list <prefix>`:

- `task.*` — subagent concurrency, isolation, model overrides
- `skills.*` and `commands.*` — discovery toggles
- `mcp.*` — server transports, timeouts, and naming
- `github.*` — repository, PR, and Actions behaviour
- `async.*` — background job lifecycle
- `goal.*` and `loop.*` — long-running task shells
- `todo.*` — todo-list persistence
- `magicKeywords.*` — recognised prompt words
- `ttsr.*` — time-traveling stream rules
- `display.*` — per-tool rendering hints
- `startup.*` — launch-time behaviour
- `share.*` and `collab.*` — sharing and collaboration
- `stt.*` and `tts.*` — speech-to-text and text-to-speech
- `memories.*`, `hindsight.*`, `mnemopi.*` — memory backends
- `bashInterceptor.*` — shell-side command interception

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
