import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	HttpProviderCallAuthority,
	providerCallReceiptPayloadSha256,
	providerCallReceiptRequestSha256,
	providerCallReceiptWirePayload,
	StrictProviderCallLifecycle,
} from "@oh-my-pi/pi-ai/provider-call-authority";
import { InMemoryProviderCallJournal } from "@oh-my-pi/pi-ai/provider-call-journal";
import {
	type ProviderCallOriginAssignment,
	resolveProviderCallOriginBinding,
} from "@oh-my-pi/pi-ai/provider-call-origin-manifest";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	Context,
	FetchImpl,
	ModelSpec,
	ProviderCallAuthority,
	ProviderCallContext,
	ProviderCallReceiptAck,
	ProviderCallReceiptRequest,
	ProviderCallReservation,
	ProviderCallReserveRequest,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const CONTEXT: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

const CAPACITY_ASSIGNMENT_SHA256 = `sha256:${"f".repeat(64)}`;

const OPENAI_MODEL = buildModel({
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: true,
	input: ["text"],
	contextWindow: 372_000,
	maxTokens: 65_536,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"openai-completions">);

const RESPONSES_MODEL = buildModel({
	id: "grok-4.6",
	name: "Grok 4.6",
	api: "openai-responses",
	provider: "xai-oauth",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 372_000,
	maxTokens: 65_536,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"openai-responses">);

const GEMINI_MODEL = buildModel({
	id: "gemini-3.7-flash",
	name: "Gemini 3.7 Flash",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	reasoning: true,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 32_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"google-gemini-cli">);

const DIRECTOR_GEMINI_MODEL = buildModel({
	id: "gemini-3.7-flash",
	name: "Gemini 3.7 Flash Director",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	reasoning: true,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 32_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"google-gemini-cli">);

const KIMI_MODEL = buildModel({
	id: "k3",
	name: "K3",
	api: "openai-completions",
	provider: "kimi-code",
	baseUrl: "https://api.kimi.com/coding/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 262_144,
	maxTokens: 32_768,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { kimiApiFormat: "openai" },
} satisfies ModelSpec<"openai-completions">);

const GPT_PROXY_MODEL = buildModel({
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	api: "openai-completions",
	provider: "gpt-proxy",
	baseUrl: "https://provider.invalid/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 372_000,
	maxTokens: 65_536,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"openai-completions">);

function originAssignment(
	configId: string,
	credentialGeneration: string,
	routeOrdinal = 0,
): ProviderCallOriginAssignment {
	const binding = resolveProviderCallOriginBinding(configId, routeOrdinal);
	return {
		...binding.frozenStaticAssignment,
		capability_generation: "capability-generation-20260823",
		credential_generation: credentialGeneration,
		source_release_digest: `sha256:${"a".repeat(64)}`,
		restricted_proxy_policy_sha256: `sha256:${"b".repeat(64)}`,
		origin_descriptor: structuredClone(binding.originDescriptor.preimage),
		route_binding_descriptor: structuredClone(binding.bindingDescriptor.preimage),
	};
}

function providerCallContext(overrides: Partial<ProviderCallContext> = {}): ProviderCallContext {
	const context = {
		mode: "strict",
		configId: "deepseek-v4-pro-0813-max-r3",
		taskReservationId: "00000000-0000-4000-8000-000000000001",
		executionBindingId: "00000000-0000-4000-8000-000000000002",
		podUid: "pod-uid",
		callSequence: "1",
		idempotencyKey: "00000000-0000-4000-8000-000000000003",
		apiFamily: "openai-completions",
		provider: "deepseek",
		accountId: "account-1",
		modelId: "deepseek-v4-pro",
		credentialGeneration: "generation-1",
		capabilityId: "00000000-0000-4000-8000-000000000004",
		snapshotId: "00000000-0000-4000-8000-000000000005",
		assignmentSha256: CAPACITY_ASSIGNMENT_SHA256,
		tokenizerContractSha256: `sha256:${"1".repeat(64)}`,
		inputTokens: "3",
		maxOutputTokens: "65536",
		expectedDimensions: [
			{ dimension: "concurrency", windowId: "-", amount: "1", unitScale: "0", windowStart: null, windowEnd: null },
			{
				dimension: "tpm_input_tokens",
				windowId: "window-1",
				amount: "3",
				unitScale: "0",
				windowStart: "2026-08-23T00:00:00.000000Z",
				windowEnd: "2026-08-23T00:01:00.000000Z",
			},
			{
				dimension: "tpm_output_tokens",
				windowId: "window-1",
				amount: "65536",
				unitScale: "0",
				windowStart: "2026-08-23T00:00:00.000000Z",
				windowEnd: "2026-08-23T00:01:00.000000Z",
			},
			{
				dimension: "tpm_total_tokens",
				windowId: "window-1",
				amount: "65539",
				unitScale: "0",
				windowStart: "2026-08-23T00:00:00.000000Z",
				windowEnd: "2026-08-23T00:01:00.000000Z",
			},
		],
		...overrides,
	} satisfies Omit<ProviderCallContext, "originAssignment"> & Partial<Pick<ProviderCallContext, "originAssignment">>;
	return {
		...context,
		originAssignment: context.originAssignment ?? originAssignment(context.configId, context.credentialGeneration),
	};
}

function strictRuntimeOptions(context: ProviderCallContext): SimpleStreamOptions {
	return {
		providerCallContext: context,
		providerCallCredential: {
			accountId: context.accountId,
			credentialGeneration: context.credentialGeneration,
			apiKey: "provider-secret",
			bearerToken: "provider-secret",
		},
		providerCallJournal: new InMemoryProviderCallJournal(),
	};
}

function sseResponse(
	modelId = OPENAI_MODEL.id,
	usage: unknown = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
): Response {
	const events = [
		{
			id: "chatcmpl-authority",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: { content: "hello" } }],
		},
		{
			id: "chatcmpl-authority",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage,
		},
		"[DONE]",
	];
	return new Response(
		`${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream", "x-request-id": "req-authority" },
		},
	);
}

function responsesSse(usage: unknown = { input_tokens: 3, output_tokens: 1, total_tokens: 4 }): Response {
	const frames = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "hello" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
		},
		{
			type: "response.completed",
			response: { status: "completed", usage },
		},
	];
	return new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function geminiSse(
	usageMetadata: unknown = { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
): Response {
	const frame = {
		response: {
			candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }],
			usageMetadata,
		},
	};
	return new Response(`data: ${JSON.stringify(frame)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function recordingAuthority(events: string[]) {
	const reserves: ProviderCallReserveRequest[] = [];
	const receipts: ProviderCallReceiptRequest[] = [];
	const authority: ProviderCallAuthority = {
		async reserve(request) {
			events.push("reserve");
			reserves.push(request);
			return {
				reservationId: "00000000-0000-4000-8000-000000000006",
				disposition: "created",
				callSequence: request.context.callSequence,
				idempotencyKey: request.context.idempotencyKey,
				requestSha256: request.requestSha256,
				issuePermit: `pcr1_${"A".repeat(43)}`,
				issueAuthorizedAt: "2026-08-23T00:00:00.000000Z",
				originAssignment: request.context.originAssignment,
				assignmentSha256: request.context.assignmentSha256,
			} satisfies ProviderCallReservation;
		},
		async recover() {
			throw new Error("must not recover during a live unambiguous reserve");
		},
		async recordReceipt(receipt) {
			events.push(`receipt:${receipt.classification}`);
			receipts.push(receipt);
			return {
				disposition: "created",
				reservationId: receipt.reservation.reservationId,
				state: receipt.classification,
				receiptOperationId: receipt.receiptOperationId,
				receiptSha256: providerCallReceiptRequestSha256(receipt),
				recordedAt: "2026-08-23T00:00:00.000000Z",
				settlements: [],
				capabilityState: receipt.classification === "terminal" ? "ready" : "zero",
				zeroReason: receipt.classification === "terminal" ? "" : "ambiguous_provider_call",
			} satisfies ProviderCallReceiptAck;
		},
	};
	return { authority, reserves, receipts };
}

function fetchImpl(fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): FetchImpl {
	return Object.assign(fn, { preconnect: fetch.preconnect });
}

describe("strict provider-call authority", () => {
	it("blocks before dispatch when strict mode has no authority", () => {
		let egress = 0;
		const invoke = () =>
			streamSimple(OPENAI_MODEL, CONTEXT, {
				...strictRuntimeOptions(providerCallContext()),
				apiKey: "not-observed",
				fetch: fetchImpl(async () => {
					egress++;
					return sseResponse();
				}),
			});
		expect(invoke).toThrow(/provider-call authority/i);
		expect(egress).toBe(0);
	});

	it("fails strict mode before authority or egress for unknown and unresolved config origins", () => {
		for (const configId of ["unknown-config", "sol-low"]) {
			let reserves = 0;
			let egress = 0;
			const authority: ProviderCallAuthority = {
				async reserve() {
					reserves++;
					throw new Error("must not reserve");
				},
				async recover() {
					throw new Error("must not recover");
				},
				async recordReceipt() {
					throw new Error("must not record");
				},
			};
			const invoke = () =>
				streamSimple(GPT_PROXY_MODEL, CONTEXT, {
					...strictRuntimeOptions(
						providerCallContext({
							configId,
							provider: GPT_PROXY_MODEL.provider,
							modelId: GPT_PROXY_MODEL.id,
						}),
					),
					apiKey: "not-observed",
					providerCallAuthority: authority,
					fetch: fetchImpl(async () => {
						egress++;
						return sseResponse(GPT_PROXY_MODEL.id);
					}),
				});
			expect(invoke).toThrow(configId === "unknown-config" ? /unknown config/i : /dedicated Codex authority/i);
			expect(reserves).toBe(0);
			expect(egress).toBe(0);
		}
	});

	it("rejects every retry path after the one issue permit consumes provider egress", async () => {
		const retryPaths = [
			"redirect",
			"auth rotation",
			"provider endpoint fallback",
			"empty stream",
			"strict tool fallback",
			"reasoning fallback",
			"stale response chain",
			"SDK retry",
		];
		for (const retryPath of retryPaths) {
			const events: string[] = [];
			const { authority } = recordingAuthority(events);
			let egress = 0;
			const providerFetch = fetchImpl(async () => {
				egress++;
				return sseResponse();
			});
			const strictOptions = strictRuntimeOptions(providerCallContext());
			const lifecycle = new StrictProviderCallLifecycle(
				OPENAI_MODEL,
				{ ...strictOptions, fetch: providerFetch },
				authority,
			);
			const options = lifecycle.options({
				...strictOptions,
				fetch: providerFetch,
			});
			const payload = { model: OPENAI_MODEL.id, messages: [] };
			await options.onPayload?.(payload, OPENAI_MODEL);
			const init = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			};
			await options.fetch?.("https://api.deepseek.com/chat/completions", init);
			await expect(options.fetch?.("https://api.deepseek.com/chat/completions", init)).rejects.toThrow(
				/single-use; retry rejected/i,
			);
			expect(egress, retryPath).toBe(1);
		}
	});

	it("reserves the exact post-shaping credential-free payload before one manual-redirect egress", async () => {
		const events: string[] = [];
		const { authority, reserves, receipts } = recordingAuthority(events);
		const result = await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext()),
			apiKey: "provider-secret-never-in-payload",
			providerCallAuthority: authority,
			onPayload: payload => ({ ...(payload as Record<string, unknown>), benchmark_marker: "post-shaped" }),
			fetch: fetchImpl(async (_input, init) => {
				events.push("egress");
				expect(init?.redirect).toBe("manual");
				expect(events[0]).toBe("reserve");
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-secret");
				return sseResponse();
			}),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(events).toEqual(["reserve", "egress", "receipt:terminal"]);
		expect(reserves).toHaveLength(1);
		expect(reserves[0]?.payload).toMatchObject({ benchmark_marker: "post-shaped", model: OPENAI_MODEL.id });
		expect(JSON.stringify(reserves[0]?.payload)).not.toContain("provider-secret-never-in-payload");
		expect(reserves[0]?.requestSha256).toBe(
			`sha256:${createHash("sha256").update(reserves[0]!.canonicalRequest).digest("hex")}`,
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			classification: "terminal",
			httpStatus: "200",
			actualDimensions: [
				{ dimension: "concurrency", amount: "1" },
				{ dimension: "tpm_input_tokens", amount: "3" },
				{ dimension: "tpm_output_tokens", amount: "1" },
				{ dimension: "tpm_total_tokens", amount: "4" },
			],
		});
		expect(receipts[0]?.responseSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("never reissues when the provider transport asks fetch to retry", async () => {
		const events: string[] = [];
		const { authority, receipts } = recordingAuthority(events);
		let egress = 0;
		const message = await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext()),
			apiKey: "not-observed",
			providerCallAuthority: authority,
			fetch: fetchImpl(async () => {
				egress++;
				return new Response(JSON.stringify({ error: { message: "transient" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}),
		}).result();
		expect(message.stopReason).toBe("error");
		expect(egress).toBe(1);
		expect(receipts).toHaveLength(1);
	});

	it("records premature EOF as ambiguous and never reissues", async () => {
		const events: string[] = [];
		const { authority, receipts } = recordingAuthority(events);
		let egress = 0;
		const truncated = sseResponse();
		const truncatedBody = (await truncated.text()).replace("data: [DONE]\n\n", "");
		const message = await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext()),
			apiKey: "not-observed",
			providerCallAuthority: authority,
			fetch: fetchImpl(async () => {
				egress++;
				return new Response(truncatedBody, {
					status: 200,
					headers: { "content-type": "text/event-stream", "x-request-id": "req-truncated" },
				});
			}),
		}).result();
		expect(message.stopReason).toBe("stop");
		expect(egress).toBe(1);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			classification: "ambiguous",
			ambiguityClass: "premature_eof",
			httpStatus: "200",
			providerRequestId: "req-truncated",
		});
	});

	it("routes all frozen API families and Kimi through one reserve-egress-receipt lifecycle", async () => {
		const cases = [
			{
				configId: "deepseek-v4-pro-0813-max-r3",
				model: OPENAI_MODEL,
				apiFamily: "openai-completions" as const,
				apiKey: "provider-secret",
				response: sseResponse,
			},
			{
				configId: "grok-4.6-max-official-subscription",
				model: RESPONSES_MODEL,
				apiFamily: "openai-responses" as const,
				apiKey: "provider-secret",
				response: responsesSse,
			},
			{
				configId: "gemini37-max-workflowz",
				model: GEMINI_MODEL,
				apiFamily: "google-gemini-cli" as const,
				apiKey: JSON.stringify({ token: "provider-secret", projectId: "project-1" }),
				response: geminiSse,
			},
			{
				configId: "kimi-k3-high",
				model: KIMI_MODEL,
				apiFamily: "openai-completions" as const,
				apiKey: "provider-secret",
				response: () => sseResponse(KIMI_MODEL.id),
			},
		];
		for (const testCase of cases) {
			const events: string[] = [];
			const { authority, reserves, receipts } = recordingAuthority(events);
			let egress = 0;
			const message = await streamSimple(testCase.model, CONTEXT, {
				...strictRuntimeOptions(
					providerCallContext({
						configId: testCase.configId,
						apiFamily: testCase.apiFamily,
						provider: testCase.model.provider,
						modelId: testCase.model.id,
					}),
				),
				apiKey: testCase.apiKey,
				providerCallAuthority: authority,
				fetch: fetchImpl(async () => {
					egress++;
					return testCase.response();
				}),
			}).result();
			expect(message.stopReason, `${testCase.configId}: ${message.errorMessage ?? ""}`).toBe("stop");
			expect(egress).toBe(1);
			expect(reserves).toHaveLength(1);
			expect(reserves[0]).toMatchObject({
				apiFamily: testCase.apiFamily,
				provider: testCase.model.provider,
				model: testCase.model.id,
			});
			expect(receipts).toHaveLength(1);
		}
	});

	it("uses the strict assigned origin for both OpenAI transports before reservation and egress", async () => {
		const cases = [
			{
				configId: "deepseek-v4-pro-0813-max-r3",
				model: { ...OPENAI_MODEL, baseUrl: "https://competing-catalog.invalid" },
				apiFamily: "openai-completions" as const,
				response: sseResponse,
			},
			{
				configId: "grok-4.6-max-official-subscription",
				model: { ...RESPONSES_MODEL, baseUrl: "https://competing-catalog.invalid/v1" },
				apiFamily: "openai-responses" as const,
				response: responsesSse,
			},
		];
		for (const testCase of cases) {
			const events: string[] = [];
			const { authority, reserves } = recordingAuthority(events);
			const context = providerCallContext({
				configId: testCase.configId,
				apiFamily: testCase.apiFamily,
				provider: testCase.model.provider,
				modelId: testCase.model.id,
			});
			const assignedUrl = `${context.originAssignment.canonical_origin}${context.originAssignment.request_path_and_query}`;
			const expectedUrl = new URL(assignedUrl).toString();
			const egressUrls: string[] = [];
			const message = await streamSimple(testCase.model, CONTEXT, {
				...strictRuntimeOptions(context),
				apiKey: "provider-secret",
				providerCallAuthority: authority,
				fetch: fetchImpl(async input => {
					events.push("fetch");
					egressUrls.push(String(input));
					return testCase.response();
				}),
			}).result();
			expect(message.stopReason, `${testCase.configId}: ${message.errorMessage ?? ""}`).toBe("stop");
			expect(reserves[0]?.credentialFreeUrl).toBe(expectedUrl);
			expect(egressUrls).toEqual([assignedUrl]);
			expect(events.slice(0, 2)).toEqual(["reserve", "fetch"]);
		}
	});

	it("rejects catalog path/query divergence for both OpenAI transports before reservation or egress", async () => {
		const cases = [
			{
				configId: "deepseek-v4-pro-0813-max-r3",
				model: { ...OPENAI_MODEL, baseUrl: "https://competing-catalog.invalid/wrong" },
				apiFamily: "openai-completions" as const,
			},
			{
				configId: "grok-4.6-max-official-subscription",
				model: { ...RESPONSES_MODEL, baseUrl: "https://competing-catalog.invalid/wrong" },
				apiFamily: "openai-responses" as const,
			},
		];
		for (const testCase of cases) {
			const events: string[] = [];
			const { authority, reserves } = recordingAuthority(events);
			const context = providerCallContext({
				configId: testCase.configId,
				apiFamily: testCase.apiFamily,
				provider: testCase.model.provider,
				modelId: testCase.model.id,
			});
			let egress = 0;
			const message = await streamSimple(testCase.model, CONTEXT, {
				...strictRuntimeOptions(context),
				apiKey: "provider-secret",
				providerCallAuthority: authority,
				fetch: fetchImpl(async () => {
					egress++;
					throw new Error("must not reach provider egress");
				}),
			}).result();
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toMatch(/path|query|origin/i);
			expect(reserves).toHaveLength(0);
			expect(events).toHaveLength(0);
			expect(egress).toBe(0);
		}
	});
	it("uses only the pinned Antigravity director-secondary sandbox origin", async () => {
		const events: string[] = [];
		const { authority, reserves, receipts } = recordingAuthority(events);
		const context = providerCallContext({
			configId: "sol-max-director-gemini37-flash-high-fast-vibe",
			apiFamily: "google-gemini-cli",
			provider: "google-antigravity",
			modelId: "gemini-3.7-flash",
			originAssignment: originAssignment("sol-max-director-gemini37-flash-high-fast-vibe", "generation-1", 1),
		});
		const fetched: string[] = [];
		const message = await streamSimple(DIRECTOR_GEMINI_MODEL, CONTEXT, {
			...strictRuntimeOptions(context),
			apiKey: JSON.stringify({ token: "provider-secret", projectId: "project-1" }),
			providerCallAuthority: authority,
			fetch: fetchImpl(async input => {
				fetched.push(String(input));
				return geminiSse();
			}),
		}).result();
		expect(message.stopReason, message.errorMessage ?? "").toBe("stop");
		expect(fetched).toHaveLength(1);
		expect(new URL(fetched[0]!).origin).toBe("https://daily-cloudcode-pa.sandbox.googleapis.com");
		expect(reserves[0]?.context.originAssignment.route_ordinal).toBe(1);
		expect(receipts[0]?.context.originAssignment.binding_descriptor_sha256).toBe(
			"2f2fd6e5418657408d8fb02aad70c499e768257acee38a56b4961d35e754e900",
		);
	});

	it("rejects any reserve assignment divergence before provider fetch and preserves exact assignment into receipts", async () => {
		const context = providerCallContext();
		let fetches = 0;
		const divergentAuthority = recordingAuthority([]);
		divergentAuthority.authority.reserve = async request => ({
			reservationId: "00000000-0000-4000-8000-000000000006",
			disposition: "created",
			callSequence: request.context.callSequence,
			idempotencyKey: request.context.idempotencyKey,
			requestSha256: request.requestSha256,
			issuePermit: `pcr1_${"A".repeat(43)}`,
			issueAuthorizedAt: "2026-08-23T00:00:00.000000Z",
			assignmentSha256: request.context.assignmentSha256,
			originAssignment: {
				...request.context.originAssignment,
				capability_generation: "other-controller-generation",
			},
		});
		const rejected = await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(context),
			apiKey: "provider-secret",
			providerCallAuthority: divergentAuthority.authority,
			fetch: fetchImpl(async () => {
				fetches++;
				return sseResponse();
			}),
		}).result();
		expect(rejected.stopReason).toBe("error");
		expect(rejected.errorMessage).toMatch(/assignment|permit/i);
		expect(fetches).toBe(0);

		const digestDivergentAuthority = recordingAuthority([]);
		digestDivergentAuthority.authority.reserve = async request => ({
			reservationId: "00000000-0000-4000-8000-000000000006",
			disposition: "created",
			callSequence: request.context.callSequence,
			idempotencyKey: request.context.idempotencyKey,
			requestSha256: request.requestSha256,
			issuePermit: `pcr1_${"A".repeat(43)}`,
			issueAuthorizedAt: "2026-08-23T00:00:00.000000Z",
			assignmentSha256: `sha256:${"e".repeat(64)}`,
			originAssignment: request.context.originAssignment,
		});
		const digestRejected = await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(context),
			apiKey: "provider-secret",
			providerCallAuthority: digestDivergentAuthority.authority,
			fetch: fetchImpl(async () => {
				fetches++;
				return sseResponse();
			}),
		}).result();
		expect(digestRejected.stopReason).toBe("error");
		expect(digestRejected.errorMessage).toMatch(/assignment|permit/i);
		expect(fetches).toBe(0);

		const events: string[] = [];
		const exactAuthority = recordingAuthority(events);
		await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(context),
			apiKey: "provider-secret",
			providerCallAuthority: exactAuthority.authority,
			fetch: fetchImpl(async () => sseResponse()),
		}).result();
		expect(exactAuthority.reserves[0]?.context.originAssignment).toEqual(context.originAssignment);
		expect(exactAuthority.receipts[0]?.context.originAssignment).toEqual(context.originAssignment);
		expect(exactAuthority.receipts[0]?.reservation.originAssignment).toEqual(context.originAssignment);
		expect(exactAuthority.receipts[0]?.context.assignmentSha256).toBe(CAPACITY_ASSIGNMENT_SHA256);
		expect(exactAuthority.receipts[0]?.reservation.assignmentSha256).toBe(CAPACITY_ASSIGNMENT_SHA256);
	});

	it("versions and canonical-hashes every durable authority/equality/transport evidence field", async () => {
		const events: string[] = [];
		const { authority, receipts } = recordingAuthority(events);
		const context = providerCallContext();
		await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(context),
			apiKey: "provider-secret",
			providerCallAuthority: authority,
			fetch: fetchImpl(async () => sseResponse()),
		}).result();
		const receipt = receipts[0]!;
		expect(receipt).toMatchObject({
			authorityOwner: "generic-omp-auth-gateway",
			backendEqualityResult: "MATCH",
			providerRequestCount: 1,
			retryCount: 0,
			failoverCount: 0,
			redirectFollowCount: 0,
			finalClassification: "TERMINAL_RESPONSE",
			drainState: "DRAINED",
		});
		const payload = providerCallReceiptWirePayload(receipt);
		expect(payload).toMatchObject({
			schema: "terminal-bench/provider-call-terminal-receipt/v2",
			authority_owner: "generic-omp-auth-gateway",
			backend_equality_result: "MATCH",
			provider_request_count: 1,
			retry_count: 0,
			failover_count: 0,
			redirect_follow_count: 0,
			final_classification: "TERMINAL_RESPONSE",
			drain_state: "DRAINED",
			assignment_sha256: CAPACITY_ASSIGNMENT_SHA256,
			origin_assignment: context.originAssignment,
		});
		const originalHash = providerCallReceiptPayloadSha256(payload, true);
		const changedOriginPayload: Record<string, unknown> = {
			...payload,
			origin_assignment: {
				...(payload.origin_assignment as ProviderCallOriginAssignment),
				capability_generation: "different-origin-generation",
			},
		};
		expect(changedOriginPayload.assignment_sha256).toBe(CAPACITY_ASSIGNMENT_SHA256);
		expect(providerCallReceiptPayloadSha256(changedOriginPayload, true)).not.toBe(originalHash);
		const mutations: Record<string, unknown> = {
			authority_owner: "dedicated-codex-backend",
			backend_equality_result: "MISMATCH",
			provider_request_count: 0,
			retry_count: 1,
			failover_count: 1,
			redirect_follow_count: 1,
			final_classification: "AMBIGUOUS_ATTEMPT",
			drain_state: "FROZEN",
			assignment_sha256: `sha256:${"e".repeat(64)}`,
		};
		for (const [field, replacement] of Object.entries(mutations)) {
			const mutated = { ...payload, [field]: replacement };
			expect(providerCallReceiptPayloadSha256(mutated, true), field).not.toBe(originalHash);
		}
	});

	it("uses the frozen snake-case reserve and classified receipt wire with dual projected-token boundaries", async () => {
		const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
		const authorityFetch = fetchImpl(async (input, init) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			calls.push({ url, init: init ?? {}, body });
			if (url.endsWith("/api/v1/provider-call-reservations")) {
				return Response.json(
					{
						schema: "terminal-bench/provider-call-reservation/v1",
						disposition: "created",
						reservation_id: "00000000-0000-4000-8000-000000000006",
						state: "issue_authorized",
						task_reservation_id: body.task_reservation_id,
						execution_binding_id: body.execution_binding_id,
						pod_uid: body.pod_uid,
						call_sequence: body.call_sequence,
						idempotency_key: body.idempotency_key,
						api_family: body.api_family,
						provider: body.provider,
						account_id: body.account_id,
						model_id: body.model_id,
						credential_generation: body.credential_generation,
						capability_id: body.capability_id,
						snapshot_id: body.snapshot_id,
						request_sha256: body.request_sha256,
						reservation_sha256: `sha256:${"b".repeat(64)}`,
						authority_epoch: "1",
						issue_authorized_at: "2026-08-23T00:00:00.000000Z",
						capability_valid_until: "2026-08-23T01:00:00.000000Z",
						snapshot_expires_at: "2026-08-23T00:01:00.000000Z",
						reserved_dimensions: body.expected_dimensions,
						assignment_sha256: CAPACITY_ASSIGNMENT_SHA256,
						issue_permit: `pcr1_${"A".repeat(43)}`,
						origin_assignment: body.origin_assignment,
					},
					{ status: 201 },
				);
			}
			const expected = calls[0]?.body.expected_dimensions as Array<Record<string, string>>;
			const actual = body.actual_dimensions as Array<Record<string, string>>;
			return Response.json(
				{
					schema: "terminal-bench/provider-call-receipt-result/v1",
					disposition: "created",
					reservation_id: body.reservation_id,
					state: "terminal",
					receipt_operation_id: body.receipt_operation_id,
					receipt_sha256: providerCallReceiptPayloadSha256(body, true),
					recorded_at: "2026-08-23T00:00:01.000000Z",
					settlements: expected.map(dimension => ({
						dimension: dimension.dimension,
						window_id: dimension.window_id,
						reserved_amount: dimension.amount,
						actual_amount: actual.find(
							item => item.dimension === dimension.dimension && item.window_id === dimension.window_id,
						)?.amount,
						settlement: dimension.dimension === "concurrency" ? "released" : "consumed_until_window_end",
					})),
					capability_state: "ready",
					zero_reason: "",
				},
				{ status: 201 },
			);
		});
		const authority = new HttpProviderCallAuthority({
			baseUrl: "https://authority.invalid",
			getGatewayToken: () => "gateway-projected-token",
			getExecutionToken: () => "execution-projected-token",
			fetch: authorityFetch,
		});

		await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext()),
			apiKey: "provider-secret",
			providerCallAuthority: authority,
			fetch: fetchImpl(async () => sseResponse()),
		}).result();

		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toEndWith("/api/v1/provider-call-reservations");
		expect(calls[0]?.body).toMatchObject({
			schema: "terminal-bench/provider-call-reserve/v1",
			task_reservation_id: "00000000-0000-4000-8000-000000000001",
			execution_binding_id: "00000000-0000-4000-8000-000000000002",
			pod_uid: "pod-uid",
			call_sequence: "1",
			api_family: "openai-completions",
			account_id: "account-1",
			model_id: "deepseek-v4-pro",
			request_body_bytes: expect.any(String),
			expected_dimensions: expect.any(Array),
		});
		expect(calls[0]?.body).not.toHaveProperty("config_id");
		expect(JSON.stringify(calls[0]?.body)).not.toContain("provider-secret");
		expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer gateway-projected-token");
		expect(new Headers(calls[0]?.init.headers).get("x-terminal-bench-execution-token")).toBe(
			"execution-projected-token",
		);
		expect(calls[1]?.url).toEndWith(
			"/api/v1/provider-call-reservations/00000000-0000-4000-8000-000000000006/receipts/terminal",
		);
		expect(calls[1]?.body.schema).toBe("terminal-bench/provider-call-terminal-receipt/v2");
		expect(new Headers(calls[1]?.init.headers).has("x-terminal-bench-execution-token")).toBe(false);
		expect(new Headers(calls[1]?.init.headers).get("x-terminal-bench-issue-permit")).toBe(`pcr1_${"A".repeat(43)}`);
	});

	it("recovers a lost reserve response without permit and performs zero provider egress", async () => {
		const authorityPaths: string[] = [];
		const authority = new HttpProviderCallAuthority({
			baseUrl: "https://authority.invalid",
			getGatewayToken: () => "gateway-projected-token",
			getExecutionToken: () => "execution-projected-token",
			fetch: fetchImpl(async input => {
				const url = String(input);
				authorityPaths.push(new URL(url).pathname);
				if (url.endsWith("/api/v1/provider-call-reservations")) throw new TypeError("connection reset");
				return Response.json(
					{
						schema: "terminal-bench/provider-call-reservation/v1",
						disposition: "recovered",
						state: "issue_authorized",
					},
					{ status: 200 },
				);
			}),
		});
		let providerEgress = 0;
		const message = await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext()),
			apiKey: "provider-secret",
			providerCallAuthority: authority,
			fetch: fetchImpl(async () => {
				providerEgress++;
				return sseResponse();
			}),
		}).result();

		expect(message.stopReason).toBe("error");
		expect(providerEgress).toBe(0);
		expect(authorityPaths).toEqual([
			"/api/v1/provider-call-reservations",
			"/api/v1/provider-call-reservations:recover",
		]);
	});

	it("rejects a credential-bearing RequestInit before reserve can issue a permit", async () => {
		const events: string[] = [];
		const { authority, reserves } = recordingAuthority(events);
		let egress = 0;
		const strictOptions = {
			...strictRuntimeOptions(providerCallContext()),
			fetch: fetchImpl(async () => {
				egress++;
				return sseResponse();
			}),
		} as SimpleStreamOptions;
		const lifecycle = new StrictProviderCallLifecycle(OPENAI_MODEL, strictOptions, authority);
		const guarded = lifecycle.options(strictOptions);
		const payload = { model: OPENAI_MODEL.id, messages: [] };
		await guarded.onPayload?.(payload, OPENAI_MODEL);
		await expect(
			guarded.fetch?.("https://api.deepseek.com/chat/completions", {
				method: "POST",
				headers: { authorization: "Bearer provider-secret", "content-type": "application/json" },
				body: JSON.stringify(payload),
			}),
		).rejects.toThrow(/credential-bearing RequestInit/i);
		expect(reserves).toHaveLength(0);
		expect(egress).toBe(0);
	});

	it("rejects credential account and generation mismatches before reserve", () => {
		const events: string[] = [];
		const { authority, reserves } = recordingAuthority(events);
		for (const credential of [
			{
				accountId: "wrong-account",
				credentialGeneration: "generation-1",
				apiKey: "provider-secret",
				bearerToken: "provider-secret",
			},
			{
				accountId: "account-1",
				credentialGeneration: "wrong-generation",
				apiKey: "provider-secret",
				bearerToken: "provider-secret",
			},
		]) {
			const invoke = () =>
				streamSimple(OPENAI_MODEL, CONTEXT, {
					...strictRuntimeOptions(providerCallContext()),
					apiKey: credential.apiKey,
					providerCallAuthority: authority,
					providerCallCredential: credential,
					fetch: fetchImpl(async () => sseResponse()),
				} as SimpleStreamOptions);
			expect(invoke).toThrow(/credential (?:account|generation) mismatch/i);
		}
		expect(reserves).toHaveLength(0);
	});

	it("does not accept a terminal marker embedded in SSE assistant content", async () => {
		const events: string[] = [];
		const { authority, receipts } = recordingAuthority(events);
		const base = await sseResponse().text();
		const misleading = base.replace('"content":"hello"', '"content":"data: [DONE]"').replace("data: [DONE]\n\n", "");
		await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext()),
			apiKey: "provider-secret",
			providerCallAuthority: authority,
			fetch: fetchImpl(async () => new Response(misleading, { headers: { "content-type": "text/event-stream" } })),
		}).result();
		expect(receipts[0]).toMatchObject({ classification: "ambiguous", ambiguityClass: "premature_eof" });
	});

	it("waits for provider EOF and hashes raw bytes that arrive after the exact terminal SSE frame", async () => {
		const events: string[] = [];
		const { authority, receipts } = recordingAuthority(events);
		const terminalBytes = new TextEncoder().encode(await sseResponse().text());
		const trailingBytes = new TextEncoder().encode(": provider-trailer\n\n");
		let providerController!: ReadableStreamDefaultController<Uint8Array>;
		const providerStarted = Promise.withResolvers<void>();
		const result = streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext()),
			apiKey: "provider-secret",
			providerCallAuthority: authority,
			fetch: fetchImpl(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								providerController = controller;
								controller.enqueue(terminalBytes);
								providerStarted.resolve();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					),
			),
		}).result();
		await providerStarted.promise;
		expect(receipts).toHaveLength(0);
		providerController.enqueue(trailingBytes);
		providerController.close();
		const message = await result;
		expect(message.stopReason).toBe("stop");
		expect(receipts[0]).toMatchObject({
			classification: "terminal",
			responseBytesReceived: String(terminalBytes.byteLength + trailingBytes.byteLength),
			responseSha256: `sha256:${createHash("sha256").update(terminalBytes).update(trailingBytes).digest("hex")}`,
		});
	});

	it("drains and hashes malformed UTF-8 through provider EOF independently of raw chunk boundaries", async () => {
		const encode = (value: string) => new TextEncoder().encode(value);
		const concatenate = (...chunks: Uint8Array[]): Uint8Array => {
			const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
			let offset = 0;
			for (const chunk of chunks) {
				joined.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return joined;
		};
		const prefix = encode('data: {"content":"');
		const invalid = Uint8Array.of(0xff);
		const malformedFrameEnd = encode('"}\n\n');
		const terminal = encode("data: [DONE]\n\n");
		const trailer = encode(": raw-trailer\n\n");
		const allBytes = concatenate(prefix, invalid, malformedFrameEnd, terminal, trailer);

		const run = async (chunks: Uint8Array[], proveTiming: boolean): Promise<ProviderCallReceiptRequest> => {
			const events: string[] = [];
			const { authority, receipts } = recordingAuthority(events);
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const providerStarted = Promise.withResolvers<void>();
			const result = streamSimple(OPENAI_MODEL, CONTEXT, {
				...strictRuntimeOptions(providerCallContext()),
				apiKey: "provider-secret",
				providerCallAuthority: authority,
				fetch: fetchImpl(
					async () =>
						new Response(
							new ReadableStream({
								start(createdController) {
									controller = createdController;
									providerStarted.resolve();
								},
							}),
							{ headers: { "content-type": "text/event-stream" } },
						),
				),
			}).result();
			await providerStarted.promise;
			controller.enqueue(chunks[0]);
			if (proveTiming) {
				await new Promise(resolve => setTimeout(resolve, 10));
				expect(receipts).toHaveLength(0);
			}
			for (const chunk of chunks.slice(1)) controller.enqueue(chunk);
			if (proveTiming) {
				await new Promise(resolve => setTimeout(resolve, 10));
				expect(receipts).toHaveLength(0);
			}
			controller.close();
			await result.catch(() => undefined);
			expect(receipts).toHaveLength(1);
			return receipts[0]!;
		};

		const separatelyChunked = await run([concatenate(prefix, invalid), malformedFrameEnd, terminal, trailer], true);
		const differentlyChunked = await run(
			[prefix.slice(0, 3), concatenate(prefix.slice(3), invalid, malformedFrameEnd, terminal), trailer],
			false,
		);
		for (const receipt of [separatelyChunked, differentlyChunked]) {
			expect(receipt).toMatchObject({
				classification: "ambiguous",
				ambiguityClass: "response_incomplete",
				responseBytesReceived: String(allBytes.byteLength),
				responseSha256: `sha256:${createHash("sha256").update(allBytes).digest("hex")}`,
			});
		}
		expect(differentlyChunked.responseSha256).toBe(separatelyChunked.responseSha256);
	});

	it("hashes every received raw byte when the provider stream fails after a terminal frame", async () => {
		const events: string[] = [];
		const { authority, receipts } = recordingAuthority(events);
		const terminalBytes = new TextEncoder().encode(await sseResponse().text());
		await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext()),
			apiKey: "provider-secret",
			providerCallAuthority: authority,
			fetch: fetchImpl(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(terminalBytes);
								setTimeout(() => controller.error(new Error("provider connection reset")), 10);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					),
			),
		}).result();
		expect(receipts[0]).toMatchObject({
			classification: "ambiguous",
			responseBytesReceived: String(terminalBytes.byteLength),
			responseSha256: `sha256:${createHash("sha256").update(terminalBytes).digest("hex")}`,
		});
	});

	it("treats synthesized zero usage as unknown instead of provider-reported usage", async () => {
		const events: string[] = [];
		const { authority, receipts } = recordingAuthority(events);
		const frames = [
			{
				id: "chatcmpl-no-usage",
				object: "chat.completion.chunk",
				created: 0,
				model: OPENAI_MODEL.id,
				choices: [{ index: 0, delta: { content: "hello" } }],
			},
			{
				id: "chatcmpl-no-usage",
				object: "chat.completion.chunk",
				created: 0,
				model: OPENAI_MODEL.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
		];
		const body = `${frames.map(frame => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
		await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext()),
			apiKey: "provider-secret",
			providerCallAuthority: authority,
			fetch: fetchImpl(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })),
		}).result();
		expect(receipts[0]).toMatchObject({ classification: "ambiguous", ambiguityClass: "usage_unknown" });
	});

	it("requires complete exact usage counters while preserving explicit provider zeros in every strict API family", async () => {
		const cases = [
			{
				name: "openai-completions",
				configId: "deepseek-v4-pro-0813-max-r3",
				model: OPENAI_MODEL,
				apiFamily: "openai-completions" as const,
				apiKey: "provider-secret",
				invalidUsage: [
					{},
					{ prompt_tokens: 3, total_tokens: 3 },
					{ prompt_tokens: 3, completion_tokens: -1, total_tokens: 2 },
					{ prompt_tokens: 3, completion_tokens: 1.5, total_tokens: 4.5 },
					{ prompt_tokens: "3", completion_tokens: 1, total_tokens: 4 },
				],
				explicitZeroUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
				response: (usage: unknown) => sseResponse(OPENAI_MODEL.id, usage),
			},
			{
				name: "openai-responses",
				configId: "grok-4.6-max-official-subscription",
				model: RESPONSES_MODEL,
				apiFamily: "openai-responses" as const,
				apiKey: "provider-secret",
				invalidUsage: [
					{},
					{ input_tokens: 3, total_tokens: 3 },
					{ input_tokens: 3, output_tokens: -1, total_tokens: 2 },
					{ input_tokens: 3, output_tokens: 1.5, total_tokens: 4.5 },
					{ input_tokens: "3", output_tokens: 1, total_tokens: 4 },
				],
				explicitZeroUsage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				response: responsesSse,
			},
			{
				name: "google-gemini-cli",
				configId: "gemini37-max-workflowz",
				model: GEMINI_MODEL,
				apiFamily: "google-gemini-cli" as const,
				apiKey: JSON.stringify({ token: "provider-secret", projectId: "project-1" }),
				invalidUsage: [
					{},
					{ promptTokenCount: 3, totalTokenCount: 3 },
					{ promptTokenCount: 3, candidatesTokenCount: -1, totalTokenCount: 2 },
					{ promptTokenCount: 3, candidatesTokenCount: 1.5, totalTokenCount: 4.5 },
					{ promptTokenCount: "3", candidatesTokenCount: 1, totalTokenCount: 4 },
				],
				explicitZeroUsage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
				response: geminiSse,
			},
		];
		for (const testCase of cases) {
			const strictContext = providerCallContext({
				configId: testCase.configId,
				apiFamily: testCase.apiFamily,
				provider: testCase.model.provider,
				modelId: testCase.model.id,
			});
			for (const invalidUsage of testCase.invalidUsage) {
				const events: string[] = [];
				const { authority, receipts } = recordingAuthority(events);
				await streamSimple(testCase.model, CONTEXT, {
					...strictRuntimeOptions(strictContext),
					apiKey: testCase.apiKey,
					providerCallAuthority: authority,
					fetch: fetchImpl(async () => testCase.response(invalidUsage)),
				}).result();
				expect(receipts[0], `${testCase.name} ${JSON.stringify(invalidUsage)}`).toMatchObject({
					classification: "ambiguous",
					ambiguityClass: "usage_unknown",
				});
			}
			const events: string[] = [];
			const { authority, receipts } = recordingAuthority(events);
			await streamSimple(testCase.model, CONTEXT, {
				...strictRuntimeOptions(strictContext),
				apiKey: testCase.apiKey,
				providerCallAuthority: authority,
				fetch: fetchImpl(async () => testCase.response(testCase.explicitZeroUsage)),
			}).result();
			expect(receipts[0], `${testCase.name} explicit zero`).toMatchObject({ classification: "terminal" });
			expect(receipts[0]?.actualDimensions?.filter(dimension => dimension.dimension.startsWith("tpm_"))).toEqual(
				strictContext.expectedDimensions
					.filter(dimension => dimension.dimension.startsWith("tpm_"))
					.map(dimension => ({ ...dimension, amount: "0" })),
			);
		}
	});

	it("rejects generic cumulative quota headers as provider_window evidence", async () => {
		const events: string[] = [];
		const { authority, receipts } = recordingAuthority(events);
		const expectedDimensions = providerCallContext().expectedDimensions;
		expectedDimensions.splice(1, 0, {
			dimension: "provider_window",
			windowId: "requests-minute",
			amount: "1",
			unitScale: "0",
			windowStart: "2026-08-23T00:00:00.000000Z",
			windowEnd: "2026-08-23T00:01:00.000000Z",
		});
		await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext({ expectedDimensions })),
			apiKey: "provider-secret",
			providerCallAuthority: authority,
			fetch: fetchImpl(async () => {
				const response = sseResponse();
				response.headers.set("x-ratelimit-limit-requests", "60");
				response.headers.set("x-ratelimit-remaining-requests", "59");
				return response;
			}),
		}).result();
		expect(receipts[0]).toMatchObject({ classification: "ambiguous", ambiguityClass: "usage_unknown" });
	});

	it("preserves exact quota, provider error code, and retry evidence", async () => {
		const events: string[] = [];
		const { authority, receipts } = recordingAuthority(events);
		const expectedDimensions: ProviderCallContext["expectedDimensions"] = [
			{ dimension: "concurrency", windowId: "-", amount: "1", unitScale: "0", windowStart: null, windowEnd: null },
			{
				dimension: "rpm_requests",
				windowId: "window-1",
				amount: "1",
				unitScale: "0",
				windowStart: "2026-08-23T00:00:00.000000Z",
				windowEnd: "2026-08-23T00:01:00.000000Z",
			},
		];
		await streamSimple(OPENAI_MODEL, CONTEXT, {
			...strictRuntimeOptions(providerCallContext({ expectedDimensions })),
			apiKey: "provider-secret",
			providerCallAuthority: authority,
			fetch: fetchImpl(async () =>
				Response.json(
					{ error: { code: "insufficient_quota", message: "quota exhausted" } },
					{
						status: 429,
						headers: {
							"retry-after": "60",
						},
					},
				),
			),
		}).result();
		expect(receipts[0]).toMatchObject({
			classification: "terminal",
			failureClass: "quota_exhausted",
			providerErrorCode: "insufficient_quota",
			retryAfterAt: expect.stringMatching(/Z$/),
		});
	});

	it("accepts the frozen ZERO acknowledgement for an exact terminal quota response", async () => {
		const expectedDimensions: ProviderCallContext["expectedDimensions"] = [
			{ dimension: "concurrency", windowId: "-", amount: "1", unitScale: "0", windowStart: null, windowEnd: null },
			{
				dimension: "rpm_requests",
				windowId: "window-1",
				amount: "1",
				unitScale: "0",
				windowStart: "2026-08-23T00:00:00.000000Z",
				windowEnd: "2026-08-23T00:01:00.000000Z",
			},
		];
		const context = providerCallContext({ expectedDimensions });
		const reservation: ProviderCallReservation = {
			reservationId: "00000000-0000-4000-8000-000000000006",
			disposition: "created",
			callSequence: context.callSequence,
			idempotencyKey: context.idempotencyKey,
			requestSha256: `sha256:${"2".repeat(64)}`,
			issuePermit: `pcr1_${"A".repeat(43)}`,
			issueAuthorizedAt: "2026-08-23T00:00:00.000000Z",
			originAssignment: context.originAssignment,
			assignmentSha256: context.assignmentSha256,
		};
		const authority = new HttpProviderCallAuthority({
			baseUrl: "https://authority.invalid",
			getGatewayToken: () => "gateway-token",
			getExecutionToken: () => "execution-token",
			fetch: fetchImpl(async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return Response.json(
					{
						schema: "terminal-bench/provider-call-receipt-result/v1",
						disposition: "created",
						reservation_id: reservation.reservationId,
						state: "terminal",
						receipt_operation_id: body.receipt_operation_id,
						receipt_sha256: providerCallReceiptPayloadSha256(body, true),
						recorded_at: "2026-08-23T00:00:02.000000Z",
						settlements: expectedDimensions.map(dimension => ({
							dimension: dimension.dimension,
							window_id: dimension.windowId,
							reserved_amount: dimension.amount,
							actual_amount: "1",
							settlement: dimension.dimension === "concurrency" ? "released" : "consumed_until_window_end",
						})),
						capability_state: "zero",
						zero_reason: "quota_exhausted",
					},
					{ status: 201 },
				);
			}),
		});
		const acknowledgement = await authority.recordReceipt(
			{
				context,
				reservation,
				receiptOperationId: "99999999-9999-4999-8999-999999999999",
				classification: "terminal",
				authorityOwner: "generic-omp-auth-gateway",
				backendEqualityResult: "MATCH",
				providerRequestCount: 1,
				retryCount: 0,
				failoverCount: 0,
				redirectFollowCount: 0,
				finalClassification: "TERMINAL_RESPONSE",
				drainState: "DRAINED",
				providerStartedAt: "2026-08-23T00:00:01.000000Z",
				providerFinishedAt: "2026-08-23T00:00:02.000000Z",
				httpStatus: "429",
				responseSha256: `sha256:${"3".repeat(64)}`,
				failureClass: "quota_exhausted",
				providerErrorCode: "insufficient_quota",
				actualDimensions: expectedDimensions.map(dimension => ({ ...dimension, amount: "1" })),
			},
			reservation.issuePermit,
		);
		expect(acknowledgement).toMatchObject({ capabilityState: "zero", zeroReason: "quota_exhausted" });
	});
});
