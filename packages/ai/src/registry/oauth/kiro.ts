import { isRecord, logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController, OAuthCredentials } from "./types";

const DEFAULT_REGION = "us-east-1";
const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPES = [
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations",
	"codewhisperer:transformations",
	"codewhisperer:taskassist",
];
const LIST_PROFILES_TARGET = "AmazonCodeWhispererService.ListAvailableProfiles";

type RegisteredClient = { clientId: string; clientSecret: string };
type DeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	interval: number;
	expiresIn: number;
};
type TokenResponse = { accessToken: string; refreshToken: string; expiresIn: number };
type RefreshState = RegisteredClient & { refreshToken: string; region: string };

export async function loginKiro(ctrl: OAuthController): Promise<OAuthCredentials> {
	const fetchImpl = ctrl.fetch ?? fetch;
	const region = DEFAULT_REGION;
	const endpoint = `https://oidc.${region}.amazonaws.com`;
	ctrl.onProgress?.("Registering Kiro device login...");
	const client = await registerClient(endpoint, fetchImpl, ctrl.signal);
	const device = await startDeviceAuthorization(endpoint, client, fetchImpl, ctrl.signal);
	ctrl.onAuth?.({
		url: device.verificationUriComplete ?? device.verificationUri,
		instructions: `Enter code: ${device.userCode}`,
	});
	ctrl.onProgress?.("Waiting for Kiro authorization...");
	const token = await pollForToken(endpoint, client, device, fetchImpl, ctrl.signal);
	let profileArn: string | undefined;
	try {
		profileArn = await discoverProfileArn(token.accessToken, region, fetchImpl, ctrl.signal);
	} catch (error) {
		if (ctrl.signal?.aborted) throw new AIError.LoginCancelledError();
		logger.warn("kiro: optional profile discovery failed", { error: String(error) });
	}
	return {
		refresh: JSON.stringify({ ...client, refreshToken: token.refreshToken, region } satisfies RefreshState),
		access: token.accessToken,
		expires: Date.now() + token.expiresIn * 1_000 - 60_000,
		profileArn,
		accountId: profileArn,
	};
}

export async function refreshKiroToken(
	credentials: OAuthCredentials,
	fetchImpl: FetchImpl = fetch,
): Promise<OAuthCredentials> {
	const state = parseRefreshState(credentials.refresh);
	const endpoint = `https://oidc.${state.region}.amazonaws.com`;
	const response = await fetchImpl(`${endpoint}/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			clientId: state.clientId,
			clientSecret: state.clientSecret,
			refreshToken: state.refreshToken,
			grantType: "refresh_token",
		}),
	});
	const payload = await readJson(response, "Kiro token refresh");
	const token = parseToken(payload, "Kiro token refresh");
	return {
		...credentials,
		refresh: JSON.stringify({
			...state,
			refreshToken: token.refreshToken || state.refreshToken,
		} satisfies RefreshState),
		access: token.accessToken,
		expires: Date.now() + token.expiresIn * 1_000 - 60_000,
	};
}

async function registerClient(endpoint: string, fetchImpl: FetchImpl, signal?: AbortSignal): Promise<RegisteredClient> {
	const response = await fetchImpl(`${endpoint}/client/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			clientName: "Oh My Pi",
			clientType: "public",
			scopes: SCOPES,
			grantTypes: [DEVICE_GRANT, "refresh_token"],
			issuerUrl: BUILDER_ID_START_URL,
		}),
		signal,
	});
	const payload = await readJson(response, "Kiro client registration");
	const clientId = stringField(payload, "clientId");
	const clientSecret = stringField(payload, "clientSecret");
	if (!clientId || !clientSecret) {
		throw new AIError.OAuthError("Kiro client registration returned incomplete credentials", {
			kind: "validation",
			provider: "kiro",
		});
	}
	return { clientId, clientSecret };
}

async function startDeviceAuthorization(
	endpoint: string,
	client: RegisteredClient,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<DeviceAuthorization> {
	const response = await fetchImpl(`${endpoint}/device_authorization`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...client, startUrl: BUILDER_ID_START_URL }),
		signal,
	});
	const payload = await readJson(response, "Kiro device authorization");
	const deviceCode = stringField(payload, "deviceCode");
	const userCode = stringField(payload, "userCode");
	const verificationUri = stringField(payload, "verificationUri");
	if (!deviceCode || !userCode || !verificationUri) {
		throw new AIError.OAuthError("Kiro device authorization returned incomplete fields", {
			kind: "validation",
			provider: "kiro",
		});
	}
	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete: stringField(payload, "verificationUriComplete"),
		interval: numberField(payload, "interval") ?? 5,
		expiresIn: numberField(payload, "expiresIn") ?? 600,
	};
}

async function pollForToken(
	endpoint: string,
	client: RegisteredClient,
	device: DeviceAuthorization,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	// A one-off network/TLS flap during token polling must not terminate a login
	// whose device code is still valid — `pollOAuthDeviceCodeFlow` already bounds
	// the loop by the device-code expiry deadline. Treat transient fetch failures
	// as another pending poll attempt, with a consecutive-failure cap so a
	// persistently unreachable endpoint still terminates instead of looping
	// until the deadline.
	const MAX_CONSECUTIVE_FETCH_FAILURES = 5;
	let consecutiveFetchFailures = 0;
	return pollOAuthDeviceCodeFlow<TokenResponse>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expiresIn,
		signal,
		poll: async () => {
			let response: Response;
			try {
				response = await fetchImpl(`${endpoint}/token`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...client, deviceCode: device.deviceCode, grantType: DEVICE_GRANT }),
					signal,
				});
			} catch (error) {
				if (signal?.aborted) throw new AIError.LoginCancelledError();
				// Absorb transient transport failures (connection reset, TLS handshake
				// flap, DNS hiccup) as a pending poll. A provider-side denial arrives as
				// a structured `error` field below, not as a thrown fetch, so this only
				// catches transport-level noise. The deadline plus the cap below keep
				// the loop finite.
				consecutiveFetchFailures += 1;
				if (consecutiveFetchFailures > MAX_CONSECUTIVE_FETCH_FAILURES) {
					return {
						status: "failed",
						message: `Kiro device login failed after ${MAX_CONSECUTIVE_FETCH_FAILURES} consecutive network errors: ${
							error instanceof Error ? error.message : String(error)
						}`,
					};
				}
				return { status: "pending" };
			}
			consecutiveFetchFailures = 0;
			const payload: unknown = await response.json().catch(() => undefined);
			if (!isRecord(payload)) {
				return { status: "failed", message: `Kiro device login failed with HTTP ${response.status}` };
			}
			const error = stringField(payload, "error");
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") return { status: "slow_down" };
			if (error) {
				return {
					status: "failed",
					message: `Kiro device login failed: ${error} (HTTP ${response.status})`,
				};
			}
			if (!response.ok) {
				return { status: "failed", message: `Kiro device login failed with HTTP ${response.status}` };
			}
			return { status: "complete", value: parseToken(payload, "Kiro device login") };
		},
	});
}

async function discoverProfileArn(
	accessToken: string,
	region: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const url = new URL(`https://management.${region}.kiro.dev/`);
	url.searchParams.set("origin", "KIRO_CLI");
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			authorization: `Bearer ${accessToken}`,
			"content-type": "application/x-amz-json-1.0",
			"x-amz-target": LIST_PROFILES_TARGET,
		},
		body: JSON.stringify({ origin: "KIRO_CLI" }),
		signal,
	});
	if (!response.ok) return undefined;
	const payload: unknown = await response.json().catch(() => undefined);
	if (!isRecord(payload) || !Array.isArray(payload.profiles)) return undefined;
	for (const profile of payload.profiles) {
		if (!isRecord(profile)) continue;
		const arn = stringField(profile, "arn");
		if (arn) return arn;
	}
	return undefined;
}

async function readJson(response: Response, operation: string): Promise<Record<string, unknown>> {
	const payload: unknown = await response.json().catch(() => undefined);
	if (!response.ok) {
		const message = isRecord(payload) ? stringField(payload, "message") : undefined;
		throw new AIError.OAuthError(`${operation} failed with HTTP ${response.status}${message ? `: ${message}` : ""}`, {
			kind: "http",
			provider: "kiro",
			status: response.status,
		});
	}
	if (!isRecord(payload)) {
		throw new AIError.OAuthError(`${operation} returned invalid JSON`, { kind: "validation", provider: "kiro" });
	}
	return payload;
}

function parseToken(payload: Record<string, unknown>, operation: string): TokenResponse {
	const accessToken = stringField(payload, "accessToken");
	const refreshToken = stringField(payload, "refreshToken") ?? "";
	const expiresIn = numberField(payload, "expiresIn") ?? 3_600;
	if (!accessToken) {
		throw new AIError.OAuthError(`${operation} returned no access token`, { kind: "validation", provider: "kiro" });
	}
	return { accessToken, refreshToken, expiresIn };
}

function parseRefreshState(value: string): RefreshState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new AIError.OAuthError("Kiro refresh state is invalid", { kind: "validation", provider: "kiro" });
	}
	if (!isRecord(parsed)) {
		throw new AIError.OAuthError("Kiro refresh state is invalid", { kind: "validation", provider: "kiro" });
	}
	const clientId = stringField(parsed, "clientId");
	const clientSecret = stringField(parsed, "clientSecret");
	const refreshToken = stringField(parsed, "refreshToken");
	const region = stringField(parsed, "region") ?? DEFAULT_REGION;
	if (!clientId || !clientSecret || !refreshToken) {
		throw new AIError.OAuthError("Kiro refresh state is incomplete", { kind: "validation", provider: "kiro" });
	}
	return { clientId, clientSecret, refreshToken, region };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
