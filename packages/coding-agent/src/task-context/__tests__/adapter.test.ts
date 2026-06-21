import { describe, expect, it } from "bun:test";
import {
	getAdapter,
	getAdapterWithProvider,
	type LanguageAdapter,
	type LspDocumentSymbolProvider,
	TsAdapter,
} from "../adapter";

function makeProvider(
	symbols: Array<{ name: string; kind: number; startLine: number; endLine: number }> = [],
): LspDocumentSymbolProvider {
	return {
		async getDocumentSymbols() {
			return symbols.map(s => ({
				name: s.name,
				kind: s.kind,
				range: { start: { line: s.startLine }, end: { line: s.endLine } },
			}));
		},
	};
}

describe("codemap getAdapter (no provider)", () => {
	it("returns null for all extensions — requires a provider", () => {
		expect(getAdapter("src/foo.ts")).toBeNull();
		expect(getAdapter("src/foo.tsx")).toBeNull();
		expect(getAdapter("src/foo.js")).toBeNull();
	});

	it("returns null when file has no extension", () => {
		expect(getAdapter("Makefile")).toBeNull();
	});

	it("returns null for non-TS extensions", () => {
		expect(getAdapter("src/foo.py")).toBeNull();
		expect(getAdapter("src/foo.rs")).toBeNull();
		expect(getAdapter("src/foo.go")).toBeNull();
	});
});

describe("codemap getAdapterWithProvider — extension routing", () => {
	it("returns a TsAdapter for TS-family extensions", () => {
		const provider = makeProvider();
		for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs"]) {
			const adapter = getAdapterWithProvider(`src/foo${ext}`, provider);
			expect(adapter).toBeInstanceOf(TsAdapter);
		}
	});

	it("is case-insensitive on extension", () => {
		const provider = makeProvider();
		expect(getAdapterWithProvider("src/FOO.TS", provider)).toBeInstanceOf(TsAdapter);
		expect(getAdapterWithProvider("src/FOO.TSX", provider)).toBeInstanceOf(TsAdapter);
	});

	it("returns null for non-TS extensions even with a provider", () => {
		const provider = makeProvider();
		expect(getAdapterWithProvider("src/foo.py", provider)).toBeNull();
		expect(getAdapterWithProvider("src/foo.rs", provider)).toBeNull();
	});

	it("returns null when file has no extension", () => {
		const provider = makeProvider();
		expect(getAdapterWithProvider("Dockerfile", provider)).toBeNull();
	});

	it("handles dotted filenames (last dot wins)", () => {
		const provider = makeProvider();
		// "foo.bar.ts" → ext is ".ts"
		expect(getAdapterWithProvider("src/foo.bar.ts", provider)).toBeInstanceOf(TsAdapter);
		// "foo.tar.gz" → ext is ".gz", not a TS extension
		expect(getAdapterWithProvider("src/foo.tar.gz", provider)).toBeNull();
	});
});

describe("codemap TsAdapter — extensions field", () => {
	it("exposes the full TS-family extension list", () => {
		const adapter = new TsAdapter(makeProvider());
		expect(adapter.extensions).toEqual([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs"]);
	});
});

describe("codemap TsAdapter — getSymbolsAsync (LSP kind mapping)", () => {
	it("maps LSP SymbolKind numbers to anchor kinds", async () => {
		const provider = makeProvider([
			{ name: "MyClass", kind: 5, startLine: 0, endLine: 10 }, // 5 → class
			{ name: "myMethod", kind: 6, startLine: 1, endLine: 5 }, // 6 → method
			{ name: "ctor", kind: 9, startLine: 2, endLine: 3 }, // 9 → method (constructor)
			{ name: "Iface", kind: 11, startLine: 3, endLine: 4 }, // 11 → interface
			{ name: "myFn", kind: 12, startLine: 4, endLine: 6 }, // 12 → function
			{ name: "myVar", kind: 13, startLine: 5, endLine: 5 }, // 13 → variable
			{ name: "MY_CONST", kind: 14, startLine: 6, endLine: 6 }, // 14 → const
			{ name: "MyStruct", kind: 23, startLine: 7, endLine: 8 }, // 23 → type (Struct)
			{ name: "unknown", kind: 999, startLine: 8, endLine: 8 }, // default → variable
		]);
		const adapter = new TsAdapter(provider);
		const symbols = await adapter.getSymbolsAsync("src/foo.ts");

		expect(symbols.map(s => [s.name, s.kind])).toEqual([
			["MyClass", "class"],
			["myMethod", "method"],
			["ctor", "method"],
			["Iface", "interface"],
			["myFn", "function"],
			["myVar", "variable"],
			["MY_CONST", "const"],
			["MyStruct", "type"],
			["unknown", "variable"],
		]);
	});

	it("converts LSP 0-indexed lines to 1-indexed", async () => {
		const provider = makeProvider([{ name: "fn", kind: 12, startLine: 0, endLine: 4 }]);
		const adapter = new TsAdapter(provider);
		const symbols = await adapter.getSymbolsAsync("src/foo.ts");
		expect(symbols[0].startLine).toBe(1);
		expect(symbols[0].endLine).toBe(5);
	});

	it("returns empty array when provider returns no symbols", async () => {
		const adapter = new TsAdapter(makeProvider([]));
		expect(await adapter.getSymbolsAsync("src/empty.ts")).toEqual([]);
	});

	it("returns empty array when provider throws", async () => {
		const provider: LspDocumentSymbolProvider = {
			async getDocumentSymbols() {
				throw new Error("LSP server crashed");
			},
		};
		const adapter = new TsAdapter(provider);
		expect(await adapter.getSymbolsAsync("src/foo.ts")).toEqual([]);
	});
});

describe("codemap TsAdapter — sync stubs", () => {
	it("getSymbols always returns empty (sync stub)", () => {
		const adapter = new TsAdapter(makeProvider());
		expect(adapter.getSymbols("src/foo.ts")).toEqual([]);
	});

	it("getSymbolAtLine always returns null (sync stub)", () => {
		const adapter = new TsAdapter(makeProvider());
		expect(adapter.getSymbolAtLine("src/foo.ts", 1)).toBeNull();
	});
});

describe("codemap TsAdapter — LanguageAdapter interface conformance", () => {
	it("satisfies the LanguageAdapter interface", () => {
		const adapter: LanguageAdapter = new TsAdapter(makeProvider());
		expect(adapter.extensions.length).toBeGreaterThan(0);
		expect(typeof adapter.getSymbolAtLine).toBe("function");
		expect(typeof adapter.getSymbols).toBe("function");
	});
});
