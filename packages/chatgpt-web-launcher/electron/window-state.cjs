"use strict";

const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const DEFAULT_WINDOW_STATE = Object.freeze({
  bounds: Object.freeze({ width: 1120, height: 720 }),
  maximized: false,
  fullscreen: false,
});
const MIN_WINDOW_BOUNDS = Object.freeze({ width: 720, height: 600 });
const MAX_WINDOW_DIMENSION = 16_384;

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function overlapsDisplay(bounds, displays) {
  return displays.some((display) => {
    const area = display?.workArea;
    return area
      && bounds.x < area.x + area.width
      && bounds.x + bounds.width > area.x
      && bounds.y < area.y + area.height
      && bounds.y + bounds.height > area.y;
  });
}

function normalizeWindowState(value, displays = []) {
  const saved = value && typeof value === "object" ? value : {};
  const bounds = saved.bounds && typeof saved.bounds === "object" ? saved.bounds : {};
  const normalized = {
    bounds: {
      width: Math.round(Math.min(MAX_WINDOW_DIMENSION, Math.max(
        MIN_WINDOW_BOUNDS.width,
        finiteNumber(bounds.width, DEFAULT_WINDOW_STATE.bounds.width),
      ))),
      height: Math.round(Math.min(MAX_WINDOW_DIMENSION, Math.max(
        MIN_WINDOW_BOUNDS.height,
        finiteNumber(bounds.height, DEFAULT_WINDOW_STATE.bounds.height),
      ))),
    },
    maximized: saved.maximized === true,
    fullscreen: saved.fullscreen === true,
  };
  if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    const positioned = { ...normalized.bounds, x: Math.round(bounds.x), y: Math.round(bounds.y) };
    if (displays.length === 0 || overlapsDisplay(positioned, displays)) {
      normalized.bounds.x = positioned.x;
      normalized.bounds.y = positioned.y;
    }
  }
  return normalized;
}

function readWindowState(filePath, displays = [], options = {}) {
  const fileSystem = options.fs ?? fs;
  try {
    return normalizeWindowState(JSON.parse(fileSystem.readFileSync(filePath, "utf8")), displays);
  } catch {
    return normalizeWindowState(null, displays);
  }
}

function writeWindowState(filePath, state, options = {}) {
  const writer = options.writePrivateFileAtomic ?? writePrivateFileAtomic;
  writer(filePath, `${JSON.stringify(normalizeWindowState(state), null, 2)}\n`);
}

function captureWindowState(window) {
  return {
    bounds: window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds(),
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  };
}

function trackWindowState(window, filePath, onError, options = {}) {
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;
  let timer = null;
  const capture = () => {
    timer = null;
    if (window.isDestroyed()) return;
    try { writeWindowState(filePath, captureWindowState(window), options); }
    catch (error) { onError?.(error); }
  };
  const schedule = () => {
    if (timer !== null) cancelTimeout(timer);
    timer = scheduleTimeout(capture, 400);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    window.on(event, schedule);
  }
  window.on("close", () => {
    if (timer !== null) cancelTimeout(timer);
    capture();
  });
}

module.exports = {
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW_BOUNDS,
  captureWindowState,
  normalizeWindowState,
  readWindowState,
  trackWindowState,
  writeWindowState,
};
