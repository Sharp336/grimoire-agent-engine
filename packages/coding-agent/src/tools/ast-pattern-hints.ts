/**
 * Advisory hints for `ast_grep` patterns that returned zero matches.
 *
 * The single most common `ast_grep` failure is treating the pattern as regex
 * or text — `\w`, `[a-z]`, `.*`, `foo|bar` parse as literal AST and never match.
 * The second is a structurally incomplete declaration (a Python pattern with a
 * trailing `:`, a bare `function $NAME` with no params/body). These detectors
 * turn an empty result into a one-line nudge toward the right tool or shape.
 *
 * Every detector is best-effort and side-effect-free: it returns `undefined`
 * when no rule matches, so the caller appends nothing rather than guessing.
 */

/** Language tokens the language-specific detector understands. */
type AstHintLanguage = "python" | "javascript" | "typescript" | "tsx" | "go" | "rust";

const EXTENSION_LANGUAGES: Record<string, AstHintLanguage> = {
	py: "python",
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	go: "go",
	rs: "rust",
};

/**
 * Best-effort language inference from the search paths/globs. Returns a language
 * only when every path with a recognized extension agrees on it; mixed or
 * unrecognized inputs yield `undefined` (the language-specific hints then stay
 * silent and only the regex-misuse hints can fire).
 */
export function inferAstLanguage(paths: readonly string[]): AstHintLanguage | undefined {
	let resolved: AstHintLanguage | undefined;
	for (const candidate of paths) {
		const ext = /\.([a-z0-9]+)$/i.exec(candidate)?.[1]?.toLowerCase();
		if (!ext) continue;
		const lang = EXTENSION_LANGUAGES[ext];
		if (!lang) continue;
		if (resolved && resolved !== lang) return undefined;
		resolved = lang;
	}
	return resolved;
}

/** Detect regex/text constructs that do not work in ast-grep patterns. */
export function detectRegexMisuse(pattern: string): string | undefined {
	const src = pattern.trim();

	if (/\\[wWdDsSbB]/.test(src)) {
		return 'Hint: "\\w", "\\d", "\\s", "\\b" are regex escapes. ast_grep matches AST nodes, not text — use $VAR for one identifier, $$$ for a node list, or the `search` tool for text.';
	}

	if (/\[[a-zA-Z0-9]-[a-zA-Z0-9]\]/.test(src)) {
		return 'Hint: "[a-z]" and similar character classes are regex, not AST. Use $VAR to match any identifier, or the `search` tool for text search.';
	}

	if (!src.includes("$") && /\w\.[*+]/.test(src)) {
		return 'Hint: ".*" and ".+" are regex wildcards. In ast_grep use $$$ for multiple AST nodes and $VAR for a single node; for text patterns use the `search` tool.';
	}

	if (/^[-\w.*]+\|[-\w.*|]+$/.test(src)) {
		return 'Hint: "|" is regex alternation and does NOT work in ast_grep patterns. Either fire one ast_grep call per alternative, or use the `search` tool with a regex like "foo|bar".';
	}

	return undefined;
}

/** Detect structurally incomplete declarations for a known language. */
export function detectLanguageSpecificMistake(pattern: string, lang: AstHintLanguage | undefined): string | undefined {
	if (!lang) return undefined;
	const src = pattern.trim();

	if (lang === "python") {
		if (src.startsWith("class ") && src.endsWith(":")) {
			return `Hint: drop the trailing colon — ast_grep patterns are not full statements. Try: "${src.slice(0, -1)}"`;
		}
		if ((src.startsWith("def ") || src.startsWith("async def ")) && src.endsWith(":")) {
			return `Hint: drop the trailing colon — ast_grep patterns are not full statements. Try: "${src.slice(0, -1)}"`;
		}
	}

	if (lang === "javascript" || lang === "typescript" || lang === "tsx") {
		if (/^(export\s+)?(async\s+)?function\s+\$[A-Z_]+\s*$/i.test(src)) {
			return 'Hint: function patterns need params and a body. Try "function $NAME($$$) { $$$ }".';
		}
	}

	if (lang === "go" && /^func\s+\$[A-Z_]+\s*$/i.test(src)) {
		return 'Hint: Go function patterns need params and a body. Try "func $NAME($$$) { $$$ }".';
	}

	if (lang === "rust" && /^fn\s+\$[A-Z_]+\s*$/i.test(src)) {
		return 'Hint: Rust fn patterns need params and a body. Try "fn $NAME($$$) { $$$ }".';
	}

	return undefined;
}

/**
 * Return a one-line advisory hint for a zero-match `ast_grep` pattern, or
 * `undefined` when no rule applies. Regex-misuse detection runs first (it needs
 * no language); the language-specific shape check runs only when `lang` is known.
 */
export function getPatternHint(pattern: string, lang: AstHintLanguage | undefined): string | undefined {
	return detectRegexMisuse(pattern) ?? detectLanguageSpecificMistake(pattern, lang);
}
