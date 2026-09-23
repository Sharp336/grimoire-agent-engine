import { expect, it } from "bun:test";
import type { EngineBindingSnapshot, EngineEvent } from "../src/engine/contracts";
import { RocksEngineStore } from "../src/engine/rocks-runtime-store";
import type { EngineCommandIdentity } from "../src/engine/store";
import { readStorageBinding, StorageClient } from "../src/session/storage-client";

// Supplied only by an isolated real Rust worker fixture; never production state.
it.skipIf(!process.env.ARTEL_STORAGE_TEST_BINDING)(
	"commits replay, native dependencies, terminal guards and bounded recovery on the real owner",
	async () => {
		const client = new StorageClient(readStorageBinding(process.env.ARTEL_STORAGE_TEST_BINDING)!);
		const store = new RocksEngineStore(client);
		const generation = await store.nextEngineGeneration();
		const suffix = crypto.randomUUID();
		const command: EngineCommandIdentity = {
			commandId: `command-${suffix}`,
			operation: "start",
			deviceId: "fixture-device",
			engineId: "fixture-engine",
			engineGeneration: generation,
			agentInstanceId: `agent-${suffix}`,
			agentInstanceRef: `grimoire://tasks/grimoire/runtime-fixture/agents/${suffix}`,
			executionId: `execution-${suffix}`,
			attemptId: `attempt-${suffix}`,
			authorityGeneration: 1,
			principalId: "fixture-owner",
			payloadHash: "payload",
			canonicalHash: "canonical",
			serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
		};
		expect(await store.admitCommand(command, generation)).toEqual({ status: "claimed" });
		expect(await store.chatIdentityId(command.agentInstanceRef!, command.principalId!)).toBe(command.agentInstanceId);
		await expect(store.chatIdentityId(command.agentInstanceRef!, "other-owner")).rejects.toThrow();
		await expect(store.chatIdentityId(`${command.agentInstanceRef}-other`, command.principalId!)).rejects.toThrow();
		expect(await store.admitCommand(command, generation)).toEqual({ status: "in_progress" });
		await expect(store.admitCommand({ ...command, canonicalHash: "changed" }, generation)).rejects.toThrow();
		const binding: EngineBindingSnapshot = {
			commandId: command.commandId,
			agentInstanceId: command.agentInstanceId,
			executionId: command.executionId!,
			attemptId: command.attemptId!,
			bindingId: `binding-${suffix}`,
			engineAgentId: `native-${suffix}`,
			profileDigest: "fixture-profile",
			state: "running",
			engineGeneration: generation,
			bindingGeneration: 1,
			authorityGeneration: 1,
		};
		await store.commitAttemptTransition(binding, "running", [{ kind: "running" }], {
			requireNew: true,
			settleCommandId: command.commandId,
		});
		expect(await store.admitCommand(command, generation)).toEqual({
			status: "replay",
			receipt: { outcome: "applied" },
		});
		await expect(store.putBinding({ ...binding, bindingId: "stale-binding" })).rejects.toThrow();
		expect((await store.getBinding(command.agentInstanceId))?.bindingId).toBe(binding.bindingId);
		const familyId = `native-${suffix}`;
		await client.write({
			operationId: `native-write-${suffix}`,
			familyId,
			generationId: "main",
			firstSeq: 1,
			entries: [
				{
					entryId: "result",
					parentId: null,
					kind: "message",
					payload: { role: "assistant", content: "durable result" },
				},
			],
			durability: "required",
			dependencies: [],
		});
		const checkpoint = {
			sessionId: familyId,
			sessionPath: `native://${familyId}/main`,
			leafEntryId: "result",
			byteBoundary: 0,
			native: { familyId, generationId: "main", throughSeq: 1, incarnation: client.incarnation },
		};
		const effect = { effectId: `effect-${suffix}`, modelCallId: "call-1", inputHash: "input" };
		await store.startModelEffect(binding, effect, checkpoint);
		await expect(
			store.commitAttemptTransition({ ...binding, state: "idle" }, "completed", [{ kind: "completed" }]),
		).rejects.toThrow();
		expect((await store.getAttempt(binding.attemptId))?.state).toBe("running");
		await store.settleModelEffect(binding, effect, "completed", undefined, checkpoint);
		await store.commitAttemptTransition({ ...binding, state: "idle" }, "completed", [{ kind: "completed" }], {
			transcriptCheckpoint: checkpoint,
		});
		expect((await store.getAttempt(binding.attemptId))?.transcript_native?.throughSeq).toBe(1);
		const attachments = { principalId: "fixture-owner", uploadIds: ["upload-one"] };
		const inboxTarget = { ...binding, sessionId: familyId };
		const queued = await store.enqueueInboxItem(inboxTarget, {
			sourceEventId: `inbox-${suffix}`,
			sourceType: "user",
			body: "hé",
			attachments,
			createdAt: 1,
		});
		const budgetId = `budget:ordinary:${binding.agentInstanceId}`;
		expect((await store.records.get("metadata", budgetId)).value).toMatchObject({
			count: 1,
			bytes: Buffer.byteLength("hé") + Buffer.byteLength(JSON.stringify(attachments)),
		});
		await expect(
			store.enqueueInboxItem(inboxTarget, {
				sourceEventId: `inbox-${suffix}`,
				sourceType: "user",
				body: "hé",
				attachments,
				createdAt: 2,
			}),
		).rejects.toThrow();
		await store.mutateInboxItem(inboxTarget, {
			mutationId: "drop-one",
			queueId: queued.item.queueId,
			expectedRevision: queued.item.revision,
			op: "drop",
		});
		await store.mutateInboxItem(inboxTarget, {
			mutationId: "drop-replay",
			queueId: queued.item.queueId,
			expectedRevision: queued.item.revision,
			op: "drop",
		});
		expect((await store.records.get("metadata", budgetId)).value).toMatchObject({ count: 0, bytes: 0 });

		// More than a single 100-record CAS/query budget must remain recoverable.
		const recoveryAgent = `recovery-${suffix}`;
		for (let index = 0; index < 105; index++)
			await store.admitCommand(
				{
					...command,
					commandId: `pending-${suffix}-${index}`,
					agentInstanceId: recoveryAgent,
					agentInstanceRef: `grimoire://tasks/grimoire/runtime-fixture/agents/${recoveryAgent}`,
					operation: "steer",
					canonicalHash: `pending-${index}`,
					executionId: `recover-execution-${suffix}`,
					attemptId: `recover-attempt-${suffix}`,
				},
				generation,
			);
		const active = {
			...binding,
			agentInstanceId: recoveryAgent,
			commandId: `pending-${suffix}-0`,
			executionId: `recover-execution-${suffix}`,
			attemptId: `recover-attempt-${suffix}`,
			bindingId: `recover-binding-${suffix}`,
		};
		await store.commitAttemptTransition(active, "running", [{ kind: "running" }], { requireNew: true });
		const recoveryToolEffect = {
			effectId: `a-open-tool-${suffix}`,
			toolCallId: "tool-call-1",
			toolName: "fixture-tool",
			policy: "tracked" as const,
			inputHash: "tool-input",
			origin: { messageId: "assistant-message-1", blockId: "assistant-block-1" },
		};
		const recoveryModelEffect = { ...effect, effectId: `z-open-model-${suffix}` };
		await store.startToolEffect(active, recoveryToolEffect, checkpoint);
		await store.startModelEffect(active, recoveryModelEffect, checkpoint);
		await store.branchIntent(recoveryAgent, `pause-${suffix}`, "pause", 0);
		const nextGeneration = await store.nextEngineGeneration();
		let notifications = 0;
		const recoveryEvents: EngineEvent[] = [];
		await store.interruptGeneration(nextGeneration, events => {
			notifications += events.length;
			recoveryEvents.push(...events);
		});
		expect((await store.getAttempt(active.attemptId))?.state).toBe("interrupted");
		expect((await store.getEffect(recoveryToolEffect.effectId))?.outcome).toBe("unknown");
		expect((await store.getEffect(recoveryModelEffect.effectId))?.outcome).toBe("unknown");
		expect(
			recoveryEvents.find(
				event => event.kind === "tool_settled" && event.payload?.invocationId === recoveryToolEffect.effectId,
			)?.payload,
		).toMatchObject({
			invocationId: recoveryToolEffect.effectId,
			toolCallId: recoveryToolEffect.toolCallId,
			toolName: recoveryToolEffect.toolName,
			policy: recoveryToolEffect.policy,
			inputHash: recoveryToolEffect.inputHash,
			origin: recoveryToolEffect.origin,
			status: "unknown",
			error: "engine_lost",
		});
		expect(
			recoveryEvents.find(
				event => event.kind === "model_settled" && event.payload?.effectId === recoveryModelEffect.effectId,
			)?.payload,
		).toMatchObject({
			effectId: recoveryModelEffect.effectId,
			modelCallId: recoveryModelEffect.modelCallId,
			status: "unknown",
			error: "engine_lost",
		});
		expect(
			(await store.records.get("metadata", `effects:${active.attemptId}:${active.bindingId}`)).value,
		).toMatchObject({ count: 0 });
		expect((await store.records.query("command_agent_pending", [recoveryAgent])).records).toHaveLength(0);
		expect((await store.intent(recoveryAgent)).holds.map(hold => hold.kind)).toEqual(
			expect.arrayContaining(["pause", "recovery"]),
		);
		expect(notifications).toBeGreaterThan(0);
		const cancelled = {
			...command,
			commandId: `cancel-before-start-${suffix}`,
			agentInstanceId: `cancel-agent-${suffix}`,
			agentInstanceRef: `grimoire://tasks/grimoire/runtime-fixture/agents/cancel-${suffix}`,
			engineGeneration: nextGeneration,
		};
		await store.registerAgent(cancelled);
		const cancellation = await store.cancelPendingStart(
			{
				agentInstanceId: cancelled.agentInstanceId,
				executionId: cancelled.executionId!,
				attemptId: cancelled.attemptId!,
				authorityGeneration: 1,
				engineGeneration: nextGeneration,
				principalId: cancelled.principalId,
				pendingStartCommandId: cancelled.commandId,
				expectedStartIntentRevision: 0,
				expectedIntentRevision: 0,
			},
			"cancel-exact-start",
		);
		expect(cancellation.status).toBe("cancelled");
		const replay = await store.admitCommand(cancelled, nextGeneration);
		expect(replay.status).toBe("replay");
		if (replay.status === "replay") expect(replay.receipt.detail?.code).toBe("cancelled");
		await store.close();
	},
	60_000,
);
