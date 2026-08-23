import { createHash } from "node:crypto";
import { assertNoDuplicateJsonKeys } from "./provider-call-gateway";
import {
	providerCallOriginAssignmentsEqual,
	resolveProviderCallOriginBinding,
	validateProviderCallOriginAssignment,
} from "./provider-call-origin-manifest";
import type {
	FetchImpl,
	ProviderCallAuthority,
	ProviderCallContext,
	ProviderCallDimension,
	ProviderCallReceiptAck,
	ProviderCallReceiptRequest,
	ProviderCallRecoverRequest,
	ProviderCallRecoveryResult,
	ProviderCallReservation,
	ProviderCallReservationReference,
} from "./types";

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isFinite(value))
			throw new Error("Provider-call payload is not JSON-safe");
		if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
			throw new Error("Provider-call payload is not JSON-safe");
		}
		return value;
	}
	if (seen.has(value)) throw new Error("Provider-call payload must be acyclic");
	seen.add(value);
	let result: unknown;
	if (Array.isArray(value)) {
		result = value.map(item => canonicalize(item, seen));
	} else {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));
		result = Object.fromEntries(entries.map(([key, child]) => [key, canonicalize(child, seen)]));
	}
	seen.delete(value);
	return result;
}

export function canonicalProviderCallBytes(value: unknown): Uint8Array {
	const encoded = JSON.stringify(canonicalize(value));
	if (encoded === undefined) throw new Error("Provider-call payload is not JSON-serializable");
	return new TextEncoder().encode(encoded);
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function appendFramedValue(chunks: Uint8Array[], value: string | Uint8Array): void {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	const size = new Uint8Array(4);
	new DataView(size.buffer).setUint32(0, bytes.byteLength);
	chunks.push(size, bytes);
}

export interface ProviderCallRequestHashInput {
	apiFamily: ProviderCallContext["apiFamily"];
	httpMethod: string;
	credentialFreeUrl: string;
	contentType: string;
	headers: ReadonlyArray<readonly [name: string, value: string]>;
	body: Uint8Array;
}

/** Frozen TB-PCALL-REQUEST-v1 binary framing shared with the controller. */
export function encodeProviderCallRequestHashInput(input: ProviderCallRequestHashInput): Uint8Array {
	const chunks: Uint8Array[] = [new TextEncoder().encode("TB-PCALL-REQUEST-v1\0")];
	appendFramedValue(chunks, input.apiFamily);
	appendFramedValue(chunks, input.httpMethod);
	appendFramedValue(chunks, input.credentialFreeUrl);
	appendFramedValue(chunks, input.contentType);
	const headerCount = new Uint8Array(4);
	new DataView(headerCount.buffer).setUint32(0, input.headers.length);
	chunks.push(headerCount);
	for (const [name, value] of input.headers) {
		const nameBytes = new TextEncoder().encode(name);
		const valueBytes = new TextEncoder().encode(value);
		const headerElementSize = new Uint8Array(4);
		new DataView(headerElementSize.buffer).setUint32(0, 8 + nameBytes.byteLength + valueBytes.byteLength);
		chunks.push(headerElementSize);
		appendFramedValue(chunks, nameBytes);
		appendFramedValue(chunks, valueBytes);
	}
	appendFramedValue(chunks, input.body);
	const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const encoded = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		encoded.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return encoded;
}

export interface HttpProviderCallAuthorityOptions {
	baseUrl: string;
	getGatewayToken: (signal?: AbortSignal) => string | Promise<string>;
	getExecutionToken: (signal?: AbortSignal) => string | Promise<string>;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

class ProviderCallAuthorityPreflightError extends Error {}
const MAX_AUTHORITY_JSON_BYTES = 64 * 1024;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CANONICAL_SHA256 = /^sha256:[0-9a-f]{64}$/;
function isCanonicalAuthorityTimestamp(value: string): boolean {
	if (!CANONICAL_TIMESTAMP.test(value)) return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 23) === value.slice(0, 23);
}

async function readStrictAuthorityJson(
	response: {
		headers: { get(name: string): string | null };
		body: {
			getReader(): {
				read(): Promise<{ done: boolean; value?: Uint8Array }>;
				cancel(): Promise<void>;
			};
		} | null;
	},
	label: string,
): Promise<Record<string, unknown>> {
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > MAX_AUTHORITY_JSON_BYTES) {
		throw new Error(`${label} exceeds ${MAX_AUTHORITY_JSON_BYTES} bytes`);
	}
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	const reader = response.body?.getReader();
	if (reader) {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			if (!next.value) throw new Error(`${label} returned an invalid response stream chunk`);
			byteLength += next.value.byteLength;
			if (byteLength > MAX_AUTHORITY_JSON_BYTES) {
				await reader.cancel();
				throw new Error(`${label} exceeds ${MAX_AUTHORITY_JSON_BYTES} bytes`);
			}
			chunks.push(next.value);
		}
	}
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	assertNoDuplicateJsonKeys(text);
	const decoded = JSON.parse(text) as unknown;
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error(`${label} must be an object`);
	return decoded as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const expected = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!expected.delete(key)) throw new Error(`${label} contains unknown field: ${key}`);
	}
	if (expected.size > 0) throw new Error(`${label} is missing field: ${expected.values().next().value}`);
}

function assertWireDimensions(value: unknown, label: string): Array<Record<string, string | null>> {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((element, index) => {
		if (!element || typeof element !== "object" || Array.isArray(element)) {
			throw new Error(`${label}[${index}] must be an object`);
		}
		const record = element as Record<string, unknown>;
		assertExactKeys(
			record,
			["dimension", "window_id", "amount", "unit_scale", "window_start", "window_end"],
			`${label}[${index}]`,
		);
		return record as Record<string, string | null>;
	});
}

function appendRawSha(chunks: Uint8Array[], value: unknown): void {
	if (typeof value !== "string" || !CANONICAL_SHA256.test(value)) throw new Error("Invalid receipt SHA field");
	appendFramedValue(chunks, Buffer.from(value.slice(7), "hex"));
}

function appendBoolean(chunks: Uint8Array[], value: unknown): void {
	if (typeof value !== "boolean") throw new Error("Invalid receipt boolean field");
	appendFramedValue(chunks, value ? "true" : "false");
}

function appendNullable(chunks: Uint8Array[], value: unknown, shaValue = false): void {
	if (value === null) {
		chunks.push(new Uint8Array(4));
		return;
	}
	if (shaValue) appendRawSha(chunks, value);
	else appendFramedValue(chunks, String(value));
}

function appendNullableCanonicalJson(chunks: Uint8Array[], value: unknown): void {
	if (value === null) {
		chunks.push(new Uint8Array(4));
		return;
	}
	appendFramedValue(chunks, canonicalProviderCallBytes(value));
}

function appendDimensionArray(chunks: Uint8Array[], value: unknown): void {
	const dimensions = assertWireDimensions(value, "receipt dimensions");
	const count = new Uint8Array(4);
	new DataView(count.buffer).setUint32(0, dimensions.length);
	chunks.push(count);
	for (const dimension of dimensions) {
		const elementChunks: Uint8Array[] = [];
		appendFramedValue(elementChunks, String(dimension.dimension));
		appendFramedValue(elementChunks, String(dimension.window_id));
		appendFramedValue(elementChunks, String(dimension.amount));
		appendFramedValue(elementChunks, String(dimension.unit_scale));
		appendNullable(elementChunks, dimension.window_start);
		appendNullable(elementChunks, dimension.window_end);
		const elementLength = elementChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
		const size = new Uint8Array(4);
		new DataView(size.buffer).setUint32(0, elementLength);
		chunks.push(size, ...elementChunks);
	}
}

export function encodeProviderCallReceiptHashInput(payload: Record<string, unknown>, terminal: boolean): Uint8Array {
	const chunks: Uint8Array[] = [
		new TextEncoder().encode(terminal ? "TB-PCALL-TERMINAL-RECEIPT-v2\0" : "TB-PCALL-AMBIGUOUS-RECEIPT-v2\0"),
	];
	const scalarFields = terminal
		? [
				"schema",
				"receipt_operation_id",
				"reservation_id",
				"task_reservation_id",
				"execution_binding_id",
				"pod_uid",
				"call_sequence",
				"idempotency_key",
			]
		: [
				"schema",
				"receipt_operation_id",
				"reservation_id",
				"task_reservation_id",
				"execution_binding_id",
				"pod_uid",
				"call_sequence",
				"idempotency_key",
			];
	for (const field of scalarFields) appendFramedValue(chunks, String(payload[field]));
	appendFramedValue(chunks, canonicalProviderCallBytes(payload.origin_assignment));
	for (const field of [
		"authority_owner",
		"backend_equality_result",
		"provider_request_count",
		"retry_count",
		"failover_count",
		"redirect_follow_count",
		"final_classification",
		"drain_state",
	]) {
		appendFramedValue(chunks, String(payload[field]));
	}
	appendRawSha(chunks, payload.assignment_sha256);
	appendRawSha(chunks, payload.request_sha256);
	for (const field of [
		"provider",
		"account_id",
		"model_id",
		"credential_generation",
		"capability_id",
		"snapshot_id",
	]) {
		appendFramedValue(chunks, String(payload[field]));
	}
	if (terminal) {
		for (const field of ["provider_started_at", "provider_finished_at", "http_status", "provider_request_id"]) {
			appendFramedValue(chunks, String(payload[field]));
		}
		appendRawSha(chunks, payload.response_sha256);
		appendBoolean(chunks, payload.response_complete);
		appendFramedValue(chunks, String(payload.failure_class));
		appendFramedValue(chunks, String(payload.provider_error_code));
		appendNullable(chunks, payload.retry_after_at);
		appendDimensionArray(chunks, payload.actual_dimensions);
		appendNullableCanonicalJson(chunks, payload.provider_usage);
	} else {
		appendFramedValue(chunks, String(payload.ambiguity_class));
		appendFramedValue(chunks, String(payload.last_observed_at));
		appendNullable(chunks, payload.provider_started_at);
		appendNullable(chunks, payload.http_status);
		appendFramedValue(chunks, String(payload.provider_request_id));
		appendBoolean(chunks, payload.request_may_have_reached_provider);
		appendFramedValue(chunks, String(payload.request_bytes_written));
		appendFramedValue(chunks, String(payload.response_bytes_received));
		appendNullable(chunks, payload.response_bytes_sha256, true);
	}
	const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const preimage = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		preimage.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return preimage;
}

export function providerCallReceiptPayloadSha256(payload: Record<string, unknown>, terminal: boolean): string {
	return `sha256:${sha256(encodeProviderCallReceiptHashInput(payload, terminal))}`;
}

const RESERVATION_RESPONSE_FIELDS = [
	"schema",
	"disposition",
	"reservation_id",
	"state",
	"task_reservation_id",
	"execution_binding_id",
	"pod_uid",
	"call_sequence",
	"idempotency_key",
	"api_family",
	"provider",
	"account_id",
	"model_id",
	"credential_generation",
	"capability_id",
	"snapshot_id",
	"request_sha256",
	"reservation_sha256",
	"authority_epoch",
	"issue_authorized_at",
	"capability_valid_until",
	"snapshot_expires_at",
	"reserved_dimensions",
	"assignment_sha256",
	"origin_assignment",
] as const;

interface ReservationWireResponse extends Record<string, unknown> {
	schema: string;
	disposition: string;
	reservation_id: string;
	state: string;
	task_reservation_id: string;
	execution_binding_id: string;
	pod_uid: string;
	call_sequence: string;
	idempotency_key: string;
	api_family: string;
	provider: string;
	account_id: string;
	model_id: string;
	credential_generation: string;
	capability_id: string;
	snapshot_id: string;
	request_sha256: string;
	reservation_sha256: string;
	authority_epoch: string;
	issue_authorized_at: string;
	capability_valid_until: string;
	snapshot_expires_at: string;
	reserved_dimensions: Array<Record<string, string | null>>;
	assignment_sha256: string;
	origin_assignment: unknown;
	issue_permit?: string;
	receipt?: unknown;
}

function wireDimensions(dimensions: ProviderCallDimension[]): Array<Record<string, string | null>> {
	return dimensions.map(dimension => ({
		dimension: dimension.dimension,
		window_id: dimension.windowId,
		amount: dimension.amount,
		unit_scale: dimension.unitScale,
		window_start: dimension.windowStart,
		window_end: dimension.windowEnd,
	}));
}
export function providerCallReceiptWirePayload(receipt: ProviderCallReceiptRequest): Record<string, unknown> {
	const { context, reservation } = receipt;
	const identity = {
		receipt_operation_id: receipt.receiptOperationId,
		reservation_id: reservation.reservationId,
		task_reservation_id: context.taskReservationId,
		execution_binding_id: context.executionBindingId,
		pod_uid: context.podUid,
		call_sequence: context.callSequence,
		idempotency_key: context.idempotencyKey,
		request_sha256: reservation.requestSha256,
		provider: context.provider,
		account_id: context.accountId,
		model_id: context.modelId,
		credential_generation: context.credentialGeneration,
		capability_id: context.capabilityId,
		snapshot_id: context.snapshotId,
		origin_assignment: context.originAssignment,
		authority_owner: receipt.authorityOwner,
		backend_equality_result: receipt.backendEqualityResult,
		provider_request_count: receipt.providerRequestCount,
		retry_count: receipt.retryCount,
		failover_count: receipt.failoverCount,
		redirect_follow_count: receipt.redirectFollowCount,
		final_classification: receipt.finalClassification,
		drain_state: receipt.drainState,
		assignment_sha256: context.assignmentSha256,
	};
	return receipt.classification === "terminal"
		? {
				schema: "terminal-bench/provider-call-terminal-receipt/v2",
				...identity,
				provider_started_at: receipt.providerStartedAt,
				provider_finished_at: receipt.providerFinishedAt,
				http_status: receipt.httpStatus,
				provider_request_id: receipt.providerRequestId ?? "",
				response_sha256: receipt.responseSha256,
				response_complete: true,
				failure_class: receipt.failureClass,
				provider_error_code: receipt.providerErrorCode ?? "",
				retry_after_at: receipt.retryAfterAt ?? null,
				actual_dimensions: wireDimensions(receipt.actualDimensions ?? []),
				provider_usage: receipt.providerUsage ?? null,
			}
		: {
				schema: "terminal-bench/provider-call-ambiguous-receipt/v2",
				...identity,
				ambiguity_class: receipt.ambiguityClass,
				last_observed_at: receipt.providerFinishedAt,
				provider_started_at: receipt.providerStartedAt ?? null,
				http_status: receipt.httpStatus ?? null,
				provider_request_id: receipt.providerRequestId ?? "",
				request_may_have_reached_provider: receipt.requestMayHaveReachedProvider ?? true,
				request_bytes_written: receipt.requestBytesWritten ?? "0",
				response_bytes_received: receipt.responseBytesReceived ?? "0",
				response_bytes_sha256: receipt.responseSha256 ?? null,
			};
}

export function providerCallReceiptRequestSha256(receipt: ProviderCallReceiptRequest): string {
	return providerCallReceiptPayloadSha256(
		providerCallReceiptWirePayload(receipt),
		receipt.classification === "terminal",
	);
}

/** Provider-call authority HTTP client; provider credentials never enter these envelopes. */
export class HttpProviderCallAuthority implements ProviderCallAuthority {
	readonly #baseUrl: string;
	readonly #getGatewayToken: HttpProviderCallAuthorityOptions["getGatewayToken"];
	readonly #getExecutionToken: HttpProviderCallAuthorityOptions["getExecutionToken"];
	readonly #fetch: FetchImpl;
	readonly #signal?: AbortSignal;

	constructor(options: HttpProviderCallAuthorityOptions) {
		const baseUrl = new URL(options.baseUrl);
		if (baseUrl.protocol !== "https:") throw new Error("Provider-call authority requires end-to-end HTTPS");
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
		this.#getGatewayToken = options.getGatewayToken;
		this.#getExecutionToken = options.getExecutionToken;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#signal = options.signal;
	}

	async reserve(request: Parameters<ProviderCallAuthority["reserve"]>[0]): Promise<ProviderCallReservation> {
		const { context } = request;
		const payload = {
			schema: "terminal-bench/provider-call-reserve/v1",
			task_reservation_id: context.taskReservationId,
			execution_binding_id: context.executionBindingId,
			pod_uid: context.podUid,
			call_sequence: context.callSequence,
			idempotency_key: context.idempotencyKey,
			api_family: context.apiFamily,
			provider: context.provider,
			account_id: context.accountId,
			model_id: context.modelId,
			credential_generation: context.credentialGeneration,
			capability_id: context.capabilityId,
			snapshot_id: context.snapshotId,
			request_sha256: request.requestSha256,
			request_body_bytes: request.requestBodyBytes,
			tokenizer_contract_sha256: context.tokenizerContractSha256,
			input_tokens: context.inputTokens,
			max_output_tokens: context.maxOutputTokens,
			expected_dimensions: wireDimensions(context.expectedDimensions),
			origin_assignment: context.originAssignment,
		};
		let response: Response;
		try {
			response = await this.#send("POST", "/api/v1/provider-call-reservations", payload, true);
		} catch (error) {
			if (error instanceof ProviderCallAuthorityPreflightError) throw error;
			return this.#recoverForReserve(request, payload, true);
		}
		if (response.status >= 500) return this.#recoverForReserve(request, payload, true);
		if (response.status !== 201) return this.#readIssueAuthority(response, request);
		try {
			return await this.#readIssueAuthority(response, request);
		} catch {
			return this.#recoverForReserve(request, payload, true);
		}
	}

	async #recoverForReserve(
		request: Parameters<ProviderCallAuthority["reserve"]>[0],
		reservePayload: unknown,
		retryReserveAfterAbsent: boolean,
	): Promise<ProviderCallReservation> {
		const recovered = await this.recover(request);
		if (recovered.kind === "absent" && retryReserveAfterAbsent) {
			let retry: Response;
			try {
				retry = await this.#send("POST", "/api/v1/provider-call-reservations", reservePayload, true);
			} catch (error) {
				if (error instanceof ProviderCallAuthorityPreflightError) throw error;
				return this.#recoverForReserve(request, reservePayload, false);
			}
			if (retry.status >= 500) return this.#recoverForReserve(request, reservePayload, false);
			if (retry.status !== 201) return this.#readIssueAuthority(retry, request);
			try {
				return await this.#readIssueAuthority(retry, request);
			} catch {
				return this.#recoverForReserve(request, reservePayload, false);
			}
		}
		if (recovered.kind === "absent") {
			throw new Error("Provider-call reserve outcome remains absent after bounded recovery; egress is forbidden");
		}
		throw new Error("Provider-call reservation recovered without issue authority; egress is forbidden");
	}

	async recover(request: ProviderCallRecoverRequest): Promise<ProviderCallRecoveryResult> {
		const { context } = request;
		const payload = {
			schema: "terminal-bench/provider-call-recover/v1",
			task_reservation_id: context.taskReservationId,
			execution_binding_id: context.executionBindingId,
			pod_uid: context.podUid,
			call_sequence: context.callSequence,
			idempotency_key: context.idempotencyKey,
			request_sha256: request.requestSha256,
			assignment_sha256: context.assignmentSha256,
			origin_assignment: context.originAssignment,
		};
		let response: Response;
		try {
			response = await this.#send("POST", "/api/v1/provider-call-reservations:recover", payload, true);
		} catch (error) {
			if (error instanceof ProviderCallAuthorityPreflightError) throw error;
			throw new Error("Provider-call reserve outcome is unknown; recovery failed and egress is forbidden", {
				cause: error,
			});
		}
		if (response.status === 404) return { kind: "absent" };
		if (response.status !== 200) {
			throw new Error(`Provider-call reservation recovery failed with HTTP ${response.status}; egress is forbidden`);
		}
		try {
			return await this.#readRecoveredReservation(response, request);
		} catch (error) {
			throw new Error(
				"Provider-call reservation recovery returned an invalid frozen response; egress is forbidden",
				{
					cause: error,
				},
			);
		}
	}

	async #readRecoveredReservation(
		response: Response,
		request: ProviderCallRecoverRequest,
	): Promise<ProviderCallRecoveryResult> {
		const wire = (await readStrictAuthorityJson(
			response,
			"Provider-call recovery response",
		)) as ReservationWireResponse;
		assertExactKeys(wire, [...RESERVATION_RESPONSE_FIELDS, "receipt"], "Provider-call recovery response");
		if (wire.state !== "issue_authorized" && wire.state !== "terminal" && wire.state !== "ambiguous") {
			throw new Error("Provider-call recovery returned an invalid state");
		}
		this.#assertReservationIdentity(wire, request, "recovered", wire.state);
		const reservation: ProviderCallReservationReference = {
			reservationId: wire.reservation_id,
			disposition: "created",
			callSequence: wire.call_sequence,
			idempotencyKey: wire.idempotency_key,
			requestSha256: wire.request_sha256,
			issueAuthorizedAt: wire.issue_authorized_at,
			assignmentSha256: wire.assignment_sha256,
			originAssignment: request.context.originAssignment,
		};
		if (wire.state === "issue_authorized") {
			if (wire.receipt !== null) throw new Error("Provider-call issue-authorized recovery receipt must be null");
			return { kind: "found", state: "issue_authorized", reservation, receipt: null };
		}
		if (wire.receipt === null || typeof wire.receipt !== "object" || Array.isArray(wire.receipt)) {
			throw new Error("Provider-call settled recovery receipt must be an object");
		}
		const receipt = wire.receipt as Record<string, unknown>;
		assertExactKeys(
			receipt,
			["classification", "receipt_operation_id", "receipt_sha256", "recorded_at"],
			"Provider-call recovered receipt",
		);
		const expectedClassification = wire.state === "terminal" ? "terminal_response" : "ambiguous_attempt";
		if (
			receipt.classification !== expectedClassification ||
			typeof receipt.receipt_operation_id !== "string" ||
			!CANONICAL_UUID.test(receipt.receipt_operation_id) ||
			typeof receipt.receipt_sha256 !== "string" ||
			!CANONICAL_SHA256.test(receipt.receipt_sha256) ||
			typeof receipt.recorded_at !== "string" ||
			!isCanonicalAuthorityTimestamp(receipt.recorded_at)
		) {
			throw new Error("Provider-call recovered receipt has invalid identity fields");
		}
		return {
			kind: "found",
			state: wire.state,
			reservation,
			receipt: {
				classification: expectedClassification,
				receiptOperationId: receipt.receipt_operation_id,
				receiptSha256: receipt.receipt_sha256,
				recordedAt: receipt.recorded_at,
			},
		};
	}

	#assertReservationIdentity(
		wire: ReservationWireResponse,
		request: ProviderCallRecoverRequest,
		disposition: "created" | "recovered" | "exact_replay_no_issue_authority",
		state: "issue_authorized" | "terminal" | "ambiguous",
	): void {
		const { context } = request;
		const requiredStrings = RESERVATION_RESPONSE_FIELDS.filter(
			field => field !== "reserved_dimensions" && field !== "origin_assignment",
		);
		if (
			requiredStrings.some(field => typeof wire[field] !== "string") ||
			wire.schema !== "terminal-bench/provider-call-reservation/v1" ||
			wire.disposition !== disposition ||
			wire.state !== state ||
			wire.task_reservation_id !== context.taskReservationId ||
			wire.execution_binding_id !== context.executionBindingId ||
			wire.pod_uid !== context.podUid ||
			wire.call_sequence !== context.callSequence ||
			wire.idempotency_key !== context.idempotencyKey ||
			wire.api_family !== context.apiFamily ||
			wire.provider !== context.provider ||
			wire.account_id !== context.accountId ||
			wire.model_id !== context.modelId ||
			wire.credential_generation !== context.credentialGeneration ||
			wire.capability_id !== context.capabilityId ||
			wire.snapshot_id !== context.snapshotId ||
			wire.request_sha256 !== request.requestSha256 ||
			wire.assignment_sha256 !== context.assignmentSha256 ||
			!CANONICAL_UUID.test(wire.reservation_id) ||
			!CANONICAL_SHA256.test(wire.reservation_sha256) ||
			!CANONICAL_SHA256.test(wire.assignment_sha256) ||
			!/^(0|[1-9][0-9]*)$/.test(wire.authority_epoch) ||
			!isCanonicalAuthorityTimestamp(wire.issue_authorized_at) ||
			!isCanonicalAuthorityTimestamp(wire.capability_valid_until) ||
			!isCanonicalAuthorityTimestamp(wire.snapshot_expires_at)
		) {
			throw new Error("Provider-call authority returned an invalid frozen reservation response");
		}
		wire.reserved_dimensions = assertWireDimensions(wire.reserved_dimensions, "reserved_dimensions");
		if (JSON.stringify(wire.reserved_dimensions) !== JSON.stringify(wireDimensions(context.expectedDimensions))) {
			throw new Error("Provider-call authority returned mismatched reserved dimensions");
		}
		if (
			!providerCallOriginAssignmentsEqual(
				validateProviderCallOriginAssignment(wire.origin_assignment),
				context.originAssignment,
			)
		) {
			throw new Error("Provider-call authority returned mismatched origin assignment");
		}
	}

	async #readIssueAuthority(
		response: Response,
		request: Parameters<ProviderCallAuthority["reserve"]>[0],
	): Promise<ProviderCallReservation> {
		if (response.status === 200) {
			const replay = (await readStrictAuthorityJson(
				response,
				"Provider-call replay response",
			)) as ReservationWireResponse;
			assertExactKeys(replay, RESERVATION_RESPONSE_FIELDS, "Provider-call replay response");
			this.#assertReservationIdentity(replay, request, "exact_replay_no_issue_authority", "issue_authorized");
			throw new Error("Provider-call reserve exact replay is without issue authority; egress is forbidden");
		}
		if (response.status !== 201) {
			throw new Error(`Provider-call reserve returned HTTP ${response.status} without issue authority`);
		}
		const wire = (await readStrictAuthorityJson(
			response,
			"Provider-call reservation response",
		)) as ReservationWireResponse;
		assertExactKeys(wire, [...RESERVATION_RESPONSE_FIELDS, "issue_permit"], "Provider-call reservation response");
		this.#assertReservationIdentity(wire, request, "created", "issue_authorized");
		if (!/^pcr1_[A-Za-z0-9_-]{43}$/.test(wire.issue_permit ?? "")) {
			throw new Error("Provider-call authority returned an invalid frozen reservation response");
		}
		return {
			reservationId: wire.reservation_id,
			disposition: "created",
			callSequence: wire.call_sequence,
			idempotencyKey: wire.idempotency_key,
			requestSha256: wire.request_sha256,
			issuePermit: wire.issue_permit!,
			issueAuthorizedAt: wire.issue_authorized_at,
			assignmentSha256: wire.assignment_sha256,
			originAssignment: request.context.originAssignment,
		};
	}

	async recordReceipt(receipt: ProviderCallReceiptRequest, issuePermit: string): Promise<ProviderCallReceiptAck> {
		const { reservation } = receipt;
		if (
			!providerCallOriginAssignmentsEqual(reservation.originAssignment, receipt.context.originAssignment) ||
			reservation.assignmentSha256 !== receipt.context.assignmentSha256
		) {
			throw new Error("Provider-call receipt assignment evidence mismatch");
		}
		if (!/^pcr1_[A-Za-z0-9_-]{43}$/.test(issuePermit)) {
			throw new Error("Provider-call receipt requires a valid request-scoped issue permit");
		}
		const expectedOwner = resolveProviderCallOriginBinding(
			receipt.context.originAssignment.config_id,
			receipt.context.originAssignment.route_ordinal,
		).authorityOwner;
		const expectedFinalClassification =
			receipt.classification === "terminal" ? "TERMINAL_RESPONSE" : "AMBIGUOUS_ATTEMPT";
		if (
			receipt.authorityOwner !== expectedOwner ||
			receipt.backendEqualityResult !== "MATCH" ||
			receipt.providerRequestCount !== 1 ||
			receipt.retryCount !== 0 ||
			receipt.failoverCount !== 0 ||
			receipt.redirectFollowCount !== 0 ||
			receipt.finalClassification !== expectedFinalClassification ||
			(receipt.drainState !== "DRAINED" && receipt.drainState !== "FROZEN") ||
			!CANONICAL_SHA256.test(receipt.context.assignmentSha256)
		) {
			throw new Error("Provider-call receipt durable authority/equality/transport evidence mismatch");
		}
		if (receipt.classification === "terminal") {
			if (
				!receipt.providerStartedAt ||
				!receipt.httpStatus ||
				!receipt.responseSha256 ||
				!receipt.failureClass ||
				!receipt.actualDimensions ||
				receipt.actualDimensions.length !== receipt.context.expectedDimensions.length
			) {
				throw new Error("Provider-call terminal receipt lacks exact terminal evidence");
			}
			for (const [index, expected] of receipt.context.expectedDimensions.entries()) {
				const actual = receipt.actualDimensions[index];
				if (
					!actual ||
					actual.dimension !== expected.dimension ||
					actual.windowId !== expected.windowId ||
					actual.unitScale !== expected.unitScale ||
					actual.windowStart !== expected.windowStart ||
					actual.windowEnd !== expected.windowEnd ||
					!/^(0|[1-9][0-9]*)$/.test(actual.amount)
				) {
					throw new Error("Provider-call terminal receipt has incomplete exact dimensions");
				}
			}
		} else if (receipt.actualDimensions !== undefined) {
			throw new Error("Provider-call ambiguous receipt must not claim exact dimensions");
		}
		const terminal = receipt.classification === "terminal";
		const payload = providerCallReceiptWirePayload(receipt);
		const expectedReceiptSha256 = providerCallReceiptRequestSha256(receipt);
		const path = `/api/v1/provider-call-reservations/${encodeURIComponent(reservation.reservationId)}/receipts/${
			terminal ? "terminal" : "ambiguous"
		}`;
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			let response: Response;
			try {
				response = await this.#send("PUT", path, payload, false, issuePermit);
			} catch (error) {
				if (error instanceof ProviderCallAuthorityPreflightError) throw error;
				lastError = error;
				continue;
			}
			if (response.status >= 500) {
				lastError = new Error(`Provider-call receipt failed with HTTP ${response.status}`);
				continue;
			}
			if (response.status !== 200 && response.status !== 201) {
				throw new Error(`Provider-call receipt failed with HTTP ${response.status}`);
			}
			try {
				return await this.#readReceiptAcknowledgement(
					response,
					receipt,
					expectedReceiptSha256,
					terminal ? "terminal" : "ambiguous",
				);
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error("Provider-call authority returned an invalid receipt acknowledgement", { cause: lastError });
	}

	async #readReceiptAcknowledgement(
		response: Response,
		receipt: ProviderCallReceiptRequest,
		expectedReceiptSha256: string,
		expectedState: "terminal" | "ambiguous",
	): Promise<ProviderCallReceiptAck> {
		const wire = await readStrictAuthorityJson(response, "Provider-call receipt acknowledgement");
		assertExactKeys(
			wire,
			[
				"schema",
				"disposition",
				"reservation_id",
				"state",
				"receipt_operation_id",
				"receipt_sha256",
				"recorded_at",
				"settlements",
				"capability_state",
				"zero_reason",
			],
			"Provider-call receipt acknowledgement",
		);
		const expectedDisposition = response.status === 201 ? "created" : "exact_replay";
		const terminalRequiresZero =
			expectedState === "terminal" &&
			(receipt.failureClass === "rate_limited_429" ||
				receipt.failureClass === "quota_exhausted" ||
				receipt.failureClass === "auth_rejected");
		const expectedCapabilityState = expectedState === "ambiguous" || terminalRequiresZero ? "zero" : "ready";
		const validZeroReason =
			expectedCapabilityState === "ready"
				? wire.zero_reason === ""
				: typeof wire.zero_reason === "string" && wire.zero_reason.length > 0;
		if (
			wire.schema !== "terminal-bench/provider-call-receipt-result/v1" ||
			wire.disposition !== expectedDisposition ||
			wire.reservation_id !== receipt.reservation.reservationId ||
			wire.state !== expectedState ||
			wire.receipt_operation_id !== receipt.receiptOperationId ||
			wire.receipt_sha256 !== expectedReceiptSha256 ||
			typeof wire.recorded_at !== "string" ||
			!isCanonicalAuthorityTimestamp(wire.recorded_at) ||
			wire.capability_state !== expectedCapabilityState ||
			!validZeroReason
		) {
			throw new Error("Invalid provider-call receipt acknowledgement identity");
		}
		if (!Array.isArray(wire.settlements) || wire.settlements.length !== receipt.context.expectedDimensions.length) {
			throw new Error("Invalid provider-call receipt acknowledgement settlements");
		}
		const actualByDimension = new Map(
			(receipt.actualDimensions ?? []).map(dimension => [
				`${dimension.dimension}\0${dimension.windowId}`,
				dimension.amount,
			]),
		);
		const settlements = wire.settlements.map((element, index) => {
			if (!element || typeof element !== "object" || Array.isArray(element)) {
				throw new Error(`Invalid provider-call receipt acknowledgement settlement ${index}`);
			}
			const settlement = element as Record<string, unknown>;
			assertExactKeys(
				settlement,
				["dimension", "window_id", "reserved_amount", "actual_amount", "settlement"],
				`Provider-call receipt acknowledgement settlement ${index}`,
			);
			const expected = receipt.context.expectedDimensions[index];
			const expectedActual =
				expectedState === "ambiguous" ? null : actualByDimension.get(`${expected.dimension}\0${expected.windowId}`);
			if (expectedState === "terminal" && expectedActual === undefined) {
				throw new Error(`Invalid provider-call terminal receipt actual dimension ${index}`);
			}
			const actualAmount = expectedActual ?? null;
			const expectedSettlement: ProviderCallReceiptAck["settlements"][number]["settlement"] =
				expectedState === "ambiguous"
					? "held_ambiguous"
					: expected.dimension === "concurrency"
						? "released"
						: "consumed_until_window_end";
			if (
				settlement.dimension !== expected.dimension ||
				settlement.window_id !== expected.windowId ||
				settlement.reserved_amount !== expected.amount ||
				settlement.actual_amount !== actualAmount ||
				settlement.settlement !== expectedSettlement
			) {
				throw new Error(`Invalid provider-call receipt acknowledgement settlement ${index}`);
			}
			return {
				dimension: expected.dimension,
				windowId: expected.windowId,
				reservedAmount: expected.amount,
				actualAmount,
				settlement: expectedSettlement,
			};
		});
		return {
			disposition: expectedDisposition,
			reservationId: receipt.reservation.reservationId,
			state: expectedState,
			receiptOperationId: receipt.receiptOperationId,
			receiptSha256: expectedReceiptSha256,
			recordedAt: wire.recorded_at,
			settlements,
			capabilityState: expectedCapabilityState,
			zeroReason: wire.zero_reason as string,
		};
	}

	async #send(
		method: "POST" | "PUT",
		path: string,
		payload: unknown,
		executionToken: boolean,
		permit?: string,
	): Promise<Response> {
		let gatewayToken: string;
		let workerToken: string | undefined;
		try {
			gatewayToken = await this.#getGatewayToken(this.#signal);
			workerToken = executionToken ? await this.#getExecutionToken(this.#signal) : undefined;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new ProviderCallAuthorityPreflightError(`Provider-call projected token preflight failed: ${detail}`, {
				cause: error,
			});
		}
		if (!gatewayToken || (executionToken && !workerToken)) {
			throw new ProviderCallAuthorityPreflightError("Provider-call projected token unavailable");
		}
		return this.#fetch(`${this.#baseUrl}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${gatewayToken}`,
				"content-type": "application/json",
				...(workerToken ? { "X-Terminal-Bench-Execution-Token": workerToken } : {}),
				...(permit ? { "X-Terminal-Bench-Issue-Permit": permit } : {}),
			},
			body: JSON.stringify(payload),
			redirect: "manual",
			signal: this.#signal,
		});
	}
}
