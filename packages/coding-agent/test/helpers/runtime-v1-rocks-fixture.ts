import {
	type EngineBindingSnapshot,
	type EngineCommandEnvelope,
	EngineTargetError,
	type EngineSemanticBindingSnapshot,
} from "../../src/engine/contracts";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../../src/config/model-registry";
import { RocksEngineStore } from "../../src/engine/rocks-runtime-store";
import { engineAgentId, engineAgentInstanceId } from "../../src/engine/route";
import { type RuntimeScope, runtimeRemainingWork } from "../../src/engine/runtime-protocol";
import type { EngineCommandIdentity } from "../../src/engine/store";
import { readStorageBinding, StorageClient } from "../../src/session/storage-client";
import { createInMemoryAuthStorage } from "./agent-session-setup";
import { admittedExecution, startRequest, type AdmittedExecutionFixture } from "./engine-runtime-admitted-fixture";
import { bindTestsToStorageWorker } from "./storage-worker-fixture";

export function semanticBinding(
	agentInstanceRef: string,
	taskRef = "grimoire://tasks/test/explicit-binding",
	workStepId: string | null = null,
): EngineSemanticBindingSnapshot {
	return {
		agentInstanceRef, taskRef, workStepId, bindingRevision: 0, installationId: null,
		parentAgentInstanceRef: null, parentAttemptId: null, parentBindingRevision: null,
	};
}

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
		bindingSnapshot: semanticBinding(agentInstanceRef, "grimoire://tasks/grimoire/runtime-test"),
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
		bindingSnapshot: semanticBinding(agent.agentInstanceId, "grimoire://tasks/grimoire/runtime-test"),
		bindingId: `binding-${name}`,
		commandId: `start-${name}`,
		executionId: `execution-${name}`,
		attemptId: `attempt-${name}`,
		engineAgentId: engineAgentId(agent.agentInstanceId),
		executionDigest: `sha256:${"a".repeat(64)}`,
		continuationDigest: `sha256:${"b".repeat(64)}`,
		dispatchRef: "gctx:cccccccccccccccc",
		dispatchHash: `sha256:${"c".repeat(64)}`,
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

/** One full typed admitted execution from the shared READONLY fixture: config, digests, receipts. */
export function admittedExecutionFixture(taskRef = "grimoire://tasks/grimoire/runtime-test"): AdmittedExecutionFixture {
	const model = buildModel({
		id: "runtime-v1-fixture-model",
		name: "Runtime v1 fixture model",
		api: "openai-completions",
		provider: "runtime-v1-fixture",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 16_000,
	});
	return admittedExecution(model, new ModelRegistry(createInMemoryAuthStorage()), { taskRef });
}

/**
 * Register `name` and commit its running Attempt from `binding(name)` through the real native admission
 * path: the shared fixture's typed Start request and immutable envelope, the routing lease from
 * stageAdmission, and the execution provenance the lease requires. Effects and approvals then stage
 * through the store's own guarded APIs.
 */
export async function active(store: RocksEngineStore, name = "root"): Promise<EngineBindingSnapshot> {
	const agent = identity(name);
	await store.registerAgent(agent);
	const target = binding(name);
	const execution = admittedExecutionFixture(target.bindingSnapshot!.taskRef!);
	// The exact typed Start the Engine transport would admit: immutable envelope captured once.
	const request = startRequest(execution, {
		commandId: target.commandId,
		agentInstanceId: target.agentInstanceId,
		agentInstanceRef: agent.agentInstanceRef,
		executionId: target.executionId,
		attemptId: target.attemptId,
	}, { cwd: "/", principalId: agent.principalId, input: "runtime v1 fixture" });
	const { commandId, agentInstanceId: _id, agentInstanceRef: _ref, bindingSnapshot, executionId, attemptId,
		authorityGeneration, principalId, ...payload } = request;
	const envelope: EngineCommandEnvelope = {
		schema: "grimoire.engine.command.v1", op: "start", commandId,
		deviceId: "device", engineId: "engine",
		engineGeneration: target.engineGeneration, agentInstanceId: target.agentInstanceId,
		agentInstanceRef: agent.agentInstanceRef, bindingSnapshot,
		executionId, attemptId, authorityGeneration, principalId,
		issuedAt: 1, payload,
	};
	const start = engineCommandIdentityFromEnvelope(envelope, target);
	await store.admitCommand(start, target.engineGeneration);
	const route = execution.config.routes.routes[0]!;
	const admission = {
		principalId: agent.principalId,
		deviceId: start.deviceId,
		engineGeneration: target.engineGeneration,
		commandId: target.commandId,
		agentInstanceRef: agent.agentInstanceRef,
		attemptId: target.attemptId,
		dispatchId: execution.config.dispatch.dispatch_id,
		dispatchRef: target.dispatchRef,
		dispatchHash: execution.dispatchHash,
		originReceiptId: `origin:${target.commandId}`,
		authContextId: "runtime-v1-fixture-auth",
		bindingSnapshot: target.bindingSnapshot!,
		executionKind: execution.config.dispatch.execution_kind,
		rosterRevision: execution.config.roster_revision,
		expectedRevisions: execution.config.record_revisions,
		limits: execution.config.routingLimits,
		candidates: [route],
		callerAttemptId: null,
		frozen: false,
	};
	const preview = await store.previewRouting(admission);
	if (preview.status !== "admitted") throw new Error("Fixture route admission was not available");
	await store.commitAttemptTransition(target, "running", [{ kind: "running" }], {
		requireNew: true,
		settleCommandId: start.commandId,
		settleCommandReceipt: { outcome: "applied" },
		routingAdmission: { request: admission, preview },
		execution: {
			execution_schema: 2,
			execution_digest: execution.config.stableDependencyDigest,
			continuation_digest: execution.config.continuationConfiguration ? hashOf(execution.config.continuationConfiguration) : target.continuationDigest,
			dispatch_ref: target.dispatchRef,
			dispatch_hash: execution.dispatchHash,
			executor_choice: choiceFrom(execution, preview.status === "admitted" ? preview.frozen : [route], target),
			lease_id: `slot-lease:${target.attemptId}`,
			queue_id: null,
		},
	});
	return target;
}

/** The executor choice the admitted frozen roster settles on: selected and candidates are the store's own admission output. */
export function choiceFrom(
	execution: AdmittedExecutionFixture,
	frozen: readonly Parameters<RocksEngineStore["previewRouting"]>[0]["candidates"],
	target: EngineBindingSnapshot,
) {
	const selected = frozen[0];
	if (!selected) throw new EngineTargetError("invalid_request", "Admitted roster selected no route");
	return {
		schema: "grimoire.executor_choice.v1" as const,
		dispatch_hash: execution.dispatchHash,
		preset_ref: null,
		effective_requirement: execution.config.dispatch.requirement,
		scope_revision: execution.config.scope_revision,
		candidates: [...frozen],
		filtered_counts: {},
		selected: { ...selected, basis: "rank" as const, order_match: null },
		execution_digest: target.executionDigest,
		shadow_cost_estimate: null,
		rules: [],
		skills: [],
		transitions: [],
		actual_cost: null,
		grants_used: [],
	};
}

function hashOf(value: unknown): string {
	return `sha256:${Bun.SHA256.hash(JSON.stringify(value), "hex")}`;
}

/** The admitted Start command identity the routing lease and attempt settlement are pinned to. */
function engineCommandIdentityFromEnvelope(
	envelope: EngineCommandEnvelope,
	target: EngineBindingSnapshot,
): EngineCommandIdentity {
	const { schema: _s, op, commandId, deviceId, engineId, engineGeneration, agentInstanceId, agentInstanceRef,
		bindingSnapshot, executionId, attemptId, authorityGeneration, principalId, issuedAt: _t, payload } = envelope;
	const serialized = JSON.stringify({ ...envelope, payload: { ...payload, expectedIntentRevision: 0 } });
	return {
		commandId, operation: op, deviceId, engineId, engineGeneration, agentInstanceId, agentInstanceRef,
		bindingSnapshot, executionId, attemptId, authorityGeneration, principalId,
		payloadHash: `sha256:${Bun.SHA256.hash(JSON.stringify(payload), "hex")}`,
		canonicalHash: `sha256:${Bun.SHA256.hash(serialized, "hex")}`,
		serializedCommand: serialized,
	};
}

/**
 * Write one durable native transcript entry in a fresh family and return its checkpoint. The owner settles a
 * completed Attempt or effect only on such a checkpoint; reuse the returned value across settlements.
 */
export async function nativeCheckpoint(store: RocksEngineStore) {
	const familyId = `checkpoint-${crypto.randomUUID()}`;
	const client = store.storageClient;
	await client.write({
		operationId: `checkpoint-${familyId}`,
		familyId,
		generationId: "main",
		firstSeq: 1,
		entries: [
			{
				entryId: "leaf",
				parentId: null,
				kind: "message",
				payload: { type: "message", message: { role: "assistant", content: "settled" } },
			},
		],
		durability: "required",
		dependencies: [],
	});
	return {
		sessionId: familyId,
		sessionPath: `native:${familyId}/main`,
		leafEntryId: "leaf",
		byteBoundary: 0,
		native: { familyId, generationId: "main", throughSeq: 1, incarnation: client.incarnation },
	};
}

