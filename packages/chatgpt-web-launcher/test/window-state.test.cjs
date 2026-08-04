"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeWindowState, readWindowState, writeWindowState } = require("../electron/window-state.cjs");

const displays = [{ workArea: { x: 0, y: 0, width: 1512, height: 982 } }];

test("window state preserves visible bounds and closed desktop modes", () => {
  assert.deepEqual(normalizeWindowState({ bounds: { x: 120, y: 80, width: 1280, height: 800 }, maximized: true, fullscreen: false }, displays), {
    bounds: { x: 120, y: 80, width: 1280, height: 800 }, maximized: true, fullscreen: false,
  });
});

test("off-screen and corrupt dimensions are repaired", () => {
  assert.deepEqual(normalizeWindowState({ bounds: { x: 9000, y: 9000, width: 200, height: 100 } }, displays), {
    bounds: { width: 720, height: 600 }, maximized: false, fullscreen: false,
  });
  assert.deepEqual(normalizeWindowState({ bounds: { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER } }, displays).bounds, {
    width: 16_384, height: 16_384,
  });
});

test("window state is atomically owner-private", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-window-state-"));
  const file = path.join(root, "window.json");
  const state = { bounds: { x: 20, y: 30, width: 1120, height: 720 }, maximized: false, fullscreen: false };
  try {
    writeWindowState(file, state);
    assert.deepEqual(readWindowState(file, displays), state);
    assert.equal(fs.readdirSync(root).some((name) => name.includes(".tmp-")), false);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
