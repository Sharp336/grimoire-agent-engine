/**
 * Perplexity login and token refresh.
 *
 * Login path: HTTP email OTP via
 * `GET /api/auth/csrf` → `POST /api/auth/signin-email` → `POST /api/auth/signin-otp`.
 *
 * No browser or manual cookie paste required.
 * Refresh: Socket.IO `refreshJWT` RPC over authenticated WebSocket connection.
 *
 * Protocol: Engine.IO v4 + Socket.IO v4 over WebSocket (bypasses Cloudflare managed challenge).
 */
import type { OAuthController, OAuthCredentials } from "./types";

const API_VERSION = "2.18";
const APP_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/** Extract expiry from a JWT. Falls back to 1 hour from now. Subtracts 5 min safety margin. */
function getJwtExpiry(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return Date.now() + 3600_000;
		const payload = parts[1] ?? "";
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
		if (decoded?.exp && typeof decoded.exp === "number") {
			return decoded.exp * 1000 - 5 * 60_000;
		}
	} catch {
		// Ignore decode errors
	}
	return Date.now() + 3600_000;
}

/** Build OAuthCredentials from a Perplexity JWT string. */
function jwtToCredentials(jwt: string, email?: string): OAuthCredentials {
	return {
		access: jwt,
		refresh: jwt,
		expires: getJwtExpiry(jwt),
		email,
	};
}

// ---------------------------------------------------------------------------
// Socket.IO email OTP login
// ---------------------------------------------------------------------------

/**
 * Send email OTP and exchange it for a Perplexity JWT via HTTP endpoints.
 */
async function httpEmailLogin(ctrl: OAuthController): Promise<OAuthCredentials> {
	if (!ctrl.onPrompt) {
		throw new Error("Perplexity login requires onPrompt callback");
	}
	const email = await ctrl.onPrompt({
		message: "Enter your Perplexity email address",
		placeholder: "user@example.com",
	});
	const trimmedEmail = email.trim();
	if (!trimmedEmail) throw new Error("Email is required for Perplexity login");
	if (ctrl.signal?.aborted) throw new Error("Login cancelled");

	ctrl.onProgress?.("Fetching Perplexity CSRF token...");
	const csrfResponse = await fetch("https://www.perplexity.ai/api/auth/csrf", {
		headers: {
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		signal: ctrl.signal,
	});

	if (!csrfResponse.ok) {
		throw new Error(`Perplexity CSRF request failed: ${csrfResponse.status}`);
	}

	const csrfData = (await csrfResponse.json()) as { csrfToken?: string };
	if (!csrfData.csrfToken) {
		throw new Error("Perplexity CSRF response missing csrfToken");
	}
	ctrl.onProgress?.("Sending login code to your email...");
	const sendResponse = await fetch("https://www.perplexity.ai/api/auth/signin-email", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		body: JSON.stringify({
			email: trimmedEmail,
			csrfToken: csrfData.csrfToken,
		}),
		signal: ctrl.signal,
	});

	if (!sendResponse.ok) {
		const body = await sendResponse.text();
		throw new Error(`Perplexity send login code failed (${sendResponse.status}): ${body}`);
	}
	const otp = await ctrl.onPrompt({
		message: "Enter the code sent to your email",
		placeholder: "123456",
	});
	const trimmedOtp = otp.trim();
	if (!trimmedOtp) throw new Error("OTP code is required");
	if (ctrl.signal?.aborted) throw new Error("Login cancelled");
	ctrl.onProgress?.("Verifying login code...");
	const verifyResponse = await fetch("https://www.perplexity.ai/api/auth/signin-otp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		body: JSON.stringify({
			email: trimmedEmail,
			otp: trimmedOtp,
			csrfToken: csrfData.csrfToken,
		}),
		signal: ctrl.signal,
	});

	const verifyData = (await verifyResponse.json()) as {
		token?: string;
		status?: string;
		error_code?: string;
		text?: string;
	};

	if (!verifyResponse.ok) {
		const reason = verifyData.text ?? verifyData.error_code ?? verifyData.status ?? "OTP verification failed";
		throw new Error(`Perplexity OTP verification failed: ${reason}`);
	}

	if (!verifyData.token) {
		throw new Error("Perplexity OTP verification response missing token");
	}

	return jwtToCredentials(verifyData.token, trimmedEmail);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Login to Perplexity through the explicit email OTP flow.
 */
export async function loginPerplexity(ctrl: OAuthController): Promise<OAuthCredentials> {
	if (!ctrl.onPrompt) {
		throw new Error("Perplexity login requires onPrompt callback");
	}

	return httpEmailLogin(ctrl);
}
