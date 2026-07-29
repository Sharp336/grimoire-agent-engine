import { beforeEach, describe, expect, test } from "bun:test";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { withEnv } from "./helpers";

// The catalog seeds `{region}` as a placeholder in the base URL; `stream` swaps
// in the resolved region and injects AWS credentials before the request goes out.
const mantleModel: Model<"openai-responses"> = buildModel({
	id: "openai.gpt-5.6-terra",
	name: "GPT-5.6 Terra",
	api: "openai-responses",
	provider: "bedrock-mantle",
	baseUrl: "https://bedrock-mantle.{region}.api.aws/openai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 2.75, output: 16.5, cacheRead: 0.28, cacheWrite: 3.44 },
	contextWindow: 272_000,
	maxTokens: 128_000,
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	},
});

function userContext(): Context {
	return { messages: [{ role: "user", content: "Say hello", timestamp: 0 }] };
}

interface Captured {
	urls: string[];
	authorization: (string | null)[];
	securityToken: (string | null)[];
}

/** Records the outgoing request and fails it, so nothing hits the network. */
function capturingFetch(captured: Captured): FetchImpl {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			captured.urls.push(String(input instanceof Request ? input.url : input));
			const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			captured.authorization.push(headers.get("authorization"));
			captured.securityToken.push(headers.get("x-amz-security-token"));
			return new Response("nope", { status: 418 });
		},
		{ preconnect: fetch.preconnect },
	);
}

async function runOnce(env: Record<string, string | undefined>, options: { region?: string } = {}): Promise<Captured> {
	const captured: Captured = { urls: [], authorization: [], securityToken: [] };
	await withEnv(env, async () => {
		clearAwsCredentialCache();
		await stream(mantleModel, userContext(), {
			...options,
			fetch: capturingFetch(captured),
			maxTokens: 16,
		}).result();
	});
	return captured;
}

// Clear every AWS variable the resolvers consult, so the host environment (or a
// developer's real profile) cannot leak into these assertions.
const CLEAN_AWS_ENV: Record<string, string | undefined> = {
	AWS_BEARER_TOKEN_BEDROCK: undefined,
	AWS_ACCESS_KEY_ID: undefined,
	AWS_SECRET_ACCESS_KEY: undefined,
	AWS_SESSION_TOKEN: undefined,
	AWS_PROFILE: undefined,
	AWS_REGION: undefined,
	AWS_DEFAULT_REGION: undefined,
	// The credential chain would otherwise fall through to EC2 IMDS and stall.
	AWS_EC2_METADATA_DISABLED: "true",
};

const STATIC_KEYS: Record<string, string> = {
	AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
	AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("bedrock-mantle region rewriting", () => {
	beforeEach(() => {
		clearAwsCredentialCache();
	});

	test("substitutes {region} from AWS_REGION", async () => {
		const captured = await runOnce({
			...CLEAN_AWS_ENV,
			AWS_BEARER_TOKEN_BEDROCK: "test-token",
			AWS_REGION: "us-west-2",
		});
		expect(captured.urls).toHaveLength(1);
		expect(captured.urls[0]).toStartWith("https://bedrock-mantle.us-west-2.api.aws/openai/v1");
		expect(captured.urls[0]).not.toContain("{region}");
		expect(captured.urls[0]).not.toContain("%7Bregion%7D");
	});

	test("falls back to AWS_DEFAULT_REGION, then to us-east-1", async () => {
		const viaDefault = await runOnce({
			...CLEAN_AWS_ENV,
			AWS_BEARER_TOKEN_BEDROCK: "test-token",
			AWS_DEFAULT_REGION: "us-east-2",
		});
		expect(viaDefault.urls[0]).toStartWith("https://bedrock-mantle.us-east-2.api.aws/openai/v1");

		const viaDefaultRegion = await runOnce({
			...CLEAN_AWS_ENV,
			AWS_BEARER_TOKEN_BEDROCK: "test-token",
		});
		expect(viaDefaultRegion.urls[0]).toStartWith("https://bedrock-mantle.us-east-1.api.aws/openai/v1");
	});

	test("an explicit option region wins over the environment", async () => {
		const captured = await runOnce(
			{ ...CLEAN_AWS_ENV, AWS_BEARER_TOKEN_BEDROCK: "test-token", AWS_REGION: "us-east-2" },
			{ region: "us-west-2" },
		);
		expect(captured.urls[0]).toStartWith("https://bedrock-mantle.us-west-2.api.aws/openai/v1");
	});
});

describe("bedrock-mantle authentication", () => {
	beforeEach(() => {
		clearAwsCredentialCache();
	});

	test("sends AWS_BEARER_TOKEN_BEDROCK as a bearer token, ahead of SigV4", async () => {
		const captured = await runOnce({
			...CLEAN_AWS_ENV,
			...STATIC_KEYS,
			AWS_BEARER_TOKEN_BEDROCK: "test-token",
			AWS_REGION: "us-east-1",
		});
		// The bearer token must win even though static keys are also present.
		expect(captured.authorization[0]).toBe("Bearer test-token");
		expect(captured.securityToken[0]).toBeNull();
	});

	test("signs with SigV4 when no bearer token is set", async () => {
		const captured = await runOnce({
			...CLEAN_AWS_ENV,
			...STATIC_KEYS,
			AWS_REGION: "us-east-1",
		});
		const authorization = captured.authorization[0];
		expect(authorization).toStartWith("AWS4-HMAC-SHA256 Credential=");
		// Signed for the `bedrock` service in the resolved region — not `bedrock-mantle`.
		expect(authorization).toContain(`/us-east-1/bedrock/aws4_request`);
		// The catalog's `Bearer <sentinel>` default must never reach the wire.
		expect(authorization).not.toContain("<authenticated>");
	});

	test("forwards a session token as x-amz-security-token", async () => {
		const captured = await runOnce({
			...CLEAN_AWS_ENV,
			...STATIC_KEYS,
			AWS_SESSION_TOKEN: "test-session-token",
			AWS_REGION: "us-east-1",
		});
		expect(captured.authorization[0]).toStartWith("AWS4-HMAC-SHA256 Credential=");
		expect(captured.securityToken[0]).toBe("test-session-token");
		expect(captured.authorization[0]).toContain("x-amz-security-token");
	});

	test("is exempt from the API-key gate and defers to the AWS credential chain", async () => {
		// The provider has no API key at all. The registry's env probe cannot see
		// file-based profiles, SSO, or IMDS, so gating on a key here would reject
		// valid setups: reaching the credential chain (and failing there) is the
		// correct behavior, not `MissingApiKeyError`.
		const captured: Captured = { urls: [], authorization: [], securityToken: [] };
		let caught: unknown;
		let errorMessage: string | undefined;
		await withEnv(CLEAN_AWS_ENV, async () => {
			clearAwsCredentialCache();
			try {
				// `MissingApiKeyError` is raised synchronously by the dispatcher, so it
				// would surface here rather than as a stream error.
				const result = await stream(mantleModel, userContext(), {
					fetch: capturingFetch(captured),
					maxTokens: 16,
					// A profile that does not exist, so the chain cannot resolve anything.
					profile: "omp-test-nonexistent-profile",
					// Bound the wait: resolution may block on slow sources rather than
					// failing fast, and either outcome proves the key gate was passed.
					signal: AbortSignal.timeout(500),
				} as Parameters<typeof stream>[2]).result();
				errorMessage = result.errorMessage;
			} catch (error) {
				caught = error;
			}
		});
		expect(caught).toBeUndefined();
		expect(errorMessage ?? "").not.toContain("No API key");
		// It failed while resolving AWS credentials, so no request was attempted.
		expect(captured.urls).toEqual([]);
	});

	test("signs the region the request was actually rewritten to", async () => {
		const captured = await runOnce({
			...CLEAN_AWS_ENV,
			...STATIC_KEYS,
			AWS_REGION: "us-west-2",
		});
		expect(captured.urls[0]).toStartWith("https://bedrock-mantle.us-west-2.api.aws/openai/v1");
		expect(captured.authorization[0]).toContain("/us-west-2/bedrock/aws4_request");
	});
});
