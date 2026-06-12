import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { mergeDiscoveredModel } from "@oh-my-pi/pi-coding-agent/config/model-registry";

/**
 * Regression for v15.2.4 tp- key bug: when Xiaomi `tp-` token-plan keys hit
 * discovery, models came back with `baseUrl: token-plan-sgp.xiaomimimo.com/v1`,
 * but the bundled `xiaomi/*` entries in `models.json` carry the standard
 * `api.xiaomimimo.com/v1` host. The old merge forced `existing.baseUrl` over
 * the discovered value, sending stream calls to the wrong host → 401.
 */

const STANDARD = "https://api.xiaomimimo.com/v1";
const TOKEN_PLAN = "https://token-plan-sgp.xiaomimimo.com/v1";

function bundled(baseUrl: string): Model<"openai-completions"> {
	return buildModel({
		id: "mimo-v2.5",
		name: "MiMo v2.5",
		api: "openai-completions",
		provider: "xiaomi",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

describe("mergeDiscoveredModel", () => {
	test("prefers discovered baseUrl over bundled baseUrl (xiaomi tp- regression)", () => {
		const discovered = bundled(TOKEN_PLAN);
		const existing = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, existing);
		expect(merged.baseUrl).toBe(TOKEN_PLAN);
	});

	test("falls back to existing baseUrl when discovery did not supply one", () => {
		const discovered = { ...bundled(STANDARD), baseUrl: undefined as unknown as string };
		const existing = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, existing);
		expect(merged.baseUrl).toBe(STANDARD);
	});

	test("merges headers: existing first, discovered overrides per-key", () => {
		const discovered: Model<"openai-completions"> = {
			...bundled(TOKEN_PLAN),
			headers: { "x-tp": "1", "x-shared": "discovered" },
		};
		const existing: Model<"openai-completions"> = {
			...bundled(STANDARD),
			headers: { "x-bundled": "1", "x-shared": "existing" },
		};
		const merged = mergeDiscoveredModel(discovered, existing);
		expect(merged.headers).toEqual({
			"x-bundled": "1",
			"x-shared": "discovered",
			"x-tp": "1",
		});
	});

	test("provider override path: override baseUrl wins when no bundled entry", () => {
		const discovered = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, undefined, { baseUrl: TOKEN_PLAN });
		expect(merged.baseUrl).toBe(TOKEN_PLAN);
	});

	test("user providerOverride baseUrl wins over discovered baseUrl even when bundled entry exists", () => {
		const discovered = bundled(STANDARD);
		const existing = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, existing, { baseUrl: "https://my-proxy.example.com/v1" });
		expect(merged.baseUrl).toBe("https://my-proxy.example.com/v1");
	});

	test("returns model untouched when no existing entry and no override", () => {
		const discovered = bundled(TOKEN_PLAN);
		const merged = mergeDiscoveredModel(discovered, undefined);
		expect(merged).toEqual(discovered);
	});

	test("provider override transport survives when a bundled/existing entry matches", () => {
		// Regression: unauthenticated-discoverable providers (OpenRouter, Kilo,
		// Vercel AI Gateway) replace bundled entries via the `existing` branch on
		// refresh. That branch used to drop the provider-level `transport`
		// override, so a `models.json` `transport: pi-native` pin was silently
		// lost and stream calls fell back to per-API dispatch → `POST
		// {baseUrl}/chat/completions` at a gateway that only serves
		// `/v1/pi/stream` → 404 "No route: POST /chat/completions".
		const discovered = bundled(STANDARD);
		const existing = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, existing, {
			baseUrl: "http://localhost:4000",
			transport: "pi-native",
		});
		expect(merged.transport).toBe("pi-native");
		expect(merged.baseUrl).toBe("http://localhost:4000");
	});

	test("provider override transport applies when no bundled entry exists", () => {
		const discovered = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, undefined, {
			baseUrl: "http://localhost:4000",
			transport: "pi-native",
		});
		expect(merged.transport).toBe("pi-native");
		expect(merged.baseUrl).toBe("http://localhost:4000");
	});

	test("existing model transport is left untouched when override omits transport", () => {
		const discovered = bundled(STANDARD);
		const existing = bundled(STANDARD);
		const merged = mergeDiscoveredModel(discovered, existing, { baseUrl: TOKEN_PLAN });
		expect(merged.transport).toBeUndefined();
	});
});
