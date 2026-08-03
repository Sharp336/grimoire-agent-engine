"use strict";

const DETACH_OWNED_CHILD = false;

function requireOwnedProcess(owned) {
  if (!owned
    || typeof owned.wait !== "function"
    || typeof owned.terminate !== "function"
    || typeof owned.close !== "function") {
    throw new TypeError("native_owned_process_required");
  }
  return owned;
}

async function waitForOwnedProcess(owned, timeoutMs) {
  requireOwnedProcess(owned);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new TypeError("owned_process_timeout_invalid");
  }
  return owned.wait(timeoutMs);
}

async function terminateOwnedProcessTree(owned) {
  requireOwnedProcess(owned);
  await owned.terminate();
}

function closeOwnedProcess(owned) {
  requireOwnedProcess(owned);
  owned.close();
}

module.exports = {
  DETACH_OWNED_CHILD,
  closeOwnedProcess,
  requireOwnedProcess,
  terminateOwnedProcessTree,
  waitForOwnedProcess,
};
