import { type ChildProcess, spawn } from "node:child_process";
import type { SecretHandle, SecretValue, VaultProvider } from "./types";

/**
 * 1Password provider adapter.
 *
 * Resolves a {@link SecretHandle} to a raw {@link SecretValue} via the
 * `op` CLI. The handle's `itemId` is a 1Password item UUID or title;
 * `field` defaults to `password`. Uses `op read "op://<vault>/<item>/<field>"`
 * which is the modern 1Password secret-reference syntax.
 *
 * The resolved value is captured in-process and never logged. The broker
 * discards it after the subprocess completes.
 */
export class OnePasswordProvider implements VaultProvider {
 readonly name = "1password";

 async resolve(handle: SecretHandle): Promise<SecretValue> {
  if (handle.provider !== "1password") {
   throw new Error(`OnePasswordProvider: wrong provider "${handle.provider}"`);
  }
  const field = handle.field ?? "password";
  // op read op://<vault>/<item>/<field> — the vault can be a name or UUID.
  // For now, assume the itemId is the item and the default vault.
  const ref = `op://${handle.itemId}/${field}`;
  const result = await this.execOp(["read", ref, "--reveal"]);
  if (result.exitCode !== 0) {
   throw new Error(`OnePasswordProvider: op read failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return {
   handle,
   value: result.stdout.trim(),
  };
 }

 async isAvailable(): Promise<boolean> {
  try {
   const result = await this.execOp(["whoami"]);
   return result.exitCode === 0;
  } catch {
   return false;
  }
 }

 private execOp(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
   let child: ChildProcess;
   try {
    child = spawn("op", args, {
     stdio: ["ignore", "pipe", "pipe"],
     env: { ...process.env },
    });
   } catch {
    resolve({ exitCode: -1, stdout: "", stderr: "spawn failed (op not in PATH)" });
    return;
   }
   let stdout = "";
   let stderr = "";
   child.stdout?.on("data", (d) => (stdout += d));
   child.stderr?.on("data", (d) => (stderr += d));
   child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
   child.on("error", (err) => resolve({ exitCode: -1, stdout: "", stderr: err.message }));
  });
 }
}
