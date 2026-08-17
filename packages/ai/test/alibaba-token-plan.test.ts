import { afterEach, describe, expect, test, vi } from "bun:test";
import { getBundledModels } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "../src/provider-models/descriptors";
import {
	alibabaTokenPlanModelManagerOptions,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
} from "../src/provider-models/openai-compat";

const ANTHROPIC_SURFACE_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
const ANTHROPIC_SURFACE_MODELS_URL = `${ANTHROPIC_SURFACE_BASE_URL}/v1/models`;

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("alibaba-token-plan model manager options", () => {
	test("exposes fetchDynamicModels only when an apiKey is configured", () => {
		const withKey = alibabaTokenPlanModelManagerOptions({ apiKey: "alibaba-token-plan-test-key" });
		expect(withKey.providerId).toBe("alibaba-token-plan");
		expect(withKey.fetchDynamicModels).toBeDefined();

		const withoutKey = alibabaTokenPlanModelManagerOptions();
		expect(withoutKey.providerId).toBe("alibaba-token-plan");
		expect(withoutKey.fetchDynamicModels).toBeUndefined();
	});
});

describe("alibaba-token-plan dynamic discovery", () => {
	test("queries the Anthropic surface and inherits bundled token limits for entries missing them", async () => {
		const bundledGlm51 = getBundledModels("alibaba-token-plan").find(model => model.id === "glm-5.1");
		expect(bundledGlm51).toBeDefined();
		expect(bundledGlm51?.contextWindow).toBeGreaterThan(0);
		expect(bundledGlm51?.maxTokens).toBeGreaterThan(0);

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe(ANTHROPIC_SURFACE_MODELS_URL);
			expect(init?.method).toBe("GET");
			expect((init?.headers as Record<string, string>)?.["x-api-key"]).toBe("alibaba-token-plan-test-key");
			return new Response(
				JSON.stringify({
					data: [
						// #7486 regression: upstream omits token limits for this entry.
						{ id: "glm-5.1", display_name: "GLM-5.1" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const options = alibabaTokenPlanModelManagerOptions({ apiKey: "alibaba-token-plan-test-key" });
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const glm51 = models?.find(model => model.id === "glm-5.1");
		expect(glm51).toBeDefined();
		expect(glm51?.api).toBe("anthropic-messages");
		expect(glm51?.baseUrl).toBe(ANTHROPIC_SURFACE_BASE_URL);
		expect(Number.isFinite(glm51?.contextWindow)).toBe(true);
		expect(Number.isFinite(glm51?.maxTokens)).toBe(true);
		expect(glm51?.contextWindow).toBeGreaterThan(0);
		expect(glm51?.maxTokens).toBeGreaterThan(0);
		expect(glm51?.contextWindow).toBe(bundledGlm51?.contextWindow);
		expect(glm51?.maxTokens).toBe(bundledGlm51?.maxTokens);
	});
});

describe("alibaba-token-plan default model", () => {
	test("resolves to a model id present in the bundled catalog", () => {
		// #6078 regression: the default/probe model id must exist in the catalog it targets.
		const defaultModelId = DEFAULT_MODEL_PER_PROVIDER["alibaba-token-plan"];
		expect(defaultModelId).toBeDefined();

		const bundledIds = new Set(getBundledModels("alibaba-token-plan").map(model => model.id));
		expect(bundledIds.has(defaultModelId)).toBe(true);
	});
});

describe("alibaba-token-plan models.dev descriptor", () => {
	test("maps to the Anthropic-messages API on the /apps/anthropic surface", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === "alibaba-token-plan");
		expect(descriptor).toBeDefined();
		expect(descriptor?.api).toBe("anthropic-messages");
		expect(descriptor?.baseUrl).toBe(ANTHROPIC_SURFACE_BASE_URL);
	});
});
