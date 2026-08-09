export const PRIME_IMPORT_SCHEMA_VERSION = 1 as const;

export type PrimeImportDomain =
	| "config"
	| "settings"
	| "models"
	| "credentials"
	| "skills"
	| "sessions"
	| "artifacts"
	| "excluded-state";

export type PrimeImportLossCode =
	| "source-missing"
	| "source-unreadable"
	| "source-invalid-layout"
	| "source-unsupported"
	| "source-symlink"
	| "source-external-symlink"
	| "source-path-escape"
	| "source-oversized"
	| "source-budget-exceeded"
	| "source-drift"
	| "source-type-changed"
	| "source-changed"
	| "source-excluded";

export type PrimeSourceEntryKind = "file" | "directory" | "symlink";

export interface PrimeSourceMetadata {
	readonly kind: PrimeSourceEntryKind;
	readonly domain: PrimeImportDomain;
	readonly canonicalPath: string;
	readonly sourceRef: string;
	readonly mode: number;
	readonly mtimeMs: number;
}

export interface PrimeSourceFile extends PrimeSourceMetadata {
	readonly kind: "file";
	readonly size: number;
	readonly sha256: string;
	readonly contentBase64: string;
}

export interface PrimeSourceDirectory extends PrimeSourceMetadata {
	readonly kind: "directory";
}

export interface PrimeSourceSymlink extends PrimeSourceMetadata {
	readonly kind: "symlink";
	readonly target?: string;
	readonly external: boolean;
}

export type PrimeSourceRecord = PrimeSourceFile | PrimeSourceDirectory | PrimeSourceSymlink;
export interface PrimeSourceSnapshot {
	readonly schemaVersion: typeof PRIME_IMPORT_SCHEMA_VERSION;
	readonly snapshotId: string;
	readonly sourceRoot: string;
	readonly cwd: string;
	readonly sessionRoot: string;
	readonly maxFileBytes: number;
	readonly maxTotalBytes: number;
	readonly maxEntries: number;
	readonly primeCliConfigPath?: string;
	readonly files: readonly Omit<PrimeSourceFile, "contentBase64">[];
}

export interface PrimeImportSourceOptions {
	readonly sourceRoot: string;
	readonly cwd: string;
	readonly sessionRoot?: string;
	readonly primeCliConfigPath?: string;
	readonly maxFileBytes?: number;
	readonly maxTotalBytes?: number;
	readonly maxEntries?: number;
}

export interface PrimeSourceExcludedEntry {
	readonly domain: "excluded-state";
	readonly sourceRef: string;
	readonly canonicalPath: string;
	readonly kind: PrimeSourceEntryKind;
	readonly reason: "kernel" | "harness" | "rlm" | "schedule" | "lease" | "heartbeat" | "runtime";
}

export interface PrimeImportSourceInventory {
	readonly records: readonly PrimeSourceRecord[];
	readonly files: readonly PrimeSourceFile[];
	readonly excluded: readonly PrimeSourceExcludedEntry[];
}

export interface PrimeImportLoss {
	readonly code: PrimeImportLossCode;
	readonly domain: PrimeImportDomain;
	readonly sourceRef: string;
	readonly path?: string;
}

export interface PrimeImportSourceDiscovery {
	readonly snapshot: PrimeSourceSnapshot;
	readonly inventory: PrimeImportSourceInventory;
	readonly losses: readonly PrimeImportLoss[];
}

export interface PrimeImportOperation {
	readonly kind: PrimeImportDomain;
	readonly sourceRefs: readonly string[];
}

export interface PrimeImportItemResult {
	readonly itemId: string;
	readonly kind: PrimeImportDomain;
	readonly sourceRefs: readonly string[];
	readonly outcome: "planned" | "imported" | "skipped" | "lost";
	readonly lossCodes?: readonly PrimeImportLossCode[];
}

export interface PrimeImportPlan {
	readonly schemaVersion: typeof PRIME_IMPORT_SCHEMA_VERSION;
	readonly snapshotId: string;
	readonly operations: readonly PrimeImportOperation[];
}

export interface PrimeRollbackManifestEntry {
	readonly itemId: string;
	readonly kind: PrimeImportDomain;
	readonly destinationRef: string;
	readonly preconditionSha256?: string;
}

export interface PrimeRollbackManifest {
	readonly schemaVersion: typeof PRIME_IMPORT_SCHEMA_VERSION;
	readonly snapshotId: string;
	readonly entries: readonly PrimeRollbackManifestEntry[];
}

export interface PrimeImportReport {
	readonly schemaVersion: typeof PRIME_IMPORT_SCHEMA_VERSION;
	readonly snapshotId: string;
	readonly items: readonly PrimeImportItemResult[];
	readonly losses: readonly PrimeImportLoss[];
	readonly partialApply: boolean;
	readonly rollbackManifest?: PrimeRollbackManifest;
}

export interface PrimeSourceDrift {
	readonly ok: boolean;
	readonly losses: readonly PrimeImportLoss[];
}
