import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
}

/** Normalizes configured repetition thresholds for every tool-loop detector. */
export function normalizeToolCallLoopThreshold(threshold: number): number {
	return Number.isFinite(threshold) ? Math.max(1, Math.trunc(threshold)) : 1;
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

function canonicalizeToolCallValue(value: unknown, stripIntentFields: boolean): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item, stripIntentFields));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (stripIntentFields && (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD)) continue;
		output[key] = canonicalizeToolCallValue(input[key], stripIntentFields);
	}
	return output;
}

export interface CanonicalizeToolCallJsonOptions {
	/** Strip harness-only intent fields from tool arguments. Keep false for arbitrary tool results. */
	stripIntentFields?: boolean;
}

/** Produces a recursively key-sorted JSON representation shared by tool-loop detectors. */
export function canonicalizeToolCallJson(
	value: unknown,
	options: CanonicalizeToolCallJsonOptions = {},
): string | undefined {
	try {
		return JSON.stringify(canonicalizeToolCallValue(value, options.stripIntentFields === true));
	} catch {
		return undefined;
	}
}

function summarizeText(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

export class ToolCallLoopGuard {
	#threshold: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = normalizeToolCallLoopThreshold(options.threshold);
		this.#exemptTools = new Set(options.exemptTools);
	}

	/** Records one completed turn and returns the threshold hit, if any. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length !== 1 || this.#exemptTools.has(toolCalls[0]!.name)) {
			this.#lastHash = undefined;
			this.#count = 0;
			return null;
		}

		const toolCall = toolCalls[0]!;
		const canonicalArgs = canonicalizeToolCallJson(toolCall.arguments, { stripIntentFields: true }) ?? "";
		const hash = `${toolCall.name}:${canonicalArgs}`;
		if (hash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = hash;
			this.#count = 1;
		}

		if (this.#count !== this.#threshold) return null;
		return {
			kind: "repeated_tool_call",
			toolName: toolCall.name,
			count: this.#count,
			resultSummary: summarizeToolResult(turn.toolResults, toolCall.id),
			argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
		};
	}
}
