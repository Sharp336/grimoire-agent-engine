import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EngineBindingSnapshot } from "../src/engine/contracts";
import { RocksEngineStore } from "../src/engine/rocks-runtime-store";
import type { EngineCommandIdentity } from "../src/engine/store";
import { readStorageBinding, StorageClient } from "../src/session/storage-client";
import { startStorageWorker } from "./helpers/storage-worker-fixture";

const workerExecutable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
const testRunRoot = process.env.ARTEL_STORAGE_TEST_RUN_ROOT;

it.skipIf(!process.env.ARTEL_STORAGE_TEST_BINDING && !(workerExecutable && testRunRoot))(
	"deleting a chat reclaims every native generation after an interrupted page",
	async () => {
		const root =
			workerExecutable && testRunRoot ? await fs.mkdtemp(path.join(testRunRoot, "generation-delete-")) : undefined;
		if (root) console.log(`Native generation delete fixture: ${root}`);
		const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
		let worker = root && workerExecutable ? await startStorageWorker(workerExecutable, root, token, 1) : undefined;
		let client = worker?.client ?? new StorageClient(readStorageBinding(process.env.ARTEL_STORAGE_TEST_BINDING)!);
		try {
			const store = new RocksEngineStore(client);
			const generation = await store.nextEngineGeneration();
			const suffix = crypto.randomUUID();
			const agentInstanceId = `delete-${suffix}`;
			const familyId = `family-${suffix}`;
			const principalId = `owner-${suffix}`;
			const command: EngineCommandIdentity = {
				commandId: `start-${suffix}`,
				operation: "start",
				deviceId: "delete-fixture-device",
				engineId: "delete-fixture-engine",
				engineGeneration: generation,
				agentInstanceId,
				agentInstanceRef: `grimoire://tasks/grimoire/native-delete-fixture/agents/${suffix}`,
				executionId: `execution-${suffix}`,
				attemptId: `attempt-old-${suffix}`,
				authorityGeneration: 1,
				principalId,
				payloadHash: "payload",
				canonicalHash: "canonical",
				serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
			};
			expect(await store.admitCommand(command, generation)).toEqual({ status: "claimed" });
			const generations = Array.from({ length: 25 }, (_, index) => `generation-${index}`);
			for (const [index, nativeGeneration] of generations.entries()) {
				await client.write({
					operationId: `write-${suffix}-${nativeGeneration}`,
					familyId,
					generationId: nativeGeneration,
					firstSeq: 1,
					entries: [
						{
							entryId: `entry-${index}`,
							parentId: null,
							kind: "message",
							payload: { type: "message", message: { role: "assistant", content: `answer ${index}` } },
						},
					],
					durability: "required",
					dependencies: [],
				});
				const binding: EngineBindingSnapshot = {
					commandId: index === 0 ? command.commandId : `next-${suffix}`,
					agentInstanceId,
					executionId: `execution-${suffix}`,
					attemptId: `attempt-${nativeGeneration}-${suffix}`,
					bindingId: `binding-${nativeGeneration}-${suffix}`,
					engineAgentId: familyId,
					profileDigest: "delete-fixture-profile",
					state: "running",
					sessionFile: `native:${familyId}/${nativeGeneration}`,
					engineGeneration: generation,
					bindingGeneration: index + 1,
					authorityGeneration: 1,
				};
				await store.commitAttemptTransition(binding, "running", [], {
					requireNew: true,
					...(index === 0 ? { settleCommandId: command.commandId } : {}),
				});
				const checkpoint = {
					sessionId: familyId,
					sessionPath: binding.sessionFile!,
					leafEntryId: `entry-${index}`,
					byteBoundary: 0,
					native: { familyId, generationId: nativeGeneration, throughSeq: 1, incarnation: client.incarnation },
				};
				await store.commitAttemptTransition({ ...binding, state: "idle" }, "completed", [], {
					transcriptCheckpoint: checkpoint,
				});
			}
			const operationId = `delete-op-${suffix}`;
			const originalQuery = store.records.query.bind(store.records);
			let attemptPages = 0;
			store.records.query = (...args) => {
				if (args[0] === "attempt_agent" && ++attemptPages === 2)
					throw new Error("simulated Engine interruption after persisted delete page");
				return originalQuery(...args);
			};
			await expect(store.chatLifecycle(agentInstanceId, principalId, "delete", operationId, 0)).rejects.toThrow(
				"simulated Engine interruption",
			);
			const progress = (await store.records.get("metadata", `native-delete-progress:${agentInstanceId}`)).value;
			expect(progress?.complete).toBe(false);
			expect(progress?.after).toHaveLength(2);
			expect(attemptPages).toBe(2);
			if (worker && root && workerExecutable) {
				await worker.stop();
				worker = await startStorageWorker(workerExecutable, root, token, 2);
				client = worker.client;
			}
			const restarted = new RocksEngineStore(client);
			await restarted.reconcilePendingNativeDeletes();
			expect(
				(await restarted.records.get("metadata", `native-delete-progress:${agentInstanceId}`)).value?.complete,
			).toBe(true);
			for (const nativeGeneration of generations) {
				const digest = new Bun.SHA256().update(`${familyId}\0${nativeGeneration}`).digest("hex");
				expect((await restarted.records.get("metadata", `native-delete:${digest}`)).value).toMatchObject({
					subtype: "native_tombstone",
					family_id: familyId,
					generation_id: nativeGeneration,
				});
			}
			expect((await restarted.chatLifecycle(agentInstanceId, principalId, "delete", operationId, 0)).status).toBe(
				"deleted",
			);
			let remaining = generations;
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline && remaining.length) {
				const next: string[] = [];
				for (const nativeGeneration of remaining) {
					const page = await client.readRange({
						familyId,
						generationId: nativeGeneration,
						maxRecords: 1,
						maxBytes: 1024,
					});
					if (page.liveThroughSeq !== 0 || page.events.length !== 0) next.push(nativeGeneration);
				}
				remaining = next;
				if (remaining.length) await Bun.sleep(50);
			}
			expect(remaining).toEqual([]);
		} finally {
			await worker?.stop();
		}
	},
	120_000,
);
