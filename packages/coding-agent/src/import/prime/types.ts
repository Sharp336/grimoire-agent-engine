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
	| "destination-invalid"
	| "destination-drift"
	| "destination-apply-failed"
	| "destination-cleanup-failed"
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
	| "credentials-ambient-dependency"
	| "skills-malformed"
	| "skills-invalid-frontmatter"
	| "skills-duplicate"
	| "skills-ignored"
	| "skills-external-symlink"
	| "skills-special-file"
	| "sessions-malformed"
	| "sessions-truncated-tail"
	| "sessions-invalid-entry"
	| "sessions-duplicate-id"
	| "sessions-broken-parent"
	| "sessions-unmatched-tool-call"
	| "sessions-unmatched-tool-result"
	| "sessions-opaque-record"
	| "sessions-unsupported-entry"
	| "sessions-header-extra"
	| "sessions-child-lineage"
	| "sessions-missing-full-output"
	| "sessions-excluded-state";

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

export type PrimeSourceSnapshotTreeEntry =
	| Pick<PrimeSourceDirectory, "kind" | "domain" | "canonicalPath" | "sourceRef" | "mode">
	| Pick<PrimeSourceSymlink, "kind" | "domain" | "canonicalPath" | "sourceRef" | "mode" | "target" | "external">;

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
	readonly treeEntries: readonly PrimeSourceSnapshotTreeEntry[];
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
	readonly line?: number;
	readonly byteOffset?: number;
	readonly byteLength?: number;
}

export type PrimeSkillScope = "global" | "project";

export type PrimeSkillPayloadEntry =
	| {
			readonly kind: "file";
			readonly relativePath: string;
			readonly sourceRef: string;
			readonly mode: number;
			readonly size: number;
			readonly sha256: string;
			readonly contentBase64: string;
	  }
	| {
			readonly kind: "directory";
			readonly relativePath: string;
			readonly sourceRef: string;
			readonly mode: number;
	  }
	| {
			readonly kind: "symlink";
			readonly relativePath: string;
			readonly sourceRef: string;
			readonly mode: number;
			readonly target: string;
	  };

export interface PrimeSkillCandidate {
	readonly kind: "skill";
	readonly scope: PrimeSkillScope;
	readonly name: string;
	readonly directorySourceRef: string;
	readonly frontmatter: Readonly<Record<string, PrimeJsonValue>>;
	readonly files: readonly PrimeSkillPayloadEntry[];
}

export interface PrimeSkillParserResult {
	readonly candidates: readonly PrimeSkillCandidate[];
	readonly losses: readonly PrimeImportLoss[];
}

export type PrimeSessionJsonObject = Readonly<Record<string, PrimeJsonValue>>;
export type PrimeSessionContentBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string };
export type PrimeSessionContent = string | readonly PrimeSessionContentBlock[];
export type PrimeServiceTier = "auto" | "default" | "flex" | "scale" | "priority";
export type PrimeServiceTierFamily = "openai" | "anthropic" | "google";
export type PrimeServiceTierByFamily = Partial<Record<PrimeServiceTierFamily, PrimeServiceTier>>;
export type PrimeSessionMessage =
	| {
			readonly role: "user";
			readonly content: PrimeSessionContent;
			readonly timestamp: number;
	  }
	| {
			readonly role: "assistant";
			readonly content: readonly PrimeJsonValue[];
			readonly api: string;
			readonly provider: string;
			readonly model: string;
			readonly usage: PrimeSessionJsonObject;
			readonly stopReason: string;
			readonly timestamp: number;
			readonly responseId?: string;
			readonly errorMessage?: string;
	  }
	| {
			readonly role: "toolResult";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly content: readonly PrimeSessionContentBlock[];
			readonly isError: boolean;
			readonly details?: PrimeJsonValue;
			readonly timestamp: number;
	  }
	| {
			readonly role: "bashExecution";
			readonly command: string;
			readonly output: string;
			readonly exitCode: number | undefined;
			readonly cancelled: boolean;
			readonly excludeFromContext?: boolean;
			readonly fullOutputSourceRef?: string;
			readonly fullOutputSha256?: string;
			readonly truncated: boolean;
			readonly timestamp: number;
	  }
	| {
			readonly role: "custom";
			readonly customType: string;
			readonly content: PrimeSessionContent;
			readonly display: boolean;
			readonly details?: PrimeJsonValue;
			readonly timestamp: number;
	  };

export interface PrimeNormalizedSessionHeader {
	readonly type: "session";
	readonly version: 3;
	readonly id: string;
	readonly timestamp: string;
	readonly cwd: string;
	readonly title?: string;
	readonly parentSession?: string;
	readonly rlmDepth?: number;
	readonly lineage?: Readonly<{
		readonly parentSession?: string;
		readonly rlmDepth?: number;
		readonly child: boolean;
	}>;
}

export type PrimeNormalizedSessionEntry =
	| {
			readonly type: "message";
			readonly id: string;
			readonly parentId: string | null;
			readonly timestamp: string;
			readonly message: PrimeSessionMessage;
	  }
	| {
			readonly type: "model_change";
			readonly id: string;
			readonly parentId: string | null;
			readonly timestamp: string;
			readonly model: string;
			readonly role?: string;
	  }
	| {
			readonly type: "thinking_level_change";
			readonly id: string;
			readonly parentId: string | null;
			readonly timestamp: string;
			readonly thinkingLevel: string | null;
			readonly configured?: string | null;
	  }
	| {
			readonly type: "service_tier_change";
			readonly id: string;
			readonly parentId: string | null;
			readonly timestamp: string;
			readonly serviceTier: PrimeServiceTierByFamily | null;
	  }
	| {
			readonly type: "compaction";
			readonly id: string;
			readonly parentId: string | null;
			readonly timestamp: string;
			readonly summary: string;
			readonly firstKeptEntryId: string;
			readonly tokensBefore: number;
			readonly details?: PrimeJsonValue;
			readonly fromExtension?: boolean;
	  }
	| {
			readonly type: "branch_summary";
			readonly id: string;
			readonly parentId: string | null;
			readonly timestamp: string;
			readonly fromId: string;
			readonly summary: string;
			readonly details?: PrimeJsonValue;
			readonly fromExtension?: boolean;
	  }
	| {
			readonly type: "custom_message";
			readonly id: string;
			readonly parentId: string | null;
			readonly timestamp: string;
			readonly customType: string;
			readonly content: PrimeSessionContent;
			readonly display: boolean;
			readonly details?: PrimeJsonValue;
	  }
	| {
			readonly type: "label";
			readonly id: string;
			readonly parentId: string | null;
			readonly timestamp: string;
			readonly targetId: string;
			readonly label?: string;
	  };

export interface PrimeNormalizedSession {
	readonly kind: "session";
	readonly sourceRef: string;
	readonly sourceSha256: string;
	readonly header: PrimeNormalizedSessionHeader;
	readonly entries: readonly PrimeNormalizedSessionEntry[];
	/** Fatal parser losses prevent this session from being imported. */
	readonly fatalLossCodes?: readonly PrimeImportLossCode[];
}

export interface PrimeSessionParserResult {
	readonly sessions: readonly PrimeNormalizedSession[];
	readonly losses: readonly PrimeImportLoss[];
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
	/** Stable logical identity for the imported item. */
	readonly destinationRef: string;
	/** Canonical container or tree path guarded by this entry. */
	readonly canonicalDestinationRef?: string;
	/** Logical path when it differs from the canonical path (for example a blob sidecar). */
	readonly logicalDestinationRef?: string;
	readonly created: boolean;
	readonly priorExists: boolean;
	readonly priorSha256?: string;
	/** Digest of the guarded logical item, container, or tree. */
	readonly currentSha256: string;
	readonly nodeType: "regular-file" | "directory-tree";
	/** Digest of the container before this logical item was created. */
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
