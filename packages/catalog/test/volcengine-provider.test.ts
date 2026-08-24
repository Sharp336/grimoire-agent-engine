import { describe, expect, test } from "bun:test";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	VOLCENGINE_STATIC_MODELS,
	volcengineModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import modelsJson from "../src/models.json";

const BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * Verbatim rows from `GET https://ark.cn-beijing.volces.com/api/v3/models`
 * (captured 2026-08-24 with a live ARK API key), trimmed to the fields the
 * mapper reads. Ark returns its full historical catalog and marks dead SKUs
 * with `status`, so the fixture keeps one row of every shape discovery must
 * handle.
 */
const ARK_MODELS_FIXTURE = {
	data: [
		{
			created: 1_782_000_000,
			domain: "VLM",
			features: { tools: { function_calling: true } },
			id: "doubao-seed-2-1-turbo-260628",
			modalities: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
			name: "doubao-seed-2-1-turbo",
			object: "model",
			task_type: ["VisualQuestionAnswering", "TextGeneration"],
			token_limits: {
				context_window: 262_144,
				max_input_token_length: 262_144,
				max_output_token_length: 262_144,
				max_reasoning_token_length: 262_144,
			},
			version: "260628",
		},
		{
			created: 1_780_000_000,
			domain: "LLM",
			features: {},
			id: "doubao-seed-translation-250915",
			modalities: { input_modalities: ["text"], output_modalities: ["text"] },
			name: "doubao-seed-translation",
			object: "model",
			task_type: ["TextGeneration"],
			token_limits: { context_window: 4096, max_input_token_length: 1024, max_output_token_length: 3072 },
			version: "250915",
		},
		{
			created: 1_756_904_544,
			domain: "",
			features: { tools: { function_calling: true } },
			id: "glm-4-5-air-20250728",
			modalities: {},
			name: "glm-4-5-air",
			object: "model",
			token_limits: {},
			version: "20250728",
		},
		{
			created: 1_714_982_195,
			domain: "",
			features: {},
			id: "doubao-lite-128k-240428",
			name: "doubao-lite-128k",
			object: "model",
			status: "Shutdown",
			version: "240428",
		},
		{
			created: 1_715_588_483,
			domain: "Embedding",
			features: {},
			id: "doubao-embedding-text-240515",
			modalities: { input_modalities: ["text"] },
			name: "doubao-embedding",
			object: "model",
			status: "Retiring",
			task_type: ["TextEmbedding"],
			version: "240515",
		},
		{
			created: 1_749_465_881,
			domain: "VideoGeneration",
			features: {},
			id: "doubao-seedance-1-0-pro-250528",
			modalities: { input_modalities: ["text"], output_modalities: ["video"] },
			name: "doubao-seedance-1-0-pro",
			object: "model",
			task_type: ["TextToVideo"],
			version: "250528",
		},
	],
};

function fixtureFetch(): typeof globalThis.fetch {
	return (async () =>
		new Response(JSON.stringify(ARK_MODELS_FIXTURE), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof globalThis.fetch;
}

describe("Volcengine Ark provider", () => {
	test("descriptor and static seed agree on the default model", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "volcengine");
		expect(descriptor).toMatchObject({
			defaultModel: "doubao-seed-2-1-pro-260628",
			envVars: ["ARK_API_KEY"],
			dynamicModelsAuthoritative: true,
		});
		expect(VOLCENGINE_STATIC_MODELS.map(model => model.id)).toContain("doubao-seed-2-1-pro-260628");
		// A regen without ARK_API_KEY must still bundle the default, or the
		// provider is selectable with no resolvable model before discovery.
		expect(modelsJson.volcengine["doubao-seed-2-1-pro-260628"]).toBeDefined();
	});

	test("discovery keeps live chat SKUs and drops retired and non-chat rows", async () => {
		const options = volcengineModelManagerOptions({ apiKey: "test-key", fetch: fixtureFetch() });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const ids = models.map(model => model.id);

		expect(ids).toContain("doubao-seed-2-1-turbo-260628");
		expect(ids).toContain("doubao-seed-translation-250915");
		// `glm-4-5-air-20250728` carries no `task_type`/`token_limits`, only a
		// `features.tools` block — the shape that must not be dropped.
		expect(ids).toContain("glm-4-5-air-20250728");
		// Ark keeps retired SKUs in the listing; they 404 on invocation.
		expect(ids).not.toContain("doubao-lite-128k-240428");
		expect(ids).not.toContain("doubao-embedding-text-240515");
		// Video/image SKUs answer on their own endpoints, not /chat/completions.
		expect(ids).not.toContain("doubao-seedance-1-0-pro-250528");
	});

	test("discovery maps Ark's token_limits and modalities", async () => {
		const options = volcengineModelManagerOptions({ apiKey: "test-key", fetch: fixtureFetch() });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const turbo = models.find(model => model.id === "doubao-seed-2-1-turbo-260628");
		expect(turbo).toMatchObject({
			provider: "volcengine",
			api: "openai-completions",
			baseUrl: BASE_URL,
			contextWindow: 262_144,
			maxTokens: 262_144,
			reasoning: true,
		});
		expect(turbo?.input).toEqual(["text", "image"]);
		// Ark bills in CNY and publishes no USD tariff; rates stay unset rather
		// than converted at an arbitrary rate.
		expect(turbo?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		// No `max_reasoning_token_length` ⇒ not a reasoning SKU.
		const translation = models.find(model => model.id === "doubao-seed-translation-250915");
		expect(translation?.reasoning).toBe(false);
		expect(translation?.contextWindow).toBe(4096);
		expect(translation?.maxTokens).toBe(3072);
	});

	test("Ark models resolve the binary thinking wire contract", () => {
		// Verified against the live endpoint: `thinking: { type: "disabled" }`
		// returns `reasoning_tokens: 0` with no `reasoning_content`, and
		// `reasoning_effort` is accepted alongside it. `thinking: { type: "auto" }`
		// is rejected with InvalidParameter, so the binary z.ai-style encoding —
		// not an effort-only dialect — is the correct format here.
		const spec = modelsJson.volcengine["doubao-seed-2-1-pro-260628"] as ModelSpec<"openai-completions">;
		const compat = buildOpenAICompat(spec);
		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.reasoningDisableMode).toBe("zai-thinking-disabled");
		expect(compat.supportsReasoningEffort).toBe(true);
		// Ark accepts several system blocks; the `developer` role is rejected.
		expect(compat.supportsMultipleSystemMessages).toBe(true);
		expect(compat.supportsDeveloperRole).toBe(false);
	});
});
