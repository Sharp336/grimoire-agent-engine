import type { Api, Model } from "../types";
import type { ProviderDefinition } from "./types";

/** OpenCode Zen advertises anonymous access through zero-priced catalog entries. */
export function isOpenCodeZenFreeModel(model: Model<Api>): boolean {
	return model.provider === "opencode-zen" && model.cost.input === 0 && model.cost.output === 0;
}

export const opencodeZenProvider = {
	id: "opencode-zen",
	name: "OpenCode Zen",
	allowsMissingApiKey: isOpenCodeZenFreeModel,
} as const satisfies ProviderDefinition;
