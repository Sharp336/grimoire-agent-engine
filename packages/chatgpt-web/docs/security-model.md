# Security model

## Trust boundaries

OMP, the exact installed ChatGPT Web package and native addon, the verified browser executable, the owner-controlled browser profile, and the selected ChatGPT/OpenAI services are trusted for their intended roles. Repository content, prompt text, tool output, browser DOM, websites, attachment names, child output, and model-generated tool calls are untrusted.

The design does not defend against a compromised OS account, OMP binary, native addon, browser binary, or OpenAI account. It does not bypass ChatGPT plan, workspace, usage, model, connector, or action restrictions.

## Local principals and transport

Broker and launcher control bind through the native owner-local transport: an owner-only Unix-domain listener on Unix or a restrictive local named pipe on Windows. They are not loopback TCP bearer endpoints. Unix peer credentials and process identity, or Windows pipe security descriptors, remote-client rejection, client PID and process identity, are checked with ancestry and start/executable identity. Peer identity is revalidated for every request.

A stolen token is insufficient. Requests also require the expected native connection proof, runtime generation, owner/epoch, connection nonce, monotonically increasing sequence, and operation-specific lease or binding. Replay, stale generation, wrong peer, unknown operation, malformed input, and unsupported native APIs fail closed.

## Tokens and full-mode binding

Control tokens, connector authenticators, bootstrap material, runtime keys, binding IDs, and launcher capabilities are control-plane secrets and are never model-visible. Full mode deliberately places one value in the prompt: an expiring, single-turn `turnToken`. It is a correlation nonce, not a control credential or direct tool authority.

Before any answer or tool action, ChatGPT must call the dedicated `chatgpt_web_bind_turn` tool with that token. Before binding, the connector exposes only that tool. An atomic one-time claim binds the authenticated connector session to the exact OMP turn, then exposes the immutable canonical tool snapshot. Claims, late results, duplicate call IDs, unknown tools, and schema or tool-set hash drift are rejected.

Browser-only and Pro prompts omit the token, local tool names, schemas, capabilities, and local tool-result continuation data entirely.

## Tool authority

OMP remains the execution authority. The broker transports exact call IDs, arguments, and results; it does not execute tools, relax sandbox policy, or grant approval. Every call still passes OMP's normal tool validation, sandboxing, mounted-device permission wrappers, and approval policy. Connector-side approval cannot override OMP.

The broker hashes every supported provider-facing field in the canonical OMP `Tool`: kind, name, description, normalized parameters, strictness, custom wire name/format, native declaration, and examples, including whether optional fields are absent or present. Unknown declaration fields and any schema/hash drift invalidate the binding instead of silently widening authority.

## Files, profile, and process identity

State defaults to `${PI_CODING_AGENT_DIR:-~/.omp/agent}/chatgpt-web`. The browser profile and tunnel key are sensitive owner-only files. Native no-follow handles enforce owner/ACL checks and stable file identity across read, validation, import, replacement, and launch. Symlink, junction, reparse, path replacement, hardlink, broad-permission, owner, or identity mismatch fails closed; there is no UID/mode-only or Node-handle fallback.

The login marker contains authentication status, verification time, Pro availability, profile generation and immutable profile identity, verified executable digest/version/identity, and owner fence. It contains no path, account ID, cookie, header, OAuth value, or credential. Marker age, profile generation, owner fence, executable identity, and profile identity are revalidated together. Marker/profile/executable swaps invalidate admission.

Chrome is launched only through the native verified-process API. The already-verified executable/profile identities and private inherited remote-debugging pipe are consumed at launch; no remote-debugging TCP port, websocket URL, generic page evaluator, cookie API, or storage-state export crosses the package boundary. Cancellation and shutdown terminate only descendants whose PID, start identity, executable identity, and ownership still match.

## Tunnel and child processes

Full mode resolves an allowlisted opaque tunnel ID to the pinned service identity. Runtime keys are imported from owner-controlled files, never accepted as URLs, environment-only overrides, or model input. Connector bootstrap is one-time, generation-bound, held by native identity, and authenticated before authorization. Redirect, DNS/host/port/TLS identity substitution, stale bootstrap, or key replacement fails before any credential is sent.

Chrome, broker, MCP, tunnel, runtime, helper, and launcher children receive explicit environment allowlists. Credential, loader, proxy, preload, search-path, debugger, and runtime override variables are not inherited. Child and grandchild environment canaries are tested.

## Logging and failure behavior

Structured logs accept a closed set of stages and bounded counts, durations, exit codes, error classes, and non-secret hashes. They reject raw prompts, DOM, tool payloads, headers, cookies, query URLs, profile paths, credentials, child lines, and exception text. Status and doctor output use the same allowlist rather than capturing and redacting arbitrary text afterward.

Missing native code, wrong architecture, ABI or hash mismatch, unavailable peer/process API, changed file identity, invalid marker, UI drift, capability mismatch, tunnel failure, or teardown uncertainty produces an explicit error. The provider never falls back to another model, mode, binary, architecture, transport, local security implementation, or fabricated result.
