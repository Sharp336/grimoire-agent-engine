/**
 * Cache identity primitives.
 *
 * A cache identity names a *physical* provider cache entry, never a session: it is
 * derived only from what the provider itself matches on, so the same identity can
 * outlive many turns and one session can depend on several identities (model
 * switch, side channel, subagent).
 *
 * Output-shaping fields (`max_tokens`, `stream`, request timeout) are deliberately
 * excluded — a bounded keepalive touch differs from the request that created the
 * entry in exactly those fields and must still resolve to the same identity.
 *
 * `historyHash` is part of the identity because every provider we cache against
 * places its trailing breakpoint inside the message array — Anthropic on the last
 * two messages (`providers/anthropic.ts:3208-3219`), Bedrock on the final user
 * block (`providers/amazon-bedrock.ts:965-971`) — so the cached region ends in the
 * conversation. Two consecutive turns share everything else and differ only in
 * history; without it they collide.
 *
 * Digests are sha256 hex rather than `Bun.hash`: these values are persisted and
 * compared across processes, so they need a wide, stable, collision-resistant
 * digest instead of a 64-bit in-process hash.
 */

import * as nodeCrypto from "node:crypto";
import type { CacheIdentity, RouteProfileKey } from "./types";

/** Domain tag so an identity digest can never equal a route digest over the same strings. */
const IDENTITY_DOMAIN = "omp/cache-identity/v1";
/** Domain tag for the coarse route-profile digest. */
const ROUTE_DOMAIN = "omp/cache-route-profile/v1";

/**
 * Normalize a provider base URL to `origin + pathname`.
 *
 * The path is KEPT: a provider's cache scope can differ per path (a gateway route,
 * an API version, a deployment name), so two base URLs on one host are not
 * interchangeable. Query and fragment are dropped (they carry per-request state),
 * the host is lowercased, and a single trailing `/` is stripped so
 * `https://h/v1/` and `https://h/v1` agree.
 *
 * A bare host with no scheme is retried once with `https://`. Empty or unparseable
 * input returns `""`; this never throws.
 */
export function normalizeEndpoint(baseUrl: string | undefined): string {
	const raw = baseUrl?.trim();
	if (!raw) return "";
	// Retry with a scheme only when the input carries none; otherwise a malformed URL
	// such as `http://` would be reinterpreted as the host `http`.
	const candidates = raw.includes("://") ? [raw] : [raw, `https://${raw}`];
	for (const candidate of candidates) {
		let url: URL;
		try {
			url = new URL(candidate);
		} catch {
			continue;
		}
		const host = url.host.toLowerCase();
		// Opaque schemes (`data:`, `mailto:`) have no host and cannot name an endpoint.
		if (host.length === 0) continue;
		const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
		return `${url.protocol.toLowerCase()}//${host}${path}`;
	}
	return "";
}

/**
 * Canonical, injective string encoding of a JSON-serializable value.
 *
 * Every primitive carries a type tag so `null`, `undefined`, the string `"null"`,
 * the number `0` and `false` cannot collide, and every variable-length piece is
 * length-prefixed so concatenation is unambiguous.
 */
function canonicalStructure(value: unknown): string {
	if (value === null) return "z";
	switch (typeof value) {
		case "undefined":
			return "u";
		case "boolean":
			return value ? "bt" : "bf";
		case "number": {
			// `String` keeps NaN/Infinity distinguishable; -0 canonicalizes to "0" like JSON.
			const text = String(value);
			return `n${text.length}:${text}`;
		}
		case "bigint": {
			const text = String(value);
			return `g${text.length}:${text}`;
		}
		case "string":
			return `s${value.length}:${value}`;
		case "object": {
			if (Array.isArray(value)) {
				// Array order is semantic (tool order is part of cache identity): never sort.
				let out = `a${value.length}:`;
				for (const item of value) {
					const encoded = canonicalStructure(item);
					out += `${encoded.length}:${encoded}`;
				}
				return out;
			}
			const record = value as Record<string, unknown>;
			// Key order is NOT semantic: sort so serialization order cannot fabricate a diff.
			const keys = Object.keys(record).sort();
			let out = `o${keys.length}:`;
			for (const key of keys) {
				const encoded = canonicalStructure(record[key]);
				out += `${key.length}:${key}${encoded.length}:${encoded}`;
			}
			return out;
		}
		default:
			// Functions and symbols have no stable serialization; tag them and drop the value.
			return "x";
	}
}

/**
 * Stable digest of a JSON-serializable value: object keys are sorted recursively so
 * key order cannot fabricate a difference, while array order is preserved because
 * tool order is part of cache identity.
 *
 * For *semantic* structures only (system blocks, tool schemas). MUST NOT be used
 * for message history — history is order-sensitive at every level and a
 * key-sorting hash would happily equate two different conversations; use
 * {@link orderedHash} there.
 */
export function structuralHash(value: unknown): string {
	return nodeCrypto.createHash("sha256").update(canonicalStructure(value), "utf8").digest("hex");
}

/**
 * Order-sensitive digest of an ordered list of wire chunks — the history primitive.
 *
 * Message order is semantic, so this never sorts. Each part is framed with its
 * UTF-8 byte length so the concatenation is injective: `["ab", "c"]` and
 * `["a", "bc"]` produce different digests where a naive join would collide.
 */
export function orderedHash(parts: readonly string[]): string {
	const hash = nodeCrypto.createHash("sha256");
	for (const part of parts) hash.update(`${Buffer.byteLength(part, "utf8")}:${part}`, "utf8");
	return hash.digest("hex");
}

/**
 * Digest of ALL TEN {@link CacheIdentity} fields in a fixed declared order.
 *
 * This identifies one physical cache entry. Adding or removing a field changes
 * every persisted fingerprint, so the domain tag is versioned.
 */
export function cacheFingerprint(identity: CacheIdentity): string {
	return orderedHash([
		IDENTITY_DOMAIN,
		identity.provider,
		identity.api,
		identity.modelId,
		identity.endpoint,
		identity.authScope,
		identity.promptCacheKey,
		identity.systemHash,
		identity.toolsHash,
		identity.historyHash,
		identity.retention,
	]);
}

/**
 * Coarse aggregation key for learned TTL and latency.
 *
 * Deliberately EXCLUDES system/tools/history/promptCacheKey. Upstream cachepilot
 * keyed TTL learning on full cache identity, including a `prompt_key` derived from
 * the whole message history, so its identity turned over on every turn and no TTL
 * profile ever accumulated enough observations to pass its confidence gate (bug
 * G9). Keeping this key coarse is that fix.
 *
 * `retention` IS included: one route emits both 5m and 1h entries, whose lifetimes
 * genuinely differ, and pooling them would learn a mean describing neither.
 */
export function routeProfileKey(key: RouteProfileKey): string {
	return orderedHash([ROUTE_DOMAIN, key.provider, key.api, key.modelId, key.endpoint, key.route, key.retention]);
}
