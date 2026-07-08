import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function getElectronHubOptions(fetch: FetchImpl) {
	const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === "electronhub");
	if (!descriptor) throw new Error("ElectronHub descriptor missing");
	const options = descriptor.createModelManagerOptions({ apiKey: "ek-dev-test", fetch });
	expect(options.providerId).toBe("electronhub");
	return options;
}

describe("ElectronHub provider catalog", () => {
	it("bundles DevPass models offline with zero token cost and supportsStore=false", () => {
		const kimi = getBundledModel<"openai-completions">("electronhub", "kimi-k2.6:dev");
		const minimax = getBundledModel<"openai-completions">("electronhub", "minimax-m2.7:dev");

		expect(kimi).toBeDefined();
		expect(minimax).toBeDefined();

		expect(kimi).toMatchObject({
			provider: "electronhub",
			api: "openai-completions",
			baseUrl: "https://api.electronhub.ai/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 240_000,
			maxTokens: null,
		});
		expect(minimax).toMatchObject({
			provider: "electronhub",
			api: "openai-completions",
			baseUrl: "https://api.electronhub.ai/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 180_000,
			maxTokens: null,
		});

		// Cost is a flat-rate DevPass plan (zero marginal token cost).
		expect(kimi.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(minimax.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		// ElectronHub is OpenAI-compatible but does not support the OpenAI `store` flag.
		expect(kimi.compat.supportsStore).toBe(false);
		expect(minimax.compat.supportsStore).toBe(false);
	});

	it("keeps only DevPass models from /v1/models discovery (filters out non-:dev + non-devpass_only)", async () => {
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(input instanceof Request ? input.url : String(input));
			return new Response(
				JSON.stringify({
					data: [
						{ id: "kimi-k2.6:dev", name: "ElectronHub: Kimi K2.6 (DevPass)", tokens: 240_000 },
						{ id: "minimax-m2.7:dev", name: "MiniMax M2.7 (DevPass)", tokens: 180_000 },
						// Keep via metadata.devpass_only even without :dev suffix
						{
							id: "rollout-preview",
							name: "ElectronHub: Preview",
							metadata: { devpass_only: true },
							tokens: 9_999,
						},
						// Must be dropped: not a DevPass record
						{ id: "kimi-k2.6", name: "Kimi K2.6", tokens: 240_000 },
						// Must be dropped: not a DevPass record
						{ id: "random-model", name: "Random", metadata: { devpass_only: false }, tokens: 1 },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const options = getElectronHubOptions(fetchImpl);
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();

		// Uses the OpenAI-compatible discovery endpoint.
		expect(requestedUrls).toEqual(["https://api.electronhub.ai/v1/models"]);

		const ids = (models ?? []).map(model => model.id);
		expect(ids).toEqual(["kimi-k2.6:dev", "minimax-m2.7:dev", "rollout-preview"]);
	});

	it("maps ElectronHub discovery metadata into ModelSpec (name cleanup, tokens->contextWindow, function_call=false)", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "thirdparty:dev",
							name: "ElectronHub: Custom DevPass Name",
							tokens: 123_456,
							metadata: {
								devpass_only: true,
								reasoning: true,
								vision: true,
								function_call: false,
							},
							pricing: { input: "0", output: "0", cache_read: "0", cache_write: "0" },
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = getElectronHubOptions(fetchImpl);
		const models = (await options.fetchDynamicModels?.()) as ModelSpec<"openai-completions">[] | null | undefined;
		const model = models?.find(candidate => candidate.id === "thirdparty:dev");

		expect(model).toBeDefined();
		expect(model?.name).toBe("Custom DevPass Name");
		expect(model?.contextWindow).toBe(123_456);
		expect(model?.reasoning).toBe(true);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.supportsTools).toBe(false);
		expect(model?.compat?.supportsStore).toBe(false);
	});
});
