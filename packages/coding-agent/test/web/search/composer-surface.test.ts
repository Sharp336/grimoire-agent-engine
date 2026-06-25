import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	applyComposerWebSearchToolSwap,
	buildComposerWebSearchForceSequence,
	CURSOR_WEB_SEARCH_TOOL_NAME,
	normalizeToolNameForRegistry,
	resolveWebSearchForcedToolName,
} from "@oh-my-pi/pi-coding-agent/web/search/composer-surface";

const composerModel = { id: "grok-composer-2.5-fast", api: "openai-responses" } as Model;
const defaultModel = { id: "grok-4.20-0309-non-reasoning", api: "openai-responses" } as Model;

describe("composer web search surface", () => {
	it("preserves the Cursor wire name when normalizing tool names", () => {
		expect(normalizeToolNameForRegistry("WebSearch")).toBe(CURSOR_WEB_SEARCH_TOOL_NAME);
		expect(normalizeToolNameForRegistry("websearch")).toBe(CURSOR_WEB_SEARCH_TOOL_NAME);
		expect(normalizeToolNameForRegistry("web_search")).toBe("web_search");
	});

	it("swaps web_search to WebSearch on composer models", () => {
		expect(applyComposerWebSearchToolSwap(["read", "web_search", "bash"], composerModel)).toEqual([
			"read",
			"bash",
			CURSOR_WEB_SEARCH_TOOL_NAME,
		]);
	});

	it("restores web_search when leaving composer models", () => {
		expect(applyComposerWebSearchToolSwap(["read", CURSOR_WEB_SEARCH_TOOL_NAME], defaultModel)).toEqual([
			"read",
			"web_search",
		]);
	});

	it("maps forced web_search to WebSearch on composer models", () => {
		expect(resolveWebSearchForcedToolName("web_search", composerModel)).toBe(CURSOR_WEB_SEARCH_TOOL_NAME);
		expect(resolveWebSearchForcedToolName("web_search", defaultModel)).toBe("web_search");
		expect(resolveWebSearchForcedToolName("write", composerModel)).toBe("write");
	});

	it("builds a one-shot WebSearch force sequence for composer search intent", () => {
		expect(
			buildComposerWebSearchForceSequence(composerModel, ["read", CURSOR_WEB_SEARCH_TOOL_NAME], "web search for glm 5.2 review"),
		).toEqual([{ type: "function", name: CURSOR_WEB_SEARCH_TOOL_NAME }, "none"]);
		expect(
			buildComposerWebSearchForceSequence(defaultModel, ["web_search"], "web search for glm 5.2 review"),
		).toBeUndefined();
		expect(
			buildComposerWebSearchForceSequence(composerModel, ["read"], "fix the hero section"),
		).toBeUndefined();
	});
});