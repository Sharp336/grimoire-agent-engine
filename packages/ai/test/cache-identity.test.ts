/**
 * Contracts for the cache identity primitives: what must change a fingerprint, what
 * must not, and which of the two keys each field belongs to.
 */

import { describe, expect, it } from "bun:test";
import {
	cacheFingerprint,
	normalizeEndpoint,
	orderedHash,
	routeProfileKey,
	structuralHash,
} from "@oh-my-pi/pi-ai/cache/identity";
import type { CacheIdentity, RouteProfileKey } from "@oh-my-pi/pi-ai/cache/types";

const baseIdentity: CacheIdentity = {
	provider: "anthropic",
	api: "anthropic-messages",
	modelId: "claude-sonnet-4-5",
	endpoint: "https://api.anthropic.com/v1",
	authScope: "auth-scope-a",
	promptCacheKey: "pck-a",
	systemHash: "system-a",
	toolsHash: "tools-a",
	historyHash: "history-a",
	retention: "short",
};

/**
 * One mutator per {@link CacheIdentity} field. A row missing here is a field the
 * fingerprint is free to ignore silently, which is exactly the class of bug that
 * makes a keepalive refresh an entry that no longer exists.
 */
const identityMutators: ReadonlyArray<readonly [keyof CacheIdentity, CacheIdentity]> = [
	["provider", { ...baseIdentity, provider: "amazon-bedrock" }],
	["api", { ...baseIdentity, api: "openai-responses" }],
	["modelId", { ...baseIdentity, modelId: "claude-opus-4-1" }],
	["endpoint", { ...baseIdentity, endpoint: "https://gateway.example.com/v1" }],
	["authScope", { ...baseIdentity, authScope: "auth-scope-b" }],
	["promptCacheKey", { ...baseIdentity, promptCacheKey: "pck-b" }],
	["systemHash", { ...baseIdentity, systemHash: "system-b" }],
	["toolsHash", { ...baseIdentity, toolsHash: "tools-b" }],
	// Two consecutive turns of ONE session share every other field and differ only
	// here, because every provider we cache against puts its trailing breakpoint
	// inside the message array. Omitting historyHash would let turn N and turn N+1
	// collide, and a keepalive would refresh an entry turn N+1 already replaced.
	["historyHash", { ...baseIdentity, historyHash: "history-b" }],
	["retention", { ...baseIdentity, retention: "long" }],
];

describe("cacheFingerprint", () => {
	it("ignores property-literal order", () => {
		// Fails if the implementation ever serializes via Object.keys/JSON insertion order.
		const reordered: CacheIdentity = {
			retention: baseIdentity.retention,
			historyHash: baseIdentity.historyHash,
			toolsHash: baseIdentity.toolsHash,
			systemHash: baseIdentity.systemHash,
			promptCacheKey: baseIdentity.promptCacheKey,
			authScope: baseIdentity.authScope,
			endpoint: baseIdentity.endpoint,
			modelId: baseIdentity.modelId,
			api: baseIdentity.api,
			provider: baseIdentity.provider,
		};
		expect(cacheFingerprint(reordered)).toBe(cacheFingerprint(baseIdentity));
	});

	it("covers all ten fields", () => {
		expect(identityMutators.length).toBe(Object.keys(baseIdentity).length);
	});

	for (const [field, mutated] of identityMutators) {
		it(`changes when ${field} changes`, () => {
			expect(cacheFingerprint(mutated)).not.toBe(cacheFingerprint(baseIdentity));
		});
	}

	it("keeps every single-field mutation distinct from every other", () => {
		// Catches ambiguous framing, where moving a character between adjacent fields
		// (provider "a"+api "bc" vs provider "ab"+api "c") yields the same digest.
		const digests = new Set([
			cacheFingerprint(baseIdentity),
			...identityMutators.map(([, mutated]) => cacheFingerprint(mutated)),
		]);
		expect(digests.size).toBe(identityMutators.length + 1);
	});

	it("is a lowercase sha256 hex digest", () => {
		// Persisted and compared across processes, so the width must not silently
		// narrow to a 64-bit Bun.hash.
		expect(cacheFingerprint(baseIdentity)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("structuralHash", () => {
	it("sorts object keys recursively", () => {
		expect(structuralHash({ a: 1, b: 2 })).toBe(structuralHash({ b: 2, a: 1 }));
		expect(structuralHash({ outer: { a: 1, b: 2 } })).toBe(structuralHash({ outer: { b: 2, a: 1 } }));
	});

	it("preserves array order", () => {
		// Tool order is part of cache identity: sorting arrays would equate two
		// different tool arrays and claim a reusable prefix that does not exist.
		expect(structuralHash([1, 2])).not.toBe(structuralHash([2, 1]));
	});

	it("distinguishes every primitive that would otherwise stringify alike", () => {
		const digests = [
			structuralHash(null),
			structuralHash(undefined),
			structuralHash("null"),
			structuralHash(0),
			structuralHash(false),
		];
		expect(new Set(digests).size).toBe(digests.length);
	});

	it("distinguishes a value from the array containing it", () => {
		expect(structuralHash("a")).not.toBe(structuralHash(["a"]));
		expect(structuralHash({ a: "b" })).not.toBe(structuralHash([["a", "b"]]));
	});
});

describe("orderedHash", () => {
	it("is order-sensitive", () => {
		expect(orderedHash(["a", "b"])).not.toBe(orderedHash(["b", "a"]));
	});

	it("frames parts unambiguously", () => {
		// A naive join with no length prefix collides on these two: both are "abc".
		expect(orderedHash(["ab", "c"])).not.toBe(orderedHash(["a", "bc"]));
	});

	it("distinguishes an empty part from a missing one", () => {
		expect(orderedHash(["a", ""])).not.toBe(orderedHash(["a"]));
	});
});

describe("normalizeEndpoint", () => {
	it("drops the query string", () => {
		expect(normalizeEndpoint("https://api.example.com/v1?key=secret")).toBe("https://api.example.com/v1");
	});

	it("drops the fragment", () => {
		expect(normalizeEndpoint("https://api.example.com/v1#frag")).toBe("https://api.example.com/v1");
	});

	it("lowercases the host", () => {
		expect(normalizeEndpoint("https://API.Example.COM/v1")).toBe("https://api.example.com/v1");
	});

	it("strips one trailing slash", () => {
		expect(normalizeEndpoint("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
		expect(normalizeEndpoint("https://api.example.com/")).toBe("https://api.example.com");
	});

	it("keeps a non-root path", () => {
		// A gateway's cache scope can differ per path, so the path is identity.
		expect(normalizeEndpoint("https://gw.example.com/openai/deployments/x")).toBe(
			"https://gw.example.com/openai/deployments/x",
		);
		expect(normalizeEndpoint("https://gw.example.com/a")).not.toBe(normalizeEndpoint("https://gw.example.com/b"));
	});

	it("retries a bare host with https", () => {
		expect(normalizeEndpoint("api.example.com/v1")).toBe("https://api.example.com/v1");
	});

	it("returns an empty string for undefined", () => {
		expect(normalizeEndpoint(undefined)).toBe("");
	});

	it("returns an empty string for an empty input", () => {
		expect(normalizeEndpoint("   ")).toBe("");
	});

	it("returns an empty string for garbage instead of throwing", () => {
		// A malformed scheme must not be salvaged into the host `http` by the
		// bare-host retry, and an unparseable string must not escape as an exception.
		expect(normalizeEndpoint("http://")).toBe("");
		expect(normalizeEndpoint("::: not a url :::")).toBe("");
	});
});

const baseRoute: RouteProfileKey = {
	provider: "anthropic",
	api: "anthropic-messages",
	modelId: "claude-sonnet-4-5",
	endpoint: "https://api.anthropic.com/v1",
	route: "us-east",
	retention: "short",
};

describe("routeProfileKey", () => {
	it("is unchanged by the fields cacheFingerprint keys on", () => {
		// This is the G9 fix: keying TTL learning on system/tools/history/promptCacheKey
		// turned the profile over every turn, so no profile ever reached its
		// confidence gate. Those fields must not reach this key at all.
		const other: RouteProfileKey & Partial<CacheIdentity> = {
			...baseRoute,
			systemHash: "system-z",
			toolsHash: "tools-z",
			historyHash: "history-z",
			promptCacheKey: "pck-z",
			authScope: "auth-scope-z",
		};
		expect(routeProfileKey(other)).toBe(routeProfileKey(baseRoute));
	});

	it("differs by route", () => {
		expect(routeProfileKey({ ...baseRoute, route: "eu-west" })).not.toBe(routeProfileKey(baseRoute));
	});

	it("differs by retention", () => {
		// A 5m entry and a 1h entry on one route have genuinely different lifetimes;
		// pooling their observations would learn a mean TTL describing neither and
		// schedule every keepalive at the wrong moment.
		expect(routeProfileKey({ ...baseRoute, retention: "long" })).not.toBe(routeProfileKey(baseRoute));
	});

	it("differs by provider, api, model and endpoint", () => {
		const digests = new Set([
			routeProfileKey(baseRoute),
			routeProfileKey({ ...baseRoute, provider: "amazon-bedrock" }),
			routeProfileKey({ ...baseRoute, api: "openai-responses" }),
			routeProfileKey({ ...baseRoute, modelId: "claude-opus-4-1" }),
			routeProfileKey({ ...baseRoute, endpoint: "https://gw.example.com/v1" }),
		]);
		expect(digests.size).toBe(5);
	});

	it("never equals the fingerprint of the identity it aggregates", () => {
		expect(routeProfileKey(baseRoute)).not.toBe(cacheFingerprint(baseIdentity));
	});
});
