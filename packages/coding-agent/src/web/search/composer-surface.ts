import type { Model, ToolChoice } from "@oh-my-pi/pi-ai";
import { buildNamedToolChoice } from "../../utils/tool-choice";
import { containsWebSearchIntent } from "./search-intent";

/** Cursor harness wire name for web search on Composer-family models. */
export const CURSOR_WEB_SEARCH_TOOL_NAME = "WebSearch" as const;

/** Models that should see the Cursor-style `WebSearch` alias instead of `web_search`. */
export const COMPOSER_WEB_SEARCH_MODEL_PREFIX = "grok-composer-" as const;

export function normalizeToolNameForRegistry(name: string): string {
	const trimmed = name.trim();
	if (trimmed === CURSOR_WEB_SEARCH_TOOL_NAME || trimmed.toLowerCase() === "websearch") {
		return CURSOR_WEB_SEARCH_TOOL_NAME;
	}
	return trimmed.toLowerCase();
}

export function isComposerWebSearchModel(model: Pick<Model, "id"> | undefined): boolean {
	return model?.id?.startsWith(COMPOSER_WEB_SEARCH_MODEL_PREFIX) ?? false;
}

export function applyComposerWebSearchToolSwap(
	toolNames: readonly string[],
	model: Pick<Model, "id"> | undefined,
): string[] {
	const normalized = toolNames.map(normalizeToolNameForRegistry);
	const hasBuiltin = normalized.includes("web_search");
	const hasAlias = normalized.includes(CURSOR_WEB_SEARCH_TOOL_NAME);

	if (isComposerWebSearchModel(model)) {
		if (!hasBuiltin && !hasAlias) return normalized;
		const swapped = normalized.filter(name => name !== "web_search" && name !== CURSOR_WEB_SEARCH_TOOL_NAME);
		swapped.push(CURSOR_WEB_SEARCH_TOOL_NAME);
		return swapped;
	}

	if (!hasBuiltin && !hasAlias) return normalized;
	const swapped = normalized.filter(name => name !== CURSOR_WEB_SEARCH_TOOL_NAME);
	if (hasAlias && !swapped.includes("web_search")) {
		swapped.push("web_search");
	}
	return swapped;
}

export function resolveWebSearchForcedToolName(
	toolName: string,
	model: Pick<Model, "id"> | undefined,
): string {
	const normalized = normalizeToolNameForRegistry(toolName);
	if (normalized !== "web_search" && normalized !== CURSOR_WEB_SEARCH_TOOL_NAME) {
		return normalized;
	}
	return isComposerWebSearchModel(model) ? CURSOR_WEB_SEARCH_TOOL_NAME : "web_search";
}

/** One-shot forced tool choice for Composer models when the user asked for web search. */
export function buildComposerWebSearchForceSequence(
	model: Pick<Model, "api" | "id"> | undefined,
	activeToolNames: readonly string[],
	promptText: string,
): ToolChoice[] | undefined {
	if (!containsWebSearchIntent(promptText)) return undefined;
	if (!isComposerWebSearchModel(model)) return undefined;
	if (!activeToolNames.includes(CURSOR_WEB_SEARCH_TOOL_NAME)) return undefined;

	const forced = buildNamedToolChoice(CURSOR_WEB_SEARCH_TOOL_NAME, model as Model);
	if (!forced) return undefined;
	return [forced, "none"];
}