/**
 * Typed Engine-side view of the canonical ClientHost storage protocol.
 *
 * The JSON Schema is owned by the Core storage package. Keep this module to
 * types and a pinned identity; do not add a second runtime schema here.
 */

export const STORAGE_PROTOCOL_SCHEMA = "artel.storage.protocol.v1" as const;
export const STORAGE_PROTOCOL_VERSION = "1.0" as const;
/** Canonical Core schema revision consumed by this Engine adapter. */
export const STORAGE_PROTOCOL_REVISION = 8 as const;
export const STORAGE_PROTOCOL_SCHEMA_HASH =
	"sha256:2d8da049a00600324c082fc32004765fbfaaf2a855f988853c3575bdb42e1954" as const;

export type StorageOperation = "write" | "barrier" | "read_range" | "read_context" | "receipt" | "health" | "metrics";

export type StorageId = string;
export type StoragePayload = Record<string, unknown>;

export interface StorageDependency {
	familyId: StorageId;
	generationId: StorageId;
	throughSeq: number;
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
	firstSeq: number;
	entries: readonly StorageEntry[];
	head?: StoragePayload;
	state?: StoragePayload;
	effect?: StoragePayload;
	durability: "buffered" | "required";
	dependencies: readonly StorageDependency[];
	payloadHash: `sha256:${string}`;
	incarnation: number;
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
	cutSeq?: number;
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

export interface StorageProtocolRequest {
	schema: typeof STORAGE_PROTOCOL_SCHEMA;
	version: typeof STORAGE_PROTOCOL_VERSION;
	operation: StorageOperation;
	write?: StorageWrite;
	barrier?: StorageBarrier;
	read?: StorageRead;
	receipt?: StorageReceiptRequest;
}

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
	| "outcome_unknown";

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
	incarnation: number;
	error?: StorageError;
}

export interface StorageWriteSuccessResponse extends StorageResponseBase {
	receipt: StorageReceipt;
	error?: never;
}

export interface StorageWriteErrorResponse extends StorageResponseBase {
	error: StorageError;
	receipt?: never;
}

export type StorageWriteResponse = StorageWriteSuccessResponse | StorageWriteErrorResponse;

export interface StorageBarrierResponse extends StorageResponseBase {
	familyId: StorageId;
	generationId: StorageId;
	throughSeq: number;
	durableThroughSeq: number;
	dependencies: readonly StorageDependency[];
}

export interface StorageReadResponse extends StorageResponseBase {
	familyId: StorageId;
	generationId: StorageId;
	throughSeq: number;
	durableThroughSeq: number;
	liveThroughSeq: number;
	events: readonly StorageReadEntry[];
	nextCursor: string | null;
}

export interface StorageReadEntry extends StorageEntry {
	seq: number;
}

export interface StorageReceiptResponse extends StorageResponseBase {
	receipt: StorageReceipt;
}

export interface StorageHealthResponse extends Omit<StorageResponseBase, "requestId"> {
	status: "ok" | "degraded" | "stopped";
	ready: boolean;
	owner: StorageId;
}

export interface StorageMetricsResponse extends Omit<StorageResponseBase, "requestId"> {
	queue: StoragePayload;
	rocksdb?: StoragePayload;
}

export type StorageProtocolResponse =
	| StorageWriteResponse
	| StorageBarrierResponse
	| StorageReadResponse
	| StorageReceiptResponse
	| StorageHealthResponse
	| StorageMetricsResponse;

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

export function storageProtocolRequest(
	operation: StorageOperation,
	request: Omit<StorageProtocolRequest, "schema" | "version" | "operation"> = {},
): StorageProtocolRequest {
	return {
		schema: STORAGE_PROTOCOL_SCHEMA,
		version: STORAGE_PROTOCOL_VERSION,
		operation,
		...request,
	};
}
