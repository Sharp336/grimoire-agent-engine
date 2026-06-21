import { logger } from "@oh-my-pi/pi-utils";

export interface SymbolAnchor {
	name: string;
	kind: "function" | "class" | "method" | "interface" | "type" | "variable" | "const";
	startLine: number;
	endLine: number;
}

export interface LanguageAdapter {
	/** File extensions this adapter handles (e.g. ['.ts', '.tsx', '.js', '.jsx']) */
	extensions: readonly string[];
	/** Extract the symbol at a given line, or null if the line isn't in a symbol. */
	getSymbolAtLine(filePath: string, line: number): SymbolAnchor | null;
	/** Extract all top-level symbols in a file. */
	getSymbols(filePath: string): SymbolAnchor[];
}

// Map LSP SymbolKind numbers to our string kind. See lsp/types.ts SYMBOL_KIND_NAMES.
// SymbolKind values: 1=File, 2=Module, 3=Namespace, 4=Package, 5=Class, 6=Method,
// 7=Property, 8=Field, 9=Constructor, 10=Enum, 11=Interface, 12=Function,
// 13=Variable, 14=Constant, 15=String, 16=Number, 17=Boolean, 18=Array, etc.
function lspKindToAnchorKind(kind: number): SymbolAnchor["kind"] {
	switch (kind) {
		case 5:
			return "class";
		case 6:
			return "method";
		case 9:
			return "method";
		case 11:
			return "interface";
		case 12:
			return "function";
		case 13:
			return "variable";
		case 14:
			return "const";
		case 23:
			return "type"; // Struct
		default:
			return "variable";
	}
}

/**
 * TypeScript language adapter. Uses the oh-my-pi LSP client to extract symbols.
 * The LSP client is accessed via a callback to avoid a static dependency on the
 * LSP module — the caller provides the function that queries the LSP server.
 */
export interface LspDocumentSymbolProvider {
	/** Returns document symbols for a file (LSP textDocument/documentSymbol). */
	getDocumentSymbols(filePath: string): Promise<
		Array<{
			name: string;
			kind: number;
			range: { start: { line: number }; end: { line: number } };
			children?: unknown[];
		}>
	>;
}

export class TsAdapter implements LanguageAdapter {
	readonly extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs"] as const;

	constructor(private readonly symbolProvider: LspDocumentSymbolProvider) {}

	getSymbolAtLine(_filePath: string, _line: number): SymbolAnchor | null {
		// LSP documentSymbol is async — this sync method can't call it directly.
		// Callers needing line-level symbols should use getSymbolsAsync (async)
		// and filter by line range. This method is a stub for the interface contract.
		return null;
	}

	async getSymbolsAsync(filePath: string): Promise<SymbolAnchor[]> {
		try {
			const docSymbols = await this.symbolProvider.getDocumentSymbols(filePath);
			const anchors: SymbolAnchor[] = [];
			for (const sym of docSymbols) {
				anchors.push({
					name: sym.name,
					kind: lspKindToAnchorKind(sym.kind),
					startLine: sym.range.start.line + 1, // LSP is 0-indexed
					endLine: sym.range.end.line + 1,
				});
			}
			return anchors;
		} catch (err) {
			logger.debug("codemap: TsAdapter symbol extraction failed", {
				filePath,
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	getSymbols(_filePath: string): SymbolAnchor[] {
		// Synchronous stub — returns empty. Use getSymbolsAsync for real extraction.
		return [];
	}
}

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs"];

/** Maps file extension to adapter. Returns null when no adapter is available. */
export function getAdapter(filePath: string): LanguageAdapter | null {
	const lastDot = filePath.lastIndexOf(".");
	if (lastDot < 0) return null;
	const ext = filePath.slice(lastDot).toLowerCase();
	if (TS_EXTENSIONS.includes(ext)) return null; // Requires a symbolProvider — use getAdapterWithProvider
	return null;
}

/** Maps file extension to adapter with an LSP provider. */
export function getAdapterWithProvider(filePath: string, provider: LspDocumentSymbolProvider): LanguageAdapter | null {
	const lastDot = filePath.lastIndexOf(".");
	if (lastDot < 0) return null;
	const ext = filePath.slice(lastDot).toLowerCase();
	if (TS_EXTENSIONS.includes(ext)) return new TsAdapter(provider);
	return null;
}
