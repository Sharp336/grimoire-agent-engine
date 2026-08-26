/**
 * Public shape of the `supercompact` operation, kept in a dependency-free leaf
 * module so slash-command registries and controllers can import
 * `formatSupercompactSummary` without pulling in the heavy `agent-session`
 * module graph (which would form an import cycle through the registry).
 */

/** Context reduction achieved by one supercompact pass. */
export interface SupercompactOutcome {
	toolResultsRemoved: number;
	toolCallsTrimmed: number;
	thinkingBlocksDropped: number;
	tokensBefore: number;
	tokensAfter: number;
	/** Session artifact holding every removed original, when persisted. */
	artifactId?: string;
}

/** Outcome of an `AgentSession.supercompact` run. */
export interface SupercompactResult extends SupercompactOutcome {
	/** True when it landed on a fresh fork, leaving the source session untouched. */
	forked: boolean;
	/** Session file the supercompacted history lives in, when the session is persisted. */
	sessionFile?: string;
}

/** One-line operator summary of a {@link SupercompactResult} (shared by TUI + ACP). */
export function formatSupercompactSummary(result: SupercompactResult): string {
	const parts: string[] = [];
	if (result.toolResultsRemoved > 0) {
		parts.push(`${result.toolResultsRemoved} tool result${result.toolResultsRemoved === 1 ? "" : "s"}`);
	}
	if (result.toolCallsTrimmed > 0) {
		parts.push(`${result.toolCallsTrimmed} call argument${result.toolCallsTrimmed === 1 ? "" : "s"}`);
	}
	if (result.thinkingBlocksDropped > 0) {
		parts.push(`${result.thinkingBlocksDropped} thinking block${result.thinkingBlocksDropped === 1 ? "" : "s"}`);
	}
	if (parts.length === 0) return "Nothing left to remove. the conversation is already all that remains.";

	const saved = Math.max(0, result.tokensBefore - result.tokensAfter);
	const percent = result.tokensBefore > 0 ? Math.round((saved / result.tokensBefore) * 100) : 0;
	const where = result.forked ? "Forked and reduced" : "Reduced in place";
	const recovery = result.artifactId ? ` Originals: artifact://${result.artifactId}.` : "";
	return (
		`${where}: dropped ${parts.join(", ")}. ` +
		`Context ${result.tokensBefore.toLocaleString()} -> ${result.tokensAfter.toLocaleString()} tokens (${percent}% smaller).` +
		recovery
	);
}
