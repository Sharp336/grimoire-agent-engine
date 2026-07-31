import type { UserMessage } from "@oh-my-pi/pi-ai";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import {
	HiddenWorkspaceSnapshotService,
	type WorkspaceSnapshotData,
	type WorkspaceSnapshotService,
} from "../workspace-snapshot";
import { UNDO_SNAPSHOT_CUSTOM_TYPE } from "../workspace-snapshot/service";
import type { SessionManager } from "./session-manager";

export interface UndoTurnBoundaries {
	/** User message entry before which the session leaf should be reparented. */
	targetUserEntryId: string;
	/** Snapshot captured before the first assistant turn being undone. */
	restoreSnapshotId: string;
	/** Union of all files changed by the assistant turns being undone. */
	filesToRestore: string[];
	/** Original user message text to re-inject into the editor. */
	userMessageText: string;
}

export interface UndoTrackerOptions {
	sessionManager: SessionManager;
	projectRoot?: string;
	agentDataDir?: string;
	/** If false, snapshot capture is skipped entirely. */
	enabled?: boolean;
}

/**
 * Tracks per-turn workspace snapshots and resolves `/undo` operations.
 *
 * Snapshot metadata is stored as a parallel `custom` entry (Option B) so the
 * message schema stays untouched and future redo/branch features can build on
 * the same data.
 */
export class UndoTracker {
	readonly #sessionManager: SessionManager;
	readonly #projectRoot: string;
	readonly #snapshotService: WorkspaceSnapshotService;
	readonly #enabled: boolean;
	#pendingStartSnapshot: string | undefined;

	constructor(options: UndoTrackerOptions) {
		this.#sessionManager = options.sessionManager;
		this.#projectRoot = options.projectRoot ?? options.sessionManager.getCwd();
		this.#enabled = options.enabled ?? true;
		this.#snapshotService = new HiddenWorkspaceSnapshotService({
			projectRoot: this.#projectRoot,
			agentDataDir: options.agentDataDir ?? getAgentDir(),
		});
	}

	async isSupported(): Promise<boolean> {
		if (!this.#enabled) return false;
		return this.#snapshotService.isSupported();
	}

	/**
	 * Call before running the assistant for a user message. Captures the
	 * workspace state that will be restored if this turn is undone.
	 */
	async onUserTurnStart(): Promise<void> {
		if (!this.#enabled) return;
		this.#pendingStartSnapshot = await this.#snapshotService.capture();
	}

	/**
	 * Call after the assistant turn ends and its messages are persisted. Records
	 * which files changed and closes out the snapshot metadata entry.
	 */
	async onAssistantTurnEnd(): Promise<void> {
		if (!this.#enabled) return;
		const startSnapshot = this.#pendingStartSnapshot;
		this.#pendingStartSnapshot = undefined;
		if (!startSnapshot) return;
		const endSnapshot = await this.#snapshotService.capture();
		if (!endSnapshot) return;
		const changedFiles = await this.#snapshotService.listChangedFiles(startSnapshot, endSnapshot);
		if (changedFiles.length === 0) return;
		const targetUserEntryId = findLastUserEntryId(this.#sessionManager);
		if (!targetUserEntryId) return;
		const data: WorkspaceSnapshotData = {
			refEntryId: targetUserEntryId,
			startSnapshot,
			endSnapshot,
			changedFiles,
		};
		this.#sessionManager.appendCustomEntry(UNDO_SNAPSHOT_CUSTOM_TYPE, data);
	}

	/**
	 * Resolve `/undo [howMuch]` to concrete boundaries.
	 *
	 * `howMuch` is the number of user/assistant turn pairs to roll back.
	 * Defaults to 1. Returns undefined when there is nothing to undo or the
	 * snapshot metadata is missing.
	 */
	resolveUndo(howMuchRaw?: string): UndoTurnBoundaries | undefined {
		const howMuch = Math.max(1, parseInt(howMuchRaw ?? "1", 10));
		const branch = this.#sessionManager.getBranch();
		let remaining = howMuch;
		let targetUserEntryId: string | undefined;
		let restoreSnapshotId: string | undefined;
		let filesToRestore: string[] | undefined;
		let userMessageText = "";
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "custom" && entry.customType === UNDO_SNAPSHOT_CUSTOM_TYPE) {
				const data = entry.data as WorkspaceSnapshotData | undefined;
				if (!data) continue;
				if (remaining === howMuch) {
					filesToRestore = [...data.changedFiles];
				} else {
					filesToRestore?.push(...data.changedFiles);
				}
				restoreSnapshotId = data.startSnapshot;
				if (--remaining === 0) {
					targetUserEntryId = data.refEntryId;
					break;
				}
			}
		}
		if (!targetUserEntryId || !restoreSnapshotId || !filesToRestore) return undefined;
		const userEntry = this.#sessionManager.getEntry(targetUserEntryId);
		if (userEntry?.type === "message" && userEntry.message.role === "user") {
			userMessageText = extractUserMessageText(userEntry.message);
		}
		return {
			targetUserEntryId,
			restoreSnapshotId,
			filesToRestore: [...new Set(filesToRestore)],
			userMessageText,
		};
	}

	async restoreFiles(boundaries: UndoTurnBoundaries): Promise<void> {
		await this.#snapshotService.restore(boundaries.restoreSnapshotId, boundaries.filesToRestore);
	}

	getProjectRoot(): string {
		return this.#projectRoot;
	}
}

function findLastUserEntryId(sessionManager: SessionManager): string | undefined {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") {
			return entry.id;
		}
	}
	return undefined;
}

function extractUserMessageText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}
