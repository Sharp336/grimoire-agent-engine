"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { APP_NAME, verifyConnectorWithBrowserHelper } = require("../electron/browser-helper-verifier.cjs");

function fixture(messages) {
  const events = [];
  let exited = false;
  const owned = {
    identity: Object.freeze({ opaque: true }),
    wait: async () => { exited = true; return { exitCode: 0 }; },
    terminate: async () => { events.push("terminate"); exited = true; },
    close: () => events.push("close-process"),
  };
  const channel = {
    async receive() { return messages.shift(); },
    async send(message) { events.push(message.type); if (message.type === "shutdown") exited = true; },
    async close() { events.push("close-channel"); },
  };
  const launchSpec = Object.freeze({ opaque: Symbol("launch") });
  const native = {
    async launchVerifiedProcess(value) { assert.equal(value, launchSpec); events.push("launch"); return owned; },
    async openOwnedProcessChannel(value) { assert.equal(value.process, owned); events.push("channel"); return channel; },
  };
  return { native, helper: { launchSpec, channel: Object.freeze({ opaque: true }) }, events, exited };
}

test("browser helper verification uses a verified owned process and structured protocol only", async () => {
  const id = "a".repeat(48);
  const value = fixture([{ type: "ready" }, { type: "result", id, appName: APP_NAME, ok: true }]);
  const result = await verifyConnectorWithBrowserHelper({
    native: value.native,
    helper: value.helper,
    descriptor: Object.freeze({ opaque: true }),
    nonceFactory: () => id,
  });
  assert.deepEqual(result, { ok: true, appName: APP_NAME });
  assert.deepEqual(value.events, ["launch", "channel", "verify", "shutdown", "close-channel", "close-process"]);
});

test("helper ready timeout terminates and closes only the retained owned handle", async () => {
  const value = fixture([new Promise(() => {})]);
  const timeout = (promise, _milliseconds, name) => name === "browser_helper_ready_timeout"
    ? Promise.reject(Object.assign(new Error("timeout"), { name: "ReadyTimeout" }))
    : promise;
  await assert.rejects(verifyConnectorWithBrowserHelper({
    native: value.native,
    helper: value.helper,
    descriptor: Object.freeze({ opaque: true }),
    timeout,
  }), { name: "ReadyTimeout" });
  assert.equal(value.events.includes("close-process"), true);
});

test("raw executable, args, environment, and path helper inputs are rejected", async () => {
  const value = fixture([]);
  for (const field of ["executable", "args", "env", "path"]) {
    await assert.rejects(verifyConnectorWithBrowserHelper({
      native: value.native,
      helper: { ...value.helper, [field]: "forbidden" },
      descriptor: Object.freeze({ opaque: true }),
    }), /browser_helper_capability_invalid/);
  }
});
