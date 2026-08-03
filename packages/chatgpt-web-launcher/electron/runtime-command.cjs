"use strict";

const PACKAGE_NAME = "@oh-my-pi/pi-chatgpt-web-launcher";
const PACKAGE_VERSION = "17.2.4";
const CLI_ENTRYPOINT = "app/cli.js";
const MCP_ENTRYPOINT = "app/mcp-main.js";

function exactKeys(value, keys) {
  return value && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function verifiedCommand(value, installedRuntime, epoch, spawn) {
  if (!value || typeof value !== "object" || !value.launchSpec || typeof value.launchSpec !== "object") {
    throw new Error("native_runtime_launch_spec_invalid");
  }
  if (value.version !== installedRuntime.version
    || value.runtimeEpoch !== epoch.runtimeEpoch
    || value.lifecycleGeneration !== epoch.lifecycleGeneration
    || typeof value.instanceNonce !== "string"
    || value.instanceNonce.length < 16
    || value.instanceNonce.length > 256) {
    throw new Error("native_runtime_launch_identity_mismatch");
  }
  if (spawn.instanceNonce !== undefined && value.instanceNonce !== spawn.instanceNonce) {
    throw new Error("native_runtime_launch_nonce_mismatch");
  }
  const command = { kind: "verified-runtime-command", version: value.version };
  Object.defineProperties(command, {
    launchSpec: { value: value.launchSpec },
    runtimeEpoch: { value: value.runtimeEpoch },
    lifecycleGeneration: { value: value.lifecycleGeneration },
    instanceNonce: { value: value.instanceNonce },
    close: { value: typeof value.close === "function" ? () => value.close() : () => {} },
  });
  return Object.freeze(command);
}

async function resolveRuntimeCommand(options, native) {
  if (!exactKeys(options, ["installedRuntime", "mode", "epoch", "spawn", "environment"])) {
    throw new Error("runtime_command_options_invalid");
  }
  if (options.mode !== "full") throw new Error("runtime_command_requires_full_mode");
  if (!options.environment || typeof options.environment !== "object" || Array.isArray(options.environment)) {
    throw new Error("runtime_spawn_environment_invalid");
  }
  if (!options.spawn || typeof options.spawn !== "object"
    || typeof options.spawn.instanceNonce !== "string"
    || options.spawn.instanceNonce.length < 16
    || options.spawn.instanceNonce.length > 256) {
    throw new Error("runtime_spawn_nonce_invalid");
  }
  const installedRuntime = options.installedRuntime;
  if (!installedRuntime || typeof installedRuntime !== "object" || !installedRuntime.bundle
    || installedRuntime.version !== PACKAGE_VERSION) throw new Error("installed_runtime_invalid");
  if (!native || typeof native.prepareVerifiedRuntimeLaunch !== "function") {
    throw new Error("native_runtime_command_authority_unavailable");
  }
  const value = await native.prepareVerifiedRuntimeLaunch({
    bundle: installedRuntime.bundle,
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    cliEntrypoint: CLI_ENTRYPOINT,
    mcpEntrypoint: MCP_ENTRYPOINT,
    operation: "serve-full-runtime",
    environment: options.environment,
    instanceNonce: options.spawn.instanceNonce,
    runtimeEpoch: options.epoch.runtimeEpoch,
    lifecycleGeneration: options.epoch.lifecycleGeneration,
  });
  return verifiedCommand(value, installedRuntime, options.epoch, options.spawn);
}

function createRuntimeCommandFactory({ native, installedRuntime }) {
  return async ({ mode, epoch, spawn, environment }) =>
    resolveRuntimeCommand({ installedRuntime, mode, epoch, spawn, environment }, native);
}

const runtimeInvocation = resolveRuntimeCommand;

module.exports = {
  CLI_ENTRYPOINT,
  MCP_ENTRYPOINT,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  createRuntimeCommandFactory,
  resolveRuntimeCommand,
  runtimeInvocation,
};
