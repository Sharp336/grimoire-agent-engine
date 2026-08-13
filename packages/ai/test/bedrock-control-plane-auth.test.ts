import { afterEach, describe, expect, test, vi } from "bun:test";
import * as awsCredentials from "../src/providers/aws-credentials";
import {
	bedrockControlPlaneBaseUrl,
	bedrockDiscoveryRegions,
	bedrockRuntimeBaseUrlFromControlPlane,
	createBedrockControlPlaneFetch,
	regionFromBedrockHost,
} from "../src/providers/bedrock-control-plane";
import * as awsRegistry from "../src/registry/aws";
import { getProviderDefinition } from "../src/registry/registry";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Bedrock control-plane discovery auth", () => {
	test("prepareModelDiscovery is unauthenticated without AWS credential sources", () => {
		vi.spyOn(awsRegistry, "hasAwsCredentialSource").mockReturnValue(false);
		vi.spyOn(awsRegistry, "resolveAwsBearerToken").mockReturnValue(undefined);
		const prepared = getProviderDefinition("amazon-bedrock")?.prepareModelDiscovery?.({});
		expect(prepared?.authenticated).toBe(false);
	});

	test("prepareModelDiscovery honors explicit region and profile for control-plane base URL", () => {
		vi.spyOn(awsRegistry, "hasAwsCredentialSource").mockReturnValue(true);
		const prepared = getProviderDefinition("amazon-bedrock")?.prepareModelDiscovery?.({
			region: "us-gov-east-1",
			profile: "faa_sandbox",
		});
		expect(prepared?.authenticated).toBe(true);
		expect(prepared?.baseUrl).toBe("https://bedrock.us-gov-east-1.amazonaws.com");
		expect(prepared?.region).toBe("us-gov-east-1");
		expect(prepared?.profile).toBe("faa_sandbox");
	});

	test("prepareModelDiscovery with bearer token attaches Authorization header", async () => {
		const prepared = getProviderDefinition("amazon-bedrock")?.prepareModelDiscovery?.({
			apiKey: "bedrock-api-key-test",
			region: "us-east-1",
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

	test("SigV4 control-plane fetch signs host path query with service bedrock", async () => {
		vi.spyOn(awsCredentials, "resolveAwsCredentials").mockResolvedValue({
			accessKeyId: "AKIATESTACCESSKEY12",
			secretAccessKey: "test-secret-access-key-value-xx",
			sessionToken: "test-session-token",
		});

		const seen: Array<{ url: string; authorization?: string | null; amzDate?: string | null }> = [];
		const baseFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = input instanceof Request ? input.url : String(input);
			const headers = new Headers(init?.headers);
			seen.push({
				url,
				authorization: headers.get("authorization"),
				amzDate: headers.get("x-amz-date"),
			});
			return Response.json({ inferenceProfileSummaries: [] });
		};

		const fetchImpl = createBedrockControlPlaneFetch({
			region: "us-gov-west-1",
			profile: "test-profile",
			fetch: baseFetch,
		});
		await fetchImpl(
			"https://bedrock.us-gov-west-1.amazonaws.com/inference-profiles?maxResults=5&typeEquals=SYSTEM_DEFINED",
			{ method: "GET", headers: { accept: "application/json" } },
		);

		expect(seen).toHaveLength(1);
		expect(seen[0].url).toContain("bedrock.us-gov-west-1.amazonaws.com/inference-profiles");
		expect(seen[0].url).toContain("maxResults=5");
		expect(seen[0].amzDate).toMatch(/^\d{8}T\d{6}Z$/);
		// Credential scope must use the host region and service "bedrock".
		expect(seen[0].authorization).toContain("AWS4-HMAC-SHA256");
		expect(seen[0].authorization).toContain("Credential=AKIATESTACCESSKEY12/");
		expect(seen[0].authorization).toContain("/us-gov-west-1/bedrock/aws4_request");
		expect(seen[0].authorization).toContain("SignedHeaders=");
		expect(seen[0].authorization).toContain("Signature=");
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
