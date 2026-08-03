"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const {
  PUBLIC_IPC_CHANNELS,
  createProviderControlBrowserHost,
  startElectronEntrypoint,
} = require("../electron/main.cjs");

function createNative(events) {
  const identity = Object.freeze({
    pid: process.pid,
    processStartIdentity: "launcher-start",
    executableIdentity: "launcher-executable",
  });
  return {
    NativeLocalListener: {
      create() {
        events.push("listener-create");
        let rejectAccept;
        return {
          endpoint: Object.freeze({ kind: "owner-local", nonce: "private-endpoint" }),
          accept: () => new Promise((_resolve, reject) => { rejectAccept = reject; }),
          close() {
            events.push("listener-close");
            rejectAccept?.(new Error("listener_closed"));
          },
        };
      },
    },
    connectLocal() { throw new Error("not_called"); },
    launchVerifiedBrowser() { throw new Error("not_called"); },
    matchesProcessIdentity(expected, actual) {
      return expected.pid === actual.pid
        && expected.processStartIdentity === actual.processStartIdentity
        && expected.executableIdentity === actual.executableIdentity;
    },
    verifyPeerDescendant() { return false; },
    currentProcessIdentity() { return identity; },
  };
}

function createElectron() {
  const handlers = new Map();
  const appEvents = new EventEmitter();
  const app = Object.assign(appEvents, {
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    setName() {},
    setAppUserModelId() {},
    whenReady: async () => {},
    getPath(name) {
      if (name === "userData") return path.resolve("test-user-data");
      if (name === "exe") return process.execPath;
      throw new Error(`unexpected_path_${name}`);
    },
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings() {},
    quit() {},
  });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {},
        session: { webRequest: { onHeadersReceived() {} } },
        isDestroyed: () => this.destroyed,
        send() {},
      });
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() {}
    focus() {}
    async loadURL() {}
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return {
    electron: {
      app,
      BrowserWindow,
      ipcMain: {
        handle(channel, handler) { handlers.set(channel, handler); },
        removeHandler(channel) { handlers.delete(channel); },
      },
      protocol: {
        registerSchemesAsPrivileged() {},
        async handle() {},
      },
    },
    handlers,
  };
}

function createRuntime(events) {
  return Object.freeze({
    host: Object.freeze({
      async lease() { throw new Error("not_called"); },
      async close() { events.push("provider-host-close"); },
    }),
    gate: Object.freeze({
      async admit() { return Object.freeze({ admission: true }); },
      release() {},
    }),
  });
}

function createProvider({ mode, configured, authenticated, events }) {
  let currentConfig = configured
    ? Object.freeze({
        mode,
        tunnelId: mode === "full" ? `tunnel_${"a".repeat(32)}` : null,
        runtimeKeyConfigured: mode === "full",
      })
    : null;
  let loggedIn = authenticated;
  const runtime = createRuntime(events);
  let bootstrapOptions;
  return {
    get bootstrapOptions() { return bootstrapOptions; },
    createNativeLocalRuntimeBootstrap(options) {
      bootstrapOptions = options;
      events.push(["bootstrap", options.runtimeBundleRoot]);
      return {
        secureHost: Object.freeze({ available: true }),
        createLoginHost() {
          events.push("login-host-create");
          let closed = false;
          return {
            async login() { throw new Error("provider_login_api_owns_this_call"); },
            async close() {
              if (closed) return;
              closed = true;
              events.push("login-host-close");
            },
          };
        },
        async resolveRuntime() {
          events.push("resolve-runtime");
          return runtime;
        },
        async closeRuntime() { events.push("runtime-close"); },
      };
    },
    async readChatGptWebConfig() { return currentConfig; },
    async readChatGptWebLoginStatus() {
      return loggedIn ? Object.freeze({ authenticated: true }) : null;
    },
    async setupChatGptWeb(options) {
      events.push(["setup", options.mode]);
      currentConfig = Object.freeze({ mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false });
      return Object.freeze({ config: currentConfig });
    },
    async loginChatGptWeb({ loginHost }) {
      events.push("login");
      loggedIn = true;
      await loginHost.close();
      return Object.freeze({ authenticated: true, proAvailable: true, verifiedAt: new Date().toISOString() });
    },
  };
}

function startupOptions(providerModule, nativeModule, ensureEvents) {
  const installedRoot = path.resolve("installed-runtime");
  return {
    providerModule,
    nativeModule,
    argv: ["electron"],
    resourcesPath: path.resolve("packaged-resources"),
    coreHome: path.resolve("private-runtime-home"),
    async ensureRuntime() {
      ensureEvents.push("ensure-runtime");
      return Object.freeze({
        root: installedRoot,
        close() { ensureEvents.push("installed-close"); },
      });
    },
    installedRoot,
  };
}

test("default packaged entrypoint installs runtime, starts full provider lifecycle, and closes in order", async () => {
  const events = [];
  const nativeModule = createNative(events);
  const providerModule = createProvider({ mode: "full", configured: true, authenticated: true, events });
  const { electron } = createElectron();
  const options = startupOptions(providerModule, nativeModule, events);

  const shell = await startElectronEntrypoint({ electron, ...options });

  assert.deepEqual(events.slice(0, 4), [
    "ensure-runtime",
    ["bootstrap", options.installedRoot],
    "resolve-runtime",
    "listener-create",
  ]);
  assert.strictEqual(providerModule.bootstrapOptions.nativeModule, nativeModule);
  assert.equal("loadNativeModule" in providerModule.bootstrapOptions, false);
  assert.deepEqual(shell.stateStore.read(), {
    revision: 2,
    setup: "ready",
    login: "authenticated",
    mode: "full",
    runtime: "ready",
    activeTurns: 0,
    mcp: "connected",
    autoStart: false,
    failure: null,
  });
  assert.equal("endpoint" in shell.stateStore.read(), false);
  await shell.close();
  await shell.close();
  assert.deepEqual(events.slice(-3), ["listener-close", "runtime-close", "installed-close"]);
  assert.equal(events.filter(event => event === "installed-close").length, 1);
});

test("default packaged login configures an empty browser-only profile then exposes the runtime", async () => {
  const events = [];
  const nativeModule = createNative(events);
  const providerModule = createProvider({ mode: "browser-only", configured: false, authenticated: false, events });
  const { electron, handlers } = createElectron();
  const options = startupOptions(providerModule, nativeModule, events);
  const shell = await startElectronEntrypoint({ electron, ...options });

  assert.equal(shell.stateStore.read().setup, "login-required");
  assert.equal(shell.stateStore.read().runtime, "stopped");
  const state = await handlers.get(PUBLIC_IPC_CHANNELS.REQUEST_LOGIN)({});

  assert.equal(state.login, "authenticated");
  assert.equal(state.runtime, "ready");
  assert.equal(state.mode, "browser-only");
  assert.deepEqual(events.filter(Array.isArray), [
    ["bootstrap", options.installedRoot],
    ["setup", "browser-only"],
  ]);
  assert.equal(events.filter(event => event === "login-host-close").length, 1);
  assert.equal(events.filter(event => event === "resolve-runtime").length, 1);
  await shell.close();
});

test("provider control adapter owns one gate admission for each lease", async () => {
  const admission = Object.freeze({ id: "admission" });
  const releases = [];
  let leaseCloses = 0;
  const lease = Object.freeze({
    id: "lease",
    capability: Object.freeze({}),
    page: Object.freeze({}),
    async stageAttachment() { return Object.freeze({ id: "attachment" }); },
    async close() { leaseCloses++; },
  });
  const runtime = {
    host: { async lease(_request, supplied) { assert.equal(supplied, admission); return lease; } },
    gate: {
      async admit(kind) { assert.equal(kind, "turn"); return admission; },
      release(value) { releases.push(value); },
    },
  };
  const host = createProviderControlBrowserHost({ runtime, requestLogin: async () => ({ authenticated: true }) });
  const wrapped = await host.lease({ mode: "browser-only" });
  await wrapped.close();
  await wrapped.close();
  await host.close();

  assert.equal(leaseCloses, 1);
  assert.deepEqual(releases, [admission]);
});

test("provider control adapter releases a lease that finishes opening after close", async () => {
  const admission = Object.freeze({ id: "admission" });
  let finishOpen;
  let markStarted;
  const pendingLease = new Promise(resolve => { finishOpen = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  let leaseCloses = 0;
  let releases = 0;
  const lease = Object.freeze({
    id: "lease",
    capability: Object.freeze({}),
    page: Object.freeze({}),
    async stageAttachment() { throw new Error("not_called"); },
    async close() { leaseCloses++; },
  });
  const runtime = {
    host: {
      async lease() {
        markStarted();
        return pendingLease;
      },
    },
    gate: {
      async admit() { return admission; },
      release(value) {
        assert.equal(value, admission);
        releases++;
      },
    },
  };
  const host = createProviderControlBrowserHost({ runtime, requestLogin: async () => ({ authenticated: true }) });
  const opening = host.lease({ mode: "browser-only" });
  await started;
  await host.close();
  finishOpen(lease);

  await assert.rejects(opening, /browser_host_closed/);
  assert.equal(leaseCloses, 1);
  assert.equal(releases, 1);
});
