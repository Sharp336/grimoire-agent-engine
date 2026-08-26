import { describe, expect, test } from "bun:test";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import {
	CATALOG_PROVIDERS,
	DEFAULT_MODEL_PER_PROVIDER,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { FREEPI_STATIC_MODELS, freepiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const FREEPI_BASE_URL = "https://sponsored-api-pilot-production.up.railway.app/api/v1";
const FREEPI_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

describe("FreePI built-in provider", () => {
	test("registers the FreePI runtime descriptor and resolvable default model", () => {
		const catalogEntry = CATALOG_PROVIDERS.find(provider => provider.id === "freepi");
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "freepi");

		expect(catalogEntry).toMatchObject({
			defaultModel: FREEPI_DEFAULT_MODEL,
			envVars: ["FREEPI_API_KEY"],
			dynamicModelsAuthoritative: true,
		});
		expect(descriptor?.catalogDiscovery?.label).toBe("FreePI");
		expect(DEFAULT_MODEL_PER_PROVIDER.freepi).toBe(FREEPI_DEFAULT_MODEL);
		expect(FREEPI_STATIC_MODELS.map(model => model.id)).toContain(FREEPI_DEFAULT_MODEL);
	});

	test("discovers the OpenAI-compatible model with bearer authentication", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ url: input.toString(), authorization: headers.get("authorization") });
			return new Response(JSON.stringify({ data: [{ id: FREEPI_DEFAULT_MODEL }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
		const options = freepiModelManagerOptions({ apiKey: "freepi-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(options.providerId).toBe("freepi");
		expect(calls).toEqual([
			{
				url: `${FREEPI_BASE_URL}/models`,
				authorization: "Bearer freepi-test-key",
			},
		]);
		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: FREEPI_DEFAULT_MODEL,
			api: "openai-completions",
			provider: "freepi",
			baseUrl: FREEPI_BASE_URL,
		});
	});

	test("resolves FREEPI_API_KEY via env", () => {
		const previous = Bun.env.FREEPI_API_KEY;
		Bun.env.FREEPI_API_KEY = "freepi-test-key";
		try {
			expect(getEnvApiKey("freepi")).toBe("freepi-test-key");
		} finally {
			if (previous === undefined) {
				delete Bun.env.FREEPI_API_KEY;
			} else {
				Bun.env.FREEPI_API_KEY = previous;
			}
		}
	});
});
