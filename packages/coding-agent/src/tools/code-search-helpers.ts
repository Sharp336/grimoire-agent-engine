import * as path from "node:path";

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

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "target", ".next", "out", "coverage"]);

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const BINARY_CHECK_BYTES = 8192;

export { BINARY_CHECK_BYTES, EXTENSION_TO_LANGUAGE, INDEXABLE_EXTENSIONS, MAX_FILE_SIZE, SKIP_DIRECTORIES };

export function detectLanguage(filePath: string): string {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	if (ext === "") {
		const basename = path.basename(filePath).toLowerCase();
		if (basename === "dockerfile") return "dockerfile";
		if (basename === "makefile") return "makefile";
	}
	return EXTENSION_TO_LANGUAGE.get(ext) ?? "text";
}

export function isIndexableFile(filePath: string): boolean {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	if (ext !== "") return INDEXABLE_EXTENSIONS.has(ext);
	const basename = path.basename(filePath).toLowerCase();
	return basename === "dockerfile" || basename === "makefile";
}

// ─── Code chunking ──────────────────────────────────────────────────────────

export interface Chunk {
	lineStart: number;
	lineEnd: number;
	content: string;
}

export function chunkFile(content: string, chunkSize: number, overlap: number): Chunk[] {
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

export function isBinaryContent(buffer: Buffer): boolean {
	const checkLen = Math.min(buffer.length, BINARY_CHECK_BYTES);
	for (let i = 0; i < checkLen; i++) {
		if (buffer[i] === 0) return true;
	}
	return false;
}
