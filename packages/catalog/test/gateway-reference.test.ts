import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { getBundledModelReferenceIndex } from "../src/identity/bundled";
import { inheritReferenceThinking, resolveModelReference } from "../src/identity/reference";
import type { ModelSpec } from "../src/types";

describe("Portkey gateway model references", () => {
	test("@modal ids do not fuzzy-match bundled catalog entries", () => {
		const index = getBundledModelReferenceIndex();
		expect(resolveModelReference("@modal/GLM-5-2-FP8", index)).toBeUndefined();
	});

	test("cross-provider references do not inherit wire routing thinking", () => {
		const index = getBundledModelReferenceIndex();
		const kiloGigaPotato = resolveModelReference("giga-potato", index);
		expect(kiloGigaPotato?.provider).toBe("kilo");
		expect(kiloGigaPotato?.thinking?.effortRouting).toBeDefined();
		expect(inheritReferenceThinking(undefined, kiloGigaPotato, "gateway")).toBeUndefined();
	});
});

describe("Vercel AI Gateway compat", () => {
	test("resolves Chat Completions gateway controls only for the Vercel endpoint", () => {
		const model = buildModel({
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
			compat: {
				vercelGatewayRouting: {
					only: ["anthropic"],
					order: ["anthropic", "bedrock"],
					caching: "auto",
					zeroDataRetention: true,
				},
			},
		} satisfies ModelSpec<"openai-completions">);

		expect(model.compat.isVercelGatewayHost).toBe(true);
		expect(model.compat.isVercelGatewayUrl).toBe(true);
		expect(model.compat.vercelGatewayRouting).toEqual({
			only: ["anthropic"],
			order: ["anthropic", "bedrock"],
			caching: "auto",
			zeroDataRetention: true,
		});
	});
});

test("keeps the routing host class but drops the ZDR URL claim for non-Vercel baseUrl overrides", () => {
	const routing = { only: ["bedrock"], zeroDataRetention: true };
	const buildOverridden = (
		baseUrl: string,
		compat: ModelSpec<"openai-completions">["compat"] = { vercelGatewayRouting: routing },
	) =>
		buildModel({
			id: "anthropic/claude-sonnet-4.6",
			name: "Claude Sonnet 4.6",
			api: "openai-completions",
			provider: "vercel-ai-gateway",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
			compat,
		} satisfies ModelSpec<"openai-completions">);
	const overridden = buildOverridden("https://corp-proxy.example/v1");
	const lookalike = buildOverridden("https://ai-gateway.vercel.sh.proxy.example/v1");
	const insecure = buildOverridden("http://ai-gateway.vercel.sh/v1");
	const forgedCompat = {
		vercelGatewayRouting: routing,
		isVercelGatewayUrl: true,
	} as unknown as ModelSpec<"openai-completions">["compat"];
	const forged = buildOverridden("https://corp-proxy.example/v1", forgedCompat);

	// Provider id alone keeps the broad routing host class (only/order may still
	// be emitted), but the ZDR retention claim must not be made for a non-Vercel
	// endpoint that won't enforce it.
	expect(overridden.compat.isVercelGatewayHost).toBe(true);
	expect(overridden.compat.isVercelGatewayUrl).toBe(false);
	expect(lookalike.compat.isVercelGatewayHost).toBe(true);
	expect(lookalike.compat.isVercelGatewayUrl).toBe(false);
	expect(insecure.compat.isVercelGatewayUrl).toBe(false);
	expect(forged.compat.isVercelGatewayUrl).toBe(false);
});

test("resolves Responses gateway controls only for the Vercel endpoint", () => {
	const routing = { caching: "auto" as const, cacheAnchorItems: 1, cacheTtl: "1h" as const, zeroDataRetention: true };
	const forgedCompat = {
		vercelGatewayRouting: routing,
		isVercelGatewayUrl: true,
	} as unknown as ModelSpec<"openai-responses">["compat"];
	const vercel = buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-responses",
		provider: "vercel-ai-gateway",
		baseUrl: "https://ai-gateway.vercel.sh/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { vercelGatewayRouting: routing },
	} satisfies ModelSpec<"openai-responses">);
	const direct = buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-responses",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: forgedCompat,
	} satisfies ModelSpec<"openai-responses">);

	expect(vercel.compat.isVercelGatewayHost).toBe(true);
	expect(vercel.compat.isVercelGatewayUrl).toBe(true);
	expect(vercel.compat.vercelGatewayRouting).toEqual(routing);
	expect(direct.compat.isVercelGatewayHost).toBe(false);
	expect(direct.compat.isVercelGatewayUrl).toBe(false);
});

test("resolves gateway routing controls for anthropic-messages Vercel models", () => {
	const routing = { only: ["bedrock"], zeroDataRetention: true };
	const forgedCompat = {
		vercelGatewayRouting: routing,
		isVercelGatewayUrl: true,
	} as unknown as ModelSpec<"anthropic-messages">["compat"];
	const vercel = buildModel({
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
		compat: { vercelGatewayRouting: routing },
	} satisfies ModelSpec<"anthropic-messages">);
	const direct = buildModel({
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
		compat: forgedCompat,
	} satisfies ModelSpec<"anthropic-messages">);

	expect(vercel.compat.isVercelGatewayHost).toBe(true);
	expect(vercel.compat.isVercelGatewayUrl).toBe(true);
	expect(vercel.compat.vercelGatewayRouting).toEqual(routing);
	expect(direct.compat.isVercelGatewayHost).toBe(false);
	expect(direct.compat.isVercelGatewayUrl).toBe(false);
	expect(direct.compat.vercelGatewayRouting).toEqual(routing);
});
