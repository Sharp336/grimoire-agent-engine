import type { ProviderDefinition } from "./types";

export const hetznerProvider = {
	id: "hetzner",
	name: "Hetzner Inference",
	envKeys: "HETZNER_API_KEY",
} as const satisfies ProviderDefinition;
