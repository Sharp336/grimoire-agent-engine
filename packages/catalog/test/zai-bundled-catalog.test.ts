import { describe, expect, it } from "bun:test";
import modelsJson from "../src/models.json";

interface BundledModel {
	api: string;
	provider: string;
	baseUrl: string;
	name: string;
	input: string[];
	reasoning: boolean;
	contextWindow: number | null;
	maxTokens: number | null;
	thinking: { mode: string; efforts: string[]; defaultLevel?: string; requiresEffort?: boolean };
}

describe("zai bundled catalog", () => {
	it("pins glm-5.2 base entry to 1M context", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.2"];

		expect(model).toBeDefined();
		expect(model.provider).toBe("zai");
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(Object.keys(zaiModels)).not.toContain("glm-5.2[1m]");
	});

	it("bundles the curated glm-5.3-flash reference with full metadata", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.3-flash"];

		expect(model).toBeDefined();
		expect(model.provider).toBe("zai");
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(model.name).toBe("GLM-5.3-Flash");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.thinking).toEqual({
			mode: "anthropic-budget-effort",
			efforts: ["low", "high", "max"],
			defaultLevel: "max",
			requiresEffort: true,
		});
	});
});
