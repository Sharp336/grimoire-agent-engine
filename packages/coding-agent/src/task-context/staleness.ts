export interface StalenessResult {
	/** The computed hash of the file on disk, or '' if the file is missing. */
	contentHash: string;
	/** Whether the file has changed since the summary was written. */
	stale: boolean;
	/** Whether the file no longer exists on disk. */
	missing: boolean;
}

/**
 * Compute the content hash of a file using Bun.hash (xxHash64).
 * Returns '' if the file does not exist (no error thrown).
 *
 * Per AGENTS.md: use `Bun.hash()` for hashing, NOT `node:crypto`.
 * The codebase uses Bun.hash for content hashing throughout
 * (e.g. noop-loop-guard.ts:98 `Bun.hash(input).toString(16)`).
 */
export async function computeFileHash(filePath: string): Promise<string> {
	try {
		const contents = await Bun.file(filePath).text();
		return Bun.hash(contents).toString(16);
	} catch {
		// File doesn't exist or can't be read — return empty hash.
		// Don't log every missing file (common when summarizing not-yet-saved files).
		return "";
	}
}

/**
 * Check whether a summary is stale by comparing the stored content_hash
 * to the current file on disk.
 *
 * - Hashes match → not stale
 * - Hashes differ → stale (file changed)
 * - File missing + stored hash was '' → stale, missing (file was never saved)
 * - File missing + stored hash was non-empty → stale, missing (file was deleted)
 */
export async function checkStaleness(filePath: string, storedHash: string): Promise<StalenessResult> {
	const currentHash = await computeFileHash(filePath);
	const missing = currentHash === "";
	const stale = missing || currentHash !== storedHash;
	return { contentHash: currentHash, stale, missing };
}
