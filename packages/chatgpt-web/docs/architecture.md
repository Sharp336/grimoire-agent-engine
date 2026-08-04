# Architecture

```text
OMP session and tool approval authority
        │ keyless package extension / stream
        ▼
@oh-my-pi/pi-chatgpt-web
  ├─ model routes and OMP prompt compiler
  ├─ browser worker (five task-bound leases per profile owner)
  ├─ runtime gate and generation-bound admission
  └─ full mode only: capability broker + stdio MCP child
        │ owner-local native listener/pipe
        ▼
authenticated connector bootstrap ── outbound tunnel ── ChatGPT connector
        │
        ▼
verified Chrome + owner profile + inherited private debugging pipe
```

## Provider registration

The package registers the custom `chatgpt-web` API at `chatgpt-web://local` through OMP's extension API. Registration is keyless but not generally unauthenticated: the host mints an opaque, source- and generation-bound capability only after native config and login-marker validation. The capability is not serializable, is not stored in `AuthStorage`, and is revoked when the source or generation changes.

The provider contributes bare route IDs `light`, `medium`, `high`, `extra-high`, and conditionally `pro`; users select them as `chatgpt-web/<id>`. Every route has one immutable effort. Full-mode non-Pro models advertise tool support; browser-only and Pro routes do not.

## Turn data flow

1. OMP selects a verified route and obtains one runtime-generation admission.
2. The provider serializes the active OMP system prompt, messages, images, selected route, and session identity into a bounded package-owned envelope.
3. Browser-only and Pro turns omit every local tool declaration and broker capability. Full mode issues one binding from the same admission, snapshots and hashes the complete canonical OMP tool set, and includes only the single-turn `turnToken` plus the bind-first instruction.
4. The browser host acquires one task-bound lease, revalidates admission, verified executable/profile identity, and opens a fresh Temporary Chat in the shared owner profile.
5. The worker selects the fixed ChatGPT mode, reattaches images, submits once, and streams reasoning, Markdown, usage, tool calls, and completion events into OMP.
6. In full mode the authenticated connector must call `chatgpt_web_bind_turn`. The broker then relays exact tool calls to the OMP agent loop; OMP applies its normal validation, approval, sandbox, and execution policy and returns exact results to the same browser response.
7. Completion, failure, cancellation, expiry, or drain closes the page, releases the lease and binding exactly once, rejects late results, and updates runtime counters. Sibling turns remain live.

There is no secondary planner, Responses proxy, generic raw page API, silent context truncation, mode switch, or fallback model.

## Browser host

The launcher-neutral `BrowserHost` boundary exposes only closed, typed operations needed by the worker: verified login, lease lifecycle, allowlisted locators/actions, bounded snapshots, opaque attachments, and turn state. It never accepts a caller-supplied executable/profile path, URL, CSS/XPath selector, JavaScript evaluator, CDP endpoint, websocket, cookie API, or storage-state API.

A native adapter verifies Chrome and the owner-controlled profile, launches with an inherited `--remote-debugging-pipe`, and exposes only the package-private byte transport used by pinned Playwright Core. The provider can run with its local system-Chrome host or the separately packaged launcher without changing model semantics.

One profile owner can hold at most five independent task-bound tab leases. A sixth lease fails explicitly. Each lease owns a fresh Temporary Chat document; tabs share only the login profile. Cancellation is an idempotent close/release transition.

## Full-mode broker and tunnel

The broker listens before the tunnel starts on an opaque owner-local native endpoint. Unix implementations use owner permissions and peer credentials; Windows uses a restrictive named pipe, remote-client rejection, client process identity, and ACL checks. Both verify process ancestry/start/executable identity and revalidate the peer on every request.

Each tunnel launch receives a fresh one-time bootstrap over held, owner-verified file/connection capabilities. The bootstrap binds the expected tunnel executable, runtime epoch, connector authenticator, and broker endpoint without exposing a replaceable path. The connector initially lists only `chatgpt_web_bind_turn`; successful one-time binding publishes the canonical per-turn tools and rejects schema/hash drift.

The tunnel is outbound. It does not create an inbound public listener, and the owner-local broker is not a loopback bearer service. Tunnel credentials and bootstrap/control material remain outside prompts, argv, generated profiles, and logs.

## Runtime and launcher lifecycle

The runtime gate issues generation-bound references for browser leases, broker bindings, and tunnel processes. Drain rejects new work and waits for every reference class to reach zero before replacement or shutdown. Startup is broker-first in full mode; teardown reverses ownership and uses native descendant identity rather than PID-only termination.

The optional Electron launcher owns the same private browser transport, profile, runtime installation, autostart, and supervision contracts. Its control service is owner-local and authenticated per peer/request. Runtime bundles and native addons are target-specific, checksum/ABI/architecture verified, and installed atomically. Linux musl is build-only and is neither a distinct runtime loader tuple nor a published native leaf.

## State layout

The default root is `${PI_CODING_AGENT_DIR:-~/.omp/agent}/chatgpt-web` and contains config, owner fencing, control/runtime-key material, browser profile, generation-bound verification marker, structured logs, and redacted local evidence. Native no-follow and stable-identity operations own all security-sensitive state transitions.

See [Security model](security-model.md) for invariants and failure behavior.
