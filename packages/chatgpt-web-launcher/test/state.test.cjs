"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_STATE, createStateStore, validateSidebarState } = require("../electron/state.cjs");
const { readBrowserNavigationState } = require("../electron/browser-state.cjs");

test("launcher state persists only allowlisted non-secret settings atomically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-launcher-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.deepEqual(store.read(), DEFAULT_STATE);
    store.update({ language: "zh-CN", onboardingComplete: true, runtimeMode: "full", browserSmokePassed: true, browserSmokeVersion: "17.2.6" });
    assert.deepEqual(createStateStore(file).read(), { ...DEFAULT_STATE, language: "zh-CN", onboardingComplete: true, runtimeMode: "full", browserSmokePassed: true, browserSmokeVersion: "17.2.6" });
    assert.throws(() => store.update({ token: "secret" }), /state_field_not_allowed/);
    assert.equal(fs.readdirSync(root).some((name) => name.includes(".tmp-")), false);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("corrupt persisted fields reset independently to closed defaults", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-launcher-corrupt-state-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, language: "en", autoStart: "yes", sidebarWidth: 999, runtimeMode: "shell", endpoint: "forbidden" }));
    assert.deepEqual(createStateStore(file).read(), { ...DEFAULT_STATE, language: "en" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("sidebar state accepts only bounded native-shell dimensions", () => {
  assert.deepEqual(validateSidebarState({ open: false, width: 300.4 }), { sidebarOpen: false, sidebarWidth: 300 });
  assert.throws(() => validateSidebarState({ open: "yes", width: 300 }), /sidebar_state_invalid/);
  assert.throws(() => validateSidebarState({ open: true, width: 900 }), /sidebar_width_out_of_range/);
});

test("browser navigation state never returns URL or document title", () => {
  const contents = {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => "https://example.invalid/?secret=canary",
    getTitle: () => "prompt canary",
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
    },
  };
  assert.deepEqual(readBrowserNavigationState(contents), {
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
  assert.equal(JSON.stringify(readBrowserNavigationState(contents)).includes("canary"), false);
});
