import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { mindshubModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const originalMindsHubApiKey = Bun.env.MINDSHUB_API_KEY;

afterEach(() => {
	if (originalMindsHubApiKey === undefined) {
		delete Bun.env.MINDSHUB_API_KEY;
	} else {
		Bun.env.MINDSHUB_API_KEY = originalMindsHubApiKey;
	}
	vi.restoreAllMocks();
});

describe("mindshub provider support", () => {
	test("resolves MINDSHUB_API_KEY from environment", () => {
		Bun.env.MINDSHUB_API_KEY = "mindshub-test-key";
		expect(getEnvApiKey("mindshub")).toBe("mindshub-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "mindshub");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("sonnet");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(descriptor?.catalogDiscovery?.envVars).toContain("MINDSHUB_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.mindshub).toBe("sonnet");
	});

	test("registers MindsHub in the OAuth/login provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "mindshub");
		expect(provider?.name).toBe("MindsHub");
	});

	test("fetches and normalizes the MindsHub model catalog", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			expect(url).toBe("https://api.mindshub.ai/v1/models");
			expect(init?.headers).toMatchObject({ Authorization: "Bearer mindshub-test-key" });
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "sonnet",
							label: "Claude Sonnet 5",
							object: "model",
							created: 0,
							enabled: true,
							reasoning_efforts: ["low", "medium", "high", "max"],
							default_reasoning_effort: "high",
							embedding: false,
							supported_params: ["stop_sequences", "max_tokens", "reasoning_effort", "thinking", "tool_choice"],
							provider: "anthropic",
							family: "sonnet",
						},
						{
							id: "kimi",
							label: "Kimi K3",
							object: "model",
							created: 0,
							enabled: true,
							reasoning_efforts: null,
							embedding: false,
							provider: "moonshot",
							family: "kimi",
						},
						{
							id: "embed-small",
							label: "Text Embedding 3 (small)",
							object: "model",
							created: 0,
							enabled: true,
							embedding: true,
							provider: "openai",
							family: "embed-small",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const options = mindshubModelManagerOptions({ apiKey: "mindshub-test-key", fetch: fetchMock });
		expect(options.providerId).toBe("mindshub");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.mindshub.ai/v1/models",
			expect.objectContaining({ method: "GET" }),
		);

		// Embedding-only rows are dropped: they serve `/v1/embeddings`, not chat.
		expect(models?.some(model => model.id === "embed-small")).toBe(false);

		const sonnet = models?.find(model => model.id === "sonnet");
		expect(sonnet?.api).toBe("openai-completions");
		expect(sonnet?.baseUrl).toBe("https://api.mindshub.ai/v1");
		expect(sonnet?.name).toBe("Claude Sonnet 5");
		expect(sonnet?.reasoning).toBe(true);
		expect(sonnet?.input).toEqual(["text", "image"]);

		// `reasoning_efforts: null` means the level isn't adjustable, not that
		// the model never reasons (see docs/models.mdx#reasoning-effort).
		const kimi = models?.find(model => model.id === "kimi");
		expect(kimi?.name).toBe("Kimi K3");
		expect(kimi?.reasoning).toBe(false);
	});

	test("discovery omits the Authorization header without an API key", async () => {
		delete Bun.env.MINDSHUB_API_KEY;
		let sentHeaders: RequestInit["headers"];
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			sentHeaders = init?.headers;
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const options = mindshubModelManagerOptions({ fetch: fetchMock });
		await options.fetchDynamicModels?.();
		expect(sentHeaders).not.toHaveProperty("Authorization");
	});
});
