import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import type {
	MissionFeature,
	MissionFeatureStatus,
	MissionHandoff,
	MissionIntegrationPending,
	MissionPauseReason,
	MissionPlan,
	MissionProgressEvent,
	MissionPublishCheck,
	MissionRepositoryState,
	MissionState,
	MissionStatus,
	MissionValidatorRole,
	MissionWorkerHandoff,
	MissionWorkspaceDescriptor,
} from "./types";
import { MISSION_PROGRESS_CUSTOM_TYPE, MISSION_STATE_CUSTOM_TYPE } from "./types";

export interface MissionPlanValidationResult {
	valid: boolean;
	errors: string[];
}

export interface NextMissionFeatureResult {
	state: MissionState;
	feature: MissionFeature | null;
}

export class MissionStateError extends Error {
	override readonly name = "MissionStateError";
}

const MISSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const MISSION_STATUSES = [
	"planning",
	"awaiting_input",
	"initializing",
	"running",
	"paused",
	"orchestrator_turn",
	"completed",
	"cancelled",
] as const satisfies readonly MissionStatus[];

const FEATURE_STATUSES = [
	"pending",
	"in_progress",
	"completed",
	"cancelled",
] as const satisfies readonly MissionFeatureStatus[];

const VALIDATOR_ROLES = ["scrutiny", "user-testing"] as const satisfies readonly MissionValidatorRole[];

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

const PAUSE_REASONS = [
	"user_requested",
	"feature_retry_limit_exceeded",
	"worker_inactive",
	"worker_interrupted",
	"repository_dirty",
	"workspace_conflict",
	"integration_diverged",
	"parent_diverged",
	"validator_workspace_dirty",
] as const satisfies readonly MissionPauseReason[];

const HANDOFF_RESOLVE_DECISIONS = ["accept", "retry_same", "retry_fresh", "cancel_feature", "pause"] as const;

function isMissionPauseReason(value: unknown): value is MissionPauseReason {
	return typeof value === "string" && (PAUSE_REASONS as readonly string[]).includes(value);
}

function isHandoffResolveDecision(
	value: unknown,
): value is "accept" | "retry_same" | "retry_fresh" | "cancel_feature" | "pause" {
	return typeof value === "string" && (HANDOFF_RESOLVE_DECISIONS as readonly string[]).includes(value);
}

function assertNever(value: never, message: string): never {
	throw new MissionStateError(`${message}: ${JSON.stringify(value)}`);
}

function formatIdList(ids: Iterable<string>): string {
	return [...ids].join(", ");
}

/** Reject empty goals/milestones/features/expectedBehavior/validators and all structural plan rules. */
export function validateMissionPlan(plan: MissionPlan): MissionPlanValidationResult {
	const errors: string[] = [];

	if (!isNonEmptyString(plan.goal)) {
		errors.push("Plan goal must be a non-empty string");
	}

	if (!Array.isArray(plan.milestones) || plan.milestones.length === 0) {
		errors.push("Plan must include at least one milestone");
	}

	if (!Array.isArray(plan.features) || plan.features.length === 0) {
		errors.push("Plan must include at least one feature");
	}

	if (errors.length > 0) {
		return { valid: false, errors };
	}

	const milestoneIds = new Set<string>();
	const featureIds = new Set<string>();
	const milestoneIndex = new Map<string, number>();
	const featureById = new Map<string, MissionPlan["features"][number]>();
	const membershipCount = new Map<string, number>();

	for (let i = 0; i < plan.milestones.length; i++) {
		const milestone = plan.milestones[i]!;
		if (!isNonEmptyString(milestone.id)) {
			errors.push(`Milestone at index ${i} has an empty id`);
			continue;
		}
		if (!MISSION_ID_PATTERN.test(milestone.id)) {
			errors.push(`Milestone id "${milestone.id}" must match ${MISSION_ID_PATTERN}`);
		}
		if (milestone.id.startsWith("_")) {
			errors.push(`User milestone id "${milestone.id}" may not begin with "_"`);
		}
		if (milestoneIds.has(milestone.id)) {
			errors.push(`Duplicate milestone id "${milestone.id}"`);
		}
		milestoneIds.add(milestone.id);
		milestoneIndex.set(milestone.id, i);

		if (!Array.isArray(milestone.featureIds) || milestone.featureIds.length === 0) {
			errors.push(`Milestone "${milestone.id}" must list at least one feature id`);
		} else {
			for (const featureId of milestone.featureIds) {
				membershipCount.set(featureId, (membershipCount.get(featureId) ?? 0) + 1);
			}
		}

		if (!Array.isArray(milestone.validators) || milestone.validators.length === 0) {
			errors.push(`Milestone "${milestone.id}" must list at least one validator`);
		} else {
			const seenRoles = new Set<MissionValidatorRole>();
			for (const role of milestone.validators) {
				if (!VALIDATOR_ROLES.includes(role)) {
					errors.push(`Milestone "${milestone.id}" has unknown validator role "${String(role)}"`);
					continue;
				}
				if (seenRoles.has(role)) {
					errors.push(`Milestone "${milestone.id}" has duplicate validator role "${role}"`);
				}
				seenRoles.add(role);
				if (role === "user-testing") {
					const hasUserTestCommand = plan.runbook.userTests.length > 0;
					const hasService = plan.runbook.services.length > 0;
					if (!hasUserTestCommand && !hasService) {
						errors.push(
							`Milestone "${milestone.id}" requests user-testing but runbook has no userTests command or service`,
						);
					}
				}
			}
		}
	}

	for (let i = 0; i < plan.features.length; i++) {
		const feature = plan.features[i]!;
		if (!isNonEmptyString(feature.id)) {
			errors.push(`Feature at index ${i} has an empty id`);
			continue;
		}
		if (!MISSION_ID_PATTERN.test(feature.id)) {
			errors.push(`Feature id "${feature.id}" must match ${MISSION_ID_PATTERN}`);
		}
		if (feature.id.startsWith("_")) {
			errors.push(`User feature id "${feature.id}" may not begin with "_"`);
		}
		if (featureIds.has(feature.id)) {
			errors.push(`Duplicate feature id "${feature.id}"`);
		}
		featureIds.add(feature.id);
		featureById.set(feature.id, feature);

		if (!isNonEmptyString(feature.milestoneId)) {
			errors.push(`Feature "${feature.id}" has an empty milestoneId`);
		} else if (!milestoneIds.has(feature.milestoneId)) {
			errors.push(`Feature "${feature.id}" references missing milestone "${feature.milestoneId}"`);
		}

		if (!Array.isArray(feature.expectedBehavior) || feature.expectedBehavior.length === 0) {
			errors.push(`Feature "${feature.id}" must list at least one expectedBehavior item`);
		}

		if (!Array.isArray(feature.preconditions)) {
			errors.push(`Feature "${feature.id}" preconditions must be an array`);
		}
	}

	for (const milestone of plan.milestones) {
		for (const featureId of milestone.featureIds) {
			if (!featureIds.has(featureId)) {
				errors.push(`Milestone "${milestone.id}" references missing feature "${featureId}"`);
				continue;
			}
			const feature = featureById.get(featureId);
			if (feature && feature.milestoneId !== milestone.id) {
				errors.push(
					`Feature "${featureId}" is listed under milestone "${milestone.id}" but feature.milestoneId is "${feature.milestoneId}"`,
				);
			}
		}
	}

	for (const feature of plan.features) {
		const count = membershipCount.get(feature.id) ?? 0;
		if (count === 0) {
			errors.push(`Feature "${feature.id}" is not listed in any milestone.featureIds`);
		} else if (count > 1) {
			errors.push(`Feature "${feature.id}" appears in more than one milestone.featureIds list`);
		}
	}

	for (const feature of plan.features) {
		const featureMilestoneIndex = milestoneIndex.get(feature.milestoneId);
		if (featureMilestoneIndex === undefined) {
			continue;
		}
		for (const preconditionId of feature.preconditions) {
			if (!featureIds.has(preconditionId)) {
				errors.push(`Feature "${feature.id}" references missing precondition "${preconditionId}"`);
				continue;
			}
			const precondition = featureById.get(preconditionId);
			if (!precondition) {
				continue;
			}
			const preconditionMilestoneIndex = milestoneIndex.get(precondition.milestoneId);
			if (preconditionMilestoneIndex !== undefined && preconditionMilestoneIndex > featureMilestoneIndex) {
				errors.push(`Feature "${feature.id}" depends on "${preconditionId}" from a later milestone`);
			}
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const cycleParticipants = new Set<string>();

	const visit = (featureId: string, stack: string[]): void => {
		if (visited.has(featureId) || cycleParticipants.has(featureId)) {
			return;
		}
		if (visiting.has(featureId)) {
			const cycleStart = stack.indexOf(featureId);
			for (const id of stack.slice(cycleStart >= 0 ? cycleStart : 0)) {
				cycleParticipants.add(id);
			}
			cycleParticipants.add(featureId);
			return;
		}
		visiting.add(featureId);
		const feature = featureById.get(featureId);
		if (feature) {
			for (const preconditionId of feature.preconditions) {
				if (featureIds.has(preconditionId)) {
					visit(preconditionId, [...stack, featureId]);
				}
			}
		}
		visiting.delete(featureId);
		visited.add(featureId);
	};

	for (const featureId of featureIds) {
		visit(featureId, []);
	}
	if (cycleParticipants.size > 0) {
		errors.push(`Feature precondition graph contains a cycle involving: ${formatIdList(cycleParticipants)}`);
	}

	return { valid: errors.length === 0, errors };
}

function isTerminalStatus(status: MissionStatus): boolean {
	switch (status) {
		case "completed":
		case "cancelled":
			return true;
		case "planning":
		case "awaiting_input":
		case "initializing":
		case "running":
		case "paused":
		case "orchestrator_turn":
			return false;
		default:
			return assertNever(status, "Unknown mission status");
	}
}

function isPlanningOrAwaiting(status: MissionStatus): boolean {
	switch (status) {
		case "planning":
		case "awaiting_input":
			return true;
		case "initializing":
		case "running":
		case "paused":
		case "orchestrator_turn":
		case "completed":
		case "cancelled":
			return false;
		default:
			return assertNever(status, "Unknown mission status");
	}
}

function handoffIsSuccessfulImplementation(handoff: MissionHandoff): handoff is MissionWorkerHandoff {
	if (handoff.kind !== "implementation") {
		return false;
	}
	if (handoff.outcome !== "success") {
		return false;
	}
	return !handoff.issues.some(issue => issue.severity === "blocking");
}

/**
 * The integration head a successful implementation handoff must advance to: the
 * last commit it reported (oldest-first), or the unchanged base for a no-op. The
 * runtime writes the pending marker with this; the fold rejects any marker that
 * disagrees, so both sides must derive it here.
 */
export function expectedIntegrationNewHead(handoff: MissionWorkerHandoff, expectedOldHead: string): string {
	if (handoff.commits.length === 0) {
		return expectedOldHead;
	}
	return handoff.commits[handoff.commits.length - 1]!;
}

function workspaceMatchesFeatureKind(feature: MissionFeature, workspace: MissionWorkspaceDescriptor): boolean {
	switch (feature.kind) {
		case "implementation":
			return workspace.kind === "feature";
		case "validation":
			return workspace.kind === "validator";
		default:
			return assertNever(feature.kind, "Unknown feature kind");
	}
}

function collectProgressEvents(entries: readonly SessionEntry[], missionId: string): MissionProgressEvent[] {
	const events: MissionProgressEvent[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MISSION_PROGRESS_CUSTOM_TYPE) {
			continue;
		}
		const parsed = parseMissionProgressEvent(entry.data);
		if (parsed.missionId === missionId) {
			events.push(parsed);
		}
	}
	return events;
}

function parseMissionProgressEvent(data: unknown): MissionProgressEvent {
	if (!isRecord(data)) {
		throw new MissionStateError("mission-progress entry data must be an object");
	}
	if (typeof data.missionId !== "string" || typeof data.sequence !== "number" || typeof data.at !== "number") {
		throw new MissionStateError("mission-progress entry missing missionId, sequence, or at");
	}
	if (typeof data.type !== "string") {
		throw new MissionStateError("mission-progress entry missing type discriminator");
	}

	const base = {
		missionId: data.missionId,
		sequence: data.sequence,
		at: data.at,
	};

	switch (data.type) {
		case "accepted":
		case "resumed":
		case "run_started":
		case "completed":
		case "cancelled":
			return { ...base, type: data.type };
		case "paused":
			if (!isMissionPauseReason(data.reason)) {
				throw new MissionStateError("paused progress event requires a valid reason");
			}
			return { ...base, type: "paused", reason: data.reason };
		case "feature_selected":
			if (typeof data.featureId !== "string") {
				throw new MissionStateError("feature_selected progress event requires featureId");
			}
			return { ...base, type: "feature_selected", featureId: data.featureId };
		case "worker_started":
		case "worker_completed":
			if (typeof data.featureId !== "string" || typeof data.workerSessionId !== "string") {
				throw new MissionStateError(`${data.type} progress event requires featureId and workerSessionId`);
			}
			return {
				...base,
				type: data.type,
				featureId: data.featureId,
				workerSessionId: data.workerSessionId,
			};
		case "worker_failed":
			if (typeof data.featureId !== "string") {
				throw new MissionStateError("worker_failed progress event requires featureId");
			}
			return {
				...base,
				type: "worker_failed",
				featureId: data.featureId,
				workerSessionId: typeof data.workerSessionId === "string" ? data.workerSessionId : undefined,
			};
		case "heartbeat":
			if (
				typeof data.featureId !== "string" ||
				typeof data.workerSessionId !== "string" ||
				typeof data.requests !== "number" ||
				typeof data.tokens !== "number" ||
				typeof data.cost !== "number"
			) {
				throw new MissionStateError(
					"heartbeat progress event requires featureId, workerSessionId, requests, tokens, and cost",
				);
			}
			return {
				...base,
				type: "heartbeat",
				featureId: data.featureId,
				workerSessionId: data.workerSessionId,
				requests: data.requests,
				tokens: data.tokens,
				cost: data.cost,
			};
		case "handoff_resolved":
			if (typeof data.featureId !== "string" || !isHandoffResolveDecision(data.decision)) {
				throw new MissionStateError("handoff_resolved progress event requires featureId and decision");
			}
			return {
				...base,
				type: "handoff_resolved",
				featureId: data.featureId,
				decision: data.decision,
			};
		case "milestone_validation_triggered":
			if (typeof data.milestoneId !== "string") {
				throw new MissionStateError("milestone_validation_triggered progress event requires milestoneId");
			}
			return { ...base, type: "milestone_validation_triggered", milestoneId: data.milestoneId };
		case "publish_validation_triggered":
			if (typeof data.generation !== "number") {
				throw new MissionStateError("publish_validation_triggered progress event requires generation");
			}
			return { ...base, type: "publish_validation_triggered", generation: data.generation };
		default:
			throw new MissionStateError(`Unknown mission-progress type "${data.type}"`);
	}
}

function validateProgressSequences(events: readonly MissionProgressEvent[]): void {
	if (events.length === 0) {
		return;
	}
	const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
	for (let i = 0; i < sorted.length; i++) {
		const expected = i === 0 ? sorted[0]!.sequence : sorted[i - 1]!.sequence + 1;
		if (sorted[i]!.sequence !== expected) {
			throw new MissionStateError(
				`Mission progress event sequences must increase by one (expected ${expected}, got ${sorted[i]!.sequence})`,
			);
		}
	}
	// Append-only transcript order must match sequence order.
	for (let i = 0; i < events.length; i++) {
		if (events[i]!.sequence !== sorted[i]!.sequence) {
			throw new MissionStateError("Mission progress events are out of sequence order in the transcript");
		}
	}
}

function validatePublishCheck(
	state: MissionState,
	publishCheck: MissionPublishCheck,
	repository: MissionRepositoryState,
): void {
	if (publishCheck.integrationHead !== repository.integrationHead) {
		throw new MissionStateError("Publish check integrationHead must match repository.integrationHead");
	}

	if (publishCheck.generation === 0) {
		if (publishCheck.phase === "validated") {
			for (const milestone of state.milestones) {
				if (milestone.kind !== "planned") {
					continue;
				}
				for (const role of milestone.validators) {
					const validator = state.features.find(
						feature =>
							feature.kind === "validation" &&
							feature.milestoneId === milestone.id &&
							feature.validator === role,
					);
					if (validator?.status !== "completed") {
						throw new MissionStateError(
							`Generation 0 validated publish check requires completed planned validator ${milestone.id}/${role}`,
						);
					}
				}
			}
		}
		return;
	}

	const publishMilestones = state.milestones.filter(
		milestone => milestone.kind === "publish" && milestone.id === `_publish.${publishCheck.generation}`,
	);
	if (publishMilestones.length !== 1) {
		throw new MissionStateError(
			`Publish generation ${publishCheck.generation} must match exactly one _publish.${publishCheck.generation} milestone`,
		);
	}
	const publishMilestone = publishMilestones[0]!;
	if (publishMilestone.generation !== publishCheck.generation) {
		throw new MissionStateError(
			`Publish milestone generation must equal publish check generation ${publishCheck.generation}`,
		);
	}

	if (publishCheck.phase === "validated") {
		for (const role of publishMilestone.validators) {
			const validator = state.features.find(
				feature =>
					feature.kind === "validation" &&
					feature.milestoneId === publishMilestone.id &&
					feature.validator === role,
			);
			if (validator?.status !== "completed") {
				throw new MissionStateError(
					`Validated publish check requires completed validator ${publishMilestone.id}/${role}`,
				);
			}
			if (validator.validatedHead !== publishCheck.integrationHead) {
				throw new MissionStateError(
					`Validated publish validator "${validator.id}" validatedHead must equal publishCheck.integrationHead`,
				);
			}
			if (validator.workspace?.kind !== "validator") {
				throw new MissionStateError(
					`Validated publish validator "${validator.id}" must retain a validator workspace`,
				);
			}
			if (validator.validatedHead !== validator.workspace.head) {
				throw new MissionStateError(
					`Validated publish validator "${validator.id}" validatedHead must equal workspace.head`,
				);
			}
		}
	}
}

function validateIntegrationPending(state: MissionState, marker: MissionIntegrationPending): void {
	if (!state.repository) {
		throw new MissionStateError("Integration-pending marker requires repository state");
	}
	if (!state.pendingHandoff) {
		throw new MissionStateError("Integration-pending marker requires a pending handoff");
	}
	if (!handoffIsSuccessfulImplementation(state.pendingHandoff)) {
		throw new MissionStateError("Integration-pending marker requires a successful implementation handoff");
	}

	const feature = state.features.find(item => item.id === marker.featureId);
	if (!feature) {
		throw new MissionStateError(`Integration-pending marker references missing feature "${marker.featureId}"`);
	}
	if (feature.kind !== "implementation") {
		throw new MissionStateError("Integration-pending marker must name an implementation feature");
	}
	if (feature.status !== "in_progress") {
		throw new MissionStateError(
			"Integration-pending marker must name the current in_progress implementation feature",
		);
	}
	if (feature.workspace?.kind !== "feature") {
		throw new MissionStateError("Integration-pending marker requires a feature workspace");
	}
	if (
		marker.expectedOldHead !== feature.workspace.baseSha ||
		marker.expectedOldHead !== state.repository.integrationHead
	) {
		throw new MissionStateError(
			"Integration-pending expectedOldHead must equal workspace.baseSha and repository.integrationHead",
		);
	}

	const expectedNewHead = expectedIntegrationNewHead(state.pendingHandoff, marker.expectedOldHead);
	if (marker.newHead !== expectedNewHead) {
		throw new MissionStateError(
			`Integration-pending newHead must be ${expectedNewHead} (empty commits keep expectedOldHead; otherwise last oldest-first commit)`,
		);
	}
}

/** Snapshot invariants for a restored MissionState (throws MissionStateError on violation). */
export function assertMissionStateInvariants(
	state: MissionState,
	progressEvents: readonly MissionProgressEvent[] = [],
): void {
	if (state.version !== 1) {
		throw new MissionStateError(`Unsupported mission state version ${String(state.version)}`);
	}

	const inProgress = state.features.filter(feature => feature.status === "in_progress");
	if (inProgress.length > 1) {
		throw new MissionStateError("At most one feature may be in_progress");
	}
	const inProgressFeature = inProgress[0];

	if (state.activeRun) {
		if (!inProgressFeature || state.activeRun.featureId !== inProgressFeature.id) {
			throw new MissionStateError("Active-run token must match the in_progress feature");
		}
		if (inProgressFeature.currentWorkerSessionId !== state.activeRun.workerSessionId) {
			throw new MissionStateError("Active-run token must match the in_progress feature current worker");
		}
	}

	if (state.pendingHandoff) {
		if (!inProgressFeature) {
			throw new MissionStateError("Pending handoff requires an in_progress feature");
		}
		if (state.activeRun) {
			throw new MissionStateError("Pending handoff excludes an active run");
		}
	}

	switch (state.status) {
		case "orchestrator_turn":
			if (!state.pendingHandoff) {
				throw new MissionStateError("orchestrator_turn requires a pending handoff");
			}
			break;
		case "planning":
		case "awaiting_input":
			if (state.repository) {
				throw new MissionStateError(`${state.status} must not have a repository`);
			}
			for (const feature of state.features) {
				if (feature.workspace) {
					throw new MissionStateError(`${state.status} must not have feature workspaces`);
				}
			}
			break;
		case "completed":
		case "cancelled":
			if (state.activeRun) {
				throw new MissionStateError("Terminal mission states must not have an active run");
			}
			if (state.pendingHandoff) {
				throw new MissionStateError("Terminal mission states must not have a pending handoff");
			}
			break;
		case "initializing":
		case "running":
		case "paused":
			break;
		default:
			assertNever(state.status, "Unknown mission status");
	}

	for (const feature of state.features) {
		if (feature.workspace && feature.workspace.ownerSessionId !== state.ownerSessionId) {
			throw new MissionStateError(`Workspace owner for feature "${feature.id}" must equal mission ownerSessionId`);
		}
		if (feature.workspace && !workspaceMatchesFeatureKind(feature, feature.workspace)) {
			throw new MissionStateError(
				`Workspace kind for feature "${feature.id}" must match feature kind "${feature.kind}"`,
			);
		}
		for (const workerSessionId of feature.workerSessionIds) {
			if (typeof workerSessionId !== "string" || workerSessionId.length === 0) {
				throw new MissionStateError(`Feature "${feature.id}" has an empty worker session id`);
			}
		}

		if (feature.kind === "validation" && feature.status === "completed") {
			if (feature.validatedHead === undefined) {
				throw new MissionStateError(`Completed validator "${feature.id}" must retain validatedHead`);
			}
			if (feature.workspace?.kind !== "validator") {
				throw new MissionStateError(
					`Completed validator "${feature.id}" must retain a validator workspace descriptor`,
				);
			}
			if (feature.validatedHead !== feature.workspace.head) {
				throw new MissionStateError(`Completed validator "${feature.id}" validatedHead must equal workspace.head`);
			}
		}
	}

	validateProgressSequences(progressEvents.filter(event => event.missionId === state.id));

	if (state.integrationPending) {
		validateIntegrationPending(state, state.integrationPending);
	}

	if (state.repository?.publishCheck) {
		validatePublishCheck(state, state.repository.publishCheck, state.repository);
	}
}

function parseMissionState(data: unknown): MissionState {
	if (!isRecord(data)) {
		throw new MissionStateError("mission-state entry data must be an object");
	}
	if (data.version !== 1) {
		throw new MissionStateError("Newest mission-state entry must be version 1");
	}
	if (typeof data.id !== "string" || typeof data.ownerSessionId !== "string") {
		throw new MissionStateError("mission-state missing id or ownerSessionId");
	}
	if (typeof data.revision !== "number" || typeof data.goal !== "string") {
		throw new MissionStateError("mission-state missing revision or goal");
	}
	if (typeof data.autoAccept !== "boolean") {
		throw new MissionStateError("mission-state missing autoAccept");
	}
	if (typeof data.status !== "string" || !MISSION_STATUSES.includes(data.status as MissionStatus)) {
		throw new MissionStateError("mission-state has invalid status");
	}
	if (!isRecord(data.runbook) || !Array.isArray(data.milestones) || !Array.isArray(data.features)) {
		throw new MissionStateError("mission-state missing runbook, milestones, or features");
	}
	if (typeof data.createdAt !== "number" || typeof data.updatedAt !== "number") {
		throw new MissionStateError("mission-state missing createdAt or updatedAt");
	}

	for (const feature of data.features) {
		if (!isRecord(feature) || typeof feature.id !== "string" || typeof feature.kind !== "string") {
			throw new MissionStateError("mission-state feature entries must include id and kind");
		}
		if (typeof feature.status !== "string" || !(FEATURE_STATUSES as readonly string[]).includes(feature.status)) {
			throw new MissionStateError(`mission-state feature "${feature.id}" has invalid status`);
		}
		if (feature.kind !== "implementation" && feature.kind !== "validation") {
			throw new MissionStateError(`mission-state feature "${feature.id}" has invalid kind`);
		}
	}

	// Structural checks above + assertMissionStateInvariants cover semantic rules.
	return data as unknown as MissionState;
}

/**
 * Restore the authoritative MissionState from transcript entries.
 * A malformed newest mission-state entry is an error — never fall back to an older snapshot.
 */
export function loadMissionState(entries: readonly SessionEntry[]): MissionState | null {
	let newest: { data: unknown } | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === MISSION_STATE_CUSTOM_TYPE) {
			newest = { data: entry.data };
		}
	}
	if (!newest) {
		return null;
	}

	let state: MissionState;
	try {
		state = parseMissionState(newest.data);
	} catch (error) {
		if (error instanceof MissionStateError) {
			throw error;
		}
		throw new MissionStateError(
			`Malformed newest mission-state entry: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let progressEvents: MissionProgressEvent[];
	try {
		progressEvents = collectProgressEvents(entries, state.id);
	} catch (error) {
		if (error instanceof MissionStateError) {
			throw error;
		}
		throw new MissionStateError(
			`Malformed mission-progress entry: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	assertMissionStateInvariants(state, progressEvents);
	return state;
}

/**
 * Transitively cancel pending implementation features whose implementation precondition was cancelled.
 * Validation features are left for selection (their preconditions may be completed or cancelled).
 */
export function cancelUnsatisfiableFeatures(state: MissionState): MissionState {
	const features = state.features.map(feature => ({ ...feature }));
	const byId = new Map(features.map(feature => [feature.id, feature]));
	let changed = true;

	while (changed) {
		changed = false;
		for (const feature of features) {
			if (feature.kind !== "implementation" || feature.status !== "pending") {
				continue;
			}
			const blocked = feature.preconditions.some(preconditionId => {
				const precondition = byId.get(preconditionId);
				return precondition?.kind === "implementation" && precondition.status === "cancelled";
			});
			if (!blocked) {
				continue;
			}
			feature.status = "cancelled";
			feature.currentWorkerSessionId = undefined;
			feature.nextRunIntent = undefined;
			changed = true;
		}
	}

	const touched = features.some((feature, index) => feature.status !== state.features[index]!.status);
	if (!touched) {
		return state;
	}
	return {
		...state,
		features,
		updatedAt: state.updatedAt,
	};
}

function preconditionsSatisfied(feature: MissionFeature, byId: Map<string, MissionFeature>): boolean {
	switch (feature.kind) {
		case "implementation":
			return feature.preconditions.every(preconditionId => {
				const precondition = byId.get(preconditionId);
				return precondition?.status === "completed";
			});
		case "validation":
			return feature.preconditions.every(preconditionId => {
				const precondition = byId.get(preconditionId);
				return precondition?.status === "completed" || precondition?.status === "cancelled";
			});
		default:
			return assertNever(feature.kind, "Unknown feature kind");
	}
}

/**
 * Cancel unsatisfiable pending implementation features, then return at most one next pending feature
 * in plan order. Never schedules in parallel.
 */
export function nextMissionFeature(state: MissionState): NextMissionFeatureResult {
	const cancelledState = cancelUnsatisfiableFeatures(state);
	const byId = new Map(cancelledState.features.map(feature => [feature.id, feature]));

	for (const feature of cancelledState.features) {
		if (feature.status !== "pending") {
			continue;
		}
		if (!preconditionsSatisfied(feature, byId)) {
			continue;
		}
		return { state: cancelledState, feature };
	}

	return { state: cancelledState, feature: null };
}

/** True when resolveHandoff({ decision: "accept" }) is legal for the pending handoff. */
export function canAcceptPendingHandoff(handoff: MissionHandoff): boolean {
	switch (handoff.kind) {
		case "implementation":
			return handoff.outcome === "success" && !handoff.issues.some(issue => issue.severity === "blocking");
		case "validation":
			return handoff.verdict === "pass";
		default:
			return assertNever(handoff, "Unknown handoff kind");
	}
}

/** Milestone default validators: scrutiny + user-testing when the runbook supports it, else scrutiny alone. */
export function defaultMilestoneValidators(runbook: MissionPlan["runbook"]): MissionValidatorRole[] {
	const supportsUserTesting = runbook.userTests.length > 0 || runbook.services.length > 0;
	if (supportsUserTesting) {
		return ["scrutiny", "user-testing"];
	}
	return ["scrutiny"];
}

export function isMissionTerminal(state: MissionState): boolean {
	return isTerminalStatus(state.status);
}

export function isMissionPlanningPhase(state: MissionState): boolean {
	return isPlanningOrAwaiting(state.status);
}
