import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { isDefaultModelAlias, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const haiku: Model<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const sonnet: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const gpt4o: Model<"anthropic-messages"> = {
	id: "gpt-4o",
	name: "GPT-4o",
	api: "anthropic-messages",
	provider: "openai",
	baseUrl: "https://api.openai.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const allModels = [haiku, sonnet, gpt4o];

function mockRegistry(models: Model<"anthropic-messages">[]): ModelRegistry {
	return { getAvailable: () => models } as unknown as ModelRegistry;
}

// ---------------------------------------------------------------------------
// isDefaultModelAlias
// ---------------------------------------------------------------------------

describe("isDefaultModelAlias", () => {
	test("undefined is a default alias", () => {
		expect(isDefaultModelAlias(undefined)).toBe(true);
	});

	test("empty string is a default alias", () => {
		expect(isDefaultModelAlias("")).toBe(true);
	});

	test('"default" is a default alias', () => {
		expect(isDefaultModelAlias("default")).toBe(true);
	});

	test('"pi/default" is a default alias', () => {
		expect(isDefaultModelAlias("pi/default")).toBe(true);
	});

	test("concrete model id is not a default alias", () => {
		expect(isDefaultModelAlias("claude-sonnet-4-5")).toBe(false);
	});

	test("provider-prefixed model id is not a default alias", () => {
		expect(isDefaultModelAlias("anthropic/claude-haiku-4-5")).toBe(false);
	});

	test('"pi/smol" is not a default alias (only pi/default is)', () => {
		expect(isDefaultModelAlias("pi/smol")).toBe(false);
	});

	test("array of all default aliases is a default alias", () => {
		expect(isDefaultModelAlias(["default", "pi/default"])).toBe(true);
	});

	test("array with any non-default entry is not a default alias", () => {
		expect(isDefaultModelAlias(["default", "claude-sonnet-4-5"])).toBe(false);
	});

	test("empty array is a default alias (vacuous truth)", () => {
		expect(isDefaultModelAlias([])).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// resolveModelOverride
// ---------------------------------------------------------------------------

describe("resolveModelOverride", () => {
	test("empty pattern list returns no model", () => {
		const result = resolveModelOverride([], mockRegistry(allModels));
		expect(result.model).toBeUndefined();
		expect(result.thinkingLevel).toBeUndefined();
	});

	test('"default" pattern is skipped — falls through to no match', () => {
		const result = resolveModelOverride(["default"], mockRegistry(allModels));
		expect(result.model).toBeUndefined();
	});

	test('"pi/default" pattern is skipped — falls through to no match', () => {
		const result = resolveModelOverride(["pi/default"], mockRegistry(allModels));
		expect(result.model).toBeUndefined();
	});

	test("exact model id resolves to the correct model", () => {
		const result = resolveModelOverride(["claude-haiku-4-5"], mockRegistry(allModels));
		expect(result.model?.id).toBe("claude-haiku-4-5");
		expect(result.model?.provider).toBe("anthropic");
		expect(result.thinkingLevel).toBeUndefined();
	});

	test("provider-prefixed pattern resolves to correct provider", () => {
		const result = resolveModelOverride(["openai/gpt-4o"], mockRegistry(allModels));
		expect(result.model?.id).toBe("gpt-4o");
		expect(result.model?.provider).toBe("openai");
	});

	test("first matching pattern wins — subsequent patterns ignored", () => {
		// haiku comes before sonnet in the pattern list; haiku should be returned
		const result = resolveModelOverride(["claude-haiku-4-5", "claude-sonnet-4-5"], mockRegistry(allModels));
		expect(result.model?.id).toBe("claude-haiku-4-5");
	});

	test("skips non-matching patterns and returns first match", () => {
		// "nonexistent" won't match; should fall through to sonnet
		const result = resolveModelOverride(["nonexistent-model", "claude-sonnet-4-5"], mockRegistry(allModels));
		expect(result.model?.id).toBe("claude-sonnet-4-5");
	});

	test("pattern with thinking level extracts both model and level", () => {
		const result = resolveModelOverride(["claude-sonnet-4-5:high"], mockRegistry(allModels));
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("high");
	});

	test("thinking level off is normalized to undefined", () => {
		// :off means no thinking — resolveModelOverride converts it to undefined
		const result = resolveModelOverride(["claude-sonnet-4-5:off"], mockRegistry(allModels));
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBeUndefined();
	});

	test("no models available — all patterns fail to match", () => {
		const result = resolveModelOverride(["claude-haiku-4-5"], mockRegistry([]));
		expect(result.model).toBeUndefined();
	});

	test("default alias followed by real model — default skipped, real returned", () => {
		const result = resolveModelOverride(["pi/default", "claude-haiku-4-5"], mockRegistry(allModels));
		expect(result.model?.id).toBe("claude-haiku-4-5");
	});
});
