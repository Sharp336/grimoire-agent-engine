import { expect, test, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { ollamaCloudModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/ollama";
import {
	fireworksModelManagerOptions,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const cloudModel: Model<"ollama-chat"> = {
	id: "deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "ollama-chat",
	provider: "ollama-cloud",
	baseUrl: "https://ollama.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
	compat: undefined,
};

function createNdjsonResponse(lines: unknown[]): Response {
	const body = `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

test("ollama-cloud discovery does not inherit unsafe cross-provider maxTokens", async () => {
	const fetchMock: FetchImpl = vi.fn(async (input, _init) => {
		const url = String(input);
		if (url === "https://ollama.com/api/tags") {
			return new Response(JSON.stringify({ models: [{ name: "deepseek-v4-flash" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === "https://ollama.com/api/show") {
			return new Response(JSON.stringify({ capabilities: ["completion"] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`Unexpected URL: ${url}`);
	});

	const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchMock });
	const models = await options.fetchDynamicModels?.();
	const model = models?.find(candidate => candidate.id === "deepseek-v4-flash");

	expect(model?.contextWindow).toBe(128000);
	expect(model?.maxTokens).toBe(8192);
	expect(model?.omitMaxOutputTokens).toBe(true);

	const bundled = mapModelsDevToModels(
		{
			"ollama-cloud": {
				models: {
					"deepseek-v4-flash": {
						name: "DeepSeek V4 Flash",
						tool_call: true,
						reasoning: true,
						modalities: { input: ["text"], output: ["text"] },
						cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
						limit: { context: 1_048_576, output: 1_048_576 },
					},
				},
			},
		},
		MODELS_DEV_PROVIDER_DESCRIPTORS,
	).find(candidate => candidate.provider === "ollama-cloud" && candidate.id === "deepseek-v4-flash");
	expect(bundled?.omitMaxOutputTokens).toBe(true);
});

test("shared models.dev references do not leak Ollama Cloud max-token omission", async () => {
	const fetchMock: FetchImpl = vi.fn(async (input, _init) => {
		const url = String(input);
		if (url === "https://models.dev/api.json") {
			return new Response(
				JSON.stringify({
					"ollama-cloud": {
						models: {
							"deepseek-v4-flash": {
								name: "DeepSeek V4 Flash",
								tool_call: true,
								reasoning: true,
								modalities: { input: ["text"], output: ["text"] },
								cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
								limit: { context: 1_048_576, output: 1_048_576 },
							},
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.startsWith("https://api.fireworks.ai/v1/accounts/fireworks/models?")) {
			return new Response(
				JSON.stringify({
					models: [
						{
							name: "accounts/fireworks/models/deepseek-v4-flash",
							displayName: "DeepSeek V4 Flash",
							contextLength: 262_144,
							supportsServerless: true,
							state: "READY",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		throw new Error(`Unexpected URL: ${url}`);
	});

	const options = fireworksModelManagerOptions({ apiKey: "fw-test-key", fetch: fetchMock });
	const models = await options.fetchDynamicModels?.();
	const model = models?.find(candidate => candidate.id === "deepseek-v4-flash");

	expect(model?.provider).toBe("fireworks");
	expect(model?.omitMaxOutputTokens).toBeUndefined();
});

test("ollama-chat omits num_predict when model opts out of max output tokens", async () => {
	let requestBody: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
		requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		return createNdjsonResponse([
			{ model: "deepseek-v4-flash", message: { role: "assistant", content: "ok" }, done: false },
			{ model: "deepseek-v4-flash", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
		]);
	});

	const model: Model<"ollama-chat"> = { ...cloudModel, omitMaxOutputTokens: true };
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Reply ok", timestamp: Date.now() }] },
		{ apiKey: "cloud-test-key", fetch: fetchMock, maxTokens: 384000 },
	).result();

	expect(requestBody).not.toHaveProperty("options");
});

test("ollama-chat sends think false when reasoning is disabled", async () => {
	let requestBody: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
		requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		return createNdjsonResponse([
			{ model: "deepseek-v4-flash", message: { role: "assistant", content: "ok" }, done: false },
			{ model: "deepseek-v4-flash", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
		]);
	});

	await streamSimple(
		cloudModel,
		{ messages: [{ role: "user", content: "Reply ok", timestamp: Date.now() }] },
		{ apiKey: "cloud-test-key", fetch: fetchMock, disableReasoning: true },
	).result();

	expect(requestBody?.think).toBe(false);
});

test("ollama-chat surfaces HTTP 400 response bodies", async () => {
	const fetchMock: FetchImpl = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ error: { message: "num_predict exceeds model cap", type: "invalid_request" } }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			),
	);

	const response = await streamSimple(
		cloudModel,
		{ messages: [{ role: "user", content: "Reply ok", timestamp: Date.now() }] },
		{ apiKey: "cloud-test-key", fetch: fetchMock },
	).result();

	expect(response.stopReason).toBe("error");
	expect(response.errorStatus).toBe(400);
	expect(response.errorMessage).toContain("HTTP 400 from https://ollama.com/api/chat");
	expect(response.errorMessage).toContain("num_predict exceeds model cap");
});
