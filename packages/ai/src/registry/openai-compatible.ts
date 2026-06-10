import type { ProviderDefinition } from "./types";

export const openaiCompatibleProvider = {
	id: "openai-compatible",
	name: "OpenAI-compatible",
	envKeys: "OPENAI_COMPAT_API_KEY",
} as const satisfies ProviderDefinition;
