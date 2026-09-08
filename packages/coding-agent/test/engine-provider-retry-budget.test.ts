import { describe, expect, it } from "bun:test";
import { type Model, streamSimple } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ProviderRequestHook } from "../src/sdk";
import {
	createProviderRetryBudgetHook,
	deferNestedProviderRetry,
	PROVIDER_RETRY_DEFERRED_CODE,
	PROVIDER_RETRY_EXHAUSTED_CODE,
	PROVIDER_RETRY_PERMANENT_CODE,
	withProviderRetryBudget,
} from "../src/session/provider-retry-budget";

describe("Engine provider retry budget", () => {
	it.each([
		{
			name: "physical Retry-After",
			response: () => new Response("busy", { status: 429, headers: { "Retry-After": "45" } }),
			expected: "retry-after-ms=45000",
		},
		{
			name: "HTTP 200 stream failure",
			response: () =>
				new Response(
					'data: {"error":{"message":"upstream overloaded 503","type":"server_error"}}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				),
			expected: "upstream overloaded 503",
		},
		{
			name: "empty completion",
			response: () =>
				new Response(
					'data: {"id":"empty","object":"chat.completion.chunk","created":0,"model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				),
			expected: "Provider returned an empty completion",
		},
	])("preserves $name through the real provider stream retry layers", async ({ response, expected }) => {
		const model = buildModel({
			id: "gpt-test",
			name: "GPT test",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://example.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		let physicalRequests = 0;
		let nestedWaits = 0;
		const result = await withProviderRetryBudget(4, () =>
			streamSimple(
				model,
				{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
				{
					apiKey: "test-key",
					fetch: createProviderRetryBudgetHook().wrapFetch(model, async () => {
						physicalRequests++;
						return response();
					}),
					providerRetryWait: async (delayMs, signal, cause) => {
						nestedWaits++;
						await deferNestedProviderRetry(delayMs, signal, cause);
					},
				},
			)
				.result()
				.catch(error => error),
		);
		expect(physicalRequests).toBe(1);
		expect(nestedWaits).toBe(1);
		expect(String(result.errorMessage ?? result)).toContain(expected);
	});

	it("resets after every successful logical request across more than four tool turns", async () => {
		let physicalRequests = 0;
		const hook = createProviderRetryBudgetHook();
		const model = { provider: "openai-codex", id: "gpt-5.5" } as Model;

		for (let toolTurn = 0; toolTurn < 6; toolTurn++) {
			const fetch = withProviderRetryBudget(4, () =>
				hook.wrapFetch(model, async () => {
					physicalRequests += 1;
					return new Response(`turn-${toolTurn}`);
				}),
			);
			expect(await (await fetch("https://example.invalid/provider")).text()).toBe(`turn-${toolTurn}`);
		}

		expect(physicalRequests).toBe(6);
	});

	it("admits and sends at most four physical requests across stream reopens", async () => {
		let admissions = 0;
		let physicalRequests = 0;
		const admission: ProviderRequestHook = {
			wrapFetch: (_model, fetch) => async (input, init) => {
				admissions += 1;
				return await fetch(input, init);
			},
		};
		const hook = createProviderRetryBudgetHook(admission);
		const model = { provider: "openai-codex", id: "gpt-5.5" } as Model;

		await withProviderRetryBudget(4, async () => {
			for (let attempt = 0; attempt < 4; attempt++) {
				const fetch = hook.wrapFetch(model, async () => {
					physicalRequests += 1;
					return new Response("busy", { status: 503, headers: { "Retry-After": "9" } });
				});
				await expect(fetch("https://example.invalid/provider")).rejects.toThrow(PROVIDER_RETRY_DEFERRED_CODE);
			}
			const exhausted = hook.wrapFetch(model, async () => {
				physicalRequests += 1;
				return new Response("must not run");
			});
			await expect(exhausted("https://example.invalid/provider")).rejects.toThrow(PROVIDER_RETRY_EXHAUSTED_CODE);
		});

		expect({ admissions, physicalRequests }).toEqual({ admissions: 4, physicalRequests: 4 });
	});

	it("suppresses a nested transport retry before admission and preserves Retry-After", async () => {
		let admissions = 0;
		let physicalRequests = 0;
		const hook = createProviderRetryBudgetHook({
			wrapFetch: (_model, fetch) => async (input, init) => {
				admissions += 1;
				return await fetch(input, init);
			},
		});
		await withProviderRetryBudget(4, async () => {
			const fetch = hook.wrapFetch({ provider: "anthropic", id: "claude-test" } as Model, async () => {
				physicalRequests += 1;
				return new Response("busy", { status: 429, headers: { "retry-after-ms": "12000" } });
			});
			const first = await fetch("https://example.invalid/provider").catch(error => error);
			expect(first).toMatchObject({ retryable: false });
			expect(String(first)).toContain(`${PROVIDER_RETRY_DEFERRED_CODE}: HTTP 429`);
			expect(String(first)).toContain("retry-after-ms=12000");
			await expect(fetch("https://example.invalid/provider")).rejects.toBe(first);
			await expect(deferNestedProviderRetry(500)).rejects.toBe(first);
			const controller = new AbortController();
			controller.abort();
			await expect(deferNestedProviderRetry(500, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
			await expect(fetch("https://example.invalid/provider", { signal: controller.signal })).rejects.toMatchObject({
				name: "AbortError",
			});
		});

		expect({ admissions, physicalRequests }).toEqual({ admissions: 1, physicalRequests: 1 });
	});

	it("keeps account-policy responses outside transient recovery", async () => {
		const hook = createProviderRetryBudgetHook();
		await withProviderRetryBudget(4, async () => {
			const fetch = hook.wrapFetch(
				{ provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses" } as Model,
				async () =>
					new Response(
						'{"error":{"message":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account."}}',
						{ status: 503 },
					),
			);
			const error = await fetch("https://example.invalid/provider").catch(reason => reason);
			expect(error).toMatchObject({ retryable: false });
			expect(String(error)).toContain(PROVIDER_RETRY_PERMANENT_CODE);
		});
	});
});
