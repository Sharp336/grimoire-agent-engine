/**
 * Command Code browser login.
 *
 * Command Code's studio is not an OAuth authorization server. Instead of
 * redirecting back with `?code=`, it takes a loopback callback URL as a query
 * parameter and **POSTs the minted API key to it as JSON** once the user
 * approves. There is no authorization code and no token endpoint, so
 * `OAuthCallbackFlow` — whose whole contract is a GET redirect carrying a code
 * plus a `code → token` exchange — cannot model this handshake. This module
 * owns the small listener the handshake needs and returns the API key, which
 * `AuthStorage.login` stores as an `api_key` credential.
 */
import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { OAuthLoginCallbacks } from "./types";

const PROVIDER = "command-code";

/** Studio (web app) origins per `COMMANDCODE_API_ENV`, mirroring the Command Code CLI. */
const STUDIO_BASE_URLS: Record<string, string> = {
	local: "http://localhost:3000",
	staging: "https://staging.commandcode.ai",
	prod: "https://commandcode.ai",
};

/** Studio origins allowed to POST the callback, regardless of the selected env. */
const ALLOWED_ORIGINS: Record<string, true> = {
	"http://localhost:3000": true,
	"https://staging.commandcode.ai": true,
	"https://commandcode.ai": true,
};

/**
 * Fixed loopback port matching the Command Code CLI and the provider's
 * `callbackPort`. Auth-broker remote-login SSH-forwards only this registered
 * port, so falling back to 5960+ would advertise an un-forwarded callback.
 */
const CALLBACK_PORT = 5959;
const CALLBACK_PATH = "/callback";
/** 302s to the studio URL so UIs can advertise a truncation-safe copy target. */
const LAUNCH_PATH = "/launch";
const LOGIN_TIMEOUT_MS = 300_000;
/** The studio payload is a handful of short strings; anything larger is junk. */
const MAX_BODY_BYTES = 10_000;

/** Credential envelope the studio POSTs to the loopback callback. */
type CommandCodeCallback = {
	apiKey: string;
	state: string;
	userId: string;
	userName: string;
	keyName: string;
};

function isCallbackPayload(value: unknown): value is CommandCodeCallback {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.apiKey === "string" &&
		record.apiKey.length > 0 &&
		typeof record.state === "string" &&
		typeof record.userId === "string" &&
		typeof record.userName === "string" &&
		typeof record.keyName === "string"
	);
}

/**
 * Map a studio-reported failure envelope (`{ error, error_description }`) onto
 * the login error it represents, or `undefined` when the payload is not one.
 */
function readFailure(value: unknown): Error | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { error?: unknown; error_description?: unknown };
	if (typeof record.error !== "string") return undefined;
	const description = typeof record.error_description === "string" ? record.error_description : undefined;
	if (record.error === "access_denied") {
		return new AIError.LoginCancelledError(description ?? "Command Code authorization was denied");
	}
	return new AIError.OAuthError(description ?? record.error, { kind: "device-auth", provider: PROVIDER });
}

/** Bind the loopback listener on the registered {@link CALLBACK_PORT}. */
function bindCallbackServer(fetch: (req: Request) => Promise<Response> | Response): Bun.Server<unknown> {
	try {
		return Bun.serve({ hostname: "127.0.0.1", port: CALLBACK_PORT, reusePort: false, fetch });
	} catch (cause) {
		throw new AIError.OAuthError(
			`Command Code login callback port ${CALLBACK_PORT} is in use. Free it (or stop the process bound to it) and retry — auth-broker remote-login only forwards this registered port.`,
			{ kind: "configuration", provider: PROVIDER, cause },
		);
	}
}

/**
 * Discriminate the two ways a pending login dies: an aborted caller signal is a
 * user cancellation, while the combined signal firing without it means the
 * five-minute studio deadline elapsed.
 */
function loginFailure(signal: AbortSignal | undefined): Error {
	return signal?.aborted
		? new AIError.LoginCancelledError(`Command Code login cancelled: ${signal.reason}`)
		: new AIError.OAuthError(
				"Command Code login timed out waiting for the studio callback. Re-run the login and complete the browser approval.",
				{ kind: "timeout", provider: PROVIDER },
			);
}

/** Await the studio callback, failing on caller cancellation or the deadline. */
async function awaitCallback(
	delivery: Promise<CommandCodeCallback>,
	signal: AbortSignal | undefined,
): Promise<CommandCodeCallback> {
	const combined = signal
		? AbortSignal.any([signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)])
		: AbortSignal.timeout(LOGIN_TIMEOUT_MS);
	if (combined.aborted) throw loginFailure(signal);

	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => {
		aborted.reject(loginFailure(signal));
	};
	combined.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([delivery, aborted.promise]);
	} finally {
		combined.removeEventListener("abort", onAbort);
	}
}

/** Run the Command Code browser login and return the API key the studio minted. */
export async function loginCommandCode(cb: OAuthLoginCallbacks): Promise<string> {
	const state = crypto.randomUUID();
	const studioBase = STUDIO_BASE_URLS[$env.COMMANDCODE_API_ENV ?? "prod"] ?? STUDIO_BASE_URLS.prod;
	const studioOrigin = new URL(studioBase).origin;
	const delivery = Promise.withResolvers<CommandCodeCallback>();
	/** Studio URL the `/launch` route redirects to; cleared when the flow ends. */
	let authUrl: string | undefined;
	/**
	 * Unguessable gate for `/launch`, independent of the OAuth `state`. The
	 * state is the only thing the callback checks before accepting a key, so a
	 * local process must not be able to GET `/launch` and learn it. The launch
	 * token is minted alongside the state and only ever handed to the caller
	 * that received `launchUrl`.
	 */
	let launchToken: string | undefined;

	const cors = (origin: string | null): Record<string, string> => ({
		"access-control-allow-origin": origin !== null && ALLOWED_ORIGINS[origin] ? origin : studioOrigin,
		"access-control-allow-methods": "POST, OPTIONS",
		"access-control-allow-headers": "content-type",
	});
	const json = (body: unknown, status: number, origin: string | null): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json", ...cors(origin) },
		});

	const handle = async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const origin = req.headers.get("origin");
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
		if (url.pathname === LAUNCH_PATH) {
			// 404 without the minted token: an expired login and a probing request
			// must be indistinguishable, so no local process can learn whether a
			// login is active — let alone read the state-bearing auth URL.
			if (authUrl !== undefined && launchToken !== undefined && url.searchParams.get("token") === launchToken) {
				return Response.redirect(authUrl, 302);
			}
			return new Response("Not found", { status: 404 });
		}
		if (url.pathname !== CALLBACK_PATH) return json({ success: false, error: "Not found" }, 404, origin);
		if (req.method !== "POST") {
			return json({ success: false, error: "Method not allowed. Use POST." }, 405, origin);
		}

		const raw = await req.text();
		if (raw.length > MAX_BODY_BYTES) return json({ success: false, error: "Payload too large" }, 413, origin);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return json({ success: false, error: "Invalid JSON" }, 400, origin);
		}

		// Reject forged deliveries without settling the login: a local process
		// must not be able to swap in its own key, nor cancel a pending login.
		// The state check runs before the failure path too, so a body with only
		// `{ "error": "access_denied" }` cannot abort a login without the token.
		const parsedState =
			typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).state : undefined;
		if (parsedState !== state) return json({ success: false, error: "Invalid state token" }, 403, origin);

		// The studio reports denial/provisioning failures on the same endpoint.
		// Acknowledge and fail the login now rather than waiting out the deadline.
		const failure = readFailure(parsed);
		if (failure) {
			queueMicrotask(() => {
				delivery.reject(failure);
			});
			return json({ success: true }, 200, origin);
		}

		if (!isCallbackPayload(parsed)) {
			return json({ success: false, error: "Missing required fields" }, 400, origin);
		}

		const payload = parsed;
		queueMicrotask(() => {
			delivery.resolve(payload);
		});
		return json({ success: true }, 200, origin);
	};

	const server = bindCallbackServer(handle);
	try {
		const port = server.port;
		if (typeof port !== "number") {
			throw new AIError.OAuthError("Command Code login callback bound to a non-TCP endpoint.", {
				kind: "configuration",
				provider: PROVIDER,
			});
		}
		const callbackUrl = `http://localhost:${port}${CALLBACK_PATH}`;
		authUrl = `${studioBase}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;
		launchToken = crypto.randomUUID();
		cb.onAuth({
			url: authUrl,
			launchUrl: `http://localhost:${port}${LAUNCH_PATH}?token=${encodeURIComponent(launchToken)}`,
			instructions: "Approve the CLI in your browser; Command Code sends the API key straight back to this machine.",
		});
		cb.onProgress?.("Waiting for browser authentication...");
		const payload = await awaitCallback(delivery.promise, cb.signal);
		cb.onProgress?.(`Authenticated as ${payload.userName}`);
		return payload.apiKey;
	} finally {
		authUrl = undefined;
		launchToken = undefined;
		// Graceful stop: the studio still needs the `{ success: true }` ack that
		// was queued alongside the delivery microtask. Await so the next login
		// in-process (tests) does not race a half-closed listener.
		await server.stop();
	}
}
