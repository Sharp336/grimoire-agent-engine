/**
 * ClinePass WorkOS OAuth flow.
 *
 * ClinePass supports two authentication methods:
 *
 * 1. **WorkOS OAuth (automatic)** — the Cline CLI (`cline auth`) stores WorkOS
 *    OAuth credentials at `~/.cline/data/settings/providers.json`. When present,
 *    we reuse them so a Cline subscriber needs no separate API key. The access
 *    token is short-lived (~1h) and refreshed via Cline's server-side endpoint
 *    `POST /api/v1/auth/refresh`.
 * 2. **Static API key (manual)** — long-lived `sk_…` keys from the Cline
 *    dashboard, handled by the API-key login path in `../clinepass`.
 */
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import type { OAuthCredentials } from "./types";

/** Prefix identifying a WorkOS OAuth access token; required when used as Bearer. */
const WORKOS_TOKEN_PREFIX = "workos:";
const CLINE_API_BASE = "https://api.cline.bot/api/v1";
const REFRESH_ENDPOINT = "/auth/refresh";
/** WorkOS access tokens last ~1h; refresh a few minutes early to avoid races. */
const WORKOS_TOKEN_LIFETIME_MS = 55 * 60 * 1000;
const WORKOS_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;

/** True for a `workos:`-prefixed OAuth access token (vs a static `sk_…` key). */
export function isWorkosToken(token: string): boolean {
	return token.startsWith(WORKOS_TOKEN_PREFIX);
}

interface ClineAuthRecord {
	accessToken: string;
	refreshToken: string;
	/** Epoch ms. */
	expiresAt: number;
	accountId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Default Cline CLI credential file. */
function defaultClineAuthPath(home: string): string {
	return path.join(home, ".cline", "data", "settings", "providers.json");
}

/**
 * Read WorkOS OAuth credentials the Cline CLI wrote to its providers.json.
 * The ClinePass provider is keyed `cline` (or legacy `cline-pass`) with
 * `settings.auth = { accessToken, refreshToken, expiresAt, accountId }`.
 * `expiresAt` is epoch ms in the file. Returns undefined when absent/incomplete.
 */
export async function readClineAuthCredentials(
	options: { home?: string; readFile?: (path: string) => string | Promise<string> } = {},
): Promise<ClineAuthRecord | undefined> {
	const home = options.home ?? os.homedir();
	const authPath = defaultClineAuthPath(home);
	const read = options.readFile ?? ((p: string) => Bun.file(p).text());

	let text: string;
	try {
		text = await read(authPath);
	} catch (err) {
		// No credential file (ENOENT) → Cline CLI isn't logged in; fall back to the
		// static API-key paste flow. Other read errors are unexpected and surface.
		if (isEnoent(err)) return undefined;
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// Malformed providers.json — treat as not logged in rather than blocking login.
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.providers)) return undefined;
	const providers = parsed.providers;

	for (const key of ["cline", "cline-pass"]) {
		const provider = isRecord(providers[key]) ? providers[key] : undefined;
		const settings = provider && isRecord(provider.settings) ? provider.settings : undefined;
		const auth = settings && isRecord(settings.auth) ? settings.auth : undefined;
		if (!auth) continue;

		const accessToken = stringField(auth, "accessToken");
		const refreshToken = stringField(auth, "refreshToken");
		if (!accessToken || !refreshToken) continue;

		const rawExpires = auth.expiresAt;
		// A missing/non-numeric `expiresAt` is treated as already expired (0) so
		// loginFromClineCli forces a refresh instead of trusting a stale token.
		const expiresAt = typeof rawExpires === "number" && Number.isFinite(rawExpires) ? rawExpires : 0;

		return { accessToken, refreshToken, expiresAt, accountId: stringField(auth, "accountId") };
	}
	return undefined;
}

/**
 * Refresh a WorkOS access token via Cline's server-side endpoint.
 *
 * `POST /api/v1/auth/refresh` with `{ granttype: "refresh_token", refreshToken }`
 * returns `{ data: { accessToken, refreshToken, expiresAt } }` where the new
 * access token is a BARE JWT — the chat API requires the `workos:` prefix, so
 * we re-add it. `expiresAt` comes back as an ISO string here (epoch ms in the
 * file), so we derive the expiry from the standard token lifetime instead.
 */
export async function refreshWorkosToken(
	credentials: OAuthCredentials,
	options: { fetch?: FetchImpl; apiBase?: string } = {},
): Promise<OAuthCredentials> {
	const fetchImpl = options.fetch ?? fetch;
	const apiBase = options.apiBase ?? CLINE_API_BASE;

	let response: Response;
	try {
		response = await fetchImpl(`${apiBase}${REFRESH_ENDPOINT}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ granttype: "refresh_token", refreshToken: credentials.refresh }),
			signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
		});
	} catch (cause) {
		if (cause instanceof DOMException && cause.name === "TimeoutError") {
			throw new AIError.OAuthError(
				"ClinePass token refresh timed out — check your network or use a static API key.",
				{
					kind: "token-refresh",
					provider: "clinepass",
					cause,
				},
			);
		}
		throw cause;
	}

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new AIError.OAuthError(
			`ClinePass token refresh failed (${response.status})${detail ? `: ${detail}` : ""}` +
				" — run `cline auth` to re-login, or use a static API key.",
			{ kind: "token-refresh", provider: "clinepass", status: response.status },
		);
	}

	const body = (await response.json()) as {
		data?: { accessToken?: string; refreshToken?: string };
		accessToken?: string;
		refreshToken?: string;
	};
	const tokens = body.data ?? body;
	if (!tokens.accessToken || !tokens.refreshToken) {
		throw new AIError.OAuthError("ClinePass token refresh returned an unexpected response shape.", {
			kind: "validation",
			provider: "clinepass",
		});
	}

	const access = isWorkosToken(tokens.accessToken)
		? tokens.accessToken
		: `${WORKOS_TOKEN_PREFIX}${tokens.accessToken}`;
	return {
		access,
		refresh: tokens.refreshToken,
		expires: Date.now() + WORKOS_TOKEN_LIFETIME_MS - WORKOS_REFRESH_MARGIN_MS,
	};
}

/**
 * Resolve ClinePass WorkOS credentials from the Cline CLI, refreshing the
 * access token if it is at/near expiry. Returns undefined when the Cline CLI is
 * not logged in (caller then falls back to the static API-key paste flow).
 */
export async function loginFromClineCli(
	options: {
		fetch?: FetchImpl;
		home?: string;
		now?: number;
		readFile?: (path: string) => string | Promise<string>;
	} = {},
): Promise<OAuthCredentials | undefined> {
	const record = await readClineAuthCredentials({
		home: options.home,
		readFile: options.readFile,
	});
	if (!record) return undefined;

	const now = options.now ?? Date.now();
	const credentials: OAuthCredentials = {
		access: record.accessToken,
		refresh: record.refreshToken,
		expires: record.expiresAt,
		accountId: record.accountId,
	};

	if (record.expiresAt <= now + WORKOS_REFRESH_MARGIN_MS) {
		return refreshWorkosToken(credentials, { fetch: options.fetch });
	}
	return credentials;
}
