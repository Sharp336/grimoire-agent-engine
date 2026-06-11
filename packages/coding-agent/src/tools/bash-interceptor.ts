/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead.
 */
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../config/settings-schema";
import { bashInterceptScriptedEditMessage } from "../edit/hashline/guidance";

export interface InterceptionResult {
	/** If true, the bash command should be blocked */
	block: boolean;
	/** Error message to return instead of executing */
	message?: string;
	/** Suggested tool to use instead */
	suggestedTool?: string;
}

/** Default scripted-edit rule for `python -c` file writes (not arbitrary custom `python` patterns). */
function isDefaultPythonScriptedEditRule(rule: BashInterceptorRule): boolean {
	return (
		rule.tool === "edit" &&
		rule.pattern.includes("python(?:3") &&
		rule.pattern.includes("-c\\b") &&
		rule.pattern.includes("write_text|write_bytes")
	);
}

/** Default scripted-edit rule for `node -e` / `bun -e` file writes. */
function isDefaultNodeBunScriptedEditRule(rule: BashInterceptorRule): boolean {
	return (
		rule.tool === "edit" &&
		rule.pattern.includes("node|nodejs|bun") &&
		rule.pattern.includes("-e\\b") &&
		rule.pattern.includes("Bun\\.write")
	);
}

function isDefaultScriptedEditNormalizationRule(rule: BashInterceptorRule): boolean {
	return isDefaultPythonScriptedEditRule(rule) || isDefaultNodeBunScriptedEditRule(rule);
}

/**
 * Compile bash interceptor rules into regexes, skipping invalid patterns.
 */
function compileRules(rules: BashInterceptorRule[]): Array<{ rule: BashInterceptorRule; regex: RegExp }> {
	const compiled: Array<{ rule: BashInterceptorRule; regex: RegExp }> = [];
	for (const rule of rules) {
		const flags = rule.flags ?? "";
		try {
			compiled.push({ rule, regex: new RegExp(rule.pattern, flags) });
		} catch {
			// Skip invalid regex patterns
		}
	}
	return compiled;
}

/** Strip leading `VAR=value` assignments so interceptor patterns match the real command. */
function stripInlineEnvAssignments(command: string): string {
	let rest = command.trim();
	for (;;) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/.exec(rest);
		if (!match) {
			return rest;
		}
		rest = rest.slice(match[0].length);
	}
}

/** GNU env options that consume a separate argv operand (see `env --help`). */
const ENV_OPTION_WITH_OPERAND: Record<string, true> = {
	"-u": true,
	"--unset": true,
	"-C": true,
	"--chdir": true,
	"--block-signal": true,
};

const ENV_OPTION_INLINE: Record<string, true> = {
	"-i": true,
	"--ignore-environment": true,
	"-0": true,
	"--null": true,
};

function splitShellWords(command: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	const s = command.trim();
	while (i < s.length) {
		while (i < s.length && /\s/.test(s[i]!)) {
			i++;
		}
		if (i >= s.length) {
			break;
		}
		const quote = s[i];
		if (quote === '"' || quote === "'") {
			i++;
			const start = i;
			while (i < s.length) {
				if (s[i] === "\\" && i + 1 < s.length) {
					i += 2;
					continue;
				}
				if (s[i] === quote) {
					break;
				}
				i++;
			}
			tokens.push(s.slice(start, i));
			if (i < s.length) {
				i++;
			}
			continue;
		}
		const start = i;
		while (i < s.length && !/\s/.test(s[i]!)) {
			i++;
		}
		tokens.push(s.slice(start, i));
	}
	return tokens;
}

function isEnvExecutable(token: string): boolean {
	return token === "env" || token.endsWith("/env");
}

function isEnvAssignmentToken(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** Expand `env -S` / `--split-string` operand into the command argv (GNU env splits the string). */
function envSplitStringCommandTokens(operand: string): string[] {
	return splitShellWords(operand);
}

/** Drop a leading `env` / `/usr/bin/env` argv prefix; return remaining tokens or null if none. */
function stripLeadingEnvArgv(tokens: string[]): string[] | null {
	if (tokens.length === 0 || !isEnvExecutable(tokens[0]!)) {
		return null;
	}
	let i = 1;
	while (i < tokens.length) {
		const tok = tokens[i]!;
		if (tok === "--") {
			i++;
			break;
		}
		if (tok === "-S" || tok === "--split-string") {
			i++;
			if (i >= tokens.length) {
				return [];
			}
			return envSplitStringCommandTokens(tokens[i]!);
		}
		if (tok.startsWith("--split-string=")) {
			return envSplitStringCommandTokens(tok.slice("--split-string=".length));
		}
		if (isEnvAssignmentToken(tok)) {
			i++;
			continue;
		}
		if (tok.startsWith("-")) {
			if (ENV_OPTION_INLINE[tok]) {
				i++;
				continue;
			}
			if (ENV_OPTION_WITH_OPERAND[tok]) {
				i += 2;
				continue;
			}
			const eq = tok.indexOf("=");
			if (eq > 1) {
				i++;
				continue;
			}
		}
		break;
	}
	return tokens.slice(i);
}

/**
 * Normalize `env VAR=val python -c ...` / `/usr/bin/env python -c ...` so anchored python rules match.
 */
function stripEnvWrapper(command: string): string {
	const trimmed = command.trim();
	const rest = stripLeadingEnvArgv(splitShellWords(trimmed));
	if (!rest || rest.length === 0) {
		return trimmed;
	}
	return stripInlineEnvAssignments(rest.join(" "));
}

function scriptedEditNormalizedCommand(command: string): string {
	return stripEnvWrapper(stripInlineEnvAssignments(command.trim()));
}

/** Command strings to test against a rule (raw first; normalized only for default scripted-edit rules). */
function commandMatchCandidates(command: string, rule: BashInterceptorRule): string[] {
	const trimmed = command.trim();
	if (!isDefaultScriptedEditNormalizationRule(rule)) {
		return [trimmed];
	}
	const normalized = scriptedEditNormalizedCommand(command);
	return normalized === trimmed ? [trimmed] : [trimmed, normalized];
}

/**
 * Check if a bash command should be intercepted.
 *
 * @param command The bash command to check
 * @param availableTools Set of tool names that are available
 * @returns InterceptionResult indicating if the command should be blocked
 */
export function checkBashInterception(
	command: string,
	availableTools: string[],
	rules: BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
): InterceptionResult {
	const compiled = compileRules(rules);

	for (const { rule, regex } of compiled) {
		// Only block if the suggested tool is actually available
		if (!availableTools.includes(rule.tool)) {
			continue;
		}

		const matched = commandMatchCandidates(command, rule).some(candidate => regex.test(candidate));
		if (!matched) {
			continue;
		}

		let body = rule.message;
		if (isDefaultPythonScriptedEditRule(rule)) {
			body = bashInterceptScriptedEditMessage("`python -c`");
		} else if (isDefaultNodeBunScriptedEditRule(rule)) {
			body = bashInterceptScriptedEditMessage("`node -e` / `bun -e`");
		}
		return {
			block: true,
			message: `Blocked: ${body}\n\nOriginal command: ${command}`,
			suggestedTool: rule.tool,
		};
	}

	return { block: false };
}
