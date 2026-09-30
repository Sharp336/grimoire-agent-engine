import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog";
import { type EngineBindingSnapshot, EngineTargetError, type EngineSemanticBindingSnapshot,
	type ExecutorChoice, type Candidate, type EngineExecutionConfiguration } from "../../src/engine/contracts";
import { ModelRegistry } from "../../src/config/model-registry";
import { engineCommandIdentity, type EngineCommandEnvelope, type EngineCommandOp } from "../../src/engine/nats-adapter";
import { candidateIdentity, frozenCandidate, l1For, type AdmissionRequest } from "../../src/engine/routing-admission";
import { RocksEngineStore } from "../../src/engine/rocks-runtime-store";
import { engineAgentId, engineAgentInstanceId } from "../../src/engine/route";
import { type RuntimeScope, runtimeRemainingWork } from "../../src/engine/runtime-protocol";
import type { EngineCommandIdentity } from "../../src/engine/store";
import { readStorageBinding, StorageClient, storageCanonicalJson } from "../../src/session/storage-client";
import { createInMemoryAuthStorage } from "./agent-session-setup";
import { admittedExecution, startEnvelope, startRequest, type AdmittedExecutionFixture } from "./engine-runtime-admitted-fixture";
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

export interface FixtureAgentIdentity {
	agentInstanceRef: string;
	bindingSnapshot: EngineSemanticBindingSnapshot;
	agentInstanceId: string;
	parentAgentInstanceId?: string;
	principalId: string;
	authorityGeneration: number;
}
export function identity(name: string, parent?: string, principalId = "owner"): FixtureAgentIdentity {
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
		bindingSnapshot: agent.bindingSnapshot,
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

export function command(name: string, op: EngineCommandOp = "start", options: {
	agent?: FixtureAgentIdentity;
	generation?: number;
	target?: Pick<EngineBindingSnapshot, "executionId" | "attemptId">;
	payload?: Record<string, unknown>;
	browserTarget?: EngineCommandEnvelope["browserTarget"];
} = {}): EngineCommandIdentity {
	const agent = options.agent ?? identity("root");
	const executionId = options.target?.executionId ?? name;
	const attemptId = options.target?.attemptId ?? name;
	let envelope: EngineCommandEnvelope;
	if (op === "start") {
		const execution = admittedExecutionFixture(agent.bindingSnapshot.taskRef!);
		if (options.payload) throw new Error("Start payload must come from its admitted execution");
		const request = startRequest(execution, {
			commandId: name, agentInstanceId: agent.agentInstanceId,
			agentInstanceRef: agent.agentInstanceRef, executionId, attemptId,
		}, { cwd: process.cwd(), principalId: agent.principalId, input: name,
			bindingSnapshot: agent.bindingSnapshot, expectedIntentRevision: 0 });
		const browserPayloadHash = options.browserTarget
			? `sha256:${Bun.SHA256.hash(storageCanonicalJson(options.browserTarget), "hex")}` : undefined;
		envelope = startEnvelope({ engineGeneration: options.generation ?? 1 }, execution, request,
			{ deviceId: "device", engineId: "engine",
				...(options.browserTarget ? { browserTarget: options.browserTarget, browserPayloadHash } : {}) });
	} else {
		envelope = {
			schema: "grimoire.engine.command.v1", op, commandId: name,
			deviceId: "device", engineId: "engine", engineGeneration: options.generation ?? 1,
			agentInstanceId: agent.agentInstanceId, agentInstanceRef: agent.agentInstanceRef,
			bindingSnapshot: agent.bindingSnapshot, executionId, attemptId,
			principalId: agent.principalId, authorityGeneration: agent.authorityGeneration,
			issuedAt: Date.now(),
			payload: options.payload ?? { expectedIntentRevision: 0 },
		};
	}
	if (options.browserTarget && op !== "start") envelope = { ...envelope, browserTarget: options.browserTarget };
	if (op === "start") return engineCommandIdentity(envelope);
	const payloadHash = engineCommandIdentity(envelope).payloadHash;
	return engineCommandIdentity({ ...envelope, browserPayloadHash: payloadHash });
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
export function admittedExecutionFixture(taskRef = "grimoire://tasks/grimoire/runtime-test",
	withFallback = false): AdmittedExecutionFixture {
	const spec: ModelSpec<"openai-completions"> = {
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
	};
	const model = buildModel(spec);
	const fallbackModel = withFallback
		? buildModel({ ...spec, id: "runtime-v1-fixture-fallback-model", name: "Fallback fixture model" })
		: undefined;
	return admittedExecution(model, new ModelRegistry(createInMemoryAuthStorage()), {
		taskRef, ...(fallbackModel ? { fallbackModel } : {}),
	});
}

/** Admit the exact frozen typed Start, routing lease, and Attempt as one native transition. */
export async function admittedFixtureStart(
	store: RocksEngineStore,
	initial: EngineBindingSnapshot,
	agentInstanceRef: string,
	principalId: string,
	execution: AdmittedExecutionFixture,
	deviceId = "device",
): Promise<EngineBindingSnapshot> {
	const cwd = process.cwd();
	const bindingSnapshot = initial.bindingSnapshot ??
		semanticBinding(agentInstanceRef, execution.taskRef);
	await store.registerAgent({
		agentInstanceId: initial.agentInstanceId, agentInstanceRef,
		principalId, authorityGeneration: initial.authorityGeneration,
	});
	const request = startRequest(execution, {
		commandId: initial.commandId, agentInstanceId: initial.agentInstanceId,
		agentInstanceRef, executionId: initial.executionId, attemptId: initial.attemptId,
	}, {
		cwd, principalId, input: "runtime v1 fixture",
		bindingSnapshot, expectedIntentRevision: 0,
	});
	const envelope = startEnvelope({ engineGeneration: initial.engineGeneration }, execution, request,
		{ deviceId, engineId: "engine" });
	const start = engineCommandIdentity(envelope);
	const result = await store.admitCommand(start, initial.engineGeneration);
	if (result.status !== "claimed") throw new Error("Fixture Start was not claimed by native owner");
	const admission: AdmissionRequest = {
		principalId, deviceId, engineGeneration: initial.engineGeneration,
		commandId: initial.commandId, agentInstanceRef, attemptId: initial.attemptId,
		dispatchId: execution.config.dispatch.dispatch_id,
		dispatchRef: execution.dispatchRef, dispatchHash: execution.dispatchHash,
		originReceiptId: request.originReceiptId, authContextId: "runtime-v1-fixture-auth",
		bindingSnapshot: request.bindingSnapshot, executionKind: execution.config.dispatch.execution_kind,
		rosterRevision: execution.config.roster_revision,
		expectedRevisions: execution.config.record_revisions,
		limits: execution.config.routingLimits, candidates: execution.config.routes.routes,
		callerAttemptId: null, frozen: false,
	};
	const preview = await store.previewRouting(admission);
	if (preview.status !== "admitted") throw new Error("Fixture route admission was not available");
	const choice = choiceFrom(execution, preview.frozen, preview.filtered);
	const target: EngineBindingSnapshot = {
		...initial, bindingSnapshot: request.bindingSnapshot,
		dispatchRef: execution.dispatchRef, dispatchHash: execution.dispatchHash,
		executionDigest: choice.execution_digest,
		continuationDigest: await continuationDigest(execution.config, agentInstanceRef, cwd,
			initial.authorityGeneration),
	};
	await store.commitAttemptTransition(target, "running", [{ kind: "running" }], {
		requireNew: true, settleCommandId: start.commandId,
		routingAdmission: { request: admission, preview },
		execution: {
			execution_schema: 2, execution_digest: target.executionDigest,
			continuation_digest: target.continuationDigest,
			dispatch_ref: target.dispatchRef, dispatch_hash: target.dispatchHash,
			executor_choice: choice, lease_id: `slot-lease:${target.attemptId}`, queue_id: null,
		},
	});
	return target;
}

export async function active(store: RocksEngineStore, name = "root",
	execution = admittedExecutionFixture(identity(name).bindingSnapshot.taskRef!)): Promise<EngineBindingSnapshot> {
	const agent = identity(name);
	return admittedFixtureStart(store, binding(name), agent.agentInstanceRef, agent.principalId, execution);
}

/** The executor choice the admitted frozen roster settles on, with the Engine's exact execution digest. */
export function choiceFrom(
	execution: AdmittedExecutionFixture,
	frozen: readonly Candidate[],
	filtered: Record<string, number>,
	selectedIndex = 0,
): ExecutorChoice {
	const route = frozen[selectedIndex];
	if (!route) throw new EngineTargetError("invalid_request", "Admitted roster selected no route");
	const config = execution.config;
	const requirement = config.dispatch.requirement;
	const admitted = config.routes.routes.find(candidate =>
		candidate.route_ref === route.route_ref && candidate.account_ref === route.account_ref &&
		candidate.model_id === route.model_id && candidate.billing_pool_id === route.billing_pool_id);
	if (!admitted) throw new EngineTargetError("stale_target", "Frozen route is outside the admitted roster");
	const selected: ExecutorChoice["selected"] = {
		...candidateIdentity(route),
		basis: requirement.pin ? "pin" : admitted.order_match ? "order" : "rank",
		order_match: admitted.order_match,
	};
	const candidates = frozen.map(frozenCandidate);
	const executionDigest = hashOf({
		schema: "artel.execution.v2", dispatchHash: execution.dispatchHash,
		executionConfiguration: config, record_revisions: config.record_revisions,
		scope_revision: config.scope_revision, candidates, selected,
	});
	return {
		schema: "grimoire.executor_choice.v1",
		dispatch_hash: execution.dispatchHash,
		preset_ref: config.dispatch.preset?.ref ?? null,
		effective_requirement: requirement,
		scope_revision: config.scope_revision,
		candidates,
		filtered_counts: filtered,
		selected,
		execution_digest: executionDigest,
		shadow_cost_estimate: route.shadow_cost,
		rules: l1For(config.instruction_sources, candidateIdentity(route))
			.map(({ ref, revision, content_hash }) => ({ ref, revision, content_hash })),
		skills: config.instruction_sources.skills,
		transitions: [],
		actual_cost: null,
		grants_used: [],
	};
}

function hashOf(value: unknown): `sha256:${string}` {
	return `sha256:${Bun.SHA256.hash(storageCanonicalJson(value), "hex")}`;
}

async function continuationDigest(config: EngineExecutionConfiguration,
	agentInstanceRef: string, cwd: string, authorityGeneration = 1): Promise<`sha256:${string}`> {
	const resolved = await fs.realpath(cwd).catch(() => path.resolve(cwd));
	const canonicalCwd = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	return hashOf({
		schema: "artel.continuation.v2", agentInstanceRef,
		parentAgentInstanceRef: null, authorityGeneration, canonicalCwd,
		continuationPolicy: config.continuationPolicy,
		continuationConfiguration: config.continuationConfiguration,
		stableDependencyDigest: config.stableDependencyDigest,
		sessionDefaults: config.sessionDefaults,
	});
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

