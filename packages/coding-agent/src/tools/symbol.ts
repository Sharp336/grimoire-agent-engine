import * as path from "node:path";
import { formatHashlineHeader } from "@oh-my-pi/hashline";
import {
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import {
	FileType,
	type GlobResult,
	glob,
	type GrepResult,
	GrepOutputMode,
	grep,
	hasMatch,
	outlineCode,
	outlineLanguages,
	isOutlineSupportedPath,
	type OutlineResult,
	type SymbolEntry,
} from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { replaceTabs, Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { createEditWritethrough, EditDiagnosticsTracker } from "../edit";
import { getFileSnapshotStore, recordFileSnapshot } from "../edit/file-snapshot-store";
import { computeHashlineDiff } from "../edit/hashline/diff";
import { executeHashlineSingle } from "../edit/hashline/execute";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { SymbolKind } from "../lsp/types";
import { symbolKindToIcon } from "../lsp/utils";
import type { Theme } from "../modes/theme/theme";
import symbolDescription from "../prompts/tools/symbol.md" with { type: "text" };
import { Ellipsis, fileHyperlink, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { createFileRecorder } from "./file-recorder";
import { classifyGroupedLines, formatGroupedFiles, groupLineIndicesByBlank } from "./grouped-file-output";
import type { OutputMeta } from "./output-meta";
import type { ToolScopeResolution } from "./path-utils";
import { formatPathRelativeToCwd, resolveToolSearchScope } from "./path-utils";
import {
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
} from "./render-utils";
import { queueResolveHandler } from "./resolve";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

// =============================================================================
// Schema
// =============================================================================

const symbolSchema = type({
	action: type("'overview' | 'find' | 'manipulate'").describe("symbol operation to perform"),
	"path?": type("string | string[]").describe(
		"file, directory, glob, or internal URL (array allowed); scopes overview/find, single file for manipulate",
	),
	"name?": type("string").describe("symbol name to find or manipulate (required for find/manipulate)"),
	"op?": type("'replace' | 'delete' | 'insert_before' | 'insert_after'").describe("manipulate operation"),
	"text?": type("string").describe(
		"replacement/insert payload for manipulate replace/insert (verbatim; owns its indentation)",
	),
	"kind?": type("string").describe(
		"disambiguator: raw domain kind string the outline emits (e.g. function, method, class, trait, struct)",
	),
	"container?": type("string").describe("disambiguator: enclosing type name (e.g. impl/trait/receiver type)"),
	"line?": type("number").describe("disambiguator: symbol selectionLine"),
	"lang?": type("string").describe("explicit language override forwarded to the tree-sitter extractor"),
	"skip?": type("number").describe("find: symbols to skip before collecting results (pagination)"),
	"limit?": type("number").describe("find: max symbols to return (default 100)"),
});

// =============================================================================
// Kind mapping (domain kind string -> LSP SymbolKind numeric)
// =============================================================================

const KIND_TO_SYMBOLKIND: Record<string, SymbolKind> = {
	module: 2 as SymbolKind,
	namespace: 3 as SymbolKind,
	class: 5 as SymbolKind,
	interface: 11 as SymbolKind,
	trait: 11 as SymbolKind,
	struct: 23 as SymbolKind,
	union: 23 as SymbolKind,
	enum: 10 as SymbolKind,
	enum_member: 22 as SymbolKind,
	function: 12 as SymbolKind,
	macro: 12 as SymbolKind,
	method: 6 as SymbolKind,
	constructor: 9 as SymbolKind,
	property: 7 as SymbolKind,
	field: 8 as SymbolKind,
	constant: 14 as SymbolKind,
	variable: 13 as SymbolKind,
	type_alias: 5 as SymbolKind,
};

const VARIABLE_KIND = 13 as SymbolKind;

function kindIcon(kind: string): string {
	return symbolKindToIcon(KIND_TO_SYMBOLKIND[kind] ?? VARIABLE_KIND);
}

// =============================================================================
// Supported languages (derived from the native outline extractor)
// =============================================================================

/** Default scan glob: a path-level brace-union of every outline-supported
 *  extension AND fixed-name file (Dockerfile, Makefile, CMakeLists.txt,
 *  justfile, ...), derived ONCE from the native `outlineLanguages()` so the
 *  Rust extractor and this scan filter never drift. Computed lazily (never at
 *  module load) so importing the tool does not force the native addon to load.
 *  A capped walk then counts SUPPORTED files rather than unsupported ones that
 *  could hide later source files before the cap. Extensionless dotfiles (shell
 *  rc files, `.emacs`) resolve via `isOutlineSupportedPath` for an explicit
 *  target but are not surfaced by a `hidden:false` directory walk. */
let supportedGlobCache: string | undefined;

function supportedGlob(): string {
	if (supportedGlobCache === undefined) {
		// Path-level union (`**/{*.ts,Dockerfile,...}`): a fixed name must be a
		// whole brace member, NOT inside the extension group — `**/*.{Dockerfile}`
		// would match `foo.Dockerfile`, never a bare `Dockerfile`.
		const patterns = new Set<string>();
		for (const lang of outlineLanguages()) {
			for (const ext of lang.extensions) {
				patterns.add(`*.${ext.toLowerCase()}`);
			}
			for (const name of lang.filenames) {
				patterns.add(name);
			}
		}
		supportedGlobCache = `**/{${[...patterns].sort().join(",")}}`;
	}
	return supportedGlobCache;
}

// =============================================================================
// Path normalization
// =============================================================================

function normalizePaths(p: string | string[] | undefined): string[] {
	if (p === undefined) return ["."];
	return Array.isArray(p) ? p : [p];
}

// =============================================================================
// Scope file enumeration (shared by overview + find)
// =============================================================================

/**
 * Enumerate the absolute supported-extension file paths a read-only symbol
 * action should outline. Handles every scope-resolution branch: a single
 * exact file, exact-file lists, fan-out multi-targets (which may include plain
 * file bases that `glob` cannot walk — those are added directly), and a single
 * directory walk. Every branch funnels through the supported-extension filter
 * and a dedupe at the end, so single-file and file-target paths behave
 * identically to directory walks.
 */
async function listScopeFiles(
	scope: ToolScopeResolution,
	_cwd: string,
	signal: AbortSignal | undefined,
	maxResults: number,
): Promise<{ files: string[]; truncated: boolean }> {
	if (!scope.isDirectory && !scope.multiTargets && !scope.exactFilePaths) {
		return { files: isOutlineSupportedPath(scope.searchPath) ? [scope.searchPath] : [], truncated: false };
	}
	const collected: string[] = [];
	let truncated = false;
	if (scope.exactFilePaths && scope.exactFilePaths.length > 0) {
		for (const abs of scope.exactFilePaths) collected.push(abs);
	}

	if (scope.multiTargets && scope.multiTargets.length > 0) {
		for (const target of scope.multiTargets) {
			// A fan-out target may be a plain file (basePath is the file path),
			// which native `glob` cannot walk (it expects a directory). Stat it
			// and add the file directly; otherwise glob the directory.
			let stat;
			try {
				stat = await Bun.file(target.basePath).stat();
			} catch {
				// Missing target — skip (the scope resolver already reported missing paths).
				continue;
			}
			if (stat.isFile()) {
				collected.push(target.basePath);
				continue;
			}
			const result: GlobResult = await glob({
				pattern: target.glob ?? supportedGlob(),
				path: target.basePath,
				fileType: FileType.File,
				gitignore: true,
				hidden: false,
				maxResults,
				signal,
			});
			if (result.matches.length >= maxResults) truncated = true;
			for (const match of result.matches) {
				collected.push(path.resolve(target.basePath, match.path));
			}
		}
	}

	// Single directory scope (no exact files, no multi-targets).
	if (scope.isDirectory && !scope.exactFilePaths && !scope.multiTargets) {
		const result = await glob({
			pattern: scope.globFilter ?? supportedGlob(),
			path: scope.searchPath,
			fileType: FileType.File,
			gitignore: true,
			hidden: false,
			maxResults,
			signal,
		});
		if (result.matches.length >= maxResults) truncated = true;
		for (const match of result.matches) {
			collected.push(path.resolve(scope.searchPath, match.path));
		}
	}

	// Filter to supported extensions, dedupe — applied last so every branch
	// (single file, file targets, directory walk) behaves consistently. Always
	// passing `maxResults` bounds the walk; `truncated` flags a capped glob so a
	// caller treats the scope as too large rather than silently dropping files.
	return { files: [...new Set(collected.filter(p => isOutlineSupportedPath(p)))], truncated };
}

// =============================================================================
// Regex escape (grep pattern is a regex; matcher is case-insensitive substring)
// =============================================================================

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =============================================================================
// Symbol formatting
// =============================================================================

interface FileOutline {
	relPath: string;
	symbols: SymbolEntry[];
}

interface MatchedSymbol {
	symbol: SymbolEntry;
	relPath: string;
	container: string | undefined;
}

/** Container resolution: prefer the extractor's `container`, else the parent symbol's name. */
function resolveContainer(s: SymbolEntry, fileSymbols: SymbolEntry[]): string | undefined {
	if (s.container) return s.container;
	if (s.parent >= 0) return fileSymbols[s.parent]?.name;
	return undefined;
}

/** Outline source already in memory, tolerating parse failures (returns [] on error). */
function outlineFromCode(code: string, abs: string, lang: string | undefined): SymbolEntry[] {
	try {
		const result: OutlineResult = outlineCode({ code, path: abs, lang });
		return result.symbols;
	} catch {
		return [];
	}
}

/** Outline a single file, tolerating read/parse failures (returns [] on error). */
async function outlineFile(abs: string, lang: string | undefined): Promise<SymbolEntry[]> {
	try {
		return outlineFromCode(await Bun.file(abs).text(), abs, lang);
	} catch {
		return [];
	}
}

function formatOverviewModelLine(s: SymbolEntry): string {
	const indent = "  ".repeat(s.depth);
	const detail = s.detail ? ` ${s.detail}` : "";
	return `${indent}${s.kind} ${s.name}${detail} @ line ${s.selectionLine}`;
}

function formatOverviewDisplayLine(s: SymbolEntry): string {
	const indent = "  ".repeat(s.depth);
	const detail = s.detail ? ` ${s.detail}` : "";
	return `${indent}${kindIcon(s.kind)} ${s.name}${detail} @ line ${s.selectionLine}`;
}

// =============================================================================
// Manipulate helpers (single-op hashline input from an exact symbol range)
// =============================================================================

type ManipulateOp = "replace" | "delete" | "insert_before" | "insert_after";

interface ManipulateSpec {
	name: string;
	kind?: string;
	container?: string;
	line?: number;
}

interface ManipulateMatch {
	symbol: SymbolEntry;
	index: number;
	container: string | undefined;
}

/** Symbols matching the manipulate spec: exact `name` plus any supplied `kind`/`container`/`line` disambiguators. */
function resolveManipulateMatches(symbols: SymbolEntry[], spec: ManipulateSpec): ManipulateMatch[] {
	return symbols
		.map((symbol, index) => ({ symbol, index, container: resolveContainer(symbol, symbols) }))
		.filter(
			({ symbol, container }) =>
				symbol.name === spec.name &&
				(spec.kind === undefined || symbol.kind === spec.kind) &&
				(spec.container === undefined || container === spec.container) &&
				(spec.line === undefined || symbol.selectionLine === spec.line),
		);
}

/** Hashline body rows: each line prefixed with `+`, which also escapes literal
 *  `+`/`-` lines. A single trailing newline is dropped so a payload ending with
 *  `\n` does not emit a stray blank `+` row. */
function manipulateBodyRows(text: string): string[] {
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.split("\n").map(line => `+${line}`);
}

/** Build a one-op hashline `input` from an exact `[start, end]` symbol range. */
function buildManipulateInput(
	relPath: string,
	tag: string,
	op: ManipulateOp,
	startLine: number,
	endLine: number,
	text: string,
): string {
	const header = formatHashlineHeader(relPath, tag);
	switch (op) {
		case "replace":
			return [header, `SWAP ${startLine}.=${endLine}:`, ...manipulateBodyRows(text)].join("\n");
		case "delete":
			return [header, `DEL ${startLine}.=${endLine}`].join("\n");
		case "insert_before":
			return [header, `INS.PRE ${startLine}:`, ...manipulateBodyRows(text)].join("\n");
		case "insert_after":
			return [header, `INS.POST ${endLine}:`, ...manipulateBodyRows(text)].join("\n");
	}
}

/** True when a whole-line `SWAP`/`DEL` of `symbols[targetIdx]` would clobber
 *  another declaration's text on the target's lines. Descendants are part of
 *  the target (replaced with it) → safe. An ancestor is safe only if it
 *  surrounds the target on *different* lines; if it opens or closes on the
 *  target's first/last line (a one-liner like `class C { m() {} }`), its
 *  delimiters share that line. A non-nested sibling on the same line (e.g.
 *  `const a = 1, b = 2`, Go `var a, b int`) always collides. `manipulate` is
 *  line-based, so it refuses every case it cannot edit in isolation. */
function wholeLineEditUnsafe(symbols: SymbolEntry[], targetIdx: number): boolean {
	const target = symbols[targetIdx];
	const isAncestorOf = (ancestorIdx: number, descendantIdx: number): boolean => {
		let cursor = symbols[descendantIdx].parent;
		while (cursor >= 0) {
			if (cursor === ancestorIdx) return true;
			cursor = symbols[cursor].parent;
		}
		return false;
	};
	for (let i = 0; i < symbols.length; i++) {
		if (i === targetIdx) continue;
		const other = symbols[i];
		const intersects = other.startLine <= target.endLine && other.endLine >= target.startLine;
		if (!intersects) continue;
		// A descendant is replaced as part of the target — safe.
		if (isAncestorOf(targetIdx, i)) continue;
		// An ancestor is safe only when its delimiters sit on lines outside the
		// target; sharing the target's first or last line means a whole-line edit
		// would clobber the ancestor's opening/closing text on that line.
		if (isAncestorOf(i, targetIdx)) {
			if (other.startLine === target.startLine || other.endLine === target.endLine) return true;
			continue;
		}
		// A sibling/cousin sharing any of the target's lines collides.
		return true;
	}
	return false;
}

// =============================================================================
// Details
// =============================================================================

export interface SymbolToolDetails {
	action: string;
	scopePath: string;
	symbolCount: number;
	fileCount: number;
	displayContent?: string;
	cwd: string;
	meta?: OutputMeta;
}

// =============================================================================
// Tool
// =============================================================================

const OVERVIEW_FILE_CAP = 50;
const FIND_PARSE_CAP = 200;

export class SymbolTool implements AgentTool<typeof symbolSchema, SymbolToolDetails> {
	readonly name = "symbol";
	readonly label = "Symbol";
	readonly summary = "Outline, find, and edit code symbols by name (tree-sitter, no language server)";
	readonly description: string;
	readonly parameters = symbolSchema;
	readonly strict = true;
	readonly deferrable = true;
	readonly loadMode = "discoverable" as const;

	readonly approval = (args: unknown): "read" | "write" => {
		// `manipulate` always mutates a file (an internal-URL target is written
		// through its backing path too), so it always needs write approval and is
		// never downgraded to read. `overview`/`find` are read-only.
		const params = args as Partial<typeof symbolSchema.infer>;
		return params.action === "manipulate" ? "write" : "read";
	};

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<typeof symbolSchema.infer>;
		const lines: string[] = [];
		if (params.action === "manipulate") {
			if (params.op) lines.push(`Op: ${params.op}`);
			if (params.name) lines.push(`Symbol: ${truncateForPrompt(params.name)}`);
			const paths = normalizePaths(params.path);
			if (paths.length > 0) lines.push(`Path: ${truncateForPrompt(paths.join(", "))}`);
		} else {
			lines.push(`Action: ${params.action ?? "?"}`);
			const paths = normalizePaths(params.path);
			if (paths.length > 0 && !(paths.length === 1 && paths[0] === ".")) {
				lines.push(`Scope: ${truncateForPrompt(paths.join(", "))}`);
			}
			if (params.name) lines.push(`Name: ${truncateForPrompt(params.name)}`);
		}
		return lines;
	};

	readonly examples: readonly ToolExample<typeof symbolSchema.inferIn>[] = [
		{
			caption: "Outline a file's symbols",
			call: { action: "overview", path: "src/tools/symbol.ts" },
		},
		{
			caption: "Find a symbol by name across a directory",
			call: { action: "find", name: "SymbolTool", path: "src/tools" },
		},
		{
			caption: "Replace a named symbol's body",
			call: {
				action: "manipulate",
				path: "src/utils/greet.ts",
				name: "greet",
				op: "replace",
				text: "function greet(name: string) {\n  return `Hello, ${name}`\n}",
			},
		},
	];

	readonly #diagnostics: EditDiagnosticsTracker;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(symbolDescription);
		this.#diagnostics = new EditDiagnosticsTracker(session);
	}

	async execute(
		_toolCallId: string,
		params: typeof symbolSchema.infer,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SymbolToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SymbolToolDetails>> {
		return untilAborted(signal, async () => {
			const cwd = this.session.cwd;
			const rawPaths = normalizePaths(params.path);

			const scope = await resolveToolSearchScope({
				rawPaths,
				cwd,
				internalUrlAction: params.action === "manipulate" ? "rewrite" : "read",
				trackImmutableSources: params.action === "manipulate",
				surfaceExactFilePaths: true,
				fanOutFileTargets: true,
				settings: this.session.settings,
				signal,
				localProtocolOptions: this.session.localProtocolOptions,
			});

			switch (params.action) {
				case "overview":
					return this.runOverview(scope, params, cwd, signal);
				case "find":
					return this.runFind(scope, params, cwd, signal);
				case "manipulate":
					return this.runManipulate(scope, params, cwd);
			}
		});
	}

	private async runOverview(
		scope: ToolScopeResolution,
		params: typeof symbolSchema.infer,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<SymbolToolDetails>> {
		// cap+1 so a too-large scope is detected without walking the whole tree.
		const { files, truncated } = await listScopeFiles(scope, cwd, signal, OVERVIEW_FILE_CAP + 1);
		if (truncated || files.length > OVERVIEW_FILE_CAP) {
			throw new ToolError("symbol overview scope too large (>50 files); narrow the path or glob");
		}
		if (files.length === 0) {
			return toolResult<SymbolToolDetails>({
				action: "overview",
				scopePath: scope.scopePath,
				symbolCount: 0,
				fileCount: 0,
				cwd,
			})
				.text("No files in scope.")
				.done();
		}

		const { record: recordFile, list: fileList } = createFileRecorder();
		const outlineByRel = new Map<string, SymbolEntry[]>();
		const outlines: FileOutline[] = [];
		let totalSymbols = 0;
		for (const abs of files) {
			const relPath = formatPathRelativeToCwd(abs, cwd);
			recordFile(relPath);
			const symbols = await outlineFile(abs, params.lang);
			outlineByRel.set(relPath, symbols);
			outlines.push({ relPath, symbols });
			totalSymbols += symbols.length;
		}

		const buildBody = (relPath: string, symbols: SymbolEntry[]): { model: string[]; display: string[] } => {
			if (symbols.length === 0) {
				const line = `${relPath} — no symbols (unsupported language or parse error)`;
				return { model: [line], display: [line] };
			}
			const model = [`${relPath} — ${symbols.length} symbol(s)`];
			const display = [`${relPath} — ${symbols.length} symbol(s)`];
			for (const s of symbols) {
				model.push(formatOverviewModelLine(s));
				display.push(formatOverviewDisplayLine(s));
			}
			return { model, display };
		};

		const modelLines: string[] = [];
		const displayLines: string[] = [];

		if (scope.isDirectory) {
			const grouped = formatGroupedFiles(fileList, relPath => {
				const symbols = outlineByRel.get(relPath) ?? [];
				const body = buildBody(relPath, symbols);
				return {
					modelLines: body.model,
					displayLines: body.display,
					skip: false,
				};
			});
			modelLines.push(...grouped.model);
			displayLines.push(...grouped.display);
		} else {
			for (const { relPath, symbols } of outlines) {
				if (modelLines.length > 0) {
					modelLines.push("");
					displayLines.push("");
				}
				const body = buildBody(relPath, symbols);
				modelLines.push(...body.model);
				displayLines.push(...body.display);
			}
		}

		const details: SymbolToolDetails = {
			action: "overview",
			scopePath: scope.scopePath,
			symbolCount: totalSymbols,
			fileCount: outlines.length,
			displayContent: displayLines.join("\n"),
			cwd,
		};
		return toolResult(details).text(modelLines.join("\n")).done();
	}

	private async runFind(
		scope: ToolScopeResolution,
		params: typeof symbolSchema.infer,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<SymbolToolDetails>> {
		if (!params.name || params.name.length === 0) {
			throw new ToolError("`name` is required for find");
		}
		const name = params.name;
		const needle = name.toLowerCase();
		const pattern = escapeRegExp(name);
		// Scan a file's content for the identifier (cheap regex, no parse, no grep
		// size cap) — prefilters explicit files and small scopes.
		const fileMatchesName = async (abs: string): Promise<boolean> => {
			try {
				return hasMatch(await Bun.file(abs).text(), pattern, true);
			} catch {
				return false;
			}
		};

		// Enumerate the supported files in the resolved scope (cheap path listing,
		// no reads). For a scope within the parse cap, prefilter by name with
		// `hasMatch`: no parse, and unlike native grep it reads files of any size,
		// so `find` never misses a symbol `overview` would show. Fall back to the
		// native grep prefilter only for genuinely large scopes (faster, but skips
		// files over grep's size cap — acceptable once the scope is already too big
		// to read in full).
		const scopeList = await listScopeFiles(scope, cwd, signal, FIND_PARSE_CAP + 1);
		const scopeFiles = scopeList.files;
		const contentCache = new Map<string, string>();
		let candidates: string[];
		if (!scopeList.truncated && scopeFiles.length <= FIND_PARSE_CAP) {
			// Small scope: read each file once, prefilter by name with `hasMatch`
			// (no parse, any size — no grep size cap), and cache matched content so
			// the outline pass below does not read matched files a second time.
			const flags = await Promise.all(
				scopeFiles.map(async abs => {
					try {
						const content = await Bun.file(abs).text();
						if (hasMatch(content, pattern, true)) {
							contentCache.set(abs, content);
							return true;
						}
					} catch {
						// Unreadable file — skip.
					}
					return false;
				}),
			);
			candidates = scopeFiles.filter((_, index) => flags[index]);
		} else {
			// Large or truncated scope: native grep prefilter (faster, but skips
			// files over grep's size cap — acceptable once the scope is too big to
			// read in full). Collect per resolved target so multi-target / exact-file
			// scopes are not over-broadened.
			const candidateSet = new Set<string>();
			const grepDir = async (base: string, glob: string): Promise<void> => {
				const result: GrepResult = await grep({
					pattern,
					path: base,
					glob,
					ignoreCase: true,
					mode: GrepOutputMode.FilesWithMatches,
					gitignore: true,
					hidden: false,
					signal,
				});
				for (const match of result.matches) {
					const abs = path.resolve(cwd, base, match.path);
					if (isOutlineSupportedPath(abs)) candidateSet.add(abs);
				}
			};
			if (scope.exactFilePaths) {
				for (const file of scope.exactFilePaths) {
					const abs = path.resolve(cwd, file);
					if (isOutlineSupportedPath(abs) && (await fileMatchesName(abs))) candidateSet.add(abs);
				}
			}
			if (scope.multiTargets) {
				for (const target of scope.multiTargets) {
					let stat;
					try {
						stat = await Bun.file(target.basePath).stat();
					} catch {
						continue;
					}
					if (stat.isFile()) {
						const abs = path.resolve(cwd, target.basePath);
						if (isOutlineSupportedPath(abs) && (await fileMatchesName(abs))) candidateSet.add(abs);
					} else {
						await grepDir(target.basePath, target.glob ?? supportedGlob());
					}
				}
			}
			if (!scope.exactFilePaths && !scope.multiTargets) {
				await grepDir(scope.searchPath, scope.globFilter ?? supportedGlob());
			}
			candidates = [...candidateSet];
			if (candidates.length > FIND_PARSE_CAP) {
				throw new ToolError(
					`too many candidate files for symbol find (${candidates.length}); narrow the path/glob or use a more specific name`,
				);
			}
		}

		// Outline each candidate and keep matching symbols. Prefer exact name
		// matches; fall back to case-insensitive substring only when nothing
		// matches the name exactly, so an exact hit is never buried under noise.
		const exact: MatchedSymbol[] = [];
		const substring: MatchedSymbol[] = [];
		for (const abs of candidates) {
			const cached = contentCache.get(abs);
			const symbols = cached !== undefined ? outlineFromCode(cached, abs, params.lang) : await outlineFile(abs, params.lang);
			const relPath = formatPathRelativeToCwd(abs, cwd);
			for (const s of symbols) {
				if (s.name === name) {
					exact.push({ symbol: s, relPath, container: resolveContainer(s, symbols) });
				} else if (s.name.toLowerCase().includes(needle)) {
					substring.push({ symbol: s, relPath, container: resolveContainer(s, symbols) });
				}
			}
		}
		const matched = exact.length > 0 ? exact : substring;

		if (matched.length === 0) {
			return toolResult<SymbolToolDetails>({
				action: "find",
				scopePath: scope.scopePath,
				symbolCount: 0,
				fileCount: 0,
				cwd,
			})
				.text("No symbols found.")
				.done();
		}

		const skip = Math.max(0, Math.floor(params.skip ?? 0));
		const limit = Math.max(1, Math.floor(params.limit ?? 100));
		const visible = matched.slice(skip, skip + limit);
		const remaining = matched.length - (skip + limit);

		const modelLines: string[] = [`Found ${matched.length} symbol(s) matching "${name}":`];
		const displayLines: string[] = [`Found ${matched.length} symbol(s) matching "${name}":`];
		for (const { symbol: s, relPath, container } of visible) {
			const containerSuffix = container ? ` (${container})` : "";
			modelLines.push(`${s.kind} ${s.name}${containerSuffix} @ ${relPath}:${s.selectionLine}`);
			displayLines.push(`${kindIcon(s.kind)} ${s.name}${containerSuffix} @ ${relPath}:${s.selectionLine}`);
		}
		if (remaining > 0) {
			const more = `… ${remaining} more; pass skip=${skip + limit}`;
			modelLines.push(more);
			displayLines.push(more);
		}

		const details: SymbolToolDetails = {
			action: "find",
			scopePath: scope.scopePath,
			symbolCount: matched.length,
			fileCount: new Set(matched.map(m => m.relPath)).size,
			displayContent: displayLines.join("\n"),
			cwd,
		};
		return toolResult(details).text(modelLines.join("\n")).done();
	}

	private async runManipulate(
		scope: ToolScopeResolution,
		params: typeof symbolSchema.infer,
		cwd: string,
	): Promise<AgentToolResult<SymbolToolDetails>> {
		const { name, op } = params;
		if (!name) throw new ToolError("`name` is required for manipulate");
		if (!op) throw new ToolError("`op` is required for manipulate");
		if (op !== "delete" && (params.text === undefined || params.text.length === 0)) {
			throw new ToolError(`\`text\` is required for op '${op}'`);
		}
		if (op === "delete" && params.text !== undefined && params.text.length > 0) {
			throw new ToolError("`text` is not allowed for op 'delete' (it is ignored — omit it)");
		}
		if (scope.isDirectory || scope.multiTargets || (scope.exactFilePaths?.length ?? 0) > 1) {
			throw new ToolError("manipulate requires a single target file in `path`");
		}
		const abs = scope.searchPath;
		const relPath = formatPathRelativeToCwd(abs, cwd);
		if (!isOutlineSupportedPath(abs)) {
			throw new ToolError(`symbol manipulate does not support ${relPath} (unsupported language)`);
		}
		if (/[\r\n]/.test(relPath)) {
			throw new ToolError(`Cannot edit a path containing newline characters: ${JSON.stringify(relPath)}`);
		}
		if (scope.immutableSourcePaths.has(abs)) {
			throw new ToolError(`${relPath} resolves to a read-only resource and cannot be edited`);
		}
		const text = params.text ?? "";
		const spec: ManipulateSpec = { name, kind: params.kind, container: params.container, line: params.line };

		let code: string;
		try {
			code = await Bun.file(abs).text();
		} catch {
			throw new ToolError(`Cannot read ${relPath}`);
		}
		const symbols = outlineCode({ code, path: abs, lang: params.lang }).symbols;
		const matches = resolveManipulateMatches(symbols, spec);
		if (matches.length === 0) {
			const quals: string[] = [];
			if (params.kind) quals.push(`kind=${params.kind}`);
			if (params.container) quals.push(`container=${params.container}`);
			if (params.line !== undefined) quals.push(`line=${params.line}`);
			const suffix = quals.length > 0 ? ` (${quals.join(", ")})` : "";
			throw new ToolError(`No symbol named '${name}'${suffix} in ${relPath}`);
		}
		if (matches.length > 1) {
			const candidateLines = matches.map(
				({ symbol, container }) =>
					`  ${symbol.kind} ${symbol.name}${container ? ` (${container})` : ""} @ line ${symbol.selectionLine}`,
			);
			throw new ToolError(
				`'${name}' matches ${matches.length} symbols in ${relPath} — add \`kind\`, \`container\`, or \`line\` to disambiguate:\n${candidateLines.join("\n")}`,
			);
		}
		const { startLine, endLine } = matches[0].symbol;
		if (wholeLineEditUnsafe(symbols, matches[0].index)) {
			throw new ToolError(
				`'${name}' is not isolated on its own line(s) in ${relPath} (it shares a line with another declaration); a line-based edit would clobber it — use \`edit\` or \`ast_edit\` for sub-line changes`,
			);
		}
		// Capture the symbol's source text now so the apply can reject if the body
		// changed since the preview even when the line range is unchanged.
		const previewRangeText = code.split("\n").slice(startLine - 1, endLine).join("\n");

		const tag = await recordFileSnapshot(this.session, abs);
		if (!tag) throw new ToolError(`Cannot snapshot ${relPath} for editing (file too large or unreadable)`);
		const preview = await computeHashlineDiff(
			{ input: buildManipulateInput(relPath, tag, op, startLine, endLine, text) },
			cwd,
			getFileSnapshotStore(this.session),
		);
		if ("error" in preview) throw new ToolError(preview.error);

		const details: SymbolToolDetails = {
			action: "manipulate",
			scopePath: relPath,
			symbolCount: 1,
			fileCount: 1,
			displayContent: preview.diff,
			cwd,
		};

		// Stage the apply through the hashline pipeline. At apply time the symbol is
		// re-read and re-resolved by spec, then required to occupy the SAME range the
		// preview showed; if it moved, changed, or no longer uniquely resolves, the
		// apply rejects so the model re-previews against current code. Re-resolving by
		// identity (rather than trusting a frozen range) is what stops hashline's
		// textual recovery from relocating a stale edit onto the wrong code; the fresh
		// per-apply tag makes the Patcher validate against live content.
		queueResolveHandler(this.session, {
			label: `Symbol ${op}: ${name} in ${relPath}`,
			sourceToolName: this.name,
			apply: async () => {
				let freshCode: string;
				try {
					freshCode = await Bun.file(abs).text();
				} catch {
					return { ...toolResult(details).text(`Cannot read ${relPath}`).done(), isError: true };
				}
				const freshMatches = resolveManipulateMatches(
					outlineCode({ code: freshCode, path: abs, lang: params.lang }).symbols,
					spec,
				);
				if (freshMatches.length !== 1) {
					return {
						...toolResult(details)
							.text(
								`Symbol '${name}' no longer uniquely resolves in ${relPath} since the preview (${freshMatches.length} match(es)); re-run \`symbol find\`/\`overview\` and retry.`,
							)
							.done(),
						isError: true,
					};
				}
				const fresh = freshMatches[0].symbol;
				if (fresh.startLine !== startLine || fresh.endLine !== endLine) {
					return {
						...toolResult(details)
							.text(`Symbol '${name}' moved or changed in ${relPath} since the preview; re-run \`symbol\` and retry.`)
							.done(),
						isError: true,
					};
				}
				const freshRangeText = freshCode.split("\n").slice(fresh.startLine - 1, fresh.endLine).join("\n");
				if (freshRangeText !== previewRangeText) {
					return {
						...toolResult(details)
							.text(`Symbol '${name}' content in ${relPath} changed since the preview; re-run \`symbol\` and retry.`)
							.done(),
						isError: true,
					};
				}
				const freshTag = await recordFileSnapshot(this.session, abs);
				if (!freshTag) {
					return { ...toolResult(details).text(`Cannot snapshot ${relPath} for editing`).done(), isError: true };
				}
				return executeHashlineSingle({
					session: this.session,
					input: buildManipulateInput(relPath, freshTag, op, fresh.startLine, fresh.endLine, text),
					signal: undefined,
					batchRequest: undefined,
					writethrough: createEditWritethrough(this.session),
					beginDeferredDiagnosticsForPath: p => this.#diagnostics.beginDeferredDiagnosticsForPath(p),
				});
			},
		});

		return toolResult(details).text(preview.diff).done();
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface SymbolRenderArgs {
	action?: string;
	path?: string | string[];
	name?: string;
	op?: string;
}

const COLLAPSED_SYMBOL_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const symbolToolRenderer = {
	inline: true,
	renderCall(args: SymbolRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		const paths = normalizePaths(args.path);
		if (paths.length > 0 && !(paths.length === 1 && paths[0] === ".")) {
			meta.push(`in ${paths.join(", ")}`);
		}
		const action = args.action ?? "?";
		const description = args.name ?? (action === "manipulate" ? args.op : undefined);
		const title = action === "manipulate" && args.op ? `Symbol ${args.op}` : "Symbol";
		const text = renderStatusLine({ icon: "pending", title, description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SymbolToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: SymbolRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const action = details?.action ?? args?.action ?? "overview";
		const symbolCount = details?.symbolCount ?? 0;
		const fileCount = details?.fileCount ?? 0;

		if (symbolCount === 0 && fileCount === 0) {
			const paths = normalizePaths(args?.path);
			const meta: string[] = ["0 symbols"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			else if (paths.length > 0 && !(paths.length === 1 && paths[0] === ".")) {
				meta.push(`in ${paths.join(", ")}`);
			}
			const description = args?.name;
			const header = renderStatusLine({ icon: "warning", title: "Symbol", description, meta }, uiTheme);
			const body = action === "find" ? "No symbols found." : "No files in scope.";
			return new Text([header, formatEmptyMessage(body, uiTheme)].join("\n"), 0, 0);
		}

		const summaryParts = [formatCount("symbol", symbolCount)];
		if (fileCount > 0) summaryParts.push(formatCount("file", fileCount));
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		const description = args?.name;
		const header = renderStatusLine(
			{ iconOverride: uiTheme.fg("accent", uiTheme.symbol("icon.search")), title: "Symbol", description, meta },
			uiTheme,
		);

		const textContent = details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		const contexts = classifyGroupedLines(allLines, details?.cwd, details?.scopePath);
		const styledLines = allLines.map((line, index) => {
			const ctx = contexts[index]!;
			const sanitized = replaceTabs(line);
			if (ctx.kind === "dir") {
				const styled = uiTheme.fg("accent", sanitized);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (ctx.kind === "file") {
				const styled = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", sanitized);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			return uiTheme.fg("toolOutput", sanitized);
		});
		const symbolGroups = groupLineIndicesByBlank(allLines).map(indices =>
			indices.map(index => styledLines[index]!),
		);
		// Drop the leading summary line from the tree body (it is already on
		// the status line) so the block does not duplicate it.
		const bodyGroups = symbolGroups.filter(group => {
			const first = group[0] ?? "";
			return !first.includes("symbol(s) matching");
		});

		return createCachedComponent(
			() => options.expanded,
			width => {
				const lines = [header];
				let shown = 0;
				for (let i = 0; i < bodyGroups.length; i++) {
					const group = bodyGroups[i]!;
					const separator = shown > 0 ? 1 : 0;
					const remainingAfter = bodyGroups.length - (i + 1);
					const reserved = !options.expanded && remainingAfter > 0 ? 1 : 0;
					if (!options.expanded && shown > 0 && lines.length + separator + group.length + reserved > COLLAPSED_SYMBOL_LIMIT) break;
					if (separator) lines.push("");
					lines.push(...group);
					shown++;
				}
				const remaining = bodyGroups.length - shown;
				if (!options.expanded && remaining > 0) {
					lines.push(uiTheme.fg("muted", `… ${remaining} more`));
				}
				return lines.map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
		);
	},
	mergeCallAndResult: true,
};
