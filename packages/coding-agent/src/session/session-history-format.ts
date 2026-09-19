/**
 * Concise markdown transcript serializer for `history://` URLs.
 *
 * Unlike `session-dump-format.ts` (verbose `/dump` export), this emits a
 * compressed transcript: full user/assistant/developer text, tool call +
 * result pairs collapsed to single lines, thinking elided, custom messages
 * as one-liners. No system prompt, no tool catalog, no config sections.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type {
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
	FileMentionMessage,
	HookMessage,
	PythonExecutionMessage,
} from "./messages";

export interface HistoryFormatOptions {
	/** Optional H1 prepended to the transcript. */
	title?: string;
	/** Render assistant thinking blocks (default: elided). */
	includeThinking?: boolean;
	/** Render tool intent comment before tool call lines. */
	includeToolIntent?: boolean;
}

/** Max length of the primary-arg summary inside `→ tool(...)` lines. */
const PRIMARY_ARG_MAX = 120;

/** Per-tool preference order for the most informative scalar argument. */
const PRIMARY_ARG_KEYS = [
	"path",
	"file_path",
	"filePath",
	"command",
	"cmd",
	"pattern",
	"url",
	"query",
	"prompt",
	"assignment",
	"note",
	"message",
	"op",
	"name",
	"id",
] as const;

/** Collapse whitespace runs and truncate to `max` chars with an ellipsis. */
function oneLine(text: string, max = PRIMARY_ARG_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatExecutionSourcePreview(source: string): string {
	return oneLine(source);
}

/** Join the text blocks of a string-or-blocks content field. Images become `[image]`. */
function contentToText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else parts.push("[image]");
	}
	return parts.join("\n");
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function primaryArgValue(value: unknown): string {
	if (typeof value === "string" && value.length > 0) return value;
	if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === "string")) {
		return value.join(", ");
	}
	return "";
}

/** Pick the most informative scalar argument of a tool call. */
export function formatToolCallPrimaryArg(name: string, args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "";
	if (name === "grep") {
		const pattern = primaryArgValue(args.pattern);
		const paths = primaryArgValue(args.path) || primaryArgValue(args.paths);
		if (pattern && paths) return oneLine(`${pattern} @ ${paths}`);
		if (pattern) return oneLine(pattern);
		if (paths) return oneLine(paths);
	}
	if (name === "glob") {
		const paths = primaryArgValue(args.path) || primaryArgValue(args.paths);
		if (paths) return oneLine(paths);
	}
	if (name === "ast_grep") {
		const pattern = primaryArgValue(args.pat);
		if (pattern) return oneLine(pattern);
	}
	for (const key of PRIMARY_ARG_KEYS) {
		const value = args[key];
		const summary = primaryArgValue(value);
		if (summary) return oneLine(summary);
	}
	// Fallback: first non-intent string arg, then a compact JSON of the args.
	const rest: Record<string, unknown> = {};
	let restCount = 0;
	for (const key in args) {
		if (key === INTENT_FIELD) continue;
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return oneLine(value);
		rest[key] = value;
		restCount++;
	}
	if (restCount === 0) return "{}";
	try {
		return oneLine(JSON.stringify(rest));
	} catch {
		return "";
	}
}

export function formatToolCallIntentPreview(args: Record<string, unknown> | undefined): string | undefined {
	const intent = args?.[INTENT_FIELD];
	return typeof intent === "string" && intent.trim() ? oneLine(intent, 80) : undefined;
}

export function formatToolResultErrorPreview(content: string | readonly (TextContent | ImageContent)[]): string {
	return oneLine(contentToText(content).split("\n", 1)[0] ?? "");
}

/** One line per tool call: `→ read(src/foo.ts:50-80) ⇒ ok · 31 lines`. */
function toolCallLine(
	name: string,
	args: Record<string, unknown> | undefined,
	result: ToolResultMessage | undefined,
	includeToolIntent?: boolean,
): string {
	const head = `→ ${name}(${formatToolCallPrimaryArg(name, args)})`;
	let base: string;
	if (!result) {
		base = `${head} ⇒ pending`;
	} else {
		const text = contentToText(result.content);
		const lines = lineCount(text);
		const count = `${lines} ${lines === 1 ? "line" : "lines"}`;
		if (result.isError) {
			const firstLine = formatToolResultErrorPreview(result.content);
			base = firstLine ? `${head} ⇒ error · ${count} — ${firstLine}` : `${head} ⇒ error · ${count}`;
		} else {
			base = `${head} ⇒ ok · ${count}`;
		}
	}

	const formattedIntent = includeToolIntent ? formatToolCallIntentPreview(args) : undefined;
	if (formattedIntent) return `// ${formattedIntent}\n${base}`;
	return base;
}

function executionLine(
	kind: "bash" | "python",
	source: string,
	msg: BashExecutionMessage | PythonExecutionMessage,
): string {
	const status = msg.cancelled
		? "cancelled"
		: msg.exitCode !== undefined && msg.exitCode !== 0
			? `error · exit ${msg.exitCode}`
			: "ok";
	const lines = lineCount(msg.output);
	const sourcePreview = formatExecutionSourcePreview(source);
	return `→ user-${kind}! ${sourcePreview} ⇒ ${status} · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

export const PRIMARY_CONTEXT_CUSTOM_TYPES: ReadonlySet<string> = new Set(["plan-mode-context", "plan-mode-reference"]);

/** Hidden non-primary custom messages whose content is needed to understand visible transcript entries. */
const CONTEXTUAL_NON_PRIMARY_HIDDEN_CUSTOM_TYPES: Record<string, true> = {
	"image-attachment-description": true,
};

/** One-liner for custom/hook messages: `[irc] A → B: body…`. */
function customOneLiner(msg: CustomMessage | HookMessage): string {
	const details = (msg.details ?? {}) as Record<string, unknown>;
	const str = (key: string): string => (typeof details[key] === "string" ? (details[key] as string) : "");
	switch (msg.customType) {
		case "irc:incoming":
			return `[irc] ${str("from") || "?"} → me: ${oneLine(str("message"))}`;
		case "irc:relay":
			return `[irc] ${str("from") || "?"} → ${str("to") || "?"}: ${oneLine(str("body"))}`;
		case "async-result": {
			const jobs = Array.isArray(details.jobs) && details.jobs.length > 0 ? details.jobs : [details];
			const labels = jobs
				.map(job => {
					const j = (job ?? {}) as Record<string, unknown>;
					return typeof j.label === "string" && j.label ? j.label : typeof j.jobId === "string" ? j.jobId : "job";
				})
				.join(", ");
			return `[async-result] ${oneLine(labels)}`;
		}
		default:
			return `[${msg.customType}] ${oneLine(contentToText(msg.content))}`;
	}
}

/**
 * Format a session's message array as a concise markdown transcript.
 *
 * `messages` is the session's in-memory message array (or the read-only
 * equivalent loaded from a session file) — the same shapes
 * `session-dump-format.ts` consumes.
 */
export function formatSessionHistoryMarkdown(messages: unknown[], opts?: HistoryFormatOptions): string {
	const typed = messages as AgentMessage[];
	const lines: string[] = [];
	if (opts?.title) {
		lines.push(`# ${opts.title}`, "");
	}

	const resultsByCallId = new Map<string, ToolResultMessage>();
	for (const msg of typed) {
		if (msg.role === "toolResult") resultsByCallId.set(msg.toolCallId, msg);
	}
	const consumed = new Set<string>();

	for (const msg of typed) {
		switch (msg.role) {
			case "user":
			case "developer": {
				const text = contentToText(msg.content);
				if (!text.trim()) break;
				lines.push(`## ${msg.role}`, "", text, "");
				break;
			}
			case "assistant": {
				const assistantMsg = msg as AssistantMessage;
				const body: string[] = [];
				for (const block of assistantMsg.content) {
					if (block.type === "text") {
						if (block.text.trim()) body.push(block.text);
					} else if (block.type === "toolCall") {
						const result = resultsByCallId.get(block.id);
						if (result) consumed.add(block.id);
						body.push(toolCallLine(block.name, block.arguments, result, opts?.includeToolIntent));
					} else if (opts?.includeThinking && block.type === "thinking" && block.thinking.trim()) {
						body.push(`_thinking:_ ${block.thinking}`);
					}
					// redactedThinking elided entirely (no readable text)
				}
				if (body.length === 0) break;
				lines.push("## assistant", "", ...body, "");
				break;
			}
			case "toolResult": {
				// Normally consumed by its toolCall; orphans (e.g. truncated history) get their own line.
				if (consumed.has(msg.toolCallId)) break;
				lines.push(toolCallLine(msg.toolName, undefined, msg, opts?.includeToolIntent), "");

				break;
			}
			case "bashExecution": {
				const bashMsg = msg as BashExecutionMessage;
				if (bashMsg.excludeFromContext) break;
				const bashLine = executionLine("bash", bashMsg.command, bashMsg);
				lines.push(bashLine, "");

				break;
			}
			case "pythonExecution": {
				const pythonMsg = msg as PythonExecutionMessage;
				if (pythonMsg.excludeFromContext) break;
				const pythonLine = executionLine("python", pythonMsg.code, pythonMsg);
				lines.push(pythonLine, "");

				break;
			}
			case "custom":
			case "hookMessage": {
				const custom = msg as CustomMessage | HookMessage;
				if (
					custom.display === false &&
					!PRIMARY_CONTEXT_CUSTOM_TYPES.has(custom.customType) &&
					CONTEXTUAL_NON_PRIMARY_HIDDEN_CUSTOM_TYPES[custom.customType] !== true
				) {
					break;
				}
				lines.push(customOneLiner(custom), "");

				break;
			}
			case "branchSummary": {
				const branchMsg = msg as BranchSummaryMessage;
				lines.push(`[branch] from ${branchMsg.fromId}: ${oneLine(branchMsg.summary)}`, "");

				break;
			}
			case "compactionSummary": {
				const compactMsg = msg as CompactionSummaryMessage;
				lines.push(`[compaction] ${oneLine(compactMsg.summary)}`, "");

				break;
			}
			case "fileMention": {
				const fileMsg = msg as FileMentionMessage;
				lines.push(`[file-mention] ${oneLine(fileMsg.files.map(f => f.path).join(", "))}`, "");

				break;
			}
		}
	}

	return `${lines.join("\n").trim()}\n`;
}
