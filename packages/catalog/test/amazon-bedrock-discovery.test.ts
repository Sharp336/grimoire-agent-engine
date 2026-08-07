import { describe, expect, test } from "bun:test";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import {
	amazonBedrockModelManagerOptions,
	bedrockRuntimeBaseUrlFromControlPlane,
	fetchAmazonBedrockDiscoveredModels,
	resolveBedrockDiscoveredModelId,
	stripBedrockGeoPrefix,
} from "@oh-my-pi/pi-catalog/provider-models";

describe("Amazon Bedrock discovery helpers", () => {
	test("stripBedrockGeoPrefix removes us-gov and commercial geo prefixes", () => {
		expect(stripBedrockGeoPrefix("us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
			"anthropic.claude-sonnet-4-5-20250929-v1:0",
		);
		expect(stripBedrockGeoPrefix("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
			"anthropic.claude-sonnet-4-5-20250929-v1:0",
		);
		expect(stripBedrockGeoPrefix("global.anthropic.claude-opus-4-8")).toBe("anthropic.claude-opus-4-8");
		expect(stripBedrockGeoPrefix("anthropic.claude-opus-4-8")).toBe("anthropic.claude-opus-4-8");
	});

	test("bedrockRuntimeBaseUrlFromControlPlane maps control plane host to runtime host", () => {
		expect(bedrockRuntimeBaseUrlFromControlPlane("https://bedrock.us-gov-east-1.amazonaws.com")).toBe(
			"https://bedrock-runtime.us-gov-east-1.amazonaws.com",
		);
		expect(bedrockRuntimeBaseUrlFromControlPlane("https://bedrock.us-east-1.amazonaws.com")).toBe(
			"https://bedrock-runtime.us-east-1.amazonaws.com",
		);
	});

	test("resolveBedrockDiscoveredModelId prefers ARN for application profiles", () => {
		expect(
			resolveBedrockDiscoveredModelId({
				type: "APPLICATION",
				inferenceProfileId: "my-app",
				inferenceProfileArn: "arn:aws-us-gov:bedrock:us-gov-east-1:123:application-inference-profile/my-app",
			}),
		).toBe("arn:aws-us-gov:bedrock:us-gov-east-1:123:application-inference-profile/my-app");

		expect(
			resolveBedrockDiscoveredModelId({
				type: "SYSTEM_DEFINED",
				inferenceProfileId: "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
				inferenceProfileArn:
					"arn:aws-us-gov:bedrock:us-gov-east-1:123:inference-profile/us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
			}),
		).toBe("us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0");
	});
});

describe("fetchAmazonBedrockDiscoveredModels", () => {
	test("maps system inference profiles from the control plane and is authoritative-ready", async () => {
		const calls: string[] = [];
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			calls.push(`${url.pathname}${url.search}`);
			if (url.pathname.endsWith("/inference-profiles")) {
				return Response.json({
					inferenceProfileSummaries: [
						{
							inferenceProfileId: "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
							inferenceProfileName: "US-GOV Anthropic Claude Sonnet 4.5",
							type: "SYSTEM_DEFINED",
							inferenceProfileArn:
								"arn:aws-us-gov:bedrock:us-gov-east-1:005444746089:inference-profile/us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
						},
						{
							inferenceProfileId: "us-gov.anthropic.claude-opus-4-8",
							inferenceProfileName: "US-GOV Anthropic Claude Opus 4.8",
							type: "SYSTEM_DEFINED",
						},
					],
				});
			}
			if (url.pathname.endsWith("/foundation-models")) {
				return Response.json({
					modelSummaries: [
						{
							modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
							modelName: "Claude Sonnet 4.5",
							responseStreamingSupported: true,
							outputModalities: ["TEXT"],
							inferenceTypesSupported: ["INFERENCE_PROFILE"],
						},
						// Embedding-only / non-text should be dropped.
						{
							modelId: "amazon.titan-embed-text-v2:0",
							modelName: "Titan Embed",
							responseStreamingSupported: false,
							outputModalities: ["EMBEDDING"],
							inferenceTypesSupported: ["ON_DEMAND"],
						},
					],
				});
			}
			return new Response("not found", { status: 404 });
		};

		const models = await fetchAmazonBedrockDiscoveredModels({
			controlPlaneBaseUrl: "https://bedrock.us-gov-east-1.amazonaws.com",
			runtimeBaseUrl: "https://bedrock-runtime.us-gov-east-1.amazonaws.com",
			fetch: fetchImpl,
		});

		expect(models).not.toBeNull();
		const ids = models!.map(m => m.id);
		expect(ids).toContain("us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0");
		expect(ids).toContain("us-gov.anthropic.claude-opus-4-8");
		expect(ids).toContain("anthropic.claude-sonnet-4-5-20250929-v1:0");
		expect(ids).not.toContain("amazon.titan-embed-text-v2:0");

		const sonnet = models!.find(m => m.id === "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0");
		expect(sonnet?.api).toBe("bedrock-converse-stream");
		expect(sonnet?.provider).toBe("amazon-bedrock");
		expect(sonnet?.baseUrl).toBe("https://bedrock-runtime.us-gov-east-1.amazonaws.com");
		expect(sonnet?.name).toContain("Sonnet");

		expect(calls.some(c => c.includes("/inference-profiles"))).toBe(true);
		expect(calls.some(c => c.includes("/foundation-models"))).toBe(true);
	});

	test("returns null when the inference-profile list fails so static catalog is retained", async () => {
		const models = await fetchAmazonBedrockDiscoveredModels({
			controlPlaneBaseUrl: "https://bedrock.us-east-1.amazonaws.com",
			runtimeBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			fetch: async () => new Response("nope", { status: 403 }),
		});
		expect(models).toBeNull();
	});

	test("model manager options omit fetchDynamicModels without authenticated discovery config", () => {
		const opts = amazonBedrockModelManagerOptions({});
		expect(opts.providerId).toBe("amazon-bedrock");
		expect(opts.dynamicModelsAuthoritative).toBe(true);
		expect(opts.fetchDynamicModels).toBeUndefined();
	});

	test("model manager refresh uses discovered models when authenticated", async () => {
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname.endsWith("/inference-profiles")) {
				return Response.json({
					inferenceProfileSummaries: [
						{
							inferenceProfileId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
							inferenceProfileName: "US Claude Sonnet 4.5",
							type: "SYSTEM_DEFINED",
						},
					],
				});
			}
			if (url.pathname.endsWith("/foundation-models")) {
				return Response.json({ modelSummaries: [] });
			}
			return new Response("not found", { status: 404 });
		};

		const manager = createModelManager(
			amazonBedrockModelManagerOptions({
				authenticated: true,
				baseUrl: "https://bedrock.us-east-1.amazonaws.com",
				fetch: fetchImpl,
			}),
		);
		const result = await manager.refresh("online");
		expect(result.stale).toBe(false);
		const ids = result.models.map(m => m.id);
		expect(ids).toContain("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		// Authoritative discovery should not keep unrelated static-only commercial geos
		// that were not returned by the control plane (exact set depends on cache merge,
		// but the discovered id must be present and provider must match).
		const hit = result.models.find(m => m.id === "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		expect(hit?.provider).toBe("amazon-bedrock");
		expect(hit?.api).toBe("bedrock-converse-stream");
	});
});
