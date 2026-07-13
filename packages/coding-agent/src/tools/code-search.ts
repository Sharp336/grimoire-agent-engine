import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	currentEmbeddingModel,
	embeddingDimFor,
	available as embeddingsAvailable,
	embedQuery,
	ZVecCodeStore,
	type ZVecSearchResult,
	zvecCodeIndexPath,
	zvecTopK,
} from "@oh-my-pi/pi-mnemopi";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import codeSearchDescription from "../prompts/tools/code-search.md" with { type: "text" };
import type { ToolSession } from ".";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";
import { ToolError } from "./tool-errors";

const codeSearchSchema = type({
	query: type("string").describe("natural language search query"),
	"pattern?": type("string").describe("optional file glob pattern to filter results (e.g. '*.ts')"),
	"topK?": type("number").describe("max results to return (default 20)"),
});

export type CodeSearchParams = typeof codeSearchSchema.infer;

// ─── Result formatting ───────────────────────────────────────────────────────

function formatSearchResult(
	results: ZVecSearchResult[],
	indexedChunkCount: number,
	mode: "hybrid" | "fts",
	indexEmpty: boolean,
): string {
	if (results.length === 0) {
		if (indexEmpty) {
			return `No matches found. The code index is empty — run /code-index to index your workspace.`;
		}
		return `No matches found (${indexedChunkCount} indexed chunk${indexedChunkCount === 1 ? "" : "s"}, Zvec index, ${mode} mode).`;
	}

	const lines: string[] = [
		`Found ${results.length} match${results.length === 1 ? "" : "es"} (${indexedChunkCount} indexed chunk${indexedChunkCount === 1 ? "" : "s"}, Zvec index, ${mode} mode)`,
		"",
	];

	for (const result of results) {
		const displayPath = shortenPath(result.filePath);
		const scoreStr = result.score.toFixed(2);
		lines.push(`${displayPath}:${result.lineStart}-${result.lineEnd} [distance: ${scoreStr}]`);

		const contentLines = result.content.split("\n");
		for (const line of contentLines) {
			const sanitized = replaceTabs(line);
			const truncated = truncateToWidth(sanitized, TRUNCATE_LENGTHS.LINE);
			lines.push(`  ${truncated}`);
		}
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

// ─── Tool ────────────────────────────────────────────────────────────────────

export class CodeSearchTool implements AgentTool<typeof codeSearchSchema> {
	readonly name = "code_search";
	readonly approval = "read" as const;
	readonly label = "Code Search";
	readonly description = codeSearchDescription;
	readonly parameters = codeSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Semantic code search using vector embeddings";

	#store: ZVecCodeStore | null = null;
	#storePromise: Promise<ZVecCodeStore> | null = null;

	static createIf(session: ToolSession): CodeSearchTool | null {
		if (!session.settings.get("tools.codeSearchEnabled")) return null;
		if (!ZVecCodeStore.available()) return null;
		return new CodeSearchTool();
	}

	// ─── Store lifecycle ─────────────────────────────────────────────────────

	async #getStore(): Promise<ZVecCodeStore> {
		if (this.#store) return this.#store;
		if (this.#storePromise) return this.#storePromise;

		this.#storePromise = this.#createStore();
		try {
			this.#store = await this.#storePromise;
			return this.#store;
		} finally {
			this.#storePromise = null;
		}
	}

	async #createStore(): Promise<ZVecCodeStore> {
		const indexPath = zvecCodeIndexPath();
		const model = currentEmbeddingModel();
		const dimension = embeddingDimFor(model);

		// Try to open existing index, fall back to create.
		try {
			return ZVecCodeStore.open(indexPath);
		} catch {
			return ZVecCodeStore.create(indexPath, dimension);
		}
	}

	// ─── Search ─────────────────────────────────────────────────────────────

	async #search(
		query: string,
		topK: number,
		_signal?: AbortSignal,
	): Promise<{ results: ZVecSearchResult[]; mode: "hybrid" | "fts"; indexEmpty: boolean }> {
		const store = await this.#getStore();
		if (store.docCount === 0) {
			return { results: [], mode: "fts", indexEmpty: true };
		}

		const canEmbed = await embeddingsAvailable();
		if (canEmbed) {
			try {
				const queryEmbedding = await embedQuery(query);
				if (queryEmbedding) {
					const vector = Array.from(queryEmbedding);
					const results = store.searchHybrid({ vector, fts: query }, topK);
					return { results, mode: "hybrid", indexEmpty: false };
				}
			} catch (err) {
				logger.debug("code_search: query embedding failed, falling back to FTS", { error: String(err) });
			}
		} else {
			logger.debug("code_search: embeddings unavailable, using FTS-only mode");
		}

		const results = store.searchFts(query, topK);
		return { results, mode: "fts", indexEmpty: false };
	}

	// ─── Execute ────────────────────────────────────────────────────────────

	async execute(_id: string, params: CodeSearchParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const query = params.query.trim();
			if (query.length === 0) {
				throw new ToolError("Query is required and must not be empty.");
			}

			const topK = params.topK ?? zvecTopK();
			if (!Number.isInteger(topK) || topK <= 0) {
				throw new ToolError("topK must be a positive integer.");
			}

			// When a pattern filter is provided, overfetch so the filter is reliable.
			const searchTopK = params.pattern ? Math.max(topK * 5, 100) : topK;
			const { results, mode, indexEmpty } = await this.#search(query, searchTopK, signal);

			// Apply optional glob pattern filter.
			let filtered = results;
			if (params.pattern) {
				const globPattern = params.pattern;
				filtered = results.filter(r => matchesGlob(r.filePath, globPattern));
			}

			// Slice to the requested topK after filtering.
			filtered = filtered.slice(0, topK);

			const store = await this.#getStore();
			const text = formatSearchResult(filtered, store.docCount, mode, indexEmpty);

			return {
				content: [{ type: "text", text }],
				details: {},
			};
		});
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function matchesGlob(filePath: string, pattern: string): boolean {
	// Simple glob matching: convert pattern to regex.
	// Supports * (any chars except /), ** (any chars including /), and ? (single char).
	const regex = globToRegex(pattern);
	return regex.test(path.basename(filePath)) || regex.test(filePath);
}

function globToRegex(pattern: string): RegExp {
	let regexStr = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]!;
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				regexStr += ".*";
				i++; // Skip the next *
			} else {
				regexStr += "[^/]*";
			}
		} else if (char === "?") {
			regexStr += "[^/]";
		} else if (".+^$(){}|[]\\".includes(char)) {
			regexStr += `\\${char}`;
		} else {
			regexStr += char;
		}
	}
	return new RegExp(`^${regexStr}$`);
}
