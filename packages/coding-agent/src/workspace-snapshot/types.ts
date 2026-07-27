export interface WorkspaceSnapshotService {
	/**
	 * Whether snapshots can be captured for this project. Returns false when git
	 * is unavailable, the project path is invalid, or snapshots are disabled.
	 */
	isSupported(): Promise<boolean>;

	/**
	 * Capture the current filesystem state as a content-addressed git tree.
	 * Returns the tree SHA, or undefined if snapshots are disabled/unsupported.
	 */
	capture(): Promise<string | undefined>;

	/**
	 * Restore the given project-relative paths to the state in `snapshotId`.
	 * Files that did not exist in the snapshot are deleted. Paths outside the
	 * project root are rejected.
	 */
	restore(snapshotId: string, files: readonly string[]): Promise<void>;

	/**
	 * List project-relative paths that differ between two captured snapshots.
	 */
	listChangedFiles(fromSnapshotId: string, toSnapshotId: string): Promise<string[]>;
}

export interface WorkspaceSnapshotOptions {
	/** Root directory that owns the snapshot repo. */
	projectRoot: string;
	/** Base agent data directory; snapshots live under `<agentDataDir>/snapshots/`. */
	agentDataDir: string;
	/** Skip untracked files larger than this many bytes. Tracked files are always captured. */
	maxUntrackedFileBytes?: number;
}

export interface WorkspaceSnapshotData {
	refEntryId: string;
	startSnapshot: string;
	endSnapshot: string;
	changedFiles: string[];
}
