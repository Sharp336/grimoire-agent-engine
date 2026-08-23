import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalProviderCallBytes,
	decodeProviderCallWorkerResponse,
	encodeProviderCallWorkerRequest,
	ProviderCallGatewayError,
	UnixProviderCallGateway,
} from "@oh-my-pi/pi-ai/provider-call-gateway";
import type { ProviderCallWorkerContext } from "@oh-my-pi/pi-ai/types";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const ROUTE_ASSIGNMENT_ID = "22222222-2222-4222-8222-222222222222";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const roots: string[] = [];

function digest(bytes: Uint8Array): Uint8Array {
	return createHash("sha256").update(bytes).digest();
}

function digestText(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function u64(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
	return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function context(): ProviderCallWorkerContext {
	return {
		mode: "strict",
		configId: "deepseek-v4-pro-0813-max-r3",
		taskReservationId: "33333333-3333-4333-8333-333333333333",
		providerRouteAssignmentId: ROUTE_ASSIGNMENT_ID,
		executionBindingId: "44444444-4444-4444-8444-444444444444",
		podUid: "pod-uid",
		callSequence: "7",
		idempotencyKey: "55555555-5555-4555-8555-555555555555",
		apiFamily: "openai-completions",
		provider: "openai",
		accountId: "account",
		modelId: "gpt-5",
		credentialGeneration: "generation",
		capabilityId: "66666666-6666-4666-8666-666666666666",
		snapshotId: "77777777-7777-4777-8777-777777777777",
		assignmentSha256: `sha256:${"1".repeat(64)}`,
		tokenizerContractSha256: `sha256:${"2".repeat(64)}`,
		inputTokens: "1",
		maxOutputTokens: "2",
		expectedDimensions: [],
		originAssignment: {} as ProviderCallWorkerContext["originAssignment"],
	};
}

function callerEntity(body: Uint8Array) {
	return {
		schema: "terminal-bench/provider-http-entity-response/v3",
		http_status: 200,
		http_version: "HTTP/1.1",
		headers: [
			{
				schema: "terminal-bench/provider-terminal-header/v3",
				name: "content-type",
				value_base64: Buffer.from("application/octet-stream").toString("base64"),
			},
		],
		trailers: [],
		body_sha256: digestText(body),
		body_bytes: body.byteLength,
		body_base64: Buffer.from(body).toString("base64"),
	};
}

function selectedResultFrame(
	workerOperationId: string,
	resultKind: "CALLER_RESPONSE" | "SUMMARY" | "ERROR",
	resultSchema: string,
	resultValue: Record<string, unknown>,
	trailing = new Uint8Array(),
): Uint8Array {
	const result = canonicalProviderCallBytes(resultValue);
	const header = canonicalProviderCallBytes({
		schema: "terminal-bench/provider-call-worker-response/v7",
		worker_operation_id: workerOperationId,
		result_kind: resultKind,
		result_schema: resultSchema,
		result_sha256: digestText(concat(encoder.encode(`${resultSchema}\0`), result)),
		result_bytes: result.byteLength,
	});
	return concat(
		encoder.encode("TBPCR003"),
		u64(header.byteLength),
		u64(result.byteLength),
		digest(header),
		digest(result),
		header,
		result,
		trailing,
	);
}

function responseFrame(workerOperationId: string, body: Uint8Array, trailing = new Uint8Array()): Uint8Array {
	return selectedResultFrame(
		workerOperationId,
		"CALLER_RESPONSE",
		"terminal-bench/provider-http-entity-response/v3",
		callerEntity(body),
		trailing,
	);
}

async function socketPath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "provider-call-gateway-"));
	roots.push(root);
	return join(root, "gateway.sock");
}

interface MockSocketState {
	chunks: Buffer[];
	responded: boolean;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("frozen Fv13 worker gateway ABI", () => {
	it("encodes the exact TBPCW002 generic request frame", () => {
		const payload = encoder.encode('{"z":1,"a":2}');
		const frame = encodeProviderCallWorkerRequest({
			context: context(),
			workerOperationId: OPERATION_ID,
			requestMaterializationKind: "GENERIC_LIFECYCLE_FINAL",
			sourceBody: payload,
		});
		const headerLength = Number(new DataView(frame.buffer, frame.byteOffset + 8, 8).getBigUint64(0));
		const payloadLength = Number(new DataView(frame.buffer, frame.byteOffset + 16, 8).getBigUint64(0));
		const header = frame.subarray(88, 88 + headerLength);
		expect(decoder.decode(frame.subarray(0, 8))).toBe("TBPCW002");
		expect(payloadLength).toBe(payload.byteLength);
		expect(decoder.decode(header)).toBe(
			'{"api_family":"openai-completions","call_sequence":7,"execution_binding_id":"44444444-4444-4444-8444-444444444444","idempotency_key":"55555555-5555-4555-8555-555555555555","pod_uid":"pod-uid","provider_route_assignment_id":"22222222-2222-4222-8222-222222222222","request_materialization_kind":"GENERIC_LIFECYCLE_FINAL","schema":"terminal-bench/provider-call-worker-request/v2","source_request_body_bytes":13,"source_request_sha256":"sha256:c5c2b1fdd0d4a83cda3ff79c9c74f2c72e2a92920afda20bcafc90c1a72f86a9","task_reservation_id":"33333333-3333-4333-8333-333333333333","worker_operation_id":"11111111-1111-4111-8111-111111111111"}',
		);
		expect(frame.subarray(24, 56)).toEqual(digest(header));
		expect(frame.subarray(56, 88)).toEqual(digest(payload));
		expect(frame.subarray(88 + headerLength)).toEqual(payload);
	});

	it("round-trips exact caller bytes over one AF_UNIX connection", async () => {
		const path = await socketPath();
		const callerBody = new Uint8Array([0, 1, 2, 127, 128, 255]);
		let connections = 0;
		const server = Bun.listen<MockSocketState>({
			unix: path,
			allowHalfOpen: true,
			data: { chunks: [], responded: false },
			socket: {
				open(socket) {
					socket.data = { chunks: [], responded: false };
					connections++;
				},
				data(socket, chunk) {
					socket.data.chunks.push(Buffer.from(chunk));
					const request = Buffer.concat(socket.data.chunks);
					if (socket.data.responded || request.byteLength < 24) return;
					const headerLength = Number(new DataView(request.buffer, request.byteOffset + 8, 8).getBigUint64(0));
					const payloadLength = Number(new DataView(request.buffer, request.byteOffset + 16, 8).getBigUint64(0));
					if (request.byteLength !== 88 + headerLength + payloadLength) return;
					socket.data.responded = true;
					const header = JSON.parse(decoder.decode(request.subarray(88, 88 + headerLength))) as Record<
						string,
						unknown
					>;
					socket.end(responseFrame(String(header.worker_operation_id), callerBody));
				},
			},
		});
		try {
			const gateway = new UnixProviderCallGateway({ socketPath: path });
			const response = await gateway.dispatch({
				context: context(),
				requestMaterializationKind: "GENERIC_LIFECYCLE_FINAL",
				sourceBody: encoder.encode("request"),
			});
			expect(response.status).toBe(200);
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(callerBody);
			expect(response.headers.get("content-type")).toBe("application/octet-stream");
			expect(connections).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	it("rejects trailing response bytes instead of accepting an ambiguous frame", () => {
		const frame = responseFrame(OPERATION_ID, encoder.encode("ok"), new Uint8Array([1]));
		expect(() => decodeProviderCallWorkerResponse(frame, OPERATION_ID)).toThrow(/trailing|length/i);
	});

	it("rejects noncanonical body base64 before returning caller bytes", () => {
		const entity = callerEntity(new Uint8Array([0]));
		entity.body_base64 = "AB==";
		const frame = selectedResultFrame(
			OPERATION_ID,
			"CALLER_RESPONSE",
			"terminal-bench/provider-http-entity-response/v3",
			entity,
		);
		expect(() => decodeProviderCallWorkerResponse(frame, OPERATION_ID)).toThrow(/canonical base64|base64\/count/i);
	});

	it("enforces frozen request and result caps before body allocation", () => {
		expect(() =>
			encodeProviderCallWorkerRequest({
				context: context(),
				workerOperationId: OPERATION_ID,
				requestMaterializationKind: "GENERIC_LIFECYCLE_FINAL",
				sourceBody: new Uint8Array(16_777_217),
			}),
		).toThrow(/16777216/);
		const oversized = new Uint8Array(88);
		oversized.set(encoder.encode("TBPCR003"));
		new DataView(oversized.buffer).setBigUint64(16, 50_331_649n);
		expect(() => decodeProviderCallWorkerResponse(oversized, OPERATION_ID)).toThrow(/frozen cap/i);
	});

	it("derives the materialization domain from controller-owned route context", () => {
		const dedicatedContext: ProviderCallWorkerContext = {
			...context(),
			codexAuthority: {
				providerRouteAssignmentId: ROUTE_ASSIGNMENT_ID,
				capabilitySetId: "88888888-8888-4888-8888-888888888888",
				translationContractSha256: `sha256:${"3".repeat(64)}`,
				solverEpoch: "1",
				assignedAt: "2026-08-23T00:00:00.000000Z",
				logicalContentType: "application/json",
				logicalHeaders: { accept: "text/event-stream", "content-type": "application/json" },
				logicalBodyBase64: "e30=",
			},
		};
		expect(() =>
			encodeProviderCallWorkerRequest({
				context: dedicatedContext,
				workerOperationId: OPERATION_ID,
				requestMaterializationKind: "GENERIC_LIFECYCLE_FINAL",
				sourceBody: encoder.encode("{}"),
			}),
		).toThrow(/materialization kind/i);
	});

	it("surfaces only a catalog-exact Fv13 error object", () => {
		const frame = selectedResultFrame(OPERATION_ID, "ERROR", "terminal-bench/provider-call-error/v2", {
			schema: "terminal-bench/provider-call-error/v2",
			code: "terminal_result_not_committed",
			message: "no committed terminal caller response is available",
			reservation_id: null,
		});
		try {
			decodeProviderCallWorkerResponse(frame, OPERATION_ID);
			throw new Error("expected gateway error");
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderCallGatewayError);
			expect((error as ProviderCallGatewayError).code).toBe("terminal_result_not_committed");
			expect((error as ProviderCallGatewayError).reservationId).toBeNull();
		}
	});

	it("keeps concurrent calls isolated by worker operation id", async () => {
		const path = await socketPath();
		const operationIds = new Set<string>();
		const server = Bun.listen<MockSocketState>({
			unix: path,
			allowHalfOpen: true,
			data: { chunks: [], responded: false },
			socket: {
				open(socket) {
					socket.data = { chunks: [], responded: false };
				},
				data(socket, chunk) {
					socket.data.chunks.push(Buffer.from(chunk));
					const request = Buffer.concat(socket.data.chunks);
					if (socket.data.responded || request.byteLength < 24) return;
					const headerLength = Number(new DataView(request.buffer, request.byteOffset + 8, 8).getBigUint64(0));
					const payloadLength = Number(new DataView(request.buffer, request.byteOffset + 16, 8).getBigUint64(0));
					if (request.byteLength !== 88 + headerLength + payloadLength) return;
					socket.data.responded = true;
					const header = JSON.parse(decoder.decode(request.subarray(88, 88 + headerLength))) as Record<
						string,
						unknown
					>;
					const operationId = String(header.worker_operation_id);
					operationIds.add(operationId);
					socket.end(responseFrame(operationId, encoder.encode(operationId)));
				},
			},
		});
		try {
			const gateway = new UnixProviderCallGateway({ socketPath: path });
			const responses = await Promise.all(
				Array.from({ length: 8 }, () =>
					gateway.dispatch({
						context: context(),
						requestMaterializationKind: "GENERIC_LIFECYCLE_FINAL",
						sourceBody: encoder.encode("same-body"),
					}),
				),
			);
			const bodies = await Promise.all(responses.map(response => response.text()));
			expect(operationIds.size).toBe(8);
			expect(new Set(bodies)).toEqual(operationIds);
		} finally {
			server.stop(true);
		}
	});
});
