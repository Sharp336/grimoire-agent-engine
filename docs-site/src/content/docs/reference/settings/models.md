---
title: Settings — Models
description: Configuration keys that pick and route models — roles, cycle order, allow-lists, advisor, and the active-model hint.
coverage: B
sidebar:
  label: Settings — Models
  order: 0
---

Settings that decide which model runs a turn and how the model switcher behaves. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

## Models

`modelRoles`, `modelTags`, and `cycleOrder` work together to define the models you can switch between. Role values may carry a thinking suffix (`:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`).

| Key | Type | Default | Description |
|---|---|---|---|
| `modelRoles` | record | `{}` | Map of role name to model id. Built-in roles: `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor`. The `tiny` role overrides the online model for lightweight background tasks (titles, memory, auto-thinking, unexpected-stop), else `@smol`. Per-role env/flags exist only for `--model`/`--smol`/`--slow`/`--plan`; configure the advisor with `modelRoles.advisor`. |
| `modelTags` | record | `{}` | Custom role/tag metadata; can introduce additional roles. |
| `modelProviderOrder` | array | `[]` | Preferred provider order when a model id is ambiguous. |
| `cycleOrder` | array | `["smol","default","slow"]` | Roles cycled by the model switcher. |
| `enabledModels` | array | `[]` | Allow-list of models; supports [path-scoped entries](/oh-my-pi/configuration/settings/#path-scoped-arrays). Empty means all available models. |
| `disabledProviders` | array | `[]` | Disabled model/discovery providers; supports path-scoped entries. See [Provider and source disabling](/oh-my-pi/configuration/settings/#provider-and-source-disabling). |
| `includeModelInPrompt` | boolean | `true` | Include the active model name in the system prompt. |

## Advisor

The advisor is a second model that reviews each completed turn and can inject advice into the primary session. Assign a model with `modelRoles.advisor`, then enable it with `advisor.enabled`, `/advisor on`, or by launching with the `--advisor` flag. See [Advisor](/oh-my-pi/features/advisor/) for runtime behavior, `WATCHDOG.md` discovery, and bounded catch-up semantics.

| Key | Type | Default | Description |
|---|---|---|---|
| `advisor.enabled` | boolean | `false` | Enable the advisor runtime when `modelRoles.advisor` resolves to an available model. |
| `advisor.subagents` | boolean | `false` | Also enable advisor runtimes for spawned task/eval subagents. |
| `advisor.syncBacklog` | enum | `off` | Bounded advisor catch-up delay: `off`, `1`, `3`, or `5`. The primary waits up to 30 seconds only while advisor backlog is at or above the threshold. |
| `advisor.immuneTurns` | number | `3` | After a `concern`/`blocker` interrupts, route further concerns/blockers as non-interrupting asides for this many completed primary turns. |
