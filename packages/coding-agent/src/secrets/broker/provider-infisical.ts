import { spawn } from "node:child_process";
import type { SecretHandle, SecretValue, VaultProvider } from "./types";

/**
 * Result of a single subprocess invocation. Mirrors the subset of
 * `Bun.spawn`/child-process fields the provider needs.
 */
export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Pluggable subprocess executor. The default implementation spawns via
 * `node:child_process`. Tests inject a stub to drive the CLI path
 * deterministically without touching SSH, the VPS, or the infisical binary.
 */
export type CommandExecutor = (args: string[], env?: Record<string, string>) => Promise<CommandResult>;

/**
 * Tier-3 Task 1 + S6 fix: Infisical provider adapter.
 *
 * Resolves a {@link SecretHandle} to a raw {@link SecretValue}. The handle's
 * `itemId` is `"<env>/<key>"` (slash-separated); the provider splits on the
 * first slash to extract env and key.
 *
 * Resolution is layered — CLI is primary, REST is the fallback.
 *
 *  1. **CLI (primary)** — spawns `<sshTarget...> <cliPath...> secrets get
 *     <key> --env=<env> --plain` (default: `ssh ovh-vps6 infisical secrets
 *     get ...`). This works against self-hosted Infisical v0.43.91, where
 *     the REST v3 secrets endpoint returns "Blind index not found" for our
 *     query shape (`?environment=&workspaceId=`). The CLI on the VPS hits the
 *     same backend and returns the value cleanly.
 *  2. **REST (fallback)** — exchanges `client_id`+`client_secret` for a JWT
 *     via `/v1/auth/universal-auth/login`, then fetches
 *     `GET <apiUrl>/v3/secrets/<key>?environment=<env>&workspaceId=<id>` with
 *     `Authorization: Bearer <token>`. Used when the CLI is unreachable
 *     (VPS down, no SSH agent, no `infisical` binary on PATH).
 *
 * Fail-closed (R2): `resolve()` throws on a wrong provider name, malformed
 * itemId, or both paths failing — it never returns a partial or empty value
 * the caller might mistake for a real secret.
 *
 * The resolved value is captured in-process and never logged. The broker
 * discards it after the subprocess completes.
 */
export class InfisicalProvider implements VaultProvider {
	readonly name = "infisical";
	#apiUrl: string;
	#healthUrl: string;
	#clientId: string;
	#clientSecret: string;
	#workspaceId: string;
	#sshTarget: string[];
	#cliPath: string[];
	#executor: CommandExecutor;
	#accessToken: string | undefined;
	#tokenExpiresAt = 0;

	constructor(opts: {
		apiUrl?: string;
		healthUrl?: string;
		clientId: string;
		clientSecret: string;
		workspaceId: string;
		/**
		 * Override the SSH argv prepended to the infisical CLI command.
		 * Default: `["ssh", "ovh-vps6"]` (the project's Tailscale SSH alias
		 * per AGENTS.md). Pass `[]` to invoke `infisical` directly without
		 * SSH (e.g. when the CLI is installed locally and authenticated).
		 */
		sshTarget?: string[];
		/** Override the infisical CLI argv. Default: `["infisical"]`. */
		cliPath?: string[];
		/**
		 * Override the subprocess executor. Default: spawn the command via
		 * `node:child_process`. Tests inject a stub to drive CLI behaviour
		 * without touching SSH/CLI binaries.
		 */
		executor?: CommandExecutor;
	}) {
		this.#apiUrl = opts.apiUrl ?? process.env.INFISICAL_API_URL ?? "http://100.96.119.57:8083/api";
		this.#healthUrl = opts.healthUrl ?? `${this.#apiUrl.replace(/\/api$/, "")}/health`;
		this.#clientId = opts.clientId;
		this.#clientSecret = opts.clientSecret;
		this.#workspaceId = opts.workspaceId;
		this.#sshTarget = opts.sshTarget ?? ["ssh", "ovh-vps6"];
		this.#cliPath = opts.cliPath ?? ["infisical"];
		this.#executor = opts.executor ?? defaultExecutor;
	}

	/**
	 * Authenticate with the Infisical API using machine identity credentials.
	 * Exchanges client_id + client_secret for a JWT access token.
	 * Caches the token until 5 minutes before expiry.
	 */
	async #getAccessToken(): Promise<string> {
		// Return cached token if still valid (with 5-min skew)
		if (this.#accessToken && Date.now() < this.#tokenExpiresAt - 300_000) {
			return this.#accessToken!;
		}

		const response = await fetch(`${this.#apiUrl}/v1/auth/universal-auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				clientId: this.#clientId,
				clientSecret: this.#clientSecret,
			}),
		});

		if (!response.ok) {
			throw new Error(`InfisicalProvider: auth login failed (${response.status}: ${response.statusText})`);
		}

		const data = (await response.json()) as { accessToken: string; expiresIn?: number };
		this.#accessToken = data.accessToken;
		// expiresIn is in seconds; default to 1 hour if absent
		this.#tokenExpiresAt = Date.now() + (data.expiresIn ?? 3600) * 1000;
		return this.#accessToken;
	}

	async resolve(handle: SecretHandle): Promise<SecretValue> {
		if (handle.provider !== "infisical") {
			throw new Error(`InfisicalProvider: wrong provider "${handle.provider}"`);
		}
		const slashIdx = handle.itemId.indexOf("/");
		if (slashIdx === -1) {
			throw new Error(`InfisicalProvider: itemId must be "<env>/<key>", got "${handle.itemId}"`);
		}
		const env = handle.itemId.slice(0, slashIdx);
		const key = handle.itemId.slice(slashIdx + 1);

		// 1. CLI primary (works against self-hosted v0.43.91 where REST v3
		//    returns "Blind index not found" with ?environment=&workspaceId=).
		try {
			const value = await this.#resolveViaCli(env, key);
			return { handle, value };
		} catch (cliErr) {
			const cliMessage = cliErr instanceof Error ? cliErr.message : String(cliErr);

			// 2. REST fallback.
			try {
				const value = await this.#resolveViaRest(env, key);
				return { handle, value };
			} catch (restErr) {
				const restMessage = restErr instanceof Error ? restErr.message : String(restErr);
				throw new Error(
					`InfisicalProvider: both CLI and REST failed for "${env}/${key}". CLI: ${cliMessage}; REST: ${restMessage}`,
				);
			}
		}
	}

	/**
	 * Build the CLI argv and run it. Fails with an `Error` whose message
	 * contains "CLI" so the resolve() failure summary stays informative.
	 */
	async #resolveViaCli(env: string, key: string): Promise<string> {
		const args = [...this.#sshTarget, ...this.#cliPath, "secrets", "get", key, `--env=${env}`, "--plain"];
		let result: CommandResult;
		try {
			result = await this.#executor(args);
		} catch (err) {
			throw new Error(`CLI executor threw for "${env}/${key}": ${err instanceof Error ? err.message : String(err)}`);
		}
		if (result.exitCode !== 0) {
			const stderrTail = result.stderr.trim().split("\n").slice(-3).join(" | ");
			throw new Error(`CLI exit ${result.exitCode} for "${env}/${key}": ${stderrTail}`);
		}
		const value = result.stdout.trim();
		if (!value) {
			throw new Error(`CLI returned empty value for "${env}/${key}"`);
		}
		return value;
	}

	/**
	 * REST v3 path. Kept as fallback for environments where the CLI is
	 * unreachable (no SSH agent, VPS offline, no infisical binary). Against
	 * self-hosted Infisical v0.43.91 this returns "Blind index not found"
	 * for our query shape — the CLI path is what works in production.
	 */
	async #resolveViaRest(env: string, key: string): Promise<string> {
		const token = await this.#getAccessToken();
		const url = `${this.#apiUrl}/v3/secrets/${encodeURIComponent(key)}?environment=${encodeURIComponent(env)}&workspaceId=${encodeURIComponent(this.#workspaceId)}`;

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`REST API returned ${response.status}: ${response.statusText}`);
		}

		const data = (await response.json()) as { secretValue?: string };
		if (typeof data.secretValue !== "string" || data.secretValue.length === 0) {
			throw new Error("REST API returned empty secretValue");
		}
		return data.secretValue;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const response = await fetch(this.#healthUrl, {
				signal: AbortSignal.timeout(5000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}
}

/**
 * Default subprocess executor. Spawns `args[0]` with the remaining argv via
 * `node:child_process`. Array-form argv — never `bash -c "..."`.
 */
async function defaultExecutor(args: string[], env?: Record<string, string>): Promise<CommandResult> {
	const { promise, resolve } = Promise.withResolvers<CommandResult>();
	const [command, ...rest] = args;
	const child = spawn(command, rest, {
		stdio: ["ignore", "pipe", "pipe"],
		env: env ?? (process.env as Record<string, string>),
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
