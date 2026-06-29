import type { EditToolDetails, EditToolPerFileResult } from "./renderer";

export const MAX_EDIT_SNAPSHOT_TEXT_CHARS = 32_768;

type EditSnapshotDetails = {
	oldText?: string;
	newText?: string;
};

function hasSnapshotText(details: EditSnapshotDetails): boolean {
	return Object.hasOwn(details, "oldText") || Object.hasOwn(details, "newText");
}

function snapshotTextChars(details: EditSnapshotDetails): number {
	return (details.oldText?.length ?? 0) + (details.newText?.length ?? 0);
}

export function pruneOversizedEditSnapshots<T extends EditSnapshotDetails>(details: T): T {
	if (!hasSnapshotText(details) || snapshotTextChars(details) <= MAX_EDIT_SNAPSHOT_TEXT_CHARS) {
		return details;
	}

	const pruned: T = { ...details };
	delete pruned.oldText;
	delete pruned.newText;
	return pruned;
}

export function pruneOversizedEditPerFileResult(details: EditToolPerFileResult): EditToolPerFileResult {
	return pruneOversizedEditSnapshots(details);
}

export function pruneOversizedEditDetails(details: EditToolDetails): EditToolDetails {
	const pruned = pruneOversizedEditSnapshots(details);
	if (!pruned.perFileResults) {
		return pruned;
	}

	return {
		...pruned,
		perFileResults: pruned.perFileResults.map(pruneOversizedEditPerFileResult),
	};
}
