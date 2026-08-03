"use strict";

const { randomBytes } = require("node:crypto");
const { requireOwnedProcess } = require("./process-tree.cjs");

const VERIFY_TIMEOUT_MS = 60_000;
const APP_NAME = "OMP ChatGPT Web";

function withTimeout(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function stopOwnedHelper(owned, channel, timeout = withTimeout) {
  try { await channel.send(Object.freeze({ type: "shutdown" })); } catch {}
  try {
    await timeout(owned.wait(), 5_000, "browser_helper_shutdown_timeout");
  } catch {
    await owned.terminate();
    await timeout(owned.wait(), 2_000, "browser_helper_termination_timeout");
  }
}

async function verifyConnectorWithBrowserHelper({
  native,
  helper,
  descriptor,
  appName = APP_NAME,
  timeoutMs = VERIFY_TIMEOUT_MS,
  nonceFactory = () => randomBytes(24).toString("hex"),
  timeout = withTimeout,
}) {
  if (appName !== APP_NAME || !descriptor || typeof descriptor !== "object") {
    throw new TypeError("browser_helper_config_invalid");
  }
  if (!helper || typeof helper !== "object" || !helper.launchSpec || !helper.channel
    || ["executable", "script", "path", "args", "env"].some((key) => Object.hasOwn(helper, key))) {
    throw new TypeError("browser_helper_capability_invalid");
  }
  if (!native || typeof native.launchVerifiedProcess !== "function"
    || typeof native.openOwnedProcessChannel !== "function") {
    throw new Error("native_browser_helper_authority_unavailable");
  }
  const owned = requireOwnedProcess(await native.launchVerifiedProcess(helper.launchSpec));
  let channel;
  try {
    channel = await native.openOwnedProcessChannel({ process: owned, channel: helper.channel });
    if (!channel || typeof channel.send !== "function" || typeof channel.receive !== "function"
      || typeof channel.close !== "function") throw new Error("browser_helper_channel_invalid");
    const ready = await timeout(channel.receive(), timeoutMs, "browser_helper_ready_timeout");
    if (!ready || typeof ready !== "object" || ready.type !== "ready" || Object.keys(ready).length !== 1) {
      throw new Error("browser_helper_ready_invalid");
    }
    const id = nonceFactory();
    if (typeof id !== "string" || !/^[0-9a-f]{32,128}$/.test(id)) throw new Error("browser_helper_nonce_invalid");
    await channel.send(Object.freeze({ type: "verify", id, appName, descriptor }));
    const response = await timeout(channel.receive(), timeoutMs, "browser_helper_result_timeout");
    if (!response || typeof response !== "object"
      || response.type !== "result"
      || response.id !== id
      || response.appName !== APP_NAME
      || response.ok !== true
      || Object.keys(response).sort().join("\0") !== ["appName", "id", "ok", "type"].sort().join("\0")) {
      throw new Error("browser_helper_result_invalid");
    }
    return Object.freeze({ ok: true, appName: APP_NAME });
  } finally {
    if (channel) {
      try { await stopOwnedHelper(owned, channel, timeout); }
      finally { await channel.close(); }
    } else {
      try { await owned.terminate(); } catch {}
    }
    owned.close();
  }
}

module.exports = {
  APP_NAME,
  VERIFY_TIMEOUT_MS,
  stopOwnedHelper,
  verifyConnectorWithBrowserHelper,
  withTimeout,
};
