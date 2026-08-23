import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { providerCallReceiptRequestSha256 } from "./provider-call-authority";
import { assertNoDuplicateJsonKeys } from "./provider-call-gateway";
import {
	providerCallOriginAssignmentsEqual,
	resolveProviderCallOriginBinding,
	validateProviderCallOriginAssignment,
} from "./provider-call-origin-manifest";
import type {
	ProviderCallAuthority,
	ProviderCallContext,
	ProviderCallDimension,
	ProviderCallJournal,
	ProviderCallJournalLease,
	ProviderCallReceiptAck,
	ProviderCallReceiptRequest,
	ProviderCallRecoveredReceipt,
	ProviderCallRecoverRequest,
	ProviderCallReservationReference,
	ProviderCallReserveRequest,
} from "./types";

type ActivePhase =
	| "prepared"
	| "reserve_uncertain"
	| "issue_authorized"
	| "provider_attempted"
	| "receipt_pending"
	| "orphaned";

interface ActiveCall {
	phase: ActivePhase;
	context: ProviderCallContext;
	lease: ProviderCallJournalLease;
	recoverRequest?: ProviderCallRecoverRequest;
	reservation?: ProviderCallReservationReference;
	providerAttemptedAt?: string;
	pendingReceipt?: ProviderCallReceiptRequest;
	pendingReceiptSha256?: string;
}

interface BindingState {
	lastCompletedSequence: string;
	active?: ActiveCall;
}

interface JournalState {
	schema: "terminal-bench/provider-call-journal/v3";
	podUid: string | null;
	bindings: Record<string, BindingState>;
}

interface OwnerRecord {
	schema: "terminal-bench/provider-call-journal-owner/v1";
	runtimeId: string;
	pid: string;
	uid: string;
	bootId: string;
	processStartTicks: string;
	podUid: string | null;
}

export interface FileProviderCallJournalOptions {
	expectedPodUid?: string;
	maxBytes?: number;
}

export interface StrictOwnedFileOptions {
	mode: number;
	maxBytes: number;
	label: string;
}

const JOURNAL_SCHEMA = "terminal-bench/provider-call-journal/v3" as const;
const OWNER_SCHEMA = "terminal-bench/provider-call-journal-owner/v1" as const;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_SHA256 = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const API_FAMILIES = new Set(["openai-completions", "google-gemini-cli", "openai-responses"]);
const DIMENSION_NAMES = new Set([
	"concurrency",
	"rpm_requests",
	"tpm_input_tokens",
	"tpm_output_tokens",
	"tpm_total_tokens",
	"provider_window",
]);
const AMBIGUITY_CLASSES = new Set([
	"request_write_unknown",
	"premature_eof",
	"connection_lost",
	"gateway_crash_recovery",
	"response_incomplete",
	"usage_unknown",
	"authority_response_unknown",
	"worker_disconnect_gateway_failed",
]);
const FAILURE_CLASSES = new Set([
	"none",
	"http_3xx",
	"http_4xx",
	"http_5xx",
	"rate_limited_429",
	"quota_exhausted",
	"auth_rejected",
	"provider_protocol",
]);

function emptyState(): JournalState {
	return { schema: JOURNAL_SCHEMA, podUid: null, bindings: {} };
}

function nextSequence(last: string): string {
	return String(BigInt(last) + 1n);
}

function assertExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	label: string,
): void {
	const requiredSet = new Set(required);
	const allowed = new Set([...required, ...optional]);
	const keys = Object.keys(value);
	if (keys.some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key))) {
		throw new Error(`${label} has invalid fields`);
	}
	if (keys.length < requiredSet.size) throw new Error(`${label} has invalid fields`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, pattern?: RegExp): string {
	if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}
function isCanonicalTimestamp(value: string): boolean {
	if (!CANONICAL_TIMESTAMP.test(value)) return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 23) === value.slice(0, 23);
}

function requireTimestamp(value: unknown, label: string): string {
	const timestamp = requireString(value, label, CANONICAL_TIMESTAMP);
	if (!isCanonicalTimestamp(timestamp)) throw new Error(`${label} is invalid`);
	return timestamp;
}

function requireNullableTimestamp(value: unknown, label: string): string | null {
	if (value === null) return null;
	return requireTimestamp(value, label);
}

function hydrateDimension(value: unknown, label: string, requirePositiveAmount = true): ProviderCallDimension {
	const record = requireRecord(value, label);
	assertExactKeys(record, ["dimension", "windowId", "amount", "unitScale", "windowStart", "windowEnd"], [], label);
	const dimension = requireString(record.dimension, `${label}.dimension`);
	if (!DIMENSION_NAMES.has(dimension)) throw new Error(`${label}.dimension is invalid`);
	const windowId = requireString(record.windowId, `${label}.windowId`);
	const amount = requireString(
		record.amount,
		`${label}.amount`,
		requirePositiveAmount ? /^[1-9][0-9]*$/ : CANONICAL_INTEGER,
	);
	const unitScale = requireString(record.unitScale, `${label}.unitScale`, /^[0-9]$/);
	const windowStart = requireNullableTimestamp(record.windowStart, `${label}.windowStart`);
	const windowEnd = requireNullableTimestamp(record.windowEnd, `${label}.windowEnd`);
	if ((windowStart === null) !== (windowEnd === null)) throw new Error(`${label} has an invalid window`);
	return {
		dimension: dimension as ProviderCallDimension["dimension"],
		windowId,
		amount,
		unitScale,
		windowStart,
		windowEnd,
	};
}

function hydrateProviderCallUsage(
	value: unknown,
	label: string,
): NonNullable<ProviderCallReceiptRequest["providerUsage"]> {
	const record = requireRecord(value, label);
	assertExactKeys(record, ["unit", "coefficient", "scale"], [], label);
	const unit = requireString(record.unit, `${label}.unit`);
	const coefficient = requireString(record.coefficient, `${label}.coefficient`, CANONICAL_INTEGER);
	const scale = requireString(record.scale, `${label}.scale`, /^[0-9]$/);
	if ((coefficient === "0" && scale !== "0") || (coefficient !== "0" && scale !== "0" && coefficient.endsWith("0"))) {
		throw new Error(`${label} is not canonical`);
	}
	return { unit, coefficient, scale };
}

function hydrateContext(value: unknown, label: string): ProviderCallContext {
	const record = requireRecord(value, label);
	assertExactKeys(
		record,
		[
			"mode",
			"configId",
			"taskReservationId",
			"providerRouteAssignmentId",
			"executionBindingId",
			"podUid",
			"callSequence",
			"idempotencyKey",
			"apiFamily",
			"provider",
			"accountId",
			"modelId",
			"credentialGeneration",
			"capabilityId",
			"snapshotId",
			"assignmentSha256",
			"tokenizerContractSha256",
			"inputTokens",
			"maxOutputTokens",
			"expectedDimensions",
			"originAssignment",
		],
		[],
		label,
	);
	if (record.mode !== "strict") throw new Error(`${label}.mode is invalid`);
	const apiFamily = requireString(record.apiFamily, `${label}.apiFamily`);
	if (!API_FAMILIES.has(apiFamily)) throw new Error(`${label}.apiFamily is invalid`);
	if (!Array.isArray(record.expectedDimensions) || record.expectedDimensions.length === 0) {
		throw new Error(`${label}.expectedDimensions is invalid`);
	}
	const expectedDimensions = record.expectedDimensions.map((dimension, index) =>
		hydrateDimension(dimension, `${label}.expectedDimensions[${index}]`),
	);
	let previousDimensionKey: string | undefined;
	for (const dimension of expectedDimensions) {
		const key = `${dimension.dimension}\0${dimension.windowId}`;
		if (
			previousDimensionKey !== undefined &&
			Buffer.compare(Buffer.from(previousDimensionKey), Buffer.from(key)) >= 0
		) {
			throw new Error(`${label}.expectedDimensions is invalid or unsorted`);
		}
		previousDimensionKey = key;
	}
	const context: ProviderCallContext = {
		mode: "strict",
		configId: requireString(record.configId, `${label}.configId`),
		taskReservationId: requireString(record.taskReservationId, `${label}.taskReservationId`, CANONICAL_UUID),
		providerRouteAssignmentId: requireString(
			record.providerRouteAssignmentId,
			`${label}.providerRouteAssignmentId`,
			CANONICAL_UUID,
		),
		executionBindingId: requireString(record.executionBindingId, `${label}.executionBindingId`, CANONICAL_UUID),
		podUid: requireString(record.podUid, `${label}.podUid`),
		callSequence: requireString(record.callSequence, `${label}.callSequence`, /^[1-9][0-9]*$/),
		idempotencyKey: requireString(record.idempotencyKey, `${label}.idempotencyKey`, CANONICAL_UUID),
		apiFamily: apiFamily as ProviderCallContext["apiFamily"],
		provider: requireString(record.provider, `${label}.provider`),
		accountId: requireString(record.accountId, `${label}.accountId`),
		modelId: requireString(record.modelId, `${label}.modelId`),
		credentialGeneration: requireString(record.credentialGeneration, `${label}.credentialGeneration`),
		capabilityId: requireString(record.capabilityId, `${label}.capabilityId`, CANONICAL_UUID),
		snapshotId: requireString(record.snapshotId, `${label}.snapshotId`, CANONICAL_UUID),
		assignmentSha256: requireString(record.assignmentSha256, `${label}.assignmentSha256`, CANONICAL_SHA256),
		tokenizerContractSha256: requireString(
			record.tokenizerContractSha256,
			`${label}.tokenizerContractSha256`,
			CANONICAL_SHA256,
		),
		inputTokens: requireString(record.inputTokens, `${label}.inputTokens`, CANONICAL_INTEGER),
		maxOutputTokens: requireString(record.maxOutputTokens, `${label}.maxOutputTokens`, CANONICAL_INTEGER),
		expectedDimensions,
		originAssignment: validateProviderCallOriginAssignment(structuredClone(record.originAssignment)),
	};
	for (const [field, value] of Object.entries({
		configId: context.configId,
		taskReservationId: context.taskReservationId,
		executionBindingId: context.executionBindingId,
		podUid: context.podUid,
		idempotencyKey: context.idempotencyKey,
		accountId: context.accountId,
		credentialGeneration: context.credentialGeneration,
		capabilityId: context.capabilityId,
		snapshotId: context.snapshotId,
		tokenizerContractSha256: context.tokenizerContractSha256,
		inputTokens: context.inputTokens,
		maxOutputTokens: context.maxOutputTokens,
	})) {
		if (!value.trim()) throw new Error(`${label}.${field} is invalid`);
	}
	const origin = resolveProviderCallOriginBinding(
		context.originAssignment.config_id,
		context.originAssignment.route_ordinal,
	);
	if (
		context.configId !== context.originAssignment.config_id ||
		context.credentialGeneration !== context.originAssignment.credential_generation ||
		origin.provider !== context.provider ||
		origin.modelId !== context.modelId ||
		origin.apiFamily !== context.apiFamily
	) {
		throw new Error(`${label} origin assignment identity is invalid`);
	}
	return context;
}

function copyContext(context: ProviderCallContext): ProviderCallContext {
	return hydrateContext(structuredClone(context), "Provider-call context");
}
function sameDimension(left: ProviderCallDimension, right: ProviderCallDimension): boolean {
	return (
		left.dimension === right.dimension &&
		left.windowId === right.windowId &&
		left.amount === right.amount &&
		left.unitScale === right.unitScale &&
		left.windowStart === right.windowStart &&
		left.windowEnd === right.windowEnd
	);
}

function sameContext(left: ProviderCallContext, right: ProviderCallContext): boolean {
	for (const field of [
		"mode",
		"configId",
		"taskReservationId",
		"executionBindingId",
		"podUid",
		"callSequence",
		"idempotencyKey",
		"apiFamily",
		"provider",
		"accountId",
		"modelId",
		"credentialGeneration",
		"capabilityId",
		"snapshotId",
		"assignmentSha256",
		"tokenizerContractSha256",
		"inputTokens",
		"maxOutputTokens",
	] as const) {
		if (left[field] !== right[field]) return false;
	}
	return (
		providerCallOriginAssignmentsEqual(left.originAssignment, right.originAssignment) &&
		left.expectedDimensions.length === right.expectedDimensions.length &&
		left.expectedDimensions.every((dimension, index) => sameDimension(dimension, right.expectedDimensions[index]))
	);
}

function sameReservation(left: ProviderCallReservationReference, right: ProviderCallReservationReference): boolean {
	return (
		left.reservationId === right.reservationId &&
		left.disposition === right.disposition &&
		left.callSequence === right.callSequence &&
		left.idempotencyKey === right.idempotencyKey &&
		left.requestSha256 === right.requestSha256 &&
		left.assignmentSha256 === right.assignmentSha256 &&
		left.issueAuthorizedAt === right.issueAuthorizedAt &&
		providerCallOriginAssignmentsEqual(left.originAssignment, right.originAssignment)
	);
}

function hydrateLease(value: unknown, label: string): ProviderCallJournalLease {
	const record = requireRecord(value, label);
	assertExactKeys(record, ["executionBindingId", "callSequence", "idempotencyKey", "receiptOperationId"], [], label);
	return {
		executionBindingId: requireString(record.executionBindingId, `${label}.executionBindingId`, CANONICAL_UUID),
		callSequence: requireString(record.callSequence, `${label}.callSequence`, CANONICAL_INTEGER),
		idempotencyKey: requireString(record.idempotencyKey, `${label}.idempotencyKey`, CANONICAL_UUID),
		receiptOperationId: requireString(record.receiptOperationId, `${label}.receiptOperationId`, CANONICAL_UUID),
	};
}

function copyLease(lease: ProviderCallJournalLease): ProviderCallJournalLease {
	return hydrateLease(structuredClone(lease), "Provider-call lease");
}

function hydrateRecoverRequest(value: unknown, label: string): ProviderCallRecoverRequest {
	const record = requireRecord(value, label);
	assertExactKeys(record, ["context", "requestSha256"], [], label);
	return {
		context: hydrateContext(record.context, `${label}.context`),
		requestSha256: requireString(record.requestSha256, `${label}.requestSha256`, CANONICAL_SHA256),
	};
}

function copyRecoverRequest(request: ProviderCallReserveRequest): ProviderCallRecoverRequest {
	return hydrateRecoverRequest(
		{ context: structuredClone(request.context), requestSha256: request.requestSha256 },
		"Provider-call recover request",
	);
}

function hydrateReservation(value: unknown, label: string): ProviderCallReservationReference {
	const record = requireRecord(value, label);
	assertExactKeys(
		record,
		[
			"reservationId",
			"disposition",
			"callSequence",
			"idempotencyKey",
			"requestSha256",
			"issueAuthorizedAt",
			"assignmentSha256",
			"originAssignment",
		],
		[],
		label,
	);
	if (record.disposition !== "created") throw new Error(`${label}.disposition is invalid`);
	return {
		reservationId: requireString(record.reservationId, `${label}.reservationId`, CANONICAL_UUID),
		disposition: "created",
		callSequence: requireString(record.callSequence, `${label}.callSequence`, CANONICAL_INTEGER),
		idempotencyKey: requireString(record.idempotencyKey, `${label}.idempotencyKey`, CANONICAL_UUID),
		requestSha256: requireString(record.requestSha256, `${label}.requestSha256`, CANONICAL_SHA256),
		issueAuthorizedAt: requireTimestamp(record.issueAuthorizedAt, `${label}.issueAuthorizedAt`),
		assignmentSha256: requireString(record.assignmentSha256, `${label}.assignmentSha256`, CANONICAL_SHA256),
		originAssignment: validateProviderCallOriginAssignment(structuredClone(record.originAssignment)),
	};
}

function copyReservation(value: ProviderCallReservationReference): ProviderCallReservationReference {
	const candidate = {
		reservationId: value.reservationId,
		disposition: value.disposition,
		callSequence: value.callSequence,
		idempotencyKey: value.idempotencyKey,
		requestSha256: value.requestSha256,
		issueAuthorizedAt: value.issueAuthorizedAt,
		assignmentSha256: value.assignmentSha256,
		originAssignment: structuredClone(value.originAssignment),
	};
	return hydrateReservation(candidate, "Provider-call reservation reference");
}

function hydrateReceipt(value: unknown, label: string): ProviderCallReceiptRequest {
	const record = requireRecord(value, label);
	assertExactKeys(
		record,
		[
			"context",
			"reservation",
			"receiptOperationId",
			"classification",
			"authorityOwner",
			"backendEqualityResult",
			"providerRequestCount",
			"retryCount",
			"failoverCount",
			"redirectFollowCount",
			"finalClassification",
			"drainState",
			"providerFinishedAt",
		],
		[
			"providerStartedAt",
			"httpStatus",
			"providerRequestId",
			"responseSha256",
			"failureClass",
			"providerErrorCode",
			"retryAfterAt",
			"actualDimensions",
			"providerUsage",
			"ambiguityClass",
			"requestMayHaveReachedProvider",
			"requestBytesWritten",
			"responseBytesReceived",
		],
		label,
	);
	const classification = record.classification;
	if (classification !== "terminal" && classification !== "ambiguous") {
		throw new Error(`${label}.classification is invalid`);
	}
	const context = hydrateContext(record.context, `${label}.context`);
	const reservation = hydrateReservation(record.reservation, `${label}.reservation`);
	if (
		!providerCallOriginAssignmentsEqual(context.originAssignment, reservation.originAssignment) ||
		context.assignmentSha256 !== reservation.assignmentSha256
	) {
		throw new Error(`${label} assignment evidence mismatch`);
	}
	const expectedOwner = resolveProviderCallOriginBinding(
		context.originAssignment.config_id,
		context.originAssignment.route_ordinal,
	).authorityOwner;
	const expectedFinalClassification = classification === "terminal" ? "TERMINAL_RESPONSE" : "AMBIGUOUS_ATTEMPT";
	if (
		record.authorityOwner !== expectedOwner ||
		record.backendEqualityResult !== "MATCH" ||
		record.providerRequestCount !== 1 ||
		record.retryCount !== 0 ||
		record.failoverCount !== 0 ||
		record.redirectFollowCount !== 0 ||
		record.finalClassification !== expectedFinalClassification ||
		(record.drainState !== "DRAINED" && record.drainState !== "FROZEN")
	) {
		throw new Error(`${label} durable evidence mismatch`);
	}
	const base: ProviderCallReceiptRequest = {
		context,
		reservation,
		receiptOperationId: requireString(record.receiptOperationId, `${label}.receiptOperationId`, CANONICAL_UUID),
		classification,
		authorityOwner: expectedOwner,
		backendEqualityResult: "MATCH",
		providerRequestCount: 1,
		retryCount: 0,
		failoverCount: 0,
		redirectFollowCount: 0,
		finalClassification: expectedFinalClassification,
		drainState: record.drainState,
		providerFinishedAt: requireTimestamp(record.providerFinishedAt, `${label}.providerFinishedAt`),
	};
	if (record.providerStartedAt !== undefined) {
		base.providerStartedAt = requireTimestamp(record.providerStartedAt, `${label}.providerStartedAt`);
	}
	if (record.httpStatus !== undefined) {
		base.httpStatus = requireString(record.httpStatus, `${label}.httpStatus`, /^(?:[1-5][0-9]{2})$/);
	}
	if (record.providerRequestId !== undefined) {
		base.providerRequestId = requireString(record.providerRequestId, `${label}.providerRequestId`);
	}
	if (record.responseSha256 !== undefined) {
		base.responseSha256 = requireString(record.responseSha256, `${label}.responseSha256`, CANONICAL_SHA256);
	}
	if (record.requestBytesWritten !== undefined) {
		base.requestBytesWritten = requireString(
			record.requestBytesWritten,
			`${label}.requestBytesWritten`,
			CANONICAL_INTEGER,
		);
	}
	if (record.responseBytesReceived !== undefined) {
		base.responseBytesReceived = requireString(
			record.responseBytesReceived,
			`${label}.responseBytesReceived`,
			CANONICAL_INTEGER,
		);
	}
	if (classification === "terminal") {
		if (
			record.ambiguityClass !== undefined ||
			record.requestMayHaveReachedProvider !== undefined ||
			!base.providerStartedAt ||
			!base.httpStatus ||
			!base.responseSha256 ||
			!Array.isArray(record.actualDimensions)
		) {
			throw new Error(`${label} has invalid terminal fields`);
		}
		const failureClass = requireString(record.failureClass, `${label}.failureClass`);
		if (!FAILURE_CLASSES.has(failureClass)) throw new Error(`${label}.failureClass is invalid`);
		base.failureClass = failureClass as NonNullable<ProviderCallReceiptRequest["failureClass"]>;
		base.actualDimensions = record.actualDimensions.map((dimension, index) =>
			hydrateDimension(dimension, `${label}.actualDimensions[${index}]`, false),
		);
		if (
			base.actualDimensions.length !== context.expectedDimensions.length ||
			base.actualDimensions.some((dimension, index) => {
				const expected = context.expectedDimensions[index];
				return (
					dimension.dimension !== expected.dimension ||
					dimension.windowId !== expected.windowId ||
					dimension.unitScale !== expected.unitScale ||
					dimension.windowStart !== expected.windowStart ||
					dimension.windowEnd !== expected.windowEnd
				);
			})
		) {
			throw new Error(`${label}.actualDimensions is incomplete or mismatched`);
		}
		if (record.providerErrorCode !== undefined) {
			base.providerErrorCode = requireString(record.providerErrorCode, `${label}.providerErrorCode`);
		}
		if (record.retryAfterAt !== undefined) {
			base.retryAfterAt = requireTimestamp(record.retryAfterAt, `${label}.retryAfterAt`);
		}
		if (record.providerUsage !== undefined) {
			base.providerUsage = hydrateProviderCallUsage(record.providerUsage, `${label}.providerUsage`);
		}
	} else {
		if (
			record.failureClass !== undefined ||
			record.providerErrorCode !== undefined ||
			record.retryAfterAt !== undefined ||
			record.providerUsage !== undefined ||
			record.actualDimensions !== undefined ||
			typeof record.requestMayHaveReachedProvider !== "boolean"
		) {
			throw new Error(`${label} has invalid ambiguous fields`);
		}
		const ambiguityClass = requireString(record.ambiguityClass, `${label}.ambiguityClass`);
		if (!AMBIGUITY_CLASSES.has(ambiguityClass)) throw new Error(`${label}.ambiguityClass is invalid`);
		base.ambiguityClass = ambiguityClass as NonNullable<ProviderCallReceiptRequest["ambiguityClass"]>;
		base.requestMayHaveReachedProvider = record.requestMayHaveReachedProvider;
		if (!base.requestBytesWritten || !base.responseBytesReceived) {
			throw new Error(`${label} has incomplete ambiguous byte counts`);
		}
	}
	return base;
}

function copyReceipt(receipt: ProviderCallReceiptRequest): ProviderCallReceiptRequest {
	const candidate: Record<string, unknown> = {
		context: structuredClone(receipt.context),
		reservation: copyReservation(receipt.reservation),
		receiptOperationId: receipt.receiptOperationId,
		classification: receipt.classification,
		providerFinishedAt: receipt.providerFinishedAt,
		authorityOwner: receipt.authorityOwner,
		backendEqualityResult: receipt.backendEqualityResult,
		providerRequestCount: receipt.providerRequestCount,
		retryCount: receipt.retryCount,
		failoverCount: receipt.failoverCount,
		redirectFollowCount: receipt.redirectFollowCount,
		finalClassification: receipt.finalClassification,
		drainState: receipt.drainState,
	};
	for (const key of [
		"providerStartedAt",
		"httpStatus",
		"providerRequestId",
		"responseSha256",
		"failureClass",
		"providerErrorCode",
		"retryAfterAt",
		"actualDimensions",
		"providerUsage",
		"ambiguityClass",
		"requestMayHaveReachedProvider",
		"requestBytesWritten",
		"responseBytesReceived",
	] as const) {
		if (receipt[key] !== undefined) candidate[key] = structuredClone(receipt[key]);
	}
	return hydrateReceipt(candidate, "Provider-call pending receipt");
}

function hydrateActive(value: unknown, label: string): ActiveCall {
	const record = requireRecord(value, label);
	assertExactKeys(
		record,
		["phase", "context", "lease"],
		["recoverRequest", "reservation", "providerAttemptedAt", "pendingReceipt", "pendingReceiptSha256"],
		label,
	);
	const phase = requireString(record.phase, `${label}.phase`);
	if (
		!new Set<ActivePhase>([
			"prepared",
			"reserve_uncertain",
			"issue_authorized",
			"provider_attempted",
			"receipt_pending",
			"orphaned",
		]).has(phase as ActivePhase)
	) {
		throw new Error(`${label}.phase is invalid`);
	}
	const context = hydrateContext(record.context, `${label}.context`);
	const lease = hydrateLease(record.lease, `${label}.lease`);
	if (
		lease.executionBindingId !== context.executionBindingId ||
		lease.callSequence !== context.callSequence ||
		lease.idempotencyKey !== context.idempotencyKey
	) {
		throw new Error(`${label} identity is invalid`);
	}
	const active: ActiveCall = { phase: phase as ActivePhase, context, lease };
	if (record.recoverRequest !== undefined) {
		active.recoverRequest = hydrateRecoverRequest(record.recoverRequest, `${label}.recoverRequest`);
		if (!sameContext(active.recoverRequest.context, context)) {
			throw new Error(`${label}.recoverRequest identity is invalid`);
		}
	}
	if (record.reservation !== undefined)
		active.reservation = hydrateReservation(record.reservation, `${label}.reservation`);
	if (record.providerAttemptedAt !== undefined) {
		active.providerAttemptedAt = requireTimestamp(record.providerAttemptedAt, `${label}.providerAttemptedAt`);
	}
	if (record.pendingReceipt !== undefined)
		active.pendingReceipt = hydrateReceipt(record.pendingReceipt, `${label}.pendingReceipt`);
	if (record.pendingReceiptSha256 !== undefined) {
		active.pendingReceiptSha256 = requireString(
			record.pendingReceiptSha256,
			`${label}.pendingReceiptSha256`,
			CANONICAL_SHA256,
		);
	}
	if (phase !== "prepared" && !active.recoverRequest) throw new Error(`${label} lacks recovery identity`);
	if (
		["issue_authorized", "provider_attempted", "receipt_pending", "orphaned"].includes(phase) &&
		!active.reservation
	) {
		throw new Error(`${label} lacks reservation identity`);
	}
	if (["provider_attempted", "receipt_pending"].includes(phase) && !active.providerAttemptedAt) {
		throw new Error(`${label} lacks provider-attempt identity`);
	}
	if (phase === "receipt_pending") {
		if (!active.pendingReceipt || !active.pendingReceiptSha256) throw new Error(`${label} lacks pending receipt`);
	} else if (active.pendingReceipt || active.pendingReceiptSha256) {
		throw new Error(`${label} has pending receipt fields in an invalid phase`);
	}
	if (active.reservation) assertReservationIdentity(active, active.reservation);
	if (active.pendingReceipt) {
		if (
			active.pendingReceipt.receiptOperationId !== lease.receiptOperationId ||
			!active.reservation ||
			!sameContext(active.pendingReceipt.context, context) ||
			!sameReservation(active.pendingReceipt.reservation, active.reservation) ||
			active.pendingReceipt.providerStartedAt !== active.providerAttemptedAt
		) {
			throw new Error(`${label}.pendingReceipt identity is invalid`);
		}
		if (providerCallReceiptRequestSha256(active.pendingReceipt) !== active.pendingReceiptSha256) {
			throw new Error(`${label}.pendingReceipt SHA-256 is invalid`);
		}
	}
	return active;
}

function hydrateState(value: unknown, expectedPodUid?: string): JournalState {
	const record = requireRecord(value, "Provider-call journal hydrate");
	assertExactKeys(record, ["schema", "podUid", "bindings"], [], "Provider-call journal hydrate");
	if (record.schema !== JOURNAL_SCHEMA) throw new Error("Provider-call journal hydrate has an invalid schema");
	if (record.podUid !== null && typeof record.podUid !== "string") {
		throw new Error("Provider-call journal hydrate has an invalid pod UID");
	}
	const podUid = record.podUid as string | null;
	if (podUid !== null && !podUid) throw new Error("Provider-call journal hydrate has an invalid pod UID");
	if (expectedPodUid !== undefined && podUid !== null && podUid !== expectedPodUid) {
		throw new Error("Provider-call journal belongs to a different Pod UID");
	}
	const rawBindings = requireRecord(record.bindings, "Provider-call journal hydrate.bindings");
	const bindings: Record<string, BindingState> = {};
	for (const [bindingId, rawBinding] of Object.entries(rawBindings)) {
		if (!CANONICAL_UUID.test(bindingId)) throw new Error("Provider-call journal hydrate has an invalid binding ID");
		const bindingRecord = requireRecord(rawBinding, `Provider-call journal binding ${bindingId}`);
		assertExactKeys(
			bindingRecord,
			["lastCompletedSequence"],
			["active"],
			`Provider-call journal binding ${bindingId}`,
		);
		const lastCompletedSequence = requireString(
			bindingRecord.lastCompletedSequence,
			`Provider-call journal binding ${bindingId}.lastCompletedSequence`,
			CANONICAL_INTEGER,
		);
		const binding: BindingState = { lastCompletedSequence };
		if (bindingRecord.active !== undefined) {
			binding.active = hydrateActive(bindingRecord.active, `Provider-call journal binding ${bindingId}.active`);
			if (binding.active.context.executionBindingId !== bindingId) {
				throw new Error(`Provider-call journal binding ${bindingId} has invalid active identity`);
			}
			if (binding.active.context.podUid !== podUid) {
				throw new Error(`Provider-call journal binding ${bindingId} has invalid Pod identity`);
			}
			if (binding.active.context.callSequence !== nextSequence(lastCompletedSequence)) {
				throw new Error(`Provider-call journal binding ${bindingId} has invalid active sequence`);
			}
		}
		bindings[bindingId] = binding;
	}
	return { schema: JOURNAL_SCHEMA, podUid, bindings };
}

function assertReservationIdentity(active: ActiveCall, reservation: ProviderCallReservationReference): void {
	if (
		reservation.callSequence !== active.lease.callSequence ||
		reservation.idempotencyKey !== active.lease.idempotencyKey ||
		reservation.requestSha256 !== active.recoverRequest?.requestSha256 ||
		reservation.assignmentSha256 !== active.context.assignmentSha256 ||
		!providerCallOriginAssignmentsEqual(reservation.originAssignment, active.context.originAssignment)
	) {
		throw new Error("Provider-call journal reservation identity mismatch");
	}
}

function assertLease(active: ActiveCall | undefined, lease: ProviderCallJournalLease): ActiveCall {
	if (
		!active ||
		active.lease.executionBindingId !== lease.executionBindingId ||
		active.lease.callSequence !== lease.callSequence ||
		active.lease.idempotencyKey !== lease.idempotencyKey ||
		active.lease.receiptOperationId !== lease.receiptOperationId
	) {
		throw new Error("Provider-call journal lease does not own the active call");
	}
	return active;
}

function assertAcknowledgement(active: ActiveCall, acknowledgement: ProviderCallReceiptAck): void {
	const pending = active.pendingReceipt;
	if (
		active.phase !== "receipt_pending" ||
		!pending ||
		acknowledgement.reservationId !== pending.reservation.reservationId ||
		acknowledgement.receiptOperationId !== pending.receiptOperationId ||
		acknowledgement.state !== pending.classification ||
		acknowledgement.receiptSha256 !== active.pendingReceiptSha256 ||
		!isCanonicalTimestamp(acknowledgement.recordedAt)
	) {
		throw new Error("Provider-call journal received a mismatched receipt acknowledgement");
	}
}

function assertRecoveredReceipt(
	active: ActiveCall,
	state: "terminal" | "ambiguous",
	receipt: ProviderCallRecoveredReceipt,
): void {
	if (
		receipt.classification !== (state === "terminal" ? "terminal_response" : "ambiguous_attempt") ||
		receipt.receiptOperationId !== active.lease.receiptOperationId ||
		receipt.receiptSha256 !== active.pendingReceiptSha256 ||
		!isCanonicalTimestamp(receipt.recordedAt) ||
		(active.pendingReceipt !== undefined && active.pendingReceipt.classification !== state)
	) {
		throw new Error("Provider-call recovery returned a mismatched receipt identity");
	}
}

class BindingMutex {
	readonly #tails = new Map<string, Promise<void>>();

	async acquire(key: string): Promise<() => void> {
		const previous = this.#tails.get(key) ?? Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const tail = previous.then(() => promise);
		this.#tails.set(key, tail);
		await previous;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			resolve();
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		};
	}
}

abstract class BaseProviderCallJournal implements ProviderCallJournal {
	readonly #mutex = new BindingMutex();
	readonly #releases = new Map<string, () => void>();
	#recovery?: Promise<void>;

	protected abstract transact<T>(operation: (state: JournalState) => T | Promise<T>): Promise<T>;

	async begin(
		context: ProviderCallContext,
		reserveRequest?: ProviderCallReserveRequest,
	): Promise<ProviderCallJournalLease> {
		const safeContext = copyContext(context);
		const recoveryIdentity = reserveRequest ? copyRecoverRequest(reserveRequest) : undefined;
		if (
			recoveryIdentity &&
			(recoveryIdentity.context.executionBindingId !== safeContext.executionBindingId ||
				recoveryIdentity.context.callSequence !== safeContext.callSequence ||
				recoveryIdentity.context.idempotencyKey !== safeContext.idempotencyKey)
		) {
			throw new Error("Provider-call journal reserve intent identity mismatch");
		}
		const release = await this.#mutex.acquire(safeContext.executionBindingId);
		try {
			const lease = await this.transact(state => {
				if (state.podUid === null) state.podUid = safeContext.podUid;
				if (state.podUid !== safeContext.podUid)
					throw new Error("Provider-call journal belongs to a different Pod UID");
				const binding = state.bindings[safeContext.executionBindingId] ?? { lastCompletedSequence: "0" };
				if (binding.active) {
					throw new Error(
						`Provider-call journal binding ${safeContext.executionBindingId} has unresolved call ${binding.active.lease.callSequence}`,
					);
				}
				const expected = nextSequence(binding.lastCompletedSequence);
				if (safeContext.callSequence !== expected) {
					throw new Error(
						`Provider-call journal expected call sequence ${expected}, received ${safeContext.callSequence}`,
					);
				}
				const created: ProviderCallJournalLease = {
					executionBindingId: safeContext.executionBindingId,
					callSequence: safeContext.callSequence,
					idempotencyKey: safeContext.idempotencyKey,
					receiptOperationId: randomUUID(),
				};
				binding.active = {
					phase: "prepared",
					context: safeContext,
					lease: created,
					recoverRequest: recoveryIdentity,
				};
				state.bindings[safeContext.executionBindingId] = binding;
				return copyLease(created);
			});
			this.#releases.set(lease.receiptOperationId, release);
			return lease;
		} catch (error) {
			release();
			throw error;
		}
	}

	async markReserveSent(lease: ProviderCallJournalLease): Promise<void> {
		await this.transact(state => {
			const active = assertLease(state.bindings[lease.executionBindingId]?.active, lease);
			if (active.phase !== "prepared" || !active.recoverRequest) {
				throw new Error("Provider-call journal cannot mark reserve sent from the current state");
			}
			active.phase = "reserve_uncertain";
		});
	}

	async storeReservation(
		lease: ProviderCallJournalLease,
		reservation: ProviderCallReservationReference,
	): Promise<void> {
		const safeReservation = copyReservation(reservation);
		await this.transact(state => {
			const active = assertLease(state.bindings[lease.executionBindingId]?.active, lease);
			if (active.phase !== "reserve_uncertain") {
				throw new Error("Provider-call journal cannot store a reservation from the current state");
			}
			assertReservationIdentity(active, safeReservation);
			active.reservation = safeReservation;
			active.phase = "issue_authorized";
		});
	}

	async storeProviderAttempt(lease: ProviderCallJournalLease, attemptedAt: string): Promise<void> {
		if (!isCanonicalTimestamp(attemptedAt)) throw new Error("Provider-call journal attemptedAt must be canonical");
		await this.transact(state => {
			const active = assertLease(state.bindings[lease.executionBindingId]?.active, lease);
			if (active.phase !== "issue_authorized" || !active.reservation) {
				throw new Error("Provider-call journal cannot attempt before reservation");
			}
			active.providerAttemptedAt = attemptedAt;
			active.phase = "provider_attempted";
		});
	}

	async storePendingReceipt(lease: ProviderCallJournalLease, receipt: ProviderCallReceiptRequest): Promise<void> {
		const safeReceipt = copyReceipt(receipt);
		const receiptSha256 = providerCallReceiptRequestSha256(safeReceipt);
		await this.transact(state => {
			const active = assertLease(state.bindings[lease.executionBindingId]?.active, lease);
			if (
				active.phase !== "provider_attempted" ||
				!active.reservation ||
				safeReceipt.receiptOperationId !== lease.receiptOperationId ||
				!sameContext(safeReceipt.context, active.context) ||
				!sameReservation(safeReceipt.reservation, active.reservation) ||
				safeReceipt.providerStartedAt !== active.providerAttemptedAt
			) {
				throw new Error(
					`Provider-call journal pending receipt identity mismatch (phase=${active.phase}, reservation=${
						active.reservation?.reservationId === safeReceipt.reservation.reservationId
					}, operation=${safeReceipt.receiptOperationId === lease.receiptOperationId})`,
				);
			}
			active.pendingReceipt = safeReceipt;
			active.pendingReceiptSha256 = receiptSha256;
			active.phase = "receipt_pending";
		});
	}

	async completeReceipt(lease: ProviderCallJournalLease, acknowledgement: ProviderCallReceiptAck): Promise<void> {
		await this.transact(state => {
			const binding = state.bindings[lease.executionBindingId];
			const active = assertLease(binding?.active, lease);
			assertAcknowledgement(active, acknowledgement);
			binding!.lastCompletedSequence = lease.callSequence;
			delete binding!.active;
		});
		this.#releaseLease(lease.receiptOperationId);
	}

	async recoverPendingReceipts(authority: ProviderCallAuthority): Promise<void> {
		if (this.#recovery) return await this.#recovery;
		this.#recovery = this.#recover(authority);
		try {
			await this.#recovery;
		} finally {
			this.#recovery = undefined;
		}
	}

	async #recover(authority: ProviderCallAuthority): Promise<void> {
		const activeCalls = await this.transact(state =>
			Object.values(state.bindings)
				.map(binding => binding.active)
				.filter((active): active is ActiveCall => active !== undefined)
				.map(active => structuredClone(active)),
		);
		for (const active of activeCalls) {
			if (active.phase === "prepared") {
				await this.#clearUnsent(active.lease);
				continue;
			}
			if (!active.recoverRequest) {
				throw new Error(
					`Provider-call journal cannot recover call ${active.lease.callSequence}: identity is unavailable`,
				);
			}
			const recovered = await authority.recover(active.recoverRequest);
			if (recovered.kind === "absent") {
				if (active.phase !== "reserve_uncertain") {
					await this.#markOrphaned(active.lease);
					throw new Error("Provider-call recovery lost an authorized reservation; binding is frozen");
				}
				await this.#clearUnsent(active.lease);
				continue;
			}
			const reservation = copyReservation(recovered.reservation);
			assertReservationIdentity(active, reservation);
			if (active.reservation && active.reservation.reservationId !== reservation.reservationId) {
				throw new Error("Provider-call recovery returned a different reservation");
			}
			if (recovered.state === "issue_authorized") {
				if (recovered.receipt !== null)
					throw new Error("Provider-call recovery returned an invalid issue-authorized receipt");
				await this.#storeOrphanedRecovery(active.lease, reservation);
				throw new Error("Provider-call reservation issue permit is unavailable after recovery; binding is frozen");
			}
			if (recovered.receipt === null) throw new Error("Provider-call recovery omitted the settled receipt");
			assertRecoveredReceipt(active, recovered.state, recovered.receipt);
			await this.#completeRecovered(active.lease);
		}
	}

	async #clearUnsent(lease: ProviderCallJournalLease): Promise<void> {
		await this.transact(state => {
			const binding = state.bindings[lease.executionBindingId];
			assertLease(binding?.active, lease);
			delete binding!.active;
		});
		this.#releaseLease(lease.receiptOperationId);
	}

	async #completeRecovered(lease: ProviderCallJournalLease): Promise<void> {
		await this.transact(state => {
			const binding = state.bindings[lease.executionBindingId];
			assertLease(binding?.active, lease);
			binding!.lastCompletedSequence = lease.callSequence;
			delete binding!.active;
		});
		this.#releaseLease(lease.receiptOperationId);
	}

	async #storeOrphanedRecovery(
		lease: ProviderCallJournalLease,
		reservation: ProviderCallReservationReference,
	): Promise<void> {
		await this.transact(state => {
			const active = assertLease(state.bindings[lease.executionBindingId]?.active, lease);
			active.reservation = reservation;
			delete active.pendingReceipt;
			delete active.pendingReceiptSha256;
			active.phase = "orphaned";
		});
	}

	async #markOrphaned(lease: ProviderCallJournalLease): Promise<void> {
		await this.transact(state => {
			const active = assertLease(state.bindings[lease.executionBindingId]?.active, lease);
			active.phase = "orphaned";
		});
	}

	#releaseLease(receiptOperationId: string): void {
		const release = this.#releases.get(receiptOperationId);
		this.#releases.delete(receiptOperationId);
		release?.();
	}

	async close(): Promise<void> {
		for (const release of this.#releases.values()) release();
		this.#releases.clear();
	}
}

export class InMemoryProviderCallJournal extends BaseProviderCallJournal {
	readonly #state = emptyState();

	protected async transact<T>(operation: (state: JournalState) => T | Promise<T>): Promise<T> {
		return await operation(this.#state);
	}
}

function currentUid(): number {
	if (!process.getuid) throw new Error("Provider-call journal requires POSIX UID ownership checks");
	return process.getuid();
}

function formatMode(mode: number): string {
	return `0${(mode & 0o777).toString(8)}`;
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function assertStrictDirectory(directory: string, label: string, create = false): Promise<string> {
	if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const lexical = path.resolve(directory);
	const info = await fs.lstat(lexical);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must not be a symlink or alias`);
	if (info.uid !== currentUid()) throw new Error(`${label} must be owned by the current UID`);
	if ((info.mode & 0o777) !== 0o700)
		throw new Error(`${label} mode must be exactly 0700, got ${formatMode(info.mode)}`);
	const real = await fs.realpath(lexical);
	if (real !== lexical) throw new Error(`${label} must not use a symlink or alias path`);
	return real;
}

export async function readStrictOwnedFile(filePath: string, options: StrictOwnedFileOptions): Promise<Uint8Array> {
	const lexical = path.resolve(filePath);
	const directory = await assertStrictDirectory(path.dirname(lexical), `${options.label} directory`);
	const canonical = path.join(directory, path.basename(lexical));
	const before = await fs.lstat(canonical);
	if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${options.label} must not be a symlink or alias`);
	if (before.uid !== currentUid()) throw new Error(`${options.label} must be owned by the current UID`);
	if ((before.mode & 0o777) !== options.mode) {
		throw new Error(
			`${options.label} mode must be exactly ${formatMode(options.mode)}, got ${formatMode(before.mode)}`,
		);
	}
	const real = await fs.realpath(canonical);
	if (real !== canonical) throw new Error(`${options.label} must not use a symlink or alias path`);
	if (before.nlink !== 1) throw new Error(`${options.label} must have exactly one hard link`);
	if (before.size > options.maxBytes)
		throw new Error(`${options.label} exceeds its bounded maximum; file is too large`);
	const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.uid !== before.uid ||
			opened.ino !== before.ino ||
			opened.dev !== before.dev ||
			(opened.mode & 0o777) !== options.mode ||
			opened.nlink !== 1 ||
			opened.size > options.maxBytes
		) {
			throw new Error(`${options.label} changed during strict validation`);
		}
		const bytes = await handle.readFile();
		if (bytes.byteLength > options.maxBytes)
			throw new Error(`${options.label} exceeds its bounded maximum; file is too large`);
		const after = await handle.stat();
		if (
			after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs ||
			after.ctimeMs !== opened.ctimeMs ||
			bytes.byteLength !== opened.size
		) {
			throw new Error(`${options.label} changed while it was being read`);
		}
		return new Uint8Array(bytes);
	} finally {
		await handle.close();
	}
}

async function processStartTicks(pid: string): Promise<string | null> {
	try {
		const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
		const close = text.lastIndexOf(")");
		if (close < 0) return null;
		const fields = text
			.slice(close + 2)
			.trim()
			.split(/\s+/);
		const ticks = fields[19];
		return CANONICAL_INTEGER.test(ticks ?? "") ? ticks : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function currentBootId(): Promise<string> {
	return (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

function hydrateOwner(value: unknown): OwnerRecord {
	const record = requireRecord(value, "Provider-call journal owner");
	assertExactKeys(
		record,
		["schema", "runtimeId", "pid", "uid", "bootId", "processStartTicks", "podUid"],
		[],
		"Provider-call journal owner",
	);
	if (record.schema !== OWNER_SCHEMA) throw new Error("Provider-call journal owner schema is invalid");
	if (record.podUid !== null && (typeof record.podUid !== "string" || !record.podUid)) {
		throw new Error("Provider-call journal owner Pod UID is invalid");
	}
	return {
		schema: OWNER_SCHEMA,
		runtimeId: requireString(record.runtimeId, "Provider-call journal owner runtimeId", CANONICAL_UUID),
		pid: requireString(record.pid, "Provider-call journal owner pid", CANONICAL_INTEGER),
		uid: requireString(record.uid, "Provider-call journal owner uid", CANONICAL_INTEGER),
		bootId: requireString(record.bootId, "Provider-call journal owner bootId", CANONICAL_UUID),
		processStartTicks: requireString(
			record.processStartTicks,
			"Provider-call journal owner processStartTicks",
			CANONICAL_INTEGER,
		),
		podUid: record.podUid as string | null,
	};
}

export class FileProviderCallJournal extends BaseProviderCallJournal {
	readonly #requestedPath: string;
	readonly #expectedPodUid?: string;
	readonly #maxBytes: number;
	readonly #runtimeId = randomUUID();
	#canonicalPath?: string;
	#ownerRecord?: OwnerRecord;
	#ready?: Promise<void>;
	#closed = false;

	constructor(filePath: string, options: FileProviderCallJournalOptions = {}) {
		super();
		this.#requestedPath = path.resolve(filePath);
		this.#expectedPodUid = options.expectedPodUid;
		this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		if (this.#expectedPodUid !== undefined && !this.#expectedPodUid) {
			throw new Error("Provider-call journal expected Pod UID must not be empty");
		}
		if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
			throw new Error("Provider-call journal maximum size is invalid");
		}
	}

	async #initialize(): Promise<void> {
		if (this.#closed) throw new Error("Provider-call journal is closed");
		if (this.#ready) return await this.#ready;
		this.#ready = (async () => {
			const directory = await assertStrictDirectory(
				path.dirname(this.#requestedPath),
				"Provider-call journal directory",
				true,
			);
			this.#canonicalPath = path.join(directory, path.basename(this.#requestedPath));
			await withFileLock(this.#canonicalPath, async () => {
				await this.#acquireOwner();
				await this.#read();
			});
		})();
		try {
			await this.#ready;
		} catch (error) {
			if (this.#ownerRecord && this.#canonicalPath) {
				await withFileLock(this.#canonicalPath, async () => this.#releaseOwner()).catch(() => undefined);
			}
			this.#ready = undefined;
			throw error;
		}
	}

	async #acquireOwner(): Promise<void> {
		const ownerDirectory = `${this.#canonicalPath!}.owner`;
		for (let attempt = 0; attempt < 2; attempt++) {
			let created = false;
			try {
				await fs.mkdir(ownerDirectory, { mode: 0o700 });
				created = true;
				const startTicks = await processStartTicks(String(process.pid));
				if (!startTicks) throw new Error("Provider-call journal cannot identify the current process");
				const owner: OwnerRecord = {
					schema: OWNER_SCHEMA,
					runtimeId: this.#runtimeId,
					pid: String(process.pid),
					uid: String(currentUid()),
					bootId: await currentBootId(),
					processStartTicks: startTicks,
					podUid: this.#expectedPodUid ?? null,
				};
				const ownerPath = path.join(ownerDirectory, "owner.json");
				const temporaryOwnerPath = path.join(ownerDirectory, `owner.${this.#runtimeId}.tmp`);
				const handle = await fs.open(temporaryOwnerPath, "wx", 0o600);
				try {
					await handle.writeFile(JSON.stringify(owner));
					await handle.sync();
				} finally {
					await handle.close();
				}
				await fs.rename(temporaryOwnerPath, ownerPath);
				await syncDirectory(ownerDirectory);
				await syncDirectory(path.dirname(ownerDirectory));
				this.#ownerRecord = owner;
				return;
			} catch (error) {
				if (created) {
					await fs.rm(ownerDirectory, { recursive: true, force: true });
					throw error;
				}
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				let existing: OwnerRecord;
				try {
					existing = await this.#readOwner(ownerDirectory);
				} catch (ownerError) {
					if ((ownerError as NodeJS.ErrnoException).code !== "ENOENT") throw ownerError;
					await fs.rm(ownerDirectory, { recursive: true, force: true });
					continue;
				}
				if (existing.uid !== String(currentUid()))
					throw new Error("Provider-call journal owner has a different UID");
				if (
					existing.bootId === (await currentBootId()) &&
					(await processStartTicks(existing.pid)) === existing.processStartTicks
				) {
					throw new Error("Provider-call journal is already owned by a live owner");
				}
				await fs.rm(ownerDirectory, { recursive: true });
			}
		}
		throw new Error("Provider-call journal owner could not be acquired");
	}

	async #readOwner(ownerDirectory: string): Promise<OwnerRecord> {
		const directoryInfo = await fs.lstat(ownerDirectory);
		if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
			throw new Error("Provider-call journal owner must not be a symlink or alias");
		}
		if (directoryInfo.uid !== currentUid() || (directoryInfo.mode & 0o777) !== 0o700) {
			throw new Error("Provider-call journal owner has unsafe ownership or mode");
		}
		const bytes = await readStrictOwnedFile(path.join(ownerDirectory, "owner.json"), {
			mode: 0o600,
			maxBytes: 4096,
			label: "Provider-call journal owner record",
		});
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		assertNoDuplicateJsonKeys(text);
		return hydrateOwner(JSON.parse(text) as unknown);
	}

	async #read(): Promise<JournalState> {
		try {
			const bytes = await readStrictOwnedFile(this.#canonicalPath!, {
				mode: 0o600,
				maxBytes: this.#maxBytes,
				label: "Provider-call journal",
			});
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			assertNoDuplicateJsonKeys(text);
			return hydrateState(JSON.parse(text) as unknown, this.#expectedPodUid);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
			throw error;
		}
	}

	async #write(state: JournalState): Promise<void> {
		const hydrated = hydrateState(structuredClone(state), this.#expectedPodUid);
		const serialized = JSON.stringify(hydrated);
		if (Buffer.byteLength(serialized) > this.#maxBytes)
			throw new Error("Provider-call journal exceeds its bounded maximum");
		const directory = path.dirname(this.#canonicalPath!);
		const temporary = `${this.#canonicalPath!}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const handle = await fs.open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(serialized);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temporary, this.#canonicalPath!);
			await fs.chmod(this.#canonicalPath!, 0o600);
			await syncDirectory(directory);
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}
	async #releaseOwner(): Promise<void> {
		const ownerDirectory = `${this.#canonicalPath!}.owner`;
		const owner = await this.#readOwner(ownerDirectory);
		if (owner.runtimeId !== this.#runtimeId) throw new Error("Provider-call journal ownership changed before close");
		await fs.rm(ownerDirectory, { recursive: true });
		await syncDirectory(path.dirname(ownerDirectory));
		this.#ownerRecord = undefined;
	}

	protected async transact<T>(operation: (state: JournalState) => T | Promise<T>): Promise<T> {
		await this.#initialize();
		return await withFileLock(this.#canonicalPath!, async () => {
			const state = await this.#read();
			const result = await operation(state);
			await this.#write(state);
			return result;
		});
	}

	override async close(): Promise<void> {
		await super.close();
		this.#closed = true;
		if (!this.#ready || !this.#ownerRecord || !this.#canonicalPath) return;
		await this.#ready;
		await withFileLock(this.#canonicalPath, async () => this.#releaseOwner());
	}
}
