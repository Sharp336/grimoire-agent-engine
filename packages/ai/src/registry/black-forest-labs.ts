import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const bflProvider = {
	id: "bfl",
	name: "Black Forest Labs (FLUX)",
	envKeys: "BFL_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginBfl } = await import("./oauth/black-forest-labs");
		return loginBfl(cb);
	},
} as const satisfies ProviderDefinition;
