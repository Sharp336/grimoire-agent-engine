import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginRequesty = createApiKeyLogin({
	providerLabel: "Requesty",
	authUrl: "https://app.requesty.ai/api-keys",
	instructions: "Create or copy your API key from the Requesty dashboard",
	promptMessage: "Paste your Requesty API key",
	placeholder: "rqsty-sk...",
	validation: {
		kind: "models-endpoint",
		provider: "Requesty",
		modelsUrl: "https://api-v2.requesty.ai/v1/manage/apikey/self",
	},
});

export const requestyProvider = {
	id: "requesty",
	name: "Requesty",
	login: loginRequesty,
} satisfies ProviderDefinition & { readonly id: "requesty" };
