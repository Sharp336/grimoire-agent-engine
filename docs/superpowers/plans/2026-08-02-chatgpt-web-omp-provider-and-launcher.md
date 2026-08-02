# ChatGPT Web Provider and Launcher Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a locally tested, first-party OMP ChatGPT Web provider and then a separately packaged Electron launcher without opening or pushing an upstream PR.

**Architecture:** Create `packages/chatgpt-web` as an OMP-native custom API provider. Its extension registers `chatgpt-web/*` models through `ExtensionAPI.registerProvider`, while its browser worker, prompt compiler, session state, MCP broker, and tunnel code remain package-owned. Add a narrow coding-agent registry seam for `auth: "none"` and `supportsTools` model metadata; do not add a `KnownApi` or `ApiOptionsMap` entry. The first milestone uses the provider directly in the OMP process; the second adds `packages/chatgpt-web-launcher` behind an authenticated browser-host RPC, never a reusable raw CDP URL.

**Tech Stack:** Bun `>=1.3.14`, TypeScript, `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, Playwright Core, MCP SDK, Turndown/GFM, Zod, Electron, React, Vite, and electron-builder. Use the OMP catalog/lock versions rather than copying source pins; do not add direct `chromium-bidi` because the source declares it without importing it and Playwright owns its transport dependency.

## Global Constraints

- Work only in the local `Nou4r/oh-my-pi` checkout; do not push, open a PR, open an issue, or contact maintainers during implementation.
- Keep `codex-chatgpt-web` as a source/reference checkout only; do not add it as a runtime dependency, submodule, or package registry dependency.
- Do not add a `KnownApi` or modify `ApiOptionsMap`; use the existing custom API identifier `chatgpt-web` and `streamSimple` registration path.
- Add only the narrow, host-issued, source/API/base-URL-bound capability-gated runtime-provider metadata seam required for this local capability: `auth: "none"` and optional `supportsTools` propagation. Keep the generic AI wire types unchanged.
- Do not port Codex configuration mutation, Codex request-envelope parsing, native Codex passthrough, or Codex service management.
- Preserve five concurrent browser turns per profile owner, fresh Temporary Chats, image reattachment, fixed effort mapping, explicit Pro read-only behavior, fail-closed browser checks, and production OMP approval/sandbox authority.
- Store browser state below `${PI_CODING_AGENT_DIR:-~/.omp/agent}/chatgpt-web/browser-profile`; reject symlink/junction/reparse traversal, verify owner-only storage/ACLs for the platform, and never place credentials in argv, logs, prompts, generated config, or Git.
- Do not represent the local browser profile as OAuth or an API key. `AuthStorage`, `SimpleStreamOptions.apiKey`, `omp token`, and generic auth-broker snapshots must contain no ChatGPT Web credential/profile identifier.
- Retain `codex-chatgpt-web/LICENSES/NOTICE.md` and `LICENSES/OpenCodex-MIT.txt` only for copied substantial code; generate current dependency/runtime notices from the OMP lockfile and actual redistributed runtime version.
- Every task ends with its focused test/check command before the next task begins. Live browser/tunnel checks are explicit local/manual gates, never normal PR CI.
- Treat control/bootstrap/connector material as non-model-visible secrets; the only model-visible full-mode value is the single-turn correlation `turnToken`, which is not a control credential and is accepted only by the dedicated bind handshake.
- Launch Chrome, helpers, MCP, tunnel, runtime, and launcher children with explicit allowlisted environments; never inherit credential, loader, proxy, or path overrides.
- Use one structured redacting sink for provider/launcher logs and returned diagnostics; never log raw DOM, prompts, headers, query URLs, cookies, child lines, profile paths, or exception text.
- Hold or re-check no-follow file identity through every executable/profile/key/descriptor use; a check followed by an unchecked path launch is not sufficient. Use the package's native file/ACL adapter for all platforms, including browser-only profile/config/marker/key persistence and verified Chrome/browser-process launch; load peer-listener, peer-identity, and tunnel process-control portions lazily only for full-mode broker/tunnel or launcher startup.

---

## File and package map

### Native prerequisite

- Create: `crates/pi-natives/src/local_peer.rs` — cross-platform owner-local listener/connection, peer PID, process ancestry/start/executable identity, stable file identity/handle, and verified-process primitives.
- Modify: `crates/pi-natives/src/lib.rs` — export the native local-peer API.
- Modify: `crates/pi-natives/Cargo.toml` — add the Windows process/pipe/file API feature flags required by the implementation.
- Modify: `packages/natives/package.json` — keep the existing `@oh-my-pi/pi-natives` N-API package as the sole owner of the local-peer/file/process bridge; add no sidecar executable or registry dependency.
- Modify/generated: `packages/natives/native/index.js` and `packages/natives/native/index.d.ts` — regenerate the N-API export after the Rust change; do not hand-edit generated bindings.
- Create: `packages/natives/test/local-peer.test.ts` — per-OS peer PID, ancestry, file-identity, replacement, and verified-launch coverage.

The provider package depends directly on `@oh-my-pi/pi-natives` from the existing OMP catalog. Its browser-safe no-follow/ACL/file-identity and verified browser-process-launch subset is loaded in both browser-only and full mode; the peer-listener, peer-identity, and tunnel process-control portions are loaded lazily only for full-mode broker/tunnel or launcher startup. Do not add a sidecar executable or silently fall back to UID/mode checks. The native API must expose a package-owned local listener/connector abstraction (not raw Node/Bun handles), stable file identity held across open/read/proof/consume, and verified process launch/termination primitives:

```ts
export interface NativeProcessIdentity {
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly executableIdentity: string;
  readonly __opaque: unique symbol;
}

export interface NativeOwnedFile {
  readonly identity: string;
  readonly __opaque: unique symbol;
  /** Reads the already-open native handle; never reopens the pathname. */
  read(): Uint8Array;
  /** Marks this native handle consumed/zeroizes its bytes after broker-side authenticator CAS; it is not path authority. */
  consume(): void;
  /** Best-effort cleanup only when the current path identity still matches; never used for authentication or consume authority. */
  cleanup(): void;
  close(): void;
}

export interface NativeOwnedProcess {
  identity: NativeProcessIdentity;
  wait(timeoutMs?: number): Promise<{ exitCode: number | null; signal: string | null }>;
  terminate(): Promise<void>;
  close(): void;
}

export interface NativeVerifiedExecutable {
  readonly identity: string;
  readonly sha256: string;
  readonly __opaque: unique symbol;
}

export type NativeLaunchEnvironmentProfile =
  | {
      readonly kind: "tunnel-child";
      readonly bootstrap: NativeOwnedFile;
      readonly broker: NativeLocalEndpoint;
      readonly runtimeKey: NativeOwnedFile;
      readonly runtimeEpoch: string;
    }
  | {
      readonly kind: "browser-child";
      /** Opened no-follow directory handle for the owner-controlled browser profile root. */
      readonly profileRoot: NativeOwnedFile;
      readonly profileGeneration: string;
      readonly ownerFence: string;
    };

export interface NativeLaunchEnvironment {
  readonly __opaque: unique symbol;
}

export type NativeBrowserFeatureToggle =
  | "disable-background-networking"
  | "disable-component-update"
  | "disable-default-apps";

export interface NativeBrowserLaunchOptions {
  readonly headed: boolean;
  readonly featureToggles?: readonly NativeBrowserFeatureToggle[];
}

export function openVerifiedExecutable(spec: {
  path: string;
  sha256: string;
  version: string;
}): Promise<NativeVerifiedExecutable>;

export function createLaunchEnvironment(
  profile: NativeLaunchEnvironmentProfile,
): NativeLaunchEnvironment;

export function launchVerifiedProcess(spec: {
  executable: NativeVerifiedExecutable;
  args: readonly string[];
  environment: NativeLaunchEnvironment;
}): Promise<NativeOwnedProcess>;

export interface NativeBrowserPipe {
  /** Reads only Chromium's response side: fd/handle 4 from the inherited remote-debugging pipe. */
  read(): AsyncIterable<Uint8Array>;
  /** Writes only Chromium's command side: fd/handle 3 from the inherited remote-debugging pipe. */
  write(bytes: Uint8Array): Promise<void>;
  /** Closes both inherited sides exactly once; child ownership remains on NativeOwnedBrowserProcess. */
  close(): Promise<void>;
}

export interface NativeOwnedBrowserProcess {
  readonly process: NativeOwnedProcess;
  /** Private inherited Chromium --remote-debugging-pipe byte stream; never a URL. */
  readonly pipe: NativeBrowserPipe;
}

export function launchVerifiedBrowser(spec: {
  executable: NativeVerifiedExecutable;
  environment: NativeLaunchEnvironment;
  options: NativeBrowserLaunchOptions;
}): Promise<NativeOwnedBrowserProcess>;

export interface NativePeerConnection {
  /** Snapshot at accept; never sufficient for authorization after the call returns. */
  peer: NativeProcessIdentity;
  /** Re-reads the live peer PID/start/executable identity through the OS/native handle. */
  currentPeer(): NativeProcessIdentity;
  read(): AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface NativeLocalEndpoint {
  readonly kind: "owner-local";
  readonly __opaque: unique symbol;
}
export interface NativeLocalListener {
  readonly endpoint: NativeLocalEndpoint;
  accept(): Promise<NativePeerConnection>;
  close(): Promise<void>;
}
export function connectLocal(endpoint: NativeLocalEndpoint): Promise<NativePeerConnection>;

/** Native live ancestry walk; ambiguity, PID reuse, or unavailable identity returns false. */
export function verifyPeerDescendant(
  peer: NativeProcessIdentity,
  ancestor: NativeProcessIdentity,
): boolean;
/** Compares the complete native identity (PID, process-start, and executable identity) through native handles; never PID-only. */
export function matchesProcessIdentity(
  expected: NativeProcessIdentity,
  actual: NativeProcessIdentity,
): boolean;
```
`NativeProcessIdentity` is a native-backed opaque handle, not a serializable authorization record: the diagnostic fields are read-only views, but every native identity/ancestry/process operation validates the private native handle and rejects structural clones, JSON-deserialized records, stale handles, PID-only records, and status JSON. `NativeOwnedProcess.identity` and `NativePeerConnection.peer` must be passed directly to native verification; the provider/broker uses `matchesProcessIdentity()` on the complete native handle and never reconstructs identity from fields.
`NativeOwnedFile`, `NativeVerifiedExecutable`, `NativeLaunchEnvironment`, `NativePeerConnection`, and `NativeOwnedProcess` are likewise native-backed opaque handles. Every native call validates the hidden handle marker and live identity; structural clones, JSON/deserialized records, copied diagnostic fields, closed handles, and stale/replaced file identities are rejected. These values are package-private capabilities even where TypeScript declarations are generated, and tests exercise clone/consume/close and replacement races.

On Linux use Unix-domain peer credentials plus `/proc` start-time/executable identity; on macOS use the native local-peer PID option plus process start/executable identity; on Windows create the named pipe with a restrictive security descriptor and remote-client rejection, obtain the client PID with `GetNamedPipeClientProcessId`, and validate process start/executable identity through native process APIs. Use `openat`/`O_NOFOLLOW` + `fstat` on POSIX and `CreateFile` with `FILE_FLAG_OPEN_REPARSE_POINT` + file IDs on Windows. Unsupported or unverifiable identity fails closed. Verified executable launch uses a stable opened identity where the OS supports it and otherwise performs an OS-native post-start identity check before any bootstrap/key capability is admitted; PID-only termination is forbidden. Unit tests must include same-user competitors, path replacement, PID reuse, and launch replacement.

---

### New runtime package

- Create: `packages/chatgpt-web/package.json` — `@oh-my-pi/pi-chatgpt-web` workspace package, CLI bin, scripts, direct `@oh-my-pi/pi-ai`/`@oh-my-pi/pi-catalog`/`@oh-my-pi/pi-natives` dependencies, and isolated browser/MCP dependencies; no direct `chromium-bidi`.
- Create: `packages/chatgpt-web/tsconfig.json` — package TypeScript settings extending the workspace base.
- Create: `packages/chatgpt-web/src/index.ts` — public exports for provider, extension, config, model routes, and runtime lifecycle.
- Create: `packages/chatgpt-web/src/extension.ts` — the only OMP extension entry point, using a structural registration type to avoid a coding-agent workspace cycle.
- Create: `packages/chatgpt-web/src/cli.ts` — `login`, `status`, `doctor`, `serve`, `mcp`, and `uninstall` commands; `mcp` is the exact tunnel-owned stdio entrypoint.
- Create: `packages/chatgpt-web/src/config.ts` — secure path resolution, link-aware ownership/ACL checks, atomic config/control-token persistence, and lifecycle settings.
- Create: `packages/chatgpt-web/src/models.ts` — route table and OMP provider-model conversion with bare IDs, `name`, `thinking`, and `supportsTools`.
- Create: `packages/chatgpt-web/src/provider/orchestration.ts` — source adapter semantics for turn-token issue/bind, broker batches, continuation, and revoke.
- Create: `packages/chatgpt-web/src/provider/stream.ts` — `streamSimple` implementation and OMP event conversion.
- Create: `packages/chatgpt-web/src/provider/prompt.ts` — OMP `Context` to browser prompt/attachment compilation.
- Create: `packages/chatgpt-web/src/provider/session.ts` — session identity, continuation, pending tool calls, profile ownership, and cleanup.
- Create: `packages/chatgpt-web/src/provider/types.ts` — package-owned runtime/event contracts; no Codex wire types.
- Create: `packages/chatgpt-web/src/browser/browser-worker.ts` — adapted ChatGPT browser worker against a narrow page/locator facade.
- Create: `packages/chatgpt-web/src/browser/chatgpt-session.ts` — selectors, Temporary Chat checks, effort selection, and login capability checks.
- Create: `packages/chatgpt-web/src/browser/login.ts` — interactive login and account capability marker.
- Create: `packages/chatgpt-web/src/browser/login-host.ts` — minimal login contract widened by the runtime host.
- Create: `packages/chatgpt-web/src/browser/markdown.ts` — ChatGPT HTML-to-Markdown conversion.
- Create: `packages/chatgpt-web/src/browser/concurrency.ts` — five-tab lease cap and single-profile-owner enforcement.
- Create: `packages/chatgpt-web/src/browser/turndown-plugin-gfm.d.ts` — package-local declaration shim for the source GFM plugin import.
- Create: `packages/chatgpt-web/src/browser/process-line-writer.ts` — helper-process JSONL output safety.
- Create: `packages/chatgpt-web/src/runtime/host.ts` — authenticated local/launcher-neutral browser host that extends the Task 2 login contract; no raw CDP URL or unbounded `Page`.
- Create: `packages/chatgpt-web/src/runtime/local-host.ts` — system-Chrome local host used in provider milestone one, with explicit executable/profile support on target OSes.
- Create: `packages/chatgpt-web/src/mcp/broker.ts` — full-mode capability and tool-result broker.
- Create: `packages/chatgpt-web/src/mcp/server.ts` — stdio MCP server for the ChatGPT connector.
- Create: `packages/chatgpt-web/src/mcp/main.ts` — package CLI entry for the tunnel-owned stdio MCP child.
- Create: `packages/chatgpt-web/src/mcp/tunnel.ts` — pinned tunnel-client download, checksum verification, tunnel-owned stdio child lifecycle, and drain controls.
- Create: `packages/chatgpt-web/src/mcp/runtime-command.ts` — shared Bun-vs-bundled-runtime command contract and POSIX/Windows argv quoting.
- Create: `packages/chatgpt-web/src/mcp/bootstrap.ts` — package-owned bootstrap-file lifecycle plus the native peer/file/process adapter; it exposes only a non-secret tunnel spawn descriptor and keeps the connector authenticator opaque.

### Host changes

- Modify: `packages/coding-agent/src/extensibility/extensions/types.ts` — add the opaque host-issued `KeylessProviderRegistration` capability field beside `auth?: "none"`/`supportsTools?: boolean`; runtime registration must require the capability for `auth: "none"` rather than accepting a caller-constructed boolean/string.
- Modify: `packages/coding-agent/src/config/model-registry.ts` — mint/validate the capability only for the allowlisted ChatGPT Web API/source/base URL, pass runtime auth mode, track source-scoped keyless runtime providers, propagate model tool capability metadata, refresh on static catalog/marker changes, and clear both on source removal/re-registration.
- Modify: `packages/coding-agent/test/model-registry-runtime-provider.test.ts` — registration, keyless availability/reload, model selector, capability, duplicate-source, and source-cleanup coverage.
- Modify: `packages/coding-agent/src/cli-commands.ts` — one lazy `chatgpt-web` command entry.
- Create: `packages/coding-agent/src/commands/chatgpt-web.ts` — extension enable/disable/status/login/doctor wrapper; login delegates to the package command, not OAuth.
- Modify: `packages/coding-agent/package.json` — add `"@oh-my-pi/pi-chatgpt-web": "workspace:*"` for the command wrapper.
- Modify: `bun.lock` — refresh after the coding-agent workspace edge.
- Modify: `docs/models.md` — native model setup and model metadata.
- Modify: `docs/providers.md` — browser profile, login, privacy, and tool-mode behavior.
- Modify: `docs/user-facing-packages.md` — package index entry.

### Launcher package (provider gate required)

- Create: `packages/chatgpt-web-launcher/package.json` — isolated Electron/React/Vite/electron-builder package using explicitly selected OMP-compatible versions.
- Create: `packages/chatgpt-web-launcher/electron/main.cjs` — Electron main process with no externally attachable raw CDP control plane.
- Create: `packages/chatgpt-web-launcher/electron/browser-host.cjs` — persistent partition, authenticated host RPC, and five-tab surface host.
- Create: `packages/chatgpt-web-launcher/electron/control-server.cjs` — owner-local native listener/pipe control service with peer proof; any optional HTTP surface is read-only, in-process health only.
- Create: `packages/chatgpt-web-launcher/electron/runtime-supervisor.cjs` — runtime/tunnel health, broker-first startup, drain, restart, and shutdown.
- Create: `packages/chatgpt-web-launcher/electron/runtime-install.cjs` — atomic runtime bundle installation.
- Create/adapt: `packages/chatgpt-web-launcher/electron/{autostart,logging,process-tree,runtime,state,window-state,browser-state,cdp-input,browser-helper-verifier,atomic-file,runtime-command}.cjs` — only source contracts required by the launcher, with allowlisted logging, authenticated browser transport, and start/executable-identity-safe process teardown.
- Create: `packages/chatgpt-web-launcher/src/main.tsx`, `packages/chatgpt-web-launcher/src/App.tsx`, `packages/chatgpt-web-launcher/electron/preload.cjs`, `packages/chatgpt-web-launcher/src/types.ts`, `packages/chatgpt-web-launcher/src/i18n.ts`, `packages/chatgpt-web-launcher/src/icons.tsx`, `packages/chatgpt-web-launcher/src/tokens.css`, `packages/chatgpt-web-launcher/src/styles.css`, `packages/chatgpt-web-launcher/vite.config.ts`, and `packages/chatgpt-web-launcher/index.html` — renderer entry/imports and setup/browser/activity/settings UI; `BrowserWindow.webPreferences.preload`, electron-builder `files`, Vite entry, and `tsconfig` must point to these exact paths.
- Create: `packages/chatgpt-web-launcher/test/` — browser-host, control-server, supervisor, installer, IPC, logging, and package smoke tests.

- Modify: `packages/chatgpt-web/src/runtime/host.ts` — keep the narrow page/locator facade stable.
- Create: `packages/chatgpt-web/src/runtime/launcher-host.ts` — authenticated host-RPC client for login/leases/turn start/end and descriptor refresh; it must never consume a raw CDP endpoint.

- Modify: `bun.lock` — refresh after the provider package, coding-agent workspace edge, and finalized launcher manifest are all present; inspect workspace entries, package-local versions, and duplicate Chromium BiDi trees before every `--frozen-lockfile` gate.

- Modify: `package.json` — add exact root catalog entries for `@modelcontextprotocol/sdk` `1.26.0`; keep existing OMP catalog pins for Turndown `7.2.4`, GFM `1.0.2`, Zod `4.4.3` as resolved by the lockfile, fflate `0.8.3`, React `19.2.7`, Vite `8.1.5`, and TypeScript `7.0.2`; do not add Electron to the core workspace catalog.
- Create: `packages/chatgpt-web/LICENSES/NOTICE.md` and `packages/chatgpt-web/LICENSES/OpenCodex-MIT.txt` — preserved/adapted notices for copied substantial code.
- Create conditionally: `packages/chatgpt-web/LICENSES/Bun-runtime.md` — generated from the actual redistributed Bun/runtime version only when the launcher bundles one; never copy stale source notices.
- Create: `packages/chatgpt-web/test/` and `packages/chatgpt-web-launcher/test/` — focused unit/fixture/integration tests.

---

## Task 0: Add native local-peer and verified-process primitives

**Files:**
- Create: `crates/pi-natives/src/local_peer.rs`
- Modify: `crates/pi-natives/src/lib.rs`
- Modify: `crates/pi-natives/Cargo.toml`
- Modify/generated: `packages/natives/native/index.js`, `packages/natives/native/index.d.ts`
- Modify: `packages/natives/native/loader-state.js`, `packages/natives/native/loader-state.d.ts`, and `packages/natives/native/embedded-addon.js` — add `win32-arm64` platform tags, leaf-package resolution, target metadata, ABI/hash checks, and fail-closed architecture selection.
- Modify: `packages/natives/scripts/gen-npm-packages.ts`, `packages/natives/scripts/embed-native.ts`, and `packages/natives/package.json` — generate/publish the sixth native leaf package, keep its loader/package manifest in sync, and retain the N-API package as the sole owner of the local-peer/file/process bridge.
- Modify: `BUILD.bazel` — add the `win32-arm64` addon and aggregate target.
- Modify: `bazel/platforms/BUILD.bazel` — add the Windows ARM64 target constraints.
- Modify: `bazel/triples/BUILD.bazel` — add the `aarch64-pc-windows-msvc` target selection.
- Modify: `bazel/toolchains/BUILD.bazel` and `bazel/toolchains/msvc/{cc.bzl,llvm.bzl,sysroot.bzl}` — add the Windows ARM64 target and cross-toolchain/sysroot flags; keep x64 baseline/modern behavior unchanged.
- Modify: `MODULE.bazel` — pin the Windows ARM64 Rust std/sysroot artifacts and checksums used by the cross build.
- Modify: `scripts/bazel-natives.ts` and `scripts/bazel-natives.test.ts` — resolve, aggregate, install, and test the new target without basename collisions.

**Interfaces:**
- Produces the `NativeLocalListener`, `NativePeerConnection`, `NativeOwnedFile`, `NativeProcessIdentity`, `verifyPeerDescendant`, and `NativeOwnedProcess` contracts described in the native prerequisite map.
- Consumes no ChatGPT Web code; this is the platform foundation for later `mcp/bootstrap.ts`, tunnel, browser-helper, and launcher process ownership.

- [ ] **Step 1: Implement the platform-native contract.**

Extend the existing `@oh-my-pi/pi-natives` N-API package rather than adding a sidecar executable or a UID/mode-only fallback. Implement native local listener/connector creation so the broker and `mcp/main.ts` never depend on undocumented Node/Bun socket handles. Return peer PID plus start-time and executable identity on every accepted connection. Implement stable opened-file identity and held-handle `read()`, `consume()`, and `cleanup()` primitives; broker-side authenticator CAS, peer proof, and same-handle authorization remain the authority for bootstrap consumption. Add verified process launch/termination primitives: use an opened identity or `fexecve`/`openat` equivalent where supported; otherwise re-check native file identity immediately after process creation and before any bootstrap/key capability is admitted, and refuse PID-only termination when start/executable identity no longer matches.
The browser launch API must expose only the closed `NativeBrowserLaunchOptions` (`headed` plus the allowlisted `NativeBrowserFeatureToggle` union), never caller-supplied Chromium argv. Native code unwraps the held `browser-child.profileRoot` from `NativeLaunchEnvironment`, derives the profile path, injects exactly one `--user-data-dir` and one inherited `--remote-debugging-pipe`, and appends only the pinned allowlisted Chromium flags. Attempts to inject `--remote-debugging-port`, override the profile, disable sandbox/security, duplicate the pipe/profile flags, or pass unknown feature toggles are rejected before spawn. Add native seam tests for those forbidden/duplicate cases and assert the launch record contains no endpoint or caller path.

Linux must use Unix-domain peer credentials and `/proc` identity, macOS its native local-peer PID option and process identity, and Windows a restrictive named-pipe security descriptor, `PIPE_REJECT_REMOTE_CLIENTS`, `GetNamedPipeClientProcessId`, `QueryFullProcessNameW`/creation-time identity, and reparse-safe file handles. Unsupported identity APIs fail closed. Keep no-follow/file identity and verified browser launch available in browser-only mode; load peer transport and tunnel process-control portions lazily only for full mode or launcher startup.
The native build matrix is explicit: Linux x64 baseline/modern plus arm64, macOS x64/arm64, and Windows x64/arm64. Musl is a build-only/staged Linux verification using the existing plain-linux filenames; it is not a concurrent libc variant, loader tuple, launcher runtime resource, or published leaf package. Add `win32-arm64` end to end rather than claiming a target the current Bazel graph cannot build: the platform, Rust target, clang/lld target, Windows SDK/CRT sysroot, addon output, aggregate labels, host selection, loader metadata, and release artifact manifest must agree. If the pinned toolchain cannot produce a verified Windows ARM64 addon, the implementation must stop and narrow the documented support matrix before packaging; it must not emit a placeholder or fall back to x64.
Update `packages/natives/native/loader-state.js`, `embedded-addon.js`, generated declarations, leaf-package generation, and release/publish manifests together: `win32-arm64` must resolve to its own package/artifact and target-specific hash/ABI metadata, never to `win32-x64`. The loader test matrix must exercise host selection, installed leaf resolution, embedded-resource selection, missing leaf, wrong architecture, ABI mismatch, and checksum mismatch.

Run the native build to regenerate declarations/loader exports. Test peer PID and ancestry matching, complete native identity equality (including process start and executable identity rather than PID-only), cross-user and competing same-user rejection, stable file identity across replacement, consume-after-proof only, PID reuse, executable replacement immediately before launch, verified termination, unsupported-API failure, and every declared host/target tuple. Use injected native seams for deterministic tests plus one real local listener test on each supported OS. Run the Bazel target resolver tests and analyze/build each declared target on its supported runner; a missing ARM64 target, wrong ABI, checksum drift, or loader mismatch fails closed.


```text
bun run build:native
bun test scripts/bazel-natives.test.ts
bun test packages/natives/test/local-peer.test.ts
```

- [ ] **Step 3: Commit the native prerequisite.**

```text
git add crates/pi-natives packages/natives BUILD.bazel bazel MODULE.bazel scripts/bazel-natives.ts scripts/bazel-natives.test.ts
git commit -m "feat: add native local-peer security primitives"
```

---

## Task 1: Create the isolated workspace package

**Files:**
- Create: `packages/chatgpt-web/package.json`
- Create: `packages/chatgpt-web/tsconfig.json`
- Create: `packages/chatgpt-web/src/index.ts`
- Create: `packages/chatgpt-web/src/provider/types.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `packages/chatgpt-web/test/package-contract.test.ts`

**Interfaces:**
- Produces the package-owned `ChatGptWebEvent`, `ChatGptWebTurnIdentity`, `ChatGptWebRuntimeAdmission`, and `CHATGPT_WEB_API` contracts consumed by Tasks 2–5; later tasks extend `src/index.ts` with their completed runtime exports.
- Reserves package exports `./extension` and `./cli` in the manifest; Task 2 creates the CLI and Task 5 creates the extension before either subpath is imported.
- Does not depend on `@oh-my-pi/pi-coding-agent`; define the structural extension registration type locally to avoid the Task 5 host/package cycle.

- [ ] **Step 1: Add the package manifest and workspace dependencies.**

Use exact, reviewable versions for dependencies not already in the OMP catalog: `@modelcontextprotocol/sdk` `1.26.0` from the new root catalog entry and `playwright-core` `1.62.1` as a package-local dependency. Use catalog pins for `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-natives`, `@types/bun`, `fflate` `0.8.3`, Turndown `7.2.4`, GFM `1.0.2`, Zod `4.4.3`, and `@types/turndown` `5.0.6`; declare `@types/turndown: "catalog:"` as a package dev dependency. Declare `@types/bun: "catalog:"` explicitly because the isolated package check extends `tsconfig.base.json` with Bun globals. The package-contract test must assert both catalog entries and fail if the provider relies on root-only type resolution. Do not add direct `chromium-bidi`: the source has no import and Playwright owns the transport dependency.

Set the provider package version to the current OMP workspace release (`17.2.4` at this planning baseline), not the source package's `1.1.0`; use `@oh-my-pi/pi-chatgpt-web`, OMP repository metadata, MIT license metadata, a `chatgpt-web` bin pointing at `src/cli.ts`, and `files` entries for `src`, `README.md`, and `LICENSES`. This is a public workspace package like `@oh-my-pi/pi-natives`, so omit `"private": true`; keep only the separately bundled Electron launcher private.

The package manifest must keep `engines.bun >= 1.3.14`, export `.`, `./extension`, and `./cli`, and define sibling-compatible `check` (`biome check . && bun run check:types`), `check:types`, and `test` (`bun test --parallel`) scripts using `bun run` where chaining is required. Add `@modelcontextprotocol/sdk` `1.26.0` to the root catalog and resolve the package-local `playwright-core` `1.62.1` plus all catalog versions in `bun.lock`; do not copy the source's Bun 1.3.11, TypeScript 5.9.3, Turndown 7.2.0, or Chromium BiDi `12.1.0` pins.

- [ ] **Step 2: Add the package TypeScript boundary.**

`packages/chatgpt-web/tsconfig.json` must extend the workspace base, include only `src` and `test`, and use the same module/resolution settings as sibling TypeScript packages. Do not add a second compiler configuration or a package-local formatter configuration.

- [ ] **Step 3: Define the package-owned event contract.**

Create `src/provider/types.ts` with an explicit event union:

```ts
export type ChatGptWebErrorClass =
  | "aborted"
  | "browser_unavailable"
  | "login_required"
  | "profile_conflict"
  | "selector_drift"
  | "tool_protocol"
  | "runtime_draining"
  | "malformed_browser_output"
  | "unsupported_context"
  | "internal";

export type ChatGptWebEvent =
  | { type: "start"; responseId: string }
  | { type: "reasoning"; text: string; continuation?: boolean }
  | { type: "commentary"; text: string; continuation?: boolean }
  | { type: "text"; text: string; continuation?: boolean }
  | { type: "tool_call"; callId: string; name: string; argumentsJson: string; freeform: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: "done"; reason: "stop" | "toolUse" | "length" }
  | { type: "error"; errorClass: ChatGptWebErrorClass; retryable: boolean };

export interface ChatGptWebTurnIdentity {
  sessionId: string;
  turnId: string;
}

export interface ChatGptWebRuntimeAdmission {
  readonly runtimeEpoch: string;
  readonly lifecycleGeneration: number;
  readonly __opaque: unique symbol;
}

export interface ChatGptWebRuntimeReference {
  readonly __opaque: unique symbol;
}
```
```ts
export type ChatGptWebRuntimeAdmissionOwner =
  | "turn"
  | "tunnel"
  | "browser-lease"
  | "broker-binding"
  | "tunnel-process"
  | "connector";

export interface ChatGptWebRuntimeGate {
  /** Under one lifecycle lock/CAS, validate running state and register the initial reservation. */
  admit(kind: "turn" | "tunnel"): Promise<ChatGptWebRuntimeAdmission>;
  /** Under the same lock, add one uniquely releasable reference to an existing reservation. */
  retain(
    admission: ChatGptWebRuntimeAdmission,
    owner: Exclude<ChatGptWebRuntimeAdmissionOwner, "turn" | "tunnel">,
  ): ChatGptWebRuntimeReference;
  /** Idempotently drop exactly this admission/reference; clones and already-released handles fail closed. */
  release(handle: ChatGptWebRuntimeAdmission | ChatGptWebRuntimeReference): void;
  /** Close admission, invalidate the epoch, and wait/cancel all registered reservations. */
  drain(): Promise<void>;
  /** Start a fresh epoch/generation after drain; old handles remain invalid forever. */
  resume(): Promise<{ runtimeEpoch: string; lifecycleGeneration: number }>;
}
```
Every admission and retained reference is runtime-unforgeable, not merely TypeScript-opaque: the implementation keeps private random state plus `WeakSet`s for live admission/reference objects and rejects structural clones, stale epochs/generations, cross-runtime handles, duplicate releases, and releases after drain. Each `retain()` call creates a distinct reference even for the same owner kind, so releasing one browser lease or connector cannot release a sibling or make drain complete early.

Every admission is an opaque reservation created under the lifecycle gate lock: the gate validates the current runtime epoch/generation and increments the active/pending reservation count before releasing the lock. `drain()` closes new admission first and waits for all registered references; `resume()` creates a new epoch/generation and requires fresh broker/host state before accepting turns or connectors.

The OMP stream adapter in Task 4 is the only translator into OMP events; no later adapter may import Codex types.

- [ ] **Step 4: Add the package root contract and boundary test.**

Export only `CHATGPT_WEB_API`, `ChatGptWebEvent`, and `ChatGptWebTurnIdentity` from `src/index.ts` at this milestone. The package contract test imports the root entry, asserts `CHATGPT_WEB_API === "chatgpt-web"`, verifies the reserved `./extension` and `./cli` export targets in `package.json`, proves no `@oh-my-pi/pi-coding-agent` dependency exists, scans package source/test imports and build metadata for `codex-chatgpt-web`/Codex runtime dependency leakage, and checks the package workspace entry plus `bun.lock` for an unintended Codex package edge or copied submodule. Route/model assertions move to Task 2; extension-subpath import and registration assertions move to Task 5 after those files exist. Provenance-only license/notice references are allowlisted explicitly.

- [ ] **Step 5: Install and run the focused check.**

```text
bun install --frozen-lockfile
bun --cwd=packages/chatgpt-web run check
bun test packages/chatgpt-web/test/package-contract.test.ts
```

Expected: dependency resolution, package type/format checks, and the root contract test pass; no application/browser code is loaded yet.

- [ ] **Step 6: Commit the package boundary.**

```text
git add packages/chatgpt-web package.json bun.lock
git commit -m "feat: add ChatGPT Web provider package boundary"
```

---
## Task 2: Implement secure config, model routes, and browser login

**Files:**
- Create: `packages/chatgpt-web/src/config.ts`
- Create: `packages/chatgpt-web/src/models.ts`
- Create: `packages/chatgpt-web/src/browser/login.ts`
- Create: `packages/chatgpt-web/src/browser/login-host.ts` — minimal injected host contract before Task 3 widens it to `BrowserHost`.
- Create: `packages/chatgpt-web/src/setup.ts` — setup/configuration contract for browser-only and full mode.
- Create: `packages/chatgpt-web/src/cli.ts`
- Modify: `packages/chatgpt-web/src/index.ts` — export completed config/model/login/setup contracts at the end of Task 2.
- Create: `packages/chatgpt-web/test/config.test.ts`
- Create: `packages/chatgpt-web/test/models.test.ts`
- Create: `packages/chatgpt-web/test/login.test.ts`
- Create: `packages/chatgpt-web/test/login-host.test.ts`
- Create: `packages/chatgpt-web/test/cli.test.ts`
- Create: `packages/chatgpt-web/test/setup.test.ts`

**Interfaces:**
- Consumes: package contracts from Task 1 and the minimal injected `LoginHost` contract defined in this task; Task 3 widens it into `BrowserHost` without a sequencing cycle.
- Produces `resolveChatGptWebPaths(agentDir?: string)`, `ChatGptWebRuntimeConfig`, `availableChatGptWebModelRoutes(proAvailable)`, `createChatGptWebProviderModels(proAvailable, fullMode)`, `loginChatGptWeb(options)`, `hasChatGptWebLogin()`, `setupChatGptWeb(options)`, and a package CLI with fully implemented `setup`, `login`, `status`, `doctor`, and `uninstall` commands. `ChatGptWebRuntimeConfig` is package-owned and contains only `mode: "browser-only" | "full"`, an allowlisted `tunnelId: string | null`, and `runtimeKeyConfigured: boolean`; it contains no path, profile ID, credential, endpoint, or token. Task 6 adds `serve` and Task 8 adds the tunnel-owned `mcp --broker-handoff` entrypoint; neither is imported before its implementation task. Extends `src/index.ts` with the completed config/model/login/setup exports.

- [ ] **Step 1: Port the fixed route table without duplicating provider IDs.**

Adapt `codex-chatgpt-web/src/chatgpt-web-models.ts` into `src/models.ts`. Keep a package route key and a bare OMP model ID separate:

```ts
export const CHATGPT_WEB_MODEL_ROUTES = [
  { key: "light", slug: "chatgpt-web/light", name: "ChatGPT Web — Instant", effort: "low", requiresPro: false },
  { key: "medium", slug: "chatgpt-web/medium", name: "ChatGPT Web — Medium", effort: "medium", requiresPro: false },
  { key: "high", slug: "chatgpt-web/high", name: "ChatGPT Web — High", effort: "high", requiresPro: false },
  { key: "extra-high", slug: "chatgpt-web/extra-high", name: "ChatGPT Web — Extra High", effort: "xhigh", requiresPro: false },
  { key: "pro", slug: "chatgpt-web/pro", name: "ChatGPT Web — Pro", effort: "max", requiresPro: true },
] as const;
```

`createChatGptWebProviderModels()` must emit `id: key`, `name`, `reasoning: true`, `thinking: { mode: "effort", efforts: [effort], defaultLevel: effort }`, context window `256_000`, maximum output `64_000`, zero costs, `input: ["text", "image"]`, and `supportsTools: fullMode && !requiresPro`. It must omit service-tier, native WebSocket, and server-side compaction claims. The `pro` model is omitted unless the verified marker reports Pro availability.

- [ ] **Step 2: Implement OMP-owned paths and atomic persistence.**

`resolveChatGptWebPaths()` must derive `${agentDir}/chatgpt-web`, with `agentDir` defaulting through the existing OMP `PI_CODING_AGENT_DIR` behavior; any injected test root is accepted only after the same real-root, ownership, and ACL validation. Return explicit paths for `config.json`, `control-token`, `runtime-key`, `browser-profile`, `ownership`, `verification.json`, `logs`, and ignored local evidence. Create an owner-controlled real root; reject symlink/junction/reparse roots and intermediate/final links, verify Windows DACLs/inheritance or POSIX ownership/modes, and refuse a broad-access or redirected profile. Acquire `ownership` with an atomic create/replace protocol containing a random owner nonce, PID plus process-start identity, and profile generation; stale recovery is allowed only after proving the recorded process is dead. Every executable/profile/key/marker access goes through the native no-follow/reparse-safe adapter, returning a stable identity and a held handle that the next operation uses; a path-only check-then-open is not an accepted implementation. Every mutating setup/login/config/uninstall operation holds the owner lock for its complete read/verify/write/replace sequence and re-checks the fencing nonce before commit; lock acquisition is not inferred from a JSON record. Write JSON through a sibling temporary file plus an owner-held native directory handle and native compare-and-replace/`ReplaceFile`-equivalent operation, re-checking the parent and destination identities immediately before replacement/deletion; refuse destination swaps or lock loss. Read-only status/doctor may inspect without owning the profile but must never report secrets or raw paths. Uninstall removes only package-owned state while holding the owner lock and fails closed on ownership/ACL ambiguity.

- [ ] **Step 3: Adapt the source login flow behind a package-owned host contract.**
Define `LoginHost` in `src/browser/login-host.ts` with only `login(request: BrowserLoginRequest): Promise<BrowserLoginResult>` and `close(): Promise<void>`. `BrowserLoginRequest` contains package-owned profile/config references, headed mode, and abort signal; `BrowserLoginResult` contains only verification metadata. Task 3's `BrowserHost` extends this interface with leases and the closed browser facade.

Port `codex-chatgpt-web/src/browser-login.ts` to `src/browser/login.ts`, preserving its two-stage lifecycle: open a dedicated headed Chrome profile for interactive sign-in, wait for the user to exit it, then launch a persistent verification context with the stored profile. Implement this behind `LoginHost.login`; temporary-chat verification stays internal to the host and the public result contains only `BrowserLoginResult` metadata. The local host supplies an explicit executable override plus this deterministic discovery order: Windows `%ProgramFiles%\Google\Chrome\Application\chrome.exe`, `%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe`, `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`, `%ProgramFiles%\Chromium\Application\chrome.exe`, `%LOCALAPPDATA%\Chromium\Application\chrome.exe`; macOS `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/Applications/Chromium.app/Contents/MacOS/Chromium`; Linux `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/snap/bin/chromium`. The override and every discovered candidate require no-follow/reparse-safe identity and executable checks. A missing executable is an actionable configuration error rather than a silent fallback.

Login must:

1. Verify an authenticated Temporary Chat page.
2. Detect Pro availability and write only a versioned boolean marker bound to the current profile generation and verified browser executable identity.
3. Never write cookies, headers, URLs with query credentials, profile IDs, or tokens to logs or returned CLI metadata.
4. Close the dedicated browser/context on success, cancellation, verification failure, and child-process failure.
5. Return only `BrowserLoginResult` metadata needed by the CLI; never return an OAuth credential or API key.

The marker includes `version: 1`, `authenticated: true`, `verifiedAt`, `proAvailable`, `profileGeneration`, a cryptographic executable digest/version, an immutable native profile/executable identity, and the owner fencing nonce; it contains no profile path, account/profile identifier, cookie, header, token, credential, or OAuth material. `hasChatGptWebLogin()` accepts it only when the timestamp is within the configured seven-day maximum age, the marker is atomically readable, the ownership/profile generation, complete executable digest/version/identity, and owner fence still match, the profile root passes link/ACL checks, and the marker has not been redirected or tampered with. Invalid, stale, linked, mismatched, replaced, or missing markers make the provider unavailable.

- [ ] **Step 4: Implement the package CLI foundation.**
Full-mode `tunnel-id` is an opaque allowlisted service identifier, not a URL or endpoint supplied by the user/model. Configuration resolves it to a pinned scheme/host/port and authenticated server identity (TLS validation with the package CA/identity pin and no cross-host redirects); DNS rebinding, redirect, certificate/CA, host, port, and endpoint substitution fail closed. Tests replace the resolved endpoint and verify that no runtime key or connector bootstrap is sent.

Implement `src/cli.ts` as the package bin with `setup`, `login`, `status`, `doctor`, and `uninstall` handlers using injected config/login/runtime dependencies. `setup --mode browser-only` writes the browser-only mode; `setup --mode full --tunnel-id <id> --runtime-key-file <path>` validates the tunnel ID, opens the supplied key through the native no-follow/owner-ACL adapter, imports its bytes into the package-owned `runtime-key` file atomically, and stores only the validated configuration. `tunnel key-import` is an alias into this same code path if source-compatible UX requires it; it never stores the caller's path as an unchecked runtime setting. `status` and `doctor` are read-only and redact paths, profile IDs, markers' identities, cookies, tokens, credentials, and raw errors; `uninstall` removes only package-owned state after ownership/ACL checks. Do not import `mcp/main.ts` or create `serve`/MCP placeholders before later tasks; Task 6 and Task 8 extend the same parser with real handlers.

- [ ] **Step 5: Add deterministic model/config/login/CLI tests.**

Tests must cover:

- Windows path case normalization and traversal rejection.
- POSIX symlink root/child and Windows junction/reparse root/child rejection.
- POSIX owner/mode checks, Windows broad/inherited ACL rejection, atomic replacement, destination-swap refusal, and profile/executable identity re-checks.
- Owner-lock contention, dead-PID/start-identity validation, generation mismatch, profile swap, and stale-marker rejection.
- Bare model IDs, rendered `chatgpt-web/<id>` selectors, exact effort/thinking mapping, Pro omission/inclusion, and `supportsTools` behavior.
- Corrupt, stale, redirected, tampered, profile-generation-mismatched, and executable-mismatched marker rejection with relogin requirement.
- Login cancellation/failure closes the temporary browser context and leaves no partial marker; setup rejects invalid tunnel IDs, missing/replaced/non-owner runtime-key files, and broad ACLs; CLI status/doctor output contains no secrets or profile identifiers.
- `login-host.test.ts` uses a fake child/browser spawn seam with high-entropy credential, loader, proxy, and path-override canaries; it asserts the allowlisted environment/argv and structured diagnostics contain none of them on success, failure, cancellation, or abnormal EOF.

Use a fake login host; no test may contact ChatGPT.

- [ ] **Step 6: Run focused tests.**

```text
bun test packages/chatgpt-web/test/config.test.ts packages/chatgpt-web/test/models.test.ts packages/chatgpt-web/test/login.test.ts packages/chatgpt-web/test/login-host.test.ts packages/chatgpt-web/test/setup.test.ts packages/chatgpt-web/test/cli.test.ts
```

Expected: all deterministic tests pass with network disabled.

- [ ] **Step 7: Commit config, login, and CLI foundation.**

```text
git add packages/chatgpt-web/src/config.ts packages/chatgpt-web/src/models.ts packages/chatgpt-web/src/browser/login-host.ts packages/chatgpt-web/src/browser/login.ts packages/chatgpt-web/src/setup.ts packages/chatgpt-web/src/cli.ts packages/chatgpt-web/src/index.ts packages/chatgpt-web/test/config.test.ts packages/chatgpt-web/test/models.test.ts packages/chatgpt-web/test/login.test.ts packages/chatgpt-web/test/login-host.test.ts packages/chatgpt-web/test/setup.test.ts packages/chatgpt-web/test/cli.test.ts
git commit -m "feat: add ChatGPT Web profile and model configuration"
```

---

## Task 3: Port the browser worker behind a secure runtime-host interface

**Files:**
- Create: `packages/chatgpt-web/src/runtime/host.ts`
- Create: `packages/chatgpt-web/src/runtime/local-host.ts`
- Create: `packages/chatgpt-web/src/runtime/playwright-transport.ts` — package-private adapter from the native inherited byte pipe to the pinned Playwright `ConnectOverCDPTransport` object contract; it implements Chromium remote-debugging-pipe UTF-8 JSON/NUL framing with incremental bounded parsing, malformed/oversized-message rejection, close/error propagation, and no endpoint/path exposure.
- Create: `packages/chatgpt-web/src/browser/browser-worker.ts`
- Create: `packages/chatgpt-web/src/browser/chatgpt-session.ts`
- Create: `packages/chatgpt-web/src/browser/markdown.ts`
- Create: `packages/chatgpt-web/src/browser/concurrency.ts`
- Create: `packages/chatgpt-web/src/browser/process-line-writer.ts`
- Create: `packages/chatgpt-web/src/runtime/logging.ts` — shared provider structured-log/diagnostic allowlist.
- Create: `packages/chatgpt-web/test/browser-worker.test.ts`
- Create: `packages/chatgpt-web/test/browser-contract.test.ts`
- Create: `packages/chatgpt-web/test/playwright-transport.test.ts` — compile/runtime contract for the pinned transport overload, framing bounds, malformed-message close, and pipe teardown without Chrome/network access.
- Create: `packages/chatgpt-web/test/native-browser-transport.integration.test.ts` — real local Chromium gate for `launchVerifiedBrowser()` plus inherited `--remote-debugging-pipe`, `connectOverCDP`, `Browser.getVersion`/`about:blank`, and clean child/pipe teardown; no account or network.
- Create: `packages/chatgpt-web/test/logging.test.ts`

**Interfaces:**
- Consumes: config, login marker, model routes, and event types from Tasks 1–2.
- Produces a narrow, launcher-neutral contract:

```ts
export type BrowserNavigationTarget = { kind: "temporary-chat" };
export type BrowserSelectorKey =
  | "composer"
  | "send"
  | "response"
  | "reasoning"
  | "commentary"
  | "generation"
  | "attachment-input"
  | "health";
export type BrowserRoleTarget =
  | { role: "button"; name: "Send" | "Stop generating" | "Attach files" | "Regenerate" }
  | { role: "textbox"; name: "Message" | "Prompt" }
  | { role: "heading"; name: "ChatGPT" }
  | { role: "main" };
export interface BrowserFilterTarget {
  key: BrowserSelectorKey;
  /** Bounded literal text used only for host-side filtering; never a selector or locator expression. */
  hasText?: string;
}
export type BrowserKey = "Enter" | "Escape" | "ControlOrMeta+Enter";
export interface BrowserLeaseCapability {
  readonly __opaque: unique symbol;
}
export interface BrowserAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly __opaque: unique symbol;
}
export interface ComposerSnapshot {
  ready: boolean;
  text: string;
  canSubmit: boolean;
}
export interface ResponseSnapshot {
  userText: string;
  assistantText: string;
  reasoningText: string;
  generationId: string | null;
  settled: boolean;
}
export interface HealthSnapshot {
  temporaryChat: boolean;
  ready: boolean;
  errorClass: ChatGptWebErrorClass | null;
}

export interface BrowserLocator {
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  insertText(text: string): Promise<void>;
  press(key: BrowserKey): Promise<void>;
  pressSequentially(text: string): Promise<void>;
  setInputFiles(files: readonly BrowserAttachment[]): Promise<void>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  count(): Promise<number>;
  nth(index: number): BrowserLocator;
  last(): BrowserLocator;
  allInnerTexts(): Promise<readonly string[]>;
  textContent(): Promise<string | null>;
  filter(target: BrowserFilterTarget): BrowserLocator;
}

export interface BrowserPage {
  goto(target: BrowserNavigationTarget): Promise<void>;
  locator(target: BrowserSelectorKey): BrowserLocator;
  getByRole(target: BrowserRoleTarget): BrowserLocator;
  readComposerSnapshot(): Promise<ComposerSnapshot>;
  readResponseSnapshot(): Promise<ResponseSnapshot>;
  readHealthSnapshot(): Promise<HealthSnapshot>;
  state(): Promise<"temporary-chat" | "other" | "closed">;
  close(): Promise<void>;
}

export interface BrowserLeaseRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly modelKey: string;
  readonly mode: "browser-only" | "full";
  readonly headed: boolean;
  readonly signal?: AbortSignal;
}
export interface BrowserHost extends LoginHost {
  lease(request: BrowserLeaseRequest, admission: ChatGptWebRuntimeAdmission): Promise<BrowserLease>;
  close(): Promise<void>;
}

export interface BrowserLease {
  id: string;
  capability: BrowserLeaseCapability;
  page: BrowserPage;
  stageAttachment(input: { name: string; bytes: Uint8Array }): Promise<BrowserAttachment>;
  close(): Promise<void>;
}
```

The selector keys, role keys, keyboard keys, and snapshot shapes are closed package-owned unions/records resolved inside the host; they are not CSS/XPath strings, URLs, arbitrary text selectors, or file paths supplied by a model, CLI, or RPC caller. `readComposerSnapshot`, `readResponseSnapshot`, and `readHealthSnapshot` are typed host-side DOM extraction replacements for the source worker's `evaluate`/`evaluateAll`; no generic `evaluate`, cookies, storage state, raw CDP URL, websocket endpoint, arbitrary JavaScript, or endpoint-bearing descriptor exists. `state()` returns a redacted enum rather than a URL that could contain credentials. `BrowserLease.capability` is an opaque per-lease capability, never the host control token.
The host mints each `BrowserAttachment` reference; `stageAttachment()` bounds and hashes the bytes, opens the staged file through the native browser-safe no-follow adapter, and retains its file identity/handle until `setInputFiles()` and lease close. The record is bound to profile-owner generation, session ID, turn ID, and lease capability; `setInputFiles()` rejects structural clones, wrong-session/turn refs, replay, link/reparse swaps, size/hash changes, and closed handles. No path or raw file descriptor crosses the BrowserHost/RPC boundary.
`stageAttachment(input)` treats `name` as display-only metadata; it chooses a fresh random basename under a lease-owned staging directory, rejects path separators/control/NUL/UNC/device forms in the display name, and never derives a staged path from caller-controlled name text.
All browser-host extraction has hard caps before allocation or model emission: composer/response/reasoning text, generation IDs, locator counts and `allInnerTexts`/`textContent`, attachment names/bytes, and error fields use fixed byte/count/depth limits. Oversized, malformed, or unexpectedly deep DOM data returns a typed fail-closed error rather than being silently truncated; tests inject oversized/malformed snapshots and verify no unbounded result reaches the provider.


`local-host.ts` is the only implementation in the provider milestone and uses the exact locked `playwright-core@1.62.1` API internally. Before `login()` or `lease()` starts a browser, it resolves the executable/profile through the native browser-safe no-follow/ACL adapter, verifies digest/version and immutable identity, binds the marker/profile generation and owner lock, calls `launchVerifiedBrowser()` with the digest-bound `NativeVerifiedExecutable` and owner-controlled `NativeLaunchEnvironment`, and adapts the returned private byte pipe to Playwright's public `ConnectOverCDPTransport` shape (`open?`, `send(message)`, `close`, `onmessage?`, `onclose?`). It then calls `chromium.connectOverCDP(transport, { isLocal: true, noDefaults: true })`; this is an in-process inherited-pipe connection, never a URL, websocket, TCP listener, or endpoint fallback. Playwright receives no executable/profile path; the native `NativeOwnedBrowserProcess` owns the child and pipe, and a transport/identity mismatch closes both and fails closed. Add a compile contract against the pinned package types so a future Playwright upgrade cannot silently remove this overload.
The marker and spawn contract binds the executable to a cryptographic digest/version plus immutable opened identity or a non-writable trusted root, not only a path/file ID; same-file content mutation between validation and spawn is rejected. The owner lock is a held native OS lock/dir handle with no-delete semantics and a fencing nonce checked on every host operation; atomic marker replacement alone never transfers ownership. Tests cover same-file executable mutation and delete/replace races while the incumbent owner remains alive.
Keep `BrowserHost` free of Electron, coding-agent, and Codex types. The request contains only a package-owned profile reference, headed/headless mode, turn ID, and abort signal; it never accepts a filesystem path or executable. The runtime admission gate is checked atomically before lease creation and rechecked immediately before browser start; a draining/stale `ChatGptWebRuntimeAdmission` is rejected. Acquire one cross-process profile owner before creating leases; an owner lock includes a random generation/nonce and verified process identity, a second owner fails explicitly, and stale recovery requires proof the recorded owner is dead. Revalidate the current login marker, profile generation, executable identity, and owner identity immediately before every login/lease browser spawn, including Pro routes; a mismatch or replacement fails closed. A lease close is idempotent and destroys only its page. The host must close all leases and release ownership on shutdown.
The launcher control service uses the same owner-controlled native local listener/pipe as the provider broker, not a loopback TCP bearer endpoint. A client must present the opaque native connection/peer proof and remain the expected descendant or explicitly authorized owner process; `NativePeerConnection.currentPeer()` is revalidated before every request. The control token, owner/epoch, lease capability, connection nonce, and sequence are necessary but not sufficient, so a same-user process that steals a token or replays a descriptor on another connection is rejected before browser state is touched. Tests cover stolen-token clients, cross-connection handles, reparent/exec/PID-reuse, and peer mutation during an in-flight request.

Inventory every browser-worker operation and implement only the required `BrowserLocator` methods. The launcher RPC authenticates every request with the control token, owner/epoch, lease capability, a per-connection nonce, and a strictly monotonic sequence; reject replay, stale epoch, wrong lease, unknown selector key, malformed arguments, and cross-lease access. Never tunnel a generic page object.
- [ ] **Step 1: Define the browser contract and test gate.**

Freeze the `BrowserHost`/`BrowserPage`/`BrowserLocator`/`BrowserLease` interfaces above before porting the worker. The provider sees only closed selector/role/key unions, typed bounded snapshots, opaque lease/attachment references, and explicit lifecycle methods; it never receives a Playwright `Page`, CSS/XPath selector, arbitrary URL/path, JavaScript evaluator, CDP endpoint, cookie/storage API, or child-process descriptor. Add `browser-contract.test.ts` first to reject unknown selector keys, malformed snapshot shapes, oversized/deep values, structural clones, wrong-session/turn/lease attachment refs, and any endpoint-bearing field.

- [ ] **Step 2: Adapt the browser worker.**

Port `codex-chatgpt-web/src/adapters/chatgpt-web/browser-worker.ts` and selectors from `codex-chatgpt-web/src/chatgpt-session.ts`. Preserve:

- fresh `CHATGPT_TEMPORARY_CHAT_URL` navigation for each turn;
- exact effort selection from the model route;
- attachment IDs are host-minted opaque refs bound to owner generation/session/turn/lease records; they resolve through a held native file identity/hash/size at `setInputFiles()`, never through a path-only re-open, and raw filesystem paths never cross the facade/RPC;
- user/assistant/generation evidence before treating a response as submitted;
- completion action plus settled text before completion;
- heartbeat and abort propagation;
- five active tab leases per profile owner, with an explicit sixth-turn error;
- Markdown conversion removes controls/scripts/styles, keeps fenced code/GFM lists, and sanitizes link targets: only bounded `http:`, `https:`, and `mailto:` targets with no control characters are OSC8-clickable; `file:`, `javascript:`, `data:`, `ftp:`, unknown schemes, malformed URLs, and control-bearing targets render as plain text;

The worker emits browser-only `ChatGptWebEvent` values through callbacks; it must not know about OMP `AssistantMessageEventStream`, Electron, MCP, or tool approval. The provider orchestration module in Task 4 ports the source `codex-chatgpt-web/src/adapters/chatgpt-web/index.ts` semantics: register/issue a per-turn broker capability before prompt compilation, race browser output against broker tool batches, validate names and schemas, emit exact OMP tool-call IDs, retain outstanding calls, pair exact `ToolResultMessage` values on continuation, and revoke the capability on completion/abort/error.

- [ ] **Step 3: Port launcher-neutral helper behavior.**

Implement a package-owned line writer for child processes, adding a hard byte/line limit, typed startup/ready/error/EOF states, bounded stderr capture, and explicit abnormal EOF handling; do not claim these protections are inherited from the source writer. Never forward raw child lines to logs; the lifecycle layer consumes typed status/error fields.
Implement `runtime/logging.ts` as the provider-side structured sink: accept only a closed stage enum, bounded durations/counts, exit code, error class, and non-secret hashes; reject or type-erasure any DOM text, prompt fragment, connector payload, header, query URL, cookie, profile path, raw child line, or exception message. Route returned CLI/health diagnostics through the same allowlist rather than applying regex redaction after raw text is captured.
Health/status/UI adapters map unknown browser or Playwright failures to the closed `ChatGptWebErrorClass` enum (`internal` when no safer class applies) before snapshot serialization; raw exception text, DOM text, URLs, queries, headers, profile paths, and prompt fragments never enter `HealthSnapshot` or diagnostics. Tests inject high-entropy canaries through health, status, and preload responses and assert only the enum and bounded non-secret fields survive.

- [ ] **Step 4: Add browser fixture and ownership tests.**

Use a fake page/locator implementation to verify selector contracts without a live browser. Cover login-host close paths, effort selection, attachment/send readiness, completion tracker settle delay, DOM health failure, abort cleanup, five leases, sixth rejection, two competing owners, stale-owner recovery, idempotent lease close, sibling-turn survival, and helper EOF. Add one fixture per source regression represented by recent commits `2441ff6`, `2dfc791`, and `20c21b0`.
The test harness must also create two stream factories against the same profile owner, prove the five-slot cap is shared within that owner, and assert cancellation is an idempotent transition: page closes, lease releases once, pending broker invocation rejects, active counters reach zero, the slot is reusable, late results reject, and sibling turns remain live. `logging.test.ts` injects high-entropy cookie, control-token, runtime-key, profile-path, prompt, URL-query, authorization-header, and unknown-format canaries and scans logger memory/diagnostics plus every captured stdout/stderr sink after success and each failure path.
Browser fixtures must cover cross-session/turn attachment refs, replacement after validation and before `setInputFiles()`, marker/profile/executable swaps while the runtime is active (including Pro), oversized/deep/malformed DOM snapshots, unsafe Markdown URL schemes with OSC8 disabled, and high-entropy attachment/log payload canaries.
`native-browser-transport.integration.test.ts` is a separate real-OS gate, not a fake-host test: resolve only the CI-provisioned pinned Chromium executable and its verified identity, launch it through `launchVerifiedBrowser()` with inherited `--remote-debugging-pipe`, prove the parent-to-child command mapping uses fd/handle 3 and child-to-parent response mapping uses fd/handle 4 on POSIX/macOS/Windows, connect through the package-private `ConnectOverCDPTransport` adapter, assert Chromium's exact UTF-8 JSON/NUL framing while issuing `Browser.getVersion` and opening `about:blank`, then close the transport and prove the child exits with no orphan or leaked handle. The fixture must fail when `CHATGPT_WEB_TEST_CHROMIUM` is absent and must not download, log in, contact a connector, or access the network.

- [ ] **Step 5: Run focused browser tests.**

```text
bun test packages/chatgpt-web/test/browser-worker.test.ts packages/chatgpt-web/test/browser-contract.test.ts packages/chatgpt-web/test/playwright-transport.test.ts packages/chatgpt-web/test/logging.test.ts
bun test packages/chatgpt-web/test/native-browser-transport.integration.test.ts
```

Expected: unit tests pass without Chrome, CDP, ChatGPT, or network access; the separate native integration passes only with the verified CI Chromium executable and still uses no account, connector, or network.

- [ ] **Step 6: Commit the browser runtime.**

```text
git add packages/chatgpt-web/src/runtime/host.ts packages/chatgpt-web/src/runtime/local-host.ts packages/chatgpt-web/src/runtime/playwright-transport.ts packages/chatgpt-web/src/runtime/logging.ts packages/chatgpt-web/src/browser/browser-worker.ts packages/chatgpt-web/src/browser/chatgpt-session.ts packages/chatgpt-web/src/browser/markdown.ts packages/chatgpt-web/src/browser/concurrency.ts packages/chatgpt-web/src/browser/process-line-writer.ts packages/chatgpt-web/test/browser-worker.test.ts packages/chatgpt-web/test/browser-contract.test.ts packages/chatgpt-web/test/playwright-transport.test.ts packages/chatgpt-web/test/native-browser-transport.integration.test.ts packages/chatgpt-web/test/logging.test.ts
git commit -m "feat: add ChatGPT Web browser runtime"
```

---

## Task 4: Adapt prompts, turns, and output into native OMP events

**Files:**
- Create: `packages/chatgpt-web/src/provider/prompt.ts`
- Create: `packages/chatgpt-web/src/provider/session.ts`
- Create: `packages/chatgpt-web/src/provider/orchestration.ts` — source adapter/index semantics for broker issue/claim, tool batches, continuation, and revoke.
- Create: `packages/chatgpt-web/src/provider/stream.ts`
- Create: `packages/chatgpt-web/test/provider/prompt.test.ts`
- Create: `packages/chatgpt-web/test/provider/stream.test.ts`
- Create: `packages/chatgpt-web/test/provider/continuation.test.ts`
- Create: `packages/chatgpt-web/test/fixtures/chatgpt-events.ts`
- Modify: `packages/chatgpt-web/src/index.ts` — export the completed provider/session/stream contracts.

**Interfaces:**
- Consumes: `BrowserHost`, browser worker events, OMP `Context`, `Message`, `Model`, `SimpleStreamOptions`, and `AssistantMessageEventStream`.
- Produces:

```ts
export function createChatGptWebStream(options?: ChatGptWebStreamOptions):
  (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) => AssistantMessageEventStream;

export interface ChatGptWebStreamOptions {
  config?: ChatGptWebRuntimeConfig;
  host?: BrowserHost;
  gate?: ChatGptWebRuntimeGate;
  now?: () => number;
}
```

- [ ] **Step 1: Define the OMP prompt envelope.**
Adapt `codex-chatgpt-web/src/adapters/chatgpt-web/prompt.ts` to serialize `Context.systemPrompt`, `Context.messages`, the selected model route, and OMP session identity. Determine mode before compiling tools: browser-only mode and every `requiresPro` route omit local tool names, schemas, capability values, and tool-result continuation data entirely; full mode may include only the canonical tool declaration set after `issue(binding)` and includes the model-facing `turnToken` plus mandatory `chatgpt_web_bind_turn` instructions. `supportsTools: false` is not sufficient because OMP's SDK can still choose an in-band fallback dialect, so the prompt compiler itself must strip the fields.

Keep control tokens, connector/bootstrap secrets, browser profile paths, auth values, Codex metadata, Codex prompt hashes, and retired Codex request fields out of the model-visible JSON. The full-mode `turnToken` is the sole deliberate exception: it is a single-turn correlation nonce, not a control credential, and may appear only in the dedicated bind instruction; connector/session secrets and binding IDs remain on the authenticated OS-bound channel. The prompt requires bind-before-answer/tool and read-only/Pro prompts reject any turn token. Keep images out of the JSON body and represent them as stable attachment references; reattach current-turn images on every fresh Temporary Chat. Enforce the source limits of at most 10 attachments and 50 MB total, failing explicitly on overflow.
- [ ] **Step 2: Implement session keys and continuation.**

Require `options.sessionId`; accept only OMP's normal keyless `N/A` sentinel in `streamOptions.apiKey` when the core supplies it, ignore it for authentication, reject any other non-empty credential material, and never resolve credentials from `AuthStorage`. Obtain one current `ChatGptWebRuntimeAdmission` from the lifecycle gate before lease acquisition and pass the same opaque admission to `BrowserHost.lease()` and full-mode broker `issue()`; both reject after drain or generation change and are rechecked immediately before side effects. Keep active sessions in `providerSessionState` under a package-prefixed key. Generate an unguessable per-turn ID and store browser lease, trace/text feeds, pending tool-call IDs, route/effort, mode, capability binding, model-facing turn-token state, authenticated MCP connector/session nonce, profile owner generation, and expiry. Reject a model/effort or mode change while a browser turn is active; close the lease and retire the binding/connector session on abort, error, expiry, or session shutdown. The connector is never admitted on a stale lifecycle generation.

- [ ] **Step 3: Convert browser events to OMP events.**

Build the partial `AssistantMessage` incrementally:

- `reasoning` → `thinking_start`/`thinking_delta`/`thinking_end`;
- `commentary` and `text` → `text_start`/`text_delta`/`text_end`;
- `usage` → update `AssistantMessage.usage` on the current partial/final message; do not invent a non-existent OMP usage event;
- browser tool request → `toolcall_start`/`toolcall_delta`/`toolcall_end` with the original call ID and exact JSON arguments;
- `done` → `done` with `reason: "stop"`, `"toolUse"`, or `"length"`;
- abort/provider failure → `error` with `"aborted"` or `"error"`.

Do not emit a tool call unless its name and `customWireName` resolve to the current `Context.tools` set and its arguments validate against the current schema. Do not execute tools inside this package. Pro and browser-only routes must reject any tool event before it reaches the broker.

- [ ] **Step 4: Implement browser-only and full-mode continuation.**

In browser-only mode, obtain a current admission, omit the turn token and all local tools, return the browser answer as a normal assistant response, and prove that no broker/MCP process starts. In full mode, `orchestration.ts` issues the per-turn token and binding only with that same admission before prompt compilation, races browser output against `nextInvocationBatch`, emits a single OMP tool-call batch with exact IDs, and requires `chatgpt_web_bind_turn` before any answer/tool action. When the broker produces tool calls, end the provider stream with `toolUse`; the production coding-agent loop and `ExtensionToolWrapper` execute/approve them. On the next invocation, consume matching `ToolResultMessage` entries from `context.messages`, resolve the exact batch cardinality once, and resume the same browser turn. A missing/stale admission fails closed rather than reopening the turn.
- [ ] **Step 5: Make compaction and auth behavior explicit.**

Do not implement Codex compaction, server-side compaction, or a silent context truncation path. Report an explicit typed unsupported/over-budget provider error when the compiled OMP context exceeds the browser request limits; preserve the existing session and release its lease/binding according to the normal failure path. Authentication remains package-local marker/config validation: `auth: "none"` is the registration metadata, OMP's `N/A` sentinel is accepted only as a keyless placeholder, any other credential input is rejected, and no `AuthStorage`, `omp token`, request header, OAuth callback, or profile identifier participates in the stream.

- [ ] **Step 6: Test event and continuation contracts.**

Tests must assert exact event order for reasoning/text, usage, partial tool JSON, tool-use termination, OMP tool-result continuation, abort, malformed event, image attachment references, retired-handle redaction, Pro/browser-only tool rejection, missing session identity, accepted-and-ignored keyless `N/A` sentinel, rejected non-sentinel credential material, unsupported compaction, and redaction of URLs/headers/profile paths/tokens from provider output. Prompt fixtures must prove browser-only and Pro requests contain no local tool names/schemas or turn token, while full-mode prompts contain exactly the canonical bound set plus only the model-facing turn token. Connector tests must prove control/bootstrap secrets never enter model-visible data; modified/expired turn tokens, wrong connector/session nonce, replay, duplicate bind, and expired bindings fail before browser or broker dispatch, while same-session repeated bind is idempotent. The continuation test must prove a tool result batch is consumed exactly once with exact cardinality and cannot resolve a different session or binding.

- [ ] **Step 7: Run focused provider tests.**

```text
bun test packages/chatgpt-web/test/provider/**/*.test.ts
```

Expected: all event/continuation tests pass with fake browser events, no network, no AuthStorage credential, and no spawned MCP/tunnel process.

- [ ] **Step 8: Commit the native provider adapter.**

```text
git add packages/chatgpt-web/src/provider/prompt.ts packages/chatgpt-web/src/provider/session.ts packages/chatgpt-web/src/provider/orchestration.ts packages/chatgpt-web/src/provider/stream.ts packages/chatgpt-web/src/index.ts packages/chatgpt-web/test/provider/prompt.test.ts packages/chatgpt-web/test/provider/stream.test.ts packages/chatgpt-web/test/provider/continuation.test.ts packages/chatgpt-web/test/fixtures/chatgpt-events.ts
git commit -m "feat: expose ChatGPT Web as an OMP stream provider"
```

---

## Task 5: Add the keyless provider seam, registration, and local CLI enablement

**Files:**
- Create: `packages/chatgpt-web/src/extension.ts`
- Create: `packages/chatgpt-web/test/extension.test.ts`
- Create: `packages/coding-agent/src/extensibility/extensions/keyless-provider.ts` — host-only mint/validate/revoke authority for non-serializable, source-scoped keyless registrations.
- Modify: `packages/coding-agent/src/extensibility/extensions/loader.ts` — expose the host issuance method on each `ConcreteExtensionAPI`, bound to the exact loaded extension path.
- Modify: `packages/coding-agent/src/extensibility/extensions/types.ts`
- Modify: `packages/coding-agent/src/config/model-registry.ts`
- Create: `packages/coding-agent/src/commands/chatgpt-web.ts`
- Modify: `packages/coding-agent/src/cli-commands.ts`
- Modify: `packages/coding-agent/package.json`
- Modify: `bun.lock`
- Create: `packages/coding-agent/test/chatgpt-web-command.test.ts`
- Modify: `packages/coding-agent/test/model-registry-runtime-provider.test.ts`

**Interfaces:**
- Consumes: `createChatGptWebStream`, route/model/config/login APIs from `packages/chatgpt-web`.
- Produces the provider registration:

```ts
pi.registerProvider("chatgpt-web", {
  baseUrl: "chatgpt-web://local",
  api: "chatgpt-web",
  auth: "none",
  keylessCapability: registration.keylessCapability,
});
```

- [ ] **Step 1: Add and test the narrow host registration seam.**
Add `issueKeylessProviderRegistration(request)` to the host `ExtensionAPI` contract. The request is a closed structural union containing only `api: "chatgpt-web"` and `baseUrl: "chatgpt-web://local"`; it returns `KeylessProviderRegistration | undefined`, where the returned `keylessCapability` is an opaque object identity, not a serializable token. `packages/chatgpt-web/src/extension.ts` declares the same narrow structural method locally and does not import `packages/coding-agent`.

`ConcreteExtensionAPI` calls the host-only authority with its loaded `extension.path`; the authority mints a fresh generation only after the extension has validated its owner-controlled marker/config and only for the allowlisted package source, API, and base URL. The authority records the capability in a private `WeakMap`/source map, so forged structural clones, JSON round trips, copied fields, and capabilities from another extension cannot validate. `model-registry.ts` validates the object identity, source ID, API, base URL, and live generation when draining `pendingProviderRegistrations`; `clearSourceRegistrations()` revokes every generation for that source. Static catalog reload, marker/config change, extension replacement, and Pro-entitlement change therefore require a fresh issuance or remove the provider; no stale capability survives.

The existing `models-config.ts` and `models-config-schema.ts` already validate and type `auth: "none"` for static model configuration. Do not make runtime `ProviderConfig.auth` a generic keyless escape hatch: add an opaque host-issued `KeylessProviderRegistration` capability whose native/private handle is minted only for the exact `chatgpt-web` API, package-owned extension source, and `chatgpt-web://local` base URL after marker/config validation. Runtime registration accepts `auth: "none"` only with that capability; arbitrary providers, forged/structural clones, wrong source IDs, changed API/base URL, and user/model-supplied capability fields fail closed. Maintain a source-scoped runtime-keyless map (`provider -> source`) that is re-applied after every static catalog/model reload and unioned with static keyless providers for availability and API-key resolution. A source's direct re-registration replaces its prior marker; registration that omits or changes `auth: "none"` removes that source/provider marker immediately. Runtime registration must never create an `AuthStorage` credential. Source handoff/removal must delete only that source's runtime marker, custom API, model overlays, and OAuth state together. Propagate optional `supportsTools?: boolean` from public provider model config through runtime overlays into `Model`. Do not touch `KnownApi`, `ApiOptionsMap`, or generic stream wire types.
Add `"@oh-my-pi/pi-chatgpt-web": "workspace:*"` to `packages/coding-agent/package.json`; do not use a catalog protocol for this private workspace edge. Refresh `bun.lock` after this manifest change and inspect the coding-agent/provider workspace entries before the frozen-install gate.

The model-registry test must assert: a keyless source-scoped provider is available without credentials and remains keyless across static catalog reload; a different source's marker survives handoff; `model.provider` is `chatgpt-web`; model IDs are bare and selectors render `chatgpt-web/light` etc.; `supportsTools` is false for browser-only/Pro and true only for full non-Pro; `clearSourceRegistrations()` removes the model/API/keyless state; and no built-in API registration remains.

- [ ] **Step 2: Implement the extension factory.**

`packages/chatgpt-web/src/extension.ts` must export a default structural `ExtensionFactory`. It reads the owner-controlled marker/config and registers only verified routes using the host-issued `KeylessProviderRegistration` capability; it passes `auth: "none"`, the custom API identifier, bare model IDs, `thinking` metadata, `supportsTools`, and a lazy `streamSimple` closure. The extension source registration exposes a host-driven refresh/replacement hook: after static catalog/model reload, explicit marker/config changes, or Pro entitlement changes, the host re-reads and source-replaces the model/capability descriptor, removing it when invalid; no stale model list or `supportsTools` value survives reload. Constructing the factory or loading the extension must not create a browser host, listen on the broker, start a tunnel, import coding-agent execution internals, create an OAuth provider, or write `AuthStorage`; the first provider stream call resolves config and host, and full-mode startup follows the broker-first lifecycle in Task 8.

- [ ] **Step 3: Add the lazy host command with exact settings persistence.**

Add one `chatgpt-web` command entry to `packages/coding-agent/src/cli-commands.ts`. `src/commands/chatgpt-web.ts` must:

- resolve `@oh-my-pi/pi-chatgpt-web/extension` with the package export;
- `enable`: read `settings.get("extensions")`, append the resolved absolute extension path exactly once, call `settings.set("extensions", next)`, then `await settings.flush()`;
- `disable`: remove only that exact resolved path, persist with `set`/`flush`, and leave unrelated extensions untouched;
- `status`: report activation, marker validity, Pro availability, configured browser host, and read-only browser runtime health without printing paths, cookies, control tokens, profile IDs, or credentials;
- `login`: invoke the package-local login flow, never `AuthStorage.login`;
- `doctor`: run only read-only path/link/ACL, marker, Chrome, mode, and broker/tunnel configuration checks consumed by later launcher health tests.

Do not change general extension discovery, add ambient extension metadata, or start an always-on provider.

- [ ] **Step 4: Test provider registration and command behavior.**

The command test must use an isolated YAML settings directory and assert idempotent enable, exact disable, no unrelated extension removal, `Settings.flush()` persistence, no secret output, no `AuthStorage` row/profile ID, `omp token chatgpt-web` refusal/no credential, model discovery after loading the extension, direct same-source re-registration replacing stale keyless markers, forged/structural/wrong-source keyless capability rejection, refresh after static catalog reload and marker/Pro changes, and extension cleanup removing `chatgpt-web` custom API and keyless state.

```text
bun test packages/chatgpt-web/test/extension.test.ts packages/coding-agent/test/chatgpt-web-command.test.ts packages/coding-agent/test/model-registry-runtime-provider.test.ts
```

- [ ] **Step 5: Run host-focused checks.**

```text
bun install --frozen-lockfile
bun test packages/chatgpt-web/test/extension.test.ts packages/coding-agent/test/chatgpt-web-command.test.ts packages/coding-agent/test/model-registry-runtime-provider.test.ts
bun --cwd=packages/coding-agent run check:types
```

Expected: custom keyless API registration, source cleanup, model capability metadata, command persistence, no credential export, and type checks pass.

- [ ] **Step 6: Commit host enablement.**

```text
git add packages/chatgpt-web/src/extension.ts packages/chatgpt-web/test/extension.test.ts packages/coding-agent/src/extensibility/extensions/keyless-provider.ts packages/coding-agent/src/extensibility/extensions/loader.ts packages/coding-agent/src/extensibility/extensions/types.ts packages/coding-agent/src/config/model-registry.ts packages/coding-agent/src/commands/chatgpt-web.ts packages/coding-agent/src/cli-commands.ts packages/coding-agent/package.json packages/coding-agent/test/chatgpt-web-command.test.ts packages/coding-agent/test/model-registry-runtime-provider.test.ts bun.lock
git commit -m "feat: register ChatGPT Web as a keyless OMP provider"
```

---

## Task 6: Complete and validate browser-only mode locally

**Files:**
- Modify: `packages/chatgpt-web/src/cli.ts`
- Modify: `packages/chatgpt-web/src/provider/stream.ts`
- Create: `packages/chatgpt-web/test/browser-only-e2e.test.ts`
- Create: `packages/chatgpt-web/test/browser-only-cli.test.ts` — execute the package CLI with fake host/process seams and assert browser-only topology.
- Create: `packages/chatgpt-web/test/evidence-schema.test.ts`

**Interfaces:**
- Consumes: native provider, keyless registration, and login command from Tasks 2–5.
- Produces: a documented browser-only mode with no MCP server, tunnel, or Electron dependency.

- [ ] **Step 1: Add explicit browser-only mode selection.**

Use package config, not an environment-only hidden flag, to select `browser-only` versus `full`, and extend the real `src/cli.ts` parser with a `serve` handler that starts only the local browser runtime for browser-only mode. Execute the package CLI entrypoint through `browser-only-cli.test.ts` with an injected fake host and child-process recorder: `serve --mode browser-only` must reach the host, `--mode full`, tunnel/MCP-only flags, and unknown `mcp` commands must reject before spawning anything. `browser-only` must never start the broker, MCP server, tunnel, launcher helper, or a second profile owner. Pro remains selectable only when the marker reports capability; the `serve` handler fails closed on a missing/invalid marker rather than falling back.

- [ ] **Step 2: Add the deterministic smoke harness and evidence schema.**

Create a harness that loads the real OMP extension/model picker and coding-agent session setup while injecting fake ChatGPT pages at the `BrowserHost` boundary. It must cover text, reasoning, image, cancellation, restart, profile-owner conflict, five parallel turns, and explicit sixth rejection without replacing the OMP agent loop. Define ignored local evidence JSON with schema version, commit, OS/arch, Bun/browser version, scenario ID, pass/fail, and invariant observations; prohibit account identifiers, profile paths, cookies, tokens, and raw responses.

- [ ] **Step 3: Exercise the real local profile manually.**

Run:

```text
bun --cwd=packages/coding-agent run src/cli.ts chatgpt-web enable
bun --cwd=packages/coding-agent run src/cli.ts chatgpt-web login
bun --cwd=packages/coding-agent run src/cli.ts models find "ChatGPT Web"
bun --cwd=packages/coding-agent run src/cli.ts --model chatgpt-web/light
```

Use the real OMP picker/session on each supported OS for every non-Pro effort: one text turn, one reasoning-visible turn, one image turn, one cancellation, five parallel turns, a second process/owner attempt, and a sixth-turn rejection. Record only redacted evidence before moving to full mode. A platform is not marked live-supported until its Chrome executable discovery, profile ACL, login, and cancellation path pass; other platforms remain fixture/package-tested.

- [ ] **Step 4: Run package and host checks.**

```text
bun test packages/chatgpt-web/test/browser-only-cli.test.ts packages/chatgpt-web/test/browser-only-e2e.test.ts packages/chatgpt-web/test/evidence-schema.test.ts
bun --cwd=packages/chatgpt-web run check
bun --cwd=packages/coding-agent run check
bun run ci:test:smoke
```

Expected: package checks, host checks, and deterministic OMP smoke pass; no MCP/tunnel process starts in browser-only mode.

- [ ] **Step 5: Commit the browser-only milestone.**

```text
git add packages/chatgpt-web/src/cli.ts packages/chatgpt-web/src/provider/stream.ts packages/chatgpt-web/test/browser-only-e2e.test.ts packages/chatgpt-web/test/browser-only-cli.test.ts packages/chatgpt-web/test/evidence-schema.test.ts
git commit -m "feat: validate ChatGPT Web browser-only mode"
```

Do not begin full-mode/launcher work until this provider-first gate has passed.

---

## Task 7: Add full-mode MCP capability routing

**Files:**
- Create: `packages/chatgpt-web/src/mcp/broker.ts`
- Create: `packages/chatgpt-web/src/mcp/server.ts`
- Create: `packages/chatgpt-web/src/mcp/main.ts`
- Create: `packages/chatgpt-web/src/mcp/bootstrap.ts` — owner-controlled one-time bootstrap-file handoff, process-peer binding, and cross-platform ancestry checks used by the broker and tunnel child.
- Modify: `packages/chatgpt-web/src/cli.ts` — add the real `mcp --broker-handoff` dispatch after `mcp/main.ts` exists; it accepts no caller-provided socket/path.
- Create: `packages/chatgpt-web/test/mcp/broker.test.ts`
- Create: `packages/chatgpt-web/test/mcp/server.test.ts`
- Create: `packages/chatgpt-web/test/mcp/stdio-child.test.ts`
- Modify: `packages/chatgpt-web/src/provider/session.ts`
- Modify: `packages/chatgpt-web/src/provider/stream.ts`

**Interfaces:**
- Consumes: OMP `Tool`, `Context`, `ToolCall`, `ToolResultMessage`, session IDs, and the browser-only provider session.
- Produces:

```ts
export interface OmpMcpConnector {
  readonly connectorId: string;
  readonly sessionId: string;
  readonly runtimeEpoch: string;
  readonly sessionNonce: string;
  /** Runtime-unforgeable handle bound to exactly one native connection/peer and broker epoch. */
  readonly __opaque: unique symbol;
}

export interface OmpTurnBinding {
  sessionId: string;
  turnId: string;
  runtimeEpoch: string;
  bindingId: string;
  expiresAt: number;
  declaredToolSetHash: string;
  tools: readonly Tool[];
}

export interface OmpTurnIssue {
  binding: OmpTurnBinding;
  turnToken: string;
}

export interface OmpConnectorBootstrap {
  readonly kind: "private-owned-bootstrap-file";
  readonly __opaque: unique symbol;
}

export interface OmpTunnelBootstrap {
  readonly kind: "private-owned-bootstrap-file";
  readonly __opaque: unique symbol;
}

/** Exported only by mcp/bootstrap.ts; never re-export from the package root or model-facing API. */
export interface OmpTunnelSpawnEnvironment {
  /** Native-validated, closed environment profile; it is not a path/Record visible to TypeScript callers. */
  readonly environment: NativeLaunchEnvironment;
  close(): void;
}

/** One-time package-private materialization; close() deletes/invalidates the unused bootstrap. */
export function consumeTunnelSpawnEnvironment(
  bootstrap: OmpTunnelBootstrap,
): OmpTunnelSpawnEnvironment;

/** Native-produced, runtime-unforgeable identity; never construct from status JSON/PID fields. */
export interface OmpTunnelProcessIdentity {
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly executableIdentity: string;
  readonly __opaque: unique symbol;
}
export interface OmpBindTurnTool {
  name: "chatgpt_web_bind_turn";
  description: string;
  inputSchema: { type: "object"; required: ["turnToken"]; properties: { turnToken: { type: "string" } } };
}

export type OmpMcpTool = Tool | OmpBindTurnTool;

export interface OmpBrokerEndpoint {
  readonly kind: "owner-local";
  readonly __opaque: unique symbol;
}

export interface BrokerToolRequest {
  readonly callId: string;
  readonly wireName: string;
  readonly freeform: boolean;
  readonly arguments?: Record<string, unknown>;
  readonly input?: string;
}

export interface OmpTurnBroker {
  listen(): Promise<{
    endpoint: OmpBrokerEndpoint;
    runtimeEpoch: string;
    lifecycleGeneration: number;
  }>;
  /** Creates a fresh connector/bootstrap file and tunnel reservation for one spawn or restart attempt. */
  prepareTunnelSpawn(): Promise<{
    connectorBootstrap: OmpConnectorBootstrap;
    tunnelBootstrap: OmpTunnelBootstrap;
    tunnelAdmission: ChatGptWebRuntimeAdmission;
  }>;
  readonly gate: ChatGptWebRuntimeGate;
  authorizeTunnel(
    bootstrap: OmpConnectorBootstrap,
    process: OmpTunnelProcessIdentity,
    admission: ChatGptWebRuntimeAdmission,
  ): Promise<void>;
  attachConnector(bootstrap: OmpConnectorBootstrap): Promise<OmpMcpConnector>;
  issue(binding: OmpTurnBinding, admission: ChatGptWebRuntimeAdmission): Promise<OmpTurnIssue>;
  claim(turnToken: string, connector: OmpMcpConnector): Promise<OmpTurnBinding>;
  listTools(connector: OmpMcpConnector): Promise<readonly OmpMcpTool[]>;
  nextInvocationBatch(bindingId: string, connector: OmpMcpConnector, signal?: AbortSignal): Promise<readonly BrokerToolRequest[]>;
  resolveBatch(bindingId: string, connector: OmpMcpConnector, calls: readonly { callId: string; result: ToolResultMessage }[]): Promise<void>;
  release(bindingId: string, connector: OmpMcpConnector): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}
```
`OmpMcpConnector` is created only by `attachConnector()` after native peer/bootstrap proof and is stored in a private runtime `WeakSet` keyed to the live `NativePeerConnection`, peer identity, connector nonce, and runtime epoch. `connectorId`, `sessionId`, `runtimeEpoch`, and `sessionNonce` are diagnostics/routing fields, never authority; every broker method rejects structural clones, JSON-deserialized records, stale/reconnected connections, wrong-peer identities, cross-epoch handles, and calls arriving on a different native connection. `currentPeer()` is checked before every frame as well as at handshake.

The environment profile binds bootstrap and runtime-key material to already-open `NativeOwnedFile` handles and the expected runtime epoch. The native launch adapter either supplies those immutable bytes/handles to the pinned tunnel before it can open them or refuses the start; it never hands the tunnel an attacker-replaceable pathname. A swap during key-open/connector setup, clone of a file handle, close-before-consume, or digest mismatch fails before authorization and is covered by a deterministic race test.
`turnToken` is a model-facing, single-turn correlation nonce required only in full-mode prompt instructions and the dedicated `chatgpt_web_bind_turn` handshake; it is not the control token, connector secret, or authority to invoke tools. The provider obtains one turn reservation from the broker-independent `ChatGptWebRuntimeGate` before lease creation. `BrowserHost.lease()` retains a `browser-lease` reference and `issue(binding, admission)` retains a `broker-binding` reference under the same gate; either failure rolls back the other reference and releases the initial `turn` owner. The provider includes the token only in full mode, the browser prompt requires a successful bind before any answer/tool action, and read-only/Pro prompts omit the token field. A newly attached connector starts in a pre-bind state: its first `tools/list` response contains only the dedicated `chatgpt_web_bind_turn` meta-tool, never the OMP tool snapshot. The connector submits the turn token through that dedicated operation; `claim` atomically attaches the immutable binding, after which `tools/list` exposes the canonical snapshot. Repeated bind with the same connector, token, and binding is idempotent; replay, wrong connector/session, expired token, or bind-after-release is rejected, and reconnect starts pre-bind with old cached lists invalidated. `connectorBootstrap` remains an opaque one-time handoff delivered only through an owner-controlled bootstrap file path inherited by the package-owned MCP child; the file path is never accepted from model input and the file contents are never placed in argv, generic tool arguments, logs, or OMP messages. `nextInvocationBatch` coalesces calls within the source-compatible bounded window and `resolveBatch` requires exact call cardinality/IDs before browser continuation.

`bootstrap.ts` makes the handoff concrete across the pinned tunnel client's supported transport: `listen()` creates the owner-controlled endpoint once, while every `prepareTunnelSpawn()` call creates a fresh owner-controlled regular bootstrap file under the runtime root, verifies its owner/identity, atomically writes a new one-time connector authenticator/runtime epoch/expected tunnel identity, and returns a new opaque `OmpConnectorBootstrap`, `OmpTunnelBootstrap`, and `gate.admit("tunnel")` reservation. The tunnel-spawned `mcp/main.ts` opens the generated path exactly once through `NativeOwnedFile`, reads and proves the authenticator through that same held handle, and sends a pending proof over the broker connection; the broker validates native peer identity/authorized tunnel ancestry and the current epoch, then atomically consumes the expected authenticator in broker state and ACKs the proof. Only after that ACK does the child call `NativeOwnedFile.consume()` to zeroize/close the held handle and confirm consumption; any pathname cleanup is same-identity best effort and never authentication/consume authority. An invalid or unauthorized peer receives no ACK and cannot consume the file. A path swap after open or before the ACK is never read/trusted as the authorized bootstrap, and cleanup must not unlink a replacement. `tunnel.ts` calls the package-private `consumeTunnelSpawnEnvironment()` exactly once immediately before native spawn, passes only its generated path in the allowlisted `OMP_CHATGPT_WEB_BOOTSTRAP_FILE` environment variable, and calls `close()` on spawn failure or after the child confirms consumption; `close()` only releases parent-side spawn state and never reopens/claims the path. The pinned tunnel client uses inherited environment when it spawns its MCP command; lifecycle tests must verify that exact versioned behavior and fail closed if propagation changes. `authorizeTunnel()` consumes only the matching fresh reservation; a restart never reuses a consumed file/authenticator or stale connector bootstrap. No connector secret is placed in argv or generic environment and there is no descriptor-forwarding or arbitrary env-secret fallback.

- [ ] **Step 1: Adapt the source broker to OMP identity and bind the tool set.**

Port the source `codex-chatgpt-web/src/adapters/chatgpt-web/turn-broker.ts` state machine, replacing Codex trace IDs and request envelopes with `sessionId`, generated `turnId`, unguessable `runtimeEpoch`/`bindingId`, a one-time model-facing `turnToken`, expiry, an authenticated MCP connector/session nonce, and the current OMP tool declaration set. The provider obtains the single turn reservation from the broker-independent gate before any `BrowserHost.lease()` or `issue()` call. `issue(binding, admission)` retains one unique `broker-binding` reference under the gate, with rollback if binding creation fails; it never mints a second independent admission. The dedicated `chatgpt_web_bind_turn` operation claims it exactly once for the authenticated connector before any tool/answer action. Define `declaredToolSetHash` as a canonical JSON hash of every field that affects OMP model wire/admission: explicit tool kind, internal name, `customWireName`, description, normalized parameters schema, `strict`, `customFormat`, `native`, `examples`, and any future provider-facing fields, with deterministic nested key ordering and absent/null distinction. Reject unsupported `native`/`customFormat` forms rather than silently omitting them, duplicate internal names, duplicate aliases, and ambiguous name/alias collisions, with the same name-first precedence as the OMP agent loop. Deep-clone and freeze the complete tool snapshot at issue/claim; hash that frozen snapshot and compare it at every list/invoke/result operation, not only at startup. The authenticated tunnel identity accepted by `authorizeTunnel()` is the native opaque identity from `NativeOwnedProcess.identity`/native verification, never a plain `{ pid, processStartIdentity, executableIdentity }` object or untrusted status JSON. Preserve source-compatible bounded tool-call batching and exact batch result cardinality.

`listen()` creates the owner-controlled Unix-domain socket or Windows named pipe for the whole runtime lifetime, before any tunnel process starts; use owner-only permissions, peer credentials/security descriptors, a separate one-time connector handshake authenticator, no-follow identity checks, and reject symlink/reparse/path swaps, broad ACLs, and TCP endpoints. A child that proves the bootstrap authenticator before `authorizeTunnel()` is registered remains bounded pending rather than being consumed or admitted; once the unique `tunnel-process` reference is retained, every connector must present native peer credentials whose PID is a live descendant of the authorized tunnel identity with matching process-start and executable identity. Revalidate that pinned peer identity/ancestry at handshake and by calling `NativePeerConnection.currentPeer()` before every frame/request; reparenting, exec replacement, PID reuse, closed handles, and unavailable identity fail closed. Implement peer PID retrieval with native OS APIs (Linux `SO_PEERCRED`, macOS `LOCAL_PEERPID`/equivalent, Windows `GetNamedPipeClientProcessId`) and fail closed when the platform cannot provide a trustworthy PID; never parse shell command output for identity. The bootstrap authenticator is not confidential against a same-user file reader; the security boundary is process identity. Same-user competitors therefore fail closed as non-descendants, while cross-user/accidental clients and stale inherited handles must also fail closed. Bind each connector and browser MCP invocation to exactly one active turn and immutable tool-set snapshot. Retain line-size caps, duplicate-call rejection, abort handling, retired-handle bounds, stale-epoch rejection, replay rejection, close-time rejection, and native owned process-group/job/PDEATHSIG cleanup so orphan descendants cannot survive tunnel teardown. Tests must mutate/reparent/reuse the peer after handshake and before a frame and verify rejection without bootstrap or tool-state consumption.

- [ ] **Step 2: Map MCP tools to OMP tools.**

Adapt `mcp-server.ts`/`mcp-main.ts` as a stdio child; the package's public runtime command is `chatgpt-web mcp --broker-handoff` backed by `src/mcp/main.ts`. The child receives the inherited owner-local endpoint through the native launch environment and authenticates a one-time connector session through the owner-controlled bootstrap handle; it never accepts a caller-supplied socket/path. Its initial `tools/list` exposes only `chatgpt_web_bind_turn`; the model invokes that dedicated meta-tool with the model-facing `turnToken`, the broker atomically claims the matching binding, and subsequent `tools/list` returns only the connector's immutable canonical OMP tool snapshot. After every connector-local list transition (pre-bind → claimed and claimed → released/expired), send MCP `notifications/tools/list_changed` on that connector before accepting the next model action so clients invalidate stale caches.

- [ ] **Step 3: Return tool calls to the OMP agent loop.**

When MCP invokes a tool, the provider stream emits an OMP tool call and returns `toolUse`. The production coding-agent loop performs approval and execution through `ExtensionToolWrapper`; this package only resolves the resulting `ToolResultMessage`. A missing/duplicate/mismatched result expires the binding and fails the turn.

- [ ] **Step 4: Add unit plus real-stdio-child tests without ChatGPT.**

Test pre-bind `tools/list` exposing only `chatgpt_web_bind_turn`, invoke/result rejection before claim, atomic claim followed by canonical `tools/list`, `notifications/tools/list_changed` delivery and client-cache invalidation on every connector-local transition, claim expiry, unknown tool rejection, duplicate call IDs, changed-schema/hash mismatch, duplicate names/aliases, name-first collision precedence, multiple parallel calls, result matching, abort while waiting, release/drain cleanup, JSON size caps, runtime-epoch mismatch, connector-session mismatch/reconnect, bootstrap-file environment inheritance, owner/ACL/no-follow checks, child proof pending before `authorizeTunnel()` and succeeding only after matching authorization, invalid peer rejection without bootstrap consumption, broker peer PID/ancestry and executable/process-start validation, broker-side one-time authenticator CAS followed by local handle consume, competing same-user process rejection, path swap after open and before ACK without replacement cleanup, missing-bootstrap rejection on POSIX and Windows, authorize-in-flight versus drain/restart rejection with rollback, new browser lease/turn admission versus drain rejection, one turn reservation rollback when lease or binding creation fails, handshake replay, two concurrent real stdio clients with different tool snapshots, a Pro model attempting an invocation, cross-user/unauthorized broker clients, Windows named-pipe ACL rejection, and no tool-list cache crossing connectors. Spawn the real `mcp-main` over stdio in the integration fixture and prove it reaches the pre-bound broker; do not use an in-memory shortcut as the only acceptance path.

- [ ] **Step 5: Run focused full-mode broker tests.**

```text
bun test packages/chatgpt-web/test/mcp/**/*.test.ts packages/chatgpt-web/test/provider/continuation.test.ts
```

Expected: all capability and continuation tests pass, including parallel invocation ordering, real stdio framing, and stale-binding rejection.

- [ ] **Step 6: Commit the full-mode broker.**

```text
git add packages/chatgpt-web/src/mcp/broker.ts packages/chatgpt-web/src/mcp/server.ts packages/chatgpt-web/src/mcp/main.ts packages/chatgpt-web/src/mcp/bootstrap.ts packages/chatgpt-web/src/cli.ts packages/chatgpt-web/src/provider/session.ts packages/chatgpt-web/src/provider/stream.ts packages/chatgpt-web/test/mcp/broker.test.ts packages/chatgpt-web/test/mcp/server.test.ts packages/chatgpt-web/test/mcp/stdio-child.test.ts
git commit -m "feat: bind ChatGPT Web MCP calls to OMP turns"
```
---
## Task 8: Add the pinned tunnel and broker-first full-mode lifecycle

**Files:**
- Create: `packages/chatgpt-web/src/mcp/runtime-command.ts`
- Create: `packages/chatgpt-web/test/mcp/runtime-command.test.ts`
- Create: `packages/chatgpt-web/src/mcp/tunnel.ts` — broker-first tunnel lifecycle, pinned artifact handoff, owned process cleanup, and epoch/drain controls.
- Create: `packages/chatgpt-web/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `OmpTurnBroker`, secure paths, package CLI, and source tunnel behavior.
- Produces an explicit `full` lifecycle with broker-first startup, tunnel-owned stdio MCP child, authenticated drain/shutdown, and versioned health identity.

- [ ] **Step 1: Define the tunnel artifact manifest.**

Pin `openai/tunnel-client` `0.0.10` in a checked-in typed `TUNNEL_ARTIFACTS` constant owned by `packages/chatgpt-web/src/mcp/tunnel.ts` for exactly `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, and `win32-x64`, with one URL, SHA-256, executable name, and semantic/binary version per tuple. The manifest is complete before implementation begins; an absent tuple, mismatched checksum/version, or unsupported host fails closed. `packages/chatgpt-web/test/mcp/tunnel.test.ts` must assert all six entries and their closed schema. Download into a temporary file, verify SHA-256 before rename, validate executable version and no-follow/reparse-safe path, atomically install it, then capture the local opened native file identity in owner-controlled install metadata/held handle; the captured identity plus digest/version must match immediately before every launch/spawn. Make the installed file non-writable by ordinary runtime code where the platform permits, re-check parent and final path identity, and reject symlink/junction/reparse swaps. The notice generator must include the actual bundled runtime/dependency versions.

- [ ] **Step 2: Implement broker-first tunnel lifecycle.**
The `runtime-key` handoff is handle-bound: `consumeTunnelSpawnEnvironment()` reads the validated key through its held native handle and creates the opaque `NativeLaunchEnvironment`; a later tunnel operation cannot reopen the configured pathname. If the pinned client only accepts a path-based `file:` option, the package must launch the MCP entry through the native argv/environment adapter that materializes the key inside the owned child, or fail closed; post-launch identity checks are not a substitute for pre-open binding.
`resume` is not an in-place reopening of a drained runtime: it creates a fresh runtime epoch/generation, fresh gate/broker/host state, and fresh connector/bootstrap reservations. Old admissions, references, bindings, connectors, browser leases, tunnel processes, and delayed callbacks are rejected after resume.

Create the provider runtime epoch and bind/listen the broker before starting the first tunnel. For every start/restart, call `prepareTunnelSpawn()` to obtain a fresh opaque connector bootstrap, opaque tunnel bootstrap, and tunnel admission reservation; immediately before native spawn call the package-private `consumeTunnelSpawnEnvironment()` to create the one-time opaque native environment profile from already-open `NativeOwnedFile` handles and the inherited `OmpBrokerEndpoint`, never a caller-reopenable bootstrap/key/socket path, then use the exact command from `resolveRuntimeCommand()` for the verified provider bundle, including the package's fixed `chatgpt-web mcp --broker-handoff` stdio child. Never accept a free-form command or model-provided path. The tunnel command receives only an explicitly constructed sanitized environment, never ambient `process.env`; `runtime-key` is consumed through its held native handle before launch, and the pinned client must authenticate those immutable bytes/handles rather than reopen a `file:` pathname. The pinned client may pass that sanitized environment to its MCP grandchild only as a versioned, tested allowlist; if it cannot guarantee that propagation, spawn `mcp/main.ts` directly through the native argv API or fail closed. Capture the tunnel identity from the native `NativeOwnedProcess.identity`/verified native process handle rather than trusting status JSON PID fields; if identity is unavailable or cannot be revalidated, fail closed. Call `authorizeTunnel()` with that opaque native identity and fresh admission as soon as it is known; if drain/restart wins the gate CAS, reject and terminate the unadmitted process. If the tunnel-spawned MCP child connects before authorization is registered, keep its proof pending: it may read/prove the authenticator, but the broker sends no consume ACK until native peer credentials, live ancestry, executable/process-start identity, and the current epoch match the authorized tunnel. A competing same-user process may read the file but is rejected as a non-descendant and cannot consume the bootstrap. `mcp/main.ts` must reject a missing, duplicated, swapped, wrong-owner, stale, non-descendant, or already-consumed bootstrap even when the inherited handoff is present. Admit turns only after tunnel health, tunnel/runtime identity, MCP child startup, two-phase bootstrap consumption/handshake, and broker handshake all agree on the current epoch. Stop through the owned verified process handle and native process-group/job boundary; termination must recheck start/executable identity (or use pidfd/job/native handle) before every signal so a PID-reused process is never killed. Bound shutdown and report a hard failure if the tunnel or child remains active after the deadline.
`runtime-command.ts` owns the package's runtime command contract. `resolveRuntimeCommand({ bundleRoot, mode })` opens and verifies the selected bundle entrypoint immediately and returns an opaque `NativeVerifiedExecutable` plus a fixed argv array for the verified bundle and child command; any diagnostic path is non-authoritative. It derives `chatgpt-web mcp --broker-handoff` from package metadata, never from free-form input. Spawn uses the native argv API without a shell, and Windows argument serialization is tested against spaces, quotes, backslashes, empty values, Unicode, malformed options, and attempted bundle escapes. The returned descriptor contains no credentials, connector secret, control token, endpoint, socket path, or model-provided path, and the verified executable handle is retained until spawn completes.

- [ ] **Step 3: Add authenticated runtime lifecycle controls.**

Implement lifecycle control through the same owner-controlled native local listener/pipe and authenticated `NativePeerConnection` proof used by the broker, not a loopback TCP/HTTP bearer endpoint. If a local HTTP health surface is needed, keep it read-only and in-process; drain, resume, cancel-browser-turns, and shutdown require the native peer/owner proof plus the random control token, expected epoch/generation, per-connection nonce, and monotonic sequence. A same-user process with a stolen token is rejected before any lifecycle mutation. The broker-independent `ChatGptWebRuntimeGate` is the single admission authority for browser-only leases, full-mode bindings, connectors, and tunnel authorization. On drain, under one lifecycle lock/CAS, close admission to new reservations first, invalidate the runtime epoch/generation, mark existing reservations for cancellation, cancel pending `prepareTunnelSpawn()`/`authorizeTunnel()` operations, and stop the tunnel so no new MCP child can spawn. Wait for all gate reservations, active browser leases, broker invocations, and pending connector handshakes to settle or fail closed, then close the broker/host; a late lease/issue/authorize cannot repopulate state. Every transition is idempotent and includes runtime epoch/generation; delayed old resume/restart callbacks fail closed. Browser-only mode uses the same gate but never constructs the broker or tunnel. Tests cover stolen-token lifecycle requests, cross-connection handles, peer mutation/reparenting/PID reuse, and state preservation after rejected controls.

- [ ] **Step 4: Make browser-only/full mode mutually explicit.**

`browser-only` must reject full-mode-only commands; `full` must fail closed if tunnel credentials, MCP configuration, checksum verification, broker handshake, or runtime identity are missing. No mode switch may happen mid-turn or reuse a binding across epochs.

- [ ] **Step 5: Test lifecycle, artifact, and process-topology security.**

Test the complete `0.0.10` six-tuple manifest, bounded download size (100 MiB) before buffering, HTTPS/allowlisted release hosts, redirect host/scheme validation, cancellation and timeout, checksum mismatch, corrupt executable, version mismatch, path-identity/reparse swap immediately before launch, runtime-key replacement/no-follow failure immediately before `file:` handoff and after launch, archive traversal/symlink/junction/hardlink rejection, ready timeout, fresh bootstrap on every restart, tunnel-spawned stdio child reaching the pre-bound broker, stale child epoch/connector rejection, old handle rejection after resume, authorize-in-flight versus drain/restart rejection, new browser lease/turn versus drain rejection, drain with active browser turn, drain with pending MCP result, scheduled-restart versus drain race, shutdown timeout, restart budget, token mismatch, loopback bind, no-new-child-after-drain, process-tree PID reuse during drain (unrelated process survives), reparent/exec identity change, orphan descendants, owned process/group/job termination, allowlisted child/grandchild environment with case-insensitive high-entropy canaries absent, and mode-specific startup. Use fake tunnel/child processes and fake clocks, but retain one integration fixture that exercises the real `mcp-main` stdio framing.

- [ ] **Step 6: Run full-mode package checks.**

```text
bun test packages/chatgpt-web/test/mcp/runtime-command.test.ts packages/chatgpt-web/test/mcp/tunnel.test.ts packages/chatgpt-web/test/lifecycle.test.ts
bun --cwd=packages/chatgpt-web run check
```

Expected: lifecycle tests pass without downloading a real tunnel binary or contacting a live connector.

- [ ] **Step 7: Commit full-mode lifecycle.**

```text
git add packages/chatgpt-web/src/mcp/runtime-command.ts packages/chatgpt-web/src/mcp/tunnel.ts packages/chatgpt-web/src/config.ts packages/chatgpt-web/src/cli.ts packages/chatgpt-web/test/mcp/runtime-command.test.ts packages/chatgpt-web/test/mcp/tunnel.test.ts packages/chatgpt-web/test/lifecycle.test.ts
git commit -m "feat: add ChatGPT Web full-mode lifecycle"
```

---

## Task 9: Validate full mode through the production OMP approval path

**Files:**
- Create: `packages/coding-agent/test/chatgpt-web-full-mode.test.ts`
- Create: `packages/chatgpt-web/test/full-mode-e2e.test.ts`
- Create: `packages/chatgpt-web/test/full-mode-evidence.test.ts`
- Modify: `packages/chatgpt-web/src/provider/stream.ts`
- Modify: `packages/chatgpt-web/src/mcp/server.ts`

**Interfaces:**
- Consumes: full-mode broker/tunnel lifecycle from Tasks 7–8.
- Produces a repeatable local acceptance scenario covering actual tool assembly, approval, errors, cancellation, and continuation.

- [ ] **Step 1: Add a production-wrapper integration fixture.**

Use the existing OMP read/write tool definitions and instantiate the production coding-agent `AgentSession` tool assembly plus `ExtensionToolWrapper` from `packages/coding-agent/src/extensibility/extensions/wrapper.ts`; do not call the bare `Agent` loop's `tool.execute` directly. Inject a deterministic approval UI/policy at the wrapper boundary. The fixture must expose one read-only tool and one write-gated tool in a temporary workspace, record invocations, and return deterministic results/errors.

For denial, assert an approval request is emitted, the underlying write executor invocation count remains zero, workspace bytes remain unchanged, the returned `ToolResultMessage.isError` is true, and the exact call ID is preserved to the broker. For approval, assert the reviewed post-hook arguments exactly equal the arguments reaching execution.
Extend the fixture across every OMP approval mode (`always-ask`, write-gated, and yolo): explicit per-tool deny overrides yolo, no-UI/pending-safety states fail closed, post-hook argument rewrites are revalidated under the same policy before execution, and cancellation during approval leaves no executor call. Browser/MCP messages cannot carry `autoApproveToolCalls`, approval decisions, or policy overrides; forged fields are rejected before the production wrapper.

- [ ] **Step 2: Run the real full-mode login/setup.**

```text
bun --cwd=packages/coding-agent run src/cli.ts chatgpt-web enable
bun --cwd=packages/coding-agent run src/cli.ts chatgpt-web login
bun --cwd=packages/coding-agent run src/cli.ts chatgpt-web status
bun --cwd=packages/coding-agent run src/cli.ts chatgpt-web doctor
```

Configure the ChatGPT custom connector/tunnel using the package's documented full-mode flow. Verify broker endpoint creation precedes tunnel start, the tunnel-spawned MCP child reaches the broker, and tunnel/MCP/provider report the same runtime epoch before admitting a model turn.

- [ ] **Step 3: Exercise the acceptance matrix.**

Run a real OMP session with `chatgpt-web/medium` and verify:

1. ChatGPT invokes the read tool and the production OMP wrapper executes it.
2. ChatGPT invokes the write tool and the wrapper emits an approval request.
3. Approving executes the exact reviewed arguments.
4. Denying leaves the workspace unchanged, performs zero write calls, and returns an error result.
5. A tool failure is returned to ChatGPT without losing the session/turn/binding identity.
6. Cancellation while a tool is pending aborts the browser turn, rejects the pending broker invocation, releases the lease once, and leaves sibling turns live.
7. The next model call consumes each exact tool result once and continues the same ChatGPT turn; replay/cross-session results fail closed.
8. Pro never advertises or accepts local tools.

- [ ] **Step 4: Run package, host, and evidence checks.**

```text
bun --cwd=packages/chatgpt-web run check
bun --cwd=packages/coding-agent run check
bun run ci:test:smoke
```

Record a schema-valid, redacted JSON evidence file under the ignored local evidence directory. Do not include account identifiers, cookies, tunnel secrets, profile paths, prompts, DOM text, or raw child output.

- [ ] **Step 5: Commit full-mode validation.**

```text
git add packages/coding-agent/test/chatgpt-web-full-mode.test.ts packages/chatgpt-web/test/full-mode-e2e.test.ts packages/chatgpt-web/test/full-mode-evidence.test.ts packages/chatgpt-web/src/provider/stream.ts packages/chatgpt-web/src/mcp/server.ts
git commit -m "test: validate ChatGPT Web full mode with OMP tools"
```

Launcher work is blocked until this provider-first acceptance matrix passes.

---

## Task 10: Add the authenticated launcher browser transport

**Files:**
- Create: `packages/chatgpt-web-launcher/package.json`
- Create: `packages/chatgpt-web-launcher/tsconfig.json` — workspace TypeScript project with `jsx: react-jsx`, DOM libs/types, bundler resolution, and `include: ["src"]`.
- Create: `packages/chatgpt-web-launcher/electron/main.cjs`
- Create: `packages/chatgpt-web-launcher/electron/browser-host.cjs`
- Create: `packages/chatgpt-web-launcher/electron/control-server.cjs`
- Create: `packages/chatgpt-web-launcher/src/types.ts`
- Create: `packages/chatgpt-web-launcher/test/browser-host.test.cjs`
- Create: `packages/chatgpt-web-launcher/test/control-server.test.cjs`
- Create: `packages/chatgpt-web-launcher/electron/cdp-input.cjs` — narrow allowlisted input bridge if the browser host requires CDP-level input.
- Create: `packages/chatgpt-web-launcher/test/cdp-input.test.cjs`
- Create: `packages/chatgpt-web-launcher/test/design-contract.test.cjs`
- Create: `packages/chatgpt-web-launcher/test/runtime-host.test.cjs`
- Modify: `packages/chatgpt-web/src/runtime/host.ts`
- Create: `packages/chatgpt-web/src/runtime/launcher-host.ts` — authenticated host-RPC client for browser login/lease and descriptor refresh; it never accepts or returns a path, endpoint, websocket, or raw transport.
Test descriptor schema/owner/epoch/PID validation, per-request nonce/sequence replay and reordering, helper executable/script path identity/hash mismatch, arbitrary existing helper rejection, post-validation replacement, symlink/reparse and broad-ACL rejection, minimal child environment, forged/stale control tokens, direct unauthenticated CDP enumeration/attachment rejection, absence of endpoint/attach/evaluate/cookies/storageState operations and fields, five leases shared by two clients, sixth rejection, lease close idempotence, cancellation isolation, persistent partition lifecycle, process exit, and no secret exposure through descriptor/preload/control responses. Also test `BrowserWindow` security settings, CSP, packaged-origin navigation/redirect/window-open rejection, disabled webviews/remote access, and the absence of raw CDP/control secrets in renderer/IPC payloads.
The browser-host fixture must stub `launchVerifiedBrowser()` and the package-private byte-pipe adapter, then assert that only the native-prepared executable identity, owner-controlled profile handle, inherited pipe, and sanitized environment reach the host. It must compile and exercise the pinned Playwright `ConnectOverCDPTransport` overload; no caller path, `launchPersistentContext`, endpoint URL, websocket, TCP listener, or raw custom transport is accepted at the BrowserHost boundary. A native descendant/identity fixture must bind the launched child before lease admission and reject ambiguous or replaced children.
- Create: `packages/chatgpt-web-launcher/assets/icon.png` and `packages/chatgpt-web-launcher/assets/icon.ico` required by the selected electron-builder targets.
- Modify: `bun.lock` — refresh after the launcher manifest and runtime dependency graph are finalized.

**Interfaces:**
- Consumes the `BrowserHost`/`BrowserPage` facade from Task 3 and the authenticated lifecycle token/epoch from Task 8.
- Produces a launcher-owned browser host that keeps Playwright/CDP internal and exposes only authenticated per-lease page operations to the provider runtime.

- [ ] **Step 1: Create the isolated launcher package and build contract.**
Create `@oh-my-pi/pi-chatgpt-web-launcher` at the current OMP workspace version (`17.2.4` baseline) with OMP-owned product metadata, `engines.bun >= 1.3.14`, and scripts `check`, `check:types` (`tsgo -p tsconfig.json --noEmit`), `test` (`node --test test/*.test.cjs`, with CJS tests outside the TypeScript include), `build`, `build:runtime`, and `package`. Declare runtime `react: "catalog:"`, `react-dom: "catalog:"`, `playwright-core: "1.62.1"`, and `@oh-my-pi/pi-natives: "catalog:"`; the launcher must not rely on provider/root hoisting for either browser transport or native loader resolution. Declare dev `@types/react: "catalog:"`, `@types/react-dom: "catalog:"`, `typescript: "catalog:"`, `vite: "catalog:"`, and `@types/bun: "catalog:"` so the isolated package check resolves the workspace's React/Vite/Bun types without root-only lookup. Pin package-local Electron integration to `electron` `41.7.1`, `electron-builder` `26.8.1`, `motion` `12.42.2`, `@vitejs/plugin-react` `5.2.0`, and `@types/node` `22.10.2`; the package-contract test must assert those manifest entries, the exact Playwright/native versions, and the resolved lockfile/package-resource layout. Keep Electron/electron-builder package-local and isolated; do not add Electron to `packages/coding-agent`. Include `assets/icon.png`, `assets/icon.ico` where required, renderer CSS/assets, and a package-local runtime-bundle contract.

The launcher must start and own the persistent browser through the same native verified-browser/private-pipe adapter used by the provider; it must not expose `remote-debugging-port`, `/json/version`, a websocket URL, an endpoint-based attach, a raw endpoint, or an attach capability. The host adapts the inherited byte pipe to the pinned Playwright v1.62.1 `ConnectOverCDPTransport` contract and calls `chromium.connectOverCDP(transport, { isLocal: true, noDefaults: true })` only inside the Electron main/browser-host process. This overload is compile-tested against the pinned package; any package upgrade that removes it fails the build rather than falling back to a URL/path spawn. Add adversarial direct-enumeration/attachment tests and assert the renderer, provider, descriptor, and control responses contain no endpoint or reusable channel.


- [ ] **Step 2: Port the persistent browser host as an authenticated RPC service.**

Adapt `codex-chatgpt-web/launcher/electron/browser-host.cjs`, but reimplement Codex-coupled route/config/catalog code rather than copying it. The Electron process owns the persistent partition and at most five task-bound surfaces. `launcher-host.ts` validates descriptor schema, control token, owner, runtime epoch, PID/nonce, lease capability, per-connection nonce, and monotonic request sequence on every operation. Helper descriptors resolve only to launcher-owned executable/script files under the versioned private install root, with expected file identity/hash, owner-only ACLs, and a minimal allowlisted environment; re-check identity immediately before spawn and never spawn an arbitrary path/script supplied by a descriptor or inherited environment. Reject replay, out-of-order, stale-epoch, closed-lease, unknown-operation, malformed, cross-lease, `evaluate`, cookies/storageState, raw-endpoint, and attach requests. A closed/cancelled surface terminates only its own browser turn. The `BrowserWindow` and preload use packaged-origin-only navigation, context isolation, no Node integration, sandboxing, CSP, disabled webviews/remote module, and typed IPC only; these settings are enforced in code and tested rather than assumed from defaults.


- [ ] **Step 3: Test browser boundary and cross-client behavior.**

Test descriptor schema/owner/epoch/PID validation, native owner-local listener/peer/connection proof, complete identity equality and `currentPeer()` revalidation before every request, reparent/exec/PID-reuse mutation, same-user stolen-token rejection, per-request nonce/sequence replay and reordering, helper executable/script path identity/hash mismatch, arbitrary existing helper rejection, post-validation replacement, symlink/reparse and broad-ACL rejection, minimal child environment, forged/stale control tokens, direct unauthenticated CDP enumeration/attachment rejection, absence of endpoint/attach/evaluate/cookies/storageState operations and fields, five leases shared by two clients, sixth rejection, lease close idempotence, cancellation isolation, persistent partition lifecycle, process exit, and no secret exposure through descriptor/preload/control responses.
The launcher `BrowserWindow` must set `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`, disable `webviewTag`/remote module access, enforce a restrictive CSP, allow only the packaged renderer origin, and reject `will-navigate`, redirects, and window-open destinations outside that origin. Add adversarial tests for renderer navigation, `window.open`, webview/remote access, CSP violations, raw CDP enumeration/attachment, and leaked IPC/control secrets.

- [ ] **Step 4: Run the focused launcher transport checks.**

```text
bun install --frozen-lockfile
bun --cwd=packages/chatgpt-web-launcher run check
bun --cwd=packages/chatgpt-web-launcher run check:types
bun test packages/chatgpt-web-launcher/test/browser-host.test.cjs packages/chatgpt-web-launcher/test/control-server.test.cjs packages/chatgpt-web-launcher/test/cdp-input.test.cjs packages/chatgpt-web-launcher/test/design-contract.test.cjs packages/chatgpt-web-launcher/test/runtime-host.test.cjs
```

Expected: the package type boundary and authenticated browser transport pass without a signed build, account credentials, or live ChatGPT.

- [ ] **Step 5: Commit the launcher browser boundary separately.**

```text
git add packages/chatgpt-web-launcher/package.json packages/chatgpt-web-launcher/tsconfig.json packages/chatgpt-web-launcher/electron/main.cjs packages/chatgpt-web-launcher/electron/browser-host.cjs packages/chatgpt-web-launcher/electron/control-server.cjs packages/chatgpt-web-launcher/electron/cdp-input.cjs packages/chatgpt-web-launcher/src/types.ts packages/chatgpt-web-launcher/test/browser-host.test.cjs packages/chatgpt-web-launcher/test/control-server.test.cjs packages/chatgpt-web-launcher/test/cdp-input.test.cjs packages/chatgpt-web-launcher/test/design-contract.test.cjs packages/chatgpt-web-launcher/test/runtime-host.test.cjs packages/chatgpt-web-launcher/assets/icon.png packages/chatgpt-web-launcher/assets/icon.ico packages/chatgpt-web/src/runtime/host.ts packages/chatgpt-web/src/runtime/launcher-host.ts bun.lock
git commit -m "feat: add authenticated ChatGPT Web launcher browser host"
```

---

## Task 11: Add launcher supervision, installation, UI, and platform packaging

**Files:**
- Modify: `packages/chatgpt-web-launcher/package.json`
- Create/adapt: `packages/chatgpt-web-launcher/electron/{autostart,logging,process-tree,runtime,state,window-state,browser-state,browser-helper-verifier,atomic-file,runtime-command,runtime-install,runtime-supervisor}.cjs`
- Create: `packages/chatgpt-web-launcher/test/runtime-bundle.test.cjs` — installed bundle resolves provider CLI/MCP entries without importing coding-agent.
- Create: `packages/chatgpt-web-launcher/test/stale-identifiers.test.cjs` — package-wide copied-name/ID/env scan with license-path allowlist.
- Modify: `bun.lock` — refresh after the finalized launcher/runtime manifest graph.
- Modify: `packages/chatgpt-web-launcher/electron/control-server.cjs`
- Create: `packages/chatgpt-web-launcher/src/main.tsx`, `packages/chatgpt-web-launcher/src/App.tsx`, `packages/chatgpt-web-launcher/electron/preload.cjs`, `packages/chatgpt-web-launcher/src/i18n.ts`, `packages/chatgpt-web-launcher/src/icons.tsx`, `packages/chatgpt-web-launcher/src/tokens.css`, `packages/chatgpt-web-launcher/src/styles.css`, `packages/chatgpt-web-launcher/vite.config.ts`, and `packages/chatgpt-web-launcher/index.html`
- Create: `packages/chatgpt-web-launcher/scripts/build-runtime-bundle.ts`, `packages/chatgpt-web-launcher/scripts/prepare-runtime.cjs`, `packages/chatgpt-web-launcher/scripts/package.cjs`, and `packages/chatgpt-web-launcher/scripts/smoke-package.cjs`
- Create: `packages/chatgpt-web-launcher/test/{atomic-file,autostart,browser-helper-verifier,logging,packaging-contract,runtime-install,runtime-supervisor,state,window-state}.test.cjs`
- Create: launcher assets/icons and runtime bundle metadata.
- Modify: `packages/chatgpt-web/src/runtime/launcher-host.ts` only for finalized control/schema compatibility.

**Interfaces:**
- Consumes the authenticated browser transport from Task 10 and broker-first lifecycle from Task 8.
- Produces a packaged launcher that supervises the same provider runtime without changing `streamSimple` or OMP model semantics.

- [ ] **Step 1: Port runtime supervision without Codex coupling.**

Create the launcher manifest with `"name": "@oh-my-pi/pi-chatgpt-web-launcher"`, the current OMP version (`17.2.4` baseline), `appId: "sh.omp.chatgpt-web"`, `productName: "OMP ChatGPT Web"`, `artifactName: "omp-chatgpt-web-${version}-${os}-${arch}.${ext}"`, and only the `OMP_CHATGPT_WEB_*` environment namespace. Add `"@oh-my-pi/pi-chatgpt-web": "workspace:*"` as the explicit runtime dependency; the launcher UI may not import coding-agent. Adapt source helpers only after removing copied Codex URLs, names, IDs, `CODEX_HOME`, integration journals, route setup, catalog monitors, and `CODEX_WEB_GPT_*` environment names. The supervisor starts the provider runtime epoch, binds the broker once, calls `prepareTunnelSpawn()` for each tunnel start/restart, launches through `launchVerifiedProcess()` to retain the opaque `NativeOwnedProcess`, waits for versioned health/handshake identity, drains before replacement, uses bounded restart recovery, and reports crash loops explicitly. Every control request requires the random bearer token and expected epoch plus native owner-local peer/connection/descendant proof, complete identity equality, and a `currentPeer()` re-check; the token is supplemental and a same-user process with a stolen token is rejected.
Add `"smoke:package": "node scripts/smoke-package.cjs"` to the launcher manifest. `scripts/smoke-package.cjs` must locate the deterministic per-OS artifact in the package output, run it with an isolated temporary application directory and `--smoke`, wait for the authenticated readiness marker, verify clean shutdown and runtime-install persistence, reject endpoint/credential/path leakage in captured output, and remove the temporary directory; it must never require a live account, tunnel, browser session, or network.
`scripts/build-runtime-bundle.ts` has explicit Bun.build entrypoints for `packages/chatgpt-web/src/cli.ts` (lifecycle/`mcp`) and `packages/chatgpt-web/src/mcp/main.ts` where a separate child entry is required. Set `packages: "bundle"` so provider and OMP utility dependencies are actually embedded; the only permitted externals are `["playwright-core", "@modelcontextprotocol/sdk", "@oh-my-pi/pi-natives"]` when the selected runtime requires installed copies. For `@oh-my-pi/pi-natives`, copy the exact package plus the target leaf package/resource layout (`native/index.js`, loader state, embedded metadata, and the verified `.node` addon) without flattening or rewriting loader paths, and copy exact runtime manifests/lockfile entries for all externals. Verify native package/version, ABI, architecture, hash, no-follow identity, and owner ACL before startup. Do not use `packages: "external"` or an unbounded external list, because that leaves the provider graph unresolved offline or breaks native loader resolution. The bundle smoke test must resolve the provider CLI and MCP entrypoints without importing `@oh-my-pi/pi-coding-agent`; no launcher/UI code is allowed to become a provider dependency.
`prepare-runtime.cjs` must resolve `ompRoot = path.resolve(launcherRoot, "../..")`, `providerRoot = path.join(ompRoot, "packages", "chatgpt-web")`, and `launcherRoot` from the script location; it must pass those explicit roots to the local bundler, copy only the provider's declared CLI/MCP entrypoints and launcher-owned runtime metadata, and copy `providerRoot/LICENSES/NOTICE.md` plus `providerRoot/LICENSES/OpenCodex-MIT.txt` into the launcher runtime's `LICENSES` extra-resources directory. When a Bun runtime is redistributed, generate the launcher-owned `LICENSES/Bun-runtime.md` from the exact bundled version and include it in the packaged artifact; `runtime-bundle.test.cjs` and `smoke-package.cjs` must verify these notices exist, are attributable to the actual bundle, and contain no stale source paths. Do not retain the source repository's `path.resolve(launcherRoot, "..")` assumption, `generate-third-party-notices` step, root-license lookup, or any source-relative Codex path.
Keep the launcher manifest `"private": true`; it is a bundled desktop artifact, not an npm-published package. Its only workspace consumer is the local provider/runtime bundle, and release packaging must not add a registry publish step or expose private runtime paths/credentials in package metadata.
The runtime bundle must include exactly one verified `@oh-my-pi/pi-natives` native addon/resource set for each `win32/darwin/linux` × `x64/arm64` target, with target-specific hash, ABI, owner/ACL, no-follow path, and loader metadata checked before startup. Bundle smoke must load the local-peer/file/process APIs on every supported tuple, reject missing or mismatched addons, and never fall back to Node handles, UID/mode checks, or a different architecture's binary. If runtime resources are unpacked, reject traversal, symlink, junction, and hardlink entries before extraction.

- [ ] **Step 2: Implement verified installation and process ownership.**

Validate bundle identity and checksums, realpath/path identity, symlink/reparse and owner-only ACLs for the executable, entrypoint, browser helper, tunnel binary, and descriptor. Build/copy atomically into a versioned private directory; derive the runtime command solely from that verified bundle and bind health to executable hash/path plus instance nonce. Re-check parent/final identity immediately before every launch/spawn; reject alternate executables, link replacement, mismatched hash/version, and an apparently healthy endpoint served by the wrong process. `launchVerifiedProcess()` must return an opaque `NativeOwnedProcess` whose `wait()`, `terminate()`, and `close()` retain ownership; do not reconstruct process ownership from a PID or allow PID-only teardown. Allow only the launcher-generated runtime invocation and an explicitly constructed minimal environment object (`env`, never inherited `process.env`, with no credential/loader/path overrides); if the pinned tunnel cannot guarantee the same allowlist to its MCP grandchild, launch the packaged `mcp/main` entry directly or fail closed. Never persist an AppImage mount path or ASAR path in OMP settings. Own every child process and terminate only through the verified owned process handle/tree, rechecking start/executable identity or using a native handle/job boundary before each signal. Test corrupt executable, checksum mismatch, path swap, broad ACL, ready timeout, restart budget, drain timeout, PID-reuse with unrelated-process survival, reparent/exec identity change, orphan descendants, stale epoch, environment canaries, and no-child-after-drain.

- [ ] **Step 3: Build the UI and preload around health evidence.**

The UI shows setup/login status, browser-only/full mode, runtime health, active turns, MCP handshake, and explicit failure state. The preload exposes only typed allowlisted actions. It must not expose raw cookies, control tokens, tunnel credentials, profile identifiers, arbitrary IPC channels, raw CDP endpoints, prompts, DOM text, or child stdout/stderr.

Use an allowlisted structured logger: stage enum, bounded duration/counts, exit code, error class, and non-secret hashes only. Do not redact arbitrary raw text after logging it; never admit DOM text, prompt fragments, headers, URLs with queries, connector payloads, cookies, or child lines to any sink.

- [ ] **Step 4: Add complete launcher helper and packaging tests.**

The stale-identifier test must reject `codex-web-gpt`, `dev.codexwebgpt`, `CODEX_WEB_GPT_`, `CODEX_HOME`, copied Codex product labels, and source-specific route names across launcher/runtime manifests, source, bundle metadata, renderer, preload, and generated artifacts; only deliberate third-party license/attribution files are allowlisted.
Cover atomic-file behavior, browser-helper verification, state/window state, input allow-list, native owner-local listener/peer proof, complete identity/currentPeer checks, reparent/exec/PID-reuse and same-user stolen-token rejection, per-request nonce/sequence replay, unknown RPC operation/evaluate/cookies/storageState/raw-CDP rejection, logging, runtime installation, supervisor process ordering/drain/restart, lifecycle generation races, helper arbitrary-path/link/replacement rejection, minimal child environments, packaging assets/runtime resources, AppImage/ASAR paths, IPC allow-list, package-wide stale-identifier scan, and high-entropy canaries for cookies, control tokens, runtime keys, profile IDs/paths, prompt secrets, URL queries, authorization headers, and unknown-format secrets. Scan disk/rotated logs, in-memory/UI payloads, returned health/preload data, stdout, and stderr after every failure path.
The package smoke must exercise the actual produced artifact on each target OS: install into a fresh temporary application root, start with the authenticated `--smoke` mode, wait for the durable readiness marker, verify runtime-bundle identity and clean supervisor shutdown, and reject endpoint/credential/path leakage. A package that only exists on disk or passes an unpacked-file test is insufficient.

- [ ] **Step 5: Build and package on each target OS.**

```text
bun install --frozen-lockfile
bun --cwd=packages/chatgpt-web-launcher run check
bun --cwd=packages/chatgpt-web-launcher run build
bun --cwd=packages/chatgpt-web-launcher run test
bun --cwd=packages/chatgpt-web-launcher run build:runtime
bun --cwd=packages/chatgpt-web-launcher run package
bun --cwd=packages/chatgpt-web-launcher run smoke:package
```

Expected: unsigned local package artifacts build with required icons/runtime resources on Windows, macOS, and Linux CI runners. No signed release, account credential, live tunnel, or upstream action is required.

- [ ] **Step 6: Commit launcher supervision and packaging separately.**

```text
git add packages/chatgpt-web-launcher/package.json packages/chatgpt-web-launcher/electron/autostart.cjs packages/chatgpt-web-launcher/electron/logging.cjs packages/chatgpt-web-launcher/electron/process-tree.cjs packages/chatgpt-web-launcher/electron/runtime.cjs packages/chatgpt-web-launcher/electron/state.cjs packages/chatgpt-web-launcher/electron/window-state.cjs packages/chatgpt-web-launcher/electron/browser-state.cjs packages/chatgpt-web-launcher/electron/browser-helper-verifier.cjs packages/chatgpt-web-launcher/electron/atomic-file.cjs packages/chatgpt-web-launcher/electron/runtime-command.cjs packages/chatgpt-web-launcher/electron/runtime-install.cjs packages/chatgpt-web-launcher/electron/runtime-supervisor.cjs packages/chatgpt-web-launcher/electron/control-server.cjs packages/chatgpt-web-launcher/src/main.tsx packages/chatgpt-web-launcher/src/App.tsx packages/chatgpt-web-launcher/electron/preload.cjs packages/chatgpt-web-launcher/src/i18n.ts packages/chatgpt-web-launcher/src/icons.tsx packages/chatgpt-web-launcher/src/tokens.css packages/chatgpt-web-launcher/src/styles.css packages/chatgpt-web-launcher/vite.config.ts packages/chatgpt-web-launcher/index.html packages/chatgpt-web-launcher/scripts/build-runtime-bundle.ts packages/chatgpt-web-launcher/scripts/prepare-runtime.cjs packages/chatgpt-web-launcher/scripts/package.cjs packages/chatgpt-web-launcher/scripts/smoke-package.cjs packages/chatgpt-web-launcher/test/runtime-bundle.test.cjs packages/chatgpt-web-launcher/test/stale-identifiers.test.cjs packages/chatgpt-web-launcher/test/atomic-file.test.cjs packages/chatgpt-web-launcher/test/autostart.test.cjs packages/chatgpt-web-launcher/test/browser-helper-verifier.test.cjs packages/chatgpt-web-launcher/test/logging.test.cjs packages/chatgpt-web-launcher/test/packaging-contract.test.cjs packages/chatgpt-web-launcher/test/runtime-install.test.cjs packages/chatgpt-web-launcher/test/runtime-supervisor.test.cjs packages/chatgpt-web-launcher/test/state.test.cjs packages/chatgpt-web-launcher/test/window-state.test.cjs packages/chatgpt-web-launcher/assets/icon.png packages/chatgpt-web-launcher/assets/icon.ico packages/chatgpt-web/src/runtime/launcher-host.ts bun.lock
git commit -m "feat: add ChatGPT Web launcher supervision and packaging"
```

The launcher remains independently revertible from the native provider milestone.

---

## Task 12: Finish documentation, notices, CI, and local release checks

**Files:**
- Modify: `docs/models.md`
- Modify: `docs/providers.md`
- Modify: `docs/user-facing-packages.md`
- Create: `packages/chatgpt-web/README.md`
- Create: `packages/chatgpt-web/docs/security-model.md`
- Create: `packages/chatgpt-web/docs/architecture.md`
- Create: `packages/chatgpt-web/LICENSES/NOTICE.md`
- Create: `packages/chatgpt-web/LICENSES/OpenCodex-MIT.txt`
- Create conditionally: `packages/chatgpt-web/LICENSES/Bun-runtime.md` — generated from the actual redistributed Bun/runtime version only when the launcher bundles one; never copy a stale source notice.
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml` — define the tag/manual release workflow and its complete native/launcher matrix: Linux x64 baseline/modern plus arm64, a non-published musl build-only/staged verification, macOS x64/arm64, Windows x64/arm64, native ABI/hash/loader checks, launcher package artifacts, and exactly six publishable native leaf-package manifests (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`). Publish only after all matrix jobs and package/license checks pass; keep credentials out of logs and never publish a target whose loader metadata was not generated from that exact artifact.
- Modify: `package.json` — add the package check/build/test scripts used by local and CI commands.

**Interfaces:**
- Consumes all finalized provider and launcher contracts.
- Produces user-facing setup documentation, security boundaries, third-party attribution, focused CI jobs, and no generated noise in unrelated packages.

- [ ] **Step 1: Document the native setup path.**

Document exactly:

```text
omp chatgpt-web enable
omp chatgpt-web login
omp models find "ChatGPT Web"
omp --model chatgpt-web/medium
```

Explain browser-only versus full mode, profile location, Pro limitations, five-tab cap, cancellation, local tool approval, and the fact that the browser automation depends on ChatGPT UI stability and account capability.

- [ ] **Step 2: Document security and data flow.**

Add package architecture and security docs covering owner-local native listener/pipe binding (not a loopback bearer endpoint), control tokens versus the model-facing single-turn `turnToken`, authenticated connector/bootstrap handoff, browser profile storage and generation-bound markers, native verified Chrome launch/private transport/owned descendant teardown, tunnel credentials, OMP tool approval authority, canonical tool-set hashing, Windows/Unix broker peer controls, child environment allowlists, TOCTOU-safe path identity, logging redaction, and fail-closed behavior. Document that browser-only/Pro prompts contain no local tool schemas and that full-mode `chatgpt_web_bind_turn` is a dedicated pre-action handshake. Do not copy Codex-specific setup instructions.

- [ ] **Step 3: Preserve and regenerate notices.**

Copy/adapt the source notices and add every dependency actually present in `bun.lock`. Verify that OpenCodex attribution remains separate from OMP's own MIT notice.

- [ ] **Step 4: Add focused CI jobs.**

Run package type checks/unit tests on the existing OMP CI matrix. Add an explicit native/provider matrix for Linux, macOS, and Windows x64 plus arm64/cross-compile jobs: build the Rust N-API addon, regenerate bindings, run `packages/natives/test/local-peer.test.ts`, load the no-follow/file-identity and verified browser-launch subset in browser-only mode while excluding only broker peer-listener and tunnel process-control symbols, and exercise full peer/process APIs on supported targets. Unsupported API, missing addon, wrong ABI, and unsupported architecture must fail closed rather than falling back to Node, UID/mode checks, or a wrong binary. Add browser fixtures without requiring ChatGPT credentials. Add negative security fixtures for replay/unknown RPC operations, tool-hash/schema drift including every OMP `Tool` field, marker/profile swaps, path replacement, broker peer/connector isolation, child/grandchild environment canaries, approval-policy precedence, stale launcher identifiers, archive traversal/symlink/hardlink extraction, and autostart cleanup. Gate live browser and tunnel smoke behind an explicit local/manual workflow; never put account secrets in the normal PR workflow.
Each supported OS/arch job must provision the same pinned Chromium test artifact, expose its verified executable through `CHATGPT_WEB_TEST_CHROMIUM`, and run `bun test packages/chatgpt-web/test/native-browser-transport.integration.test.ts`. That gate must exercise actual OS handle/file-descriptor inheritance, Chromium's `--remote-debugging-pipe` framing, `Browser.getVersion` or `about:blank`, and child/pipe teardown; it is account-, connector-, and network-free. Musl remains build-only/staged and does not publish a separate runtime or native leaf.

- [ ] **Step 5: Run final local validation.**

```text
bun install --frozen-lockfile
bun --cwd=packages/chatgpt-web run check
bun --cwd=packages/coding-agent run check
bun --cwd=packages/chatgpt-web-launcher run check
bun --cwd=packages/chatgpt-web-launcher run build
bun --cwd=packages/chatgpt-web-launcher run test
bun run check
bun run ci:test:smoke
bun run --workspaces --if-present build
```

For the launcher, also run its package check/build/test/package commands from Task 11 on each supported OS runner.

- [ ] **Step 6: Commit documentation and CI separately.**

```text
git add docs/models.md docs/providers.md docs/user-facing-packages.md packages/chatgpt-web/README.md packages/chatgpt-web/docs/security-model.md packages/chatgpt-web/docs/architecture.md packages/chatgpt-web/LICENSES/NOTICE.md packages/chatgpt-web/LICENSES/OpenCodex-MIT.txt .github/workflows/ci.yml .github/workflows/release.yml package.json bun.lock
git commit -m "docs: document and validate ChatGPT Web integration"
```

---

## Task 13: Rebase and prepare, but do not submit, the upstream contribution

**Files:**
- No source files unless rebase conflicts expose a real integration defect.
- Review: all commits and generated lockfile/notice changes.

**Interfaces:**
- Consumes the tested local branch and both remotes.
- Produces a clean, reviewable local branch and a draft change summary without pushing or opening a PR.

- [ ] **Step 1: Rebase against the current upstream main.**

```text
git fetch upstream main
git rebase upstream/main
```

Resolve only integration conflicts; do not merge unrelated upstream changes or regenerate the whole repository.

- [ ] **Step 2: Repeat every verification gate after rebase.**

Run all commands from Tasks 6, 9, 10, 11, and 12. Repeat the live browser-only and full-mode matrices because upstream changes may alter model/session/tool behavior.

- [ ] **Step 3: Inspect the local diff.**

Check that the diff contains only the new packages, required host seams, docs, notices, lockfile/catalog entries, and focused tests. Remove generated artifacts, account-specific files, cookies, logs, and temporary bundles before any future review.

- [ ] **Step 4: Build a local PR packet without submitting it.**

Prepare a local summary containing: problem, architecture, file ownership, security model, manual smoke scenarios/results, platform packaging results, dependency/license changes, known risks, and exact test commands. Do not use GitHub CLI to create a PR, issue, comment, or review.

- [ ] **Step 5: Stop at the maintainer-review gate.**

Only after the local branch is green and the packet is reviewed by the project owner should the work be considered ready for a future upstream discussion. Until then, keep both forks unchanged remotely.

---

## Final acceptance checklist

- [ ] Both local clones use `Nou4r` forks as their `origin` remotes, retain read-only `upstream` remotes for `miuuyy/codex-chatgpt-web` and `can1357/oh-my-pi`, and have no upstream PR or issue.
- [ ] `omp chatgpt-web enable` activates exactly one extension path and package dependency/lock entries are frozen-valid.
- [ ] The native model picker lists all non-Pro routes after login and Pro only when entitled.
- [ ] Text, reasoning, image, cancellation, restart, and five-way parallel browser-only scenarios pass.
- [ ] Browser-only and full-mode Chrome login/lease starts use the digest/version-bound native verified executable/profile handle, the inherited private pipe adapted to the pinned Playwright `ConnectOverCDPTransport` contract, and owned descendant teardown; arbitrary/untrusted path-based spawn, endpoint/URL fallback, replacement, orphan, PID-reuse, stale-owner, and direct-enumeration/attachment tests fail closed, while no executable/profile path, endpoint, or reusable channel crosses the host/provider/RPC boundary.
- [ ] A sixth concurrent browser turn fails explicitly; browser-only/Pro prompts contain no local tool schemas or turn token.
- [ ] Full-mode issues a separate model-facing turn token, requires the dedicated `chatgpt_web_bind_turn` handshake before action, and keeps control/bootstrap/connector secrets off the model channel.
- [ ] Full-mode MCP calls map only to the current canonical OMP tool set, reject schema/hash drift and alias collisions, isolate two concurrent connector sessions, preserve bounded batches, and require OMP approval.
- [ ] Tool results resume the same session exactly once with exact call IDs/cardinality; replay, stale epoch, wrong connector, and cross-session results fail closed.
- [ ] Keyless `auth: "none"` registration works without credentials, accepts only OMP's normal `N/A` sentinel, survives static reload, and removes stale source markers on re-registration/cleanup.
- [ ] Profile/marker generation and executable identities are bound, freshness-checked, atomically persisted, and resistant to link, replacement, and TOCTOU swaps.
- [ ] Browser RPC is a closed typed allowlist with native owner-local peer/connection proof and `currentPeer()` revalidation plus authenticated per-lease nonce/sequence; unknown operations, evaluate/cookies/storageState, raw CDP endpoints, replay, and cross-lease access fail.
- [ ] Broker Unix/named-pipe ACL/peer/connector checks, handshake replay, complete identity/currentPeer/ancestry revalidation, and cross-client isolation pass; a same-user reader may learn the non-confidential bootstrap bytes but cannot authenticate a connection, control lifecycle, or consume the bootstrap.
- [ ] Child processes receive only allowlisted environments; credential canaries are absent from argv, environment, logs, UI, stderr, stdout, and returned diagnostics.
- [ ] Runtime/tunnel/helper commands derive only from opaque native verified executable handles and versioned bundles with hash/path identity rechecked immediately before spawn; drain generation prevents post-drain children.
- [ ] Approval precedence, explicit deny, yolo safeguards, post-hook revalidation, no-UI fail-closed behavior, cancellation, and forged approval-field rejection pass through the production wrapper.
- [ ] Launcher `tsconfig`, package checks, runtime bundle smoke, icons, app/product/artifact IDs, and stale-identifier scan pass on each target OS.
- [ ] Full-mode tunnel-id resolution uses only the pinned allowlist and authenticated scheme/host/port/CA or identity pin; redirect, DNS rebinding, certificate, host, port, endpoint substitution, and missing-key failures close without handing credentials to a substituted service.
- [ ] Launcher health, drain, restart, and atomic installation tests pass on all target platforms.
- [ ] Licenses/notices are complete and generated from the current lockfile.
- [ ] The provider-first acceptance artifact is complete before launcher tests/package work is accepted.
- [ ] Rebase verification passes against `upstream/main`.
- [ ] No GitHub PR, issue, push, or maintainer request is made before owner approval.
