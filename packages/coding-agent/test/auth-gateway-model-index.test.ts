import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildAuthGatewayModelIndex } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";

function createModel(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: `${provider}/${id}`,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

describe("auth-gateway model index", () => {
	test("resolves a unique bare model id", () => {
		const model = createModel("provider-a", "unique-model");
		const index = buildAuthGatewayModelIndex([model]);

		expect(index.resolveModel("unique-model")).toBe(model);
	});

	test("resolves qualified ids for both providers sharing a model id", () => {
		const first = createModel("provider-a", "shared-model");
		const second = createModel("provider-b", "shared-model");
		const index = buildAuthGatewayModelIndex([first, second]);

		expect(index.resolveModel("provider-a/shared-model")).toBe(first);
		expect(index.resolveModel("provider-b/shared-model")).toBe(second);
	});

	test("refuses a bare id after a collision remains ambiguous", () => {
		const first = createModel("provider-a", "shared-model");
		const second = createModel("provider-b", "shared-model");
		const third = createModel("provider-c", "shared-model");
		const index = buildAuthGatewayModelIndex([first, second, third]);

		expect(index.resolveModel("shared-model")).toBeUndefined();
	});

	test("lists each model once instead of once per index alias", () => {
		const unique = createModel("provider-a", "unique-model");
		const first = createModel("provider-a", "shared-model");
		const second = createModel("provider-b", "shared-model");
		const index = buildAuthGatewayModelIndex([unique, first, second]);

		expect([...index.listModels()]).toEqual([unique, first, second]);
	});
});
