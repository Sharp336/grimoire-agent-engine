import type { MemoryBackendId, MemoryBackendSearchResult } from "./types";

/**
 * Follow `aliasOf` to the session that owns worker/client lifecycle.
 * Subagent states alias the root; explicit operations must use that owner.
 */
export function resolveAliasedState<T extends { readonly aliasOf?: T }>(state: T): T;
export function resolveAliasedState<T extends { readonly aliasOf?: T }>(state: T | undefined): T | undefined;
export function resolveAliasedState<T extends { readonly aliasOf?: T }>(state: T | undefined): T | undefined {
	return state?.aliasOf ?? state;
}

export function abortedMemorySearch(backend: MemoryBackendId, query: string): MemoryBackendSearchResult {
	return { backend, query, count: 0, items: [], message: "Search aborted." };
}

export function uninitializedMemorySearch(
	backend: MemoryBackendId,
	query: string,
	label: string,
): MemoryBackendSearchResult {
	return {
		backend,
		query,
		count: 0,
		items: [],
		message: `${label} backend is not initialised for this session.`,
	};
}

/**
 * Fallback text for `/memory stats` and `/memory diagnose` when the active
 * backend's hook is missing or returns nothing.
 *
 * The `off` backend isn't a real backend a user picked among several
 * stats-capable options — it's the no-op state memory falls back to by
 * default — so it gets its own message instead of the generic
 * "not available for the X backend" template, which would otherwise read as
 * the self-contradictory "not available for the off backend".
 *
 * Shared by both the TUI (`CommandController.handleMemoryCommand`) and the
 * ACP/RPC slash-command handler so the two surfaces stay consistent.
 */
export function memoryStatsUnavailableMessage(backendId: MemoryBackendId, action: "stats" | "diagnose"): string {
	if (backendId === "off") return "Memory backend is off — there is nothing to show.";
	return `Memory ${action} is not available for the ${backendId} backend.`;
}
