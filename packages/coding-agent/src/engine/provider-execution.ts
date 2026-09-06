import type { Api, SimpleStreamOptions } from "@oh-my-pi/pi-ai";

type Fetch = NonNullable<SimpleStreamOptions["fetch"]>;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ProviderExecutionIdentity {
	expectedPrincipalId: string;
	profileRef: string;
	profileContentHash: string;
	routeRef: string;
	routeContentHash: string;
	providerAccountRef: string;
	providerAccountContentHash: string;
	providerId: string;
	modelId: string;
}

export interface ProviderExecutionMaterial {
	mode: "owner_local" | "hosted_broker";
	providerRuntimeId: string;
	api: Api;
	baseUrl: string;
	credential: string;
}

export class ProviderExecutionError extends Error {
	readonly retryable = false;

	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ProviderExecutionError";
	}
}

export class ProviderExecutionClient {
	constructor(
		readonly endpoint: string,
		readonly token: string,
		readonly requestFetch: Fetch = globalThis.fetch,
	) {}

	async resolve(identity: ProviderExecutionIdentity, signal?: AbortSignal): Promise<ProviderExecutionMaterial> {
		const requestSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
			: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		let response: Response;
		try {
			response = await this.requestFetch(this.endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					schema: "grimoire.provider_execution.request.v1",
					...identity,
					executionMode: "full_agent",
				}),
				signal: requestSignal,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new ProviderExecutionError(
				"provider_execution_unavailable",
				error instanceof Error ? error.message : "Provider execution material is unavailable",
			);
		}
		if (!response.ok) {
			throw new ProviderExecutionError(
				"provider_execution_unavailable",
				`Provider execution returned HTTP ${response.status}`,
			);
		}
		const value: unknown = await response.json().catch(() => undefined);
		if (!value || typeof value !== "object") {
			throw new ProviderExecutionError(
				"provider_execution_invalid_response",
				"Provider execution returned an invalid response",
			);
		}
		const result = value as Record<string, unknown>;
		if (result.schema !== "grimoire.provider_execution.result.v1") {
			throw new ProviderExecutionError(
				"provider_execution_invalid_response",
				"Provider execution returned an invalid response",
			);
		}
		if (result.allowed !== true || result.status !== "ready") {
			const code = typeText(result.status) || "provider_execution_denied";
			throw new ProviderExecutionError(code, publicProviderExecutionMessage(code));
		}
		for (const [field, expected] of Object.entries(identity)) {
			if (result[field] !== expected) {
				throw new ProviderExecutionError(
					"provider_execution_identity_mismatch",
					"Provider execution response does not match the requested route",
				);
			}
		}
		const mode = result.mode;
		const api = result.api;
		const providerRuntimeId = typeText(result.providerRuntimeId);
		const baseUrl = typeText(result.baseUrl);
		const credential = typeText(result.credential);
		if (
			(mode !== "owner_local" && mode !== "hosted_broker") ||
			(api !== "openai-completions" && api !== "anthropic-messages") ||
			result.executionMode !== "full_agent" ||
			!providerRuntimeId ||
			!validProviderBaseUrl(baseUrl) ||
			!credential ||
			(mode === "hosted_broker" && !credential.startsWith("gri_pbr_"))
		) {
			throw new ProviderExecutionError(
				"provider_execution_invalid_response",
				"Provider execution returned incomplete material",
			);
		}
		return { mode, api, providerRuntimeId, baseUrl, credential };
	}
}

function typeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function publicProviderExecutionMessage(code: string): string {
	switch (code) {
		case "provider_trust_required_for_full_agent":
			return "ProviderAccount must be explicitly trusted before it can run a full Agent session";
		case "principal_changed":
			return "ProviderAccount access changed with the signed-in principal; retry from the refreshed profile catalog";
		case "provider_execution_identity_stale":
		case "provider_execution_identity_unavailable":
		case "provider_execution_identity_mismatch":
			return "ProviderAccount or route changed; retry from the refreshed profile catalog";
		case "provider_credential_binding_mismatch":
		case "provider_credential_unavailable":
			return "ProviderAccount local credential is unavailable; reconnect the account on this device";
		case "provider_broker_token_unavailable":
		case "provider_broker_token_invalid":
			return "ProviderAccount shared broker activation is unavailable; reconnect sharing and retry";
		case "provider_api_not_supported_for_execution":
			return "ProviderAccount API is not supported by the Agent execution transport";
		case "provider_endpoint_invalid_for_execution":
			return "ProviderAccount endpoint must use HTTPS, or HTTP on this device only";
		default:
			return "ProviderAccount execution authorization was denied";
	}
}

function validProviderBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "https:" ||
				(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}
