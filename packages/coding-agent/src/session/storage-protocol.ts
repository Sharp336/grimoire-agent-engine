/**
 * Typed Engine-side view of the canonical ClientHost storage protocol.
 *
 * The JSON Schema is owned by the Core storage package. Keep this module to
 * types and a pinned identity; do not add a second runtime schema here.
 */

export const STORAGE_PROTOCOL_SCHEMA = "artel.storage.protocol.v1" as const;
export const STORAGE_PROTOCOL_VERSION = "1.0" as const;
/** Canonical Core schema revision consumed by this Engine adapter. */
export const STORAGE_PROTOCOL_REVISION = 12 as const;
export const STORAGE_PROTOCOL_SCHEMA_HASH =
	"sha256:3bb42913852ed0aae8bffd2734a70510360a1c403fd2af9a57effb438114e681" as const;

export type StorageOperation =
	| "write"
	| "barrier"
	| "read_range"
	| "read_context"
	| "read_children"
	| "receipt"
	| "health"
	| "metrics"
	| "runtime_query";

export type StorageId = string;
export type StoragePayload = Record<string, unknown>;

export interface StorageDependency {
	familyId: StorageId;
	generationId: StorageId;
	/** Safe integer prefix; zero is already satisfied. */
	throughSeq: number;
}

export interface StorageLineage {
	/** Immutable ancestry; nonzero parent cut must also be an explicit write dependency. */
	parentGenerationId: StorageId;
	forkCutSeq: number;
	forkLeafId: StorageId | null;
}

/** Native properties remain lossless; storage watermarks/fences are server-owned. */
export interface StorageNativeHead extends StoragePayload {
	/** Omission selects the final new entry; null selects the before-first-entry position. */
	leafId?: StorageId | null;
	lineage?: StorageLineage;
	contextAnchors?: StoragePayload;
	appliedThroughSeq?: never;
	durableThroughSeq?: never;
	acceptedThroughSeq?: never;
	incarnation?: never;
	firstSeq?: never;
	throughSeq?: never;
}

export interface StorageEntry {
	entryId: StorageId;
	parentId: StorageId | null;
	kind: string;
	payload: StoragePayload;
	state?: StoragePayload;
	effect?: StoragePayload;
}

export interface StorageWrite {
	requestId: StorageId;
	operationId: StorageId;
	familyId: StorageId;
	generationId: StorageId;
	/** Next contiguous reserved sequence, or appliedThroughSeq + 1 with no queued predecessor. */
	firstSeq: number;
	entries: readonly StorageEntry[];
	head?: StorageNativeHead;
	state?: StoragePayload;
	effect?: StoragePayload;
	durability: "buffered" | "required";
	dependencies: readonly StorageDependency[];
	/** JCS of the complete write, excluding only requestId/payloadHash; includes incarnation. */
	payloadHash: `sha256:${string}`;
	incarnation: number;
	runtime?: StorageRuntimeMutation;
	expectedThroughSeq?: number;
	nativeEdits?: readonly { entryId: string; entry: StorageEntry | null }[];
}

export type StorageRuntimeKind =
	| "metadata"
	| "identity"
	| "binding"
	| "attempt"
	| "command"
	| "effect"
	| "approval"
	| "inbox"
	| "hold"
	| "event"
	| "delivery"
	| "projection"
	| "session";
export interface StorageRuntimeKey {
	kind: StorageRuntimeKind;
	id: string;
}
export interface StorageRuntimeRecord extends StorageRuntimeKey {
	revision: number | null;
	value: StoragePayload | null;
}
export interface StorageRuntimeMutation {
	checks: Array<StorageRuntimeKey & { revision: number | null }>;
	puts: Array<StorageRuntimeKey & { value: StoragePayload }>;
	deletes: StorageRuntimeKey[];
}
export type StorageRuntimeIndex =
	| "identity_ref"
	| "identity_parent"
	| "identity_principal"
	| "binding_engine_agent"
	| "binding_session"
	| "binding_generation"
	| "attempt_agent"
	| "attempt_generation"
	| "command_agent_pending"
	| "command_processor"
	| "effect_attempt_call"
	| "effect_attempt"
	| "effect_generation"
	| "approval_effect"
	| "approval_state"
	| "inbox_source"
	| "inbox_session"
	| "inbox_agent_pending"
	| "inbox_agent"
	| "inbox_wake"
	| "hold_agent"
	| "event_agent"
	| "event_attempt"
	| "event_all"
	| "event_pending"
	| "delivery_pending"
	| "projection_target"
	| "session_agent"
	| "session_updated"
	| "event_projection"
	| "event_message"
	| "event_message_revision"
	| "projection_attempt"
	| "identity_root"
	| "event_lifecycle"
	| "attempt_all"
	| "kind_primary";

export interface StorageRuntimeQuery {
	requestId: string;
	incarnation: number;
	selector:
		| { type: "records"; keys: StorageRuntimeKey[] }
		| {
				type: "index";
				index: StorageRuntimeIndex;
				key: Array<string | number | null>;
				cursor?: string;
				after?: Array<string | number | null>;
		  };
	maxRecords: number;
	maxBytes: number;
}
export interface StorageRuntimeQueryResponse extends StorageResponseBase {
	records: StorageRuntimeRecord[];
	nextCursor: string | null;
	indexRevision?: number;
}

export interface StorageBarrier {
	requestId: StorageId;
	familyId: StorageId;
	generationId: StorageId;
	throughSeq: number;
	dependencies: readonly StorageDependency[];
	timeoutMs?: number;
	incarnation: number;
}

export interface StorageRead {
	requestId: StorageId;
	familyId: StorageId;
	generationId: StorageId;
	leafId?: StorageId;
	/** Inclusive ancestor boundary; the owner validates membership on the selected path. */
	startEntryId?: StorageId;
	parentId?: StorageId;
	/** Frozen cut, defaults to durableThroughSeq. Zero selects the empty prefix. */
	cutSeq?: number;
	/** Opaque token bound to kind, scope, frozen cut, leaf and traversal position. */
	cursor?: string;
	maxRecords: number;
	maxBytes: number;
	incarnation: number;
}

export interface StorageReceiptRequest {
	requestId: StorageId;
	familyId: StorageId;
	generationId: StorageId;
	operationId: StorageId;
	incarnation: number;
}

interface StorageRequestBase {
	schema: typeof STORAGE_PROTOCOL_SCHEMA;
	version: typeof STORAGE_PROTOCOL_VERSION;
}

export type StorageRequestBody =
	| { operation: "write"; write: StorageWrite; barrier?: never; read?: never; receipt?: never }
	| { operation: "barrier"; barrier: StorageBarrier; write?: never; read?: never; receipt?: never }
	| {
			operation: "read_range" | "read_context" | "read_children";
			read: StorageRead;
			write?: never;
			barrier?: never;
			receipt?: never;
	  }
	| { operation: "receipt"; receipt: StorageReceiptRequest; write?: never; barrier?: never; read?: never }
	| {
			operation: "runtime_query";
			query: StorageRuntimeQuery;
			write?: never;
			barrier?: never;
			read?: never;
			receipt?: never;
	  }
	| { operation: "health" | "metrics"; write?: never; barrier?: never; read?: never; receipt?: never };

export type StorageProtocolRequest = StorageRequestBase & StorageRequestBody;

export type StorageAdmissionState = "rejected_before_admission" | "admitted_pending" | "admitted";
export type StorageAppliedState = "not_applied" | "applied";
export type StorageDurabilityState = "not_required" | "pending" | "durable";
export type StorageOutcome =
	| "pending"
	| "success"
	| "outcome_unknown"
	| "storage_error"
	| "backpressure"
	| "conflict"
	| "schema_error"
	| "stale_incarnation";

export interface StorageReceipt {
	/** Unique within familyId; generationId/incarnation retain the original write identity. */
	operationId: StorageId;
	familyId: StorageId;
	generationId: StorageId;
	payloadHash: `sha256:${string}`;
	firstSeq: number;
	throughSeq: number;
	admissionState: StorageAdmissionState;
	appliedState: StorageAppliedState;
	durabilityState: StorageDurabilityState;
	outcome: StorageOutcome;
	error?: StorageError | null;
	incarnation: number;
}

export type StorageErrorCode =
	| "backpressure"
	| "conflict"
	| "schema_error"
	| "storage_error"
	| "stale_incarnation"
	| "sequence_gap"
	| "outcome_unknown"
	| "invalid_cursor"
	| "not_found"
	| "retryable";

export interface StorageError {
	code: StorageErrorCode;
	message: string;
	retryable: boolean;
}

export type StorageResponseSchema = "artel.storage.protocol.response.v1";

export interface StorageResponseBase {
	schema: StorageResponseSchema;
	version: typeof STORAGE_PROTOCOL_VERSION;
	requestId: StorageId;
	/** Current owner fence; an embedded receipt may retain an earlier incarnation. */
	incarnation: number;
	error?: never;
}

export interface StorageWriteSuccessResponse extends StorageResponseBase {
	receipt: StorageReceipt;
	error?: never;
}

/** Common failure for every operation; no success-only fields are fabricated. */
export interface StorageErrorResponse extends Omit<StorageResponseBase, "requestId" | "error"> {
	/** Null only for authenticated malformed input without a usable request ID. */
	requestId: StorageId | null;
	error: StorageError;
}

export type StorageWriteErrorResponse = StorageErrorResponse;
export type StorageWriteResponse = StorageWriteSuccessResponse | StorageWriteErrorResponse;

export interface StorageBarrierSuccessResponse extends StorageResponseBase {
	familyId: StorageId;
	generationId: StorageId;
	throughSeq: number;
	durableThroughSeq: number;
	dependencies: readonly StorageDependency[];
}

export type StorageBarrierResponse = StorageBarrierSuccessResponse | StorageErrorResponse;

export interface StorageReadSuccessResponse extends StorageResponseBase {
	familyId: StorageId;
	generationId: StorageId;
	/** Frozen read cut; durable/live watermarks may advance independently. */
	throughSeq: number;
	durableThroughSeq: number;
	liveThroughSeq: number;
	events: readonly StorageReadEntry[];
	nextCursor: string | null;
	head?: StorageNativeHead | null;
	state?: StoragePayload | null;
}

export type StorageReadResponse = StorageReadSuccessResponse | StorageErrorResponse;

export interface StorageReadEntry extends StorageEntry {
	seq: number;
}

export interface StorageReceiptSuccessResponse extends StorageResponseBase {
	receipt: StorageReceipt;
}

export type StorageReceiptResponse = StorageReceiptSuccessResponse | StorageErrorResponse;

export interface StorageHealthSuccessResponse extends Omit<StorageResponseBase, "requestId"> {
	status: "ok" | "degraded" | "stopped";
	ready: boolean;
	owner: StorageId;
}

export type StorageHealthResponse = StorageHealthSuccessResponse | StorageErrorResponse;

export interface StorageMetricsSuccessResponse extends Omit<StorageResponseBase, "requestId"> {
	queue: StoragePayload;
	rocksdb?: StoragePayload;
}

export type StorageMetricsResponse = StorageMetricsSuccessResponse | StorageErrorResponse;

export type StorageProtocolResponse =
	| StorageWriteResponse
	| StorageBarrierResponse
	| StorageReadResponse
	| StorageReceiptResponse
	| StorageHealthResponse
	| StorageMetricsResponse
	| StorageRuntimeQueryResponse;

/** Small transport boundary; Engine integration is intentionally deferred to S3. */
export interface StorageProtocolTransport {
	request(request: StorageProtocolRequest): Promise<StorageProtocolResponse>;
}

/**
 * Pin the consumer to the single Core-owned schema before sending requests.
 * A mismatched hash is a deployment/configuration error, never a fallback.
 */
export function assertStorageProtocolHash(hash: string): void {
	if (hash !== STORAGE_PROTOCOL_SCHEMA_HASH) {
		throw new Error(`Unsupported storage protocol schema hash: ${hash}`);
	}
}

export function storageProtocolRequest(operation: "write", request: { write: StorageWrite }): StorageProtocolRequest;
export function storageProtocolRequest(
	operation: "barrier",
	request: { barrier: StorageBarrier },
): StorageProtocolRequest;
export function storageProtocolRequest(
	operation: "read_range" | "read_context" | "read_children",
	request: { read: StorageRead },
): StorageProtocolRequest;
export function storageProtocolRequest(
	operation: "receipt",
	request: { receipt: StorageReceiptRequest },
): StorageProtocolRequest;
export function storageProtocolRequest(operation: "health" | "metrics"): StorageProtocolRequest;
export function storageProtocolRequest(
	operation: "runtime_query",
	request: { query: StorageRuntimeQuery },
): StorageProtocolRequest;
export function storageProtocolRequest(
	operation: StorageOperation,
	request: {
		write?: StorageWrite;
		barrier?: StorageBarrier;
		read?: StorageRead;
		receipt?: StorageReceiptRequest;
		query?: StorageRuntimeQuery;
	} = {},
): StorageProtocolRequest {
	return {
		schema: STORAGE_PROTOCOL_SCHEMA,
		version: STORAGE_PROTOCOL_VERSION,
		operation,
		...request,
	} as StorageProtocolRequest;
}
