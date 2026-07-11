import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@oh-my-pi/pi-catalog/provider-models";
import { $env, $pickenv } from "@oh-my-pi/pi-utils";
import { PROVIDER_REGISTRY } from "./registry";

type KeyResolver = string | (() => string | undefined);

const LEGACY_ENV_KEYS: Record<string, KeyResolver> = {
	// Non-provider / search-tool keys and API-name keys not modeled as registry provider defs.
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	exa: "EXA_API_KEY",
	jina: "JINA_API_KEY",
	brave: "BRAVE_API_KEY",
	tinyfish: "TINYFISH_API_KEY",
	firecrawl: "FIRECRAWL_API_KEY",
};

/** Env fallbacks derived from the catalog table, registry definitions, and legacy non-provider keys. */
const CATALOG_ENTRY_ENV_KEYS = (CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]).flatMap(provider => {
	const envVars = provider.envVars;
	if (!envVars || envVars.length === 0) return [];
	const resolver: KeyResolver = envVars.length === 1 ? envVars[0] : () => $pickenv(...envVars);
	return [[provider.id, resolver] as [string, KeyResolver]];
});

const serviceProviderMap: Record<string, KeyResolver> = {
	...Object.fromEntries(CATALOG_ENTRY_ENV_KEYS),
	...Object.fromEntries(
		PROVIDER_REGISTRY.flatMap(provider =>
			provider.envKeys != null ? [[provider.id, provider.envKeys] as [string, KeyResolver]] : [],
		),
	),
	...LEGACY_ENV_KEYS,
};

/** Get an API key for a provider from known environment variables. */
export function getEnvApiKey(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	return typeof resolver === "string" ? $env[resolver] : resolver?.();
}

/** Return the single environment variable name backing a provider, when one exists. */
export function getEnvApiKeyName(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	return typeof resolver === "string" ? resolver : undefined;
}

/** Enumerate providers with environment-key fallbacks. */
export function listProvidersWithEnvKey(): string[] {
	return Object.keys(serviceProviderMap);
}
