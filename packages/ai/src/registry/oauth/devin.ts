import * as AIError from "../../error";
import { OAuthCallbackFlow } from "./callback-server";
import { jwtExpiryMs } from "./jwt";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

type FetchFunction = NonNullable<OAuthController["fetch"]>;

const DEVIN_WEBAPP_URL = "https://app.devin.ai";
const DEVIN_API_URL = "https://server.codeium.com";
const CALLBACK_PORT = 59653;
const CALLBACK_PATH = "/callback";
const TOKEN_PATH = "/exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode";
const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

interface DevinPKCEParams {
	verifier: string;
	challenge: string;
}

export interface DevinCliTokenExchange {
	apiKey: string;
	apiServerUrl?: string;
}

export async function loginDevin(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new DevinOAuthFlow(ctrl);
	return flow.login();
}

class DevinOAuthFlow extends OAuthCallbackFlow {
	#pkce?: DevinPKCEParams;

	constructor(ctrl: OAuthController) {
		super(ctrl, {
			preferredPort: CALLBACK_PORT,
			callbackPath: CALLBACK_PATH,
			callbackHostname: "127.0.0.1",
		});
	}

	generateState(): string {
		return crypto.randomUUID();
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		this.#pkce = await generatePKCE();
		const params = new URLSearchParams({
			redirect_uri: redirectUri,
			state,
			prompt: "select_account",
			code_challenge: this.#pkce.challenge,
			code_challenge_method: "S256",
		});

		return {
			url: `${DEVIN_WEBAPP_URL}/auth/cli/continue?${params.toString()}`,
			instructions: "Sign in to Devin in your browser.",
		};
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		if (!this.#pkce) {
			throw new AIError.OAuthError("Devin PKCE verifier was not initialized", {
				kind: "configuration",
				provider: "devin",
			});
		}
		const exchange = await exchangeDevinCliToken(code, this.#pkce.verifier, this.ctrl.fetch);

		return {
			access: exchange.apiKey,
			refresh: exchange.apiKey,
			expires: getTokenExpiry(exchange.apiKey),
			apiEndpoint: exchange.apiServerUrl || DEVIN_API_URL,
			enterpriseUrl: DEVIN_WEBAPP_URL,
		};
	}
}

export async function exchangeDevinCliToken(
	authorizationCode: string,
	codeVerifier: string,
	fetchImpl: FetchFunction = fetch,
): Promise<DevinCliTokenExchange> {
	const response = await fetchImpl(`${DEVIN_API_URL}${TOKEN_PATH}`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"Connect-Protocol-Version": "1",
		},
		body: JSON.stringify({
			authorizationCode,
			codeVerifier,
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new AIError.OAuthError(`Devin CLI token exchange failed: ${response.status} ${error}`.trim(), {
			kind: "token-exchange",
			provider: "devin",
			status: response.status,
		});
	}

	const data = (await response.json()) as { apiKey?: unknown; apiServerUrl?: unknown };
	if (typeof data.apiKey !== "string" || data.apiKey.length === 0) {
		throw new AIError.OAuthError("Devin CLI token exchange returned an empty token", {
			kind: "validation",
			provider: "devin",
		});
	}
	return {
		apiKey: data.apiKey,
		apiServerUrl:
			typeof data.apiServerUrl === "string" && data.apiServerUrl.length > 0 ? data.apiServerUrl : undefined,
	};
}

// A malformed or non-JWT Devin token keeps the conservative long-lived
// fallback rather than forcing an immediate refresh.
function getTokenExpiry(token: string): number {
	return jwtExpiryMs(token) ?? Date.now() + FALLBACK_EXPIRES_MS;
}
