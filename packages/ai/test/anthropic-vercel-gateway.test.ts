import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, ModelSpec, VercelGatewayRouting } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

type Payload = Record<string, unknown>;

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function vercelModel(
	routing?: VercelGatewayRouting,
	baseUrl = "https://ai-gateway.vercel.sh",
): Model<"anthropic-messages"> {
	return buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "vercel-ai-gateway",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...(routing ? { compat: { vercelGatewayRouting: routing } } : {}),
	} satisfies ModelSpec<"anthropic-messages">);
}

function customModel(routing?: VercelGatewayRouting): Model<"anthropic-messages"> {
	return buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "custom",
		baseUrl: "https://api.example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...(routing ? { compat: { vercelGatewayRouting: routing } } : {}),
	} satisfies ModelSpec<"anthropic-messages">);
}

function capturePayload(model: Model<"anthropic-messages">): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamAnthropic(model, context, {
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as Payload),
	});
	return promise;
}

describe("Vercel AI Gateway routing on the Anthropic transport", () => {
	it("forwards routing and zeroDataRetention as providerOptions.gateway", async () => {
		const payload = await capturePayload(
			vercelModel({ only: ["bedrock"], order: ["anthropic", "bedrock"], zeroDataRetention: true }),
		);
		expect(payload.providerOptions).toEqual({
			gateway: { only: ["bedrock"], order: ["anthropic", "bedrock"], zeroDataRetention: true },
		});
	});

	it("emits zeroDataRetention alone without a routing preference", async () => {
		const payload = await capturePayload(vercelModel({ zeroDataRetention: true }));
		expect(payload.providerOptions).toEqual({ gateway: { zeroDataRetention: true } });
	});

	it("drops zeroDataRetention when baseUrl is overridden away from Vercel", async () => {
		// The provider id alone is not enough for a retention claim; only routing
		// survives a baseUrl override away from the Vercel hostname.
		const routing: VercelGatewayRouting = { only: ["bedrock"], zeroDataRetention: true };
		const [proxyPayload, lookalikePayload] = await Promise.all([
			capturePayload(vercelModel(routing, "https://corp-proxy.example")),
			capturePayload(vercelModel(routing, "https://ai-gateway.vercel.sh.proxy.example")),
		]);
		expect(proxyPayload.providerOptions).toEqual({ gateway: { only: ["bedrock"] } });
		expect(lookalikePayload.providerOptions).toEqual({ gateway: { only: ["bedrock"] } });
	});

	it("leaves unset, disabled, and non-Vercel requests unchanged", async () => {
		const [unset, disabled, nonVercel] = await Promise.all([
			capturePayload(vercelModel()),
			capturePayload(vercelModel({ zeroDataRetention: false })),
			capturePayload(customModel({ zeroDataRetention: true })),
		]);
		for (const payload of [unset, disabled, nonVercel]) {
			expect(payload.providerOptions).toBeUndefined();
		}
	});
});
