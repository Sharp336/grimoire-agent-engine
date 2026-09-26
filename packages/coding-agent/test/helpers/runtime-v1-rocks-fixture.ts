import type { EngineBindingSnapshot } from "../../src/engine/contracts";
import { RocksEngineStore } from "../../src/engine/rocks-runtime-store";
import { engineAgentId, engineAgentInstanceId } from "../../src/engine/route";
import { type RuntimeScope, runtimeRemainingWork } from "../../src/engine/runtime-protocol";
import type { EngineCommandIdentity } from "../../src/engine/store";
import { readStorageBinding, StorageClient } from "../../src/session/storage-client";
import { bindTestsToStorageWorker } from "./storage-worker-fixture";

/**
 * Runtime v1 store scenarios on a real Rust owner. Call inside a `describe.skipIf(storageWorkerUnavailable)`
 * body: every test gets its own owner process, so Engine generation 1 and an empty catalog are fresh per test.
 */
export function runtimeV1Fixture() {
	const worker = bindTestsToStorageWorker();
	/** A new client and projections over the same owner, as a restarted Engine sees them. */
	const reopen = () =>
		new RocksEngineStore(new StorageClient(readStorageBinding(process.env.GRIMOIRE_STORAGE_BINDING)!));
	return {
		blobsDir: worker.blobsDir,
		reopen,
		async createStore(): Promise<RocksEngineStore> {
			const store = reopen();
			await store.nextEngineGeneration();
			return store;
		},
	};
}

export function identity(name: string, parent?: string, principalId = "owner") {
	const agentInstanceRef = `grimoire://tasks/grimoire/runtime-test/agents/${name}`;
	return {
		agentInstanceRef,
		agentInstanceId: engineAgentInstanceId(agentInstanceRef),
		parentAgentInstanceId: parent,
		principalId,
		authorityGeneration: 1,
	};
}

export function binding(name: string): EngineBindingSnapshot {
	const agent = identity(name);
	return {
		agentInstanceId: agent.agentInstanceId,
		bindingId: `binding-${name}`,
		commandId: `start-${name}`,
		executionId: `execution-${name}`,
		attemptId: `attempt-${name}`,
		engineAgentId: engineAgentId(agent.agentInstanceId),
		profileDigest: "profile",
		state: "running",
		engineGeneration: 1,
		bindingGeneration: 1,
		authorityGeneration: 1,
		intentRevision: 0,
	};
}

export function command(name: string, op = "start"): EngineCommandIdentity {
	return {
		...identity("root"),
		commandId: name,
		operation: op,
		deviceId: "device",
		engineId: "engine",
		engineGeneration: 1,
		attemptId: name,
		executionId: name,
		payloadHash: `sha256:${"a".repeat(64)}`,
		canonicalHash: `sha256:${name}`,
		browserPayloadHash: `sha256:${"b".repeat(64)}`,
		serializedCommand: JSON.stringify({ text: name }),
	};
}

export function eventsRequest(
	epoch: string,
	afterCursor: number,
	scope: RuntimeScope = { kind: "catalog" },
	timeoutMs = 0,
) {
	return {
		scope,
		principalId: "owner",
		epoch,
		afterCursor,
		timeoutMs,
		limit: 100,
		maxBytes: 61440,
		remainingWork: runtimeRemainingWork(),
	};
}

/** Register `name` and commit its running Attempt from `binding(name)`. */
export async function active(store: RocksEngineStore, name = "root"): Promise<EngineBindingSnapshot> {
	await store.registerAgent(identity(name));
	const target = binding(name);
	await store.commitAttemptTransition(target, "running", [{ kind: "running" }]);
	return target;
}

/**
 * Write one durable native transcript entry in a fresh family and return its checkpoint. The owner settles a
 * completed Attempt or effect only on such a checkpoint; reuse the returned value across settlements.
 */
export async function nativeCheckpoint(store: RocksEngineStore) {
	const family = `family-${crypto.randomUUID()}`;
	const client = store.storageClient;
	await client.write({
		operationId: `transcript-${family}`,
		familyId: family,
		generationId: "main",
		firstSeq: 1,
		entries: [
			{
				entryId: "leaf",
				parentId: null,
				kind: "message",
				payload: { type: "message", message: { role: "assistant", content: "done" } },
			},
		],
		durability: "required",
		dependencies: [],
	});
	return {
		sessionId: family,
		sessionPath: `native:${family}/main`,
		leafEntryId: "leaf",
		byteBoundary: 0,
		native: { familyId: family, generationId: "main", throughSeq: 1, incarnation: client.incarnation },
	};
}
