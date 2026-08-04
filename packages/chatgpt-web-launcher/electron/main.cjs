"use strict";

const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");
const { LauncherBrowserHost } = require("./browser-host.cjs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const { ensurePackagedRuntime } = require("./runtime-install.cjs");
const { AuthenticatedControlServer } = require("./control-server.cjs");
const { createRuntimeCommandFactory } = require("./runtime-command.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");

const RENDERER_ORIGIN = "omp-chatgpt-web://launcher";
const RENDERER_URL = `${RENDERER_ORIGIN}/index.html`;
const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "worker-src 'none'",
].join("; ");

async function loadNativeModule() {
  return import("@oh-my-pi/pi-natives");
}
async function loadPackagedRuntimeNativeModule(resourcesPath) {
  const root = normalizedAbsolutePath(resourcesPath, "invalid_resources_path");
  const entrypoint = path.join(root, "runtime", "app", "node_modules", "@oh-my-pi", "pi-natives", "native", "index.js");
  return import(pathToFileURL(entrypoint).href);
}

async function* readNativeStream(read) {
  for (;;) {
    const chunk = await read();
    if (!(chunk instanceof Uint8Array)) throw new Error("native_stream_invalid_chunk");
    if (chunk.byteLength === 0) return;
    yield chunk;
  }
}

function wrapPeerConnection(connection) {
  return Object.freeze({
    peer: connection.peer,
    currentPeer: () => connection.currentPeer(),
    read: () => readNativeStream(() => connection.read()),
    write: (bytes) => connection.write(bytes),
    close: () => connection.close(),
  });
}

function createAsyncNativeAdapter(nativeModule) {
  if (!nativeModule || !nativeModule.NativeLocalListener
    || typeof nativeModule.NativeLocalListener.create !== "function"
    || typeof nativeModule.connectLocal !== "function"
    || typeof nativeModule.launchVerifiedBrowser !== "function"
    || typeof nativeModule.matchesProcessIdentity !== "function"
    || typeof nativeModule.verifyPeerDescendant !== "function") {
    throw new TypeError("invalid_native_module");
  }
  return Object.freeze({
    createLocalListener() {
      const listener = nativeModule.NativeLocalListener.create();
      return Object.freeze({
        endpoint: listener.endpoint,
        accept: async () => wrapPeerConnection(await listener.accept()),
        close: async () => { listener.close(); },
      });
    },
    async connectLocal(endpoint) {
      return wrapPeerConnection(await nativeModule.connectLocal(endpoint));
    },
    async launchVerifiedBrowser(spec) {
      const owned = await nativeModule.launchVerifiedBrowser(spec);
      return Object.freeze({
        process: owned.process,
        pipe: Object.freeze({
          read: () => readNativeStream(() => owned.pipe.read()),
          write: (bytes) => owned.pipe.write(bytes),
          close: () => owned.pipe.close(),
        }),
      });
    },
    matchesProcessIdentity: (expected, actual) => nativeModule.matchesProcessIdentity(expected, actual),
    verifyPeerDescendant: (peer, ancestor) => nativeModule.verifyPeerDescendant(peer, ancestor),
    currentProcessIdentity: () => {
      if (typeof nativeModule.currentProcessIdentity !== "function") throw new Error("current_process_identity_unavailable");
      return nativeModule.currentProcessIdentity();
    },
  });
}

function secureWebPreferences() {
  return Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webviewTag: false,
    enableRemoteModule: false,
    spellcheck: false,
  });
}

function isPackagedRendererUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "omp-chatgpt-web:"
      && parsed.hostname === "launcher"
      && (parsed.pathname === "/" || parsed.pathname === "/index.html")
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}
function isPackagedRendererResourceUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "omp-chatgpt-web:" || parsed.hostname !== "launcher"
      || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return false;
    if (parsed.pathname === "/" || parsed.pathname === "/index.html") return true;
    return /^\/assets\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:css|ico|js|png|svg|woff2)$/u.test(parsed.pathname)
      && !parsed.pathname.includes("..")
      && !parsed.pathname.includes("//");
  } catch {
    return false;
  }
}
function resolveRendererAssetPath(distRoot, value) {
  if (typeof distRoot !== "string" || !path.isAbsolute(distRoot) || distRoot.includes("\0")) {
    throw new TypeError("invalid_renderer_root");
  }
  if (!isPackagedRendererResourceUrl(value)) throw new TypeError("invalid_renderer_resource");
  const pathname = new URL(value).pathname;
  const relative = pathname === "/" || pathname === "/index.html" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(distRoot, relative);
  const containment = path.relative(distRoot, resolved);
  if (containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
    throw new TypeError("invalid_renderer_resource");
  }
  return resolved;
}

function createRendererProtocolHandler(distRoot) {
  const contentTypes = Object.freeze({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  });
  return async request => {
    let filePath;
    try {
      filePath = resolveRendererAssetPath(distRoot, request?.url);
      const bytes = await fs.promises.readFile(filePath);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Security-Policy": CSP,
          "Content-Type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}



function installRendererGuards(window) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockOutsideOrigin = (event, url, _inPlace, mainFrame) => {
    if (mainFrame !== false && !isPackagedRendererUrl(url)) event.preventDefault();
  };
  contents.on("will-navigate", blockOutsideOrigin);
  contents.on("will-redirect", blockOutsideOrigin);
  contents.on("did-redirect-navigation", blockOutsideOrigin);
  contents.session.webRequest.onHeadersReceived((details, callback) => {
    if (!isPackagedRendererResourceUrl(details.url)) {
      callback({ cancel: true });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP],
        "Cross-Origin-Opener-Policy": ["same-origin"],
        "Cross-Origin-Resource-Policy": ["same-origin"],
        "X-Content-Type-Options": ["nosniff"],
      },
    });
  });
}

function createSecureLauncherWindow(BrowserWindow, options = {}) {
  const { preloadPath, webPreferences: _ignoredWebPreferences, ...windowOptions } = options;
  if (preloadPath !== undefined
    && (typeof preloadPath !== "string" || !path.isAbsolute(preloadPath) || preloadPath.includes("\0"))) {
    throw new TypeError("invalid_preload_path");
  }
  const webPreferences = {
    ...secureWebPreferences(),
    ...(preloadPath === undefined ? {} : { preload: preloadPath }),
  };
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    ...windowOptions,
    webPreferences,
  });
  installRendererGuards(window);
  return window;
}

function sanitizedChildEnvironment(source, platform = process.platform) {
  const keys = platform === "win32"
    ? ["SystemRoot", "WINDIR", "TEMP", "TMP"]
    : ["HOME", "LANG", "LC_ALL", "TMPDIR"];
  const result = Object.create(null);
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 32_768 && !value.includes("\0")) result[key] = value;
  }
  return Object.freeze(result);
}

function fixedHelperPaths(privateInstallRoot, version) {
  if (typeof privateInstallRoot !== "string" || !path.isAbsolute(privateInstallRoot)) throw new TypeError("invalid_private_install_root");
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new TypeError("invalid_runtime_version");
  const versionRoot = path.join(privateInstallRoot, version);
  return Object.freeze({
    versionRoot,
    executable: path.join(versionRoot, "runtime", process.platform === "win32" ? "bun.exe" : "bun"),
    script: path.join(versionRoot, "runtime", "launcher-client.js"),
  });
}

function digestMatches(expected, bytes) {
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected)) return false;
  const actual = createHash("sha256").update(bytes).digest();
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function verifyLauncherHelper({ nativeModule, privateInstallRoot, version, expected }) {
  const native = nativeModule ?? await loadNativeModule();
  if (!expected || typeof expected !== "object"
    || !/^[0-9a-f]{64}$/u.test(expected.executableSha256)
    || !/^[0-9a-f]{64}$/u.test(expected.scriptSha256)
    || typeof expected.executableIdentity !== "string"
    || typeof expected.scriptIdentity !== "string") throw new TypeError("invalid_helper_manifest");
  const paths = fixedHelperPaths(privateInstallRoot, version);
  const executable = await native.openVerifiedExecutable({
    path: paths.executable,
    sha256: expected.executableSha256,
    version,
  });
  if (executable.identity !== expected.executableIdentity) throw new Error("helper_executable_identity_mismatch");
  if (!native.NativeOwnedFile || typeof native.NativeOwnedFile.open !== "function") throw new Error("native_owned_file_unavailable");
  const script = await native.NativeOwnedFile.open(paths.script, false);
  try {
    const bytes = script.read();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 16 * 1024 * 1024
      || !digestMatches(expected.scriptSha256, bytes)) throw new Error("helper_script_hash_mismatch");
    if (script.identity !== expected.scriptIdentity) throw new Error("helper_script_identity_mismatch");
    return Object.freeze({ executable, script, paths });
  } catch (error) {
    script.close();
    throw error;
  }
}

async function revalidateLauncherHelper(nativeModule, verified, expected) {
  const current = await verifyLauncherHelper({
    nativeModule,
    privateInstallRoot: path.dirname(verified.paths.versionRoot),
    version: path.basename(verified.paths.versionRoot),
    expected,
  });
  try {
    if (current.executable.identity !== verified.executable.identity
      || current.script.identity !== verified.script.identity) throw new Error("helper_identity_replaced");
    return current;
  } catch (error) {
    current.script.close();
    throw error;
  }
}

function createProviderControlBrowserHost({ runtime, requestLogin }) {
  if (!runtime?.host || typeof runtime.host.lease !== "function"
    || !runtime.gate || typeof runtime.gate.admit !== "function" || typeof runtime.gate.release !== "function"
    || typeof requestLogin !== "function") throw new TypeError("invalid_provider_runtime");
  const leases = new Set();
  const loginTasks = new Set();
  let closed = false;
  let closeTask;
  const closeLease = async entry => {
    if (entry.closed) return;
    entry.closed = true;
    leases.delete(entry);
    const errors = [];
    try { await entry.lease.close(); } catch (error) { errors.push(error); }
    try { runtime.gate.release(entry.admission); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, "provider_browser_lease_close_failed");
  };
  const trackLogin = request => {
    if (closed) return Promise.reject(new Error("browser_host_closed"));
    const task = Promise.resolve().then(() => requestLogin(request));
    loginTasks.add(task);
    void task.then(
      () => loginTasks.delete(task),
      () => loginTasks.delete(task),
    );
    return task;
  };
  return Object.freeze({
    login: request => trackLogin(request),
    async lease(request) {
      if (closed) throw new Error("browser_host_closed");
      const admission = await runtime.gate.admit("turn");
      if (closed) {
        try { runtime.gate.release(admission); }
        catch (error) { throw new AggregateError([error], "provider_browser_lease_open_failed"); }
        throw new Error("browser_host_closed");
      }
      let lease;
      try {
        lease = await runtime.host.lease(request, admission);
      } catch (error) {
        try { runtime.gate.release(admission); }
        catch (releaseError) {
          throw new AggregateError([error, releaseError], "provider_browser_lease_open_failed");
        }
        throw error;
      }
      const entry = { admission, lease, closed: false };
      if (closed) {
        await closeLease(entry);
        throw new Error("browser_host_closed");
      }
      const wrapped = Object.freeze({
        id: lease.id,
        capability: lease.capability,
        page: lease.page,
        stageAttachment: input => lease.stageAttachment(input),
        close: () => closeLease(entry),
      });
      leases.add(entry);
      return wrapped;
    },
    async close() {
      if (closeTask) return closeTask;
      closed = true;
      closeTask = (async () => {
        const results = await Promise.allSettled([...leases].map(closeLease));
        await Promise.allSettled([...loginTasks]);
        const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (errors.length > 0) throw new AggregateError(errors, "provider_browser_host_close_failed");
      })();
      return closeTask;
    },
  });
}

async function createLauncherMain({
  nativeModule: providedNativeModule,
  playwrightChromium = chromium,
  listener: providedListener,
  authority,
  ownerIdentity,
  launcherIdentity,
  executable,
  profile,
  browserOptions,
  packageLoginHost,
  providerRuntime,
  providerRequestLogin,
}) {
  const nativeModule = providedNativeModule ?? await loadNativeModule();
  const native = createAsyncNativeAdapter(nativeModule);
  if (!authority || authority.launcherPid !== launcherIdentity?.pid || !ownerIdentity) {
    throw new TypeError("invalid_launcher_authority");
  }
  let browserHost;
  if (providerRuntime !== undefined) {
    browserHost = createProviderControlBrowserHost({
      runtime: providerRuntime,
      requestLogin: providerRequestLogin,
    });
  } else {
    if (!profile || typeof profile !== "object" || !profile.root || !profile.reference || !profile.config
      || typeof profile.generation !== "string" || !profile.generation
      || typeof profile.ownerFence !== "string" || !profile.ownerFence) throw new TypeError("invalid_opaque_profile");
    if (!packageLoginHost || typeof packageLoginHost.login !== "function" || typeof packageLoginHost.close !== "function") {
      throw new TypeError("invalid_package_login_host");
    }
    if (!executable) throw new TypeError("invalid_launcher_authority");
    const environment = await nativeModule.createLaunchEnvironment({
      kind: "browser-child",
      profileRoot: profile.root,
      profileGeneration: profile.generation,
      ownerFence: profile.ownerFence,
    });
    const loginHost = Object.freeze({
      async login(request) {
        if (request.profileGeneration !== profile.generation || request.ownerFence !== profile.ownerFence) {
          throw new Error("stale_profile_authority");
        }
        return packageLoginHost.login({
          profile: profile.reference,
          config: profile.config,
          profileGeneration: profile.generation,
          ownerFence: profile.ownerFence,
          headed: true,
          signal: request.signal,
        });
      },
      close: () => packageLoginHost.close(),
    });
    const launchSpec = Object.freeze({
      executable,
      environment,
      options: Object.freeze({
        headed: browserOptions?.headed === true,
        featureToggles: Object.freeze([
          "disable-background-networking",
          "disable-component-update",
          "disable-default-apps",
        ]),
      }),
    });
    browserHost = new LauncherBrowserHost({
      native,
      chromium: playwrightChromium,
      launchSpec,
      loginHost,
    });
  }
  const listener = providedListener ?? native.createLocalListener();
  const controlServer = new AuthenticatedControlServer({
    listener,
    native,
    browserHost,
    authority,
    ownerIdentity,
    launcherIdentity,
  }).start();
  return Object.freeze({
    descriptor: controlServer.descriptor(),
    publicState: () => controlServer.publicState(),
    close: () => controlServer.close(),
  });
}
const PUBLIC_IPC_CHANNELS = Object.freeze({
  GET_STATE: "omp-chatgpt-web:state:get",
  STATE_CHANGED: "omp-chatgpt-web:state:changed",
  REQUEST_LOGIN: "omp-chatgpt-web:login:request",
  SET_MODE: "omp-chatgpt-web:mode:set",
  RESTART_RUNTIME: "omp-chatgpt-web:runtime:restart",
  SET_AUTOSTART: "omp-chatgpt-web:autostart:set",
});
const PUBLIC_STATE_KEYS = Object.freeze([
  "activeTurns", "autoStart", "failure", "login", "mcp", "mode", "revision", "runtime", "setup",
]);
const DEFAULT_PUBLIC_STATE = Object.freeze({
  revision: 0,
  setup: "failed",
  login: "unknown",
  mode: "browser-only",
  runtime: "failed",
  activeTurns: 0,
  mcp: "disabled",
  autoStart: false,
  failure: Object.freeze({ code: "internal", recoverable: false }),
});
const PUBLIC_STATE_ENUMS = Object.freeze({
  setup: new Set(["checking", "ready", "login-required", "failed"]),
  login: new Set(["unknown", "required", "in-progress", "authenticated", "failed"]),
  mode: new Set(["browser-only", "full"]),
  runtime: new Set(["stopped", "starting", "ready", "degraded", "restarting", "failed"]),
  mcp: new Set(["disabled", "waiting", "connected", "failed"]),
  failure: new Set(["configuration", "authentication", "browser", "runtime", "mcp", "restart-limit", "internal"]),
});
const SMOKE_READY_MARKER = "OMP_CHATGPT_WEB_SMOKE_READY";

function validateRendererState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== PUBLIC_STATE_KEYS.join("\0")) throw new TypeError("invalid_public_state");
  for (const field of ["setup", "login", "mode", "runtime", "mcp"]) {
    if (!PUBLIC_STATE_ENUMS[field].has(value[field])) throw new TypeError("invalid_public_state");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isInteger(value.activeTurns) || value.activeTurns < 0 || value.activeTurns > 5
    || typeof value.autoStart !== "boolean") throw new TypeError("invalid_public_state");
  let failure = null;
  if (value.failure !== null) {
    if (!value.failure || typeof value.failure !== "object" || Array.isArray(value.failure)
      || Object.keys(value.failure).sort().join("\0") !== "code\0recoverable"
      || !PUBLIC_STATE_ENUMS.failure.has(value.failure.code)
      || typeof value.failure.recoverable !== "boolean") throw new TypeError("invalid_public_state");
    failure = Object.freeze({ code: value.failure.code, recoverable: value.failure.recoverable });
  }
  return Object.freeze({
    revision: value.revision,
    setup: value.setup,
    login: value.login,
    mode: value.mode,
    runtime: value.runtime,
    activeTurns: value.activeTurns,
    mcp: value.mcp,
    autoStart: value.autoStart,
    failure,
  });
}

function createRendererStateStore(initialState = DEFAULT_PUBLIC_STATE) {
  let state = validateRendererState(initialState);
  const listeners = new Set();
  return Object.freeze({
    read: () => state,
    replace(nextState) {
      state = validateRendererState(nextState);
      for (const listener of listeners) listener(state);
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("invalid_public_state_listener");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function registerLauncherIpc(ipcMain, stateStore, actions = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function" || typeof ipcMain.removeHandler !== "function") {
    throw new TypeError("invalid_ipc_main");
  }
  if (!stateStore || typeof stateStore.read !== "function" || typeof stateStore.replace !== "function") {
    throw new TypeError("invalid_public_state_store");
  }
  const handlers = new Map([
    [PUBLIC_IPC_CHANNELS.GET_STATE, async () => stateStore.read()],
    [PUBLIC_IPC_CHANNELS.REQUEST_LOGIN, async () => invokeAction("requestLogin", [])],
    [PUBLIC_IPC_CHANNELS.SET_MODE, async (_event, mode) => {
      if (!PUBLIC_STATE_ENUMS.mode.has(mode)) throw new TypeError("invalid_launcher_mode");
      return invokeAction("setMode", [mode]);
    }],
    [PUBLIC_IPC_CHANNELS.RESTART_RUNTIME, async () => invokeAction("restartRuntime", [])],
    [PUBLIC_IPC_CHANNELS.SET_AUTOSTART, async (_event, enabled) => {
      if (typeof enabled !== "boolean") throw new TypeError("invalid_autostart_value");
      return invokeAction("setAutoStart", [enabled]);
    }],
  ]);
  async function invokeAction(name, arguments_) {
    if (typeof actions[name] !== "function") throw new Error("launcher_action_unavailable");
    const result = await actions[name](...arguments_);
    if (result !== undefined) stateStore.replace(result);
    return stateStore.read();
  }
  for (const [channel, handler] of handlers) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
  }
  return () => {
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
  };
}

function normalizedAbsolutePath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)
    || path.normalize(value) !== value) throw new TypeError(code);
  return value;
}

async function runSmokeMode({
  app,
  native,
  appDir,
  markerPath,
  resourcesPath,
  platform = process.platform,
  arch = process.arch,
  writeMarker = writePrivateFileAtomic,
  writeOutput = line => process.stdout.write(line),
}) {
  const root = normalizedAbsolutePath(appDir, "invalid_smoke_app_dir");
  const marker = normalizedAbsolutePath(markerPath, "invalid_smoke_marker");
  const relative = path.relative(root, marker);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError("invalid_smoke_marker");
  }
  const installed = await ensurePackagedRuntime({
    app,
    coreHome: root,
    resourcesPath: normalizedAbsolutePath(resourcesPath, "invalid_resources_path"),
    native,
    platform,
    arch,
  });
  try {
    writeMarker(marker, `${JSON.stringify({
      marker: SMOKE_READY_MARKER,
      ready: true,
      packaged: true,
      runtimeVerified: true,
      version: installed.version,
      platform: installed.platform,
      arch: installed.arch,
    })}\n`);
    writeOutput(`${SMOKE_READY_MARKER}\n`);
  } finally {
    installed.close();
  }
}
const RUNTIME_AUTHORITY_METHODS = Object.freeze([
  "installRuntimeBundleAtomic",
  "launchVerifiedProcess",
  "openRuntimeBundle",
  "prepareVerifiedRuntimeLaunch",
  "verifyRuntimeBundle",
]);

function hasPackagedRuntimeAuthority(app, native, providerEpochOptions) {
  return app?.isPackaged === true
    && providerEpochOptions !== null
    && typeof providerEpochOptions === "object"
    && !Array.isArray(providerEpochOptions)
    && RUNTIME_AUTHORITY_METHODS.every(method => typeof native?.[method] === "function");
}

function runtimeRendererPatch(snapshot, mode, autoStart) {
  const runtimeStatus = snapshot.status === "draining" ? "stopped" : snapshot.status;
  const runtime = ["stopped", "starting", "ready", "restarting", "failed"].includes(runtimeStatus)
    ? runtimeStatus
    : "failed";
  const failed = runtime === "failed";
  return Object.freeze({
    setup: failed ? "failed" : "ready",
    login: "unknown",
    mode,
    runtime,
    activeTurns: 0,
    mcp: mode === "browser-only" ? "disabled" : failed ? "failed" : runtime === "ready" ? "connected" : "waiting",
    autoStart,
    failure: failed
      ? Object.freeze({
          code: snapshot.errorClass === "RuntimeRestartBudgetExceeded" ? "restart-limit" : "runtime",
          recoverable: snapshot.errorClass !== "RuntimeRestartBudgetExceeded",
        })
      : null,
  });
}

async function createPackagedRuntimeIntegration({
  app,
  native,
  providerEpochOptions,
  providerLoader,
  resourcesPath,
  coreHome,
  stateStore,
  initialMode = "browser-only",
  logger,
}) {
  if (!hasPackagedRuntimeAuthority(app, native, providerEpochOptions)) {
    throw new Error("packaged_runtime_authority_unavailable");
  }
  if (!stateStore || typeof stateStore.read !== "function" || typeof stateStore.replace !== "function") {
    throw new TypeError("invalid_public_state_store");
  }
  if (initialMode !== "browser-only" && initialMode !== "full") throw new TypeError("runtime_mode_invalid");
  const installedRuntime = await ensurePackagedRuntime({
    app,
    coreHome: normalizedAbsolutePath(coreHome, "invalid_runtime_home"),
    resourcesPath: normalizedAbsolutePath(resourcesPath, "invalid_resources_path"),
    native,
  });
  let closed = false;
  let selectedMode = initialMode;
  let autoStart = getAutostart(app).enabled;
  let unsubscribe = () => {};
  try {
    const supervisor = new RuntimeSupervisor({
      providerEpochOptions,
      providerLoader,
      native,
      commandFactory: createRuntimeCommandFactory({ native, installedRuntime }),
      logger,
    });
    const publish = snapshot => {
      if (closed) return stateStore.read();
      const current = stateStore.read();
      return stateStore.replace({
        revision: current.revision + 1,
        ...runtimeRendererPatch(snapshot, selectedMode, autoStart),
      });
    };
    unsubscribe = supervisor.subscribe(publish);
    const actions = Object.freeze({
      async setMode(mode) {
        if (mode !== "browser-only" && mode !== "full") throw new TypeError("invalid_launcher_mode");
        selectedMode = mode;
        if (mode === "full") await supervisor.start({ mode: "full" });
        else await supervisor.drain();
        return publish(supervisor.snapshot());
      },
      async restartRuntime() {
        if (selectedMode !== "full") throw new Error("runtime_not_started");
        await supervisor.restart();
        return publish(supervisor.snapshot());
      },
      async setAutoStart(enabled) {
        const result = setAutostart(app, enabled);
        if (!result.supported) throw new Error("autostart_unsupported");
        autoStart = result.enabled;
        return publish(supervisor.snapshot());
      },
    });
    if (initialMode === "full") await supervisor.start({ mode: "full" });
    else publish(supervisor.snapshot());
    return Object.freeze({
      actions,
      supervisor,
      async close() {
        if (closed) return;
        closed = true;
        unsubscribe();
        try { await supervisor.stop(); }
        finally { installedRuntime.close(); }
      },
    });
  } catch (error) {
    unsubscribe();
    installedRuntime.close();
    throw error;
  }
}


function loadPackagedProviderModule() {
  return require(path.join(__dirname, "..", "build", "provider-runtime.cjs"));
}

function providerRendererPatch({ config, authenticated, runtime, autoStart, failure = null }) {
  const mode = config?.mode === "full" ? "full" : "browser-only";
  const ready = runtime === "ready";
  return Object.freeze({
    setup: config ? (authenticated ? "ready" : "login-required") : "login-required",
    login: authenticated ? "authenticated" : failure?.code === "browser" ? "failed" : "required",
    mode,
    runtime,
    activeTurns: 0,
    mcp: mode === "full" ? (ready ? "connected" : runtime === "failed" ? "failed" : "waiting") : "disabled",
    autoStart,
    failure,
  });
}

async function createDefaultPackagedProviderIntegration({
  app,
  native,
  providerModule: providedProviderModule,
  providerModuleLoader = loadPackagedProviderModule,
  resourcesPath,
  coreHome,
  stateStore,
  ensureRuntime = ensurePackagedRuntime,
}) {
  if (app?.isPackaged !== true || !native || typeof native.currentProcessIdentity !== "function") {
    throw new Error("packaged_provider_authority_unavailable");
  }
  if (!stateStore || typeof stateStore.read !== "function" || typeof stateStore.replace !== "function") {
    throw new TypeError("invalid_public_state_store");
  }
  const runtimeResourcesPath = normalizedAbsolutePath(resourcesPath, "invalid_resources_path");
  const runtimeHome = normalizedAbsolutePath(coreHome, "invalid_runtime_home");
  const installedRuntime = await ensureRuntime({
    app,
    coreHome: runtimeHome,
    resourcesPath: runtimeResourcesPath,
    native,
  });
  let closed = false;
  let control;
  let loginHost;
  let loginTask;
  let loginAbortController;
  let closeTask;
  let config = null;
  let authenticated = false;
  let autoStart = getAutostart(app).enabled;
  try {
    if (!installedRuntime || typeof installedRuntime.root !== "string"
      || !path.isAbsolute(installedRuntime.root) || typeof installedRuntime.close !== "function") {
      throw new Error("installed_runtime_invalid");
    }
    const provider = providedProviderModule ?? await providerModuleLoader();
    for (const method of [
      "createNativeLocalRuntimeBootstrap",
      "loginChatGptWeb",
      "readChatGptWebConfig",
      "readChatGptWebLoginStatus",
      "setupChatGptWeb",
    ]) {
      if (typeof provider?.[method] !== "function") throw new Error("packaged_provider_bundle_invalid");
    }
    const bootstrap = provider.createNativeLocalRuntimeBootstrap({
      nativeModule: native,
      runtimeBundleRoot: installedRuntime.root,
    });
    if (!bootstrap?.secureHost || typeof bootstrap.createLoginHost !== "function"
      || typeof bootstrap.resolveRuntime !== "function" || typeof bootstrap.closeRuntime !== "function") {
      throw new Error("packaged_provider_bootstrap_invalid");
    }
    const publish = patch => {
      if (closed) return stateStore.read();
      const current = stateStore.read();
      return stateStore.replace({ revision: current.revision + 1, ...patch });
    };
    const publishStatus = (runtime, failure = null) =>
      publish(providerRendererPatch({ config, authenticated, runtime, autoStart, failure }));
    const readStatus = async () => {
      config = await provider.readChatGptWebConfig({ host: bootstrap.secureHost });
      authenticated = (await provider.readChatGptWebLoginStatus({ secureHost: bootstrap.secureHost }))?.authenticated === true;
    };
    let actions;
    const closeControl = async () => {
      const current = control;
      control = undefined;
      if (current) await current.close();
    };
    const startRuntime = async () => {
      if (closed) throw new Error("provider_integration_closed");
      const runtime = await bootstrap.resolveRuntime();
      if (closed) {
        await runtime.close?.();
        throw new Error("provider_integration_closed");
      }
      const processIdentity = native.currentProcessIdentity();
      if (!processIdentity || !Number.isSafeInteger(processIdentity.pid) || processIdentity.pid <= 0) {
        await runtime.close?.();
        throw new Error("current_process_identity_invalid");
      }
      await closeControl();
      if (closed) {
        await runtime.close?.();
        throw new Error("provider_integration_closed");
      }
      let nextControl;
      try {
        nextControl = await createLauncherMain({
          nativeModule: native,
          authority: Object.freeze({
            ownerId: randomBytes(24).toString("base64url"),
            runtimeEpoch: randomBytes(24).toString("base64url"),
            lifecycleGeneration: 1,
            launcherPid: processIdentity.pid,
            controlToken: randomBytes(32).toString("base64url"),
          }),
          ownerIdentity: processIdentity,
          launcherIdentity: processIdentity,
          providerRuntime: runtime,
          providerRequestLogin: async ({ signal } = {}) => {
            const state = await actions.requestLogin(signal);
            return Object.freeze({ authenticated: state.login === "authenticated" });
          },
        });
        if (closed) {
          await nextControl.close();
          await runtime.close?.();
          throw new Error("provider_integration_closed");
        }
        control = nextControl;
      } catch (error) {
        if (nextControl && nextControl !== control) await nextControl.close().catch(() => {});
        if (typeof runtime.close === "function") await runtime.close().catch(() => {});
        throw error;
      }
      return runtime;
    };
    const runLogin = async (signal) => {
      if (closed) throw new Error("provider_integration_closed");
      publish(providerRendererPatch({
        config,
        authenticated: false,
        runtime: "stopped",
        autoStart,
        failure: null,
      }));
      try {
        if (!config) {
          ({ config } = await provider.setupChatGptWeb({
            mode: "browser-only",
            secureHost: bootstrap.secureHost,
          }));
        }
        if (signal?.aborted) throw new Error("aborted");
        loginHost = bootstrap.createLoginHost();
        await provider.loginChatGptWeb({
          secureHost: bootstrap.secureHost,
          loginHost,
          signal,
        });
        if (signal?.aborted) throw new Error("aborted");
        loginHost = undefined;
        authenticated = true;
        await bootstrap.closeRuntime();
        await startRuntime();
        return publishStatus("ready");
      } catch {
        authenticated = false;
        publishStatus("failed", Object.freeze({ code: "browser", recoverable: true }));
        if (signal?.aborted) throw new Error("aborted");
        throw new Error("login_failed");
      } finally {
        const current = loginHost;
        loginHost = undefined;
        if (current) await current.close().catch(() => {});
      }
    };
    actions = Object.freeze({
      requestLogin(signal) {
        if (!loginTask) {
          const controller = new AbortController();
          loginAbortController = controller;
          const abort = () => controller.abort();
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
          loginTask = runLogin(controller.signal).finally(() => {
            signal?.removeEventListener("abort", abort);
            if (loginAbortController === controller) loginAbortController = undefined;
            loginTask = undefined;
          });
        }
        return loginTask;
      },
      async setMode(mode) {
        if (mode !== "browser-only" && mode !== "full") throw new TypeError("invalid_launcher_mode");
        if (config?.mode !== mode) {
          if (mode === "full") {
            publishStatus("failed", Object.freeze({ code: "configuration", recoverable: true }));
            throw new Error("full_mode_configuration_required");
          }
          ({ config } = await provider.setupChatGptWeb({
            mode: "browser-only",
            secureHost: bootstrap.secureHost,
          }));
          await closeControl();
          await bootstrap.closeRuntime();
          authenticated = (await provider.readChatGptWebLoginStatus({
            secureHost: bootstrap.secureHost,
          }))?.authenticated === true;
        }
        if (!authenticated) return publishStatus("stopped");
        await startRuntime();
        return publishStatus("ready");
      },
      async restartRuntime() {
        if (!config || !authenticated) {
          publishStatus("failed", Object.freeze({ code: "authentication", recoverable: true }));
          throw new Error("runtime_not_authenticated");
        }
        publishStatus("restarting");
        try {
          await closeControl();
          await bootstrap.closeRuntime();
          await startRuntime();
          return publishStatus("ready");
        } catch {
          publishStatus("failed", Object.freeze({ code: "runtime", recoverable: true }));
          throw new Error("runtime_restart_failed");
        }
      },
      async setAutoStart(enabled) {
        const result = setAutostart(app, enabled);
        if (!result.supported) throw new Error("autostart_unsupported");
        autoStart = result.enabled;
        return publishStatus(stateStore.read().runtime);
      },
    });
    try {
      await readStatus();
      if (config && authenticated) {
        publishStatus("starting");
        await startRuntime();
        publishStatus("ready");
      } else {
        publishStatus("stopped");
      }
    } catch {
      publishStatus("failed", Object.freeze({ code: config ? "runtime" : "internal", recoverable: true }));
    }
    return Object.freeze({
      actions,
      async close() {
        if (closeTask) return closeTask;
        closed = true;
        loginAbortController?.abort();
        const pendingLogin = loginTask;
        closeTask = (async () => {
          const errors = [];
          if (pendingLogin) await pendingLogin.catch(() => {});
          try { await closeControl(); } catch (error) { errors.push(error); }
          const currentLoginHost = loginHost;
          loginHost = undefined;
          if (currentLoginHost) {
            try { await currentLoginHost.close(); } catch (error) { errors.push(error); }
          }
          try { await bootstrap.closeRuntime(); } catch (error) { errors.push(error); }
          try { installedRuntime.close(); } catch (error) { errors.push(error); }
          if (errors.length > 0) throw new AggregateError(errors, "packaged_provider_cleanup_failed");
        })();
        return closeTask;
      },
    });
  } catch (error) {
    try { installedRuntime?.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], "packaged_provider_startup_failed"); }
    throw error;
  }
}

async function startRendererShell(electron, options = {}) {
  const { app, BrowserWindow, ipcMain, protocol } = electron;
  protocol.registerSchemesAsPrivileged([{
    scheme: "omp-chatgpt-web",
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
  }]);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  app.setName("OMP ChatGPT Web");
  if (process.platform === "win32") app.setAppUserModelId("sh.omp.chatgpt-web");
  await app.whenReady();
  await protocol.handle("omp-chatgpt-web", createRendererProtocolHandler(path.join(__dirname, "..", "dist")));
  const stateStore = options.stateStore ?? createRendererStateStore();
  let runtimeIntegration = null;
  if (typeof options.prepareRuntimeIntegration === "function") {
    try {
      runtimeIntegration = await options.prepareRuntimeIntegration({ app, stateStore });
    } catch {
      stateStore.replace(DEFAULT_PUBLIC_STATE);
    }
  }
  const cleanupIpc = registerLauncherIpc(
    ipcMain,
    stateStore,
    runtimeIntegration?.actions ?? options.actions,
  );
  let window;
  try {
    window = createSecureLauncherWindow(BrowserWindow, {
      preloadPath: path.join(__dirname, "preload.cjs"),
      title: "OMP ChatGPT Web",
    });
  } catch (error) {
    cleanupIpc();
    try { await runtimeIntegration?.close(); }
    catch { process.exitCode = 1; }
    throw error;
  }
  const unsubscribe = stateStore.subscribe(state => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(PUBLIC_IPC_CHANNELS.STATE_CHANGED, state);
    }
  });
  let allowClose = false;
  let cleaned = false;
  let shutdownPromise;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unsubscribe();
    cleanupIpc();
  };
  const shutdown = () => {
    if (!shutdownPromise) {
      shutdownPromise = Promise.resolve().then(async () => {
        try { await runtimeIntegration?.close(); }
        finally { await options.onShutdown?.(); }
      }).finally(cleanup);
    }
    return shutdownPromise;
  };
  window.on("close", event => {
    if (allowClose) return;
    event.preventDefault();
    void shutdown().catch(() => {
      process.exitCode = 1;
    }).finally(() => {
      allowClose = true;
      if (!window.isDestroyed()) window.close();
    });
  });
  window.on("closed", cleanup);
  app.on("second-instance", () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on("window-all-closed", () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    }).finally(() => {
      if (process.platform !== "darwin") app.quit();
    });
  });
  try {
    await window.loadURL(RENDERER_URL);
    window.show();
  } catch (error) {
    try { await shutdown(); }
    catch { process.exitCode = 1; }
    allowClose = true;
    if (!window.isDestroyed()) window.close();
    throw error;
  }
  return Object.freeze({
    window,
    stateStore,
    async close() {
      await shutdown();
      allowClose = true;
      if (!window.isDestroyed()) window.close();
    },
  });
}

async function startElectronEntrypoint(options = {}) {
  const electron = options.electron ?? require("electron");
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  if (argv.includes("--smoke")) {
    await electron.app.whenReady();
    const resourcesPath = options.resourcesPath ?? process.resourcesPath;
    const native = options.nativeModule ?? (electron.app.isPackaged
      ? await loadPackagedRuntimeNativeModule(resourcesPath)
      : await loadNativeModule());
    await runSmokeMode({
      app: electron.app,
      native,
      appDir: env.OMP_CHATGPT_WEB_APP_DIR,
      markerPath: env.OMP_CHATGPT_WEB_SMOKE_MARKER,
      resourcesPath,
      writeOutput: options.writeOutput,
    });
    electron.app.exit(0);
    return null;
  }
  const providerEpochOptions = options.providerEpochOptions;
  const canPrepareRuntime = electron.app.isPackaged === true
    && providerEpochOptions !== null
    && typeof providerEpochOptions === "object"
    && !Array.isArray(providerEpochOptions);
  let prepareRuntimeIntegration = options.prepareRuntimeIntegration;
  if (!prepareRuntimeIntegration && canPrepareRuntime) {
    prepareRuntimeIntegration = async ({ app, stateStore }) => {
      const resourcesPath = options.resourcesPath ?? process.resourcesPath;
      const native = options.nativeModule ?? await loadPackagedRuntimeNativeModule(resourcesPath);
      return createPackagedRuntimeIntegration({
        app,
        native,
        providerEpochOptions,
        providerLoader: options.providerLoader,
        resourcesPath,
        coreHome: options.coreHome ?? app.getPath("userData"),
        stateStore,
        initialMode: options.initialMode,
        logger: options.logger,
      });
    };
  } else if (!prepareRuntimeIntegration && electron.app.isPackaged === true) {
    prepareRuntimeIntegration = async ({ app, stateStore }) => {
      const resourcesPath = options.resourcesPath ?? process.resourcesPath;
      const native = options.nativeModule ?? await loadPackagedRuntimeNativeModule(resourcesPath);
      return createDefaultPackagedProviderIntegration({
        app,
        native,
        providerModule: options.providerModule,
        providerModuleLoader: options.providerModuleLoader,
        resourcesPath,
        coreHome: options.coreHome ?? app.getPath("userData"),
        stateStore,
        ensureRuntime: options.ensureRuntime,
      });
    };
  }
  return startRendererShell(electron, { ...options, prepareRuntimeIntegration });
}


module.exports = {
  CSP,
  RENDERER_ORIGIN,
  RENDERER_URL,
  DEFAULT_PUBLIC_STATE,
  PUBLIC_IPC_CHANNELS,
  SMOKE_READY_MARKER,
  createLauncherMain,
  createAsyncNativeAdapter,
  createPackagedRuntimeIntegration,
  createDefaultPackagedProviderIntegration,
  createProviderControlBrowserHost,
  createRendererStateStore,
  createRendererProtocolHandler,
  createSecureLauncherWindow,
  fixedHelperPaths,
  installRendererGuards,
  hasPackagedRuntimeAuthority,
  isPackagedRendererResourceUrl,
  isPackagedRendererUrl,
  normalizedAbsolutePath,
  registerLauncherIpc,
  resolveRendererAssetPath,
  revalidateLauncherHelper,
  loadPackagedProviderModule,
  loadPackagedRuntimeNativeModule,
  loadNativeModule,
  sanitizedChildEnvironment,
  runtimeRendererPatch,
  runSmokeMode,
  secureWebPreferences,
  startElectronEntrypoint,
  startRendererShell,
  validateRendererState,
  verifyLauncherHelper,
};

if (require.main === module) {
  void startElectronEntrypoint().catch(() => {
    process.exitCode = 1;
    try { require("electron").app.exit(1); } catch {}
  });
}
