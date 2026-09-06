import { describe, expect, it } from "bun:test";
import {
	resolveCanonicalModelLimits,
	resolveExecutableModelLimits,
} from "@oh-my-pi/pi-coding-agent/engine/model-limits";

describe("Engine provider model limits", () => {
	it("resolves accepted exact identities through the canonical bundled catalog", () => {
		expect(resolveCanonicalModelLimits("gpt-5.6-terra")).toMatchObject({
			contextWindow: 1_050_000,
			maxOutputTokens: 128_000,
		});
		expect(resolveCanonicalModelLimits("openai.gpt-5.6-terra")).toMatchObject({
			contextWindow: 272_000,
			maxOutputTokens: 128_000,
			referenceProvider: "bedrock-mantle",
		});
		expect(resolveCanonicalModelLimits("claude-opus-5")).toMatchObject({
			contextWindow: 1_000_000,
			maxOutputTokens: 128_000,
		});
		expect(resolveCanonicalModelLimits("claude-sonnet-5")).toMatchObject({
			contextWindow: 1_000_000,
			maxOutputTokens: 128_000,
		});
	});

	it("preserves explicit limits and rejects unknown incomplete models", () => {
		expect(
			resolveExecutableModelLimits({
				modelIdentityId: "private-provider/custom-model",
				contextWindow: 272_000,
				maxOutputTokens: 32_000,
			}),
		).toEqual({ contextWindow: 272_000, maxOutputTokens: 32_000 });
		expect(() => resolveExecutableModelLimits({ modelIdentityId: "private-provider/custom-model" })).toThrow(
			"model limits are unknown",
		);
		expect(() =>
			resolveExecutableModelLimits({
				modelIdentityId: "gpt-5.6-terra",
				contextWindow: 0,
			}),
		).toThrow("model.contextWindow must be a positive integer");
	});
});
