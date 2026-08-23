import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { providerCallReceiptRequestSha256 } from "@oh-my-pi/pi-ai/provider-call-authority";
import { FileProviderCallJournal } from "@oh-my-pi/pi-ai/provider-call-journal";
import {
	PROVIDER_CALL_ORIGIN_ASSIGNMENT_FIELDS,
	type ProviderCallOriginAssignment,
	resolveProviderCallOriginBinding,
} from "@oh-my-pi/pi-ai/provider-call-origin-manifest";
import type {
	ProviderCallAuthority,
	ProviderCallContext,
	ProviderCallJournalLease,
	ProviderCallReceiptAck,
	ProviderCallReceiptRequest,
	ProviderCallReservation,
	ProviderCallReserveRequest,
} from "@oh-my-pi/pi-ai/types";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

const CAPACITY_ASSIGNMENT_SHA256 = `sha256:${"f".repeat(64)}`;

function originAssignment(credentialGeneration: string): ProviderCallOriginAssignment {
	const binding = resolveProviderCallOriginBinding("deepseek-v4-pro-0813-max-r3", 0);
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

function context(callSequence: string, idempotencySuffix: string): ProviderCallContext {
	return {
		mode: "strict",
		configId: "deepseek-v4-pro-0813-max-r3",
		taskReservationId: "11111111-1111-4111-8111-111111111111",
		providerRouteAssignmentId: "11111111-1111-4111-8111-111111111112",
		executionBindingId: "22222222-2222-4222-8222-222222222222",
		podUid: "pod-uid",
		callSequence,
		idempotencyKey: `44444444-4444-4444-8444-4444444444${idempotencySuffix}`,
		apiFamily: "openai-completions",
		provider: "deepseek",
		accountId: "account-1",
		modelId: "deepseek-v4-pro",
		credentialGeneration: "generation-1",
		capabilityId: "55555555-5555-4555-8555-555555555555",
		assignmentSha256: CAPACITY_ASSIGNMENT_SHA256,
		snapshotId: "66666666-6666-4666-8666-666666666666",
		tokenizerContractSha256: `sha256:${"1".repeat(64)}`,
		inputTokens: "3",
		maxOutputTokens: "16",
		expectedDimensions: [
			{ dimension: "concurrency", windowId: "-", amount: "1", unitScale: "0", windowStart: null, windowEnd: null },
		],
		originAssignment: originAssignment("generation-1"),
	};
}

function reservation(ctx: ProviderCallContext): ProviderCallReservation {
	return {
		reservationId: "88888888-8888-4888-8888-888888888888",
		disposition: "created",
		callSequence: ctx.callSequence,
		idempotencyKey: ctx.idempotencyKey,
		requestSha256: `sha256:${"2".repeat(64)}`,
		issuePermit: `pcr1_${"A".repeat(43)}`,
		assignmentSha256: ctx.assignmentSha256,
		issueAuthorizedAt: "2026-08-23T00:00:00.000000Z",
		originAssignment: ctx.originAssignment,
	};
}
function reservationReference(ctx: ProviderCallContext): ProviderCallReceiptRequest["reservation"] {
	const created = reservation(ctx);
	return {
		reservationId: created.reservationId,
		disposition: created.disposition,
		callSequence: created.callSequence,
		idempotencyKey: created.idempotencyKey,
		requestSha256: created.requestSha256,
		issueAuthorizedAt: created.issueAuthorizedAt,
		assignmentSha256: created.assignmentSha256,
		originAssignment: created.originAssignment,
	};
}

function reserveRequest(ctx: ProviderCallContext): ProviderCallReserveRequest {
	const body = new TextEncoder().encode("{}");
	return {
		context: ctx,
		provider: ctx.provider,
		model: ctx.modelId,
		apiFamily: ctx.apiFamily,
		httpMethod: "POST",
		credentialFreeUrl: "https://api.deepseek.com/chat/completions",
		contentType: "application/json",
		headers: [["content-type", "application/json"]],
		payload: {},
		body,
		canonicalRequest: body,
		requestSha256: `sha256:${"2".repeat(64)}`,
		requestBodyBytes: String(body.byteLength),
	};
}

function receipt(ctx: ProviderCallContext, op: string): ProviderCallReceiptRequest {
	return {
		context: ctx,
		reservation: reservationReference(ctx),
		receiptOperationId: op,
		classification: "ambiguous",
		authorityOwner: "generic-omp-auth-gateway",
		backendEqualityResult: "MATCH",
		providerRequestCount: 1,
		retryCount: 0,
		failoverCount: 0,
		redirectFollowCount: 0,
		finalClassification: "AMBIGUOUS_ATTEMPT",
		drainState: "FROZEN",
		providerStartedAt: "2026-08-23T00:00:00.000000Z",
		providerFinishedAt: "2026-08-23T00:00:01.000000Z",
		ambiguityClass: "gateway_crash_recovery",
		requestMayHaveReachedProvider: true,
		requestBytesWritten: "80",
		responseBytesReceived: "0",
	};
}

type CrashSafeJournal = FileProviderCallJournal & {
	markReserveSent(lease: ProviderCallJournalLease): Promise<void>;
	close(): Promise<void>;
};

function crashSafe(journal: FileProviderCallJournal): CrashSafeJournal {
	return journal as unknown as CrashSafeJournal;
}

function ack(request: ProviderCallReceiptRequest): ProviderCallReceiptAck {
	return {
		disposition: "created",
		reservationId: request.reservation.reservationId,
		state: request.classification,
		receiptOperationId: request.receiptOperationId,
		receiptSha256: providerCallReceiptRequestSha256(request),
		recordedAt: "2026-08-23T00:00:02.000000Z",
		settlements: [],
		capabilityState: request.classification === "ambiguous" ? "zero" : "ready",
		zeroReason: request.classification === "ambiguous" ? "ambiguous_provider_call" : "",
	};
}

async function journalPath(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-call-journal-"));
	roots.push(root);
	return path.join(root, "journal.json");
}

describe("durable provider-call journal", () => {
	it("serializes one binding and durably advances call sequence only after an acknowledged receipt", async () => {
		const file = await journalPath();
		const journal = new FileProviderCallJournal(file);
		const firstContext = context("1", "01");
		const first = await journal.begin(firstContext, reserveRequest(firstContext));
		await journal.markReserveSent(first);
		const firstReceipt = receipt(firstContext, first.receiptOperationId);
		await journal.storeReservation(first, firstReceipt.reservation);
		await journal.storeProviderAttempt(first, "2026-08-23T00:00:00.000000Z");
		await journal.storePendingReceipt(first, firstReceipt);

		let secondStarted = false;
		const secondPromise = journal.begin(context("2", "02")).then(lease => {
			secondStarted = true;
			return lease;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(secondStarted).toBe(false);
		await journal.completeReceipt(first, ack(firstReceipt));
		const second = await secondPromise;
		expect(secondStarted).toBe(true);
		expect(second.receiptOperationId).not.toBe(first.receiptOperationId);

		const persisted = JSON.parse(await Bun.file(file).text()) as { bindings: Record<string, unknown> };
		expect(persisted.bindings[firstContext.executionBindingId]).toBeDefined();
	});

	it("round-trips canonical terminal provider usage in durable receipt evidence", async () => {
		const file = await journalPath();
		const ctx = context("1", "01");
		const firstJournal = new FileProviderCallJournal(file);
		const lease = await firstJournal.begin(ctx, reserveRequest(ctx));
		await firstJournal.markReserveSent(lease);
		const pending = receipt(ctx, lease.receiptOperationId);
		pending.classification = "terminal";
		pending.finalClassification = "TERMINAL_RESPONSE";
		pending.drainState = "DRAINED";
		pending.httpStatus = "200";
		pending.responseSha256 = `sha256:${"3".repeat(64)}`;
		pending.failureClass = "none";
		pending.actualDimensions = structuredClone(ctx.expectedDimensions);
		pending.providerUsage = { unit: "tokens", coefficient: "999", scale: "0" };
		delete pending.ambiguityClass;
		delete pending.requestMayHaveReachedProvider;
		delete pending.requestBytesWritten;
		delete pending.responseBytesReceived;
		await firstJournal.storeReservation(lease, pending.reservation);
		await firstJournal.storeProviderAttempt(lease, pending.providerStartedAt!);
		await firstJournal.storePendingReceipt(lease, pending);
		await firstJournal.close();

		const persisted = JSON.parse(await Bun.file(file).text()) as {
			bindings: Record<
				string,
				{ active?: { pendingReceipt?: ProviderCallReceiptRequest; pendingReceiptSha256?: string } }
			>;
		};
		const active = persisted.bindings[ctx.executionBindingId]?.active;
		expect(active?.pendingReceipt?.providerUsage).toEqual({
			unit: "tokens",
			coefficient: "999",
			scale: "0",
		});
		expect(active?.pendingReceiptSha256).toBe(providerCallReceiptRequestSha256(pending));

		let recoverCalls = 0;
		const authority = {
			async recover() {
				recoverCalls++;
				return {
					kind: "found",
					state: "terminal",
					reservation: pending.reservation,
					receipt: {
						classification: "terminal_response",
						receiptOperationId: pending.receiptOperationId,
						receiptSha256: providerCallReceiptRequestSha256(pending),
						recordedAt: "2026-08-23T00:00:02.000000Z",
					},
				};
			},
		} as unknown as ProviderCallAuthority;
		const reconstructed = new FileProviderCallJournal(file);
		await reconstructed.recoverPendingReceipts(authority);
		expect(recoverCalls).toBe(1);
		await reconstructed.close();
	});

	it("reconciles a committed receipt through recover without replaying a receipt or durable permit", async () => {
		const file = await journalPath();
		const firstJournal = new FileProviderCallJournal(file);
		const ctx = context("1", "01");
		const lease = await firstJournal.begin(ctx, reserveRequest(ctx));
		await crashSafe(firstJournal).markReserveSent(lease);
		const pending = receipt(ctx, lease.receiptOperationId);
		const plaintextPermit = reservation(ctx).issuePermit;
		await firstJournal.storeReservation(lease, pending.reservation);
		await firstJournal.storeProviderAttempt(lease, "2026-08-23T00:00:00.000000Z");
		await firstJournal.storePendingReceipt(lease, pending);
		expect(await Bun.file(file).text()).not.toContain(plaintextPermit);
		await crashSafe(firstJournal).close();

		let recoverCalls = 0;
		let reserveCalls = 0;
		let receiptCalls = 0;
		const authority = {
			async reserve() {
				reserveCalls++;
				throw new Error("must not reserve during recovery");
			},
			async recover() {
				recoverCalls++;
				return {
					kind: "found",
					state: "ambiguous",
					reservation: pending.reservation,
					receipt: {
						classification: "ambiguous_attempt",
						receiptOperationId: pending.receiptOperationId,
						receiptSha256: providerCallReceiptRequestSha256(pending),
						recordedAt: "2026-08-23T00:00:02.000000Z",
					},
				};
			},
			async recordReceipt() {
				receiptCalls++;
				throw new Error("must not replay receipt without plaintext permit");
			},
		} as unknown as ProviderCallAuthority;
		const reconstructed = new FileProviderCallJournal(file);
		await reconstructed.recoverPendingReceipts(authority);
		expect(recoverCalls).toBe(1);
		expect(reserveCalls).toBe(0);
		expect(receiptCalls).toBe(0);
		await expect(reconstructed.begin(context("2", "02"))).resolves.toMatchObject({ callSequence: "2" });
		await crashSafe(reconstructed).close();
	});

	it("round-trips versioned durable evidence and rejects every evidence mutation before recovery contact", async () => {
		const sourceFile = await journalPath();
		const ctx = context("1", "01");
		const source = new FileProviderCallJournal(sourceFile);
		const lease = await source.begin(ctx, reserveRequest(ctx));
		await source.markReserveSent(lease);
		const pending = receipt(ctx, lease.receiptOperationId);
		await source.storeReservation(lease, pending.reservation);
		await source.storeProviderAttempt(lease, pending.providerStartedAt!);
		await source.storePendingReceipt(lease, pending);
		await source.close();
		const baseline = JSON.parse(await Bun.file(sourceFile).text()) as {
			schema: string;
			bindings: Record<string, { active?: { pendingReceipt?: Record<string, unknown> } }>;
		};
		expect(baseline.schema).toBe("terminal-bench/provider-call-journal/v3");
		expect(baseline.bindings[ctx.executionBindingId]?.active?.pendingReceipt).toMatchObject({
			context: { assignmentSha256: CAPACITY_ASSIGNMENT_SHA256 },
			reservation: { assignmentSha256: CAPACITY_ASSIGNMENT_SHA256 },
			authorityOwner: "generic-omp-auth-gateway",
			backendEqualityResult: "MATCH",
			providerRequestCount: 1,
			retryCount: 0,
			failoverCount: 0,
			redirectFollowCount: 0,
			finalClassification: "AMBIGUOUS_ATTEMPT",
			drainState: "FROZEN",
		});
		const expectEvidenceMutationFailure = async (
			name: string,
			mutate: (receipt: Record<string, unknown>) => void,
		): Promise<void> => {
			const corrupted = structuredClone(baseline);
			const corruptedReceipt = corrupted.bindings[ctx.executionBindingId]?.active?.pendingReceipt;
			if (!corruptedReceipt) throw new Error("expected pending receipt");
			mutate(corruptedReceipt);
			const file = await journalPath();
			await fs.writeFile(file, JSON.stringify(corrupted), { mode: 0o600 });
			let recoveryCalls = 0;
			const authority = {
				async recover() {
					recoveryCalls++;
					throw new Error("must not contact recovery with mutated evidence");
				},
			} as unknown as ProviderCallAuthority;
			await expect(new FileProviderCallJournal(file).recoverPendingReceipts(authority), name).rejects.toThrow(
				/evidence|receipt|classification|assignment|invalid|mismatch/i,
			);
			expect(recoveryCalls, name).toBe(0);
		};
		const mutations: Record<string, unknown> = {
			authorityOwner: "dedicated-codex-backend",
			backendEqualityResult: "MISMATCH",
			providerRequestCount: 0,
			retryCount: 1,
			failoverCount: 1,
			redirectFollowCount: 1,
			finalClassification: "TERMINAL_RESPONSE",
			drainState: "DRAINED",
		};
		for (const [field, replacement] of Object.entries(mutations)) {
			await expectEvidenceMutationFailure(field, corruptedReceipt => {
				corruptedReceipt[field] = replacement;
			});
		}
		await expectEvidenceMutationFailure("context assignment digest only", corruptedReceipt => {
			(corruptedReceipt.context as ProviderCallContext).assignmentSha256 = `sha256:${"e".repeat(64)}`;
		});
		await expectEvidenceMutationFailure("matching context and reservation assignment digests", corruptedReceipt => {
			const replacement = `sha256:${"e".repeat(64)}`;
			(corruptedReceipt.context as ProviderCallContext).assignmentSha256 = replacement;
			(corruptedReceipt.reservation as ProviderCallReservation).assignmentSha256 = replacement;
		});
	});

	it("recovers first after an uncertain reserve and never replays reserve when recovery says absent", async () => {
		const file = await journalPath();
		const firstJournal = new FileProviderCallJournal(file);
		const ctx = context("1", "01");
		const lease = await firstJournal.begin(ctx, reserveRequest(ctx));
		await crashSafe(firstJournal).markReserveSent(lease);
		await crashSafe(firstJournal).close();
		let recoverCalls = 0;
		let reserveCalls = 0;
		const authority = {
			async reserve() {
				reserveCalls++;
				throw new Error("must not replay reserve");
			},
			async recover() {
				recoverCalls++;
				return { kind: "absent" };
			},
			async recordReceipt() {
				throw new Error("must not record");
			},
		} as unknown as ProviderCallAuthority;
		const reconstructed = new FileProviderCallJournal(file);
		await reconstructed.recoverPendingReceipts(authority);
		expect(recoverCalls).toBe(1);
		expect(reserveCalls).toBe(0);
		await expect(reconstructed.begin(ctx, reserveRequest(ctx))).resolves.toMatchObject({ callSequence: "1" });
		await crashSafe(reconstructed).close();
	});

	it("reclaims an incomplete owner directory left by a crash before owner metadata commit", async () => {
		const file = await journalPath();
		await fs.mkdir(`${file}.owner`, { mode: 0o700 });
		const journal = new FileProviderCallJournal(file);
		await expect(journal.begin(context("1", "01"), reserveRequest(context("1", "01")))).resolves.toMatchObject({
			callSequence: "1",
		});
		await journal.close();
	});

	it("does not let a second process recover or ambiguously settle a live owner's call", async () => {
		const file = await journalPath();
		const owner = new FileProviderCallJournal(file);
		const ctx = context("1", "01");
		const lease = await owner.begin(ctx, reserveRequest(ctx));
		await crashSafe(owner).markReserveSent(lease);
		await owner.storeReservation(lease, reservation(ctx));
		let recoverCalls = 0;
		const authority = {
			async reserve() {
				throw new Error("must not reserve");
			},
			async recover() {
				recoverCalls++;
				return { kind: "found", state: "issue_authorized", reservation: reservation(ctx), receipt: null };
			},
			async recordReceipt() {
				throw new Error("must not record");
			},
		} as unknown as ProviderCallAuthority;
		const contender = new FileProviderCallJournal(file);
		await expect(contender.recoverPendingReceipts(authority)).rejects.toThrow(/live owner|already owned/i);
		expect(recoverCalls).toBe(0);
		await crashSafe(owner).close();
	});

	it("coalesces concurrent recovery and clears an absent uncertain reserve exactly once", async () => {
		const file = await journalPath();
		const first = new FileProviderCallJournal(file);
		const ctx = context("1", "01");
		const lease = await first.begin(ctx, reserveRequest(ctx));
		await first.markReserveSent(lease);
		await first.close();
		let recoverCalls = 0;
		const recoveryStarted = Promise.withResolvers<void>();
		const releaseRecovery = Promise.withResolvers<void>();
		const authority = {
			async reserve() {
				throw new Error("must not reserve");
			},
			async recover() {
				recoverCalls++;
				recoveryStarted.resolve();
				await releaseRecovery.promise;
				return { kind: "absent" };
			},
			async recordReceipt() {
				throw new Error("must not record");
			},
		} as unknown as ProviderCallAuthority;
		const reconstructed = new FileProviderCallJournal(file);
		const firstRecovery = reconstructed.recoverPendingReceipts(authority);
		const secondRecovery = reconstructed.recoverPendingReceipts(authority);
		await recoveryStarted.promise;
		releaseRecovery.resolve();
		await Promise.all([firstRecovery, secondRecovery]);
		expect(recoverCalls).toBe(1);
		await expect(reconstructed.begin(ctx, reserveRequest(ctx))).resolves.toMatchObject({ callSequence: "1" });
		await reconstructed.close();
	});

	it("freezes recovered issue authority instead of inventing an ambiguous receipt without the permit", async () => {
		const file = await journalPath();
		const first = new FileProviderCallJournal(file);
		const ctx = context("1", "01");
		const lease = await first.begin(ctx, reserveRequest(ctx));
		await first.markReserveSent(lease);
		await first.storeReservation(lease, reservationReference(ctx));
		await first.close();
		let receiptCalls = 0;
		const authority = {
			async reserve() {
				throw new Error("must not reserve");
			},
			async recover() {
				return {
					kind: "found",
					state: "issue_authorized",
					reservation: reservationReference(ctx),
					receipt: null,
				};
			},
			async recordReceipt() {
				receiptCalls++;
				throw new Error("must not record");
			},
		} as unknown as ProviderCallAuthority;
		const reconstructed = new FileProviderCallJournal(file);
		await expect(reconstructed.recoverPendingReceipts(authority)).rejects.toThrow(/permit is unavailable|frozen/i);
		expect(receiptCalls).toBe(0);
		await expect(reconstructed.begin(context("2", "02"))).rejects.toThrow(/unresolved/i);
		await reconstructed.close();
	});

	it("rejects cross-Pod hydration before contacting controller recovery", async () => {
		const file = await journalPath();
		const first = new FileProviderCallJournal(file, { expectedPodUid: "pod-uid" });
		await first.begin(context("1", "01"), reserveRequest(context("1", "01")));
		await first.close();
		let recoverCalls = 0;
		const authority = {
			async reserve() {
				throw new Error("must not reserve");
			},
			async recover() {
				recoverCalls++;
				return { kind: "absent" };
			},
			async recordReceipt() {
				throw new Error("must not record");
			},
		} as unknown as ProviderCallAuthority;
		const otherPod = new FileProviderCallJournal(file, { expectedPodUid: "other-pod" });
		await expect(otherPod.recoverPendingReceipts(authority)).rejects.toThrow(/different Pod UID/i);
		expect(recoverCalls).toBe(0);
	});

	it("rejects every live-context invariant violation and any full recovery-context divergence during hydration", async () => {
		type PersistedActive = {
			context: ProviderCallContext;
			recoverRequest: { context: ProviderCallContext; requestSha256: string };
		};
		type PersistedState = {
			schema: string;
			podUid: string | null;
			bindings: Record<string, { lastCompletedSequence: string; active?: PersistedActive }>;
		};
		const sourceFile = await journalPath();
		const ctx = context("1", "01");
		ctx.expectedDimensions.push({
			dimension: "rpm_requests",
			windowId: "window-1",
			amount: "1",
			unitScale: "0",
			windowStart: "2026-08-23T00:00:00.000000Z",
			windowEnd: "2026-08-23T00:01:00.000000Z",
		});
		const source = new FileProviderCallJournal(sourceFile);
		const lease = await source.begin(ctx, reserveRequest(ctx));
		await source.markReserveSent(lease);
		await source.close();
		const baseline = JSON.parse(await Bun.file(sourceFile).text()) as PersistedState;

		const expectHydrationFailure = async (name: string, mutate: (active: PersistedActive) => void): Promise<void> => {
			const corrupted = structuredClone(baseline);
			const active = corrupted.bindings[ctx.executionBindingId]?.active;
			if (!active) throw new Error("expected active provider-call journal state");
			mutate(active);
			const file = await journalPath();
			await fs.writeFile(file, JSON.stringify(corrupted), { mode: 0o600 });
			let recoverCalls = 0;
			const authority = {
				async reserve() {
					throw new Error("must not reserve");
				},
				async recover() {
					recoverCalls++;
					throw new Error("controller recovery must not receive corrupt durable state");
				},
				async recordReceipt() {
					throw new Error("must not record");
				},
			} as unknown as ProviderCallAuthority;
			await expect(new FileProviderCallJournal(file).recoverPendingReceipts(authority), name).rejects.toThrow(
				/hydrate|identity|invalid|origin|Pod|mismatch|unsorted/i,
			);
			expect(recoverCalls, name).toBe(0);
		};

		for (const [name, mutateContext] of [
			[
				"positive amount",
				(context: ProviderCallContext) => {
					context.expectedDimensions[0]!.amount = "0";
				},
			],
			[
				"one-digit unit scale",
				(context: ProviderCallContext) => {
					context.expectedDimensions[0]!.unitScale = "10";
				},
			],
			[
				"raw UTF-8 dimension ordering",
				(context: ProviderCallContext) => {
					context.expectedDimensions.reverse();
				},
			],
			[
				"positive call sequence",
				(context: ProviderCallContext) => {
					context.callSequence = "0";
				},
			],
			[
				"trimmed required scalar",
				(context: ProviderCallContext) => {
					context.accountId = " ";
				},
			],
			[
				"origin manifest identity",
				(context: ProviderCallContext) => {
					context.provider = "other-provider";
				},
			],
		] as const) {
			await expectHydrationFailure(name, active => {
				mutateContext(active.context);
				mutateContext(active.recoverRequest.context);
			});
		}

		for (const [name, mutateRecovery] of [
			[
				"task reservation",
				(context: ProviderCallContext) => {
					context.taskReservationId = "77777777-7777-4777-8777-777777777777";
				},
			],
			[
				"Pod",
				(context: ProviderCallContext) => {
					context.podUid = "other-pod";
				},
			],
			[
				"account",
				(context: ProviderCallContext) => {
					context.accountId = "other-account";
				},
			],
			[
				"credential generation",
				(context: ProviderCallContext) => {
					context.credentialGeneration = "other-generation";
				},
			],
			[
				"capability",
				(context: ProviderCallContext) => {
					context.capabilityId = "77777777-7777-4777-8777-777777777777";
				},
			],
			[
				"snapshot",
				(context: ProviderCallContext) => {
					context.snapshotId = "77777777-7777-4777-8777-777777777777";
				},
			],
			[
				"tokenizer contract",
				(context: ProviderCallContext) => {
					context.tokenizerContractSha256 = `sha256:${"2".repeat(64)}`;
				},
			],
			[
				"input counter",
				(context: ProviderCallContext) => {
					context.inputTokens = "4";
				},
			],
			[
				"output counter",
				(context: ProviderCallContext) => {
					context.maxOutputTokens = "17";
				},
			],
			[
				"dimension vector",
				(context: ProviderCallContext) => {
					context.expectedDimensions[0]!.amount = "2";
				},
			],
			[
				"provider/model/config",
				(context: ProviderCallContext) => {
					context.configId = "kimi-k3-high";
					context.provider = "kimi-code";
					context.modelId = "k3";
				},
			],
			[
				"API family",
				(context: ProviderCallContext) => {
					context.configId = "gemini37-max-workflowz";
					context.provider = "google-antigravity";
					context.modelId = "gemini-3.7-flash";
					context.apiFamily = "google-gemini-cli";
				},
			],
		] as const) {
			await expectHydrationFailure(name, active => mutateRecovery(active.recoverRequest.context));
		}

		for (const field of PROVIDER_CALL_ORIGIN_ASSIGNMENT_FIELDS) {
			await expectHydrationFailure(`recovery origin assignment ${field}`, active => {
				const recoveryAssignment = active.recoverRequest.context.originAssignment as unknown as Record<
					string,
					unknown
				>;
				const current = recoveryAssignment[field];
				recoveryAssignment[field] =
					typeof current === "number"
						? current + 1
						: field === "capability_generation" || field === "credential_generation"
							? "other-generation"
							: field === "source_release_digest" || field === "restricted_proxy_policy_sha256"
								? `sha256:${"c".repeat(64)}`
								: `${String(current)}-wrong`;
			});
		}
	});

	it("rejects unsafe journal modes, symlink aliases, oversized state, and invalid hydrated fields", async () => {
		const file = await journalPath();
		await fs.writeFile(file, JSON.stringify({ schema: "terminal-bench/provider-call-journal/v3", bindings: {} }), {
			mode: 0o644,
		});
		await expect(new FileProviderCallJournal(file).begin(context("1", "01"))).rejects.toThrow(/mode|0600/i);

		const root = path.dirname(file);
		const target = path.join(root, "target.json");
		await fs.writeFile(target, JSON.stringify({ schema: "terminal-bench/provider-call-journal/v3", bindings: {} }), {
			mode: 0o600,
		});
		const alias = path.join(root, "alias.json");
		await fs.symlink(target, alias);
		await expect(new FileProviderCallJournal(alias).begin(context("1", "01"))).rejects.toThrow(/symlink|alias/i);

		await fs.chmod(file, 0o600);
		await fs.writeFile(file, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
		await expect(new FileProviderCallJournal(file).begin(context("1", "01"))).rejects.toThrow(/too large|bound/i);

		await fs.writeFile(
			file,
			'{"schema":"terminal-bench/provider-call-journal/v3","schema":"terminal-bench/provider-call-journal/v3","podUid":"pod-uid","bindings":{}}',
			{ mode: 0o600 },
		);
		await expect(new FileProviderCallJournal(file).begin(context("1", "01"))).rejects.toThrow(/duplicate/i);

		await fs.writeFile(
			file,
			JSON.stringify({
				schema: "terminal-bench/provider-call-journal/v3",
				podUid: "pod-uid",
				bindings: { [context("1", "01").executionBindingId]: { lastCompletedSequence: "-1" } },
			}),
			{ mode: 0o600 },
		);
		await expect(new FileProviderCallJournal(file).begin(context("1", "01"))).rejects.toThrow(/invalid|hydrate/i);
	});
});
