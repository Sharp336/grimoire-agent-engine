import type { Database } from "bun:sqlite";

export type StorageRepairTarget = "agent" | "history";
export type HistoryRepairSource = "sessions" | "fresh";
export type StorageRepairAction = "preserved" | "rebuilt" | "omitted" | "refused";

export interface StorageRepairFlags {
	target: StorageRepairTarget;
	historySource?: HistoryRepairSource;
	output?: string;
	apply: boolean;
	agentDir: string;
}

export interface StorageRepairObjectResult {
	name: string;
	kind: string;
	owner: string;
	action: StorageRepairAction;
	detail?: string;
}

export interface StorageRepairChecksum {
	path: string;
	sha256: string;
	size: number;
	ephemeral: boolean;
}

export interface StorageRepairResult {
	target: StorageRepairTarget;
	historySource?: HistoryRepairSource;
	apply: boolean;
	dataLoss: boolean;
	status: "ready" | "refused" | "published-with-warning";
	source: string;
	backup: string;
	candidate: string;
	backupCreated: boolean;
	candidatePublished: boolean;
	candidatePathTrusted: boolean;
	checksums: StorageRepairChecksum[];
	objects: StorageRepairObjectResult[];
	refusal?: string;
	warning?: string;
	manualNextStep: string;
}

/** Fault and race seams used only by focused storage-repair tests. */
export interface StorageRepairTestHooks {
	afterPristineCopy?: (tempDir: string) => void | Promise<void>;
	afterSessionManifestParse?: () => void | Promise<void>;
	beforeBackupWrite?: () => void | Promise<void>;
	afterBackupLink?: () => void | Promise<void>;
	beforeCandidateVerification?: () => void | Promise<void>;
	beforeCandidatePublication?: () => void | Promise<void>;
	afterCandidatePublication?: () => void | Promise<void>;
	beforeCandidateStageUnlink?: () => void | Promise<void>;
	beforeCandidateDirectorySync?: () => void | Promise<void>;
	isWindows?: () => boolean;
	onDirectorySync?: () => void;
}

export interface SourceMemberManifest {
	role: "main" | "wal" | "shm";
	path: string;
	archiveName: string;
	dev: string;
	ino: string;
	size: number;
	mtimeNs: string;
	ctimeNs: string;
	mode: number;
	uid: string;
	gid: string;
	sha256: string;
}

export interface SourceTripletManifest {
	version: 1;
	source: string;
	members: Record<"main" | "wal" | "shm", SourceMemberManifest | null>;
}

export interface CanonicalSchemaObject {
	kind: string;
	name: string;
	table: string;
	columns?: unknown[];
	indexes?: unknown[];
	foreignKeys?: unknown[];
	sql?: string;
}

export interface FrozenSqliteSnapshot {
	db: Database;
	schema: CanonicalSchemaObject[];
	versions: Record<string, string[]>;
	corruption: string[];
}

export interface PristineSnapshot {
	tempDir: string;
	manifest: SourceTripletManifest;
	paths: Record<"main" | "wal" | "shm", string | null>;
	immutable: FrozenSqliteSnapshot | null;
}
