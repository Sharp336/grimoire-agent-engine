import type { ProviderDefinition } from "./types";

export const agnesProvider = {
	id: "agnes",
	name: "Agnes AI",
} as const satisfies ProviderDefinition;
