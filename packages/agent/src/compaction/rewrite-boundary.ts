import type { SessionEntry } from "./entries";

/** Resolve the inclusive history-rewrite floor shared by prune and shake. */
export function resolveHistoryRewriteStartIndex(
	entries: readonly SessionEntry[],
	rewriteStartIndex: number | undefined,
	keepBoundaryId: string | undefined,
): number {
	if (rewriteStartIndex !== undefined) {
		if (!Number.isFinite(rewriteStartIndex)) return entries.length;
		return Math.min(entries.length, Math.max(0, Math.floor(rewriteStartIndex)));
	}
	if (keepBoundaryId === undefined) return 0;
	const legacyIndex = entries.findIndex(entry => entry.id === keepBoundaryId);
	return legacyIndex < 0 ? 0 : legacyIndex;
}
