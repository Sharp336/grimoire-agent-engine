import { type ChildProcess, spawn } from "node:child_process";
import type { SecretHandle, SecretValue, VaultProvider } from "./types";

/**
 * HashiCorp Vault provider adapter.
 *
 * Resolves a {@link SecretHandle} to a raw {@link SecretValue} via the
 * `vault` CLI. The handle's `itemId` is the Vault path (e.g.
 * `secret/data/myapp/config`). `field` defaults to `password` (or the
 * specified key within the secret).
 *
 * Uses `vault kv get -format=json <path>` and parses the JSON response.
 * The resolved value is captured in-process and never logged.
 */
export class HashiCorpVaultProvider implements VaultProvider {
 readonly name = "hashicorp";
 #addr: string;

 constructor(opts?: { addr?: string }) {
  this.#addr = opts?.addr ?? process.env.VAULT_ADDR ?? "http://127.0.0.1:8200";
 }

 async resolve(handle: SecretHandle): Promise<SecretValue> {
  if (handle.provider !== "hashicorp") {
   throw new Error(`HashiCorpVaultProvider: wrong provider "${handle.provider}"`);
  }
  const field = handle.field ?? "password";
  // vault kv get -format=json -field=<field> <path>
  const args = ["kv", "get", "-format=json", "-field=" + field, handle.itemId];
  const result = await this.execVault(args);
  if (result.exitCode !== 0) {
   throw new Error(`HashiCorpVaultProvider: vault kv get failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  try {
   const data = JSON.parse(result.stdout) as { data?: { data?: Record<string, string> } };
   const value = data.data?.data?.[field];
   if (value === undefined) {
    throw new Error(`field "${field}" not found in Vault secret`);
   }
   return { handle, value };
  } catch (err) {
   throw new Error(`HashiCorpVaultProvider: failed to parse response: ${err instanceof Error ? err.message : String(err)}`);
  }
 }

 async isAvailable(): Promise<boolean> {
  try {
   const result = await this.execVault(["status", "-format=json"]);
   return result.exitCode === 0;
  } catch {
   return false;
  }
 }

 private execVault(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
   const child = spawn("vault", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, VAULT_ADDR: this.#addr },
   });
   let stdout = "";
   let stderr = "";
   child.stdout?.on("data", (d) => (stdout += d));
   child.stderr?.on("data", (d) => (stderr += d));
   child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
   child.on("error", (err) => resolve({ exitCode: -1, stdout: "", stderr: err.message }));
  });
 }
}
