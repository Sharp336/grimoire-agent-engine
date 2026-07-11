import { afterEach, describe, expect, it, vi } from "bun:test";
import { OAuthError } from "../../../error";
import type { FetchImpl } from "../../../types";
import { getProviderDefinition, isOAuthOnlyProvider, PROVIDER_REGISTRY } from "../../registry";
import { getOAuthProviders } from "../index";
import {
	isXAIAccessTokenExpiring,
	loginXAIGrokBuild,
	loginXAIOAuth,
	refreshXAIGrokBuildToken,
	refreshXAIOAuthToken,
	validateXAIEndpoint,
} from "../xai-oauth";

afterEach(() => {
	vi.restoreAllMocks();
});

function jwtWithExp(exp: number): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
	return `${header}.${payload}.sig`;
}

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
const AUTHORIZATION_ENDPOINT = "https://auth.x.ai/oauth2/authorize";
const USERINFO_ENDPOINT = "https://auth.x.ai/oauth2/userinfo";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const BUILD_SCOPE = `${SCOPE} conversations:read conversations:write`;

const DEVICE_AUTHORIZATION = {
	device_code: "device-code-123",
	user_code: "ABCD-EFGH",
	verification_uri: "https://auth.x.ai/activate",
	verification_uri_complete: "https://auth.x.ai/activate?user_code=ABCD-EFGH",
	expires_in: 600,
	interval: 1,
};

type RecordedRequest = {
	url: string;
	init: RequestInit | undefined;
};

type TokenResponse = {
	body: unknown;
	status?: number;
};

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function createDeviceFlowFetch(tokenResponses: readonly TokenResponse[]) {
	const requests: RecordedRequest[] = [];
	let tokenResponseIndex = 0;
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
		requests.push({ url, init });

		if (url === DISCOVERY_URL) {
			return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
		}
		if (url === DEVICE_CODE_URL) {
			return jsonResponse(DEVICE_AUTHORIZATION);
		}
		if (url === TOKEN_ENDPOINT) {
			const tokenResponse = tokenResponses[tokenResponseIndex];
			tokenResponseIndex += 1;
			if (!tokenResponse) {
				throw new Error(`Unexpected xAI token poll ${tokenResponseIndex}`);
			}
			return jsonResponse(tokenResponse.body, tokenResponse.status);
		}
		throw new Error(`Unexpected xAI OAuth request: ${url}`);
	});

	return {
		fetchMock: fetchMock as unknown as typeof fetch,
		requests,
	};
}

function requestForm(request: RecordedRequest | undefined): URLSearchParams {
	const body = request?.init?.body;
	if (!(body instanceof URLSearchParams)) {
		throw new Error("Expected an application/x-www-form-urlencoded request body");
	}
	return body;
}

function buildDiscoveryResponse(): Response {
	return jsonResponse({
		authorization_endpoint: AUTHORIZATION_ENDPOINT,
		token_endpoint: TOKEN_ENDPOINT,
		userinfo_endpoint: USERINFO_ENDPOINT,
	});
}

function createBuildFlowFetch(options?: { userinfo?: unknown; tokenStatus?: number }) {
	const requests: RecordedRequest[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
		requests.push({ url, init });
		if (url === DISCOVERY_URL) return buildDiscoveryResponse();
		if (url === TOKEN_ENDPOINT) {
			return jsonResponse(
				{ access_token: "build-access", refresh_token: "build-refresh", expires_in: 3600 },
				options?.tokenStatus,
			);
		}
		if (url === USERINFO_ENDPOINT) return jsonResponse(options?.userinfo ?? { sub: "account-42", email: "a@b.test" });
		throw new Error(`Unexpected Build OAuth request: ${url}`);
	});
	return { fetchMock: fetchMock as unknown as typeof fetch, requests };
}

describe("isXAIAccessTokenExpiring", () => {
	it("returns false for an empty string", () => {
		expect(isXAIAccessTokenExpiring("")).toBe(false);
	});

	it("returns false for a non-JWT", () => {
		expect(isXAIAccessTokenExpiring("not.a.jwt")).toBe(false);
	});

	it("returns true when exp is already in the past", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(isXAIAccessTokenExpiring(jwtWithExp(now - 60))).toBe(true);
	});

	it("returns false when exp is well in the future", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(isXAIAccessTokenExpiring(jwtWithExp(now + 3600))).toBe(false);
	});
});

describe("validateXAIEndpoint", () => {
	it("rejects non-HTTPS URLs", () => {
		expect(() => validateXAIEndpoint("http://x.ai/token", "token_endpoint")).toThrow(/Invalid xAI token_endpoint/);
	});

	it("rejects non-xAI hosts", () => {
		expect(() => validateXAIEndpoint("https://evil.com/token", "token_endpoint")).toThrow(
			/Invalid xAI token_endpoint/,
		);
	});

	it("accepts the x.ai apex and *.x.ai subdomains", () => {
		expect(validateXAIEndpoint("https://x.ai/token", "token_endpoint")).toBe("https://x.ai/token");
		expect(validateXAIEndpoint("https://auth.x.ai/oauth/token", "token_endpoint")).toBe(
			"https://auth.x.ai/oauth/token",
		);
	});
});

describe("refreshXAIOAuthToken", () => {
	it("rejects an empty refresh_token without making a network call", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("fetch should not be called when refresh_token is empty");
		});

		await expect(refreshXAIOAuthToken("", fetchMock as unknown as typeof fetch)).rejects.toThrow(
			/missing refresh_token/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("preserves raw non-2xx response diagnostics for xai-oauth", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			if (url === DISCOVERY_URL) return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
			if (url === TOKEN_ENDPOINT) {
				return jsonResponse({ error: "invalid_grant", error_description: "legacy detail" }, 400);
			}
			throw new Error(`Unexpected refresh request: ${url}`);
		};

		try {
			await refreshXAIOAuthToken("xai-refresh", fetchMock);
			throw new Error("Expected xai-oauth refresh to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(OAuthError);
			expect(error).toMatchObject({ kind: "token-refresh", provider: "xai", status: 400 });
			expect((error as Error).message).toContain('"error_description":"legacy detail"');
		}
	});
});

describe("xAI Grok Build browser OAuth", () => {
	it("registers one OAuth-only login under its own provider id", () => {
		const definitions = PROVIDER_REGISTRY.filter(provider => provider.id === "xai-grok-build");
		expect(definitions).toHaveLength(1);
		expect(getProviderDefinition("xai-grok-build")).toMatchObject({
			id: "xai-grok-build",
			name: "xAI Grok Build",
			oauthOnly: true,
		});
		expect(getProviderDefinition("xai-grok-build")?.storeCredentialsAs).toBeUndefined();
		expect(getProviderDefinition("xai-grok-build")?.callbackPort).toBeUndefined();
		expect(isOAuthOnlyProvider("xai-grok-build")).toBe(true);
		expect(isOAuthOnlyProvider("xai-oauth")).toBe(false);
		expect(getOAuthProviders().filter(provider => provider.id === "xai-grok-build")).toEqual([
			{ id: "xai-grok-build", name: "xAI Grok Build", available: true, storeCredentialsAs: undefined },
		]);
	});

	it("completes the discovery-driven PKCE loopback flow and records verified identity", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const { fetchMock, requests } = createBuildFlowFetch();
		let authorizeUrl: URL | undefined;
		let callbackRequest: Promise<Response> | undefined;

		const credentials = await loginXAIGrokBuild({
			fetch: fetchMock,
			onAuth: info => {
				authorizeUrl = new URL(info.url);
				const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
				const state = authorizeUrl.searchParams.get("state");
				if (!redirectUri || !state) throw new Error("Missing redirect_uri or state");
				callbackRequest = fetch(`${redirectUri}?code=build-code&state=${encodeURIComponent(state)}`);
			},
		});
		await callbackRequest;
		if (!authorizeUrl) throw new Error("Authorization URL was not published");

		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(AUTHORIZATION_ENDPOINT);
		const params = authorizeUrl.searchParams;
		const redirectUri = params.get("redirect_uri");
		if (!redirectUri) throw new Error("Authorization URL omitted redirect_uri");
		expect([...params.keys()].sort()).toEqual([
			"client_id",
			"code_challenge",
			"code_challenge_method",
			"nonce",
			"redirect_uri",
			"referrer",
			"response_type",
			"scope",
			"state",
		]);
		expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		expect(params.get("state")).toHaveLength(36);
		expect(params.get("nonce")).toHaveLength(36);
		expect(params.get("code_challenge")).toHaveLength(43);

		const tokenRequest = requests.find(request => request.url === TOKEN_ENDPOINT);
		const tokenForm = requestForm(tokenRequest);
		const codeVerifier = tokenForm.get("code_verifier");
		if (!codeVerifier) throw new Error("Authorization-code token request omitted code_verifier");
		const codeChallenge = Buffer.from(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
		).toString("base64url");
		expect(Object.fromEntries(params)).toEqual({
			response_type: "code",
			client_id: CLIENT_ID,
			redirect_uri: redirectUri,
			scope: BUILD_SCOPE,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
			state: expect.any(String),
			nonce: expect.any(String),
			referrer: "grok-build",
		});

		expect(Object.fromEntries(tokenForm)).toEqual({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: "build-code",
			code_verifier: codeVerifier,
			redirect_uri: redirectUri,
		});
		expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
		const userinfoRequest = requests.find(request => request.url === USERINFO_ENDPOINT);
		expect(new Headers(userinfoRequest?.init?.headers).get("Authorization")).toBe("Bearer build-access");
		expect(credentials).toEqual({
			access: "build-access",
			refresh: "build-refresh",
			expires: now + 3_300_000,
			accountId: "account-42",
			email: "a@b.test",
		});
	});

	it("rejects a mismatched callback state before token exchange", async () => {
		const controller = new AbortController();
		const { fetchMock, requests } = createBuildFlowFetch();
		let wrongCallback: Promise<Response> | undefined;
		const login = loginXAIGrokBuild({
			fetch: fetchMock,
			signal: controller.signal,
			onAuth: info => {
				const authUrl = new URL(info.url);
				const redirectUri = authUrl.searchParams.get("redirect_uri");
				if (!redirectUri) throw new Error("Missing redirect_uri");
				wrongCallback = fetch(`${redirectUri}?code=build-code&state=wrong-state`).then(response => {
					controller.abort("test complete");
					return response;
				});
			},
		});
		await expect(login).rejects.toThrow(/State mismatch|CSRF/i);
		expect((await wrongCallback)?.ok).toBe(false);
		expect(requests.some(request => request.url === TOKEN_ENDPOINT)).toBe(false);
	});

	it("attributes userinfo validation failures to xai-grok-build", async () => {
		const { fetchMock } = createBuildFlowFetch({ userinfo: { email: "a@b.test" } });
		let callbackRequest: Promise<Response> | undefined;
		try {
			await loginXAIGrokBuild({
				fetch: fetchMock,
				onAuth: info => {
					const authUrl = new URL(info.url);
					const redirectUri = authUrl.searchParams.get("redirect_uri");
					const state = authUrl.searchParams.get("state");
					if (!redirectUri || !state) throw new Error("Missing callback parameters");
					callbackRequest = fetch(`${redirectUri}?code=build-code&state=${encodeURIComponent(state)}`);
				},
			});
			throw new Error("Expected login to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(OAuthError);
			expect((error as OAuthError).provider).toBe("xai-grok-build");
			expect((error as Error).message).toMatch(/userinfo response missing sub/);
		}
		await callbackRequest;
	});

	it("retains the existing refresh token when Build refresh omits a replacement", async () => {
		const requests: RecordedRequest[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			requests.push({ url, init });
			if (url === DISCOVERY_URL) return buildDiscoveryResponse();
			if (url === TOKEN_ENDPOINT) return jsonResponse({ access_token: "next-access", expires_in: 3600 });
			throw new Error(`Unexpected refresh request: ${url}`);
		});
		const credentials = await refreshXAIGrokBuildToken("existing-refresh", fetchMock as unknown as typeof fetch);
		expect(credentials.refresh).toBe("existing-refresh");
		expect(Object.fromEntries(requestForm(requests[1]))).toEqual({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: "existing-refresh",
		});
	});

	it("labels Build refresh transport failures", async () => {
		const transportFailure = new Error("connection reset");
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			if (url === DISCOVERY_URL) return buildDiscoveryResponse();
			if (url === TOKEN_ENDPOINT) throw transportFailure;
			throw new Error(`Unexpected refresh request: ${url}`);
		});

		try {
			await refreshXAIGrokBuildToken("build-refresh", fetchMock as unknown as typeof fetch);
			throw new Error("Expected Build refresh to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(OAuthError);
			expect(error).toMatchObject({ kind: "token-refresh", provider: "xai-grok-build" });
			expect((error as Error).cause).toBe(transportFailure);
		}
	});

	it("sanitizes Build refresh response diagnostics to status and allowlisted error code", async () => {
		const refreshToken = "sentinel-refresh-token\r\ninjected";
		for (const [errorCode, expectedMessage] of [
			["invalid_grant", "xAI token refresh failed: 400 invalid_grant"],
			[`${refreshToken}\u0000`, "xAI token refresh failed: 400"],
		] as const) {
			const fetchMock: FetchImpl = async input => {
				const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
				if (url === DISCOVERY_URL) return buildDiscoveryResponse();
				if (url === TOKEN_ENDPOINT) {
					return jsonResponse(
						{
							error: errorCode,
							error_description: `refresh failed for ${refreshToken}\u0000`,
							debug: refreshToken,
						},
						400,
					);
				}
				throw new Error(`Unexpected refresh request: ${url}`);
			};

			try {
				await refreshXAIGrokBuildToken(refreshToken, fetchMock);
				throw new Error("Expected Build refresh to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(OAuthError);
				expect(error).toMatchObject({ kind: "token-refresh", provider: "xai-grok-build", status: 400 });
				expect((error as Error).message).toBe(expectedMessage);
				expect((error as Error).message).not.toContain(refreshToken);
				expect((error as Error).message).not.toContain("error_description");
			}
		}
	});
});

describe("loginXAIOAuth", () => {
	it("performs the RFC 8628 device flow and returns the issued credentials", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const { fetchMock, requests } = createDeviceFlowFetch([
			{
				body: {
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				},
			},
		]);
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const progress: string[] = [];
		const onAuth = vi.fn((info: { url: string; instructions?: string }) => {
			authEvents.push(info);
		});
		const onProgress = vi.fn((message: string) => {
			progress.push(message);
		});
		const onManualCodeInput = vi.fn(async () => {
			throw new Error("device authorization must not request a pasted code");
		});

		const credentials = await loginXAIOAuth({
			fetch: fetchMock,
			onAuth,
			onProgress,
			onManualCodeInput,
		});

		expect(requests.map(request => request.url)).toEqual([DISCOVERY_URL, DEVICE_CODE_URL, TOKEN_ENDPOINT]);

		const discoveryRequest = requests[0];
		expect(discoveryRequest?.init?.method).toBe("GET");
		expect(new Headers(discoveryRequest?.init?.headers).get("Accept")).toBe("application/json");

		const deviceRequest = requests[1];
		expect(deviceRequest?.init?.method).toBe("POST");
		const deviceHeaders = new Headers(deviceRequest?.init?.headers);
		expect(deviceHeaders.get("Content-Type")).toBe("application/x-www-form-urlencoded");
		expect(deviceHeaders.get("Accept")).toBe("application/json");
		const deviceForm = requestForm(deviceRequest);
		expect([...deviceForm.keys()].sort()).toEqual(["client_id", "scope"]);
		expect(Object.fromEntries(deviceForm)).toEqual({
			client_id: CLIENT_ID,
			scope: SCOPE,
		});

		const tokenRequest = requests[2];
		expect(tokenRequest?.init?.method).toBe("POST");
		const tokenHeaders = new Headers(tokenRequest?.init?.headers);
		expect(tokenHeaders.get("Content-Type")).toBe("application/x-www-form-urlencoded");
		expect(tokenHeaders.get("Accept")).toBe("application/json");
		const tokenForm = requestForm(tokenRequest);
		expect([...tokenForm.keys()].sort()).toEqual(["client_id", "device_code", "grant_type"]);
		expect(Object.fromEntries(tokenForm)).toEqual({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: CLIENT_ID,
			device_code: DEVICE_AUTHORIZATION.device_code,
		});

		expect(authEvents).toEqual([
			{
				url: DEVICE_AUTHORIZATION.verification_uri_complete,
				instructions: `Enter code: ${DEVICE_AUTHORIZATION.user_code}`,
			},
		]);
		expect(authEvents[0]?.instructions).not.toMatch(/hermes/i);
		expect(onManualCodeInput).not.toHaveBeenCalled();
		expect(progress).toEqual(["Waiting for xAI device authorization..."]);
		expect(credentials).toEqual({
			access: "access-token",
			refresh: "refresh-token",
			expires: now + 3_300_000,
		});
	});

	it("continues through authorization_pending and slow_down responses", async () => {
		const sleepSpy = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const { fetchMock, requests } = createDeviceFlowFetch([
			{ status: 400, body: { error: "authorization_pending" } },
			{ status: 400, body: { error: "slow_down" } },
			{
				body: {
					access_token: "eventual-access-token",
					refresh_token: "eventual-refresh-token",
					expires_in: 3600,
				},
			},
		]);

		const credentials = await loginXAIOAuth({ fetch: fetchMock });

		const tokenRequests = requests.filter(request => request.url === TOKEN_ENDPOINT);
		expect(tokenRequests).toHaveLength(3);
		expect(tokenRequests.map(request => Object.fromEntries(requestForm(request)))).toEqual([
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: DEVICE_AUTHORIZATION.device_code,
			},
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: DEVICE_AUTHORIZATION.device_code,
			},
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: DEVICE_AUTHORIZATION.device_code,
			},
		]);
		expect(sleepSpy.mock.calls).toEqual([[1000], [6000]]);
		expect(credentials.access).toBe("eventual-access-token");
		expect(credentials.refresh).toBe("eventual-refresh-token");
	});

	it("rejects a token response that omits access_token", async () => {
		const { fetchMock, requests } = createDeviceFlowFetch([
			{
				body: {
					refresh_token: "refresh-token",
					expires_in: 3600,
				},
			},
		]);

		await expect(loginXAIOAuth({ fetch: fetchMock })).rejects.toThrow(
			/xAI device-code token response missing access_token/,
		);
		expect(requests.filter(request => request.url === TOKEN_ENDPOINT)).toHaveLength(1);
	});
});
