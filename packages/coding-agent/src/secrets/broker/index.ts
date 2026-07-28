/**
 * Tier-2 Secret Broker — barrel export.
 *
 * The broker module is in-process for Tier-2 (the off-host sidecar is Tier-3).
 * It holds a `VaultProvider` interface, resolves handles, spawns subprocesses
 * with hardened env, and returns scrubbed results. The agent never holds a raw
 * secret value.
 */

export { SecretBroker } from "./broker";
export type { ChainStep } from "./chain";
export { runWithChain } from "./chain";
export type { HardenedSpawnOptions, HardenedSpawnResult } from "./exec-hardening";
export { CLOSED_PATH, ENV_OVERRIDE_BLACKLIST, hardenedSpawn } from "./exec-hardening";
export { BitwardenProvider } from "./provider-bitwarden";
export { InfisicalProvider } from "./provider-infisical";
export { createRunWithChainTool } from "./run-with-chain-tool";
export { createRunWithSecretTool } from "./run-with-secret-tool";
export { scrubOutput } from "./scrub-output";
export { createSecretBrokerExtension } from "./secret-broker-extension";
export type {
	ExecResult,
	RotateResult,
	SecretHandle,
	SecretValue,
	VaultProvider,
} from "./types";
