import { describe, expect, it } from "bun:test";
import modelsJson from "../src/models.json";

interface BundledModel {
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number | null;
	maxTokens: number | null;
	thinking?: { mode: string; efforts: string[] };
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

	it("ships glm-5.3 with 1M context and the low/high/max ladder", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.3"];

		expect(model).toBeDefined();
		expect(model.provider).toBe("zai");
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.thinking).toEqual({ mode: "anthropic-budget-effort", efforts: ["low", "high", "max"] });
	});
});

describe("zhipu-coding-plan bundled catalog", () => {
	it("ships glm-5.3 with 1M context and the low/high/max ladder", () => {
		const zhipuModels = modelsJson["zhipu-coding-plan"] as Record<string, BundledModel>;
		const model = zhipuModels["glm-5.3"];

		expect(model).toBeDefined();
		expect(model.provider).toBe("zhipu-coding-plan");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text"]);
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.thinking).toEqual({ mode: "effort", efforts: ["low", "high", "max"] });
	});
});
