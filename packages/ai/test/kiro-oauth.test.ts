import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { loginKiro, refreshKiroToken } from "@oh-my-pi/pi-ai/registry/oauth/kiro";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const PROFILE_ARN = "arn:aws:codewhisperer:eu-west-1:123:profile/test";

function json(payload: unknown, status = 200): Response {
	return Response.json(payload, { status });
}

function loginFetch(tokenResponse: Response | (() => Response | Promise<Response>)): FetchImpl {
	return async input => {
		const url = String(input);
		if (url.endsWith("/client/register")) return json({ clientId: "client", clientSecret: "secret" });
		if (url.endsWith("/device_authorization")) {
			return json({
				deviceCode: "device",
				userCode: "ABCD-EFGH",
				verificationUri: "https://example.test/verify",
				verificationUriComplete: "https://example.test/verify?code=ABCD-EFGH",
				interval: 1,
				expiresIn: 60,
			});
		}
		if (url.endsWith("/token")) return typeof tokenResponse === "function" ? tokenResponse() : tokenResponse;
		if (url.startsWith("https://management.us-east-1.kiro.dev/")) return json({ profiles: [{ arn: PROFILE_ARN }] });
		throw new Error(`Unexpected Kiro OAuth request: ${url}`);
	};
}

describe("Kiro OAuth", () => {
	it("completes device login and persists the discovered profile", async () => {
		const authUrls: string[] = [];
		const credentials = await loginKiro({
			fetch: loginFetch(json({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 })),
			onAuth: info => authUrls.push(info.url),
		});

		expect(authUrls).toEqual(["https://example.test/verify?code=ABCD-EFGH"]);
		expect(credentials).toMatchObject({ access: "access", profileArn: PROFILE_ARN, accountId: PROFILE_ARN });
		expect(JSON.parse(credentials.refresh)).toEqual({
			clientId: "client",
			clientSecret: "secret",
			refreshToken: "refresh",
			region: "us-east-1",
		});
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("preserves the stored refresh token when refresh omits a replacement", async () => {
		const credentials = await refreshKiroToken(
			{
				access: "old-access",
				expires: 0,
				refresh: JSON.stringify({
					clientId: "client",
					clientSecret: "secret",
					refreshToken: "stored-refresh",
					region: "eu-west-1",
				}),
				profileArn: PROFILE_ARN,
			},
			async (input, init) => {
				expect(String(input)).toBe("https://oidc.eu-west-1.amazonaws.com/token");
				expect(JSON.parse(String(init?.body))).toMatchObject({ refreshToken: "stored-refresh" });
				return json({ accessToken: "new-access", expiresIn: 1800 });
			},
		);

		expect(credentials.access).toBe("new-access");
		expect(JSON.parse(credentials.refresh).refreshToken).toBe("stored-refresh");
		expect(credentials.profileArn).toBe(PROFILE_ARN);
	});

	it("maps a provider device denial to an OAuth polling error", async () => {
		const error = await loginKiro({ fetch: loginFetch(json({ error: "access_denied" }, 400)) }).catch(value => value);
		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect((error as Error).message).toContain("access_denied (HTTP 400)");
	});

	it("maps cancellation during token polling to LoginCancelledError", async () => {
		const controller = new AbortController();
		const error = await loginKiro({
			signal: controller.signal,
			fetch: loginFetch(() => {
				controller.abort();
				throw new Error("cancelled fetch");
			}),
		}).catch(value => value);

		expect(error).toBeInstanceOf(AIError.LoginCancelledError);
		expect((error as Error).message).toBe("Login cancelled");
	});
});
