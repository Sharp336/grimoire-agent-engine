"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CdpInputBridge, MAX_TEXT_BYTES, keyEvents } = require("../electron/cdp-input.cjs");

function fixture() {
  const calls = [];
  let detached = 0;
  const session = {
    async send(method, params) { calls.push([method, params]); },
    async detach() { detached += 1; },
  };
  const page = { context: () => ({ newCDPSession: async (candidate) => { assert.equal(candidate, page); return session; } }) };
  return { page, calls, detached: () => detached };
}

test("CDP bridge exposes only bounded text and the closed keyboard allowlist", async () => {
  const state = fixture();
  const bridge = new CdpInputBridge(state.page);
  await bridge.insertText("hello");
  await bridge.press("Enter");
  await bridge.press("ControlOrMeta+Enter");
  assert.deepEqual(state.calls.map(([method]) => method), [
    "Input.insertText",
    "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
    "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
  ]);
  assert.deepEqual(keyEvents("Escape").map(event => event.type), ["keyDown", "keyUp"]);
  assert.throws(() => keyEvents("F12"), /unknown_keyboard_key/);
  await assert.rejects(bridge.insertText("x".repeat(MAX_TEXT_BYTES + 1)), /invalid_input_text/);
  assert.equal(state.calls.some(([method]) => method === "Runtime.evaluate"), false);
});

test("CDP session close is idempotent and rejects subsequent input", async () => {
  const state = fixture();
  const bridge = new CdpInputBridge(state.page);
  await bridge.insertText("x");
  await bridge.close();
  await bridge.close();
  assert.equal(state.detached(), 1);
  await assert.rejects(bridge.press("Enter"), /input_bridge_closed/);
});
