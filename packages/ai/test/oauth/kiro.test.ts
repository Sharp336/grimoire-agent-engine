import { describe, expect, it } from "bun:test";
import { kiroProvider } from "@oh-my-pi/pi-ai/registry/kiro";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

const KIRO_PROFILE_ARN = "arn:aws:codewhisperer:eu-west-1:123456789:profile/test";

function kiroCredentials(profileArn?: string): Record<string, OAuthCredentials> {
	return {
		kiro: {
			access: "kiro-access-token",
			refresh: "kiro-refresh-token",
			expires: Date.now() + 3_600_000,
			profileArn,
			accountId: profileArn,
		},
	};
}

function requireResult<T>(value: T | null, label: string): T {
	if (!value) throw new Error(`${label} returned null`);
	return value;
}

describe("Kiro built-in OAuth credential serialization", () => {
	it("routes Kiro credentials through the structured serializer", async () => {
		const result = requireResult(await getOAuthApiKey("kiro", kiroCredentials(KIRO_PROFILE_ARN)), "getOAuthApiKey");
		const parsed = JSON.parse(result.apiKey);
		expect(parsed).toMatchObject({
			accessToken: "kiro-access-token",
			profileArn: KIRO_PROFILE_ARN,
		});
	});

	it("matches the custom-provider Kiro serializer byte-for-byte", async () => {
		const builtIn = requireResult(await getOAuthApiKey("kiro", kiroCredentials(KIRO_PROFILE_ARN)), "getOAuthApiKey");
		const custom = kiroProvider.getApiKey?.(kiroCredentials(KIRO_PROFILE_ARN).kiro);
		expect(builtIn.apiKey).toBe(custom);
	});

	it("preserves profileArn as undefined when it was not discovered", async () => {
		const result = requireResult(await getOAuthApiKey("kiro", kiroCredentials()), "getOAuthApiKey");
		const parsed = JSON.parse(result.apiKey);
		expect(parsed.accessToken).toBe("kiro-access-token");
		expect(parsed.profileArn).toBeUndefined();
	});

	it("still returns a raw access token for non-structured providers", async () => {
		const result = requireResult(
			await getOAuthApiKey("anthropic", {
				anthropic: {
					access: "sk-ant-raw",
					refresh: "",
					expires: Date.now() + 3_600_000,
				},
			}),
			"getOAuthApiKey",
		);
		expect(result.apiKey).toBe("sk-ant-raw");
	});
});
