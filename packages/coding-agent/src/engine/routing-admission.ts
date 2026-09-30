import { createHash } from "node:crypto";
import { storageCanonicalJson } from "../session/storage-client";
import {
	type Candidate,
	type CandidateIdentity,
	type EngineExecutionConfiguration,
	type EngineSemanticBindingSnapshot,
	EngineTargetError,
	type ExecutorChoice,
	type InstructionRule,
	type RoutingLimits,
} from "./contracts";
import type {
	RocksAttempt,
	RocksCommand,
	RocksSlotLease,
	RocksSlotQueue,
	RocksWaitEdge,
	RoutingReceipt,
	RoutingState,
	SlotResources,
} from "./rocks-runtime-rows";
import type { RuntimeTransaction } from "./runtime-records";

/** §6: heartbeat 30s, lease TTL 120s. */
export const LEASE_TTL_MS = 120_000;
export const LEASE_HEARTBEAT_MS = 30_000;
/** Admitted fallback list: selected plus up to seven. */
const FROZEN_CANDIDATES = 8;

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
export const routingStateId = (principalId: string, deviceId: string) =>
	`routing:${createHash("sha256").update(`${principalId}\0${deviceId}`, "utf8").digest("hex")}`;
export const leaseId = (attemptId: string) => `slot-lease:${attemptId}`;
const queueId = (sequence: number) => `slot-queue:${sequence}`;
const edgeId = (caller: string, callee: string) => `wait-edge:${caller}:${callee}`;

export function candidateIdentity(candidate: Candidate | CandidateIdentity): CandidateIdentity {
	return {
		model_id: candidate.model_id,
		route_ref: candidate.route_ref,
		account_ref: candidate.account_ref,
		effort: candidate.effort,
		service_tier: candidate.service_tier,
		billing_pool_id: candidate.billing_pool_id,
		billing_pool_basis: candidate.billing_pool_basis,
	};
}

/** Frozen Candidate record without adapter/descriptor fields of the roster row. */
export function frozenCandidate(route: Candidate): Candidate {
	return {
		...candidateIdentity(route),
		tier: route.tier,
		provider_id: route.provider_id,
		quota_window_ids: route.quota_window_ids,
		shadow_cost: route.shadow_cost,
		price_source: route.price_source,
		estimated: route.estimated,
		record_revisions: route.record_revisions,
	};
}

export function slotResources(candidate: Candidate, limits: RoutingLimits, consultation: boolean): SlotResources {
	return {
		scope_refs: limits.scopes.map(scope => scope.scope_ref),
		tier: candidate.tier,
		account_ref: candidate.account_ref,
		provider_id: candidate.provider_id,
		consultation,
	};
}

type Vector = Record<string, number>;

/** Consultation uses its own scope counter; account/provider ceilings are shared by every kind. */
function demand(resources: SlotResources, limits: RoutingLimits): Vector {
	const vector: Vector = {};
	for (const scope of limits.scopes) {
		if (!resources.scope_refs.includes(scope.scope_ref)) continue;
		if (resources.consultation) {
			vector[`consultations:${scope.scope_ref}`] = 1;
			continue;
		}
		vector[`agents:${scope.scope_ref}`] = 1;
		for (const limit of scope.by_tier) {
			const matches =
				resources.tier !== null && (limit.mode === "exact" ? resources.tier === limit.tier : resources.tier >= limit.tier);
			if (matches) vector[`tier:${scope.scope_ref}:${limit.mode}:${limit.tier}`] = 1;
		}
	}
	vector[`account:${resources.account_ref}`] = 1;
	vector[`provider:${resources.provider_id}`] = 1;
	return vector;
}

function ceilings(limits: RoutingLimits): Vector {
	const result: Vector = {};
	for (const scope of limits.scopes) {
		result[`agents:${scope.scope_ref}`] = scope.agents ?? Infinity;
		result[`consultations:${scope.scope_ref}`] = scope.consultations;
		for (const limit of scope.by_tier) result[`tier:${scope.scope_ref}:${limit.mode}:${limit.tier}`] = limit.value;
	}
	for (const [ref, value] of Object.entries(limits.accounts)) result[`account:${ref}`] = value ?? Infinity;
	for (const [id, value] of Object.entries(limits.providers)) result[`provider:${id}`] = value ?? Infinity;
	return result;
}

function fits(vector: Vector, available: Vector): boolean {
	return Object.entries(vector).every(([key, count]) => key in available && count <= available[key]);
}

/** Held leases only reduce ceilings this request is subject to; negatives after a limit decrease are kept. */
function heldAvailability(limits: RoutingLimits, leases: readonly RocksSlotLease[], creditAttempt?: string): Vector {
	const available = ceilings(limits);
	for (const lease of leases) {
		if (lease.attempt_id === creditAttempt) continue;
		for (const [key, count] of Object.entries(demand(lease.resources, limits)))
			if (key in available) available[key] -= count;
	}
	return available;
}

export interface WaitingAdmission {
	/** Callee Attempt id. */
	admission_id: string;
	/** Complete authorized roster for a new Start; only frozen candidates for a Resume. */
	candidates: readonly SlotResources[];
}

/**
 * §6.1 finite optimistic closure over one census. It performs no real release, reorder or effect.
 * A holder whose awaited callees are all satisfied may finish; a waiting admission that fits may run
 * to completion with net-zero occupancy. Repeats to a fixed point.
 */
export function routingReachability(
	limits: RoutingLimits,
	leases: readonly RocksSlotLease[],
	waiting: readonly WaitingAdmission[],
	edges: readonly RocksWaitEdge[],
): { reachable: Set<string>; released: Set<string>; available: Vector } {
	const available = heldAvailability(limits, leases);
	const holders = new Map(leases.map(lease => [lease.attempt_id, demand(lease.resources, limits)]));
	const admissions = new Set(waiting.map(item => item.admission_id));
	if (holders.size !== leases.length || admissions.size !== waiting.length)
		throw new EngineTargetError("admission_state_unknown", "Duplicate routing census identity");
	for (const edge of edges)
		if (!holders.has(edge.waited_admission_id) && !admissions.has(edge.waited_admission_id))
			throw new EngineTargetError("admission_state_unknown", "Wait edge names an unknown admission");
	const reachable = new Set<string>();
	const released = new Set<string>();
	const satisfied = (id: string) => reachable.has(id) || released.has(id);
	for (let changed = true; changed; ) {
		changed = false;
		for (const [attempt, vector] of holders) {
			if (released.has(attempt)) continue;
			if (edges.some(edge => edge.caller_attempt_id === attempt && !satisfied(edge.waited_admission_id))) continue;
			for (const [key, count] of Object.entries(vector)) if (key in available) available[key] += count;
			released.add(attempt);
			changed = true;
		}
		for (const admission of waiting) {
			if (reachable.has(admission.admission_id)) continue;
			if (admission.candidates.some(resources => fits(demand(resources, limits), available))) {
				reachable.add(admission.admission_id);
				changed = true;
			}
		}
	}
	return { reachable, released, available };
}

interface Census {
	state: RoutingState | undefined;
	revision: number;
	leases: RocksSlotLease[];
	queue: RocksSlotQueue[];
	edges: RocksWaitEdge[];
}

async function census(tx: RuntimeTransaction, principalId: string, deviceId: string): Promise<Census> {
	try {
		const state = await tx.get<RoutingState>("metadata", routingStateId(principalId, deviceId));
		const leases = await tx.query<RocksSlotLease>("routing_leases", [principalId, deviceId]);
		const queue = await tx.query<RocksSlotQueue>("routing_queue", [principalId, deviceId]);
		// ponytail: one device-wide edge page; owner-partitioned edges if >100 concurrent waits matter.
		const edges = await tx.query<RocksWaitEdge>("routing_wait_edges", []);
		return { state, revision: state?.routing_revision ?? 0, leases, queue, edges };
	} catch (error) {
		// A partial census never proves queue/cycle refusal.
		if (error instanceof EngineTargetError && error.code === "restore_budget")
			throw new EngineTargetError("admission_state_unknown", "Routing census exceeds one atomic page");
		throw error;
	}
}

interface Transition {
	tx: RuntimeTransaction;
	census: Census;
	principalId: string;
	deviceId: string;
	commandId: string;
	agentRef: string;
	attemptId: string;
	action: RoutingReceipt["action"];
	lease: string | null;
	queue: string | null;
	candidate: CandidateIdentity | null;
	leaseRevision: number | null;
	from?: CandidateIdentity;
}

/** One routing op per mutation: revision bump, receipt on the Attempt start command, typed owner operation. */
async function commitTransition(t: Transition): Promise<RoutingReceipt> {
	const next = t.census.revision + 1;
	await t.tx.put("metadata", routingStateId(t.principalId, t.deviceId), {
		subtype: "routing_state",
		principal_id: t.principalId,
		device_id: t.deviceId,
		routing_revision: next,
	} satisfies RoutingState);
	const unsigned = {
		action: t.action,
		attempt_id: t.attemptId,
		receipt_id: `routing:${t.commandId}:${next}`,
		lease_id: t.lease,
		queue_id: t.queue,
		candidate: t.candidate,
		lease_revision: t.leaseRevision,
	};
	const receipt: RoutingReceipt = { ...unsigned, receipt_hash: sha256(storageCanonicalJson(unsigned)) };
	const command = await t.tx.get<RocksCommand>("command", t.commandId);
	if (!command) throw new EngineTargetError("stale_target", "Routing command is not admitted");
	await t.tx.put("command", t.commandId, { ...command, routing: receipt, updated_at: Date.now() });
	t.tx.routingAdmission = {
		action: t.action,
		expected_routing_revision: t.census.revision,
		command_id: t.commandId,
		attempt_id: t.attemptId,
		agent_ref: t.agentRef,
		principal_id: t.principalId,
		device_id: t.deviceId,
		lease_id: t.lease,
		queue_id: t.queue,
		candidate: t.candidate,
		receipt_id: receipt.receipt_id,
		receipt_hash: receipt.receipt_hash,
		lease_revision: t.leaseRevision,
		...(t.from ? { from_candidate: t.from } : {}),
	};
	return receipt;
}

export interface AdmissionRequest {
	principalId: string;
	deviceId: string;
	engineGeneration: number;
	commandId: string;
	agentInstanceRef: string;
	attemptId: string;
	dispatchId: string;
	dispatchRef: string;
	dispatchHash: string;
	originReceiptId: string;
	authContextId: string;
	bindingSnapshot: EngineSemanticBindingSnapshot;
	executionKind: "ordinary" | "automation" | "consultation";
	limits: RoutingLimits;
	rosterRevision: `sha256:${string}`;
	expectedRevisions: Record<string, number>;
	/** Complete authorized roster (new Start) or the admitted frozen list (Resume), in policy order. */
	candidates: readonly Candidate[];
	/** Awaiting caller Attempt whose lease stays held while this callee is pending. */
	callerAttemptId: string | null;
	/** Resume never grows its admitted list. */
	frozen: boolean;
}

export type AdmissionOutcome =
	| { status: "admitted"; selected: number; frozen: Candidate[]; leaseRevision: number; filtered: Record<string, number> }
	| { status: "queued"; queueId: string };

/** Everything a pending Start needs to prove capacity for a queued peer, read from its durable command. */
async function queuedDemand(tx: RuntimeTransaction, row: RocksSlotQueue): Promise<WaitingAdmission> {
	const command = await tx.get<RocksCommand>("command", row.command_id);
	const payload = JSON.parse(command?.identity.serializedCommand ?? "null")?.payload;
	const config = payload?.executionConfiguration as EngineExecutionConfiguration | undefined;
	if (!config?.roster_complete) throw new EngineTargetError("admission_state_unknown", "Queued admission roster missing");
	const consultation = payload.executionKind === "consultation";
	return {
		admission_id: row.admission_id,
		candidates: config.routes.routes
			.filter(route => row.candidate_refs.includes(candidateRef(route)))
			.map(route => slotResources(route, config.routingLimits, consultation)),
	};
}

export const candidateRef = (candidate: CandidateIdentity) =>
	`${candidate.route_ref}#${candidate.effort}#${candidate.service_tier}`;

/**
 * §6 Start eligible / capacity search and §6.1 cycle refusal, in one atomic owner mutation.
 * Returns admission (lease held, selected+up to 7 frozen) or FIFO queue; throws structured refusal.
 */
export async function stageAdmission(tx: RuntimeTransaction, request: AdmissionRequest): Promise<AdmissionOutcome> {
	const current = await census(tx, request.principalId, request.deviceId);
	const consultation = request.executionKind === "consultation";
	if (current.leases.some(lease => lease.attempt_id === request.attemptId))
		throw new EngineTargetError("stale_target", "Attempt already holds a routing lease");
	const own = current.queue.find(row => row.admission_id === request.attemptId && row.status === "waiting");
	const others = current.queue.filter(row => row !== own && row.status === "waiting");
	const waiting: WaitingAdmission[] = [];
	for (const row of others) waiting.push(await queuedDemand(tx, row));
	const resources = request.candidates.map(candidate => slotResources(candidate, request.limits, consultation));
	waiting.push({ admission_id: request.attemptId, candidates: resources });
	const tentative: RocksWaitEdge | undefined = request.callerAttemptId
		? {
				subtype: "wait_edge",
				caller_attempt_id: request.callerAttemptId,
				waited_admission_id: request.attemptId,
				kind: consultation ? "consultation" : "child",
			}
		: undefined;
	const edges = current.edges.filter(
		edge => !(edge.caller_attempt_id === tentative?.caller_attempt_id && edge.waited_admission_id === request.attemptId),
	);
	if (tentative) edges.push(tentative);
	const proof = routingReachability(request.limits, current.leases, waiting, edges);
	const now = heldAvailability(request.limits, current.leases);
	const limitsOnly = ceilings(request.limits);
	const filtered: Record<string, number> = {
		roster: request.candidates.length,
		permanent_capacity: resources.filter(item => !fits(demand(item, request.limits), limitsOnly)).length,
		capacity_now: resources.filter(item => !fits(demand(item, request.limits), now)).length,
	};
	// FIFO: an earlier eligible queued head goes first; it is woken by this store's change signal.
	const aheadEligible = others.some(
		(row, index) => (!own || row.sequence < own.sequence) && waiting[index].candidates.some(item => fits(demand(item, request.limits), now)),
	);
	const selected = aheadEligible ? -1 : resources.findIndex(item => fits(demand(item, request.limits), now));
	const edgeKey = tentative ? edgeId(tentative.caller_attempt_id, request.attemptId) : undefined;
	if (selected >= 0) {
		// Freeze only after actual selection: selected first, then up to 7 individually reachable members.
		const frozen = [request.candidates[selected]];
		for (const [index, candidate] of request.candidates.entries()) {
			if (frozen.length === FROZEN_CANDIDATES || request.frozen) break;
			if (index !== selected && fits(demand(resources[index], request.limits), proof.available)) frozen.push(candidate);
		}
		if (request.frozen) frozen.push(...request.candidates.filter((_, index) => index !== selected));
		const lease = leaseId(request.attemptId);
		const heartbeat = Date.now();
		const start = await tx.get<RocksCommand>("command", request.commandId);
		const leaseRevision = request.frozen ? (start?.routing?.lease_revision ?? 0) + 1 : 1;
		await tx.create("metadata", lease, {
			schema: "grimoire.slot_lease.v1",
			subtype: "slot_lease",
			principal_id: request.principalId,
			device_id: request.deviceId,
			attempt_id: request.attemptId,
			lease_revision: leaseRevision,
			engine_generation: request.engineGeneration,
			dispatch_hash: request.dispatchHash,
			binding_snapshot_hash: sha256(storageCanonicalJson(request.bindingSnapshot)),
			resources: resources[selected],
			acquired_at: heartbeat,
			heartbeat_at: heartbeat,
			expires_at: heartbeat + LEASE_TTL_MS,
		} satisfies RocksSlotLease);
		const queueKey = own ? queueId(own.sequence) : null;
		if (own) await tx.put("metadata", queueKey!, { ...own, status: "accepted" } satisfies RocksSlotQueue);
		if (tentative && request.callerAttemptId) {
			await tx.get<RocksAttempt>("attempt", request.callerAttemptId);
			await tx.put("metadata", edgeKey!, tentative);
		}
		await commitTransition({
			tx,
			census: current,
			principalId: request.principalId,
			deviceId: request.deviceId,
			commandId: request.commandId,
			agentRef: request.agentInstanceRef,
			attemptId: request.attemptId,
			action: "acquire",
			lease,
			queue: queueKey,
			candidate: candidateIdentity(request.candidates[selected]),
			leaseRevision,
		});
		return { status: "admitted", selected: 0, frozen, leaseRevision, filtered };
	}
	if (resources.length > 0 && filtered.permanent_capacity === resources.length)
		throw refusal(request, own, current, "capacity_unavailable", "Configured zero or exceeded capacity", filtered);
	if (!proof.reachable.has(request.attemptId)) {
		// Missing capacity is held only by callers blocked in the closed wait graph.
		const blocking = current.leases.map(lease => lease.attempt_id).filter(id => !proof.released.has(id));
		throw refusal(request, own, current, "admission_dependency_cycle", "Awaited admission is unreachable", filtered, blocking);
	}
	if (own) return { status: "queued", queueId: queueId(own.sequence) };
	const sequence = current.revision + 1;
	const key = queueId(sequence);
	await tx.create("metadata", key, {
		schema: "grimoire.slot_queue.v1",
		subtype: "slot_queue",
		principal_id: request.principalId,
		device_id: request.deviceId,
		sequence,
		admission_id: request.attemptId,
		command_id: request.commandId,
		attempt_id: request.attemptId,
		dispatch_ref: request.dispatchRef,
		dispatch_hash: request.dispatchHash,
		origin_receipt_id: request.originReceiptId,
		bindingSnapshot: request.bindingSnapshot,
		auth_context_id: request.authContextId,
		roster_revision: request.rosterRevision,
		candidate_refs: request.candidates.map(candidateRef),
		requested_at: Date.now(),
		reason: aheadEligible ? "fifo" : "capacity",
		expected_revisions: request.expectedRevisions,
		status: "waiting",
	} satisfies RocksSlotQueue);
	if (tentative && request.callerAttemptId) {
		await tx.get<RocksAttempt>("attempt", request.callerAttemptId);
		await tx.put("metadata", edgeKey!, tentative);
	}
	await commitTransition({
		tx,
		census: current,
		principalId: request.principalId,
		deviceId: request.deviceId,
		commandId: request.commandId,
		agentRef: request.agentInstanceRef,
		attemptId: request.attemptId,
		action: "enqueue",
		lease: null,
		queue: key,
		candidate: null,
		leaseRevision: null,
	});
	return { status: "queued", queueId: key };
}

function refusal(
	request: AdmissionRequest,
	own: RocksSlotQueue | undefined,
	current: Census,
	code: "capacity_unavailable" | "admission_dependency_cycle",
	message: string,
	filtered: Record<string, number>,
	blocking: string[] = [],
): EngineTargetError {
	return new EngineTargetError(code, message, {
		dispatch_id: request.dispatchId,
		wait_kind: request.executionKind === "consultation" ? "consultation" : "child",
		blocking_attempt_ids: blocking,
		resource_limits: request.limits,
		candidate_rejections: filtered,
		alternatives: ["execute_in_caller", "request_limit_change"],
		// A queued entry is settled by stageQueueCancel, never silently skipped.
		...(own ? { queue_id: queueId(own.sequence), routing_revision: current.revision } : {}),
	});
}

/** Terminalizes a waiting entry exactly once with an explicit reason; removes its wait edges. */
export async function stageQueueCancel(
	tx: RuntimeTransaction,
	request: Pick<AdmissionRequest, "principalId" | "deviceId" | "commandId" | "agentInstanceRef" | "attemptId">,
	status: "cancelled" | "refused",
	reason: string,
): Promise<boolean> {
	const current = await census(tx, request.principalId, request.deviceId);
	const own = current.queue.find(row => row.admission_id === request.attemptId && row.status === "waiting");
	if (!own) return false;
	const key = queueId(own.sequence);
	await tx.put("metadata", key, { ...own, status, reason } satisfies RocksSlotQueue);
	for (const edge of current.edges)
		if (edge.waited_admission_id === request.attemptId)
			await tx.delete("metadata", edgeId(edge.caller_attempt_id, edge.waited_admission_id));
	await commitTransition({
		tx,
		census: current,
		...request,
		agentRef: request.agentInstanceRef,
		action: "cancel",
		lease: null,
		queue: key,
		candidate: null,
		leaseRevision: null,
	});
	return true;
}

/** Explicit pause / terminal / cancel: release exactly once by lease_revision and settle this Attempt's edges. */
export async function stageRelease(
	tx: RuntimeTransaction,
	attemptId: string,
	start?: { commandId: string; agentInstanceRef: string; candidate: CandidateIdentity },
): Promise<boolean> {
	const key = leaseId(attemptId);
	const lease = await tx.get<RocksSlotLease>("metadata", key);
	if (!lease) return false;
	const attempt = await tx.get<RocksAttempt>("attempt", attemptId);
	const commandId = attempt?.command_id ?? start?.commandId;
	const command = commandId ? await tx.get<RocksCommand>("command", commandId) : undefined;
	if (!commandId || !command?.identity.agentInstanceRef)
		throw new EngineTargetError("admission_state_unknown", "Leased Attempt has no admitted start command");
	const current = await census(tx, lease.principal_id, lease.device_id);
	await tx.delete("metadata", key);
	for (const edge of current.edges)
		if (edge.caller_attempt_id === attemptId || edge.waited_admission_id === attemptId)
			await tx.delete("metadata", edgeId(edge.caller_attempt_id, edge.waited_admission_id));
	const selected = attempt?.execution?.executor_choice;
	await commitTransition({
		tx,
		census: current,
		principalId: lease.principal_id,
		deviceId: lease.device_id,
		commandId,
		agentRef: command.identity.agentInstanceRef,
		attemptId,
		action: "release",
		lease: key,
		queue: null,
		candidate: selected ? currentIdentity(selected) : (start?.candidate ?? null),
		leaseRevision: lease.lease_revision,
	});
	return true;
}

/** Current route = last durable transition, else the admitted selection. */
export function currentIdentity(choice: { selected: CandidateIdentity; transitions: { to: CandidateIdentity }[] }) {
	return candidateIdentity(choice.transitions.at(-1)?.to ?? choice.selected);
}

/** Heartbeat keeps resources unchanged; an expired or foreign-generation lease is never renewed. */
export async function stageRenew(tx: RuntimeTransaction, attemptId: string, engineGeneration: number): Promise<boolean> {
	const key = leaseId(attemptId);
	const lease = await tx.get<RocksSlotLease>("metadata", key);
	const attempt = await tx.get<RocksAttempt>("attempt", attemptId);
	if (!lease || !attempt?.execution) return false;
	const now = Date.now();
	if (lease.engine_generation !== engineGeneration || lease.expires_at <= now)
		throw new EngineTargetError("stale_target", "Routing lease expired; new effects require admission");
	const command = await tx.get<RocksCommand>("command", attempt.command_id);
	const current = await census(tx, lease.principal_id, lease.device_id);
	await tx.put("metadata", key, { ...lease, heartbeat_at: now, expires_at: now + LEASE_TTL_MS } satisfies RocksSlotLease);
	await commitTransition({
		tx,
		census: current,
		principalId: lease.principal_id,
		deviceId: lease.device_id,
		commandId: attempt.command_id,
		agentRef: command?.identity.agentInstanceRef ?? "",
		attemptId,
		action: "renew",
		lease: key,
		queue: null,
		candidate: currentIdentity(attempt.execution.executor_choice),
		leaseRevision: lease.lease_revision,
	});
	return true;
}

/**
 * Fallback to another frozen route unit: atomic old→new transfer with credit of the own lease (scope
 * total not +1). A failed fit leaves the old lease untouched and the candidate is skipped.
 */
export async function stageTransfer(
	tx: RuntimeTransaction,
	attemptId: string,
	to: Candidate,
	limits: RoutingLimits,
	engineGeneration: number,
): Promise<number | undefined> {
	const key = leaseId(attemptId);
	const lease = await tx.get<RocksSlotLease>("metadata", key);
	const attempt = await tx.get<RocksAttempt>("attempt", attemptId);
	if (!lease || !attempt?.execution) throw new EngineTargetError("stale_target", "Fallback requires a held lease");
	if (lease.engine_generation !== engineGeneration || lease.expires_at <= Date.now())
		throw new EngineTargetError("stale_target", "Routing lease expired; new effects require admission");
	const current = await census(tx, lease.principal_id, lease.device_id);
	const resources = slotResources(to, limits, lease.resources.consultation);
	if (!fits(demand(resources, limits), heldAvailability(limits, current.leases, attemptId))) return undefined;
	const command = await tx.get<RocksCommand>("command", attempt.command_id);
	const now = Date.now();
	const revision = lease.lease_revision + 1;
	await tx.put("metadata", key, {
		...lease,
		lease_revision: revision,
		resources,
		heartbeat_at: now,
		expires_at: now + LEASE_TTL_MS,
	} satisfies RocksSlotLease);
	await commitTransition({
		tx,
		census: current,
		principalId: lease.principal_id,
		deviceId: lease.device_id,
		commandId: attempt.command_id,
		agentRef: command?.identity.agentInstanceRef ?? "",
		attemptId,
		action: "transfer",
		lease: key,
		queue: null,
		candidate: candidateIdentity(to),
		leaseRevision: revision,
		from: currentIdentity(attempt.execution.executor_choice),
	});
	return revision;
}

/** Restart reconciliation: a lease of another Engine generation never returns to its old process. */
export async function staleLeaseAttempts(
	tx: RuntimeTransaction,
	principalId: string,
	deviceId: string,
	engineGeneration: number,
): Promise<string[]> {
	const current = await census(tx, principalId, deviceId);
	return current.leases.filter(lease => lease.engine_generation !== engineGeneration).map(lease => lease.attempt_id);
}

/** L1 instructions for one route: null-route rules plus rules whose route_refs include it, in array order. */
export function l1For(sources: { rules: readonly InstructionRule[] }, route: CandidateIdentity): InstructionRule[] {
	return sources.rules.filter(rule => rule.route_refs === null || rule.route_refs.includes(route.route_ref));
}

/** Rules not yet applied under (ref, content_hash); a same-route pool change yields an empty delta. */
export function ruleDelta(
	sources: { rules: readonly InstructionRule[] },
	applied: readonly { ref: string; content_hash: string }[],
	route: CandidateIdentity,
): InstructionRule[] {
	const seen = new Set(applied.map(rule => `${rule.ref}\0${rule.content_hash}`));
	return l1For(sources, route).filter(rule => !seen.has(`${rule.ref}\0${rule.content_hash}`));
}

/** Replay the immutable admitted baseline and every durable transition before repairing messages. */
export function executorRuleReplay(
	sources: { rules: readonly InstructionRule[] },
	choice: Pick<ExecutorChoice, "selected" | "rules" | "transitions">,
): Array<{ eventId: string; route: CandidateIdentity; rules: InstructionRule[] }> {
	const applied = l1For(sources, choice.selected).map(({ ref, revision, content_hash }) => ({ ref, revision, content_hash }));
	const deltas: Array<{ eventId: string; route: CandidateIdentity; rules: InstructionRule[] }> = [];
	const eventIds = new Set<string>();
	let previous = candidateIdentity(choice.selected);
	for (const [index, transition] of choice.transitions.entries()) {
		if (transition.seq !== index + 1 || !transition.event_id || eventIds.has(transition.event_id) ||
			storageCanonicalJson(transition.from) !== storageCanonicalJson(previous))
			throw new EngineTargetError("stale_target", "Executor rule transition chain is not its admitted history");
		eventIds.add(transition.event_id);
		const rules = ruleDelta(sources, applied, transition.to);
		applied.push(...rules.map(({ ref, revision, content_hash }) => ({ ref, revision, content_hash })));
		if (rules.length) deltas.push({ eventId: transition.event_id, route: transition.to, rules });
		previous = transition.to;
	}
	if (storageCanonicalJson(applied) !== storageCanonicalJson(choice.rules))
		throw new EngineTargetError("stale_target", "Durable executor rule union differs from its admitted transition history");
	return deltas;
}

/** Renders L1 rule text before L2/L3: one block, array order preserved, no dedup of distinct rules. */
export function renderRules(rules: readonly InstructionRule[]): string {
	if (rules.length === 0) return "";
	return `<executor-rules>\n${rules.map(rule => rule.route_refs === null ? rule.content :
		`<executor-route-rule applies-only-to-route-refs="${rule.route_refs.join(" ")}">\n${rule.content}\n</executor-route-rule>`
	).join("\n\n")}\n</executor-rules>`;
}
