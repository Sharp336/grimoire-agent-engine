import { createHash, randomBytes, randomUUID } from "node:crypto";

import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController, OAuthCredentials } from "./types";

/** Qoder CLI version advertised in `Cosy-Version` and the token `User-Agent`. */
export const QODER_CLI_VERSION = "1.1.2";
const CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
// QODER_*_BASE are trusted-configuration debug seams that can redirect
// credentialed traffic (login, refresh, userinfo). Process env is trusted — an
// attacker who controls it already has stronger vectors (proxy vars, preload
// flags) — so they are intentionally not allowlisted; never point them at an
// untrusted host.
const WEB_BASE = process.env.QODER_WEB_BASE?.trim() || "https://qoder.com";
/** OpenAPI host: device-token flow, and `/api/v1/userinfo` for the api3 identity chain. */
export const OPENAPI_BASE = process.env.QODER_OPENAPI_BASE?.trim() || "https://openapi.qoder.sh";
const SKEW_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;
/**
 * Qoder Privacy Mode wire value: the official client maps `data_policy_agreed: false`
 * to `Cosy-Data-Policy: disagree` (opt-out). Enforced on every request, non-overridable.
 */
export const QODER_PRIVATE_DATA_POLICY = "disagree";

const b64url = (buffer: Buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseExpires(value: unknown): number {
	if (typeof value === "number") return (value < 1e12 ? value * 1000 : value) - SKEW_MS;
	if (typeof value === "string") {
		const numeric = Number(value);
		const milliseconds = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value);
		if (Number.isFinite(milliseconds)) return milliseconds - SKEW_MS;
	}
	return Date.now() + 30 * 60_000 - SKEW_MS;
}

type QoderTokenBody = {
	token?: unknown;
	device_token?: unknown;
	refresh_token?: unknown;
	expires_at?: unknown;
};

/** Prefer explicit `device_token` when present; retain `token` compatibility. */
function accessFromTokenResponse(body: QoderTokenBody): string | undefined {
	return nonEmptyString(body.device_token) ?? nonEmptyString(body.token);
}

function credentialsFromTokenResponse(body: QoderTokenBody, refreshFallback: string): OAuthCredentials | undefined {
	const access = accessFromTokenResponse(body);
	if (!access) return undefined;
	const refresh = nonEmptyString(body.refresh_token) ?? nonEmptyString(refreshFallback);
	if (!refresh) return undefined;
	return {
		access,
		refresh,
		expires: parseExpires(body.expires_at),
	};
}

async function fetchQoderAccountId(access: string, fetchImpl: FetchImpl, signal?: AbortSignal): Promise<string> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
		response = await fetchImpl(`${OPENAPI_BASE}/api/v1/userinfo`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${access}`,
				Accept: "application/json",
			},
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (cause) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError("Qoder userinfo request failed", {
			kind: "validation",
			provider: "qoder",
			cause,
		});
	}
	if (!response.ok) {
		throw new AIError.OAuthError(`Qoder userinfo failed (${response.status})`, {
			kind: "validation",
			provider: "qoder",
			status: response.status,
		});
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		throw new AIError.OAuthError("Qoder userinfo returned invalid JSON", {
			kind: "validation",
			provider: "qoder",
			cause,
		});
	}
	const accountId =
		body && typeof body === "object" && "id" in body ? nonEmptyString((body as { id?: unknown }).id) : undefined;
	if (!accountId) {
		throw new AIError.OAuthError("Qoder userinfo returned no account id", {
			kind: "validation",
			provider: "qoder",
		});
	}
	return accountId;
}

export async function loginQoder(ctrl: OAuthController): Promise<OAuthCredentials> {
	const fetchImpl: FetchImpl = ctrl.fetch ?? fetch;
	const verifier = b64url(randomBytes(64));
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	const nonce = randomUUID();
	const authUrl =
		`${WEB_BASE}/device/selectAccounts?challenge=${encodeURIComponent(challenge)}` +
		`&challenge_method=S256&nonce=${encodeURIComponent(nonce)}` +
		`&machine_id=${encodeURIComponent(randomUUID())}&client_id=${CLIENT_ID}`;
	ctrl.onAuth?.({ url: authUrl, instructions: "Sign in to Qoder in your browser to authorize omp." });
	ctrl.onProgress?.("Waiting for Qoder browser sign-in…");

	const pollUrl = `${OPENAPI_BASE}/api/v1/deviceToken/poll?${new URLSearchParams({
		nonce,
		verifier,
		challenge_method: "S256",
	})}`;
	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		intervalSeconds: 2,
		expiresInSeconds: 300,
		signal: ctrl.signal,
		poll: async () => {
			let response: Response;
			try {
				const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
				response = await fetchImpl(pollUrl, {
					method: "GET",
					headers: { Accept: "application/json" },
					signal: ctrl.signal ? AbortSignal.any([ctrl.signal, timeoutSignal]) : timeoutSignal,
				});
			} catch {
				if (ctrl.signal?.aborted) throw new AIError.LoginCancelledError();
				// A rejected poll fetch (per-request timeout, network blip) is not a
				// verdict on the device flow — stay pending until the outer 300s
				// deadline or caller cancellation.
				return { status: "pending" } as const;
			}
			// 202 Accepted and 404 Not Found both mean "still pending" for Qoder's
			// device-token poll. Check before `response.ok` — 202 is a 2xx and would
			// otherwise fall through into JSON parsing.
			if (response.status === 202 || response.status === 404) return { status: "pending" } as const;
			if (!response.ok) return { status: "failed", message: `Qoder login failed (${response.status})` } as const;

			let body: QoderTokenBody;
			try {
				body = (await response.json()) as QoderTokenBody;
			} catch (cause) {
				throw new AIError.OAuthError("Qoder login returned invalid JSON", {
					kind: "validation",
					provider: "qoder",
					cause,
				});
			}
			const access = accessFromTokenResponse(body);
			if (!access) return { status: "pending" } as const;
			const refresh = nonEmptyString(body.refresh_token);
			if (!refresh) {
				// Browser login must finish with a refreshable credential. Persisting a
				// token-only result would advertise refreshability the registered hook
				// cannot honor — fail validation instead of looping forever.
				throw new AIError.OAuthError("Qoder login returned no refresh_token", {
					kind: "validation",
					provider: "qoder",
				});
			}
			const accountId = await fetchQoderAccountId(access, fetchImpl, ctrl.signal);
			return {
				status: "complete",
				value: {
					access,
					refresh,
					expires: parseExpires(body.expires_at),
					accountId,
				},
			} as const;
		},
	});
}

export async function refreshQoderToken(refresh: string, fetchOverride?: FetchImpl): Promise<OAuthCredentials> {
	if (!refresh.trim()) {
		throw new AIError.OAuthError("Qoder sign in again: missing refresh_token", {
			kind: "validation",
			provider: "qoder",
		});
	}

	const response = await (fetchOverride ?? fetch)(`${OPENAPI_BASE}/api/v1/deviceToken/refresh`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": `qoder/${QODER_CLI_VERSION}`,
		},
		body: JSON.stringify({ refresh_token: refresh }),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		let detail = "";
		try {
			detail = (await response.text()).trim();
		} catch {
			// Ignore body-read failures; the status code is the diagnostic.
		}
		// The body carries the provider's error code (e.g. invalid_grant), which
		// isDefinitiveOAuthFailure needs to retire a dead credential.
		throw new AIError.OAuthError(`Qoder token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`, {
			kind: "token-refresh",
			provider: "qoder",
			status: response.status,
		});
	}

	let body: QoderTokenBody;
	try {
		body = (await response.json()) as QoderTokenBody;
	} catch (cause) {
		throw new AIError.OAuthError("Qoder token refresh returned invalid JSON", {
			kind: "validation",
			provider: "qoder",
			cause,
		});
	}
	const credentials = credentialsFromTokenResponse(body, refresh);
	if (!credentials) {
		throw new AIError.OAuthError("Qoder token refresh returned no token", { kind: "validation", provider: "qoder" });
	}
	return credentials;
}

export let getQoderCommonHeaders = (): Record<string, string> => {
	const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
	const headers = Object.freeze({
		"Cosy-ClientType": "5",
		"Cosy-Version": QODER_CLI_VERSION,
		"Cosy-MachineOS": `${arch}_${process.platform}`,
		"Cosy-Data-Policy": QODER_PRIVATE_DATA_POLICY,
	});
	getQoderCommonHeaders = () => headers;
	return headers;
};

function isCompleteQoderDataLine(line: string): boolean {
	const payload = line.slice(line.indexOf(":") + 1).trimStart();
	if (payload === "[DONE]") return true;
	try {
		JSON.parse(payload);
		return true;
	} catch {
		return false;
	}
}

export function repairQoderSseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffered = "";
	let eventLines: string[] = [];
	const flushEvent = (controller: TransformStreamDefaultController<Uint8Array>): void => {
		if (eventLines.length === 0) return;
		const repaired: string[] = [];
		let dataLine = -1;
		for (const eventLine of eventLines) {
			if (/^data(?::|$)/.test(eventLine)) {
				dataLine = repaired.push(eventLine) - 1;
			} else if (
				dataLine !== -1 &&
				!/^(?:event|id|retry)(?::|$)/.test(eventLine) &&
				!isCompleteQoderDataLine(repaired[dataLine] ?? "")
			) {
				repaired[dataLine] += eventLine;
			} else {
				repaired.push(eventLine);
			}
		}
		controller.enqueue(encoder.encode(`${repaired.join("\n")}\n\n`));
		eventLines = [];
	};

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffered += decoder.decode(chunk, { stream: true });
				for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
					const line = buffered.slice(0, newline).replace(/\r$/, "");
					buffered = buffered.slice(newline + 1);
					if (line !== "") {
						eventLines.push(line);
						continue;
					}
					flushEvent(controller);
				}
			},
			flush(controller) {
				buffered += decoder.decode();
				if (buffered !== "") eventLines.push(buffered.replace(/\r$/, ""));
				flushEvent(controller);
			},
		}),
	);
}

export function wrapQoderSseFetch(fetchImpl: FetchImpl = fetch): FetchImpl {
	return async (input, init) => {
		const response = await fetchImpl(input, init);
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
			return response;
		}
		return new Response(repairQoderSseBody(response.body), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}
