/**
 * Public shape of the `shake` operation, kept in a dependency-free leaf module
 * so slash-command registries and controllers can import `formatShakeSummary`
 * without pulling in the heavy `agent-session` module graph (which would form
 * an import cycle through the slash-command registry).
 */

/** Mode selector for `AgentSession.shake`. */
export type ShakeMode = "elide" | "images";

/** Outcome of an `AgentSession.shake` run. */
export interface ShakeResult {
	mode: ShakeMode;
	/** Whole tool-call results dropped. */
	toolResultsDropped: number;
	/** Large fenced/XML blocks dropped. */
	blocksDropped: number;
	/** Image blocks removed (images mode only). */
	imagesDropped?: number;
	/** Estimated context tokens reclaimed. */
	tokensFreed: number;
	/** Session artifact holding the dropped originals, when persisted. */
	artifactId?: string;
}

/** One-line operator summary of one `/shake` run's {@link ShakeResult}s (shared by TUI + ACP). */
export function formatShakeSummary(results: readonly ShakeResult[]): string {
	let toolResults = 0;
	let blocks = 0;
	let images = 0;
	let tokensFreed = 0;
	let ranElide = false;
	for (const result of results) {
		toolResults += result.toolResultsDropped;
		blocks += result.blocksDropped;
		images += result.imagesDropped ?? 0;
		tokensFreed += result.tokensFreed;
		if (result.mode === "elide") ranElide = true;
	}
	if (!ranElide) {
		return images === 0
			? "No images found in this session."
			: `Dropped ${images} image${images === 1 ? "" : "s"} from this session.`;
	}
	const parts: string[] = [];
	if (toolResults > 0) parts.push(`${toolResults} tool result${toolResults === 1 ? "" : "s"}`);
	if (blocks > 0) parts.push(`${blocks} block${blocks === 1 ? "" : "s"}`);
	if (images > 0) parts.push(`${images} image${images === 1 ? "" : "s"}`);
	if (parts.length === 0) return "Nothing to shake.";
	return `Shook ${parts.join(" + ")} (~${tokensFreed} tokens freed).`;
}
