"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");
const { errorClass } = require("./logging.cjs");
const { requireOwnedProcess, terminateOwnedProcessTree, waitForOwnedProcess } = require("./process-tree.cjs");

const DEFAULT_POLICY = Object.freeze({ readyTimeoutMs: 120_000, drainTimeoutMs: 15_000, shutdownTimeoutMs: 5_000, restartWindowMs: 60_000, restartLimit: 5 });
const PROVIDER_RUNTIME_ENTRYPOINT = "@oh-my-pi/pi-chatgpt-web";
const PROVIDER_RUNTIME_BUNDLE = path.resolve(__dirname, "../build/provider-runtime.cjs");
const STATUSES = Object.freeze(new Set(["stopped", "starting", "ready", "draining", "restarting", "failed"]));
class StaleGenerationError extends Error { constructor() { super("runtime_generation_stale"); this.name = "StaleGenerationError"; } }

function normalizeMode(mode) {
  if (mode !== "browser-only" && mode !== "full") throw new TypeError("runtime_mode_invalid");
  return mode;
}

function validatePolicy(value = {}) {
  const policy = { ...DEFAULT_POLICY, ...value };
  for (const key of ["readyTimeoutMs", "drainTimeoutMs", "shutdownTimeoutMs", "restartWindowMs"]) {
    if (!Number.isFinite(policy[key]) || policy[key] <= 0) throw new TypeError("runtime_policy_invalid");
  }
  if (!Number.isInteger(policy.restartLimit) || policy.restartLimit < 0 || policy.restartLimit > 100) throw new TypeError("runtime_policy_invalid");
  return Object.freeze(policy);
}

function defaultTimeout(promise, milliseconds, timeoutClass) {
  let timer;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => { const error = new Error("runtime_operation_timeout"); error.name = timeoutClass; reject(error); }, milliseconds);
  });
  return Promise.race([promise, timed]).finally(() => clearTimeout(timer));
}

function validateReadyHealth(health, expected) {
  if (!health || typeof health !== "object" || Array.isArray(health)
    || health.version !== expected.version || health.runtimeEpoch !== expected.runtimeEpoch
    || health.lifecycleGeneration !== expected.lifecycleGeneration || health.instanceNonce !== expected.instanceNonce
    || health.ready !== true) throw new Error("runtime_ready_identity_mismatch");
  return Object.freeze({ ready: true });
}

function epochDigest(value) { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function exitCodeOf(exit) { return Number.isInteger(exit?.exitCode) && exit.exitCode >= -1 && exit.exitCode <= 255 ? exit.exitCode : null; }
function loadBundledProviderRuntime(_entrypoint = PROVIDER_RUNTIME_ENTRYPOINT, loadModule = require) {
  if (typeof loadModule !== "function") throw new TypeError("provider_runtime_loader_invalid");
  return Promise.resolve().then(() => loadModule(PROVIDER_RUNTIME_BUNDLE));
}
function createProviderRuntimeEpochFactory(options, loadProvider = loadBundledProviderRuntime) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("provider_runtime_epoch_options_invalid");
  }
  if (typeof loadProvider !== "function") throw new TypeError("provider_runtime_loader_invalid");
  let resolved;
  const resolve = async () => {
    if (!resolved) {
      resolved = Promise.resolve(loadProvider(PROVIDER_RUNTIME_ENTRYPOINT)).then(provider => {
        if (!provider || typeof provider.createChatGptWebLauncherEpochFactory !== "function") {
          throw new Error("provider_runtime_epoch_factory_unavailable");
        }
        const factory = provider.createChatGptWebLauncherEpochFactory(options);
        if (!factory || typeof factory.create !== "function") {
          throw new Error("provider_runtime_epoch_factory_invalid");
        }
        return factory;
      });
    }
    return resolved;
  };
  return Object.freeze({
    async create(mode) {
      if (normalizeMode(mode) !== "full") throw new Error("provider_runtime_epoch_factory_requires_full_mode");
      return (await resolve()).create("full");
    },
  });
}


class RuntimeSupervisor {
  constructor({ epochFactory, providerEpochOptions, providerLoader, native, commandFactory, logger, clock = () => Date.now(), timeout = defaultTimeout, policy }) {
    if (!epochFactory && !providerEpochOptions) throw new TypeError("runtime_epoch_factory_invalid");
    if (epochFactory && providerEpochOptions) throw new TypeError("runtime_epoch_factory_ambiguous");
    const selectedEpochFactory = epochFactory ?? createProviderRuntimeEpochFactory(providerEpochOptions, providerLoader);
    if (!selectedEpochFactory || typeof selectedEpochFactory.create !== "function") throw new TypeError("runtime_epoch_factory_invalid");
    if (!native || typeof native.launchVerifiedProcess !== "function") throw new TypeError("native_runtime_launcher_invalid");
    if (typeof commandFactory !== "function") throw new TypeError("runtime_command_factory_invalid");
    if (typeof clock !== "function" || typeof timeout !== "function") throw new TypeError("runtime_clock_invalid");
    this.epochFactory = selectedEpochFactory; this.native = native; this.commandFactory = commandFactory; this.logger = logger;
    this.clock = clock; this.timeout = timeout; this.policy = validatePolicy(policy); this.listeners = new Set();
    this.queue = Promise.resolve(); this.intent = 0; this.generation = 0; this.desiredMode = null; this.active = null; this.restartHistory = [];
    this.state = { status: "stopped", mode: null, generation: 0, restartCount: 0, epochHash: null, exitCode: null, errorClass: null };
  }

  snapshot() { return Object.freeze({ ...this.state }); }
  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("runtime_listener_invalid");
    this.listeners.add(listener); listener(this.snapshot()); return () => this.listeners.delete(listener);
  }
  start(options) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).length !== 1 || !Object.hasOwn(options, "mode")) {
      return Promise.reject(new TypeError("runtime_start_options_invalid"));
    }
    const mode = normalizeMode(options.mode); const intent = ++this.intent; this.desiredMode = mode; this.active?.abort.abort();
    return this.#enqueue(() => this.#replace(intent, mode, false));
  }
  restart() {
    const mode = this.desiredMode ?? this.active?.mode;
    if (!mode) return Promise.reject(new Error("runtime_not_started"));
    const intent = ++this.intent; this.desiredMode = mode; this.active?.abort.abort();
    return this.#enqueue(() => this.#replace(intent, mode, true));
  }
  drain() {
    const intent = ++this.intent; this.desiredMode = null; this.active?.abort.abort();
    return this.#enqueue(async () => {
      this.#setState({ status: "draining", errorClass: null });
      const active = this.active; if (active) await this.#cleanupActivation(active);
      if (intent !== this.intent) return this.snapshot();
      this.active = null; this.#setState({ status: "stopped", mode: null, epochHash: null }); return this.snapshot();
    });
  }
  stop() { return this.drain(); }

  #enqueue(operation) { const result = this.queue.then(operation, operation); this.queue = result.catch(() => {}); return result; }
  #setState(patch) {
    this.state = { ...this.state, ...patch }; if (!STATUSES.has(this.state.status)) throw new Error("runtime_status_invalid");
    const snapshot = this.snapshot(); for (const listener of this.listeners) { try { listener(snapshot); } catch {} }
    try {
      if (snapshot.status === "failed") this.logger?.error("runtime.failure", { errorClass: snapshot.errorClass ?? "Error", generation: snapshot.generation, restartCount: snapshot.restartCount });
      else this.logger?.info("runtime.lifecycle", { mode: snapshot.mode, status: snapshot.status, generation: snapshot.generation, restartCount: snapshot.restartCount });
    } catch {}
  }
  #current(intent, activation) { return intent === this.intent && this.desiredMode === activation.mode && !activation.abort.signal.aborted; }
  #assertCurrent(intent, activation) { if (!this.#current(intent, activation)) throw new StaleGenerationError(); }

  async #replace(intent, mode, restarting) {
    if (intent !== this.intent || this.desiredMode !== mode) return this.snapshot();
    const previous = this.active;
    if (previous) {
      this.#setState({ status: "draining" });
      try { await this.#cleanupActivation(previous); } finally { if (this.active === previous) this.active = null; }
    }
    if (intent !== this.intent || this.desiredMode !== mode) return this.snapshot();
    const activation = { token: ++this.generation, mode, abort: new AbortController(), epoch: null, broker: null, spawn: null, spawnEnvironment: null, command: null, child: null, cleaned: false };
    this.active = activation;
    this.#setState({ status: restarting ? "restarting" : "starting", mode, generation: activation.token, epochHash: null, exitCode: null, errorClass: null });
    try { await this.#activate(intent, activation); return this.snapshot(); }
    catch (error) {
      try { await this.#cleanupActivation(activation); } catch {}
      if (this.active === activation) this.active = null;
      if (error instanceof StaleGenerationError || intent !== this.intent) return this.snapshot();
      this.desiredMode = null; this.#setState({ status: "failed", errorClass: errorClass(error), epochHash: null }); throw error;
    }
  }

  async #activate(intent, activation) {
    if (activation.mode === "browser-only") {
      this.#setState({ status: "ready" });
      return;
    }
    const epoch = await this.epochFactory.create(activation.mode);
    if (!epoch || typeof epoch !== "object" || typeof epoch.runtimeEpoch !== "string" || epoch.runtimeEpoch.length < 16
      || !Number.isInteger(epoch.lifecycleGeneration) || epoch.lifecycleGeneration < 1 || !epoch.broker
      || typeof epoch.broker.listen !== "function" || typeof epoch.broker.drain !== "function") throw new Error("runtime_epoch_invalid");
    activation.epoch = epoch; activation.broker = epoch.broker; this.#assertCurrent(intent, activation);
    if (typeof epoch.start === "function") await epoch.start();
    this.#assertCurrent(intent, activation); await epoch.broker.listen(); this.#assertCurrent(intent, activation);
    this.#setState({ epochHash: epochDigest(epoch.runtimeEpoch) });
    if (typeof epoch.broker.prepareTunnelSpawn !== "function"
      || typeof epoch.broker.authorizeTunnel !== "function"
      || typeof epoch.materializeTunnelSpawn !== "function") throw new Error("runtime_tunnel_broker_invalid");
    const spawn = await epoch.broker.prepareTunnelSpawn(); activation.spawn = spawn; this.#assertCurrent(intent, activation);
    const spawnEnvironment = await epoch.materializeTunnelSpawn(spawn);
    activation.spawnEnvironment = spawnEnvironment;
    if (!spawnEnvironment || typeof spawnEnvironment !== "object" || !spawnEnvironment.environment
      || typeof spawnEnvironment.completeSpawnHandoff !== "function"
      || typeof spawnEnvironment.close !== "function") throw new Error("runtime_spawn_environment_invalid");
    this.#assertCurrent(intent, activation);
    const command = await this.commandFactory({
      mode: "full",
      epoch,
      spawn,
      environment: spawnEnvironment.environment,
    });
    activation.command = command; this.#assertCurrent(intent, activation);
    if (!command || typeof command !== "object" || !command.launchSpec) throw new Error("runtime_command_invalid");
    const owned = requireOwnedProcess(await this.native.launchVerifiedProcess(command.launchSpec)); activation.child = owned; this.#assertCurrent(intent, activation);
    await epoch.broker.authorizeTunnel(spawn.connectorBootstrap, owned.identity, spawn.tunnelAdmission);
    const waitReady = typeof epoch.waitForTunnelReady === "function" ? epoch.waitForTunnelReady.bind(epoch)
      : typeof epoch.broker.waitForTunnelReady === "function" ? epoch.broker.waitForTunnelReady.bind(epoch.broker) : null;
    if (!waitReady) throw new Error("runtime_ready_authority_unavailable");
    const health = await this.timeout(waitReady(owned.identity, activation.abort.signal, this.policy.readyTimeoutMs), this.policy.readyTimeoutMs, "RuntimeReadyTimeout");
    validateReadyHealth(health, { version: command.version, runtimeEpoch: command.runtimeEpoch, lifecycleGeneration: command.lifecycleGeneration, instanceNonce: command.instanceNonce });
    this.#assertCurrent(intent, activation);
    await spawnEnvironment.completeSpawnHandoff();
    await spawnEnvironment.close();
    activation.spawnEnvironment = null;
    command.close?.();
    activation.command = null;
    await spawn.close?.();
    activation.spawn = null;
    this.#assertCurrent(intent, activation);
    this.#setState({ status: "ready" });
    void this.#monitor(activation, intent);
  }

  async #monitor(activation, intent) {
    let exit; try { exit = await waitForOwnedProcess(activation.child); } catch (error) { exit = { exitCode: null, waitError: error }; }
    await this.#enqueue(() => this.#handleExit(activation, intent, exit));
  }
  async #handleExit(activation, intent, exit) {
    if (this.active !== activation || !this.#current(intent, activation)) return;
    this.#setState({ exitCode: exitCodeOf(exit) }); activation.child?.close(); activation.child = null; activation.command?.close?.(); activation.command = null;
    const now = this.clock(); this.restartHistory = this.restartHistory.filter((value) => now - value <= this.policy.restartWindowMs);
    if (this.restartHistory.length >= this.policy.restartLimit) {
      this.desiredMode = null; try { await this.#cleanupActivation(activation); } catch {}
      if (this.active === activation) this.active = null;
      this.#setState({ status: "failed", errorClass: "RuntimeRestartBudgetExceeded", epochHash: null }); return;
    }
    this.restartHistory.push(now); this.#setState({ restartCount: this.restartHistory.length, status: "restarting" });
    const nextIntent = ++this.intent; await this.#replace(nextIntent, activation.mode, true);
  }

  async #cleanupActivation(activation) {
    if (activation.cleaned) return; activation.cleaned = true; activation.abort.abort(); let primaryError = null;
    if (activation.broker) {
      try { await this.timeout(Promise.resolve(activation.broker.drain()), this.policy.drainTimeoutMs, "RuntimeDrainTimeout"); }
      catch (error) { primaryError = error; }
    }
    if (activation.child) {
      try {
        await terminateOwnedProcessTree(activation.child);
        await this.timeout(waitForOwnedProcess(activation.child), this.policy.shutdownTimeoutMs, "RuntimeShutdownTimeout");
      } catch (error) { if (!primaryError) primaryError = error; }
      finally { activation.child.close(); activation.child = null; }
    }
    try { await activation.spawnEnvironment?.close?.(); }
    catch (error) { if (!primaryError) primaryError = error; }
    activation.spawnEnvironment = null;
    try { activation.command?.close?.(); } catch (error) { if (!primaryError) primaryError = error; } activation.command = null;
    try { await activation.spawn?.close?.(); } catch (error) { if (!primaryError) primaryError = error; } activation.spawn = null;
    try { await activation.epoch?.close?.(); } catch (error) { if (!primaryError) primaryError = error; } activation.epoch = null; activation.broker = null;
    if (primaryError) throw primaryError;
  }
}

module.exports = {
  DEFAULT_POLICY,
  PROVIDER_RUNTIME_ENTRYPOINT,
  PROVIDER_RUNTIME_BUNDLE,
  RuntimeSupervisor,
  loadBundledProviderRuntime,
  createProviderRuntimeEpochFactory,
  defaultTimeout,
  normalizeMode,
  validatePolicy,
  validateReadyHealth,
};
