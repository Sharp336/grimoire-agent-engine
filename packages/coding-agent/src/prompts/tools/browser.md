Drives real Chromium tab; full puppeteer access via JS.

<instruction>
- Static content? `read` the URL. Browser only for JS execution, auth, interactive actions.
- `open` → `run` — tabs survive calls and subagents, open once reuse.
- `run` scope: `page`, `browser`, `tab`, `display`, `assert`, `wait` available. `wait(fn)` polls until truthy — use instead of polling inside `tab.evaluate`.
- `start_recording` begins a sanitized HAR capture for an open, supported tab. Optional `domains` scopes capture to exact http(s) origins; otherwise the current tab origin is used.
- `stop_recording` persists the capture to an `artifact://` file and returns bounded counts, never captured traffic inline.

- `tab` helpers (drop to raw puppeteer `page` for anything uncovered):
  Element handles: `tab.ref("e5")` / `tab.id(n)` return a handle you call methods on directly — `(await tab.id(n)).click()`. Handles are NOT selectors: `tab.click`/`type`/`fill`/`waitFor*` take STRING selectors only. Snapshot refs work in any selector slot: `tab.click("e5")` ≡ `tab.click("aria-ref=e5")`.
  Simple: `tab.goto`, `tab.click`, `tab.type`, `tab.fill`, `tab.press`, `tab.scroll`, `tab.scrollIntoView`, `tab.drag`, `tab.uploadFile`, `tab.select`, `tab.screenshot`, `tab.extract`, `tab.evaluate`.
  Waits: `tab.waitFor`, `tab.waitForSelector`, `tab.waitForUrl`, `tab.waitForResponse`, `tab.waitForNavigation`.
  Snapshots: `tab.observe()` → accessibility tree; `tab.ariaSnapshot()` → ARIA YAML with `[ref=eN]`.

  Gotchas:
  - `tab.fill` NEVER works for `<select>` — use `tab.select`.
  - `tab.waitForNavigation` must start BEFORE the trigger click.
  - Navigation and re-renders (virtualized lists, SPA updates) invalidate ids/refs — re-observe or re-snapshot, then act in the same cell.
  - Stalled actions fail fast with named error, never whole-cell timeout.
  - Raw request interception is run-scoped: run end removes `request` handlers, disables interception, releases held requests.

- `app.path` → NEVER tamper with a real desktop app (no stealth patches).
- Selectors: CSS + puppeteer `aria/…`, `text/…`, `xpath/…`, `pierce/…`. Playwright-only pseudos (`:has-text()`, `:visible`) are REJECTED.
</instruction>

<recording>
Two-phase, authorized network capture:
- Recording is opt-in and explicit: approve `start_recording` on an open supported tab, drive the flow with `run`/interactions, then approve `stop_recording` to finalize it. `run` never starts or stops a recorder.
- `start_recording` optionally scopes capture with exact http(s) origins (`domains`); the scope is fixed at start and never widens across navigation. Reproduce the exact requests you want captured after starting.
- `stop_recording` flushes and persists a sanitized HAR to `artifact://<id>`. Read it back with `read artifact://<id>` when you need request/response detail; the tool result itself carries only the URI plus entry/body/truncation counts — never the captured traffic inline.
- v1 supports only Puppeteer-backed headless, spawned-app, and connected tabs; CMUX is not supported. Responses served by a service worker or synthesized from the HTTP cache may not surface as page-target Network events, so they can be absent from the HAR. Force a cache-bypassing (hard) reload or disable the service worker when such a response must be captured.
- Headers and bodies are sanitized (secrets/PII redacted) and bounded (entry/byte caps); bodies are captured only for JSON or form-encoded content types. An over-limit capture reports `truncated`, and omitted bodies are counted.
- Client-derivation rule: when you turn a captured request into client code, NEVER hardcode captured auth material, CSRF tokens, signed URLs, account IDs, or other PII — those are per-session and are redacted in the artifact anyway. Parameterize approved runtime credentials and derive dynamic identifiers at call time.
</recording>

<critical>
- MUST `open` before `run`. Default to `tab.observe()`; screenshot only for appearance. `code` runs with full Node access — not sandboxed.
</critical>
