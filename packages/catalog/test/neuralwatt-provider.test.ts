import { describe, expect, test } from "bun:test";
import { neuralwattModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

function makeNeuralwattFetchMock(models: unknown[]): {
	fetchImpl: FetchImpl;
	calls: Array<{ url: string; authorization: string | null }>;
} {
	const calls: Array<{ url: string; authorization: string | null }> = [];
	const fetchImpl: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({
			url: String(input),
			authorization: headers.get("authorization"),
		});
		return new Response(JSON.stringify({ data: models }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetchImpl, calls };
}

describe("Neuralwatt provider discovery", () => {
	test("sets supportsReasoningEffort from metadata.capabilities.reasoning_effort", async () => {
		const { fetchImpl, calls } = makeNeuralwattFetchMock([
			{
				id: "glm-5.2",
				object: "model",
				metadata: {
					capabilities: {
						reasoning: true,
						reasoning_effort: true,
						vision: false,
						developer_role: true,
					},
					limits: { max_context_length: 384000, max_output_tokens: 16384 },
					pricing: {
						input_per_million: 1.45,
						output_per_million: 4.5,
						cached_input_per_million: 0.3625,
					},
				},
			},
			{
				id: "kimi-k2.6",
				object: "model",
				metadata: {
					capabilities: {
						reasoning: true,
						reasoning_effort: false,
						vision: false,
						developer_role: false,
					},
					limits: { max_context_length: 262144, max_output_tokens: 32768 },
					pricing: {
						input_per_million: 2,
						output_per_million: 8,
						cached_input_per_million: 0.5,
					},
				},
			},
			{
				id: "qwen3.6-fast",
				object: "model",
				metadata: {
					capabilities: {
						reasoning: false,
						vision: false,
						developer_role: false,
					},
				},
			},
			{
				id: "glm-5.2-fast",
				object: "model",
				metadata: {
					capabilities: {
						reasoning: false,
						reasoning_effort: true,
						vision: false,
						developer_role: false,
					},
				},
			},
		]);

		const options = neuralwattModelManagerOptions({
			apiKey: "neuralwatt-test-key",
			fetch: fetchImpl,
		});
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.neuralwatt.com/v1/models",
				authorization: "Bearer neuralwatt-test-key",
			},
		]);
		expect(models).toBeDefined();
		expect(models).toHaveLength(4);

		// GLM-5.2: reasoning_effort: true → supportsReasoningEffort: true
		const glm = models?.find(m => m.id === "glm-5.2");
		expect(glm).toBeDefined();
		expect(glm).toMatchObject({
			provider: "neuralwatt",
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			contextWindow: 384000,
			maxTokens: 16384,
			cost: { input: 1.45, output: 4.5, cacheRead: 0.3625 },
		});
		expect(glm?.compat?.supportsReasoningEffort).toBe(true);
		expect(glm?.compat?.supportsDeveloperRole).toBe(true);
		expect(glm?.compat?.thinkingFormat).toBe("openai");

		// Kimi-K2.6: reasoning_effort: false → supportsReasoningEffort: false
		// (reasoning model, but does not accept the reasoning_effort wire param)
		const kimi = models?.find(m => m.id === "kimi-k2.6");
		expect(kimi).toBeDefined();
		expect(kimi).toMatchObject({
			reasoning: true,
			input: ["text"],
		});
		expect(kimi?.compat?.supportsReasoningEffort).toBe(false);
		expect(kimi?.compat?.thinkingFormat).toBe("openai");

		// Qwen fast alias: no reasoning_effort field → defaults to false
		const qwen = models?.find(m => m.id === "qwen3.6-fast");
		expect(qwen).toBeDefined();
		expect(qwen).toMatchObject({ reasoning: false });
		expect(qwen?.compat?.supportsReasoningEffort).toBe(false);
		expect(qwen?.compat?.thinkingFormat).toBe("openai");
		// GLM-5.2-fast: reasoning_effort is reported by metadata, but reasoning is false.
		const fast = models?.find(m => m.id === "glm-5.2-fast");
		expect(fast).toBeDefined();
		expect(fast).toMatchObject({ reasoning: false });
		expect(fast?.compat?.supportsReasoningEffort).toBe(false);
	});

	test("defaults supportsReasoningEffort to false when capabilities metadata is absent", async () => {
		const { fetchImpl, calls } = makeNeuralwattFetchMock([{ id: "glm-5.2", object: "model" }]);

		const options = neuralwattModelManagerOptions({
			apiKey: "neuralwatt-test-key",
			fetch: fetchImpl,
		});
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.neuralwatt.com/v1/models",
				authorization: "Bearer neuralwatt-test-key",
			},
		]);
		expect(models).toBeDefined();
		expect(models).toHaveLength(1);
		expect(models?.[0]?.compat?.supportsReasoningEffort).toBe(false);
	});
});
