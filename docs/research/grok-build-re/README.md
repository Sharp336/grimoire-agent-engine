# Grok Build RE Dossier

Related product request: [can1357/oh-my-pi#4945](https://github.com/can1357/oh-my-pi/issues/4945).

**Status: DOSSIER_ONLY.** This document is behavior-evidence for a future separate Build-quota provider. It is **not** a ship of Build chat, Build auth, Build models, or Build usage code. Existing SuperGrok `xai-oauth` (including `xai-oauth/grok-build*`) is unchanged.

Redacted capture fixtures live under [`fixtures/`](fixtures/). Every header and body **value** was redacted before write; retained fields are names, lengths, schemas, hosts, methods, and paths. Public OAuth client identifiers are published only as redacted length metadata, not literal values.


## Executive summary — **DOSSIER_ONLY**

The official binary is an RE oracle only: `grok 0.2.93 (f00f96316d) [stable]`. Wave B confirms selected **request emission** and a production DNS/TCP destination, but it does not confirm production response contracts. In particular, a normal coding turn emitted `GET /v1/user?include=subscription` and `GET /v1/user` under loopback capture, yet no successful response body supplied residual, used, unit, or reset data. Item 6 therefore fails the plan's durable Build-usage gate. Items 1–7 are not all complete, so a Build provider MUST NOT ship. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]

**Decision:** publish this evidence dossier only. Do not implement Build auth, Build chat, Build usage, model registration, or error classification from the present evidence. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]

### Exit-criteria status matrix

| RE item | Status | Behavior evidence | Gate-relevant missing proof |
|---|---|---|---|
| 1. Auth | **partial** | Parseable official auth-store field shape, a usable stored session, authenticated emitted header names, and fake-key-only local failure before network. [Evidence: [`fixtures/auth-store-shape.json`](fixtures/auth-store-shape.json), [`fixtures/override-models-401.json`](fixtures/override-models-401.json), [`fixtures/api-key-differential.json`](fixtures/api-key-differential.json)] | Login/device flow, refresh wire, exact accepted/rejected production-auth semantics, and bare-key rejection at a real Build endpoint. |
| 2. Chat wire | **partial** | Loopback override emitted `POST /v1/responses` schemas; a `-m grok-build` production trace resolved and connected to `cli-chat-proxy.grok.com`. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json)] | Successful production HTTP status/body and whether emitted fields are required. |
| 3. Streaming | **unverified — confirm first** | Only a request-side `stream` boolean was emitted. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)] | Content type, SSE event names/data, terminal done/error behavior, and cancellation. |
| 4. Models | **partial** | `GET /v1/models` emitted; one authenticated session displayed two account-visible IDs. [Evidence: [`fixtures/override-models-401.json`](fixtures/override-models-401.json), [`fixtures/strace-models-summary.json`](fixtures/strace-models-summary.json)] | Successful remote response schema, complete Build inventory, pagination, and an authorized `api.x.ai` comparison if needed. |
| 5. Quota/errors | **unverified — confirm first** | Available 401s were synthetic loopback responses; the live prompt exposed no HTTP status or response body. [Evidence: [`fixtures/override-models-401.json`](fixtures/override-models-401.json), [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json)] | Distinguishing production quota, auth, and ordinary rate-limit status/body/header signals. |
| 6. Usage/billing | **partial — ship blocker** | The staged normal turn emitted `GET /v1/user?include=subscription` and `GET /v1/user`; no remote response body was captured. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)] | Durable residual/used/reset fields, units, update cadence, and authenticated response semantics. |
| 7. Refresh/session | **partial** | The official auth store contains redacted refresh/expiry fields; response requests emitted conversation/session/request IDs and later-turn index. [Evidence: [`fixtures/auth-store-shape.json`](fixtures/auth-store-shape.json), [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)] | Refresh endpoint/method/body/rotation and demonstrated multi-turn continuity requirements. |
| 8. Default-chat adjacent | **partial** | The staged normal turn emitted settings, bundle, subscription/user, and feedback-config requests. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)] | Sidecar response schemas, recap/default toolset identifiers, and required-versus-best-effort behavior. |

## Evidence method and limits

- Wave B exercised the official `grok 0.2.93 (f00f96316d) [stable]` binary. Loopback capture used a base-URL override bound only to `127.0.0.1`; every persisted request header/body value was converted to redaction metadata before the fixture was written. The loopback response bodies and statuses are explicitly synthetic and prove request emission only. [Evidence: [`fixtures/override-models-401.json`](fixtures/override-models-401.json), [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/strace-local-prompt-summary.json`](fixtures/strace-local-prompt-summary.json)]
- Production transport proof came from redacted `strace` summaries. Authenticated `models` resolved `cli-chat-proxy.grok.com` and connected to its corroborated TLS addresses. The traced `-m grok-build` prompt resolved the same name and connected to one corroborated TLS address, but ended with a redacted non-JSON CLI error. `strace` did not reveal decrypted HTTP, SNI, a status, a response body, or SSE frames. Therefore this is **host DNS/TCP proof only**, not production host/path proof. [Evidence: [`fixtures/strace-models-summary.json`](fixtures/strace-models-summary.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json)]
- The TLS key-log experiment produced an empty temporary file, so it provides no decrypted-wire evidence. [Evidence: [`fixtures/sslkeylog-experiment.json`](fixtures/sslkeylog-experiment.json)]
- Sensitive fixture data is intentionally limited to field names, types, redacted lengths, and non-secret host metadata. No token, authorization, API-key, email, user identifier, cookie, raw trace line, or raw CLI error is reproduced here. [Evidence: [`fixtures/auth-store-shape.json`](fixtures/auth-store-shape.json), [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/api-key-differential.json`](fixtures/api-key-differential.json)]
- Offline static strings from the same oracle binary remain leads, not contracts. In particular, static auth, billing, streaming, host, and model-like tokens cannot establish a Build request path, authentication rule, model inventory, SSE contract, or usage API.

## Confirmed request-side facts only

### Destination and override boundary

1. With the captured override set to a loopback `/v1` base, the binary sent its observed preflights and response requests to that loopback recorder before any remote endpoint could be reached. [Evidence: [`fixtures/override-models-401.json`](fixtures/override-models-401.json), [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/strace-local-prompt-summary.json`](fixtures/strace-local-prompt-summary.json)]
2. Authenticated production model discovery resolved `cli-chat-proxy.grok.com`; its corroborated IPv4 TLS destinations were `104.18.28.234:443` and `104.18.29.234:443`. The prompt trace also reached `104.18.28.234:443`. A separate observed connection is explicitly not attributed to a Build endpoint. This does **not** prove any production HTTP path. [Evidence: [`fixtures/strace-models-summary.json`](fixtures/strace-models-summary.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json)]

### Observed override request paths and per-request header names

The following are emitted request facts under the authenticated **loopback** override. Header sets varied by path; none is asserted to be globally mandatory or sufficient for production auth. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)]

| Method and path | Count | Observed header names |
|---|---:|---|
| `GET /v1/models` | 1 | `accept`, `accept-encoding`, `authorization`, `host`, `user-agent`, `x-email`, `x-grok-client-version`, `x-userid`, `x-xai-token-auth` |
| `GET /v1/settings` | 4 | `accept`, `accept-encoding`, `authorization`, `host`, `user-agent`, `x-email`, `x-grok-client-identifier`, `x-grok-client-version`, `x-userid`, `x-xai-token-auth` |
| `GET /v1/bundle/archive` | 2 | `accept`, `accept-encoding`, `authorization`, `host`, `user-agent`, `x-email`, `x-grok-client-version`, `x-userid` |
| `GET /v1/user?include=subscription` | 1 | `accept`, `accept-encoding`, `authorization`, `host`, `user-agent`, `x-grok-client-version`, `x-xai-token-auth` |
| `GET /v1/user` | 3 | `accept`, `accept-encoding`, `authorization`, `host`, `user-agent`, `x-grok-client-version`, `x-xai-token-auth` |
| `GET /v1/feedback/config` | 1 | `accept`, `accept-encoding`, `authorization`, `host`, `traceparent`, `tracestate`, `user-agent`, `x-grok-client-version`, `x-xai-token-auth` |
| `POST /v1/responses` | 3 | Common: `accept`, `accept-encoding`, `authorization`, `content-length`, `content-type`, `host`, `user-agent`, `x-grok-agent-id`, `x-grok-client-identifier`, `x-grok-client-version`, `x-grok-conv-id`, `x-grok-model-override`, `x-grok-req-id`, `x-grok-session-id`; requests 2–3 additionally emitted `traceparent` and `x-grok-turn-idx`. |

The no-credential control emitted `GET /v1/login-config` to the loopback override without `authorization`, `x-xai-token-auth`, `x-email`, or `x-userid`. This is request emission only, not a device-login contract. [Evidence: [`fixtures/api-key-differential.json`](fixtures/api-key-differential.json)]

### Observed `POST /v1/responses` body schemas

All fields below are top-level request-schema observations from the loopback recorder; values are redacted and no production response contract follows. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)]

- **Request 1:** `include`, `input`, `max_output_tokens`, `model`, `reasoning`, `store`, `stream`, `temperature`, `tool_choice`, and `tools`. Its `input` was an array of two objects with `content`, `role`, and `type` fields.
- **Requests 2–3:** `include`, `input`, `model`, `reasoning`, `store`, `stream`, and `tools`. Their `input` was an array of six objects with `content`, `role`, and `type` fields.
- `content-type` was emitted for all three requests, but the fixture does not prove that any particular request field, header, or media type is required by the production Build service. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)]

## RE items 1–8

### 1. Build auth — **partial**

The official auth store was parseable and had one entry containing field names for issuer/client metadata, a redacted credential key, redacted refresh token, expiry, and redacted profile/identity metadata. A `grok models` invocation using that official store succeeded and reported a logged-in state. The captured request-side header names are listed above, but their per-endpoint necessity and acceptance rules are not proved. [Evidence: [`fixtures/auth-store-shape.json`](fixtures/auth-store-shape.json), [`fixtures/strace-models-summary.json`](fixtures/strace-models-summary.json), [`fixtures/override-models-401.json`](fixtures/override-models-401.json), [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)]

`grok login --device-auth` was not run, and no device authorization, authorization-code, token exchange, or refresh request/response was captured. The static issuer, OAuth vocabulary, and configuration strings are still **unverified — confirm first**. [Evidence: [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]

### 2. Build chat wire — **partial**

The loopback override emitted `POST /v1/responses` three times with the request-side schemas and header names above. Separately, the live `-m grok-build` trace reached the DNS name `cli-chat-proxy.grok.com` and a corroborated TLS destination. Those two observations establish the override request shape and production host transport independently; they do **not** bind `/v1/responses` to that production host at the HTTP layer. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json), [`fixtures/strace-models-summary.json`](fixtures/strace-models-summary.json)]

The staged response statuses/bodies were synthetic loopback data. The live prompt had no observable HTTP status or response schema. Production success, field requirements, and error behavior remain **unverified — confirm first**. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json)]

### 3. Streaming — **unverified — confirm first**

Only the request-side boolean `stream` was observed. No production media type, SSE event, event-data schema, completion/error signal, or cancellation behavior was captured. Static event-name strings are not streaming evidence. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)]

### 4. Build model inventory — **partial**

`GET /v1/models` is an emitted loopback request. One authenticated `grok models` session displayed `grok-4.5` and `grok-composer-2.5-fast`; this is account-visible output, not a complete remote model list or a promise that either identifier belongs in an OMP Build provider. [Evidence: [`fixtures/override-models-401.json`](fixtures/override-models-401.json), [`fixtures/strace-models-summary.json`](fixtures/strace-models-summary.json)]

The only captured loopback model-list response was deliberately synthetic. A full successful Build response, pagination/cursor behavior, and any authorized comparison to `api.x.ai` remain **unverified — confirm first**. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]

### 5. Quota and errors — **unverified — confirm first**

A loopback 401 and staged 401s are synthetic. The production prompt ended in a redacted non-JSON CLI error with no observable HTTP status, response headers, or response body. No captured fact distinguishes Build quota exhaustion from authentication failure, generic rate limiting, capacity, or other errors. [Evidence: [`fixtures/override-models-401.json`](fixtures/override-models-401.json), [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json)]

Static 401/403/429, quota, credit, and access-gate text remains **unverified — confirm first** for Build error classification.

### 6. Build usage/billing — **partial and the ship blocker**

Normal-turn initialization emitted `GET /v1/user?include=subscription` once and `GET /v1/user` three times under loopback capture. Both requests carried the same header-name subset shown above (`accept`, `accept-encoding`, `authorization`, `host`, `user-agent`, `x-grok-client-version`, `x-xai-token-auth`). No response was from the production service; the recorder supplied only synthetic errors for non-model paths. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)]

There is no captured durable Build residual, used amount, limit, reset, unit, account scope, or update cadence. Static billing paths and field-like tokens are **unverified — confirm first** and MUST NOT be substituted for Build usage reporting. [Evidence: [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]

This alone blocks Build ship: OMP usage needs response-supported data for `omp usage` and `/usage`, not request costs or a permanent empty implementation.

### 7. Refresh and session continuity — **partial**

The official auth-store field schema includes a redacted refresh-token field and expiry field. `POST /v1/responses` emitted `x-grok-conv-id`, `x-grok-session-id`, `x-grok-req-id`, plus `x-grok-turn-idx` on later observed requests. This proves field/header emission only; it does not prove their values, reuse, precedence, lifetime, or necessity. [Evidence: [`fixtures/auth-store-shape.json`](fixtures/auth-store-shape.json), [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)]

No refresh call, token rotation, re-auth failure, or successful multi-turn production continuity was captured. Refresh/session behavior is therefore **unverified — confirm first** beyond the partial request/store observations. [Evidence: [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]

### 8. Default-chat adjacent calls — **partial**

The staged normal turn emitted `/v1/settings`, `/v1/bundle/archive`, `/v1/user?include=subscription`, `/v1/user`, and `/v1/feedback/config` before/around response attempts. The fixture does not prove response schemas, that any call is required, a recap mechanism, a default preset/toolset identifier, or a production timing/order guarantee. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json)]

Static Build-named preset and recap tokens remain **unverified — confirm first** rather than evidence of a default coding turn.

## API-key hard-reject differential — bounded result

In a fresh isolated environment with OAuth unset and only a fake seven-character `XAI_API_KEY`, a `-m grok-build` prompt failed locally before any loopback request; the fake key was not echoed or transmitted to the recorder. With neither credential source, the separate control emitted unauthenticated `GET /v1/login-config` requests to the override. [Evidence: [`fixtures/api-key-differential.json`](fixtures/api-key-differential.json)]

This is useful fail-closed evidence for one fake-key input to the official binary. It is **not** a complete production Build-auth rejection contract and does not prove behavior for valid API keys, other credential sources, or real endpoints. [Evidence: [`fixtures/api-key-differential.json`](fixtures/api-key-differential.json)]

## OMP integration map — registration surfaces only

These are conditional implementation surfaces, not authorization to implement and not replacements for missing RE evidence. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]

- A future distinct provider identity would be registered through catalog descriptors/model-manager options and the built-in provider/login registry; its OAuth credential would use OMP's provider-scoped store. Existing `xai-oauth` remains a separate SuperGrok/API path and is not evidence of a Build contract.
- A future usage integration would require a real `UsageProvider`, default usage registration in `AuthStorage`, and the generic `omp usage`/`/usage` path. The current default usage registry has no xAI/xai-oauth usage provider.
- A future Build path must resolve stored OAuth under its own identity and fail before network on key-only configuration; it must not reuse the current `xai-oauth` API-key fallback. This is an OMP product constraint, not a discovered Build wire contract.

## Remaining capture plan

Use the redacted ingestion rules in [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json) and run only with an explicitly approved, low-cost Build session. Retain host/path/method/status, header names with redacted lengths, and response/SSE schemas; redact every header/body value before persistence. [Evidence: [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]

1. **Auth and refresh (items 1, 7):** capture an authorized normal request immediately before and after a naturally available refresh; retain refresh host/path/method/status, request header names/redacted lengths, refresh response field schema, and post-refresh header shape. [Evidence: [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]
2. **Chat, streaming, errors (items 2, 3, 5):** perform one approved minimal coding prompt and one controlled cancellation; capture `POST /v1/responses` status, content type, SSE event names/data schemas, terminal done/error/cancellation behavior, and naturally observed auth/quota/rate-limit signal schemas. [Evidence: [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]
3. **Models (item 4):** capture a successful remote `GET /v1/models` response including complete returned IDs, response schema, status, and pagination/cursor fields. Compare with `api.x.ai` only if separately authorized and non-billing. [Evidence: [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]
4. **Usage (item 6):** capture successful `/v1/user?include=subscription`, `/v1/user`, and any normal-turn billing calls; retain all response-field schemas and prove used/residual/reset fields, units, and update cadence. No durable response signal means the Build ship remains blocked. [Evidence: [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]
5. **Sidecars (item 8):** capture settings, bundle, and feedback responses during a successful normal coding turn; determine default preset/toolset identifiers and whether each sidecar is required or best-effort. [Evidence: [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]

## Recommended upstream deliverable shape

Submit one documentation/evidence-only PR that copies this artifact to `docs/research/grok-build-re/` and records the **DOSSIER_ONLY** decision plus the capture plan. Its scope MUST exclude provider code, auth code, model-catalog entries, usage-provider registration, tests that assert invented protocol behavior, API-key fallback changes, and a new issue. The PR can be superseded by a later implementation only after all items 1–7 are behavior-confirmed, including body-level durable Build usage. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]

## Explicitly unverified — confirm first

- Production HTTP path binding, status codes, response schemas, field requirements, and error semantics for every emitted request. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json)]
- Device login, OAuth client/scopes/audience, token exchange, refresh request/response, and production auth rejection behavior. [Evidence: [`fixtures/auth-store-shape.json`](fixtures/auth-store-shape.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]
- Streaming content type, SSE event/data schema, done/error/cancellation semantics. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]
- Complete Build model inventory and remote model-list schema/pagination. [Evidence: [`fixtures/strace-models-summary.json`](fixtures/strace-models-summary.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]
- Build quota/auth/rate-limit taxonomy and any status/header/body discriminator. [Evidence: [`fixtures/authenticated-prompt-strace-summary.json`](fixtures/authenticated-prompt-strace-summary.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]
- Durable Build usage/billing residual, used, limit, reset, units, account scope, update cadence, and endpoint response semantics. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]
- Session/recap/default-toolset semantics and which observed sidecars are required. [Evidence: [`fixtures/override-chat-staged.json`](fixtures/override-chat-staged.json), [`fixtures/live-remote-capture-template.json`](fixtures/live-remote-capture-template.json)]
