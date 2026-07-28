import { randomUUID } from "node:crypto";
import { hardenedSpawn } from "./exec-hardening";
import type { SidecarClient } from "../sidecar/client";
import { scrubOutput } from "./scrub-output";
import type { ExecResult, SecretHandle, SecretValue, VaultProvider } from "./types";

/** A live TTL-scoped borrow (D3). Values live in the credential vault under `lease:<id>`. */
interface LeaseRecord {
	leaseId: string;
	handle: SecretHandle;
	expiresAt: number;
	createdAt: number;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Tier-2 Secret Broker — the in-process broker that ties everything together.
 *
 * The agent requests a capability: "run this command with secret X in env var
 * Y". The broker (1) resolves the handle via the registered provider (fail-
 * closed), (2) tracks the resolved value for scrubbing, (3) spawns the
 * subprocess with a hardened env + the secret injected, (4) scrubs stdout/stderr
 * of the resolved value, and (5) returns a typed {@link ExecResult}. The agent
 * never holds the raw secret value.
 *
 * Off-host sidecar isolation is Tier-3 (Arch-C); for Tier-2 the broker is
 * in-process but the agent's only interface is the {@link ExecResult} return
 * type, which cannot carry a raw secret.
 */
export class SecretBroker {
	/** Live leases (D3): leaseId → record. Values are in the credential vault. */
	readonly #leases = new Map<string, LeaseRecord>();
	#providers = new Map<string, VaultProvider>();

	/**
	 * When attached, capability calls proxy to the off-process sidecar
	 * instead of resolving in-process. The sidecar holds secrets in its own
	 * heap; this process never sees them (except via the gated
	 * resolve_for_redaction path used by /redact).
	 */
	#sidecarClient: SidecarClient | undefined;
	/** Resolved secret values tracked for scrubbing. Never exposed. */
	#resolvedSecrets: string[] = [];
	/**
	 * Credential vault — process-memory only. Holds secrets the broker needs
	 * to inject into subprocess env vars (e.g. `BW_SESSION`) without leaking
	 * them into `process.env`. The agent's tools never see this map; the
	 * provider reads it via `credentials` (read-only accessor) when spawning.
	 */
	#credentialVault = new Map<string, string>();

	/**
	 * Attach an off-process sidecar. After this call, runWithSecret and
	 * resolveHandle proxy to the sidecar over the unix socket; the local
	 * vault stays as fallback when the sidecar is unreachable.
	 */
	attachSidecar(client: SidecarClient): void {
		this.#sidecarClient = client;
	}

	/** True when proxying to an off-process sidecar. */
	get hasSidecar(): boolean {
		return this.#sidecarClient !== undefined;
	}

	registerProvider(provider: VaultProvider): void {
		this.#providers.set(provider.name, provider);
	}

	/**
	 * Look up a registered provider by name. Used by `runWithChain()` to
	 * resolve each step's handle. Returns `undefined` if no provider is
	 * registered under that name.
	 */
	getProvider(name: string): VaultProvider | undefined {
		return this.#providers.get(name);
	}

	/**
	 * Run a command with a resolved secret injected into the subprocess env.
	 * Fail-closed (R2): unknown provider or resolution failure yields an error
	 * {@link ExecResult}, never a raw value.
	 */
	async runWithSecret(params: {
		handle: SecretHandle;
		command: string;
		args: string[];
		/** Env var name to inject the resolved secret as. */
		envKey: string;
		cwd?: string;
		timeoutMs?: number;
	}): Promise<ExecResult> {
		// Proxy to the sidecar when attached — secrets resolve in ITS heap,
		// not this process's.
		if (this.#sidecarClient) {
			try {
				const res = await this.#sidecarClient.request({
					op: "run_with_secret",
					handle: params.handle,
					command: params.command,
					args: params.args,
					envKey: params.envKey,
					timeoutMs: params.timeoutMs,
				});
				if (res.ok) return res.result as ExecResult;
				return { exitCode: -1, stdout: "", stderr: `[SIDECAR] ${(res as { error: string }).error}` };
			} catch (err) {
				return {
					exitCode: -1,
					stdout: "",
					stderr: `[SIDECAR] unreachable: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		}

		// 1. Resolve handle → SecretValue (fail-closed).
		const provider = this.#providers.get(params.handle.provider);
		if (!provider) {
			return {
				exitCode: -1,
				stdout: "",
				stderr: `[BROKER] Unknown provider: ${params.handle.provider}`,
			};
		}
		let secret: { value: string };
		try {
			const resolved = await provider.resolve(params.handle);
			secret = { value: resolved.value };
		} catch (err) {
			return {
				exitCode: -1,
				stdout: "",
				stderr: `[BROKER] Resolution failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		// 2. Track the resolved value for scrubbing.
		this.#resolvedSecrets.push(secret.value);

		// 3. Spawn with hardened env + secret injected (never into process.env).
		// S4: broker children get a restricted SSH agent socket (if the operator
		// has set one up at the well-known path), or NO SSH_AUTH_SOCK at all.
		// This prevents the subprocess from reaching hosts the user's personal
		// keys authorize — chains that need SSH (e.g., BW → SSH → Infisical)
		// only work with the restricted agent holding the scoped VPS key.
		const restrictedSockPath = process.env.OMP_SECRET_RESTRICTED_SSH_SOCK;
		const result = await hardenedSpawn({
			command: params.command,
			args: params.args,
			envSecrets: { [params.envKey]: secret.value },
			cwd: params.cwd,
			timeoutMs: params.timeoutMs,
			...(restrictedSockPath ? { sshAuthSock: restrictedSockPath } : {}),
		});

		// 4. Scrub stdout/stderr of all known secret values.
		const stdout = scrubOutput(result.stdout, this.#resolvedSecrets);
		const stderr = scrubOutput(result.stderr, this.#resolvedSecrets);

		// 5. Return typed result — no raw secret in any field.
		return { exitCode: result.exitCode, stdout, stderr };
	}

	/** Clear the resolved-secrets scrub list. Call on session end. */
	clearResolvedSecrets(): void {
		this.#resolvedSecrets = [];
	}

	/**
	 * Resolve a handle to a {@link SecretValue}. Fail-closed (R2): throws on an
	 * unknown provider or any resolution failure — never returns a partial or
	 * empty value the caller might mistake for a real secret.
	 *
	 * Used by the `/redact` command (trusted extension code, NOT the agent) to
	 * register the resolved value into the obfuscator. The caller transiently
	 * holds the value to call `addSecret`, then discards it; the value never
	 * crosses back into the agent's message stream.
	 */
	async resolveHandle(handle: SecretHandle): Promise<SecretValue> {
		if (this.#sidecarClient) {
			const res = await this.#sidecarClient.request({ op: "resolve_for_redaction", handle });
			if (!res.ok) {
				throw new Error(`[SIDECAR] ${(res as { error: string }).error}`);
			}
			const result = res.result as { value: string };
			return { handle, value: result.value };
		}
		const provider = this.#providers.get(handle.provider);
		if (!provider) {
			throw new Error(`[BROKER] Unknown provider: ${handle.provider}`);
		}
		return provider.resolve(handle);
	}

	/**
	 * Register a credential in the vault. The broker will inject it into
	 * subprocess env vars via `BitwardenProvider`'s credentials map. The value
	 * is held in process memory only — it never enters `process.env`, so the
	 * agent's `BashTool` and other env-aware tools cannot read it.
	 */
	async setCredential(key: string, value: string): Promise<void> {
		this.#credentialVault.set(key, value);
		// Forward to the sidecar when attached so its vault (and its providers)
		// see the credential. Awaited by callers that need the value usable
		// immediately (e.g. /bw-unlock before a bw-backed resolve).
		if (this.#sidecarClient) {
			const res = await this.#sidecarClient.request({ op: "set_credential", key, value });
			if (!res.ok) {
				throw new Error(`[SIDECAR] set_credential failed: ${(res as { error: string }).error}`);
			}
		}
	}

	/**
	 * Look up a credential in the vault. Returns `undefined` if the key has not
	 * been registered. Used by providers (e.g. `BitwardenProvider`) to pull
	 * `BW_SESSION` before shelling out to `bw`.
	 */
	getCredential(key: string): string | undefined {
		return this.#credentialVault.get(key);
	}

	/**
	 * Read-only live view of the credential vault. Reads (`get`, `has`,
	 * iteration) reflect future `setCredential` / `clearCredentials` calls
	 * immediately; writes throw. Providers that hold this reference observe
	 * live state without being able to mutate it.
	 */
	get credentials(): ReadonlyMap<string, string> {
		return new Proxy(this.#credentialVault, {
			get(target, prop, receiver) {
				if (prop === "set" || prop === "delete" || prop === "clear") {
					return () => {
						throw new Error("credential vault is read-only outside the broker");
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	/**
	 * Wipe the credential vault. Call on session end so the live secret does
	 * not linger in process memory after the agent exits.
	 */
	clearCredentials(): void {
		for (const leaseId of [...this.#leases.keys()]) {
			void this.revokeLease(leaseId);
		}
		this.#credentialVault.clear();
	}

	/**
	 * Create a TTL-scoped borrow (D3): resolve the handle NOW (fail-closed)
	 * and hold the value in the vault under a lease-namespaced key. The value
	 * joins the scrub list while the lease is live and is removed on expiry
	 * or revoke. Rotation flows (C3) hold the old password as a lease across
	 * the test-new/revert window — the agent never sees it.
	 */
	async createLease(handle: SecretHandle, ttlMs: number): Promise<{ leaseId: string; expiresAt: number }> {
		if (this.#sidecarClient) {
			const res = await this.#sidecarClient.request({ op: "create_lease", handle, ttlMs });
			if (!res.ok) {
				throw new Error(`[SIDECAR] ${(res as { error: string }).error}`);
			}
			return res.result as { leaseId: string; expiresAt: number };
		}
		const provider = this.#providers.get(handle.provider);
		if (!provider) {
			throw new Error(`[BROKER] Unknown provider: ${handle.provider}`);
		}
		const resolved = await provider.resolve(handle);
		const leaseId = randomUUID();
		const expiresAt = Date.now() + ttlMs;
		const timer = setTimeout(() => {
			void this.revokeLease(leaseId);
		}, ttlMs);
		timer.unref?.();
		this.#leases.set(leaseId, { leaseId, handle, expiresAt, createdAt: Date.now(), timer });
		this.#credentialVault.set(`lease:${leaseId}`, resolved.value);
		this.#resolvedSecrets.push(resolved.value);
		return { leaseId, expiresAt };
	}
	/** Revoke a lease: remove the value from the vault + scrub list. Idempotent. */
	async revokeLease(leaseId: string): Promise<void> {
		if (this.#sidecarClient) {
			const res = await this.#sidecarClient.request({ op: "revoke_lease", leaseId });
			if (!res.ok) {
				throw new Error(`[SIDECAR] ${(res as { error: string }).error}`);
			}
			return;
		}
		const lease = this.#leases.get(leaseId);
		if (!lease) return;
		clearTimeout(lease.timer);
		const value = this.#credentialVault.get(`lease:${leaseId}`);
		this.#credentialVault.delete(`lease:${leaseId}`);
		if (value !== undefined) {
			const index = this.#resolvedSecrets.indexOf(value);
			if (index !== -1) this.#resolvedSecrets.splice(index, 1);
		}
		this.#leases.delete(leaseId);
	}
	/** Lease metadata (never values). */
	listLeases(): Array<{ leaseId: string; handle: SecretHandle; expiresAt: number; createdAt: number }> {
		return [...this.#leases.values()].map(({ leaseId, handle, expiresAt, createdAt }) => ({
			leaseId,
			handle,
			expiresAt,
			createdAt,
		}));
	}

	/**
	 * Run a command with a leased secret injected — same contract as
	 * runWithSecret but sourced from the lease instead of a fresh provider
	 * resolution. Fail-closed on unknown/expired lease.
	 */
	async runWithLease(params: {
		leaseId: string;
		command: string;
		args: string[];
		envKey: string;
		cwd?: string;
		timeoutMs?: number;
	}): Promise<ExecResult> {
		if (this.#sidecarClient) {
			try {
				const res = await this.#sidecarClient.request({
					op: "run_with_lease",
					leaseId: params.leaseId,
					command: params.command,
					args: params.args,
					envKey: params.envKey,
					timeoutMs: params.timeoutMs,
				});
				if (res.ok) return res.result as ExecResult;
				return { exitCode: -1, stdout: "", stderr: `[SIDECAR] ${(res as { error: string }).error}` };
			} catch (err) {
				return {
					exitCode: -1,
					stdout: "",
					stderr: `[SIDECAR] unreachable: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		}
		const value = this.#credentialVault.get(`lease:${params.leaseId}`);
		if (value === undefined) {
			return {
				exitCode: -1,
				stdout: "",
				stderr: `[BROKER] unknown or expired lease: ${params.leaseId}`,
			};
		}
		const restrictedSockPath = process.env.OMP_SECRET_RESTRICTED_SSH_SOCK;
		const result = await hardenedSpawn({
			command: params.command,
			args: params.args,
			envSecrets: { [params.envKey]: value },
			cwd: params.cwd,
			timeoutMs: params.timeoutMs,
			...(restrictedSockPath ? { sshAuthSock: restrictedSockPath } : {}),
		});
		const stdout = scrubOutput(result.stdout, this.#resolvedSecrets);
		const stderr = scrubOutput(result.stderr, this.#resolvedSecrets);
		return { exitCode: result.exitCode, stdout, stderr };
	}
	
}
