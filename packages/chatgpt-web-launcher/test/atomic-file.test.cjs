"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WINDOWS_RENAME_RETRY_DELAYS_MS, renameAtomicFile } = require("../electron/atomic-file.cjs");

test("atomic rename retries only bounded transient Windows failures", () => {
  const waits = [];
  let attempts = 0;
  renameAtomicFile("source", "destination", {
    platform: "win32",
    rename() {
      attempts += 1;
      if (attempts < 4) { const error = new Error("locked"); error.code = ["EPERM", "EACCES", "EBUSY"][attempts - 1]; throw error; }
    },
    wait: (value) => waits.push(value),
  });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, WINDOWS_RENAME_RETRY_DELAYS_MS.slice(0, 3));
});

test("atomic rename fails closed after the retry budget and never retries structural errors", () => {
  let attempts = 0;
  assert.throws(() => renameAtomicFile("source", "destination", {
    platform: "win32",
    rename() { attempts += 1; const error = new Error("locked"); error.code = "EPERM"; throw error; },
    wait() {},
  }), /locked/);
  assert.equal(attempts, WINDOWS_RENAME_RETRY_DELAYS_MS.length + 1);
  attempts = 0;
  assert.throws(() => renameAtomicFile("source", "destination", {
    platform: "win32",
    rename() { attempts += 1; const error = new Error("missing"); error.code = "ENOENT"; throw error; },
    wait() { assert.fail("must not retry"); },
  }), /missing/);
  assert.equal(attempts, 1);
});
