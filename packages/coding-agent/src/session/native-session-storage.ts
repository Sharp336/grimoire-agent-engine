import type { CheckpointRewindPrefix } from "./checkpoint-entries";
import type { SessionContextState } from "./session-context";
import type { SessionEntry, SessionHeader, SessionLaunchSnapshot, UsageStatistics } from "./session-entries";

/** State before contextStartId, not a second transcript or a reconstructed prompt. */
export interface NativeContextPrefix {
	settings: SessionContextState;
	credentialPins: Record<string, { hash: string; lastUsedAt: number }>;
	lastModelChangeRole?: string;
	hasAssistant: boolean;
	entryTypes: SessionEntry["type"][];
	todoState?: SessionEntry;
	rewind?: CheckpointRewindPrefix;
	archiveUsage?: UsageStatistics;
	/** Last archived user launch; null preserves an unannotated user message. */
	lastUserLaunchSnapshot?: SessionLaunchSnapshot | null;
}

export interface NativeSessionCheckpoint {
	schema: "omp.native.context.v1";
	header: SessionHeader;
	leafId: string | null;
	contextStartId: string | null;
	prefix: NativeContextPrefix;
}

export interface NativeSessionRead {
	checkpoint: NativeSessionCheckpoint;
	/** Ordered native entries, with original identities and parent links intact. */
	entries: SessionEntry[];
	throughSeq: number;
	position: NativeSessionPosition;
	complete: boolean;
}

export interface NativeSessionPosition {
	familyId: string;
	generationId: string;
	throughSeq: number;
	incarnation: number;
}

export interface NativeSessionTicket {
	position: NativeSessionPosition;
	/** Applied for buffered writes; durable for required writes. */
	completion: Promise<void>;
}

/** The owner explicitly rejected this operation without applying it. */
export class NativeSessionWriteRejectedError extends Error {}

/** One session/generation on the shared Engine storage client, never a JSONL facade. */
export interface NativeSessionStorage {
	readonly locator: string;
	/** Initialize a fresh generation by immutable lineage, without copying historical entries. */
	initializeFork(source: NativeSessionPosition, checkpoint: NativeSessionCheckpoint): NativeSessionTicket;
	/** Reserve finite admission synchronously or throw; never enqueue an unbounded promise tail. */
	append(
		entries: readonly SessionEntry[],
		checkpoint: NativeSessionCheckpoint,
		durability: "buffered" | "required",
	): NativeSessionTicket;
	rewrite(
		entries: readonly SessionEntry[],
		deletedIds: readonly string[],
		checkpoint: NativeSessionCheckpoint,
		appended?: readonly SessionEntry[],
	): NativeSessionTicket;
	/** Fixed prefix captured by the caller, not a drain that future writes can extend. */
	barrier(position: NativeSessionPosition): Promise<void>;
	/** Bounded pages at one frozen cut; does not visit archive entries before the checkpoint. */
	readContext(selection?: { entryId: string; expectedLeafEntryId: string }): Promise<NativeSessionRead>;
	/** Explicit expensive consumer; pagination remains bounded even when materializing the archive. */
	readArchive(): Promise<NativeSessionRead>;
	readChildren(parentId: string, position: NativeSessionPosition): Promise<SessionEntry[]>;
}
