"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_PUBLIC_STATE,
  IPC_CHANNELS,
  createPreloadApi,
  validatePublicState,
} = require("../electron/preload.cjs");
const {
  DEFAULT_PUBLIC_STATE: MAIN_DEFAULT_PUBLIC_STATE,
  PUBLIC_IPC_CHANNELS,
  createRendererStateStore,
  hasPackagedRuntimeAuthority,
  registerLauncherIpc,
  runtimeRendererPatch,
  validateRendererState,
} = require("../electron/main.cjs");

const packageRoot = path.resolve(__dirname, "..");

function publicState(overrides = {}) {
  return {
    revision: 7,
    setup: "ready",
    login: "authenticated",
    mode: "full",
    runtime: "ready",
    activeTurns: 2,
    mcp: "connected",
    autoStart: true,
    failure: null,
    ...overrides,
  };
}

function fakeRenderer(response = publicState()) {
  const calls = [];
  const listeners = new Map();
  const removals = [];
  return {
    calls,
    listeners,
    removals,
    ipcRenderer: {
      async invoke(channel, ...args) {
        calls.push([channel, ...args]);
        return channel === IPC_CHANNELS.GET_STATE ? response : undefined;
      },
      on(channel, listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel, listener) {
        removals.push([channel, listener]);
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    },
  };
}

test("preload publishes one frozen API over the exact IPC channel allowlist", async () => {
  assert.deepEqual(IPC_CHANNELS, {
    GET_STATE: "omp-chatgpt-web:state:get",
    STATE_CHANGED: "omp-chatgpt-web:state:changed",
    REQUEST_LOGIN: "omp-chatgpt-web:login:request",
    SET_MODE: "omp-chatgpt-web:mode:set",
    RESTART_RUNTIME: "omp-chatgpt-web:runtime:restart",
    SET_AUTOSTART: "omp-chatgpt-web:autostart:set",
  });
  assert.equal(Object.isFrozen(IPC_CHANNELS), true);
  assert.equal(Object.isFrozen(DEFAULT_PUBLIC_STATE), true);

  const fake = fakeRenderer();
  const api = createPreloadApi(fake.ipcRenderer);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), [
    "getState",
    "requestLogin",
    "restartRuntime",
    "setAutoStart",
    "setMode",
    "subscribeState",
  ]);
  assert.equal("send" in api, false);
  assert.equal("invoke" in api, false);
  assert.equal("on" in api, false);

  await api.getState();
  await api.requestLogin();
  await api.setMode("browser-only");
  await api.restartRuntime();
  await api.setAutoStart(false);
  assert.deepEqual(fake.calls, [
    [IPC_CHANNELS.GET_STATE],
    [IPC_CHANNELS.REQUEST_LOGIN],
    [IPC_CHANNELS.SET_MODE, "browser-only"],
    [IPC_CHANNELS.RESTART_RUNTIME],
    [IPC_CHANNELS.SET_AUTOSTART, false],
  ]);
  await assert.rejects(api.setMode("custom"), /invalid_launcher_mode/);
  await assert.rejects(api.setAutoStart("true"), /invalid_autostart_value/);
});

test("public state validation reconstructs an allowlisted frozen snapshot", async () => {
  const canary = "HIGH_ENTROPY_RENDERER_SECRET_CANARY";
  const unsafe = publicState({
    endpoint: `local://${canary}`,
    cookie: canary,
    controlToken: canary,
    profilePath: canary,
    prompt: canary,
    childOutput: canary,
    failure: {
      code: "runtime",
      recoverable: true,
      message: canary,
      detail: { token: canary },
    },
  });
  const sanitized = validatePublicState(unsafe);
  assert.deepEqual(sanitized, publicState({ failure: { code: "runtime", recoverable: true } }));
  assert.equal(JSON.stringify(sanitized).includes(canary), false);
  assert.equal(Object.isFrozen(sanitized), true);
  assert.equal(Object.isFrozen(sanitized.failure), true);

  const api = createPreloadApi(fakeRenderer(unsafe).ipcRenderer);
  assert.equal(JSON.stringify(await api.getState()).includes(canary), false);
  assert.throws(() => validatePublicState(publicState({ activeTurns: 6 })), /invalid_active_turns/);
  assert.throws(() => validatePublicState(publicState({ failure: { code: canary, recoverable: false } })), /invalid_failure_code/);
  assert.throws(() => validatePublicState(publicState({ revision: -1 })), /invalid_public_revision/);
});

test("state subscriptions sanitize updates and unsubscribe the exact wrapped listener once", () => {
  const fake = fakeRenderer();
  const api = createPreloadApi(fake.ipcRenderer);
  const received = [];
  const unsubscribe = api.subscribeState(state => received.push(state));
  const wrapped = fake.listeners.get(IPC_CHANNELS.STATE_CHANGED);
  assert.equal(typeof wrapped, "function");

  wrapped({ sender: "ignored" }, publicState({ cookie: "subscription-canary" }));
  assert.equal(received.length, 1);
  assert.equal(JSON.stringify(received[0]).includes("subscription-canary"), false);
  wrapped({}, publicState({ activeTurns: 99 }));
  assert.equal(received.length, 1);

  unsubscribe();
  unsubscribe();
  assert.deepEqual(fake.removals, [[IPC_CHANNELS.STATE_CHANGED, wrapped]]);
  wrapped({}, publicState({ revision: 8 }));
  assert.equal(received.length, 1);
});

test("renderer source consumes every non-secret state field and only the typed bridge", () => {
  const types = fs.readFileSync(path.join(packageRoot, "src", "types.ts"), "utf8");
  const app = fs.readFileSync(path.join(packageRoot, "src", "App.tsx"), "utf8");
  const preload = fs.readFileSync(path.join(packageRoot, "electron", "preload.cjs"), "utf8");
  const html = fs.readFileSync(path.join(packageRoot, "index.html"), "utf8");
  const combinedRenderer = `${types}\n${app}`;

  for (const contract of [
    "LauncherPublicState",
    "LauncherPreloadApi",
    "setup",
    "login",
    "mode",
    "runtime",
    "activeTurns",
    "mcp",
    "autoStart",
    "failure",
  ]) assert.match(combinedRenderer, new RegExp(`\\b${contract}\\b`));
  for (const action of ["getState", "subscribeState", "requestLogin", "setMode", "restartRuntime", "setAutoStart"]) {
    assert.match(types, new RegExp(`\\b${action}\\b`));
    assert.match(app, new RegExp(`\\b${action}\\b`));
  }
  assert.match(types, /readonly ompChatGptWeb: LauncherPreloadApi/);
  assert.match(preload, /exposeInMainWorld\("ompChatGptWeb"/);
  assert.doesNotMatch(combinedRenderer, /@oh-my-pi\/pi-chatgpt-web|coding-agent/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("main process mirrors the preload allowlist and admits only validated public state", async () => {
  assert.deepEqual(PUBLIC_IPC_CHANNELS, IPC_CHANNELS);
  assert.deepEqual(validatePublicState(MAIN_DEFAULT_PUBLIC_STATE), MAIN_DEFAULT_PUBLIC_STATE);
  assert.throws(
    () => validateRendererState({ ...publicState(), endpoint: "http://127.0.0.1:9222" }),
    /invalid_public_state/,
  );
  const handlers = new Map();
  const removals = [];
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { removals.push(channel); handlers.delete(channel); },
  };
  const store = createRendererStateStore(publicState());
  const cleanup = registerLauncherIpc(ipcMain, store, {
    setMode(mode) { return publicState({ revision: 8, mode }); },
    setAutoStart(enabled) { return publicState({ revision: 9, autoStart: enabled }); },
    requestLogin() { return publicState({ revision: 10, login: "in-progress" }); },
    restartRuntime() { return publicState({ revision: 11, runtime: "restarting" }); },
  });
  assert.deepEqual(await handlers.get(PUBLIC_IPC_CHANNELS.GET_STATE)({}), publicState());
  await assert.rejects(
    handlers.get(PUBLIC_IPC_CHANNELS.SET_MODE)({}, "other"),
    /invalid_launcher_mode/,
  );
  assert.equal((await handlers.get(PUBLIC_IPC_CHANNELS.SET_MODE)({}, "browser-only")).mode, "browser-only");
  assert.equal((await handlers.get(PUBLIC_IPC_CHANNELS.SET_AUTOSTART)({}, false)).autoStart, false);
  cleanup();
  assert.equal(handlers.size, 0);
  assert.ok(removals.length >= Object.keys(PUBLIC_IPC_CHANNELS).length - 1);
});

test("packaged runtime integration is authority-gated and renderer health is redacted", () => {
  const providerEpochOptions = Object.freeze({ opaque: true });
  const native = Object.fromEntries([
    "installRuntimeBundleAtomic",
    "launchVerifiedProcess",
    "openRuntimeBundle",
    "prepareVerifiedRuntimeLaunch",
    "verifyRuntimeBundle",
  ].map(name => [name, () => { throw new Error(`${name}_not_called`); }]));
  assert.equal(hasPackagedRuntimeAuthority({ isPackaged: false }, native, providerEpochOptions), false);
  assert.equal(hasPackagedRuntimeAuthority({ isPackaged: true }, { ...native, prepareVerifiedRuntimeLaunch: undefined }, providerEpochOptions), false);
  assert.equal(hasPackagedRuntimeAuthority({ isPackaged: true }, native, providerEpochOptions), true);
  const failure = runtimeRendererPatch({
    status: "failed",
    errorClass: "HIGH_ENTROPY_INTERNAL_SECRET",
  }, "full", true);
  assert.deepEqual(failure.failure, { code: "runtime", recoverable: true });
  assert.equal(JSON.stringify(failure).includes("HIGH_ENTROPY_INTERNAL_SECRET"), false);
  assert.deepEqual(runtimeRendererPatch({
    status: "failed",
    errorClass: "RuntimeRestartBudgetExceeded",
  }, "full", false).failure, { code: "restart-limit", recoverable: false });
  const source = fs.readFileSync(path.join(packageRoot, "electron", "main.cjs"), "utf8");
  assert.match(source, /createRuntimeCommandFactory\(\{ native, installedRuntime \}\)/);
  assert.match(source, /await runtimeIntegration\?\.close\(\)/);
  assert.match(source, /finally \{ installedRuntime\.close\(\); \}/);
});
