import { describe, expect, it, spyOn } from "bun:test";
import { type ApprovalDecision, type ApprovalRequest, type EngineBindingGate, type EngineBindingResult, type EngineEvent, sameSemanticBinding, validateSemanticBinding } from "../src/engine/contracts";
import { type EngineCommandEnvelope, engineCommandIdentity } from "../src/engine/nats-adapter";
import { engineAgentInstanceId } from "../src/engine/route";
import type { RocksEngineStore } from "../src/engine/rocks-runtime-store";
import type { RocksEffect } from "../src/engine/rocks-runtime-rows";
import { type EngineApprovalRow, EngineCommandConflictError } from "../src/engine/store";
import {
	RUNTIME_PROTOCOL_HASH,
	type RuntimeScope,
	runtimeLimits,
	validateRuntimeValue,
} from "../src/engine/runtime-protocol";
import type { StoragePayload } from "../src/session/storage-protocol";
import {
	active,
	binding,
	command,
	eventsRequest,
	identity,
	nativeCheckpoint,
	runtimeV1Fixture,
	semanticBinding,
} from "./helpers/runtime-v1-rocks-fixture";
import { storageWorkerUnavailable } from "./helpers/storage-worker-fixture";

/** Fail the owner commit that stages `matches`; nothing of that atomic batch is applied. */
function failCommit(
	store: RocksEngineStore,
	message: string,
	matches: (put: { kind: string; id: string; value: StoragePayload }) => boolean,
) {
	const write = store.storageClient.write.bind(store.storageClient);
	return spyOn(store.storageClient, "write").mockImplementation((input, ...rest) => {
		if (input.runtime?.puts.some(matches)) throw new Error(message);
		return write(input, ...rest);
	});
}

it("fences semantic scope independently of opaque Agent provenance and validates owned birth snapshots", () => {
	const ref = "grimoire://tasks/birth/provenance/agents/legacy";
	const snapshot = semanticBinding(ref, "grimoire://tasks/current/explicit", "step");
	validateSemanticBinding(snapshot, ref);
	expect(sameSemanticBinding(snapshot, { ...snapshot })).toBe(true);
	for (const changed of [
		{ ...snapshot, taskRef: "grimoire://tasks/current/other" },
		{ ...snapshot, workStepId: null },
		{ ...snapshot, bindingRevision: 1, installationId: `install_${"a".repeat(32)}` },
	]) expect(sameSemanticBinding(snapshot, changed)).toBe(false);
	for (const rejected of [
		{ ...snapshot, taskRef: null },
		{ ...snapshot, taskRef: `grimoire://tasks/~u/${"a".repeat(64)}/private` },
		{ ...snapshot, taskRef: null, workStepId: null },
		{ ...snapshot, bindingRevision: 1, installationId: `install_${"a".repeat(32)}` },
		{ ...snapshot, bindingRevision: Number.MAX_SAFE_INTEGER + 1 },
	]) expect(() => validateSemanticBinding(rejected, ref)).toThrow();
	const ownedRef = `grimoire://agents/~u/${"b".repeat(64)}/owned`;
	validateRuntimeValue("agi", ownedRef);
	expect(() => validateSemanticBinding({ ...snapshot, agentInstanceRef: ownedRef }, ownedRef)).toThrow();
	const owned = { ...snapshot, agentInstanceRef: ownedRef, bindingRevision: 1, installationId: `install_${"a".repeat(32)}` };
	validateSemanticBinding(owned, ownedRef);
	validateSemanticBinding({ ...owned, taskRef: null, workStepId: null }, ownedRef);
	expect(() => validateSemanticBinding({ ...owned, taskRef: null }, ownedRef)).toThrow();
	expect(() => validateRuntimeValue("agi", `${ref}\n`)).toThrow();
	const envelope = {
		schema: "grimoire.engine.command.v1" as const, op: "start" as const, commandId: "exact",
		deviceId: "device", engineId: "engine", engineGeneration: 1, agentInstanceId: "agent",
		agentInstanceRef: ref, bindingSnapshot: snapshot, authorityGeneration: 1, issuedAt: 1,
		payload: { cwd: "pinned", input: "same" },
	};
	expect(engineCommandIdentity(envelope).canonicalHash).not.toBe(
		engineCommandIdentity({ ...envelope, bindingSnapshot: { ...snapshot, workStepId: null } }).canonicalHash,
	);
});

describe.skipIf(storageWorkerUnavailable)("runtime v1 durable boundaries", () => {
	const { createStore, reopen } = runtimeV1Fixture();
	async function identityRows(store: RocksEngineStore, names: string[]) {
		return Promise.all(
			names.map(async name => {
				const row = (await store.records.get("identity", identity(name).agentInstanceId)).value;
				return [row?.intent_revision, row?.summary_revision, row?.summary_json];
			}),
		);
	}

	it("releases only the terminal predecessor projection after a new Attempt commits", async () => {
		const store = await createStore();
		const prior = await active(store);
		const checkpoint = await nativeCheckpoint(store);
		await store.commitAttemptTransition({ ...prior, state: "idle" }, "completed", [{ kind: "completed" }],
			{ transcriptCheckpoint: checkpoint });
		const next = { ...prior, commandId: "next-start", executionId: "next-execution", attemptId: "next-attempt",
			bindingId: "next-binding", bindingGeneration: prior.bindingGeneration + 1 };
		await store.commitAttemptTransition(next, "running", [{ kind: "running" }], { requireNew: true });
		await store.putBinding({ ...prior, state: "released" });
		expect(await store.getBinding(prior.agentInstanceId)).toMatchObject({
			attemptId: next.attemptId, bindingId: next.bindingId, bindingGeneration: next.bindingGeneration, state: "running",
		});
		expect((await store.getAttempt(prior.attemptId))?.state).toBe("completed");
		await expect(store.putBinding({ ...prior, state: "running" })).rejects.toThrow();
		await expect(store.putBinding({ ...prior, state: "released", attemptId: "foreign-old-attempt" })).rejects.toThrow();
		await expect(store.putBinding({ ...next, state: "released", bindingId: "wrong-same-generation" })).rejects.toThrow();
	});

	for (const appliedBeforeRestart of [false, true]) it(
		appliedBeforeRestart
			? "replays an applied old-generation approval and its lost hosted acknowledgement without another decision"
			: "prepares only never-admitted approvals on the adopted destination generation",
		async () => {
			const store = await createStore();
			const principalId = "grimoire:user:approval-delivery";
			const installationId = `install_${"a".repeat(32)}`;
			const owner = new Bun.CryptoHasher("sha256").update(principalId).digest("hex");
			const agentInstanceRef = `grimoire://agents/~u/${owner}/requester`;
			const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
			const snapshot = { ...semanticBinding(agentInstanceRef), bindingRevision: 1, installationId };
			store.verifyInstallation(installationId, principalId);
			await store.checkSemanticStart(agentInstanceId, snapshot, principalId);
			const target = { ...binding("approval"), agentInstanceId, bindingSnapshot: snapshot };
			const start: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1", op: "start", commandId: target.commandId,
				deviceId: "device", engineId: "engine", engineGeneration: 1, principalId,
				agentInstanceId, agentInstanceRef, bindingSnapshot: snapshot, runtimeBindingId: target.bindingId,
				bindingGeneration: 1, authorityGeneration: 1, executionId: target.executionId, attemptId: target.attemptId,
				issuedAt: 1, payload: { expectedIntentRevision: 0 },
			};
			await store.admitCommand(engineCommandIdentity(start), 1);
			await store.commitAttemptTransition(target, "running", [{ kind: "running" }], {
				requireNew: true, settleCommandId: start.commandId,
			});
			const hash = `sha256:${"a".repeat(64)}`;
			const request: ApprovalRequest = {
				schema: "grimoire.approval_request.v1", id: "approval-effect", effect_id: "approval-effect",
				principal_id: principalId, requester_agent_ref: agentInstanceRef, requester_attempt_id: target.attemptId,
				requester_binding_revision: 1, dispatch_hash: hash, kind: "tool", name: "bash",
				subject: { tool_name: "bash", call_hash: hash, ceiling_hash: hash },
				requires_human: true, reason: "fixture decision", created_at: "2026-09-30T00:00:00Z",
				addressed_to: { kind: "human", principal_id: principalId }, addressed_at: "2026-09-30T00:00:00Z",
				expires_at: null, address_revision: 1, decision_revision: 0, status: "waiting_human_paused",
				timeout_seconds: 300, settings_revision: 0, settings_hash: hash,
			};
			// Seed the retained paused effect, not a provider or a mock approval implementation.
			const effect: RocksEffect = {
				effect_id: request.effect_id, command_id: start.commandId, agent_instance_id: agentInstanceId,
				execution_id: target.executionId, attempt_id: target.attemptId, binding_id: target.bindingId,
				engine_generation: 1, binding_generation: 1, authority_generation: 1,
				effect_kind: "tool", tool_call_id: "call", tool_name: "bash", input_hash: hash, policy: "permit",
				assistant_message_id: null, assistant_block_id: null, state: "planned", outcome: null,
				created_at: 1, updated_at: 1, runtime_event_id: 0,
			};
			await store.mutation(agentInstanceId, async tx => {
				await tx.put("effect", effect.effect_id, effect);
				await tx.put("approval", request.id, {
					approval_id: request.id, effect_id: request.effect_id, state: "pending", decision: null,
					decision_record: null, timed_out_attempt_ids: [], request, updated_at: 1,
				} satisfies EngineApprovalRow);
			});
			await store.appendEvent({ ...target, causationCommandId: start.commandId,
				kind: "tool_approval_requested", payload: request });
			await store.commitAttemptTransition(target, "paused", [{ kind: "paused" }]);
			const inputRevision = (await store.getAttempt(target.attemptId))!.input_revision;
			const decision: ApprovalDecision = {
				schema: "grimoire.approval_decision.v1", request_id: request.id, command_id: "approval-command",
				expected_address_revision: 1, expected_decision_revision: 0, decision: "approve", reason: null,
				origin_receipt_id: "origin-fixture", decided_by: { kind: "human", principal_id: principalId },
				authority: { ceiling_hash: hash, subject_hash: hash, dispatch_hash: hash },
				decided_at: "2026-09-30T00:01:00Z",
			};
			const envelope: EngineCommandEnvelope = { ...start, op: "resolve_approval", commandId: decision.command_id,
				payload: { originReceiptId: decision.origin_receipt_id, approvalDecision: decision, expectedInputRevision: inputRevision } };
			const original = engineCommandIdentity(envelope);
			if (appliedBeforeRestart) {
				await store.admitCommand(original, 1);
				await store.resolveApproval(target, request.id, "approve", decision, {
					settleCommandId: original.commandId, causationCommandId: original.commandId, expectedInputRevision: inputRevision,
				});
			}
			const restarted = reopen();
			restarted.verifyInstallation(installationId, principalId);
			const generation = await restarted.nextEngineGeneration();
			const current = { ...target, engineGeneration: generation };
			// The existing recovery owner adopts this fence. This case tests delivery after that adoption,
			// not the separate runtime/session rehydration path.
			await restarted.mutation(agentInstanceId, async tx => {
				const nativeBinding = await tx.get<Record<string, unknown>>("binding", agentInstanceId);
				const nativeAttempt = await tx.get<Record<string, unknown>>("attempt", target.attemptId);
				await tx.put("binding", agentInstanceId, { ...nativeBinding, engine_generation: generation });
				await tx.put("attempt", target.attemptId, { ...nativeAttempt, engine_generation: generation });
				await tx.put("effect", effect.effect_id, { ...effect, engine_generation: generation });
			});
			const foreign = reopen();
			foreign.verifyInstallation(`install_${"b".repeat(32)}`, principalId);
			await expect(foreign.approvalDelivery(original, decision, inputRevision, generation))
				.rejects.toMatchObject({ code: "stale_target" });
			let delivered = original;
			if (!appliedBeforeRestart) {
				await expect(restarted.approvalDelivery(original, decision, inputRevision + 1, generation))
					.rejects.toMatchObject({ code: "stale_target" });
				await expect(restarted.approvalDelivery(original, { ...decision, expected_address_revision: 2 }, inputRevision, generation))
					.rejects.toMatchObject({ code: "stale_target" });
				await restarted.mutation(agentInstanceId, tx => tx.put("effect", effect.effect_id, {
					...effect, engine_generation: generation, state: "unknown", outcome: "unknown",
				}));
				await expect(restarted.approvalDelivery(original, decision, inputRevision, generation))
					.rejects.toMatchObject({ code: "stale_target" });
				await restarted.mutation(agentInstanceId, tx => tx.put("effect", effect.effect_id, {
					...effect, engine_generation: generation,
				}));
				expect(await restarted.approvalDelivery(original, decision, inputRevision, generation)).toEqual({ status: "absent" });
				await expect(store.admitCommand(original, 1)).rejects.toMatchObject({ code: "stale_target" });
				await expect(restarted.admitCommand(original, generation)).rejects.toMatchObject({ code: "stale_target" });
				await expect(restarted.rejectUnadmittedCommand(original, { outcome: "rejected" }, generation))
					.rejects.toMatchObject({ code: "stale_target" });
				expect(await restarted.getStartConversationIdentity(original.commandId)).toBeUndefined();
				delivered = engineCommandIdentity({ ...envelope, engineGeneration: generation });
				expect(delivered.canonicalHash).not.toBe(original.canonicalHash);
				await restarted.admitCommand(delivered, generation);
				await expect(restarted.approvalDelivery(delivered, decision, inputRevision, generation))
					.rejects.toMatchObject({ code: "admission_state_unknown" });
				await restarted.resolveApproval(current, request.id, "approve", decision, {
					settleCommandId: delivered.commandId, causationCommandId: delivered.commandId, expectedInputRevision: inputRevision,
				});
			}
			const retained = await restarted.approvalDelivery(delivered, decision, inputRevision, generation);
			expect(retained).toEqual({ status: "settled", identity: delivered, receipt: { outcome: "applied" } });
			if (appliedBeforeRestart)
				await expect(restarted.approvalDelivery(engineCommandIdentity({ ...envelope, engineGeneration: generation }),
					decision, inputRevision, generation)).rejects.toBeInstanceOf(EngineCommandConflictError);
			expect(await restarted.admitCommand(delivered, generation)).toEqual({ status: "replay", receipt: { outcome: "applied" } });
			expect((await restarted.getApproval(request.id))?.request.decision_revision).toBe(1);
			expect((await restarted.getEffect(request.effect_id))?.state).toBe("planned");
			const resolved = (await restarted.pendingEventsForSink("hosted-binding")).events.filter(event =>
				event.causationCommandId === delivered.commandId && event.kind === "tool_approval_resolved");
			expect(resolved.map(event => event.payload)).toEqual([{
				request_id: request.id, decision_revision: 1, outcome: "approved", decided_by: decision.decided_by,
			}]);
			await restarted.mutation(agentInstanceId, tx => tx.delete("command", delivered.commandId));
			await expect(restarted.approvalDelivery(delivered, decision, inputRevision, generation))
				.rejects.toMatchObject({ code: "admission_state_unknown" });
			expect((await restarted.getApproval(request.id))?.request.decision_revision).toBe(1);
		},
	);

	it("keeps owned admission closed across restart, certifies exact idle and adopts only the committed successor", async () => {
		const store = await createStore();
		const principalId = "grimoire:user:binding-owner";
		const installationId = `install_${"a".repeat(32)}`;
		const owner = new Bun.CryptoHasher("sha256").update(principalId).digest("hex");
		const agentInstanceRef = `grimoire://agents/~u/${owner}/bound`;
		const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
		const snapshot = { ...semanticBinding(agentInstanceRef), bindingRevision: 1, installationId };
		await expect(store.checkSemanticStart(agentInstanceId, snapshot, principalId)).rejects.toMatchObject({ code: "binding_pending" });
		store.verifyInstallation(installationId, principalId);
		await store.checkSemanticStart(agentInstanceId, snapshot, principalId);
		const proposalHash = `sha256:${"b".repeat(64)}`;
		const gate: EngineBindingGate = { bindingSnapshot: snapshot, phase: "preparing",
			operationId: "operation-one", proposalHash, gateRevision: 0, censusMutationRevision: 0 };
		const prepared = await store.bindingPrepare(gate);
		await expect(store.bindingPrepare({ ...gate, operationId: "another-operation" })).rejects.toMatchObject({ code: "stale_target" });
		const pending = { ...command("pending-owned"), agentInstanceRef, agentInstanceId, principalId,
			bindingSnapshot: snapshot, browserPayloadHash: undefined };
		expect(await store.admitCommand(pending, 1)).toEqual({ status: "binding_pending" });
		const secondPending = { ...command("pending-owned-two"), agentInstanceRef, agentInstanceId, principalId,
			bindingSnapshot: snapshot, browserPayloadHash: undefined };
		expect(await store.admitCommand(secondPending, 1)).toEqual({ status: "binding_pending" });
		const pendingRows = await store.records.getMany([
			{ kind: "command", id: pending.commandId }, { kind: "command", id: secondPending.commandId },
		]);
		let notified = false;
		void store.changeSignal().then(() => { notified = true; });
		for (let retry = 0; retry < 3; retry++)
			expect(await Promise.all([store.admitCommand(pending, 1), store.admitCommand(secondPending, 1)]))
				.toEqual([{ status: "binding_pending" }, { status: "binding_pending" }]);
		expect(await store.records.getMany(pendingRows.map(({ kind, id }) => ({ kind, id })))).toEqual(pendingRows);
		expect(notified).toBe(false);
		let restarted = reopen();
		let generation = await restarted.nextEngineGeneration();
		await restarted.interruptGeneration(generation);
		expect((await restarted.records.get("command", pending.commandId)).value).toMatchObject({
			state: "received", binding_pending: true, receipt: null,
		});
		restarted.verifyInstallation(installationId, principalId);
		const params = { agentInstanceRef, installationId, operationId: gate.operationId!, proposalHash, bindingRevision: 1 };
		expect(await restarted.bindingCensus(params, generation)).toMatchObject({ status: "busy", nonterminal_starts: 2 });
		const operation = { agent_ref: agentInstanceRef, revision: 2, binding_revision: 1,
			task_ref: snapshot.taskRef, work_step_id: snapshot.workStepId, installation_id: installationId,
			phase: "active" as const, operation_id: gate.operationId!, proposal_hash: proposalHash, status: "aborted" as const };
		const aborted: EngineBindingResult = { schema: "grimoire.agent_binding.result.v1", action: "abort", ...operation, operation_result: operation };
		const firstAbort = await restarted.bindingTransition("abort", aborted);
		const secondGate = { ...gate, operationId: "operation-two" };
		await restarted.bindingPrepare(secondGate);
		const secondOperation = { ...operation, operation_id: secondGate.operationId! };
		const secondAbort = await restarted.bindingTransition("abort",
			{ ...aborted, ...secondOperation, operation_result: secondOperation });
		expect(await restarted.bindingPrepare(gate)).toEqual(firstAbort);
		for (const action of ["abort", "status", "prepare"] as const)
			expect(await restarted.bindingTransition("abort", { ...aborted, action })).toEqual(firstAbort);
		await expect(restarted.bindingTransition("abort", { ...aborted, revision: aborted.revision + 1,
			operation_result: { ...operation, revision: operation.revision + 1 } })).rejects.toMatchObject({ code: "stale_target" });
		expect(await restarted.semanticGate(agentInstanceId)).toEqual(secondAbort);
		expect(await restarted.admitCommand(pending, generation)).toEqual({ status: "claimed" });
		const claimed = await restarted.records.get("command", pending.commandId);
		await restarted.bindingPrepare({ ...gate, operationId: "release-claimed" });
		expect(await restarted.admitCommand(pending, generation)).toEqual({ status: "binding_pending" });
		const released = await restarted.records.get("command", pending.commandId);
		expect(released.revision).toBe(claimed.revision! + 1);
		expect(released.value).toMatchObject({ binding_pending: true, processor_generation: null });
		expect(await restarted.admitCommand(pending, generation)).toEqual({ status: "binding_pending" });
		expect(await restarted.records.get("command", pending.commandId)).toEqual(released);
		const releaseOperation = { ...operation, operation_id: "release-claimed" };
		await restarted.bindingTransition("abort", { ...aborted, ...releaseOperation, operation_result: releaseOperation });
		expect(await restarted.admitCommand(pending, generation)).toEqual({ status: "claimed" });
		expect(await restarted.canRearmBindingStart(pending.commandId, generation)).toBe(true);
		await restarted.settleCommand(pending.commandId, pending.canonicalHash, { outcome: "rejected", detail: { code: "cancelled" } });
		// An empty born-owned Agent proves the positive idle/adoption path without synthetic settlement.
		const emptyRef = `grimoire://agents/~u/${owner}/empty`;
		const emptyId = engineAgentInstanceId(emptyRef);
		const emptySnapshot = { ...snapshot, agentInstanceRef: emptyRef };
		const closed = await restarted.bindingPrepare({ ...gate, bindingSnapshot: emptySnapshot, operationId: "operation-empty" });
		const emptyParams = { ...params, agentInstanceRef: emptyRef, operationId: "operation-empty" };
		// An immutable-mismatch rejection may have no identity; it belongs to neither this Agent nor its subtree.
		await restarted.rejectUnadmittedCommand({ ...command("unknown-rejection"), agentInstanceId: "unknown-agent" },
			{ outcome: "rejected", detail: { code: "immutable_mismatch" } }, generation);
		let checkpoint = await restarted.bindingCensus(emptyParams, generation);
		// Exhausting an empty record page still yields a durable child-scan cursor.
		expect(checkpoint).toMatchObject({ status: "unknown", next_cursor: expect.any(String) });
		restarted = reopen();
		restarted.verifyInstallation(installationId, principalId);
		checkpoint = await restarted.bindingCensus(emptyParams, generation);
		expect(checkpoint).toMatchObject({ status: "complete", nonterminal_starts: 0, nonterminal_attempts: 0,
			open_effects: 0, unsettled_children: 0, mutable_pending_writes: 0, next_cursor: null });
		expect(await restarted.bindingCensus(emptyParams, generation)).toEqual(checkpoint);
		const target = { ...emptySnapshot, taskRef: null, workStepId: null, bindingRevision: 2 };
		const committedOperation = { ...operation, agent_ref: emptyRef, operation_id: "operation-empty",
			revision: 3, binding_revision: 2, task_ref: null, work_step_id: null,
			phase: "committed_await_adopt" as const, status: "committed" as const };
		const committed: EngineBindingResult = { schema: "grimoire.agent_binding.result.v1", action: "commit",
			...committedOperation, operation_result: committedOperation };
		const staged = { ...closed, phase: "committed_closed" as const, committedTarget: target };
		// A new owned event after the certificate makes adoption stale, even without an Attempt or identity.
		const late = await restarted.appendEvent({ ...binding("late-owned"), engineGeneration: generation, agentInstanceId: emptyId,
			causationCommandId: "late-owned", kind: "reconciled" });
		await expect(restarted.bindingTransition("adopt", committed, staged)).rejects.toMatchObject({ code: "binding_pending" });
		restarted = reopen();
		generation = await restarted.nextEngineGeneration();
		restarted.verifyInstallation(installationId, principalId);
		await expect(restarted.bindingTransition("adopt", { ...committed, action: "status", revision: 4,
			operation_result: { ...committedOperation, revision: 4 } }, staged)).rejects.toMatchObject({ code: "stale_target" });
		await expect(restarted.bindingCensus({ ...emptyParams, bindingRevision: 2 }, generation))
			.rejects.toMatchObject({ code: "stale_target" });
		expect(await restarted.bindingCensus(emptyParams, generation))
			.toMatchObject({ status: "busy", mutable_pending_writes: 1 });
		await restarted.markEventDelivered(late.eventId, "hosted-binding");
		checkpoint = await restarted.bindingCensus(emptyParams, generation);
		for (let page = 0; checkpoint.next_cursor && page < 30; page++)
			checkpoint = await restarted.bindingCensus(emptyParams, generation);
		expect(checkpoint).toMatchObject({ status: "complete", mutable_pending_writes: 0, next_cursor: null });
		const firstAdopt = await restarted.bindingTransition("adopt", { ...committed, action: "status" }, staged);
		for (const action of ["commit", "status", "prepare"] as const)
			expect(await restarted.bindingTransition("adopt", { ...committed, action }, staged)).toEqual(firstAdopt);
		await expect(restarted.bindingTransition("adopt", { ...committed, revision: 4,
			operation_result: { ...committedOperation, revision: 4 } }, staged)).rejects.toMatchObject({ code: "stale_target" });
		await expect(restarted.checkSemanticStart(emptyId, target, principalId)).rejects.toMatchObject({ code: "binding_pending" });
		const adoptedOperation = { ...committedOperation, phase: "active" as const, status: "adopted" as const };
		const adopted: EngineBindingResult = { ...committed, ...adoptedOperation, action: "adopt", operation_result: adoptedOperation };
		await expect(restarted.bindingTransition("activate", adopted)).rejects.toMatchObject({ code: "binding_pending" });
		const targetParams = { ...emptyParams, bindingRevision: target.bindingRevision };
		checkpoint = await restarted.bindingCensus(targetParams, generation);
		expect(checkpoint).toMatchObject({ status: "unknown", binding_revision: 2 });
		for (let page = 0; checkpoint.next_cursor && page < 30; page++)
			checkpoint = await restarted.bindingCensus(targetParams, generation);
		expect(checkpoint).toMatchObject({ status: "complete", next_cursor: null });
		const firstActivate = await restarted.bindingTransition("activate", adopted);
		await restarted.checkSemanticStart(emptyId, target, principalId);
		await expect(restarted.checkSemanticStart(emptyId, emptySnapshot, principalId)).rejects.toMatchObject({ code: "stale_target" });
		restarted = reopen();
		restarted.verifyInstallation(installationId, principalId);
		for (const action of ["adopt", "status", "prepare"] as const)
			expect(await restarted.bindingTransition("activate", { ...adopted, action })).toEqual(firstActivate);
		await expect(restarted.bindingTransition("activate", { ...adopted, binding_revision: 3,
			operation_result: { ...adoptedOperation, binding_revision: 3 } })).rejects.toMatchObject({ code: "stale_target" });
		expect(firstActivate.gateRevision).toBe(closed.gateRevision + 2);
		await expect(restarted.bindingTransition("abort", { ...aborted, agent_ref: emptyRef })).rejects.toThrow();
		expect(prepared.bindingSnapshot).toEqual(snapshot);
	});

	it("admits a pre-enrolled owned child once and never recreates its lost established gate", async () => {
		const store = await createStore();
		const principalId = "grimoire:user:owned-birth";
		const installationId = `install_${"f".repeat(32)}`;
		const owner = new Bun.CryptoHasher("sha256").update(principalId).digest("hex");
		const parentRef = `grimoire://agents/~u/${owner}/parent`;
		const parentId = engineAgentInstanceId(parentRef);
		const snapshot = { ...semanticBinding(parentRef), installationId, bindingRevision: 1 };
		store.verifyInstallation(installationId, principalId);
		await store.checkSemanticStart(parentId, snapshot, principalId);
		await store.registerAgent({ agentInstanceId: parentId, agentInstanceRef: parentRef, principalId, authorityGeneration: 1 });
		const parent = { ...binding("parent"), agentInstanceId: parentId, bindingSnapshot: snapshot };
		await store.commitAttemptTransition(parent, "running", [{ kind: "running" }]);
		const childRef = `grimoire://agents/~u/${owner}/child`;
		const childId = engineAgentInstanceId(childRef);
		const childSnapshot = { ...snapshot, agentInstanceRef: childRef, parentAgentInstanceRef: parentRef,
			parentAttemptId: parent.attemptId, parentBindingRevision: 1 };
		await store.registerAgent({ agentInstanceId: childId, agentInstanceRef: childRef, principalId,
			parentAgentInstanceId: parentId, authorityGeneration: 1 });
		await expect(store.checkSemanticStart(childId, { ...childSnapshot, parentBindingRevision: 2 }, principalId))
			.rejects.toMatchObject({ code: "stale_target" });
		await store.checkSemanticStart(childId, childSnapshot, principalId);
		expect((await store.semanticGate(childId))?.bindingSnapshot).toEqual(childSnapshot);
		const event = await store.appendEvent({ ...parent, causationCommandId: parent.commandId, kind: "reconciled" });
		const marker = `binding-mutation:${parentId}`;
		const before = (await store.records.get("metadata", marker)).revision!;
		// Hold both independent family commits until both have read the same marker revision.
		const ready = Promise.withResolvers<void>();
		let arrivals = 0;
		const write = store.storageClient.write.bind(store.storageClient);
		const concurrent = spyOn(store.storageClient, "write").mockImplementation(async (input, ...rest) => {
			if (input.runtime?.puts.some(row => row.kind === "metadata" && row.id === marker) && arrivals < 2) {
				if (++arrivals === 2) ready.resolve();
				await ready.promise;
			}
			return write(input, ...rest);
		});
		let nextEvent: EngineEvent;
		try {
			[nextEvent] = await Promise.all([
				store.appendEvent({ ...parent, causationCommandId: parent.commandId, kind: "reconciled" }),
				store.markEventDelivered(event.eventId, "hosted-binding"),
			]);
		} finally {
			concurrent.mockRestore();
		}
		// The losing record CAS retries; both writes and both cut invalidations survive.
		expect((await store.records.get("metadata", marker)).revision).toBe(before + 2);
		expect((await store.records.get("delivery", `hosted-binding:${event.eventId}`)).value).toMatchObject({
			state: "delivered", agent_instance_id: parentId,
		});
		expect((await store.records.get("event", String(nextEvent.eventId))).value?.eventId).toBe(nextEvent.eventId);
		const stableCut = (await store.records.get("metadata", marker)).revision;
		await store.markEventPublished(nextEvent.eventId);
		await store.markEventDelivered(nextEvent.eventId, "other-sink");
		await store.markEventDelivered(event.eventId, "hosted-binding");
		await store.markEventDeliveryFailed(nextEvent.eventId, "hosted-binding", "retryable");
		expect((await store.records.get("metadata", marker)).revision).toBe(stableCut);
		await store.mutation(childId, tx => tx.delete("metadata", `semantic-binding:${childId}`));
		await expect(store.checkSemanticStart(childId, childSnapshot, principalId))
			.rejects.toMatchObject({ code: "binding_pending" });
		const proposalHash = `sha256:${"9".repeat(64)}`;
		await store.bindingPrepare({ bindingSnapshot: snapshot, phase: "preparing", operationId: "parent-move",
			proposalHash, gateRevision: 0, censusMutationRevision: 0 });
		await store.mutation(childId, async tx => {
			const child = (await tx.get<Record<string, unknown>>("identity", childId))!;
			await tx.put("identity", childId, { ...child, parent_agent_instance_ref: "grimoire://agents/broken-parent" });
		});
		const census = { agentInstanceRef: parentRef, installationId, operationId: "parent-move", proposalHash, bindingRevision: 1 };
		await expect((async () => {
			for (let page = 0; page < 20; page++) await store.bindingCensus(census, 1);
		})()).rejects.toMatchObject({ code: "binding_pending" });
	});

	it("refuses a too-wide branch atomically without imposing a device AgentInstance cap", async () => {
		const store = await createStore();
		await store.registerAgent(identity("wide"));
		await store.registerAgent(identity("sibling"));
		// Native branch control is one atomic owner batch of at most 64 agents; the root plus 64 children exceed it.
		const names = ["wide", "sibling"];
		for (let index = 0; index < 64; index++) {
			names.push(`wide-retained-${index}`);
			await store.registerAgent(identity(`wide-retained-${index}`, identity("wide").agentInstanceId));
		}
		const before = await identityRows(store, names);
		const cut = (await store.meta()).watermark;
		const error = await store.branchIntent(identity("wide").agentInstanceId, "pause-wide", "pause", 0).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toMatchObject({ code: "restore_budget" });
		expect(await identityRows(store, names)).toEqual(before);
		expect((await store.meta()).watermark).toBe(cut);
		expect((await store.records.get("hold", `${identity("wide").agentInstanceId}:pause`)).value).toBeNull();
		await store.registerAgent(identity("after-limit"));
		await store.branchIntent(identity("sibling").agentInstanceId, "pause-sibling", "pause", 0);
		expect((await store.intent(identity("sibling").agentInstanceId)).manualHold).toBe(true);
		expect((await store.intent(identity("wide").agentInstanceId)).manualHold).toBe(false);
	});
	it("rolls back a branch control over the cumulative atomic record budget instead of publishing partial holds", async () => {
		const store = await createStore();
		await store.registerAgent(identity("heavy"));
		// Within the 64-agent branch bound, but every member adds its own hold and binding reads to one batch.
		const names = ["heavy"];
		for (let index = 0; index < 30; index++) {
			names.push(`heavy-retained-${index}${"x".repeat(700)}`);
			await store.registerAgent(identity(names.at(-1)!, identity("heavy").agentInstanceId));
		}
		const cut = (await store.meta()).watermark;
		const before = await identityRows(store, names);
		const error = await store.branchIntent(identity("heavy").agentInstanceId, "pause-heavy", "pause", 0).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toMatchObject({ code: "restore_budget" });
		expect(String(error)).toContain("atomic record budget");
		expect(await identityRows(store, names)).toEqual(before);
		expect((await store.meta()).watermark).toBe(cut);
		expect((await store.records.get("hold", `${identity("heavy").agentInstanceId}:pause`)).value).toBeNull();
		expect((await store.intent(identity("heavy").agentInstanceId)).manualHold).toBe(false);
	});
	it("keeps deep internal hold and cycle checks finite while preserving usable hold continuation", async () => {
		const store = await createStore();
		// Registration walks the whole ancestry inside one atomic owner batch (at most 100 checked records): the
		// owner admits a chain through depth 21 and refuses the next level whole, instead of SQLite's 1024 ancestors.
		const deepest = 21;
		for (let index = 0; index <= deepest; index++)
			await store.registerAgent(
				identity(`chain-${index}`, index ? identity(`chain-${index - 1}`).agentInstanceId : undefined),
			);
		const leaf = identity(`chain-${deepest}`);
		const cut = (await store.meta()).watermark;
		expect(
			await store.registerAgent(identity(`chain-${deepest + 1}`, leaf.agentInstanceId)).then(
				() => null,
				(error: unknown) => error,
			),
		).toMatchObject({ code: "restore_budget" });
		expect((await store.records.get("identity", identity(`chain-${deepest + 1}`).agentInstanceId)).value).toBeNull();
		expect((await store.meta()).watermark).toBe(cut);
		expect(
			await store.registerAgent(identity("cycle-probe", identity("cycle-probe").agentInstanceId)).then(
				() => null,
				(error: unknown) => error,
			),
		).toMatchObject({ code: "invalid_request" });
		// The deepest admitted agent stays controllable and its hold page continues.
		await store.branchIntent(leaf.agentInstanceId, "leaf-pause", "pause", 0);
		await store.branchIntent(leaf.agentInstanceId, "leaf-stop", "stop", 1);
		expect((await store.intent(leaf.agentInstanceId)).holds.map(hold => hold.commandId)).toEqual([
			"leaf-pause",
			"leaf-stop",
		]);
		const request = { principalId: "owner", agentInstanceRef: leaf.agentInstanceRef, limit: 1 };
		const page = await store.runtimeHolds(request);
		expect(page.items).toMatchObject([{ commandId: "leaf-pause" }]);
		expect(page.nextCursor).not.toBeNull();
		expect((page.work as { scannedRows: number }).scannedRows).toBeLessThanOrEqual(
			runtimeLimits.bootstrapScannedRows,
		);
		const next = await store.runtimeHolds({ ...request, cursor: String(page.nextCursor) });
		expect(next.items).toMatchObject([{ commandId: "leaf-stop" }]);
		expect(next.nextCursor).toBeNull();
	});
	it("pages a deep canonical hold chain with one bounded ancestor walk per page and never trusts a changed continuation", async () => {
		const store = await createStore();
		// A root pause walks its whole branch in one atomic owner batch; nine levels keep that walk admissible.
		const depth = 8;
		const heldDepths = [0, 1, 4, 6, 7];
		for (let index = 0; index <= depth; index++)
			await store.registerAgent(
				identity(`deep-${index}`, index ? identity(`deep-${index - 1}`).agentInstanceId : undefined),
			);
		for (const held of heldDepths)
			await store.branchIntent(identity(`deep-${held}`).agentInstanceId, `hold-${held}`, "pause");
		const request = { principalId: "owner", agentInstanceRef: identity(`deep-${depth}`).agentInstanceRef, limit: 1 };
		const first = await store.runtimeHolds(request);
		expect(first.items).toEqual([
			{
				sourceAgentInstanceRef: identity(`deep-${depth - 1}`).agentInstanceRef,
				commandId: `hold-${depth - 1}`,
				generation: expect.any(Number),
				kind: "pause",
			},
		]);
		const firstCursor = String(first.nextCursor);
		let page = first;
		const commands: string[] = [];
		const rows: number[] = [];
		for (let n = 0; n < 12; n++) {
			validateRuntimeValue("holdsPage", page);
			const work = page.work as { scannedRows: number; materializedBytes: number };
			expect(work.materializedBytes).toBeGreaterThan(0);
			rows.push(work.scannedRows);
			commands.push(...(page.items as Array<{ commandId: string }>).map(item => item.commandId));
			if (page.nextCursor === null) break;
			page = await store.runtimeHolds({ ...request, cursor: String(page.nextCursor) });
		}
		expect(rows[0]).toBeLessThanOrEqual(runtimeLimits.bootstrapScannedRows);
		expect(page.nextCursor).toBeNull();
		expect(commands).toEqual(heldDepths.toReversed().map(held => `hold-${held}`));
		for (const changed of [
			{ ...request, cursor: `${firstCursor.slice(0, -1)}!` },
			{ ...request, agentInstanceRef: identity(`deep-${heldDepths[2]}`).agentInstanceRef, cursor: firstCursor },
			{ ...request, principalId: "foreign", cursor: firstCursor },
		]) {
			const rejected = await store.runtimeHolds(changed).then(
				() => undefined,
				error => error,
			);
			expect(rejected).toBeInstanceOf(Error);
		}
		await store.branchIntent(identity(`deep-${depth}`).agentInstanceId, "new-leaf-hold", "pause");
		const stale = await store.runtimeHolds({ ...request, cursor: firstCursor }).then(
			() => undefined,
			error => error,
		);
		expect(stale).toMatchObject({ code: "stale_target" });
	});

	it("pins hold pages to their exact current Attempt and resumes within one ancestor", async () => {
		const store = await createStore();
		const target = await active(store);
		const agent = identity("root");
		await store.branchIntent(agent.agentInstanceId, "hold-pause", "pause", 0);
		await store.branchIntent(agent.agentInstanceId, "hold-stop", "stop", 1);
		const request = {
			principalId: "owner",
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: target.attemptId,
			revision: 2,
			limit: 1,
		};
		const first = await store.runtimeHolds(request);
		expect(first.items).toMatchObject([{ commandId: "hold-pause", kind: "pause" }]);
		const cursor = String(first.nextCursor);
		const second = await store.runtimeHolds({ ...request, cursor });
		expect(second.items).toMatchObject([{ commandId: "hold-stop", kind: "stop" }]);
		expect(second.nextCursor).toBeNull();
		const [body, mac] = cursor.split(".");
		const position = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { scope: string[] };
		position.scope[3] = identity("foreign").agentInstanceRef;
		const forged = `${Buffer.from(JSON.stringify(position)).toString("base64url")}.${mac}`;
		const denied = await store.runtimeHolds({ ...request, cursor: forged }).then(
			() => undefined,
			error => error,
		);
		expect(denied).toMatchObject({ code: "stale_target" });
		const malformed = await store.runtimeHolds({ ...request, cursor: `h1.e30.${"界".repeat(43)}` }).then(
			() => undefined,
			error => error,
		);
		expect(malformed).toMatchObject({ code: "stale_target" });
		// A new Attempt on the same Engine generation advances its binding generation.
		const restartedAttempt = {
			...target,
			attemptId: "newer-attempt",
			executionId: "newer-execution",
			bindingGeneration: 2,
		};
		await store.commitAttemptTransition(restartedAttempt, "running", [{ kind: "running" }]);
		const stale = await store.runtimeHolds({ ...request, cursor }).then(
			() => undefined,
			error => error,
		);
		expect(stale).toMatchObject({ code: "stale_target" });
		const current = await store.runtimeHolds({ ...request, attemptId: restartedAttempt.attemptId });
		expect(current.items).toMatchObject([{ commandId: "hold-pause" }]);
	});

	it("reopens bounded active tool baselines and rejects a continuation after exact lifecycle changes", async () => {
		let store = await createStore();
		const target = await active(store);
		const agent = identity("root");
		const request = { principalId: "owner", agentInstanceRef: agent.agentInstanceRef, attemptId: target.attemptId };
		const scope: RuntimeScope = {
			kind: "attempt",
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: target.attemptId,
			kinds: ["tool"],
		};
		const before = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		const revisions: number[] = [];
		for (let i = 0; i < 20; i++) {
			const event = await store.startToolEffect(target, {
				effectId: `effect-${String(i).padStart(2, "0")}`,
				toolCallId: `tool-${String(i).padStart(2, "0")}`,
				toolName: "read",
				policy: "tracked",
				inputHash: "sha256:private-input-hash",
				...(i === 19 ? {} : { origin: { messageId: "assistant_parallel", blockId: `block_${i}` } }),
			});
			revisions.push(event.eventId);
		}
		await store.requestToolApproval(target, {
			effectId: "effect-permit",
			toolCallId: "tool-permit",
			toolName: "write",
			policy: "permit",
			inputHash: "sha256:approval",
			origin: { messageId: "assistant_permission", blockId: "block_1" },
		});
		const snapshot = await store.runtimeSnapshot(scope, request);
		const detail = snapshot.agents[0];
		const tools = detail.tools as Array<{ toolCallId: string; revision: number; phase: string }>;
		expect(tools.map(tool => tool.toolCallId)).toEqual(
			Array.from({ length: 16 }, (_, i) => `tool-${String(i).padStart(2, "0")}`),
		);
		expect(tools.map(tool => tool.revision)).toEqual(revisions.slice(0, 16));
		expect(tools.every(tool => tool.phase === "started")).toBeTrue();
		expect(tools).toMatchObject(
			Array.from({ length: 16 }, (_, i) => ({
				origin: { messageId: "assistant_parallel", blockId: `block_${i}` },
			})),
		);
		// Native work counts emitted page records (this one detail); its 16-tool bound is asserted above.
		expect(snapshot.work.changes).toBe(1);
		const cursor = String(detail.toolsNextCursor);
		const remaining = await store.runtimeTools({ ...request, cursor });
		expect(remaining).toMatchObject({
			revision: revisions.at(-1),
			nextCursor: null,
			items: [
				{ toolCallId: "tool-16", origin: { messageId: "assistant_parallel", blockId: "block_16" } },
				{ toolCallId: "tool-17" },
				{ toolCallId: "tool-18" },
				{ toolCallId: "tool-19" },
			],
		});
		expect((remaining.work as { scannedRows: number }).scannedRows).toBeLessThan(20);
		expect((remaining.items as Record<string, unknown>[]).at(-1)).not.toHaveProperty("origin");
		await store.appendEvent({
			...target,
			causationCommandId: target.commandId,
			kind: "message_updated",
			payload: {
				mode: "snapshot",
				messageId: "unselected",
				blockId: "text",
				stream: "assistant",
				contentId: "unselected-content",
				revision: 1,
				offset: 0,
				endOffset: 1,
				totalBytes: 1,
				text: "x",
				status: "streaming",
				partial: false,
			},
		});
		expect(await store.runtimeTools({ ...request, cursor })).toMatchObject({
			revision: revisions.at(-1),
			items: remaining.items,
		});
		await expect(store.runtimeTools({ ...request, principalId: "foreign", cursor })).rejects.toMatchObject({
			code: "agent_not_found",
		});
		await expect(store.runtimeTools({ ...request, attemptId: "other-attempt", cursor })).rejects.toMatchObject({
			code: "stale_target",
		});
		const rootSummary = (before.agents[0] as { revision: number }).revision;
		const catalog = await store.runtimeEvents(eventsRequest(before.epoch, before.watermark));
		expect(catalog.changes.filter(change => change.kind === "summary")).toHaveLength(1); // pending permit needs attention
		expect(catalog.changes.every(change => change.kind !== "tool")).toBeTrue();
		expect(Number(catalog.changes[0]?.revision)).toBeGreaterThan(rootSummary);
		store = reopen();
		const reopened = await store.runtimeSnapshot(scope, request);
		expect(reopened.agents[0].tools).toEqual(tools);
		expect(reopened.agents[0].toolsNextCursor).toBe(cursor);
		const settled = await store.settleToolEffect(target, "effect-19", "completed", {
			checkpoint: await nativeCheckpoint(store),
		});
		await expect(store.runtimeTools({ ...request, cursor })).rejects.toMatchObject({ code: "stale_target" });
		const terminal = await store.runtimeEvents(eventsRequest(before.epoch, settled.eventId - 1, scope));
		expect(terminal.changes).toMatchObject([
			{
				kind: "tool",
				attemptId: target.attemptId,
				revision: settled.eventId,
				value: { toolCallId: "tool-19", phase: "finished" },
			},
		]);
		await store.resolveToolApproval(target, "effect-permit", "deny");
		const live = await store.runtimeEvents(eventsRequest(before.epoch, settled.eventId, scope));
		expect(live.changes.some(change => change.kind === "tool" && change.value.phase === "denied")).toBeTrue();
		expect(
			live.changes.find(change => change.kind === "tool" && change.value.phase === "denied")?.value.origin,
		).toEqual({ messageId: "assistant_permission", blockId: "block_1" });
		await store.interruptGeneration(await store.nextEngineGeneration());
		const recovered = await store.runtimeTools(request);
		expect((recovered.items as Array<{ phase: string }>).every(tool => tool.phase === "unknown")).toBeTrue();
		expect((recovered.items as Record<string, unknown>[])[0]).toMatchObject({
			origin: { messageId: "assistant_parallel", blockId: "block_0" },
		});
		expect(
			(recovered.items as Array<{ toolCallId: string }>).some(
				tool => tool.toolCallId === "tool-19" || tool.toolCallId === "tool-permit",
			),
		).toBeFalse();
	});
	it("continues a tool snapshot only at its unchanged cut and never serves a mixed cut after settlement", async () => {
		const store = await createStore();
		const target = await active(store);
		const agent = identity("root");
		const request = { principalId: "owner", agentInstanceRef: agent.agentInstanceRef, attemptId: target.attemptId };
		await store.startToolEffect(target, {
			effectId: "effect-cut",
			toolCallId: "tool-cut",
			toolName: "read",
			policy: "tracked",
			inputHash: "sha256:cut",
		});
		const scope: RuntimeScope = {
			kind: "branch",
			rootAgentInstanceRef: agent.agentInstanceRef,
			interests: [
				{ kind: "attempt", agentInstanceRef: agent.agentInstanceRef, attemptId: target.attemptId, kinds: ["tool"] },
			],
		};
		const first = await store.runtimeSnapshot(scope, request, undefined, 1);
		expect(first.members).toHaveLength(1);
		expect(first.agents).toHaveLength(0);
		const continued = await store.runtimeSnapshot(scope, request, first.nextCursor!, 1);
		expect(continued.watermark).toBe(first.watermark);
		expect(continued.agents[0].tools).toMatchObject([{ toolCallId: "tool-cut", phase: "started" }]);
		await store.settleToolEffect(target, "effect-cut", "completed", { checkpoint: await nativeCheckpoint(store) });
		// The owner keeps current rows only: after any event the old continuation is refused, never answered from
		// another cut, and a fresh read from the start follows the settlement.
		await expect(store.runtimeSnapshot(scope, request, first.nextCursor!, 1)).rejects.toMatchObject({
			code: "stale_target",
		});
		expect((await store.runtimeTools(request)).items).toEqual([]);
		const fresh = await store.runtimeSnapshot(scope, request);
		expect(fresh.watermark).toBeGreaterThan(first.watermark);
		expect(fresh.agents[0].tools).toEqual([]);
	});
	it("preserves native Responses tool correlation through admission, settlement and reopen", async () => {
		let store = await createStore();
		const target = await active(store);
		const agentInstanceRef = identity("root").agentInstanceRef;
		const request = { principalId: "owner", agentInstanceRef, attemptId: target.attemptId };
		const scope: RuntimeScope = { kind: "attempt", agentInstanceRef, attemptId: target.attemptId, kinds: ["tool"] };
		const before = await store.runtimeSnapshot(scope, request);
		const toolCallId = `call_${"a".repeat(24)}|fc_${"b".repeat(50)}`;
		const origin = { messageId: "assistant_native", blockId: "block_2" };
		const effect = {
			effectId: "native-effect",
			origin,
			toolCallId,
			toolName: "read",
			policy: "tracked" as const,
			inputHash: "sha256:native",
		};
		const started = await store.startToolEffect(target, effect);
		expect((await store.runtimeTools(request)).items).toMatchObject([{ toolCallId, phase: "started", origin }]);
		await expect(store.runtimeTools({ ...request, principalId: "foreign" })).rejects.toMatchObject({
			code: "agent_not_found",
		});
		store = reopen();
		expect((await store.runtimeTools(request)).items).toMatchObject([{ toolCallId, phase: "started", origin }]);
		const checkpoint = await nativeCheckpoint(store);
		await expect(
			store.settleToolEffect({ ...target, attemptId: "another-attempt" }, effect.effectId, "completed", {
				checkpoint,
			}),
		).rejects.toThrow();
		expect(await store.getEffect(effect.effectId)).toMatchObject({ tool_call_id: toolCallId, state: "started" });
		await store.settleToolEffect(target, effect.effectId, "completed", { checkpoint });
		const changes = await store.runtimeEvents(eventsRequest(before.epoch, started.eventId, scope));
		expect(changes.changes.filter(change => change.kind === "tool")).toMatchObject([
			{ value: { toolCallId, phase: "finished", origin } },
		]);
		expect((await store.runtimeTools(request)).items).toEqual([]);
		store = reopen();
		expect(await store.getEffect(effect.effectId)).toMatchObject({
			tool_call_id: toolCallId,
			state: "settled",
			outcome: "completed",
			assistant_message_id: origin.messageId,
			assistant_block_id: origin.blockId,
		});
		await expect(
			store.startToolEffect(target, {
				...effect,
				effectId: "bad-origin",
				toolCallId: "bad-origin",
				origin: { ...origin, blockId: "" },
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect(await store.getEffect("bad-origin")).toBeUndefined();
		for (const [index, invalid] of [
			"call_|",
			"|fc_1",
			"call_1|fc_1|extra",
			"call_1/fc_1",
			"call_1|fc_1\n",
			"x".repeat(201),
		].entries()) {
			const effectId = `invalid-native-${index}`;
			await expect(
				store.startToolEffect(target, { ...effect, effectId, toolCallId: invalid }),
			).rejects.toMatchObject({ code: "invalid_request" });
			expect(await store.getEffect(effectId)).toBeUndefined();
		}
	});
	it("rolls back tool baseline revisions with failed effect transactions and refuses invalid tool identity before admission", async () => {
		const store = await createStore();
		const target = await active(store);
		const request = {
			principalId: "owner",
			agentInstanceRef: identity("root").agentInstanceRef,
			attemptId: target.attemptId,
		};
		const effect = {
			effectId: "effect-atomic",
			toolCallId: "tool-atomic",
			toolName: "read",
			policy: "tracked" as const,
			inputHash: "sha256:atomic",
		};
		const rejectEffect = () =>
			failCommit(store, "tool revision rollback", put => put.kind === "effect" && put.id === effect.effectId);
		const initial = await store.runtimeTools(request);
		let failure = rejectEffect();
		try {
			await expect(store.startToolEffect(target, effect)).rejects.toThrow("tool revision rollback");
		} finally {
			failure.mockRestore();
		}
		expect(await store.getEffect(effect.effectId)).toBeUndefined();
		expect(await store.runtimeTools(request)).toMatchObject({ revision: initial.revision, items: [] });
		const started = await store.startToolEffect(target, effect);
		failure = rejectEffect();
		try {
			await expect(
				store.settleToolEffect(target, effect.effectId, "completed", { checkpoint: await nativeCheckpoint(store) }),
			).rejects.toThrow("tool revision rollback");
		} finally {
			failure.mockRestore();
		}
		expect(await store.getEffect(effect.effectId)).toMatchObject({ state: "started" });
		expect(await store.runtimeTools(request)).toMatchObject({
			revision: started.eventId,
			items: [{ revision: started.eventId, phase: "started" }],
		});
		await expect(
			store.startToolEffect(target, { ...effect, effectId: "effect-invalid", toolCallId: "invalid/id" }),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect(await store.getEffect("effect-invalid")).toBeUndefined();
	});

	it("projects profile route facts through exact Attempt detail without changing app summaries", async () => {
		let store = await createStore();
		const target = await active(store);
		const agentInstanceRef = identity("root").agentInstanceRef;
		const scope: RuntimeScope = {
			kind: "attempt",
			agentInstanceRef,
			attemptId: target.attemptId,
			kinds: ["state", "usage"],
		};
		const request = { principalId: "owner", agentInstanceRef, attemptId: target.attemptId };
		const before = await store.runtimeSnapshot(scope, request);
		const summary = (await store.runtimeSummary({ principalId: "owner", agentInstanceRef })).summary;
		const profileRef = "gctx:2222222222222222",
			primaryRouteRef = "gctx:3333333333333333",
			routeRef = "gctx:4444444444444444";
		for (const phase of ["loading", "active", "exhausted"] as const) {
			const state = { profileRef, primaryRouteRef, routeRef, fallback: true, phase };
			const event = await store.commitAttemptProfileRoute(target, state);
			expect(event).toBeDefined();
			const page = await store.runtimeSnapshot(scope, request);
			expect(page.agents[0].profileRoute).toMatchObject({
				state,
				eventSeq: event!.seq,
				target: {
					agentInstanceId: target.agentInstanceId,
					attemptId: target.attemptId,
					runtimeBindingId: target.bindingId,
				},
			});
			const changes = await store.runtimeEvents(eventsRequest(before.epoch, event!.eventId - 1, scope));
			expect(changes.changes.find(change => change.kind === "state")?.value.profileRoute).toEqual(
				page.agents[0].profileRoute,
			);
			expect(
				changes.changes.some(change => change.kind === "invalidate" && change.value.resource === "context"),
			).toBeTrue();
			expect((await store.runtimeSummary({ principalId: "owner", agentInstanceRef })).summary).toEqual(summary);
		}
		await expect(store.runtimeSnapshot(scope, { ...request, principalId: "other" })).rejects.toThrow();
		store = reopen();
		expect((await store.runtimeSnapshot(scope, request)).agents[0].profileRoute).toMatchObject({
			state: { phase: "exhausted", routeRef },
		});
		const catalog = await store.runtimeEvents(eventsRequest(before.epoch, before.watermark, { kind: "catalog" }));
		expect(catalog.changes).toEqual([]);
	});

	it("publishes committed retry waits and settlements on the same Attempt and restores the settled detail after reopen", async () => {
		let store = await createStore();
		const target = await active(store);
		const agentInstanceRef = identity("root").agentInstanceRef;
		const scope: RuntimeScope = { kind: "attempt", agentInstanceRef, attemptId: target.attemptId, kinds: ["state"] };
		const request = { principalId: "owner" };
		const before = await store.runtimeSnapshot(scope, request);
		const summary = (await store.runtimeSummary({ principalId: "owner", agentInstanceRef })).summary;
		expect(before.agents[0].retry).toBeNull();
		const waiting = { attempt: 1, maxAttempts: 3, route: "provider/model", delayMs: 34074.824224, scheduledAt: 9000.125, outcome: "waiting" as const, error: "Bearer secret-value" };
		const scheduled = await store.commitAttemptRetry(target, waiting, { kind: "retry_scheduled", payload: { retry: waiting } });
		expect(scheduled).toBeDefined();
		expect(await store.getAttempt(target.attemptId)).toMatchObject({ retry_delay_ms: 34074.824224, retry_scheduled_at: 9000.125 });
		const scheduledFrame = await store.runtimeEvents(eventsRequest(before.epoch, scheduled!.eventId - 1, scope));
		expect(scheduledFrame.changes).toMatchObject([{
			kind: "state",
			agentInstanceRef,
			revision: scheduled!.eventId,
			value: {
				attemptId: target.attemptId,
				target: { executionId: target.executionId },
				retry: { attempt: 1, maxAttempts: 3, route: "provider/model", delayMs: 34075, scheduledAt: 9001, outcome: "waiting", error: expect.any(String) },
			},
		}]);
		expect(JSON.stringify(scheduledFrame)).not.toContain("secret-value");
		expect((await store.runtimeSnapshot(scope, request)).agents[0].retry).toEqual(
			scheduledFrame.changes[0].value.retry,
		);
		const settled = { attempt: 1, maxAttempts: 3, outcome: "succeeded" as const };
		const completed = await store.commitAttemptRetry(target, settled, { kind: "retry_settled", payload: { retry: settled } });
		const settledFrame = await store.runtimeEvents(eventsRequest(before.epoch, completed!.eventId - 1, scope));
		expect(settledFrame.changes).toMatchObject([{
			kind: "state",
			agentInstanceRef,
			revision: completed!.eventId,
			value: {
				attemptId: target.attemptId,
				target: { executionId: target.executionId },
				retry: { attempt: 1, maxAttempts: 3, route: "provider/model", delayMs: 34075, scheduledAt: 9001, outcome: "succeeded" },
			},
		}]);
		expect((await store.runtimeSummary({ principalId: "owner", agentInstanceRef })).summary).toEqual(summary);
		store = reopen();
		expect((await store.runtimeSnapshot(scope, request)).agents[0].retry).toEqual(settledFrame.changes[0].value.retry);
	});

	it("settles a waiting retry in the recovery frame and does not carry it into a replacement Attempt", async () => {
		let store = await createStore();
		const target = await active(store);
		const agentInstanceRef = identity("root").agentInstanceRef;
		const request = { principalId: "owner" };
		const scope: RuntimeScope = { kind: "attempt", agentInstanceRef, attemptId: target.attemptId, kinds: ["state"] };
		await store.commitAttemptRetry(target, { attempt: 2, maxAttempts: 3, outcome: "waiting", scheduledAt: 9000 }, { kind: "retry_scheduled" });
		const generation = await store.nextEngineGeneration();
		const interrupted = (await store.interruptGeneration(generation)).find(event => event.kind === "interrupted");
		expect(interrupted).toBeDefined();
		const recoveryFrame = await store.runtimeEvents(eventsRequest((await store.runtimeSnapshot(scope, request)).epoch, interrupted!.eventId - 1, scope));
		expect(recoveryFrame.changes.find(change => change.kind === "state")?.value).toMatchObject({
			state: "interrupted",
			retry: { attempt: 2, maxAttempts: 3, outcome: "interrupted" },
		});
		store = reopen();
		expect((await store.runtimeSnapshot(scope, request)).agents[0].retry).toMatchObject({
			attempt: 2, outcome: "interrupted",
		});
		expect(await store.commitAttemptRetry(target, { attempt: 3, maxAttempts: 3, outcome: "waiting" }, { kind: "retry_scheduled" })).toBeUndefined();
		const next = { ...target, attemptId: "next-attempt", executionId: "next-execution", commandId: "next-command", bindingGeneration: 2, engineGeneration: generation };
		await store.commitAttemptTransition(next, "running", [{ kind: "running" }]);
		const current = await store.runtimeSnapshot({ ...scope, attemptId: next.attemptId }, request);
		expect(current.agents[0]).toMatchObject({ attemptId: next.attemptId, retry: null });
		expect((await store.runtimeSnapshot(scope, request)).agents[0].retry).toMatchObject({ outcome: "interrupted" });
	});

	it("emits exact usage and context invalidations after model settlement without token or app churn", async () => {
		const store = await createStore();
		const target = await active(store);
		const agent = identity("root");
		const scope: RuntimeScope = {
			kind: "attempt",
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: target.attemptId,
			kinds: ["usage"],
		};
		const before = await store.runtimeSnapshot(scope, { principalId: "owner" });
		const effect = { effectId: "model-usage", modelCallId: "model-call", inputHash: "sha256:private" };
		await store.startModelEffect(target, effect);
		const settled = await store.settleModelEffect(
			target,
			effect,
			"completed",
			undefined,
			await nativeCheckpoint(store),
		);
		const batch = await store.runtimeEvents(eventsRequest(before.epoch, before.watermark, scope));
		expect(batch.changes).toMatchObject([
			{
				kind: "invalidate",
				attemptId: target.attemptId,
				revision: settled.eventId,
				value: { resource: "usage", revision: settled.eventId },
			},
			{
				kind: "invalidate",
				attemptId: target.attemptId,
				revision: settled.eventId,
				value: { resource: "context", revision: settled.eventId },
			},
		]);
		expect((await store.runtimeEvents(eventsRequest(before.epoch, before.watermark))).changes).toEqual([]);
		expect(JSON.stringify(batch)).not.toContain("sha256:private");
	});
	it("settles active message status atomically with recovery without changing the retained resource", async () => {
		const store = await createStore();
		const target = await active(store);
		const request = {
			agentInstanceRef: identity("root").agentInstanceRef,
			attemptId: target.attemptId,
			principalId: "owner",
		};
		await store.appendEvent({
			...target,
			causationCommandId: target.commandId,
			kind: "message_updated",
			payload: {
				mode: "snapshot",
				messageId: "active-message",
				blockId: "text",
				stream: "assistant",
				contentId: "active-content",
				revision: 1,
				offset: 0,
				endOffset: 5,
				totalBytes: 5,
				text: "hello",
				status: "streaming",
				partial: false,
			},
		});
		const before = await store.runtimeMessages(request);
		const failure = failCommit(
			store,
			"recovery rollback",
			put => put.kind === "event" && (put.value as { kind?: string }).kind === "interrupted",
		);
		try {
			await expect(store.interruptGeneration(await store.nextEngineGeneration())).rejects.toThrow(
				"recovery rollback",
			);
		} finally {
			failure.mockRestore();
		}
		expect((await store.runtimeMessages(request)).items).toEqual(before.items);
		expect((await store.getAttempt(target.attemptId))?.state).toBe("running");
		const events = await store.interruptGeneration(2);
		expect(events.map(event => event.kind)).toContain("message_updated");
		const after = await store.runtimeMessages(request);
		expect(after.items).toMatchObject([{ revision: 2, status: "interrupted", text: "hello", totalBytes: 5 }]);
		await store.interruptGeneration(await store.nextEngineGeneration());
		expect((await store.runtimeMessages(request)).items).toEqual(after.items);
	});
	it("pins canonical schema bytes and validates the strict scope union", async () => {
		const bytes = await Bun.file(new URL("../src/engine/runtime-protocol-v1.json", import.meta.url)).arrayBuffer();
		expect(`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`).toBe(RUNTIME_PROTOCOL_HASH);
		validateRuntimeValue("scope", { kind: "catalog" });
		expect(() =>
			validateRuntimeValue("scope", { kind: "catalog", agentInstanceRef: identity("root").agentInstanceRef }),
		).toThrow();
	});
	it("rejects unknown ancestry, cross-principal children and reparenting an already projected root", async () => {
		const store = await createStore();
		await expect(store.registerAgent(identity("orphan", "unknown-parent"))).rejects.toThrow("Parent ancestry");
		const parent = identity("parent");
		await store.registerAgent(parent);
		await expect(store.registerAgent(identity("foreign-child", parent.agentInstanceId, "other"))).rejects.toThrow(
			"ownership",
		);
		const root = identity("registered-root");
		await store.registerAgent(root);
		// Native refuses the same reparent before comparing fields: a projected root keeps its ancestry.
		await expect(store.registerAgent({ ...root, parentAgentInstanceId: parent.agentInstanceId })).rejects.toThrow(
			"cannot be reparented",
		);
		const snapshot = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		expect(snapshot.agents).toHaveLength(2);
		expect(snapshot.agents.find(agent => agent.agentInstanceRef === root.agentInstanceRef)).toMatchObject({
			rootAgentInstanceRef: root.agentInstanceRef,
		});
	});
	it("captures a no-gap watermark and discovers newly enrolled children", async () => {
		const store = await createStore();
		const root = identity("root");
		await store.registerAgent(root);
		const snapshot = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		expect(snapshot.agents).toHaveLength(1);
		const waiting = store.waitRuntimeEvents(
			eventsRequest(snapshot.epoch, snapshot.watermark, { kind: "catalog" }, 1000),
		);
		await store.registerAgent(identity("child", root.agentInstanceId));
		const batch = await waiting;
		expect(batch.changes).toHaveLength(1);
		expect(batch.changes[0].kind).toBe("summary");
		expect(batch.changes[0].agentInstanceRef).toBe(identity("child").agentInstanceRef);
		expect(batch.throughCursor).toBeGreaterThan(snapshot.watermark);
		expect(batch.hasMore).toBe(false);
	});
	it("advances filtered cursors through a factual cut without leaking another principal", async () => {
		const store = await createStore();
		await store.registerAgent(identity("root"));
		const snapshot = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		await store.registerAgent(identity("private", undefined, "other"));
		const batch = await store.runtimeEvents(eventsRequest(snapshot.epoch, snapshot.watermark));
		expect(batch.changes).toEqual([]);
		expect(batch.throughCursor).toBeGreaterThan(snapshot.watermark);
		expect((await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).agents).toHaveLength(1);
		await expect(store.runtimeEvents(eventsRequest("old-epoch", 0))).rejects.toThrow("epoch");
	});
	it("preserves a local child hold when its ancestor resumes and rejects stale controls", async () => {
		const store = await createStore();
		const root = identity("root"),
			child = identity("child", root.agentInstanceId);
		await store.registerAgent(root);
		await store.registerAgent(child);
		await store.branchIntent(root.agentInstanceId, "pause-root", "pause", 0);
		await store.branchIntent(child.agentInstanceId, "pause-child", "pause", 1);
		await store.branchIntent(root.agentInstanceId, "resume-root", "resume", 1);
		expect((await store.intent(root.agentInstanceId)).manualHold).toBe(false);
		const remaining = await store.intent(child.agentInstanceId);
		expect(remaining.holds.map(hold => hold.commandId)).toEqual(["pause-child"]);
		await expect(store.branchIntent(root.agentInstanceId, "stale-stop", "stop", 1)).rejects.toThrow("revision");
	});
	it("enrolls children into an existing hold before admitting any effect", async () => {
		const store = await createStore();
		const root = identity("root");
		await store.registerAgent(root);
		await store.branchIntent(root.agentInstanceId, "pause-root", "pause", 0);
		const child = identity("child", root.agentInstanceId);
		await store.registerAgent(child);
		expect((await store.intent(child.agentInstanceId)).holds[0]?.sourceAgentInstanceId).toBe(root.agentInstanceId);
		await expect(
			store.startModelEffect(binding("child"), {
				effectId: "effect-child",
				modelCallId: "model-child",
				inputHash: "hash",
			}),
		).rejects.toThrow("held");
		expect((await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).agents).toHaveLength(2);
	});
	it("keeps receipts indefinitely and never replays an interrupted admission", async () => {
		const store = await createStore();
		const original = command("pending");
		await store.admitCommand(original, 1);
		await store.interruptGeneration(await store.nextEngineGeneration());
		const replay = await store.admitCommand(original, 2);
		expect(replay.status).toBe("replay");
		if (replay.status === "replay") expect(replay.receipt.detail?.code).toBe("interrupted");
		const receipt = await store.runtimeCommand(
			original.commandId,
			{ principalId: "owner" },
			original.browserPayloadHash,
		);
		expect(receipt.stage).toBe("rejected");
		expect(receipt.retention).toBe("indefinite");
		await expect(store.admitCommand({ ...original, canonicalHash: "different" }, 2)).rejects.toThrow("different");
		expect((await store.runtimeCommand("missing", { principalId: "owner" })).lookup).toBe("outcome_unknown");
	});
	it("cancels an exact Start before ordinary delivery and preserves its fence across reopen", async () => {
		let store = await createStore();
		const start = {
			...command("start-late"),
			serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
		};
		await store.registerAgent(identity("root"));
		const target = {
			...identity("root"),
			executionId: start.executionId!,
			attemptId: start.attemptId!,
			engineGeneration: 1,
			pendingStartCommandId: start.commandId,
			expectedStartIntentRevision: 0,
			expectedIntentRevision: 0,
		};
		expect(await store.cancelPendingStart(target, "stop-first")).toMatchObject({
			status: "cancelled",
			intentRevision: 1,
		});
		store = reopen();
		expect(await store.admitCommand(start, 1)).toMatchObject({
			status: "replay",
			receipt: { outcome: "rejected", detail: { code: "cancelled", cancellationCommandId: "stop-first" } },
		});
		expect(await store.getAttempt(start.attemptId!)).toBeUndefined();
		expect((await store.intent(target.agentInstanceId)).manualHold).toBe(true);
		await expect(store.admitCommand({ ...start, canonicalHash: "changed", attemptId: "other" }, 1)).rejects.toThrow();
	});
	it("pins a pending cancellation to the source principal and immutable Start CAS", async () => {
		const store = await createStore();
		const start = {
			...command("pending-exact"),
			serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
		};
		await store.admitCommand(start, 1);
		const target = {
			...identity("root"),
			executionId: start.executionId!,
			attemptId: start.attemptId!,
			engineGeneration: 1,
			pendingStartCommandId: start.commandId,
			expectedStartIntentRevision: 0,
			expectedIntentRevision: 0,
		};
		await expect(store.cancelPendingStart({ ...target, principalId: "foreign" }, "foreign-stop")).rejects.toThrow(
			"immutable target",
		);
		await expect(
			store.cancelPendingStart({ ...target, expectedStartIntentRevision: 1 }, "wrong-cas"),
		).rejects.toThrow("immutable target");
		expect((await store.intent(target.agentInstanceId)).intentRevision).toBe(0);
		expect(await store.cancelPendingStart(target, "exact-stop")).toMatchObject({ status: "cancelled" });
	});
	it("uses the factual applied Start revision and rejects an intervening intent mutation", async () => {
		const store = await createStore();
		const target = binding("root");
		const start = {
			...command(target.commandId),
			attemptId: target.attemptId,
			executionId: target.executionId,
			serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
		};
		await store.admitCommand(start, 1);
		await store.commitAttemptTransition({ ...target, intentRevision: 7 }, "running", [{ kind: "running" }], {
			startIntent: { expectedRevision: 0 },
			settleCommandId: start.commandId,
			settleCommandReceipt: { outcome: "applied" },
		});
		const fence = {
			...target,
			principalId: "owner",
			pendingStartCommandId: start.commandId,
			expectedStartIntentRevision: 0,
			expectedIntentRevision: 0,
		};
		expect(await store.branchIntent(target.agentInstanceId, "stop-after-bind", "stop", 0, fence)).toMatchObject({
			intentRevision: 8,
		});
		await expect(store.branchIntent(target.agentInstanceId, "delayed-old-stop", "stop", 0, fence)).rejects.toThrow(
			"Intent changed",
		);
	});
});
