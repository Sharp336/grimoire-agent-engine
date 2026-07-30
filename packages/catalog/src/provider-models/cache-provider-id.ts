import { DEVIN_DEFAULT_BASE_URL, parseDevinCredential } from "../discovery/devin";
import { parseKiroCredentials, resolveKiroRegion } from "../discovery/kiro";

export interface ModelCacheProviderIdOptions {
	apiKey?: string;
	baseUrl?: string;
	profileArn?: string;
	region?: string;
}

export function getDefaultModelDiscoveryBaseUrl(providerId: string): string | undefined {
	switch (providerId) {
		case "litellm":
			return Bun.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1";
		case "opencode-go":
			return "https://opencode.ai/zen/go/v1";
		case "opencode-zen":
			return "https://opencode.ai/zen/v1";
		case "vllm":
			return "http://127.0.0.1:8000/v1";
		default:
			return undefined;
	}
}

/** Resolve the cache namespace used by a provider's model-manager options without constructing those options. */
export function resolveModelCacheProviderId(providerId: string, options: ModelCacheProviderIdOptions = {}): string {
	switch (providerId) {
		case "cursor":
			return "cursor:max-mode-v2";
		case "devin": {
			// Discovery is account/endpoint-specific: the credential may carry its
			// own `apiEndpoint`, and an explicit `baseUrl` override wins over it.
			// Mirror `fetchDevinModels`' endpoint resolution so switching accounts or
			// regional endpoints cannot reuse another identity's authoritative cache.
			const credential = parseDevinCredential(options.apiKey);
			if (!credential.token) return providerId;
			const endpoint = (
				credential.apiEndpoint && (!options.baseUrl || options.baseUrl === DEVIN_DEFAULT_BASE_URL)
					? credential.apiEndpoint
					: (options.baseUrl ?? DEVIN_DEFAULT_BASE_URL)
			).replace(/\/+$/, "");
			return `devin:models-v1:${Bun.hash(`${credential.token}\u0000${endpoint}`).toString(36)}`;
		}
		case "litellm": {
			const baseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			return `litellm:rich-v5:${Bun.hash(baseUrl).toString(36)}`;
		}
		case "kiro": {
			const credentials = parseKiroCredentials(options.apiKey, options.profileArn);
			if (!credentials) return providerId;
			const region = resolveKiroRegion(options.region, credentials.profileArn);
			const endpoint = (options.baseUrl ?? `https://management.${region}.kiro.dev`).replace(/\/$/, "");
			const identity = credentials.profileArn ?? credentials.accessToken;
			return `kiro:models-v1:${Bun.hash(`${identity}\u0000${endpoint}`).toString(36)}`;
		}
		case "opencode-go":
		case "opencode-zen": {
			const configuredBaseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			const trimmedBaseUrl = configuredBaseUrl.endsWith("/") ? configuredBaseUrl.slice(0, -1) : configuredBaseUrl;
			const discoveryBaseUrl = trimmedBaseUrl.endsWith("/v1") ? trimmedBaseUrl : `${trimmedBaseUrl}/v1`;
			const scope = `${options.apiKey ?? ""}\u0000${discoveryBaseUrl}`;
			return `${providerId}:models-v1:${Bun.hash(scope).toString(36)}`;
		}
		case "openrouter":
			return "openrouter:pseudo-api";
		case "vllm": {
			const baseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			return `vllm:${Bun.hash(baseUrl).toString(36)}`;
		}
		default:
			return providerId;
	}
}
