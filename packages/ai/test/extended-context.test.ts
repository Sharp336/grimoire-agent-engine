import { describe, expect, it } from "bun:test";
import type { Model } from "../src/types";
import {
	applyExtendedContext,
	extendedContextSuffix,
	hasExtendedContextAccess,
	isExtendedContext,
	resetOverageCache,
	supportsExtendedContext,
	updateOverageDisabledReason,
} from "../src/utils/extended-context";

function makeModel(overrides: Partial<Model> = {}): Model {
	return {
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		...overrides,
	};
}

describe("supportsExtendedContext", () => {
	it("returns true when extendedContextWindow is set", () => {
		const model = makeModel({ extendedContextWindow: 1_000_000 });
		expect(supportsExtendedContext(model)).toBe(true);
	});

	it("returns false when extendedContextWindow is undefined", () => {
		const model = makeModel();
		expect(supportsExtendedContext(model)).toBe(false);
	});

	it("returns false when extendedContextWindow is null", () => {
		const model = makeModel({ extendedContextWindow: null as unknown as undefined });
		expect(supportsExtendedContext(model)).toBe(false);
	});
});

describe("isExtendedContext", () => {
	it("returns true when contextWindow >= extendedContextWindow", () => {
		const model = makeModel({ contextWindow: 1_000_000, extendedContextWindow: 1_000_000 });
		expect(isExtendedContext(model)).toBe(true);
	});

	it("returns false when contextWindow < extendedContextWindow", () => {
		const model = makeModel({ contextWindow: 200_000, extendedContextWindow: 1_000_000 });
		expect(isExtendedContext(model)).toBe(false);
	});

	it("returns false when extendedContextWindow is undefined", () => {
		const model = makeModel();
		expect(isExtendedContext(model)).toBe(false);
	});
});

describe("extendedContextSuffix", () => {
	it("returns [1m] for 1M tokens", () => {
		const model = makeModel({ extendedContextWindow: 1_000_000 });
		expect(extendedContextSuffix(model)).toBe("[1m]");
	});

	it("returns [500k] for 500K tokens", () => {
		const model = makeModel({ extendedContextWindow: 500_000 });
		expect(extendedContextSuffix(model)).toBe("[500k]");
	});

	it("returns [2m] for 2M tokens", () => {
		const model = makeModel({ extendedContextWindow: 2_000_000 });
		expect(extendedContextSuffix(model)).toBe("[2m]");
	});

	it("returns [128k] for 128K tokens", () => {
		const model = makeModel({ extendedContextWindow: 128_000 });
		expect(extendedContextSuffix(model)).toBe("[128k]");
	});

	it("returns [1500k] for non-integer million (1.5M tokens)", () => {
		const model = makeModel({ extendedContextWindow: 1_500_000 });
		expect(extendedContextSuffix(model)).toBe("[1500k]");
	});

	it("returns empty string when extendedContextWindow is undefined", () => {
		const model = makeModel();
		expect(extendedContextSuffix(model)).toBe("");
	});
});

describe("applyExtendedContext", () => {
	it("sets contextWindow and appends name tag when extendedContext is true", () => {
		const model = makeModel({ extendedContextWindow: 1_000_000 });
		const result = applyExtendedContext(model, true);
		expect(result.contextWindow).toBe(1_000_000);
		expect(result.name).toBe("Claude Opus 4.6 [1M]");
	});

	it("returns original model when extendedContext is false", () => {
		const model = makeModel({ extendedContextWindow: 1_000_000 });
		const result = applyExtendedContext(model, false);
		expect(result).toBe(model);
	});

	it("returns original model when extendedContextWindow is undefined", () => {
		const model = makeModel();
		const result = applyExtendedContext(model, true);
		expect(result).toBe(model);
	});

	it("does not double-append name tag if already present", () => {
		const model = makeModel({ name: "Claude Opus 4.6 [1M]", extendedContextWindow: 1_000_000 });
		const result = applyExtendedContext(model, true);
		expect(result.name).toBe("Claude Opus 4.6 [1M]");
		expect(result.contextWindow).toBe(1_000_000);
	});

	it("appends uppercase [500K] tag for 500K extended context", () => {
		const model = makeModel({ extendedContextWindow: 500_000 });
		const result = applyExtendedContext(model, true);
		expect(result.contextWindow).toBe(500_000);
		expect(result.name).toBe("Claude Opus 4.6 [500K]");
	});
});

describe("hasExtendedContextAccess", () => {
	// Reset cache between tests
	it("API key users always have access", () => {
		resetOverageCache();
		expect(hasExtendedContextAccess(false)).toBe(true);
	});

	it("OAuth users denied before first API call (cache undefined)", () => {
		resetOverageCache();
		expect(hasExtendedContextAccess(true)).toBe(false);
	});

	it("OAuth users allowed when no restriction (header absent = null)", () => {
		resetOverageCache();
		updateOverageDisabledReason({});
		expect(hasExtendedContextAccess(true)).toBe(true);
	});

	it("OAuth users allowed when out_of_credits", () => {
		resetOverageCache();
		updateOverageDisabledReason({ "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits" });
		expect(hasExtendedContextAccess(true)).toBe(true);
	});

	it("OAuth users denied for blocking reasons", () => {
		const blockingReasons = [
			"overage_not_provisioned",
			"org_level_disabled",
			"seat_tier_level_disabled",
			"member_level_disabled",
			"no_limits_configured",
			"unknown",
		];
		for (const reason of blockingReasons) {
			resetOverageCache();
			updateOverageDisabledReason({ "anthropic-ratelimit-unified-overage-disabled-reason": reason });
			expect(hasExtendedContextAccess(true)).toBe(false);
		}
	});

	it("API key users unaffected by blocking reasons", () => {
		resetOverageCache();
		updateOverageDisabledReason({ "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled" });
		expect(hasExtendedContextAccess(false)).toBe(true);
	});
});
