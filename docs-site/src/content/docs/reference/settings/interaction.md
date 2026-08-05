---
title: Settings — Interaction
description: Steering, follow-up, interrupt, ask, and resume behaviour.
coverage: B
sidebar:
  label: Settings — Interaction
  order: 5
---

Settings that control how queued prompts, interrupts, and resume requests are delivered. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

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
