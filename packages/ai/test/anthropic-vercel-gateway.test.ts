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

function vercelModel(routing?: VercelGatewayRouting): Model<"anthropic-messages"> {
	return buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "vercel-ai-gateway",
		baseUrl: "https://ai-gateway.vercel.sh",
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
