import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseNativeSessionLocator, RocksNativeSessionStorage } from "../session/rocks-native-session-storage";
import { SessionManager, type SessionDurabilityCheckpoint } from "../session/session-manager";
import { type StorageClient, storageCanonicalJson } from "../session/storage-client";
import type { StorageDependency, StoragePayload, StorageRuntimeKind, StorageRuntimeMutation, StorageUsageProbeBinding } from "../session/storage-protocol";
import type {
	ApprovalDecision,
	ApprovalRequest,
	EngineApprovalResolved,
	CandidateIdentity,
	ChoiceTransition,
	ExecutorChoice,
	EngineAttemptState,
	EngineExecutionConfiguration,
	EngineBindingGate,
	EngineBindingCheckpoint,
	EngineBindingResult,
	EngineSemanticBindingSnapshot,
	EngineBindingSnapshot,
	EngineEvent,
	EngineEventBase,
	EngineOrdinaryEvent,
	EngineInboxItem,
	EngineInboxMutation,
	EngineInboxSource,
	EngineInboxTarget,
	EngineMessageAttachments,
	EngineRetryState,
	ExecutorRouteState,
	RoutingLimits,
} from "./contracts";
import { EngineBindingPendingError, EngineRoutingQueuedError, EngineTargetError, sameSemanticBinding, validateSemanticBinding } from "./contracts";
import type { BillingPoolProposal } from "./provider-execution";
import {
	completeRestoreRebind,
	type RestoreWorkspaceDescriptor,
	type RestoreWorkspaceReceipt,
	restoreDescriptor,
	validateRestorePlan,
} from "./rocks-restore-workspace";
import {
	boundedReceipt,
	eventReadKeys,
	projectionId,
	type RocksProjection,
	retainedInputPayload,
	retainInputParts,
	runtimeReceipt,
	settleRuntimeMessages,
} from "./rocks-runtime-projection";
import {
	bindingSnapshot,
	bindingTarget,
	type RocksAttempt,
	type RocksBinding,
	type RocksCommand,
	type RocksEffect,
	type RocksEvent,
	type RocksHold,
	type RocksIdentity,
	type RocksInbox,
	type RocksSlotLease,
} from "./rocks-runtime-rows";
import {
	attachmentIdentity,
	attachmentUploadKey,
	type EngineAttachment,
	messageAttachmentReferences,
} from "./runtime-attachments";
import { ENGINE_CONTROL_OPS, RUNTIME_PROTOCOL_REVISION, runtimeLimits, validateRuntimeValue } from "./runtime-protocol";
import { engineAgentInstanceId } from "./route";
import {
	type AdmissionOutcome,
	type AdmissionRequest,
	candidateIdentity,
	candidateRef,
	currentIdentity,
	leaseId,
	ruleDelta,
	stageAdmission,
	staleLeaseAttempts,
	stageQueueCancel,
	stageRelease,
	stageRenew,
	stageTransfer,
} from "./routing-admission";
import { RuntimeRecords, RuntimeTransaction } from "./runtime-records";
import { type EnginePendingStartTarget, validateStartFence } from "./start-fence";
import {
	type EngineApprovalRow,
	EngineAttemptConflictError,
	type EngineBranchHold,
	type EngineCommandAdmission,
	EngineCommandConflictError,
	type EngineCommandIdentity,
	type EngineCommandReceipt,
	EngineEffectConflictError,
	EngineInboxConflictError,
	type EngineModelEffectInput,
	type EnginePendingStartCancellation,
	type EngineToolEffectInput,
	type EngineTransitionEvent,
} from "./store";

type EventTarget = Pick<
	EngineBindingSnapshot,
	| "commandId"
	| "agentInstanceId"
	| "executionId"
	| "attemptId"
	| "bindingId"
	| "engineGeneration"
	| "bindingGeneration"
	| "authorityGeneration"
>;
export interface ResumeMember extends EventTarget {
	bindingSnapshot?: EngineSemanticBindingSnapshot;
	intentRevision: number;
	parentAgentInstanceId: string | null;
}
interface ResumeOwnership {
	subtype: "ownership";
	agent_instance_id: string;
	attempt_id: string;
	position: number;
	value: { intentRevision: number; members: ResumeMember[] };
}
type AgentIdentity = Pick<
	EngineCommandIdentity,
	| "agentInstanceId"
	| "agentInstanceRef"
	| "parentAgentInstanceId"
	| "parentAgentInstanceRef"
	| "principalId"
	| "authorityGeneration"
>;
interface StartCancellation {
	subtype: "start_cancellation";
	target: EnginePendingStartTarget;
	cancellationCommandId: string;
}
const terminal = new Set<EngineAttemptState>(["completed", "failed", "cancelled", "interrupted"]);

const bindingResultFields = [
	"agent_ref", "revision", "binding_revision", "task_ref", "work_step_id",
	"installation_id", "phase", "operation_id", "proposal_hash", "status",
] as const;

/** Hosted status/prepare may replay a commit; transport action is not operation identity. */
function sameBindingResult(left: EngineBindingResult, right: EngineBindingResult): boolean {
	return bindingResultFields.every(field =>
		left[field] === right[field] && left.operation_result[field] === right.operation_result[field]);
}

/** Only changes to census observations invalidate its cut, not publication/projection bookkeeping. */
function censusState(kind: StorageRuntimeKind, value: StoragePayload | null): string | number | null {
	if (!value) return null;
	switch (kind) {
		case "identity":
			return JSON.stringify([value.agent_instance_ref, value.parent_agent_instance_id,
				value.parent_agent_instance_ref, value.principal_id, value.root_agent_instance_ref]);
		case "command": return value.state === "received" ? 1 : null;
		case "attempt": return terminal.has(value.state as EngineAttemptState) ? null : 1;
		case "effect": return value.state === "settled" ? null : 1;
		case "inbox": return value.subtype === "item" && value.disposition === "pending" ? 1 : null;
		case "event": {
			const event = value as unknown as RocksEvent;
			return event.kind === "reconciled" && event.payload?.semanticBinding === true ? null : event.eventId;
		}
		case "delivery":
			return value.sink_id === "hosted-binding" && value.state === "delivered" ? String(value.event_id) : null;
		default: return null;
	}
}

function modelEffectPayload(effect: RocksEffect): Record<string, unknown> {
	return { effectId: effect.effect_id, modelCallId: effect.tool_call_id };
}

function toolEffectPayload(effect: RocksEffect): Record<string, unknown> {
	return {
		invocationId: effect.effect_id,
		toolCallId: effect.tool_call_id,
		toolName: effect.tool_name,
		policy: effect.policy,
		inputHash: effect.input_hash,
		...(effect.assistant_message_id && effect.assistant_block_id
			? { origin: { messageId: effect.assistant_message_id, blockId: effect.assistant_block_id } }
			: {}),
	};
}

export interface RocksTransitionOptions {
	cause?: string;
	terminalResult?: Record<string, unknown>;
	actualCost?: ExecutorChoice["actual_cost"];
	intentGuard?: { expectedRevision?: number; requireUnheld?: boolean; inputId?: string; inputRevision?: number; commandId?: string };
	startIntent?: {
		expectedRevision?: number;
		explicitContinue?: boolean;
		allowInheritedHold?: boolean;
		sourceAgentInstanceId?: string;
		sourceRevision?: number;
	};
	settleCommandId?: string;
	settleCommandReceipt?: EngineCommandReceipt;
	expectedStates?: readonly EngineAttemptState[];
	requireNew?: boolean;
	transcriptCheckpoint?: SessionDurabilityCheckpoint;
	inboxSessionId?: string;
	inboxMutation?: EngineInboxMutation;
	inboxMutationCausationCommandId?: string;
	/** Admitted execution provenance written with the Attempt row at acceptance. */
	execution?: RocksAttempt["execution"];
	/** Previewed full-roster selection must remain identical at the owner CAS. */
	routingAdmission?: { request: AdmissionRequest; preview: Extract<AdmissionOutcome, { status: "admitted" }> };
	/** Reacquire the current frozen route in the SAME state transition that resumes a paused Attempt. */
	routingResume?: AdmissionRequest;
	previousInboxSessionId?: string;
	pendingInboxSourceSessionId?: string;
	restoreWorkspaceReceipt?: RestoreWorkspaceReceipt;
}

/** Product state transitions remain here; the storage owner checks every observed revision and commits the batch. */
export class RocksEngineMutations {
	readonly records: RuntimeRecords;
	#change = Promise.withResolvers<void>();
	readonly #commitWatchers = new Set<(puts: StorageRuntimeMutation["puts"]) => void>();
	#installation: { installationId: string; principalId: string } | undefined;
	readonly #agentRoots = new Map<string, string>();
	readonly #ownedRoots = new Set<string>();
	#bindingTracking?: Promise<void>;

	async #loadBindingTracking(): Promise<void> {
		for (const kind of ["identity", "metadata"] as const) {
			let cursor: string | undefined;
			do {
				const page = await this.records.query("kind_primary", [kind], cursor, 100, undefined, true);
				this.#rememberBindingRows(page.records.filter(row => row.value !== null) as StorageRuntimeMutation["puts"]);
				cursor = page.nextCursor ?? undefined;
			} while (cursor);
		}
	}

	#rememberBindingRows(rows: StorageRuntimeMutation["puts"]): void {
		for (const row of rows) {
			if (row.kind !== "identity") continue;
			const identity = row.value as unknown as RocksIdentity;
			this.#agentRoots.set(row.id, identity.root_agent_instance_ref
				? engineAgentInstanceId(identity.root_agent_instance_ref) : row.id);
		}
		for (const row of rows) {
			if (row.kind !== "metadata" || !row.id.startsWith("semantic-binding:")) continue;
			const gate = row.value.gate as EngineBindingGate;
			const id = engineAgentInstanceId(gate.bindingSnapshot.agentInstanceRef);
			const parent = gate.bindingSnapshot.parentAgentInstanceRef;
			const root = this.#agentRoots.get(id) ??
				(parent ? this.#agentRoots.get(engineAgentInstanceId(parent)) : undefined) ?? id;
			this.#agentRoots.set(id, root);
			this.#ownedRoots.add(root);
		}
	}

	#bindingMutationKey(id: string): string {
		return `binding-mutation:${this.#agentRoots.get(id) ?? id}`;
	}
	constructor(
		readonly storageClient: StorageClient,
		readonly projectEvent: (tx: RuntimeTransaction, event: EngineEvent) => Promise<void>,
	) {
		this.records = new RuntimeRecords(storageClient);
	}
	async drain(): Promise<void> {
		await this.records.drain();
	}
	async close(): Promise<void> {
		await this.drain();
	}
	changeSignal(): Promise<void> {
		return this.#change.promise;
	}
	/** Calls `watch` with the rows of every mutation this store commits until the returned disposer runs. */
	watchCommits(watch: (puts: StorageRuntimeMutation["puts"]) => void): () => void {
		this.#commitWatchers.add(watch);
		return () => this.#commitWatchers.delete(watch);
	}
	async mutation<T>(
		scope: string,
		work: (tx: RuntimeTransaction) => Promise<T>,
		dependencies: StorageDependency[] = [],
		durability: "required" | "buffered" = "required",
	): Promise<T> {
		await (this.#bindingTracking ??= this.#loadBindingTracking());
		// Conflicts replay `work` on a fresh transaction; only the last one is committed.
		let committed: RuntimeTransaction | undefined;
		const result = await this.records.mutate(
			scope,
			async tx => {
				committed = tx;
				const result = await work(tx);
				// Record CAS is the owner's only atomic fence; index revisions cannot be checked by a write.
				const puts = tx.mutation().puts;
				const roots = new Set<string>();
				for (const agent of tx.changedAgentIds(censusState)) {
					const identity = puts.find(row => row.kind === "identity" && row.id === agent)?.value as unknown as RocksIdentity | undefined;
					const previousRoot = this.#agentRoots.get(agent) ?? agent;
					const root = identity?.root_agent_instance_ref
						? engineAgentInstanceId(identity.root_agent_instance_ref) : previousRoot;
					if (this.#ownedRoots.has(previousRoot)) roots.add(previousRoot);
					if (this.#ownedRoots.has(root)) roots.add(root);
				}
				for (const row of puts) {
					if (row.kind !== "metadata" || !row.id.startsWith("semantic-binding:")) continue;
					const gate = row.value.gate as EngineBindingGate;
					const snapshot = gate.bindingSnapshot;
					const agent = engineAgentInstanceId(snapshot.agentInstanceRef);
					const parent = snapshot.parentAgentInstanceRef;
					roots.add(this.#agentRoots.get(agent) ??
						(parent ? this.#agentRoots.get(engineAgentInstanceId(parent)) : undefined) ?? agent);
				}
				// ponytail: one checked row per changed owned tree; owner partition CAS if four-attempt contention grows.
				for (const root of roots)
					await tx.put("metadata", `binding-mutation:${root}`, { subtype: "binding_mutation" });
				return result;
			},
			dependencies,
			durability,
		);
		const mutation = committed?.mutation();
		if (mutation && (mutation.puts.length || mutation.deletes.length)) {
			this.#rememberBindingRows(mutation.puts);
			for (const watch of this.#commitWatchers) watch(mutation.puts);
			const change = this.#change;
			this.#change = Promise.withResolvers<void>();
			change.resolve();
		}
		return result;
	}

	verifyInstallation(installationId: string, principalId: string): void {
		validateRuntimeValue("installationId", installationId);
		if (!/^grimoire:user:[A-Za-z0-9._~-]+$/.test(principalId))
			throw new EngineTargetError("invalid_request", "Invalid installation owner");
		if (this.#installation && (this.#installation.installationId !== installationId ||
			this.#installation.principalId !== principalId))
			throw new EngineTargetError("stale_target", "Engine installation cannot change in place");
		this.#installation = { installationId, principalId };
	}

	get verifiedInstallationId(): string | undefined {
		return this.#installation?.installationId;
	}

	#requireInstallation(snapshot: EngineSemanticBindingSnapshot, principalId?: string): void {
		validateSemanticBinding(snapshot, snapshot.agentInstanceRef);
		if (!snapshot.installationId) return;
		if (!this.#installation) throw new EngineBindingPendingError();
		const ownerHash = createHash("sha256").update(this.#installation.principalId).digest("hex");
		if (snapshot.installationId !== this.#installation.installationId)
			throw new EngineBindingPendingError("Start belongs to another installation");
		if ((principalId !== undefined && principalId !== this.#installation.principalId) ||
			!snapshot.agentInstanceRef.startsWith(`grimoire://agents/~u/${ownerHash}/`) ||
			(snapshot.taskRef?.startsWith("grimoire://tasks/~u/") &&
				!snapshot.taskRef.startsWith(`grimoire://tasks/~u/${ownerHash}/`)))
			throw new EngineTargetError("stale_target", "Binding does not belong to this owner");
	}

	async semanticGate(id: string): Promise<EngineBindingGate | undefined> {
		return (await this.records.get("metadata", `semantic-binding:${id}`, true)).value?.gate as EngineBindingGate | undefined;
	}

	async assertSemanticStart(
		tx: RuntimeTransaction, id: string, snapshot: EngineSemanticBindingSnapshot, principalId?: string,
	): Promise<void> {
		this.#requireInstallation(snapshot, principalId);
		if (!snapshot.installationId) return;
		if (id !== engineAgentInstanceId(snapshot.agentInstanceRef))
			throw new EngineTargetError("invalid_request", "Owned Start requires its exact Engine Agent identity");
		const key = `semantic-binding:${id}`;
		let gate = (await tx.get<{ gate: EngineBindingGate }>("metadata", key))?.gate;
		if (!gate) {
			const identity = await tx.get<RocksIdentity>("identity", id);
			const enrolledChild = identity && snapshot.parentAgentInstanceRef && snapshot.parentAttemptId &&
				identity.agent_instance_ref === snapshot.agentInstanceRef &&
				(identity.parent_agent_instance_ref === null || identity.parent_agent_instance_ref === snapshot.parentAgentInstanceRef) &&
				identity.parent_agent_instance_id === engineAgentInstanceId(snapshot.parentAgentInstanceRef) &&
				identity.principal_id === this.#installation!.principalId;
			if (snapshot.bindingRevision !== 1 || (identity && !enrolledChild) ||
				await tx.get("metadata", `semantic-birth:${id}`) ||
				await tx.get<RocksBinding>("binding", id) ||
				(await tx.query<RocksAttempt>("attempt_agent", [id])).length)
				throw new EngineBindingPendingError("Owned binding needs exact local adoption");
			if (snapshot.parentAgentInstanceRef && snapshot.parentAttemptId) {
				const parentId = engineAgentInstanceId(snapshot.parentAgentInstanceRef);
				const parentGate = (await tx.get<{ gate: EngineBindingGate }>("metadata", `semantic-binding:${parentId}`))?.gate;
				const parentAttempt = await tx.get<RocksAttempt>("attempt", snapshot.parentAttemptId);
				const parent = parentAttempt?.binding_snapshot;
				if (!parent || parentAttempt?.agent_instance_id !== parentId || parent.agentInstanceRef !== snapshot.parentAgentInstanceRef ||
					parent.bindingRevision !== snapshot.parentBindingRevision ||
					parent.installationId !== snapshot.installationId ||
					parent.taskRef !== snapshot.taskRef || parent.workStepId !== snapshot.workStepId)
					throw new EngineTargetError("stale_target", "Child birth differs from its exact admitted parent");
				if (parentGate?.phase !== "open") throw new EngineBindingPendingError("Parent binding is closed");
				if (!sameSemanticBinding(parentGate.bindingSnapshot, parent))
					throw new EngineTargetError("stale_target", "Child birth belongs to a retired parent binding");
				if (identity && identity.parent_agent_instance_ref === null)
					await tx.put("identity", id, { ...identity, parent_agent_instance_ref: snapshot.parentAgentInstanceRef });
			}
			gate = { bindingSnapshot: snapshot, phase: "open", operationId: null, proposalHash: null,
				gateRevision: 0, censusMutationRevision: 0 };
			await tx.put("metadata", key, { subtype: "semantic_binding", gate });
			await tx.put("metadata", `semantic-birth:${id}`, { subtype: "semantic_binding", established: true });
		}
		validateRuntimeValue("bindingGate", gate);
		if (gate.phase !== "open") throw new EngineBindingPendingError();
		if (!sameSemanticBinding(gate.bindingSnapshot, snapshot))
			throw new EngineTargetError("stale_target", "Start binding differs from the adopted binding");
	}

	async checkSemanticStart(id: string, snapshot?: EngineSemanticBindingSnapshot, principalId?: string): Promise<void> {
		if (snapshot) await this.mutation(id, tx => this.assertSemanticStart(tx, id, snapshot, principalId));
	}

	async bindingPrepare(gate: EngineBindingGate): Promise<EngineBindingGate> {
		validateRuntimeValue("bindingGate", gate);
		this.#requireInstallation(gate.bindingSnapshot);
		if (!gate.bindingSnapshot.installationId || gate.phase !== "preparing" || gate.committedTarget)
			throw new EngineTargetError("invalid_request", "Prepare requires a closed owned old binding");
		const id = engineAgentInstanceId(gate.bindingSnapshot.agentInstanceRef);
		return this.mutation(id, async tx => {
			const key = `semantic-binding:${id}`;
			const old = (await tx.get<{ gate: EngineBindingGate }>("metadata", key))?.gate;
			const retained = await tx.get<RocksBinding>("binding", id);
			if (!old && (retained || await tx.get<RocksIdentity>("identity", id) ||
				await tx.get("metadata", `semantic-birth:${id}`)))
				throw new EngineBindingPendingError("Retained owned Agent lost its semantic gate");
			const terminal = await tx.get<{ result: EngineBindingResult; gate: EngineBindingGate; old: EngineSemanticBindingSnapshot }>(
				"metadata", `binding-terminal:${id}:${gate.operationId}`);
			if (terminal) {
				if (terminal.result.proposal_hash !== gate.proposalHash ||
					!sameSemanticBinding(terminal.old, gate.bindingSnapshot))
					throw new EngineTargetError("stale_target", "Terminal binding operation changed");
				return terminal.gate;
			}
			if (old && old.phase !== "open") {
				if (old.phase === "preparing" && old.operationId === gate.operationId &&
					old.proposalHash === gate.proposalHash && sameSemanticBinding(old.bindingSnapshot, gate.bindingSnapshot))
					return old;
				throw new EngineTargetError("stale_target", "Another binding operation owns the gate");
			}
			if ((old && !sameSemanticBinding(old.bindingSnapshot, gate.bindingSnapshot)) ||
				(!old && retained?.binding_snapshot && !sameSemanticBinding(retained.binding_snapshot, gate.bindingSnapshot)))
				throw new EngineTargetError("stale_target", "Prepare binding differs from the local binding");
			const next: EngineBindingGate = { ...gate, gateRevision: (old?.gateRevision ?? 0) + 1,
				censusMutationRevision: old?.censusMutationRevision ?? 0 };
			validateRuntimeValue("bindingGate", next);
			await tx.put("metadata", key, { subtype: "semantic_binding", gate: next });
			await tx.put("metadata", `semantic-birth:${id}`, { subtype: "semantic_binding", established: true });
			if (await tx.get<RocksIdentity>("identity", id))
				await this.identityEvent(tx, id, gate.operationId!, "reconciled", { semanticBinding: true });
			return next;
		});
	}

	async bindingTransition(action: "adopt" | "activate" | "abort", result: EngineBindingResult,
		requested?: EngineBindingGate): Promise<EngineBindingGate> {
		validateRuntimeValue("bindingResult", result);
		if (requested) validateRuntimeValue("bindingGate", requested);
		const id = engineAgentInstanceId(result.agent_ref);
		const transitioned = await this.mutation(id, async tx => {
			const key = `semantic-binding:${id}`;
			const gate = (await tx.get<{ gate: EngineBindingGate }>("metadata", key))?.gate;
			if (!gate) throw new EngineBindingPendingError("Binding gate is unavailable");
			this.#requireInstallation(gate.bindingSnapshot);
			const target: EngineSemanticBindingSnapshot = { ...gate.bindingSnapshot,
				taskRef: result.task_ref, workStepId: result.work_step_id, bindingRevision: result.binding_revision };
			if (result.installation_id !== gate.bindingSnapshot.installationId)
				throw new EngineTargetError("stale_target", "Binding installation changed");
			const resultKey = `binding-result:${id}:${result.operation_id}:${action}`;
			const last = await tx.get<{ result: EngineBindingResult; gate: EngineBindingGate }>("metadata", resultKey);
			if (last) {
				if (!sameBindingResult(last.result, result) ||
					(requested && (requested.operationId !== result.operation_id ||
						requested.proposalHash !== result.proposal_hash ||
						!sameSemanticBinding(requested.bindingSnapshot, last.gate.bindingSnapshot) ||
						!sameSemanticBinding(requested.committedTarget, last.gate.committedTarget))))
					throw new EngineTargetError("stale_target", "Replayed binding operation changed");
				return last.gate;
			}
			if (gate.operationId !== result.operation_id || gate.proposalHash !== result.proposal_hash)
				throw new EngineTargetError("stale_target", "Binding operation changed");
			const committedKey = `binding-result:${id}:${result.operation_id}:commit-pending`;
			const committed = await tx.get<{ result: EngineBindingResult }>("metadata", committedKey);
			if (committed && (action === "abort" || (action === "adopt" && !sameBindingResult(committed.result, result))))
				throw new EngineTargetError("stale_target", "Committed binding result changed");
			let next: EngineBindingGate;
			if (action === "adopt") {
				if (result.status !== "committed" || result.phase !== "committed_await_adopt" ||
					gate.phase !== "preparing" || target.bindingRevision !== gate.bindingSnapshot.bindingRevision + 1 ||
					(target.taskRef === gate.bindingSnapshot.taskRef && target.workStepId === gate.bindingSnapshot.workStepId) ||
					!requested || requested.phase !== "committed_closed" ||
					!sameSemanticBinding(requested.bindingSnapshot, gate.bindingSnapshot) ||
					!sameSemanticBinding(requested.committedTarget, target) ||
					requested.operationId !== gate.operationId || requested.proposalHash !== gate.proposalHash)
					throw new EngineTargetError("stale_target", "Adoption requires the exact committed successor");
				const scan = await tx.get<{ checkpoint: EngineBindingCheckpoint }>("metadata", `binding-census:${id}`);
				if (!await this.#freshBindingCheckpoint(tx, id, gate, scan?.checkpoint, gate.bindingSnapshot.bindingRevision)) {
					// Persist the canonical commitment even when the old-binding cut needs recertification.
					// The caller keeps committed_closed; the Engine's preparing gate still denies all new work.
					if (!committed)
						await tx.put("metadata", committedKey, { subtype: "binding_result", result, gate });
					return null;
				}
				next = { ...gate, phase: "committed_closed", committedTarget: target };
			} else if (action === "activate") {
				if (result.status !== "adopted" || result.phase !== "active" ||
					gate.phase !== "committed_closed" || !sameSemanticBinding(gate.committedTarget, target))
					throw new EngineTargetError("stale_target", "Activation requires canonical adoption");
				const activationKey = `binding-result:${id}:${result.operation_id}:activate-pending`;
				const activation = await tx.get<{ result: EngineBindingResult }>("metadata", activationKey);
				if (activation && !sameBindingResult(activation.result, result))
					throw new EngineTargetError("stale_target", "Canonical adoption result changed");
				const scan = await tx.get<{ checkpoint: EngineBindingCheckpoint }>("metadata", `binding-census:${id}`);
				if (!await this.#freshBindingCheckpoint(tx, id, gate, scan?.checkpoint, target.bindingRevision)) {
					if (!activation)
						await tx.put("metadata", activationKey, { subtype: "binding_result", result, gate });
					return null;
				}
				next = { ...gate, bindingSnapshot: target, phase: "open", operationId: null, proposalHash: null };
				delete next.committedTarget;
			} else {
				if (result.status !== "aborted" || result.phase !== "active" ||
					gate.phase !== "preparing" || !sameSemanticBinding(gate.bindingSnapshot, target))
					throw new EngineTargetError("stale_target", "Only canonical old-binding abort may open the gate");
				next = { ...gate, phase: "open", operationId: null, proposalHash: null };
			}
			next.gateRevision++;
			validateRuntimeValue("bindingGate", next);
			await tx.put("metadata", key, { subtype: "semantic_binding", gate: next });
			await tx.put("metadata", resultKey, { subtype: "binding_result", result, gate: next });
			if (action !== "adopt")
				await tx.put("metadata", `binding-terminal:${id}:${result.operation_id}`,
					{ subtype: "binding_result", result, gate: next, old: gate.bindingSnapshot });
			if (await tx.get<RocksIdentity>("identity", id))
				await this.identityEvent(tx, id, result.operation_id, "reconciled", { semanticBinding: true });
			return next;
		});
		if (!transitioned)
			throw new EngineBindingPendingError("Binding transition requires a fresh complete zero census");
		return transitioned;
	}

	async #freshBindingCheckpoint(tx: RuntimeTransaction, id: string, gate: EngineBindingGate,
		checkpoint: EngineBindingCheckpoint | undefined, bindingRevision: number): Promise<boolean> {
		return checkpoint?.status === "complete" && checkpoint.next_cursor === null &&
			checkpoint.agent_ref === gate.bindingSnapshot.agentInstanceRef &&
			checkpoint.installation_id === gate.bindingSnapshot.installationId &&
			checkpoint.operation_id === gate.operationId && checkpoint.proposal_hash === gate.proposalHash &&
			checkpoint.binding_revision === bindingRevision && checkpoint.gate_revision === gate.gateRevision &&
			checkpoint.nonterminal_starts === 0 && checkpoint.nonterminal_attempts === 0 &&
			checkpoint.open_effects === 0 && checkpoint.unsettled_children === 0 && checkpoint.mutable_pending_writes === 0 &&
			checkpoint.census_mutation_revision === await tx.revision("metadata", this.#bindingMutationKey(id)) &&
			checkpoint.engine_generation === (await tx.get<{ generation: number }>("metadata", "engine"))?.generation;
	}

	async bindingCensus(params: {
		agentInstanceRef: string; installationId: string; operationId: string; proposalHash: string; bindingRevision: number;
	}, generation: number): Promise<EngineBindingCheckpoint> {
		const id = engineAgentInstanceId(params.agentInstanceRef);
		return this.mutation(id, async tx => {
			const gate = (await tx.get<{ gate: EngineBindingGate }>("metadata", `semantic-binding:${id}`))?.gate;
			if (!gate || gate.phase === "open") throw new EngineBindingPendingError("No closed binding gate");
			this.#requireInstallation(gate.bindingSnapshot);
			if (gate.bindingSnapshot.agentInstanceRef !== params.agentInstanceRef ||
				gate.bindingSnapshot.installationId !== params.installationId ||
				(gate.committedTarget ?? gate.bindingSnapshot).bindingRevision !== params.bindingRevision ||
				gate.operationId !== params.operationId || gate.proposalHash !== params.proposalHash)
				throw new EngineTargetError("stale_target", "Census operation changed");
			const key = `binding-census:${id}`;
			type Frame = { id: string; ref: string; stage: number; after?: Array<string | number | null> };
			type Scan = { checkpoint: EngineBindingCheckpoint; stack: Frame[] };
			const marker = this.#bindingMutationKey(id);
			const revision = await tx.revision("metadata", marker);
			let scan = await tx.get<Scan>("metadata", key);
			if (!scan?.stack || scan.checkpoint.gate_revision !== gate.gateRevision ||
				scan.checkpoint.census_mutation_revision !== revision ||
				scan.checkpoint.engine_generation !== generation) {
				scan = { stack: [{ id, ref: params.agentInstanceRef, stage: 0 }], checkpoint: {
					agent_ref: params.agentInstanceRef, installation_id: params.installationId,
					operation_id: params.operationId, proposal_hash: params.proposalHash, binding_revision: params.bindingRevision,
					gate_revision: gate.gateRevision, census_mutation_revision: revision,
					runtime_contract_revision: RUNTIME_PROTOCOL_REVISION, engine_generation: generation, status: "unknown",
					nonterminal_starts: 0, nonterminal_attempts: 0, open_effects: 0, unsettled_children: 0,
					mutable_pending_writes: 0, next_cursor: null } };
			}
			// Depth-first, bounded partition pages. Unknown/unrelated identities and events are never visited.
			const frame = scan.stack.at(-1);
			if (frame) {
				const identity = (await this.records.get("identity", frame.id, true)).value as unknown as RocksIdentity | undefined;
				const parent = scan.stack.at(-2);
				if ((identity && identity.agent_instance_ref !== frame.ref) ||
					(parent && (!identity || identity.parent_agent_instance_id !== parent.id ||
						identity.parent_agent_instance_ref !== parent.ref ||
						identity.principal_id !== this.#installation!.principalId)))
					throw new EngineBindingPendingError("Census descendant ancestry is unavailable");
				const page = await this.records.query(frame.stage === 0 ? "agent_records" : "identity_parent",
					[frame.id], undefined, frame.stage === 0 ? 25 : 1, frame.after, true);
				if (frame.stage === 0) {
					for (const row of page.records) {
						const value = row.value;
						if (!value || value.agent_instance_id !== frame.id)
							throw new EngineBindingPendingError("Census encountered a broken descendant record");
						let counter: "nonterminal_starts" | "nonterminal_attempts" | "open_effects" | "mutable_pending_writes";
						if (row.kind === "command" && value.state === "received") counter = "nonterminal_starts";
						else if (row.kind === "attempt" && !terminal.has(value.state as EngineAttemptState)) counter = "nonterminal_attempts";
						else if (row.kind === "effect" && value.state !== "settled") counter = "open_effects";
						else if (row.kind === "inbox" && value.subtype === "item" && value.disposition === "pending") counter = "mutable_pending_writes";
						else if (row.kind === "event") {
							const event = value as unknown as RocksEvent;
							if (event.kind === "reconciled" && event.payload?.semanticBinding === true) continue;
							if ((await this.records.get("delivery", `hosted-binding:${event.eventId}`, true)).value?.state === "delivered") continue;
							counter = "mutable_pending_writes";
						} else continue;
						scan.checkpoint[frame.id === id ? counter : "unsettled_children"]++;
					}
					if (page.nextCursor) frame.after = [page.records.at(-1)!.id];
					else {
						delete frame.after;
						frame.stage = 1;
					}
				} else {
					const child = page.records[0];
					if (!child) scan.stack.pop();
					else {
						if (!identity) throw new EngineBindingPendingError("Census descendant parent is unavailable");
						const childIdentity = child.value as unknown as RocksIdentity;
						if (!childIdentity || !childIdentity.agent_instance_ref || scan.stack.some(ancestor => ancestor.id === child.id))
							throw new EngineBindingPendingError("Census descendant ancestry is invalid");
						frame.after = [child.id];
						scan.stack.push({ id: child.id, ref: childIdentity.agent_instance_ref, stage: 0 });
					}
				}
			}
			if (((await this.records.get("metadata", marker, true)).revision ?? 0) !== revision)
				throw new EngineBindingPendingError("Census changed during its scoped page");
			const complete = scan.stack.length === 0;
			const busy = scan.checkpoint.nonterminal_starts + scan.checkpoint.nonterminal_attempts +
				scan.checkpoint.open_effects + scan.checkpoint.unsettled_children + scan.checkpoint.mutable_pending_writes > 0;
			scan.checkpoint.status = busy ? "busy" : complete ? "complete" : "unknown";
			scan.checkpoint.next_cursor = complete ? null :
				`scan_${gate.gateRevision}_${revision}_${generation}_${createHash("sha256").update(storageCanonicalJson(scan.stack)).digest("hex")}`;
			validateRuntimeValue("bindingCheckpoint", scan.checkpoint);
			await tx.put("metadata", key, { ...scan, subtype: "semantic_binding" });
			return scan.checkpoint;
		});
	}
	async nextEngineGeneration(): Promise<number> {
		const floorPath = process.env.GRIMOIRE_ENGINE_GENERATION_FLOOR_FILE;
		const saved = floorPath
			? await fs.readFile(floorPath, "utf8").catch(error => {
					if (error?.code === "ENOENT") return "0";
					throw error;
				})
			: "0";
		const floor = Number(saved.trim());
		if (!Number.isSafeInteger(floor) || floor < 0) throw new Error("Invalid Engine generation floor");
		const restoreEpoch = process.env.GRIMOIRE_STORAGE_RESTORE_ID;
		const restoreWorkspace = process.env.GRIMOIRE_STORAGE_RESTORE_WORKSPACE_REBIND;
		const plan = restoreWorkspace ? validateRestorePlan(JSON.parse(restoreWorkspace)) : undefined;
		const workRoot = process.env.GRIMOIRE_ENGINE_WORK_ROOT;
		if (
			plan &&
			(plan.restoreEpoch !== restoreEpoch ||
				!workRoot ||
				path.win32.normalize(plan.targetWorkRoot).toLowerCase() !== path.win32.normalize(workRoot).toLowerCase())
		)
			throw new Error("Restore workspace plan does not match the Engine launch contour");
		const generation = await this.mutation("engine", async tx => {
			const previous = await tx.get<{ generation: number; store_epoch: string; snapshot_epoch: string }>(
				"metadata",
				"engine",
			);
			const value = {
				subtype: "engine",
				generation: Math.max((previous?.generation ?? 0) + 1, floor + 1),
				store_epoch: restoreEpoch ?? previous?.store_epoch ?? crypto.randomUUID(),
				snapshot_epoch: crypto.randomUUID(),
			};
			if (floorPath) {
				const temporary = `${floorPath}.${process.pid}.tmp`;
				await fs.mkdir(path.dirname(floorPath), { recursive: true });
				const handle = await fs.open(temporary, "wx");
				try {
					await handle.writeFile(String(value.generation));
					await handle.sync();
				} finally {
					await handle.close();
				}
				await fs.rename(temporary, floorPath);
			}
			await tx.put("metadata", "engine", value);
			const previousWorkspace = await tx.get<RestoreWorkspaceDescriptor>("metadata", "restore-workspace");
			if (plan) {
				await tx.put(
					"metadata",
					"restore-workspace",
					restoreDescriptor(previousWorkspace, plan, this.storageClient.incarnation),
				);
			} else if (restoreEpoch && previousWorkspace) {
				await tx.delete("metadata", "restore-workspace");
			} else if (
				previousWorkspace &&
				(previousWorkspace.restoreEpoch !== value.store_epoch ||
					!workRoot ||
					path.win32.normalize(previousWorkspace.targetWorkRoot).toLowerCase() !==
						path.win32.normalize(workRoot).toLowerCase())
			) {
				throw new Error("Retained restore workspace descriptor is incompatible with this Engine contour");
			}
			return value.generation;
		});
		return generation;
	}
	async isCurrentEngineGeneration(generation: number): Promise<boolean> {
		return (await this.records.get("metadata", "engine")).value?.generation === generation;
	}
	async getStoreEpoch(): Promise<string> {
		return String((await this.records.get("metadata", "engine")).value?.store_epoch ?? "");
	}
	async getSnapshotEpoch(): Promise<string> {
		return String((await this.records.get("metadata", "engine")).value?.snapshot_epoch ?? "");
	}
	#usageProbeKey(principalId: string, deviceId: string, accountRef: string): string {
		return `usage-probe-binding:${createHash("sha256").update(`${principalId}\0${deviceId}\0${accountRef}`).digest("hex")}`;
	}
	async getUsageProbeBinding(principalId: string, deviceId: string, accountRef: string) {
		const row = (await this.records.get("metadata", this.#usageProbeKey(principalId, deviceId, accountRef), true))
			.value as StorageUsageProbeBinding | null;
		if (row && (row.principal_id !== principalId || row.device_id !== deviceId || row.account_ref !== accountRef))
			throw new EngineTargetError("stale_target", "Usage binding owner differs");
		return { accountRef, modulePath: row?.module_path ?? null, revision: row?.revision ?? 0 };
	}
	async setUsageProbeBinding(principalId: string, deviceId: string, accountRef: string, expectedRevision: number, modulePath: string | null) {
		const key = this.#usageProbeKey(principalId, deviceId, accountRef);
		return this.mutation(key, async tx => {
			const current = await tx.get<StorageUsageProbeBinding>("metadata", key);
			if ((current?.revision ?? 0) !== expectedRevision ||
				(current && (current.principal_id !== principalId || current.device_id !== deviceId || current.account_ref !== accountRef)))
				throw new EngineTargetError("stale_target", "Usage binding revision changed");
			const revision = expectedRevision + 1;
			await tx.put("metadata", key, {
				subtype: "usage_probe_binding", principal_id: principalId, device_id: deviceId,
				account_ref: accountRef, module_path: modulePath, revision, updated_at: new Date().toISOString(),
			});
			return { accountRef, modulePath, revision };
		});
	}

	async getBinding(id: string): Promise<EngineBindingSnapshot | undefined> {
		const row = (await this.records.get("binding", id)).value as unknown as RocksBinding | null;
		return row ? bindingSnapshot(row) : undefined;
	}
	async chatIdentityId(ref: string, principalId: string): Promise<string> {
		const page = await this.records.query("identity_ref", [ref], undefined, 2);
		const identity = page.records[0]?.value as unknown as RocksIdentity | null;
		if (page.records.length !== 1 || identity?.agent_instance_ref !== ref || identity.principal_id !== principalId)
			throw new EngineTargetError("agent_not_found", "Unknown chat");
		return identity.agent_instance_id;
	}
	async chatLifecycleStatus(id: string, principalId: string) {
		const identity = (await this.records.get("identity", id)).value as unknown as RocksIdentity | null;
		if (!identity || identity.principal_id !== principalId)
			throw new EngineTargetError("agent_not_found", "Unknown chat");
		return {
			agentInstanceId: id,
			status: identity.deleted_at
				? ("deleted" as const)
				: identity.archived_at
					? ("archived" as const)
					: ("active" as const),
			revision: identity.lifecycle_revision ?? 0,
			operationId: identity.lifecycle_operation_id ?? null,
		};
	}
	async archivedChats(principalId: string, cursor?: string) {
		const page = await this.records.query("identity_principal", [principalId], cursor, 100);
		return {
			chats: page.records.flatMap(record => {
				const identity = record.value as unknown as RocksIdentity | null;
				return identity?.principal_id === principalId && identity.archived_at && !identity.deleted_at
					? [
							{
								agentInstanceId: identity.agent_instance_id,
								agentInstanceRef: identity.agent_instance_ref,
								summary: JSON.parse(identity.summary_json ?? "null"),
								revision: identity.lifecycle_revision ?? 0,
								archivedAt: identity.archived_at,
							},
						]
					: [];
			}),
			nextCursor: page.nextCursor,
		};
	}
	async chatLifecycle(
		id: string,
		principalId: string,
		action: "archive" | "unarchive" | "delete",
		operationId: string,
		expectedRevision: number,
	): Promise<{ status: "active" | "archived" | "deleted"; revision: number; operationId: string }> {
		validateRuntimeValue("id", id);
		validateRuntimeValue("id", operationId);
		const result = await this.mutation(id, async tx => {
			const identity = await tx.get<RocksIdentity>("identity", id);
			if (!identity || identity.principal_id !== principalId)
				throw new EngineTargetError("agent_not_found", "Unknown chat");
			const current = () => ({
				status: identity.deleted_at
					? ("deleted" as const)
					: identity.archived_at
						? ("archived" as const)
						: ("active" as const),
				revision: identity.lifecycle_revision ?? 0,
				operationId,
			});
			if (identity.lifecycle_operation_id === operationId) {
				if (identity.lifecycle_action !== action)
					throw new EngineTargetError("invalid_request", "Lifecycle operation ID was reused");
				return current();
			}
			if ((identity.lifecycle_revision ?? 0) !== expectedRevision)
				throw new EngineTargetError("stale_target", "Chat lifecycle revision changed");
			if (
				identity.deleted_at ||
				(action === "archive" && identity.archived_at) ||
				(action === "unarchive" && !identity.archived_at)
			)
				throw new EngineTargetError("invalid_request", "Chat lifecycle transition is unavailable");
			const binding = await tx.get<RocksBinding>("binding", id);
			if (binding) {
				const attempt = await tx.get<RocksAttempt>("attempt", binding.attempt_id);
				if (attempt && !terminal.has(attempt.state))
					throw new EngineTargetError("agent_busy", "Stop the active chat first");
			}
			if (action === "delete") {
				if (binding?.session_file && !binding.session_file.startsWith("native:"))
					throw new EngineTargetError("invalid_request", "Only native history can be deleted here");
				await tx.put("metadata", `native-delete-progress:${id}`, {
					subtype: "native_delete_progress",
					agent_instance_id: id,
					operation_id: operationId,
					deleted_at: Date.now(),
					session_file: binding?.session_file ?? null,
					after: null,
					complete: false,
				});
				for (const kind of ["pause", "stop", "recovery"]) await tx.delete("hold", `${id}:${kind}`);
			}
			const now = Date.now();
			await tx.put("identity", id, {
				...identity,
				archived_at: action === "archive" ? now : action === "unarchive" ? null : (identity.archived_at ?? null),
				deleted_at: action === "delete" ? now : (identity.deleted_at ?? null),
				lifecycle_revision: expectedRevision + 1,
				lifecycle_operation_id: operationId,
				lifecycle_action: action,
				intent_revision: identity.intent_revision + 1,
				updated_at: now,
			});
			return {
				status:
					action === "delete"
						? ("deleted" as const)
						: action === "archive"
							? ("archived" as const)
							: ("active" as const),
				revision: expectedRevision + 1,
				operationId,
			};
		});
		if (action === "delete") await this.reconcileDeletedNativeGenerations(id);
		return result;
	}

	/** Persist one bounded page before advancing the cursor; safe to resume after a crash. */
	async reconcileDeletedNativeGenerations(id: string): Promise<void> {
		interface DeleteProgress {
			subtype: "native_delete_progress";
			agent_instance_id: string;
			operation_id: string;
			deleted_at: number;
			session_file: string | null;
			after: [number, string] | null;
			complete: boolean;
		}
		for (;;) {
			const progress = (await this.records.get("metadata", `native-delete-progress:${id}`, true))
				.value as DeleteProgress | null;
			if (!progress || progress.complete) return;
			const page = await this.records.query("attempt_agent", [id], undefined, 16, progress.after ?? undefined, true);
			const candidates = new Map<string, { familyId: string; generationId: string }>();
			const include = (familyId: string, generationId: string) => {
				if (!familyId || !generationId) throw new Error("Native delete encountered an invalid generation");
				candidates.set(`${familyId}\0${generationId}`, { familyId, generationId });
			};
			if (!progress.after && progress.session_file) {
				const { familyId, generationId } = parseNativeSessionLocator(progress.session_file);
				include(familyId, generationId);
			}
			for (const row of page.records) {
				const native = (row.value as unknown as RocksAttempt | null)?.transcript_native;
				if (native) include(native.familyId, native.generationId);
			}
			const eligible: Array<{ familyId: string; generationId: string }> = [];
			for (const candidate of candidates.values()) {
				const locator = `native:${encodeURIComponent(candidate.familyId)}/${encodeURIComponent(candidate.generationId)}`;
				const bindings = await this.records.query("binding_session", [locator], undefined, 100, undefined, true);
				if (bindings.nextCursor || bindings.records.some(row => row.value?.agent_instance_id !== id)) continue;
				eligible.push(candidate);
			}
			await this.mutation(id, async tx => {
				const current = await tx.get<DeleteProgress>("metadata", `native-delete-progress:${id}`);
				if (!current || current.complete || JSON.stringify(current.after) !== JSON.stringify(progress.after))
					return;
				for (const { familyId, generationId } of eligible) {
					const digest = createHash("sha256").update(`${familyId}\0${generationId}`).digest("hex");
					await tx.put("metadata", `native-delete:${digest}`, {
						subtype: "native_tombstone",
						family_id: familyId,
						generation_id: generationId,
						agent_instance_id: id,
						operation_id: progress.operation_id,
						deleted_at: progress.deleted_at,
					});
				}
				const last = page.records.at(-1);
				const createdAt = last?.value?.created_at;
				if (last && (!Number.isSafeInteger(createdAt) || Number(createdAt) < 0))
					throw new Error("Native delete attempt cursor is invalid");
				await tx.put("metadata", `native-delete-progress:${id}`, {
					...current,
					after: last ? [Number(createdAt), last.id] : current.after,
					complete: page.nextCursor === null,
				});
			});
		}
	}
	/** An unbound prepared generation goes to reclaim like a deleted one. Its tombstone names no agent, so reclaim
	 * removes only this generation and never the agent's runtime rows. */
	async abandonNativeGeneration(scope: string, locator: string): Promise<void> {
		const { familyId, generationId } = parseNativeSessionLocator(locator);
		const digest = createHash("sha256").update(`${familyId}\0${generationId}`).digest("hex");
		await this.mutation(scope, tx =>
			tx.put("metadata", `native-delete:${digest}`, {
				subtype: "native_tombstone",
				family_id: familyId,
				generation_id: generationId,
				deleted_at: Date.now(),
			}),
		);
	}
	async getAttempt(id: string): Promise<RocksAttempt | undefined> {
		return ((await this.records.get("attempt", id)).value as unknown as RocksAttempt) ?? undefined;
	}
	async getAttemptTarget(id: string): Promise<RocksAttempt | undefined> {
		return this.getAttempt(id);
	}
	async getEffect(id: string): Promise<RocksEffect | undefined> {
		return ((await this.records.get("effect", id)).value as unknown as RocksEffect) ?? undefined;
	}
	async getApproval(id: string): Promise<EngineApprovalRow | undefined> {
		return ((await this.records.get("approval", id)).value as unknown as EngineApprovalRow) ?? undefined;
	}
	async getStartConversationIdentity(id: string): Promise<EngineCommandIdentity | undefined> {
		return ((await this.records.get("command", id)).value as unknown as RocksCommand | null)?.identity;
	}

	/** Destination-only delivery proof. Public outcome_unknown is deliberately not evidence of absence. */
	async approvalDelivery(
		command: EngineCommandIdentity,
		decision: ApprovalDecision,
		expectedInputRevision: number | undefined,
		processorGeneration: number,
	): Promise<{ status: "absent" } | { status: "settled"; identity: EngineCommandIdentity; receipt: EngineCommandReceipt }> {
		validateRuntimeValue("approvalDecision", decision);
		if (command.operation !== "resolve_approval" || decision.command_id !== command.commandId ||
			!command.attemptId || !command.principalId || decision.decided_by.principal_id !== command.principalId ||
			(expectedInputRevision !== undefined && (!Number.isSafeInteger(expectedInputRevision) || expectedInputRevision < 0)))
			throw new EngineTargetError("invalid_request", "Approval delivery requires its exact decision and input revision");
		return this.mutation(command.agentInstanceId, async tx => {
			if ((await tx.get<{ generation: number }>("metadata", "engine"))?.generation !== processorGeneration)
				throw new EngineTargetError("stale_target", "Approval delivery processor generation changed");
			const agent = await tx.get<RocksIdentity>("identity", command.agentInstanceId);
			const binding = await tx.get<RocksBinding>("binding", command.agentInstanceId);
			const attempt = await tx.get<RocksAttempt>("attempt", command.attemptId!);
			if (!this.#installation || this.#installation.principalId !== command.principalId ||
				!agent || agent.principal_id !== command.principalId || agent.agent_instance_ref !== command.agentInstanceRef ||
				agent.deleted_at || agent.archived_at || !binding || !attempt ||
				binding.binding_snapshot?.installationId !== this.#installation.installationId ||
				binding.binding_snapshot.agentInstanceRef !== command.agentInstanceRef ||
				!attempt.binding_snapshot || !sameSemanticBinding(attempt.binding_snapshot, binding.binding_snapshot) ||
				binding.attempt_id !== command.attemptId || attempt.agent_instance_id !== command.agentInstanceId ||
				binding.execution_id !== command.executionId || attempt.execution_id !== command.executionId ||
				binding.binding_id !== command.bindingId || attempt.binding_id !== command.bindingId ||
				binding.binding_generation !== command.bindingGeneration || attempt.binding_generation !== command.bindingGeneration ||
				binding.authority_generation !== command.authorityGeneration || attempt.authority_generation !== command.authorityGeneration ||
				(command.bindingSnapshot && !sameSemanticBinding(command.bindingSnapshot, binding.binding_snapshot)))
				throw new EngineTargetError("stale_target", "Approval delivery is not on its current destination installation and Attempt");
			const admitted = await tx.get<RocksCommand>("command", command.commandId);
			if (admitted) {
				if (admitted.canonical_hash !== command.canonicalHash) throw new EngineCommandConflictError(command.commandId);
				if (admitted.state !== "settled" || !admitted.receipt || !admitted.identity.serializedCommand)
					throw new EngineTargetError("admission_state_unknown", "Approval command admission is not settled");
				return { status: "settled", identity: admitted.identity, receipt: admitted.receipt };
			}
			if (await tx.revision("command", command.commandId) !== 0)
				throw new EngineTargetError("admission_state_unknown", "Approval command history was removed");
			// Reclaim/restore or a missing history row alone cannot prove never-admitted. Reconcile with
			// the retained applied Start and the still-undecided effect, whose decision settles atomically.
			const start = await tx.get<RocksCommand>("command", attempt.command_id);
			const approval = await tx.get<EngineApprovalRow>("approval", decision.request_id);
			const effect = approval && await tx.get<RocksEffect>("effect", approval.request.effect_id);
			if (binding.engine_generation !== processorGeneration || attempt.engine_generation !== processorGeneration ||
				terminal.has(attempt.state) || start?.operation !== "start" || start.state !== "settled" ||
				start.receipt?.outcome !== "applied" || start.identity.attemptId !== command.attemptId ||
				start.identity.principalId !== command.principalId ||
				start.identity.agentInstanceId !== command.agentInstanceId || !start.identity.bindingSnapshot ||
				!sameSemanticBinding(start.identity.bindingSnapshot, binding.binding_snapshot) ||
				!approval || approval.state !== "pending" || approval.decision_record ||
				!["pending", "waiting_human_paused"].includes(approval.request.status) ||
				approval.request.requester_attempt_id !== command.attemptId ||
				approval.request.requester_agent_ref !== command.agentInstanceRef ||
				approval.request.principal_id !== command.principalId ||
				approval.request.requester_binding_revision !== binding.binding_snapshot.bindingRevision ||
				approval.request.address_revision !== decision.expected_address_revision ||
				approval.request.decision_revision !== decision.expected_decision_revision ||
				(expectedInputRevision !== undefined && attempt.input_revision !== expectedInputRevision) ||
				!effect || effect.command_id !== attempt.command_id || effect.attempt_id !== command.attemptId ||
				!this.sameFence(effect, bindingSnapshot(binding)) ||
				effect.state !== (approval.request.kind === "escalation" ? "started" : "planned"))
				throw new EngineTargetError("stale_target", "Approval absence cannot be reconciled with its pending native effect");
			return { status: "absent" };
		});
	}
	async agentInstanceIdForEngineAgent(id: string): Promise<string | undefined> {
		return (await this.records.query("binding_engine_agent", [id])).records[0]?.value?.agent_instance_id as
			| string
			| undefined;
	}

	async counter(tx: RuntimeTransaction, id: string, subtype: string, delta: number): Promise<number> {
		const row = await tx.get<{ count: number }>("metadata", id);
		const count = (row?.count ?? 0) + delta;
		if (!Number.isSafeInteger(count) || count < 0)
			throw new EngineTargetError("invalid_request", "Runtime counter is invalid");
		await tx.put("metadata", id, { subtype, count });
		return count;
	}
	async assertFence(tx: RuntimeTransaction, target: EventTarget): Promise<void> {
		const engine = await tx.get<{ generation: number }>("metadata", "engine");
		if (engine?.generation !== target.engineGeneration)
			throw new EngineTargetError("stale_target", "Engine generation changed");
		const binding = await tx.get<RocksBinding>("binding", target.agentInstanceId);
		if (binding && !this.sameFence(binding, target)) throw new EngineAttemptConflictError(target.attemptId);
	}
	sameFence(
		row: Pick<
			RocksBinding,
			| "agent_instance_id"
			| "execution_id"
			| "attempt_id"
			| "binding_id"
			| "engine_generation"
			| "binding_generation"
			| "authority_generation"
		>,
		target: EventTarget,
	): boolean {
		return (
			row.agent_instance_id === target.agentInstanceId &&
			row.execution_id === target.executionId &&
			row.attempt_id === target.attemptId &&
			row.binding_id === target.bindingId &&
			row.engine_generation === target.engineGeneration &&
			row.binding_generation === target.bindingGeneration &&
			row.authority_generation === target.authorityGeneration
		);
	}
	async registerAgent(identity: AgentIdentity): Promise<void> {
		await this.mutation(identity.agentInstanceId, tx => this.register(tx, identity));
	}
	async register(tx: RuntimeTransaction, input: AgentIdentity): Promise<void> {
		let identity = input;
		if (identity.parentAgentInstanceId === identity.agentInstanceId)
			throw new EngineTargetError("invalid_request", "AgentInstance cannot be its own parent");
		const existing = await tx.get<RocksIdentity>("identity", identity.agentInstanceId);
		if (
			existing &&
			!existing.parent_agent_instance_id &&
			identity.parentAgentInstanceId &&
			existing.membership_revision > 0
		)
			throw new EngineTargetError("stale_target", "An existing branch cannot be reparented by registration");
		let parent: RocksIdentity | undefined;
		if (identity.parentAgentInstanceId) {
			parent = await tx.get<RocksIdentity>("identity", identity.parentAgentInstanceId);
			if (parent?.principal_id) {
				if (identity.principalId && identity.principalId !== parent.principal_id)
					throw new EngineTargetError("stale_target", "Child ownership must match parent");
				identity = { ...identity, principalId: parent.principal_id };
			}
		}
		if (
			existing &&
			((identity.agentInstanceRef &&
				existing.agent_instance_ref &&
				identity.agentInstanceRef !== existing.agent_instance_ref) ||
				(identity.principalId && existing.principal_id && existing.principal_id !== identity.principalId) ||
				(identity.parentAgentInstanceId &&
					existing.parent_agent_instance_id &&
					identity.parentAgentInstanceId !== existing.parent_agent_instance_id))
		)
			throw new EngineTargetError("stale_target", "AgentInstance identity is immutable");
		const completingIdentity =
			!existing ||
			(!existing.agent_instance_ref && identity.agentInstanceRef) ||
			(!existing.parent_agent_instance_id && identity.parentAgentInstanceId);
		if (completingIdentity) {
			// A checked registry guard protects alias/ancestry empty predicates from concurrent registration.
			// Every registration writes this one row, so it commits under the event chain like a counter:
			// optimistic retries alone exhaust their budget when several agents register at once.
			tx.sequence("engine");
			const engine = await tx.get<{ subtype: string; generation: number; identity_revision?: number }>(
				"metadata",
				"engine",
			);
			if (!engine) throw new Error("Engine generation must be initialized before registration");
			await tx.put("metadata", "engine", { ...engine, identity_revision: (engine.identity_revision ?? 0) + 1 });
			if (identity.agentInstanceRef) {
				const aliases = await tx.query<RocksIdentity>("identity_ref", [identity.agentInstanceRef]);
				if (aliases.some(row => row.agent_instance_id !== identity.agentInstanceId))
					throw new EngineTargetError("stale_target", "Canonical identity already has a native identity");
			}
			const ancestors = new Set([identity.agentInstanceId]);
			let ancestor = parent;
			while (ancestor) {
				if (ancestors.has(ancestor.agent_instance_id) || ancestors.size > 64)
					throw new EngineTargetError("invalid_request", "Invalid or excessive AgentInstance ancestry");
				ancestors.add(ancestor.agent_instance_id);
				ancestor = ancestor.parent_agent_instance_id
					? await tx.get<RocksIdentity>("identity", ancestor.parent_agent_instance_id)
					: undefined;
			}
			if (parent && !existing?.parent_agent_instance_id)
				await tx.put("identity", parent.agent_instance_id, {
					...parent,
					membership_revision: parent.membership_revision + 1,
				});
		}
		const row: RocksIdentity = {
			agent_instance_id: identity.agentInstanceId,
			agent_instance_ref: identity.agentInstanceRef ?? "",
			parent_agent_instance_id: identity.parentAgentInstanceId ?? null,
			parent_agent_instance_ref: identity.parentAgentInstanceRef ?? null,
			principal_id: identity.principalId ?? "",
			authority_generation: identity.authorityGeneration,
			intent_revision: 0,
			queue_revision: 0,
			queue_pending_count: 0,
			root_agent_instance_ref: parent?.root_agent_instance_ref || identity.agentInstanceRef || "",
			summary_revision: 0,
			summary_json: null,
			membership_revision: 0,
			created_at: Date.now(),
			updated_at: Date.now(),
			...existing,
		};
		row.agent_instance_ref ||= identity.agentInstanceRef ?? "";
		row.parent_agent_instance_id ??= identity.parentAgentInstanceId ?? null;
		row.parent_agent_instance_ref ??= identity.parentAgentInstanceRef ?? null;
		row.principal_id ||= identity.principalId ?? "";
		row.root_agent_instance_ref ||= parent?.root_agent_instance_ref || row.agent_instance_ref;
		if (identity.parentAgentInstanceId && !existing?.parent_agent_instance_id)
			row.root_agent_instance_ref =
				parent?.root_agent_instance_ref || identity.parentAgentInstanceRef || row.agent_instance_ref;
		row.authority_generation = Math.max(row.authority_generation, identity.authorityGeneration);
		await tx.put("identity", identity.agentInstanceId, row);
		if (!existing && row.agent_instance_ref)
			await this.identityEvent(
				tx,
				row.agent_instance_id,
				`register:${row.agent_instance_id}`,
				"agent_registered",
				{},
			);
	}
	async holds(tx: RuntimeTransaction, id: string): Promise<EngineBranchHold[]> {
		const result: EngineBranchHold[] = [];
		const seen = new Set<string>();
		while (id) {
			if (seen.has(id) || seen.size >= 64)
				throw new EngineTargetError("invalid_request", "Invalid AgentInstance ancestry");
			seen.add(id);
			const identity = await tx.get<RocksIdentity>("identity", id);
			for (const kind of ["pause", "stop", "recovery"] as const) {
				const hold = await tx.get<RocksHold>("hold", `${id}:${kind}`);
				if (hold)
					result.push({
						sourceAgentInstanceId: id,
						sourceAgentInstanceRef: identity?.agent_instance_ref ?? "",
						kind,
						commandId: hold.command_id,
						generation: hold.generation,
					});
			}
			id = identity?.parent_agent_instance_id ?? "";
		}
		return result;
	}
	async checkIntent(tx: RuntimeTransaction, id: string, expected?: number, unheld = false): Promise<void> {
		const row = await tx.get<RocksIdentity>("identity", id);
		if (row?.deleted_at || row?.archived_at)
			throw new EngineTargetError("stale_target", "Chat is archived or deleted");
		if (expected !== undefined && (row?.intent_revision ?? 0) !== expected)
			throw new EngineTargetError("stale_target", "AgentInstance intent revision changed");
		if (unheld && (await this.holds(tx, id)).length)
			throw new EngineTargetError("agent_busy", "AgentInstance branch is held");
	}
	async intent(id: string) {
		const tx = new RuntimeTransaction(this.records);
		const row = await tx.get<RocksIdentity>("identity", id);
		const holds = await this.holds(tx, id);
		return {
			intentRevision: row?.intent_revision ?? 0,
			manualHold: holds.length > 0,
			holds: holds.slice(0, runtimeLimits.httpPageRecords),
			holdsHasMore: holds.length > runtimeLimits.httpPageRecords,
		};
	}
	async assertIntent(id: string, expected?: number, unheld = false): Promise<void> {
		await this.checkIntent(new RuntimeTransaction(this.records), id, expected, unheld);
	}

	async pendingBudget(
		tx: RuntimeTransaction,
		agent: string,
		control: boolean,
		countDelta: number,
		bytesDelta: number,
	): Promise<void> {
		for (const scope of control ? ["device"] : ["device", agent]) {
			const id = `budget:${control ? "control" : "ordinary"}:${scope}`;
			const old = await tx.get<{ count: number; bytes: number }>("metadata", id);
			const count = (old?.count ?? 0) + countDelta;
			const bytes = (old?.bytes ?? 0) + bytesDelta;
			const maxCount = control
				? runtimeLimits.controlPendingRecords
				: scope === "device"
					? runtimeLimits.devicePendingRecords
					: runtimeLimits.agentPendingRecords;
			const maxBytes = control
				? runtimeLimits.controlPendingBytes
				: scope === "device"
					? runtimeLimits.devicePendingBytes
					: runtimeLimits.agentPendingBytes;
			if (count < 0 || bytes < 0) throw new Error("Runtime admission budget underflow");
			if (count > maxCount || bytes > maxBytes)
				throw new EngineTargetError("queue_full", "Pending admission budget is full");
			await tx.put("metadata", id, { subtype: "pending_budget", count, bytes, scope, control });
		}
	}
	async admitCommand(command: EngineCommandIdentity, processorGeneration: number): Promise<EngineCommandAdmission> {
		if (command.operation === "resume" && command.engineGeneration < processorGeneration)
			await this.cancelResumeQueues(command.commandId, command.canonicalHash, processorGeneration);
		return this.mutation(command.agentInstanceId, async tx => {
			if ((await tx.get<{ generation: number }>("metadata", "engine"))?.generation !== processorGeneration)
				throw new EngineTargetError("stale_target", "Command processor generation changed");
			const old = await tx.get<RocksCommand>("command", command.commandId);
			const ownedStart = command.operation === "start" && Boolean(command.bindingSnapshot?.installationId);
			if (!old && ownedStart && command.bindingSnapshot?.installationId !== this.#installation?.installationId)
				return { status: "binding_pending" };
			if (old) {
				if (old.canonical_hash !== command.canonicalHash) throw new EngineCommandConflictError(command.commandId);
				if (old.state === "settled") {
					if (!old.receipt) throw new Error("Settled command has no receipt");
					return { status: "replay", receipt: boundedReceipt(old.receipt) };
				}
				if (command.operation === "start" && command.bindingSnapshot) {
					try {
						await this.assertSemanticStart(tx, command.agentInstanceId, command.bindingSnapshot, command.principalId);
					} catch (error) {
						if (!(error instanceof EngineBindingPendingError)) throw error;
						if (!old.binding_pending || old.processor_generation !== null)
							await tx.put("command", command.commandId, { ...old, binding_pending: true, processor_generation: null });
						return { status: "binding_pending" };
					}
					if (old.binding_pending) {
						if (old.processor_generation === processorGeneration) return { status: "in_progress" };
						await tx.put("command", command.commandId, { ...old, processor_generation: processorGeneration });
						return { status: "claimed" };
					}
				}
				if (old.processor_generation === processorGeneration) return { status: "in_progress" };
				if (old.processor_generation !== null && old.operation === "resume") {
					const parsed: unknown = JSON.parse(old.identity.serializedCommand ?? "{}");
					const payload = parsed && typeof parsed === "object" && "payload" in parsed ? parsed.payload : undefined;
					if (payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string")
						throw new EngineTargetError("agent_busy", "Interrupted Resume awaits exact native-history recovery");
				}
				if (old.processor_generation !== null || command.engineGeneration < processorGeneration) {
					return {
						status: "replay",
						receipt: await this.settleInterrupted(tx, command.commandId, processorGeneration),
					};
				}
				await tx.put("command", command.commandId, {
					...old,
					processor_generation: processorGeneration,
					updated_at: Date.now(),
				});
				return { status: "claimed" };
			}
			// Never let an old envelope win the gap between destination lookup and Core rebind.
			// Settled exact replays above retain their original generation.
			if (command.operation === "resolve_approval" && command.engineGeneration !== processorGeneration)
				throw new EngineTargetError("stale_target", "Unadmitted approval requires the current Engine generation");
			if (command.operation === "start" && command.agentInstanceRef && !command.bindingSnapshot)
				throw new EngineTargetError("invalid_request", "New Start requires an admitted bindingSnapshot");
			const lifecycle = await tx.get<RocksIdentity>("identity", command.agentInstanceId);
			if (command.operation === "start" && lifecycle?.agent_instance_ref && !command.bindingSnapshot)
				throw new EngineTargetError("invalid_request", "Hosted Agent Start requires its admitted bindingSnapshot");
			if (lifecycle?.deleted_at || lifecycle?.archived_at)
				throw new EngineTargetError("stale_target", "Chat is archived or deleted");
			let bindingPending = false;
			if (command.bindingSnapshot) {
				if (command.operation === "start") {
					validateSemanticBinding(command.bindingSnapshot, command.agentInstanceRef ?? "");
					try {
						await this.assertSemanticStart(tx, command.agentInstanceId, command.bindingSnapshot, command.principalId);
					} catch (error) {
						if (!(error instanceof EngineBindingPendingError)) throw error;
						bindingPending = true;
					}
					const prior = await tx.get<RocksBinding>("binding", command.agentInstanceId);
					if (prior?.binding_snapshot?.bindingRevision === 0 &&
						!sameSemanticBinding(prior.binding_snapshot, command.bindingSnapshot))
						throw new EngineTargetError("stale_target", "Legacy binding is immutable");
				} else if (command.attemptId) {
					const attempt = await tx.get<RocksAttempt>("attempt", command.attemptId);
					if (attempt?.binding_snapshot && !sameSemanticBinding(attempt.binding_snapshot, command.bindingSnapshot))
						throw new EngineTargetError("stale_target", "Control snapshot differs from the admitted Attempt");
				}
			}
			const control = Object.hasOwn(ENGINE_CONTROL_OPS, command.operation);
			const bytes = Buffer.byteLength(command.serializedCommand ?? "");
			await this.pendingBudget(tx, command.agentInstanceId, control, 1, bytes);
			await this.register(tx, command);
			await tx.put("command", command.commandId, {
				command_id: command.commandId,
				agent_instance_id: command.agentInstanceId,
				processor_generation: bindingPending ? null : processorGeneration,
				state: "received",
				canonical_hash: command.canonicalHash,
				payload_bytes: bytes,
				control_admission: control ? 1 : 0,
				engine_generation: command.engineGeneration,
				operation: command.operation,
				identity: command,
				receipt: null,
				received_at: Date.now(),
				updated_at: Date.now(),
				pending_accounted: true,
				binding_pending: bindingPending || (ownedStart && command.engineGeneration < processorGeneration),
			} satisfies RocksCommand);
			if (command.operation === "start") {
				const cancelled = await tx.get<StartCancellation>("metadata", `start-cancellation:${command.commandId}`);
				if (cancelled) {
					const admitted = (await tx.get<RocksCommand>("command", command.commandId))!;
					this.validateStartTarget(admitted, cancelled.target);
					const receipt: EngineCommandReceipt = {
						outcome: "rejected",
						detail: {
							code: "cancelled",
							message: "Exact Start was cancelled before admission",
							cancellationCommandId: cancelled.cancellationCommandId,
						},
					};
					await this.settle(tx, command.commandId, receipt);
					return { status: "replay", receipt };
				}
			}
			if (bindingPending) return { status: "binding_pending" };
			if (command.browserPayloadHash) await this.receiptEvent(tx, command.commandId);
			if (command.engineGeneration < processorGeneration && !ownedStart) {
				return {
					status: "replay",
					receipt: await this.settleInterrupted(tx, command.commandId, processorGeneration),
				};
			}
			return { status: "claimed" };
		});
	}
	async acceptedResumeMessage(command: RocksCommand): Promise<boolean | "unknown"> {
		if (command.operation !== "resume" || !command.identity.serializedCommand) return false;
		const envelope = JSON.parse(command.identity.serializedCommand) as {
			payload?: { text?: unknown; clientMessageId?: unknown };
		};
		if (typeof envelope.payload?.text !== "string" || typeof envelope.payload.clientMessageId !== "string")
			return false;
		const binding = await this.getBinding(command.agent_instance_id);
		if (!binding?.sessionFile || binding.attemptId !== command.identity.attemptId ||
			binding.bindingId !== command.identity.bindingId ||
			binding.bindingGeneration !== command.identity.bindingGeneration ||
			binding.engineGeneration !== command.identity.engineGeneration ||
			binding.authorityGeneration !== command.identity.authorityGeneration)
			return "unknown";
		const { familyId, generationId } = parseNativeSessionLocator(binding.sessionFile);
		const session = await SessionManager.openNative(
			new RocksNativeSessionStorage(this.storageClient, familyId, generationId),
		);
		return session.getContextBranch().some(entry =>
			entry.type === "message" && entry.message.role === "user" &&
				entry.clientMessageId === envelope.payload?.clientMessageId
		);
	}

	/** An interrupted command never runs: settle it and publish its rejection like any other refused command. */
	async settleInterrupted(
		tx: RuntimeTransaction,
		id: string,
		generation: number,
		messageAcceptance: boolean | "unknown" = false,
	): Promise<EngineCommandReceipt> {
		const receipt = {
			outcome: "rejected" as const,
			detail: messageAcceptance === true
				? {
						code: "message_accepted_resume_unknown",
						message: "User message was accepted before interruption; this Attempt cannot resume after restart",
						requiresExplicitContinue: true,
					}
				: messageAcceptance === "unknown"
					? {
							code: "resume_message_outcome_unknown",
							message: "Interrupted Resume message acceptance could not be verified",
							requiresExplicitContinue: true,
						}
					: {
							code: "interrupted",
							message: "Execution was interrupted; explicit Continue is required",
							requiresExplicitContinue: true,
						},
		};
		await this.settle(tx, id, receipt);
		const { identity: command } = (await tx.get<RocksCommand>("command", id))!;
		await this.append(
			tx,
			{
				commandId: id,
				agentInstanceId: command.agentInstanceId,
				executionId: command.executionId ?? "",
				attemptId: command.attemptId ?? "",
				bindingId: command.bindingId ?? "",
				engineGeneration: generation,
				bindingGeneration: command.bindingGeneration ?? 0,
				authorityGeneration: command.authorityGeneration,
			},
			{ kind: "rejected", payload: receipt.detail, causationCommandId: id },
		);
		return receipt;
	}
	startExpected(command: EngineCommandIdentity): number | undefined {
		if (!command.serializedCommand) return undefined;
		const value = JSON.parse(command.serializedCommand) as { payload?: { expectedIntentRevision?: number } };
		return value.payload?.expectedIntentRevision;
	}
	validateStartTarget(command: RocksCommand, target: EnginePendingStartTarget): void {
		const identity = command.identity;
		if (
			command.operation !== "start" ||
			identity.agentInstanceId !== target.agentInstanceId ||
			identity.executionId !== target.executionId ||
			identity.attemptId !== target.attemptId ||
			identity.authorityGeneration !== target.authorityGeneration ||
			identity.engineGeneration > target.engineGeneration ||
			(target.principalId !== undefined && identity.principalId !== target.principalId) ||
			(target.expectedStartIntentRevision !== undefined &&
				this.startExpected(identity) !== target.expectedStartIntentRevision)
		)
			throw new EngineTargetError("stale_target", "Start cancellation reference does not match immutable target");
	}
	async targetStart(tx: RuntimeTransaction, target: EnginePendingStartTarget): Promise<RocksCommand | undefined> {
		const command = target.pendingStartCommandId
			? await tx.get<RocksCommand>("command", target.pendingStartCommandId)
			: (await tx.query<RocksCommand>("command_agent_pending", [target.agentInstanceId])).find(
					row =>
						row.operation === "start" &&
						row.identity.executionId === target.executionId &&
						row.identity.attemptId === target.attemptId,
				);
		if (command) this.validateStartTarget(command, target);
		return command;
	}
	async cancelRevision(
		tx: RuntimeTransaction,
		target: EnginePendingStartTarget,
		start?: RocksCommand,
	): Promise<number | undefined> {
		if (!validateStartFence(target)) return target.expectedIntentRevision;
		const identity = await tx.get<RocksIdentity>("identity", target.agentInstanceId);
		const current = identity?.intent_revision ?? -1;
		if (
			target.expectedIntentRevision === current ||
			(start &&
				target.expectedIntentRevision === target.expectedStartIntentRevision &&
				start.start_applied_intent_revision === current)
		)
			return current;
		throw new EngineTargetError("stale_target", "Intent changed after exact Start admission");
	}
	async cancelPendingStart(
		target: EnginePendingStartTarget,
		cancellationCommandId: string,
	): Promise<EnginePendingStartCancellation> {
		return this.mutation(target.agentInstanceId, async tx => {
			const fenced = validateStartFence(target);
			const start = await this.targetStart(tx, target);
			// A Start already applied has left the pending index: its Attempt exists, so the Stop is too late here.
			if (!start && !fenced)
				return (await tx.get<RocksAttempt>("attempt", target.attemptId))
					? { status: "too_late" }
					: { status: "not_found" };
			if (start?.state === "settled")
				return start.receipt?.outcome === "rejected" && start.receipt.detail?.code === "cancelled"
					? {
							status: "already_cancelled",
							intentRevision:
								(await tx.get<RocksIdentity>("identity", target.agentInstanceId))?.intent_revision ?? 0,
						}
					: { status: "too_late" };
			const expected = await this.cancelRevision(tx, target, start);
			if (fenced) {
				const key = `start-cancellation:${target.pendingStartCommandId}`;
				const old = await tx.get<StartCancellation>("metadata", key);
				if (
					old &&
					(old.target.agentInstanceId !== target.agentInstanceId ||
						old.target.executionId !== target.executionId ||
						old.target.attemptId !== target.attemptId ||
						old.target.authorityGeneration !== target.authorityGeneration ||
						old.target.principalId !== target.principalId ||
						old.target.expectedStartIntentRevision !== target.expectedStartIntentRevision)
				)
					throw new EngineTargetError("stale_target", "Start cancellation identity already bound");
				if (!old)
					await tx.put("metadata", key, {
						subtype: "start_cancellation",
						target,
						cancellationCommandId,
					} satisfies StartCancellation);
			}
			const held = await this.changeIntent(tx, target.agentInstanceId, cancellationCommandId, "stop", expected);
			if (!start) return { status: "cancelled", intentRevision: held.intentRevision };
			const detail = {
				code: "cancelled",
				message: "Attempt cancelled before Engine session initialization",
				cancellationCommandId,
			};
			await this.settle(tx, start.command_id, { outcome: "rejected", detail }, start.canonical_hash, true);
			const event = await this.append(
				tx,
				{ ...target, commandId: start.command_id, bindingId: "", bindingGeneration: 0 },
				{ kind: "rejected", payload: detail },
			);
			return { status: "cancelled", intentRevision: held.intentRevision, event };
		});
	}
	async releaseCommand(id: string, hash: string, processor: number): Promise<void> {
		await this.mutation(`command:${id}`, async tx => {
			const row = await tx.get<RocksCommand>("command", id);
			if (row?.state === "received" && row.canonical_hash === hash && row.processor_generation === processor)
				await tx.put("command", id, { ...row, processor_generation: null });
		});
	}
	async canRearmBindingStart(id: string, processor: number): Promise<boolean> {
		const row = (await this.records.get("command", id, true)).value as unknown as RocksCommand | undefined;
		return Boolean(row?.binding_pending && row.operation === "start" && row.state === "received" &&
			row.processor_generation === processor && row.identity.attemptId &&
			!(await this.records.get("attempt", row.identity.attemptId, true)).value);
	}
	async settleCommand(id: string, hash: string, receipt: EngineCommandReceipt): Promise<void> {
		if (receipt.outcome === "rejected") await this.cancelResumeQueues(id, hash);
		await this.mutation(`command:${id}`, tx => this.settle(tx, id, receipt, hash, true));
	}
	/** Terminal receipt for a command whose admission keeps failing; the row and receipt commit together. */
	async rejectUnadmittedCommand(
		command: EngineCommandIdentity,
		receipt: EngineCommandReceipt & { outcome: "rejected" },
		processorGeneration: number,
	): Promise<void> {
		if (command.operation === "resume") await this.cancelResumeQueues(command.commandId, command.canonicalHash, processorGeneration);
		await this.mutation(command.agentInstanceId, async tx => {
			if ((await tx.get<{ generation: number }>("metadata", "engine"))?.generation !== processorGeneration)
				throw new EngineTargetError("stale_target", "Command processor generation changed");
			const old = await tx.get<RocksCommand>("command", command.commandId);
			if (old?.state === "settled") return;
			if (old && old.processor_generation !== null)
				throw new Error(`Command ${command.commandId} is being processed`);
			if (!old) {
				if (command.operation === "resolve_approval" && command.engineGeneration !== processorGeneration)
					throw new EngineTargetError("stale_target", "Old approval delivery cannot create a rejection receipt");
				// Never admitted: it holds no pending budget, so settling releases nothing.
				await tx.put("command", command.commandId, {
					command_id: command.commandId,
					agent_instance_id: command.agentInstanceId,
					processor_generation: null,
					state: "received",
					canonical_hash: command.canonicalHash,
					payload_bytes: Buffer.byteLength(command.serializedCommand ?? ""),
					control_admission: Object.hasOwn(ENGINE_CONTROL_OPS, command.operation) ? 1 : 0,
					engine_generation: command.engineGeneration,
					operation: command.operation,
					identity: command,
					receipt: null,
					received_at: Date.now(),
					updated_at: Date.now(),
					pending_accounted: false,
				} satisfies RocksCommand);
			}
			// Settle before the event: its summary must no longer project this Start as pending.
			await this.settle(tx, command.commandId, receipt, command.canonicalHash, true);
			if (
				command.operation === "start" &&
				command.executionId &&
				command.attemptId &&
				!(await tx.get<RocksAttempt>("attempt", command.attemptId))
			)
				await this.append(
					tx,
					{
						commandId: command.commandId,
						agentInstanceId: command.agentInstanceId,
						executionId: command.executionId,
						attemptId: command.attemptId,
						bindingId: "",
						engineGeneration: processorGeneration,
						bindingGeneration: 0,
						authorityGeneration: command.authorityGeneration,
					},
					{ kind: "rejected", payload: receipt.detail, causationCommandId: command.commandId },
				);
		});
	}
	async settle(
		tx: RuntimeTransaction,
		id: string,
		receipt: EngineCommandReceipt,
		hash?: string,
		required = false,
	): Promise<void> {
		let row = await tx.get<RocksCommand>("command", id);
		if (!row) {
			if (required) throw new Error(`Command ${id} was not admitted`);
			return;
		}
		if (hash && hash !== row.canonical_hash) throw new EngineCommandConflictError(id);
		if (row.state === "settled") {
			// The owner returns rows with canonically ordered keys; an identical receipt may differ only in order.
			if (storageCanonicalJson(row.receipt) !== storageCanonicalJson(receipt))
				throw new EngineCommandConflictError(id, "receipt");
			return;
		}
		if (row.operation === "start" && row.routing?.action === "enqueue" && row.identity.attemptId &&
			row.identity.agentInstanceRef && row.identity.principalId) {
			await stageQueueCancel(tx, {
				principalId: row.identity.principalId,
				deviceId: row.identity.deviceId,
				commandId: id,
				agentInstanceRef: row.identity.agentInstanceRef,
				attemptId: row.identity.attemptId,
			}, receipt.outcome === "rejected" ? "refused" : "cancelled",
			String(receipt.detail?.code ?? "command_settled"));
			row = (await tx.get<RocksCommand>("command", id))!;
		}
		if (row.pending_accounted)
			await this.pendingBudget(tx, row.agent_instance_id, Boolean(row.control_admission), -1, -row.payload_bytes);
		const settled: RocksCommand = {
			...row,
			state: "settled",
			processor_generation: null,
			pending_accounted: false,
			receipt,
			updated_at: Date.now(),
		};
		await tx.put("command", id, settled);
		await this.receiptEvent(tx, id);
	}
	/**
	 * Publishes a browser command's current receipt stage on its own agent and, when the browser froze another
	 * source target (a branch launched from its parent), on that source agent of the same principal too.
	 */
	async receiptEvent(tx: RuntimeTransaction, id: string): Promise<void> {
		const row = await tx.get<RocksCommand>("command", id);
		if (!row) return;
		const command = row.identity;
		const identity = await tx.get<RocksIdentity>("identity", row.agent_instance_id);
		const attempt = command.attemptId ? await tx.get<RocksAttempt>("attempt", command.attemptId) : undefined;
		const value = runtimeReceipt(row, identity, attempt);
		if (!value) return;
		await this.append(
			tx,
			{
				commandId: id,
				agentInstanceId: row.agent_instance_id,
				executionId: command.executionId ?? "",
				attemptId: command.attemptId ?? "",
				bindingId: command.bindingId ?? "",
				engineGeneration: command.engineGeneration,
				bindingGeneration: command.bindingGeneration ?? 0,
				authorityGeneration: command.authorityGeneration,
			},
			{ kind: "command_receipt", payload: { value } },
		);
		const source = (value.target as { agentInstanceRef: string }).agentInstanceRef;
		if (source === command.agentInstanceRef) return;
		const owner = (await tx.query<RocksIdentity>("identity_ref", [source])).find(
			candidate => candidate.principal_id === (command.principalId ?? ""),
		);
		if (!owner)
			throw new EngineTargetError("stale_target", "Receipt source identity is not owned by the command principal");
		await this.identityEvent(tx, owner.agent_instance_id, id, "command_receipt", { value });
	}

	/** Starts an event: marks its counters and loads the rows its projection (and `fence`) read in one round trip. */
	async eventReads(
		tx: RuntimeTransaction,
		target: EventTarget,
		event: EngineTransitionEvent,
		fence = false,
	): Promise<void> {
		const counters = [`agent-seq:${target.agentInstanceId}`, "events"];
		tx.sequence(...counters);
		await tx.prefetch([
			...(fence
				? [
						{ kind: "metadata" as const, id: "engine" },
						{ kind: "binding" as const, id: target.agentInstanceId },
					]
				: []),
			...counters.map(id => ({ kind: "metadata" as const, id })),
			...eventReadKeys({
				agentInstanceId: target.agentInstanceId,
				attemptId: target.attemptId,
				kind: event.kind,
				payload: event.payload,
				causationCommandId: event.causationCommandId ?? target.commandId,
			}),
		]);
	}
	async append(tx: RuntimeTransaction, target: EventTarget, event: EngineTransitionEvent): Promise<EngineEvent> {
		await this.eventReads(tx, target, event);
		const seq = await this.counter(tx, `agent-seq:${target.agentInstanceId}`, "agent_seq", 1);
		const eventId = await this.counter(tx, "events", "event_counter", 1);
		const attempt = target.attemptId ? await tx.get<RocksAttempt>("attempt", target.attemptId) : undefined;
		const stored: RocksEvent = {
			...event,
			eventId,
			...(attempt?.binding_snapshot ? { bindingSnapshot: attempt.binding_snapshot } : {}),
			seq,
			createdAt: Date.now(),
			causationCommandId: event.causationCommandId ?? target.commandId,
			agentInstanceId: target.agentInstanceId,
			executionId: target.executionId,
			attemptId: target.attemptId,
			bindingId: target.bindingId,
			engineGeneration: target.engineGeneration,
			bindingGeneration: target.bindingGeneration,
			authorityGeneration: target.authorityGeneration,
			event_id: eventId,
			agent_instance_id: target.agentInstanceId,
			attempt_id: target.attemptId,
			published_at: null,
		};
		const payload = await retainedInputPayload(tx, stored);
		if (payload && stored.kind === "input_requested") stored.payload = payload;
		await tx.create("event", String(eventId), stored);
		await this.projectEvent(tx, stored);
		return stored;
	}
	async identityEvent(
		tx: RuntimeTransaction,
		id: string,
		commandId: string,
		kind: EngineOrdinaryEvent["kind"],
		payload: Record<string, unknown>,
	): Promise<EngineEvent> {
		const identity = await tx.get<RocksIdentity>("identity", id);
		const retained = await tx.get<RocksBinding>("binding", id);
		const gate = payload.semanticBinding === true
			? (await tx.get<{ gate: EngineBindingGate }>("metadata", `semantic-binding:${id}`))?.gate : undefined;
		const binding = gate && !sameSemanticBinding(retained?.binding_snapshot, gate.committedTarget ?? gate.bindingSnapshot)
			? undefined : retained;
		const engine = await tx.get<{ generation: number }>("metadata", "engine");
		return this.append(
			tx,
			{
				commandId,
				agentInstanceId: id,
				executionId: binding?.execution_id ?? "",
				attemptId: binding?.attempt_id ?? "",
				bindingId: binding?.binding_id ?? "",
				engineGeneration: engine?.generation ?? 0,
				bindingGeneration: binding?.binding_generation ?? 0,
				authorityGeneration: identity?.authority_generation ?? 0,
			},
			{ kind, payload },
		);
	}
	async appendEvent(event: Omit<EngineEventBase, "eventId" | "seq" | "createdAt"> & EngineTransitionEvent): Promise<EngineEvent> {
		return this.mutation(
			event.agentInstanceId,
			async tx => {
				const target = { ...event, commandId: event.causationCommandId };
				await this.eventReads(tx, target, event, true);
				await this.assertFence(tx, target);
				return this.append(tx, target, event);
			},
			[],
			["message_updated", "assistant_snapshot", "trace_reasoning", "trace_tool"].includes(event.kind)
				? "buffered"
				: "required",
		);
	}
	async commitEvent(
		target: EventTarget,
		event: EngineTransitionEvent,
		command?: string,
		receipt: EngineCommandReceipt | "applied" | "rejected" = "applied",
	): Promise<EngineEvent> {
		return this.mutation(target.agentInstanceId, async tx => {
			await this.eventReads(tx, target, event, true);
			await this.assertFence(tx, target);
			// Settle before the event: its summary must no longer project the command as pending.
			if (command) await this.settle(tx, command, typeof receipt === "string" ? { outcome: receipt } : receipt);
			return this.append(tx, target, event);
		});
	}
	async commitUnboundStartRejection(
		target: EventTarget,
		event: EngineTransitionEvent,
		receipt: EngineCommandReceipt,
	): Promise<EngineEvent> {
		return this.mutation(target.agentInstanceId, async tx => {
			// The retained binding belongs to an older Attempt, so validate the claimed Start instead.
			// A rejected Start may request the wrong generation. Its immutable request generation
			// must match the command row; the actual rejection writer is fenced by engine + processor.
			const engine = await tx.get<{ generation: number }>("metadata", "engine");
			const command = await tx.get<RocksCommand>("command", target.commandId);
			const identity = command?.identity;
			if (
				engine?.generation !== target.engineGeneration ||
				command?.command_id !== target.commandId ||
				command.agent_instance_id !== target.agentInstanceId ||
				command?.state !== "received" ||
				command.processor_generation !== target.engineGeneration ||
				command.operation !== "start" ||
				identity?.commandId !== target.commandId ||
				identity?.agentInstanceId !== target.agentInstanceId ||
				identity.executionId !== target.executionId ||
				identity.attemptId !== target.attemptId ||
				identity.authorityGeneration !== target.authorityGeneration ||
				identity.engineGeneration !== command.engine_generation ||
				(identity.bindingId ?? "") !== target.bindingId ||
				(identity.bindingGeneration ?? 0) !== target.bindingGeneration ||
				target.bindingId !== "" ||
				target.bindingGeneration !== 0 ||
				event.kind !== "rejected" ||
				event.causationCommandId !== target.commandId ||
				receipt.outcome !== "rejected" ||
				(await tx.get<RocksAttempt>("attempt", target.attemptId))
			) {
				throw new EngineAttemptConflictError(target.attemptId);
			}
			// Settle before the event: its summary must no longer project this Start as pending.
			await this.settle(tx, target.commandId, receipt, command.canonical_hash, true);
			return this.append(tx, target, event);
		});
	}
	async bind(tx: RuntimeTransaction, binding: EngineBindingSnapshot): Promise<void> {
		const engine = await tx.get<{ generation: number }>("metadata", "engine");
		if (engine?.generation !== binding.engineGeneration) throw new EngineAttemptConflictError(binding.attemptId);
		await this.register(tx, {
			agentInstanceId: binding.agentInstanceId,
			authorityGeneration: binding.authorityGeneration,
		});
		const old = await tx.get<RocksBinding>("binding", binding.agentInstanceId);
		const identity = (await tx.get<RocksIdentity>("identity", binding.agentInstanceId))!;
		if (identity.deleted_at || identity.archived_at)
			throw new EngineTargetError("stale_target", "Chat is archived or deleted");
		if (
			binding.authorityGeneration < identity.authority_generation ||
			(old &&
				(binding.engineGeneration < old.engine_generation ||
					binding.authorityGeneration < old.authority_generation ||
					(binding.engineGeneration === old.engine_generation &&
						(binding.bindingGeneration < old.binding_generation ||
							(binding.bindingGeneration === old.binding_generation && !this.sameFence(old, binding))))))
		)
			throw new EngineAttemptConflictError(binding.attemptId);
		identity.intent_revision = Math.max(identity.intent_revision, binding.intentRevision ?? 0);
		await tx.put("identity", binding.agentInstanceId, identity);
		await tx.put("binding", binding.agentInstanceId, {
			...bindingTarget(binding),
			command_id: binding.commandId,
			engine_agent_id: binding.engineAgentId,
			session_file: binding.sessionFile ?? null,
			binding_snapshot: binding.bindingSnapshot,
			execution_schema: 2,
			execution_digest: binding.executionDigest,
			continuation_digest: binding.continuationDigest,
			dispatch_ref: binding.dispatchRef,
			dispatch_hash: binding.dispatchHash,
			state: binding.state,
			manual_hold: binding.manualHold || (await this.holds(tx, binding.agentInstanceId)).length ? 1 : 0,
			intent_revision: identity.intent_revision,
			intent_command_id: binding.intentCommandId ?? null,
			updated_at: Date.now(),
		} satisfies RocksBinding);
	}
	async putBinding(binding: EngineBindingSnapshot): Promise<void> {
		await this.mutation(binding.agentInstanceId, async tx => {
			// Releasing an idle binding after a newer authority registered: that authority's own bind replaces the row.
			const identity = await tx.get<RocksIdentity>("identity", binding.agentInstanceId);
			if (identity && binding.authorityGeneration < identity.authority_generation) return;
			const current = await tx.get<RocksBinding>("binding", binding.agentInstanceId);
			if (binding.state === "released" && current &&
				current.engine_generation === binding.engineGeneration &&
				current.authority_generation === binding.authorityGeneration &&
				current.binding_generation > binding.bindingGeneration) {
				const prior = await tx.get<RocksAttempt>("attempt", binding.attemptId);
				if (prior && this.sameFence(prior, binding) && terminal.has(prior.state))
					return; // Resources were disposed; the newly admitted Attempt owns the binding projection.
			}
			await this.bind(tx, binding);
		});
	}
	async commitBindingEvent(
		binding: EngineBindingSnapshot,
		event: EngineTransitionEvent,
		settlement?: { commandId: string; receipt: EngineCommandReceipt },
	): Promise<EngineEvent> {
		return this.mutation(binding.agentInstanceId, async tx => {
			await this.assertFence(tx, binding);
			await this.bind(tx, binding);
			const result = await this.append(tx, binding, event);
			if (settlement) await this.settle(tx, settlement.commandId, settlement.receipt);
			return result;
		});
	}
	async putAttempt(binding: EngineBindingSnapshot, state: EngineAttemptState, cause?: string): Promise<boolean> {
		await this.commitAttemptTransition(binding, state, [], { cause });
		return true;
	}
	async commitAttemptTransition(
		binding: EngineBindingSnapshot,
		state: EngineAttemptState,
		events: readonly EngineTransitionEvent<EngineOrdinaryEvent>[],
		options: RocksTransitionOptions = {},
	): Promise<EngineEvent[]> {
		const native = options.transcriptCheckpoint?.native;
		if (state === "completed" && !native) throw new EngineAttemptConflictError(binding.attemptId);
		for (const event of events)
			if (event.kind === "input_requested" && event.payload)
				await retainInputParts(this.records, binding, event.payload);
		const result = await this.mutation(
			binding.agentInstanceId,
			async tx => {
				const engine = await tx.get<{ generation: number }>("metadata", "engine");
				if (engine?.generation !== binding.engineGeneration)
					throw new EngineAttemptConflictError(binding.attemptId);
				if (options.startIntent && binding.bindingSnapshot)
					await this.assertSemanticStart(tx, binding.agentInstanceId, binding.bindingSnapshot);
				if (options.intentGuard)
					await this.checkIntent(
						tx,
						binding.agentInstanceId,
						options.intentGuard.expectedRevision,
						options.intentGuard.requireUnheld,
					);
				const old = await tx.get<RocksAttempt>("attempt", binding.attemptId);
				if (
					(options.requireNew && old) ||
					(options.expectedStates && (!old || !options.expectedStates.includes(old.state))) ||
					(old && !this.sameFence(old, binding))
				)
					throw new EngineAttemptConflictError(binding.attemptId);
				if (options.intentGuard?.inputRevision !== undefined) {
					const input = options.intentGuard.inputId
						? await tx.get<{ value: { revision: number } }>(
								"projection",
								projectionId("input", binding.attemptId, options.intentGuard.inputId),
							)
						: undefined;
					if ((input?.value.revision ?? old?.input_revision) !== options.intentGuard.inputRevision)
						throw new EngineTargetError("stale_target", "Pending input revision changed");
				}
				if (options.routingResume) {
					const current = await tx.get<RocksBinding>("binding", binding.agentInstanceId);
					await this.checkIntent(tx, binding.agentInstanceId, options.intentGuard?.expectedRevision, true);
					if (!current || current.manual_hold !== 0 || !this.sameFence(current, binding) ||
						(options.intentGuard?.expectedRevision !== undefined && current.intent_revision !== options.intentGuard.expectedRevision) ||
						(options.intentGuard?.commandId !== undefined && current.intent_command_id !== options.intentGuard.commandId) ||
						!sameSemanticBinding(current.binding_snapshot, options.routingResume.bindingSnapshot) ||
						options.routingResume.commandId !== old?.command_id || options.routingResume.attemptId !== binding.attemptId)
						throw new EngineTargetError("stale_target", "Resume intent or admitted binding changed");
					if (options.intentGuard?.commandId) {
						const control = await tx.get<RocksCommand>("command", options.intentGuard.commandId);
						if (control && (control.operation !== "resume" || control.state !== "received"))
							throw new EngineTargetError("stale_target", "Resume command is no longer pending");
					}
					if (!old?.execution || old.state !== "paused" || state === "paused" ||
						candidateRef(currentIdentity(old.execution.executor_choice)) !==
							candidateRef(options.routingResume.candidates[0]))
						throw new EngineTargetError("stale_target", "Resume must keep the admitted current frozen route");
					const held = await tx.get<RocksSlotLease>("metadata", leaseId(binding.attemptId));
					if (held) {
						if (held.engine_generation !== binding.engineGeneration ||
							held.expires_at <= Date.now() ||
							held.attempt_id !== binding.attemptId ||
							held.dispatch_hash !== options.routingResume.dispatchHash ||
							held.binding_snapshot_hash !== `sha256:${createHash("sha256").update(storageCanonicalJson(options.routingResume.bindingSnapshot)).digest("hex")}` ||
							held.resources.account_ref !== options.routingResume.candidates[0]?.account_ref)
							throw new EngineTargetError("stale_target", "Pre-acquired Resume lease changed");
					} else {
						const acquired = await stageAdmission(tx, options.routingResume);
						if (acquired.status === "queued") return { queueId: acquired.queueId };
						if (candidateRef(acquired.frozen[0]) !== candidateRef(options.routingResume.candidates[0]))
							throw new EngineTargetError("stale_target", "Resume changed its frozen route");
					}
				}
				if (state === "cancel_requested" && !(await tx.get("metadata", leaseId(binding.attemptId))))
					await stageRelease(tx, binding.attemptId);
				if (terminal.has(state)) {
					const effects = await tx.get<{ count: number }>(
						"metadata",
						`effects:${binding.attemptId}:${binding.bindingId}`,
					);
					if (effects?.count) throw new EngineEffectConflictError(binding.attemptId);
				}
				const committed: EngineEvent[] = [];
				if (options.startIntent) {
					const guard = options.startIntent;
					await this.checkIntent(tx, binding.agentInstanceId, guard.expectedRevision);
					if (guard.sourceAgentInstanceId)
						await this.checkIntent(tx, guard.sourceAgentInstanceId, guard.sourceRevision);
					if (guard.explicitContinue && guard.expectedRevision !== undefined)
						committed.push(
							...(
								await this.changeIntent(
									tx,
									binding.agentInstanceId,
									binding.commandId,
									"continue",
									guard.expectedRevision,
								)
							).events,
						);
					else if (!guard.allowInheritedHold) await this.checkIntent(tx, binding.agentInstanceId, undefined, true);
				}
				if (options.restoreWorkspaceReceipt) await completeRestoreRebind(tx, options.restoreWorkspaceReceipt);
				await this.bind(tx, binding);
				if (options.startIntent) {
					const command = await tx.get<RocksCommand>("command", binding.commandId);
					const identity = await tx.get<RocksIdentity>("identity", binding.agentInstanceId);
					if (command?.operation === "start" && command.state === "received")
						await tx.put("command", binding.commandId, {
							...command,
							start_applied_intent_revision: identity?.intent_revision ?? 0,
						});
				}
				const checkpoint = options.transcriptCheckpoint;
				const row: RocksAttempt = {
					...bindingTarget(binding),
					command_id: binding.commandId,
					binding_snapshot: binding.bindingSnapshot,
					row_id: old?.row_id ?? Date.now(),
					created_at: old?.created_at ?? Date.now(),
					state,
					cause: options.cause ?? null,
					updated_at: Date.now(),
					transcript_session_id: null,
					transcript_path: null,
					transcript_leaf_entry_id: null,
					transcript_byte_boundary: null,
					transcript_revision: 0,
					retry_attempt: 0,
					retry_max_attempts: 0,
					retry_route: null,
					retry_delay_ms: null,
					retry_scheduled_at: null,
					retry_outcome: null,
					retry_error: null,
					execution: options.execution,
					executor_route_state: null,
					result_payload: null,
					detail_revision: 0,
					input_revision: 0,
					message_revision: 0,
					tool_revision: 0,
					...old,
				};
				Object.assign(row, { state, cause: options.cause ?? null, updated_at: Date.now() });
				if (options.actualCost !== undefined && row.execution)
					row.execution = { ...row.execution, executor_choice: {
						...row.execution.executor_choice, actual_cost: options.actualCost,
					} };
				if (
					(state === "completed" || state === "failed" || state === "cancelled" || state === "interrupted") &&
					row.retry_outcome === "waiting"
				)
					row.retry_outcome = state === "completed" ? "succeeded" : state;
				if (options.terminalResult) row.result_payload = options.terminalResult;
				if (checkpoint)
					Object.assign(row, {
						transcript_session_id: checkpoint.sessionId,
						transcript_path: checkpoint.sessionPath,
						transcript_leaf_entry_id: checkpoint.leafEntryId,
						transcript_byte_boundary: checkpoint.byteBoundary,
						transcript_revision: (old?.transcript_revision ?? 0) + 1,
						...(native ? { transcript_native: native } : {}),
					});
				if (options.routingAdmission) {
					const { request, preview } = options.routingAdmission;
					const admitted = await stageAdmission(tx, request);
					if (admitted.status !== "admitted" ||
						storageCanonicalJson(admitted.frozen) !== storageCanonicalJson(preview.frozen))
						throw new EngineTargetError("admission_state_unknown", "Routing selection changed before acceptance");
					if (!options.execution ||
						candidateRef(row.execution!.executor_choice.selected) !== candidateRef(admitted.frozen[0]))
						throw new EngineTargetError("admission_state_unknown", "Attempt execution differs from admitted route");
				}
				await tx.put("attempt", binding.attemptId, row);
				// §6: an actual pause or a terminal state releases the routing lease exactly once, atomically.
				if ((state === "paused" || terminal.has(state)) && old?.state !== state)
					await stageRelease(tx, binding.attemptId);
				if (terminal.has(state))
					committed.push(
						...(await settleRuntimeMessages(
							tx,
							binding,
							state === "cancelled" ? "cancelled" : state === "interrupted" ? "interrupted" : "settled",
							(tx, target, event) => this.append(tx, target, event),
						)),
					);
				if (options.inboxSessionId) {
					const pending = await tx.query<RocksInbox>("inbox_agent_pending", [binding.agentInstanceId]);
					for (const item of pending)
						await tx.put("inbox", item.queue_id, {
							...item,
							...bindingTarget(binding),
							sessionId: options.inboxSessionId,
							session_id: options.inboxSessionId,
							attemptId: binding.attemptId,
							wake_delivered_at: null,
							wakeDeliveredAt: undefined,
						});
				}
				if (options.inboxMutation) {
					if (!options.inboxSessionId)
						throw new EngineInboxConflictError("Inbox mutation requires a session identity");
					const result = await this.mutateInbox(
						tx,
						{ ...binding, sessionId: options.inboxSessionId },
						options.inboxMutation,
						options.inboxMutationCausationCommandId,
					);
					if (result.event) committed.push(result.event);
				}
				const transitionEvents: readonly EngineTransitionEvent<EngineOrdinaryEvent>[] =
					events.length || !checkpoint ? events : [{ kind: "reconciled" }];
				for (const event of transitionEvents)
					committed.push(
						await this.append(tx, binding, {
							...event,
							...(checkpoint
								? {
										payload: {
											...event.payload,
											transcriptCheckpoint: { ...checkpoint, revision: row.transcript_revision },
										},
									}
								: {}),
						}),
					);
				if (options.settleCommandId)
					await this.settle(tx, options.settleCommandId, options.settleCommandReceipt ?? { outcome: "applied" });
				// A terminal Attempt moves its browser Start receipt to execution_terminal (settling it already did).
				if (terminal.has(state) && options.settleCommandId !== binding.commandId)
					await this.receiptEvent(tx, binding.commandId);
				return committed;
			},
			this.checkpointDependencies(options.transcriptCheckpoint),
		);
		if ("queueId" in result) throw new EngineRoutingQueuedError(result.queueId);
		return result;
	}

	async branchAgents(tx: RuntimeTransaction, id: string): Promise<string[]> {
		const agentIds = [id];
		for (let index = 0; index < agentIds.length; index++) {
			if (agentIds.length > 64)
				throw new EngineTargetError("restore_budget", "Branch control exceeds its atomic budget");
			const children = await tx.query<RocksIdentity>("identity_parent", [agentIds[index]]);
			for (const child of children) {
				if (agentIds.includes(child.agent_instance_id)) throw new Error("Agent ancestry cycle");
				agentIds.push(child.agent_instance_id);
			}
		}
		return agentIds;
	}
	async changeIntent(
		tx: RuntimeTransaction,
		id: string,
		commandId: string,
		action: "pause" | "resume" | "stop" | "continue",
		expected?: number,
	) {
		await this.checkIntent(tx, id, expected);
		const root = await tx.get<RocksIdentity>("identity", id);
		if (!root) throw new EngineTargetError("agent_not_found", "Unknown branch root");
		if (action === "resume" || action === "continue") {
			for (const kind of action === "resume" ? ["pause"] : ["pause", "stop", "recovery"])
				await tx.delete("hold", `${id}:${kind}`);
		} else
			await tx.put("hold", `${id}:${action === "stop" ? "stop" : "pause"}`, {
				source_agent_instance_id: id,
				agent_instance_id: id,
				kind: action === "stop" ? "stop" : "pause",
				command_id: commandId,
				generation: root.intent_revision + 1,
			});
		const agentIds = await this.branchAgents(tx, id);
		const events: EngineEvent[] = [];
		const parents = new Map<string, string | null>();
		const targets = new Map<string, ResumeMember>();
		for (const agent of agentIds) {
			const row = (await tx.get<RocksIdentity>("identity", agent))!;
			parents.set(agent, row.parent_agent_instance_id ?? null);
			await tx.put("identity", agent, { ...row, intent_revision: row.intent_revision + 1 });
			const holds = await this.holds(tx, agent);
			const binding = await tx.get<RocksBinding>("binding", agent);
			if (binding)
				await tx.put("binding", agent, {
					...binding,
					manual_hold: holds.length ? 1 : 0,
					intent_revision: row.intent_revision + 1,
					intent_command_id: commandId,
				});
			if (action === "resume" && binding && holds.length === 0) {
				const attempt = await tx.get<RocksAttempt>("attempt", binding.attempt_id);
				if (attempt && !terminal.has(attempt.state))
					targets.set(agent, {
						commandId: binding.command_id, agentInstanceId: agent, executionId: binding.execution_id,
						attemptId: binding.attempt_id, bindingId: binding.binding_id,
						engineGeneration: binding.engine_generation, bindingGeneration: binding.binding_generation,
						authorityGeneration: binding.authority_generation, bindingSnapshot: binding.binding_snapshot,
						intentRevision: row.intent_revision + 1, parentAgentInstanceId: row.parent_agent_instance_id ?? null,
					});
			}
			events.push(
				await this.identityEvent(tx, agent, commandId, "holds_changed", {
					action,
					sourceAgentInstanceId: id,
					holds,
					holdsHasMore: false,
				}),
			);
		}
		return { agentIds, events, intentRevision: root.intent_revision + 1, parents, targets };
	}
	async branchIntent(
		id: string,
		commandId: string,
		action: "pause" | "resume" | "stop" | "continue",
		expected?: number,
		startFence?: EnginePendingStartTarget,
	) {
		return this.mutation(id, async tx => {
			if (startFence) {
				const start = action === "stop" ? await this.targetStart(tx, startFence) : undefined;
				if (!start) throw new EngineTargetError("stale_target", "Cancellation requires its exact admitted Start");
				expected = await this.cancelRevision(tx, startFence, start);
			}
			const ownershipId = projectionId("ownership", "resume", commandId);
			if (action === "resume") {
				const ownership = await tx.get<ResumeOwnership>("projection", ownershipId);
				if (ownership) {
					if (ownership.agent_instance_id !== id ||
						(expected !== undefined && ownership.value.intentRevision !== expected + 1))
						throw new EngineTargetError("stale_target", "Resume ownership changed its original intent");
					const agentIds: string[] = [];
					let superseded = false;
					const parents = new Map<string, string | null>();
					const targets = new Map<string, ResumeMember>();
					for (const saved of ownership.value.members) {
						parents.set(saved.agentInstanceId, saved.parentAgentInstanceId);
						targets.set(saved.agentInstanceId, saved);
						const original = await tx.get<RocksAttempt>("attempt", saved.attemptId);
						if (original && terminal.has(original.state)) continue;
						const current = await tx.get<RocksBinding>("binding", saved.agentInstanceId);
						if (current && this.sameFence(current, saved) &&
							sameSemanticBinding(current.binding_snapshot, saved.bindingSnapshot) &&
							current.intent_command_id === commandId && current.intent_revision === saved.intentRevision)
							agentIds.push(saved.agentInstanceId);
						else superseded = true;
					}
					return { agentIds, events: [] as EngineEvent[], intentRevision: ownership.value.intentRevision,
						superseded, parents, targets };
				}
			}
			const changed = await this.changeIntent(tx, id, commandId, action, expected);
			if (action === "resume") {
				const root = await tx.get<RocksBinding>("binding", id);
				await tx.create("projection", ownershipId, {
					subtype: "ownership", agent_instance_id: id, attempt_id: root?.attempt_id ?? "",
					position: changed.events[0].eventId,
					value: { intentRevision: changed.intentRevision, members: [...changed.targets.values()] },
				} satisfies ResumeOwnership);
				return { ...changed, agentIds: [...changed.targets.keys()], superseded: false };
			}
			return { ...changed, superseded: false };
		});
	}

	async resumeOwnership(commandId: string, agentId: string): Promise<ResumeOwnership["value"] | undefined> {
		const row = (await this.records.get("projection", projectionId("ownership", "resume", commandId))).value as
			unknown as ResumeOwnership | undefined;
		if (!row) return undefined;
		if (row.agent_instance_id !== agentId)
			throw new EngineTargetError("stale_target", "Resume ownership belongs to another branch");
		return row.value;
	}

	checkpointDependencies(checkpoint?: SessionDurabilityCheckpoint): StorageDependency[] {
		const native = checkpoint?.native;
		if (!native) return [];
		if (native.incarnation !== this.storageClient.incarnation)
			throw new EngineTargetError("stale_target", "Native checkpoint owner changed");
		return [{ familyId: native.familyId, generationId: native.generationId, throughSeq: native.throughSeq }];
	}
	async effectStart(
		target: EventTarget,
		input: EngineToolEffectInput | EngineModelEffectInput,
		model: boolean,
		approval: ApprovalRequest | undefined,
		checkpoint?: SessionDurabilityCheckpoint,
	): Promise<EngineEvent> {
		return this.mutation(
			target.agentInstanceId,
			async tx => {
				await this.assertFence(tx, target);
				await this.checkIntent(tx, target.agentInstanceId, undefined, true);
				const binding = await tx.get<RocksBinding>("binding", target.agentInstanceId);
				const attempt = await tx.get<RocksAttempt>("attempt", target.attemptId);
				if (!binding || !attempt || !this.sameFence(attempt, target) || terminal.has(attempt.state))
					throw new EngineEffectConflictError(input.effectId);
				const lease = await tx.get<RocksSlotLease>("metadata", leaseId(target.attemptId));
				if (!attempt.execution || !lease || lease.attempt_id !== target.attemptId ||
					lease.engine_generation !== target.engineGeneration ||
					lease.dispatch_hash !== attempt.execution.dispatch_hash ||
					lease.expires_at <= Date.now() ||
					lease.resources.account_ref !== currentIdentity(attempt.execution.executor_choice).account_ref)
					throw new EngineTargetError("stale_target", "Model/tool effect requires an active admitted routing lease");
				if (await tx.get("effect", input.effectId)) throw new EngineEffectConflictError(input.effectId);
				const tool = "toolCallId" in input ? input : undefined;
				const modelCall = "modelCallId" in input ? input.modelCallId : "";
				const row: RocksEffect = {
					agent_instance_id: target.agentInstanceId,
					execution_id: target.executionId,
					attempt_id: target.attemptId,
					binding_id: target.bindingId,
					engine_generation: target.engineGeneration,
					binding_generation: target.bindingGeneration,
					authority_generation: target.authorityGeneration,
					effect_id: input.effectId,
					command_id: target.commandId,
					tool_call_id: tool?.toolCallId ?? modelCall,
					tool_name: tool?.toolName ?? "model_dispatch",
					policy: tool?.policy ?? "unrestricted",
					input_hash: input.inputHash,
					assistant_message_id: tool?.origin?.messageId ?? null,
					assistant_block_id: tool?.origin?.blockId ?? null,
					effect_kind: model ? "model" : "tool",
					state: approval ? "planned" : "started",
					outcome: null,
					created_at: Date.now(),
					updated_at: Date.now(),
					runtime_event_id: 0,
				};
				await tx.put("effect", input.effectId, row);
				await this.counter(tx, `effects:${target.attemptId}:${target.bindingId}`, "open_effects", 1);
				// §5.1: the request is saved with its planned effect before the requested event is emitted.
				if (approval) {
					if (approval.id !== input.effectId || approval.effect_id !== input.effectId)
						throw new EngineEffectConflictError(input.effectId);
					await tx.create("approval", approval.id, {
						approval_id: approval.id,
						effect_id: approval.effect_id,
						state: "pending",
						decision: null,
						updated_at: Date.now(),
						request: approval,
						decision_record: null,
						timed_out_attempt_ids: [],
					} satisfies EngineApprovalRow);
					return this.append(tx, target, { kind: `${approval.kind}_approval_requested`, payload: approval });
				}
				return this.append(tx, target, {
					kind: model ? "model_started" : "tool_started",
					payload: model
						? { effectId: input.effectId, modelCallId: modelCall }
						: {
								invocationId: input.effectId,
								toolCallId: tool?.toolCallId,
								toolName: tool?.toolName,
								policy: tool?.policy,
								inputHash: input.inputHash,
								...(tool?.origin ? { origin: tool.origin } : {}),
							},
				});
			},
			this.checkpointDependencies(checkpoint),
		);
	}
	async startToolEffect(
		target: EventTarget,
		effect: EngineToolEffectInput,
		checkpoint?: SessionDurabilityCheckpoint,
	): Promise<EngineEvent> {
		return this.effectStart(target, effect, false, undefined, checkpoint);
	}
	async startModelEffect(
		target: EventTarget,
		effect: EngineModelEffectInput,
		checkpoint?: SessionDurabilityCheckpoint,
	): Promise<EngineEvent> {
		return this.effectStart(target, effect, true, undefined, checkpoint);
	}
	async requestModelApproval(
		target: EventTarget, effect: EngineModelEffectInput, request: ApprovalRequest,
		checkpoint?: SessionDurabilityCheckpoint,
	): Promise<EngineEvent> {
		return this.effectStart(target, effect, true, request, checkpoint);
	}
	async requestToolApproval(
		target: EventTarget,
		effect: EngineToolEffectInput,
		request: ApprovalRequest,
		checkpoint?: SessionDurabilityCheckpoint,
	): Promise<EngineEvent> {
		return this.effectStart(target, effect, false, request, checkpoint);
	}
	/** The MCP call has already started; an escalation parks that exact effect without creating a planned duplicate. */
	async requestStartedEffectApproval(target: EventTarget, effectId: string, request: ApprovalRequest): Promise<EngineEvent> {
		return this.mutation(target.agentInstanceId, async tx => {
			await this.assertFence(tx, target);
			const effect = await tx.get<RocksEffect>("effect", effectId);
			if (request.kind !== "escalation" || request.id !== effectId || request.effect_id !== effectId ||
				effect?.state !== "started" || !this.sameFence(effect, target) ||
				await tx.get<EngineApprovalRow>("approval", effectId))
				throw new EngineEffectConflictError(effectId);
			await tx.create("approval", effectId, {
				approval_id: effectId, effect_id: effectId, state: "pending", decision: null,
				updated_at: Date.now(), request, decision_record: null, timed_out_attempt_ids: [],
			} satisfies EngineApprovalRow);
			return this.append(tx, target, { kind: "escalation_approval_requested", payload: request });
		});
	}
	async effectSettle(
		tx: RuntimeTransaction,
		target: EventTarget,
		id: string,
		outcome: RocksEffect["outcome"],
		options: { error?: string; jobIds?: string[] } = {},
	): Promise<EngineEvent> {
		await this.assertFence(tx, target);
		const row = await tx.get<RocksEffect>("effect", id);
		if (
			!row ||
			!this.sameFence(row, target) ||
			(row.state !== "started" && !(row.state === "planned" && (outcome === "denied" || outcome === "cancelled")))
		)
			throw new EngineEffectConflictError(id);
		await tx.put("effect", id, {
			...row,
			state: outcome === "unknown" ? "unknown" : "settled",
			outcome,
			...options,
			updated_at: Date.now(),
		});
		await this.counter(tx, `effects:${target.attemptId}:${target.bindingId}`, "open_effects", -1);
		return this.append(tx, target, {
			kind: row.effect_kind === "model" ? "model_settled" : "tool_settled",
			payload: {
				...(row.effect_kind === "model" ? modelEffectPayload(row) : toolEffectPayload(row)),
				status: outcome,
				...options,
			},
		});
	}
	async settleToolEffect(
		target: EventTarget,
		id: string,
		outcome: "completed" | "failed" | "cancelled",
		options: { error?: string; jobIds?: string[]; checkpoint?: SessionDurabilityCheckpoint } = {},
	): Promise<EngineEvent> {
		if (outcome === "completed" && !options.checkpoint?.native) throw new EngineEffectConflictError(id);
		return this.mutation(
			target.agentInstanceId,
			tx => this.effectSettle(tx, target, id, outcome, { error: options.error, jobIds: options.jobIds }),
			this.checkpointDependencies(options.checkpoint),
		);
	}
	async settleModelEffect(
		target: EventTarget,
		effect: EngineModelEffectInput,
		outcome: "completed" | "failed",
		error?: string,
		checkpoint?: SessionDurabilityCheckpoint,
	): Promise<EngineEvent> {
		if (outcome === "completed" && !checkpoint?.native) throw new EngineEffectConflictError(effect.effectId);
		return this.mutation(
			target.agentInstanceId,
			tx => this.effectSettle(tx, target, effect.effectId, outcome, error ? { error } : {}),
			this.checkpointDependencies(checkpoint),
		);
	}
	/**
	 * One decisive CAS on the requester's own approval record. The decision (or cancellation) is saved
	 * before the planned effect is unblocked; a late decision never revives a closed request.
	 */
	async resolveApproval(
		target: EventTarget,
		id: string,
		outcome: "approve" | "approve_always" | "deny" | "cancelled",
		record: ApprovalDecision | null,
		options: {
			causationCommandId?: string;
			settleCommandId?: string;
			expectedIntentRevision?: number;
			expectedInputRevision?: number;
		} = {},
	): Promise<EngineEvent[]> {
		return this.mutation(target.agentInstanceId, async tx => {
			await this.assertFence(tx, target);
			const approval = await tx.get<EngineApprovalRow>("approval", id);
			if (approval?.state !== "pending") throw new EngineEffectConflictError(id);
			const request = approval.request;
			if (
				record &&
				(record.request_id !== id ||
					record.expected_address_revision !== request.address_revision ||
					record.expected_decision_revision !== request.decision_revision)
			)
				throw new EngineTargetError("stale_target", "Approval request revision changed");
			const effect = request.kind === "tool" || request.kind === "spawn" || request.kind === "consultant"
				? await tx.get<RocksEffect>("effect", request.effect_id) : undefined;
			if (effect && (effect.state !== "planned" || !this.sameFence(effect, target)))
				throw new EngineEffectConflictError(id);
			await this.checkIntent(tx, target.agentInstanceId, options.expectedIntentRevision);
			if (options.expectedInputRevision !== undefined) {
				const attempt = await tx.get<RocksAttempt>("attempt", target.attemptId);
				if (attempt?.input_revision !== options.expectedInputRevision)
					throw new EngineTargetError("stale_target", "Input revision changed");
			}
			const status = outcome === "cancelled" ? "cancelled" : outcome === "deny" ? "denied" : "approved";
			if (status !== "cancelled" && !record)
				throw new EngineTargetError("invalid_request", "Approval resolution requires its verified decision");
			const resolution: EngineApprovalResolved = {
				request_id: id, decision_revision: request.decision_revision + 1,
				...(status === "cancelled" ? { outcome: "cancelled", decided_by: record?.decided_by ?? null } :
					{ outcome: status, decided_by: record!.decided_by }),
			};
			const resolved = { ...request, status, decision_revision: request.decision_revision + 1 } as ApprovalRequest;
			await tx.put("approval", id, {
				...approval,
				state: "resolved",
				decision: outcome,
				decision_record: record,
				request: resolved,
				updated_at: Date.now(),
			} satisfies EngineApprovalRow);
			if (status === "denied" && effect &&
				(await tx.get<RocksAttempt>("attempt", target.attemptId))?.state === "paused")
				await tx.put("metadata", `approval-recovery:${target.attemptId}`, {
					subtype: "approval_recovery", request_id: id,
				});
			const events = [
				await this.append(tx, target, {
					kind: `${request.kind}_approval_resolved`,
					causationCommandId: options.causationCommandId,
					payload: resolution,
				}),
			];
			if (effect && status === "approved" && (await tx.get<RocksAttempt>("attempt", target.attemptId))?.state === "running") {
				const lease = await tx.get<RocksSlotLease>("metadata", leaseId(target.attemptId));
				const attempt = await tx.get<RocksAttempt>("attempt", target.attemptId);
				if (!lease || !attempt?.execution || lease.attempt_id !== target.attemptId ||
					lease.engine_generation !== target.engineGeneration ||
					lease.dispatch_hash !== attempt.execution.dispatch_hash ||
					lease.expires_at <= Date.now() ||
					lease.resources.account_ref !== currentIdentity(attempt.execution.executor_choice).account_ref)
					throw new EngineTargetError("stale_target", "Approval cannot start effect without active routing lease");
				await tx.put("effect", effect.effect_id, { ...effect, state: "started", updated_at: Date.now() });
				events.push(await this.append(tx, target, {
					kind: effect.effect_kind === "model" ? "model_started" : "tool_started",
					payload: effect.effect_kind === "model"
						? { effectId: effect.effect_id, modelCallId: effect.tool_call_id }
						: {
								invocationId: effect.effect_id, toolCallId: effect.tool_call_id,
								toolName: effect.tool_name, policy: effect.policy, inputHash: effect.input_hash,
							},
				}));
			} else if (effect && status !== "approved")
				events.push(
					await this.effectSettle(
						tx,
						target,
						effect.effect_id,
						status === "denied" ? "denied" : "cancelled",
						record?.reason ? { error: record.reason } : {},
					),
				);
			if (options.settleCommandId) await this.settle(tx, options.settleCommandId, { outcome: "applied" });
			return events;
		});
	}
	/** Starts an approved parked effect only after the same Attempt reacquires its routing lease. */
	async activateApprovedToolEffect(target: EventTarget, id: string): Promise<EngineEvent> {
		return this.mutation(target.agentInstanceId, async tx => {
			await this.assertFence(tx, target);
			await this.checkIntent(tx, target.agentInstanceId, undefined, true);
			const approval = await tx.get<EngineApprovalRow>("approval", id);
			const effect = await tx.get<RocksEffect>("effect", id);
			const attempt = await tx.get<RocksAttempt>("attempt", target.attemptId);
			const lease = await tx.get<RocksSlotLease>("metadata", leaseId(target.attemptId));
			if (approval?.state !== "resolved" || approval.request.status !== "approved" ||
				!effect || effect.state !== "planned" || !this.sameFence(effect, target) ||
				attempt?.state !== "running" || !attempt.execution ||
				!lease || lease.attempt_id !== target.attemptId ||
				lease.engine_generation !== target.engineGeneration ||
				lease.dispatch_hash !== attempt.execution.dispatch_hash ||
				lease.expires_at <= Date.now() ||
				lease.resources.account_ref !== currentIdentity(attempt.execution.executor_choice).account_ref)
				throw new EngineTargetError("stale_target", "Approved tool effect requires the resumed Attempt's live routing lease");
			await tx.put("effect", id, { ...effect, state: "started", updated_at: Date.now() });
			return this.append(tx, target, {
				kind: effect.effect_kind === "model" ? "model_started" : "tool_started",
				payload: effect.effect_kind === "model"
					? { effectId: effect.effect_id, modelCallId: effect.tool_call_id }
					: {
							invocationId: id, toolCallId: effect.tool_call_id, toolName: effect.tool_name,
							policy: effect.policy, inputHash: effect.input_hash,
						},
			});
		});
	}

	/** Timeout: address the next capable ancestor, or the human with the same transition when none remains. */
	async readdressApproval(
		target: EventTarget,
		id: string,
		expectedAddressRevision: number,
		to: ApprovalRequest["addressed_to"],
		expiresAt: string | null,
	): Promise<EngineEvent[]> {
		return this.mutation(target.agentInstanceId, async tx => {
			await this.assertFence(tx, target);
			const approval = await tx.get<EngineApprovalRow>("approval", id);
			if (approval?.state !== "pending" || approval.request.address_revision !== expectedAddressRevision ||
				!approval.request.expires_at || Date.parse(approval.request.expires_at) > Date.now()) return [];
			const from = approval.request.addressed_to;
			const now = new Date().toISOString();
			const status = to.kind === "human" ? "waiting_human_paused" : "pending";
			const request = {
				...approval.request,
				addressed_to: to,
				addressed_at: now,
				expires_at: expiresAt,
				address_revision: expectedAddressRevision + 1,
				status,
			} as ApprovalRequest;
			await tx.put("approval", id, {
				...approval,
				request,
				timed_out_attempt_ids:
					from.kind === "attempt" ? [...approval.timed_out_attempt_ids, from.attempt_id] : approval.timed_out_attempt_ids,
				updated_at: Date.now(),
			} satisfies EngineApprovalRow);
			return [
				await this.append(tx, target, {
					kind: "approval_timed_out",
					payload: { request_id: id, address_revision: expectedAddressRevision, status },
				}),
				await this.append(tx, target, {
					kind: "approval_escalated",
					payload: { request_id: id, address_revision: request.address_revision, from, to, expires_at: expiresAt },
				}),
			];
		});
	}

	async commitAttemptRetry(
		target: EngineBindingSnapshot,
		retry: EngineRetryState,
		event: EngineTransitionEvent,
	): Promise<EngineEvent | undefined> {
		return this.mutation(target.agentInstanceId, async tx => {
			const row = await tx.get<RocksAttempt>("attempt", target.attemptId);
			if (!row || !this.sameFence(row, target) || terminal.has(row.state)) return undefined;
			await this.assertFence(tx, target);
			await tx.put("attempt", target.attemptId, {
				...row,
				retry_attempt: retry.attempt,
				retry_max_attempts: retry.maxAttempts,
				retry_route: retry.route ?? row.retry_route,
				retry_delay_ms: retry.delayMs ?? row.retry_delay_ms,
				retry_scheduled_at: retry.scheduledAt ?? row.retry_scheduled_at,
				retry_outcome: retry.outcome ?? null,
				retry_error: retry.error ?? null,
			});
			return this.append(tx, target, event);
		});
	}
	/** Phase-only projection of the current route (loading/active/exhausted); no transition, no lease change. */
	async commitExecutorRouteState(target: EngineBindingSnapshot, state: ExecutorRouteState): Promise<void> {
		await this.mutation(target.agentInstanceId, async tx => {
			const row = await tx.get<RocksAttempt>("attempt", target.attemptId);
			if (!row || !this.sameFence(row, target) || terminal.has(row.state)) return;
			await this.assertFence(tx, target);
			await tx.put("attempt", target.attemptId, { ...row, executor_route_state: JSON.stringify(state) });
		});
	}
	/**
	 * Durable route change before the next model effect. Another frozen route unit transfers the lease
	 * atomically (own-lease credit); a same-route billing-pool change keeps lease and slot untouched.
	 * Returns undefined when the target cannot fit now: the caller skips that candidate.
	 */
	async commitExecutorRoute(
		target: EngineBindingSnapshot,
		to: CandidateIdentity,
		reason: "route_fallback" | "billing_pool_exhausted" | "billing_pool_observed",
		toExecutionDigest: string,
		limits: RoutingLimits,
	): Promise<{ event: EngineEvent; choice: ExecutorChoice } | undefined> {
		return this.mutation(target.agentInstanceId, async tx => {
			const row = await tx.get<RocksAttempt>("attempt", target.attemptId);
			if (!row?.execution || !this.sameFence(row, target) || terminal.has(row.state)) return undefined;
			await this.assertFence(tx, target);
			const choice = row.execution.executor_choice;
			const from = currentIdentity(choice);
			const sameRoute = candidateRef(from) === candidateRef(to);
			const unit = choice.candidates.find(candidate => candidateRef(candidate) === candidateRef(to));
			if (!unit || (sameRoute) !== (reason !== "route_fallback"))
				throw new EngineTargetError("invalid_request", "Unregistered executor fallback is forbidden");
			const original = await tx.get<RocksCommand>("command", row.command_id);
			const wire: unknown = original?.identity.serializedCommand
				? JSON.parse(original.identity.serializedCommand) : undefined;
			if (!wire || typeof wire !== "object" || !("payload" in wire) ||
				!wire.payload || typeof wire.payload !== "object" || !("executionConfiguration" in wire.payload))
				throw new EngineTargetError("stale_target", "Frozen Start execution configuration is missing");
			validateRuntimeValue("engineExecutionConfiguration", wire.payload.executionConfiguration);
			const config = wire.payload.executionConfiguration as EngineExecutionConfiguration;
			const delta = ruleDelta(config.instruction_sources, choice.rules, to)
				.map(({ ref, revision, content_hash }) => ({ ref, revision, content_hash }));
			const route = config.routes.routes.find(candidate => candidateRef(candidate) === candidateRef(to));
			const requirement = choice.effective_requirement;
			if (!route || to.model_id !== route.model_id || to.account_ref !== route.account_ref ||
				(requirement.require_trusted_provider && !route.execution.trusted) ||
				(route.tier === null ? requirement.min_tier > 0 : route.tier < requirement.min_tier) ||
				(requirement.pin && (route.model_id !== requirement.pin.model_id ||
					route.effort !== requirement.pin.effort ||
					(requirement.pin.route_ref !== null && route.route_ref !== requirement.pin.route_ref))) ||
				(!sameRoute && (requirement.fallback_mode === "none" ||
					(requirement.fallback_mode === "same_model" && route.model_id !== choice.selected.model_id))) ||
				(!route.billing_pools.some(pool => pool.pool_id === to.billing_pool_id)))
				throw new EngineTargetError("stale_target", "Executor route violates its frozen admission policy");
			const lease = await tx.get<RocksSlotLease>("metadata", leaseId(target.attemptId));
			if (!lease) throw new EngineTargetError("stale_target", "Executor route change requires a held lease");
			let leaseRevision = lease.lease_revision;
			if (!sameRoute) {
				const transferred = await stageTransfer(tx, target.attemptId, unit, limits, target.engineGeneration);
				if (transferred === undefined) return undefined;
				leaseRevision = transferred;
			}
			const seq = choice.transitions.length + 1;
			const transition: ChoiceTransition = {
				seq,
				event_id: `${target.attemptId}:route:${seq}`,
				from,
				to: candidateIdentity(to),
				reason,
				at: new Date().toISOString(),
				lease_revision: leaseRevision,
				from_execution_digest: choice.execution_digest,
				to_execution_digest: toExecutionDigest,
			};
			const state: ExecutorRouteState = {
				dispatchHash: row.execution.dispatch_hash,
				selected: transition.to,
				pending: null,
				fallback: candidateRef(to) !== candidateRef(choice.selected),
				phase: "loading",
				eventSeq: 0,
			};
			const updatedChoice: ExecutorChoice = {
				...choice, execution_digest: toExecutionDigest, transitions: [...choice.transitions, transition],
				rules: delta.length ? [...choice.rules, ...delta] : choice.rules,
			};
			await tx.put("attempt", target.attemptId, {
				...row,
				execution: {
					...row.execution,
					executor_choice: updatedChoice,
				},
				executor_route_state: JSON.stringify(state),
			});
			const event = await this.append(tx, target, { kind: "executor_route_changed", payload: transition });
			return { event, choice: updatedChoice };
		});
	}
	/** A billing change is one Attempt-row mutation; the held lease and its revision are never rewritten. */
	async commitBillingPoolTransition(
		target: EngineBindingSnapshot,
		proposal: BillingPoolProposal,
		toExecutionDigest: string,
	): Promise<{ status: "applied" | "replayed" | "stale"; choice: ExecutorChoice; current: CandidateIdentity; executionDigest: string; event?: EngineEvent }> {
		return this.mutation(target.agentInstanceId, async tx => {
			const row = await tx.get<RocksAttempt>("attempt", target.attemptId);
			if (!row?.execution || !this.sameFence(row, target) || row.state !== "running")
				throw new EngineTargetError("stale_target", "Billing transition requires a running admitted Attempt");
			await this.assertFence(tx, target);
			const choice = row.execution.executor_choice;
			const current = currentIdentity(choice);
			const last = choice.transitions.at(-1);
			if (last && last.reason === proposal.reason &&
				last.from_execution_digest === proposal.from_execution_digest &&
				last.to_execution_digest === choice.execution_digest &&
				storageCanonicalJson(last.from) === storageCanonicalJson(proposal.from) &&
				storageCanonicalJson(last.to) === storageCanonicalJson(proposal.to))
				return { status: "replayed" as const, choice, current, executionDigest: choice.execution_digest };
			if (choice.execution_digest !== proposal.from_execution_digest ||
				storageCanonicalJson(current) !== storageCanonicalJson(proposal.from))
				return { status: "stale" as const, choice, current, executionDigest: choice.execution_digest };
			const to = proposal.to;
			if ((proposal.reason !== "billing_pool_exhausted" && proposal.reason !== "billing_pool_observed") ||
				candidateRef(current) !== candidateRef(to) || current.model_id !== to.model_id ||
				current.account_ref !== to.account_ref ||
				!choice.candidates.some(candidate => candidateRef(candidate) === candidateRef(to)))
				throw new EngineTargetError("stale_target", "Billing proposal differs from the admitted route unit");
			const command = await tx.get<RocksCommand>("command", row.command_id);
			const wire: unknown = command?.identity.serializedCommand
				? JSON.parse(command.identity.serializedCommand) : undefined;
			if (!wire || typeof wire !== "object" || !("payload" in wire) ||
				!wire.payload || typeof wire.payload !== "object" || !("executionConfiguration" in wire.payload))
				throw new EngineTargetError("stale_target", "Frozen Start execution configuration is missing");
			validateRuntimeValue("engineExecutionConfiguration", wire.payload.executionConfiguration);
			const config = wire.payload.executionConfiguration as EngineExecutionConfiguration;
			const route = config.routes.routes.find(candidate => candidateRef(candidate) === candidateRef(to));
			if (!route || route.model_id !== to.model_id ||
				!route.billing_pools.some(pool => pool.pool_id === to.billing_pool_id))
				throw new EngineTargetError("stale_target", "Billing pool is not in the frozen route");
			const lease = await tx.get<RocksSlotLease>("metadata", leaseId(target.attemptId));
			if (!lease || row.execution.lease_id !== leaseId(target.attemptId) ||
				lease.attempt_id !== target.attemptId || lease.engine_generation !== target.engineGeneration ||
				lease.expires_at <= Date.now() || lease.resources.account_ref !== current.account_ref)
				throw new EngineTargetError("stale_target", "Billing transition requires the same held lease");
			const seq = choice.transitions.length + 1;
			const transition: ChoiceTransition = {
				seq,
				event_id: `${target.attemptId}:route:${seq}`,
				from: current,
				to: candidateIdentity(to),
				reason: proposal.reason,
				at: new Date().toISOString(),
				lease_revision: lease.lease_revision,
				from_execution_digest: choice.execution_digest,
				to_execution_digest: toExecutionDigest,
			};
			const state: ExecutorRouteState = {
				dispatchHash: row.execution.dispatch_hash,
				selected: transition.to,
				pending: null,
				fallback: candidateRef(to) !== candidateRef(choice.selected),
				phase: "loading",
				eventSeq: 0,
			};
			const updatedChoice: ExecutorChoice = { ...choice, execution_digest: toExecutionDigest,
				transitions: [...choice.transitions, transition] };
			await tx.put("attempt", target.attemptId, {
				...row,
				execution: { ...row.execution, executor_choice: updatedChoice },
				executor_route_state: JSON.stringify(state),
			});
			const event = await this.append(tx, target, { kind: "executor_route_changed", payload: transition });
			return { status: "applied" as const, choice: updatedChoice, current: transition.to,
				executionDigest: toExecutionDigest, event };
		});
	}
	/** No physical write until commitAttemptTransition stages this same selection and the Attempt together. */
	async previewRouting(request: AdmissionRequest): Promise<AdmissionOutcome> {
		return stageAdmission(new RuntimeTransaction(this.records, true), request);
	}
	/** Queue-only transition must not accidentally acquire a lease without an Attempt. */
	async queueRouting(request: AdmissionRequest): Promise<Extract<AdmissionOutcome, { status: "queued" }>> {
		return this.mutation("routing", async tx => {
			const outcome = await stageAdmission(tx, request);
			if (outcome.status !== "queued")
				throw new EngineTargetError("admission_state_unknown", "Routing capacity changed before queue commit");
			return outcome;
		});
	}
	/** Queue cancellation is one routing mutation and never releases an actively held lease. */
	async cancelPausedRouting(attemptId: string, intentCommandId?: string, processorGeneration?: number): Promise<void> {
		await this.mutation("routing", async tx => {
			const attempt = await tx.get<RocksAttempt>("attempt", attemptId);
			if (!attempt) return;
			const generation = processorGeneration ?? attempt.engine_generation;
			if ((await tx.get<{ generation: number }>("metadata", "engine"))?.generation !== generation)
				throw new EngineTargetError("stale_target", "Queue cleanup processor generation changed");
			const binding = await tx.get<RocksBinding>("binding", attempt.agent_instance_id);
			if (intentCommandId !== undefined && binding?.intent_command_id !== intentCommandId) return;
			if (await tx.get("metadata", leaseId(attemptId))) return;
			await stageRelease(tx, attemptId);
		});
	}

	/** Clean before final refusal; a crash leaves the command received so recovery repeats this bounded cleanup. */
	async cancelResumeQueues(commandId: string, canonicalHash?: string, processorGeneration?: number): Promise<void> {
		const command = (await this.records.get("command", commandId)).value as unknown as RocksCommand | undefined;
		if (!command || command.operation !== "resume" || command.state !== "received") return;
		if (canonicalHash !== undefined && command.canonical_hash !== canonicalHash)
			throw new EngineCommandConflictError(commandId);
		const ownership = await this.resumeOwnership(commandId, command.agent_instance_id);
		for (const member of ownership?.members ?? [])
			await this.cancelPausedRouting(member.attemptId, commandId,
				processorGeneration ?? command.processor_generation ?? command.engine_generation);
	}

	async cancelRoutingQueue(
		request: Pick<AdmissionRequest, "principalId" | "deviceId" | "commandId" | "agentInstanceRef" | "attemptId">,
		status: "cancelled" | "refused",
		reason: string,
	): Promise<boolean> {
		return this.mutation("routing", tx => stageQueueCancel(tx, request, status, reason));
	}
	async renewRouting(attemptId: string, engineGeneration: number): Promise<boolean> {
		return this.mutation("routing", tx => stageRenew(tx, attemptId, engineGeneration));
	}
	/** Restart: leases of an older Engine generation are released; recovery holds forbid their old effects. */
	async releaseStaleRouting(principalId: string, deviceId: string, engineGeneration: number): Promise<void> {
		const stale = await this.mutation("routing", tx => staleLeaseAttempts(tx, principalId, deviceId, engineGeneration));
		for (const attemptId of stale) await this.releaseRouting(attemptId);
	}
	/** Releases a lease exactly once; an unaccepted Start has no Attempt row yet, so its command is named. */
	async releaseRouting(
		attemptId: string,
		start?: { commandId: string; agentInstanceRef: string; candidate: CandidateIdentity },
	): Promise<void> {
		await this.mutation("routing", tx => stageRelease(tx, attemptId, start));
	}

	/** A durable native entry owns a directly delivered message's bodies; its ready upload rows are done (C5). */
	async consumeUploads(references: EngineMessageAttachments): Promise<void> {
		for (const uploadId of references.uploadIds) {
			const id = `blob-upload:${attachmentUploadKey(references.principalId, uploadId).key}`;
			await this.mutation(id, async tx => {
				if (await tx.get("metadata", id)) await tx.delete("metadata", id);
			});
		}
	}
	async enqueueInboxItem(
		target: EngineInboxTarget,
		source: EngineInboxSource,
		expectedIntentRevision?: number,
		commandId = source.sourceEventId,
	): Promise<{ item: EngineInboxItem; created: boolean }> {
		const attachments =
			source.attachments === undefined ? undefined : messageAttachmentReferences(source.attachments);
		source = { ...source, attachments };
		if (attachments && source.sourceType !== "user")
			throw new EngineInboxConflictError("Only user messages may reference uploaded attachments");
		if (source.createdAt !== undefined && (!Number.isSafeInteger(source.createdAt) || source.createdAt < 0))
			throw new EngineInboxConflictError("Invalid inbox source timestamp");
		validateRuntimeValue("id", source.sourceEventId);
		if (!source.body.trim() && !source.attachments)
			throw new EngineInboxConflictError("Inbox requires text or attachments");
		return this.mutation(target.agentInstanceId, async tx => {
			await this.checkIntent(tx, target.agentInstanceId, expectedIntentRevision);
			const original = await tx.get<{
				body: string;
				source_type: string;
				sender: string | null;
				attachment_refs: unknown;
				attachment_descriptors?: EngineAttachment[];
				created_at: number;
			}>("inbox", `source:${source.sourceEventId}`);
			if (
				original &&
				(original.body !== source.body ||
					original.source_type !== source.sourceType ||
					original.sender !== (source.sender ?? null) ||
					JSON.stringify(original.attachment_refs) !== JSON.stringify(source.attachments ?? null) ||
					(source.createdAt !== undefined && original.created_at !== source.createdAt))
			)
				throw new EngineInboxConflictError("Inbox source has different immutable content");
			const old = await tx.get<RocksInbox>("inbox", source.sourceEventId);
			if (old) {
				if (old.sessionId !== target.sessionId || !this.sameFence(old, { ...target, commandId }))
					throw new EngineInboxConflictError("Inbox session changed");
				return { item: old, created: false };
			}
			const semantic = (await tx.get<{ gate: EngineBindingGate }>("metadata", `semantic-binding:${target.agentInstanceId}`))?.gate;
			if (semantic) {
				this.#requireInstallation(semantic.bindingSnapshot);
				if (semantic.phase !== "open") throw new EngineBindingPendingError("Binding blocks new queued work");
			}
			const attachmentDescriptors: EngineAttachment[] = original?.attachment_descriptors ?? [];
			if (!original && attachments) {
				for (const uploadId of attachments.uploadIds) {
					const { key, ownerHash } = attachmentUploadKey(attachments.principalId, uploadId);
					const upload = await tx.get<{
						subtype: string;
						owner_hash: string;
						state: string;
						attachment: EngineAttachment;
					}>("metadata", `blob-upload:${key}`);
					if (!upload)
						throw new EngineTargetError(
							"attachment_expired",
							"Attachment upload is not ready or has expired; attach the file again",
						);
					if (upload.subtype !== "blob_upload" || upload.owner_hash !== ownerHash || upload.state !== "ready")
						throw new EngineInboxConflictError("Attachment is not ready for this owner");
					const descriptor = attachmentIdentity(upload.attachment);
					if (descriptor.uploadId !== uploadId || descriptor.clientMessageId !== source.sourceEventId)
						throw new EngineInboxConflictError("Attachment belongs to another message");
					attachmentDescriptors.push(descriptor);
					// The inbox source now owns the body; its upload row goes in the same batch (C5 consumed).
					await tx.delete("metadata", `blob-upload:${key}`);
				}
			}
			if (!original)
				await tx.put("inbox", `source:${source.sourceEventId}`, {
					subtype: "source",
					agent_instance_id: target.agentInstanceId,
					source_event_id: source.sourceEventId,
					body: source.body,
					source_type: source.sourceType,
					sender: source.sender ?? null,
					attachment_refs: source.attachments ?? null,
					...(attachmentDescriptors.length ? { attachment_descriptors: attachmentDescriptors } : {}),
					created_at: source.createdAt ?? Date.now(),
				});
			const command = await tx.get<RocksCommand>("command", commandId);
			if (command?.pending_accounted) {
				await this.pendingBudget(
					tx,
					command.agent_instance_id,
					Boolean(command.control_admission),
					-1,
					-command.payload_bytes,
				);
				await tx.put("command", commandId, { ...command, pending_accounted: false });
			}
			await this.pendingBudget(
				tx,
				target.agentInstanceId,
				false,
				1,
				Buffer.byteLength(source.body) +
					Buffer.byteLength(source.attachments ? JSON.stringify(source.attachments) : ""),
			);
			const position = await this.counter(tx, `inbox-position:${target.sessionId}`, "inbox_position", 1024);
			const item: RocksInbox = {
				subtype: "item",
				queueId: source.sourceEventId,
				queue_id: source.sourceEventId,
				source_event_id: source.sourceEventId,
				sessionId: target.sessionId,
				session_id: target.sessionId,
				agentInstanceId: target.agentInstanceId,
				agent_instance_id: target.agentInstanceId,
				attemptId: target.attemptId,
				attempt_id: target.attemptId,
				execution_id: target.executionId,
				binding_id: target.bindingId,
				engine_generation: target.engineGeneration,
				binding_generation: target.bindingGeneration,
				authority_generation: target.authorityGeneration,
				sourceEventId: source.sourceEventId,
				sourceType: source.sourceType,
				...(source.sender ? { sender: source.sender } : {}),
				sourceBody: source.body,
				deliveryPayload: source.body,
				...(source.attachments ? { attachments: source.attachments } : {}),
				...(attachmentDescriptors.length
					? { attachmentDescriptors, attachment_descriptors: attachmentDescriptors }
					: {}),
				...(source.deliverAt !== undefined ? { deliverAt: source.deliverAt } : {}),
				deliver_at: source.deliverAt ?? null,
				wakeIntent: source.wakeIntent ?? false,
				wake_intent: source.wakeIntent ? 1 : 0,
				wake_delivered_at: null,
				position,
				disposition: "pending",
				revision: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			await tx.put("inbox", item.queueId, item);
			await this.inboxEvent(tx, target, commandId, "queued", item);
			return { item, created: true };
		});
	}
	async inboxEvent(
		tx: RuntimeTransaction,
		target: EngineInboxTarget,
		command: string,
		action: string,
		item: RocksInbox,
	): Promise<EngineEvent> {
		const identity = await tx.get<RocksIdentity>("identity", target.agentInstanceId);
		if (identity) {
			const pending =
				identity.queue_pending_count +
				(action === "queued" ? 1 : action === "acknowledge" || action === "drop" ? -1 : 0);
			if (pending < 0) throw new EngineInboxConflictError("Inbox pending count is invalid");
			await tx.put("identity", target.agentInstanceId, {
				...identity,
				queue_revision: identity.queue_revision + 1,
				queue_pending_count: pending,
			});
		}
		return this.append(
			tx,
			{ ...target, commandId: command },
			{
				kind: "inbox_changed",
				payload: { action, queueId: item.queueId, revision: item.revision, sourceEventId: item.sourceEventId },
			},
		);
	}
	async mutateInbox(
		tx: RuntimeTransaction,
		target: EngineInboxTarget,
		mutation: EngineInboxMutation,
		command = mutation.mutationId,
	): Promise<{ item: EngineInboxItem; event?: EngineEvent }> {
		const old = await tx.get<RocksInbox>("inbox", mutation.queueId);
		if (!old || old.session_id !== target.sessionId || !this.sameFence(old, { ...target, commandId: command }))
			throw new EngineInboxConflictError("Inbox target changed");
		const item = { ...old };
		if (mutation.op === "edit") {
			if (typeof mutation.value !== "string" || (!mutation.value.trim() && !item.attachments))
				throw new EngineInboxConflictError("Inbox requires text or attachments");
			item.deliveryPayload = mutation.value;
		} else if (mutation.op === "annotate") {
			if (mutation.value !== null && typeof mutation.value !== "string")
				throw new EngineInboxConflictError("Invalid annotation");
			item.annotation = mutation.value?.trim() || undefined;
		} else if (mutation.op === "defer") {
			if (
				mutation.value !== null &&
				(typeof mutation.value !== "number" || !Number.isSafeInteger(mutation.value) || mutation.value < 0)
			)
				throw new EngineInboxConflictError("Invalid delivery instant");
			item.deliverAt = mutation.value ?? undefined;
			item.deliver_at = mutation.value;
			item.wakeIntent = true;
			item.wake_intent = 1;
		} else item.disposition = mutation.op === "acknowledge" ? "acknowledged" : "dropped";
		if (
			item.deliveryPayload === old.deliveryPayload &&
			item.annotation === old.annotation &&
			item.deliverAt === old.deliverAt &&
			item.wakeIntent === old.wakeIntent &&
			item.disposition === old.disposition
		)
			return { item: old };
		if (old.revision !== mutation.expectedRevision) throw new EngineInboxConflictError("Inbox revision changed");
		if (old.disposition !== "pending") throw new EngineInboxConflictError("Inbox item is already settled");
		const oldBytes =
			Buffer.byteLength(old.deliveryPayload) +
			Buffer.byteLength(old.annotation ?? "") +
			Buffer.byteLength(old.attachments ? JSON.stringify(old.attachments) : "");
		const newBytes =
			Buffer.byteLength(item.deliveryPayload) +
			Buffer.byteLength(item.annotation ?? "") +
			Buffer.byteLength(item.attachments ? JSON.stringify(item.attachments) : "");
		await this.pendingBudget(
			tx,
			target.agentInstanceId,
			false,
			item.disposition === "pending" ? 0 : -1,
			item.disposition === "pending" ? newBytes - oldBytes : -oldBytes,
		);
		item.revision++;
		item.updatedAt = Date.now();
		item.wake_delivered_at = null;
		delete item.wakeDeliveredAt;
		await tx.put("inbox", item.queueId, item);
		return { item, event: await this.inboxEvent(tx, target, command, mutation.op, item) };
	}
	async mutateInboxItem(target: EngineInboxTarget, mutation: EngineInboxMutation): Promise<EngineInboxItem> {
		return (await this.mutateInboxItemWithEvent(target, mutation)).item;
	}
	async mutateInboxItemWithEvent(
		target: EngineInboxTarget,
		mutation: EngineInboxMutation,
		command?: string,
	): Promise<{ item: EngineInboxItem; event?: EngineEvent }> {
		return this.mutation(target.agentInstanceId, tx => this.mutateInbox(tx, target, mutation, command));
	}
	async listInboxItems(session: string, includeTerminal = false): Promise<EngineInboxItem[]> {
		const result: EngineInboxItem[] = [];
		for (const state of includeTerminal ? ["pending", "acknowledged", "dropped"] : ["pending"]) {
			const page = await this.records.query("inbox_session", [session, state]);
			if (page.nextCursor) throw new EngineTargetError("restore_budget", "Inbox exceeds bounded working set");
			result.push(...page.records.map(row => row.value as unknown as RocksInbox));
		}
		return result.sort((a, b) => a.position - b.position || a.queueId.localeCompare(b.queueId));
	}
	async getInboxItem(session: string, id: string): Promise<EngineInboxItem | undefined> {
		const row = await this.getInboxItemByQueueId(id);
		return row?.sessionId === session ? row : undefined;
	}
	async getInboxItemByQueueId(id: string): Promise<EngineInboxItem | undefined> {
		const row = (await this.records.get("inbox", id)).value as unknown as RocksInbox | null;
		return row?.subtype === "item" ? row : undefined;
	}
	async rearmInboxWake(id: string, revision: number): Promise<boolean> {
		return this.mutation(`inbox:${id}`, async tx => {
			const item = await tx.get<RocksInbox>("inbox", id);
			if (
				!item ||
				item.revision !== revision ||
				item.disposition !== "pending" ||
				!item.wake_intent ||
				item.wake_delivered_at === null
			)
				return false;
			delete item.wakeDeliveredAt;
			item.wake_delivered_at = null;
			item.revision++;
			item.updatedAt = Date.now();
			await tx.put("inbox", id, item);
			return true;
		});
	}
	async reorderInboxItems(
		target: EngineInboxTarget,
		id: string,
		expected: readonly string[],
		desired: readonly string[],
	): Promise<EngineInboxItem[]> {
		return (await this.reorderInboxItemsWithEvent(target, id, expected, desired)).items;
	}
	async reorderInboxItemsWithEvent(
		target: EngineInboxTarget,
		id: string,
		expected: readonly string[],
		desired: readonly string[],
		revision?: number,
	): Promise<{ items: EngineInboxItem[]; event?: EngineEvent }> {
		if (!id || new Set(desired).size !== desired.length)
			throw new EngineInboxConflictError("Reorder IDs must be unique");
		return this.mutation(target.agentInstanceId, async tx => {
			const identity = await tx.get<RocksIdentity>("identity", target.agentInstanceId);
			if (revision !== undefined && identity?.queue_revision !== revision)
				throw new EngineInboxConflictError("Queue revision changed");
			const rows = await tx.query<RocksInbox>("inbox_session", [target.sessionId, "pending"]);
			for (const row of rows)
				if (!this.sameFence(row, { ...target, commandId: id }))
					throw new EngineInboxConflictError("Inbox target changed");
			rows.sort((a, b) => a.position - b.position || a.queueId.localeCompare(b.queueId));
			const current = rows.map(row => row.queueId);
			if (JSON.stringify(current) === JSON.stringify(desired)) return { items: rows };
			if (
				JSON.stringify(current) !== JSON.stringify(expected) ||
				current.length !== desired.length ||
				desired.some(key => !current.includes(key))
			)
				throw new EngineInboxConflictError("Inbox order changed");
			const items: RocksInbox[] = [];
			for (const [index, key] of desired.entries()) {
				const row = rows.find(item => item.queueId === key)!;
				row.position = (index + 1) * 1024;
				row.revision++;
				row.wake_delivered_at = null;
				delete row.wakeDeliveredAt;
				await tx.put("inbox", key, row);
				items.push(row);
			}
			return { items, ...(items[0] ? { event: await this.inboxEvent(tx, target, id, "reorder", items[0]) } : {}) };
		});
	}
	async nextInboxWakeAt(generation: number): Promise<number | undefined> {
		let after: Array<string | number | null> | undefined;
		do {
			const page = await this.records.query("inbox_wake", [generation], undefined, 50, after);
			for (const record of page.records) {
				const item = record.value as unknown as RocksInbox;
				const binding = await this.getBinding(item.agent_instance_id);
				const gate = await this.semanticGate(item.agent_instance_id);
				if (gate && (!this.#installation || gate.phase !== "open")) continue;
				if (!binding || binding.manualHold || binding.state === "running") continue;
				const first = (await this.records.query("inbox_session", [item.sessionId, "pending"], undefined, 1))
					.records[0];
				if (first?.id === item.queueId) return item.deliver_at ?? item.createdAt;
			}
			const last = page.records.at(-1);
			after = page.nextCursor && last ? [(last.value as unknown as RocksInbox).deliver_at, last.id] : undefined;
		} while (after);
		return undefined;
	}
	async claimDueInboxWakes(generation: number, now = Date.now()): Promise<EngineEvent[]> {
		const events: EngineEvent[] = [];
		let after: Array<string | number | null> | undefined;
		do {
			const page = await this.records.query("inbox_wake", [generation], undefined, 50, after);
			for (const record of page.records) {
				const observed = record.value as unknown as RocksInbox;
				if ((observed.deliver_at ?? observed.createdAt) > now) continue;
				const event = await this.mutation(observed.agent_instance_id, async tx => {
					const item = await tx.get<RocksInbox>("inbox", record.id);
					const gate = (await tx.get<{ gate: EngineBindingGate }>("metadata", `semantic-binding:${observed.agent_instance_id}`))?.gate;
					if (gate && (!this.#installation || gate.phase !== "open")) return;
					if (
						item?.disposition !== "pending" ||
						item.wake_delivered_at !== null ||
						item.engine_generation !== generation
					)
						return;
					const binding = await tx.get<RocksBinding>("binding", item.agent_instance_id);
					const identity = await tx.get<RocksIdentity>("identity", item.agent_instance_id);
					if (
						!binding ||
						binding.manual_hold ||
						binding.state === "running" ||
						(await this.holds(tx, item.agent_instance_id)).length
					)
						return;
					const pending = await tx.query<RocksInbox>("inbox_session", [item.sessionId, "pending"]);
					pending.sort((a, b) => a.position - b.position || a.queueId.localeCompare(b.queueId));
					if (pending[0]?.queueId !== item.queueId) return;
					item.wake_delivered_at = now;
					item.wakeDeliveredAt = now;
					item.revision++;
					await tx.put("inbox", item.queueId, item);
					if (identity)
						await tx.put("identity", item.agent_instance_id, {
							...identity,
							queue_revision: identity.queue_revision + 1,
						});
					return this.append(
						tx,
						{ ...bindingSnapshot(binding), commandId: `inbox-wake:${item.queueId}:${item.revision}` },
						{
							kind: "inbox_changed",
							payload: {
								action: "wake_due",
								queueId: item.queueId,
								revision: item.revision,
								intentRevision: identity?.intent_revision ?? 0,
								manualHold: false,
							},
						},
					);
				});
				if (event) events.push(event);
				if (events.length >= 25) return events;
			}
			const last = page.records.at(-1);
			after = page.nextCursor && last ? [(last.value as unknown as RocksInbox).deliver_at, last.id] : undefined;
		} while (after);
		return events;
	}

	/** Bounded tool-effect ledger of one Attempt, used to map retained native calls to exact effects. */
	async attemptToolEffects(attemptId: string): Promise<RocksEffect[]> {
		const effects: RocksEffect[] = [];
		for (const state of ["planned", "started", "settled"]) {
			const page = await this.records.query("effect_attempt", [attemptId, state], undefined, 1_000);
			if (page.nextCursor) throw new EngineTargetError("restore_budget", "Attempt effect ledger exceeds recovery bound");
			effects.push(...page.records.map(row => row.value as unknown as RocksEffect));
		}
		return effects;
	}

	/** Stable response owners survive compaction and event retention; pointers name exact native entries. */
	async attemptMessageOwnership(agentId: string, attemptId: string): Promise<Map<string, string | null>> {
		const messages = new Map<string, string | null>();
		let cursor: string | undefined;
		do {
			const page = await this.records.query("projection_attempt", ["ownership", attemptId], cursor);
			for (const record of page.records) {
				const owner = record.value as unknown as RocksProjection;
				if (owner.subtype !== "ownership" || owner.agent_instance_id !== agentId || owner.attempt_id !== attemptId)
					throw new EngineTargetError("stale_target", "Response ownership changed its Attempt");
				if (typeof owner.value.messageId === "string")
					messages.set(owner.value.messageId,
						typeof owner.value.historyEntryId === "string" ? owner.value.historyEntryId : null);
			}
			if (page.nextCursor && page.nextCursor === cursor)
				throw new EngineTargetError("source_unavailable", "Response ownership cursor did not advance");
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		return messages;
	}

	/** Only native tool effects fenced by their own undecided or decided-but-unapplied approval survive. */
	retainedApproval(effect: RocksEffect, approval: EngineApprovalRow | undefined, attemptId: string): boolean {
		if (!approval || effect.effect_kind !== "tool" || approval.request.requester_attempt_id !== attemptId ||
			approval.request.effect_id !== effect.effect_id) return false;
		if (effect.state === "started")
			return approval.request.kind === "escalation" && approval.request.status !== "cancelled";
		return effect.state === "planned" && approval.request.kind !== "escalation" &&
			(approval.state === "pending" || approval.request.status === "approved");
	}

	/** A settled pause survives only when every open effect has its exact pending or decided approval. */
	async durableApprovalPause(attemptId: string): Promise<ApprovalRequest[] | undefined> {
		const attempt = await this.getAttempt(attemptId);
		if (attempt?.state !== "paused" || attempt.cause !== "approval_deadline" || !attempt.execution ||
			!attempt.transcript_native) return undefined;
		const binding = await this.getBinding(attempt.agent_instance_id);
		if (binding?.attemptId !== attemptId || binding.state !== "running" ||
			!binding.sessionFile?.startsWith("native:")) return undefined;
		const effects = [
			...(await this.records.query("effect_attempt", [attemptId, "planned"], undefined, 1_000)).records,
			...(await this.records.query("effect_attempt", [attemptId, "started"], undefined, 1_000)).records,
		];
		if (effects.length >= 1_000) return undefined;
		const approvals: ApprovalRequest[] = [];
		for (const row of effects) {
			const effect = row.value as unknown as RocksEffect;
			const approval = await this.getApproval(effect.effect_id);
			if (!this.retainedApproval(effect, approval, attemptId)) return undefined;
			approvals.push(approval!.request);
		}
		if (!effects.length) {
			const marker = (await this.records.get("metadata", `approval-recovery:${attemptId}`)).value as
				{ request_id?: string } | null;
			const approval = marker?.request_id ? await this.getApproval(marker.request_id) : undefined;
			if (!approval || approval.request.requester_attempt_id !== attemptId ||
				approval.request.status !== "denied" || approval.state !== "resolved")
				return undefined;
			approvals.push(approval.request);
		}
		return approvals;
	}

	/** Transfer only the paused Attempt's fence; never re-admit its Start or rewrite its effect ledger. */
	async recoverPausedApproval(attemptId: string, generation: number): Promise<EngineBindingSnapshot | undefined> {
		const approvals = await this.durableApprovalPause(attemptId);
		if (!approvals) return undefined;
		const attempt = await this.getAttempt(attemptId);
		if (!attempt) return undefined;
		return this.mutation(attempt.agent_instance_id, async tx => {
			const current = await tx.get<RocksAttempt>("attempt", attemptId);
			const binding = await tx.get<RocksBinding>("binding", attempt.agent_instance_id);
			const engine = await tx.get<{ generation: number }>("metadata", "engine");
			if (!current || current.state !== "paused" || current.cause !== "approval_deadline" ||
				binding?.attempt_id !== attemptId || engine?.generation !== generation ||
				current.engine_generation >= generation || binding.engine_generation !== current.engine_generation)
				return undefined;
			const effects = [
				...await tx.query<RocksEffect>("effect_attempt", [attemptId, "planned"]),
				...await tx.query<RocksEffect>("effect_attempt", [attemptId, "started"]),
			];
			for (const effect of effects)
				if (!this.retainedApproval(effect, await tx.get<EngineApprovalRow>("approval", effect.effect_id), attemptId))
					return undefined;
			await tx.put("binding", attempt.agent_instance_id, { ...binding, engine_generation: generation });
			await tx.put("attempt", attemptId, { ...current, engine_generation: generation });
			for (const effect of effects)
				await tx.put("effect", effect.effect_id, { ...effect, engine_generation: generation });
			return { ...bindingSnapshot(binding), engineGeneration: generation };
		});
	}

	async interruptGeneration(generation: number, notify?: (events: EngineEvent[]) => void,
		retain?: (attemptId: string) => void): Promise<EngineEvent[]> {
		// Admission starts only after this scan. Every bounded commit records its own guarded decisions.
		const events: EngineEvent[] = [];
		const deliver = (changed: EngineEvent[]) => {
			if (notify) notify(changed);
			else {
				if (events.length + changed.length > 1000)
					throw new EngineTargetError("restore_budget", "Use paged recovery notifications");
				events.push(...changed);
			}
		};
		// Only in-flight work is indexed (open attempts, received commands, pending inbox items), so recovery
		// never walks history. Collect first: every recovery write below shrinks these partitions.
		const work = new Map<string, RocksAttempt[]>();
		for (const index of ["attempt_open", "command_received", "inbox_pending"] as const) {
			let after: string | undefined;
			do {
				const page = await this.records.query(index, [], undefined, 100, after ? [after] : undefined);
				for (const row of page.records) {
					const value = row.value as { agent_instance_id: string; engine_generation: number } | null;
					if (!value || value.engine_generation >= generation) continue;
					const attempts = work.get(value.agent_instance_id) ?? [];
					if (index === "attempt_open") attempts.push(value as unknown as RocksAttempt);
					work.set(value.agent_instance_id, attempts);
				}
				after = page.nextCursor ? page.records.at(-1)?.id : undefined;
			} while (after);
		}
		for (const [id, attempts] of work) {
			attempts.sort((a, b) => a.created_at - b.created_at || a.attempt_id.localeCompare(b.attempt_id));
			const durable = new Set<string>();
			for (const attempt of attempts)
				if (await this.durableApprovalPause(attempt.attempt_id)) durable.add(attempt.attempt_id);
			const onlyDurable = durable.size > 0 && durable.size === attempts.length;
			let held = false;
			const ensureHold = async () => {
				if (held) return;
				deliver(
					await this.mutation(id, async tx => {
						const identity = await tx.get<RocksIdentity>("identity", id);
						if (!identity) return [];
						// A recovery hold from an earlier restart still waits for the user; placing it again
						// would only bump the intent revision and stale every pending UI command.
						if (await tx.get<RocksHold>("hold", `${id}:recovery`)) return [];
						identity.intent_revision++;
						await tx.put("identity", id, identity);
						await tx.put("hold", `${id}:recovery`, {
							source_agent_instance_id: id,
							agent_instance_id: id,
							kind: "recovery",
							command_id: `recovery:${generation}`,
							generation: identity.intent_revision,
						});
						const binding = await tx.get<RocksBinding>("binding", id);
						if (binding)
							await tx.put("binding", id, {
								...binding,
								manual_hold: 1,
								intent_revision: identity.intent_revision,
							});
						return [
							await this.identityEvent(tx, id, `recovery:${generation}`, "holds_changed", {
								action: "recovery",
								requiresExplicitContinue: true,
							}),
						];
					}),
				);
				held = true;
			};
			const pendingInbox = await this.records.query("inbox_agent_pending", [id], undefined, 1);
			if (!onlyDurable && pendingInbox.records.some(row => Number(row.value?.engine_generation) < generation))
				await ensureHold();
			// Stable ordering skips protected Starts without looping on the unchanged pending row.
			let commandAfter: Array<string | number | null> | undefined;
			for (;;) {
				const pending = await this.records.query("command_agent_pending", [id], undefined, 1, commandAfter);
				const command = pending.records[0]?.value as unknown as RocksCommand | undefined;
				if (!command) break;
				commandAfter = [command.received_at, command.command_id];
				if (command.engine_generation >= generation) continue;
				if (command.operation === "resume") await this.cancelResumeQueues(command.command_id, command.canonical_hash, generation);
				const messageAcceptance = await this.acceptedResumeMessage(command).catch(() => "unknown" as const);
				if (!onlyDurable || command.operation === "resume") await ensureHold();
				await this.mutation(id, async tx => {
					const current = await tx.get<RocksCommand>("command", command.command_id);
					if (current?.state === "received" && current.engine_generation < generation)
						await this.settleInterrupted(tx, current.command_id, generation, messageAcceptance);
				});
			}
			for (const observed of attempts) {
				if (durable.has(observed.attempt_id)) continue;
				await ensureHold();
				const target: EventTarget = {
					commandId: observed.command_id,
					agentInstanceId: id,
					executionId: observed.execution_id,
					attemptId: observed.attempt_id,
					bindingId: observed.binding_id,
					engineGeneration: generation,
					bindingGeneration: observed.binding_generation,
					authorityGeneration: observed.authority_generation,
				};
				for (const state of ["planned", "started"])
					for (;;) {
						const effects = await this.records.query(
							"effect_attempt",
							[observed.attempt_id, state],
							undefined,
							1,
						);
						const effectId = effects.records[0]?.id;
						if (!effectId) break;
						deliver(
							await this.mutation(id, async tx => {
								const effect = await tx.get<RocksEffect>("effect", effectId);
								if (!effect || effect.state !== state || effect.engine_generation >= generation) return [];
								const approval = await tx.get<EngineApprovalRow>("approval", effectId);
								const cancelledEscalation = state === "started" && approval?.request.kind === "escalation" &&
									approval.request.status !== "approved";
								await tx.put("effect", effectId, {
									...effect,
									state: state === "started" && !cancelledEscalation ? "unknown" : "settled",
									outcome: state === "started" && !cancelledEscalation ? "unknown" : "cancelled",
									error: cancelledEscalation ? "escalation_unperformed" : "engine_lost",
								});
								const approvalEvents: EngineEvent[] = [];
								if (approval?.state === "pending") {
									const resolved = { ...approval.request, status: "cancelled" as const,
										decision_revision: approval.request.decision_revision + 1 };
									await tx.put("approval", effectId, {
										...approval, state: "resolved", decision: "cancelled", updated_at: Date.now(),
										request: resolved,
									} satisfies EngineApprovalRow);
									approvalEvents.push(await this.append(tx, target, {
										kind: `${approval.request.kind}_approval_resolved`,
										payload: { request_id: effectId, decision_revision: resolved.decision_revision,
											outcome: "cancelled", decided_by: null },
									}));
								}
								await this.counter(tx, `effects:${effect.attempt_id}:${effect.binding_id}`, "open_effects", -1);
								return [
									...approvalEvents,
									await this.append(tx, target, {
										kind: effect.effect_kind === "model" ? "model_settled" : "tool_settled",
										payload: {
											...(effect.effect_kind === "model"
												? modelEffectPayload(effect)
												: toolEffectPayload(effect)),
											status: state === "started" && !cancelledEscalation ? "unknown" : "cancelled",
											error: cancelledEscalation ? "escalation_unperformed" : "engine_lost",
										},
									}),
								];
							}),
						);
					}
				deliver(
					await this.mutation(id, async tx => {
						const attempt = await tx.get<RocksAttempt>("attempt", observed.attempt_id);
						if (!attempt || terminal.has(attempt.state) || attempt.engine_generation >= generation) return [];
						const open = await tx.get<{ count: number }>(
							"metadata",
							`effects:${attempt.attempt_id}:${attempt.binding_id}`,
						);
						if (open?.count) throw new EngineEffectConflictError(attempt.attempt_id);
						await tx.put("attempt", attempt.attempt_id, {
							...attempt,
							state: "interrupted",
							cause: "engine_lost",
							retry_outcome: attempt.retry_outcome === "waiting" ? "interrupted" : attempt.retry_outcome,
						});
						await stageRelease(tx, attempt.attempt_id);
						return [
							...(await settleRuntimeMessages(tx, target, "interrupted", (tx, target, event) =>
								this.append(tx, target, event),
							)),
							await this.append(tx, target, {
								kind: "interrupted",
								payload: { reason: "engine_lost", requiresExplicitContinue: true },
							}),
						];
					}),
				);
			}
			if (onlyDurable) for (const attemptId of durable) retain?.(attemptId);
			if (held)
				await this.mutation(id, async tx => {
					const binding = await tx.get<RocksBinding>("binding", id);
					if (binding && binding.engine_generation < generation)
						await tx.put("binding", id, { ...binding, state: "released", manual_hold: 1 });
				});
		}
		return events;
	}
	async pendingEvents(limit = 100): Promise<EngineEvent[]> {
		return (await this.records.query("event_pending", [], undefined, Math.max(1, Math.min(1000, limit)))).records.map(
			row => row.value as unknown as RocksEvent,
		);
	}
	async pendingEventsForSink(
		sink: string,
		limit = 100,
		after = 0,
	): Promise<{ events: EngineEvent[]; throughCursor: number; scannedRecords: number }> {
		const page = await this.records.query("event_all", [], undefined, Math.max(1, Math.min(1000, limit)), [after]);
		const events: EngineEvent[] = [];
		let throughCursor = after;
		for (const row of page.records) {
			const event = row.value as unknown as RocksEvent;
			if (event.eventId <= after) continue;
			throughCursor = event.eventId;
			if ((await this.records.get("delivery", `${sink}:${event.eventId}`)).value?.state !== "delivered")
				events.push(event);
		}
		return { events, throughCursor, scannedRecords: page.records.length };
	}
	async markEventDeliveryFailed(id: number, sink: string, error: string): Promise<void> {
		await this.mutation(`delivery:${sink}`, async tx => {
			const old = await tx.get<{ state: string; attempts: number }>("delivery", `${sink}:${id}`);
			if (old?.state === "delivered") return;
			await tx.put("delivery", `${sink}:${id}`, {
				event_id: id,
				sink_id: sink,
				state: "pending",
				attempts: (old?.attempts ?? 0) + 1,
				last_error: error.slice(0, 2048),
			});
		});
	}
	async markEventDelivered(id: number, sink: string): Promise<void> {
		await this.markEventsDelivered([id], sink);
	}
	async markEventsDelivered(ids: readonly number[], sink: string): Promise<void> {
		await this.mutation(`delivery:${sink}`, async tx => {
			for (const id of ids) {
				const agent = sink === "hosted-binding"
					? (await tx.get<RocksEvent>("event", String(id)))?.agent_instance_id : undefined;
				const identity = agent ? await tx.get<RocksIdentity>("identity", agent) : undefined;
				await tx.put("delivery", `${sink}:${id}`, {
					event_id: id, sink_id: sink, state: "delivered",
					...(agent && typeof identity?.deleted_at !== "number" ? { agent_instance_id: agent } : {}),
				});
			}
		});
	}
	async markEventPublished(id: number): Promise<void> {
		await this.mutation(`event:${id}`, async tx => {
			const event = await tx.get<RocksEvent>("event", String(id));
			if (event) await tx.put("event", String(id), { ...event, published_at: Date.now() });
		});
	}
}
