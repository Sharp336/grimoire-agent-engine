import { describe, expect, test } from "bun:test";
import {
	availableChatGptWebModelRoutes,
	CHATGPT_WEB_MODEL_ROUTES,
	createChatGptWebProviderModels,
	requireChatGptWebModelRoute,
} from "../src/models";

describe("ChatGPT Web model routes", () => {
	test("keeps bare provider ids separate from rendered selectors", () => {
		expect(CHATGPT_WEB_MODEL_ROUTES.map(route => route.key)).toEqual([
			"light",
			"medium",
			"high",
			"extra-high",
			"pro",
		]);
		expect(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug)).toEqual([
			"chatgpt-web/light",
			"chatgpt-web/medium",
			"chatgpt-web/high",
			"chatgpt-web/extra-high",
			"chatgpt-web/pro",
		]);
		expect(requireChatGptWebModelRoute("light", false).slug).toBe("chatgpt-web/light");
		expect(requireChatGptWebModelRoute("chatgpt-web/light", false).key).toBe("light");
	});

	test("maps each route to one exact effort without remote capability claims", () => {
		const models = createChatGptWebProviderModels(true, true);
		expect(models.map(model => [model.id, model.thinking])).toEqual([
			["light", { mode: "effort", efforts: ["low"], defaultLevel: "low" }],
			["medium", { mode: "effort", efforts: ["medium"], defaultLevel: "medium" }],
			["high", { mode: "effort", efforts: ["high"], defaultLevel: "high" }],
			["extra-high", { mode: "effort", efforts: ["xhigh"], defaultLevel: "xhigh" }],
			["pro", { mode: "effort", efforts: ["max"], defaultLevel: "max" }],
		]);
		for (const model of models) {
			expect(model.reasoning).toBe(true);
			expect(model.contextWindow).toBe(256_000);
			expect(model.maxTokens).toBe(64_000);
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(model.input).toEqual(["text", "image"]);
			expect(model).not.toHaveProperty("serviceTier");
			expect(model).not.toHaveProperty("preferWebsockets");
			expect(model).not.toHaveProperty("remoteCompaction");
		}
	});

	test("omits Pro until verified and only enables tools for non-Pro full mode", () => {
		expect(availableChatGptWebModelRoutes(false).some(route => route.requiresPro)).toBe(false);
		expect(createChatGptWebProviderModels(false, true).map(model => model.supportsTools)).toEqual([
			true,
			true,
			true,
			true,
		]);
		expect(createChatGptWebProviderModels(true, true).at(-1)?.supportsTools).toBe(false);
		expect(createChatGptWebProviderModels(true, false).every(model => !model.supportsTools)).toBe(true);
		expect(() => requireChatGptWebModelRoute("pro", false)).toThrow("unavailable");
	});
});
