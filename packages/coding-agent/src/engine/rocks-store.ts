import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseNativeSessionLocator } from "../session/rocks-native-session-storage";
import type { SessionDurabilityCheckpoint } from "../session/session-manager";
import type { StorageClient } from "../session/storage-client";
import type { StorageDependency } from "../session/storage-protocol";
import type {
	EngineAttemptState,
	EngineBindingSnapshot,
	EngineEvent,
	EngineInboxItem,
	EngineInboxMutation,
	EngineInboxSource,
	EngineInboxTarget,
	EngineProfileRouteState,
	EngineRetryState,
} from "./contracts";
import { EngineTargetError } from "./contracts";
import {
	completeRestoreRebind,
	type RestoreWorkspaceDescriptor,
	type RestoreWorkspaceReceipt,
	restoreDescriptor,
	validateRestorePlan,
} from "./rocks-restore-workspace";
import { projectionId, runtimeReceipt, settleRuntimeMessages } from "./rocks-runtime-projection";
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
} from "./rocks-runtime-rows";
import {
	attachmentIdentity,
	attachmentUploadKey,
	type EngineAttachment,
	messageAttachmentReferences,
} from "./runtime-attachments";
import { ENGINE_CONTROL_OPS, runtimeLimits, validateRuntimeValue } from "./runtime-protocol";
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
	intentGuard?: { expectedRevision?: number; requireUnheld?: boolean; inputId?: string; inputRevision?: number };
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
	conversationIdentityDigest?: string;
	previousInboxSessionId?: string;
	pendingInboxSourceSessionId?: string;
	restoreWorkspaceReceipt?: RestoreWorkspaceReceipt;
}

/** Product state transitions remain here; the storage owner checks every observed revision and commits the batch. */
export class RocksEngineMutations {
	readonly records: RuntimeRecords;
	#change = Promise.withResolvers<void>();
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
	async mutation<T>(
		scope: string,
		work: (tx: RuntimeTransaction) => Promise<T>,
		dependencies: StorageDependency[] = [],
		durability: "required" | "buffered" = "required",
	): Promise<T> {
		const result = await this.records.mutate(scope, work, dependencies, durability);
		const change = this.#change;
		this.#change = Promise.withResolvers<void>();
		change.resolve();
		return result;
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
		const page = await this.records.query("kind_primary", ["identity"], cursor, 100);
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
	async getBindingConversationIdentity(id: string): Promise<string | undefined> {
		return (await this.records.get("binding", id)).value?.conversation_identity_digest as string | undefined;
	}
	async getStartConversationIdentity(id: string): Promise<EngineCommandIdentity | undefined> {
		return ((await this.records.get("command", id)).value as unknown as RocksCommand | null)?.identity;
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
		return this.mutation(command.agentInstanceId, async tx => {
			if ((await tx.get<{ generation: number }>("metadata", "engine"))?.generation !== processorGeneration)
				throw new EngineTargetError("stale_target", "Command processor generation changed");
			const old = await tx.get<RocksCommand>("command", command.commandId);
			if (old) {
				if (old.canonical_hash !== command.canonicalHash) throw new EngineCommandConflictError(command.commandId);
				if (old.state === "settled") {
					if (!old.receipt) throw new Error("Settled command has no receipt");
					return { status: "replay", receipt: old.receipt };
				}
				if (old.processor_generation === processorGeneration) return { status: "in_progress" };
				if (old.processor_generation !== null || command.engineGeneration < processorGeneration) {
					const receipt = this.interruptedReceipt();
					await this.settle(tx, command.commandId, receipt, command.canonicalHash);
					return { status: "replay", receipt };
				}
				await tx.put("command", command.commandId, {
					...old,
					processor_generation: processorGeneration,
					updated_at: Date.now(),
				});
				return { status: "claimed" };
			}
			const lifecycle = await tx.get<RocksIdentity>("identity", command.agentInstanceId);
			if (lifecycle?.deleted_at || lifecycle?.archived_at)
				throw new EngineTargetError("stale_target", "Chat is archived or deleted");
			const control = ENGINE_CONTROL_OPS.has(command.operation);
			const bytes = Buffer.byteLength(command.serializedCommand ?? "");
			await this.pendingBudget(tx, command.agentInstanceId, control, 1, bytes);
			await this.register(tx, command);
			await tx.put("command", command.commandId, {
				command_id: command.commandId,
				agent_instance_id: command.agentInstanceId,
				processor_generation: processorGeneration,
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
			if (command.engineGeneration < processorGeneration) {
				const receipt = this.interruptedReceipt();
				await this.settle(tx, command.commandId, receipt);
				return { status: "replay", receipt };
			}
			return { status: "claimed" };
		});
	}
	interruptedReceipt(): EngineCommandReceipt {
		return {
			outcome: "rejected",
			detail: {
				code: "interrupted",
				message: "Execution was interrupted; explicit Continue is required",
				requiresExplicitContinue: true,
			},
		};
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
			if (!start && !fenced) return { status: "not_found" };
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
	async settleCommand(id: string, hash: string, receipt: EngineCommandReceipt): Promise<void> {
		await this.mutation(`command:${id}`, tx => this.settle(tx, id, receipt, hash, true));
	}
	async settle(
		tx: RuntimeTransaction,
		id: string,
		receipt: EngineCommandReceipt,
		hash?: string,
		required = false,
	): Promise<void> {
		const row = await tx.get<RocksCommand>("command", id);
		if (!row) {
			if (required) throw new Error(`Command ${id} was not admitted`);
			return;
		}
		if (hash && hash !== row.canonical_hash) throw new EngineCommandConflictError(id);
		if (row.state === "settled") {
			if (JSON.stringify(row.receipt) !== JSON.stringify(receipt)) throw new EngineCommandConflictError(id);
			return;
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
		const identity = await tx.get<RocksIdentity>("identity", row.agent_instance_id);
		const attempt = row.identity.attemptId
			? await tx.get<RocksAttempt>("attempt", row.identity.attemptId)
			: undefined;
		const value = runtimeReceipt(settled, identity, attempt);
		if (value) {
			const command = row.identity;
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
		}
	}

	async append(tx: RuntimeTransaction, target: EventTarget, event: EngineTransitionEvent): Promise<EngineEvent> {
		await tx.reserveEvents();
		const seq = await this.counter(tx, `agent-seq:${target.agentInstanceId}`, "agent_seq", 1);
		const eventId = await this.counter(tx, "events", "event_counter", 1);
		const stored: RocksEvent = {
			eventId,
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
			kind: event.kind,
			...(event.payload ? { payload: event.payload } : {}),
			event_id: eventId,
			agent_instance_id: target.agentInstanceId,
			attempt_id: target.attemptId,
			published_at: null,
		};
		await tx.put("event", String(eventId), stored);
		await this.projectEvent(tx, stored);
		return stored;
	}
	async identityEvent(
		tx: RuntimeTransaction,
		id: string,
		commandId: string,
		kind: EngineEvent["kind"],
		payload: Record<string, unknown>,
	): Promise<EngineEvent> {
		const identity = await tx.get<RocksIdentity>("identity", id);
		const binding = await tx.get<RocksBinding>("binding", id);
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
	async appendEvent(event: Omit<EngineEvent, "eventId" | "seq" | "createdAt">): Promise<EngineEvent> {
		return this.mutation(
			event.agentInstanceId,
			async tx => {
				const target = { ...event, commandId: event.causationCommandId };
				await this.assertFence(tx, target);
				return this.append(tx, target, { kind: event.kind, payload: event.payload });
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
			await this.assertFence(tx, target);
			const result = await this.append(tx, target, event);
			if (command) await this.settle(tx, command, typeof receipt === "string" ? { outcome: receipt } : receipt);
			return result;
		});
	}
	async bind(tx: RuntimeTransaction, binding: EngineBindingSnapshot, digest?: string): Promise<void> {
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
			profile_digest: binding.profileDigest,
			conversation_identity_digest: digest ?? old?.conversation_identity_digest ?? null,
			state: binding.state,
			manual_hold: binding.manualHold || (await this.holds(tx, binding.agentInstanceId)).length ? 1 : 0,
			intent_revision: identity.intent_revision,
			intent_command_id: binding.intentCommandId ?? null,
			updated_at: Date.now(),
		} satisfies RocksBinding);
	}
	async putBinding(binding: EngineBindingSnapshot): Promise<void> {
		await this.mutation(binding.agentInstanceId, tx => this.bind(tx, binding));
	}
	async commitBindingEvent(
		binding: EngineBindingSnapshot,
		event: EngineTransitionEvent,
		id: string,
		receipt: EngineCommandReceipt,
	): Promise<EngineEvent> {
		return this.mutation(binding.agentInstanceId, async tx => {
			await this.assertFence(tx, binding);
			await this.bind(tx, binding);
			const result = await this.append(tx, binding, event);
			await this.settle(tx, id, receipt);
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
		events: readonly EngineTransitionEvent[],
		options: RocksTransitionOptions = {},
	): Promise<EngineEvent[]> {
		const native = options.transcriptCheckpoint?.native;
		if (state === "completed" && !native) throw new EngineAttemptConflictError(binding.attemptId);
		return this.mutation(
			binding.agentInstanceId,
			async tx => {
				const engine = await tx.get<{ generation: number }>("metadata", "engine");
				if (engine?.generation !== binding.engineGeneration)
					throw new EngineAttemptConflictError(binding.attemptId);
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
				await this.bind(tx, binding, options.conversationIdentityDigest);
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
					profile_route_state: null,
					result_payload: null,
					detail_revision: 0,
					input_revision: 0,
					message_revision: 0,
					tool_revision: 0,
					...old,
				};
				Object.assign(row, { state, cause: options.cause ?? null, updated_at: Date.now() });
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
				await tx.put("attempt", binding.attemptId, row);
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
				for (const event of events.length || !checkpoint
					? events
					: [{ kind: "reconciled" } as EngineTransitionEvent])
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
				return committed;
			},
			this.checkpointDependencies(options.transcriptCheckpoint),
		);
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
		const agentIds = [id];
		const events: EngineEvent[] = [];
		for (let index = 0; index < agentIds.length; index++) {
			if (agentIds.length > 64)
				throw new EngineTargetError("restore_budget", "Branch control exceeds its atomic budget");
			const agent = agentIds[index];
			const row = (await tx.get<RocksIdentity>("identity", agent))!;
			const children = await tx.query<RocksIdentity>("identity_parent", [agent]);
			for (const child of children) {
				if (agentIds.includes(child.agent_instance_id)) throw new Error("Agent ancestry cycle");
				agentIds.push(child.agent_instance_id);
			}
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
			events.push(
				await this.identityEvent(tx, agent, commandId, "holds_changed", {
					action,
					sourceAgentInstanceId: id,
					holds,
					holdsHasMore: false,
				}),
			);
		}
		return { agentIds, events, intentRevision: root.intent_revision + 1 };
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
			return this.changeIntent(tx, id, commandId, action, expected);
		});
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
		approval: boolean,
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
				if (approval)
					await tx.put("approval", input.effectId, {
						approval_id: input.effectId,
						effect_id: input.effectId,
						state: "pending",
						decision: null,
						updated_at: Date.now(),
					});
				return this.append(tx, target, {
					kind: approval ? "tool_approval_requested" : model ? "model_started" : "tool_started",
					payload: model
						? { effectId: input.effectId, modelCallId: modelCall }
						: {
								invocationId: input.effectId,
								toolCallId: tool?.toolCallId,
								toolName: tool?.toolName,
								policy: tool?.policy,
								inputHash: input.inputHash,
								...(tool?.origin ? { origin: tool.origin } : {}),
								...(approval ? { approvalId: input.effectId } : {}),
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
		return this.effectStart(target, effect, false, false, checkpoint);
	}
	async startModelEffect(
		target: EventTarget,
		effect: EngineModelEffectInput,
		checkpoint?: SessionDurabilityCheckpoint,
	): Promise<EngineEvent> {
		return this.effectStart(target, effect, true, false, checkpoint);
	}
	async requestToolApproval(
		target: EventTarget,
		effect: EngineToolEffectInput,
		checkpoint?: SessionDurabilityCheckpoint,
	): Promise<EngineEvent> {
		return this.effectStart(target, effect, false, true, checkpoint);
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
	async resolveToolApproval(
		target: EventTarget,
		id: string,
		decision: "approve" | "deny" | "cancelled",
		options: {
			reason?: string;
			causationCommandId?: string;
			settleCommandId?: string;
			expectedIntentRevision?: number;
			expectedInputRevision?: number;
		} = {},
	): Promise<EngineEvent[]> {
		return this.mutation(target.agentInstanceId, async tx => {
			await this.assertFence(tx, target);
			const approval = await tx.get<EngineApprovalRow>("approval", id);
			const effect = await tx.get<RocksEffect>("effect", id);
			if (approval?.state !== "pending" || effect?.state !== "planned" || !this.sameFence(effect, target))
				throw new EngineEffectConflictError(id);
			if (decision !== "cancelled")
				await this.checkIntent(tx, target.agentInstanceId, options.expectedIntentRevision, decision === "approve");
			if (options.expectedInputRevision !== undefined) {
				const attempt = await tx.get<RocksAttempt>("attempt", target.attemptId);
				if (attempt?.input_revision !== options.expectedInputRevision)
					throw new EngineTargetError("stale_target", "Input revision changed");
			}
			await tx.put("approval", id, {
				...approval,
				state: "resolved",
				decision,
				reason: options.reason ?? null,
				updated_at: Date.now(),
			});
			const events = [
				await this.append(tx, target, {
					kind: "tool_approval_resolved",
					causationCommandId: options.causationCommandId,
					payload: { approvalId: id, decision, ...(options.reason ? { reason: options.reason } : {}) },
				}),
			];
			if (decision === "approve") {
				await tx.put("effect", id, { ...effect, state: "started", updated_at: Date.now() });
				events.push(
					await this.append(tx, target, {
						kind: "tool_started",
						payload: {
							invocationId: id,
							toolCallId: effect.tool_call_id,
							toolName: effect.tool_name,
							policy: effect.policy,
							inputHash: effect.input_hash,
						},
					}),
				);
			} else
				events.push(
					await this.effectSettle(
						tx,
						target,
						id,
						decision === "deny" ? "denied" : "cancelled",
						options.reason ? { error: options.reason } : {},
					),
				);
			if (options.settleCommandId) await this.settle(tx, options.settleCommandId, { outcome: "applied" });
			return events;
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
	async commitAttemptProfileRoute(
		target: EngineBindingSnapshot,
		state: EngineProfileRouteState,
	): Promise<EngineEvent | undefined> {
		return this.mutation(target.agentInstanceId, async tx => {
			const row = await tx.get<RocksAttempt>("attempt", target.attemptId);
			if (!row || !this.sameFence(row, target) || terminal.has(row.state)) return undefined;
			await this.assertFence(tx, target);
			await tx.put("attempt", target.attemptId, { ...row, profile_route_state: JSON.stringify(state) });
			const event = await this.append(tx, target, {
				kind: "profile_route_changed",
				payload: { profileRoute: state },
			});
			await tx.put("attempt", target.attemptId, {
				...(await tx.get<RocksAttempt>("attempt", target.attemptId)),
				profile_route_state: JSON.stringify({ ...state, eventSeq: event.seq }),
			});
			return event;
		});
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
					if (upload?.subtype !== "blob_upload" || upload.owner_hash !== ownerHash || upload.state !== "ready")
						throw new EngineInboxConflictError("Attachment is not ready for this owner");
					const descriptor = attachmentIdentity(upload.attachment);
					if (descriptor.uploadId !== uploadId || descriptor.clientMessageId !== source.sourceEventId)
						throw new EngineInboxConflictError("Attachment belongs to another message");
					attachmentDescriptors.push(descriptor);
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
			const page = await this.records.query("inbox_wake", [], undefined, 50, after);
			for (const record of page.records) {
				const item = record.value as unknown as RocksInbox;
				if (item.engine_generation !== generation) continue;
				const binding = await this.getBinding(item.agent_instance_id);
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
			const page = await this.records.query("inbox_wake", [], undefined, 50, after);
			for (const record of page.records) {
				const observed = record.value as unknown as RocksInbox;
				if (observed.engine_generation !== generation) continue;
				if ((observed.deliver_at ?? observed.createdAt) > now) continue;
				const event = await this.mutation(observed.agent_instance_id, async tx => {
					const item = await tx.get<RocksInbox>("inbox", record.id);
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

	async interruptGeneration(generation: number, notify?: (events: EngineEvent[]) => void): Promise<EngineEvent[]> {
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
		let after: string | undefined;
		do {
			const page = await this.records.query(
				"kind_primary",
				["identity"],
				undefined,
				25,
				after ? [after] : undefined,
			);
			for (const record of page.records) {
				const id = record.id;
				let held = false;
				const ensureHold = async () => {
					if (held) return;
					deliver(
						await this.mutation(id, async tx => {
							const identity = await tx.get<RocksIdentity>("identity", id);
							if (!identity) return [];
							const hold = await tx.get<RocksHold>("hold", `${id}:recovery`);
							if (hold?.command_id === `recovery:${generation}`) return [];
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
				if (pendingInbox.records.some(row => Number(row.value?.engine_generation) < generation)) await ensureHold();
				// Requery the shrinking pending index; never carry its mutable cursor across a write.
				for (;;) {
					const pending = await this.records.query("command_agent_pending", [id], undefined, 1);
					const command = pending.records[0]?.value as unknown as RocksCommand | undefined;
					if (!command || command.engine_generation >= generation) break;
					await ensureHold();
					await this.mutation(id, async tx => {
						const current = await tx.get<RocksCommand>("command", command.command_id);
						if (current?.state === "received" && current.engine_generation < generation)
							await this.settle(tx, current.command_id, this.interruptedReceipt());
					});
				}
				let attemptAfter: Array<string | number | null> | undefined;
				do {
					const attempts = await this.records.query("attempt_agent", [id], undefined, 25, attemptAfter);
					for (const entry of attempts.records) {
						const observed = entry.value as unknown as RocksAttempt;
						if (observed.engine_generation >= generation || terminal.has(observed.state)) continue;
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
										if (!effect || effect.state !== state || effect.engine_generation >= generation)
											return [];
										await tx.put("effect", effectId, {
											...effect,
											state: state === "started" ? "unknown" : "settled",
											outcome: state === "started" ? "unknown" : "cancelled",
											error: "engine_lost",
										});
										const approval = await tx.get<EngineApprovalRow>("approval", effectId);
										if (approval?.state === "pending")
											await tx.put("approval", effectId, {
												...approval,
												state: "resolved",
												decision: "cancelled",
												reason: "engine_lost",
											});
										await this.counter(
											tx,
											`effects:${effect.attempt_id}:${effect.binding_id}`,
											"open_effects",
											-1,
										);
										return [
											await this.append(tx, target, {
												kind: effect.effect_kind === "model" ? "model_settled" : "tool_settled",
												payload: {
													...(effect.effect_kind === "model"
														? modelEffectPayload(effect)
														: toolEffectPayload(effect)),
													status: state === "started" ? "unknown" : "cancelled",
													error: "engine_lost",
												},
											}),
										];
									}),
								);
							}
						deliver(
							await this.mutation(id, async tx => {
								const attempt = await tx.get<RocksAttempt>("attempt", observed.attempt_id);
								if (!attempt || terminal.has(attempt.state) || attempt.engine_generation >= generation)
									return [];
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
					const last = attempts.records.at(-1);
					attemptAfter = attempts.nextCursor && last ? [Number(last.value?.created_at), last.id] : undefined;
				} while (attemptAfter);
				if (held)
					await this.mutation(id, async tx => {
						const binding = await tx.get<RocksBinding>("binding", id);
						if (binding && binding.engine_generation < generation)
							await tx.put("binding", id, { ...binding, state: "released", manual_hold: 1 });
					});
			}
			after = page.nextCursor ? page.records.at(-1)?.id : undefined;
		} while (after);
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
			for (const id of ids)
				await tx.put("delivery", `${sink}:${id}`, { event_id: id, sink_id: sink, state: "delivered" });
		});
	}
	async markEventPublished(id: number): Promise<void> {
		await this.mutation(`event:${id}`, async tx => {
			const event = await tx.get<RocksEvent>("event", String(id));
			if (event) await tx.put("event", String(id), { ...event, published_at: Date.now() });
		});
	}
}
