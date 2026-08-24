# Changelog

## [Unreleased]

### Added

- Added interactive Command Code API-key login with authenticated `/models` validation for the public Provider API.

## [18.0.4] - 2026-08-24

### Fixed

- Fixed Cursor tool calls through OpenAI-compatible authentication gateways losing arguments when complete argument maps are sent without streaming deltas ([#9479](https://github.com/can1357/oh-my-pi/issues/9479)).
- Fixed Cursor plan entitlement refusals repeatedly selecting ineligible accounts by scoping credential blocks to the requested model during rotation ([#9488](https://github.com/can1357/oh-my-pi/issues/9488)).
- Improved HTTP 413 error classification to accurately distinguish between payload/media size limits and token context window overflows, preventing inappropriate token compaction attempts and routing to correct recovery/fallback strategies ([#9235](https://github.com/can1357/oh-my-pi/issues/9235)).
- Fixed Cursor conversation rotation after aborts or mid-turn restarts to properly replay the last user message on a fresh conversation.

## [18.0.3] - 2026-08-23

### Fixed

- Fixed a Fireworks-hosted model aborting mid-generation with an HTTP 400 `Floating point NaN (not-a-number) is detected in generation` killing the turn instead of retrying; this model-side numerical fault is now classified transient and retried, matching the existing treatment of Copilot fleet-skew 400s ([#9458](https://github.com/can1357/oh-my-pi/issues/9458)).

## [18.0.2] - 2026-08-23

### Fixed

- Fixed OpenAI-compatible completions hosts that stream content then terminate with the `[DONE]` sentinel while omitting (or `null`ing) `finish_reason` failing every turn with `OpenAI completions stream closed before a finish_reason was received`; a `[DONE]`-terminated stream now finalizes as a clean stop and only a genuine transport EOF (no `[DONE]`, no finish reason) surfaces the incomplete-stream error ([#9433](https://github.com/can1357/oh-my-pi/issues/9433)).

## [18.0.1] - 2026-08-23

### Changed

- Broker-backed startup no longer blocks on a broker round trip when the encrypted snapshot cache is fresh: the credential store starts from the cached snapshot and the background snapshot stream revalidates immediately (stale-while-revalidate). First launches and expired caches still fail fast with the actionable broker error.

### Fixed

- Captured bounded Devin Connect trailer details and request-shape evidence for diagnosing intermittent `invalid_argument` stream rejections ([#4218](https://github.com/can1357/oh-my-pi/pull/9137) by [@Mustaqeem66](https://github.com/Mustaqeem66)).
- Fixed abandoned `auth-broker-snapshot.enc.*.tmp` files accumulating in the cache directory when a process exited mid-write; stale temp files are now swept on each cache write.
- Fixed Cursor GPT effort models failing with `not_found` on accounts that require the discovered effort-specific model id ([#9287](https://github.com/can1357/oh-my-pi/issues/9287)).
- Fixed thinking-loop detection going silent after the first streamed tool call, so Grok/xAI reasoning loops that continue after a tool call starts still abort and retry instead of spinning until you press Esc.
- Fixed Codex continuations, retries, and compaction replacing or dropping the turn-scoped sticky-routing token ([#9277](https://github.com/can1357/oh-my-pi/issues/9277)).
- Fixed Codex Responses append chains falling back to full-context replay when replay-sanitized assistant items differ only by output-only IDs or lifecycle status.
- Fixed Cursor usage reporting “no usage data” for plans without a numeric legacy request cap.
- Fixed DeepSeek models rejecting requests with HTTP 400 `unknown variant \`image_url\`, expected \`text\`` when screenshots or image-producing tool results are present in conversation history or when `model.input` claims vision capability; `convertMessages` in `openai-completions` now strips `image_url` content parts and injects non-vision image placeholders for all DeepSeek endpoints.
- Fixed `PI_PROXY` covering only provider streams: OAuth token refresh and login, usage probes, and model discovery went out through the bare global `fetch` and ignored it, so a region-blocked token endpoint answered `403 Request not allowed` (Anthropic `/v1/oauth/token`) and disabled the credential while the proxied stream itself worked. `installGlobalProxyFetch()` now routes the process-wide `fetch` through `PI_PROXY`; a per-request proxy such as `PI_PROXY_<PROVIDER>` still wins, and loopback / private-range / `NO_PROXY` targets stay direct.
- Fixed Anthropic inference ignoring every proxy setting. `coworkFetch` runs on `node:https`, whose Bun shim discards both `agent.createConnection` and `options.createConnection`: the CONNECT tunnel to `PI_PROXY` was built, TLS-negotiated, then abandoned, and the request dialed `api.anthropic.com` on the default route (measured at the proxy: 581 bytes of handshake, zero request bytes). On a region-blocked egress that returned `403 {"type":"forbidden","message":"Request not allowed"}` with the proxy apparently configured. Proxied requests now go through Bun's own `fetch`, which honors `init.proxy`, trading the Cowork TLS/header profile for a proxy that actually carries the traffic; the dead tunnel plumbing is gone from the transport. `node:http2` (Cursor) does honor `createConnection` and is unaffected.
- Fixed `cowork-fetch` capturing `globalThis.fetch` at module load, so a proxy wrapper installed later in startup was ignored on its fallback path.
- Cursor Connect end-stream failures now surface bounded server trailer details instead of opaque generic errors ([#9137](https://github.com/can1357/oh-my-pi/pull/9137) by [@Mustaqeem66](https://github.com/Mustaqeem66))
- Fixed Cursor sessions aborting on the next turn or during compaction after MCP tools returned numeric-looking string arguments ([#9394](https://github.com/can1357/oh-my-pi/issues/9394)).
- Fixed glyph tokenization crashing with `entries is not a function` when `Context.systemPrompt` arrived as a bare string (e.g. from legacy earendil-works extensions); it is now normalized to an array before iterating, matching every provider path ([#9384](https://github.com/can1357/oh-my-pi/issues/9384)).

### Added

- Added Amazon Bedrock Converse guardrail configuration with provider-scoped identifier, version, and trace settings.

## [18.0.0] - 2026-08-22

### Added

- Added reversible private-use glyph tokenization for Claude-compatible provider requests, including prompt notices, streamed response decoding, and safe handling of unresolved model-authored glyph tokens.

Older entries are archived in [packages/ai/CHANGELOG.md@c821261d1018](https://github.com/can1357/oh-my-pi/blob/c821261d10180d60bd96c1b7334227691c9e14f6/packages/ai/CHANGELOG.md).
