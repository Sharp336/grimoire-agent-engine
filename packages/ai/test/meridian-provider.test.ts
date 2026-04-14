import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { meridianModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";

const originalMeridianApiKey = Bun.env.MERIDIAN_API_KEY;
const originalMeridianBaseUrl = Bun.env.MERIDIAN_BASE_URL;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalMeridianApiKey === undefined) {
		delete Bun.env.MERIDIAN_API_KEY;
	} else {
		Bun.env.MERIDIAN_API_KEY = originalMeridianApiKey;
	}
	if (originalMeridianBaseUrl === undefined) {
		delete Bun.env.MERIDIAN_BASE_URL;
	} else {
		Bun.env.MERIDIAN_BASE_URL = originalMeridianBaseUrl;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("meridian provider support", () => {
	test("resolves MERIDIAN_API_KEY from environment", () => {
		Bun.env.MERIDIAN_API_KEY = "meridian-test-key";
		expect(getEnvApiKey("meridian")).toBe("meridian-test-key");
	});

	test("does not synthesize Meridian auth from generic fallback vars", () => {
		delete Bun.env.MERIDIAN_API_KEY;
		delete Bun.env.ANTHROPIC_API_KEY;
		expect(getEnvApiKey("meridian")).toBeUndefined();
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "meridian");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("claude-sonnet-4-6");
		expect(descriptor?.allowUnauthenticated).toBe(true);
		expect(descriptor?.catalogDiscovery).toBeUndefined();
		expect(DEFAULT_MODEL_PER_PROVIDER.meridian).toBe("claude-sonnet-4-6");
	});

	test("registers Meridian in OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "meridian");
		expect(provider?.name).toBe("Meridian (Local Anthropic-compatible)");
	});

	test("builds model manager options with Meridian defaults", async () => {
		Bun.env.MERIDIAN_BASE_URL = "http://127.0.0.1:3456";
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-sonnet-4-6",
								display_name: "Claude Sonnet 4.6",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const options = meridianModelManagerOptions();
		expect(options.providerId).toBe("meridian");
		expect(options.fetchDynamicModels).toBeDefined();
		expect(options.modelsDev).toBeUndefined();

		const models = await options.fetchDynamicModels?.();
		expect(global.fetch).toHaveBeenNthCalledWith(
			2,
			"http://127.0.0.1:3456/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ "x-api-key": "x" }),
			}),
		);
		expect(models?.[0]?.provider).toBe("meridian");
		expect(models?.[0]?.api).toBe("anthropic-messages");
		expect(models?.[0]?.baseUrl).toBe("http://127.0.0.1:3456/v1");
	});
});
