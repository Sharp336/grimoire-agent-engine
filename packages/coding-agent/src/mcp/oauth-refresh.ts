import type { OAuthCredentials } from "@oh-my-pi/pi-ai";

export interface RefreshOptions {
	refreshToken: string;
	tokenUrl: string;
	clientId?: string;
	clientSecret?: string;
	scopes?: string;
}

const PRIVATE_IP_PATTERNS = [
	/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
	/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
	/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
	/^192\.168\.\d{1,3}\.\d{1,3}$/,
	/^169\.254\.\d{1,3}\.\d{1,3}$/,
	/^0\.0\.0\.0$/,
	/^::1$/,
	/^fd00:/i,
	/^fe80:/i,
];

export function validateTokenUrl(tokenUrl: string, serverOrigin: string, authServerOrigin?: string): void {
	let parsed: URL;
	try {
		parsed = new URL(tokenUrl);
	} catch {
		throw new Error(`Invalid token URL: ${tokenUrl}`);
	}

	const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";

	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
		throw new Error(`Token URL must use HTTPS (got ${parsed.protocol}). HTTP is only allowed for localhost.`);
	}

	const tokenOrigin = parsed.origin;
	const originsMatch =
		tokenOrigin === serverOrigin || (authServerOrigin !== undefined && tokenOrigin === authServerOrigin);

	if (!originsMatch) {
		const allowed = authServerOrigin ? `${serverOrigin} or ${authServerOrigin}` : serverOrigin;
		throw new Error(`Token URL origin ${tokenOrigin} does not match expected origin(s): ${allowed}`);
	}

	// Skip SSRF check for localhost (already validated for HTTPS exemption above)
	if (isLocalhost) return;

	// Strip IPv6 brackets for pattern matching
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	for (const pattern of PRIVATE_IP_PATTERNS) {
		if (pattern.test(hostname)) {
			throw new Error(`Token URL hostname ${hostname} resolves to a private/reserved address`);
		}
	}
}

export function sanitizeTokenError(responseBody: string): string {
	try {
		const json = JSON.parse(responseBody);
		const error = json.error;
		const description = json.error_description;
		if (error || description) {
			return `error: ${error ?? "unknown"}, description: ${description ?? "none"}`;
		}
	} catch {
		// not JSON, fall through
	}
	if (responseBody.length > 200) {
		return responseBody.slice(0, 200);
	}
	return responseBody;
}

export async function refreshMCPOAuthToken(opts: RefreshOptions): Promise<OAuthCredentials> {
	const params = new URLSearchParams();
	params.set("grant_type", "refresh_token");
	params.set("refresh_token", opts.refreshToken);
	if (opts.clientId) {
		params.set("client_id", opts.clientId);
	}
	if (opts.clientSecret) {
		params.set("client_secret", opts.clientSecret);
	}
	if (opts.scopes) {
		params.set("scope", opts.scopes);
	}

	const response = await fetch(opts.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	if (!response.ok) {
		const body = await response.text();
		const safeMsg = sanitizeTokenError(body);
		throw new Error(`OAuth token refresh failed (HTTP ${response.status}): ${safeMsg}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};

	return {
		access: data.access_token,
		refresh: data.refresh_token ?? opts.refreshToken,
		expires: Date.now() + (data.expires_in ?? 3600) * 1000,
		scopes: opts.scopes,
	};
}
