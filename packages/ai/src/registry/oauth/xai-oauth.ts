// Device authorization and token refresh adapted from NousResearch/hermes-agent (MIT).

/**
 * xAI Grok OAuth device authorization flow.
 *
 * Requests an RFC 8628 device code, opens xAI's verification page, and polls
 * the discovered token endpoint until the user approves the login.
 */

import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow } from "./callback-server";
import { type OAuthDeviceCodePollResult, pollOAuthDeviceCodeFlow } from "./device-code";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_GROK_BUILD_SCOPE = `${XAI_OAUTH_SCOPE} conversations:read conversations:write`;
const XAI_GROK_BUILD_REFERRER = "grok-build";
const XAI_GROK_BUILD_PROVIDER = "xai-grok-build";

// Mirrors the 5-min skew used by anthropic.ts:160 — keeps every provider on the
// same conservative client-side expiry window.
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;

const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

interface XAIOAuthDiscovery {
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint: string;
}

interface XAIDeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAllowlistedOAuthErrorCode(value: unknown): value is string {
	return (
		value === "invalid_request" ||
		value === "invalid_client" ||
		value === "invalid_grant" ||
		value === "unauthorized_client" ||
		value === "unsupported_grant_type" ||
		value === "invalid_scope"
	);
}

/**
 * Validate an xAI OIDC endpoint against its scheme and host.
 *
 * The discovery response is long-lived and its token endpoint receives every
 * future refresh token. Rejecting non-HTTPS or non-`x.ai` / `*.x.ai` hosts
 * pins that endpoint to the xAI auth origin.
 *
 * @throws Error with message `Invalid xAI <field>: <url>` when the URL fails
 *         either scheme or host validation.
 */
export function validateXAIEndpoint(url: string, field: string, provider: string = "xai"): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider });
	}
	if (parsed.protocol !== "https:") {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider });
	}
	const host = parsed.hostname.toLowerCase();
	if (!host || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider });
	}
	return url;
}

/** Fetch xAI's OIDC discovery document and validate its browser/token endpoints. */
async function xaiOAuthDiscovery(
	timeoutMs: number = DISCOVERY_TIMEOUT_MS,
	fetchOverride?: FetchImpl,
	provider: string = "xai",
	requireBrowserEndpoints: boolean = false,
): Promise<XAIOAuthDiscovery> {
	const fetchImpl = fetchOverride ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new AIError.OAuthError(
			`xAI OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "discovery", provider, cause: error },
		);
	}
	if (response.status !== 200) {
		throw new AIError.OAuthError(`xAI OIDC discovery returned status ${response.status}.`, {
			kind: "discovery",
			provider,
			status: response.status,
		});
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AIError.OAuthError(
			`xAI OIDC discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider, cause: error },
		);
	}
	if (!isRecord(payload)) {
		throw new AIError.OAuthError("xAI OIDC discovery response was not a JSON object.", {
			kind: "validation",
			provider,
		});
	}
	const endpoints = {
		authorization_endpoint:
			typeof payload.authorization_endpoint === "string" ? payload.authorization_endpoint.trim() : "",
		token_endpoint: typeof payload.token_endpoint === "string" ? payload.token_endpoint.trim() : "",
		userinfo_endpoint: typeof payload.userinfo_endpoint === "string" ? payload.userinfo_endpoint.trim() : "",
	};
	for (const [field, endpoint] of Object.entries(endpoints)) {
		const required = field === "token_endpoint" || requireBrowserEndpoints;
		if (!endpoint) {
			if (!required) continue;
			throw new AIError.OAuthError(`xAI OIDC discovery response was missing ${field}.`, {
				kind: "validation",
				provider,
			});
		}
		validateXAIEndpoint(endpoint, field, provider);
	}
	return endpoints;
}

/**
 * Check whether a JWT access token is at or past its `exp` claim (with an
 * optional refresh-skew margin).
 *
 * Returns `false` for malformed input because this is a refresh-trigger check,
 * not token validation.
 */
export function isXAIAccessTokenExpiring(jwt: string, skewSeconds: number = 0): boolean {
	try {
		if (typeof jwt !== "string" || !jwt.includes(".")) return false;
		const parts = jwt.split(".");
		if (parts.length < 2) return false;
		const payloadPart = parts[1];
		if (!payloadPart) return false;
		const decoded = Buffer.from(payloadPart, "base64url").toString("utf8");
		const payload: unknown = JSON.parse(decoded);
		if (!isRecord(payload)) return false;
		const exp = payload.exp;
		if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
		const now = Math.floor(Date.now() / 1000);
		const skew = Math.max(0, Math.floor(skewSeconds));
		return exp <= now + skew;
	} catch {
		return false;
	}
}

function parseXAIDeviceAuthorization(payload: unknown): XAIDeviceAuthorization {
	if (!isRecord(payload)) {
		throw new AIError.OAuthError("xAI device-code response was not a JSON object.", {
			kind: "validation",
			provider: "xai",
		});
	}

	const deviceCode = typeof payload.device_code === "string" ? payload.device_code.trim() : "";
	const userCode = typeof payload.user_code === "string" ? payload.user_code.trim() : "";
	const verificationUri = typeof payload.verification_uri === "string" ? payload.verification_uri.trim() : "";
	const verificationUriComplete =
		typeof payload.verification_uri_complete === "string" ? payload.verification_uri_complete.trim() : "";
	const expiresInSeconds = payload.expires_in;
	const intervalSeconds = payload.interval;
	if (
		!deviceCode ||
		!userCode ||
		!verificationUri ||
		!verificationUriComplete ||
		typeof expiresInSeconds !== "number" ||
		!Number.isFinite(expiresInSeconds) ||
		expiresInSeconds <= 0 ||
		typeof intervalSeconds !== "number" ||
		!Number.isFinite(intervalSeconds) ||
		intervalSeconds <= 0
	) {
		throw new AIError.OAuthError("xAI device-code response missing or invalid required fields.", {
			kind: "validation",
			provider: "xai",
		});
	}

	validateXAIEndpoint(verificationUri, "verification_uri");
	validateXAIEndpoint(verificationUriComplete, "verification_uri_complete");
	return {
		deviceCode,
		userCode,
		verificationUriComplete,
		expiresInSeconds,
		intervalSeconds,
	};
}

function parseXAITokenResponse(
	payload: unknown,
	label: string,
	refreshTokenFallback?: string,
	provider: string = "xai",
): OAuthCredentials {
	if (!isRecord(payload)) {
		throw new AIError.OAuthError(`${label} was not a JSON object`, {
			kind: "validation",
			provider,
		});
	}
	const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
	const responseRefreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
	const refreshToken = responseRefreshToken || refreshTokenFallback || "";
	const expiresInSeconds = payload.expires_in;
	if (!accessToken) {
		throw new AIError.OAuthError(`${label} missing access_token`, { kind: "validation", provider });
	}
	if (!refreshToken) {
		throw new AIError.OAuthError(`${label} missing refresh_token`, { kind: "validation", provider });
	}
	if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)) {
		throw new AIError.OAuthError(`${label} missing expires_in`, { kind: "validation", provider });
	}
	return {
		access: accessToken,
		refresh: refreshToken,
		expires: Date.now() + expiresInSeconds * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
	};
}

async function requestXAIDeviceAuthorization(
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<XAIDeviceAuthorization> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
		response = await fetchImpl(XAI_OAUTH_DEVICE_CODE_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({
				client_id: XAI_OAUTH_CLIENT_ID,
				scope: XAI_OAUTH_SCOPE,
			}),
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(
			`xAI device-code request failed: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "device-auth", provider: "xai", cause: error },
		);
	}

	if (!response.ok) {
		let detail = "";
		try {
			detail = (await response.text()).trim();
		} catch {
			// Ignore body-read failures; the status code is the diagnostic.
		}
		throw new AIError.OAuthError(`xAI device-code request failed: ${response.status}${detail ? ` ${detail}` : ""}`, {
			kind: "device-auth",
			provider: "xai",
			status: response.status,
		});
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AIError.OAuthError(
			`xAI device-code response returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider: "xai", cause: error },
		);
	}
	return parseXAIDeviceAuthorization(payload);
}

async function pollXAIDeviceToken(
	tokenEndpoint: string,
	deviceCode: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<OAuthDeviceCodePollResult<OAuthCredentials>> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
		response = await fetchImpl(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: XAI_OAUTH_CLIENT_ID,
				device_code: deviceCode,
			}),
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(
			`xAI device-code token polling failed: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "polling", provider: "xai", cause: error },
		);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AIError.OAuthError(
			`xAI device-code token polling returned invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ kind: "polling", provider: "xai", status: response.status, cause: error },
		);
	}

	if (response.ok) {
		return {
			status: "complete",
			value: parseXAITokenResponse(payload, "xAI device-code token response"),
		};
	}
	if (!isRecord(payload)) {
		throw new AIError.OAuthError(`xAI device-code token polling failed: ${response.status}`, {
			kind: "polling",
			provider: "xai",
			status: response.status,
		});
	}

	const errorCode = typeof payload.error === "string" ? payload.error : "";
	if (errorCode === "authorization_pending") return { status: "pending" };
	if (errorCode === "slow_down") return { status: "slow_down" };

	const errorDescription = typeof payload.error_description === "string" ? payload.error_description : "";
	const detail = errorDescription || errorCode || String(response.status);
	throw new AIError.OAuthError(`xAI device-code token polling failed: ${detail}`, {
		kind: "polling",
		provider: "xai",
		status: response.status,
	});
}

/** Log in to xAI Grok with the RFC 8628 device authorization grant. */
export async function loginXAIOAuth(ctrl: OAuthController): Promise<OAuthCredentials> {
	const fetchImpl = ctrl.fetch ?? fetch;
	const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS, fetchImpl);
	const device = await requestXAIDeviceAuthorization(fetchImpl, ctrl.signal);
	ctrl.onAuth?.({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});
	ctrl.onProgress?.("Waiting for xAI device authorization...");

	return pollOAuthDeviceCodeFlow({
		poll: () => pollXAIDeviceToken(discovery.token_endpoint, device.deviceCode, fetchImpl, ctrl.signal),
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal: ctrl.signal,
	});
}

class XAIGrokBuildOAuthFlow extends OAuthCallbackFlow {
	#discovery: XAIOAuthDiscovery;
	#verifier: string;
	#challenge: string;
	#fetch: FetchImpl;

	constructor(
		ctrl: OAuthController,
		discovery: XAIOAuthDiscovery,
		pkce: { verifier: string; challenge: string },
		fetchImpl: FetchImpl,
		callbackPort: number,
	) {
		super(ctrl, {
			preferredPort: callbackPort,
			callbackHostname: "127.0.0.1",
			callbackPath: "/callback",
		});
		this.#discovery = discovery;
		this.#verifier = pkce.verifier;
		this.#challenge = pkce.challenge;
		this.#fetch = fetchImpl;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const params = new URLSearchParams({
			response_type: "code",
			client_id: XAI_OAUTH_CLIENT_ID,
			redirect_uri: redirectUri,
			scope: XAI_GROK_BUILD_SCOPE,
			code_challenge: this.#challenge,
			code_challenge_method: "S256",
			state,
			nonce: crypto.randomUUID(),
			referrer: XAI_GROK_BUILD_REFERRER,
		});
		return { url: `${this.#discovery.authorization_endpoint}?${params.toString()}` };
	}

	generateState(): string {
		return crypto.randomUUID();
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		let response: Response;
		try {
			response = await this.#fetch(this.#discovery.token_endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: new URLSearchParams({
					grant_type: "authorization_code",
					client_id: XAI_OAUTH_CLIENT_ID,
					code,
					code_verifier: this.#verifier,
					redirect_uri: redirectUri,
				}),
				signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new AIError.OAuthError(
				`xAI authorization-code exchange failed: ${error instanceof Error ? error.message : String(error)}`,
				{ kind: "token-exchange", provider: XAI_GROK_BUILD_PROVIDER, cause: error },
			);
		}
		if (!response.ok) {
			throw new AIError.OAuthError(`xAI authorization-code exchange failed: ${response.status}`, {
				kind: "token-exchange",
				provider: XAI_GROK_BUILD_PROVIDER,
				status: response.status,
			});
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new AIError.OAuthError("xAI authorization-code exchange returned invalid JSON", {
				kind: "validation",
				provider: XAI_GROK_BUILD_PROVIDER,
				cause: error,
			});
		}
		const credentials = parseXAITokenResponse(
			payload,
			"xAI authorization-code token response",
			undefined,
			XAI_GROK_BUILD_PROVIDER,
		);
		return this.#attachUserInfo(credentials);
	}

	async #attachUserInfo(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		let response: Response;
		try {
			response = await this.#fetch(this.#discovery.userinfo_endpoint, {
				headers: { Authorization: `Bearer ${credentials.access}`, Accept: "application/json" },
				signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new AIError.OAuthError(
				`xAI userinfo request failed: ${error instanceof Error ? error.message : String(error)}`,
				{ kind: "http", provider: XAI_GROK_BUILD_PROVIDER, cause: error },
			);
		}
		if (!response.ok) {
			throw new AIError.OAuthError(`xAI userinfo request failed: ${response.status}`, {
				kind: "http",
				provider: XAI_GROK_BUILD_PROVIDER,
				status: response.status,
			});
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new AIError.OAuthError("xAI userinfo response returned invalid JSON", {
				kind: "validation",
				provider: XAI_GROK_BUILD_PROVIDER,
				cause: error,
			});
		}
		if (!isRecord(payload) || typeof payload.sub !== "string" || !payload.sub.trim()) {
			throw new AIError.OAuthError("xAI userinfo response missing sub", {
				kind: "validation",
				provider: XAI_GROK_BUILD_PROVIDER,
			});
		}
		const email = typeof payload.email === "string" && payload.email.trim() ? payload.email : undefined;
		return { ...credentials, accountId: payload.sub, ...(email ? { email } : {}) };
	}
}

export async function loginXAIGrokBuild(ctrl: OAuthController, callbackPort: number): Promise<OAuthCredentials> {
	const fetchImpl = ctrl.fetch ?? fetch;
	const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS, fetchImpl, XAI_GROK_BUILD_PROVIDER, true);
	const pkce = await generatePKCE();
	try {
		return await new XAIGrokBuildOAuthFlow(ctrl, discovery, pkce, fetchImpl, callbackPort).login();
	} catch (error) {
		if (error instanceof AIError.OAuthError || error instanceof AIError.LoginCancelledError) throw error;
		throw new AIError.OAuthError(error instanceof Error ? error.message : String(error), {
			kind: error instanceof AIError.ConfigurationError ? "configuration" : "validation",
			provider: XAI_GROK_BUILD_PROVIDER,
			cause: error,
		});
	}
}

/**
 * Refresh an xAI OAuth access token using a stored refresh_token.
 *
 * Re-runs OIDC discovery and re-validates the token endpoint before sending
 * the stored refresh token.
 */
export async function refreshXAIOAuthToken(refreshToken: string, fetchOverride?: FetchImpl): Promise<OAuthCredentials> {
	return refreshXAIToken(refreshToken, fetchOverride, "xai");
}

export async function refreshXAIGrokBuildToken(
	refreshToken: string,
	fetchOverride?: FetchImpl,
): Promise<OAuthCredentials> {
	return refreshXAIToken(refreshToken, fetchOverride, XAI_GROK_BUILD_PROVIDER);
}

async function refreshXAIToken(
	refreshToken: string,
	fetchOverride: FetchImpl | undefined,
	provider: string,
): Promise<OAuthCredentials> {
	const fetchImpl = fetchOverride ?? fetch;
	if (typeof refreshToken !== "string" || !refreshToken.trim()) {
		throw new AIError.OAuthError("missing refresh_token", { kind: "validation", provider });
	}

	const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS, fetchImpl, provider);
	const tokenEndpoint = validateXAIEndpoint(discovery.token_endpoint, "token_endpoint", provider);

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: XAI_OAUTH_CLIENT_ID,
		refresh_token: refreshToken,
	});

	let response: Response;
	try {
		response = await fetchImpl(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body,
			signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		if (provider !== XAI_GROK_BUILD_PROVIDER || error instanceof AIError.OAuthError) throw error;
		throw new AIError.OAuthError(
			`xAI token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				kind: "token-refresh",
				provider: XAI_GROK_BUILD_PROVIDER,
				cause: error,
			},
		);
	}

	if (!response.ok) {
		if (provider === XAI_GROK_BUILD_PROVIDER) {
			let errorCode: string | undefined;
			try {
				const payload: unknown = await response.json();
				if (isRecord(payload) && isAllowlistedOAuthErrorCode(payload.error)) {
					errorCode = payload.error;
				}
			} catch {
				// Build diagnostics never include untrusted response text.
			}
			throw new AIError.OAuthError(
				`xAI token refresh failed: ${response.status}${errorCode ? ` ${errorCode}` : ""}`,
				{
					kind: "token-refresh",
					provider,
					status: response.status,
				},
			);
		}
		let detail = "";
		try {
			detail = (await response.text()).trim();
		} catch {
			// Ignore body-read failures; the status code is the diagnostic.
		}
		throw new AIError.OAuthError(`xAI token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`, {
			kind: "token-refresh",
			provider,
			status: response.status,
		});
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AIError.OAuthError(
			`xAI token refresh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider, cause: error },
		);
	}
	return parseXAITokenResponse(payload, "xAI token refresh response", refreshToken, provider);
}
