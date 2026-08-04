"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AuthenticatedControlServer, PUBLIC_OPERATIONS } = require("../electron/control-server.cjs");

function identity(pid, start = `start-${pid}`, executable = `exe-${pid}`, ancestor = true) {
  return { pid, processStartIdentity: start, executableIdentity: executable, ancestor };
}
function matches(left, right) {
  return left.pid === right.pid && left.processStartIdentity === right.processStartIdentity && left.executableIdentity === right.executableIdentity;
}
function locatorFixture() {
  return {
    async click() {}, async fill() {}, async insertText() {}, async press() {}, async pressSequentially() {}, async setInputFiles() {},
    async isVisible() { return true; }, async isEnabled() { return true; }, async count() { return 1; },
    nth() { return this; }, last() { return this; }, async allInnerTexts() { return ["text"]; }, async textContent() { return "text"; }, filter() { return this; },
  };
}
function serverFixture({ login = null, closeHost = null } = {}) {
  let nextLease = 0;
  const closed = [];
  const listener = { endpoint: { kind: "owner-local", opaque: true }, async accept() { return new Promise(() => {}); }, async close() {} };
  const native = {
    matchesProcessIdentity: matches,
    verifyPeerDescendant: peer => peer.ancestor === true,
  };
  const browserHost = {
    async login(request) {
      if (login) return login(request);
      return { authenticated: true, verifiedAt: "2026-08-02T00:00:00.000Z", proAvailable: true, profileIdentity: "profile", executable: { identity: "exe", sha256: "a".repeat(64), version: "1" } };
    },
    async lease() {
      const id = `lease-${++nextLease}`;
      const locator = locatorFixture();
      let isClosed = false;
      return {
        id,
        page: {
          locator: () => locator, getByRole: () => locator, async goto() {},
          async readComposerSnapshot() { return { ready: true, text: "", canSubmit: true }; },
          async readResponseSnapshot() { return { userText: "", assistantText: "", reasoningText: "", generationId: null, settled: true }; },
          async readHealthSnapshot() { return { temporaryChat: true, ready: true, errorClass: null }; },
          async state() { return isClosed ? "closed" : "temporary-chat"; }, async close() { isClosed = true; },
        },
        async stageAttachment({ name, bytes }) { return { id: `${id}-attachment`, name, size: bytes.length, sha256: "b".repeat(64) }; },
        async close() { if (!isClosed) { isClosed = true; closed.push(id); } },
      };
    },
    async close() { if (closeHost) await closeHost(); },
  };
  const ownerIdentity = identity(10);
  const launcherIdentity = identity(20);
  const authority = { ownerId: "owner-1", runtimeEpoch: "epoch-1", lifecycleGeneration: 1, launcherPid: 20, controlToken: "control-secret" };
  const server = new AuthenticatedControlServer({ listener, native, browserHost, authority, ownerIdentity, launcherIdentity, launcherNonce: "launcher-nonce" });
  return { server, closed, authority, ownerIdentity, launcherIdentity };
}
function connection(peer) {
  return { peer, current: peer, currentPeer() { return this.current; }, async *read() {}, async write() {}, async close() {} };
}

function pendingConnection(peer, messages = [], readCloseError = null) {
  let releaseRead;
  let markReadStarted;
  let closeCount = 0;
  const writes = [];
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  const conn = {
    peer,
    current: peer,
    currentPeer() { return this.current; },
    async *read() {
      markReadStarted();
      for (const message of messages) yield Buffer.from(`${JSON.stringify(message)}\n`);
      await new Promise((resolve, reject) => {
        releaseRead = () => readCloseError ? reject(readCloseError) : resolve();
      });
    },
    async write(bytes) { writes.push(Buffer.from(bytes)); },
    async close() {
      closeCount += 1;
      releaseRead?.();
    },
  };
  return { conn, readStarted, writes, closeCount: () => closeCount };
}
function state() { return { connectionNonce: null, sequence: 0, requestNonces: new Set() }; }
function envelope(session, peer, overrides = {}) {
  return {
    version: 1,
    ownerId: "owner-1",
    runtimeEpoch: "epoch-1",
    lifecycleGeneration: 1,
    launcherNonce: "launcher-nonce",
    controlToken: "control-secret",
    clientPid: peer.pid,
    connectionNonce: "connection-nonce",
    requestNonce: `request-${session.sequence + 1}`,
    sequence: session.sequence + 1,
    operation: "page.state",
    leaseId: "missing",
    leaseCapability: "missing",
    arguments: {},
    ...overrides,
  };
}
async function rejection(server, conn, peer, session, overrides, code) {
  await assert.rejects(server.handleRequest(conn, peer, session, envelope(session, peer, overrides)), error => error.code === code);
}
async function openLease(server, conn, peer, session, suffix) {
  return server.handleRequest(conn, peer, session, envelope(session, peer, {
    requestNonce: `open-${suffix}`,
    operation: "lease.open",
    leaseId: undefined,
    leaseCapability: undefined,
    arguments: { sessionId: `session-${suffix}`, turnId: `turn-${suffix}`, modelKey: "gpt-5", mode: "browser-only", headed: true },
  }));
}

test("every request validates token, owner, epoch, PID, nonce, sequence, and complete live peer identity", async () => {
  const { server } = serverFixture();
  const peer = identity(30);
  const conn = connection(peer);
  const session = state();
  await rejection(server, conn, peer, session, { controlToken: "forged" }, "unauthorized");
  await rejection(server, conn, peer, session, { ownerId: "other" }, "wrong_owner");
  await rejection(server, conn, peer, session, { runtimeEpoch: "old" }, "stale_runtime_epoch");
  await rejection(server, conn, peer, session, { lifecycleGeneration: 2 }, "stale_lifecycle_generation");
  await rejection(server, conn, peer, session, { launcherNonce: "old" }, "stale_launcher_nonce");
  await rejection(server, conn, peer, session, { clientPid: 31 }, "wrong_client_pid");
  const lease = await openLease(server, conn, peer, session, "one");
  await rejection(server, conn, peer, session, { sequence: session.sequence, requestNonce: "replay-seq" }, "replayed_sequence");
  await rejection(server, conn, peer, session, { sequence: session.sequence + 2, requestNonce: "reordered" }, "out_of_order_sequence");
  await rejection(server, conn, peer, session, { requestNonce: "open-one", operation: "page.state", leaseId: lease.leaseId, leaseCapability: lease.leaseCapability }, "replayed_request_nonce");
  await rejection(server, conn, peer, session, { connectionNonce: "changed", operation: "page.state", leaseId: lease.leaseId, leaseCapability: lease.leaseCapability }, "wrong_connection_nonce");
  conn.current = identity(peer.pid, "pid-reused", peer.executableIdentity);
  await rejection(server, conn, peer, session, { operation: "page.state", leaseId: lease.leaseId, leaseCapability: lease.leaseCapability }, "peer_identity_changed");
  conn.current = identity(peer.pid, peer.processStartIdentity, "replaced-executable");
  await rejection(server, conn, peer, session, { operation: "page.state", leaseId: lease.leaseId, leaseCapability: lease.leaseCapability }, "peer_identity_changed");
  await server.close();
});

test("same-user stolen token and non-descendant peers are rejected before dispatch", async () => {
  const { server } = serverFixture();
  const peer = identity(40, "start-40", "competitor", false);
  const conn = connection(peer);
  await rejection(server, conn, peer, state(), { operation: "lease.open", arguments: { sessionId: "s", turnId: "t", modelKey: "m", mode: "browser-only", headed: true } }, "unauthorized_peer");
  await server.close();
});

test("five leases are shared across clients; sixth rejects; close is idempotent and cancellation isolated", async () => {
  const { server, closed } = serverFixture();
  const peerA = identity(50);
  const peerB = identity(51);
  const connA = connection(peerA);
  const connB = connection(peerB);
  const stateA = state();
  const stateB = state();
  const leases = [];
  for (let index = 0; index < 3; index += 1) leases.push(await openLease(server, connA, peerA, stateA, `a-${index}`));
  for (let index = 0; index < 2; index += 1) leases.push(await openLease(server, connB, peerB, stateB, `b-${index}`));
  await rejection(server, connA, peerA, stateA, { operation: "lease.open", arguments: { sessionId: "six", turnId: "six", modelKey: "m", mode: "full", headed: false }, leaseId: undefined, leaseCapability: undefined }, "browser_lease_limit");
  const target = leases[1];
  await server.handleRequest(connA, peerA, stateA, envelope(stateA, peerA, { operation: "lease.cancel", leaseId: target.leaseId, leaseCapability: target.leaseCapability }));
  assert.deepEqual(closed, [target.leaseId]);
  const stillOpen = leases[3];
  assert.equal(await server.handleRequest(connB, peerB, stateB, envelope(stateB, peerB, { operation: "page.state", leaseId: stillOpen.leaseId, leaseCapability: stillOpen.leaseCapability })), "temporary-chat");
  const closedAgain = await server.handleRequest(connA, peerA, stateA, envelope(stateA, peerA, { operation: "lease.close", leaseId: target.leaseId, leaseCapability: target.leaseCapability }));
  assert.deepEqual(closedAgain, { closed: true });
  await server.close();
});

test("closed, cross-lease, malformed, and dangerous operations fail closed", async () => {
  const { server } = serverFixture();
  const peer = identity(60);
  const conn = connection(peer);
  const session = state();
  const first = await openLease(server, conn, peer, session, "first");
  const second = await openLease(server, conn, peer, session, "second");
  await rejection(server, conn, peer, session, { operation: "page.state", leaseId: first.leaseId, leaseCapability: second.leaseCapability }, "wrong_lease_capability");
  for (const operation of ["evaluate", "cookies", "storageState", "attach", "endpoint", "connectOverCDP"]) {
    await rejection(server, conn, peer, session, { operation }, "unknown_operation");
  }
  await server.handleRequest(conn, peer, session, envelope(session, peer, { operation: "lease.close", leaseId: first.leaseId, leaseCapability: first.leaseCapability }));
  await rejection(server, conn, peer, session, { operation: "page.state", leaseId: first.leaseId, leaseCapability: first.leaseCapability }, "closed_lease");
  await rejection(server, conn, peer, session, { extra: true }, "malformed_request");
  assert.deepEqual(["evaluate", "cookies", "storageState", "attach", "endpoint", "connectOverCDP", "websocket"].filter(name => PUBLIC_OPERATIONS.has(name)), []);
  await server.close();
});

test("descriptor and protocol results never disclose lifecycle control secrets or transport addresses", async () => {
  const { server } = serverFixture();
  const descriptor = server.descriptor();
  assert.equal(JSON.stringify(descriptor).includes("control-secret"), false);
  assert.equal("token" in descriptor, false);
  assert.equal("url" in descriptor, false);
  assert.equal("websocket" in descriptor, false);
  assert.equal(descriptor.endpoint.kind, "owner-local");
  assert.deepEqual(server.publicState(), { status: "ready", activeLeases: 0 });
  assert.equal(JSON.stringify(server.publicState()).includes("control-secret"), false);
  await server.close();
});


test("close shuts down pending connections, drains their tasks, and rejects post-close dispatch", { timeout: 1_000 }, async () => {
  const { server } = serverFixture();
  const peer = identity(70);
  const pending = pendingConnection(peer, [], new Error("read_closed"));
  let taskFinished = false;
  const task = server.serveConnection(pending.conn);
  void task.then(() => { taskFinished = true; }, () => { taskFinished = true; });
  await pending.readStarted;

  await server.close();

  assert.equal(pending.closeCount(), 1);
  assert.equal(taskFinished, true);
  await rejection(server, pending.conn, peer, state(), { operation: "host.login" }, "connection_closed");
  await server.close();
  assert.equal(pending.closeCount(), 1);
});

test("host.close shuts down its own pending connection without awaiting itself", { timeout: 1_000 }, async () => {
  const { server } = serverFixture();
  const peer = identity(71);
  const session = state();
  const pending = pendingConnection(peer, [envelope(session, peer, {
    operation: "host.close",
    leaseId: undefined,
    leaseCapability: undefined,
  })]);

  await server.serveConnection(pending.conn);

  assert.equal(pending.closeCount(), 1);
  assert.deepEqual(pending.writes.map(bytes => JSON.parse(bytes.toString("utf8"))), [{
    version: 1,
    sequence: 1,
    ok: true,
    result: { closed: true },
  }]);
  assert.deepEqual(server.publicState(), { status: "stopped", activeLeases: 0 });
  await server.close();
  assert.equal(pending.closeCount(), 1);
});

test("close releases an in-flight request by closing its host before draining the connection", { timeout: 1_000 }, async () => {
  let markOperationStarted;
  let releaseOperation;
  let hostCloseCount = 0;
  const operationStarted = new Promise(resolve => { markOperationStarted = resolve; });
  const { server } = serverFixture({
    async login() {
      markOperationStarted();
      return new Promise(resolve => {
        releaseOperation = () => resolve({ authenticated: true });
      });
    },
    async closeHost() {
      hostCloseCount += 1;
      releaseOperation();
    },
  });
  const peer = identity(72);
  const session = state();
  const pending = pendingConnection(peer, [envelope(session, peer, {
    operation: "host.login",
    leaseId: undefined,
    leaseCapability: undefined,
    arguments: { profileGeneration: "profile-1", ownerFence: "owner-fence-1" },
  })]);
  const connectionTask = server.serveConnection(pending.conn);
  await operationStarted;

  await server.close();
  await connectionTask;

  assert.equal(hostCloseCount, 1);
  assert.equal(pending.closeCount(), 1);
  assert.deepEqual(pending.writes, []);
  assert.deepEqual(server.publicState(), { status: "stopped", activeLeases: 0 });
  await server.close();
  assert.equal(hostCloseCount, 1);
});