import { describe, expect, it } from "bun:test";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

describe("BytePlus Coding Plan catalog provider", () => {
	it("exposes catalog metadata from the catalog table", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "byteplus-coding-plan");

		expect(DEFAULT_MODEL_PER_PROVIDER["byteplus-coding-plan"]).toBe("ark-code-latest");
		expect(descriptor?.defaultModel).toBe("ark-code-latest");
		expect(descriptor?.catalogDiscovery?.label).toBe("BytePlus Coding Plan");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("BYTEPLUS_CODING_PLAN_API_KEY");
	});

	it("discovers only curated Coding Plan models from the dedicated endpoint", async () => {
		let requestedUrl = "";
		const fetchMock: FetchImpl = async input => {
			requestedUrl = input instanceof Request ? input.url : String(input);
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "dola-seed-2.0-pro",
							name: "Dola Seed API Alias",
							context_length: "200000",
							max_completion_tokens: 64000,
						},
						{
							id: "deepseek-v4-pro",
							name: "DeepSeek V4 Pro",
							context_length: "1048576",
							max_completion_tokens: 393216,
						},
						{
							id: "skylark-embedding-vision-251215",
							name: "Skylark Embedding Vision",
							context_length: "4096",
							max_completion_tokens: 4096,
						},
						{
							id: "seedance-1-0-pro-250528",
							name: "Seedance 1.0 Pro",
							context_length: "8192",
							max_completion_tokens: 8192,
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};

		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "byteplus-coding-plan");
		const models = await descriptor
			?.createModelManagerOptions({ apiKey: "test-key", fetch: fetchMock })
			.fetchDynamicModels?.();
		expect(models?.map(item => item.id)).toEqual(["deepseek-v4-pro", "dola-seed-2.0-pro"]);
		const model = models?.find(item => item.id === "dola-seed-2.0-pro") as Model<"openai-completions"> | undefined;
		const deepseek = models?.find(item => item.id === "deepseek-v4-pro") as Model<"openai-completions"> | undefined;

		expect(requestedUrl).toBe("https://ark.ap-southeast.bytepluses.com/api/coding/v3/models");
		expect(model?.provider).toBe("byteplus-coding-plan");
		expect(model?.id).toBe("dola-seed-2.0-pro");
		expect(model?.name).toBe("Dola Seed API Alias");
		expect(model?.baseUrl).toBe("https://ark.ap-southeast.bytepluses.com/api/coding/v3");
		expect(model?.api).toBe("openai-completions");
		expect(model?.reasoning).toBe(true);
		expect(model?.contextWindow).toBe(200000);
		expect(model?.maxTokens).toBe(64000);
		expect(deepseek?.reasoning).toBe(true);
		expect(deepseek?.contextWindow).toBe(1048576);
		expect(deepseek?.maxTokens).toBe(393216);
		if (model?.api !== "openai-completions") {
			throw new Error("Expected BytePlus Coding Plan discovery to return OpenAI completions models");
		}
		expect(model.compat?.supportsStore).toBe(false);
		expect(model.compat?.supportsDeveloperRole).toBe(false);
	});

	it("does not probe the Coding Plan catalog without an API key", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "byteplus-coding-plan");
		const options = descriptor?.createModelManagerOptions({});

		expect(options?.fetchDynamicModels).toBeUndefined();
	});

	it("bundles the default Coding Plan alias for startup selection before discovery", () => {
		const model = getBundledModel("byteplus-coding-plan", "ark-code-latest");

		expect(model.provider).toBe("byteplus-coding-plan");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://ark.ap-southeast.bytepluses.com/api/coding/v3");
		expect(model.contextWindow).toBe(262144);
		expect(model.maxTokens).toBe(131072);
	});

	it("bundles the documented active Coding Plan model set", () => {
		const ids = getBundledModels("byteplus-coding-plan").map(model => model.id);

		expect(ids).toEqual([
			"ark-code-latest",
			"auto",
			"bytedance-seed-code",
			"deepseek-v4-flash",
			"deepseek-v4-pro",
			"dola-seed-2.0-code",
			"dola-seed-2.0-lite",
			"dola-seed-2.0-pro",
			"glm-4.7",
			"glm-5.1",
			"gpt-oss-120b",
			"kimi-k2.5",
		]);
	});

	it("marks documented multimodal BytePlus models as image-capable", () => {
		expect(getBundledModel("byteplus-coding-plan", "ark-code-latest").input).toEqual(["text", "image"]);
		expect(getBundledModel("byteplus-coding-plan", "dola-seed-2.0-code").input).toEqual(["text", "image"]);
		expect(getBundledModel("byteplus-coding-plan", "bytedance-seed-code").input).toEqual(["text", "image"]);
		expect(getBundledModel("byteplus-coding-plan", "kimi-k2.5").input).toEqual(["text", "image"]);
	});

	it("bundles documented DeepSeek V4 Coding Plan limits", () => {
		const flash = getBundledModel("byteplus-coding-plan", "deepseek-v4-flash");
		const pro = getBundledModel("byteplus-coding-plan", "deepseek-v4-pro");

		expect(flash.contextWindow).toBe(1048576);
		expect(flash.maxTokens).toBe(393216);
		expect(pro.contextWindow).toBe(1048576);
		expect(pro.maxTokens).toBe(393216);
	});
});
