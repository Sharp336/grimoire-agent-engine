import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import {
	PROVIDER_CALL_ORIGIN_MANIFEST,
	type ProviderCallOriginAssignment,
	resolveProviderCallOriginBinding,
} from "@oh-my-pi/pi-ai/provider-call-origin-manifest";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { encodeStream, formatError, parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ModelSpec,
	ProviderCallContext,
	ProviderCallGatewayRequest,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function makeEventStream(events: AssistantMessageEvent[], final: AssistantMessage): AssistantMessageEventStream {
	async function* iter() {
		for (const e of events) yield e;
	}
	const stream = iter() as unknown as AssistantMessageEventStream;
	(stream as { result(): Promise<AssistantMessage> }).result = async () => final;
	return stream;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	return buf.split("\n\n").filter(s => s.length > 0);
}

function parseSseLine(line: string): unknown {
	const stripped = line.replace(/^data: /, "");
	if (stripped === "[DONE]") return "[DONE]";
	return JSON.parse(stripped);
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function baseAssistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

const baseContext: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

function strictOriginAssignment(
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

function expectedDynamics(
	configIds: readonly string[],
	credentialGeneration = "generation",
): Record<
	string,
	Pick<
		ProviderCallOriginAssignment,
		"capability_generation" | "credential_generation" | "source_release_digest" | "restricted_proxy_policy_sha256"
	>
> {
	return Object.fromEntries(
		configIds.map(configId => [
			configId,
			{
				capability_generation: "capability-generation-20260823",
				credential_generation: credentialGeneration,
				source_release_digest: `sha256:${"a".repeat(64)}`,
				restricted_proxy_policy_sha256: `sha256:${"b".repeat(64)}`,
			},
		]),
	);
}

function strictProviderCallContext(gpt = false, requestedConfigId?: string): ProviderCallContext {
	const configId = requestedConfigId ?? (gpt ? "sol-low" : "deepseek-v4-pro-0813-max-r3");
	const credentialGeneration = "generation";
	const providerRouteAssignmentId = "00000000-0000-4000-8000-000000000003";
	return {
		mode: "strict",
		configId,
		taskReservationId: "00000000-0000-4000-8000-000000000001",
		providerRouteAssignmentId,
		executionBindingId: "00000000-0000-4000-8000-000000000002",
		podUid: "pod-uid",
		callSequence: "1",
		idempotencyKey: "00000000-0000-4000-8000-000000000003",
		apiFamily: "openai-completions",
		provider: gpt ? "gpt-proxy" : "deepseek",
		accountId: "account",
		modelId: gpt ? "gpt-5.6-sol" : "deepseek-v4-pro",
		credentialGeneration,
		assignmentSha256: `sha256:${"f".repeat(64)}`,
		capabilityId: "00000000-0000-4000-8000-000000000004",
		snapshotId: "00000000-0000-4000-8000-000000000005",
		tokenizerContractSha256: `sha256:${"1".repeat(64)}`,
		inputTokens: "1",
		maxOutputTokens: "1",
		expectedDimensions: [
			{
				dimension: "concurrency",
				windowId: "-",
				amount: "1",
				unitScale: "0",
				windowStart: null,
				windowEnd: null,
			},
		],
		originAssignment: strictOriginAssignment(configId, credentialGeneration),
		...(gpt
			? {
					codexAuthority: {
						providerRouteAssignmentId,
						capabilitySetId: "00000000-0000-4000-8000-000000000006",
						translationContractSha256: `sha256:${"2".repeat(64)}`,
						solverEpoch: "1",
						assignedAt: "2026-08-23T00:00:00.000000Z",
						logicalContentType: "application/json" as const,
						logicalHeaders: { accept: "text/event-stream", "content-type": "application/json" },
						logicalBodyBase64: Buffer.from(JSON.stringify({ model: configId, stream: true })).toString("base64"),
					},
				}
			: {}),
	};
}

const DEEPSEEK_STRICT_MODEL = buildModel({
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

const XAI_STRICT_MODEL = buildModel({
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

const GPT_STRICT_MODEL = buildModel({
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	api: "openai-completions",
	provider: "gpt-proxy",
	baseUrl: "https://forbidden-local-gpt.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 372_000,
	maxTokens: 65_536,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"openai-completions">);

describe("pi-native parseRequest", () => {
	it("accepts modelId + context and returns canonical shape", () => {
		const parsed = parseRequest({
			modelId: "claude-sonnet-4-5",
			context: baseContext,
			options: { temperature: 0.5, reasoning: Effort.High },
			stream: false,
		});
		expect(parsed.modelId).toBe("claude-sonnet-4-5");
		expect(parsed.context).toEqual(baseContext);
		expect(parsed.options.temperature).toBe(0.5);
		expect(parsed.options.reasoning).toBe(Effort.High);
		expect(parsed.stream).toBe(false);
	});

	it("falls back to model.id when modelId is absent (streamProxy compat)", () => {
		const parsed = parseRequest({
			model: { id: "claude-opus-4-1", provider: "anthropic", api: "anthropic-messages" },
			context: baseContext,
		});
		expect(parsed.modelId).toBe("claude-opus-4-1");
	});

	it("accepts top-level string `model` as the id (extra compat)", () => {
		const parsed = parseRequest({
			model: "gpt-5",
			context: baseContext,
		});
		expect(parsed.modelId).toBe("gpt-5");
	});

	it("defaults stream to true when omitted", () => {
		const parsed = parseRequest({ modelId: "x", context: baseContext });
		expect(parsed.stream).toBe(true);
	});

	it("drops server-controlled and unknown option keys", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				temperature: 0.2,
				cachedContent: "cachedContents/caller-owned-corpus",
				apiKey: "should-be-stripped",
				signal: {},
				fetch: () => {},
				onPayload: () => {},
				onResponse: () => {},
				onSseEvent: () => {},
				execHandlers: {},
				providerSessionState: new Map(),
				providerCallUrlPlan: {
					apiFamily: "openai-completions",
					requestPathAndQuery: "/v1/chat/completions",
					url: "https://provider.invalid/v1/chat/completions",
				},
				notARealField: "ignored",
			},
		});
		expect(parsed.options).toEqual({ temperature: 0.2, cachedContent: "cachedContents/caller-owned-corpus" });
		expect("apiKey" in parsed.options).toBe(false);
		expect("signal" in parsed.options).toBe(false);
		expect("fetch" in parsed.options).toBe(false);
		expect("onPayload" in parsed.options).toBe(false);
		expect("onResponse" in parsed.options).toBe(false);
		expect("onSseEvent" in parsed.options).toBe(false);
		expect("providerCallUrlPlan" in parsed.options).toBe(false);
		expect("notARealField" in parsed.options).toBe(false);
	});

	it("preserves loopGuard so the remote cook pass can disable the server-side guard", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: { loopGuard: { enabled: false } },
		});
		expect(parsed.options.loopGuard).toEqual({ enabled: false });
	});

	it("forwards acceptEmptyResponse so a passive Google advisor can accept silence server-side", () => {
		const parsed = parseRequest({
			modelId: "google/gemini-3.6-flash",
			context: baseContext,
			options: { acceptEmptyResponse: true },
		});
		expect(parsed.options.acceptEmptyResponse).toBe(true);
	});

	it("forwards strict context but never accepts serialized gateway or URL-plan authority", () => {
		const providerCallContext = strictProviderCallContext();
		const parsed = parseRequest({
			modelId: "openai/gpt-5",
			context: baseContext,
			options: {
				providerCallContext,
				providerCallGateway: { socketPath: "forbidden" },
				providerCallUrlPlan: {
					apiFamily: "openai-completions",
					requestPathAndQuery: "/v1/chat/completions",
					url: "https://provider.invalid/v1/chat/completions",
				},
			},
		});
		expect(parsed.options.providerCallContext).toEqual(providerCallContext);
		expect(parsed.options.providerCallGateway).toBeUndefined();
		expect(parsed.options.providerCallUrlPlan).toBeUndefined();
	});

	it("forwards an explicit statefulResponses disablement to the native stream", () => {
		const parsed = parseRequest({
			modelId: "openai/gpt-5",
			context: baseContext,
			options: { promptCacheKey: "bench-cache-pair", statefulResponses: false },
		});
		expect(parsed.options.promptCacheKey).toBe("bench-cache-pair");
		expect(parsed.options.statefulResponses).toBe(false);
	});

	it("preserves headers, metadata, sessionId, thinkingBudgets", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				headers: { "x-foo": "bar" },
				metadata: { user_id: "u" },
				sessionId: "explicit-session",
				thinkingBudgets: { high: 8192 },
				stopSequences: ["\n\n"],
				toolChoice: "required",
				serviceTier: "priority",
				cacheRetention: "long",
			},
		});
		expect(parsed.options.headers).toEqual({ "x-foo": "bar" });
		expect(parsed.options.metadata).toEqual({ user_id: "u" });
		expect(parsed.options.sessionId).toBe("explicit-session");
		expect(parsed.options.thinkingBudgets).toEqual({ high: 8192 });
		expect(parsed.options.stopSequences).toEqual(["\n\n"]);
		expect(parsed.options.toolChoice).toBe("required");
		expect(parsed.options.serviceTier).toBe("priority");
		expect(parsed.options.cacheRetention).toBe("long");
	});

	it("forwards the explicit prompt-cache policy through the canonical options bag", () => {
		const parsed = parseRequest({
			modelId: "gpt-5.6",
			context: baseContext,
			options: { promptCache: { mode: "explicit", ttl: "30m", breakpoint: "none" } },
		});

		expect(parsed.options.promptCache).toEqual({ mode: "explicit", ttl: "30m", breakpoint: "none" });
	});

	it("rejects missing required fields", () => {
		expect(() => parseRequest({ context: baseContext })).toThrow(/modelId/);
		expect(() => parseRequest({ modelId: "x" })).toThrow(/context/);
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: [] } })).toThrow(/messages/);
	});

	it("rejects non-object body", () => {
		expect(() => parseRequest(null)).toThrow();
		expect(() => parseRequest("hello")).toThrow();
		expect(() => parseRequest([])).toThrow();
	});

	it("validates systemPrompt and tools shape", () => {
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: "not array", messages: [] } })).toThrow(
			/systemPrompt/,
		);
		expect(() => parseRequest({ modelId: "x", context: { messages: [], tools: "not array" } })).toThrow(/tools/);
	});

	it("skips null and undefined option values", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: { temperature: null, topP: undefined, maxTokens: 100 },
		});
		expect("temperature" in parsed.options).toBe(false);
		expect("topP" in parsed.options).toBe(false);
		expect(parsed.options.maxTokens).toBe(100);
	});
});

describe("pi-native gateway cache controls", () => {
	it("delivers statefulResponses false to the provider stream", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-cache-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "pi-native-cache" });
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => mock,
			version: "test",
		});

		try {
			mock.push({ content: ["ok"] });
			const response = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: "pi-native-cache",
					context: baseContext,
					options: { promptCacheKey: "bench-cache-pair", statefulResponses: false },
					stream: false,
				}),
			});

			expect(response.status).toBe(200);
			await response.json();
			expect(mock.calls).toHaveLength(1);
			expect(mock.calls[0]?.options).toMatchObject({
				promptCacheKey: "bench-cache-pair",
				statefulResponses: false,
			});
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
			clearCustomApis();
		}
	});

	it("rejects strict dispatch when the provider-call gateway is absent", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-strict-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const model = DEEPSEEK_STRICT_MODEL;
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => model,
			version: "test",
			expectedProviderCallDynamics: expectedDynamics(["deepseek-v4-pro-0813-max-r3"]),
		});
		try {
			const response = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: model.id,
					context: baseContext,
					options: { providerCallContext: strictProviderCallContext() },
					stream: false,
				}),
			});
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				error: {
					type: "provider_call_gateway_unavailable",
					message: "Strict provider-call gateway runtime unavailable",
				},
			});
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not treat the catalog baseUrl as route authority for a strict assigned call", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-origin-assignment-authority-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const competingCatalogModel = { ...DEEPSEEK_STRICT_MODEL, baseUrl: "https://evil.invalid" };
		let gatewayCalls = 0;
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => competingCatalogModel,
			version: "test",
			expectedProviderCallDynamics: expectedDynamics(["deepseek-v4-pro-0813-max-r3"]),
			providerCallGateway: {
				async dispatch() {
					gatewayCalls++;
					throw new Error("gateway reached after assignment authority accepted");
				},
			},
		});
		try {
			const response = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: competingCatalogModel.id,
					context: baseContext,
					options: { providerCallContext: strictProviderCallContext() },
					stream: false,
				}),
			});
			expect(response.status).toBe(502);
			expect(gatewayCalls).toBe(1);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects catalog path/query mismatches for both production OpenAI transports before every effect", async () => {
		const originalFetch = globalThis.fetch;
		let providerEgress = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "api.deepseek.com" || url.hostname === "api.x.ai") {
				providerEgress++;
				throw new Error("must not reach provider egress");
			}
			return originalFetch(input, init);
		}) as typeof fetch;
		try {
			for (const scenario of [
				{
					configId: "deepseek-v4-pro-0813-max-r3",
					model: { ...DEEPSEEK_STRICT_MODEL, baseUrl: "https://catalog.invalid/wrong" },
				},
				{
					configId: "grok-4.6-max-official-subscription",
					model: { ...XAI_STRICT_MODEL, baseUrl: "https://catalog.invalid/wrong" },
				},
			] as const) {
				const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-url-plan-order-"));
				const storage = await AuthStorage.create(path.join(dir, "auth.db"));
				let gatewayCalls = 0;
				const ctx = strictProviderCallContext();
				ctx.configId = scenario.configId;
				ctx.apiFamily = scenario.model.api;
				ctx.provider = scenario.model.provider;
				ctx.modelId = scenario.model.id;
				ctx.originAssignment = strictOriginAssignment(scenario.configId, ctx.credentialGeneration);
				const handle = startAuthGateway({
					bind: "127.0.0.1:0",
					bearerTokens: ["test-token"],
					storage,
					resolveModel: () => scenario.model,
					version: "test",
					expectedProviderCallDynamics: expectedDynamics([scenario.configId]),
					providerCallGateway: {
						async dispatch() {
							gatewayCalls++;
							throw new Error("must not dispatch");
						},
					},
				});
				try {
					const response = await originalFetch(`${handle.url}/v1/pi/stream`, {
						method: "POST",
						headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
						body: JSON.stringify({
							modelId: scenario.model.id,
							context: baseContext,
							options: { providerCallContext: ctx },
							stream: false,
						}),
					});
					expect(response.status).toBe(409);
					expect(await response.text()).toContain("path/query mismatch");
					expect(gatewayCalls).toBe(0);
					expect(providerEgress).toBe(0);
				} finally {
					await handle.close();
					storage.close();
					await fs.rm(dir, { recursive: true, force: true });
				}
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("rejects each well-formed dynamic substitution before the shared gateway", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-dynamic-equality-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		let gatewayCalls = 0;
		const dynamicFields = [
			"capability_generation",
			"credential_generation",
			"source_release_digest",
			"restricted_proxy_policy_sha256",
		] as const;
		const exercise = async (gpt: boolean, field: (typeof dynamicFields)[number]): Promise<Response> => {
			const configId = gpt ? "sol-low" : "deepseek-v4-pro-0813-max-r3";
			const model = gpt ? GPT_STRICT_MODEL : DEEPSEEK_STRICT_MODEL;
			const ctx = strictProviderCallContext(gpt, configId);
			ctx.originAssignment = {
				...ctx.originAssignment,
				[field]:
					field.endsWith("sha256") || field.endsWith("digest") ? `sha256:${"c".repeat(64)}` : "wrong-generation",
			};
			const handle = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: ["test-token"],
				storage,
				resolveModel: () => model,
				expectedProviderCallDynamics: expectedDynamics([configId]),
				providerCallGateway: {
					async dispatch() {
						gatewayCalls++;
						throw new Error("must not dispatch");
					},
				},
			});
			try {
				return await fetch(`${handle.url}/v1/pi/stream`, {
					method: "POST",
					headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
					body: JSON.stringify({
						modelId: model.id,
						context: baseContext,
						options: { providerCallContext: ctx },
						stream: true,
					}),
				});
			} finally {
				await handle.close();
			}
		};
		try {
			for (const gpt of [false, true]) {
				for (const field of dynamicFields) expect((await exercise(gpt, field)).status, `${gpt}/${field}`).toBe(409);
			}
			expect(gatewayCalls).toBe(0);
		} finally {
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a governed generic route without a controller assignment before any gateway or credential effect", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-generic-assignment-required-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		let gatewayCalls = 0;
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => DEEPSEEK_STRICT_MODEL,
			version: "test",
			providerCallGateway: {
				async dispatch() {
					gatewayCalls++;
					throw new Error("must not dispatch without an assignment");
				},
			},
		});
		try {
			const response = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: DEEPSEEK_STRICT_MODEL.id,
					context: baseContext,
					options: {},
					stream: true,
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.text()).toContain("controller-materialized strict assignment");
			expect(gatewayCalls).toBe(0);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not govern a catalog collision with the same provider and model id but a different API family", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-api-family-collision-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey(DEEPSEEK_STRICT_MODEL.provider, "test-key");
		const mock = createMockModel({
			provider: DEEPSEEK_STRICT_MODEL.provider,
			id: DEEPSEEK_STRICT_MODEL.id,
			responses: [{ content: ["collision remains ungoverned"] }],
		});
		let gatewayCalls = 0;
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => mock,
			version: "test",
			providerCallGateway: {
				async dispatch() {
					gatewayCalls++;
					throw new Error("must not dispatch an API-family collision");
				},
			},
		});
		try {
			const response = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: `${DEEPSEEK_STRICT_MODEL.provider}/${DEEPSEEK_STRICT_MODEL.id}`,
					context: baseContext,
					options: {},
					stream: false,
				}),
			});
			expect(response.status).toBe(200);
			expect(JSON.stringify(await response.json())).toContain("collision remains ungoverned");
			expect(mock.calls).toHaveLength(1);
			expect(gatewayCalls).toBe(0);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
			clearCustomApis();
		}
	});

	it("rejects GPT format routes before gateway dispatch when no controller assignment exists", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-gpt-assignment-required-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		let gatewayCalls = 0;
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => GPT_STRICT_MODEL,
			version: "test",
			providerCallGateway: {
				async dispatch() {
					gatewayCalls++;
					throw new Error("must not dispatch without an assignment");
				},
			},
		});
		try {
			const response = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					model: GPT_STRICT_MODEL.id,
					messages: [{ role: "user", content: "hello" }],
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.text()).toContain("controller-materialized strict assignment");
			expect(gatewayCalls).toBe(0);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("dispatches the production provider/id key for all 20 pinned GPT bindings exactly once", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-codex-delegate-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const gptBindings = PROVIDER_CALL_ORIGIN_MANIFEST.routes.filter(route => route.provider === "gpt-proxy");
		const runtimeModelKey = `${GPT_STRICT_MODEL.provider}/${GPT_STRICT_MODEL.id}`;
		const gatewayRequests: ProviderCallGatewayRequest[] = [];
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: modelKey => (modelKey === runtimeModelKey ? GPT_STRICT_MODEL : undefined),
			version: "test",
			expectedProviderCallDynamics: expectedDynamics(gptBindings.map(binding => binding.configId)),
			providerCallGateway: {
				async dispatch(request) {
					gatewayRequests.push(request);
					expect(request.requestMaterializationKind).toBe("DEDICATED_CODEX_AUTHORITY_TRANSLATED");
					expect(JSON.parse(new TextDecoder().decode(request.sourceBody))).toEqual({
						model: request.context.configId,
						stream: true,
					});
					return new Response('data: {"choices":[]}\\n\\ndata: [DONE]\\n\\n', {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				},
			},
		});
		try {
			for (const binding of gptBindings) {
				const requestBody = JSON.stringify({
					modelId: runtimeModelKey,
					context: baseContext,
					options: { providerCallContext: strictProviderCallContext(true, binding.configId) },
					stream: true,
				});
				const response = await fetch(`${handle.url}/v1/pi/stream`, {
					method: "POST",
					headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
					body: requestBody,
				});
				expect(response.status, binding.configId).toBe(200);
				expect(await response.text()).toContain("data: [DONE]");
			}
			expect(gptBindings).toHaveLength(20);
			expect(gatewayRequests).toHaveLength(20);
			expect(gatewayRequests.map(request => request.context.originAssignment.config_id)).toEqual(
				gptBindings.map(binding => binding.configId),
			);

			const mismatched = strictProviderCallContext(true);
			mismatched.originAssignment = { ...mismatched.originAssignment, dns_host: "evil.invalid" };
			const rejected = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: runtimeModelKey,
					context: baseContext,
					options: { providerCallContext: mismatched },
					stream: true,
				}),
			});
			expect(rejected.status).toBe(409);
			expect(gatewayRequests).toHaveLength(20);

			const duplicateSource = JSON.stringify({
				modelId: runtimeModelKey,
				context: baseContext,
				options: { providerCallContext: strictProviderCallContext(true) },
				stream: true,
			});
			const duplicated = duplicateSource.replace(
				'"originAssignment":{',
				'"originAssignment":{"config_id":"duplicate",',
			);
			const duplicateRejected = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: duplicated,
			});
			expect(duplicateRejected.status).toBe(400);
			expect(gatewayRequests).toHaveLength(20);

			const noncanonicalInteger = duplicateSource.replace(/"config_ordinal":([0-9]+)/, '"config_ordinal":$1e0');
			const noncanonicalRejected = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: noncanonicalInteger,
			});
			expect(noncanonicalRejected.status).toBe(400);
			expect(gatewayRequests).toHaveLength(20);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
describe("pi-native encodeStream", () => {
	it("ships every AssistantMessageEvent verbatim, terminated by [DONE]", async () => {
		// Pi-native is omp-talks-to-omp: the client feeds parsed events directly
		// into `AssistantMessageEventStream.push()`, so the wire IS the canonical
		// event type. No partial-stripping, no per-event re-shaping.
		const finalMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
			usage: { ...ZERO_USAGE, input: 4, output: 2, totalTokens: 6 },
		});
		const partialAfterDelta: AssistantMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
		});
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "text_start", contentIndex: 0, partial: baseAssistant({ content: [{ type: "text", text: "" }] }) },
			{ type: "text_delta", contentIndex: 0, delta: "hi", partial: partialAfterDelta },
			{ type: "text_end", contentIndex: 0, content: "hi", partial: partialAfterDelta },
			{ type: "done", reason: "stop", message: finalMessage },
		];
		const chunks = await collectSse(encodeStream(makeEventStream(events, finalMessage)));
		const parsed = chunks.map(parseSseLine);

		// Every payload is the input event verbatim — partials, signatures,
		// usage all intact. Terminator follows `done`/`error`.
		expect(parsed.length).toBe(events.length + 1);
		for (let i = 0; i < events.length; i++) {
			expect(parsed[i]).toEqual(JSON.parse(JSON.stringify(events[i])));
		}
		expect(parsed[parsed.length - 1]).toBe("[DONE]");
	});

	it("preserves the rolling `partial` on every delta (sanity: no shrink)", async () => {
		// Guards against an accidental re-introduction of partial-stripping
		// optimization. Clients depend on `partial` being present.
		const final = baseAssistant({ content: [{ type: "text", text: "abc" }] });
		const events: AssistantMessageEvent[] = [
			{ type: "text_delta", contentIndex: 0, delta: "abc", partial: final },
			{ type: "done", reason: "stop", message: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine) as Array<
			Record<string, unknown>
		>;
		expect(parsed[0]).toHaveProperty("partial");
		expect((parsed[0] as { partial: AssistantMessage }).partial.content).toEqual([{ type: "text", text: "abc" }]);
	});

	it("stops streaming after a terminal `done` and emits [DONE] once", async () => {
		const final = baseAssistant();
		const events: AssistantMessageEvent[] = [
			{ type: "done", reason: "stop", message: final },
			// This trailing event must NOT reach the wire — terminal events end
			// the stream so the client iterator resolves cleanly.
			{ type: "text_delta", contentIndex: 0, delta: "ghost", partial: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine);
		expect(parsed.length).toBe(2);
		expect((parsed[0] as { type: string }).type).toBe("done");
		expect(parsed[1]).toBe("[DONE]");
	});

	it("forwards `error` events verbatim, then closes with [DONE]", async () => {
		const errored = baseAssistant({
			stopReason: "error",
			errorMessage: "upstream blew up",
			usage: { ...ZERO_USAGE, input: 3 },
		});
		const events: AssistantMessageEvent[] = [{ type: "error", reason: "error", error: errored }];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, errored)))).map(parseSseLine);
		expect(parsed[0]).toEqual({ type: "error", reason: "error", error: JSON.parse(JSON.stringify(errored)) });
		expect(parsed[1]).toBe("[DONE]");
	});

	it("emits a synthetic error envelope when the source iterator throws", async () => {
		// Source-stream failures (network drop after `streamSimple` returned)
		// must not hang the client. We surface a minimal `error` event followed
		// by `[DONE]` so the iterator on the other end resolves.
		const broken = (async function* () {
			yield { type: "start", partial: baseAssistant() } satisfies AssistantMessageEvent;
			throw new Error("connection reset");
		})() as unknown as AssistantMessageEventStream;
		(broken as { result(): Promise<AssistantMessage> }).result = async () => baseAssistant();

		const parsed = (await collectSse(encodeStream(broken))).map(parseSseLine);
		expect((parsed[0] as { type: string }).type).toBe("start");
		expect(parsed[1]).toEqual({ type: "error", reason: "error", errorMessage: "connection reset" });
		expect(parsed[2]).toBe("[DONE]");
	});

	it("continues draining the source after a strict client cancellation", async () => {
		const gate = Promise.withResolvers<void>();
		const sourceDrained = Promise.withResolvers<void>();
		let drained = false;
		const final = baseAssistant({ content: [{ type: "text", text: "drained" }] });
		const source = (async function* () {
			yield { type: "start", partial: baseAssistant() } satisfies AssistantMessageEvent;
			await gate.promise;
			drained = true;
			sourceDrained.resolve();
			yield { type: "done", reason: "stop", message: final } satisfies AssistantMessageEvent;
		})() as unknown as AssistantMessageEventStream;
		(source as { result(): Promise<AssistantMessage> }).result = async () => final;
		const reader = encodeStream(source, undefined, undefined, { drainOnCancel: true }).getReader();
		await reader.read();
		const cancelled = reader.cancel("worker disconnected");
		gate.resolve();
		await cancelled;
		await sourceDrained.promise;
		expect(drained).toBe(true);
	});
});

describe("pi-native formatError", () => {
	it("emits { error: { type, message } } with the given status", async () => {
		const res = formatError(401, "authentication_error", "no credential");
		expect(res.status).toBe(401);
		expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
		expect(await res.json()).toEqual({ error: { type: "authentication_error", message: "no credential" } });
	});
});
