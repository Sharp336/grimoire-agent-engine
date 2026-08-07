import { describe, expect, test } from "bun:test";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import {
	amazonBedrockModelManagerOptions,
	bedrockDiscoveryRegions,
	bedrockRuntimeBaseUrlFromControlPlane,
	fetchAmazonBedrockDiscoveredModels,
	foundationIdFromModelArn,
	foundationIdsFromInferenceProfileSummary,
	isBedrockCatalogEligibleModelId,
	isOnDemandConverseFoundationModel,
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
	});

	test("bedrockDiscoveryRegions sweeps both GovCloud regions", () => {
		expect(bedrockDiscoveryRegions("us-gov-east-1")).toEqual(["us-gov-east-1", "us-gov-west-1"]);
		expect(bedrockDiscoveryRegions("us-gov-west-1")).toEqual(["us-gov-west-1", "us-gov-east-1"]);
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
			}),
		).toBe("us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0");
	});

	test("foundationIdsFromInferenceProfileSummary uses models[].modelArn", () => {
		expect(
			foundationIdsFromInferenceProfileSummary({
				inferenceProfileId: "my-app",
				type: "APPLICATION",
				models: [
					{
						modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0",
					},
				],
			}),
		).toEqual(["anthropic.claude-sonnet-4-5-20250929-v1:0"]);
		expect(
			foundationIdFromModelArn(
				"arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/meta.llama3-70b-instruct-v1:0",
			),
		).toBe("meta.llama3-70b-instruct-v1:0");
	});

	test("isBedrockCatalogEligibleModelId mirrors catalog denylist", () => {
		expect(isBedrockCatalogEligibleModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(true);
		expect(isBedrockCatalogEligibleModelId("ai21.jamba-instruct-v1:0")).toBe(false);
		expect(isBedrockCatalogEligibleModelId("amazon.titan-text-express-v1")).toBe(false);
		expect(isBedrockCatalogEligibleModelId("amazon.titan-embed-text-v2:0")).toBe(false);
	});

	test("isOnDemandConverseFoundationModel requires TEXT + ON_DEMAND and streaming", () => {
		expect(
			isOnDemandConverseFoundationModel({
				responseStreamingSupported: true,
				outputModalities: ["TEXT"],
				inferenceTypesSupported: ["ON_DEMAND"],
			}),
		).toBe(true);
		expect(
			isOnDemandConverseFoundationModel({
				responseStreamingSupported: true,
				outputModalities: ["TEXT"],
				inferenceTypesSupported: ["INFERENCE_PROFILE"],
			}),
		).toBe(false);
		expect(
			isOnDemandConverseFoundationModel({
				responseStreamingSupported: true,
				outputModalities: ["TEXT"],
			}),
		).toBe(false);
	});
});

describe("fetchAmazonBedrockDiscoveredModels", () => {
	test("merges system profiles and on-demand foundations across GovCloud regions", async () => {
		const calls: string[] = [];
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			calls.push(`${url.host}${url.pathname}`);
			const region = url.hostname.split(".")[1];
			if (url.pathname.endsWith("/inference-profiles")) {
				if (region === "us-gov-east-1") {
					return Response.json({
						inferenceProfileSummaries: [
							{
								inferenceProfileId: "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
								inferenceProfileName: "US-GOV Anthropic Claude Sonnet 4.5",
								type: "SYSTEM_DEFINED",
								models: [
									{
										modelArn:
											"arn:aws-us-gov:bedrock:us-gov-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0",
									},
								],
							},
							{
								inferenceProfileId: "us-gov.nvidia.nemotron-nano-9b-v2",
								inferenceProfileName: "US-GOV NVIDIA Nemotron Nano 9B v2",
								type: "SYSTEM_DEFINED",
								models: [
									{
										modelArn:
											"arn:aws-us-gov:bedrock:us-gov-east-1::foundation-model/nvidia.nemotron-nano-9b-v2",
									},
								],
							},
							// Application profile: metadata must come from models[].modelArn, not leaf "my-app".
							{
								inferenceProfileId: "my-app",
								inferenceProfileName: "Company Claude",
								type: "APPLICATION",
								inferenceProfileArn:
									"arn:aws-us-gov:bedrock:us-gov-east-1:123:application-inference-profile/my-app",
								models: [
									{
										modelArn:
											"arn:aws-us-gov:bedrock:us-gov-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0",
									},
								],
							},
						],
					});
				}
				if (region === "us-gov-west-1") {
					return Response.json({
						inferenceProfileSummaries: [
							{
								inferenceProfileId: "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
								inferenceProfileName: "US-GOV Anthropic Claude Sonnet 4.5",
								type: "SYSTEM_DEFINED",
								models: [
									{
										modelArn:
											"arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0",
									},
								],
							},
						],
					});
				}
				return Response.json({ inferenceProfileSummaries: [] });
			}
			if (url.pathname.endsWith("/foundation-models")) {
				if (region === "us-gov-west-1") {
					return Response.json({
						modelSummaries: [
							{
								modelId: "amazon.nova-lite-v1:0",
								modelName: "Nova Lite",
								responseStreamingSupported: true,
								outputModalities: ["TEXT"],
								inferenceTypesSupported: ["ON_DEMAND"],
							},
							{
								modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
								modelName: "Claude Sonnet 4.5",
								responseStreamingSupported: true,
								outputModalities: ["TEXT"],
								inferenceTypesSupported: ["INFERENCE_PROFILE"],
							},
							{
								modelId: "amazon.titan-text-express-v1",
								modelName: "Titan Text Express",
								responseStreamingSupported: true,
								outputModalities: ["TEXT"],
								inferenceTypesSupported: ["ON_DEMAND"],
							},
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
				return Response.json({ modelSummaries: [] });
			}
			return new Response("not found", { status: 404 });
		};

		const models = await fetchAmazonBedrockDiscoveredModels({
			ambientControlPlaneBaseUrl: "https://bedrock.us-gov-east-1.amazonaws.com",
			fetch: fetchImpl,
		});

		expect(models).not.toBeNull();
		const ids = models!.map(m => m.id);
		expect(ids).toContain("us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0");
		expect(ids).toContain("us-gov.nvidia.nemotron-nano-9b-v2");
		expect(ids).toContain("amazon.nova-lite-v1:0");
		expect(ids).toContain("arn:aws-us-gov:bedrock:us-gov-east-1:123:application-inference-profile/my-app");
		expect(ids).not.toContain("anthropic.claude-sonnet-4-5-20250929-v1:0");
		expect(ids).not.toContain("amazon.titan-text-express-v1");
		expect(ids).not.toContain("amazon.titan-embed-text-v2:0");

		const app = models!.find(
			m => m.id === "arn:aws-us-gov:bedrock:us-gov-east-1:123:application-inference-profile/my-app",
		);
		// Inherited from underlying Claude Sonnet 4.5 bundled reference, not fabricated defaults.
		expect(app?.reasoning).toBe(true);
		expect((app?.cost.input ?? 0) > 0).toBe(true);

		const nova = models!.find(m => m.id === "amazon.nova-lite-v1:0");
		expect(nova?.baseUrl).toBe("https://bedrock-runtime.us-gov-west-1.amazonaws.com");

		expect(calls.some(c => c.includes("bedrock.us-gov-east-1.amazonaws.com"))).toBe(true);
		expect(calls.some(c => c.includes("bedrock.us-gov-west-1.amazonaws.com"))).toBe(true);
	});

	test("returns null when every region fails so static catalog is retained", async () => {
		const models = await fetchAmazonBedrockDiscoveredModels({
			ambientControlPlaneBaseUrl: "https://bedrock.us-east-1.amazonaws.com",
			fetch: async () => new Response("nope", { status: 403 }),
		});
		expect(models).toBeNull();
	});

	test("returns null when profiles empty and foundation listing fails (no authoritative wipe)", async () => {
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname.endsWith("/inference-profiles")) {
				return Response.json({ inferenceProfileSummaries: [] });
			}
			return new Response("forbidden", { status: 403 });
		};
		const models = await fetchAmazonBedrockDiscoveredModels({
			ambientControlPlaneBaseUrl: "https://bedrock.us-east-1.amazonaws.com",
			fetch: fetchImpl,
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
							models: [
								{
									modelArn:
										"arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0",
								},
							],
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
		const hit = result.models.find(m => m.id === "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		expect(hit?.provider).toBe("amazon-bedrock");
		expect(hit?.api).toBe("bedrock-converse-stream");
	});
});
