#!/usr/bin/env bun
/**
 * Quick smoke check: composer model should expose WebSearch (not web_search).
 * Run from repo root:
 *   bun scripts/verify-composer-websearch.ts
 */
import { applyComposerWebSearchToolSwap, CURSOR_WEB_SEARCH_TOOL_NAME } from "../packages/coding-agent/src/web/search/composer-surface.ts";
import { createTools } from "../packages/coding-agent/src/tools/index.ts";
import { Settings } from "../packages/coding-agent/src/config/settings.ts";

const composerModel = { id: "grok-composer-2.5-fast" } as const;
const defaultModel = { id: "grok-4.20-0309-non-reasoning" } as const;

const session = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*" as const,
	settings: Settings.isolated({ "web_search.enabled": true }),
};

const tools = await createTools(session);
const names = tools.map(t => t.name);

if (!names.includes("web_search")) throw new Error("registry missing web_search");
if (!names.includes(CURSOR_WEB_SEARCH_TOOL_NAME)) throw new Error("registry missing WebSearch alias");

const composerActive = applyComposerWebSearchToolSwap(
	["read", "bash", "web_search", "find"],
	composerModel,
);
if (!composerActive.includes(CURSOR_WEB_SEARCH_TOOL_NAME) || composerActive.includes("web_search")) {
	throw new Error(`composer swap failed: ${composerActive.join(", ")}`);
}

const restored = applyComposerWebSearchToolSwap(composerActive, defaultModel);
if (!restored.includes("web_search") || restored.includes(CURSOR_WEB_SEARCH_TOOL_NAME)) {
	throw new Error(`restore swap failed: ${restored.join(", ")}`);
}

console.log("OK: WebSearch alias registered and composer surface swap works");
console.log(`  registry tools: ${names.filter(n => n === "web_search" || n === CURSOR_WEB_SEARCH_TOOL_NAME).join(", ")}`);
console.log(`  composer active: ${composerActive.join(", ")}`);