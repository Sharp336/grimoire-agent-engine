import { describe, expect, it, spyOn } from "bun:test";
import type { Model, UsageReport } from "@oh-my-pi/pi-ai";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";
import {
	attachLatencyResponse,
	LatencyAudit,
	latencyFetch,
	latencyNormalizedSource,
	latencyPreparation,
} from "@oh-my-pi/pi-utils/latency-audit";
import {
	ProviderAdmissionClient,
	ProviderAdmissionError,
	type ProviderRequestRecord,
	withProviderObservationContext,
	type ProviderAdmissionIdentity,
} from "../src/engine/provider-admission";
import { ProviderExecutionError } from "../src/engine/provider-execution";
import type { AuthStorage } from "../src/session/auth-storage";
import { createProviderRetryBudgetHook, withProviderRetryBudget } from "../src/session/provider-retry-budget";

describe("ProviderAdmissionClient", () => {
	it("keeps first nonempty content on its Response after another fetch, without changing emitted content", async () => {
		const route = {
			...identity(),
			runtimeProviderId: "artel-route-fixture",
			modelId: "claude-sonnet-5",
			baseUrl: "https://cheapai.invalid/v1",
		};
		const selected = buildModel({
			id: route.modelId,
			name: "Fixture",
			api: "openai-completions",
			provider: route.runtimeProviderId,
			baseUrl: route.baseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1_000,
		});
		const hook = new ProviderAdmissionClient("http://127.0.0.1/admission", "secret-test-key", async () =>
			Response.json({ allowed: true }),
		).createHook(undefined, {} as AuthStorage, "", [route]);
		const identityFields = { effectId: "audit-effect", modelCallId: "model-1" };
		const audit = new LatencyAudit(identityFields);
		const logs = spyOn(logger, "info").mockImplementation(() => {});
		const run = async (probe?: LatencyAudit) => {
			let calls = 0;
			let controller: ReadableStreamDefaultController<Uint8Array>;
			const opened = Promise.withResolvers<void>();
			const consumerReached = Promise.withResolvers<void>();
			const consumerRelease = Promise.withResolvers<void>();
			const encoder = new TextEncoder();
			const frame = (delta: object) =>
				encoder.encode(
					`data: ${JSON.stringify({
						id: "response-one",
						choices: [{ index: 0, delta }],
					})}\n\n`,
				);
			const raw: FetchImpl = async () => {
				calls++;
				if (calls > 1)
					return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
				return new Response(
					new ReadableStream<Uint8Array>({
						start(value) {
							controller = value;
							value.enqueue(frame({ role: "assistant" }));
							value.enqueue(frame({ reasoning_content: "\n", content: " " }));
							opened.resolve();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			};
			const wrapped = hook.wrapFetch(selected, (input, init) => latencyFetch(raw, input, init));
			return await withProviderObservationContext(
				identityFields,
				async () => {
					expect(latencyPreparation.getStore()).toBe(probe);
					const response = stream(
						selected,
						{ messages: [{ role: "user", content: "secret-input", timestamp: 0 }] },
						{ apiKey: "secret-test-key", fetch: wrapped },
					);
					const output: string[] = [];
					const consuming = (async () => {
						for await (const event of response) {
							if (event.type !== "text_delta" && event.type !== "thinking_delta") continue;
							output.push(`${event.type}:${event.delta}`);
							if (!event.delta.trim()) continue;
							if (probe) {
								expect(latencyNormalizedSource(event)?.request.fields.physicalRequestOrdinal).toBe(1);
								expect(latencyNormalizedSource(event)?.sourceCorrelation).toBe("direct");
							} else expect(latencyNormalizedSource(event)).toBeUndefined();
							consumerReached.resolve();
							await consumerRelease.promise;
						}
					})();
					try {
						await opened.promise;
						// A later response must never steal the first response's late parser content.
						await (await wrapped(`${route.baseUrl}/chat/completions`)).text();
						controller!.enqueue(frame({ content: "secret-output" }));
						controller!.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller!.close();
						await Promise.race([consumerReached.promise, consuming]);
						if (probe) {
							const first = probe.marks.find(mark => mark.stage === "normalized_first");
							expect(first).toMatchObject({
								physicalRequestOrdinal: 1,
								stream: "assistant",
								chars: 13,
								sourceCorrelation: "direct",
							});
							expect(first!.parsedAt).toBeLessThanOrEqual(first!.at);
							expect(
								probe.marks.some(mark => mark.stage === "normalized_first" && mark.stream === "thinking"),
							).toBe(false);
						}
					} finally {
						consumerRelease.resolve();
					}
					await consuming;
					expect((await response.result()).stopReason).toBe("stop");
					return output;
				},
				probe,
				recorder().record,
			);
		};
		try {
			const disabled = await run();
			expect(logs.mock.calls.filter(([message]) => message === "artel.latency")).toEqual([]);
			expect(await run(audit)).toEqual(disabled);
			audit.finish("fixture_settled");
			expect(
				audit.marks.filter(mark => mark.stage === "fetch_start").map(mark => mark.physicalRequestOrdinal),
			).toEqual([1, 2]);
			expect(
				audit.marks.some(mark => mark.stage === "no_content_on_terminal" && mark.physicalRequestOrdinal === 2),
			).toBe(true);
			expect(JSON.stringify(logs.mock.calls)).not.toContain("secret-");
		} finally {
			logs.mockRestore();
		}
	});

	it("does not attribute buffered or transformed healer output to a later matching fragment", async () => {
		const selected = buildModel({
			id: "claude-sonnet-5",
			name: "Fixture",
			api: "openai-completions",
			provider: "cheapai",
			baseUrl: "https://cheapai.invalid/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1_000,
		});
		for (const fragments of [
			["<", "<"],
			["<think>secret-thinking</think>", "secret-output"],
		]) {
			const audit = new LatencyAudit({ effectId: "healer-effect", modelCallId: "model-1" });
			const run = async (probe?: LatencyAudit) => {
				const stream = streamOpenAICompletions(
					selected,
					{ messages: [] },
					{
						apiKey: "secret-test-key",
						fetch: async () => {
							const response = new Response(
								fragments
									.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
									.join("") + "data: [DONE]\n\n",
								{ headers: { "content-type": "text/event-stream" } },
							);
							if (probe)
								attachLatencyResponse(response, {
									audit: probe,
									fields: { physicalRequestOrdinal: 1 },
									first: new Set(),
								});
							return response;
						},
					},
				);
				const output: string[] = [];
				for await (const event of stream) {
					if (event.type === "text_delta" || event.type === "thinking_delta")
						output.push(`${event.type}:${event.delta}`);
				}
				expect((await stream.result()).stopReason).toBe("stop");
				return output;
			};
			expect(await run(audit)).toEqual(await run());
			const normalized = audit.marks.filter(mark => mark.stage === "normalized_first");
			expect(normalized.map(mark => mark.stream)).toEqual(
				fragments[0] === "<" ? ["assistant"] : ["thinking", "assistant"],
			);
			for (const mark of normalized) {
				expect(mark.sourceCorrelation).toBe("unknown");
				expect(mark.parsedAt).toBeUndefined();
			}
		}
	});

	it("does not count a retry-budget rejection as a physical provider dispatch", async () => {
		const audit = new LatencyAudit({ effectId: "budget-effect", modelCallId: "model-1" });
		const hook = new ProviderAdmissionClient("http://127.0.0.1/admission", "token", async () =>
			Response.json({ allowed: true }),
		).createHook(identity(), { invalidateUsageCache: async () => {} } as unknown as AuthStorage, "https://provider.invalid");
		let rawCalls = 0;
		await withProviderRetryBudget(1, () =>
			withProviderObservationContext(
				audit.identity as { effectId: string; modelCallId: string },
				async () => {
					const wrapped = createProviderRetryBudgetHook(hook).wrapFetch(model(), (input, init) =>
						latencyFetch(
							async () => {
								rawCalls++;
								return new Response("ok");
							},
							input,
							init,
						),
					);
					await (await wrapped("https://provider.invalid")).text();
					await expect(wrapped("https://provider.invalid")).rejects.toThrow("retry");
				},
				audit,
				recorder().record,
			),
		);
		expect(rawCalls).toBe(1);
		expect(audit.marks.filter(mark => mark.stage === "fetch_start")).toHaveLength(1);
		const before = audit.marks.find(mark => mark.stage === "quota_before_done")!;
		const fetch = audit.marks.find(mark => mark.stage === "fetch_start")!;
		expect(before.at).toBeLessThanOrEqual(fetch.at);
	});
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
				executionPin?: string;
			};
			if (body.phase === "before") {
				admissionBefore += 1;
				expect(body.modelId).toBe("gpt-5.6-terra");
				expect(body.accountBindingId).toBe("acct-1");
				expect(body.usageReport?.metadata?.accountId).toBe("acct-1");
				expect(body.usageReport?.raw).toBeUndefined();
				expect(body.executionPin).toBe("a".repeat(64));
			} else admissionAfter += 1;
			return Response.json({ allowed: true, status: "within_weekly_ceiling" });
		};
		const authStorage = {
			listOAuthAccounts: () => [{ credentialId: 7 }],
			getOAuthCredential: () => ({ type: "oauth", access: "claimed", refresh: "claimed", expires: Date.now() + 60_000 }),
			invalidateUsageCache: async () => {
				invalidations += 1;
			},
			fetchCredentialUsageReport: async (provider: string, credentialId: number) => {
				expect({ provider, credentialId }).toEqual({ provider: "openai-codex", credentialId: 7 });
				usageReads += 1;
				return usageReport();
			},
		} as unknown as AuthStorage;
		const wrapped = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", admissionFetch)
			.createHook({ ...identity(), executionPin: "a".repeat(64) }, authStorage, "https://chatgpt.com/backend-api",
				[], { accountId: "acct-1", credentialId: 7 })
			.wrapFetch(model(), async () => {
				providerCalls += 1;
				return new Response("ok");
			});
		const { requests, record } = recorder();
		await withProviderObservationContext({ effectId: "model_effect_admit", modelCallId: "model-1" }, async () => {
			await wrapped("https://chatgpt.com/backend-api/codex/responses");
			await wrapped("https://chatgpt.com/backend-api/codex/responses");
		}, undefined, record);
		await Promise.resolve();
		expect({ admissionBefore, usageReads, providerCalls }).toEqual({
			admissionBefore: 2,
			usageReads: 2,
			providerCalls: 2,
		});
		// The exact credential reader is already fresh; only the after-phase invalidates.
		expect(invalidations).toBe(2);
		expect(admissionAfter).toBe(2);
		expect(requests.map(({ ordinal, state, statusCode }) => ({ ordinal, state, statusCode }))).toEqual([
			{ ordinal: 1, state: "responded", statusCode: 200 },
			{ ordinal: 2, state: "responded", statusCode: 200 },
		]);
	});

	it("rejects missing or denied launch pins instead of admitting a mutable subscription profile", async () => {
		for (const decision of [
			{ allowed: true },
			{ allowed: true, executionPin: "bad" },
			{ allowed: false, status: "provider_identity_stale" },
		]) {
			const client = new ProviderAdmissionClient("http://127.0.0.1/admission", "token", async () =>
				Response.json(decision),
			);
			await expect(client.pin(identity(), model().id)).rejects.toBeInstanceOf(ProviderAdmissionError);
		}
		const client = new ProviderAdmissionClient("http://127.0.0.1/admission", "token", async (_input, init) => {
			const request = JSON.parse(String(init?.body));
			expect(request.phase).toBe("pin");
			expect(request.modelId).toBe(model().id);
			expect(request.usageReport).toBeUndefined();
			return Response.json({ allowed: true, executionPin: "a".repeat(64) });
		});
		expect(await client.pin(identity(), model().id)).toBe("a".repeat(64));
	});

	it("fails closed with a permanent typed error before provider dispatch", async () => {
		const admissionFetch = async () => Response.json({ allowed: false, status: "codex_weekly_ceiling_reached" });
		const authStorage = { invalidateUsageCache: async () => {} } as unknown as AuthStorage;
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

	it("requires current admission for an exact pinned API-key fallback and refuses foreign routes", async () => {
		let admissionCalls = 0;
		let providerCalls = 0;
		const authStorage = { invalidateUsageCache: async () => {} } as unknown as AuthStorage;
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async () => {
			admissionCalls += 1;
			return Response.json({ allowed: true });
		}).createHook(identity(), authStorage, "https://chatgpt.com/backend-api", [
			{
				...identity(),
				providerAccountRef: "gctx:4444444444444444",
				routeRef: "gctx:5555555555555555",
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
		await withProviderObservationContext({ effectId: "model_effect_fallback", modelCallId: "model-1" },
			() => fallbackFetch("https://cheapai.invalid/v1/responses"), undefined, recorder().record);
		expect({ admissionCalls, providerCalls }).toEqual({ admissionCalls: 1, providerCalls: 1 });

		for (const foreignSubscription of [
			{ ...fallbackModel, provider: "other-subscription" },
			{ ...fallbackModel, baseUrl: "https://other.invalid/v1" },
		]) {
			const foreignFetch = hook.wrapFetch(foreignSubscription as Model, async () => new Response("unexpected"));
			const error = await foreignFetch("https://other.invalid/v1/responses").catch(reason => reason);
			expect(error).toMatchObject({ code: "provider_identity_mismatch", retryable: false });
		}
		expect(admissionCalls).toBe(1);
	});

	it("stops waiting for a shared usage refresh when the provider request is cancelled", async () => {
		const cancelled = new Error("turn cancelled");
		const controller = new AbortController();
		const authStorage = {
			invalidateUsageCache: async () => {},
			fetchCredentialUsageReport: () => new Promise<UsageReport | null>(() => {}),
		} as unknown as AuthStorage;
		let providerCalls = 0;
		const wrapped = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async () =>
			Response.json({ allowed: true }),
		)
			.createHook(identity(), authStorage, "https://chatgpt.com/backend-api", [], { accountId: "acct-1", credentialId: 7 })
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
			if (body.phase === "before") return Response.json({ allowed: true });
			observations.push(body);
			return observations.length === 1
				? new Response("lost acknowledgement", { status: 503 })
				: Response.json({ allowed: true, status: "recorded" });
		};
		const route = {
			...identity(),
			providerAccountRef: "gctx:4444444444444444",
			routeRef: "gctx:5555555555555555",
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
			undefined,
			recorder().record,
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

	it("reports a bounded secret-free summary after observation rejection", async () => {
		const warnings = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const requests: Array<Record<string, unknown>> = [];
			const route = {
				...identity(),
				providerAccountRef: "gctx:4444444444444444",
				routeRef: "gctx:5555555555555555",
				providerId: "cheapai",
				runtimeProviderId: "artel-4444444444444444",
				modelId: "gpt-5.6-terra",
				baseUrl: "https://cheapai.invalid/v1",
			};
			const hook = new ProviderAdmissionClient(
				"http://127.0.0.1/provider-admission",
				"host-token-must-not-enter-log",
				async (_input, init) => {
					const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
					if (body.phase === "before") return Response.json({ allowed: true });
					requests.push(body);
					return Response.json({ allowed: false, status: "provider_observation_identity_stale" });
				},
			).createHook(undefined, {} as AuthStorage, "", [route]);
			const wrapped = hook.wrapFetch(
				{ id: route.modelId, provider: route.runtimeProviderId, baseUrl: route.baseUrl } as Model,
				async () => new Response("completed answer"),
			);
			await withProviderObservationContext(
				{ effectId: "model_effect_rejected", modelCallId: "model-rejected" },
				async () => await (await wrapped("https://cheapai.invalid/v1/chat/completions")).text(),
				undefined,
				recorder().record,
			);
			expect(requests).toHaveLength(2);
			expect(requests[0]).toEqual(requests[1]);
			expect(warnings).toHaveBeenCalledWith("Provider route observation was not recorded", {
				observationId: "model_effect_rejected.1.5555555555555555",
				effectId: "model_effect_rejected",
				routeRef: route.routeRef,
				status: "provider_observation_identity_stale",
				attempts: 2,
			});
			expect(JSON.stringify(warnings.mock.calls)).not.toContain("host-token-must-not-enter-log");
			expect(JSON.stringify(warnings.mock.calls)).not.toContain("completed answer");
		} finally {
			warnings.mockRestore();
		}
	});

	it("does not delay provider fallback while a failed-route observation is pending", async () => {
		const observationStarted = Promise.withResolvers<void>();
		const observationRelease = Promise.withResolvers<Response>();
		let observation: Record<string, unknown> | undefined;
		const route = {
			...identity(),
			providerAccountRef: "gctx:4444444444444444",
			routeRef: "gctx:5555555555555555",
			providerId: "cheapai",
			runtimeProviderId: "artel-4444444444444444",
			modelId: "gpt-5.6-terra",
			baseUrl: "https://cheapai.invalid/v1",
		};
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (body.phase === "before") return Response.json({ allowed: true });
			observation = body;
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
				wrapped("https://cheapai.invalid/v1/chat/completions"), undefined, recorder().record,
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
			...identity(),
			providerAccountRef: "gctx:4444444444444444",
			routeRef: "gctx:5555555555555555",
			providerId: "cheapai",
			runtimeProviderId: "artel-4444444444444444",
			modelId: "gpt-5.6-terra",
			baseUrl: "https://cheapai.invalid/v1",
		};
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (body.phase !== "before") observations.push(body);
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
			undefined,
			recorder().record,
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
			...identity(),
			providerAccountRef: "gctx:4444444444444444",
			routeRef: "gctx:5555555555555555",
			providerId: "cheapai",
			runtimeProviderId: "artel-4444444444444444",
			modelId: "gpt-5.6-terra",
			baseUrl: "https://cheapai.invalid/v1",
		};
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (body.phase !== "before") observations.push(body);
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
			undefined,
			recorder().record,
		);
		expect(observations).toEqual([]);
	});

	it("makes each physical request durable before sending and settles its fate", async () => {
		const route = {
			...identity(),
			providerAccountRef: "gctx:4444444444444444",
			routeRef: "gctx:5555555555555555",
			providerId: "cheapai",
			runtimeProviderId: "artel-4444444444444444",
			modelId: "gpt-5.6-terra",
			baseUrl: "https://cheapai.invalid/v1",
		};
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async () =>
			Response.json({ allowed: true }),
		).createHook(undefined, {} as AuthStorage, "", [route]);
		const routeModel = { id: route.modelId, provider: route.runtimeProviderId, baseUrl: route.baseUrl } as Model;
		const sent: string[] = [];
		const outcomes: Array<() => Promise<Response>> = [
			async () => new Response("first", { status: 200 }),
			async () => {
				throw new ProviderExecutionError("provider_execution_denied", "material refused before sending");
			},
			async () => {
				throw new Error("HTTP 503 upstream unavailable");
			},
			async () => {
				throw new Error("socket reset");
			},
		];
		const wrapped = hook.wrapFetch(routeModel, async input => {
			sent.push(String(input));
			return await outcomes[sent.length - 1]!();
		});
		const { requests, record } = recorder();
		await withProviderObservationContext({ effectId: "model_effect_facts", modelCallId: "model-facts" }, async () => {
			await (await wrapped("https://cheapai.invalid/v1/chat/completions")).text();
			await expect(wrapped("https://cheapai.invalid/v1/chat/completions")).rejects.toBeInstanceOf(ProviderExecutionError);
			await expect(wrapped("https://cheapai.invalid/v1/chat/completions")).rejects.toThrow("HTTP 503");
			await expect(wrapped("https://cheapai.invalid/v1/chat/completions")).rejects.toThrow("socket reset");
			// Off-boundary egress (dot segments are resolved) is refused before any record or send.
			await expect(wrapped("https://cheapai.invalid/v1/../token")).rejects.toMatchObject({
				code: "provider_egress_unadmitted",
			});
			await expect(wrapped("https://oauth2.googleapis.com/token")).rejects.toMatchObject({
				code: "provider_egress_unadmitted",
			});
		}, undefined, record);
		expect(sent).toHaveLength(4);
		expect(requests).toEqual([
			{ ordinal: 1, executionDigest: route.executionDigest, routeRef: route.routeRef, accountRef: route.providerAccountRef, state: "responded", statusCode: 200 },
			{ ordinal: 2, executionDigest: route.executionDigest, routeRef: route.routeRef, accountRef: route.providerAccountRef, state: "not_sent", statusCode: null },
			{ ordinal: 3, executionDigest: route.executionDigest, routeRef: route.routeRef, accountRef: route.providerAccountRef, state: "responded", statusCode: 503 },
			{ ordinal: 4, executionDigest: route.executionDigest, routeRef: route.routeRef, accountRef: route.providerAccountRef, state: "send_unknown", statusCode: null },
		]);

		// A failed durable registration sends nothing; without an effect record nothing is sent either.
		const failing: ProviderRequestRecord = {
			register: async () => {
				throw new Error("durable write failed");
			},
			settle: async () => {},
		};
		await expect(withProviderObservationContext({ effectId: "model_effect_unwritten", modelCallId: "model-x" },
			() => wrapped("https://cheapai.invalid/v1/chat/completions"), undefined, failing)).rejects.toThrow("durable write failed");
		await expect(wrapped("https://cheapai.invalid/v1/chat/completions")).rejects.toMatchObject({
			code: "provider_effect_unadmitted",
		});
		expect(sent).toHaveLength(4);
	});

	it("admits a non-fetch physical request through the same boundary and facts", async () => {
		const route = {
			...identity(),
			providerAccountRef: "gctx:4444444444444444",
			routeRef: "gctx:5555555555555555",
			providerId: "cursor",
			runtimeProviderId: "artel-cursor",
			modelId: "composer-2",
			baseUrl: "https://api2.cursor.sh",
		};
		let admissions = 0;
		let denyNext = false;
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async (_input, init) => {
			if (JSON.parse(String(init?.body)).phase !== "before") return Response.json({ allowed: true });
			admissions += 1;
			if (!denyNext) return Response.json({ allowed: true });
			denyNext = false;
			return Response.json({ allowed: false, status: "provider_quota_exhausted" });
		}).createHook(undefined, {} as AuthStorage, "", [route]);
		const routeModel = { id: route.modelId, provider: route.runtimeProviderId, baseUrl: route.baseUrl } as Model;
		let sends = 0;
		const h2 = (send: () => Promise<number | null>) =>
			hook.wrapRequest(routeModel, { url: "https://api2.cursor.sh/agent.v1.AgentService/Run", send });
		const { requests, record } = recorder();
		await withProviderObservationContext({ effectId: "model_effect_h2", modelCallId: "model-h2" }, async () => {
			expect(await h2(async () => {
				sends += 1;
				return 200;
			})).toBe(200);
			// A quota denial refuses before any record or HTTP/2 stream is opened.
			denyNext = true;
			await expect(h2(async () => {
				sends += 1;
				return 200;
			})).rejects.toMatchObject({ code: "provider_quota_exhausted" });
			// Material refused inside the transport never reached the provider.
			await expect(h2(async () => {
				throw new ProviderExecutionError("provider_execution_denied", "material refused before the stream");
			})).rejects.toBeInstanceOf(ProviderExecutionError);
			await expect(h2(async () => {
				sends += 1;
				throw new Error("stream killed mid-flight");
			})).rejects.toThrow("stream killed");
			// Off-boundary h2 egress is refused like any fetch.
			await expect(hook.wrapRequest(routeModel, { url: "https://cursor.com/api/other", send: async () => 200 }))
				.rejects.toMatchObject({ code: "provider_egress_unadmitted" });
		}, undefined, record);
		expect({ admissions, sends }).toEqual({ admissions: 4, sends: 2 });
		expect(requests.map(({ ordinal, state, statusCode }) => ({ ordinal, state, statusCode }))).toEqual([
			{ ordinal: 1, state: "responded", statusCode: 200 },
			{ ordinal: 2, state: "not_sent", statusCode: null },
			{ ordinal: 3, state: "send_unknown", statusCode: null },
		]);
	});

	it("serializes durable registration so concurrent requests never share an ordinal", async () => {
		const route = {
			...identity(),
			providerAccountRef: "gctx:4444444444444444",
			routeRef: "gctx:5555555555555555",
			providerId: "cheapai",
			runtimeProviderId: "artel-4444444444444444",
			modelId: "gpt-5.6-terra",
			baseUrl: "https://cheapai.invalid/v1",
		};
		// Both requests pass admission before the first durable write finishes.
		const bothAdmitted = Promise.withResolvers<void>();
		let admitted = 0;
		const hook = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", async (_input, init) => {
			if (JSON.parse(String(init?.body)).phase === "before" && ++admitted === 2) bothAdmitted.resolve();
			return Response.json({ allowed: true });
		}).createHook(undefined, {} as AuthStorage, "", [route]);
		const wrapped = hook.wrapFetch(
			{ id: route.modelId, provider: route.runtimeProviderId, baseUrl: route.baseUrl } as Model,
			async () => new Response("ok"),
		);
		// A slow durable write: the second request (speculative compaction beside the turn) arrives meanwhile.
		const { requests, record } = recorder();
		const firstWrite = Promise.withResolvers<void>();
		let writes = 0;
		const slow: ProviderRequestRecord = {
			register: async (effectId, ordinal, frozen) => {
				if (++writes === 1) await firstWrite.promise;
				await record.register(effectId, ordinal, frozen);
			},
			settle: record.settle,
		};
		await withProviderObservationContext({ effectId: "model_effect_parallel", modelCallId: "model-p" }, async () => {
			const both = Promise.all([
				wrapped("https://cheapai.invalid/v1/chat/completions"),
				wrapped("https://cheapai.invalid/v1/chat/completions"),
			]);
			await bothAdmitted.promise;
			await Bun.sleep(0);
			firstWrite.resolve();
			await both;
		}, undefined, slow);
		expect(requests.map(({ ordinal, state }) => ({ ordinal, state }))).toEqual([
			{ ordinal: 1, state: "responded" },
			{ ordinal: 2, state: "responded" },
		]);
	});
	it.each(["anthropic", "cursor"] as const)("uses one fresh exact-account %s report to gate egress", async provider => {
		let accountId = "acct-1";
		let exhausted = true;
		let reads = 0;
		let sent = 0;
		const fetchedAt = Date.now();
		const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const auth = {
			listOAuthAccounts: () => [{ credentialId: 7 }],
			getOAuthCredential: () => ({ type: "oauth", access: `${encode({ alg: "none" })}.${encode({ sub: accountId })}.sig`,
				refresh: "private", expires: Date.now() + 60_000 }),
			fetchCredentialUsageReport: async () => {
				reads++;
				return { provider, fetchedAt, metadata: provider === "cursor" ? {} : { accountId },
					limits: [{ id: `${provider}:window`, status: exhausted ? "exhausted" : "ok",
						amount: { remainingFraction: exhausted ? 0 : 0.6 }, window: { durationMs: 18_000_000 } }],
					raw: { accessToken: "must-not-cross-boundary" } } as UsageReport;
			},
			invalidateUsageCache: async () => {},
		} as unknown as AuthStorage;
		const before: Array<Record<string, unknown>> = [];
		const client = new ProviderAdmissionClient("http://admission.invalid", "fixture", async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (body.phase !== "before") return Response.json({ allowed: true });
			before.push(body);
			const observations = body.usageObservations?.observations as Array<{ metric: string; value: number }> | undefined;
			return Response.json({ allowed: !observations?.some(row => row.metric === "exhausted" && row.value === 1),
				status: "quota_exhausted" });
		});
		const selected = { ...model(), provider };
		const wrapped = client.createHook({
			...identity(), providerId: provider,
			providerKind: provider === "cursor" ? "cursor_subscription" : "anthropic_subscription",
		}, auth, "https://provider.invalid", [], { accountId: "acct-1", credentialId: 7 }, undefined, {
			provider_id: provider, external_id: "acct-1", pools: [],
			quota_windows: [{ window_id: `${provider}:window`, window_seconds: 18_000 }],
		}).wrapFetch(selected, async () => { sent++; return new Response("ok"); });
		const invoke = () => withProviderObservationContext({ effectId: `effect-${reads}`, modelCallId: `model-${reads}` },
			() => wrapped("https://provider.invalid/model"), undefined, recorder().record);
		await expect(invoke()).rejects.toMatchObject({ code: "quota_exhausted" });
		expect(sent).toBe(0);
		exhausted = false;
		expect((await invoke()).status).toBe(200);
		expect(sent).toBe(1);
		expect(before[1]?.usageObservations).toMatchObject({ accountId: "acct-1",
			observedAt: new Date(fetchedAt).toISOString(), observations: [expect.objectContaining({
				metric: "quota_remaining", value: 0.6, observed_at: new Date(fetchedAt).toISOString(),
			})] });
		accountId = "foreign";
		await invoke();
		expect(before[2]?.usageObservations).toBeUndefined();
		expect(before[2]?.usageStatus).toBe("unavailable");
		expect(reads).toBe(3);
		expect(JSON.stringify(before)).not.toContain("must-not-cross-boundary");
		expect(before.every(row => row.usageReport === undefined)).toBeTrue();
	});

});

function identity(): ProviderAdmissionIdentity {
	return {
		expectedPrincipalId: "grimoire:user:owner",
		agentInstanceRef: `grimoire://agents/~u/${"b".repeat(64)}/fixture`,
		attemptId: "fixture-attempt", bindingRevision: 1, installationId: `install_${"a".repeat(32)}`,
		dispatchRef: "gctx:1111111111111111", dispatchHash: `sha256:${"1".repeat(64)}`,
		executionDigest: `sha256:${"d".repeat(64)}`, originReceiptId: "origin-fixture", credentialGeneration: 1,
		providerAccountRef: "gctx:2222222222222222",
		providerAccountContentHash: `sha256:${"2".repeat(64)}`,
		routeRef: "gctx:3333333333333333",
		routeContentHash: `sha256:${"3".repeat(64)}`,
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

/** The durable request record every Engine model effect supplies, kept in memory. */
function recorder() {
	const requests: Array<{
		ordinal: number;
		executionDigest: string;
		routeRef: string;
		accountRef: string;
		state: string;
		statusCode: number | null;
	}> = [];
	const record: ProviderRequestRecord = {
		register: async (_effectId, ordinal, frozen) => {
			expect(ordinal).toBe(requests.length + 1);
			requests.push({ ordinal, ...frozen, state: "planned", statusCode: null });
		},
		settle: async (_effectId, ordinal, state, statusCode) => {
			const request = requests[ordinal - 1]!;
			expect(request.state).toBe("planned");
			Object.assign(request, { state, statusCode });
		},
	};
	return { requests, record };
}
