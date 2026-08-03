"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");

let compiledRuntime;
function loadRuntimeModule(nativeModule) {
  if (compiledRuntime) return compiledRuntime;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-launcher-host-"));
  const hostSource = path.resolve(__dirname, "../../chatgpt-web/src/runtime/host.ts");
  const launcherSource = path.resolve(__dirname, "../../chatgpt-web/src/runtime/launcher-host.ts");
  const tsgo = path.resolve(__dirname, "../../../node_modules/@typescript/native-preview/bin/tsgo");
  const compiled = spawnSync(process.execPath, [
    tsgo,
    "--ignoreConfig",
    "--module", "commonjs",
    "--target", "es2022",
    "--noCheck",
    "--outDir", directory,
    hostSource,
    launcherSource,
  ], { encoding: "utf8" });
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "@oh-my-pi/pi-natives") return nativeModule;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    compiledRuntime = require(path.join(directory, "runtime", "launcher-host.js"));
    return compiledRuntime;
  } finally {
    Module._load = originalLoad;
  }
}

function queue() {
  const values = [];
  const readers = [];
  return {
    push(value) { const reader = readers.shift(); if (reader) reader(value); else values.push(value); },
    read() { if (values.length) return Promise.resolve(values.shift()); return new Promise(resolve => readers.push(resolve)); },
  };
}

function identity(pid, start = `start-${pid}`, executable = `exe-${pid}`) {
  return { pid, processStartIdentity: start, executableIdentity: executable };
}
function sameIdentity(left, right) {
  return left.pid === right.pid && left.processStartIdentity === right.processStartIdentity && left.executableIdentity === right.executableIdentity;
}

function runtimeFixture() {
  const responses = queue();
  const requests = [];
  const peer = identity(700);
  let currentPeer = peer;
  let nextLease = 0;
  let closed = false;
  const connection = {
    peer,
    currentPeer: () => currentPeer,
    read: () => responses.read(),
    async write(bytes) {
      const request = JSON.parse(Buffer.from(bytes).toString("utf8"));
      requests.push(request);
      let result = null;
      if (request.operation === "lease.open") result = { leaseId: `lease-${++nextLease}`, leaseCapability: `capability-${nextLease}` };
      else if (request.operation === "page.state") result = "temporary-chat";
      else if (request.operation === "page.read-health") result = { temporaryChat: true, ready: true, errorClass: null };
      else if (request.operation === "locator.count") result = 1;
      else if (request.operation === "host.login") result = { authenticated: true, verifiedAt: "2026-08-02T00:00:00.000Z", proAvailable: true, profileIdentity: "profile", executable: { identity: "exe", sha256: "a".repeat(64), version: "1" } };
      responses.push(Buffer.from(`${JSON.stringify({ version: 1, sequence: request.sequence, ok: true, result })}\n`));
    },
    async close() { if (!closed) { closed = true; responses.push(new Uint8Array()); } },
  };
  const nativeModule = {
    connectLocal: () => connection,
    matchesProcessIdentity: sameIdentity,
  };
  const runtime = loadRuntimeModule(nativeModule);
  const authority = { ownerId: "owner", runtimeEpoch: "epoch", lifecycleGeneration: 1, launcherPid: 700, launcherNonce: "launcher-nonce", controlToken: "control-token" };
  const descriptor = { version: 1, ownerId: "owner", runtimeEpoch: "epoch", lifecycleGeneration: 1, launcherPid: 700, launcherNonce: "launcher-nonce", launcherIdentity: peer, endpoint: { kind: "owner-local" } };
  const native = runtime.createLauncherNativeClient(nativeModule);
  const host = new runtime.LauncherBrowserHost({ native, authority, refreshDescriptor: async () => descriptor, clientPid: 800 });
  const admission = { runtimeEpoch: "epoch", lifecycleGeneration: 1 };
  return { runtime, host, authority, descriptor, admission, requests, setPeer(value) { currentPeer = value; } };
}

const leaseRequest = (turn, signal) => ({ sessionId: "session", turnId: turn, modelKey: "gpt-5", mode: "browser-only", headed: true, signal });

test("runtime adapter validates descriptor owner, epoch, PID, nonce, endpoint, and complete server identity", async () => {
  const state = runtimeFixture();
  const variants = [
    [{ ...state.descriptor, ownerId: "other" }, "wrong_launcher_owner"],
    [{ ...state.descriptor, runtimeEpoch: "old" }, "stale_launcher_epoch"],
    [{ ...state.descriptor, lifecycleGeneration: 2 }, "stale_lifecycle_generation"],
    [{ ...state.descriptor, launcherPid: 701 }, "wrong_launcher_pid"],
    [{ ...state.descriptor, launcherNonce: "old" }, "stale_launcher_nonce"],
    [{ ...state.descriptor, endpoint: { kind: "tcp", url: "http://127.0.0.1:9222" } }, "invalid_launcher_endpoint"],
    [{ ...state.descriptor, websocket: "ws://127.0.0.1" }, "invalid_launcher_descriptor"],
  ];
  for (const [descriptor, code] of variants) {
    const host = new state.runtime.LauncherBrowserHost({ native: state.runtime.createLauncherNativeClient({ connectLocal() { throw new Error("must_not_connect"); }, matchesProcessIdentity: sameIdentity }), authority: state.authority, refreshDescriptor: async () => descriptor, clientPid: 800 });
    await assert.rejects(host.lease(leaseRequest(code), state.admission), error => error.message === code);
  }
  const wrongPeerModule = { connectLocal: () => ({ peer: identity(999), currentPeer: () => identity(999), read: async () => new Uint8Array(), async write() {}, async close() {} }), matchesProcessIdentity: sameIdentity };
  const wrongPeerHost = new state.runtime.LauncherBrowserHost({ native: state.runtime.createLauncherNativeClient(wrongPeerModule), authority: state.authority, refreshDescriptor: async () => state.descriptor, clientPid: 800 });
  await assert.rejects(wrongPeerHost.lease(leaseRequest("wrong-peer"), state.admission), error => error.message === "wrong_launcher_peer");
});

test("runtime requests carry token, per-connection nonce, unique request nonce, strict sequence, and no transport/path fields", async () => {
  const state = runtimeFixture();
  const lease = await state.host.lease(leaseRequest("one"), state.admission);
  assert.equal(await lease.page.state(), "temporary-chat");
  assert.equal(await lease.page.locator("composer").count(), 1);
  await lease.close();
  assert.deepEqual(state.requests.map(request => request.sequence), [1, 2, 3, 4]);
  assert.equal(new Set(state.requests.map(request => request.connectionNonce)).size, 1);
  assert.equal(new Set(state.requests.map(request => request.requestNonce)).size, 4);
  assert.equal(state.requests.every(request => request.controlToken === "control-token"), true);
  const encoded = JSON.stringify(state.requests);
  for (const forbidden of ["endpointURL", "websocket", "storageState", "cookies", "evaluate", "executableOverride"]) assert.equal(encoded.includes(forbidden), false);
  await state.host.close();
});

test("abort cancels only its lease and live peer identity is revalidated for each request", async () => {
  const state = runtimeFixture();
  const controller = new AbortController();
  const first = await state.host.lease(leaseRequest("first", controller.signal), state.admission);
  const second = await state.host.lease(leaseRequest("second"), state.admission);
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await second.page.state(), "temporary-chat");
  assert.equal(state.requests.some(request => request.operation === "lease.cancel" && request.leaseId === first.id), true);
  assert.equal(state.requests.some(request => request.operation === "lease.cancel" && request.leaseId === second.id), false);
  state.setPeer(identity(700, "reused-pid", "exe-700"));
  await assert.rejects(second.page.readHealthSnapshot(), error => error.message === "launcher_peer_identity_changed");
  state.setPeer(identity(700));
  await second.close();
});

test("stale admissions reject before connection and login never sends opaque paths or executable overrides", async () => {
  const state = runtimeFixture();
  await assert.rejects(state.host.lease(leaseRequest("stale"), { runtimeEpoch: "old", lifecycleGeneration: 1 }), error => error.message === "stale_launcher_epoch");
  const result = await state.host.login({ profile: { identity: "private-path", kind: "directory" }, config: { secret: "not-for-rpc" }, profileGeneration: "generation", ownerFence: "fence", headed: true, executableOverride: "C:\\Chrome\\chrome.exe" });
  assert.equal(result.authenticated, true);
  const login = state.requests.find(request => request.operation === "host.login");
  assert.deepEqual(login.arguments, { profileGeneration: "generation", ownerFence: "fence" });
  assert.equal(JSON.stringify(login).includes("private-path"), false);
  assert.equal(JSON.stringify(login).includes("Chrome"), false);
  await state.host.close();
});
