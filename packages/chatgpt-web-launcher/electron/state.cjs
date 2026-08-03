"use strict";

const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 420;
const DEFAULT_STATE = Object.freeze({
  version: 1,
  language: null,
  onboardingComplete: false,
  autoStart: true,
  keepRunningOnClose: true,
  showBrowserDuringTurns: true,
  browserSmokePassed: false,
  browserSmokeVersion: null,
  sidebarOpen: true,
  sidebarWidth: 252,
  runtimeMode: "browser-only",
});
const STATE_KEYS = Object.freeze(Object.keys(DEFAULT_STATE));

function normalizeState(value) {
  const input = value && typeof value === "object" && value.version === 1 ? value : {};
  const state = { ...DEFAULT_STATE };
  if (input.language === null || input.language === "en" || input.language === "zh-CN") state.language = input.language;
  for (const key of [
    "onboardingComplete",
    "autoStart",
    "keepRunningOnClose",
    "showBrowserDuringTurns",
    "browserSmokePassed",
    "sidebarOpen",
  ]) {
    if (typeof input[key] === "boolean") state[key] = input[key];
  }
  if (typeof input.browserSmokeVersion === "string" && input.browserSmokeVersion.length <= 128) {
    state.browserSmokeVersion = input.browserSmokeVersion;
  }
  if (Number.isFinite(input.sidebarWidth)
    && input.sidebarWidth >= SIDEBAR_MIN_WIDTH
    && input.sidebarWidth <= SIDEBAR_MAX_WIDTH) state.sidebarWidth = Math.round(input.sidebarWidth);
  if (input.runtimeMode === "browser-only" || input.runtimeMode === "full") state.runtimeMode = input.runtimeMode;
  return state;
}

function readState(filePath, options = {}) {
  const fileSystem = options.fs ?? fs;
  try {
    return normalizeState(JSON.parse(fileSystem.readFileSync(filePath, "utf8")));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(filePath, state, options = {}) {
  const writer = options.writePrivateFileAtomic ?? writePrivateFileAtomic;
  writer(filePath, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
}

function validateSidebarState(value) {
  if (!value || typeof value !== "object" || typeof value.open !== "boolean") throw new Error("sidebar_state_invalid");
  if (!Number.isFinite(value.width) || value.width < SIDEBAR_MIN_WIDTH || value.width > SIDEBAR_MAX_WIDTH) {
    throw new Error("sidebar_width_out_of_range");
  }
  return Object.freeze({ sidebarOpen: value.open, sidebarWidth: Math.round(value.width) });
}

function createStateStore(filePath, options = {}) {
  let state = readState(filePath, options);
  return Object.freeze({
    read() {
      return structuredClone(state);
    },
    update(patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("state_patch_invalid");
      for (const key of Object.keys(patch)) {
        if (!STATE_KEYS.includes(key) || key === "version") throw new TypeError("state_field_not_allowed");
      }
      state = normalizeState({ ...state, ...patch, version: 1 });
      writeState(filePath, state, options);
      return structuredClone(state);
    },
  });
}

module.exports = {
  DEFAULT_STATE,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  createStateStore,
  normalizeState,
  readState,
  validateSidebarState,
  writeState,
};
