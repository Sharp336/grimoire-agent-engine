"use strict";

const IPC_CHANNELS = Object.freeze({
  GET_STATE: "omp-chatgpt-web:state:get",
  STATE_CHANGED: "omp-chatgpt-web:state:changed",
  REQUEST_LOGIN: "omp-chatgpt-web:login:request",
  SET_MODE: "omp-chatgpt-web:mode:set",
  RESTART_RUNTIME: "omp-chatgpt-web:runtime:restart",
  SET_AUTOSTART: "omp-chatgpt-web:autostart:set",
});

const SETUP_STATES = new Set(["checking", "ready", "login-required", "failed"]);
const LOGIN_STATES = new Set(["unknown", "required", "in-progress", "authenticated", "failed"]);
const MODES = new Set(["browser-only", "full"]);
const RUNTIME_STATES = new Set(["stopped", "starting", "ready", "degraded", "restarting", "failed"]);
const MCP_STATES = new Set(["disabled", "waiting", "connected", "failed"]);
const FAILURE_CODES = new Set([
  "configuration",
  "authentication",
  "browser",
  "runtime",
  "mcp",
  "restart-limit",
  "internal",
]);
const MAX_ACTIVE_TURNS = 5;

const DEFAULT_PUBLIC_STATE = Object.freeze({
  revision: 0,
  setup: "checking",
  login: "unknown",
  mode: "browser-only",
  runtime: "stopped",
  activeTurns: 0,
  mcp: "disabled",
  autoStart: false,
  failure: null,
});

function assertRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(code);
}

function assertMember(value, allowed, code) {
  if (typeof value !== "string" || !allowed.has(value)) throw new TypeError(code);
  return value;
}

function validatePublicState(value) {
  assertRecord(value, "invalid_public_state");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new TypeError("invalid_public_revision");
  if (!Number.isInteger(value.activeTurns) || value.activeTurns < 0 || value.activeTurns > MAX_ACTIVE_TURNS) {
    throw new TypeError("invalid_active_turns");
  }
  if (typeof value.autoStart !== "boolean") throw new TypeError("invalid_autostart_state");

  let failure = null;
  if (value.failure !== null) {
    assertRecord(value.failure, "invalid_public_failure");
    failure = Object.freeze({
      code: assertMember(value.failure.code, FAILURE_CODES, "invalid_failure_code"),
      recoverable: value.failure.recoverable === true,
    });
    if (typeof value.failure.recoverable !== "boolean") throw new TypeError("invalid_failure_recovery");
  }

  return Object.freeze({
    revision: value.revision,
    setup: assertMember(value.setup, SETUP_STATES, "invalid_setup_state"),
    login: assertMember(value.login, LOGIN_STATES, "invalid_login_state"),
    mode: assertMember(value.mode, MODES, "invalid_launcher_mode"),
    runtime: assertMember(value.runtime, RUNTIME_STATES, "invalid_runtime_state"),
    activeTurns: value.activeTurns,
    mcp: assertMember(value.mcp, MCP_STATES, "invalid_mcp_state"),
    autoStart: value.autoStart,
    failure,
  });
}

function createPreloadApi(ipcRenderer) {
  if (!ipcRenderer
    || typeof ipcRenderer.invoke !== "function"
    || typeof ipcRenderer.on !== "function"
    || typeof ipcRenderer.removeListener !== "function") {
    throw new TypeError("invalid_ipc_renderer");
  }

  return Object.freeze({
    async getState() {
      return validatePublicState(await ipcRenderer.invoke(IPC_CHANNELS.GET_STATE));
    },
    subscribeState(listener) {
      if (typeof listener !== "function") throw new TypeError("invalid_state_listener");
      let subscribed = true;
      const wrapped = (_event, candidate) => {
        if (!subscribed) return;
        let state;
        try {
          state = validatePublicState(candidate);
        } catch (error) {
          if (error instanceof TypeError) return;
          throw error;
        }
        listener(state);
      };
      ipcRenderer.on(IPC_CHANNELS.STATE_CHANGED, wrapped);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(IPC_CHANNELS.STATE_CHANGED, wrapped);
      };
    },
    async requestLogin() {
      await ipcRenderer.invoke(IPC_CHANNELS.REQUEST_LOGIN);
    },
    async setMode(mode) {
      assertMember(mode, MODES, "invalid_launcher_mode");
      await ipcRenderer.invoke(IPC_CHANNELS.SET_MODE, mode);
    },
    async restartRuntime() {
      await ipcRenderer.invoke(IPC_CHANNELS.RESTART_RUNTIME);
    },
    async setAutoStart(enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("invalid_autostart_value");
      await ipcRenderer.invoke(IPC_CHANNELS.SET_AUTOSTART, enabled);
    },
  });
}

function exposePreloadApi(contextBridge, ipcRenderer) {
  if (!contextBridge || typeof contextBridge.exposeInMainWorld !== "function") {
    throw new TypeError("invalid_context_bridge");
  }
  const api = createPreloadApi(ipcRenderer);
  contextBridge.exposeInMainWorld("ompChatGptWeb", api);
  return api;
}

if (process.versions.electron) {
  const { contextBridge, ipcRenderer } = require("electron");
  exposePreloadApi(contextBridge, ipcRenderer);
}

module.exports = Object.freeze({
  DEFAULT_PUBLIC_STATE,
  IPC_CHANNELS,
  createPreloadApi,
  exposePreloadApi,
  validatePublicState,
});
