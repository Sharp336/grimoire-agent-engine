import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * Azure OpenAI login flow (API key paste). No validation endpoint is possible:
 * the request base URL is user-configured (AZURE_OPENAI_BASE_URL /
 * AZURE_OPENAI_RESOURCE_NAME + deployment), so the key is stored and validated
 * at request time.
 */
export const loginAzure = createApiKeyLogin({
	providerLabel: "Azure OpenAI",
	authUrl: "https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/AllServices",
	instructions: "Copy your Azure OpenAI API key from the Azure portal resource's Keys and Endpoint page",
	promptMessage: "Paste your Azure OpenAI API key",
	placeholder: "azure-...",
	validation: null,
});

export const azureProvider = {
	id: "azure",
	name: "Azure OpenAI",
	login: (cb: OAuthLoginCallbacks) => loginAzure(cb),
} as const satisfies ProviderDefinition;
