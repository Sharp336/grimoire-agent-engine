/**
 * Qwen Code OAuth flow (Device Code Flow with PKCE)
 *
 * Based on OAuth 2.0 Device Authorization Grant (RFC 8628)
 * Following the pattern established by GitHub Copilot implementation
 *
 * This is a NEW provider that implements proper OAuth device code flow,
 * distinct from qwen-portal which uses manual token paste.
 */

import { abortableSleep } from "@oh-my-pi/pi-utils";
import type { OAuthController, OAuthCredentials } from "./types";

const QWEN_CONFIG = {
	clientId: process.env.QWEN_OAUTH_CLIENT_ID || "",
	deviceCodeUrl: "https://chat.qwen.ai/api/v1/oauth2/device/code",
	tokenUrl: "https://chat.qwen.ai/api/v1/oauth2/token",
	scope: "openid profile email model.completion",
} as const;

const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;

/** Device code response from Qwen */
type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
};

/** Token response */
type TokenSuccessResponse = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	id_token?: string;
	token_type: string;
};

/** Token error response */
type TokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// Generate random verifier (43-128 chars as per RFC 7636)
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	// Generate challenge (SHA256 of verifier)
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = new Uint8Array(hashBuffer);
	const challenge = btoa(String.fromCharCode(...hashArray))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	return { verifier, challenge };
}

async function startDeviceFlow(): Promise<{ deviceCode: DeviceCodeResponse; codeVerifier: string }> {
	const pkce = await generatePKCE();

	const data = await fetchJson(QWEN_CONFIG.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: QWEN_CONFIG.clientId,
			scope: QWEN_CONFIG.scope,
			code_challenge: pkce.challenge,
			code_challenge_method: "S256",
		}),
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response from Qwen");
	}

	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid device code response fields from Qwen");
	}

	return {
		deviceCode: {
			device_code: deviceCode,
			user_code: userCode,
			verification_uri: verificationUri,
			interval,
			expires_in: expiresIn,
		},
		codeVerifier: pkce.verifier,
	};
}

async function sleepForQwenPoll(ms: number, signal?: AbortSignal): Promise<void> {
	try {
		await abortableSleep(ms, signal);
	} catch {
		throw new Error("Login cancelled");
	}
}

async function pollForToken(
	deviceCode: string,
	codeVerifier: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
): Promise<TokenSuccessResponse> {
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
	let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs);
		await sleepForQwenPoll(waitMs, signal);

		const raw = await fetch(QWEN_CONFIG.tokenUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: QWEN_CONFIG.clientId,
				device_code: deviceCode,
				code_verifier: codeVerifier,
			}),
		});

		if (!raw.ok) {
			const errorData = (await raw.json().catch(() => ({}))) as TokenErrorResponse;
			const { error, error_description: description, interval } = errorData;

			if (error === "authorization_pending") {
				continue;
			}

			if (error === "slow_down") {
				slowDownResponses += 1;
				intervalMs =
					typeof interval === "number" && interval > 0 ? interval * 1000 : Math.max(1000, intervalMs + 5000);
				intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
				continue;
			}

			const descriptionSuffix = description ? `: ${description}` : "";
			throw new Error(`Device flow failed: ${error}${descriptionSuffix}`);
		}

		const data = (await raw.json()) as TokenSuccessResponse;

		if (
			typeof data.access_token !== "string" ||
			typeof data.refresh_token !== "string" ||
			typeof data.expires_in !== "number"
		) {
			throw new Error("Invalid token response from Qwen");
		}

		return data;
	}

	if (slowDownResponses > 0) {
		throw new Error(
			"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.",
		);
	}

	throw new Error("Device flow timed out");
}

function decodeJwt(token: string): { email?: string; preferred_username?: string; sub?: string; name?: string } | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1];
		if (!payload) return null;
		const decoded = JSON.parse(atob(payload));
		return decoded;
	} catch {
		return null;
	}
}

/**
 * Login with Qwen Code OAuth (device code flow)
 *
 * Flow:
 * 1. Request device code from Qwen
 * 2. Show user the verification URL and code
 * 3. Poll for access token
 * 4. Return OAuth credentials
 */
export async function loginQwenCode(ctrl: OAuthController): Promise<OAuthCredentials> {
	ctrl.onProgress?.("Requesting device code from Qwen...");

	const { deviceCode, codeVerifier } = await startDeviceFlow();

	ctrl.onAuth?.({
		url: deviceCode.verification_uri,
		instructions: `Enter code "${deviceCode.user_code}" at ${deviceCode.verification_uri}`,
	});

	ctrl.onProgress?.("Waiting for browser authentication...");

	const tokenData = await pollForToken(
		deviceCode.device_code,
		codeVerifier,
		deviceCode.interval,
		deviceCode.expires_in,
		ctrl.signal,
	);

	// Extract user info from
	const decodedIdToken = tokenData.id_token ? decodeJwt(tokenData.id_token) : null;
	const decodedAccessToken = decodeJwt(tokenData.access_token);

	const email =
		decodedIdToken?.email ||
		decodedIdToken?.preferred_username ||
		decodedAccessToken?.email ||
		decodedAccessToken?.preferred_username ||
		undefined;

	const displayName = decodedIdToken?.name || email || undefined;

	ctrl.onProgress?.("Authentication successful!");

	return {
		access: tokenData.access_token,
		refresh: tokenData.refresh_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000, // 5 min buffer
		email,
		accountId: displayName,
	};
}

/**
 * Refresh Qwen Code OAuth token
 *
 * Uses the refresh_token grant type to get new access/refresh tokens.
 */
export async function refreshQwenCodeToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(QWEN_CONFIG.tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: QWEN_CONFIG.clientId,
			refresh_token: refreshToken,
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Qwen Code token refresh failed: ${error}`);
	}

	const tokenData = (await response.json()) as TokenSuccessResponse;

	if (
		typeof tokenData.access_token !== "string" ||
		typeof tokenData.refresh_token !== "string" ||
		typeof tokenData.expires_in !== "number"
	) {
		throw new Error("Invalid token response during refresh");
	}

	// Extract user info from tokens
	const decodedIdToken = tokenData.id_token ? decodeJwt(tokenData.id_token) : null;
	const decodedAccessToken = decodeJwt(tokenData.access_token);

	const email =
		decodedIdToken?.email ||
		decodedIdToken?.preferred_username ||
		decodedAccessToken?.email ||
		decodedAccessToken?.preferred_username ||
		undefined;

	const displayName = decodedIdToken?.name || email || undefined;

	return {
		access: tokenData.access_token,
		refresh: tokenData.refresh_token || refreshToken, // Fall back to old if not returned
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
		email,
		accountId: displayName,
	};
}
