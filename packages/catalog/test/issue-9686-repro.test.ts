import { describe, expect, it } from "bun:test";
import { buildAnthropicCompat } from "../src/compat/anthropic";
import type { ModelSpec } from "../src/types";

function spec(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): ModelSpec<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "custom-bedrock-proxy",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...overrides,
	} as ModelSpec<"anthropic-messages">;
}

describe("issue #9686 — Anthropic compat supportsContextManagement", () => {
	it("defaults supportsContextManagement to true", () => {
		const compat = buildAnthropicCompat(spec());
		expect(compat.supportsContextManagement).toBe(true);
	});

	it("honors explicit compat.supportsContextManagement: false", () => {
		const compat = buildAnthropicCompat(spec({ compat: { supportsContextManagement: false } }));
		expect(compat.supportsContextManagement).toBe(false);
	});

	it("honors explicit compat.supportsContextManagement: true", () => {
		const compat = buildAnthropicCompat(spec({ compat: { supportsContextManagement: true } }));
		expect(compat.supportsContextManagement).toBe(true);
	});
});
