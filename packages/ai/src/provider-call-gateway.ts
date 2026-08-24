import { createHash, randomUUID } from "node:crypto";

import {
	assertProviderCallOrigin,
	resolveProviderCallOriginBinding,
	validateProviderCallOriginAssignment,
} from "./provider-call-origin-manifest";
import type {
	Api,
	FetchImpl,
	Model,
	ProviderCallContext,
	ProviderCallGateway,
	ProviderCallGatewayRequest,
	SimpleStreamOptions,
} from "./types";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const REQUEST_MAGIC = encoder.encode("TBPCW002");
const RESPONSE_MAGIC = encoder.encode("TBPCR003");
const REQUEST_SCHEMA = "terminal-bench/provider-call-worker-request/v2";
const RESPONSE_SCHEMA = "terminal-bench/provider-call-worker-response/v7";
const ENTITY_SCHEMA = "terminal-bench/provider-http-entity-response/v3";
const SUMMARY_SCHEMA = "terminal-bench/provider-call-summary/v7";
const ERROR_SCHEMA = "terminal-bench/provider-call-error/v2";
const HEADER_SCHEMA = "terminal-bench/provider-terminal-header/v3";
const MAX_WORKER_HEADER_BYTES = 1_048_576;
const MAX_WORKER_REQUEST_PAYLOAD_BYTES = 16_777_216;
const MAX_WORKER_RESULT_JSON_BYTES = 50_331_648;
const MAX_CALLER_RESPONSE_BODY_BYTES = 33_554_432;
const MAX_TERMINAL_HEADER_BYTES = 1_048_576;
const MAX_RESPONSE_FRAME_BYTES = 88 + MAX_WORKER_HEADER_BYTES + MAX_WORKER_RESULT_JSON_BYTES;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

const RESULT_FIELDS = [
	"schema",
	"worker_operation_id",
	"result_kind",
	"result_schema",
	"result_sha256",
	"result_bytes",
] as const;
const ENTITY_FIELDS = [
	"schema",
	"http_status",
	"http_version",
	"headers",
	"trailers",
	"body_sha256",
	"body_bytes",
	"body_base64",
] as const;
const TERMINAL_HEADER_FIELDS = ["schema", "name", "value_base64"] as const;
const ERROR_FIELDS = ["schema", "code", "message", "reservation_id"] as const;
const SUMMARY_FIELDS = [
	"schema",
	"reservation_id",
	"reservation_sha256",
	"state",
	"task_reservation_id",
	"provider_route_assignment_id",
	"execution_binding_id",
	"pod_uid",
	"call_sequence",
	"request_sha256",
	"consume_operation_id",
	"consume_context_sha256",
	"dispatch_epoch_id",
	"dispatch_claim_sha256",
	"gateway_principal_sha256",
	"backend_identity_sha256",
	"backend_equality_result",
	"consumed_at",
	"receipt_due_at",
	"receipt_operation_id",
	"provider_request_id",
	"response_sha256",
	"response_body_bytes",
	"completed_at",
	"terminal_error_code",
] as const;

const ALLOWED_HEADER_NAMES = new Set([
	"anthropic-request-id",
	"cache-control",
	"content-encoding",
	"content-length",
	"content-type",
	"openai-request-id",
	"request-id",
	"retry-after",
	"x-error-code",
	"x-goog-request-id",
	"x-request-id",
	"x-should-retry",
]);
const ALLOWED_TRAILER_NAMES = new Set([
	"anthropic-request-id",
	"openai-request-id",
	"request-id",
	"x-error-code",
	"x-goog-request-id",
	"x-request-id",
	"x-should-retry",
]);

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
	already_receipted: "reservation already has a different receipt",
	arithmetic_out_of_range: "provider reservation arithmetic is out of range",
	assignment_mismatch: "provider route assignment does not match",
	authentication_required: "authentication is required",
	backend_equality_mismatch: "authenticated backend identity does not match consumed attempt",
	caller_response_too_large: "caller response body exceeds the frozen 33554432-byte cap",
	caller_result_binding_mismatch:
		"caller result lookup does not match the committed worker operation/frame/idempotency binding",
	capability_not_ready: "selected provider capability is not READY",
	consume_context_mismatch: "consume context does not match durable consume",
	consume_operation_conflict: "consume operation differs from durable consume",
	control_envelope_too_large: "controller or worker envelope exceeds its operation-specific frozen cap",
	control_metadata_too_large: "canonical non-body control metadata exceeds the frozen 1048576-byte cap",
	dispatch_epoch_conflict: "dispatch epoch differs from the permanent claim",
	duplicate_json_key: "request contains a duplicate JSON object key",
	durable_integrity_failure: "durable provider authority integrity failure",
	endpoint_forbidden: "authenticated principal is not allowed on this endpoint",
	evidence_invalid: "provider input hard-max evidence is invalid",
	evidence_review_invalid: "provider input hard-max review is invalid",
	exclusive_authority_invalid: "exclusive provider authority fence is not READY",
	invalid_unicode: "request contains invalid Unicode",
	limit_authority_invalid: "provider configured-limit authority is not nonrevocable and exclusive",
	malformed_request: "request is malformed",
	policy_invalid: "six-dimension output policy is invalid",
	policy_review_invalid: "six-dimension output policy review is invalid",
	principal_binding_mismatch: "authenticated gateway principal does not match consumed attempt",
	profile_invalid: "required database, hold, or single-attempt transport profile is invalid",
	provider_cap_invalid: "reviewed provider cap record is missing, stale, or mismatched",
	provider_capacity_unavailable: "provider capacity is unavailable",
	provider_response_too_large: "provider response body exceeds the frozen 33554432-byte cap",
	real_scope_invalid: "reviewed provider capacity aggregation scope is invalid",
	receipt_conflict: "receipt retry differs from recorded receipt",
	receipt_context_mismatch: "receipt context does not match consumed attempt",
	receipt_deadline_expired: "receipt deadline expired before receipt transaction",
	request_body_too_large: "final provider request body exceeds the frozen 16777216-byte cap",
	request_materialization_invalid: "final credential-free provider request materialization is invalid",
	request_payload_mismatch: "immutable request BYTEA row does not match reservation",
	reservation_expired: "provider call reservation has expired",
	reservation_not_consumed: "reservation is not available for receipt",
	reservation_not_found: "provider call reservation was not found",
	reservation_not_reserved: "reservation is not available for consume",
	reserve_idempotency_conflict: "reserve idempotency key conflicts with durable request",
	response_content_encoding_invalid: "provider or caller response content encoding is not exact identity",
	response_headers_invalid: "provider or caller response headers violate the closed canonical policy",
	response_translation_invalid: "deterministic caller response translation failed validation",
	snapshot_not_ready: "selected provider snapshot is not READY and current",
	terminal_response_invalid: "terminal provider response ABI/hash/count/cap is invalid",
	terminal_result_not_committed: "no committed terminal caller response is available",
	timing_policy_invalid: "provider call timing policy is invalid",
	unknown_field: "request contains an unknown field",
	unsupported_schema: "request schema is not supported",
	validity_failed: "provider reservation evidence or policy is not currently valid",
};

function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (next < 0xdc00 || next > 0xdfff) return true;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "string" && hasLoneSurrogate(value))
			throw new Error("Provider-call JSON contains invalid Unicode");
		if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Provider-call JSON is not finite");
		if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
			throw new Error("Provider-call JSON is not serializable");
		}
		return value;
	}
	if (seen.has(value)) throw new Error("Provider-call JSON must be acyclic");
	seen.add(value);
	let result: unknown;
	if (Array.isArray(value)) {
		result = value.map(item => canonicalize(item, seen));
	} else {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		for (const [key] of entries) {
			if (hasLoneSurrogate(key)) throw new Error("Provider-call JSON contains invalid Unicode");
		}
		result = Object.fromEntries(entries.map(([key, child]) => [key, canonicalize(child, seen)]));
	}
	seen.delete(value);
	return result;
}

/** Exact RFC 8785 bytes for the JSON values used by the frozen provider-call ABI. */
export function canonicalProviderCallBytes(value: unknown): Uint8Array {
	const source = JSON.stringify(canonicalize(value));
	if (source === undefined) throw new Error("Provider-call JSON is not serializable");
	return encoder.encode(source);
}

function rawDigest(value: Uint8Array): Uint8Array {
	return createHash("sha256").update(value).digest();
}

function taggedDigest(value: Uint8Array): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function domainDigest(schema: string, bytes: Uint8Array): string {
	return taggedDigest(Buffer.concat([Buffer.from(schema), Buffer.from([0]), bytes]));
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[], label: string): void {
	const remaining = new Set(fields);
	for (const key of Object.keys(value)) {
		if (!remaining.delete(key)) throw new Error(`${label} contains unknown field: ${key}`);
	}
	if (remaining.size) throw new Error(`${label} is missing field: ${remaining.values().next().value}`);
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return bytes;
}

function uint64(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("Provider-call frame length is invalid");
	const result = new Uint8Array(8);
	new DataView(result.buffer).setBigUint64(0, BigInt(value));
	return result;
}

function readUint64(frame: Uint8Array, offset: number): number {
	const value = new DataView(frame.buffer, frame.byteOffset + offset, 8).getBigUint64(0);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Provider-call frame length is out of range");
	return Number(value);
}

function parseCallSequence(value: string): number {
	if (!POSITIVE_INTEGER.test(value)) throw new Error("Provider-call callSequence must be a positive integer");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error("Provider-call callSequence exceeds the safe-integer range");
	return parsed;
}

function requireIdentifier(value: string, label: string): void {
	if (!value || value.length > 1024 || hasLoneSurrogate(value)) throw new Error(`${label} is invalid`);
}

function validateWorkerContext(context: ProviderCallContext): void {
	for (const [label, value] of [
		["task reservation id", context.taskReservationId],
		["provider route assignment id", context.providerRouteAssignmentId],
		["execution binding id", context.executionBindingId],
		["Pod UID", context.podUid],
		["idempotency key", context.idempotencyKey],
		["API family", context.apiFamily],
	] as const) {
		requireIdentifier(value, `Provider-call ${label}`);
	}
	parseCallSequence(context.callSequence);
}

export function validateProviderCallContext(model: Model<Api>, context: ProviderCallContext): void {
	if (context.mode !== "strict") throw new Error("Unsupported provider-call gateway mode");
	if (context.provider !== model.provider)
		throw new Error(`Provider-call gateway provider mismatch: expected ${model.provider}`);
	if (context.modelId !== model.id) throw new Error(`Provider-call gateway model mismatch: expected ${model.id}`);
	const expectedApiFamily =
		model.api === "openai-completions"
			? "openai-completions"
			: model.api === "google-gemini-cli"
				? "google-gemini-cli"
				: model.api === "openai-responses" || model.api === "azure-openai-responses"
					? "openai-responses"
					: undefined;
	if (!expectedApiFamily || context.apiFamily !== expectedApiFamily) {
		throw new Error(`Provider-call gateway does not support API family ${model.api}`);
	}
	const assignment = validateProviderCallOriginAssignment(context.originAssignment);
	const route = resolveProviderCallOriginBinding(assignment.config_id, assignment.route_ordinal);
	if (
		context.configId !== assignment.config_id ||
		context.credentialGeneration !== assignment.credential_generation ||
		route.provider !== context.provider ||
		route.modelId !== context.modelId ||
		route.apiFamily !== context.apiFamily
	) {
		throw new Error(`Provider-call origin assignment identity mismatch for ${context.configId}`);
	}
	validateWorkerContext(context);
	for (const [name, value] of Object.entries({
		configId: context.configId,
		accountId: context.accountId,
		credentialGeneration: context.credentialGeneration,
		capabilityId: context.capabilityId,
		snapshotId: context.snapshotId,
		assignmentSha256: context.assignmentSha256,
		tokenizerContractSha256: context.tokenizerContractSha256,
		inputTokens: context.inputTokens,
		maxOutputTokens: context.maxOutputTokens,
	})) {
		if (!value.trim()) throw new Error(`Provider-call gateway ${name} is required`);
	}
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	for (const value of [
		context.taskReservationId,
		context.providerRouteAssignmentId,
		context.executionBindingId,
		context.idempotencyKey,
		context.capabilityId,
		context.snapshotId,
	]) {
		if (!uuid.test(value)) throw new Error("Provider-call gateway UUID fields must be lowercase canonical UUIDs");
	}
	if (!SHA256.test(context.assignmentSha256) || !SHA256.test(context.tokenizerContractSha256)) {
		throw new Error("Provider-call assignment/tokenizer contract hash is invalid");
	}
	if (!/^(0|[1-9][0-9]*)$/.test(context.inputTokens) || !/^(0|[1-9][0-9]*)$/.test(context.maxOutputTokens)) {
		throw new Error("Provider-call token counters must be canonical unsigned decimal strings");
	}
	if (context.expectedDimensions.length === 0) throw new Error("Provider-call gateway dimensions are required");
	let previousKey: string | undefined;
	for (const dimension of context.expectedDimensions) {
		const key = `${dimension.dimension}\0${dimension.windowId}`;
		const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
		if (
			!dimension.windowId ||
			!/^[1-9][0-9]*$/.test(dimension.amount) ||
			!/^[0-9]$/.test(dimension.unitScale) ||
			(dimension.windowStart !== null && !timestamp.test(dimension.windowStart)) ||
			(dimension.windowEnd !== null && !timestamp.test(dimension.windowEnd)) ||
			(previousKey !== undefined && Buffer.compare(Buffer.from(previousKey), Buffer.from(key)) >= 0)
		) {
			throw new Error("Provider-call gateway dimension vector is invalid or unsorted");
		}
		previousKey = key;
	}
}

interface WorkerRequestFrameInput extends ProviderCallGatewayRequest {
	workerOperationId: string;
}

function workerRequestParts(input: WorkerRequestFrameInput): readonly Uint8Array[] {
	validateWorkerContext(input.context);
	if (!UUID_V4.test(input.workerOperationId)) throw new Error("Provider-call worker operation ID must be UUIDv4");
	const expectedMaterializationKind = input.context.codexAuthority
		? "DEDICATED_CODEX_AUTHORITY_TRANSLATED"
		: "GENERIC_LIFECYCLE_FINAL";
	if (input.requestMaterializationKind !== expectedMaterializationKind) {
		throw new Error("Provider-call request materialization kind does not match the controller-owned route context");
	}
	if (
		input.context.codexAuthority &&
		input.context.codexAuthority.providerRouteAssignmentId !== input.context.providerRouteAssignmentId
	) {
		throw new Error("Provider-call dedicated route-assignment identity mismatch");
	}
	if (input.sourceBody.byteLength > MAX_WORKER_REQUEST_PAYLOAD_BYTES) {
		throw new Error(`Provider-call source body exceeds ${MAX_WORKER_REQUEST_PAYLOAD_BYTES} bytes`);
	}
	const sourceDigest = taggedDigest(input.sourceBody);
	const header = canonicalProviderCallBytes({
		schema: REQUEST_SCHEMA,
		worker_operation_id: input.workerOperationId,
		task_reservation_id: input.context.taskReservationId,
		provider_route_assignment_id: input.context.providerRouteAssignmentId,
		execution_binding_id: input.context.executionBindingId,
		pod_uid: input.context.podUid,
		call_sequence: parseCallSequence(input.context.callSequence),
		idempotency_key: input.context.idempotencyKey,
		api_family: input.context.apiFamily,
		request_materialization_kind: input.requestMaterializationKind,
		source_request_sha256: sourceDigest,
		source_request_body_bytes: input.sourceBody.byteLength,
	});
	if (header.byteLength > MAX_WORKER_HEADER_BYTES) throw new Error("Provider-call worker header is too large");
	const prefix = concat([
		REQUEST_MAGIC,
		uint64(header.byteLength),
		uint64(input.sourceBody.byteLength),
		rawDigest(header),
		rawDigest(input.sourceBody),
	]);
	return [prefix, header, input.sourceBody];
}

/** Deterministic TBPCW002 encoder used by golden-vector and gateway tests. */
export function encodeProviderCallWorkerRequest(input: WorkerRequestFrameInput): Uint8Array {
	return concat(workerRequestParts(input));
}

export function assertNoDuplicateJsonKeys(source: string): void {
	if (source.includes("\ufeff") || source.includes("\r") || source.includes("\0")) {
		throw new Error("Forbidden JSON byte");
	}
	const canonicalIntegerFields = new Set([
		"config_ordinal",
		"route_ordinal",
		"origin_descriptor_canonical_bytes",
		"binding_descriptor_canonical_bytes",
		"port",
	]);
	let offset = 0;
	const skipWhitespace = (): void => {
		while (/\s/.test(source[offset] ?? "")) offset++;
	};
	const parseString = (): string => {
		const start = offset;
		if (source[offset++] !== '"') throw new Error("Expected JSON string");
		while (offset < source.length) {
			const character = source[offset++];
			if (character === "\\") {
				offset++;
				continue;
			}
			if (character === '"') return JSON.parse(source.slice(start, offset)) as string;
		}
		throw new Error("Unterminated JSON string");
	};
	const parseValue = (field?: string): void => {
		skipWhitespace();
		const character = source[offset];
		if (character === "{") {
			offset++;
			skipWhitespace();
			const keys = new Set<string>();
			if (source[offset] === "}") {
				offset++;
				return;
			}
			while (true) {
				skipWhitespace();
				const key = parseString();
				if (keys.has(key)) throw new Error(`Duplicate JSON field: ${key}`);
				keys.add(key);
				skipWhitespace();
				if (source[offset++] !== ":") throw new Error("Expected JSON colon");
				parseValue(key);
				skipWhitespace();
				const delimiter = source[offset++];
				if (delimiter === "}") return;
				if (delimiter !== ",") throw new Error("Expected JSON object delimiter");
			}
		}
		if (character === "[") {
			offset++;
			skipWhitespace();
			if (source[offset] === "]") {
				offset++;
				return;
			}
			while (true) {
				parseValue();
				skipWhitespace();
				const delimiter = source[offset++];
				if (delimiter === "]") return;
				if (delimiter !== ",") throw new Error("Expected JSON array delimiter");
			}
		}
		if (character === '"') {
			parseString();
			return;
		}
		const start = offset;
		while (offset < source.length && !/[\s,\]}]/.test(source[offset] ?? "")) offset++;
		if (offset === start) throw new Error("Expected JSON scalar");
		const scalar = source.slice(start, offset);
		if (field && canonicalIntegerFields.has(field) && !/^(0|[1-9][0-9]*)$/.test(scalar)) {
			throw new Error(`Noncanonical JSON integer: ${field}`);
		}
	};
	parseValue();
	skipWhitespace();
	if (offset !== source.length) throw new Error("Trailing JSON data");
}

function parseCanonicalObject(bytes: Uint8Array, label: string): Record<string, unknown> {
	const source = fatalDecoder.decode(bytes);
	assertNoDuplicateJsonKeys(source);
	const value = JSON.parse(source) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	if (!exactBytes(canonicalProviderCallBytes(value), bytes)) throw new Error(`${label} is not exact RFC 8785 JSON`);
	return value as Record<string, unknown>;
}

function canonicalBase64ByteLength(value: unknown, cap: number, label: string): number {
	if (typeof value !== "string") throw new Error(`${label} is not base64`);
	const maxCharacters = 4 * Math.ceil(cap / 3);
	if (
		value.length > maxCharacters ||
		(value.length > 0 && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
	) {
		throw new Error(`${label} is not canonical base64`);
	}
	if (value.length === 0) return 0;
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const byteLength = (value.length / 4) * 3 - padding;
	if (byteLength > cap) throw new Error(`${label} exceeds ${cap} bytes`);
	return byteLength;
}

function decodeCanonicalBase64(value: unknown, byteLength: unknown, cap: number, label: string): Uint8Array {
	if (typeof value !== "string" || !Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
		throw new Error(`${label} base64/count is invalid`);
	}
	const count = byteLength as number;
	const decodedLength = canonicalBase64ByteLength(value, cap, label);
	if (decodedLength !== count) throw new Error(`${label} base64/count mismatch`);
	const decoded = Buffer.from(value, "base64");
	if (decoded.byteLength !== count || decoded.toString("base64") !== value)
		throw new Error(`${label} base64/count mismatch`);
	return decoded;
}

interface DecodedHeaders {
	headers: Headers;
	trailers: Headers;
}

function validateTerminalHeaderValue(name: string, value: string, label: string): void {
	if (value !== value.replace(/^[ \t]+|[ \t]+$/g, "") || !/^[\x20-\x7e]*$/.test(value)) {
		throw new Error(`${label} value is not canonical ASCII`);
	}
	if (
		(name === "anthropic-request-id" ||
			name === "openai-request-id" ||
			name === "request-id" ||
			name === "x-goog-request-id" ||
			name === "x-request-id") &&
		!/^[A-Za-z0-9._:-]{1,255}$/.test(value)
	) {
		throw new Error(`${label} request identifier is invalid`);
	}
	if (name === "x-error-code" && !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
		throw new Error(`${label} error code is invalid`);
	}
	if (name === "x-should-retry" && value !== "true" && value !== "false") {
		throw new Error(`${label} retry flag is invalid`);
	}
	if (name === "content-type" && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:; charset=utf-8)?$/.test(value)) {
		throw new Error(`${label} content type is invalid`);
	}
	if (name === "retry-after") {
		const decimal = /^(0|[1-9][0-9]*)$/.test(value);
		const imfFixdate =
			/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(
				value,
			) && Number.isFinite(Date.parse(value));
		if (!decimal && !imfFixdate) throw new Error(`${label} retry-after value is invalid`);
	}
	if (name === "cache-control" && (value.length > 1024 || !/^[\x20-\x7e]+$/.test(value))) {
		throw new Error(`${label} cache-control value is invalid`);
	}
}
function decodeTerminalHeaders(headersValue: unknown, trailersValue: unknown): DecodedHeaders {
	if (!Array.isArray(headersValue) || !Array.isArray(trailersValue))
		throw new Error("Provider-call headers must be arrays");
	if (
		canonicalProviderCallBytes(headersValue).byteLength + canonicalProviderCallBytes(trailersValue).byteLength >
		MAX_TERMINAL_HEADER_BYTES
	) {
		throw new Error("Provider-call terminal headers are too large");
	}
	const seen = new Set<string>();
	const decodeCollection = (values: unknown[], allowed: ReadonlySet<string>, label: string): Headers => {
		const result = new Headers();
		let previous: string | undefined;
		for (const value of values) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} entry is invalid`);
			const record = value as Record<string, unknown>;
			exactKeys(record, TERMINAL_HEADER_FIELDS, `${label} entry`);
			if (
				record.schema !== HEADER_SCHEMA ||
				typeof record.name !== "string" ||
				!HEADER_NAME.test(record.name) ||
				!allowed.has(record.name) ||
				(previous !== undefined && previous >= record.name) ||
				seen.has(record.name)
			) {
				throw new Error(`${label} names violate the closed sorted policy`);
			}
			const bytes = decodeCanonicalBase64(
				record.value_base64,
				canonicalBase64ByteLength(record.value_base64, MAX_TERMINAL_HEADER_BYTES, `${label} value`),
				MAX_TERMINAL_HEADER_BYTES,
				`${label} value`,
			);
			const text = fatalDecoder.decode(bytes);
			validateTerminalHeaderValue(record.name, text, label);
			result.set(record.name, text);
			seen.add(record.name);
			previous = record.name;
		}
		return result;
	};
	const headers = decodeCollection(headersValue, ALLOWED_HEADER_NAMES, "Provider-call response headers");
	const trailers = decodeCollection(trailersValue, ALLOWED_TRAILER_NAMES, "Provider-call response trailers");
	const contentEncoding = headers.get("content-encoding");
	if (contentEncoding !== null && contentEncoding !== "identity") {
		throw new Error("Provider-call response Content-Encoding is not exact identity");
	}
	return { headers, trailers };
}

function decodeCallerEntity(result: Record<string, unknown>): Response {
	exactKeys(result, ENTITY_FIELDS, "Provider-call caller response");
	if (
		result.schema !== ENTITY_SCHEMA ||
		!Number.isSafeInteger(result.http_status) ||
		(result.http_status as number) < 200 ||
		(result.http_status as number) > 599 ||
		(result.http_version !== "HTTP/1.1" && result.http_version !== "SYNTHETIC") ||
		typeof result.body_sha256 !== "string" ||
		!SHA256.test(result.body_sha256)
	) {
		throw new Error("Provider-call caller response metadata is invalid");
	}
	const body = decodeCanonicalBase64(
		result.body_base64,
		result.body_bytes,
		MAX_CALLER_RESPONSE_BODY_BYTES,
		"Provider-call caller response body",
	);
	if (taggedDigest(body) !== result.body_sha256) throw new Error("Provider-call caller response body hash mismatch");
	const { headers, trailers } = decodeTerminalHeaders(result.headers, result.trailers);
	const contentLength = headers.get("content-length");
	if (
		contentLength !== null &&
		(!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) !== body.byteLength)
	) {
		throw new Error("Provider-call caller response Content-Length mismatch");
	}
	const response = new Response(body, { status: result.http_status as number, headers });
	Object.defineProperties(response, {
		providerCallHttpVersion: { configurable: false, enumerable: false, value: result.http_version },
		trailers: { configurable: false, enumerable: false, value: Promise.resolve(trailers) },
	});
	return response;
}

function decodeGatewayError(result: Record<string, unknown>): never {
	exactKeys(result, ERROR_FIELDS, "Provider-call gateway error");
	if (
		result.schema !== ERROR_SCHEMA ||
		typeof result.code !== "string" ||
		ERROR_MESSAGES[result.code] !== result.message ||
		(result.reservation_id !== null &&
			(typeof result.reservation_id !== "string" || !UUID_V4.test(result.reservation_id)))
	) {
		throw new Error("Provider-call gateway returned an invalid frozen error");
	}
	throw new ProviderCallGatewayError(result.code, result.message as string, result.reservation_id as string | null);
}

function decodeGatewaySummary(result: Record<string, unknown>): never {
	exactKeys(result, SUMMARY_FIELDS, "Provider-call gateway summary");
	if (
		result.schema !== SUMMARY_SCHEMA ||
		typeof result.state !== "string" ||
		typeof result.reservation_id !== "string" ||
		!UUID_V4.test(result.reservation_id) ||
		typeof result.call_sequence !== "number" ||
		!Number.isSafeInteger(result.call_sequence) ||
		(result.call_sequence as number) <= 0
	) {
		throw new Error("Provider-call gateway returned an invalid summary");
	}
	throw new ProviderCallGatewayStateError(result.state, result.reservation_id);
}

export class ProviderCallGatewayError extends Error {
	readonly code: string;
	readonly reservationId: string | null;

	constructor(code: string, message: string, reservationId: string | null) {
		super(message);
		this.name = "ProviderCallGatewayError";
		this.code = code;
		this.reservationId = reservationId;
	}
}

export class ProviderCallGatewayStateError extends Error {
	readonly state: string;
	readonly reservationId: string;

	constructor(state: string, reservationId: string) {
		super(`Provider-call gateway returned ${state} without a committed caller response`);
		this.name = "ProviderCallGatewayStateError";
		this.state = state;
		this.reservationId = reservationId;
	}
}

/** Strict TBPCR003 decoder. It accepts one canonical frame and requires immediate EOF. */
export function decodeProviderCallWorkerResponse(frame: Uint8Array, expectedWorkerOperationId: string): Response {
	if (frame.byteLength < 88) throw new Error("Provider-call gateway response frame is truncated");
	if (!exactBytes(frame.subarray(0, 8), RESPONSE_MAGIC))
		throw new Error("Provider-call gateway response magic is invalid");
	const headerLength = readUint64(frame, 8);
	const resultLength = readUint64(frame, 16);
	if (headerLength > MAX_WORKER_HEADER_BYTES || resultLength > MAX_WORKER_RESULT_JSON_BYTES) {
		throw new Error("Provider-call gateway response length exceeds the frozen cap");
	}
	if (frame.byteLength !== 88 + headerLength + resultLength) {
		throw new Error("Provider-call gateway response has a truncated or trailing frame length");
	}
	const headerBytes = frame.subarray(88, 88 + headerLength);
	const resultBytes = frame.subarray(88 + headerLength);
	if (!exactBytes(frame.subarray(24, 56), rawDigest(headerBytes))) {
		throw new Error("Provider-call gateway response header hash mismatch");
	}
	if (!exactBytes(frame.subarray(56, 88), rawDigest(resultBytes))) {
		throw new Error("Provider-call gateway response result hash mismatch");
	}
	const header = parseCanonicalObject(headerBytes, "Provider-call gateway response header");
	exactKeys(header, RESULT_FIELDS, "Provider-call gateway response header");
	if (
		header.schema !== RESPONSE_SCHEMA ||
		header.worker_operation_id !== expectedWorkerOperationId ||
		header.result_bytes !== resultLength ||
		typeof header.result_sha256 !== "string" ||
		!SHA256.test(header.result_sha256)
	) {
		throw new Error("Provider-call gateway response header is invalid");
	}
	const result = parseCanonicalObject(resultBytes, "Provider-call gateway selected result");
	let expectedSchema: string;
	if (header.result_kind === "CALLER_RESPONSE") expectedSchema = ENTITY_SCHEMA;
	else if (header.result_kind === "SUMMARY") expectedSchema = SUMMARY_SCHEMA;
	else if (header.result_kind === "ERROR") expectedSchema = ERROR_SCHEMA;
	else throw new Error("Provider-call gateway response kind is invalid");
	if (header.result_schema !== expectedSchema || result.schema !== expectedSchema) {
		throw new Error("Provider-call gateway result kind/schema mismatch");
	}
	if (domainDigest(expectedSchema, resultBytes) !== header.result_sha256) {
		throw new Error("Provider-call gateway result domain hash mismatch");
	}
	if (header.result_kind === "CALLER_RESPONSE") return decodeCallerEntity(result);
	if (header.result_kind === "SUMMARY") return decodeGatewaySummary(result);
	return decodeGatewayError(result);
}

export interface UnixProviderCallGatewayOptions {
	socketPath: string;
}

/** Frozen TBPCW002/TBPCR003 same-Pod client. No controller or provider network path exists here. */
export class UnixProviderCallGateway implements ProviderCallGateway {
	readonly #socketPath: string;

	constructor(options: UnixProviderCallGatewayOptions) {
		if (!options.socketPath || options.socketPath.includes("\0") || Buffer.byteLength(options.socketPath) > 107) {
			throw new Error("Provider-call gateway socket path is invalid");
		}
		this.#socketPath = options.socketPath;
	}

	async dispatch(request: ProviderCallGatewayRequest): Promise<Response> {
		const workerOperationId = randomUUID();
		const parts = workerRequestParts({ ...request, workerOperationId });
		const frame = await new Promise<Uint8Array>((resolve, reject) => {
			interface ExchangeState {
				parts: readonly Uint8Array[];
				partIndex: number;
				partOffset: number;
				chunks: Buffer[];
				received: number;
				expectedResponseBytes?: number;
				requestEnded: boolean;
				settled: boolean;
			}
			const state: ExchangeState = {
				parts,
				partIndex: 0,
				partOffset: 0,
				chunks: [],
				received: 0,
				requestEnded: false,
				settled: false,
			};
			const fail = (socket: Bun.Socket<ExchangeState> | undefined, error: Error): void => {
				if (state.settled) return;
				state.settled = true;
				socket?.terminate();
				reject(error);
			};
			const finish = (socket: Bun.Socket<ExchangeState>): void => {
				if (state.settled) return;
				if (state.expectedResponseBytes === undefined || state.received !== state.expectedResponseBytes) {
					fail(socket, new Error("Provider-call gateway closed before the exact response frame was complete"));
					return;
				}
				state.settled = true;
				const response = Buffer.concat(state.chunks, state.received);
				socket.shutdown();
				resolve(response);
			};
			const flush = (socket: Bun.Socket<ExchangeState>): void => {
				if (state.requestEnded) return;
				while (state.partIndex < state.parts.length) {
					const part = state.parts[state.partIndex];
					const written = socket.write(part, state.partOffset, part.byteLength - state.partOffset);
					if (written < 0) {
						fail(socket, new Error("Provider-call gateway socket closed while writing the request"));
						return;
					}
					state.partOffset += written;
					if (state.partOffset < part.byteLength) return;
					state.partIndex++;
					state.partOffset = 0;
				}
				state.requestEnded = true;
				setTimeout(() => {
					if (!state.settled) socket.shutdown(true);
				}, 0);
			};
			void Bun.connect<ExchangeState>({
				unix: this.#socketPath,
				allowHalfOpen: true,
				data: state,
				socket: {
					binaryType: "buffer",
					open: flush,
					drain: flush,
					data(socket, chunk) {
						state.received += chunk.byteLength;
						if (state.received > MAX_RESPONSE_FRAME_BYTES) {
							fail(socket, new Error("Provider-call gateway response exceeds the frozen frame cap"));
							return;
						}
						state.chunks.push(Buffer.from(chunk));
						if (state.expectedResponseBytes === undefined && state.received >= 24) {
							const prefix = Buffer.concat(state.chunks, state.received).subarray(0, 24);
							if (!exactBytes(prefix.subarray(0, 8), RESPONSE_MAGIC)) {
								fail(socket, new Error("Provider-call gateway response magic is invalid"));
								return;
							}
							const headerLength = readUint64(prefix, 8);
							const resultLength = readUint64(prefix, 16);
							if (headerLength > MAX_WORKER_HEADER_BYTES || resultLength > MAX_WORKER_RESULT_JSON_BYTES) {
								fail(socket, new Error("Provider-call gateway response length exceeds the frozen cap"));
								return;
							}
							state.expectedResponseBytes = 88 + headerLength + resultLength;
						}
						if (state.expectedResponseBytes !== undefined && state.received > state.expectedResponseBytes) {
							fail(socket, new Error("Provider-call gateway response has trailing bytes"));
						}
					},
					end(socket) {
						// Bun reports the local SHUT_WR as `end` on some versions.
						// Only a nonempty, complete response can be a remote EOF.
						if (state.received > 0) finish(socket);
					},
					close(socket) {
						finish(socket);
					},
					error(socket, error) {
						fail(socket, error);
					},
					connectError(socket, error) {
						fail(socket, error);
					},
				},
			}).catch(error => fail(undefined, error instanceof Error ? error : new Error(String(error))));
		});
		return decodeProviderCallWorkerResponse(frame, workerOperationId);
	}
}

const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
	"authorization",
	"proxy-authorization",
	"x-api-key",
	"api-key",
	"x-goog-api-key",
	"cookie",
	"set-cookie",
]);
const CREDENTIAL_QUERY: ReadonlySet<string> = new Set([
	"access_token",
	"api_key",
	"apikey",
	"authorization",
	"key",
	"token",
]);

async function requestBodyBytes(input: string | URL | Request, init?: RequestInit): Promise<Uint8Array> {
	const body = init?.body;
	if (typeof body === "string") return encoder.encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	if (body === undefined || body === null) {
		if (input instanceof Request && input.body) return new Uint8Array(await input.clone().arrayBuffer());
		return new Uint8Array();
	}
	throw new Error("Strict provider-call gateway requires a deterministic byte request body");
}

function validateCredentialFreeRequest(
	input: string | URL | Request,
	init: RequestInit | undefined,
	context: ProviderCallContext,
): void {
	const url = new URL(input instanceof Request ? input.url : input);
	for (const key of url.searchParams.keys()) {
		if (CREDENTIAL_QUERY.has(key.toLowerCase())) {
			throw new Error(`Provider-call URL contains credential query field: ${key}`);
		}
	}
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	for (const [name] of headers) {
		if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
			throw new Error(`Provider-call request contains credential header: ${name}`);
		}
	}
	const contentEncoding = headers.get("content-encoding");
	if (contentEncoding !== null && contentEncoding !== "identity") {
		throw new Error("Provider-call request Content-Encoding must be absent or exact identity");
	}
	assertProviderCallOrigin(context.originAssignment, url, headers);
}

function dedicatedCodexSourceBody(context: ProviderCallContext): Uint8Array {
	const authority = context.codexAuthority;
	if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
		throw new Error("Dedicated Codex gateway context is missing");
	}
	const keys = Object.keys(authority).sort();
	if (
		keys.join("\0") !==
		[
			"assignedAt",
			"capabilitySetId",
			"logicalBodyBase64",
			"logicalContentType",
			"logicalHeaders",
			"providerRouteAssignmentId",
			"solverEpoch",
			"translationContractSha256",
		].join("\0")
	) {
		throw new Error("Dedicated Codex gateway context is not the closed reviewed shape");
	}
	const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
	if (
		authority.providerRouteAssignmentId !== context.providerRouteAssignmentId ||
		!UUID_V4.test(authority.providerRouteAssignmentId) ||
		!UUID_V4.test(authority.capabilitySetId) ||
		!SHA256.test(authority.translationContractSha256) ||
		!/^[1-9][0-9]*$/.test(authority.solverEpoch) ||
		!timestamp.test(authority.assignedAt) ||
		!Number.isFinite(Date.parse(authority.assignedAt)) ||
		authority.logicalContentType !== "application/json"
	) {
		throw new Error("Dedicated Codex gateway context identity is invalid");
	}
	const headerKeys = Object.keys(authority.logicalHeaders).sort();
	if (
		headerKeys.some(name => name !== "accept" && name !== "content-type") ||
		authority.logicalHeaders["content-type"] !== "application/json" ||
		(authority.logicalHeaders.accept !== undefined && authority.logicalHeaders.accept !== "text/event-stream")
	) {
		throw new Error("Dedicated Codex logical headers are not the closed reviewed set");
	}
	const byteLength = canonicalBase64ByteLength(
		authority.logicalBodyBase64,
		MAX_WORKER_REQUEST_PAYLOAD_BYTES,
		"Dedicated Codex logical body",
	);
	const body = decodeCanonicalBase64(
		authority.logicalBodyBase64,
		byteLength,
		MAX_WORKER_REQUEST_PAYLOAD_BYTES,
		"Dedicated Codex logical body",
	);
	const source = fatalDecoder.decode(body);
	assertNoDuplicateJsonKeys(source);
	const parsed = JSON.parse(source) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Dedicated Codex logical body must be a JSON object");
	}
	return body;
}

/** Dispatches the controller-translated dedicated Codex request through the same Unix worker gateway. */
export function dispatchDedicatedCodexProviderCall(
	model: Model<Api>,
	context: ProviderCallContext,
	gateway: ProviderCallGateway,
): Promise<Response> {
	validateProviderCallContext(model, context);
	const route = resolveProviderCallOriginBinding(
		context.originAssignment.config_id,
		context.originAssignment.route_ordinal,
	);
	if (route.authorityOwner !== "dedicated-codex-backend") {
		throw new Error("Generic provider routes cannot use dedicated Codex gateway dispatch");
	}
	return gateway.dispatch({
		context,
		requestMaterializationKind: "DEDICATED_CODEX_AUTHORITY_TRANSLATED",
		sourceBody: dedicatedCodexSourceBody(context),
	});
}

/** Captures one final serialized generic body and delegates the complete call to the Unix worker gateway. */
export class StrictProviderCallGatewayLifecycle {
	readonly #context: ProviderCallContext;
	readonly #gateway: ProviderCallGateway;
	readonly #userOnPayload: SimpleStreamOptions["onPayload"];
	#payloadShaped = false;
	#fetchInvoked = false;

	constructor(model: Model<Api>, options: SimpleStreamOptions, gateway: ProviderCallGateway) {
		const context = options.providerCallContext;
		if (!context) throw new Error("Provider-call gateway context is required");
		validateProviderCallContext(model, context);
		const route = resolveProviderCallOriginBinding(
			context.originAssignment.config_id,
			context.originAssignment.route_ordinal,
		);
		if (route.authorityOwner !== "generic-omp-auth-gateway") {
			throw new Error("GPT provider calls must use dedicated Codex gateway dispatch");
		}
		this.#context = context;
		this.#gateway = gateway;
		this.#userOnPayload = options.onPayload;
	}

	options(options: SimpleStreamOptions): SimpleStreamOptions {
		const guardedFetch = this.#fetch.bind(this) as FetchImpl;
		return { ...options, onPayload: this.#onPayload.bind(this), fetch: guardedFetch };
	}

	async #onPayload(payload: unknown, model?: Model<Api>): Promise<unknown> {
		if (this.#payloadShaped) throw new Error("Provider-call payload shaping is single-use");
		const replacement = await this.#userOnPayload?.(payload, model);
		this.#payloadShaped = true;
		return replacement === undefined ? payload : replacement;
	}

	async #fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (this.#fetchInvoked) throw new Error("Provider-call gateway dispatch is single-use; retry rejected");
		this.#fetchInvoked = true;
		if (!this.#payloadShaped) throw new Error("Provider-call gateway requires final payload shaping before dispatch");
		const body = await requestBodyBytes(input, init);
		if (body.byteLength > MAX_WORKER_REQUEST_PAYLOAD_BYTES) {
			throw new Error(`Provider-call request body exceeds ${MAX_WORKER_REQUEST_PAYLOAD_BYTES} bytes`);
		}
		validateCredentialFreeRequest(input, init, this.#context);
		return this.#gateway.dispatch({
			context: this.#context,
			requestMaterializationKind: "GENERIC_LIFECYCLE_FINAL",
			sourceBody: body,
		});
	}
}

export type { ProviderCallRequestMaterializationKind } from "./types";
