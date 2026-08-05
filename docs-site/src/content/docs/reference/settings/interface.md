---
title: Settings — Interface
description: Theme, status line, and terminal output.
coverage: B
sidebar:
  label: Settings — Interface
  order: 4
---

Settings that change the visual and interactive surface of the TUI. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

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

For a custom status line, set `statusLine.preset: custom` and configure `statusLine.leftSegments`, `statusLine.rightSegments`, and `statusLine.segmentOptions`. See [Themes](/oh-my-pi/configuration/themes/) for theme selection.

