/**
 * Compiles a system prompt by calling an LLM with the meta-prompt,
 * environment inventory, and guidance library. Caches results on input hash.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type AssistantMessage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { buildInventory, type InventoryInput } from "./inventory.js";
import { collectGuidanceLibrary } from "./library.js";

import metaPromptContent from "./meta-prompt.md" with { type: "text" };

export interface CompileOptions {
	/** Active session model to compile with */
	model: Model;
	/** Session-authenticated API key/token for the active model */
	apiKey: string;
	/** Environment data for inventory building */
	inventory: InventoryInput;
	/** Project context files content */
	contextFiles: string;
	/** Invariant rules that must appear verbatim */
	invariants: string;
	/** Target token budget for the compiled prompt */
	tokenBudget: number;
	/** Skip cache and recompile */
	noCache?: boolean;
}

export interface CompileResult {
	/** The compiled system prompt */
	systemPrompt: string;
	/** Which model compiled it */
	modelId: string;
	/** Compilation duration in milliseconds */
	durationMs: number;
	/** Whether this was served from cache */
	cacheHit: boolean;
}

const CACHE_DIR = path.join(getAgentDir(), "cache", "composer");

export async function compileSystemPrompt(options: CompileOptions): Promise<CompileResult> {
	const { model, apiKey, inventory, contextFiles, invariants, tokenBudget, noCache } = options;

	// Build the inputs
	const inventoryText = buildInventory(inventory);
	logger.debug("composer: inventory built", {
		inventoryLength: inventoryText.length,
		toolCount: inventory.tools.length,
		mcpServerCount: inventory.mcpServerInstructions.length,
		skillCount: inventory.skills.length,
		editMode: inventory.editMode,
	});
	const library = await collectGuidanceLibrary();
	logger.debug("composer: guidance library collected", {
		toolDocsLength: library.toolDocs.length,
		systemPromptTemplateLength: library.systemPromptTemplate.length,
	});
	// Compute cache key from all inputs
	const cacheInput = [
		inventoryText,
		library.toolDocs,
		library.systemPromptTemplate,
		contextFiles,
		invariants,
		String(tokenBudget),
		`${model.provider}/${model.id}`,
	].join("\n---\n");

	const cacheKey = Bun.hash(cacheInput).toString(36);
	const cachePath = path.join(CACHE_DIR, `${cacheKey}.txt`);

	// Check cache
	logger.debug("composer: checking cache", { cachePath, noCache: !!noCache });
	if (!noCache) {
		try {
			const cached = await Bun.file(cachePath).text();
			logger.debug("composer: cache hit", { cacheKey, outputLength: cached.length });
			return {
				systemPrompt: cached,
				modelId: `${model.provider}/${model.id}`,
				durationMs: 0,
				cacheHit: true,
			};
		} catch {
			logger.debug("composer: cache miss", { cacheKey });
		}
	}

	// Build the compilation prompt
	const userMessage = buildCompilationMessage({
		inventoryText,
		toolDocs: library.toolDocs,
		systemPromptTemplate: library.systemPromptTemplate,
		contextFiles,
		invariants,
		tokenBudget,
	});
	logger.debug("composer: compilation message built", {
		messageLength: userMessage.length,
		contextFilesLength: contextFiles.length,
		invariantsLength: invariants.length,
		tokenBudget,
	});

	// Call the LLM
	const start = performance.now();
	logger.debug("composer: compiling system prompt", {
		model: `${model.provider}/${model.id}`,
		cacheKey,
	});

	let response: AssistantMessage;
	try {
		response = await completeSimple(
			model,
			{
				systemPrompt: metaPromptContent,
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
			},
			{ apiKey },
		);
	} catch (err) {
		logger.error("composer: compilation failed", {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			model: `${model.provider}/${model.id}`,
			cacheKey,
		});
		throw err;
	}

	const durationMs = Math.round(performance.now() - start);

	// Extract text from response
	logger.debug("composer: response received", {
		contentBlockCount: response.content.length,
	});
	const systemPrompt = extractText(response);
	if (!systemPrompt) {
		logger.error("composer: response text extraction failed", {
			contentBlockCount: response.content.length,
		});
		throw new Error("composer: compilation produced empty output");
	}

	logger.debug("composer: compiled", {
		durationMs,
		outputLength: systemPrompt.length,
		cacheKey,
	});

	// Cache the result
	logger.debug("composer: writing cache", { cachePath, outputLength: systemPrompt.length });
	try {
		await fs.promises.mkdir(CACHE_DIR, { recursive: true });
		await Bun.write(cachePath, systemPrompt);
		logger.debug("composer: cache written", { cachePath });
	} catch (err) {
		logger.warn("composer: cache write failed", {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
	}

	return {
		systemPrompt,
		modelId: `${model.provider}/${model.id}`,
		durationMs,
		cacheHit: false,
	};
}

function buildCompilationMessage(input: {
	inventoryText: string;
	toolDocs: string;
	systemPromptTemplate: string;
	contextFiles: string;
	invariants: string;
	tokenBudget: number;
}): string {
	const sections = [
		"Compile a system prompt for a coding agent session.\n",
		"## Environment Inventory\n",
		input.inventoryText,
		"\n## Guidance Library — Tool Documentation\n",
		input.toolDocs,
		"\n## Guidance Library — Current System Prompt Template\n",
		"This is the existing system prompt template for reference. Use it as source material, not as a template to fill in.\n",
		input.systemPromptTemplate,
		"\n## Invariants (MUST include verbatim)\n",
		input.invariants,
	];

	if (input.contextFiles) {
		sections.push(
			"\n## Project Context\n",
			"These are project-specific rules and conventions. Include them in the compiled prompt.\n",
			input.contextFiles,
		);
	}

	sections.push(
		`\n## Budget\n\nTarget: approximately ${input.tokenBudget} tokens. This is a guideline, not a hard limit. Prioritize completeness over brevity, but do not pad.`,
	);

	return sections.join("\n");
}

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text) {
			parts.push(block.text);
		}
	}
	return parts.join("\n").trim();
}
