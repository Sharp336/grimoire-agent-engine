import * as AIError from "../../error";
import { generatePKCE } from "./pkce";
import type { OAuthCredentials } from "./types";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

export interface CursorAuthParams {
	verifier: string;
	challenge: string;
	uuid: string;
	loginUrl: string;
}

export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();

	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});

	const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;

	return { verifier, challenge, uuid, loginUrl };
}

export async function pollCursorAuth(
	uuid: string,
	verifier: string,
): Promise<{ accessToken: string; refreshToken: string }> {
	let delay = POLL_BASE_DELAY;
	let consecutiveErrors = 0;

	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		await Bun.sleep(delay);

		try {
			const response = await fetch(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`);

			if (response.status === 404) {
				consecutiveErrors = 0;
				delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
				continue;
			}

			if (response.ok) {
				const data = (await response.json()) as {
					accessToken: string;
					refreshToken: string;
				};
				return {
					accessToken: data.accessToken,
					refreshToken: data.refreshToken,
				};
			}

			throw new AIError.OAuthError(`Poll failed: ${response.status}`, {
				kind: "polling",
				provider: "cursor",
				status: response.status,
			});
		} catch {
			consecutiveErrors++;
			if (consecutiveErrors >= 3) {
				throw new AIError.OAuthError("Too many consecutive errors during Cursor auth polling", {
					kind: "polling",
					provider: "cursor",
				});
			}
		}
	}

	throw new AIError.OAuthError("Cursor authentication polling timeout", {
		kind: "timeout",
		provider: "cursor",
	});
}

export async function loginCursor(
	onAuthUrl: (url: string) => void,
	onPollStart?: () => void,
): Promise<OAuthCredentials> {
	const { verifier, uuid, loginUrl } = await generateCursorAuthParams();

	onAuthUrl(loginUrl);
	onPollStart?.();

	const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);

	const expiresAt = getTokenExpiry(accessToken);

	return {
		access: accessToken,
		refresh: refreshToken,
		expires: expiresAt,
	};
}

export async function refreshCursorToken(apiKeyOrRefreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKeyOrRefreshToken}`,
			"Content-Type": "application/json",
		},
		body: "{}",
	});

	if (!response.ok) {
		const error = await response.text();
		throw new AIError.OAuthError(`Cursor token refresh failed: ${error}`, {
			kind: "token-refresh",
			provider: "cursor",
		});
	}

	const data = (await response.json()) as {
		accessToken: string;
		refreshToken: string;
	};

	const expiresAt = getTokenExpiry(data.accessToken);

	return {
		access: data.accessToken,
		refresh: data.refreshToken || apiKeyOrRefreshToken,
		expires: expiresAt,
	};
}

function getTokenExpiry(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) {
			return Date.now() + 3600 * 1000;
		}
		const payload = parts[1];
		if (!payload) {
			return Date.now() + 3600 * 1000;
		}
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
		if (decoded && typeof decoded === "object" && typeof decoded.exp === "number") {
			return decoded.exp * 1000 - 5 * 60 * 1000;
		}
	} catch {
		// Ignore parsing errors
	}
	return Date.now() + 3600 * 1000;
}

export function isCursorTokenExpiringSoon(token: string, thresholdSeconds = 300): boolean {
	try {
		const [, payload] = token.split(".");
		if (!payload) return true;
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
		const currentTime = Math.floor(Date.now() / 1000);
		return decoded.exp - currentTime < thresholdSeconds;
	} catch {
		return true;
	}
}

/**
 * Cursor dashboard API keys (Settings → API Keys, `crsr_...`) are long-lived
 * and cannot authenticate the agent RPCs directly — the official Cursor
 * CLI's `CURSOR_API_KEY` login path exchanges them for a session access
 * token via `exchange_user_api_key` before ever sending a request. Session
 * access tokens (from `/login` or `CURSOR_ACCESS_TOKEN`) are JWTs and never
 * carry this prefix, so it alone disambiguates the two credential shapes.
 */
export function isRawCursorApiKey(value: string): boolean {
	return value.startsWith("crsr_");
}

interface CachedCursorAccessToken {
	access: string;
	expires: number;
}

const rawApiKeyAccessTokenCache = new Map<string, CachedCursorAccessToken>();
const pendingRawApiKeyExchanges = new Map<string, Promise<string>>();

/**
 * Resolves any Cursor credential to a bearer usable against the agent RPCs.
 * Session access tokens pass through unchanged; a raw `CURSOR_API_KEY` is
 * exchanged once via {@link refreshCursorToken} and the resulting session
 * token cached until shortly before its JWT `exp`, so a long streaming
 * session or repeated calls don't re-exchange on every request.
 */
export async function resolveCursorAccessToken(apiKeyOrAccessToken: string): Promise<string> {
	if (!isRawCursorApiKey(apiKeyOrAccessToken)) {
		return apiKeyOrAccessToken;
	}
	const cached = rawApiKeyAccessTokenCache.get(apiKeyOrAccessToken);
	if (cached && cached.expires > Date.now()) {
		return cached.access;
	}
	const existing = pendingRawApiKeyExchanges.get(apiKeyOrAccessToken);
	if (existing) {
		return existing;
	}
	const pending = refreshCursorToken(apiKeyOrAccessToken)
		.then(credentials => {
			rawApiKeyAccessTokenCache.set(apiKeyOrAccessToken, { access: credentials.access, expires: credentials.expires });
			return credentials.access;
		})
		.finally(() => {
			pendingRawApiKeyExchanges.delete(apiKeyOrAccessToken);
		});
	pendingRawApiKeyExchanges.set(apiKeyOrAccessToken, pending);
	return pending;
}
