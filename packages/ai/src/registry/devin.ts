import { loginDevin } from "./oauth/devin";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const devinProvider = {
	id: "devin",
	name: "Devin",
	login: async (cb: OAuthLoginCallbacks) => {
		const credentials = await loginDevin(cb);
		return JSON.stringify({ token: credentials.access, apiEndpoint: credentials.apiEndpoint });
	},
	callbackPort: 59653,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
