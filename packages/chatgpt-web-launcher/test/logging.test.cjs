"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { createLauncherEvent, createLogger, installProcessDiagnosticGuards, sanitize } = require("../electron/logging.cjs");

test("logger constructs records only from allowlisted event fields", () => {
  const record = createLauncherEvent("info", "runtime.lifecycle", {
    mode: "full", status: "ready", generation: 2, restartCount: 0,
  }, () => new Date("2026-08-02T00:00:00.000Z"));
  assert.deepEqual(JSON.parse(JSON.stringify(record)), {
    at: "2026-08-02T00:00:00.000Z", level: "info", event: "runtime.lifecycle",
    detail: { mode: "full", status: "ready", generation: 2, restartCount: 0 },
  });
  assert.throws(() => sanitize("runtime.lifecycle", { message: "raw child line" }), /log_field_not_allowed/);
  assert.throws(() => sanitize("unknown.event", {}), /log_event_not_allowed/);
  assert.throws(() => sanitize("runtime.failure", { errorClass: "prompt: secret", generation: 1, restartCount: 0 }), /log_field_invalid/);
});

test("persisted logger ignores malformed and unregistered records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-launcher-log-"));
  const filePath = path.join(root, "activity.jsonl");
  try {
    fs.writeFileSync(filePath, [
      JSON.stringify({ at: "2026-08-02T00:00:00.000Z", level: "info", event: "runtime.lifecycle", detail: { mode: "full", status: "ready", generation: 1, restartCount: 0 } }),
      JSON.stringify({ at: "2026-08-02T00:00:00.000Z", level: "info", event: "child.output", detail: { text: "secret" } }),
    ].join("\n"));
    assert.deepEqual(createLogger({ filePath }).recent().map((value) => value.event), ["runtime.lifecycle"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("process stream errors become an error class and never arbitrary diagnostic text", () => {
  const stream = new PassThrough();
  const records = [];
  installProcessDiagnosticGuards({ logger: { error: (event, detail) => records.push({ event, detail }) }, streams: [stream] });
  stream.emit("error", Object.assign(new Error("sensitive endpoint and token"), { name: "PipeClosedError" }));
  assert.deepEqual(records, [{ event: "launcher.diagnostic", detail: { sink: "stdout", errorClass: "PipeClosedError" } }]);
  assert.doesNotMatch(JSON.stringify(records), /sensitive|endpoint|token/);
  stream.destroy();
});
