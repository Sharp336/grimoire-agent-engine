---
title: Settings — Context
description: Compaction, context overflow, memory backends, and autolearn.
coverage: B
sidebar:
  label: Settings — Context
  order: 3
---

Settings that govern how the context window is filled, summarized, and remembered across sessions. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

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

`compaction` has additional tuning keys (idle compaction, supersede/drop heuristics) visible in `omp config list`. See [Compaction](/oh-my-pi/features/compaction/) for the full strategy reference.
