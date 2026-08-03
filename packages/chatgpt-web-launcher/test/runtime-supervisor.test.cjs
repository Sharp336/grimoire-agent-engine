"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  PROVIDER_RUNTIME_BUNDLE,
  PROVIDER_RUNTIME_ENTRYPOINT,
  RuntimeSupervisor,
  createProviderRuntimeEpochFactory,
  loadBundledProviderRuntime,
} = require("../electron/runtime-supervisor.cjs");
const { resolveRuntimeCommand } = require("../electron/runtime-command.cjs");
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function waitFor(supervisor, predicate) { return new Promise((resolve) => { let off = () => {}; off = supervisor.subscribe((state) => { if (predicate(state)) { off(); resolve(state); } }); }); }
function fixture(options = {}) {
  const events = [], children = []; let epochNumber = 0, spawnNumber = 0;
  const epochFactory = { async create() {
    epochNumber += 1; const number = epochNumber; const runtimeEpoch = `epoch-${number}-${"e".repeat(16)}`;
    const broker = {
      async listen() { events.push(`epoch-${number}:listen`); },
      async prepareTunnelSpawn() { spawnNumber += 1; const current = spawnNumber; const instanceNonce = `nonce-${current}-${"n".repeat(16)}`; events.push(`spawn-${current}:prepare`); return { index: current, instanceNonce, connectorBootstrap: { index: current }, tunnelAdmission: { index: current }, async close() { events.push(`spawn-${current}:close`); } }; },
      async authorizeTunnel(bootstrap, identity, admission) { assert.equal(bootstrap.index, admission.index); assert.equal(bootstrap.index, spawnNumber); events.push(`${identity.label}:authorize`); },
      async drain() { events.push(`epoch-${number}:drain`); if (options.drainPending) return new Promise(() => {}); },
    };
    return { runtimeEpoch, lifecycleGeneration: number, broker, async start() { events.push(`epoch-${number}:start`); },
      async materializeTunnelSpawn(spawn) {
        events.push(`spawn-${spawn.index}:materialize`);
        let closed = false;
        return {
          environment: Object.freeze({ opaqueEnvironment: spawn.index }),
          async completeSpawnHandoff() { events.push(`spawn-${spawn.index}:handoff`); },
          async close() { if (!closed) { closed = true; events.push(`spawn-${spawn.index}:environment-close`); } },
        };
      },
      async waitForTunnelReady(identity) { events.push(`${identity.label}:ready-wait`); if (options.readyPending) return new Promise(() => {}); const child = children.find((value) => value.identity === identity); if (options.reparent) identity.parent = "unrelated"; return { ready: true, version: options.wrongHealth ? "0.0.0" : "17.2.6", runtimeEpoch, lifecycleGeneration: number, instanceNonce: child.instanceNonce }; },
      async close() { events.push(`epoch-${number}:close`); } };
  } };
  const native = { async launchVerifiedProcess(spec) {
    assert.deepEqual(Object.keys(spec).sort(), ["instanceNonce", "opaqueLaunch"].sort()); const exit = deferred(); const identity = { label: `child-${children.length + 1}`, pid: 700 + children.length, parent: "launcher" };
    const child = { identity, instanceNonce: spec.instanceNonce, terminated: false, closed: false, wait: () => exit.promise,
      async terminate() { this.terminated = true; events.push(`${identity.label}:terminate-owned`); exit.resolve({ exitCode: 0 }); },
      close() { this.closed = true; events.push(`${identity.label}:close-owned`); }, crash(code = 1) { exit.resolve({ exitCode: code }); } };
    children.push(child); events.push(`${identity.label}:launch`); return child;
  } };
  const commandFactory = async ({ epoch, spawn, environment }) => { const current = spawnNumber; assert.deepEqual(environment, { opaqueEnvironment: spawn.index }); events.push(`spawn-${current}:command`); return { launchSpec: Object.freeze({ opaqueLaunch: current, instanceNonce: spawn.instanceNonce }), version: "17.2.6", runtimeEpoch: epoch.runtimeEpoch, lifecycleGeneration: epoch.lifecycleGeneration, instanceNonce: spawn.instanceNonce, close() { events.push(`spawn-${current}:command-close`); } }; };
  const supervisor = new RuntimeSupervisor({ epochFactory, native, commandFactory, timeout: options.timeout ?? ((promise) => promise), clock: () => 1000, policy: { restartLimit: options.restartLimit ?? 2 } });
  return { supervisor, events, children };
}
test("fixed provider entrypoint resolves the real full-mode epoch factory without a path input", async () => {
  const options = Object.freeze({ runtimeRoot: Object.freeze({ opaque: true }) });
  const created = [];
  let loadedSpecifier;
  const factory = createProviderRuntimeEpochFactory(options, async specifier => {
    loadedSpecifier = specifier;
    return {
      createChatGptWebLauncherEpochFactory(received) {
        assert.equal(received, options);
        return { async create(mode) { created.push(mode); return { mode }; } };
      },
    };
  });
  await assert.rejects(factory.create("browser-only"), /requires_full_mode/);
  assert.equal(loadedSpecifier, undefined);
  assert.deepEqual(await factory.create("full"), { mode: "full" });
  assert.equal(loadedSpecifier, PROVIDER_RUNTIME_ENTRYPOINT);
  assert.equal(PROVIDER_RUNTIME_ENTRYPOINT, "@oh-my-pi/pi-chatgpt-web");
  assert.deepEqual(created, ["full"]);
  assert.equal(PROVIDER_RUNTIME_BUNDLE, path.resolve(__dirname, "../build/provider-runtime.cjs"));
  const bundledProvider = Object.freeze({ bundled: true });
  let requiredPath;
  assert.equal(await loadBundledProviderRuntime(PROVIDER_RUNTIME_ENTRYPOINT, specifier => {
    requiredPath = specifier;
    return bundledProvider;
  }), bundledProvider);
  assert.equal(requiredPath, PROVIDER_RUNTIME_BUNDLE);
});
test("runtime command forwards only the native materialized environment and fixed identity", async () => {
  const environment = Object.freeze({ opaqueEnvironment: true });
  let captured;
  const command = await resolveRuntimeCommand({
    installedRuntime: { bundle: Object.freeze({ opaqueBundle: true }), version: "17.2.6" },
    mode: "full",
    epoch: { runtimeEpoch: `epoch-${"e".repeat(16)}`, lifecycleGeneration: 4 },
    spawn: { instanceNonce: `nonce-${"n".repeat(16)}`, forbiddenCapability: "must-not-forward" },
    environment,
  }, {
    async prepareVerifiedRuntimeLaunch(request) {
      captured = request;
      return {
        launchSpec: Object.freeze({ opaqueLaunch: true }),
        version: "17.2.6",
        runtimeEpoch: request.runtimeEpoch,
        lifecycleGeneration: request.lifecycleGeneration,
        instanceNonce: request.instanceNonce,
      };
    },
  });
  assert.equal(captured.environment, environment);
  assert.equal("spawn" in captured, false);
  assert.equal("forbiddenCapability" in captured, false);
  assert.equal(captured.instanceNonce, `nonce-${"n".repeat(16)}`);
  assert.equal(command.launchSpec.opaqueLaunch, true);
});
test("browser-only mode becomes ready without creating provider or native runtime authority", async () => {
  const value = fixture();
  const state = await value.supervisor.start({ mode: "browser-only" });
  assert.equal(state.status, "ready");
  assert.equal(state.mode, "browser-only");
  assert.equal(state.epochHash, null);
  assert.deepEqual(value.events, []);
  assert.deepEqual(value.children, []);
  await value.supervisor.drain();
});
test("epoch and broker start before tunnel; drain precedes replacement", async () => {
  const value = fixture(); await value.supervisor.start({ mode: "full" });
  assert.deepEqual(value.events.slice(0, 10), ["epoch-1:start", "epoch-1:listen", "spawn-1:prepare", "spawn-1:materialize", "spawn-1:command", "child-1:launch", "child-1:authorize", "child-1:ready-wait", "spawn-1:handoff", "spawn-1:environment-close"]);
  await value.supervisor.restart(); assert.ok(value.events.indexOf("epoch-1:drain") < value.events.indexOf("child-2:launch"));
  assert.equal(value.events.filter((event) => event.endsWith(":prepare")).length, 2); await value.supervisor.drain();
});
test("ready timeout fails closed on retained owned handle", async () => {
  const timeout = (promise, _ms, name) => name === "RuntimeReadyTimeout" ? Promise.reject(Object.assign(new Error("timeout"), { name })) : promise;
  const value = fixture({ readyPending: true, timeout }); await assert.rejects(value.supervisor.start({ mode: "full" }), { name: "RuntimeReadyTimeout" });
  assert.equal(value.children[0].terminated, true); assert.equal(value.children[0].closed, true); assert.equal(value.supervisor.snapshot().status, "failed");
  assert.equal(value.events.includes("spawn-1:environment-close"), true);
});
test("crash-loop restart budget is bounded with fresh epochs and spawn preparations", async () => {
  const value = fixture({ restartLimit: 1 }); await value.supervisor.start({ mode: "full" });
  const ready = waitFor(value.supervisor, (state) => state.status === "ready" && state.generation === 2); value.children[0].crash(9); await ready;
  const failed = waitFor(value.supervisor, (state) => state.status === "failed"); value.children[1].crash(9); const state = await failed;
  assert.equal(state.errorClass, "RuntimeRestartBudgetExceeded"); assert.equal(value.children.length, 2); assert.equal(value.events.filter((event) => event.endsWith(":prepare")).length, 2);
});
test("drain timeout still closes ownership and creates no later child", async () => {
  const timeout = (promise, _ms, name) => name === "RuntimeDrainTimeout" ? Promise.reject(Object.assign(new Error("timeout"), { name })) : promise;
  const value = fixture({ drainPending: true, timeout }); await value.supervisor.start({ mode: "full" }); await assert.rejects(value.supervisor.drain(), { name: "RuntimeDrainTimeout" });
  assert.equal(value.children[0].terminated, true); assert.equal(value.children[0].closed, true); await Promise.resolve(); assert.equal(value.children.length, 1);
});
test("PID reuse, reparenting, and ambient environment never replace owned authority", async () => {
  process.env.OMP_TEST_ENVIRONMENT_CANARY = "must-not-be-inherited";
  try { const value = fixture({ reparent: true }); await value.supervisor.start({ mode: "full" }); const original = value.children[0]; const reused = { pid: original.identity.pid, killed: false }; await value.supervisor.drain(); assert.equal(original.terminated, true); assert.equal(reused.killed, false); assert.equal(original.identity.parent, "unrelated"); assert.doesNotMatch(JSON.stringify(value.events), /OMP_TEST_ENVIRONMENT_CANARY/); }
  finally { delete process.env.OMP_TEST_ENVIRONMENT_CANARY; }
});
test("mismatched ready identity is rejected", async () => { const value = fixture({ wrongHealth: true }); await assert.rejects(value.supervisor.start({ mode: "full" }), /runtime_ready_identity_mismatch/); assert.equal(value.children[0].terminated, true); });
