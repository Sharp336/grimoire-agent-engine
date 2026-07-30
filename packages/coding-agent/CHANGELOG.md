Warning: truncated output (original token count: 407320)
... 580702 bytes omitted ...

# Changelog

## [Unreleased]

### Added

- Added server-name autocomplete for `/mcp` commands (`enable`, `disable`, `test`, `remove`, `reconnect`, `reauth`, `unauth`) using configured and runtime-discovered MCP servers.
- Added `--from-claude` and `--from-codex` session imports, also available from `/resume @claude` and `/resume @codex`.

### Changed

- Improved grouped read-call layout by nesting each request's usage metrics beneath its final path.
- Improved turn recovery to prevent duplicate output streaming during credential rotation or model fallback when visible text has already been streamed.
- Optimized tool guidance for bash, grep, and glob to be more concise while clarifying shell boundaries and search timeouts.
- Optimized models configuration resource probing to run in a single child process, reducing startup contention.

### Fixed

- Fixed `/tan` agents being unable to read parent-session `local://` attachments by correctly resolving local protocol options against the parent session's artifacts.
- Fixed Codex web search silently returning plain completions when the hosted web search tool was skipped.
- Fixed TUI collaboration guest loader not starting when joining or reconnecting mid-turn.
- Fixed multi-second TUI freezes in reftable-format repositories by moving branch resolution off the render path and adding a timeout to synchronous git spawns.
- Fixed `xd://` device summaries containing control characters and exceeding size budgets by stripping control characters and bounding summaries by UTF-8 bytes.
- Fixed `task.softRequestBudget` configuration having no effect on bundled scout and sonic subagents.
- Fixed quick LSP server exits being misreported as reader failures and resolved an issue where explicit reloads were blocked by initialization backoff.
- Forced Git subprocesses to use the stable `C` locale to ensure predictable, non-interactive command output.
- Fixed compatibility replay issues for pre-upgrade launch brokers evaluating xterm inside the client process.
- Fixed Advisor cost tracking in the status line across conversation boundaries, ensuring session transitions, forks, and resumes correctly restore or isolate conversation spend.
- Fixed validation failures for legacy extensions importing from the package root, which previously blocked installations.
- Fixed ACP clients (such as Zed), TUI status lines, and collaboration guests not updating when model changes occur dynamically within the agent loop.
- Fixed assistant-facing resource summaries omitting parameterized MCP resource templates, ensuring failed reads list templates alongside concrete resources.
- Fixed redundant `xd://` mount notices and prompt-cache invalidation when resuming sessions or reconnecting devices.
- Fixed the model picker displaying placeholder model lists instead of the actual credential-aware catalog resolved at registration.
- Fixed file corruption and snapshot mismatches when writing files through the ACP client bridge by verifying the final on-disk content after client-side post-save formatting.
- Fixed `omp ttsr test` silently evaluating source files as prose when their extensions were missing from the allowlist, and expanded the allowlist to support .NET, Shell, SQL, Zig, Dart, Scala, Elixir, and Protobuf files.
- Fixed automatic light/dark theme switching in direct WezTerm sessions on macOS when DEC Mode 2031 is unsupported, and improved theme-change color responsiveness.

## [17.1.8] - 2026-07-28

### Breaking Changes

- Changed tab.screenshot() to no longer accept a per-call save path; it now saves screenshots under browser.screenshotDir (or the OS temp directory if unset) and returns the saved path.

### Added

- Added omp cleanse, a new command that automatically detects language-ecosystem checkers, parses diagnostics (such as Cargo Clippy JSON), distributes repair workloads across concurrent subagents, and runs verification checks with a live progress bar.

### Changed

- Reworked the /guided-goal command from a modal-based popup flow into a natural, conversational chat interface where the agent asks follow-up questions directly in the session.
- Reduced startup memory usage by lazy-loading HTML session export assets only on their first use.

### Fixed

- Fixed Advisor notes appending stale-review-window warnings when newer primary turns are queued during a review.
- Fixed layout padding alignment issues in bordered output blocks and web-search result panels.
- Fixed excluded web search providers remaining visible in the Web Search Provider Order settings list.
- Fixed internal Hub peer messages being exposed as ordinary tool-call updates in clients like Paseo.
- Fixed compatibility issues when installing legacy pi extensions by updating the legacy shim to correctly bridge missing runtime symbols and exports (such as isContextOverflow, isRetryableAssistantError, and JSON parsing utilities).
- Fixed an issue where routine daemon operations (like list, logs, stop, or describe) could inadvertently trigger a restart loop for detached daemons in a backoff window.
- Fixed marketplace plugin MCP discovery to correctly honor the mcpServers manifest field in plugin configuration files.
- Fixed user-initiated shell executions (! and $) being misattributed as agent actions in advisor transcripts.
- Fixed unnecessary prompt-cache invalidations by preserving the active auto-thinking effort level when per-turn classification fails.
- Fixed the omp process name showing up as bun in Linux process managers (like ps and top).
- Fixed agent shell commands inheriting environment variables from the launch directory's .env file, ensuring they only receive the parent environment and explicit tool overrides.
- Fixed the /new command retaining completed or failed async jobs from the previous session.
- Improved error handling in omp update to display a friendly timeout message if the download times out while streaming the binary.
- Fixed the write tool incorrectly treating semicolon-joined read selectors as filesystem paths and creating unintended directory structures.
- Fixed omp worktree clear prematurely deleting active task-isolation sandboxes owned by running subagents.
- Fixed /vibe mode preventing the director from completing parent tasks after verifying worker results by keeping the built-in todo tool active.
- Fixed numeric GitHub issue and pull request autocomplete being suppressed inside skill slash-command arguments.
### Changed

- Startup release notes now default to a compact change-count summary. Use `startup.changelogMode` (`summary` | `expanded` | `hidden`) to control them; legacy `collapseChangelog` choices migrate automatically ([#6771](https://github.com/can1357/oh-my-pi/issues/6771)).

## [17.1.7] - 2026-07-27

### Fixed

- Restoring a prompt with image attachments via esc-esc branch or `/tree` now re-attaches the images to the composer draft: previously only the text (with its `[Image #N]` markers) was restored, so resubmitting sent the literal marker with no image.
- Fixed large bash/eval/ssh output citing two different artifact ids in one result — the truncation notice said `Read artifact://N for full output` while the footer said `Artifact: N+1`. The streaming sink's head and tail windows each had a full budget, so a middle-elided inline body could reach `headBytes + spillThreshold` and always re-tripped the final-defense inline byte cap, which truncated a second time (two elision markers), saved a duplicate already-truncated artifact, and left the notice's line ranges stale. The head and tail windows now share the spill-threshold budget (head clamped to half), the cap budget derives from the configured threshold plus notice slack, and when the cap does fire on a sink-spilled result it references the existing raw artifact instead of saving a copy.

### Added

- Added the bundled `ts-no-local-is-record` TTSR rule, which catches local `isRecord` function and lambda definitions and directs agents to shared guards plus explicit shape validation.
- A `tool_call` handler (extension or hook) can now return `input` to revise the arguments a tool executes with, not just `block` it. The returned object is the raw execution input passed to the tool (ignored when `block` is set, and not applied to `computer` tool calls), enabling wrappers that normalize or rewrite a built-in's arguments without reimplementing the tool. For model-issued calls the event fires at arg-prep time in the agent loop, so a revision is revalidated against the tool schema and is what concurrency scheduling, `tool_execution_start`/transcripts, the persisted assistant message, and the approval gate all observe — the user approves exactly what runs, and a revision that changes a tool's functional concurrency (e.g. bash `pty`) schedules correctly. A revised nested `write xd://` device dispatch forfeits the outer write gate's approval and faces the full prompt again ([#6681](https://github.com/can1357/oh-my-pi/pull/6681) by [@psyrendust](https://github.com/psyrendust)).
- Added a parser for macOS `sample`(1) call-tree reports to the read tool: `*.sample.txt` reads now return a compact bottleneck summary — per-thread hot paths with on-CPU sample counts (blocked syscall time excluded), demangled Rust v0/legacy symbols, flattened direct recursion, merged call-site siblings, idle-thread classification, and a process-wide top-functions-by-self-samples table. `:raw` still reads the original report, and files that merely carry the extension fall back to plain text.
- Added V8 `.cpuprofile` support to the read tool (Node/Bun `--cpu-prof`, Chrome DevTools, CDP `Profiler.stop` output): reads now return a compact bottleneck summary — hot-path call tree with on-CPU milliseconds (`(idle)` time excluded), collapsed pass-through chains, flattened direct recursion, shortened file URLs, and a top-functions-by-self-time table. `:raw` still reads the original JSON, and files that merely carry the extension fall back to plain text.

### Changed

- Direct and `xd://` dispatch now share one canonical tool map: `write xd://<tool>` executes any enabled top-level or mounted tool, and `read xd://<tool>` returns its docs, instead of failing when the name was exposed through the other layer. Mounted names are presentation metadata only, so tool replacement and disconnection cannot leave stale device instances; disabled tools remain unreachable, and both `xd://` and Cursor/top-level fallback execution retain the tool's approval and ACP permission gates.
- Session listing now caches parsed headers keyed on file stat identity (mtime + size), so repeated resume-picker opens and startup scans re-read only changed session files
- Reduced per-keystroke editor dispatch overhead: keybinding resolution happens once per input chunk and the per-action interception chain is gated behind a single canonical-key set probe
- `xd://` device docs now render the parameter schema as a comment-annotated TypeScript type (via `jsonSchemaToTypeScript`, the same renderer the in-band tool inventory uses) instead of a raw JSON Schema dump, shrinking system-prompt device sections while keeping descriptions inline.
- Added a `/vision [on|off|auto|status]` slash command for session-scoped control of the `inspect_image` vision-delegation tool, modeled on `/computer`: `on`/`off` force the tool for the current session only, `auto` returns to the persisted setting, and `status` reports the effective mode, session override, tool state, and active-model image capability.
- Replaced the `inspect_image.enabled` boolean with the tri-state `inspect_image.mode` (`auto`|`on`|`off`, default `auto`). In `auto` the tool is registered only when the active model lacks native image input, so vision-capable models (e.g. `kimi-code/k3`) read images inline with their own capabilities instead of delegating to a separate vision model; the tool set is re-evaluated on every model switch with a status notice when it flips. The `read` tool now follows the effective state dynamically rather than the raw setting, so it returns decoded image blocks again whenever `inspect_image` is hidden. Existing `inspect_image.enabled: true/false` configs migrate to `inspect_image.mode: on/off`.

## [17.1.6] - 2026-07-27

### Added

- Added separate Advisor cost visibility to the status line, rendering primary and Advisor spend as `$2.67 (sub) + $0.41 (adv)` while keeping already-incurred Advisor cost across runtime disablement and same-session history rewrites.

### Changed

- Made the task tool's per-spawn `effort` parameter opt-in through `task.enableEffort`, which defaults to false and omits the field from flat and batch schemas and tool guidance until enabled.
- Reduced terminal-title update overhead by deduplicating unchanged titles on every platform and using `SetConsoleTitleW` through `bun:ffi` instead of OSC writes on Windows. Windows working titles now keep a static `:` separator instead of scheduling spinner updates; other platforms retain the animated separator.
- Added `task.maxEffort` to cap the task tool's optional per-spawn effort hint after model-specific resolution, so operators can enable effort hints without allowing them to exceed a configured ceiling; the ceiling now also rides into the spawned session so retry-fallback model swaps re-clamp to it instead of escalating past the cap ([#6580](https://github.com/can1357/oh-my-pi/issues/6580), [#6794](https://github.com/can1357/oh-my-pi/pull/6794) by [@wolfiesch](https://github.com/wolfiesch)).
- Restructured the steering/interjection envelope sent to the model: the injected `<user_interjection>...<message>...</message>...` wrapper around user text is now a `<system-notice>` explaining the interjection followed by the user's raw message unwrapped, matching the existing `<system-notice>`/`<system-directive>` convention instead of nesting the literal message inside its own tag pair, which some models found confusing.

### Fixed

- Fixed a disabled higher-priority MCP server no longer disabling a same-named lower-priority one: disabled servers are now suppressed after key-level dedupe instead of dropped before it, so a project `foo` with `enabled: false` keeps the user-level `foo` off while still not starving a differently-named equivalent connection.
- Fixed the MCP tool-name collision winner flipping when the current owner reconnects: the winner is now chosen by a stable server+tool key instead of tool-array insertion order, which reconnects reorder.
- Fixed MCP resources with custom URI schemes being treated as missing filesystem paths. `read` and `omp read` now resolve server-advertised native resource URIs such as `ags://capabilities/current-host`, while preserving the existing `mcp://<resource-uri>` form.
- Fixed three gaps in native MCP resource URI resolution: server-advertised URIs whose path is exactly `/` (e.g. `catalog://root/`) are now preserved byte-for-byte instead of losing the trailing slash to reconstruction; opaque resource URIs (`urn:example:document`, `custom:item`) are recognized by the `read` and `omp read` resolver gates instead of falling through to filesystem handling; and a failing `resources/templates/list` no longer discards a successful `resources/list`, which previously produced a false missing-resource error.
- Fixed custom LSP servers sending `languageId: "plaintext"` for extensions outside the built-in language map by honoring an optional per-server `languageId` in `lsp.json` for disk and in-memory document opens ([#6800](https://github.com/can1357/oh-my-pi/issues/6800)).
- Fixed interactive extension confirmations ignoring `dialogOptions`, and cancelled handler-owned dialogs when the extension watchdog times out so stale approval UI cannot outlive a blocked tool call ([#6805](https://github.com/can1357/oh-my-pi/issues/6805)).
- Fixed the per-handler extension context snapshotting the live `ctx.model` getter, so a handler calling `pi.setModel()` and then reading `ctx.model` saw the stale model; the scoped context now delegates to the base context instead of spreading it.
- Fixed Python cell errors (`$` commands and the eval tool) leaking runner-internal traceback frames. Cell syntax errors now render as the bare caret display with a `<cell>` filename instead of a `_handle_request_async`/`ast.parse` stack dump, and runtime tracebacks start at user code, matching the Ruby runner's user-frame filtering.
- Dropped unavailable forced tool choices through the queue rejection lifecycle and discarded their remaining sequence yields so a skipped force cannot disable tools on the next request ([#6543](https://github.com/can1357/oh-my-pi/pull/6543) by [@paralin](https://github.com/paralin)).
- Fixed identical MCP server connections discovered under direct and marketplace-plugin names spawning twice and duplicating mounted tool routes; distinct tools whose server names sanitize to the same route now keep the first registration and log both origins ([#6786](https://github.com/can1357/oh-my-pi/issues/6786)).
- Fixed `/usage` and the other large transcript command panels (`/session`, `/advisor status`, `/jobs`, `/changelog`, `/context`, `/memory view`) duplicating in native scrollback when invoked while an agent turn is streaming. These callsites mounted their finalized panel immediately via `present()` instead of deferring it until the turn ends via `presentCommandOutput()` (the path added in #5427 for `/tools`/`/mcp`), so the panel landed above a still-growing live block and was recommitted lower down ([#6767](https://github.com/can1357/oh-my-pi/issues/6767)).
- Fixed plan-mode task subagents unregistering extension-provided models, credentials, managers, and custom APIs from the shared parent `ModelRegistry` when restricted sessions intentionally skip extension loading ([#6783](https://github.com/can1357/oh-my-pi/issues/6783)).
- Fixed `/live` sideband WebSockets ignoring standard proxy environment variables and `NO_PROXY`, which left proxied sessions stuck while the rest of the Codex connection succeeded ([#6770](https://github.com/can1357/oh-my-pi/issues/6770)).
- Fixed the bash tool's `kill` builtin rejecting numeric signals and multiple process operands, stopping after the first failed target, and defaulting to `SIGKILL` instead of the standard `SIGTERM`. Negative PID operands (process groups per `kill(2)`) and the `--` end-of-options marker are now handled instead of being misparsed as signals ([#6779](https://github.com/can1357/oh-my-pi/issues/6779)).
- Fixed `learned.md` saves growing a blank line on every write (trailing-newline split artifact) and hoisting all headings/prose above all bullets, which re-scoped lessons under the wrong heading in hand-organized files. Saves are now byte-idempotent and preserve mixed Markdown ordering: non-list lines keep their positions, new lessons insert newest-first at the head of the first bullet run, and dedupe/cap operate on bullet lines in place.

## [17.1.5] - 2026-07-27

### Added

- Added a configurable per-request timeout for the `inspect_image` tool (`inspect_image.timeoutMs`, default 5 minutes; set to 0 to disable) so a stalled vision-model provider fails fast with a clear error instead of blocking until manual abort ([#4165](https://github.com/can1357/oh-my-pi/issues/4165)).

### Changed

- Reduced default startup resident memory by constructing the default-off ComputerTool ArkType schema only on first parameter access, then reusing it across tool instances without changing validation or tool behavior ([#6742](https://github.com/can1357/oh-my-pi/pull/6742) by [@usr-bin-roygbiv](https://github.com/usr-bin-roygbiv)).
- Reduced startup CPU and memory by loading the bundled changelog only when needed, while preserving source, npm bundle, standalone binary, and native absolute-path fallback resolution.
- Moved PTY log replay into the shared project launch broker, so normal CLI and Hub startup no longer load the xterm runtime while launch logs return validated rendered terminal rows.

### Fixed

- Fixed DeepSeek V4 Flash and Step 3.7 Flash models using hashline edit mode by default despite repeatedly misreading its range grammar; both now use the simpler replace-mode fallback unless explicitly overridden ([#6671](https://github.com/can1357/oh-my-pi/issues/6671)).
- Fixed an Ask form appearing while the main prompt contains a draft hiding that text and consuming the next in-flight keystroke. The draft now remains visible and keeps receiving input until it is submitted or cleared; only then do form controls activate ([#6737](https://github.com/can1357/oh-my-pi/issues/6737)).
- Fixed `glob` rejecting safe `memory://root/<directory>/**` patterns. Memory globs now resolve their directory prefix inside the project memory root while rejecting traversal and percent-encoded path separators across the complete glob path.
- Fixed `omp --resume <id>` prompting to fork sessions from another existing directory instead of switching the process and cwd-scoped settings into the resumed session's recorded directory ([#6752](https://github.com/can1357/oh-my-pi/issues/6752)).
- Fixed deferred CLI model roles resolving ambiguous bare model IDs to a preferred but unauthenticated provider instead of the authenticated provider selected by the eager path ([#6727](https://github.com/can1357/oh-my-pi/issues/6727)).
- Fixed Windows sessions crashing with an unhandled `EPIPE: broken pipe, write` when an LSP server closed its stdin between filesystem mutations; LSP writes now observe asynchronous `FileSink.write()` failures and route them through the existing request/notification failure path.
- Fixed the bash tool's `stat` builtin failing on native Windows with `stat: unsupported on this platform` (exit 1) for every invocation. The vendored `uu-stat` now ships a Windows-native backend that maps the GNU format directives onto `std::fs::Metadata`, the `windows_by_handle` metadata extensions (inode, hard-link count, and device via `GetFileInformationByHandle`), and the Win32 volume APIs for `--file-system` mode; Unix behavior is unchanged ([#6723](https://github.com/can1357/oh-my-pi/issues/6723)).
- Fixed auto-retry wedging the session after an assistant-tail removal miss: when a context rebuild recreated the failed turn's message object, the identity-keyed cleanup logged `assistant removal missed` but the retry still scheduled `continue()`, which rejected the terminal assistant error message locally (`Cannot continue from message role: assistant`) before any provider request — `auto_retry_end` never fired, the TUI kept showing retry progress, and the in-flight `prompt()` hung until a manual follow-up. The retry path now strips a still-failed assistant tail positionally after the backoff, and a continuation that still fails locally closes the retry saga with a failed `auto_retry_end` ([#5382](https://github.com/can1357/oh-my-pi/issues/5382)).
- Fixed native Anthropic web-search history being recursively truncated during session persistence or retained under a different user turn, preserving opaque replay bytes across reload and stripping them on reparent ([#6703](https://github.com/can1357/oh-my-pi/issues/6703)).
- Fixed malformed or temporarily unreadable `config.yml` files being treated as empty settings and then overwritten by the next setting change, which could permanently erase broker tokens, model roles, and provider configuration. Invalid YAML is now moved to a timestamped `.broken-*` backup, read failures abort without touching the source, pending changes remain retryable with the last successfully loaded settings, atomic writes preserve symlink targets and handle Windows `EPERM` replacement, concurrent startup failures are fully observed and quarantine races fail closed, and `omp config set/reset` waits for persistence before reporting success.
- Fixed mounted MCP tools being hard to invoke when server or plugin guidance names their original calls: sessions now include one bounded, exact original-name-to-`xd://` route map for every live mounted MCP tool—including servers without initialize instructions—and refresh it as catalogs change without disabling schema virtualization.
- Fixed `inspect_image` blocking indefinitely when the vision-model API stalls by combining the caller's abort signal with an `AbortSignal.timeout()` and surfacing a distinct timeout `ToolError` (separate from user-triggered abort) ([#4165](https://github.com/can1357/oh-my-pi/issues/4165)).
- Fixed MiMo models using hashline edit mode by default despite needing the same replace-mode fallback as Kimi. ([#3772](https://github.com/can1357/oh-my-pi/issues/3772))
- Fixed `omp` refusing to start on Windows when no `bash.exe` is discoverable — most visibly with scoop-installed Git, whose manifest shims `sh.exe`/`git.exe` but never `bash.exe`, so PATH lookup missed it. Startup threw `No bash shell found` while merely building the bash tool description, even though bash tool commands always execute in the embedded brush-core shell and need no host bash. Shell discovery now also checks `GIT_INSTALL_ROOT`, scoop and per-user Git for Windows install roots, and `sh.exe` on PATH, then falls back to `cmd.exe` for the spawn-only paths (interactive PTY, ACP client terminals) instead of failing; the cmd fallback is never used to wrap user-shell commands — brush runs the POSIX line directly.
- Added a selectable voice setting for `/live` realtime sessions ([#6566](https://github.com/can1357/oh-my-pi/issues/6566)).

## [17.1.4] - 2026-07-26

### Added

- `omp usage` now surfaces auto-disabled credentials as red `✗` tombstone rows (identity, how long ago, the shortened upstream cause — e.g. `Refresh token expired` — and a re-login hint), including a provider section when no active credential remains. User-driven tombstones (`replaced by newer credential`, `deleted by user`) and API-key rows stay hidden. Requires a broker with `GET /v1/credentials/disabled`; older brokers degrade to no tombstone rows.
- `omp usage` warns about Anthropic's ~30-day OAuth grant lifetime: accounts whose interactive login (`authorizedAt`) is within a week of the deadline get a yellow `⚠ re-login within <time>` line, and past-deadline accounts a red one. Grants die server-side exactly ~30 days after login regardless of refresh rotation, so this is the only warning before the broker auto-disables the row.

### Changed

- Enabled Computer Use sessions now state the desktop-routing contract in the compact system prompt, retain their controller across model switches, expose effective native/function routing through `/computer status`, and emit structured lifecycle diagnostics without logging captured content.

### Fixed

- Fixed dragging an image whose path contains unescaped spaces (e.g. macOS screenshot names like `Screenshot 2026-07-24 at 1.55.12 PM.png`) into the terminal — the bracketed-paste image extraction route now has the same whole-text-as-path fallback as the clipboard keybind route, so both routes share identical detection and attach the image instead of inserting the raw path as literal text ([#6578](https://github.com/can1357/oh-my-pi/issues/6578)). The shared fallback only claims payloads that hold a single path: one carrying a second absolute-path anchor after unescaped whitespace (`/tmp/a.png /tmp/b shot.png` — dragging two files at once when either name has spaces) now pastes as text on both routes instead of being fused into one unresolvable path, which on the clipboard route previously attached nothing and swallowed the text behind an "Image not found" status.
- Fixed transient reasonless request aborts that arrived after a tool call finished streaming ending the turn instead of entering recovery, which left edit calls and task subagents dead until the user manually resumed. The session now continues from the synthetic unexecuted tool result under the normal retry policy without replaying completed side effects ([#6668](https://github.com/can1357/oh-my-pi/issues/6668)).
- Fixed prewalk silently dropping a same-model hand-off that only lowers the thinking level: the arm/switch guard compared model identity alone and discarded the resolved `thinkingLevel`, so a legal effort-downgrade target (e.g. `prewalk: "@task"` resolving to the same model at a cheaper effort) never applied and the session paid the plan/continue nudges for nothing. Prewalk now compares `(provider, id, effective thinking level)`, applies effort-only hand-offs, and emits a notice on a genuine no-op instead of returning silently ([#6659](https://github.com/can1357/oh-my-pi/issues/6659)).
- Fixed `@czottmann/pi-automode` failing legacy extension validation because the pi-ai compatibility shim omitted `clampThinkingLevel`, then failing every classified tool call because `ctx.modelRegistry` omitted `getApiKeyAndHeaders`. ([#6648](https://github.com/can1357/oh-my-pi/issues/6648))
- Fixed hide-secrets placeholders conflicting with hashline edit headers by replacing hash-delimited tokens with the unambiguous `$$HASH$$` format ([#6631](https://github.com/can1357/oh-my-pi/issues/6631)).
- Fixed the advisor silently swallowing its own quarantined turns: when an advisor called an ungranted tool (e.g. `bash`) its whole turn was discarded before dispatch, so its advice never reached the primary agent and the failure surfaced only in advisor diagnostics — every other non-recovering failure branch notifies the host UI, but quarantine re-primed silently with no bound. A persistently-quarantining advisor now surfaces a `notifyFailure` warning in the main UI (deduped, cleared on the next successful turn) and stops the unbounded silent re-prime loop ([#6661](https://github.com/can1357/oh-my-pi/issues/6661)).
- Fixed the Docker `natives-builder` stage failing to build releases ≥ 17.1.1: the native audio stack added bindgen (miniaudio needs libclang) and a bundled-opus CMake build (needs cmake + make), none of which were installed in the slim builder image.
- Fixed a configured `modelRoles.default` naming an extension-registered model (listed in `enabledModels`) silently running on a different in-scope provider's model. The startup model scope is resolved before extensions call `registerProvider()`, so the default role dropped out of scope and `buildSessionOptions` pinned `options.model` to the first scoped model — which marked the model "explicit" and suppressed the post-extension default-role re-resolution. A configured default that can't be found in the startup scope is now deferred so it re-resolves against the fully registered, still `enabledModels`-scoped catalog once extensions load ([#6694](https://github.com/can1357/oh-my-pi/issues/6694)).
- Fixed Parakeet speech-to-text failing to load `sherpa-onnx-node` from Windows source workspaces when Bun installed the wrapper under `packages/coding-agent/node_modules` but hoisted its native platform package to the repository root ([#6690](https://github.com/can1357/oh-my-pi/issues/6690)).
- Fixed `omp usage` duplicating org-less legacy accounts as "no usage data" rows whenever any sibling report carried an organization (mixed pools of pre-org-capture rows and fresh org-scoped logins): an org-less account is now covered by its own org-less report, while org-attributed sibling reports still never count as its coverage.
- `omp usage` revalidates the broker credential snapshot before rendering: live usage reports were previously paired with a disk-cached account list up to an hour old, so a just-completed re-login (org-less row upserted to org-scoped) rendered as a phantom duplicate until the cache expired.
- Fixed Advisor requests reaching Anthropic-compatible endpoints without a provider-facing session identity: the separately constructed advisor `Agent` never had a metadata resolver installed, so its outbound requests omitted the `metadata.user_id` session id that the main and subagent agents carry. Each advisor now emits its own `advisorProviderSessionId` via `metadata.user_id`, resolved live so a token refresh surfaces the current `account_uuid`, giving Main, subagent, and Advisor traffic distinct, stable session ids for proxy routing and attribution ([#6625](https://github.com/can1357/oh-my-pi/issues/6625)).
- Todo progress now stays in sync when using Cursor models: the Cursor exec bridge mirrors the provider's server-owned todo list into session state, refreshes the interactive todo panel, and persists each snapshot to the session branch so the list survives reloads, rewinds, compaction, and session switches. Existing phase grouping is preserved for tasks the session already knows. Previously the list was in-memory only and the panel stayed stale, because Cursor resolves the todo tool remotely and never emits the local `todo` tool result that both paths key off.
- Cursor todo calls the server refuses or rejects no longer leave the todo card spinning: the bridge settles every completed native todo call, not just the ones carrying a list. Local phases and the session branch are left untouched in that case, and the settling result deliberately carries no `details.phases` — echoing the current list back would let a call that changed nothing overwrite live panel state.
- Fixed the todo renderer emitting mirrored label text verbatim. A Cursor snapshot carries provider-authored task content, phase names, and summary text, and the renderer interpolated all of it straight into terminal output, so a label holding ANSI/C0 sequences rewrote the terminal every time the list rendered or replayed. Every display path now goes through one sanitize-and-flatten-tabs helper — task labels, blocker notes, phase headers, the zero-task fallback, and the streaming call preview — while the raw values stay untouched as the lookup keys they are.
- Fixed a server-resolved Cursor todo card animating for the rest of the session when the server packed the call's start and completion into one HTTP/2 chunk. The bridge's `tool_execution_end` is a synchronous callback fired mid-parse, while the streamed `toolcall_start` that creates the visible card is queued on the event stream and delivered a microtask later — the interactive controller handled the completion first, found no pending card, and dropped it, leaving the card that appeared moments later with nothing to settle it. An early completion is now held and attached the moment the streamed block creates its card, settling it without repeating the panel refresh or failure warning that already fired on first arrival. Card creation from cumulative `message_update` frames is also guarded by the turn's timeline map, so a call settled mid-stream can no longer be recreated as a second, permanently pending card by the next update re-listing the same block.
- Cursor todo failures no longer render unsanitized provider text into the status line. The bridge forwards the server's error string verbatim, so an ANSI escape or other C0/C1 control reached the terminal intact and could repaint outside the row, tabs punched holes in the single-line warning, and a long message overflowed it. The detail is now stripped of control sequences, collapsed, and truncated at the render boundary; the persisted result keeps the full-fidelity error for the transcript.
- Fixed disabling the Advisor from `/settings` updating the persisted setting without stopping the live Advisor runtime until the session restarted: `SelectorController.handleSettingChange` had no case for `advisor.enabled`, unlike other session-managed toggles (`autoCompact`, `steeringMode`, ...), so the change never reached `session.setAdvisorEnabled`.
- Fixed `bash.patterns` `deny`/`prompt` rules matching only against the whole command string, so a dangerous command in any non-leading position of a compound line (e.g. `cd /tmp && rm -rf /tmp/x`, `sleep 1 & rm -rf /tmp/x`) silently bypassed a `deny` rule and, under `approvalMode: yolo`, executed with no prompt. `deny`/`prompt` rules now also match each command segment, split with a shell-aware tokenizer that honors every command boundary (`&&`, `||`, `;`, `|`, single `&`, subshells, newlines) and quoting; `allow` rules still require the whole command to match and never apply to compound lines ([#6695](https://github.com/can1357/oh-my-pi/issues/6695)).
- Fixed `omp config list` printing credential settings in plain text. `auth.broker.token`, `searxng.token`, `searxng.basicPassword` and `dev.autoqaPush.token` were disclosed in both the human and `--json` output of a command that dumps every value without anyone asking for a specific credential. Credentials are now marked in the schema with a top-level `credential` flag, which also covers settings that have no settings-panel entry and so cannot use `ui.secret`. Human output shows dots; JSON omits `value` and marks the entry `redacted` rather than substituting a placeholder a consumer could write back. `omp config get <path>` is unchanged, since that is an explicit request for one value. The settings panel now derives masking from the same flag, so a credential cannot render as plain text on one surface and dots on the other. Only a credential that is actually set is redacted, so a fresh configuration still reports unset credentials as unset rather than implying every one of them is configured.
- Fixed `/new`, `/drop`, `/fork`, and `/move` crashing or doing unnecessary work when invoked during vibe mode; interactive session transitions now show the existing exit-vibe warning and leave the session unchanged, and reset loops disable themselves instead of resubmitting into that unchanged session ([#6607](https://github.com/can1357/oh-my-pi/issues/6607)).
- Fixed legacy pi extensions failing extension validation when importing `estimateTokens` from `@earendil-works/pi-coding-agent` (aliased to the legacy shim). Legacy pi re-exported `estimateTokens` from its coding-agent package root; in omp it lives in `@oh-my-pi/pi-agent-core/compaction` and the coding-agent barrel does not forward it, so the shim's `export * from "../index"` left it off the surface and a named import threw Bun's static "Export named 'estimateTokens' not found" error (e.g. `omp plugin install pi-blackhole`). The shim now re-exports it ([#6583](https://github.com/can1357/oh-my-pi/issues/6583)).
- Fixed plan approval presenting a completed plan instead of the newest draft when the submitted title did not match the draft filename ([#6569](https://github.com/can1357/oh-my-pi/issues/6569)).
- Fixed `omp auth-gateway serve` advertising only the compiled-in bundled catalog, so every model omp reaches through provider discovery (e.g. ids released after the build date) was invisible on `/v1/models` and returned `Unknown model` through `/v1/chat/completions` even though the same broker credential answered it in the TUI. The gateway now sources its catalog from `ModelRegistry` — the same component the TUI/CLI use (bundled + cached + discovered) — keeping the credential scoping and qualified/bare-id registration, and rebuilds it periodically so a long-lived `serve` tracks newly discovered models without a restart ([#6615](https://github.com/can1357/oh-my-pi/issues/6615)).
- Fixed screenshot-relative pointer actions missing their visible targets when image transports that cannot preserve original detail silently downscaled a large computer screenshot; affected transports now establish the native coordinate frame below the verified image-resize threshold without changing the public capture defaults for other models ([#6596](https://github.com/can1357/oh-my-pi/pull/6596) by [@wolfiesch](https://github.com/wolfiesch)).
- Corrected Windows shell resolution errors to identify the active global, project, overlay, or runtime source for `shellPath`, including profile and custom configuration directories, instead of directing every user to the retired `settings.json` file ([#6579](https://github.com/can1357/oh-my-pi/issues/6579)).
- Fixed `debug` (js-debug/`pwa-node`) stateful commands misrouting after launch: a lazily-attached `[worker N]` child session (or the threadless root launcher) would steal the active-session focus from the stopped script child, so `threads` listed only the worker thread, post-launch breakpoints read back as pending/unbound, and there was no way to step/continue/evaluate the script's thread. Focus now follows stops rather than registrations, and `threads` aggregates every live thread across the session tree ([#6663](https://github.com/can1357/oh-my-pi/issues/6663)).
- Fixed a turn-ending provider error being truncated to 8 lines in the transcript with no way to reveal the rest: `AssistantMessageComponent` now implements `setExpanded`, so Ctrl+O (tool-output expansion) reveals the full error body and the collapsed view shows a `… +N more lines (Ctrl+O to expand)` hint ([#6555](https://github.com/can1357/oh-my-pi/issues/6555)).
- Fixed direct binary updates trusting an executable that only reported the expected version. The updater now selects one exact asset from the tagged GitHub release, requires its published SHA-256 digest and size, and verifies both while streaming the download before installation. GitHub release metadata requests use `GITHUB_TOKEN` or `GH_TOKEN` when available, allowing users behind an exhausted anonymous rate limit to authenticate.
- Documented that the non-PTY shell's bundled `jq` command is backed by jaq, including its null-indexing divergence and portable filter syntax ([#6614](https://github.com/can1357/oh-my-pi/issues/6614)).
- Fixed `omp://tools/task.md` and `omp://tools/eval.md` drifting from the 17.1.3 runtime: `task.md` claimed subagents force-disable `async.enabled`/`bash.autoBackground.enabled` (both are inherited from the parent since 17.1.0) and omitted the `task` tool's `effort` parameter, and `eval.md` omitted the still-working eval `agent(model=…)` per-call model selector ([#6594](https://github.com/can1357/oh-my-pi/issues/6594)).
- Fixed advisor retry amplification after transient Codex SSE socket closures by limiting each advisor-level try to one provider transport attempt.
- Fixed `omp update` aborting with `npm error EEXIST` on standalone binary installs whose directory coincides with the global npm/bun bin dir (for example `npm prefix -g` set to `~/.local`, which the installer also targets). The install-target resolver classified the binary as npm/bun-managed from directory containment alone, so `npm install -g` tried to replace a regular file its symlink step would clobber; it now treats a plain executable (not a symlink) in a package-manager bin dir as the standalone binary and self-updates it in place ([#6527](https://github.com/can1357/oh-my-pi/pull/6527) by [@am423](https://github.com/am423)).
- Fixed Codex subscription and proxy models being sent the unsupported native `{ type: "computer" }` declaration based only on model ID. They now receive the callable function-tool fallback, including after switching from native OpenAI Responses history, while explicit endpoint metadata can still opt into the GA contract. Explicit native Codex replays preserve `computer_call`/`computer_call_output` pairing, normal CLI startup keeps the native desktop worker graph lazy, and packaged workers re-enter the single CLI host without the computer module claiming non-computer selectors.
- Fixed isolated JavaScript eval subprocesses letting the global fatal-rejection handler race the cell rejection interceptor. A floated promise rejection is now folded into the owning cell result without killing its reusable worker process.
- Fixed `/context` counting hidden, explicit-only skills (`hide: true` / `disable-model-invocation`) in the Skills category and subtracting that inflated estimate from the first system-prompt block, which reported `System prompt: 0 tokens` and inflated Skills usage. Accounting now counts only the skills actually rendered into the system prompt — mirroring `buildSystemPrompt`'s filter, so hidden skills and all skills when the `read` tool is unavailable contribute zero ([#6498](https://github.com/can1357/oh-my-pi/issues/6498)).
- Fixed `pi-sprite` failing plugin validation because the legacy Pi compatibility shims omitted `createExtensionRuntime` and terminal capability/image-deletion helpers used by the extension ([#6506](https://github.com/can1357/oh-my-pi/issues/6506)).
- Fixed Escape waiting for an in-flight `session_stop` extension handler to exhaust its timeout; abort now cancels the active stop pass without reporting a false timeout or applying stale continuation context ([#6489](https://github.com/can1357/oh-my-pi/issues/6489)).
- Fixed the agent not resuming after re-answering a past `ask` from the session tree. Committing a new answer via `/tree` branched a fresh sibling `toolResult` and rebuilt context, but nothing ever continued the agent — unlike a live `ask`, whose continuation is intrinsic to the streaming run loop — so the model never consumed the new answer and the session sat idle until a manual prompt. `navigateTree` now reports the commit (`askReanswerCommitted`) and the interactive `/tree` handler resumes the agent via `resumeAfterAskReanswer()` *after* its transcript rebuild, so the resumed turn never renders against the stale pre-rebuild UI. Plain leaf moves and the read-only `reopenAsk` probe stay idle ([#6483](https://github.com/can1357/oh-my-pi/issues/6483)).
- Fixed Ctrl+C and fatal shutdown entering an `ExtensionExitError` rejection loop while an extension or hook was still loading ([#6488](https://github.com/can1357/oh-my-pi/issues/6488)).

## [17.1.3] - 2026-07-24

### Fixed

- Fixed the in-process `find` builtin's `-exec`/`-execdir` children inheriting the omp process's real stdout/stderr, so commands like `find … -exec ls -ld {} \;` spammed their output straight into the terminal (corrupting the TUI) instead of the tool's captured output, and bypassed shell redirects. Exec children now stream stdout/stderr back through the shell's scope streams (matching `xargs`/`ifne`) and run with the shell's exported environment (`env_clear` + scope snapshot) instead of the host process environment.
- Fixed `ast_edit` erroring with "`lang` is required" — an argument that no longer exists in the tool schema — when `paths` resolved to files of multiple languages (e.g. a crate directory with `.rs` + `.toml`). Mixed-language paths now rewrite per file: each file is parsed in its own inferred language, patterns are compiled per language, and a pattern that doesn't parse in some matched language simply skips those files.
- Fixed the `retain` tool's TUI renderer crashing when streaming arguments temporarily expose a non-array `items` value ([#6528](https://github.com/can1357/oh-my-pi/issues/6528)).
- Fixed Edit and Write tools failing with `Settings not initialized` in isolated sessions by using each tool session's settings for generated-file guards, with safe schema defaults for standalone guards and inline-image rendering ([#6549](https://github.com/can1357/oh-my-pi/issues/6549)).

## [17.1.2] - 2026-07-24

### Added

- Added in-process moreutils-style shell builtins to the bash tool's embedded shell: `ts` (timestamp lines; `-i`/`-s` elapsed modes, `-m` monotonic clock, `-r` relative rewriting of RFC3339/syslog timestamps, `%.S`/`%.s`/`%.T` subsecond extensions), `sponge` (soak stdin fully before atomically writing the target, so `foo file | ... | sponge file` works; `-a` appends), `ifne` (run a command only when stdin is non-empty; `-n` inverts and passes non-empty stdin through), `isutf8` (streaming UTF-8 validation with line/char/byte diagnostics; `-q`, `-l`, `-i`), `combine` (boolean `and`/`not`/`or`/`xor` on the lines of two files, `-` for stdin), and `errno` (errno name/number/description lookup with `-l` list and `-s` search; unix only). Like the uutils-backed builtins, they run in-process against the command's own stdio, resolve paths against the shell working directory, honor cancellation, and are disabled by `PI_DISABLE_UUTILS_BUILTINS`.
- The bash tool prompt now lists the available shell builtins (`mkdir` through `jq`, `rm`/`mv`/`ln`, and the moreutils set) so the model relies on them without existence checks; the line is dropped when `PI_DISABLE_UUTILS_BUILTINS` disables the builtins and omits unix-only `errno` on Windows.
- Sessions using a broker-backed auth store now report each completed request's token usage and cost to the auth broker (batched, 10s cadence) so the broker can track actual token burn per client install
- Added a per-spawn `effort` parameter to the `task` tool (`"lo"` | `"med"` | `"hi"`): each selector maps onto the resolved model's supported thinking range (lowest, middle, and highest level — whatever the model tops out at, e.g. `high`, `xhigh`, or `max`) and overrides the agent's default selector, including `auto`. Omitting `effort` keeps the existing automatic per-prompt thinking classification.
- Added `searxng.engines` setting for the SearXNG web search provider: a comma-separated list of engine names or bang shortcuts (e.g. `ddg, br, startpage`) sent as the API's `engines=` parameter. Shortcuts are resolved to canonical engine names via the instance's `/config` endpoint (cached per endpoint; entries pass through verbatim if `/config` is unreachable). Bang syntax in queries (`!ddg foo`) continues to pass through to the instance, and external bangs (`!!g`) are now stripped client-side since SearXNG answers them with an HTTP redirect even for JSON requests.
- Web search queries now understand Google-style directives on every provider: `site:`/`-site:` (plus `domain:`/`host:` aliases), `after:`/`before:`/`since:`/`until:` date bounds, `inurl:`/`intitle:`/`intext:`/`allin*:`, `filetype:`/`ext:`, `lang:`, quoted phrases (including smart quotes), `+term`, `-`/`NOT` exclusions, and `OR`/`|` groups. A shared parser (`web/search/query.ts`) structures the query once per request; each provider maps constraints onto native API filters where the upstream supports them (Perplexity domain/date/language filters on both the API-key and ask paths, Tavily `include_domains`/`exclude_domains` + `start_date`/`end_date`, Exa domain lists + published-date bounds on API and MCP paths, Anthropic `allowed_domains`/`blocked_domains`, xAI `filters.allowed_domains`/`excluded_domains`, Parallel `source_policy`, Brave absolute `freshness` ranges, Firecrawl `tbs=cdr` date ranges, Jina `X-Site`, SearXNG `language`) and otherwise re-emits only the operator syntax its engine parses (full Google syntax for Gemini grounding, OpenAI, Kagi, and the credential-free scrapers — with scraper-hostile path-`site:`/`inurl:` operators demoted to plain keywords; conservative subsets for DuckDuckGo, Mojeek, Kimi, Z.AI, TinyFish, and Synthetic). The pipeline then applies a lenient post-filter to every response: constraints the engine ignored are enforced on the returned sources, and any constraint dimension that would eliminate every result is relaxed and reported to the model (`Note: no results matched \`site:...\`; the constraint was relaxed`) instead of returning nothing. Directive-free queries are passed through byte-identical everywhere.
- Eval and browser `run` code previews are now prettified for display: minified/compact agent-written cells are expanded by conservative streaming formatters (Python, JavaScript, Ruby, Julia) that indent block structure, split statements, normalize operator spacing (JS), and expand object literals wider than 100 columns onto one property per line — purely for rendering, the executed source is untouched. The formatters handle in-flight prefixes (unterminated strings/comments/blocks) without inventing closers, and layout decisions are prefix-stable so already-rendered lines never reflow while a call streams.

### Changed

- Large pastes saved via the large-paste menu now insert `local://paste-N.md` references (previously `local://attachment-N`), so the saved paste carries a markdown extension and a clearer name.
- Raw SSE debug capture now trims over-budget events smartly instead of chopping off the tail: tool definitions inside `data:` payloads are compacted first (name kept, schema/description elided — often enough to keep the whole payload as valid JSON), and anything still over the 64k cap keeps its head and tail with a `: omp-debug-elided chars=N` comment marking the removed middle, so trailing fields like `usage` stay visible.
- The `web_search` tool prompt now tells the model to never search for content that is programmatically accessible or has a known URL (GitHub, known arXiv papers, Wikipedia pages, official docs) and to `read` the URL directly instead.

### Fixed

- Fixed `todo` calls that omit `op` hard-failing validation ("op must be operation to apply (was missing)"): the tool now validates leniently and infers the op for unambiguous payloads (`list` → `init`, `phase`+`items` → `append`, bare `items` on an empty list → `init`); `op` stays required in the schema, and ambiguous op-less calls surface the schema error as a retryable tool error.
- Fixed credential-free web search engines (SearXNG, DuckDuckGo, Google, Startpage, Ecosia, Mojeek, and the Public Web fan-out) returning zero results for queries with `site:` paths (e.g. `site:github.com/owner/repo`) or `inurl:` operators: scraper engines only match `site:` against a bare domain and DuckDuckGo ignores `inurl:` entirely, so such queries silently emptied the result set and fell through to the next provider in the chain. A shared `formatScraperQuery` formatter now structurally demotes path-carrying `site:` and all `inurl:` values to plain search terms (covering OR-grouped and quoted directives) while preserving bare-domain `site:` filters, negated operators, and each engine's supported syntax; the pipeline post-filter still enforces the demoted constraints on returned sources.
- Fixed `ast_edit` previews reading like applied edits to the model: the `⟨proposed⟩` badge was TUI-only, so the model-visible result (hashline header + `-`/`+` rows, identical to applied edit output) carried no staged-proposal signal. The preview result now leads with a "Staged as a proposal — files NOT modified yet" notice naming `xd://resolve`/`xd://reject`, the injected resolve reminder names the source tool, and the `ast_edit` tool prompt documents the two-phase flow.
- Fixed the `hub` launch `ps`/`list` response burying the active process behind every exited one and growing without bound in long-lived projects: the broker now lists non-terminal daemons first (oldest to newest) and caps exited/failed history at the 10 most recently exited, so the active launch is immediately visible and the response stays bounded. Broker recovery also preserves each already-terminal daemon's real exit time instead of overwriting it with the restart timestamp, so the history cap keeps the genuinely most-recently-exited processes after an idle-broker restart ([#6517](https://github.com/can1357/oh-my-pi/issues/6517)).
- Fixed a tool call rendering twice in the transcript. A mid-stream `rebuildChatFromMessages` (from `/shake`, auto-compaction, or a settings toggle) preserves the live `pendingTools` components across the clear+replay, but that preservation assumed every pending-tool component was still dangling. When a tool's result had already landed in the session entries while its component still lingered in `pendingTools`, the replay reconstructed the completed block *and* the preserved live component was re-appended, so the same block appeared twice; resolved components are now dropped from preservation and owned by the replay ([#6516](https://github.com/can1357/oh-my-pi/issues/6516)).
- Fixed `--model default` (and other bare role names) resolving to the bundled `cursor/default` catalog model instead of the configured `modelRoles.default` role. `resolveCliModel`'s exact-match phase ran its unauthenticated catalog fallback before role resolution, so a bundled id colliding with a reserved role name shadowed a configured, runnable role — failing with `No API key found for cursor` on machines without Cursor credentials. The catalog fallback is now deferred so an authenticated exact model still wins, a configured role beats an unauthenticated catalog-only id, and the catalog id is still recovered when no role matches ([#6508](https://github.com/can1357/oh-my-pi/issues/6508)).

### Removed

- Removed the `model` parameter from `task` and `agent()`: explicit per-spawn model selectors and fallback chains are no longer supported; spawns always use the agent's configured model

## [17.1.1] - 2026-07-24

### Added

- Added the `/session pin` subcommand and account picker to pin provider OAuth accounts for the current session
- Added the disabled-by-default `computer` essential tool with configurable enablement, backend, display, and maximum width/height settings. Native desktop execution runs through a `DesktopSession` worker; observation uses read approval, input uses exec approval, and provider checks always prompt and fail closed.
- Added the `/computer` slash command (`on`/`off`/`status`/toggle) to enable or disable the computer tool for the current session without persisting settings.
- Exposed `computer` to models without native OpenAI computer-use support as a regular function tool with a typed GA action schema; the same native desktop backend and approval policy apply on both paths.
- Hardened computer action ingress: action-specific fields, modifier/key arrays, coordinates, drag points, and scroll deltas fail closed before native input; numeric fields must be signed 32-bit integers and coordinates must be non-negative.

### Changed

- Replaced Chromium-backed `/live` media and external speech recorder/player subprocesses with the cross-platform native microphone, speaker, Opus, and WebRTC stack from `@oh-my-pi/pi-natives`.

### Fixed

- Fixed live-call attestation depending on the ChatGPT desktop app being installed: `generateLiveAttestation` now mints DeviceCheck tokens in-process through the `@oh-my-pi/pi-natives` `deviceCheckGenerateToken` binding instead of probing `/Applications` for the app's `devicecheck.node` addon, so the `x-oai-attestation` header works on hosts without the desktop app and drops the `createRequire` addon probing; the attestation provider is now wired up to `@oh-my-pi/pi-ai` for ChatGPT-OAuth Codex requests.
- Fixed `xd://` device execution failures rendering as `write` errors instead of using the mounted tool's own error renderer.
- Fixed custom tools without bespoke renderers losing the default state-tinted card when mounted under `xd://`; dispatched calls now keep their label, arguments, status, output preview, and expansion affordance instead of dumping a bare result line into the transcript.
- Fixed the clipboard image-paste keybind mangling copied URL text into a bogus path error on macOS (e.g. `Image not found at /https/::i.can.ac:CE4Ek3.png` for a copied `https://i.can.ac/CE4Ek3.png`). AppleScript's `the clipboard as «class furl»` coerces plain *text* into a file URL by treating the string as an HFS path (`:`↔`/` swap), so `readMacFileUrlsFromClipboard` returned a garbage path that dead-ended in `handleImagePathPaste` instead of falling through to the text paste. The script now bails early via `clipboard info for «class furl»` unless the pasteboard actually carries a `public.file-url` representation, so URL/text clipboards paste as text.
- Fixed spilled tool-output artifact descriptors leaking on error/abort paths. `OutputSink.dump()` was the only path that closed the spill `Bun.FileSink`, but the bash and Python executors re-throw on failure and their `finally` blocks never closed the sink, so a large-output command that errored leaked the artifact descriptor until an unrelated read (e.g. a `SKILL.md` load) hit `EMFILE`. `OutputSink` now exposes an idempotent `dispose()` that closes the sink exactly once, wired into every executor's `finally` ([#6463](https://github.com/can1357/oh-my-pi/issues/6463)).
- Fixed the first submitted prompt stalling while the lo…232152 tokens truncated…irectory. ([#239](https://github.com/badlogic/pi-mono/pull/239) by [@aliou](https://github.com/aliou))
- **Kitty keyboard protocol on Linux**: Fixed keyboard input not working in Ghostty on Linux when Num Lock is enabled. The Kitty protocol includes Caps Lock and Num Lock state in modifier values, which broke key detection. Now correctly masks out lock key bits when matching keyboard shortcuts. ([#243](https://github.com/badlogic/pi-mono/issues/243))
- **Emoji deletion and cursor movement**: Backspace, Delete, and arrow keys now correctly handle multi-codepoint characters like emojis. Previously, deleting an emoji would leave partial bytes, corrupting the editor state. ([#240](https://github.com/badlogic/pi-mono/issues/240))

## [0.24.0] - 2025-12-19

### Added

- **Subagent orchestration example**: Added comprehensive custom tool example for spawning and orchestrating sub-agents with isolated context windows. Includes scout/planner/reviewer/worker agents and workflow commands for multi-agent pipelines. ([#215](https://github.com/badlogic/pi-mono/pull/215) by [@nicobailon](https://github.com/nicobailon))
- **`getMarkdownTheme()` export**: Custom tools can now import `getMarkdownTheme()` from `@oh-my-pi/pi-coding-agent` to use the same markdown styling as the main UI.
- **`pi.exec()` signal and timeout support**: Custom tools and hooks can now pass `{ signal, timeout }` options to `pi.exec()` for cancellation and timeout handling. The result includes a `killed` flag when the process was terminated.
- **Kitty keyboard protocol support**: Shift+Enter, Alt+Enter, Shift+Tab, Ctrl+D, and all Ctrl+key combinations now work in Ghostty, Kitty, WezTerm, and other modern terminals. ([#225](https://github.com/badlogic/pi-mono/pull/225) by [@kim0](https://github.com/kim0))
- **Dynamic API key refresh**: OAuth tokens (GitHub Copilot, Anthropic OAuth) are now refreshed before each LLM call, preventing failures in long-running agent loops where tokens expire mid-session. ([#223](https://github.com/badlogic/pi-mono/pull/223) by [@kim0](https://github.com/kim0))
- **`/hotkeys` command**: Shows all keyboard shortcuts in a formatted table.
- **Markdown table borders**: Tables now render with proper top and bottom borders.

### Changed

- **Subagent example improvements**: Parallel mode now streams updates from all tasks. Chain mode shows all completed steps during streaming. Expanded view uses proper markdown rendering with syntax highlighting. Usage footer shows turn count.
- **Skills standard compliance**: Skills now adhere to the [Agent Skills standard](https://agentskills.io/specification). Validates name (must match parent directory, lowercase, max 64 chars), description (required, max 1024 chars), and frontmatter fields. Warns on violations but remains lenient. Prompt format changed to XML structure. Removed `{baseDir}` placeholder in favor of relative paths. ([#231](https://github.com/badlogic/pi-mono/issues/231))

### Fixed

- **JSON mode stdout flush**: Fixed race condition where `pi --mode json` could exit before all output was written to stdout, causing consumers to miss final events.
- **Symlinked tools, hooks, and slash commands**: Discovery now correctly follows symlinks when scanning for custom tools, hooks, and slash commands. ([#219](https://github.com/badlogic/pi-mono/pull/219), [#232](https://github.com/badlogic/pi-mono/pull/232) by [@aliou](https://github.com/aliou))

### Breaking Changes

- **Custom tools now require `index.ts` entry point**: Auto-discovered custom tools must be in a subdirectory with an `index.ts` file. The old pattern `~/.pi/agent/tools/mytool.ts` must become `~/.pi/agent/tools/mytool/index.ts`. This allows multi-file tools to import helper modules. Explicit paths via `--tool` or `settings.json` still work with any `.ts` file.
- **Hook `tool_result` event restructured**: The `ToolResultEvent` now exposes full tool result data instead of just text. ([#233](https://github.com/badlogic/pi-mono/pull/233))
  - Removed: `result: string` field
  - Added: `content: (TextContent | ImageContent)[]` - full content array
  - Added: `details: unknown` - tool-specific details (typed per tool via discriminated union on `toolName`)
  - `ToolResultEventResult.result` renamed to `ToolResultEventResult.text` (removed), use `content` instead
  - Hook handlers returning `{ result: "..." }` must change to `{ content: [{ type: "text", text: "..." }] }`
  - Built-in tool details types exported: `BashToolDetails`, `ReadToolDetails`, `GrepToolDetails`, `FindToolDetails`, `LsToolDetails`, `TruncationResult`
  - Type guards exported for narrowing: `isBashToolResult`, `isReadToolResult`, `isEditToolResult`, `isWriteToolResult`, `isGrepToolResult`, `isFindToolResult`, `isLsToolResult`

## [0.23.4] - 2025-12-18

### Added

- **Syntax highlighting**: Added syntax highlighting for markdown code blocks, read tool output, and write tool content. Uses cli-highlight with theme-aware color mapping and VS Code-style syntax colors. ([#214](https://github.com/badlogic/pi-mono/pull/214) by [@svkozak](https://github.com/svkozak))
- **Intra-line diff highlighting**: Edit tool now shows word-level changes with inverse highlighting when a single line is modified. Multi-line changes show all removed lines first, then all added lines.

### Fixed

- **Gemini tool result format**: Fixed tool result format for Gemini 3 Flash Preview which strictly requires `{ output: value }` for success and `{ error: value }` for errors. Previous format using `{ result, isError }` was rejected by newer Gemini models. ([#213](https://github.com/badlogic/pi-mono/issues/213), [#220](https://github.com/badlogic/pi-mono/pull/220))
- **Google baseUrl configuration**: Google provider now respects `baseUrl` configuration for custom endpoints or API proxies. ([#216](https://github.com/badlogic/pi-mono/issues/216), [#221](https://github.com/badlogic/pi-mono/pull/221) by [@theBucky](https://github.com/theBucky))
- **Google provider FinishReason**: Added handling for new `IMAGE_RECITATION` and `IMAGE_OTHER` finish reasons. Upgraded @google/genai to 1.34.0.

## [0.23.3] - 2025-12-17

### Fixed

- Check for compaction before submitting user prompt, not just after agent turn ends. This catches cases where user aborts mid-response and context is already near the limit.

### Changed

- Improved system prompt documentation section with clearer pointers to specific doc files for custom models, themes, skills, hooks, custom tools, and RPC.
- Cleaned up documentation:
  - `theme.md`: Added missing color tokens (`thinkingXhigh`, `bashMode`)
  - `skills.md`: Rewrote with better framing and examples
  - `hooks.md`: Fixed timeout/error handling docs, added import aliases section
  - `custom-tools.md`: Added intro with use cases and comparison table
  - `rpc.md`: Added missing `hook_error` event documentation
  - `README.md`: Complete settings table, condensed philosophy section, standardized OAuth docs
- Hooks loader now supports same import aliases as custom tools (`@sinclair/typebox`, `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-tui`, `@oh-my-pi/pi-coding-agent`).

### Breaking Changes

- **Hooks**: `turn_end` event's `toolResults` type changed from `AppMessage[]` to `ToolResultMessage[]`. If you have hooks that handle `turn_end` events and explicitly type the results, update your type annotations.

## [0.23.2] - 2025-12-17

### Fixed

- Fixed Claude models via GitHub Copilot re-answering all previous prompts in multi-turn conversations. The issue was that assistant message content was sent as an array instead of a string, which Copilot's Claude adapter misinterpreted. Also added missing `Openai-Intent: conversation-edits` header and fixed `X-Initiator` logic to check for any assistant/tool message in history. ([#209](https://github.com/badlogic/pi-mono/issues/209))
- Detect image MIME type via file magic (read tool and `@file` attachments), not filename extension.
- Fixed markdown tables overflowing terminal width. Tables now wrap cell contents to fit available width instead of breaking borders mid-row. ([#206](https://github.com/badlogic/pi-mono/pull/206) by [@kim0](https://github.com/kim0))

## [0.23.1] - 2025-12-17

### Fixed

- Fixed TUI performance regression caused by Box component lacking render caching. Built-in tools now use Text directly (like v0.22.5), and Box has proper caching for custom tool rendering.
- Fixed custom tools failing to load from `~/.pi/agent/tools/` when pi is installed globally. Module imports (`@sinclair/typebox`, `@oh-my-pi/pi-tui`, `@oh-my-pi/pi-ai`) are now resolved via aliases.

## [0.23.0] - 2025-12-17

### Added

- **Custom tools**: Extend pi with custom tools written in TypeScript. Tools can provide custom TUI rendering, interact with users via `pi.ui` (select, confirm, input, notify), and maintain state across sessions via `onSession` callback. See [docs/custom-tools.md](docs/custom-tools.md) and [examples/custom-tools/](examples/custom-tools/). ([#190](https://github.com/badlogic/pi-mono/issues/190))
- **Hook and tool examples**: Added `examples/hooks/` and `examples/custom-tools/` with working examples. Examples are now bundled in npm and binary releases.

### Breaking Changes

- **Hooks**: Replaced `session_start` and `session_switch` events with unified `session` event. Use `event.reason` (`"start" | "switch" | "clear"`) to distinguish. Event now includes `entries` array for state reconstruction.

## [0.22.5] - 2025-12-17

### Fixed

- Fixed `--session` flag not saving sessions in print mode (`-p`). The session manager was never receiving events because no subscriber was attached.

## [0.22.4] - 2025-12-17

### Added

- `--list-models [search]` CLI flag to list available models with optional fuzzy search. Shows provider, model ID, context window, max output, thinking support, and image support. Only lists models with configured API keys. ([#203](https://github.com/badlogic/pi-mono/issues/203))

### Fixed

- Fixed tool execution showing green (success) background while still running. Now correctly shows gray (pending) background until the tool completes.

## [0.22.3] - 2025-12-16

### Added

- **Streaming bash output**: Bash tool now streams output in real-time during execution. The TUI displays live progress with the last 5 lines visible (expandable with ctrl+o). ([#44](https://github.com/badlogic/pi-mono/issues/44))

### Changed

- **Tool output display**: When collapsed, tool output now shows the last N lines instead of the first N lines, making streaming output more useful.
- Updated `@oh-my-pi/pi-ai` with X-Initiator header support for GitHub Copilot, ensuring agent calls are not deducted from quota. ([#200](https://github.com/badlogic/pi-mono/pull/200) by [@kim0](https://github.com/kim0))

### Fixed

- Fixed editor text being cleared during compaction. Text typed while compaction is running is now preserved. ([#179](https://github.com/badlogic/pi-mono/issues/179))
- Improved RGB to 256-color mapping for terminals without truecolor support. Now correctly uses grayscale ramp for neutral colors and preserves semantic tints (green for success, red for error, blue for pending) instead of mapping everything to wrong cube colors.
- `/think off` now actually disables thinking for all providers. Previously, providers like Gemini with "dynamic thinking" enabled by default would still use thinking even when turned off. ([#180](https://github.com/badlogic/pi-mono/pull/180) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.22.2] - 2025-12-15

### Changed

- Updated `@oh-my-pi/pi-ai` with interleaved thinking enabled by default for Anthropic Claude 4 models.

## [0.22.1] - 2025-12-15

_Dedicated to Peter's shoulder ([@steipete](https://twitter.com/steipete))_

### Changed

- Updated `@oh-my-pi/pi-ai` with interleaved thinking support for Anthropic models.

## [0.22.0] - 2025-12-15

### Added

- **GitHub Copilot support**: Use GitHub Copilot models via OAuth login (`/login` -> "GitHub Copilot"). Supports both github.com and GitHub Enterprise. Models are sourced from models.dev and include Claude, GPT, Gemini, Grok, and more. All models are automatically enabled after login. ([#191](https://github.com/badlogic/pi-mono/pull/191) by [@cau1k](https://github.com/cau1k))

### Fixed

- Model selector fuzzy search now matches against provider name (not just model ID) and supports space-separated tokens where all tokens must match

## [0.21.0] - 2025-12-14

### Added

- **Inline image rendering**: Terminals supporting Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images now render images inline in tool output. Aspect ratio is preserved by querying terminal cell dimensions on startup. Toggle with `/show-images` command or `terminal.showImages` setting. Falls back to text placeholder on unsupported terminals or when disabled. ([#177](https://github.com/badlogic/pi-mono/pull/177) by [@nicobailon](https://github.com/nicobailon))
- **Gemini 3 Pro thinking levels**: Thinking level selector now works with Gemini 3 Pro models. Minimal/low map to Google's LOW, medium/high map to Google's HIGH. ([#176](https://github.com/badlogic/pi-mono/pull/176) by [@markusylisiurunen](https://github.com/markusylisiurunen))

### Fixed

- Fixed read tool failing on macOS screenshot filenames due to Unicode Narrow No-Break Space (U+202F) in timestamp. Added fallback to try macOS variant paths and consolidated duplicate expandPath functions into shared path-utils.ts. ([#181](https://github.com/badlogic/pi-mono/pull/181) by [@nicobailon](https://github.com/nicobailon))
- Fixed double blank lines rendering after markdown code blocks ([#173](https://github.com/badlogic/pi-mono/pull/173) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.20.1] - 2025-12-13

### Added

- **Exported skills API**: `loadSkillsFromDir`, `formatSkillsForPrompt`, and related types are now exported for use by other packages (e.g., mom).

## [0.20.0] - 2025-12-13

### Breaking Changes

- **Pi skills now use `SKILL.md` convention**: Pi skills must now be named `SKILL.md` inside a directory, matching Codex CLI format. Previously any `*.md` file was treated as a skill. Migrate by renaming `~/.pi/agent/skills/foo.md` to `~/.pi/agent/skills/foo/SKILL.md`.

### Added

- Display loaded skills on startup in interactive mode

## [0.19.1] - 2025-12-12

### Fixed

- Documentation: Added skills system documentation to README (setup, usage, CLI flags, settings)

## [0.19.0] - 2025-12-12

### Added

- **Skills system**: Auto-discover and load instruction files on-demand. Supports Claude Code (`~/.claude/skills/*/SKILL.md`), Codex CLI (`~/.codex/skills/`), and Pi-native formats (`~/.pi/agent/skills/`, `.pi/skills/`). Skills are listed in system prompt with descriptions, agent loads them via read tool when needed. Supports `{baseDir}` placeholder. Disable with `--no-skills` or `skills.enabled: false` in settings. ([#169](https://github.com/badlogic/pi-mono/issues/169))
- **Version flag**: Added `--version` / `-v` flag to display the current version and exit. ([#170](https://github.com/badlogic/pi-mono/pull/170))

## [0.18.2] - 2025-12-11

### Added

- **Auto-retry on transient errors**: Automatically retries requests when providers return overloaded, rate limit, or server errors (429, 500, 502, 503, 504). Uses exponential backoff (2s, 4s, 8s). Shows retry status in TUI with option to cancel via Escape. Configurable in `settings.json` via `retry.enabled`, `retry.maxRetries`, `retry.baseDelayMs`. RPC mode emits `auto_retry_start` and `auto_retry_end` events. ([#157](https://github.com/badlogic/pi-mono/issues/157))
- **HTML export line numbers**: Read tool calls in HTML exports now display line number ranges (e.g., `file.txt:10-20`) when offset/limit parameters are used, matching the TUI display format. Line numbers appear in yellow color for better visibility. ([#166](https://github.com/badlogic/pi-mono/issues/166))

### Fixed

- **Branch selector now works with single message**: Previously the branch selector would not open when there was only one user message. Now it correctly allows branching from any message, including the first one. This is needed for checkpoint hooks to restore state from before the first message. ([#163](https://github.com/badlogic/pi-mono/issues/163))
- **In-memory branching for `--no-session` mode**: Branching now works correctly in `--no-session` mode without creating any session files. The conversation is truncated in memory.
- **Git branch indicator now works in subdirectories**: The footer's git branch detection now walks up the directory hierarchy to find the git root, so it works when running pi from a subdirectory of a repository. ([#156](https://github.com/badlogic/pi-mono/issues/156))

## [0.18.1] - 2025-12-10

### Added

- **Mistral provider**: Added support for Mistral AI models. Set `MISTRAL_API_KEY` environment variable to use.

### Fixed

- Fixed print mode (`-p`) not exiting after output when custom themes are present (theme watcher now properly stops in print mode) ([#161](https://github.com/badlogic/pi-mono/issues/161))

## [0.18.0] - 2025-12-10

### Added

- **Hooks system**: TypeScript modules that extend agent behavior by subscribing to lifecycle events. Hooks can intercept tool calls, prompt for confirmation, modify results, and inject messages from external sources. Auto-discovered from `~/.pi/agent/hooks/*.ts` and `.pi/hooks/*.ts`. Thanks to [@nicobailon](https://github.com/nicobailon) for the collaboration on the design and implementation. ([#145](https://github.com/badlogic/pi-mono/issues/145), supersedes [#158](https://github.com/badlogic/pi-mono/pull/158))
- **`pi.send()` API**: Hooks can inject messages into the agent session from external sources (file watchers, webhooks, CI systems). If streaming, messages are queued; otherwise a new agent loop starts immediately.
- **`--hook <path>` CLI flag**: Load hook files directly for testing without modifying settings.
- **Hook events**: `session_start`, `session_switch`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `tool_call` (can block), `tool_result` (can modify), `branch`.
- **Hook UI primitives**: `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`, `ctx.ui.notify()` for interactive prompts from hooks.
- **Hooks documentation**: Full API reference at `docs/hooks.md`, shipped with npm package.

## [0.17.0] - 2025-12-09

### Changed

- **Simplified compaction flow**: Removed proactive compaction (aborting mid-turn when threshold approached). Compaction now triggers in two cases only: (1) overflow error from LLM, which compacts and auto-retries, or (2) threshold crossed after a successful turn, which compacts without retry.
- **Compaction retry uses `Agent.continue()`**: Auto-retry after overflow now uses the new `continue()` API instead of re-sending the user message, preserving exact context state.
- **Merged turn prefix summary**: When a turn is split during compaction, the turn prefix summary is now merged into the main history summary instead of being stored separately.

### Added

- **`isCompacting` property on AgentSession**: Check if auto-compaction is currently running.
- **Session compaction indicator**: When resuming a compacted session, displays "Session compacted N times" status message.

### Fixed

- **Block input during compaction**: User input is now blocked while auto-compaction is running to prevent race conditions.
- **Skip error messages in usage calculation**: Context size estimation now skips both aborted and error messages, as neither have valid usage data.

## [0.16.0] - 2025-12-09

### Breaking Changes

- **New RPC protocol**: The RPC mode (`--mode rpc`) has been completely redesigned with a new JSON protocol. The old protocol is no longer supported. See [`docs/rpc.md`](docs/rpc.md) for the new protocol documentation and [`test/rpc-example.ts`](test/rpc-example.ts) for a working example. Includes `RpcClient` TypeScript class for easy integration. ([#91](https://github.com/badlogic/pi-mono/issues/91))

### Changed

- **README restructured**: Reorganized documentation from 30+ flat sections into 10 logical groups. Converted verbose subsections to scannable tables. Consolidated philosophy sections. Reduced size by ~60% while preserving all information.

## [0.15.0] - 2025-12-09

### Changed

- **Major code refactoring**: Restructured codebase for better maintainability and separation of concerns. Moved files into organized directories (`core/`, `modes/`, `utils/`, `cli/`). Extracted `AgentSession` class as central session management abstraction. Split `main.ts` and `tui-renderer.ts` into focused modules. See `DEVELOPMENT.md` for the new code map. ([#153](https://github.com/badlogic/pi-mono/issues/153))

## [0.14.2] - 2025-12-08

### Added

- `/debug` command now includes agent messages as JSONL in the output

### Fixed

- Fix crash when bash command outputs binary data (e.g., `curl` downloading a video file)

## [0.14.1] - 2025-12-08

### Fixed

- Fix build errors with tsgo 7.0.0-dev.20251208.1 by properly importing `ReasoningEffort` type

## [0.14.0] - 2025-12-08

### Breaking Changes

- **Custom themes require new color tokens**: Themes must now include `thinkingXhigh` and `bashMode` color tokens. The theme loader provides helpful error messages listing missing tokens. See built-in themes (dark.json, light.json) for reference values.

### Added

- **OpenAI compatibility overrides in models.json**: Custom models using `openai-completions` API can now specify a `compat` object to override provider quirks (`supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `maxTokensField`). Useful for LiteLLM, custom proxies, and other non-standard endpoints. ([#133](https://github.com/badlogic/pi-mono/issues/133), thanks @fink-andreas for the initial idea and PR)
- **xhigh thinking level**: Added `xhigh` thinking level for OpenAI codex-max models. Cycle through thinking levels with Shift+Tab; `xhigh` appears only when using a codex-max model. ([#143](https://github.com/badlogic/pi-mono/issues/143))
- **Collapse changelog setting**: Add `"collapseChangelog": true` to `~/.pi/agent/settings.json` to show a condensed "Updated to vX.Y.Z" message instead of the full changelog after updates. Use `/changelog` to view the full changelog. ([#148](https://github.com/badlogic/pi-mono/issues/148))
- **Bash mode**: Execute shell commands directly from the editor by prefixing with `!` (e.g., `!ls -la`). Output streams in real-time, is added to the LLM context, and persists in session history. Supports multiline commands, cancellation (Escape), truncation for large outputs, and preview/expand toggle (Ctrl+O). Also available in RPC mode via `{"type":"bash","command":"..."}`. ([#112](https://github.com/badlogic/pi-mono/pull/112), original implementation by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.13.2] - 2025-12-07

### Changed

- **Tool output truncation**: All tools now enforce consistent truncation limits with actionable notices for the LLM. ([#134](https://github.com/badlogic/pi-mono/issues/134))
  - **Limits**: 2000 lines OR 50KB (whichever hits first), never partial lines
  - **read**: Shows `[Showing lines X-Y of Z. Use offset=N to continue]`. If first line exceeds 50KB, suggests bash command
  - **bash**: Tail truncation with temp file. Shows `[Showing lines X-Y of Z. Full output: /tmp/...]`
  - **grep**: Pre-truncates match lines to 500 chars. Shows match limit and line truncation notices
  - **find/ls**: Shows result/entry limit notices
  - TUI displays truncation warnings in yellow at bottom of tool output (visible even when collapsed)

## [0.13.1] - 2025-12-06

### Added

- **Flexible Windows shell configuration**: The bash tool now supports multiple shell sources beyond Git Bash. Resolution order: (1) custom `shellPath` in settings.json, (2) Git Bash in standard locations, (3) any bash.exe on PATH. This enables Cygwin, MSYS2, and other bash environments. Configure with `~/.pi/agent/settings.json`: `{"shellPath": "C:\\cygwin64\\bin\\bash.exe"}`.

### Fixed

- **Windows binary detection**: Fixed Bun compiled binary detection on Windows by checking for URL-encoded `%7EBUN` in addition to `$bunfs` and `~BUN` in `import.meta.url`. This ensures the binary correctly locates supporting files (package.json, themes, etc.) next to the executable.

## [0.12.15] - 2025-12-06

### Fixed

- **Editor crash with emojis/CJK characters**: Fixed crash when pasting or typing text containing wide characters (emojis like ✅, CJK characters) that caused line width to exceed terminal width. The editor now uses grapheme-aware text wrapping with proper visible width calculation.

## [0.12.14] - 2025-12-06

### Added

- **Double-Escape Branch Shortcut**: Press Escape twice with an empty editor to quickly open the `/branch` selector for conversation branching.

## [0.12.13] - 2025-12-05

### Changed

- **Faster startup**: Version check now runs in parallel with TUI initialization instead of blocking startup for up to 1 second. Update notifications appear in chat when the check completes.

## [0.12.12] - 2025-12-05

### Changed

- **Footer display**: Token counts now use M suffix for millions (e.g., `10.2M` instead of `10184k`). Context display shortened from `61.3% of 200k` to `61.3%/200k`.

### Fixed

- **Multi-key sequences in inputs**: Inputs like model search now handle multi-key sequences identically to the main prompt editor. ([#122](https://github.com/badlogic/pi-mono/pull/122) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Line wrapping escape codes**: Fixed underline style bleeding into padding when wrapping long URLs. ANSI codes now attach to the correct content, and line-end resets only turn off underline (preserving background colors). ([#109](https://github.com/badlogic/pi-mono/issues/109))

### Added

- **Fuzzy search models and sessions**: Implemented a simple fuzzy search for models and sessions (e.g., `codexmax` now finds `gpt-5.1-codex-max`). ([#122](https://github.com/badlogic/pi-mono/pull/122) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Prompt History Navigation**: Browse previously submitted prompts using Up/Down arrow keys when the editor is empty. Press Up to cycle through older prompts, Down to return to newer ones or clear the editor. Similar to shell history and Claude Code's prompt history feature. History is session-scoped and stores up to 100 entries. ([#121](https://github.com/badlogic/pi-mono/pull/121) by [@nicobailon](https://github.com/nicobailon))
- **`/resume` Command**: Switch to a different session mid-conversation. Opens an interactive selector showing all available sessions. Equivalent to the `--resume` CLI flag but can be used without restarting the agent. ([#117](https://github.com/badlogic/pi-mono/pull/117) by [@hewliyang](https://github.com/hewliyang))

## [0.12.11] - 2025-12-05

### Changed

- **Compaction UI**: Simplified collapsed compaction indicator to show warning-colored text with token count instead of styled banner. Removed redundant success message after compaction. ([#108](https://github.com/badlogic/pi-mono/issues/108))

### Fixed

- **Print mode error handling**: `-p` flag now outputs error messages and exits with code 1 when requests fail, instead of silently producing no output.
- **Branch selector crash**: Fixed TUI crash when user messages contained Unicode characters (like `✔` or `›`) that caused line width to exceed terminal width. Now uses proper `truncateToWidth` instead of `substring`.
- **Bash output escape sequences**: Fixed incomplete stripping of terminal escape sequences in bash tool output. `stripAnsi` misses some sequences like standalone String Terminator (`ESC \`), which could cause rendering issues when displaying captured TUI output.
- **Footer overflow crash**: Fixed TUI crash when terminal width is too narrow for the footer stats line. The footer now truncates gracefully instead of overflowing.

### Added

- **`authHeader` option in models.json**: Custom providers can set `"authHeader": true` to automatically add `Authorization: Bearer <apiKey>` header. Useful for providers that require explicit auth headers. ([#81](https://github.com/badlogic/pi-mono/issues/81))
- **`--append-system-prompt` Flag**: Append additional text or file contents to the system prompt. Supports both inline text and file paths. Complements `--system-prompt` for layering custom instructions without replacing the base system prompt. ([#114](https://github.com/badlogic/pi-mono/pull/114) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Thinking Block Toggle**: Added `Ctrl+T` shortcut to toggle visibility of LLM thinking blocks. When toggled off, shows a static "Thinking..." label instead of full content. Useful for reducing visual clutter during long conversations. ([#113](https://github.com/badlogic/pi-mono/pull/113) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.12.10] - 2025-12-04

### Added

- Added `gpt-5.1-codex-max` model support

## [0.12.9] - 2025-12-04

### Added

- **`/copy` Command**: Copy the last agent message to clipboard. Works cross-platform (macOS, Windows, Linux). Useful for extracting text from rendered Markdown output. ([#105](https://github.com/badlogic/pi-mono/pull/105) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.12.8] - 2025-12-04

- Fix: Use CTRL+O consistently for compaction expand shortcut (not CMD+O on Mac)

## [0.12.7] - 2025-12-04

### Added

- **Context Compaction**: Long sessions can now be compacted to reduce context usage while preserving recent conversation history. ([#92](https://github.com/badlogic/pi-mono/issues/92), [docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md#context-compaction))
  - `/compact [instructions]`: Manually compact context with optional custom instructions for the summary
  - `/autocompact`: Toggle automatic compaction when context exceeds threshold
  - Compaction summarizes older messages while keeping recent messages (default 20k tokens) verbatim
  - Auto-compaction triggers when context reaches `contextWindow - reserveTokens` (default 16k reserve)
  - Compacted sessions show a collapsible summary in the TUI (toggle with `o` key)
  - HTML exports include compaction summaries as collapsible sections
  - RPC mode supports `{"type":"compact"}` command and auto-compaction (emits compaction events)
- **Branch Source Tracking**: Branched sessions now store `branchedFrom` in the session header, containing the path to the original session file. Useful for tracing session lineage.

## [0.12.5] - 2025-12-03

### Added

- **Forking/Rebranding Support**: All branding (app name, config directory, environment variable names) is now configurable via `piConfig` in `package.json`. Forks can change `piConfig.name` and `piConfig.configDir` to rebrand the CLI without code changes. Affects CLI banner, help text, config paths, and error messages. ([#95](https://github.com/badlogic/pi-mono/pull/95))

### Fixed

- **Bun Binary Detection**: Fixed Bun compiled binary failing to start after Bun updated its virtual filesystem path format from `%7EBUN` to `$bunfs`. ([#95](https://github.com/badlogic/pi-mono/pull/95))

## [0.12.4] - 2025-12-02

### Added

- **RPC Termination Safeguard**: When running as an RPC worker (stdin pipe detected), the CLI now exits immediately if the parent process terminates unexpectedly. Prevents orphaned RPC workers from persisting indefinitely and consuming system resources.

## [0.12.3] - 2025-12-02

### Fixed

- **Rate limit handling**: Anthropic rate limit errors now trigger automatic retry with exponential backoff (base 10s, max 5 retries). Previously these errors would abort the request immediately.
- **Usage tracking during retries**: Retried requests now correctly accumulate token usage from all attempts, not just the final successful one. Fixes artificially low token counts when requests were retried.

## [0.12.2] - 2025-12-02

### Changed

- Removed support for gpt-4.5-preview and o3 models (not yet available)

## [0.12.1] - 2025-12-02

### Added

- **Models**: Added support for OpenAI's new models:
  - `gpt-4.1` (128K context)
  - `gpt-4.1-mini` (128K context)
  - `gpt-4.1-nano` (128K context)
  - `o3` (200K context, reasoning model)
  - `o4-mini` (200K context, reasoning model)

## [0.12.0] - 2025-12-02

### Added

- **`-p, --print` Flag**: Run in non-interactive batch mode. Processes input message or piped stdin without TUI, prints agent response directly to stdout. Ideal for scripting, piping, and CI/CD integration. Exits after first response.
- **`-P, --print-streaming` Flag**: Like `-p`, but streams response tokens as they arrive. Use `--print-streaming --no-markdown` for raw unformatted output.
- **`--print-turn` Flag**: Continue processing tool calls and agent turns until the agent naturally finishes or requires user input. Combine with `-p` for complete multi-turn conversations.
- **`--no-markdown` Flag**: Output raw text without Markdown formatting. Useful when piping output to tools that expect plain text.
- **Streaming Print Mode**: Added internal `printStreaming` option for streaming output in non-TUI mode.
- **RPC Mode `print` Command**: Send `{"type":"print","content":"text"}` to get formatted print output via `print_output` events.
- **Auto-Save in Print Mode**: Print mode conversations are automatically saved to the session directory, allowing later resumption with `--continue`.
- **Thinking level options**: Added `--thinking-off`, `--thinking-minimal`, `--thinking-low`, `--thinking-medium`, `--thinking-high` flags for directly specifying thinking level without the selector UI.

### Changed

- **Simplified RPC Protocol**: Replaced the `prompt` wrapper command with direct message objects. Send `{"role":"user","content":"text"}` instead of `{"type":"prompt","message":"text"}`. Better aligns with message format throughout the codebase.
- **RPC Message Handling**: Agent now processes raw message objects directly, with `timestamp` auto-populated if missing.

## [0.11.9] - 2025-12-02

### Changed

- Change Ctrl+I to Ctrl+P for model cycling shortcut to avoid collision with Tab key in some terminals

## [0.11.8] - 2025-12-01

### Fixed

- Absolute glob patterns (e.g., `/Users/foo/**/*.ts`) are now handled correctly. Previously the leading `/` was being stripped, causing the pattern to be interpreted relative to the current directory.

## [0.11.7] - 2025-12-01

### Fixed

- Fix read path traversal vulnerability. Paths are now validated to prevent reading outside the working directory or its parents. The `read` tool can read from `cwd`, its ancestors (for config files), and all descendants. Symlinks are resolved before validation.

## [0.11.6] - 2025-12-01

### Fixed

- Fix `--system-prompt <path>` allowing the path argument to be captured by the message collection, causing "file not found" errors.

## [0.11.5] - 2025-11-30

### Fixed

- Fixed fatal error "Cannot set properties of undefined (setting '0')" when editing empty files in the `edit` tool.
- Simplified `edit` tool output: Shows only "Edited file.txt" for successful edits instead of verbose search/replace details.
- Fixed fatal error in footer rendering when token counts contain NaN values due to missing usage data.

## [0.11.4] - 2025-11-30

### Fixed

- Fixed chat rendering crash when messages contain preformatted/styled text (e.g., thinking traces with gray italic styling). The markdown renderer now preserves existing ANSI escape codes when they appear before inline elements.

## [0.11.3] - 2025-11-29

### Fixed

- Fix file drop functionality for absolute paths

## [0.11.2] - 2025-11-29

### Fixed

- Fixed TUI crash when pasting content containing tab characters. Tabs are now converted to 4 spaces before insertion.
- Fixed terminal corruption after exit when shell integration sequences (OSC 133) appeared in bash output. These sequences are now stripped along with other ANSI codes.

## [0.11.1] - 2025-11-29

### Added

- Added `fd` integration for file path autocompletion. Now uses `fd` for faster fuzzy file search

### Fixed

- Fixed keyboard shortcuts Ctrl+A, Ctrl+E, Ctrl+K, Ctrl+U, Ctrl+W, and word navigation (Option+Arrow) not working in VS Code integrated terminal and some other terminal emulators

## [0.11.0] - 2025-11-29

### Added

- **File-based Slash Commands**: Create custom reusable prompts as `.txt` files in `~/.pi/slash-commands/`. Files become `/filename` commands with first-line descriptions. Supports `{{selection}}` placeholder for referencing selected/attached content.
- **`/branch` Command**: Create conversation branches from any previous user message. Opens a selector to pick a message, then creates a new session file starting from that point. Original message text is placed in the editor for modification.
- **Unified Content References**: Both `@path` in messages and `--file path` CLI arguments now use the same attachment system with consistent MIME type detection.
- **Drag & Drop Files**: Drop files onto the terminal to attach them to your message. Supports multiple files and both text and image content.

### Changed

- **Model Selector with Search**: The `/model` command now opens a searchable list. Type to filter models by name, use arrows to navigate, Enter to select.
- **Improved File Autocomplete**: File path completion after `@` now supports fuzzy matching and shows file/directory indicators.
- **Session Selector with Search**: The `--resume` and `--session` flags now open a searchable session list with fuzzy filtering.
- **Attachment Display**: Files added via `@path` are now shown as "Attached: filename" in the user message, separate from the prompt text.
- **Tab Completion**: Tab key now triggers file path autocompletion anywhere in the editor, not just after `@` symbol.

### Fixed

- Fixed autocomplete z-order issue where dropdown could appear behind chat messages
- Fixed cursor position when navigating through wrapped lines in the editor
- Fixed attachment handling for continued sessions to preserve file references

## [0.10.6] - 2025-11-28

### Changed

- Show base64-truncated indicator for large images in tool output

### Fixed

- Fixed image dimensions not being read correctly from PNG/JPEG/GIF files
- Fixed PDF images being incorrectly base64-truncated in display
- Allow reading files from ancestor directories (needed for monorepo configs)

## [0.10.5] - 2025-11-28

### Added

- Full multimodal support: attach images (PNG, JPEG, GIF, WebP) and PDFs to prompts using `@path` syntax or `--file` flag

### Fixed

- `@`-references now handle special characters in file names (spaces, quotes, unicode)
- Fixed cursor positioning issues with multi-byte unicode characters in editor

## [0.10.4] - 2025-11-28

### Fixed

- Removed padding on first user message in TUI to improve visual consistency.

## [0.10.3] - 2025-11-28

### Added

- Added RPC mode (`--rpc`) for programmatic integration. Accepts JSON commands on stdin, emits JSON events on stdout. See [RPC mode documentation](https://github.com/nicobailon/pi-mono/blob/main/packages/coding-agent/README.md#rpc-mode) for protocol details.

### Changed

- Refactored internal architecture to support multiple frontends (TUI, RPC) with shared agent logic.

## [0.10.2] - 2025-11-26

### Added

- Added thinking level persistence. Default level stored in `~/.pi/settings.json`, restored on startup. Per-session overrides saved in session files.
- Added model cycling shortcut: `Ctrl+I` cycles through available models (or scoped models with `-m` flag).
- Added automatic retry with exponential backoff for transient API errors (network issues, 500s, overload).
- Cumulative token usage now shown in footer (total tokens used across all messages in session).
- Added `--system-prompt` flag to override default system prompt with custom text or file contents.
- Footer now shows estimated total cost in USD based on model pricing.

### Changed

- Replaced `--models` flag with `-m/--model` supporting multiple values. Specify models as `provider/model@thinking` (e.g., `anthropic/claude-sonnet-4-20250514@high`). Multiple `-m` flags scope available models for the session.
- Thinking level border now persists visually after selector closes.
- Improved tool result display with collapsible output (default collapsed, expand with `Ctrl+O`).

## [0.10.1] - 2025-11-25

### Added

- Add custom model configuration via `~/.pi/models.json`

## [0.10.0] - 2025-11-25

Initial public release.

### Added

- Interactive TUI with streaming responses
- Conversation session management with `--continue`, `--resume`, and `--session` flags
- Multi-line input support (Shift+Enter or Option+Enter for new lines)
- Tool execution: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `think`
- Thinking mode support for Claude with visual indicator and `/thinking` selector
- File path autocompletion with `@` prefix
- Slash command autocompletion
- `/export` command for HTML session export
- `/model` command for runtime model switching
- `/session` command for session statistics
- Model provider support: Anthropic (Claude), OpenAI, Google (Gemini)
- Git branch display in footer
- Message queueing during streaming responses
- OAuth integration for Gmail and Google Calendar access
- HTML export with syntax highlighting and collapsible sections

## [0.9.3] - 2025-11-24

### Added

- Added Anthropic Claude Opus 4.5 support

## [0.9.2] - 2025-11-24

### Fixed

- **Edit Tool Dollar Sign Bug**: Fixed critical bug in the `edit` tool where `String.replace()` was interpreting `$` as a special replacement pattern (e.g., `$$`, `$&`, `$'`). When trying to insert `$` into code (like adding a dollar sign to a template literal), the replacement would silently fail and produce unchanged content, but the tool would incorrectly report success. Now uses `indexOf` + `substring` for raw string replacement without special character interpretation. Also added verification that content actually changed, rejecting with a clear error if the replacement produces identical content. ([#53](https://github.com/badlogic/pi-mono/issues/53))

## [0.9.0] - 2025-11-21

### Added

- **`/clear` Command**: New slash command to reset the conversation context and start a fresh session. Aborts any in-flight agent work, clears all messages, and creates a new session file. ([#48](https://github.com/badlogic/pi-mono/pull/48))
- **Model Cycling with Thinking Levels**: The `--models` flag now supports thinking level syntax (e.g., `--models sonnet:high,haiku:low`). When cycling models with `Ctrl+P`, the associated thinking level is automatically applied. The first model in the scope is used as the initial model when starting a new session. Both model and thinking level changes are now saved to session and settings for persistence. ([#47](https://github.com/badlogic/pi-mono/pull/47))
- **`--thinking` Flag**: New CLI flag to set thinking level directly (e.g., `--thinking high`). Valid values: `off`, `minimal`, `low`, `medium`, `high`. Takes highest priority over all other thinking level sources. ([#45](https://github.com/badlogic/pi-mono/issues/45))

### Breaking

- **Interactive Mode with Initial Prompt**: Passing a prompt on the command line (e.g., `pi "List files"`) now starts interactive mode with the prompt pre-submitted, instead of exiting after completion. Use `--print` or `-p` to get the previous non-interactive behavior (e.g., `pi -p "List files"`). This matches Claude CLI (`-p`) and Codex (`exec`) behavior. ([#46](https://github.com/badlogic/pi-mono/issues/46))

### Fixed

- **Slash Command Autocomplete**: Fixed issue where pressing Enter on a highlighted slash command suggestion (e.g., typing `/mod` with `/model` highlighted) would submit the partial text instead of executing the selected command. Now Enter applies the completion and submits in one action. ([#49](https://github.com/badlogic/pi-mono/issues/49))
- **Model Matching Priority**: The `--models` flag now prioritizes exact matches over partial matches. Supports `provider/modelId` format (e.g., `openrouter/openai/gpt-5.1-codex`) for precise selection. Exact ID matches are tried before partial matching, so `--models gpt-5.1-codex` correctly selects `gpt-5.1-codex` instead of `openai/gpt-5.1-codex-mini`.
- **Markdown Link Rendering**: Fixed links with identical text and href (e.g., `https://github.com/badlogic/pi-mono/pull/48/files`) being rendered twice. Now correctly compares raw text instead of styled text (which contains ANSI codes) when determining if link text matches href.

## [0.8.5] - 2025-11-21

### Fixed

- **Path Completion Hanging**: Fixed catastrophic regex backtracking in path completion that caused the terminal to hang when text contained many `/` characters (e.g., URLs). Replaced complex regex with simple string operations. ([#18](https://github.com/badlogic/pi-mono/issues/18))
- **Autocomplete Arrow Keys**: Fixed issue where arrow keys would move both the autocomplete selection and the editor cursor simultaneously when the file selector list was shown.

## [0.8.4] - 2025-11-21

### Fixed

- **Read Tool Error Handling**: Fixed issue where the `read` tool would return errors as successful text content instead of throwing. Now properly throws errors for file not found and offset out of bounds conditions.

## [0.8.3] - 2025-11-21

### Improved

- **Export HTML**: Limited container width to 700px for better readability. Fixed message statistics to match `/session` command output with proper breakdown of User/Assistant/Tool Calls/Tool Results/Total messages.
- **Dark Theme**: Increased visibility of editor border (darkGray from #303030 to #505050) and thinking minimal indicator (from #4e4e4e to #6e6e6e).

## [0.8.0] - 2025-11-21

### Added

- **Theme System**: Full theming support with 44 customizable color tokens. Two built-in themes (`dark`, `light`) with auto-detection based on terminal background. Use `/theme` command to select themes interactively. Custom themes in `~/.pi/agent/themes/*.json` support live editing - changes apply immediately when the file is saved. Themes use RGB hex values for consistent rendering across terminals. VS Code users: set `terminal.integrated.minimumContrastRatio` to `1` for proper color rendering. See [Theme Documentation](docs/theme.md) for details.

## [0.7.29] - 2025-11-20

### Improved

- **Read Tool Display**: When the `read` tool is called with offset/limit parameters, the tool execution now displays the line range in a compact format (e.g., `read src/main.ts:100-200` for offset=100, limit=100).

## [0.7.28] - 2025-11-20

### Added

- **Message Queuing**: You can now send multiple messages while the agent is processing without waiting for the previous response to complete. Messages submitted during streaming are queued and processed based on your queue mode setting. Queued messages are shown in a pending area below the chat. Press Escape to abort and restore all queued messages to the editor. Use `/queue` to select between "one-at-a-time" (process queued messages sequentially, recommended) or "all" (process all queued messages at once). The queue mode setting is saved and persists across sessions. ([#15](https://github.com/badlogic/pi-mono/issues/15))

## [0.7.27] - 2025-11-20

### Fixed

- **Slash Command Submission**: Fixed issue where slash commands required two Enter presses to execute. Now pressing Enter on a slash command autocomplete suggestion immediately submits the command, while Tab still applies the completion for adding arguments. ([#30](https://github.com/badlogic/pi-mono/issues/30))
- **Slash Command Autocomplete**: Fixed issue where typing a typo then correcting it would not show autocomplete suggestions. Autocomplete now re-triggers when typing or backspacing in a slash command context. ([#29](https://github.com/badlogic/pi-mono/issues/29))

## [0.7.26] - 2025-11-20

### Added

- **Tool Output Expansion**: Press `Ctrl+O` to toggle between collapsed and expanded tool output display. Expands all tool call outputs (bash, read, write, etc.) to show full content instead of truncated previews. ([#31](https://github.com/badlogic/pi-mono/issues/31))
- **Custom Headers**: Added support for custom HTTP headers in `models.json` configuration. Headers can be specified at both provider and model level, with model-level headers overriding provider-level ones. This enables bypassing Cloudflare bot detection and other proxy requirements. ([#39](https://github.com/badlogic/pi-mono/issues/39))

### Fixed

- **Chutes AI Provider**: Fixed 400 errors when using Chutes AI provider. Added compatibility fixes for `store` field exclusion, `max_tokens` parameter usage, and system prompt role handling. ([#42](https://github.com/badlogic/pi-mono/pull/42) by [@butelo](https://github.com/butelo))
- **Mistral/Chutes Syntax Error**: Fixed syntax error in merged PR that used `iif` instead of `if`.
- **Anthropic OAuth Bug**: Fixed bug where `process.env.ANTHROPIC_API_KEY = undefined` set the env var to string "undefined" instead of deleting it. Now uses `delete` operator.

## [0.7.25] - 2025-11-20

### Added

- **Model Cycling**: Press `Ctrl+P` to quickly cycle through models. Use `--models` CLI argument to scope to specific models (e.g., `--models claude-sonnet,gpt-4o`). Supports pattern matching and smart version selection (prefers aliases over dated versions). ([#37](https://github.com/badlogic/pi-mono/pull/37) by [@fightbulc](https://github.com/fightbulc))

## [0.7.24] - 2025-11-20

### Added

- **Thinking Level Cycling**: Press `Shift+Tab` to cycle through thinking levels (off → minimal → low → medium → high) for reasoning-capable models. Editor border color changes to indicate current level (gray → blue → cyan → magenta).

## [0.7.23] - 2025-11-20

### Added

- **Update Notifications**: Interactive mode now checks for new versions on startup and displays a notification if an update is available.

### Changed

- **System Prompt**: Updated system prompt to instruct agent to output plain text summaries directly instead of using cat or bash commands to display what it did.

### Fixed

- **File Path Completion**: Removed 10-file limit in tab completion selector. All matching files and directories now appear in the completion list.
- **Absolute Path Completion**: Fixed tab completion for absolute paths (e.g., `/Applications`). Absolute paths in the middle of text (like "hey /") now complete correctly. Also fixed crashes when trying to stat inaccessible files (like macOS `.VolumeIcon.icns`) during directory traversal.

## [0.7.22] - 2025-11-19

### Fixed

- **Long Line Wrapping**: Fixed crash when rendering long lines without spaces (e.g., file paths). Long words now break character-by-character to fit within terminal width.

## [0.7.21] - 2025-11-19

### Fixed

- **Terminal Flicker**: Fixed flicker at bottom of viewport (especially editor component) in xterm.js-based terminals (VS Code, etc.) by using per-line clear instead of clear-to-end sequence.
- **Background Color Rendering**: Fixed black cells appearing at end of wrapped lines when using background colors. Completely rewrote text wrapping and background application to properly handle ANSI reset codes.
- **Tool Output**: Strip ANSI codes from bash/tool output before rendering to prevent conflicts with TUI styling.

## [0.7.20] - 2025-11-18

### Fixed

- **Message Wrapping**: Fixed word-based text wrapping for long lines in chat messages. Text now properly wraps at word boundaries while preserving ANSI styling (colors, bold, italic, etc.) across wrapped lines. Background colors now extend to the full width of each line. Empty lines in messages now render correctly with full-width background.

## [0.7.18] - 2025-11-18

### Fixed

- **Bash Tool Error Handling**: Bash tool now properly throws errors for failed commands (non-zero exit codes), timeouts, and aborted executions. This ensures tool execution components display with red background when bash commands fail.
- **Thinking Traces Styling**: Thinking traces now maintain gray italic styling throughout, even when containing inline code blocks, bold text, or other inline formatting

## [0.7.17] - 2025-11-18

### Added

- **New Model**: Added `gemini-3-pro-preview` to Google provider.
- **OAuth Authentication**: Added `/login` and `/logout` commands for OAuth-based authentication with Claude Pro/Max subscriptions. Tokens are stored in `~/.pi/agent/oauth.json` with 0600 permissions and automatically refreshed when expired. OAuth tokens take priority over API keys for Anthropic models.

### Fixed

- **Anthropic Aborted Thinking**: Fixed error when resubmitting assistant messages with incomplete thinking blocks (from aborted streams). Thinking blocks without valid signatures are now converted to text blocks with `<thinking>` delimiters, preventing API rejection.
- **Model Selector Loading**: Fixed models not appearing in `/model` selector until user started typing. Models now load asynchronously and re-render when available.
- **Input Paste Support**: Added bracketed paste mode support to `Input` component, enabling paste of long OAuth authorization codes.

## [0.7.16] - 2025-11-17

### Fixed

- **Tool Error Display**: Fixed edit tool (and all other tools) not showing error state correctly in TUI. Failed tool executions now properly display with red background and show the error message. Previously, the `isError` flag from tool execution events was not being passed to the UI component, causing all tool results to show with green (success) background regardless of whether they succeeded or failed.

## [0.7.15] - 2025-11-17

### Fixed

- **Anthropic OAuth Support**: Added support for `ANTHROPIC_OAUTH_TOKEN` environment variable. The agent now checks for OAuth tokens before falling back to API keys for Anthropic models, enabling OAuth-based authentication.

## [0.7.14] - 2025-11-17

### Fixed

- **Mistral API Compatibility**: Fixed compatibility with Mistral API by excluding the `store` field and using `max_tokens` instead of `max_completion_tokens`, and avoiding the `developer` role in system prompts.
- **Error Display**: Fixed error message display in assistant messages to include proper spacing before the error text.
- **Message Streaming**: Fixed missing `message_start` event when no partial message chunks were received during streaming.

## [0.7.13] - 2025-11-16

### Fixed

- **TUI Editor**: Fixed unicode input support for umlauts (äöü), emojis (😀), and other extended characters. Previously the editor only accepted ASCII characters (32-126). Now properly handles all printable unicode while still filtering out control characters. ([#20](https://github.com/badlogic/pi-mono/pull/20))

## [0.7.12] - 2025-11-16

### Added

- **Custom Models and Providers**: Support for custom models and providers via `~/.pi/agent/models.json` configuration file. Add local models (Ollama, vLLM, LM Studio) or any OpenAI-compatible, Anthropic-compatible, or Google-compatible API. File is reloaded on every `/model` selector open, allowing live updates without restart. ([#21](https://github.com/badlogic/pi-mono/issues/21))
- Added `gpt-5.1-codex` model to OpenAI provider (400k context, 128k max output, reasoning-capable).

### Changed

- **Breaking**: No longer hardcodes Anthropic/Claude as default provider/model. Now prefers sensible defaults per provider (e.g., `claude-sonnet-4-5` for Anthropic, `gpt-5.1-codex` for OpenAI), or requires explicit selection in interactive mode.
- Interactive mode now allows starting without a model, showing helpful error on message submission instead of failing at startup.
- Non-interactive mode (CLI messages, JSON, RPC) still fails early if no model or API key is available.
- Model selector now saves selected model as default in settings.json.
- `models.json` validation errors (syntax + schema) now surface with precise file/field info in both CLI and `/model` selector.
- Agent system prompt now includes absolute path to its own README.md for self-documentation.

### Fixed

- Fixed crash when restoring a session with a custom model that no longer exists or lost credentials. Now gracefully falls back to default model, logs the reason, and appends a warning message to the restored chat.
- Footer no longer crashes when no model is selected.

## [0.7.11] - 2025-11-16

### Changed

- The `/model` selector now filters models based on available API keys. Only models for which API keys are configured in environment variables are shown. This prevents selecting models that would fail due to missing credentials. A yellow hint is displayed at the top of the selector explaining this behavior. ([#19](https://github.com/badlogic/pi-mono/pull/19))

## [0.7.10] - 2025-11-14

### Added

- `/branch` command for creating conversation branches. Opens a selector showing all user messages in chronological order. Selecting a message creates a new session with all messages before the selected one, and places the selected message in the editor for modification or resubmission. This allows exploring alternative conversation paths without losing the current session. (fixes [#16](https://github.com/badlogic/pi-mono/issues/16))

## [0.7.9] - 2025-11-14

### Changed

- Editor: updated keyboard shortcuts to follow Unix conventions:
  - **Ctrl+W** deletes the previous word (stopping at whitespace or punctuation)
  - **Ctrl+U** deletes from cursor to start of line (at line start, merges with previous line)
  - **Ctrl+K** deletes from cursor to end of line (at line end, merges with next line)
  - **Option+Backspace** in Ghostty now behaves like **Ctrl+W** (delete word backwards)
  - **Cmd+Backspace** in Ghostty now behaves like **Ctrl+U** (delete to start of line)

## [0.7.8] - 2025-11-13

### Changed

- Updated README.md with `/changelog` slash command documentation

## [0.7.7] - 2025-11-13

### Added

- Automatic changelog display on startup in interactive mode. When starting a new session (not continuing/resuming), the agent will display all changelog entries since the last version you used. The last shown version is tracked in `~/.pi/agent/settings.json`.
- `/changelog` command to display the changelog in the TUI
- OpenRouter Auto Router model support ([#5](https://github.com/badlogic/pi-mono/pull/5))
- Windows Git Bash support with automatic detection and process tree termination ([#1](https://github.com/badlogic/pi-mono/pull/1))

### Changed

- **BREAKING**: Renamed project context file from `AGENT.md` to `AGENTS.md`. The system now looks for `AGENTS.md` or `CLAUDE.md` (with `AGENTS.md` preferred). Existing `AGENT.md` files will need to be renamed to `AGENTS.md` to continue working. (fixes [#9](https://github.com/badlogic/pi-mono/pull/9))
- **BREAKING**: Session file format changed to store provider and model ID separately instead of as a single `provider/modelId` string. Existing sessions will not restore the model correctly when resumed - you'll need to manually set the model again using `/model`. (fixes [#4](https://github.com/badlogic/pi-mono/pull/4))
- Improved Windows Git Bash detection logic with better error messages showing actual paths searched ([#13](https://github.com/badlogic/pi-mono/pull/13))

### Fixed

- Fixed markdown list rendering bug where bullets were not displayed when list items contained inline code with cyan color formatting
- Fixed context percentage showing 0% in footer when last assistant message was aborted ([#12](https://github.com/badlogic/pi-mono/issues/12))
- Fixed error message loss when `turn_end` event contains an error. Previously, errors in `turn_end` events (e.g., "Provider returned error" from OpenRouter Auto Router) were not captured in `agent.state.error`, making it appear as if the agent completed successfully. ([#6](https://github.com/badlogic/pi-mono/issues/6))

## [0.7.6] - 2025-11-13

Previous releases did not maintain a changelog.
