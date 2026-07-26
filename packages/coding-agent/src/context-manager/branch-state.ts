/** True only when the state-creation leaf is an ancestor on the active branch. */
export function isContextScopeVisible(
	scopeLeafEntryId: string,
	branchEntries: readonly { readonly id: string }[],
): boolean {
	for (const entry of branchEntries) {
		if (entry.id === scopeLeafEntryId) return true;
	}
	return false;
}
