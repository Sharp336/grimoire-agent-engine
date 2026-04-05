/**
 * Pre-send tool output thinning.
 *
 * Reduces context size by replacing old, non-critical tool results with
 * lightweight stubs before every LLM call (via the transformContext hook).
 * Unlike pruning.ts, this does NOT mutate session entries — it operates
 * exclusively on the ephemeral message array constructed for each API call.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { DEFAULT_THINNABLE_TOOLS } from "../../config/settings-schema";

export interface ThinningConfig {
	enabled: boolean;
	/** Number of recent tool results to keep intact. */
	keepRecent: number;
	/**
	 * Allowlist of tool names whose results may be thinned.
	 * Tools NOT on this list are always preserved — safe default for unknown
	 * MCP/extension tools whose output may be expensive or non-reproducible.
	 */
	thinnableTools: string[];
}

export interface ThinningResult {
	messages: AgentMessage[];
	thinnedCount: number;
	estimatedTokensSaved: number;
}

export const DEFAULT_THINNING_CONFIG: ThinningConfig = {
	enabled: true,
	// ~1-2 heavy turns worth of tool results (debugging sessions average 5-8 calls/turn).
	// Conservative enough to rarely destroy needed context; aggressive enough to
	// delay compaction by several turns in typical sessions.
	keepRecent: 10,
	// Canonical list lives in settings-schema.ts so the schema default and this runtime
	// default cannot drift. See DEFAULT_THINNABLE_TOOLS for the inclusion criterion.
	thinnableTools: [...DEFAULT_THINNABLE_TOOLS],
};

/** Sentinel prefix used in stub text — importable for test assertions. */
export const THINNED_STUB_PREFIX = "[Prior output cleared";

/**
 * Replace old tool-result contents with a compact stub before sending
 * messages to the LLM.
 *
 * Runs before every API call via the `transformContext` hook. Preserves
 * the most recent `config.keepRecent` eligible results and results from
 * tools not on the `thinnableTools` allowlist.
 *
 * Does NOT mutate the input array or any of its elements.
 */
export function thinToolOutputs(messages: AgentMessage[], config?: Partial<ThinningConfig>): ThinningResult {
	const cfg: ThinningConfig = { ...DEFAULT_THINNING_CONFIG, ...config };

	if (!cfg.enabled || messages.length === 0) {
		return { messages, thinnedCount: 0, estimatedTokensSaved: 0 };
	}

	// Collect indices of thinning-eligible tool results in order.
	const eligibleIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "toolResult") continue;
		const tr = msg as ToolResultMessage;
		// Skip already-pruned entries — pruning owns those.
		if (tr.prunedAt !== undefined) continue;
		// Skip tools not on the allowlist — unknown tools are preserved by default.
		if (!cfg.thinnableTools.includes(tr.toolName)) continue;
		// Skip results with no content (nothing to save).
		if (!tr.content || tr.content.length === 0) continue;
		eligibleIndices.push(i);
	}

	// Nothing to thin if we have keepRecent or fewer eligible results.
	if (eligibleIndices.length <= cfg.keepRecent) {
		return { messages, thinnedCount: 0, estimatedTokensSaved: 0 };
	}

	// Indices of results that will be replaced (everything before the tail).
	const toThinIndices = new Set(eligibleIndices.slice(0, eligibleIndices.length - cfg.keepRecent));

	const result = messages.slice(); // shallow copy of the outer array
	let thinnedCount = 0;
	let estimatedTokensSaved = 0;

	for (const idx of toThinIndices) {
		const tr = messages[idx] as ToolResultMessage;

		// Estimate original size (chars / 4, same heuristic as estimateTokens).
		let chars = 0;
		for (const block of tr.content) {
			if (block.type === "text") {
				chars += block.text.length;
			} else if (block.type === "image") {
				chars += 4800; // mirrors estimateTokens image constant
			}
		}
		const originalTokens = Math.ceil(chars / 4);

		const stubText = `${THINNED_STUB_PREFIX} — ${originalTokens} tokens]`;
		const stubTokens = Math.ceil(stubText.length / 4);
		const saved = Math.max(0, originalTokens - stubTokens);

		// New message object — never mutate the original.
		const thinned: ToolResultMessage = {
			...tr,
			content: [{ type: "text", text: stubText }],
		};

		result[idx] = thinned;
		thinnedCount++;
		estimatedTokensSaved += saved;
	}

	return { messages: result, thinnedCount, estimatedTokensSaved };
}
