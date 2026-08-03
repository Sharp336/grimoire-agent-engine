"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_RECORDS = 300;
const LEVELS = Object.freeze(new Set(["debug", "info", "warning", "error"]));
const EVENT_FIELDS = Object.freeze({
  "launcher.diagnostic": Object.freeze({ sink: "enum", errorClass: "error" }),
  "launcher.ipc_failure": Object.freeze({ errorClass: "error" }),
  "runtime.lifecycle": Object.freeze({ mode: "mode", status: "status", generation: "count", restartCount: "count" }),
  "runtime.failure": Object.freeze({ errorClass: "error", generation: "count", restartCount: "count" }),
  "runtime.exit": Object.freeze({ exitCode: "exit", generation: "count", restartCount: "count" }),
  "runtime.install": Object.freeze({ outcome: "enum", version: "version", platform: "platform", arch: "arch" }),
  "browser.helper": Object.freeze({ outcome: "enum", errorClass: "error" }),
});

function errorClass(error) {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error";
}

function validField(type, value) {
  if (type === "count") return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  if (type === "exit") return value === null || (Number.isInteger(value) && value >= -1 && value <= 255);
  if (type === "mode") return value === null || value === "browser-only" || value === "full";
  if (type === "status") return ["stopped", "starting", "ready", "draining", "restarting", "failed"].includes(value);
  if (type === "version") return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
  if (type === "platform") return ["darwin", "linux", "win32"].includes(value);
  if (type === "arch") return ["arm64", "x64"].includes(value);
  if (type === "error") return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value);
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function sanitize(event, detail = {}) {
  const schema = EVENT_FIELDS[event];
  if (!schema || !detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new TypeError("log_event_not_allowed");
  }
  const keys = Object.keys(detail);
  if (keys.some((key) => !Object.hasOwn(schema, key))) throw new TypeError("log_field_not_allowed");
  const result = Object.create(null);
  for (const [key, value] of Object.entries(detail)) {
    if (!validField(schema[key], value)) throw new TypeError("log_field_invalid");
    result[key] = value;
  }
  return result;
}

function createLauncherEvent(level, event, detail = {}, now = () => new Date()) {
  if (!LEVELS.has(level)) throw new TypeError("log_level_not_allowed");
  return Object.freeze({
    at: now().toISOString(),
    level,
    event,
    detail: Object.freeze(sanitize(event, detail)),
  });
}

function readRecent(filePath, options = {}) {
  const fileSystem = options.fs ?? fs;
  try {
    return fileSystem.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-MAX_MEMORY_RECORDS).flatMap((line) => {
      try {
        const record = JSON.parse(line);
        if (!record || typeof record.at !== "string" || !LEVELS.has(record.level)) return [];
        return [{ ...record, detail: sanitize(record.event, record.detail) }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function createLogger({ filePath, publish, fs: fileSystem = fs, now = () => new Date() }) {
  const records = readRecent(filePath, { fs: fileSystem });
  const append = (level, event, detail = {}) => {
    const record = createLauncherEvent(level, event, detail, now);
    records.push(record);
    if (records.length > MAX_MEMORY_RECORDS) records.splice(0, records.length - MAX_MEMORY_RECORDS);
    try {
      fileSystem.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const stat = fileSystem.statSync(filePath, { throwIfNoEntry: false });
      if (stat && stat.size >= MAX_LOG_BYTES) {
        fileSystem.rmSync(`${filePath}.1`, { force: true });
        renameAtomicFile(filePath, `${filePath}.1`, { rename: fileSystem.renameSync.bind(fileSystem) });
      }
      fileSystem.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {}
    publish?.(record);
    return record;
  };
  return Object.freeze({
    debug: (event, detail) => append("debug", event, detail),
    info: (event, detail) => append("info", event, detail),
    warn: (event, detail) => append("warning", event, detail),
    error: (event, detail) => append("error", event, detail),
    recent: (limit = 150) => records.slice(-Math.max(1, Math.min(MAX_MEMORY_RECORDS, Math.floor(limit)))),
    filePath,
  });
}

function installProcessDiagnosticGuards({ logger, streams = [process.stdout, process.stderr] }) {
  const guarded = new Set();
  streams.forEach((stream, index) => {
    if (!stream || typeof stream.on !== "function" || guarded.has(stream)) return;
    guarded.add(stream);
    stream.on("error", (error) => logger?.error("launcher.diagnostic", {
      sink: index === 0 ? "stdout" : "stderr",
      errorClass: errorClass(error),
    }));
  });
}

function registerLoggedIpc(ipcMain, logger, channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { return await handler(event, ...args); }
    catch (error) {
      logger.error("launcher.ipc_failure", { errorClass: errorClass(error) });
      throw error;
    }
  });
}

module.exports = {
  EVENT_FIELDS,
  createLauncherEvent,
  createLogger,
  errorClass,
  installProcessDiagnosticGuards,
  readRecent,
  registerLoggedIpc,
  sanitize,
};
