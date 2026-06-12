/**
 * omp-permissions — fine-grained, predicate-based tool-call permissions for the
 * Oh My Pi (omp) coding agent.
 *
 * Ports the compound-bash decomposition idea from `liberzon/claude-hooks` and
 * the permission model from opencode (`permission.<category>` glob -> action),
 * mapped onto omp's built-in tools AND `serena` MCP tools.
 *
 * One `tool_call` interceptor:
 *   1. ALWAYS blocks every attempt to modify its own config file, plus any
 *      user-listed `protect.paths`, via edit-family tools or bash references —
 *      independent of the global enable flag and of permission rules.
 *   2. When enabled, evaluates each tool call against the configured rules.
 *
 * Permission categories mirror opencode: read, edit, glob, grep, bash, task,
 * lsp, question, webfetch, websearch, external_directory, doom_loop. Each maps
 * to one or more omp/serena tools (see TOOL_TABLE). Per-category rules are a
 * glob -> action map (or a bare action string); a top-level `"*"` (or a bare
 * string `permission`) sets a global default. Last-matching rule wins, and
 * across pieces (bash sub-commands / multiple paths) the most restrictive
 * outcome wins (deny > ask > allow > pass-through).
 *
 * Config (JSON), defaults to enabled, discovered + merged (later wins):
 *   - user:     ${PI_CODING_AGENT_DIR:-~/.omp/agent}/omp-permissions.json
 *   - project:  <cwd>/.omp/omp-permissions.json
 *   - override: $OMP_PERMISSIONS_CONFIG
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const CONFIG_BASENAME = "omp-permissions.json";

export type Action = "allow" | "ask" | "deny";

export type Category =
	| "read"
	| "edit"
	| "glob"
	| "grep"
	| "bash"
	| "task"
	| "lsp"
	| "question"
	| "webfetch"
	| "websearch"
	| "external_directory"
	| "doom_loop";

export interface NormalizedConfig {
	/** undefined means "not explicitly set"; treated as enabled. */
	enabled: boolean | undefined;
	/** Fallback action from a bare `permission` string or `permission["*"]`. */
	globalDefault: Action | null;
	categories: Record<string, Record<string, Action>>;
	protect: { enabled: boolean | undefined; action: Action | undefined; paths: string[] };
	log: { enabled: boolean | undefined; path: string | undefined };
}

export interface Decision {
	action: Action | null;
	reason: string;
}

function emptyConfig(): NormalizedConfig {
	return {
		enabled: undefined,
		globalDefault: null,
		categories: {},
		protect: { enabled: undefined, action: undefined, paths: [] },
		log: { enabled: undefined, path: undefined },
	};
}

// ---------------------------------------------------------------------------
// Bash compound-command decomposition (ported from liberzon/claude-hooks).
// ---------------------------------------------------------------------------

const SHELL_KEYWORDS = new Set(["do", "done", "then", "else", "elif", "fi", "esac", "{", "}", "break", "continue"]);
const KEYWORD_PREFIX_RE = /^(do|then|else|elif)\s+/;
const COMPOUND_HEADER_RE = /^(for|while|until|if|case|select)\b/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Strip heredoc bodies, leaving only the `<<DELIM` marker line. */
export function stripHeredocs(command: string): string {
	const lines = command.split("\n");
	const result: string[] = [];
	let delim: string | null = null;
	for (const line of lines) {
		if (delim !== null) {
			if (line.trim() === delim) delim = null;
			continue;
		}
		const m = line.match(/<<-?\s*['"]?(\w+)['"]?/);
		if (m) delim = m[1];
		result.push(line);
	}
	return result.join("\n");
}

/** Split on &&, ||, ;, |, and newlines at the top level (quotes/$() aware). */
export function splitOnOperators(command: string): string[] {
	command = stripHeredocs(command).replace(/\\\n/g, " ");
	const segments: string[] = [];
	let current = "";
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	let parenDepth = 0;
	const n = command.length;

	while (i < n) {
		const ch = command[i];

		if (ch === "\\" && !inSingle && i + 1 < n) {
			current += ch + command[i + 1];
			i += 2;
			continue;
		}
		if (ch === "'" && !inDouble && parenDepth === 0) {
			inSingle = !inSingle;
			current += ch;
			i++;
			continue;
		}
		if (ch === '"' && !inSingle && parenDepth === 0) {
			inDouble = !inDouble;
			current += ch;
			i++;
			continue;
		}
		if (inSingle || inDouble) {
			current += ch;
			i++;
			continue;
		}
		if (ch === "$" && i + 1 < n && command[i + 1] === "(") {
			parenDepth++;
			current += "$(";
			i += 2;
			continue;
		}
		if (ch === "(" && parenDepth > 0) {
			parenDepth++;
			current += ch;
			i++;
			continue;
		}
		if (ch === ")" && parenDepth > 0) {
			parenDepth--;
			current += ch;
			i++;
			continue;
		}
		if (parenDepth > 0) {
			current += ch;
			i++;
			continue;
		}
		if (ch === "&" && i + 1 < n && command[i + 1] === "&") {
			segments.push(current);
			current = "";
			i += 2;
			continue;
		}
		if (ch === "|" && i + 1 < n && command[i + 1] === "|") {
			segments.push(current);
			current = "";
			i += 2;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "\n") {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	segments.push(current);
	return segments.map(s => s.trim()).filter(Boolean);
}

/** Recursively extract $() and backtick subshell contents (skips $(( ))). */
export function extractSubshells(command: string): string[] {
	const subshells: string[] = [];
	const n = command.length;
	let i = 0;
	while (i < n) {
		if (command[i] === "$" && i + 1 < n && command[i + 1] === "(" && !(i + 2 < n && command[i + 2] === "(")) {
			let depth = 0;
			const start = i + 2;
			let j = i + 1;
			while (j < n) {
				if (command[j] === "(") depth++;
				else if (command[j] === ")") {
					depth--;
					if (depth === 0) {
						const content = command.slice(start, j);
						subshells.push(content);
						subshells.push(...extractSubshells(content));
						break;
					}
				}
				j++;
			}
			i = j + 1;
		} else {
			i++;
		}
	}
	const parts = command.split("`");
	for (let idx = 1; idx < parts.length; idx += 2) {
		const content = parts[idx];
		if (content.trim()) {
			subshells.push(content);
			subshells.push(...extractSubshells(content));
		}
	}
	return subshells;
}

function skipShellValue(cmd: string, i: number): number {
	const n = cmd.length;
	if (i >= n) return i;
	if (cmd[i] === '"') {
		i++;
		while (i < n && cmd[i] !== '"') i += cmd[i] === "\\" && i + 1 < n ? 2 : 1;
		if (i < n) i++;
		return i;
	}
	if (cmd[i] === "'") {
		i++;
		while (i < n && cmd[i] !== "'") i++;
		if (i < n) i++;
		return i;
	}
	let parenDepth = 0;
	while (i < n) {
		const ch = cmd[i];
		if (ch === "$" && i + 1 < n && cmd[i + 1] === "(") {
			parenDepth += 2;
			i += 2;
			continue;
		}
		if (ch === "(" && parenDepth > 0) {
			parenDepth++;
			i++;
			continue;
		}
		if (ch === ")" && parenDepth > 0) {
			parenDepth--;
			i++;
			continue;
		}
		if (parenDepth > 0) {
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") break;
		i++;
	}
	return i;
}

/** Strip leading `FOO=bar` env assignments (subshell-aware). */
export function stripEnvVars(cmd: string): string {
	for (;;) {
		const m = cmd.match(ASSIGNMENT_RE);
		if (!m) break;
		const i = skipShellValue(cmd, m[0].length);
		const rest = cmd.slice(i).replace(/^\s+/, "");
		if (!rest) break;
		cmd = rest;
	}
	return cmd;
}

/** Remove output/input redirections (`>f`, `2>&1`, `<f`, `<<<w`, ...). */
export function stripRedirections(cmd: string): string {
	cmd = cmd.replace(/\d*>>?\s*&?\d*\S*/g, "");
	cmd = cmd.replace(/<<<?\s*\S+/g, "");
	cmd = cmd.replace(/<\s*\S+/g, "");
	return cmd.trim();
}

function isStandaloneAssignment(cmd: string): boolean {
	const m = cmd.match(ASSIGNMENT_RE);
	if (!m) return false;
	return cmd.slice(skipShellValue(cmd, m[0].length)).trim() === "";
}

/** Normalize one segment: strip keyword prefix, env vars, redirections, ws. */
export function normalizeCommand(cmd: string): string {
	cmd = cmd.trim();
	if (!cmd) return cmd;
	cmd = cmd.replace(KEYWORD_PREFIX_RE, "");
	cmd = stripEnvVars(cmd);
	cmd = stripRedirections(cmd);
	return cmd.replace(/\s+/g, " ").trim();
}

/** Decompose a compound command into all normalized sub-commands. */
export function decomposeCommand(command: string): string[] {
	const all: string[] = [];
	for (const seg of splitOnOperators(command)) {
		for (const sub of extractSubshells(seg)) {
			for (const ss of splitOnOperators(sub)) {
				const nn = normalizeCommand(ss);
				if (nn) all.push(nn);
			}
		}
		const nn = normalizeCommand(seg);
		if (nn) all.push(nn);
	}
	return all.filter(c => !(SHELL_KEYWORDS.has(c) || COMPOUND_HEADER_RE.test(c)) && !isStandaloneAssignment(c));
}

// ---------------------------------------------------------------------------
// Glob matching + rule resolution (opencode-style wildcard semantics).
// ---------------------------------------------------------------------------

/** Compile a `*`/`?` glob into an anchored RegExp (`*` = 0+ chars incl `/`). */
export function globToRegExp(pattern: string): RegExp {
	let re = "";
	for (const c of pattern) {
		if (c === "*") re += "[\\s\\S]*";
		else if (c === "?") re += "[\\s\\S]";
		else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

/**
 * A rule pattern matches a value if the glob matches, OR — for prefix-style
 * rules ending in " *" — the bare prefix equals the value (so `git *` also
 * matches a bare `git`).
 */
export function matchRule(value: string, pattern: string): boolean {
	if (globToRegExp(pattern).test(value)) return true;
	if (pattern.endsWith(" *") && value === pattern.slice(0, -2)) return true;
	return false;
}

/** Resolve the action for a single value against a rule map (last match wins). */
export function resolveAction(value: string, rules: Record<string, Action>): Action | null {
	let result: Action | null = null;
	for (const [pattern, action] of Object.entries(rules)) {
		if (matchRule(value, pattern)) result = action;
	}
	return result;
}

const ACTION_RANK: Record<Action, number> = { allow: 1, ask: 2, deny: 3 };

function rank(action: Action | null): number {
	return action === null ? 0 : ACTION_RANK[action];
}

function moreRestrictive(a: Decision, b: Decision): Decision {
	return rank(b.action) > rank(a.action) ? b : a;
}

/**
 * Evaluate a set of values against a rule map + global default, combining with
 * deny > ask > allow > pass-through (a single denied piece denies the whole).
 */
export function evaluate(
	values: string[],
	rules: Record<string, Action> | undefined,
	globalDefault: Action | null,
	label: (value: string) => string,
): Decision {
	let worst: Action | null = null;
	let reason = "";
	for (const value of values) {
		let action = rules ? resolveAction(value, rules) : null;
		if (action === null) action = globalDefault;
		if (action === "deny") {
			return { action: "deny", reason: `${label(value)} matches a deny rule` };
		}
		if (action !== null && rank(action) > rank(worst)) {
			worst = action;
			reason = `${label(value)} matches an ${action} rule`;
		}
	}
	return { action: worst, reason };
}

export function decideBash(command: string, rules: Record<string, Action>): Decision {
	return evaluate(decomposeCommand(command), rules, null, c => `bash sub-command "${c}"`);
}

export function decideTargets(targets: string[], rules: Record<string, Action>): Decision {
	return evaluate(targets, rules, null, p => `path "${p}"`);
}

// ---------------------------------------------------------------------------
// Tool classification (omp built-ins + serena MCP tools).
// ---------------------------------------------------------------------------

type ArgKind =
	| "command"
	| "path"
	| "paths"
	| "editPatch"
	| "relPath"
	| "query"
	| "pattern"
	| "fileMask"
	| "agent"
	| "lspAction"
	| "none";

interface ToolSpec {
	category: Category;
	arg: ArgKind;
	shell?: true;
	pathLike?: true;
}

const TOOL_TABLE: Record<string, ToolSpec> = {
	// omp built-ins
	read: { category: "read", arg: "path", pathLike: true },
	bash: { category: "bash", arg: "command", shell: true },
	edit: { category: "edit", arg: "editPatch", pathLike: true },
	write: { category: "edit", arg: "path", pathLike: true },
	ast_edit: { category: "edit", arg: "paths", pathLike: true },
	notebook: { category: "edit", arg: "path", pathLike: true },
	find: { category: "glob", arg: "paths", pathLike: true },
	search: { category: "grep", arg: "pattern" },
	lsp: { category: "lsp", arg: "lspAction" },
	task: { category: "task", arg: "agent" },
	web_search: { category: "websearch", arg: "query" },
	ask: { category: "question", arg: "none" },
	// serena MCP tools (mcp__serena_*)
	mcp__serena_execute_shell_command: { category: "bash", arg: "command", shell: true },
	mcp__serena_create_text_file: { category: "edit", arg: "relPath", pathLike: true },
	mcp__serena_replace_content: { category: "edit", arg: "relPath", pathLike: true },
	mcp__serena_replace_symbol_body: { category: "edit", arg: "relPath", pathLike: true },
	mcp__serena_insert_after_symbol: { category: "edit", arg: "relPath", pathLike: true },
	mcp__serena_insert_before_symbol: { category: "edit", arg: "relPath", pathLike: true },
	mcp__serena_rename_symbol: { category: "edit", arg: "relPath", pathLike: true },
	mcp__serena_safe_delete_symbol: { category: "edit", arg: "relPath", pathLike: true },
	mcp__serena_read_file: { category: "read", arg: "relPath", pathLike: true },
	mcp__serena_find_file: { category: "glob", arg: "fileMask", pathLike: true },
	mcp__serena_search_for_pattern: { category: "grep", arg: "pattern" },
	mcp__serena_get_symbols_overview: { category: "read", arg: "relPath", pathLike: true },
	mcp__serena_find_symbol: { category: "read", arg: "relPath", pathLike: true },
	mcp__serena_find_referencing_symbols: { category: "read", arg: "relPath", pathLike: true },
	mcp__serena_find_implementations: { category: "read", arg: "relPath", pathLike: true },
	mcp__serena_find_declaration: { category: "read", arg: "relPath", pathLike: true },
	mcp__serena_get_diagnostics_for_file: { category: "read", arg: "relPath", pathLike: true },
};

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function extractRaw(arg: ArgKind, input: Record<string, unknown>): string[] {
	switch (arg) {
		case "command":
			return typeof input.command === "string" ? [input.command] : [];
		case "path":
			return typeof input.path === "string" ? [input.path] : [];
		case "relPath":
			return typeof input.relative_path === "string" ? [input.relative_path] : [];
		case "query":
			return typeof input.query === "string" ? [input.query] : [];
		case "fileMask":
			return typeof input.file_mask === "string" ? [input.file_mask] : [];
		case "agent":
			return typeof input.agent === "string" ? [input.agent] : [];
		case "lspAction":
			return typeof input.action === "string" ? [input.action] : [];
		case "pattern": {
			const value = input.pattern ?? input.substring_pattern;
			return typeof value === "string" ? [value] : [];
		}
		case "paths":
			return Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === "string") : [];
		case "editPatch":
			return extractEditPaths(typeof input.input === "string" ? input.input : "");
		case "none":
			return [];
	}
}

export interface ToolClassification {
	category: Category;
	values: string[];
	isShell: boolean;
	pathLike: boolean;
}

export function classifyTool(toolName: string, input: Record<string, unknown>): ToolClassification | null {
	const spec = TOOL_TABLE[toolName];
	if (!spec) return null;
	let category: Category = spec.category;
	const values = extractRaw(spec.arg, input);
	if (category === "read" && values.length > 0 && URL_RE.test(values[0])) {
		category = "webfetch";
	}
	return {
		category,
		values,
		isShell: spec.shell === true,
		pathLike: spec.pathLike === true && category !== "webfetch",
	};
}

// ---------------------------------------------------------------------------
// Path helpers + config self-protection.
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	if (p === "$HOME") return os.homedir();
	if (p.startsWith("$HOME/")) return path.join(os.homedir(), p.slice(6));
	return p;
}

function userConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR
		? expandHome(process.env.PI_CODING_AGENT_DIR)
		: path.join(os.homedir(), ".omp", "agent");
	return path.resolve(agentDir, CONFIG_BASENAME);
}

/** Config files whose modification is always blocked, whether or not present. */
export function protectedConfigPaths(cwd: string): string[] {
	const out = [userConfigPath(), path.resolve(cwd, ".omp", CONFIG_BASENAME)];
	if (process.env.OMP_PERMISSIONS_CONFIG) {
		out.push(path.resolve(expandHome(process.env.OMP_PERMISSIONS_CONFIG)));
	}
	return Array.from(new Set(out));
}

function isExternal(value: string, cwd: string): boolean {
	const abs = path.resolve(cwd, expandHome(value));
	const base = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
	return abs !== cwd && !abs.startsWith(base);
}

/** Extract target file paths from a hashline `edit` patch (`¶PATH#TAG`). */
export function extractEditPaths(input: string): string[] {
	if (!input) return [];
	const paths: string[] = [];
	const re = /¶([^\n#]+)#[0-9A-Fa-f]{4}/g;
	for (const m of input.matchAll(re)) {
		const p = m[1]
			.trim()
			.replace(/^\*+\s*/, "")
			.replace(/^(?:Update File:|Add File:|Delete File:|Move to:)\s*/i, "")
			.trim();
		if (p) paths.push(p);
	}
	return paths;
}

const PROTECT_CONFIG_MESSAGE = `Modifying the permission config (${CONFIG_BASENAME}) is not allowed.`;

/**
 * Returns a block reason if `toolName`/`input` would modify (or, for shell
 * tools, references) a protected file — the permission config (always) or any
 * `protect.paths` entry; otherwise null.
 */
export function checkConfigProtection(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	config: NormalizedConfig,
): string | null {
	const classification = classifyTool(toolName, input);
	if (!classification) return null;
	if (!classification.isShell && classification.category !== "edit") return null;

	const protectedSet = protectedConfigPaths(cwd);
	const extraGlobs = config.protect.enabled === false ? [] : config.protect.paths;

	if (classification.isShell) {
		const parts: string[] = [];
		if (typeof input.command === "string") parts.push(input.command);
		if (typeof input.cwd === "string") parts.push(input.cwd);
		if (input.env && typeof input.env === "object") {
			for (const v of Object.values(input.env as Record<string, unknown>)) {
				if (typeof v === "string") parts.push(v);
			}
		}
		const text = parts.join("\n");
		if (text.includes(CONFIG_BASENAME) || protectedSet.some(p => text.includes(p))) {
			return PROTECT_CONFIG_MESSAGE;
		}
		for (const glob of extraGlobs) {
			if (glob.includes("*") || glob.includes("?")) continue;
			const abs = path.resolve(cwd, expandHome(glob));
			if (text.includes(glob) || text.includes(abs) || text.includes(path.basename(glob))) {
				return `Referencing a protected path (${glob}) from a shell command is not allowed.`;
			}
		}
		return null;
	}

	for (const target of classification.values) {
		const abs = path.resolve(cwd, expandHome(target));
		if (path.basename(target) === CONFIG_BASENAME || protectedSet.includes(abs)) {
			return PROTECT_CONFIG_MESSAGE;
		}
		for (const glob of extraGlobs) {
			const expanded = expandHome(glob);
			if (matchRule(target, expanded) || matchRule(abs, path.resolve(cwd, expanded))) {
				return `Modifying a protected path (${glob}) is not allowed.`;
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Decision pipeline (category + external_directory).
// ---------------------------------------------------------------------------

export function decide(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	config: NormalizedConfig,
): Decision {
	const classification = classifyTool(toolName, input);
	if (!classification) return { action: null, reason: "" };

	let values: string[];
	if (classification.isShell) {
		values = classification.values.flatMap(cmd => decomposeCommand(cmd));
		if (values.length === 0) return { action: null, reason: "" };
	} else {
		values = classification.values.length > 0 ? classification.values : [""];
	}

	const { category } = classification;
	let decision = evaluate(values, config.categories[category], config.globalDefault, v =>
		v ? `${category} "${v}"` : category,
	);

	if (classification.pathLike) {
		const external = values.filter(v => v && isExternal(v, cwd)).map(v => path.resolve(cwd, expandHome(v)));
		if (external.length > 0) {
			decision = moreRestrictive(
				decision,
				evaluate(external, config.categories.external_directory, config.globalDefault, v => `external path "${v}"`),
			);
		}
	}
	return decision;
}

/** Detects the same tool call repeating with identical input (opencode parity). */
export class DoomTracker {
	#lastSignature = "";
	#count = 0;
	tripped(toolName: string, input: Record<string, unknown>): boolean {
		const signature = `${toolName}\u0000${JSON.stringify(input)}`;
		if (signature === this.#lastSignature) {
			this.#count += 1;
		} else {
			this.#lastSignature = signature;
			this.#count = 1;
		}
		return this.#count >= 3;
	}
}

// ---------------------------------------------------------------------------
// Config loading.
// ---------------------------------------------------------------------------

function normalizeCategoryRules(value: unknown): Record<string, Action> {
	if (value === "allow" || value === "ask" || value === "deny") return { "*": value };
	const map: Record<string, Action> = {};
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [pat, act] of Object.entries(value as Record<string, unknown>)) {
			if (act === "allow" || act === "ask" || act === "deny") map[pat] = act;
		}
	}
	return map;
}

export function parseConfig(raw: string): NormalizedConfig {
	const data = JSON.parse(raw) as unknown;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("config root must be a JSON object");
	}
	const obj = data as Record<string, unknown>;
	const enabled = obj.enabled === undefined ? undefined : Boolean(obj.enabled);

	let globalDefault: Action | null = null;
	const categories: Record<string, Record<string, Action>> = {};
	const perm = obj.permission ?? obj.permissions;
	if (perm === "allow" || perm === "ask" || perm === "deny") {
		globalDefault = perm;
	} else if (perm && typeof perm === "object" && !Array.isArray(perm)) {
		for (const [key, value] of Object.entries(perm as Record<string, unknown>)) {
			if (key === "*") {
				if (value === "allow" || value === "ask" || value === "deny") globalDefault = value;
			} else {
				categories[key] = normalizeCategoryRules(value);
			}
		}
	}

	const protectRaw = (obj.protect ?? {}) as Record<string, unknown>;
	const protectPaths = Array.isArray(protectRaw.paths)
		? protectRaw.paths.filter((p): p is string => typeof p === "string")
		: [];
	const protectAction = protectRaw.action === "ask" || protectRaw.action === "deny" ? protectRaw.action : undefined;

	const logRaw = obj.log;
	let log: { enabled: boolean | undefined; path: string | undefined };
	if (typeof logRaw === "boolean") {
		log = { enabled: logRaw, path: undefined };
	} else if (logRaw && typeof logRaw === "object" && !Array.isArray(logRaw)) {
		const lr = logRaw as Record<string, unknown>;
		log = {
			enabled: lr.enabled === undefined ? undefined : Boolean(lr.enabled),
			path: typeof lr.path === "string" ? lr.path : undefined,
		};
	} else {
		log = { enabled: undefined, path: undefined };
	}

	return {
		enabled,
		globalDefault,
		categories,
		protect: {
			enabled: protectRaw.enabled === undefined ? undefined : Boolean(protectRaw.enabled),
			action: protectAction,
			paths: protectPaths,
		},
		log,
	};
}

export async function loadConfigFile(filePath: string): Promise<NormalizedConfig | null> {
	try {
		return parseConfig(await Bun.file(filePath).text());
	} catch (err) {
		if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
			return null;
		}
		throw err;
	}
}

export function mergeConfigs(base: NormalizedConfig | null, over: NormalizedConfig | null): NormalizedConfig {
	const b = base ?? emptyConfig();
	const o = over ?? emptyConfig();
	const categories: Record<string, Record<string, Action>> = {};
	for (const [key, rules] of Object.entries(b.categories)) categories[key] = { ...rules };
	for (const [key, rules] of Object.entries(o.categories)) {
		categories[key] = { ...(categories[key] ?? {}), ...rules };
	}
	return {
		enabled: o.enabled !== undefined ? o.enabled : b.enabled,
		globalDefault: o.globalDefault !== null ? o.globalDefault : b.globalDefault,
		categories,
		protect: {
			enabled: o.protect.enabled !== undefined ? o.protect.enabled : b.protect.enabled,
			action: o.protect.action !== undefined ? o.protect.action : b.protect.action,
			paths: Array.from(new Set([...b.protect.paths, ...o.protect.paths])),
		},
		log: {
			enabled: o.log.enabled !== undefined ? o.log.enabled : b.log.enabled,
			path: o.log.path !== undefined ? o.log.path : b.log.path,
		},
	};
}

export function isEnabled(config: NormalizedConfig): boolean {
	return config.enabled !== false;
}

interface MinimalLogger {
	warn?: (msg: string) => void;
	error?: (msg: string) => void;
}

async function safeLoad(filePath: string, logger?: MinimalLogger): Promise<NormalizedConfig | null> {
	try {
		return await loadConfigFile(filePath);
	} catch (err) {
		logger?.warn?.(`[omp-permissions] ignoring invalid config at ${filePath}: ${err}`);
		return null;
	}
}

export async function loadMergedConfig(cwd: string, logger?: MinimalLogger): Promise<NormalizedConfig> {
	const user = await safeLoad(userConfigPath(), logger);
	const project = await safeLoad(path.resolve(cwd, ".omp", CONFIG_BASENAME), logger);
	const override = process.env.OMP_PERMISSIONS_CONFIG
		? await safeLoad(path.resolve(expandHome(process.env.OMP_PERMISSIONS_CONFIG)), logger)
		: null;
	return mergeConfigs(mergeConfigs(user, project), override);
}

// ---------------------------------------------------------------------------
// Extension factory.
// ---------------------------------------------------------------------------

interface ConfirmContext {
	hasUI?: boolean;
	ui?: { confirm?: (arg: unknown) => Promise<unknown> };
}

async function confirmAllow(ctx: ConfirmContext | undefined, toolName: string, reason: string): Promise<boolean> {
	// Fail closed when there is no interactive UI (headless / subagent runs).
	const ui = ctx?.ui;
	if (!ctx?.hasUI || typeof ui?.confirm !== "function") return false;
	const prompt = `Permission policy — allow ${toolName}? (${reason})`;
	try {
		return Boolean(await ui.confirm(prompt));
	} catch {
		try {
			return Boolean(await ui.confirm({ title: "Permission policy", message: prompt }));
		} catch {
			return false;
		}
	}
}

function logFilePath(config: NormalizedConfig): string {
	if (config.log.path) return path.resolve(expandHome(config.log.path));
	const agentDir = process.env.PI_CODING_AGENT_DIR
		? expandHome(process.env.PI_CODING_AGENT_DIR)
		: path.join(os.homedir(), ".omp", "agent");
	return path.resolve(agentDir, "omp-permissions.log");
}

export interface SessionIdentity {
	pid: number;
	session: string | null;
	sessionName: string | null;
	cwd: string;
}

interface IdentityContext {
	cwd?: string;
	sessionManager?: { getSessionId?: () => string; sessionId?: string; getId?: () => string };
}

function captureIdentity(pi: ExtensionAPI, ctx: IdentityContext | undefined): SessionIdentity {
	let session: string | null = null;
	try {
		const sm = ctx?.sessionManager;
		if (sm) {
			if (typeof sm.getSessionId === "function") session = sm.getSessionId();
			else if (typeof sm.sessionId === "string") session = sm.sessionId;
			else if (typeof sm.getId === "function") session = sm.getId();
		}
	} catch {
		session = null;
	}
	let sessionName: string | null = null;
	try {
		const getName = (pi as { getSessionName?: () => string | undefined }).getSessionName;
		if (typeof getName === "function") sessionName = getName.call(pi) ?? null;
	} catch {
		sessionName = null;
	}
	return { pid: process.pid, session, sessionName, cwd: ctx?.cwd ?? process.cwd() };
}

export interface Outcome {
	permission: "allowed" | "blocked" | "asked";
	block: boolean;
	reason: string;
	confirmed?: boolean;
}

export async function resolveOutcome(
	action: Action | null,
	reason: string,
	toolName: string,
	ctx: ConfirmContext | undefined,
): Promise<Outcome> {
	if (action === "deny") return { permission: "blocked", block: true, reason };
	if (action === "ask") {
		const canAsk = ctx?.hasUI === true && typeof ctx?.ui?.confirm === "function";
		if (!canAsk) {
			return { permission: "blocked", block: true, reason: `${reason} (no UI to confirm)` };
		}
		const ok = await confirmAllow(ctx, toolName, reason);
		return ok
			? { permission: "asked", block: false, reason, confirmed: true }
			: { permission: "asked", block: true, reason: `denied at confirmation: ${reason}`, confirmed: false };
	}
	return { permission: "allowed", block: false, reason };
}

export function buildLogRecord(
	identity: SessionIdentity,
	toolName: string,
	category: Category | null,
	outcome: Outcome,
): Record<string, unknown> {
	return {
		ts: new Date().toISOString(),
		pid: identity.pid,
		session: identity.session,
		sessionName: identity.sessionName,
		cwd: identity.cwd,
		tool: toolName,
		category,
		permission: outcome.permission,
		blocked: outcome.block,
		confirmed: outcome.confirmed,
		reason: outcome.reason || undefined,
	};
}

function writeLog(config: NormalizedConfig, record: Record<string, unknown>, logger?: MinimalLogger): void {
	if (config.log.enabled !== true) return;
	const file = logFilePath(config);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
	} catch (err) {
		logger?.warn?.(`[omp-permissions] failed to write log to ${file}: ${err}`);
	}
}

export default function ompPermissions(pi: ExtensionAPI): void {
	pi.setLabel?.("Permissions");

	let config = emptyConfig();
	let loaded = false;
	let identity: SessionIdentity = {
		pid: process.pid,
		session: null,
		sessionName: null,
		cwd: process.cwd(),
	};
	const doom = new DoomTracker();
	const logger = pi.logger as MinimalLogger | undefined;

	const reload = async (cwd: string, ctx: IdentityContext | undefined) => {
		config = await loadMergedConfig(cwd, logger);
		identity = captureIdentity(pi, ctx);
		loaded = true;
	};

	pi.on("session_start", async (_event, ctx) => {
		await reload(ctx?.cwd ?? process.cwd(), ctx as IdentityContext | undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;
		const cwd = ctx?.cwd ?? process.cwd();
		if (!loaded) await reload(cwd, ctx as IdentityContext | undefined);

		const category = classifyTool(toolName, input)?.category ?? null;
		const finish = (outcome: Outcome) => {
			writeLog(config, buildLogRecord(identity, toolName, category, outcome), logger);
			return outcome.block ? { block: true, reason: outcome.reason } : undefined;
		};

		// 1. Self-protection (always on). Action configurable: ask (default) or deny.
		const guard = checkConfigProtection(toolName, input, cwd, config);
		if (guard) {
			return finish(await resolveOutcome(config.protect.action ?? "ask", guard, toolName, ctx));
		}

		// 2. Global enable flag (defaults to enabled when unset).
		if (!isEnabled(config)) {
			return finish({ permission: "allowed", block: false, reason: "rule enforcement disabled" });
		}

		// 3. Permission rules for the tool's category (+ external_directory).
		let decision = decide(toolName, input, cwd, config);

		// 4. Doom-loop guard (only when configured).
		if ((config.categories.doom_loop || config.globalDefault) && doom.tripped(toolName, input)) {
			decision = moreRestrictive(
				decision,
				evaluate(
					[""],
					config.categories.doom_loop,
					config.globalDefault,
					() => "repeated identical tool call (doom loop)",
				),
			);
		}

		return finish(await resolveOutcome(decision.action, decision.reason, toolName, ctx));
	});
}
