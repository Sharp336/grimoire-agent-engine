import { describe, expect, test } from "bun:test";
import {
	bedrockControlPlaneBaseUrl,
	bedrockDiscoveryRegions,
	bedrockRuntimeBaseUrlFromControlPlane,
	createBedrockControlPlaneFetch,
	regionFromBedrockHost,
} from "../src/providers/bedrock-control-plane";
import { getProviderDefinition } from "../src/registry/registry";

describe("Bedrock control-plane discovery auth", () => {
	test("prepareModelDiscovery is unauthenticated without AWS credential sources", async () => {
		const prev = {
			AWS_PROFILE: process.env.AWS_PROFILE,
			AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
			AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
			AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK,
			AWS_WEB_IDENTITY_TOKEN_FILE: process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
			AWS_ROLE_ARN: process.env.AWS_ROLE_ARN,
			AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE,
			AWS_SHARED_CREDENTIALS_FILE: process.env.AWS_SHARED_CREDENTIALS_FILE,
			AWS_EC2_METADATA_DISABLED: process.env.AWS_EC2_METADATA_DISABLED,
			AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
			AWS_CONTAINER_CREDENTIALS_FULL_URI: process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
		};
		const emptyConfig = `${await import("node:os").then(o => o.tmpdir())}/omp-empty-aws-config-${process.pid}`;
		const emptyCreds = `${emptyConfig}.creds`;
		await Bun.write(emptyConfig, "");
		await Bun.write(emptyCreds, "");
		try {
			for (const key of Object.keys(prev)) delete process.env[key];
			process.env.AWS_CONFIG_FILE = emptyConfig;
			process.env.AWS_SHARED_CREDENTIALS_FILE = emptyCreds;
			process.env.AWS_EC2_METADATA_DISABLED = "true";
			const prepared = getProviderDefinition("amazon-bedrock")?.prepareModelDiscovery?.({});
			expect(prepared?.authenticated).toBe(false);
		} finally {
			for (const [key, value] of Object.entries(prev)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("prepareModelDiscovery with bearer token signs via Authorization header", async () => {
		const prepared = getProviderDefinition("amazon-bedrock")?.prepareModelDiscovery?.({
			apiKey: "bedrock-api-key-test",
		});
		expect(prepared?.authenticated).toBe(true);
		expect(prepared?.baseUrl).toMatch(/^https:\/\/bedrock\./);
		expect(prepared?.fetch).toBeTypeOf("function");

		let sawAuth = false;
		const baseFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers);
			sawAuth = headers.get("authorization") === "Bearer bedrock-api-key-test";
			return Response.json({ inferenceProfileSummaries: [] });
		};
		const fetchImpl = createBedrockControlPlaneFetch({
			region: "us-east-1",
			bearerToken: "bedrock-api-key-test",
			fetch: baseFetch,
		});
		await fetchImpl("https://bedrock.us-east-1.amazonaws.com/inference-profiles");
		expect(sawAuth).toBe(true);
	});

	test("control plane and runtime URL helpers", () => {
		expect(bedrockControlPlaneBaseUrl("us-gov-east-1")).toBe("https://bedrock.us-gov-east-1.amazonaws.com");
		expect(bedrockRuntimeBaseUrlFromControlPlane("https://bedrock.us-gov-west-1.amazonaws.com")).toBe(
			"https://bedrock-runtime.us-gov-west-1.amazonaws.com",
		);
		expect(regionFromBedrockHost("bedrock.us-gov-west-1.amazonaws.com")).toBe("us-gov-west-1");
		expect(regionFromBedrockHost("bedrock-runtime.us-east-1.amazonaws.com")).toBe("us-east-1");
		expect(bedrockDiscoveryRegions("us-gov-east-1")).toEqual(["us-gov-east-1", "us-gov-west-1"]);
	});
});
