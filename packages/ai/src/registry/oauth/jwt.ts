/**
 * Unsigned JWT payload access, in one place.
 *
 * Six OAuth descriptors used to decode `exp` themselves, across three
 * strategies: `atob` plus a manual URL-safe unescape, `base64url`, and plain
 * `base64`. All three worked — Bun's `base64` decoder accepts the URL-safe
 * alphabet, and the `atob` callers unescaped first because bare `atob` throws
 * on `-`/`_` — so this consolidation preserves behavior rather than fixing a
 * decode bug. What it removes is six copies of the same parse, and six
 * independently drifting answers to "what does a token with no readable `exp`
 * mean". The decode is the protocol and lives here; that fallback is provider
 * policy and stays with each caller.
 *
 * Signatures are deliberately NOT verified: these tokens come from a
 * credential the caller already holds, and are read only to schedule refresh.
 */

/** Clock skew subtracted from `exp` so refresh lands before real expiry. */
export const JWT_EXPIRY_SKEW_MS = 5 * 60_000;

/**
 * Decode a JWT's payload segment. Returns `null` for anything that is not a
 * three-segment token with a JSON object payload — including the opaque
 * non-JWT credentials several providers legitimately issue.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	if (typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const payload = parts[1];
	if (!payload) return null;
	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
		return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
			? (decoded as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function expSeconds(token: string): number | undefined {
	const exp = decodeJwtPayload(token)?.exp;
	return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
}

/**
 * Absolute refresh deadline in epoch milliseconds, skew applied. `undefined`
 * means the token stated no usable expiry; the caller decides what that means
 * for its provider.
 */
export function jwtExpiryMs(token: string, skewMs = JWT_EXPIRY_SKEW_MS): number | undefined {
	const exp = expSeconds(token);
	return exp === undefined ? undefined : exp * 1000 - skewMs;
}

/**
 * Whether the token expires within `thresholdSeconds`. A token with no
 * readable `exp` counts as expiring: callers use this to decide whether to
 * refresh, and refreshing an opaque token is the safe direction.
 */
export function isJwtExpiringWithin(token: string, thresholdSeconds: number): boolean {
	const exp = expSeconds(token);
	if (exp === undefined) return true;
	return exp - Math.floor(Date.now() / 1000) < thresholdSeconds;
}
