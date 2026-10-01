import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EngineEvent } from "../src/engine/contracts";
import { RocksEngineStore } from "../src/engine/rocks-runtime-store";
import { readStorageBinding, StorageClient } from "../src/session/storage-client";
import { startStorageWorker } from "./helpers/storage-worker-fixture";
import {
	admittedExecutionFixture, admittedFixtureStart, binding as nativeBinding,
	command as fixtureCommand, identity as fixtureIdentity,
} from "./helpers/runtime-v1-rocks-fixture";

const workerExecutable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
const testRunRoot = process.env.ARTEL_STORAGE_TEST_RUN_ROOT;

// Supplied only by an isolated real Rust worker fixture; never production state.
it.skipIf(!process.env.ARTEL_STORAGE_TEST_BINDING && !(workerExecutable && testRunRoot))(
	"commits replay, native dependencies, terminal guards and bounded recovery on the real owner",
	async () => {
		const root =
			workerExecutable && testRunRoot ? await fs.mkdtemp(path.join(testRunRoot, "runtime-store-")) : undefined;
		if (root) console.log(`Runtime store fixture: ${root}`);
		const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
		const worker = root && workerExecutable ? await startStorageWorker(workerExecutable, root, token, 1) : undefined;
		try {
			const client =
				worker?.client ?? new StorageClient(readStorageBinding(process.env.ARTEL_STORAGE_TEST_BINDING)!);
			const store = new RocksEngineStore(client);
			const generation = await store.nextEngineGeneration();
			const suffix = crypto.randomUUID();
			const agent = fixtureIdentity(suffix, undefined, "fixture-owner");
			const execution = admittedExecutionFixture();
			const binding = await admittedFixtureStart(
				store, { ...nativeBinding(suffix), engineGeneration: generation },
				agent.agentInstanceRef, agent.principalId, execution, "fixture-device",
			);
			const command = await store.getStartConversationIdentity(binding.commandId);
			if (!command) throw new Error("Admitted fixture lost its original Start");
			expect(await store.chatIdentityId(command.agentInstanceRef!, command.principalId!)).toBe(
				command.agentInstanceId,
			);
			await expect(store.chatIdentityId(command.agentInstanceRef!, "other-owner")).rejects.toThrow();
			await expect(
				store.chatIdentityId(`${command.agentInstanceRef}-other`, command.principalId!),
			).rejects.toThrow();
			await expect(store.admitCommand({ ...command, canonicalHash: "changed" }, generation)).rejects.toThrow();
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
			const effect = { source: "primary" as const, effectId: `effect-${suffix}`, modelCallId: "call-1", inputHash: "input" };
			await store.startModelEffect(binding, effect, checkpoint);
			await expect(
				store.commitAttemptTransition({ ...binding, state: "idle" }, "completed", [{ kind: "completed" }]),
			).rejects.toThrow();
			expect((await store.getAttempt(binding.attemptId))?.state).toBe("running");
			const frozen = { executionDigest: `sha256:${"d".repeat(64)}`, routeRef: "gctx:route", accountRef: "gctx:account" };
			// Ordinals are dense and durable before send; only planned requests settle, once.
			await expect(store.registerModelRequest(binding, effect.effectId, { ordinal: 2, ...frozen })).rejects.toThrow();
			await store.registerModelRequest(binding, effect.effectId, { ordinal: 1, ...frozen });
			await store.settleModelRequest(binding, effect.effectId, 1, "not_sent", null);
			await expect(store.settleModelRequest(binding, effect.effectId, 1, "responded", 200)).rejects.toThrow();
			await store.registerModelRequest(binding, effect.effectId, { ordinal: 2, ...frozen });
			await store.settleModelRequest(binding, effect.effectId, 2, "responded", 200);
			const tokens = { input: 12, output: null, cacheRead: null, cacheWrite: null, reasoning: null };
			const settledModel = await store.settleModelEffect(binding, effect, "completed", undefined, checkpoint, {
				providerResponseId: "resp-1",
				tokens,
				cost: { status: "unknown", reason: "tokens_incomplete" },
			});
			expect(settledModel.payload).toMatchObject({
				requestTracking: "v1",
				requests: [
					{ ordinal: 1, state: "not_sent", statusCode: null },
					{ ordinal: 2, state: "responded", statusCode: 200 },
				],
				usage: { ordinal: 2, providerResponseId: "resp-1", tokens },
			});
			await store.commitAttemptTransition({ ...binding, state: "idle" }, "completed", [{ kind: "completed" }], {
				transcriptCheckpoint: checkpoint,
			});
			expect((await store.getAttempt(binding.attemptId))?.transcript_native?.throughSeq).toBe(1);
			const inboxTarget = { ...binding, sessionId: familyId };
			const queued = await store.enqueueInboxItem(inboxTarget, {
				sourceEventId: `inbox-${suffix}`,
				sourceType: "user",
				body: "hé",
				createdAt: 1,
			});
			const budgetId = `budget:ordinary:${binding.agentInstanceId}`;
			expect((await store.records.get("metadata", budgetId)).value).toMatchObject({
				count: 1,
				bytes: Buffer.byteLength("hé"),
			});
			await expect(
				store.enqueueInboxItem(inboxTarget, {
					sourceEventId: `inbox-${suffix}`,
					sourceType: "user",
					body: "hé",
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
			const recoveryIdentity = fixtureIdentity(`recovery-${suffix}`, undefined, agent.principalId);
			const recoveryAgent = recoveryIdentity.agentInstanceId;
			const active = await admittedFixtureStart(
				store, { ...nativeBinding(`recovery-${suffix}`), engineGeneration: generation },
				recoveryIdentity.agentInstanceRef, recoveryIdentity.principalId, execution, "fixture-device",
			);
			for (let index = 0; index < 105; index++)
				await store.admitCommand(fixtureCommand(`pending-${suffix}-${index}`, "steer", {
					agent: recoveryIdentity, target: active, generation,
				}), generation);
			const recoveryToolEffect = {
				effectId: `a-open-tool-${suffix}`,
				toolCallId: "tool-call-1",
				toolName: "fixture-tool",
				policy: "tracked" as const,
				inputHash: "tool-input",
				origin: { messageId: "assistant-message-1", blockId: "assistant-block-1" },
			};
			const recoveryModelEffect = { ...effect, effectId: `z-open-model-${suffix}` };
			const unsentModelEffect = { ...effect, effectId: `z-unsent-model-${suffix}`, modelCallId: "call-2" };
			await store.startToolEffect(active, recoveryToolEffect, checkpoint);
			await store.startModelEffect(active, recoveryModelEffect, checkpoint);
			await store.startModelEffect(active, unsentModelEffect, checkpoint);
			await store.registerModelRequest(active, recoveryModelEffect.effectId, { ordinal: 1, ...frozen });
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
				// Registered but never settled: the crash leaves its fate unknown, with no zero usage.
				requestTracking: "v1",
				requests: [{ ordinal: 1, ...frozen, state: "send_unknown", statusCode: null }],
				usage: null,
			});
			// Tracking initialized with the effect proves that no request was registered, so none is invented.
			expect(
				recoveryEvents.find(
					event => event.kind === "model_settled" && event.payload?.effectId === unsentModelEffect.effectId,
				)?.payload,
			).toMatchObject({ requestTracking: "v1", requests: [], usage: null, status: "unknown" });
			expect(
				(await store.records.get("metadata", `effects:${active.attemptId}:${active.bindingId}`)).value,
			).toMatchObject({ count: 0 });
			expect((await store.records.query("command_agent_pending", [recoveryAgent])).records).toHaveLength(0);
			expect((await store.intent(recoveryAgent)).holds.map(hold => hold.kind)).toEqual(
				expect.arrayContaining(["pause", "recovery"]),
			);
			expect(notifications).toBeGreaterThan(0);
			const cancelled = fixtureCommand(`cancel-before-start-${suffix}`, "start", {
				agent: fixtureIdentity(`cancel-${suffix}`, undefined, agent.principalId),
				generation: nextGeneration,
			});
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
		} finally {
			await worker?.stop();
		}
	},
	60_000,
);
