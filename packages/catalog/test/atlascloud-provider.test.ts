import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { atlascloudModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Atlas Cloud provider discovery", () => {
	test("registers catalog descriptor with ATLASCLOUD_API_KEY env discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "atlascloud");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("qwen/qwen3.5-flash");
		expect(descriptor?.catalogDiscovery).toEqual({
			label: "Atlas Cloud",
			envVars: ["ATLASCLOUD_API_KEY"],
		});
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.atlascloud).toBe("qwen/qwen3.5-flash");
	});

	test("discovers Atlas Cloud models from the OpenAI-compatible endpoint", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(input),
				authorization: headers.get("authorization"),
			});
			return Response.json({
				object: "list",
				data: [
					{ id: "deepseek-ai/deepseek-v4-pro", object: "model", name: "DeepSeek V4 Pro" },
					{ id: "qwen/qwen3.5-flash", object: "model", name: "Qwen3.5 Flash" },
				],
			});
		};

		const options = atlascloudModelManagerOptions({ apiKey: "atlascloud-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.atlascloud.ai/v1/models",
				authorization: "Bearer atlascloud-test-key",
			},
		]);
		expect(models?.map(model => model.id)).toEqual(["deepseek-ai/deepseek-v4-pro", "qwen/qwen3.5-flash"]);
		expect(models?.find(model => model.id === "qwen/qwen3.5-flash")).toMatchObject({
			provider: "atlascloud",
			api: "openai-completions",
			baseUrl: "https://api.atlascloud.ai/v1",
			name: "Qwen3.5 Flash",
		});
		expect(models?.find(model => model.id === "qwen/qwen3.5-flash")?.input).toContain("text");
	});
});
