import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, ModelSpec, VercelGatewayRouting } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withEnv } from "./helpers";

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

type Payload = Record<string, unknown>;

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function vercelChatModel(routing?: VercelGatewayRouting): Model<"openai-completions"> {
	return buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-completions",
		provider: "vercel-ai-gateway",
		baseUrl: "https://ai-gateway.vercel.sh/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...(routing ? { compat: { vercelGatewayRouting: routing } } : {}),
	} satisfies ModelSpec<"openai-completions">);
}

function responsesModel(provider: string, baseUrl: string, routing?: VercelGatewayRouting): Model<"openai-responses"> {
	return buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-responses",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...(routing ? { compat: { vercelGatewayRouting: routing } } : {}),
	} satisfies ModelSpec<"openai-responses">);
}

function captureChatPayload(
	model: Model<"openai-completions">,
	options: { cacheRetention?: "long" | "short" | "none" } = {},
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		signal: abortedSignal(),
		...options,
		onPayload: payload => resolve(payload as Payload),
	});
	return promise;
}

function captureResponsesPayload(
	model: Model<"openai-responses">,
	options: { cacheRetention?: "long" | "short" | "none" } = {},
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamOpenAIResponses(model, context, {
		apiKey: "test-key",
		signal: abortedSignal(),
		...options,
		onPayload: payload => resolve(payload as Payload),
	});
	return promise;
}

describe("Vercel AI Gateway automatic cache controls", () => {
	it("maps cache fields and routing to their documented Chat and Responses request shapes", async () => {
		const routing: VercelGatewayRouting = {
			only: ["anthropic"],
			order: ["anthropic", "bedrock"],
			caching: "auto",
			cacheAnchorItems: 1,
			cacheTtl: "1h",
		};
		const [chat, responses] = await Promise.all([
			captureChatPayload(vercelChatModel(routing)),
			captureResponsesPayload(responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", routing), {
				cacheRetention: "long",
			}),
		]);

		expect(chat.providerOptions).toEqual({
			gateway: { only: ["anthropic"], order: ["anthropic", "bedrock"], caching: "auto" },
		});
		expect(chat.caching).toBeUndefined();
		expect(chat.cache_anchor_items).toBeUndefined();
		expect(chat.cache_ttl).toBeUndefined();

		expect(responses.providerOptions).toEqual({
			gateway: { only: ["anthropic"], order: ["anthropic", "bedrock"] },
		});
		expect(responses.caching).toBe("auto");
		expect(responses.cache_anchor_items).toBe(1);
		expect(responses.cache_ttl).toBe("1h");
	});

	it("uses the Vercel default TTL for default, explicit, and environment short retention", async () => {
		const routing: VercelGatewayRouting = {
			only: ["anthropic"],
			order: ["anthropic", "bedrock"],
			caching: "auto",
			cacheAnchorItems: 1,
			cacheTtl: "1h",
		};
		const defaultRetention = await captureResponsesPayload(
			responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", routing),
		);
		const explicitShortRetention = await captureResponsesPayload(
			responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", routing),
			{ cacheRetention: "short" },
		);
		let environmentShortRetention!: Payload;
		await withEnv({ PI_CACHE_RETENTION: "short" }, async () => {
			environmentShortRetention = await captureResponsesPayload(
				responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", routing),
			);
		});

		for (const payload of [defaultRetention, explicitShortRetention, environmentShortRetention]) {
			expect(payload.providerOptions).toEqual({
				gateway: { only: ["anthropic"], order: ["anthropic", "bedrock"] },
			});
			expect(payload.caching).toBe("auto");
			expect(payload.cache_anchor_items).toBe(1);
			expect(payload.cache_ttl).toBeUndefined();
		}
	});

	it("omits Chat and Responses automatic cache controls when cache retention is none", async () => {
		const routing: VercelGatewayRouting = {
			only: ["anthropic"],
			order: ["anthropic", "bedrock"],
			caching: "auto",
			cacheAnchorItems: 1,
			cacheTtl: "1h",
		};
		const [chat, responses] = await Promise.all([
			captureChatPayload(vercelChatModel(routing), { cacheRetention: "none" }),
			captureResponsesPayload(responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", routing), {
				cacheRetention: "none",
			}),
		]);

		expect(chat.providerOptions).toEqual({ gateway: { only: ["anthropic"], order: ["anthropic", "bedrock"] } });
		expect(chat.caching).toBeUndefined();
		expect(chat.cache_anchor_items).toBeUndefined();
		expect(chat.cache_ttl).toBeUndefined();

		expect(responses.providerOptions).toEqual({
			gateway: { only: ["anthropic"], order: ["anthropic", "bedrock"] },
		});
		expect(responses.caching).toBeUndefined();
		expect(responses.cache_anchor_items).toBeUndefined();
		expect(responses.cache_ttl).toBeUndefined();
	});

	it("omits Chat and Responses automatic cache controls when PI_CACHE_RETENTION is none", async () => {
		const routing: VercelGatewayRouting = {
			only: ["anthropic"],
			order: ["anthropic", "bedrock"],
			caching: "auto",
			cacheAnchorItems: 1,
			cacheTtl: "1h",
		};
		await withEnv({ PI_CACHE_RETENTION: "none" }, async () => {
			const [chat, responses] = await Promise.all([
				captureChatPayload(vercelChatModel(routing)),
				captureResponsesPayload(responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", routing)),
			]);

			expect(chat.providerOptions).toEqual({ gateway: { only: ["anthropic"], order: ["anthropic", "bedrock"] } });
			expect(chat.caching).toBeUndefined();
			expect(chat.cache_anchor_items).toBeUndefined();
			expect(chat.cache_ttl).toBeUndefined();

			expect(responses.providerOptions).toEqual({
				gateway: { only: ["anthropic"], order: ["anthropic", "bedrock"] },
			});
			expect(responses.caching).toBeUndefined();
			expect(responses.cache_anchor_items).toBeUndefined();
			expect(responses.cache_ttl).toBeUndefined();
		});
	});

	it("leaves unconfigured and non-Vercel Responses requests unchanged", async () => {
		const routing: VercelGatewayRouting = {
			caching: "auto",
			cacheAnchorItems: 1,
			cacheTtl: "1h",
		};
		const [unconfiguredVercel, nonVercel] = await Promise.all([
			captureResponsesPayload(responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1")),
			captureResponsesPayload(responsesModel("custom", "https://api.example.com/v1", routing)),
		]);

		for (const payload of [unconfiguredVercel, nonVercel]) {
			expect(payload.caching).toBeUndefined();
			expect(payload.cache_anchor_items).toBeUndefined();
			expect(payload.cache_ttl).toBeUndefined();
			expect(payload.providerOptions).toBeUndefined();
		}
	});
});

describe("Vercel AI Gateway zero data retention", () => {
	it("maps zeroDataRetention to the documented Chat and Responses request shapes", async () => {
		const routing: VercelGatewayRouting = { zeroDataRetention: true };
		const [chat, responses] = await Promise.all([
			captureChatPayload(vercelChatModel(routing)),
			captureResponsesPayload(responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", routing)),
		]);

		expect(chat.providerOptions).toEqual({ gateway: { zeroDataRetention: true } });
		expect(chat.caching).toBeUndefined();

		expect(responses.providerOptions).toEqual({ gateway: { zeroDataRetention: true } });
		expect(responses.caching).toBeUndefined();
	});

	it("keeps zeroDataRetention beside only/order routing on both surfaces", async () => {
		const routing: VercelGatewayRouting = {
			only: ["bedrock"],
			order: ["anthropic", "bedrock"],
			zeroDataRetention: true,
		};
		const [chat, responses] = await Promise.all([
			captureChatPayload(vercelChatModel(routing)),
			captureResponsesPayload(responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", routing)),
		]);

		expect(chat.providerOptions).toEqual({
			gateway: { only: ["bedrock"], order: ["anthropic", "bedrock"], zeroDataRetention: true },
		});
		expect(responses.providerOptions).toEqual({
			gateway: { only: ["bedrock"], order: ["anthropic", "bedrock"], zeroDataRetention: true },
		});
	});

	it("keeps zeroDataRetention while suppressing caching when cache retention is none", async () => {
		const routing: VercelGatewayRouting = { caching: "auto", zeroDataRetention: true };
		const [chat, responses] = await Promise.all([
			captureChatPayload(vercelChatModel(routing), { cacheRetention: "none" }),
			captureResponsesPayload(responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", routing), {
				cacheRetention: "none",
			}),
		]);

		// ZDR is a routing constraint, not a cache preference: `none` retention
		// suppresses `caching` but must not silently drop zeroDataRetention.
		expect(chat.providerOptions).toEqual({ gateway: { zeroDataRetention: true } });
		expect(chat.caching).toBeUndefined();

		expect(responses.providerOptions).toEqual({ gateway: { zeroDataRetention: true } });
		expect(responses.caching).toBeUndefined();
	});

	it("keeps zeroDataRetention while suppressing caching when PI_CACHE_RETENTION is none", async () => {
		const routing: VercelGatewayRouting = { caching: "auto", zeroDataRetention: true };
		await withEnv({ PI_CACHE_RETENTION: "none" }, async () => {
			const [chat, responses] = await Promise.all([
				captureChatPayload(vercelChatModel(routing)),
				captureResponsesPayload(responsesModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", routing)),
			]);

			expect(chat.providerOptions).toEqual({ gateway: { zeroDataRetention: true } });
			expect(chat.caching).toBeUndefined();

			expect(responses.providerOptions).toEqual({ gateway: { zeroDataRetention: true } });
			expect(responses.caching).toBeUndefined();
		});
	});

	it("emits nothing for unset, disabled, or non-Vercel hosts", async () => {
		const nonVercelChat = buildModel({
			id: "anthropic/claude-sonnet-4.6",
			name: "Claude Sonnet 4.6",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://api.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
			compat: { vercelGatewayRouting: { zeroDataRetention: true } },
		} satisfies ModelSpec<"openai-completions">);

		const [unsetChat, disabledChat, nonVercelChatPayload, nonVercelResponses] = await Promise.all([
			captureChatPayload(vercelChatModel()),
			captureChatPayload(vercelChatModel({ zeroDataRetention: false })),
			captureChatPayload(nonVercelChat),
			captureResponsesPayload(responsesModel("custom", "https://api.example.com/v1", { zeroDataRetention: true })),
		]);

		for (const payload of [unsetChat, disabledChat, nonVercelChatPayload, nonVercelResponses]) {
			expect(payload.providerOptions).toBeUndefined();
		}
	});
});
