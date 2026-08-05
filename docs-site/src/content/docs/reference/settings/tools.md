---
title: Settings — Tools
description: Tool approval modes, the native computer tool, bash / eval / LSP, and the file editing and reading surface.
coverage: B
sidebar:
  label: Settings — Tools
  order: 2
---

Settings that govern which tools are available, when they run, and how they are approved. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

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
