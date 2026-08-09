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
	| "source-excluded"
	| "config-malformed"
	| "config-invalid-value"
	| "config-unknown-field"
	| "config-unsupported-field"
	| "models-malformed"
	| "models-invalid-value"
	| "models-unknown-field"
	| "models-unsupported-compat"
	| "models-unsupported-routing"
	| "credentials-malformed"
	| "credentials-unknown"
	| "credentials-command-ref"
	| "credentials-env-ref"
	| "credentials-oauth-relogin"
	| "credentials-ambient-dependency";

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
export type PrimeJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly PrimeJsonValue[]
	| { readonly [key: string]: PrimeJsonValue };

export type PrimeThinkingEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PrimeCredentialClassification =
	| "literal_api_key"
	| "env_or_literal_ref"
	| "command_ref"
	| "oauth_relogin"
	| "ambient_dependency"
	| "unknown";

export interface PrimeNormalizedHeaderValue {
	readonly classification: PrimeCredentialClassification;
	readonly secretOperationId?: string;
}

export interface PrimeNormalizedThinking {
	readonly mode: "effort";
	readonly efforts: readonly PrimeThinkingEffort[];
	readonly effortMap?: Readonly<Partial<Record<PrimeThinkingEffort, string>>>;
}

export interface PrimeNormalizedModel {
	readonly id: string;
	readonly name?: string;
	readonly api?: string;
	readonly baseUrl?: string;
	readonly reasoning?: boolean;
	readonly thinking?: PrimeNormalizedThinking;
	readonly input?: readonly ("text" | "image")[];
	readonly supportsTools?: boolean;
	readonly cost?: Readonly<{
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	}>;
	readonly contextWindow?: number;
	readonly headers?: Readonly<Record<string, PrimeNormalizedHeaderValue>>;
	readonly maxTokens?: number;
	readonly premiumMultiplier?: number;
	readonly omitMaxOutputTokens?: boolean;
	readonly compat?: Readonly<Record<string, PrimeJsonValue>>;
}

export interface PrimeNormalizedModelOverride {
	readonly id: string;
	readonly name?: string;
	readonly reasoning?: boolean;
	readonly thinking?: PrimeNormalizedThinking;
	readonly input?: readonly ("text" | "image")[];
	readonly cost?: Readonly<{
		readonly input?: number;
		readonly output?: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
	}>;
	readonly contextWindow?: number;
	readonly headers?: Readonly<Record<string, PrimeNormalizedHeaderValue>>;
	readonly maxTokens?: number;
	readonly compat?: Readonly<Record<string, PrimeJsonValue>>;
}

interface PrimeNormalizedModelOperationBase extends PrimeImportOperation {
	readonly kind: "models";
	readonly provider: string;
	readonly providerConfig?: Readonly<{
		readonly baseUrl?: string;
		readonly api?: string;
		readonly headers?: Readonly<Record<string, PrimeNormalizedHeaderValue>>;
		readonly compat?: Readonly<Record<string, PrimeJsonValue>>;
		readonly authHeader?: boolean;
		readonly auth?: "apiKey" | "none" | "oauth";
	}>;
	readonly providerApiKey?: {
		readonly classification: PrimeCredentialClassification;
		readonly secretOperationId?: string;
	};
}

export interface PrimeNormalizedModelDefinitionOperation extends PrimeNormalizedModelOperationBase {
	readonly modelKind: "definition";
	readonly model: PrimeNormalizedModel;
}

export interface PrimeNormalizedModelOverrideOperation extends PrimeNormalizedModelOperationBase {
	readonly modelKind: "override";
	readonly model: PrimeNormalizedModelOverride;
}

export type PrimeNormalizedModelOperation =
	| PrimeNormalizedModelDefinitionOperation
	| PrimeNormalizedModelOverrideOperation;

export interface PrimeNormalizedSettingsOperation extends PrimeImportOperation {
	readonly kind: "settings";
	readonly scope: "global" | "project";
	readonly values: Readonly<Record<string, PrimeJsonValue>>;
}

export interface PrimeCredentialMetadata {
	readonly provider: string;
	readonly classification: PrimeCredentialClassification;
	readonly sourceRef: string;
	readonly secretOperationId?: string;
}

export interface PrimeNormalizedCredentialOperation extends PrimeImportOperation {
	readonly kind: "credentials";
	readonly provider: string;
	readonly classification: PrimeCredentialClassification;
	readonly metadata: PrimeCredentialMetadata;
	readonly secretOperationId?: string;
}

export type PrimeConfigOperation =
	| PrimeNormalizedSettingsOperation
	| PrimeNormalizedModelOperation
	| PrimeNormalizedCredentialOperation;

export class ApplyOnlySecretTable {
	readonly #values = new Map<string, string>();

	add(operationId: string, secret: string): void {
		if (!/^credential-[a-f0-9]{64}$/.test(operationId)) {
			throw new Error("secret operation id must be opaque");
		}
		if (this.#values.has(operationId)) throw new Error("duplicate secret operation id");
		this.#values.set(operationId, secret);
	}

	get(operationId: string): string | undefined {
		return this.#values.get(operationId);
	}

	toJSON(): undefined {
		return undefined;
	}
}

export interface PrimeConfigParserResult {
	readonly settings: readonly PrimeNormalizedSettingsOperation[];
	readonly effectiveSettings: Readonly<Record<string, PrimeJsonValue>>;
	readonly models: readonly PrimeNormalizedModelOperation[];
	readonly credentials: readonly PrimeNormalizedCredentialOperation[];
	readonly operations: readonly PrimeConfigOperation[];
	readonly losses: readonly PrimeImportLoss[];
	readonly secretTable: ApplyOnlySecretTable;
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
