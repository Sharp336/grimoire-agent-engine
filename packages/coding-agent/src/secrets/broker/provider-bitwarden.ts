import { spawn } from "node:child_process";
import type { SecretHandle, SecretValue, VaultProvider } from "./types";

/**
 * Tier-2 Secret Broker — Bitwarden provider adapter.
 *
 * Resolves a {@link SecretHandle} to a raw {@link SecretValue} by shelling out
 * to the `bw` CLI in array-form argv (never `bash -c`, which would reintroduce
 * shell interpolation and PATH lookup). Fail-closed (R2): `resolve()` throws on
 * any non-zero exit — it never returns a partial or empty value that the caller
 * might mistake for a real secret.
 *
 * The resolved value is captured in-process and never logged. The broker
 * discards it after the subprocess completes.
 *
 * Credential vault wiring: `BW_SESSION` is held in the broker's in-memory
 * credential vault (passed in via `opts.credentials`) instead of `process.env`.
 * When a vault IS wired, the vault is the single source of truth and the
 * provider strips `BW_SESSION` from the inherited env block — so a leaked
 * value in `process.env` cannot impersonate the registered credential, and the
 * agent's `BashTool` and other env-aware tools cannot read the live session.
 *
 * Fail-closed (R2): if `BW_SESSION` cannot be sourced (vault empty OR vault
 * not wired AND `process.env.BW_SESSION` missing), `resolve()` throws with a
 * message containing "BW_SESSION".
 */
export class BitwardenProvider implements VaultProvider {
	readonly name = "bitwarden";
	/**
	 * Optional credentials map. When provided, the provider reads `BW_SESSION`
	 * from this map rather than `process.env`. Pass the broker's
	 * `credentials` accessor here so the vault is the single source of truth.
	 */
	readonly #credentials: ReadonlyMap<string, string> | undefined;

	constructor(opts?: { credentials?: ReadonlyMap<string, string> }) {
		this.#credentials = opts?.credentials;
	}

	async resolve(handle: SecretHandle): Promise<SecretValue> {
		if (handle.provider !== "bitwarden") {
			throw new Error(`BitwardenProvider: wrong provider "${handle.provider}"`);
		}
		const field = handle.field ?? "password";
		// Array-form argv — never `bash -c "..."`. `--raw` returns the bare value.
		const result = await this.execBw(["get", field, handle.itemId, "--raw"]);
		if (result.exitCode !== 0) {
			throw new Error(`BitwardenProvider: bw get failed (exit ${result.exitCode}): ${result.stderr}`);
		}
		return {
			handle,
			value: result.stdout.trim(),
		};
	}
	async isAvailable(): Promise<boolean> {
		// Fail-closed (R2): refuse to probe `bw` without a session. Without one
		// the call would still succeed (`bw status` does not require a session)
		// but the spawned subprocess would have no `BW_SESSION`, opening the
		// door to the leak we just closed. Treat missing credentials as
		// "not configured".
		if (!this.#getSession()) return false;
		try {
			const result = await this.execBw(["status", "--raw"]);
			if (result.exitCode !== 0) return false;
			const status = JSON.parse(result.stdout) as { status?: string };
			return status.status === "unlocked";
		} catch {
			return false;
		}
	}

	/**
	 * Fetch the raw item JSON. Used by sibling providers that need fields
	 * beyond the password (e.g. TotpProvider reads login.totp for the seed).
	 * The JSON is parsed in-process and never logged.
	 */
	async getItemJson(itemId: string): Promise<unknown> {
		const result = await this.execBw(["get", "item", itemId]);
		if (result.exitCode !== 0) {
			throw new Error(`BitwardenProvider: bw get item failed (exit ${result.exitCode}): ${result.stderr}`);
		}
		return JSON.parse(result.stdout);
	}
	/**
	 * Resolve the active BW_SESSION. Three cases:
	 *   1. Vault wired AND has BW_SESSION → return the vault value (vault is
	 *      the source of truth; process.env is ignored).
	 *   2. Vault wired but empty for BW_SESSION → return undefined → fail-closed.
	 *   3. Vault NOT wired → fall back to process.env.BW_SESSION (legacy path);
	 *      if that's also missing, fail-closed.
	 */
	#getSession(): string | undefined {
		const fromVault = this.#credentials?.get("BW_SESSION");
		if (fromVault !== undefined) return fromVault;
		if (this.#credentials !== undefined) return undefined;
		return process.env.BW_SESSION;
	}

	private execBw(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const { promise, resolve } = Promise.withResolvers<{
			exitCode: number;
			stdout: string;
			stderr: string;
		}>();

		const session = this.#getSession();
		if (session === undefined) {
			// Fail-closed (R2): refuse to spawn `bw` without a session. The agent
			// has not registered `BW_SESSION` with the broker, and there is no
			// legacy fallback in process.env. Never return a partial / empty
			// value — that would let the caller mistake a leaked placeholder
			// for a real secret.
			return Promise.resolve({
				exitCode: -1,
				stdout: "",
				stderr: "[BROKER] BW_SESSION not registered in credential vault and not in process.env (fail-closed R2)",
			});
		}

		// Build the subprocess env. Strip BW_SESSION from process.env so a
		// leaked value (e.g. operator set it AFTER the move-to-vault step)
		// cannot impersonate the registered credential. The vault value is
		// the only BW_SESSION the spawned bw ever sees.
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.BW_SESSION;
		env.BW_SESSION = session;

		const child = spawn("bw", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", d => {
			stdout += d;
		});
		child.stderr?.on("data", d => {
			stderr += d;
		});
		child.on("close", exitCode => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
		child.on("error", err => resolve({ exitCode: -1, stdout, stderr: err.message }));
		return promise;
	}
}
