/**
 * Tool output pruning utilities for compaction.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { DEFAULT_THINNABLE_TOOLS } from "../../config/settings-schema";
import type { SessionEntry, SessionMessageEntry } from "../session-manager";
import { estimateTokens } from "./compaction";

export interface PruneConfig {
	/**
	 * Fraction of the context window to protect from pruning (0–1).
	 * The most recent tool outputs totalling this share of the window are kept intact.
	 */
	protectFraction: number;
	/** Skip pruning unless estimated savings exceed this token count. */
	minimumSavings: number;
	/**
	 * Allowlist of tool names eligible for permanent pruning from session history.
	 * This is a strict SUBSET of the thinning allowlist — some reproducible tools
	 * (notably `read`) are thinnable in ephemeral sends but kept in session history
	 * so checkpoint/rewind and user inspection remain faithful to what the model saw.
	 */
	prunableTools: string[];
}

/**
 * Tools that produce reproducible output (so they can be THINNED from ephemeral
 * LLM sends) but whose raw content must REMAIN in the persistent session history.
 * - `read`: users rely on scrolling back to see what the model read from their files.
 * - `skill`: skill instructions are the model's working context; removing them from
 *   history would erase the rationale for subsequent actions.
 */
const PRUNE_PROTECTED_TOOLS = new Set(["read", "skill"]);

const DEFAULT_PRUNABLE_TOOLS: readonly string[] = DEFAULT_THINNABLE_TOOLS.filter(t => !PRUNE_PROTECTED_TOOLS.has(t));

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	// 20% of context window — protects the last ~1–2 heavy turns regardless of model size.
	protectFraction: 0.2,
	minimumSavings: 5_000,
	prunableTools: [...DEFAULT_PRUNABLE_TOOLS],
};

// Cap prevents runaway budget on large-context models (1M+).
// Without this, 20% of 1M = 200K protected — more than an entire 128K context.
const MAX_PROTECT_TOKENS = 80_000;

/**
 * Conservative fallback context window used when the active model's metadata is
 * unavailable. Matches the historical assumption for Claude Sonnet class models.
 * Exported so callers can pass `model?.contextWindow ?? 0` and let
 * `resolveProtectTokens` decide the fallback — avoiding magic numbers at call sites.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function resolveProtectTokens(config: PruneConfig, contextWindow: number): number {
	// Treat 0/negative as "unknown" and fall back to the default. Without this
	// guard, an unknown context window would produce a 0-token protection budget
	// and aggressively prune the most recent tool results — the wrong failure mode.
	const effective = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
	return Math.min(MAX_PROTECT_TOKENS, Math.floor(effective * config.protectFraction));
}

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
}

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number): number {
	const noticeTokens = Math.ceil(createPrunedNotice(tokens).length / 4);
	return Math.max(0, tokens - noticeTokens);
}

export function pruneToolOutputs(
	entries: SessionEntry[],
	contextWindow: number,
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): PruneResult {
	// Compute once — the protection budget does not change across entries.
	const protectTokens = resolveProtectTokens(config, contextWindow);

	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	const candidates: Array<{ entry: SessionMessageEntry; tokens: number }> = [];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = estimateTokens(message as AgentMessage);
		const isEligible = config.prunableTools.includes(message.toolName);

		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}

		if (accumulatedTokens < protectTokens || !isEligible) {
			accumulatedTokens += tokens;
			continue;
		}

		candidates.push({ entry: entry as SessionMessageEntry, tokens });
		accumulatedTokens += tokens;
	}

	for (const candidate of candidates) {
		tokensSaved += estimatePrunedSavings(candidate.tokens);
	}

	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0 };
	}

	const prunedAt = Date.now();
	for (const candidate of candidates) {
		const message = candidate.entry.message as ToolResultMessage;
		message.content = [{ type: "text", text: createPrunedNotice(candidate.tokens) }];
		message.prunedAt = prunedAt;
		prunedCount++;
	}

	return { prunedCount, tokensSaved };
}
