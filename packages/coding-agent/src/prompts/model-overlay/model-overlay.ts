import { detectModelOverlayFamily, type ModelOverlayFamily } from "./detect";
import { getModelOverlaySection } from "./sections";

export type ModelOverlayMode = "auto" | "off" | "gpt-5" | "claude-opus" | "kimi-k2";

function resolveForcedFamily(mode: ModelOverlayMode): ModelOverlayFamily | undefined {
	if (mode === "gpt-5" || mode === "claude-opus" || mode === "kimi-k2") {
		return mode;
	}

	return undefined;
}

export function resolveModelOverlay(model: string | undefined, mode: ModelOverlayMode): string | undefined {
	if (mode === "off") {
		return undefined;
	}

	const family = resolveForcedFamily(mode) ?? detectModelOverlayFamily(model);
	if (family === undefined) {
		return undefined;
	}

	return getModelOverlaySection(family);
}
