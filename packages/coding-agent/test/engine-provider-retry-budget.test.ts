import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ProviderRequestHook } from "../src/sdk";
import {
	createProviderRetryBudgetHook,
	PROVIDER_RETRY_DEFERRED_CODE,
	PROVIDER_RETRY_EXHAUSTED_CODE,
	withProviderRetryBudget,
} from "../src/session/provider-retry-budget";

describe("Engine provider retry budget", () => {
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
		const fetch = hook.wrapFetch({ provider: "anthropic", id: "claude-test" } as Model, async () => {
			physicalRequests += 1;
			return new Response("busy", { status: 429, headers: { "retry-after-ms": "12000" } });
		});

		await withProviderRetryBudget(4, async () => {
			const first = await fetch("https://example.invalid/provider").catch(error => error);
			expect(first).toMatchObject({ retryable: false });
			expect(String(first)).toContain(`${PROVIDER_RETRY_DEFERRED_CODE}: HTTP 429`);
			expect(String(first)).toContain("retry-after-ms=12000");
			await expect(fetch("https://example.invalid/provider")).rejects.toThrow(PROVIDER_RETRY_DEFERRED_CODE);
		});

		expect({ admissions, physicalRequests }).toEqual({ admissions: 1, physicalRequests: 1 });
	});
});
