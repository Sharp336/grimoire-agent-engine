Drives real Chromium tab; full Playwright (patchright) access via JS.

<instruction>
- Static content (articles, docs, issues/PRs, JSON, PDFs, feeds)? `read` the URL. Browser only for JS execution, auth, interactive actions.
- Three actions:
  - `open` — acquire/reuse named tab (`name` defaults `"main"`). Optional `url` (navigate once ready), `viewport`, `dialogs: "accept" | "dismiss"` (auto-handle `alert`/`confirm`/`beforeunload`; else page hangs till you wire `page.on('dialog', …)`).
  - `close` — release tab by `name`, or all with `all: true`. `kill: true` also kills spawned-app process trees.
  - `run` — execute JS in existing tab. `code` = async function body; `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. Return value JSON-stringified into result; `display(value)` accumulates text/images.
- Tabs survive `run` calls and in-process subagents — open once, reuse.
- Browser kinds (`app` on `open`):
  - default (no `app`) → headless Chromium with built-in stealth (patchright).
  - `app.path` → spawn absolute binary (Electron/CDP). No stealth — NEVER tamper with a real desktop app.
  - `app.cdp_url` → connect to existing CDP endpoint (e.g. `http://127.0.0.1:9222`).
  - `app.target` (with `path`/`cdp_url`) — substring on url+title picks BrowserWindow.
- `tab` helpers; drop to raw Playwright `page` for anything uncovered:
  - `tab.goto(url, { waitUntil? })` — navigate.
  - `tab.observe({ includeAll?, viewportOnly? })` — accessibility snapshot: `{ url, title, viewport, scroll, elements: [{ id, role, name, value, states, … }] }`. `id` is a **string** like `"e2"` (aria-ref). Ids stable until next observe/goto.
  - `tab.id(ref)` — ref string from last observe → handle (`.click()`, `.fill()`, `.type()`, …). Returns `Locator` in headless mode, `CmuxElementHandle` in cmux mode; both support the same action methods.
  - `tab.click(selector)` / `tab.type(selector, text)` / `tab.fill(selector, value)` / `tab.press(key, { selector? })` / `tab.scroll(dx, dy)`.
  - `tab.waitFor(selector)` — wait until attached; returns `Locator`.
  - `tab.drag(from, to)` — endpoints: selector (center-to-center) or `{ x, y }` viewport point (canvases, sliders).
  - `tab.scrollIntoView(selector)` — center in viewport; before clicking off-screen elements.
  - `tab.select(selector, …values)` — set `<select>` option(s); returns selection. `tab.fill` NEVER works for selects.
  - `tab.uploadFile(selector, …filePaths)` — attach files to `<input type="file">`; paths relative to cwd.
  - `tab.waitForUrl(pattern, { timeout? })` — substring or `RegExp` (matches SPA pushState nav); returns matched URL.
  - `tab.waitForResponse(pattern, { timeout? })` — substring, `RegExp`, or `(response) => boolean`; returns Playwright `Response` (`.text()`/`.json()`/`.status()`/`.headers()`).
  - `tab.evaluate(fn, …args)` — `page.evaluate` for ad-hoc DOM reads.
  - `tab.screenshot({ selector?, fullPage?, save?, silent? })` — capture + attach for viewing (`silent: true` skips). Pass `save` only when a later step needs the file.
  - `tab.extract(format = "markdown")` — readable page content (`"markdown"` | `"text"`); throws when nothing readable.
- Selectors: CSS + Playwright engines `text=Sign in`, `xpath=//a`, `role=button[name="Save"]`; legacy `aria/X`, `text/X`, `xpath/X`, `pierce/X`, `p-aria/X`, `p-text/X` auto-translated. `role=`/`aria/` match by ARIA role (incl. implicit) + accessible name in both backends.
</instruction>

<critical>
- MUST `open` before `run` — `run` never creates a tab.
- Default to `tab.observe()` for page state — structured data, actionable ids. Screenshot ONLY when appearance matters.
- Navigation invalidates element ids — re-observe before use.
- `tab.id(ref)` takes the **string** id from `observe()` (e.g. `"e2"`), not a number.
- `code` runs with full Node access. Treat as your code, not sandboxed.
</critical>

<output>
Per call: `display(value)` output, then `code`'s return value. `run` always produces at least a status line.
</output>
