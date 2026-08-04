/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead.
 */
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../config/settings-schema";
import { extractFlatShellCommandStages, tokenizeShellSegments } from "./shell-tokenize";

export interface InterceptionResult {
	/** If true, the bash command should be blocked */
	block: boolean;
	/** Error message to return instead of executing */
	message?: string;
	/** Suggested tool to use instead */
	suggestedTool?: string;
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

/** Finds the end of a shell word, respecting quotes and escapes; returns null for incomplete syntax. */
function skipShellWord(command: string, start: number): number | null {
	let inSingle = false;
	let inDouble = false;
	for (let i = start; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (i + 1 >= command.length) return null;
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return null;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") return i;
	}
	return inSingle || inDouble ? null : command.length;
}

/** Removes leading `NAME=value` assignments without interpreting shell syntax. */
function withoutLeadingEnvironmentAssignments(command: string): string | null {
	let index = 0;
	let foundAssignment = false;
	while (index < command.length) {
		while (command[index] === " " || command[index] === "\t") index++;
		const assignmentStart = index;
		if (!/[A-Za-z_]/.test(command[index] ?? "")) break;
		let nameEnd = index + 1;
		while (/[A-Za-z0-9_]/.test(command[nameEnd] ?? "")) nameEnd++;
		if (command[nameEnd] !== "=") {
			return foundAssignment ? command.slice(assignmentStart).trimStart() : null;
		}
		const wordEnd = skipShellWord(command, nameEnd + 1);
		if (wordEnd === null) return null;
		foundAssignment = true;
		index = wordEnd;
		if (index === command.length) return null;
	}
	if (!foundAssignment) return null;
	const commandWithoutAssignments = command.slice(index).trimStart();
	return commandWithoutAssignments.length > 0 ? commandWithoutAssignments : null;
}

/**
 * Commands whose input is stdin unless a path operand is supplied. A dedicated
 * path-searching tool cannot stand in for one of these when it runs as a
 * pipeline stage filtering the previous command stdout.
 */
const STDIN_FILTER_COMMANDS = new Set(["grep", "egrep", "fgrep", "rgrep", "rg", "ripgrep", "ag", "ack", "ack-grep"]);

/** Suggested tools that search paths and cannot read the bash pipeline stdin. */
const PATH_ONLY_TOOLS = new Set(["grep"]);

/** Options that supply the pattern, so no bare pattern operand follows. */
const PATTERN_OPTIONS = new Set(["-e", "-f", "--regexp", "--file"]);

/** Options that consume the next token as a value rather than a search path. */
const VALUE_OPTIONS = new Set([
	"-e",
	"-f",
	"-m",
	"-A",
	"-B",
	"-C",
	"--regexp",
	"--file",
	"--max-count",
	"--after-context",
	"--before-context",
	"--context",
	"--color",
	"--colour",
	"--include",
	"--exclude",
	"--exclude-dir",
	"--label",
]);

const REDIRECTION_TOKEN = /^\d*(?:>>|>&|&>|<<|<|>)/;
const BARE_REDIRECTION_TOKEN = /^\d*(?:>>|>&|&>|<<|<|>)$/;
const ENVIRONMENT_ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function commandWordBasename(word: string): string {
	const normalized = word.replaceAll("\\", "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * True when the stage is a grep-style filter invoked without any path operand,
 * so the only thing it can read is the stdin it inherits from the pipeline.
 * Anything this small scanner cannot account for returns false, which keeps the
 * previous interception behaviour.
 */
function isStdinOnlyFilterStage(stage: string): boolean {
	const words = tokenizeShellSegments(stage)[0];
	if (!words || words.length === 0) return false;
	let index = 0;
	while (index < words.length && ENVIRONMENT_ASSIGNMENT_TOKEN.test(words[index] ?? "")) index++;
	const commandWord = words[index];
	if (!commandWord || !STDIN_FILTER_COMMANDS.has(commandWordBasename(commandWord))) return false;

	let patternSeen = false;
	for (let i = index + 1; i < words.length; i++) {
		const word = words[i] ?? "";
		if (word === "--") {
			const operands = words.length - (i + 1);
			return operands <= (patternSeen ? 0 : 1);
		}
		if (REDIRECTION_TOKEN.test(word)) {
			// A redirection target is not a search path.
			if (BARE_REDIRECTION_TOKEN.test(word)) i++;
			continue;
		}
		if (word.startsWith("-") && word.length > 1) {
			if (PATTERN_OPTIONS.has(word)) {
				patternSeen = true;
				i++;
				continue;
			}
			if (VALUE_OPTIONS.has(word)) {
				i++;
				continue;
			}
			if (word.startsWith("--")) continue;
			// Bundled short flags: a trailing -e/-f still consumes the next word.
			const lastFlag = word.at(-1);
			if (lastFlag === "e" || lastFlag === "f") {
				patternSeen = true;
				i++;
			}
			continue;
		}
		if (!patternSeen) {
			patternSeen = true;
			continue;
		}
		// A second bare operand is a search path a path-based tool can handle.
		return false;
	}
	return true;
}

interface InterceptionCandidate {
	/** Text matched against the configured rule patterns. */
	text: string;
	/**
	 * True when the candidate is a pipeline stage whose only input is stdin, so
	 * rules suggesting a path-based tool must not apply to it.
	 */
	stdinOnlyPipelineStage: boolean;
}

function interceptionCandidates(command: string): InterceptionCandidate[] {
	const candidates: InterceptionCandidate[] = [{ text: command.trim(), stdinOnlyPipelineStage: false }];
	for (const stage of extractFlatShellCommandStages(command)) {
		const stdinOnlyPipelineStage = stage.consumesPipelineStdin && isStdinOnlyFilterStage(stage.text);
		candidates.push({ text: stage.text.trim(), stdinOnlyPipelineStage });
		const withoutAssignments = withoutLeadingEnvironmentAssignments(stage.text);
		if (withoutAssignments) candidates.push({ text: withoutAssignments, stdinOnlyPipelineStage });
	}
	return candidates;
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
	originalCommand = command,
): InterceptionResult {
	const compiled = compileRules(rules);
	const candidates = interceptionCandidates(command);

	for (const { rule, regex } of compiled) {
		// Only block if the suggested tool is actually available
		if (!availableTools.includes(rule.tool)) {
			continue;
		}

		for (const candidate of candidates) {
			// The suggested tool searches paths, so it cannot replace a stage
			// that only filters the stdin handed to it by the pipeline.
			if (candidate.stdinOnlyPipelineStage && PATH_ONLY_TOOLS.has(rule.tool)) continue;
			// A configured global or sticky regex carries state across calls.
			regex.lastIndex = 0;
			if (regex.test(candidate.text)) {
				return {
					block: true,
					message: `Blocked: ${rule.message}\n\nOriginal command: ${originalCommand}`,
					suggestedTool: rule.tool,
				};
			}
		}
	}

	return { block: false };
}
