/**
 * Tier-2 Secret Broker — type contracts.
 *
 * The goal of these types is to make raw secret values unrepresentable in any
 * type the agent can observe (F15). The agent only ever sees a {@link SecretHandle};
 * a {@link SecretValue} is internal to the broker and is never returned across the
 * broker boundary. The only return type that crosses back to the agent is
 * {@link ExecResult}, whose `stdout`/`stderr` are scrubbed by the broker before
 * return.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Handles + values
// ═══════════════════════════════════════════════════════════════════════════

/** A handle to a secret — the only form the agent ever sees. */
export interface SecretHandle {
	/** Provider backend: "bitwarden" | "infisical" | "ephemeral" */
	provider: string;
	/** Item ID in the provider's namespace (e.g., Bitwarden item UUID). */
	itemId: string;
	/** Optional field name (e.g., "password", "username", "totp"). */
	field?: string;
}

/**
 * A resolved secret value — NEVER returned to the agent. Internal to the broker.
 * The broker resolves a {@link SecretHandle} into this, injects `value` into a
 * subprocess env, then discards it; only scrubbed {@link ExecResult} leaves the
 * broker.
 */
export interface SecretValue {
	handle: SecretHandle;
	value: string;
	/** Optional expiry epoch (ms). Providers may set a TTL for cached resolutions. */
	expiresAt?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider interface
// ═══════════════════════════════════════════════════════════════════════════

/** VaultProvider interface — pluggable adapter for password managers. */
export interface VaultProvider {
	readonly name: string;
	/**
	 * Resolve a handle to a raw value. Fail-closed (R2): throw on resolution
	 * failure — never return a partial or empty value that the caller might
	 * mistake for a real secret.
	 */
	resolve(handle: SecretHandle): Promise<SecretValue>;
	/** Check if the provider is available (e.g., `bw` CLI is installed and unlocked). */
	isAvailable(): Promise<boolean>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Broker return types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of `run_with_secret` — the ONLY type returned to the agent.
 * `stdout`/`stderr` are scrubbed by the broker: known secret values are replaced
 * with `[REDACTED]` before this struct leaves the broker. No field here can carry
 * a raw secret value.
 */
export interface ExecResult {
	exitCode: number;
	/** Scrubbed stdout — known secret values replaced with [REDACTED]. */
	stdout: string;
	/** Scrubbed stderr — known secret values replaced with [REDACTED]. */
	stderr: string;
}

/** Result of a `rotate_password` capability (Tier-3 full impl; stub type for Tier-2). */
export interface RotateResult {
	itemId: string;
	ok: boolean;
	reasonCode?: string;
}
