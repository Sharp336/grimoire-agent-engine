export type MissionStatus =
	| "planning"
	| "awaiting_input"
	| "initializing"
	| "running"
	| "paused"
	| "orchestrator_turn"
	| "completed"
	| "cancelled";

export type MissionFeatureStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type MissionValidatorRole = "scrutiny" | "user-testing";

export type MissionWorkerOutcome = "success" | "partial" | "failure" | "return_to_orchestrator";

export type MissionIssueSeverity = "blocking" | "non_blocking" | "suggestion";

export type MissionPauseReason =
	| "user_requested"
	| "feature_retry_limit_exceeded"
	| "worker_inactive"
	| "worker_interrupted"
	| "repository_dirty"
	| "workspace_conflict"
	| "integration_diverged"
	| "parent_diverged"
	| "validator_workspace_dirty";

export interface MissionRunbook {
	setup: string[];
	services: Array<{
		name: string;
		start: string;
		ready: string;
		stop?: string;
		logs?: string;
	}>;
	userTests: string[];
}

export interface MissionFeatureSpec {
	id: string;
	description: string;
	skillName?: string;
	milestoneId: string;
	preconditions: string[];
	expectedBehavior: string[];
	fulfills?: string[];
}

export interface MissionRemediationFeatureSpec {
	id: string;
	description: string;
	skillName?: string;
	preconditions: string[];
	expectedBehavior: string[];
	fulfills?: string[];
}

export interface MissionMilestoneSpec {
	id: string;
	description: string;
	featureIds: string[];
	validators: MissionValidatorRole[];
}

export interface MissionPlan {
	goal: string;
	runbook: MissionRunbook;
	milestones: MissionMilestoneSpec[];
	features: MissionFeatureSpec[];
}

export interface MissionPublishCheck {
	parentHead: string;
	integrationHead: string;
	generation: number;
	phase: "validating" | "validated";
}

export interface MissionRepositoryState {
	repoRoot: string;
	parentBranch: string;
	baseSha: string;
	integrationBranch: string;
	integrationHead: string;
	publishCheck?: MissionPublishCheck;
}

interface MissionWorkspaceBase {
	id: string;
	ownerSessionId: string;
	repoRoot: string;
	path: string;
	featureId: string;
	phase: "reserved" | "ready";
}

export interface MissionFeatureWorkspaceDescriptor extends MissionWorkspaceBase {
	kind: "feature";
	branch: string;
	baseSha: string;
}

export interface MissionValidatorWorkspaceDescriptor extends MissionWorkspaceBase {
	kind: "validator";
	head: string;
}

export type MissionWorkspaceDescriptor = MissionFeatureWorkspaceDescriptor | MissionValidatorWorkspaceDescriptor;

export interface MissionIssue {
	severity: MissionIssueSeverity;
	description: string;
	evidence?: string;
	affectedFeatureIds?: string[];
}

export interface MissionWorkerHandoff {
	kind: "implementation";
	outcome: MissionWorkerOutcome;
	summary: string;
	implementation: string[];
	remaining: string[];
	verification: {
		commands: Array<{ command: string; result: "passed" | "failed" | "not_run"; evidence?: string }>;
		interactiveChecks: Array<{ check: string; result: "passed" | "failed" | "not_run"; evidence?: string }>;
	};
	tests: { added: string[]; coverageNotes: string[] };
	issues: MissionIssue[];
	skillDeviations: string[];
	commits: string[];
}

export interface MissionValidatorHandoff {
	kind: "validation";
	role: MissionValidatorRole;
	verdict: "pass" | "fail";
	summary: string;
	checks: Array<{ check: string; result: "passed" | "failed" | "not_run"; evidence?: string }>;
	issues: MissionIssue[];
}

export type MissionHandoff = MissionWorkerHandoff | MissionValidatorHandoff;

/** Closed set of decisions a host may apply to a pending handoff. */
export type MissionHandoffDecision = "accept" | "retry_same" | "retry_fresh" | "cancel_feature" | "pause";

export interface MissionMilestone extends MissionMilestoneSpec {
	kind: "planned" | "publish";
	generation?: number;
}

export type MissionNextRunMode = "initial" | "follow_up" | "fresh";

export interface MissionNextRunIntent {
	mode: MissionNextRunMode;
	messageToWorker?: string;
}

export interface MissionFeature extends MissionFeatureSpec {
	kind: "implementation" | "validation";
	validator?: MissionValidatorRole;
	status: MissionFeatureStatus;
	workerSessionIds: string[];
	currentWorkerSessionId?: string;
	completedWorkerSessionId?: string;
	retryBudgetUsed: number;
	workspace?: MissionWorkspaceDescriptor;
	validatedHead?: string;
	nextRunIntent?: MissionNextRunIntent;
}

export interface MissionActiveRun {
	featureId: string;
	workerSessionId: string;
	turn: number;
}

export interface MissionIntegrationPending {
	featureId: string;
	expectedOldHead: string;
	newHead: string;
}

export interface MissionState {
	version: 1;
	id: string;
	ownerSessionId: string;
	revision: number;
	goal: string;
	autoAccept: boolean;
	status: MissionStatus;
	pauseReason?: MissionPauseReason;
	runbook: MissionRunbook;
	repository?: MissionRepositoryState;
	milestones: MissionMilestone[];
	features: MissionFeature[];
	activeRun?: MissionActiveRun;
	pendingHandoff?: MissionHandoff;
	integrationPending?: MissionIntegrationPending;
	workerModel?: string | string[];
	validatorModel?: string | string[];
	createdAt: number;
	updatedAt: number;
}

export interface MissionProgressEventBase {
	missionId: string;
	sequence: number;
	at: number;
}

export type MissionProgressEvent =
	| (MissionProgressEventBase & { type: "accepted" })
	| (MissionProgressEventBase & { type: "paused"; reason: MissionPauseReason })
	| (MissionProgressEventBase & { type: "resumed" })
	| (MissionProgressEventBase & { type: "run_started" })
	| (MissionProgressEventBase & { type: "feature_selected"; featureId: string })
	| (MissionProgressEventBase & { type: "worker_started"; featureId: string; workerSessionId: string })
	| (MissionProgressEventBase & {
			type: "heartbeat";
			featureId: string;
			workerSessionId: string;
			requests: number;
			tokens: number;
			cost: number;
	  })
	| (MissionProgressEventBase & { type: "worker_completed"; featureId: string; workerSessionId: string })
	| (MissionProgressEventBase & { type: "worker_failed"; featureId: string; workerSessionId?: string })
	| (MissionProgressEventBase & {
			type: "handoff_resolved";
			featureId: string;
			decision: MissionHandoffDecision;
	  })
	| (MissionProgressEventBase & { type: "milestone_validation_triggered"; milestoneId: string })
	| (MissionProgressEventBase & { type: "publish_validation_triggered"; generation: number })
	| (MissionProgressEventBase & { type: "completed" })
	| (MissionProgressEventBase & { type: "cancelled" });

export const MISSION_WORKER_TURN_CAP = 5;
export const MISSION_INACTIVITY_TIMEOUT_MS = 600_000;

export const MISSION_STATE_CUSTOM_TYPE = "mission-state";
export const MISSION_PROGRESS_CUSTOM_TYPE = "mission-progress";

/** Method/input types for MissionRuntime — recorded now; no runtime stub in this slice. */
export interface MissionRuntimeContract {
	snapshot(): MissionState | null;
	start(
		goal: string,
		options?: { workerModel?: string | string[]; validatorModel?: string | string[]; autoAccept?: boolean },
	): Promise<MissionState>;
	setPlan(plan: MissionPlan): Promise<MissionState>;
	accept(): Promise<MissionState>;
	runNext(signal?: AbortSignal): Promise<MissionHandoff | null>;
	resolveHandoff(input: { decision: MissionHandoffDecision; messageToWorker?: string }): Promise<MissionState>;
	revisePending(input: { addFeatures: MissionRemediationFeatureSpec[] }): Promise<MissionState>;
	pause(reason: MissionPauseReason): Promise<MissionState>;
	resume(input?: { restartWorker?: boolean; messageToWorker?: string }): Promise<MissionState>;
	cancel(): Promise<MissionState>;
	prepareToSuspend(): Promise<void>;
	restore(): Promise<MissionState | null>;
}
