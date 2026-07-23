# computer

> Execute OpenAI computer-use action batches against a session-owned, storage-isolated Chromium tab and return a fresh PNG.

## Source

- Entry: `packages/coding-agent/src/tools/computer.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/computer.md`
- Active safety prompt: `packages/coding-agent/src/prompts/system/computer-safety.md`
- Browser lifecycle:
  - `packages/coding-agent/src/tools/browser/registry.ts`
  - `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
  - `packages/coding-agent/src/tools/browser/tab-worker.ts`
  - `packages/coding-agent/src/tools/browser/tab-protocol.ts`
- Settings: `packages/coding-agent/src/config/settings-schema.ts`
- Protocol mapping: `packages/ai/src/providers/openai-shared.ts`, `openai-responses.ts`, and `openai-codex-responses.ts`

## Availability

`computer` is an essential built-in tool, but it is disabled unless `computer.enabled` is `true`. Selecting `--tools computer` does not bypass this setting.

```yaml
computer:
  enabled: true
  startUrl: about:blank
browser:
  headless: true
```

Official OpenAI Responses/Codex GPT-5.4-or-newer models receive the native tool. Other models receive the same schema as an ordinary function unless their resolved model compatibility explicitly sets `supportsNativeComputerUse`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `actions` | `ComputerAction[]` | Yes | Ordered actions executed serially. Empty batches are accepted and still return the current viewport. |
| `pendingSafetyChecks` | `{ id: string; code?: string \| null; message?: string \| null }[]` | Yes | Provider safety checks attached to this batch. Any non-empty array forces interactive confirmation. |

### Actions

| `type` | Required fields | Optional fields | Behavior |
| --- | --- | --- | --- |
| `click` | `x`, `y`, `button` | `keys` | Click at viewport coordinates. Buttons: `left`, `right`, `wheel`, `back`, `forward`. |
| `double_click` | `x`, `y`, `keys` | — | Double-click with held modifiers. |
| `drag` | `path` | `keys` | Drag through at least two ordered `{ x, y }` points. |
| `keypress` | `keys` | — | Press a normalized key combination; the array must be non-empty. |
| `move` | `x`, `y` | `keys` | Move the pointer with optional held modifiers. |
| `screenshot` | — | — | No-op action; the batch-level screenshot is still captured after all actions. |
| `scroll` | `x`, `y`, `scroll_x`, `scroll_y` | `keys` | Move to the coordinate, then send a wheel delta. |
| `type` | `text` | — | Type literal text through Puppeteer keyboard input. |
| `wait` | — | — | Wait two seconds before the next action. |

Modifier aliases normalize to Puppeteer keys, including `CTRL`/`CONTROL`, `CMD`/`COMMAND`/`META`, `ALT`/`OPTION`, and `SHIFT`. Common navigation aliases such as `ENTER`, `TAB`, arrows, page navigation, function keys, and space are normalized too.

## Outputs

A successful batch returns:

- exactly one `{ type: "image", mimeType: "image/png", data: <base64> }` content item;
- `details.actions`: the ordered action type names;
- `details.tab`: the session-derived tab name (`computer:<session-id>`);
- `details.viewport`: `{ width: 1280, height: 720, deviceScaleFactor: 1 }`;
- `openaiComputer.acknowledgedSafetyChecks`: the input checks, copied only after the whole batch succeeds.

The PNG is exactly 1280x720. Screenshot pixels and input action coordinates therefore use the same coordinate space.

## Flow

1. `ComputerTool.execute()` validates action invariants and derives the tab name from the coding-agent session id.
2. The tool acquires the process-level headless browser handle selected by `browser.headless`.
3. `acquireTab()` creates a dedicated Puppeteer `BrowserContext` (`isolateStorage: true`) for the computer session, applies the fixed viewport, and navigates to `computer.startUrl`.
4. Later calls in the same session reuse that named tab and context.
5. `runInTab()` executes generated Puppeteer code in the tab worker. Actions run serially; modifiers are pressed before and released after each applicable action.
6. After the final action, the worker captures the current viewport PNG and returns it through the worker display channel.
7. The tool rejects results that do not contain exactly one PNG. A successful result carries acknowledged provider safety checks for native `computer_call_output` replay.
8. Session disposal releases owner tabs. Graceful cleanup closes the page and owned context; forced cleanup disposes the context over CDP before dropping the browser hold.

## Approval and safety

- Ordinary calls use approval tier `exec`.
- A non-empty `pendingSafetyChecks` array sets `alwaysPrompt: true`; global `yolo`, `--auto-approve`, and per-tool `allow` cannot bypass it.
- Print/headless approval flows have no confirmation UI and fail closed when mandatory checks are present.
- The active safety prompt treats UI content as untrusted data, follows only direct user instructions, and requires point-of-risk confirmation for high-impact actions.
- Approval covers only the displayed batch and does not replace point-of-risk confirmation.

## Side effects

- Launches or reuses OMP's supervised Chromium process according to the browser registry.
- Opens one page and one isolated browser context per active computer session.
- Navigates to `computer.startUrl` on first acquisition.
- Performs the requested browser input actions and normal page network activity.
- Holds browser/tab registry state until session cleanup.
- Does not write screenshots to disk; the PNG is returned as tool content.

## Limits and caps

- Viewport: 1280x720 CSS/image pixels, device scale factor 1.
- Batch timeout: 30 seconds.
- `wait`: 2 seconds per action.
- Batches are exclusive and cannot overlap with another call to the same tool instance.
- Browser-only: the tool does not control the desktop or native applications.
- Function fallback depends on the selected model understanding the action schema.

## Errors

- A drag path with fewer than two points fails before browser execution.
- An empty keypress array fails before browser execution.
- Any Puppeteer action failure aborts the remaining batch. No screenshot or safety acknowledgement is returned.
- A batch that does not produce exactly one PNG fails with `Computer batch completed without exactly one PNG screenshot`.
- Browser acquisition, navigation, worker timeout, abort, and teardown errors use the shared browser/tool error paths.
- Failed native calls without a replayable PNG are folded into an assistant recovery note by the OpenAI Responses mapping rather than emitted as an invalid function/native output.

## Related documentation

- [Computer use configuration and safety](../computer-use.md)
- [Approval modes](../approval-mode.md)
- [Settings reference](../settings.md)
