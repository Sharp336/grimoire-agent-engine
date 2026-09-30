import type { Api, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { CandidateIdentity } from "./contracts";

type Fetch = NonNullable<SimpleStreamOptions["fetch"]>;
const REQUEST_TIMEOUT_MS = 10_000;
const HOSTED_BROKER_API_PATH = "/runtime/provider-broker/v1";

/** Exact admitted Attempt identity; ClientHost resolves credentials only against its retained immutable Start. */
export interface ProviderExecutionIdentity {
	expectedPrincipalId: string;
	agentInstanceRef: string;
	attemptId: string;
	bindingRevision: number;
	installationId: string | null;
	dispatchRef: string;
	dispatchHash: string;
	executionDigest: string;
	originReceiptId: string;
	routeRef: string;
	routeContentHash: string;
	providerAccountRef: string;
	providerAccountContentHash: string;
	credentialGeneration: number;
	providerId: string;
	modelId: string;
}

export interface BillingPoolProposal {
	from: CandidateIdentity;
	from_execution_digest: string;
	to: CandidateIdentity;
	reason: "billing_pool_exhausted" | "billing_pool_observed";
}

export interface LocalOAuthIdentity {
	method: "oauth";
	store: "local_omp";
	agentDir: string;
	accountId: string;
	credentialId: number;
}

export interface ProviderExecutionMaterial {
	mode: "owner_local" | "hosted_broker";
	providerRuntimeId: string;
	api: Api;
	baseUrl: string;
	credential: string;
	executionPin?: string;
	localOAuth?: LocalOAuthIdentity;
}
export type ProviderExecutionDescriptor = Omit<ProviderExecutionMaterial, "credential" | "executionPin">;

export class ProviderExecutionError extends Error {
	readonly retryable = false;

	constructor(
		readonly code: string,
		message: string,
		readonly billing?: BillingPoolProposal,
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

	async describe(identity: ProviderExecutionIdentity, signal?: AbortSignal): Promise<ProviderExecutionDescriptor> {
		const response = await this.requestFetch(this.endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ schema: "grimoire.provider_execution.request.v1", ...identity,
				executionMode: "full_agent", descriptorOnly: true }),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) :
				AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) throw new ProviderExecutionError("provider_execution_unavailable",
			`Provider descriptor returned HTTP ${response.status}`);
		const value: unknown = await response.json().catch(() => undefined);
		if (!value || typeof value !== "object") throw new ProviderExecutionError(
			"provider_execution_invalid_response", "Owner OAuth identity is unavailable");
		const result = value as Record<string, unknown>;
		const claim = result.localOAuth as Record<string, unknown> | undefined;
		if (result.schema !== "grimoire.provider_execution.result.v1" || result.allowed !== true ||
			result.status !== "ready" || result.credential !== undefined ||
			result.executionPin !== undefined || result.secrets_returned !== false ||
			result.provider_credentials_returned !== false ||
			Object.entries(identity).some(([key, expected]) => result[key] !== expected) ||
			(result.mode !== "owner_local" && result.mode !== "hosted_broker") ||
			typeof result.api !== "string" || !typeText(result.baseUrl) || !typeText(result.providerRuntimeId) ||
			(claim !== undefined && (claim.method !== "oauth" || claim.store !== "local_omp" ||
				typeof claim.agentDir !== "string" || !claim.agentDir ||
				typeof claim.accountId !== "string" || !claim.accountId ||
				typeof claim.credentialId !== "number" || !Number.isSafeInteger(claim.credentialId) ||
				claim.credentialId < 1)) ||
			(result.mode === "hosted_broker" && claim !== undefined))
			throw new ProviderExecutionError("provider_execution_invalid_response", "Provider descriptor is invalid");
		return { mode: result.mode, api: result.api as Api, baseUrl: result.baseUrl as string,
			providerRuntimeId: result.providerRuntimeId as string,
			...(claim ? { localOAuth: claim as unknown as LocalOAuthIdentity } : {}) };
	}

	async resolve(
		identity: ProviderExecutionIdentity,
		signal?: AbortSignal,
		executionPin?: string,
	): Promise<ProviderExecutionMaterial> {
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
					...(executionPin ? { executionPin } : {}),
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
			throw new ProviderExecutionError(code, publicProviderExecutionMessage(code),
				code === "billing_pool_changed" ? parseBillingPoolProposal(result.billing) : undefined);
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
		const pin = result.executionPin;
		const localOAuth = result.localOAuth;
		const oauth = localOAuth && typeof localOAuth === "object" && !Array.isArray(localOAuth)
			? localOAuth as Record<string, unknown> : null;
		const ownedOAuth = oauth?.method === "oauth" && oauth.store === "local_omp" &&
			typeof oauth.agentDir === "string" && oauth.agentDir.length > 0 &&
			typeof oauth.accountId === "string" && oauth.accountId.length > 0 &&
			typeof oauth.credentialId === "number" && Number.isSafeInteger(oauth.credentialId) && oauth.credentialId > 0 &&
			mode === "owner_local" && credential.startsWith("clientcred://localomp.");
		if (
			(mode !== "owner_local" && mode !== "hosted_broker") ||
			(api !== "openai-completions" && api !== "anthropic-messages" && api !== "openai-responses") ||
			result.executionMode !== "full_agent" ||
			!providerRuntimeId ||
			!validProviderBaseUrl(baseUrl, mode) ||
			!credential ||
			typeof pin !== "string" ||
			!/^[a-f0-9]{64}$/.test(pin) ||
			(executionPin !== undefined && pin !== executionPin) ||
			(mode === "hosted_broker" && !credential.startsWith("gri_pbr_")) ||
			(localOAuth !== undefined && !ownedOAuth) ||
			(ownedOAuth && (result.secrets_returned !== false || result.provider_credentials_returned !== false))
		) {
			throw new ProviderExecutionError(
				"provider_execution_invalid_response",
				"Provider execution returned incomplete material",
			);
		}
		return {
			mode,
			api,
			providerRuntimeId,
			baseUrl,
			credential,
			...(ownedOAuth ? { localOAuth: {
				method: "oauth" as const, store: "local_omp" as const,
				agentDir: oauth.agentDir, accountId: oauth.accountId, credentialId: oauth.credentialId,
			} } : {}),
			...(typeof pin === "string" ? { executionPin: pin } : {}),
		};
	}

	/** No credential/pin is exposed before the frozen candidate's lease transfer. */
	async checkCandidate(
		identity: ProviderExecutionIdentity,
		candidate: { route_ref: string; account_ref: string; effort: string; service_tier: string },
		signal?: AbortSignal,
	): Promise<{ billing_pool_id: string; billing_pool_basis: "expected" | "observed" }> {
		const response = await this.requestFetch(this.endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ schema: "grimoire.provider_execution.request.v1", ...identity,
				executionMode: "candidate_check", candidate }),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) :
				AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) throw new ProviderExecutionError("provider_execution_unavailable",
			`Provider candidate check returned HTTP ${response.status}`);
		const result: unknown = await response.json().catch(() => undefined);
		if (!result || typeof result !== "object" || (result as Record<string, unknown>).schema !==
			"grimoire.provider_execution.result.v1")
			throw new ProviderExecutionError("provider_execution_invalid_response", "Provider candidate check is invalid");
		const value = result as Record<string, unknown>;
		if (value.allowed !== true || value.status !== "ready" ||
			value.executionMode !== "candidate_check" ||
			value.secrets_returned !== false || value.provider_credentials_returned !== false ||
			value.credential !== undefined || value.executionPin !== undefined ||
			Object.entries(identity).some(([key, expected]) => value[key] !== expected) ||
			(value.candidate !== undefined && JSON.stringify(value.candidate) !== JSON.stringify(candidate)))
			throw new ProviderExecutionError("provider_execution_denied", "Frozen candidate is not currently authorized");
		const billing = value.billing;
		if (!billing || typeof billing !== "object" ||
			typeof Reflect.get(billing, "billing_pool_id") !== "string" ||
			!Reflect.get(billing, "billing_pool_id") ||
			!["expected", "observed"].includes(String(Reflect.get(billing, "billing_pool_basis"))))
			throw new ProviderExecutionError("provider_execution_invalid_response", "Candidate billing pool is unavailable");
		return billing as { billing_pool_id: string; billing_pool_basis: "expected" | "observed" };
	}
}

function typeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function parseBillingPoolProposal(value: unknown): BillingPoolProposal | undefined {
	if (!value || typeof value !== "object") return undefined;
	const proposal = value as Record<string, unknown>;
	const identity = (item: unknown): item is CandidateIdentity => {
		if (!item || typeof item !== "object") return false;
		const fields = item as Record<string, unknown>;
		return ["model_id", "route_ref", "account_ref", "effort", "service_tier", "billing_pool_id"]
			.every(key => typeof fields[key] === "string" && fields[key] !== "") &&
			(fields.billing_pool_basis === "expected" || fields.billing_pool_basis === "observed");
	};
	if (!identity(proposal.from) || !identity(proposal.to) ||
		typeof proposal.from_execution_digest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(proposal.from_execution_digest) ||
		(proposal.reason !== "billing_pool_exhausted" && proposal.reason !== "billing_pool_observed"))
		return undefined;
	return proposal as unknown as BillingPoolProposal;
}

function publicProviderExecutionMessage(code: string): string {
	switch (code) {
		case "provider_trust_required_for_full_agent":
			return "ProviderAccount must be explicitly trusted before it can run a full Agent session";
		case "principal_changed":
			return "ProviderAccount access changed with the signed-in principal; retry from the refreshed route roster";
		case "provider_execution_identity_stale":
		case "provider_execution_identity_unavailable":
		case "provider_execution_identity_mismatch":
			return "ProviderAccount or route changed; retry from the refreshed route roster";
		case "provider_execution_pin_invalid":
			return "Admitted execution authorization expired or changed; start a new Attempt";
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

function validProviderBaseUrl(value: string, mode: ProviderExecutionMaterial["mode"]): boolean {
	try {
		const url = new URL(value);
		const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
		const loopback = ["127.0.0.1", "[::1]", "::1", "localhost"].includes(hostname);
		const privateHostedBroker =
			mode === "hosted_broker" &&
			url.protocol === "http:" &&
			url.pathname === HOSTED_BROKER_API_PATH &&
			isRfc1918Hostname(hostname);
		return (
			(url.protocol === "https:" || (url.protocol === "http:" && (loopback || privateHostedBroker))) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

function isRfc1918Hostname(hostname: string): boolean {
	const octets = hostname.split(".").map(value => Number(value));
	if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
		return false;
	}
	return (
		octets[0] === 10 ||
		(octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31) ||
		(octets[0] === 192 && octets[1] === 168)
	);
}
