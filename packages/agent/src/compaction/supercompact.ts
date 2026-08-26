/**
 * Supercompaction: reduce a session to its conversation.
 *
 * Every other reduction in this directory cuts on **time**: pick a boundary,
 * discard or summarize what is older, keep the recent tail verbatim. Supercompaction
 * cuts on **kind** instead. It walks the whole branch, with no recency window
 * and no size gate, and removes the three content kinds a model regenerates
 * anyway — tool results, tool-call arguments, and reasoning blocks — while
 * keeping every word of the conversation itself verbatim from the first turn.
 *
 * The dialogue is the only part of a transcript that cannot be recovered from
 * the filesystem, and across real sessions it is a few percent of the context.
 * It keeps that few percent and drops the rest.
 *
 * Tool-call *blocks* survive with their id, name, and key structure intact, so
 * call/result pairing and provider replay shape are preserved; only oversized
 * argument values are elided. Supercompacted messages drop `providerPayload` because a
 * native-history copy would otherwise serve the original bytes back on replay
 * (same contract as `provider-image-budget.ts`).
 *
 * This module is the pure layer — region detection and in-place mutation only.
 * Artifact offload, persistence, and provider-session teardown belong to the
 * caller (`SessionMaintenance.supercompact`). Layering mirrors `pruning.ts`:
 * no I/O here.
 */

import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import { findTurnStartIndex } from "./compaction";
import type { SessionEntry, SessionMessageEntry } from "./entries";
import { invalidateMessageCache } from "./message-cache";

/**
 * Longest string value kept inside a tool call's arguments. Anything longer is
 * replaced with its character count, so `read` keeps its path and `write` loses
 * its file body.
 */
const ARG_VALUE_CHARS = 160;

/** Total character budget for one call's arguments, applied after per-value capping. */
const ARG_TOTAL_CHARS = 800;

/** Longest array kept inside a tool call's arguments before the tail is counted instead. */
const ARG_MAX_ARRAY_ITEMS = 20;

/**
 * `skill` results are instructions the agent is still following, not tool
 * output, so they are never removed. Nothing else is exempt: the point of the
 * operation is that size and recency do not earn an exemption.
 */
const PROTECTED_TOOLS = ["skill"];

export interface ToolResultRegion {
	kind: "toolResult";
	entry: SessionMessageEntry;
	tokens: number;
	originalText: string;
	/** Tool name, for the recovery artifact heading. */
	label: string;
}

export interface ToolArgsRegion {
	kind: "toolArgs";
	entry: SessionMessageEntry;
	blockIndex: number;
	tokens: number;
	originalText: string;
	label: string;
	/** Arguments capped to the configured budget, ready to install. */
	replacement: Record<string, unknown>;
}

export interface ThinkingRegion {
	kind: "thinking";
	entry: SessionMessageEntry;
	blockIndex: number;
	tokens: number;
	originalText: string;
	label: string;
}

export type SupercompactRegion = ToolResultRegion | ToolArgsRegion | ThinkingRegion;

export interface SupercompactTally {
	toolResults: number;
	toolCalls: number;
	thinkingBlocks: number;
	/** Tokens held by every region before the pass. */
	tokensBefore: number;
}

/**
 * Cap one argument value. Strings above the budget collapse to a character
 * count; objects and arrays are walked so a nested file body cannot smuggle
 * itself past the cap. Numbers, booleans, and null are always small enough to
 * keep, and keeping them means numeric offsets, line ranges, and flags stay
 * readable in the trace.
 */
function capValue(value: unknown, budget: number, depth: number): unknown {
	if (typeof value === "string") {
		return value.length <= budget ? value : `<elided ${value.length} chars>`;
	}
	if (Array.isArray(value)) {
		if (depth <= 0) return `<elided ${value.length} items>`;
		const head = value.slice(0, ARG_MAX_ARRAY_ITEMS).map(item => capValue(item, budget, depth - 1));
		if (value.length > ARG_MAX_ARRAY_ITEMS) head.push(`<elided ${value.length - ARG_MAX_ARRAY_ITEMS} items>`);
		return head;
	}
	if (value !== null && typeof value === "object") {
		if (depth <= 0) return "<elided object>";
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			out[key] = capValue(inner, budget, depth - 1);
		}
		return out;
	}
	return value;
}

/**
 * Cap a whole argument object so the surviving trace fits {@link ARG_TOTAL_CHARS}.
 *
 * Three escalating steps, because per-value capping alone cannot bound the
 * total: a thousand short keys or a long numeric array stays oversized no matter
 * how small the string budget gets.
 *
 * 1. cap every value, halving the string budget while the object is too big
 * 2. drop keys from the end, since argument order puts the interesting ones first
 * 3. record how many keys went, so the trace never lies about being complete
 */
function capArguments(args: Record<string, unknown>): Record<string, unknown> {
	let budget = ARG_VALUE_CHARS;
	let capped = capValue(args, budget, 4) as Record<string, unknown>;
	while (budget > 1 && JSON.stringify(capped).length > ARG_TOTAL_CHARS) {
		budget = Math.floor(budget / 2);
		capped = capValue(args, budget, 4) as Record<string, unknown>;
	}
	if (JSON.stringify(capped).length <= ARG_TOTAL_CHARS) return capped;

	// Drop keys from the end until the object plus its own "keys elided" note
	// fits. Measuring the note inside the candidate matters: adding it after a
	// passing check is what pushed the result back over the limit.
	const keys = Object.keys(capped);
	for (let dropped = 1; dropped <= keys.length; dropped++) {
		const candidate: Record<string, unknown> = {};
		for (const key of keys.slice(0, keys.length - dropped)) candidate[key] = capped[key];
		candidate["<elided>"] = `${dropped} more keys`;
		if (JSON.stringify(candidate).length <= ARG_TOTAL_CHARS) return candidate;
	}
	return { "<elided>": `${keys.length} keys` };
}

/**
 * Index where the Nth-from-last turn begins, or 0 when the branch holds fewer
 * turns than that (every round is inside the keep window, so nothing is old
 * enough to remove).
 *
 * Turn boundaries come from {@link findTurnStartIndex} rather than a local rule,
 * so `bashExecution`, `branch_summary` and `custom_message` starts stay
 * consistent with how compaction cuts turns.
 */
function keepWindowStart(entries: SessionEntry[], keepTurns: number): number {
	let cursor = entries.length - 1;
	for (let found = 1; found <= keepTurns; found++) {
		const start = findTurnStartIndex(entries, cursor, 0);
		if (start < 0) return 0;
		if (found === keepTurns) return start;
		cursor = start - 1;
	}
	return 0;
}

/**
 * Locate every eligible region on a branch, in document order.
 *
 * Unlike the size-gated reducers there is no minimum savings and no compaction
 * boundary to respect. Pre-boundary entries are supercompacted too: they are not on
 * the wire today, but they are the bulk of the transcript, and leaving them
 * intact means a later branch navigation or reset boundary resurrects
 * everything this operation was asked to remove.
 *
 * The one exemption is `keepRecentTurns`, which stops the walk at the start of
 * the Nth-from-last user turn so recent rounds stay whole. `0` removes across the whole
 * branch.
 */
export function collectSupercompactRegions(
	entries: SessionEntry[],
	tokenizer: Tokenizer,
	keepRecentTurns: number,
): SupercompactRegion[] {
	const regions: SupercompactRegion[] = [];
	const stopIndex = keepRecentTurns > 0 ? keepWindowStart(entries, keepRecentTurns) : entries.length;

	for (let index = 0; index < stopIndex; index++) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const message = entry.message as AgentMessage;

		if (message.role === "toolResult") {
			const result = message as ToolResultMessage;
			if (PROTECTED_TOOLS.includes(result.toolName)) continue;
			if (result.prunedAt !== undefined) continue;
			// Computer-use results replay from `providerMetadata.screenshot`, not
			// from content, so rewriting the text changes nothing on the wire and
			// clearing the metadata would break the call pairing instead.
			if (result.providerMetadata?.type === "computer") continue;
			const text = result.content
				.filter((block): block is TextContent => block.type === "text")
				.map(block => block.text)
				.join("\n");
			if (text.length === 0) continue;
			regions.push({
				kind: "toolResult",
				entry: entry as SessionMessageEntry,
				// Text only. Image blocks in the same result are kept, so counting the
				// whole message would claim savings the pass does not make.
				tokens: tokenizer.countTokens(text),
				originalText: text,
				label: result.toolName,
			});
			continue;
		}

		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		for (let index = 0; index < assistant.content.length; index++) {
			const block = assistant.content[index];
			if (block.type === "toolCall") {
				const call = block as ToolCall;
				// Computer calls replay from `providerMetadata.actions`, so capping
				// the arguments would shrink nothing the provider actually reads.
				if (call.providerMetadata?.type === "computer") continue;
				const original = JSON.stringify(call.arguments ?? {});
				const replacement = capArguments(call.arguments ?? {});
				if (JSON.stringify(replacement).length >= original.length + (call.rawBlock?.length ?? 0)) continue;
				regions.push({
					kind: "toolArgs",
					entry: entry as SessionMessageEntry,
					blockIndex: index,
					tokens: tokenizer.countTokens(original + (call.rawBlock ?? "")),
					// Everything apply is about to clear, not just the arguments, so
					// the archive is a complete record of what was removed.
					originalText: JSON.stringify(
						{
							arguments: call.arguments ?? {},
							rawBlock: call.rawBlock,
							thoughtSignature: call.thoughtSignature,
							providerPayload: assistant.providerPayload,
						},
						null,
						1,
					),
					label: call.name,
					replacement,
				});
				continue;
			}
			if (block.type === "thinking" || block.type === "redactedThinking") {
				const reasoning = block as { type: string; thinking?: string; data?: string };
				const text = reasoning.thinking ?? reasoning.data ?? "";
				regions.push({
					kind: "thinking",
					entry: entry as SessionMessageEntry,
					blockIndex: index,
					tokens: text.length === 0 ? 0 : tokenizer.countTokens(text),
					// The whole block: apply deletes it outright, so its signature and
					// item id go with the text and all three belong in the archive.
					originalText: JSON.stringify(block, null, 1),
					label: block.type,
				});
			}
		}
	}

	return regions;
}

/**
 * Apply every region and return the counts.
 *
 * Ordering matters in one place: argument rewrites address blocks by index and
 * thinking removal changes the array length, so all argument rewrites for a
 * message land before that message's thinking blocks are filtered out.
 */
export function applySupercompactRegions(
	items: Array<{ region: SupercompactRegion; replacement: string }>,
): SupercompactTally {
	const tally: SupercompactTally = { toolResults: 0, toolCalls: 0, thinkingBlocks: 0, tokensBefore: 0 };
	const thinkingByEntry = new Map<SessionMessageEntry, Set<number>>();

	for (const { region, replacement } of items) {
		tally.tokensBefore += region.tokens;
		if (region.kind === "toolResult") {
			const message = region.entry.message as ToolResultMessage;
			// Only the text is replaced. Image blocks are real content, not tool
			// noise, and `/shake images` already exists for dropping them; deleting
			// them here would lose bytes the text-only archive never captured.
			const keptNonText = message.content.filter(block => block.type !== "text");
			message.content = [{ type: "text", text: replacement }, ...keptNonText];
			message.prunedAt = Date.now();
			invalidateMessageCache(message as AgentMessage);
			tally.toolResults++;
			continue;
		}
		if (region.kind === "toolArgs") {
			const message = region.entry.message as AssistantMessage;
			const block = message.content[region.blockIndex];
			if (block?.type !== "toolCall") continue;
			const call = block as ToolCall;
			// Arguments are schema-governed, so nothing fabricated goes in them: a
			// synthetic key can fail strict validation and teaches the model to emit
			// it back. The recovery id lives in the operator summary instead.
			call.arguments = region.replacement;
			// `rawBlock` is the verbatim in-band syntax that produced this call, so
			// leaving it would hand the original arguments straight back.
			call.rawBlock = undefined;
			// A thought signature is encrypted reasoning context minted over the
			// original call. Trimmed arguments make it inconsistent and Google
			// re-sends it verbatim on replay, so it goes with them. Archived.
			call.thoughtSignature = undefined;
			message.providerPayload = undefined;
			invalidateMessageCache(message as AgentMessage);
			tally.toolCalls++;
			continue;
		}
		let indexes = thinkingByEntry.get(region.entry);
		if (!indexes) {
			indexes = new Set();
			thinkingByEntry.set(region.entry, indexes);
		}
		indexes.add(region.blockIndex);
	}

	for (const [entry, indexes] of thinkingByEntry) {
		const message = entry.message as AssistantMessage;
		// Provider serializers omit empty assistant turns, so an assistant message
		// left with no blocks is correct — never invent model-authored text.
		message.content = message.content.filter((_block, index) => !indexes.has(index));
		message.providerPayload = undefined;
		invalidateMessageCache(message as AgentMessage);
		tally.thinkingBlocks += indexes.size;
	}

	return tally;
}
