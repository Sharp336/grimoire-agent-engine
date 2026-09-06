import { describe, expect, it } from "bun:test";
import type { Model, UsageReport } from "@oh-my-pi/pi-ai";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	ProviderAdmissionClient,
	ProviderAdmissionError,
	withProviderObservationContext,
} from "../src/engine/provider-admission";
import type { AuthStorage } from "../src/session/auth-storage";

describe("ProviderAdmissionClient", () => {
	it("admits each physical fetch and invalidates freshness after each result", async () => {
		let admissionBefore = 0;
		let admissionAfter = 0;
		let invalidations = 0;
		let usageReads = 0;
		let providerCalls = 0;
		const admissionFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as {
				phase: string;
				modelId?: string;
				accountBindingId?: string;
				usageReport?: UsageReport;
			};
			if (body.phase === "before") {
				admissionBefore += 1;
				expect(body.modelId).toBe("gpt-5.6-terra");
				expect(body.accountBindingId).toBe("acct-1");
				expect(body.usageReport?.metadata?.accountId).toBe("acct-1");
				expect(body.usageReport?.raw).toBeUndefined();
			} else admissionAfter += 1;
			return Response.json({ allowed: true, status: "within_weekly_ceiling" });
		};
		const authStorage = {
			invalidateUsageCache: async () => {
				invalidations += 1;
			},
			fetchUsageReports: async () => {
				usageReads += 1;
				return [usageReport()];
			},
		} as unknown as AuthStorage;
		const wrapped = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", admissionFetch)
			.createHook(identity(), authStorage, "https://chatgpt.com/backend-api")
			.wrapFetch(model(), async () => {
				providerCalls += 1;
				return new Response("ok");
			});
		await wrapped("https://chatgpt.com/backend-api/codex/responses");
		await wrapped("https://chatgpt.com/backend-api/codex/responses");
		await Promise.resolve();
		expect({ admissionBefore, usageReads, providerCalls }).toEqual({
			admissionBefore: 2,
			usageReads: 2,
			providerCalls: 2,
		});
		expect(invalidations).toBe(4);
		expect(admissionAfter).toBe(2);
	});

	it("fails closed with a permanent typed error before provider dispatch", async () => {
		const admissionFetch = async () => Response.json({ allowed: false, status: "codex_weekly_ceiling_reached" });
		const authStorage = {
			invalidateUsageCache: async () => {},
			fetchUsageReports: async () => [usageReport()],
		} as unknown as AuthStorage;
		let providerCalls = 0;
		const wrapped = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", admissionFetch)
			.createHook(identity(), authStorage, "https://chatgpt.com/backend-api")
			.wrapFetch(model(), async () => {
				providerCalls += 1;
				return new Response("unexpected");
			});
		const error = await wrapped("https://chatgpt.com/backend-api/codex/responses").catch(reason => reason);
		expect(error).toBeInstanceOf(ProviderAdmissionError);
		expect(error).toMatchObject({ code: "codex_weekly_ceiling_reached", retryable: false });
		expect(providerCalls).toBe(0);
	});

	it("bypasses subscription admission only for an exact pinned API-key fallback", async () => {
		let admissionCalls = 0;
		let providerCalls = 0;
		const authStorage = {
			invalidateUsageCache: async () => {},
			fetchUsageReports: async () => [usageReport()],
		} as unknown as AuthStorage;
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async () => {
			admissionCalls += 1;
			return Response.json({ allowed: true });
		}).createHook(identity(), authStorage, "https://chatgpt.com/backend-api", [
			{
				expectedPrincipalId: "grimoire:user:owner",
				profileRef: "gctx:2222222222222222",
				profileContentHash: "sha256:profile",
				providerAccountRef: "gctx:4444444444444444",
				providerAccountContentHash: "sha256:account",
				routeRef: "gctx:5555555555555555",
				routeContentHash: "sha256:route",
				providerId: "cheapai-account-1",
				runtimeProviderId: "cheapai-account-1",
				modelId: "gpt-5.6-terra",
				baseUrl: "https://cheapai.invalid/v1",
			},
		]);
		const fallbackModel = {
			id: "gpt-5.6-terra",
			provider: "cheapai-account-1",
			baseUrl: "https://cheapai.invalid/v1",
		} as Model;
		const fallbackFetch = hook.wrapFetch(fallbackModel, async () => {
			providerCalls += 1;
			return new Response("ok");
		});
		await fallbackFetch("https://cheapai.invalid/v1/responses");
		expect({ admissionCalls, providerCalls }).toEqual({ admissionCalls: 0, providerCalls: 1 });

		for (const foreignSubscription of [
			{ ...fallbackModel, provider: "other-subscription" },
			{ ...fallbackModel, baseUrl: "https://other.invalid/v1" },
		]) {
			const foreignFetch = hook.wrapFetch(foreignSubscription as Model, async () => new Response("unexpected"));
			const error = await foreignFetch("https://other.invalid/v1/responses").catch(reason => reason);
			expect(error).toMatchObject({ code: "provider_identity_mismatch", retryable: false });
		}
		expect(admissionCalls).toBe(0);
	});

	it("stops waiting for a shared usage refresh when the provider request is cancelled", async () => {
		const cancelled = new Error("turn cancelled");
		const controller = new AbortController();
		const authStorage = {
			invalidateUsageCache: async () => {},
			fetchUsageReports: () => new Promise<UsageReport[] | null>(() => {}),
		} as unknown as AuthStorage;
		let providerCalls = 0;
		const wrapped = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async () =>
			Response.json({ allowed: true }),
		)
			.createHook(identity(), authStorage, "https://chatgpt.com/backend-api")
			.wrapFetch(model(), async () => {
				providerCalls += 1;
				return new Response("unexpected");
			});
		const result = wrapped("https://chatgpt.com/backend-api/codex/responses", { signal: controller.signal }).catch(
			error => error,
		);
		controller.abort(cancelled);
		expect(await result).toBe(cancelled);
		expect(providerCalls).toBe(0);
	});

	it("records one redacted idempotent observation for a completed API-key stream", async () => {
		const observations: Array<Record<string, unknown>> = [];
		const admissionFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			observations.push(body);
			return observations.length === 1
				? new Response("lost acknowledgement", { status: 503 })
				: Response.json({ allowed: true, status: "recorded" });
		};
		const route = {
			expectedPrincipalId: "grimoire:user:owner",
			profileRef: "gctx:2222222222222222",
			profileContentHash: "sha256:profile",
			providerAccountRef: "gctx:4444444444444444",
			providerAccountContentHash: "sha256:account",
			routeRef: "gctx:5555555555555555",
			routeContentHash: "sha256:route",
			providerId: "cheapai",
			runtimeProviderId: "artel-4444444444444444",
			modelId: "gpt-5.6-terra",
			baseUrl: "https://cheapai.invalid/v1",
		};
		const hook = new ProviderAdmissionClient(
			"http://127.0.0.1/provider-admission",
			"host-token-must-not-enter-observation",
			admissionFetch,
		).createHook(undefined, {} as AuthStorage, "", [route]);
		const wrapped = hook.wrapFetch(
			{ id: route.modelId, provider: route.runtimeProviderId, baseUrl: route.baseUrl } as Model,
			async () => {
				const response = new Response("completed answer");
				Object.defineProperty(response, "url", { value: "https://cheapai.invalid/v1/chat/completions" });
				return response;
			},
		);
		const result = await withProviderObservationContext(
			{ effectId: "model_effect_1", modelCallId: "model-1" },
			async () => {
				const response = await wrapped("https://cheapai.invalid/v1/chat/completions");
				return { url: response.url, answer: await response.text() };
			},
		);
		expect(result.url).toBe("https://cheapai.invalid/v1/chat/completions");
		expect(result.answer).toBe("completed answer");
		expect(observations).toHaveLength(2);
		expect(observations[0]).toEqual(observations[1]);
		expect(observations[0]).toMatchObject({
			phase: "observe",
			expectedPrincipalId: "grimoire:user:owner",
			routeRef: route.routeRef,
			providerId: "cheapai",
			effectId: "model_effect_1",
			modelCallId: "model-1",
			physicalRequestOrdinal: 1,
			outcome: "success",
			statusCode: 200,
		});
		const encoded = JSON.stringify(observations);
		expect(encoded).not.toContain("host-token-must-not-enter-observation");
		expect(encoded).not.toContain("completed answer");
	});

	it("does not delay provider fallback while a failed-route observation is pending", async () => {
		const observationStarted = Promise.withResolvers<void>();
		const observationRelease = Promise.withResolvers<Response>();
		let observation: Record<string, unknown> | undefined;
		const route = {
			expectedPrincipalId: "grimoire:user:owner",
			profileRef: "gctx:2222222222222222",
			profileContentHash: "sha256:profile",
			providerAccountRef: "gctx:4444444444444444",
			providerAccountContentHash: "sha256:account",
			routeRef: "gctx:5555555555555555",
			routeContentHash: "sha256:route",
			providerId: "cheapai",
			runtimeProviderId: "artel-4444444444444444",
			modelId: "gpt-5.6-terra",
			baseUrl: "https://cheapai.invalid/v1",
		};
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async (_input, init) => {
			observation = JSON.parse(String(init?.body)) as Record<string, unknown>;
			observationStarted.resolve();
			return await observationRelease.promise;
		}).createHook(undefined, {} as AuthStorage, "", [route]);
		const wrapped = hook.wrapFetch(
			{ id: route.modelId, provider: route.runtimeProviderId, baseUrl: route.baseUrl } as Model,
			async () => {
				throw new Error("HTTP 429 upstream rate limited");
			},
		);
		const startedAt = performance.now();
		await expect(
			withProviderObservationContext({ effectId: "model_effect_2", modelCallId: "model-2" }, async () =>
				wrapped("https://cheapai.invalid/v1/chat/completions"),
			),
		).rejects.toThrow("HTTP 429");
		expect(performance.now() - startedAt).toBeLessThan(1_000);
		await observationStarted.promise;
		expect(observation).toMatchObject({ outcome: "rate_limited", statusCode: 429 });
		observationRelease.resolve(Response.json({ allowed: true, status: "recorded" }));
	});

	it("records HTTP 200 terminal SSE errors as physical provider failures", async () => {
		const observations: Array<Record<string, unknown>> = [];
		const route = {
			expectedPrincipalId: "grimoire:user:owner",
			profileRef: "gctx:2222222222222222",
			profileContentHash: "sha256:profile",
			providerAccountRef: "gctx:4444444444444444",
			providerAccountContentHash: "sha256:account",
			routeRef: "gctx:5555555555555555",
			routeContentHash: "sha256:route",
			providerId: "cheapai",
			runtimeProviderId: "artel-4444444444444444",
			modelId: "gpt-5.6-terra",
			baseUrl: "https://cheapai.invalid/v1",
		};
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async (_input, init) => {
			observations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return Response.json({ allowed: true, status: "recorded" });
		}).createHook(undefined, {} as AuthStorage, "", [route]);
		const codexModel = buildModel({
			id: route.modelId,
			name: "Terra",
			api: "openai-codex-responses",
			provider: route.runtimeProviderId,
			baseUrl: route.baseUrl,
			reasoning: true,
			preferWebsockets: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 32_000,
		});
		const errorSse = `data: ${JSON.stringify({
			type: "error",
			code: "model_error",
			message: "retryable provider failure",
		})}\n\n`;
		const providerFetch = hook.wrapFetch(
			codexModel,
			async () =>
				new Response(errorSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const context: Context = {
			systemPrompt: ["Answer briefly."],
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};
		const result = await withProviderObservationContext(
			{ effectId: "model_effect_semantic", modelCallId: "model-semantic" },
			async () =>
				await streamOpenAICodexResponses(codexModel, context, {
					apiKey: "dummy-test-key",
					fetch: providerFetch as FetchImpl,
				}).result(),
		);
		expect(result.stopReason).toBe("error");
		expect(observations.length).toBeGreaterThan(0);
		expect(observations.every(item => item.outcome === "provider_error" && item.statusCode === 200)).toBe(true);
		expect(observations.map(item => item.physicalRequestOrdinal)).toEqual(
			observations.map((_item, index) => index + 1),
		);
	}, 30_000);

	it("does not record a cancelled successful stream as an outage", async () => {
		const observations: Array<Record<string, unknown>> = [];
		const controller = new AbortController();
		const route = {
			expectedPrincipalId: "grimoire:user:owner",
			profileRef: "gctx:2222222222222222",
			profileContentHash: "sha256:profile",
			providerAccountRef: "gctx:4444444444444444",
			providerAccountContentHash: "sha256:account",
			routeRef: "gctx:5555555555555555",
			routeContentHash: "sha256:route",
			providerId: "cheapai",
			runtimeProviderId: "artel-4444444444444444",
			modelId: "gpt-5.6-terra",
			baseUrl: "https://cheapai.invalid/v1",
		};
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async (_input, init) => {
			observations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return Response.json({ allowed: true });
		}).createHook(undefined, {} as AuthStorage, "", [route]);
		const wrapped = hook.wrapFetch(
			{ id: route.modelId, provider: route.runtimeProviderId, baseUrl: route.baseUrl } as Model,
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(streamController) {
							streamController.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);
		await withProviderObservationContext(
			{ effectId: "model_effect_cancel", modelCallId: "model-cancel" },
			async () => {
				const response = await wrapped("https://cheapai.invalid/v1/chat/completions", {
					signal: controller.signal,
				});
				const reader = response.body!.getReader();
				await reader.read();
				controller.abort();
				await reader.cancel();
			},
		);
		expect(observations).toEqual([]);
	});
});

function identity() {
	return {
		expectedPrincipalId: "grimoire:user:owner",
		profileRef: "gctx:1111111111111111",
		profileContentHash: "sha256:profile",
		providerAccountRef: "gctx:2222222222222222",
		providerAccountContentHash: "sha256:account",
		routeRef: "gctx:3333333333333333",
		routeContentHash: "sha256:route",
		providerKind: "openai_codex_subscription" as const,
		providerId: "openai-codex",
		accountBindingId: "acct-1",
	};
}

function model(): Model {
	return { id: "gpt-5.6-terra", provider: "openai-codex" } as Model;
}

function usageReport(): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		metadata: { accountId: "acct-1" },
		limits: [],
		raw: { accessToken: "must-not-cross-boundary" },
	};
}
