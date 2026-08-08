import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { applyDeepSeekV4BuiltinPolicy } from "@oh-my-pi/pi-catalog/provider-models/deepseek-policy";
import { DEFAULT_MODEL_PER_PROVIDER, getCatalogProviderEntry } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { deepseekModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const V4_IDS = ["deepseek-v4-pro", "deepseek-v4-flash"] as const;

function staleDeepSeekSpec(id: (typeof V4_IDS)[number]): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		thinking: {
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: {
				[Effort.Low]: "high",
				[Effort.High]: "max",
			},
		},
		compat: {
			supportsDeveloperRole: true,
			supportsToolChoice: true,
			maxTokensField: "max_completion_tokens",
			reasoningEffortMap: {
				[Effort.Low]: "high",
				[Effort.High]: "max",
			},
			extraBody: { thinking: { type: "enabled" } },
		},
	};
}

function expectDeepSeekV4Contract(model: Model<"openai-completions">): void {
	expect(model.api).toBe("openai-completions");
	expect(model.provider).toBe("deepseek");
	expect(model.baseUrl).toBe("https://api.deepseek.com");
	expect(model.reasoning).toBe(true);
	expect(model.input).toEqual(["text"]);
	expect(model.contextWindow).toBe(1_000_000);
	expect(model.maxTokens).toBe(384_000);

	const compat = model.compat;
	expect(compat.supportsDeveloperRole).toBe(false);
	expect(compat.supportsReasoningEffort).toBe(true);
	expect(compat.maxTokensField).toBe("max_tokens");
	expect(compat.supportsToolChoice).toBe(false);
	expect(compat.reasoningContentField).toBe("reasoning_content");
	expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	expect(compat.requiresReasoningContentForAllAssistantTurns).toBe(true);
	expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
	expect(compat.requiresAssistantContentForToolCalls).toBe(true);
	expect(compat.extraBody).toBeUndefined();
	expect(compat.whenThinking?.extraBody).toEqual({ thinking: { type: "enabled" } });
	expect(model.thinking?.effortMap).toBeUndefined();
}

describe("DeepSeek first-party provider", () => {
	test("uses V4 Flash as the first-party default", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER.deepseek).toBe("deepseek-v4-flash");
		expect(getCatalogProviderEntry("deepseek")?.defaultModel).toBe("deepseek-v4-flash");
	});

	test("repairs stale generated metadata and aliases without changing pricing", () => {
		for (const id of V4_IDS) {
			const stale = staleDeepSeekSpec(id);
			const normalized = applyDeepSeekV4BuiltinPolicy("deepseek", id, stale);
			const model = buildModel(normalized) as Model<"openai-completions">;

			expect(normalized.thinking).toBeUndefined();
			expect(model.cost).toEqual(stale.cost);
			expectDeepSeekV4Contract(model);
		}
	});

	test("does not rewrite non-V4 or non-first-party models", () => {
		const stale = staleDeepSeekSpec("deepseek-v4-pro");
		expect(applyDeepSeekV4BuiltinPolicy("openrouter", stale.id, stale)).toBe(stale);
		expect(applyDeepSeekV4BuiltinPolicy("deepseek", "deepseek-chat", stale)).toBe(stale);
	});

	test("bundled Pro and Flash models expose the authoritative contract", () => {
		for (const id of V4_IDS) {
			const model = getBundledModel("deepseek", id) as Model<"openai-completions">;
			expectDeepSeekV4Contract(model);
		}

		const pro = getBundledModel("deepseek", "deepseek-v4-pro") as Model<"openai-completions">;
		expect(pro.thinking?.efforts).toEqual([Effort.High, Effort.Max]);

		const flash = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
		expect(flash.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	test("sparse live discovery inherits bundled V4 limits and compatibility", async () => {
		const seen: { url?: string; authorization?: string } = {};
		const stubFetch: FetchImpl = async (input, init) => {
			seen.url = String(input);
			seen.authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
			return new Response(
				JSON.stringify({
					object: "list",
					data: V4_IDS.map(id => ({ id, object: "model", owned_by: "deepseek" })),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = deepseekModelManagerOptions({ apiKey: "sk-test", fetch: stubFetch });
		const discovered = await options.fetchDynamicModels?.();

		expect(seen.url).toBe("https://api.deepseek.com/models");
		expect(seen.authorization).toBe("Bearer sk-test");
		expect(discovered?.map(model => model.id)).toEqual([...V4_IDS].sort());

		for (const spec of discovered ?? []) {
			expectDeepSeekV4Contract(buildModel(spec) as Model<"openai-completions">);
		}
	});

	test("custom discovery base URL remains a runtime override", async () => {
		const seen: string[] = [];
		const stubFetch: FetchImpl = async input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = deepseekModelManagerOptions({
			apiKey: "sk-test",
			baseUrl: "https://proxy.example/deepseek",
			fetch: stubFetch,
		});
		const discovered = await options.fetchDynamicModels?.();

		expect(seen).toEqual(["https://proxy.example/deepseek/models"]);
		expect(discovered?.[0]?.baseUrl).toBe("https://proxy.example/deepseek");
	});
});
