import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	encodeProviderCallReceiptHashInput,
	encodeProviderCallRequestHashInput,
	HttpProviderCallAuthority,
} from "@oh-my-pi/pi-ai/provider-call-authority";
import {
	type ProviderCallOriginAssignment,
	resolveProviderCallOriginBinding,
} from "@oh-my-pi/pi-ai/provider-call-origin-manifest";
import type {
	FetchImpl,
	ProviderCallApiFamily,
	ProviderCallContext,
	ProviderCallDimension,
	ProviderCallReservation,
	ProviderCallReserveRequest,
	ProviderCallUsage,
} from "@oh-my-pi/pi-ai/types";
import WIRE_GOLDENS from "./fixtures/provider-call-authority-wire-golden-v2.json" with { type: "json" };
import GOLDENS from "./fixtures/provider-call-authority-wire-v2-golden-vectors.json" with { type: "json" };

type GoldenVector = (typeof GOLDENS.vectors)[number];
type GoldenInput = Record<string, unknown>;
type WireGoldenVector = (typeof WIRE_GOLDENS.vectors)[number];

const CAPACITY_ASSIGNMENT_SHA256 = `sha256:${"f".repeat(64)}`;

function vector(name: GoldenVector["name"]): GoldenVector {
	const result = GOLDENS.vectors.find(candidate => candidate.name === name);
	if (!result) throw new Error(`Missing provider-call golden vector: ${name}`);
	return result;
}

function input(name: GoldenVector["name"]): GoldenInput {
	return vector(name).input as GoldenInput;
}

function wireVector(name: WireGoldenVector["name"]): WireGoldenVector {
	const result = WIRE_GOLDENS.vectors.find(candidate => candidate.name === name);
	if (!result) throw new Error(`Missing provider-call wire golden vector: ${name}`);
	return result;
}

function dimensions(value: unknown): ProviderCallDimension[] {
	return (value as Array<Record<string, string | null>>).map(dimension => ({
		dimension: dimension.dimension as ProviderCallDimension["dimension"],
		windowId: dimension.window_id ?? "",
		amount: dimension.amount ?? "",
		unitScale: dimension.unit_scale ?? "",
		windowStart: dimension.window_start,
		windowEnd: dimension.window_end,
	}));
}

function fetchImpl(fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): FetchImpl {
	return Object.assign(fn, { preconnect: fetch.preconnect });
}

function goldenOriginAssignment(credentialGeneration: string): ProviderCallOriginAssignment {
	const binding = resolveProviderCallOriginBinding("sol-low", 0);
	return {
		...binding.frozenStaticAssignment,
		capability_generation: "capability-generation-20260823",
		credential_generation: credentialGeneration,
		source_release_digest: `sha256:${"a".repeat(64)}`,
		restricted_proxy_policy_sha256: `sha256:${"b".repeat(64)}`,
		origin_descriptor: structuredClone(binding.originDescriptor.preimage),
		route_binding_descriptor: structuredClone(binding.bindingDescriptor.preimage),
	};
}

function goldenContext(): ProviderCallContext {
	const reservationInput = input("reservation");
	return {
		mode: "strict",
		configId: "sol-low",
		taskReservationId: String(reservationInput.task_reservation_id),
		providerRouteAssignmentId: "11111111-1111-4111-8111-111111111112",
		executionBindingId: String(reservationInput.execution_binding_id),
		podUid: String(reservationInput.pod_uid),
		callSequence: String(reservationInput.call_sequence),
		idempotencyKey: String(reservationInput.idempotency_key),
		apiFamily: reservationInput.api_family as ProviderCallApiFamily,
		provider: String(reservationInput.provider),
		accountId: String(reservationInput.account_id),
		modelId: String(reservationInput.model_id),
		credentialGeneration: String(reservationInput.credential_generation),
		capabilityId: String(reservationInput.capability_id),
		snapshotId: String(reservationInput.snapshot_id),
		assignmentSha256: CAPACITY_ASSIGNMENT_SHA256,
		tokenizerContractSha256: String(reservationInput.tokenizer_contract_sha256),
		inputTokens: String(reservationInput.input_tokens),
		maxOutputTokens: String(reservationInput.max_output_tokens),
		expectedDimensions: dimensions(reservationInput.expected_dimensions),
		originAssignment: goldenOriginAssignment(String(reservationInput.credential_generation)),
	};
}

function receiptEvidence(_context: ProviderCallContext, terminal: boolean) {
	return {
		authorityOwner: "dedicated-codex-backend" as const,
		backendEqualityResult: "MATCH" as const,
		providerRequestCount: 1 as const,
		retryCount: 0 as const,
		failoverCount: 0 as const,
		redirectFollowCount: 0 as const,
		finalClassification: terminal ? ("TERMINAL_RESPONSE" as const) : ("AMBIGUOUS_ATTEMPT" as const),
		drainState: terminal ? ("DRAINED" as const) : ("FROZEN" as const),
	};
}

function goldenReserveRequest(context: ProviderCallContext): ProviderCallReserveRequest {
	const requestInput = input("request");
	const body = new TextEncoder().encode(String(requestInput.body_utf8));
	return {
		context,
		provider: context.provider,
		model: context.modelId,
		apiFamily: context.apiFamily,
		httpMethod: String(requestInput.http_method),
		credentialFreeUrl: String(requestInput.credential_free_url),
		contentType: String(requestInput.content_type),
		headers: (requestInput.headers as Array<{ lowercase_name: string; trimmed_value: string }>).map(header => [
			header.lowercase_name,
			header.trimmed_value,
		]),
		payload: JSON.parse(String(requestInput.body_utf8)),
		body,
		canonicalRequest: Buffer.from(vector("request").preimage_base64, "base64"),
		requestSha256: String(input("reservation").request_sha256),
		requestBodyBytes: String(input("reservation").request_body_bytes),
	};
}

describe("provider-call Go/TypeScript golden vectors", () => {
	it("validates candidate controller v2 vectors without claiming an independently frozen shared pin", async () => {
		const fixtureBytes = await Bun.file(
			`${import.meta.dir}/fixtures/provider-call-authority-wire-v2-golden-vectors.json`,
		).bytes();
		expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
			"932a30882143d389a98a78b1ddc3b1eaf60a9dbc5fd423463b9152bedce5a04d",
		);
		const wireFixtureBytes = await Bun.file(
			`${import.meta.dir}/fixtures/provider-call-authority-wire-golden-v2.json`,
		).bytes();
		expect(createHash("sha256").update(wireFixtureBytes).digest("hex")).toBe(
			"0f6259f182337a38428de173875ccb6b03c5bde579b888d7fd88052688fb603b",
		);
		expect(GOLDENS.candidate_controller_v2).toEqual({
			artifact: "internal/api/testdata/provider_call_authority_hash_golden_v2.json",
			sha256: "28c8f810358c8e54807e4d43b83efddfd71b6fd2acb02c451b1a30126275326b",
			status: "candidate-not-independently-frozen",
		});
		expect(WIRE_GOLDENS.candidate_controller_v2).toEqual({
			artifact: "internal/api/testdata/provider_call_authority_wire_golden_v2.json",
			sha256: "83a42e82579bcb7cf5e4c2e7662fcf66d6f5b6894594f6d57cf48c2a8452587a",
			status: "candidate-not-independently-frozen",
		});
		expect(GOLDENS.superseded_historical_lineage.status).toBe("superseded-v1-lineage-only");
		expect(WIRE_GOLDENS.superseded_historical_lineage).toEqual(GOLDENS.superseded_historical_lineage);
		expect(GOLDENS).not.toHaveProperty("parents");
		expect(WIRE_GOLDENS).not.toHaveProperty("parents");
		expect(WIRE_GOLDENS.schema).toBe("terminal-bench/provider-call-authority-wire-golden-v2");
		expect(GOLDENS.schema).toBe("terminal-bench/provider-call-hash-golden-v2");
		expect(input("reservation")).toMatchObject({
			origin_assignment: goldenContext().originAssignment,
		});
		expect(input("reservation")).not.toHaveProperty("assignment_sha256");
		const reservationSha256 = `sha256:${vector("reservation").sha256}`;
		for (const golden of WIRE_GOLDENS.vectors.slice(0, 3)) {
			expect(JSON.parse(golden.response_json)).toMatchObject({ reservation_sha256: reservationSha256 });
		}
		expect(WIRE_GOLDENS.vectors.map(golden => golden.request_json).join("\n")).not.toMatch(
			/provider-call-(?:terminal|ambiguous)-receipt\/v1/,
		);
		expect(WIRE_GOLDENS.vectors.map(golden => golden.name)).toEqual([
			"reserve_created",
			"reserve_exact_replay",
			"recover_issue_authorized_no_permit",
			"terminal_receipt_created",
			"ambiguous_receipt_created",
		]);
		for (const golden of GOLDENS.vectors) {
			const preimage = Buffer.from(golden.preimage_base64, "base64");
			expect(preimage.byteLength, golden.name).toBe(golden.preimage_byte_length);
			expect(createHash("sha256").update(preimage).digest("hex"), golden.name).toBe(golden.sha256);
			if (golden.name.startsWith("terminal_receipt") || golden.name === "ambiguous_receipt") {
				expect(
					Buffer.from(
						encodeProviderCallReceiptHashInput(
							golden.input as unknown as Record<string, unknown>,
							golden.name.startsWith("terminal_receipt"),
						),
					),
					golden.name,
				).toEqual(preimage);
			}
		}
	});

	it("hash-binds canonical non-null provider usage without replay collisions", () => {
		const golden = vector("terminal_receipt_with_usage");
		const payload = golden.input as unknown as Record<string, unknown>;
		const encode = (candidate: Record<string, unknown>) =>
			Buffer.from(encodeProviderCallReceiptHashInput(candidate, true));
		const digest = (candidate: Record<string, unknown>) =>
			createHash("sha256").update(encode(candidate)).digest("hex");
		const preimage = encode(payload);
		const canonicalUsage = Buffer.from('{"coefficient":"999","scale":"0","unit":"tokens"}');
		const usageFrame = Buffer.alloc(4 + canonicalUsage.byteLength);
		usageFrame.writeUInt32BE(canonicalUsage.byteLength);
		canonicalUsage.copy(usageFrame, 4);

		expect(preimage.byteLength).toBe(3500);
		expect(preimage).toEqual(Buffer.from(golden.preimage_base64, "base64"));
		expect(preimage.subarray(-usageFrame.byteLength)).toEqual(usageFrame);
		expect(createHash("sha256").update(preimage).digest("hex")).toBe(
			"004c414edbd8b962db7155c5f0d6d49797eb5d7280691cb3a3e6cceb04cca6be",
		);
		expect(preimage.includes(Buffer.from("[object Object]"))).toBe(false);

		const mutations = [
			{ unit: "requests", coefficient: "999", scale: "0" },
			{ unit: "tokens", coefficient: "998", scale: "0" },
			{ unit: "tokens", coefficient: "999", scale: "1" },
			null,
		];
		const mutationDigests = mutations.map(provider_usage => digest({ ...payload, provider_usage }));
		expect(new Set([digest(payload), ...mutationDigests]).size).toBe(1 + mutationDigests.length);
	});

	it("encodes the runtime request byte-identically to the controller golden", () => {
		const golden = vector("request");
		const request = golden.input as {
			api_family: ProviderCallApiFamily;
			http_method: string;
			credential_free_url: string;
			content_type: string;
			headers: Array<{ lowercase_name: string; trimmed_value: string }>;
			body_utf8: string;
		};
		const actual = encodeProviderCallRequestHashInput({
			apiFamily: request.api_family,
			httpMethod: request.http_method,
			credentialFreeUrl: request.credential_free_url,
			contentType: request.content_type,
			headers: request.headers.map(header => [header.lowercase_name, header.trimmed_value]),
			body: new TextEncoder().encode(request.body_utf8),
		});
		expect(Buffer.from(actual)).toEqual(Buffer.from(golden.preimage_base64, "base64"));
	});

	it("preserves every candidate reservation response field while binding exact origin assignment evidence", async () => {
		const terminalInput = input("terminal_receipt_with_usage");
		const ambiguousInput = input("ambiguous_receipt");
		const createdWire = wireVector("reserve_created");
		const terminalWire = wireVector("terminal_receipt_created");
		const ambiguousWire = wireVector("ambiguous_receipt_created");
		const calls: Array<{ url: string; method: string; body: string }> = [];
		const authority = new HttpProviderCallAuthority({
			baseUrl: "https://authority.invalid",
			getGatewayToken: () => "gateway-token",
			getExecutionToken: () => "execution-token",
			fetch: fetchImpl(async (url, init) => {
				const path = new URL(String(url)).pathname;
				calls.push({ url: String(url), method: String(init?.method), body: String(init?.body) });
				const golden =
					path === createdWire.path ? createdWire : path === terminalWire.path ? terminalWire : ambiguousWire;
				return new Response(golden.response_json, {
					status: golden.status,
					headers: { "content-type": "application/json" },
				});
			}),
		});
		const context = goldenContext();
		const reservation = await authority.reserve(goldenReserveRequest(context));
		await authority.recordReceipt(
			{
				context,
				reservation,
				receiptOperationId: String(terminalInput.receipt_operation_id),
				classification: "terminal",
				...receiptEvidence(context, true),
				providerStartedAt: String(terminalInput.provider_started_at),
				providerFinishedAt: String(terminalInput.provider_finished_at),
				httpStatus: String(terminalInput.http_status),
				providerRequestId: String(terminalInput.provider_request_id),
				responseSha256: String(terminalInput.response_sha256),
				failureClass: "none",
				providerErrorCode: "",
				actualDimensions: dimensions(terminalInput.actual_dimensions),
				providerUsage: terminalInput.provider_usage as unknown as ProviderCallUsage,
			},
			reservation.issuePermit,
		);
		await authority.recordReceipt(
			{
				context,
				reservation,
				receiptOperationId: String(ambiguousInput.receipt_operation_id),
				classification: "ambiguous",
				...receiptEvidence(context, false),
				providerStartedAt: String(ambiguousInput.provider_started_at),
				providerFinishedAt: String(ambiguousInput.last_observed_at),
				httpStatus: String(ambiguousInput.http_status),
				providerRequestId: String(ambiguousInput.provider_request_id),
				responseSha256: String(ambiguousInput.response_bytes_sha256),
				ambiguityClass: "premature_eof",
				requestMayHaveReachedProvider: true,
				requestBytesWritten: String(ambiguousInput.request_bytes_written),
				responseBytesReceived: String(ambiguousInput.response_bytes_received),
			},
			reservation.issuePermit,
		);

		expect(
			calls.map(call => ({
				method: call.method,
				path: new URL(call.url).pathname,
				body: call.body,
			})),
		).toEqual(
			[createdWire, terminalWire, ambiguousWire].map(golden => ({
				method: golden.method,
				path: golden.path,
				body: golden.request_json,
			})),
		);
	});

	it("fails closed on exact replay and recovered no-permit controller wire goldens", async () => {
		const replayWire = wireVector("reserve_exact_replay");
		const replayCalls: Array<{ path: string; body: string }> = [];
		const replayAuthority = new HttpProviderCallAuthority({
			baseUrl: "https://authority.invalid",
			getGatewayToken: () => "gateway-token",
			getExecutionToken: () => "execution-token",
			fetch: fetchImpl(async (url, init) => {
				replayCalls.push({ path: new URL(String(url)).pathname, body: String(init?.body) });
				return new Response(replayWire.response_json, {
					status: replayWire.status,
					headers: { "content-type": "application/json" },
				});
			}),
		});
		await expect(replayAuthority.reserve(goldenReserveRequest(goldenContext()))).rejects.toThrow(
			/without issue authority/i,
		);
		expect(replayCalls).toEqual([{ path: replayWire.path, body: replayWire.request_json }]);

		const reserveWire = wireVector("reserve_created");
		const recoverWire = wireVector("recover_issue_authorized_no_permit");
		const recoverCalls: Array<{ path: string; body: string }> = [];
		const recoverAuthority = new HttpProviderCallAuthority({
			baseUrl: "https://authority.invalid",
			getGatewayToken: () => "gateway-token",
			getExecutionToken: () => "execution-token",
			fetch: fetchImpl(async (url, init) => {
				const path = new URL(String(url)).pathname;
				recoverCalls.push({ path, body: String(init?.body) });
				if (path === reserveWire.path) throw new TypeError("lost reserve response");
				return new Response(recoverWire.response_json, {
					status: recoverWire.status,
					headers: { "content-type": "application/json" },
				});
			}),
		});
		await expect(recoverAuthority.reserve(goldenReserveRequest(goldenContext()))).rejects.toThrow(
			/recovered without issue authority/i,
		);
		expect(recoverCalls).toEqual([
			{ path: reserveWire.path, body: reserveWire.request_json },
			{ path: recoverWire.path, body: recoverWire.request_json },
		]);
	});
	it("decodes only the exact nested recovered receipt schema and key types", async () => {
		const recoverWire = wireVector("recover_issue_authorized_no_permit");
		const settled = JSON.parse(recoverWire.response_json) as Record<string, unknown>;
		settled.assignment_sha256 = CAPACITY_ASSIGNMENT_SHA256;
		settled.origin_assignment = goldenContext().originAssignment;
		settled.state = "terminal";
		settled.receipt = {
			classification: "terminal_response",
			receipt_operation_id: "99999999-9999-4999-8999-999999999999",
			receipt_sha256: `sha256:${"a".repeat(64)}`,
			recorded_at: "2025-01-01T00:00:02.123456Z",
		};
		const authority = new HttpProviderCallAuthority({
			baseUrl: "https://authority.invalid",
			getGatewayToken: () => "gateway-token",
			getExecutionToken: () => "execution-token",
			fetch: fetchImpl(async () =>
				Response.json(settled, {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		});
		await expect(authority.recover(goldenReserveRequest(goldenContext()))).resolves.toMatchObject({
			kind: "found",
			state: "terminal",
			receipt: {
				classification: "terminal_response",
				receiptOperationId: "99999999-9999-4999-8999-999999999999",
				receiptSha256: `sha256:${"a".repeat(64)}`,
				recordedAt: "2025-01-01T00:00:02.123456Z",
			},
		});

		for (const invalidReceipt of [
			{ ...(settled.receipt as object), unknown: true },
			{ ...(settled.receipt as object), receipt_operation_id: 1 },
			{ ...(settled.receipt as object), classification: "terminal" },
		]) {
			const invalid = { ...settled, receipt: invalidReceipt };
			const invalidAuthority = new HttpProviderCallAuthority({
				baseUrl: "https://authority.invalid",
				getGatewayToken: () => "gateway-token",
				getExecutionToken: () => "execution-token",
				fetch: fetchImpl(async () => Response.json(invalid, { status: 200 })),
			});
			await expect(invalidAuthority.recover(goldenReserveRequest(goldenContext()))).rejects.toThrow(
				/invalid frozen response/i,
			);
		}
	});

	it("recovers after duplicate, unknown, or malformed created-201 bodies", async () => {
		const created = wireVector("reserve_created");
		const recovered = wireVector("recover_issue_authorized_no_permit");
		const invalidBodies = [
			created.response_json.replace(
				'{"schema":',
				'{"schema":"terminal-bench/provider-call-reservation/v1","schema":',
			),
			created.response_json.replace("{", '{"unknown":true,'),
			created.response_json.slice(0, -1),
		];
		for (const invalidBody of invalidBodies) {
			const paths: string[] = [];
			const authority = new HttpProviderCallAuthority({
				baseUrl: "https://authority.invalid",
				getGatewayToken: () => "gateway-token",
				getExecutionToken: () => "execution-token",
				fetch: fetchImpl(async url => {
					const path = new URL(String(url)).pathname;
					paths.push(path);
					return path === created.path
						? new Response(invalidBody, { status: 201, headers: { "content-type": "application/json" } })
						: new Response(recovered.response_json, {
								status: recovered.status,
								headers: { "content-type": "application/json" },
							});
				}),
			});
			await expect(authority.reserve(goldenReserveRequest(goldenContext()))).rejects.toThrow(
				/recovered without issue authority/i,
			);
			expect(paths).toEqual([created.path, recovered.path]);
		}
	});

	it("validates durable receipt acknowledgements and retries the identical operation after unknown acknowledgements", async () => {
		const terminalInput = input("terminal_receipt_with_usage");
		const context = goldenContext();
		const reservation: ProviderCallReservation = {
			reservationId: String(terminalInput.reservation_id),
			disposition: "created",
			callSequence: context.callSequence,
			idempotencyKey: context.idempotencyKey,
			requestSha256: String(terminalInput.request_sha256),
			issuePermit: `pcr1_${"A".repeat(43)}`,
			issueAuthorizedAt: "2025-01-01T00:00:01.123456Z",
			assignmentSha256: context.assignmentSha256,
			originAssignment: context.originAssignment,
		};
		const bodies: string[] = [];
		const authority = new HttpProviderCallAuthority({
			baseUrl: "https://authority.invalid",
			getGatewayToken: () => "gateway-token",
			getExecutionToken: () => "execution-token",
			fetch: fetchImpl(async (_url, init) => {
				bodies.push(String(init?.body));
				return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
			}),
		});
		await expect(
			authority.recordReceipt(
				{
					context,
					reservation,
					receiptOperationId: String(terminalInput.receipt_operation_id),
					classification: "terminal",
					...receiptEvidence(context, true),
					providerStartedAt: String(terminalInput.provider_started_at),
					providerFinishedAt: String(terminalInput.provider_finished_at),
					httpStatus: String(terminalInput.http_status),
					providerRequestId: String(terminalInput.provider_request_id),
					responseSha256: String(terminalInput.response_sha256),
					failureClass: "none",
					providerErrorCode: "",
					actualDimensions: dimensions(terminalInput.actual_dimensions),
					providerUsage: terminalInput.provider_usage as unknown as ProviderCallUsage,
				},
				reservation.issuePermit,
			),
		).rejects.toThrow(/invalid.*receipt.*acknowledgement/i);
		expect(bodies).toEqual([
			wireVector("terminal_receipt_created").request_json,
			wireVector("terminal_receipt_created").request_json,
		]);
	});

	it("recovers again when the identical reserve retry after recover-404 has an unknown outcome", async () => {
		const reserve = wireVector("reserve_created");
		const recover = wireVector("recover_issue_authorized_no_permit");
		const paths: string[] = [];
		let reserveAttempts = 0;
		const authority = new HttpProviderCallAuthority({
			baseUrl: "https://authority.invalid",
			getGatewayToken: () => "gateway-token",
			getExecutionToken: () => "execution-token",
			fetch: fetchImpl(async url => {
				const path = new URL(String(url)).pathname;
				paths.push(path);
				if (path === reserve.path) {
					reserveAttempts++;
					throw new TypeError(`lost reserve response ${reserveAttempts}`);
				}
				if (paths.length === 2) return new Response(null, { status: 404 });
				return new Response(recover.response_json, {
					status: recover.status,
					headers: { "content-type": "application/json" },
				});
			}),
		});
		await expect(authority.reserve(goldenReserveRequest(goldenContext()))).rejects.toThrow(
			/recovered without issue authority/i,
		);
		expect(paths).toEqual([reserve.path, recover.path, reserve.path, recover.path]);
	});
});
