import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { MemoryType } from "@oh-my-pi/pi-mnemopi/core/typed-memory";
import type { ContextDreamTaskName } from "./dreamer-registry";
import type { ContextMemoryAdapter } from "./memory";

export type ContextManagerMode = "primary" | "child" | "off";

export type ContextProjectKind = "git" | "directory";

export interface ContextProjectIdentity {
	readonly id: string;
	readonly kind: ContextProjectKind;
	readonly canonicalIdentity: string;
	readonly cwd: string;
	readonly root: string;
	readonly primaryRoot?: string;
	readonly rootCommit?: string;
	readonly remoteIdentity?: string;
}

export interface StoredContextProject extends ContextProjectIdentity {
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface ContextSessionInput {
	readonly id: string;
	readonly projectId: string;
	readonly sessionFile?: string;
	readonly mode: Exclude<ContextManagerMode, "off">;
	readonly currentLeafEntryId?: string;
	readonly historianVersion?: number;
}

export interface ContextSessionRecord extends ContextSessionInput {
	readonly activeGeneration: number;
	readonly schemaVersion: number;
	readonly lastSeenAt: number;
}

export type ContextJobKind = "historian" | "recomp" | "wrapup" | "embed" | "dreamer" | "git-index" | "maintenance";

export type ContextJobStatus = "pending" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export interface ContextJobInput {
	readonly id?: string;
	readonly projectId: string;
	readonly sessionId?: string;
	readonly kind: ContextJobKind;
	readonly task?: string;
	readonly payload?: unknown;
	readonly nextDueAt?: number;
}
export type ContextDropSource =
	| "explicit"
	| "age"
	| "superseded"
	| "useless"
	| "reasoning"
	| "smart"
	| "caveman"
	| "compartment";
export type ContextDropStatus = "queued" | "active" | "superseded";

export interface ContextDropInput {
	readonly sessionId: string;
	readonly targetTag: number;
	readonly expandedTags: readonly number[];
	readonly reason?: string;
	readonly source: ContextDropSource;
	readonly scopeLeafEntryId: string;
	readonly replacementText?: string;
	readonly status: ContextDropStatus;
	readonly eligibleAt: number;
	readonly clearReasoning?: boolean;
	readonly generation: number;
}

export interface ContextDropRecord extends ContextDropInput {
	readonly id: number;
	readonly createdAt: number;
}

export interface ContextSourceContentRecord {
	readonly sessionId: string;
	readonly tagOrdinal: number;
	readonly contentHash: string;
	readonly sessionEntryId?: string;
	readonly placeholder?: string;
	readonly createdAt: number;
}

export interface ContextJobRecord {
	readonly id: string;
	readonly projectId: string;
	readonly sessionId?: string;
	readonly kind: ContextJobKind;
	readonly task?: string;
	readonly payload?: unknown;
	readonly status: ContextJobStatus;
	readonly nextDueAt?: number;
	readonly leaseOwner?: string;
	readonly leaseUntil?: number;
	readonly heartbeatAt?: number;
	readonly attempt: number;
	readonly lastError?: string;
	readonly progress: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface ContextOnWireStats {
	readonly conversationTokens: number;
	readonly toolCallTokens: number;
	readonly totalTokens: number;
	readonly nonMessageTokens: number;
}

export interface ContextSessionRuntimeRecord extends ContextOnWireStats {
	readonly sessionId: string;
	readonly modelKey: string;
	readonly contextLimit: number;
	readonly pressurePercent: number;
	readonly executeThresholdTokens: number;
	readonly cacheTtlMs: number;

	readonly pendingSince?: number;
	readonly lastMaterializedAt?: number;
	readonly updatedAt: number;
	readonly cleanupWatermarkTag: number;
}

export interface ContextReduceResult {
	readonly status: "unavailable" | "rejected" | "queued";
	readonly requestedTags: readonly number[];
	readonly expandedTags: readonly number[];
	readonly rejected: readonly {
		readonly tagOrdinal: number;
		readonly reasons: readonly string[];
	}[];
	readonly eligibleAt?: number;
}

export interface ContextExpandResult {
	readonly status: "unavailable" | "ok";
	readonly requestedTags: readonly number[];
	readonly foundTags: readonly number[];
	readonly missingTags: readonly number[];
	readonly content: string;
	readonly artifactId?: string;
	readonly cancelledDrops: number;
}

export interface ContextStoreDiagnostics {
	readonly path: string;
	readonly schemaVersion: number;
	readonly journalMode: string;
	readonly foreignKeys: boolean;
}

export interface ContextMessageRef {
	readonly sessionId: string;
	readonly entryId?: string;
	readonly tagOrdinal: number;
	readonly contentHash: string;
	readonly role: string;
	readonly turnIndex: number;
}

export interface MessageTagRecord extends ContextMessageRef {
	readonly tokenCount: number;
	readonly createdAt: number;
	readonly supersededAt?: number;
}

export interface ContextCompartmentInput {
	readonly id?: string;
	readonly sessionId: string;
	readonly scopeLeafEntryId: string;
	readonly startTag: number;
	readonly endTag: number;
	readonly tagOrdinals: readonly number[];
	readonly title: string;
	readonly p1: string;
	readonly p2: string;
	readonly p3: string;
	readonly startDate?: string;
	readonly endDate?: string;
	readonly p1Tokens: number;
	readonly p2Tokens: number;
	readonly p3Tokens: number;
	readonly sourceHash: string;
	readonly historianVersion: number;
	readonly generation: number;
}

export interface ContextCompartmentRecord extends ContextCompartmentInput {
	readonly id: string;
	readonly active: boolean;
	readonly createdAt: number;
}

export interface ContextSessionFactInput {
	readonly id?: string;
	readonly sessionId: string;
	readonly projectId: string;
	readonly generation: number;
	readonly text: string;
	readonly category: MemoryType;
	readonly confidence: number;
	readonly scope: "session" | "project" | "user";
	readonly startTag: number;
	readonly endTag: number;
	readonly sourceTags: readonly number[];
}

export interface ContextSessionFactRecord extends ContextSessionFactInput {
	readonly id: string;
	readonly canonicalMemoryId?: string;
	readonly retrievalCount: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type ContextSearchDocumentSource = "compartment" | "session_fact" | "note" | "git_commit";
export type ContextSearchSource = "memory" | ContextSearchDocumentSource;

export interface ContextSearchDocumentInput {
	readonly id?: string;
	readonly projectId: string;
	readonly sessionId?: string;
	readonly source: ContextSearchDocumentSource;
	readonly sourceId: string;
	readonly canonicalId?: string;
	readonly contentHash: string;
	readonly title: string;
	readonly text: string;
	readonly startTag?: number;
	readonly endTag?: number;
	readonly generation: number;
	readonly active?: boolean;
}

export interface ContextSearchDocumentRecord extends ContextSearchDocumentInput {
	readonly id: string;
	readonly active: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface ContextSearchFtsRecord extends ContextSearchDocumentRecord {
	readonly rank: number;
}

export interface ContextEmbeddingRecord {
	readonly documentId: string;
	readonly provider: string;
	readonly model: string;
	readonly dimension: number;
	readonly vector: Float32Array;
	readonly contentHash: string;
	readonly createdAt: number;
}

export interface ContextNoteInput {
	readonly id?: string;
	readonly projectId: string;
	readonly sessionId?: string;
	readonly scope: "project" | "session";
	readonly category: string;
	readonly content: string;
	readonly surfaceCondition?: string;
	readonly status?: "pending" | "active" | "dismissed";
}

export interface ContextNoteRecord extends ContextNoteInput {
	readonly id: string;
	readonly status: "pending" | "active" | "dismissed";
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type ContextNoteAction = "write" | "read" | "filter" | "update" | "dismiss";

export interface ContextNoteOperation {
	readonly action: ContextNoteAction;
	readonly id?: string;
	readonly category?: string;
	readonly content?: string;
	readonly surfaceCondition?: string;
	readonly scope?: "project" | "session";
	readonly status?: "pending" | "active" | "dismissed";
}

export interface ContextNoteResult {
	readonly action: ContextNoteAction;
	readonly status: "ok" | "not_found" | "unavailable";
	readonly notes: readonly ContextNoteRecord[];
}

export interface ContextGitCommitInput {
	readonly projectId: string;
	readonly sha: string;
	readonly subject: string;
	readonly body: string;
	readonly author: string;
	readonly committedAt: number;
}

export interface ContextGitCommitRecord extends ContextGitCommitInput {
	readonly indexedAt: number;
}

export interface ContextSearchHit {
	readonly source: ContextSearchSource;
	readonly id: string;
	readonly canonicalId?: string;
	readonly contentHash: string;
	readonly title: string;
	readonly snippet: string;
	readonly score: number;
	readonly startTag?: number;
	readonly endTag?: number;
	readonly sessionId?: string;
	readonly projectId?: string;
}

export interface ContextSearchOptions {
	readonly sources?: readonly ContextSearchSource[];
	readonly limit?: number;
	readonly sessionId?: string;
	readonly signal?: AbortSignal;
}

export interface ContextSearchResult {
	readonly query: string;
	readonly hits: readonly ContextSearchHit[];
	readonly unavailableSources: readonly ContextSearchSource[];
	readonly generation: number;
}

export interface ContextEmbeddingStatus {
	readonly state: "unavailable" | "idle" | "running" | "paused" | "failed";
	readonly provider?: string;
	readonly model?: string;
	readonly pending: number;
	readonly completed: number;
	readonly progress: number;
	readonly error?: string;
}

export interface ContextHistorianRunResult {
	readonly status: "unavailable" | "busy" | "noop" | "published" | "failed";
	readonly compartments: number;
	readonly facts: number;
	readonly startTag?: number;
	readonly endTag?: number;
	readonly error?: string;
}

export interface ContextManagerStatus {
	readonly mode: ContextManagerMode;
	readonly active: boolean;
	readonly projectId?: string;
	readonly sessionId?: string;
	readonly failure?: string;
	readonly fallbackRequired?: boolean;
}

export interface ContextFlushResult {
	readonly status: "ok" | "unavailable" | "failed";
	readonly activatedDrops: number;
	readonly activeDrops: number;
	readonly queuedDrops: number;
	readonly compartments: number;
	readonly facts: number;
	readonly error?: string;
}

export interface ContextDreamRunResult {
	readonly task: ContextDreamTaskName;
	readonly status: "succeeded" | "failed" | "skipped";
	readonly changed: number;
	readonly summary: string;
	readonly jobId?: string;
}

export interface ContextDreamerStatus {
	readonly active: boolean;
	readonly running: readonly ContextDreamTaskName[];
	readonly scheduleSummary: string;
	readonly recentJobs: readonly ContextJobRecord[];
}

export interface ContextPromptAugmentResult {
	readonly status: "disabled" | "augmented" | "no-context" | "failed";
	readonly prompt: string;
	readonly augmentation?: string;
	readonly warning?: string;
}

export type ContextStatusLineState = "pending" | "historian" | "error";

export interface ContextManagerDiagnostics {
	readonly status: ContextManagerStatus;
	readonly store?: ContextStoreDiagnostics;
	readonly runtime?: ContextSessionRuntimeRecord;
	readonly tags: {
		readonly total: number;
		readonly active: number;
		readonly superseded: number;
		readonly dropped: number;
		readonly protected: number;
	};
	readonly drops: {
		readonly queued: number;
		readonly active: number;
		readonly superseded: number;
	};
	readonly compartments: {
		readonly total: number;
		readonly p1Tokens: number;
		readonly p2Tokens: number;
		readonly p3Tokens: number;
		readonly budgetTokens: number;
	};
	readonly facts: number;
	readonly notes: number;
	readonly historian: {
		readonly running: boolean;
		readonly pendingPublication: boolean;
	};
	readonly embedding: ContextEmbeddingStatus;
	readonly dreamer: ContextDreamerStatus;
	readonly jobs: readonly ContextJobRecord[];
	readonly memory: {
		readonly enabled: boolean;
		readonly available: boolean;
		readonly autoRecall: boolean;
		readonly projectBank?: string;
		readonly userBank?: string;
	};
	readonly errors: readonly string[];
}

export interface SessionContextManager {
	readonly mode: ContextManagerMode;
	readonly active: boolean;
	beginDispose(): void;
	startBackgroundMaintenance(): void;
	prepareCanonicalMessages(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
	prepareOutgoingMessages(messages: AgentMessage[]): void;
	setMemoryAdapter(adapter: ContextMemoryAdapter | undefined): void;
	getMemoryAdapter(): ContextMemoryAdapter | undefined;
	searchContext(query: string, options?: ContextSearchOptions): Promise<ContextSearchResult>;
	embeddingStatus(): ContextEmbeddingStatus;
	startEmbedding(signal?: AbortSignal): Promise<ContextEmbeddingStatus>;
	pauseEmbedding(): ContextEmbeddingStatus;
	diagnostics(): Promise<ContextManagerDiagnostics>;
	statusLineState(): ContextStatusLineState | undefined;
	flush(model?: Model, signal?: AbortSignal): Promise<ContextFlushResult>;
	indexGit(signal?: AbortSignal): Promise<number>;
	manageNote(operation: ContextNoteOperation): Promise<ContextNoteResult>;
	runDreamTasks(
		tasks: readonly ContextDreamTaskName[],
		options?: { readonly force?: boolean; readonly signal?: AbortSignal },
	): Promise<readonly ContextDreamRunResult[]>;
	dreamerStatus(): ContextDreamerStatus;
	augmentPrompt(userPrompt: string, signal?: AbortSignal): Promise<ContextPromptAugmentResult>;
	bindPersistedMessage(message: AgentMessage, entryId: string): void;
	reduceTags(requestedTags: readonly number[], reason?: string): Promise<ContextReduceResult>;
	expandTags(requestedTags: readonly number[], cancelDrops?: boolean): Promise<ContextExpandResult>;
	wrapup(messagesToKeep?: number, signal?: AbortSignal): Promise<ContextHistorianRunResult>;
	recomp(
		range?: { readonly startTag: number; readonly endTag: number },
		signal?: AbortSignal,
	): Promise<ContextHistorianRunResult>;
	transformContext(
		messages: AgentMessage[],
		signal?: AbortSignal,
		model?: Model,
		nonMessageTokens?: number,
	): Promise<AgentMessage[]>;
	decorateSystemPrompt(systemPrompt: string[], signal?: AbortSignal, memoryQuery?: string): Promise<string[]>;
	rebind(): Promise<void>;
	status(): ContextManagerStatus;
	dispose(): Promise<void>;
}
