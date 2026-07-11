import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { FileType, listWorkspace } from "@oh-my-pi/pi-natives";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import {
	available as embeddingsAvailable,
	currentEmbeddingModel,
	embed,
	embedQuery,
	embeddingDimFor,
	type CodeChunk,
	ZVecCodeStore,
	type ZVecSearchResult,
	zvecChunkOverlap,
	zvecChunkSize,
	zvecCodeIndexPath,
	zvecEnabled,
	zvecTopK,
} from "@oh-my-pi/pi-mnemopi";
import { type } from "arktype";
import * as path from "node:path";
import codeSearchDescription from "../prompts/tools/code-search.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError, throwIfAborted } from "./tool-errors";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";

const codeSearchSchema = type({
	query: type("string").describe("natural language search query"),
	"pattern?": type("string").describe("optional file glob pattern to filter results (e.g. '*.ts')"),
	"topK?": type("number").describe("max results to return (default 20)"),
});

export type CodeSearchParams = typeof codeSearchSchema.infer;

// ─── Language detection ─────────────────────────────────────────────────────

const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, string> = new Map([
	["ts", "typescript"],
	["tsx", "typescript"],
	["js", "javascript"],
	["jsx", "javascript"],
	["mjs", "javascript"],
	["cjs", "javascript"],
	["py", "python"],
	["rs", "rust"],
	["go", "go"],
	["java", "java"],
	["c", "c"],
	["cpp", "cpp"],
	["cc", "cpp"],
	["h", "c"],
	["hpp", "cpp"],
	["hxx", "cpp"],
	["rb", "ruby"],
	["lua", "lua"],
	["sql", "sql"],
	["sh", "shell"],
	["bash", "shell"],
	["zsh", "shell"],
	["fish", "shell"],
	["ps1", "powershell"],
	["yaml", "yaml"],
	["yml", "yaml"],
	["json", "json"],
	["toml", "toml"],
	["xml", "xml"],
	["html", "html"],
	["css", "css"],
	["scss", "scss"],
	["less", "less"],
	["vue", "vue"],
	["svelte", "svelte"],
	["md", "markdown"],
	["mdx", "markdown"],
	["php", "php"],
	["swift", "swift"],
	["kt", "kotlin"],
	["scala", "scala"],
	["clj", "clojure"],
	["ex", "elixir"],
	["exs", "elixir"],
	["erl", "erlang"],
	["hs", "haskell"],
	["ml", "ocaml"],
	["nim", "nim"],
	["zig", "zig"],
	["v", "verilog"],
	["sv", "systemverilog"],
	["dart", "dart"],
	["gradle", "gradle"],
	["dockerfile", "dockerfile"],
	["makefile", "makefile"],
	["r", "r"],
	["jl", "julia"],
]);

const INDEXABLE_EXTENSIONS: ReadonlySet<string> = new Set(EXTENSION_TO_LANGUAGE.keys());

const SKIP_DIRECTORIES = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"target",
	".next",
	"out",
	"coverage",
]);

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const BINARY_CHECK_BYTES = 8192;

function detectLanguage(filePath: string): string {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	if (ext === "") {
		const basename = path.basename(filePath).toLowerCase();
		if (basename === "dockerfile") return "dockerfile";
		if (basename === "makefile") return "makefile";
	}
	return EXTENSION_TO_LANGUAGE.get(ext) ?? "text";
}

function isIndexableFile(filePath: string): boolean {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	if (ext !== "") return INDEXABLE_EXTENSIONS.has(ext);
	const basename = path.basename(filePath).toLowerCase();
	return basename === "dockerfile" || basename === "makefile";
}

// ─── Code chunking ──────────────────────────────────────────────────────────

interface Chunk {
	lineStart: number;
	lineEnd: number;
	content: string;
}

function chunkFile(content: string, chunkSize: number, overlap: number): Chunk[] {
	const lines = content.split("\n");
	if (lines.length === 0) return [];
	const chunks: Chunk[] = [];
	const step = Math.max(1, chunkSize - overlap);
	for (let start = 0; start < lines.length; start += step) {
		const end = Math.min(start + chunkSize - 1, lines.length - 1);
		const chunkLines = lines.slice(start, end + 1);
		chunks.push({
			lineStart: start + 1,
			lineEnd: end + 1,
			content: chunkLines.join("\n"),
		});
		if (end === lines.length - 1) break;
	}
	return chunks;
}

// ─── Binary detection ───────────────────────────────────────────────────────

function isBinaryContent(buffer: Buffer): boolean {
	const checkLen = Math.min(buffer.length, BINARY_CHECK_BYTES);
	for (let i = 0; i < checkLen; i++) {
		if (buffer[i] === 0) return true;
	}
	return false;
}

// ─── Result formatting ───────────────────────────────────────────────────────

function formatSearchResult(
	results: ZVecSearchResult[],
	searchedFileCount: number,
	mode: "hybrid" | "fts",
): string {
	if (results.length === 0) {
		return `No matches found (searched ${searchedFileCount} file${searchedFileCount === 1 ? "" : "s"}, Zvec index, ${mode} mode).`;
	}

	const lines: string[] = [
		`Found ${results.length} match${results.length === 1 ? "" : "es"} (searched ${searchedFileCount} file${searchedFileCount === 1 ? "" : "s"}, Zvec index, ${mode} mode)`,
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
	#searchedFileCount = 0;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): CodeSearchTool | null {
		if (!zvecEnabled()) return null;
		if (!ZVecCodeStore.available()) return null;
		return new CodeSearchTool(session);
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
			return await ZVecCodeStore.open(indexPath);
		} catch {
			return await ZVecCodeStore.create(indexPath, dimension);
		}
	}

	// ─── Workspace scanning ──────────────────────────────────────────────────

	async #collectSourceFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
		const result = await listWorkspace({
			path: cwd,
			maxDepth: 20,
			gitignore: true,
			hidden: false,
			signal,
		});

		const files: string[] = [];
		for (const entry of result.entries) {
			if (entry.fileType !== FileType.File) continue;
			if (!isIndexableFile(entry.path)) continue;
			if (entry.size !== undefined && entry.size > MAX_FILE_SIZE) continue;

			// Check skip directories in the relative path.
			const parts = entry.path.split("/");
			if (parts.some(p => SKIP_DIRECTORIES.has(p))) continue;

			files.push(path.join(cwd, entry.path));
		}
		return files;
	}

	// ─── Indexing ───────────────────────────────────────────────────────────

	async #ensureIndexed(signal?: AbortSignal): Promise<void> {
		const store = await this.#getStore();
		const cwd = this.session.cwd;

		const sourceFiles = await this.#collectSourceFiles(cwd, signal);
		this.#searchedFileCount = sourceFiles.length;

		if (sourceFiles.length === 0) return;

		// Get currently indexed file hashes from the store.
		const storeFileHashes = store.getFileHashes();

		// Build a set of indexed file paths for deletion detection.
		const indexedPaths = new Set(storeFileHashes.keys());

		// Process each file: read, hash, compare, chunk, embed, upsert.
		const chunksToUpsert: CodeChunk[] = [];
		const filesToRemove: string[] = [];
		const currentFiles = new Set<string>();
		const chunkSize = zvecChunkSize();
		const overlap = zvecChunkOverlap();
		const canEmbed = await embeddingsAvailable();

		for (const filePath of sourceFiles) {
			throwIfAborted(signal);
			currentFiles.add(filePath);

			// Read file content.
			const file = Bun.file(filePath);
			const exists = await file.exists();
			if (!exists) continue;

			const stat = await file.stat();
			if (stat.size > MAX_FILE_SIZE) continue;

			const buffer = Buffer.from(await file.arrayBuffer());
			if (isBinaryContent(buffer)) continue;

			const content = buffer.toString("utf-8");
			const fileHash = Bun.hash(content).toString(16);

			// Chunk the file and compute per-chunk hashes for change detection.
			const chunks = chunkFile(content, chunkSize, overlap);
			const newChunkHashes = new Set(chunks.map(c => Bun.hash(c.content).toString(16)));

			// Check if file is already indexed with identical chunk hashes.
			const indexedHashes = storeFileHashes.get(filePath);
			if (indexedHashes !== undefined) {
				if (setsEqual(indexedHashes, newChunkHashes)) continue; // No chunks changed — skip.
				// Some chunks changed — remove old ones before re-indexing.
				store.removeFile(filePath);
			}

			// File is new or changed — embed and collect for upsert.
			const language = detectLanguage(filePath);
			const batchSize = 32;
			for (let i = 0; i < chunks.length; i += batchSize) {
				throwIfAborted(signal);
				const batch = chunks.slice(i, i + batchSize);
				let embeddings: Float32Array[] | null = null;
				if (canEmbed) {
					try {
						embeddings = await embed(batch.map(c => c.content));
					} catch (err) {
						logger.debug("code_search: embedding batch failed", { error: String(err) });
					}
				}

				for (let j = 0; j < batch.length; j++) {
					const chunk = batch[j]!;
					chunksToUpsert.push({
						id: `${fileHash}-${chunk.lineStart}`,
						filePath,
						language,
						lineStart: chunk.lineStart,
						lineEnd: chunk.lineEnd,
						content: chunk.content,
						chunkHash: Bun.hash(chunk.content).toString(16),
						embedding: embeddings?.[j] ? Array.from(embeddings[j]!) : [],
					});
				}
			}
		}

		// Detect deleted files.
		for (const indexedPath of indexedPaths) {
			if (!currentFiles.has(indexedPath)) {
				filesToRemove.push(indexedPath);
			}
		}

		// Remove deleted files from the store.
		for (const filePath of filesToRemove) {
			store.removeFile(filePath);
		}

		// Upsert new/changed chunks.
		if (chunksToUpsert.length > 0) {
			store.upsertChunks(chunksToUpsert);
		}

		// Optimize the index after updates.
		if (chunksToUpsert.length > 0 || filesToRemove.length > 0) {
			store.optimize();
		}
	}

	// ─── Search ─────────────────────────────────────────────────────────────

	async #search(query: string, topK: number, signal?: AbortSignal): Promise<{ results: ZVecSearchResult[]; mode: "hybrid" | "fts" }> {
		await this.#ensureIndexed(signal);

		const store = await this.#getStore();
		if (store.docCount === 0) {
			return { results: [], mode: "fts" };
		}

		const canEmbed = await embeddingsAvailable();
		if (canEmbed) {
			try {
				const queryEmbedding = await embedQuery(query);
				if (queryEmbedding) {
					const vector = Array.from(queryEmbedding);
					const results = store.searchHybrid({ vector, fts: query }, topK);
					return { results, mode: "hybrid" };
				}
			} catch (err) {
				logger.debug("code_search: query embedding failed, falling back to FTS", { error: String(err) });
			}
		} else {
			logger.debug("code_search: embeddings unavailable, using FTS-only mode");
		}

		const results = store.searchFts(query, topK);
		return { results, mode: "fts" };
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

			const { results, mode } = await this.#search(query, topK, signal);

			// Apply optional glob pattern filter.
			let filtered = results;
			if (params.pattern) {
				const globPattern = params.pattern;
				filtered = results.filter(r => matchesGlob(r.filePath, globPattern));
			}

			const text = formatSearchResult(filtered, this.#searchedFileCount, mode);

			return {
				content: [{ type: "text", text }],
				details: {},
			};
		});
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) if (!b.has(item)) return false;
	return true;
}

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
