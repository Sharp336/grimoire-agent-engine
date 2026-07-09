import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://app.electronhub.ai";
const API_BASE_URL = "https://api.electronhub.ai/v1";
const VALIDATION_MODEL = "kimi-k2.6:dev";

export const loginElectronHub = createApiKeyLogin({
	providerLabel: "ElectronHub Coding Plan",
	authUrl: AUTH_URL,
	instructions: "Copy your ek-dev- API key from the ElectronHub dashboard Coding Plan tab",
	promptMessage: "Paste your ElectronHub DevPass API key",
	placeholder: "ek-dev-...",
	validation: {
		kind: "chat-completions",
		provider: "ElectronHub",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const electronHubProvider = {
	id: "electronhub",
	name: "ElectronHub Coding Plan (DevPass)",
	login: (cb: OAuthLoginCallbacks) => loginElectronHub(cb),
} as const satisfies ProviderDefinition;
