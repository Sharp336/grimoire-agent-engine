import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderCallGatewayStateError } from "@oh-my-pi/pi-ai/provider-call-gateway";
import {
	type ProviderCallOriginAssignment,
	resolveProviderCallOriginBinding,
} from "@oh-my-pi/pi-ai/provider-call-origin-manifest";
import { __providerInFlightForTesting, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	ProviderCallContext,
	ProviderCallGateway,
	ProviderCallGatewayRequest,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MESSAGE_CONTEXT: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};
const PROVIDER_ROUTE_ASSIGNMENT_ID = "10000000-0000-4000-8000-000000000001";

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

const GPT_MODEL = buildModel({
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

function providerCallContext(
	model: Model,
	configId: string,
	routeOrdinal = 0,
	overrides: Partial<ProviderCallContext> = {},
): ProviderCallContext {
	const credentialGeneration = "generation-1";
	return {
		mode: "strict",
		configId,
		taskReservationId: "00000000-0000-4000-8000-000000000001",
		providerRouteAssignmentId: PROVIDER_ROUTE_ASSIGNMENT_ID,
		executionBindingId: "00000000-0000-4000-8000-000000000002",
		podUid: "pod-uid",
		callSequence: "1",
		idempotencyKey: "00000000-0000-4000-8000-000000000003",
		apiFamily:
			model.api === "google-gemini-cli"
				? "google-gemini-cli"
				: model.api === "openai-responses"
					? "openai-responses"
					: "openai-completions",
		provider: model.provider,
		accountId: model.provider === "google-antigravity" ? "reviewed-google-project" : "account-1",
		modelId: model.id,
		credentialGeneration,
		capabilityId: "00000000-0000-4000-8000-000000000004",
		snapshotId: "00000000-0000-4000-8000-000000000005",
		assignmentSha256: `sha256:${"f".repeat(64)}`,
		tokenizerContractSha256: `sha256:${"1".repeat(64)}`,
		inputTokens: "3",
		maxOutputTokens: "65536",
		expectedDimensions: [
			{ dimension: "concurrency", windowId: "-", amount: "1", unitScale: "0", windowStart: null, windowEnd: null },
		],
		originAssignment: originAssignment(configId, credentialGeneration, routeOrdinal),
		...overrides,
	};
}

function openAiSse(modelId: string): Response {
	const frames = [
		{
			id: "chatcmpl-gateway",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: { content: "hello" } }],
		},
		{
			id: "chatcmpl-gateway",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
		},
		"[DONE]",
	];
	return new Response(
		`${frames.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}`).join("\n\n")}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req-gateway" } },
	);
}

function responsesSse(): Response {
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
			response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } },
		},
	];
	return new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function geminiSse(): Response {
	const frame = {
		response: {
			candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
		},
	};
	return new Response(`data: ${JSON.stringify(frame)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function fetchSpy(onCall: () => void): FetchImpl {
	return Object.assign(
		async () => {
			onCall();
			throw new Error("legacy direct fetch must not run");
		},
		{ preconnect: fetch.preconnect },
	);
}

class RecordingGateway implements ProviderCallGateway {
	readonly requests: ProviderCallGatewayRequest[] = [];
	readonly #respond: (request: ProviderCallGatewayRequest) => Response | Promise<Response>;

	constructor(respond: (request: ProviderCallGatewayRequest) => Response | Promise<Response>) {
		this.#respond = respond;
	}

	async dispatch(request: ProviderCallGatewayRequest): Promise<Response> {
		this.requests.push(request);
		return this.#respond(request);
	}
}

function strictOptions(context: ProviderCallContext, gateway: ProviderCallGateway): SimpleStreamOptions {
	return { providerCallContext: context, providerCallGateway: gateway };
}

function visibleText(message: Awaited<ReturnType<ReturnType<typeof streamSimple>["result"]>>): string {
	return message.content
		.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join("");
}

describe("strict provider-call gateway dispatch", () => {
	it("fails closed before API key or direct fetch when the gateway is absent", () => {
		let keyReads = 0;
		let directFetches = 0;
		const invoke = () =>
			streamSimple(OPENAI_MODEL, MESSAGE_CONTEXT, {
				providerCallContext: providerCallContext(OPENAI_MODEL, "deepseek-v4-pro-0813-max-r3"),
				apiKey: async () => {
					keyReads++;
					return "forbidden-secret";
				},
				fetch: fetchSpy(() => directFetches++),
			});
		expect(invoke).toThrow(/provider-call gateway/i);
		expect(keyReads).toBe(0);
		expect(directFetches).toBe(0);
	});

	it.each([
		{
			name: "OpenAI completions",
			model: OPENAI_MODEL,
			configId: "deepseek-v4-pro-0813-max-r3",
			response: () => openAiSse(OPENAI_MODEL.id),
		},
		{
			name: "OpenAI responses",
			model: RESPONSES_MODEL,
			configId: "grok-4.6-max-official-subscription",
			response: responsesSse,
		},
		{
			name: "Google Gemini CLI",
			model: GEMINI_MODEL,
			configId: "gemini37-max-workflowz",
			response: geminiSse,
		},
		{
			name: "Kimi Code",
			model: KIMI_MODEL,
			configId: "kimi-k3-high",
			response: () => openAiSse(KIMI_MODEL.id),
		},
	])("routes $name through one gateway dispatch with no credential or direct fetch", async testCase => {
		let keyReads = 0;
		let directFetches = 0;
		const gateway = new RecordingGateway(testCase.response);
		const context = providerCallContext(testCase.model, testCase.configId);
		const message = await streamSimple(testCase.model, MESSAGE_CONTEXT, {
			...strictOptions(context, gateway),
			apiKey: async () => {
				keyReads++;
				return "forbidden-secret";
			},
			fetch: fetchSpy(() => directFetches++),
		}).result();
		expect(message.stopReason).toBe("stop");
		expect(visibleText(message)).toContain("hello");
		expect(keyReads).toBe(0);
		expect(directFetches).toBe(0);
		expect(gateway.requests).toHaveLength(1);
		expect(gateway.requests[0]?.requestMaterializationKind).toBe("GENERIC_LIFECYCLE_FINAL");
		expect(gateway.requests[0]?.context).toBe(context);
		expect(gateway.requests[0]?.sourceBody.byteLength).toBeGreaterThan(0);
	});

	it("commits the exact post-onPayload serialization as final source request body bytes", async () => {
		let committedPayload: Record<string, unknown> | undefined;
		const gateway = new RecordingGateway(() => openAiSse(OPENAI_MODEL.id));
		await streamSimple(OPENAI_MODEL, MESSAGE_CONTEXT, {
			...strictOptions(providerCallContext(OPENAI_MODEL, "deepseek-v4-pro-0813-max-r3"), gateway),
			onPayload(payload) {
				committedPayload = { ...(payload as Record<string, unknown>), controllerMarker: "final" };
				return committedPayload;
			},
		}).result();
		expect(gateway.requests).toHaveLength(1);
		expect(new TextDecoder().decode(gateway.requests[0]!.sourceBody)).toBe(JSON.stringify(committedPayload));
	});

	it.each([
		{
			name: "retryable 429",
			status: 429,
			headers: { "content-type": "application/json", "retry-after": "60" },
		},
		{
			name: "redirect 302",
			status: 302,
			headers: { "content-type": "application/json", location: "https://evil.invalid/redirect" },
		},
	])("does not retry, follow, or redispatch a committed $name response", async testCase => {
		let directFetches = 0;
		const gateway = new RecordingGateway(
			() =>
				new Response(JSON.stringify({ error: { message: "committed provider response" } }), {
					status: testCase.status,
					headers: testCase.headers,
				}),
		);
		const message = await streamSimple(OPENAI_MODEL, MESSAGE_CONTEXT, {
			...strictOptions(providerCallContext(OPENAI_MODEL, "deepseek-v4-pro-0813-max-r3"), gateway),
			fetch: fetchSpy(() => directFetches++),
		}).result();
		expect(message.stopReason).toBe("error");
		expect(gateway.requests).toHaveLength(1);
		expect(directFetches).toBe(0);
	});

	it.each([
		new ProviderCallGatewayStateError("CONSUMED", "00000000-0000-4000-8000-000000000006"),
		new Error("Provider-call gateway response result hash mismatch"),
	])("surfaces a nonterminal or malformed gateway result without fallback", async gatewayError => {
		let directFetches = 0;
		const gateway = new RecordingGateway(async () => {
			throw gatewayError;
		});
		const message = await streamSimple(OPENAI_MODEL, MESSAGE_CONTEXT, {
			...strictOptions(providerCallContext(OPENAI_MODEL, "deepseek-v4-pro-0813-max-r3"), gateway),
			fetch: fetchSpy(() => directFetches++),
		}).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain(gatewayError.message);
		expect(gateway.requests).toHaveLength(1);
		expect(directFetches).toBe(0);
	});

	it("bypasses local in-flight leases so concurrent strict streams each reach the gateway", async () => {
		const root = await mkdtemp(join(tmpdir(), "strict-gateway-inflight-"));
		__providerInFlightForTesting.setRoot(root);
		let active = 0;
		let maxActive = 0;
		const gateway = new RecordingGateway(async request => {
			active++;
			maxActive = Math.max(maxActive, active);
			await Bun.sleep(20);
			active--;
			return openAiSse(request.context.modelId);
		});
		try {
			const messages = await Promise.all(
				Array.from({ length: 8 }, (_, index) => {
					const context = providerCallContext(OPENAI_MODEL, "deepseek-v4-pro-0813-max-r3", 0, {
						callSequence: String(index + 1),
						idempotencyKey: `00000000-0000-4000-8${String(index).padStart(3, "0")}-000000000003`,
					});
					return streamSimple(OPENAI_MODEL, MESSAGE_CONTEXT, {
						...strictOptions(context, gateway),
						maxInFlightRequests: { [OPENAI_MODEL.provider]: 1 },
					}).result();
				}),
			);
			expect(messages.every(message => message.stopReason === "stop")).toBe(true);
			expect(gateway.requests).toHaveLength(8);
			expect(new Set(gateway.requests.map(request => request.context.callSequence)).size).toBe(8);
			expect(maxActive).toBeGreaterThan(1);
			expect(await readdir(root)).toEqual([]);
		} finally {
			__providerInFlightForTesting.setRoot(undefined);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects dedicated GPT routes before generic gateway dispatch", () => {
		const gateway = new RecordingGateway(() => openAiSse(GPT_MODEL.id));
		const invoke = () =>
			streamSimple(GPT_MODEL, MESSAGE_CONTEXT, strictOptions(providerCallContext(GPT_MODEL, "sol-low"), gateway));
		expect(invoke).toThrow(/dedicated Codex/i);
		expect(gateway.requests).toHaveLength(0);
	});
});
