/**
 * MissionRuntime — the single writer of mission state.
 *
 * Composes the pure append-only fold (`./state`), the crash-recoverable native-git
 * workspace manager (`./workspace`), and the structured-subagent primitives
 * (`../task/structured-subagent`, `../task/executor`) behind
 * {@link MissionRuntimeContract}.
 *
 * Three rules hold everywhere in this file:
 *
 * 1. **Persistence precedes effect.** Every transition appends its `mission-state`
 *    snapshot, zero or one progress event, and any mode marker through one
 *    {@link SessionManager.appendEntriesAtomically} batch and awaits it BEFORE any
 *    emit, child dispatch, or Git mutation. A persistence error leaves the prior
 *    in-memory state authoritative and blocks the effect.
 * 2. **The transition tail is short.** `#withTransitionTail` serializes state +
 *    persistence only. It never encloses Git work, a model turn, or an awaited child.
 * 3. **Ownership is checked, never assumed.** A restored snapshot whose
 *    `ownerSessionId` differs from the active session is read-only: it can be
 *    inspected but never resumes, dispatches, or touches a workspace.
 */

import { logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import activePromptTemplate from "../prompts/missions/active.md" with { type: "text" };
import continuationPromptTemplate from "../prompts/missions/continuation.md" with { type: "text" };
import interruptedPromptTemplate from "../prompts/missions/interrupted.md" with { type: "text" };
import planningPromptTemplate from "../prompts/missions/planning.md" with { type: "text" };
import scrutinyPromptTemplate from "../prompts/missions/scrutiny.md" with { type: "text" };
import userTestingPromptTemplate from "../prompts/missions/user-testing.md" with { type: "text" };
import workerPromptTemplate from "../prompts/missions/worker.md" with { type: "text" };
import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { MissionChildOwnerEntry, SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import { getBundledAgent } from "../task/agents";
import { runSubagentFollowUpTurn } from "../task/executor";
import {
	type ParentApprovalDelegate,
	reserveStructuredSubagentId,
	runStructuredSubagent,
} from "../task/structured-subagent";
import type { AgentProgress, SingleResult } from "../task/types";
import type { ToolSession } from "../tools";
import { buildOutputValidator } from "../tools/output-schema-validator";
import { getPreviewLines, PREVIEW_LIMITS, replaceTabs, TRUNCATE_LENGTHS } from "../tools/render-utils";
import * as git from "../utils/git";
import {
	assertMissionStateInvariants,
	canAcceptPendingHandoff,
	cancelUnsatisfiableFeatures,
	isMissionTerminal,
	loadMissionState,
	nextMissionFeature,
	validateMissionPlan,
} from "./state";
import {
	MISSION_INACTIVITY_TIMEOUT_MS,
	MISSION_PROGRESS_CUSTOM_TYPE,
	MISSION_STATE_CUSTOM_TYPE,
	MISSION_WORKER_TURN_CAP,
	type MissionFeature,
	type MissionFeatureWorkspaceDescriptor,
	type MissionHandoff,
	type MissionMilestone,
	type MissionNextRunMode,
	type MissionPauseReason,
	type MissionPlan,
	type MissionProgressEvent,
	type MissionProgressEventBase,
	type MissionRemediationFeatureSpec,
	type MissionRepositoryState,
	type MissionRuntimeContract,
	type MissionState,
	type MissionValidatorRole,
	type MissionWorkerHandoff,
	type MissionWorkspaceDescriptor,
} from "./types";
import { MissionWorkspaceManager } from "./workspace";

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

/** Hidden parent-only tool activated while a mission is nonterminal. */
const MISSION_TOOL_NAME = "mission";

/**
 * Heartbeats coalesce to this interval. The aggregated task `onProgress` callback
 * fires on every tool/token update; each persisted heartbeat rewrites the journal
 * atomically, so an unthrottled 1:1 mapping is quadratic in transcript length.
 * Inactivity is still reset by EVERY callback — only the persisted event coalesces.
 */
export const MISSION_HEARTBEAT_INTERVAL_MS = 15_000;

/** Idle TTL for id-scoped cold revivers registered for mission workers. */
export const MISSION_WORKER_IDLE_TTL_MS = 30 * 60 * 1000;

const LOCAL_BRANCH_PREFIX = "refs/heads/";

const RESULT_ENUM = ["passed", "failed", "not_run"] as const;

const CHECK_ITEM_SCHEMA = {
	type: "object",
	properties: {
		check: { type: "string" },
		result: { type: "string", enum: RESULT_ENUM },
		evidence: { type: "string" },
	},
	required: ["check", "result"],
	additionalProperties: false,
};

const COMMAND_ITEM_SCHEMA = {
	type: "object",
	properties: {
		command: { type: "string" },
		result: { type: "string", enum: RESULT_ENUM },
		evidence: { type: "string" },
	},
	required: ["command", "result"],
	additionalProperties: false,
};

const ISSUE_SCHEMA = {
	type: "object",
	properties: {
		severity: { type: "string", enum: ["blocking", "non_blocking", "suggestion"] },
		description: { type: "string" },
		evidence: { type: "string" },
		affectedFeatureIds: { type: "array", items: { type: "string" } },
	},
	required: ["severity", "description"],
	additionalProperties: false,
};

const STRING_ARRAY_SCHEMA = { type: "array", items: { type: "string" } };

/** Strict output contract for an implementation worker handoff. */
export const MISSION_IMPLEMENTATION_HANDOFF_SCHEMA = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["implementation"] },
		outcome: { type: "string", enum: ["success", "partial", "failure", "return_to_orchestrator"] },
		summary: { type: "string" },
		implementation: STRING_ARRAY_SCHEMA,
		remaining: STRING_ARRAY_SCHEMA,
		verification: {
			type: "object",
			properties: {
				commands: { type: "array", items: COMMAND_ITEM_SCHEMA },
				interactiveChecks: { type: "array", items: CHECK_ITEM_SCHEMA },
			},
			required: ["commands", "interactiveChecks"],
			additionalProperties: false,
		},
		tests: {
			type: "object",
			properties: { added: STRING_ARRAY_SCHEMA, coverageNotes: STRING_ARRAY_SCHEMA },
			required: ["added", "coverageNotes"],
			additionalProperties: false,
		},
		issues: { type: "array", items: ISSUE_SCHEMA },
		skillDeviations: STRING_ARRAY_SCHEMA,
		commits: STRING_ARRAY_SCHEMA,
	},
	required: [
		"kind",
		"outcome",
		"summary",
		"implementation",
		"remaining",
		"verification",
		"tests",
		"issues",
		"skillDeviations",
		"commits",
	],
	additionalProperties: false,
};

/** Strict output contract for a validator handoff (both roles). */
export const MISSION_VALIDATION_HANDOFF_SCHEMA = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["validation"] },
		role: { type: "string", enum: ["scrutiny", "user-testing"] },
		verdict: { type: "string", enum: ["pass", "fail"] },
		summary: { type: "string" },
		checks: { type: "array", items: CHECK_ITEM_SCHEMA },
		issues: { type: "array", items: ISSUE_SCHEMA },
	},
	required: ["kind", "role", "verdict", "summary", "checks", "issues"],
	additionalProperties: false,
};

const implementationHandoffValidator = buildOutputValidator(MISSION_IMPLEMENTATION_HANDOFF_SCHEMA).validator;
const validationHandoffValidator = buildOutputValidator(MISSION_VALIDATION_HANDOFF_SCHEMA).validator;

// ════════════════════════════════════════════════════════════════════════════
// Host contract
// ════════════════════════════════════════════════════════════════════════════

/**
 * Everything MissionRuntime needs from the owning top-level `AgentSession`.
 * Mirrors `GoalRuntimeHost`: plain callbacks only, never UI objects — the parent
 * approval delegate is produced on demand as a closure over AgentSession privates.
 */
export interface MissionRuntimeHost {
	/** Session id of the owning top-level session; re-read on every check so `/new` is followed. */
	ownerSessionId(): string;
	/** Parent checkout directory. */
	cwd(): string;
	sessionManager: Pick<
		SessionManager,
		"appendEntriesAtomically" | "appendCustomEntry" | "appendModeChange" | "getEntries" | "flush"
	>;
	emitUpdated(state: MissionState): void | Promise<void>;
	emitProgress(event: MissionProgressEvent): void | Promise<void>;
	sendHiddenMessage(message: {
		customType: string;
		content: string;
		deliverAs?: "steer" | "followUp" | "nextTurn";
	}): Promise<void>;
	getEnabledToolNames(): string[];
	/** Applying an active tool set also rebuilds the system prompt (SessionTools owns that). */
	setActiveToolsByName(names: string[]): Promise<void>;
	/** Parent-mediated approvals for one mission child; `undefined` fails the child closed. */
	parentApprovalDelegate(owner: MissionChildOwnerEntry): ParentApprovalDelegate | undefined;
	/** Resolve both child model patterns through the ModelRegistry; throws on an unknown model. */
	resolveChildModels(worker?: string | string[], validator?: string | string[]): Promise<void>;
	/** Throw when any name is absent from the session's loaded skill inventory. */
	assertSkillsExist(names: readonly string[]): void;
	getToolSession(): ToolSession;
	isPlanModeActive(): boolean;
	isGoalModeActive(): boolean;
	isVibeModeActive(): boolean;
	/**
	 * Register an id-scoped cold reviver for one mission worker; returns an
	 * unregister handle, or `undefined` when this host cannot revive (no
	 * auth/model/settings context). The factory itself is built by AgentSession —
	 * it needs private state the runtime must not hold.
	 */
	registerPersistedReviver(agentId: string): (() => void) | undefined;
	agentLifecycle(): AgentLifecycleManager;
	now?(): number;
}

export class MissionRuntimeError extends Error {
	override readonly name = "MissionRuntimeError";
}

/** Thrown when a session transition would interrupt in-flight mission work. */
export const MISSION_BUSY = "MISSION_BUSY";

/** Thrown when a transition would rewrite or relocate the transcript a live mission owns. */
export const INVALID_MISSION_TRANSITION = "INVALID_MISSION_TRANSITION";

// ════════════════════════════════════════════════════════════════════════════
// Prompt rendering
// ════════════════════════════════════════════════════════════════════════════

export type MissionPromptKind =
	| "active"
	| "planning"
	| "continuation"
	| "interrupted"
	| "worker"
	| "scrutiny"
	| "user-testing";

const MISSION_PROMPTS: Record<MissionPromptKind, string> = {
	active: activePromptTemplate,
	planning: planningPromptTemplate,
	continuation: continuationPromptTemplate,
	interrupted: interruptedPromptTemplate,
	worker: workerPromptTemplate,
	scrutiny: scrutinyPromptTemplate,
	"user-testing": userTestingPromptTemplate,
};

/** Render one static mission prompt. Prompts are `.md` files; never build them in code. */
export function renderMissionPrompt(kind: MissionPromptKind, context: prompt.TemplateContext = {}): string {
	return prompt.render(MISSION_PROMPTS[kind], context);
}

// ════════════════════════════════════════════════════════════════════════════
// Local helpers
// ════════════════════════════════════════════════════════════════════════════

type MissionProgressDraft = DistributiveOmit<MissionProgressEvent, keyof MissionProgressEventBase>;
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type MissionModeMarker = "mission" | "mission_paused" | "none";

function assertNever(value: never, message: string): never {
	throw new MissionRuntimeError(`${message}: ${JSON.stringify(value)}`);
}

/** Attach the base fields to a progress draft. The union spread is exact by construction. */
function withProgressBase(draft: MissionProgressDraft, base: MissionProgressEventBase): MissionProgressEvent {
	return { ...base, ...draft } as MissionProgressEvent;
}

function toLocalBranchRef(branchName: string): string {
	return branchName.startsWith(LOCAL_BRANCH_PREFIX) ? branchName : `${LOCAL_BRANCH_PREFIX}${branchName}`;
}

function isCleanCheckout(summary: { staged: number; unstaged: number; untracked: number } | null): boolean {
	return summary !== null && summary.staged === 0 && summary.unstaged === 0 && summary.untracked === 0;
}

/** Truncate untrusted evidence: tabs replaced, capped by the shared preview limits. */
function sanitizeEvidence(text: string): string {
	return getPreviewLines(replaceTabs(text), PREVIEW_LIMITS.EXPANDED_LINES, TRUNCATE_LENGTHS.LINE).join("\n");
}

/**
 * Schema evidence from at most the first ten validation errors, using ONLY each
 * error's path and message. The received value never appears.
 */
function schemaEvidenceFrom(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
	const lines = issues.slice(0, 10).map(issue => {
		const at = issue.path.map(segment => String(segment)).join(".");
		return at ? `${at}: ${issue.message}` : issue.message;
	});
	return sanitizeEvidence(lines.join("\n"));
}

function syntheticImplementationHandoff(schemaEvidence: string, description: string): MissionWorkerHandoff {
	return {
		kind: "implementation",
		outcome: "failure",
		summary: "Invalid structured handoff",
		implementation: [],
		remaining: [],
		verification: { commands: [], interactiveChecks: [] },
		tests: { added: [], coverageNotes: [] },
		issues: [{ severity: "blocking", description, evidence: schemaEvidence }],
		skillDeviations: [],
		commits: [],
	};
}

function syntheticValidationHandoff(
	expectedRole: MissionValidatorRole,
	schemaEvidence: string,
	description: string,
): MissionHandoff {
	return {
		kind: "validation",
		role: expectedRole,
		verdict: "fail",
		summary: "Invalid structured handoff",
		checks: [],
		issues: [{ severity: "blocking", description, evidence: schemaEvidence }],
	};
}

/** Actionable gap text carried into a retry turn. Pure data — no invented prose. */
function handoffGapText(handoff: MissionHandoff): string | undefined {
	const lines: string[] = [];
	for (const issue of handoff.issues) {
		if (issue.severity !== "blocking") continue;
		lines.push(issue.evidence ? `- ${issue.description} (${issue.evidence})` : `- ${issue.description}`);
	}
	if (handoff.kind === "implementation") {
		for (const remaining of handoff.remaining) lines.push(`- ${remaining}`);
	} else {
		for (const check of handoff.checks) {
			if (check.result === "failed") {
				lines.push(check.evidence ? `- ${check.check} (${check.evidence})` : `- ${check.check}`);
			}
		}
	}
	if (lines.length === 0) return undefined;
	return sanitizeEvidence(lines.join("\n"));
}

function featureById(state: MissionState, featureId: string): MissionFeature | undefined {
	return state.features.find(feature => feature.id === featureId);
}

function milestoneOf(state: MissionState, feature: MissionFeature): MissionMilestone {
	const milestone = state.milestones.find(item => item.id === feature.milestoneId);
	if (!milestone) {
		throw new MissionRuntimeError(`Feature "${feature.id}" references unknown milestone "${feature.milestoneId}"`);
	}
	return milestone;
}

function replaceFeature(state: MissionState, updated: MissionFeature): MissionState {
	return { ...state, features: state.features.map(feature => (feature.id === updated.id ? updated : feature)) };
}

function roleOf(feature: MissionFeature): MissionChildOwnerEntry["role"] {
	switch (feature.kind) {
		case "implementation":
			return "implementation";
		case "validation":
			if (!feature.validator) {
				throw new MissionRuntimeError(`Validation feature "${feature.id}" has no validator role`);
			}
			return feature.validator;
		default:
			return assertNever(feature.kind, "Unknown feature kind");
	}
}

function agentNameForRole(role: MissionChildOwnerEntry["role"]): string {
	switch (role) {
		case "implementation":
		case "user-testing":
			return "task";
		case "scrutiny":
			return "reviewer";
		default:
			return assertNever(role, "Unknown mission child role");
	}
}

function promptKindForRole(role: MissionChildOwnerEntry["role"]): MissionPromptKind {
	switch (role) {
		case "implementation":
			return "worker";
		case "scrutiny":
			return "scrutiny";
		case "user-testing":
			return "user-testing";
		default:
			return assertNever(role, "Unknown mission child role");
	}
}

/** Highest persisted progress sequence for this mission on the active branch. */
function latestProgressSequence(entries: readonly SessionEntry[], missionId: string): number {
	let sequence = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MISSION_PROGRESS_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null) continue;
		const record: Record<string, unknown> = data as Record<string, unknown>;
		if (record.missionId !== missionId) continue;
		if (typeof record.sequence === "number" && record.sequence > sequence) sequence = record.sequence;
	}
	return sequence;
}

// ════════════════════════════════════════════════════════════════════════════
// MissionRuntime
// ════════════════════════════════════════════════════════════════════════════

interface DispatchReservation {
	feature: MissionFeature;
	milestone: MissionMilestone;
	descriptor: MissionWorkspaceDescriptor;
	/** True when this runNext reserved a brand-new descriptor (materialize) instead of reusing one (reconcile). */
	freshlyReserved: boolean;
}

/**
 * Result of the runNext selection tail. `idle` means nothing is runnable, so the
 * caller checks completion OUTSIDE the tail (publication does Git work and takes
 * the tail again). `halted` means the tail already paused the mission.
 */
type SelectionOutcome = { kind: "dispatch"; reservation: DispatchReservation } | { kind: "idle" } | { kind: "halted" };

export class MissionRuntime implements MissionRuntimeContract {
	readonly #host: MissionRuntimeHost;
	readonly #workspaces = new MissionWorkspaceManager();
	readonly #reviverHandles = new Map<string, () => void>();

	#state: MissionState | null = null;
	#sequence = 0;
	#tail: Promise<void> = Promise.resolve();

	#pauseRequested = false;
	#cancelRequested = false;
	#suspended = false;

	#childAbort: AbortController | undefined;
	#inFlight: Promise<unknown> | undefined;
	#externalWork = 0;

	#inactivityTimer: NodeJS.Timeout | undefined;
	#lastHeartbeatAt = 0;

	#toolsActivated = false;
	#savedToolNames: string[] | undefined;

	constructor(host: MissionRuntimeHost) {
		this.#host = host;
	}

	// ── contract ────────────────────────────────────────────────────────────

	snapshot(): MissionState | null {
		return this.#state ? structuredClone(this.#state) : null;
	}

	async start(
		goal: string,
		options?: { workerModel?: string | string[]; validatorModel?: string | string[]; autoAccept?: boolean },
	): Promise<MissionState> {
		if (this.#host.isPlanModeActive())
			throw new MissionRuntimeError("Missions cannot start while plan mode is active.");
		if (this.#host.isGoalModeActive())
			throw new MissionRuntimeError("Missions cannot start while goal mode is active.");
		if (this.#host.isVibeModeActive())
			throw new MissionRuntimeError("Missions cannot start while vibe mode is active.");
		if (this.#state && !isMissionTerminal(this.#state)) {
			throw new MissionRuntimeError(`Mission ${this.#state.id} is already active (${this.#state.status}).`);
		}

		const now = this.#now();
		const created: MissionState = {
			version: 1,
			id: Snowflake.next(),
			ownerSessionId: this.#host.ownerSessionId(),
			revision: 0,
			goal,
			autoAccept: options?.autoAccept === true,
			status: "planning",
			runbook: { setup: [], services: [], userTests: [] },
			milestones: [],
			features: [],
			workerModel: options?.workerModel,
			validatorModel: options?.validatorModel,
			createdAt: now,
			updatedAt: now,
		};

		const state = await this.#withTransitionTail(() => this.#commit(created, { mode: "mission" }));
		this.#pauseRequested = false;
		this.#cancelRequested = false;
		await this.#activateTool();
		await this.#host.sendHiddenMessage({
			customType: "mission-planning",
			content: renderMissionPrompt("planning", { goal: goal.trim() || undefined }),
			deliverAs: "nextTurn",
		});
		return state;
	}

	async setPlan(plan: MissionPlan): Promise<MissionState> {
		const state = this.#requireOwnedState();
		if (state.status !== "planning" && state.status !== "awaiting_input") {
			throw new MissionRuntimeError(`set_plan is valid only while planning (status is "${state.status}").`);
		}
		const validation = validateMissionPlan(plan);
		if (!validation.valid) {
			throw new MissionRuntimeError(`Invalid mission plan:\n${validation.errors.map(e => `- ${e}`).join("\n")}`);
		}

		const milestones: MissionMilestone[] = plan.milestones.map(milestone => ({
			...milestone,
			featureIds: [...milestone.featureIds],
			validators: [...milestone.validators],
			kind: "planned",
		}));
		const features: MissionFeature[] = plan.features.map(feature => ({
			...feature,
			preconditions: [...feature.preconditions],
			expectedBehavior: [...feature.expectedBehavior],
			kind: "implementation",
			status: "pending",
			workerSessionIds: [],
			retryBudgetUsed: 0,
		}));

		return this.#withTransitionTail(() =>
			this.#commit({
				...state,
				revision: state.revision + 1,
				goal: plan.goal,
				runbook: {
					setup: [...plan.runbook.setup],
					services: plan.runbook.services.map(service => ({ ...service })),
					userTests: [...plan.runbook.userTests],
				},
				milestones,
				features,
				status: "awaiting_input",
			}),
		);
	}

	async accept(): Promise<MissionState> {
		const state = this.#requireOwnedState();
		if (state.status !== "awaiting_input") {
			throw new MissionRuntimeError(`accept is valid only in awaiting_input (status is "${state.status}").`);
		}

		// Resolution errors leave awaiting_input untouched — nothing is persisted yet.
		await this.#host.resolveChildModels(state.workerModel, state.validatorModel);
		const skills = [...new Set(state.features.flatMap(feature => (feature.skillName ? [feature.skillName] : [])))];
		if (skills.length > 0) this.#host.assertSkillsExist(skills);

		await this.#withTransitionTail(() =>
			this.#commit({ ...state, status: "initializing" }, { progress: { type: "accepted" } }),
		);
		return this.#initializeRepository();
	}

	async runNext(signal?: AbortSignal): Promise<MissionHandoff | null> {
		const state = this.#requireOwnedState();
		if (isMissionTerminal(state)) return null;
		if (state.pendingHandoff) {
			throw new MissionRuntimeError("A pending handoff must be resolved before run_next.");
		}
		if (state.status !== "running") {
			throw new MissionRuntimeError(`run_next requires status "running" (status is "${state.status}").`);
		}

		// (a) tail: select one feature, reserve its descriptor, persist feature_selected.
		const selection = await this.#withTransitionTail(() => this.#selectAndReserve());
		if (selection.kind === "idle") {
			await this.#maybeFinishMission(this.#requireState());
			return null;
		}
		if (selection.kind === "halted") return null;
		const reservation = selection.reservation;

		// (b) outside the tail: mutate Git for the workspace, then reserve the worker id.
		const ready = await this.#materializeWorkspace(reservation);
		if (!ready) return null;
		const dispatch = await this.#prepareDispatch(reservation);

		// (c) tail: persist ready + revalidate the race, then persist the active-run token.
		const started = await this.#withTransitionTail(() => this.#commitDispatch(reservation, ready, dispatch));
		if (!started) return null;

		const turn = this.#runChildTurn(started, signal);
		this.#inFlight = turn;
		try {
			return await turn;
		} finally {
			this.#inFlight = undefined;
		}
	}

	async resolveHandoff(input: {
		decision: "accept" | "retry_same" | "retry_fresh" | "cancel_feature" | "pause";
		messageToWorker?: string;
	}): Promise<MissionState> {
		const state = this.#requireOwnedState();
		const handoff = state.pendingHandoff;
		if (!handoff) throw new MissionRuntimeError("There is no pending handoff to resolve.");
		if (state.status !== "orchestrator_turn") {
			throw new MissionRuntimeError(
				`resolve_handoff requires status "orchestrator_turn" (status is "${state.status}"); resume the mission first.`,
			);
		}
		const feature = state.features.find(item => item.status === "in_progress");
		if (!feature) throw new MissionRuntimeError("Pending handoff has no in_progress feature.");

		switch (input.decision) {
			case "accept":
				return this.#acceptHandoff(state, feature, handoff);
			case "retry_same":
			case "retry_fresh":
				return this.#retryHandoff(feature, handoff, input.decision, input.messageToWorker);
			case "cancel_feature":
				return this.#cancelFeature(feature);
			case "pause":
				// Latch first: no successor dispatches even if persistence is slow.
				this.#pauseRequested = true;
				return this.#withTransitionTail(() =>
					this.#commit(
						{ ...state, status: "paused", pauseReason: "user_requested" },
						{
							progress: { type: "handoff_resolved", featureId: feature.id, decision: "pause" },
							mode: "mission_paused",
						},
					),
				);
			default:
				return assertNever(input.decision, "Unknown handoff decision");
		}
	}

	async revisePending(input: { addFeatures: MissionRemediationFeatureSpec[] }): Promise<MissionState> {
		const state = this.#requireOwnedState();
		const handoff = state.pendingHandoff;
		if (handoff?.kind !== "validation" || handoff.verdict !== "fail") {
			throw new MissionRuntimeError("revise_pending requires a failed validator handoff.");
		}
		if (state.status !== "orchestrator_turn") {
			throw new MissionRuntimeError(
				`revise_pending requires status "orchestrator_turn" (status is "${state.status}").`,
			);
		}
		if (input.addFeatures.length === 0) {
			throw new MissionRuntimeError("revise_pending requires at least one remediation feature.");
		}
		const failed = state.features.find(item => item.status === "in_progress");
		if (failed?.kind !== "validation") {
			throw new MissionRuntimeError("revise_pending has no in_progress validator feature.");
		}
		const milestone = milestoneOf(state, failed);

		const existingIds = new Set(state.features.map(item => item.id));
		const remediations: MissionFeature[] = [];
		for (const spec of input.addFeatures) {
			if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(spec.id)) {
				throw new MissionRuntimeError(`Remediation feature id "${spec.id}" must match [a-z0-9][a-z0-9._-]{0,63}.`);
			}
			if (existingIds.has(spec.id)) {
				throw new MissionRuntimeError(`Remediation feature id "${spec.id}" already exists.`);
			}
			if (spec.expectedBehavior.length === 0) {
				throw new MissionRuntimeError(`Remediation feature "${spec.id}" requires nonempty expectedBehavior.`);
			}
			existingIds.add(spec.id);
			remediations.push({
				id: spec.id,
				description: spec.description,
				skillName: spec.skillName,
				milestoneId: milestone.id,
				preconditions: [...spec.preconditions],
				expectedBehavior: [...spec.expectedBehavior],
				fulfills: spec.fulfills ? [...spec.fulfills] : undefined,
				kind: "implementation",
				status: "pending",
				workerSessionIds: [],
				retryBudgetUsed: 0,
			});
		}
		for (const remediation of remediations) {
			for (const precondition of remediation.preconditions) {
				if (!existingIds.has(precondition)) {
					throw new MissionRuntimeError(
						`Remediation feature "${remediation.id}" references unknown precondition "${precondition}".`,
					);
				}
			}
		}

		// Every validator checkout released here must be clean; a dirty one is preserved.
		const validators = state.features.filter(item => item.kind === "validation" && item.milestoneId === milestone.id);
		for (const validator of validators) {
			const workspace = validator.workspace;
			if (!workspace) continue;
			await this.#releaseWorkers(validator);
			const released = await this.#guardExternal(() => this.#workspaces.releaseIfEmpty(workspace));
			if (!released) {
				await this.#pauseWith("validator_workspace_dirty");
				throw new MissionRuntimeError(
					`Validator workspace for "${validator.id}" is not clean at ${workspace.path}; clean it and use /mission restart.`,
				);
			}
		}

		const remediationIds = remediations.map(item => item.id);
		const resetValidatorIds = new Set(validators.map(item => item.id));
		const features = state.features.map(item => {
			if (!resetValidatorIds.has(item.id)) return item;
			return {
				...item,
				status: "pending" as const,
				currentWorkerSessionId: undefined,
				completedWorkerSessionId: undefined,
				workspace: undefined,
				validatedHead: undefined,
				nextRunIntent: undefined,
				preconditions: [...item.preconditions, ...remediationIds.filter(id => !item.preconditions.includes(id))],
			};
		});

		// Ordered insert: remediation runs immediately before the first validator of this milestone.
		const firstValidatorIndex = features.findIndex(item => resetValidatorIds.has(item.id));
		const insertAt = firstValidatorIndex === -1 ? features.length : firstValidatorIndex;
		features.splice(insertAt, 0, ...remediations);

		const milestones = state.milestones.map(item =>
			item.id === milestone.id ? { ...item, featureIds: [...item.featureIds, ...remediationIds] } : item,
		);

		return this.#withTransitionTail(() =>
			this.#commit(
				{
					...state,
					revision: state.revision + 1,
					milestones,
					features,
					pendingHandoff: undefined,
					status: "running",
				},
				{ progress: { type: "milestone_validation_triggered", milestoneId: milestone.id } },
			),
		);
	}

	async pause(reason: MissionPauseReason): Promise<MissionState> {
		const state = this.#requireState();
		if (isMissionTerminal(state)) {
			throw new MissionRuntimeError(`Mission ${state.id} is already ${state.status}.`);
		}
		// Latch first: an in-flight child may settle, but no successor dispatches.
		this.#pauseRequested = true;
		if (state.status === "paused") return state;
		return this.#withTransitionTail(() =>
			this.#commit(
				{ ...state, status: "paused", pauseReason: reason },
				{ progress: { type: "paused", reason }, mode: "mission_paused" },
			),
		);
	}

	async resume(input?: { restartWorker?: boolean; messageToWorker?: string }): Promise<MissionState> {
		const state = this.#requireOwnedState();
		if (state.status !== "paused") {
			throw new MissionRuntimeError(`resume requires status "paused" (status is "${state.status}").`);
		}
		const reason = state.pauseReason;
		if (!reason) throw new MissionRuntimeError("Paused mission has no recorded pause reason.");

		let resumed: MissionState;
		switch (reason) {
			case "user_requested":
				resumed = await this.#resumeSimple(state, input);
				break;
			case "feature_retry_limit_exceeded":
				resumed = await this.#resumeRetryBudget(state, input);
				break;
			case "worker_inactive":
				resumed = await this.#resumeWithIntent(state, "fresh", input?.messageToWorker);
				break;
			case "worker_interrupted":
				resumed = await this.#resumeInterrupted(state, input);
				break;
			case "repository_dirty":
				this.#pauseRequested = false;
				resumed = await this.#initializeRepository();
				break;
			case "workspace_conflict":
				resumed = await this.#resumeWorkspaceConflict(state, input);
				break;
			case "integration_diverged":
				resumed = await this.#resumeIntegrationDiverged(state);
				break;
			case "parent_diverged":
				resumed = await this.#resumePublication(state);
				break;
			case "validator_workspace_dirty":
				throw new MissionRuntimeError(
					"A dirty validator checkout cannot be resumed. Clean the checkout, then use /mission restart.",
				);
			default:
				return assertNever(reason, "Unknown mission pause reason");
		}

		if (resumed.status === "running" || resumed.status === "orchestrator_turn") {
			await this.#enqueueContinuation();
		}
		return resumed;
	}

	async cancel(): Promise<MissionState> {
		const state = this.#requireState();
		if (isMissionTerminal(state)) return state;

		this.#cancelRequested = true;
		this.#pauseRequested = true;
		this.#childAbort?.abort(new MissionRuntimeError("Mission cancelled"));
		this.#clearInactivity();
		if (this.#inFlight) await this.#inFlight.catch(() => {});

		const current = this.#requireState();
		const owner = this.#isOwner();
		if (owner) {
			// Preserve every nonempty workspace; only clean, unmodified ones are removed.
			for (const feature of current.features) {
				if (feature.status === "completed") continue;
				await this.#releaseWorkers(feature);
				const workspace = feature.workspace;
				if (!workspace) continue;
				const released = await this.#guardExternal(() => this.#workspaces.releaseIfEmpty(workspace)).catch(
					error => {
						logger.warn("Mission workspace release failed during cancel", {
							featureId: feature.id,
							error: String(error),
						});
						return false;
					},
				);
				if (!released) {
					logger.info("Mission workspace preserved during cancel", {
						featureId: feature.id,
						path: workspace.path,
					});
				}
			}
		}

		const features = current.features.map(feature =>
			feature.status === "pending" || feature.status === "in_progress"
				? { ...feature, status: "cancelled" as const, currentWorkerSessionId: undefined, nextRunIntent: undefined }
				: feature,
		);
		const cancelled = await this.#withTransitionTail(() =>
			this.#commit(
				{
					...current,
					features,
					activeRun: undefined,
					pendingHandoff: undefined,
					integrationPending: undefined,
					status: "cancelled",
					pauseReason: undefined,
				},
				{ progress: { type: "cancelled" }, mode: "none" },
			),
		);
		await this.#deactivateTool();
		this.#unregisterAllRevivers();
		return cancelled;
	}

	async prepareToSuspend(): Promise<void> {
		const state = this.#state;
		this.#clearInactivity();
		this.#childAbort = undefined;
		this.#suspended = true;
		if (!state || isMissionTerminal(state)) return;
		if (state.status !== "paused") {
			await this.pause("user_requested");
		} else {
			this.#pauseRequested = true;
		}
		await this.#host.sessionManager.flush();
	}

	async restore(): Promise<MissionState | null> {
		this.#clearInactivity();
		this.#childAbort = undefined;
		this.#inFlight = undefined;
		this.#pauseRequested = false;
		this.#cancelRequested = false;
		this.#suspended = false;
		this.#unregisterAllRevivers();

		const entries = this.#host.sessionManager.getEntries();
		const loaded = loadMissionState(entries);
		if (!loaded) {
			await this.#deactivateTool();
			this.#state = null;
			this.#sequence = 0;
			return null;
		}
		this.#state = loaded;
		this.#sequence = latestProgressSequence(entries, loaded.id);

		if (!this.#isOwner()) {
			// A forked or copied transcript inspects only: never resume, dispatch, or clean up.
			await this.#deactivateTool();
			return this.snapshot();
		}

		if (isMissionTerminal(loaded)) {
			await this.#deactivateTool();
			await this.#restoreTerminalCleanup(loaded);
			return this.snapshot();
		}

		await this.#activateTool();
		for (const feature of loaded.features) {
			for (const workerSessionId of feature.workerSessionIds) this.#registerReviver(workerSessionId);
		}

		if (loaded.status === "initializing") {
			await this.#initializeRepository();
		}
		if (this.#state?.integrationPending) {
			await this.#recoverIntegrationPending();
		}
		await this.#restoreInterruptedWorker();
		return this.snapshot();
	}

	// ── host-facing extras (not part of MissionRuntimeContract) ─────────────

	/** True while a child turn, workspace/Git mutation, or state flush is in flight. */
	isBusy(): boolean {
		return this.#inFlight !== undefined || this.#externalWork > 0;
	}

	/** Nonterminal owned mission that blocks destructive session transitions. */
	hasActiveMission(): boolean {
		return this.#state !== null && !isMissionTerminal(this.#state) && this.#isOwner();
	}

	/** Parent system-prompt context while a mission is active; null when there is none. */
	buildActivePrompt(): string | null {
		const state = this.#state;
		if (!state || isMissionTerminal(state)) return null;
		return renderMissionPrompt("active");
	}

	/**
	 * Hidden autonomous-continuation nudge. Non-null only while the mission is
	 * running or holding an unresolved handoff on the orchestrator's turn.
	 */
	buildContinuationPrompt(): string | null {
		const state = this.#state;
		if (!state || !this.#isOwner()) return null;
		if (state.status !== "running" && state.status !== "orchestrator_turn") return null;
		return renderMissionPrompt("continuation");
	}

	// ── transition tail + persistence ───────────────────────────────────────

	#now(): number {
		return this.#host.now?.() ?? Date.now();
	}

	async #withTransitionTail<T>(fn: () => Promise<T> | T): Promise<T> {
		const previous = this.#tail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#tail = previous.then(
			() => promise,
			() => promise,
		);
		await previous.catch(() => {});
		try {
			return await fn();
		} finally {
			resolve();
		}
	}

	/**
	 * Persist one transition atomically, then publish it. MUST run inside the tail.
	 * A persistence error leaves `#state` (the prior snapshot) authoritative.
	 */
	async #commit(
		next: MissionState,
		options: { progress?: MissionProgressDraft; mode?: MissionModeMarker } = {},
	): Promise<MissionState> {
		const at = this.#now();
		const state: MissionState = { ...next, updatedAt: at };
		assertMissionStateInvariants(state);

		const sequence = this.#sequence + 1;
		const event = options.progress
			? withProgressBase(options.progress, { missionId: state.id, sequence, at })
			: undefined;
		const manager = this.#host.sessionManager;
		const mode = options.mode;

		await manager.appendEntriesAtomically(() => {
			manager.appendCustomEntry(MISSION_STATE_CUSTOM_TYPE, state);
			if (event) manager.appendCustomEntry(MISSION_PROGRESS_CUSTOM_TYPE, event);
			if (mode) manager.appendModeChange(mode, mode === "none" ? undefined : { missionId: state.id });
		});

		this.#state = state;
		if (event) this.#sequence = sequence;
		await this.#host.emitUpdated(state);
		if (event) await this.#host.emitProgress(event);
		return state;
	}

	/** Heartbeat path: append only the progress event, never mission state. */
	async #appendProgressOnly(draft: MissionProgressDraft): Promise<void> {
		const state = this.#state;
		if (!state) return;
		const sequence = this.#sequence + 1;
		const event = withProgressBase(draft, { missionId: state.id, sequence, at: this.#now() });
		const manager = this.#host.sessionManager;
		await manager.appendEntriesAtomically(() => {
			manager.appendCustomEntry(MISSION_PROGRESS_CUSTOM_TYPE, event);
		});
		this.#sequence = sequence;
		await this.#host.emitProgress(event);
	}

	#requireState(): MissionState {
		if (!this.#state) throw new MissionRuntimeError("No mission is active.");
		return this.#state;
	}

	#isOwner(): boolean {
		return this.#state?.ownerSessionId === this.#host.ownerSessionId();
	}

	#requireOwnedState(): MissionState {
		const state = this.#requireState();
		if (!this.#isOwner()) {
			throw new MissionRuntimeError(
				`Mission ${state.id} belongs to session ${state.ownerSessionId}; this transcript copy is read-only.`,
			);
		}
		return state;
	}

	/** Mark an external (Git/worktree) critical section so session transitions report MISSION_BUSY. */
	async #guardExternal<T>(fn: () => Promise<T>): Promise<T> {
		this.#externalWork++;
		try {
			return await fn();
		} finally {
			this.#externalWork--;
		}
	}

	async #pauseWith(reason: MissionPauseReason): Promise<MissionState> {
		const state = this.#requireState();
		this.#pauseRequested = true;
		return this.#withTransitionTail(() =>
			this.#commit(
				{ ...this.#requireState(), status: "paused", pauseReason: reason },
				{ progress: { type: "paused", reason }, mode: "mission_paused" },
			),
		).then(next => {
			logger.info("Mission paused", { missionId: state.id, reason });
			return next;
		});
	}

	// ── tool activation + continuation ──────────────────────────────────────

	async #activateTool(): Promise<void> {
		if (this.#toolsActivated) return;
		const enabled = this.#host.getEnabledToolNames();
		this.#savedToolNames = enabled.filter(name => name !== MISSION_TOOL_NAME);
		this.#toolsActivated = true;
		await this.#host.setActiveToolsByName([...this.#savedToolNames, MISSION_TOOL_NAME]);
	}

	async #deactivateTool(): Promise<void> {
		if (!this.#toolsActivated) return;
		const restored = this.#savedToolNames ?? this.#host.getEnabledToolNames().filter(n => n !== MISSION_TOOL_NAME);
		this.#savedToolNames = undefined;
		this.#toolsActivated = false;
		await this.#host.setActiveToolsByName(restored);
	}

	async #enqueueContinuation(): Promise<void> {
		const content = this.buildContinuationPrompt();
		if (!content) return;
		await this.#host.sendHiddenMessage({
			customType: "mission-continuation",
			content,
			deliverAs: "nextTurn",
		});
	}

	// ── acceptance / repository initialization ──────────────────────────────

	async #initializeRepository(): Promise<MissionState> {
		const state = this.#requireOwnedState();
		if (state.status !== "initializing") return state;

		const existing = state.repository;
		const repoRoot = existing?.repoRoot ?? (await this.#guardExternal(() => git.repo.root(this.#host.cwd())));
		if (!repoRoot) return this.#pauseWith("repository_dirty");

		const preflight = await this.#guardExternal(async () => {
			const parentBranch = await git.branch.current(repoRoot);
			const summary = await git.status.summary(repoRoot);
			const headSha = await git.ref.resolve(repoRoot, "HEAD");
			return { parentBranch, clean: isCleanCheckout(summary), headSha };
		});
		if (!preflight.parentBranch || !preflight.clean || !preflight.headSha) {
			logger.info("Mission acceptance preflight refused", {
				missionId: state.id,
				attached: preflight.parentBranch !== null,
				clean: preflight.clean,
			});
			return this.#pauseWith("repository_dirty");
		}
		if (existing && existing.parentBranch !== preflight.parentBranch) {
			return this.#pauseWith("repository_dirty");
		}

		const repository: MissionRepositoryState = existing ?? {
			repoRoot,
			parentBranch: preflight.parentBranch,
			baseSha: preflight.headSha,
			integrationBranch: `omp/mission/${state.id}/integration`,
			integrationHead: preflight.headSha,
		};
		if (!existing) {
			// The descriptor is durable before any ref is created.
			await this.#withTransitionTail(() => this.#commit({ ...this.#requireState(), repository }));
		}

		const integrationRef = toLocalBranchRef(repository.integrationBranch);
		const outcome = await this.#guardExternal(() =>
			git.withRepoLock(repoRoot, async (): Promise<"ready" | "repository_dirty" | "workspace_conflict"> => {
				const branch = await git.branch.current(repoRoot);
				const summary = await git.status.summary(repoRoot);
				const headSha = await git.ref.resolve(repoRoot, "HEAD");
				if (branch !== repository.parentBranch || !isCleanCheckout(summary) || headSha === null) {
					return "repository_dirty";
				}
				const current = await git.ref.resolve(repoRoot, integrationRef);
				if (current === null) {
					await git.branch.create(repoRoot, repository.integrationBranch, repository.integrationHead);
					return "ready";
				}
				return current === repository.integrationHead ? "ready" : "workspace_conflict";
			}),
		);
		if (outcome !== "ready") return this.#pauseWith(outcome);

		return this.#withTransitionTail(() =>
			this.#commit(
				{ ...this.#requireState(), repository, status: "running", pauseReason: undefined },
				{ progress: { type: "run_started" }, mode: "mission" },
			),
		);
	}

	// ── runNext: part (a) ───────────────────────────────────────────────────

	async #selectAndReserve(): Promise<SelectionOutcome> {
		let state = this.#requireState();

		// Milestone validators are injected before selection so the next milestone
		// can never run ahead of this milestone's validation.
		const injected = await this.#injectPendingValidators(state);
		if (injected) state = injected;

		const selection = nextMissionFeature(state);
		if (selection.state !== state) {
			state = await this.#commit(selection.state);
		}
		const feature = selection.feature;
		if (!feature) return { kind: "idle" };
		if (feature.retryBudgetUsed >= MISSION_WORKER_TURN_CAP) {
			this.#pauseRequested = true;
			await this.#commit(
				{ ...state, status: "paused", pauseReason: "feature_retry_limit_exceeded" },
				{ progress: { type: "paused", reason: "feature_retry_limit_exceeded" }, mode: "mission_paused" },
			);
			return { kind: "halted" };
		}

		const milestone = milestoneOf(state, feature);
		const existing = feature.workspace;
		const descriptor: MissionWorkspaceDescriptor =
			existing ??
			(feature.kind === "implementation"
				? await this.#workspaces.reserveFeature(state.ownerSessionId, state, feature)
				: await this.#workspaces.reserveValidator(state.ownerSessionId, state, feature.id));

		const reserved: MissionFeature = { ...feature, workspace: descriptor };
		const next = await this.#commit(replaceFeature(state, reserved), {
			progress: { type: "feature_selected", featureId: feature.id },
		});
		const persisted = featureById(next, feature.id);
		if (!persisted) throw new MissionRuntimeError(`Selected feature "${feature.id}" vanished during persistence.`);
		return {
			kind: "dispatch",
			reservation: { feature: persisted, milestone, descriptor, freshlyReserved: existing === undefined },
		};
	}

	/**
	 * Inject `_validate.<milestoneId>.<role>` features for the first milestone whose
	 * implementation features are all completed or cancelled. One milestone per
	 * transition (each carries its own `milestone_validation_triggered`).
	 */
	async #injectPendingValidators(state: MissionState): Promise<MissionState | null> {
		for (const milestone of state.milestones) {
			const implementations = state.features.filter(
				feature => feature.kind === "implementation" && feature.milestoneId === milestone.id,
			);
			const settled = implementations.every(
				feature => feature.status === "completed" || feature.status === "cancelled",
			);
			if (!settled) continue;

			const missing = milestone.validators.filter(
				role =>
					!state.features.some(
						feature =>
							feature.kind === "validation" &&
							feature.milestoneId === milestone.id &&
							feature.validator === role,
					),
			);
			if (missing.length === 0) continue;

			const preconditions = implementations.map(feature => feature.id);
			const expectedBehavior = [...new Set(implementations.flatMap(feature => feature.expectedBehavior))];
			const injected: MissionFeature[] = missing.map(role => ({
				id: `_validate.${milestone.id}.${role}`,
				description: `${role} validation for milestone ${milestone.id}`,
				milestoneId: milestone.id,
				preconditions,
				expectedBehavior:
					expectedBehavior.length > 0 ? expectedBehavior : [`Milestone ${milestone.id}: ${milestone.description}`],
				kind: "validation",
				validator: role,
				status: "pending",
				workerSessionIds: [],
				retryBudgetUsed: 0,
			}));

			// Place immediately after this milestone's last implementation feature.
			const features = [...state.features];
			let insertAt = features.length;
			for (let index = features.length - 1; index >= 0; index--) {
				const candidate = features[index];
				if (candidate && candidate.kind === "implementation" && candidate.milestoneId === milestone.id) {
					insertAt = index + 1;
					break;
				}
			}
			features.splice(insertAt, 0, ...injected);

			return this.#commit(
				{ ...state, features },
				{ progress: { type: "milestone_validation_triggered", milestoneId: milestone.id } },
			);
		}
		return null;
	}

	// ── runNext: part (b) ───────────────────────────────────────────────────

	async #materializeWorkspace(reservation: DispatchReservation): Promise<MissionWorkspaceDescriptor | null> {
		const hasTranscript = this.#hasChildTranscript(reservation.feature.currentWorkerSessionId);
		try {
			if (reservation.freshlyReserved && !hasTranscript) {
				return await this.#guardExternal(() => this.#workspaces.materialize(reservation.descriptor));
			}
			const result = await this.#guardExternal(() =>
				this.#workspaces.reconcile(reservation.descriptor, hasTranscript),
			);
			if (result.kind === "ready") return result.descriptor;
			logger.info("Mission workspace conflict", {
				featureId: result.featureId,
				path: result.path,
				detail: result.detail,
			});
			await this.#pauseWith("workspace_conflict");
			return null;
		} catch (error) {
			logger.warn("Mission workspace materialization failed", {
				featureId: reservation.feature.id,
				error: String(error),
			});
			await this.#pauseWith("workspace_conflict");
			return null;
		}
	}

	async #prepareDispatch(
		reservation: DispatchReservation,
	): Promise<{ mode: MissionNextRunMode; workerSessionId: string; messageToWorker?: string }> {
		const feature = reservation.feature;
		const intent = feature.nextRunIntent;
		let mode: MissionNextRunMode = intent?.mode ?? (feature.currentWorkerSessionId ? "follow_up" : "initial");
		if (mode === "follow_up" && !this.#hasChildTranscript(feature.currentWorkerSessionId)) {
			// No exact transcript survives: a fresh worker in the same workspace, never a wrong follow-up.
			mode = "fresh";
		}
		if (
			mode === "initial" &&
			feature.currentWorkerSessionId &&
			this.#hasChildTranscript(feature.currentWorkerSessionId)
		) {
			mode = "follow_up";
		}

		let workerSessionId: string;
		if (mode === "follow_up") {
			const current = feature.currentWorkerSessionId;
			if (!current) throw new MissionRuntimeError(`follow_up for "${feature.id}" has no current worker session id.`);
			workerSessionId = current;
		} else if (mode === "initial" && feature.currentWorkerSessionId) {
			workerSessionId = feature.currentWorkerSessionId;
		} else {
			workerSessionId = await reserveStructuredSubagentId(this.#host.getToolSession(), {
				label: `mission-${feature.id}`,
			});
		}
		return { mode, workerSessionId, messageToWorker: intent?.messageToWorker };
	}

	// ── runNext: part (c) ───────────────────────────────────────────────────

	async #commitDispatch(
		reservation: DispatchReservation,
		ready: MissionWorkspaceDescriptor,
		dispatch: { mode: MissionNextRunMode; workerSessionId: string; messageToWorker?: string },
	): Promise<{
		feature: MissionFeature;
		milestone: MissionMilestone;
		descriptor: MissionWorkspaceDescriptor;
		mode: MissionNextRunMode;
		workerSessionId: string;
		messageToWorker?: string;
		turn: number;
	} | null> {
		const state = this.#requireState();
		const current = featureById(state, reservation.feature.id);
		if (!current) return null;

		// The owned ready descriptor is persisted even when the race was lost.
		const readyState = await this.#commit(replaceFeature(state, { ...current, workspace: ready }));
		const settled = featureById(readyState, reservation.feature.id);
		if (!settled) return null;

		if (
			this.#pauseRequested ||
			this.#cancelRequested ||
			this.#suspended ||
			readyState.status !== "running" ||
			readyState.pendingHandoff !== undefined ||
			settled.status !== "pending"
		) {
			return null;
		}

		const workerSessionIds = settled.workerSessionIds.includes(dispatch.workerSessionId)
			? settled.workerSessionIds
			: [...settled.workerSessionIds, dispatch.workerSessionId];
		const turn = settled.retryBudgetUsed + 1;
		const started: MissionFeature = {
			...settled,
			status: "in_progress",
			workerSessionIds,
			currentWorkerSessionId: dispatch.workerSessionId,
			retryBudgetUsed: turn,
			nextRunIntent: undefined,
		};

		await this.#commit(
			{
				...replaceFeature(readyState, started),
				activeRun: { featureId: started.id, workerSessionId: dispatch.workerSessionId, turn },
			},
			{ progress: { type: "worker_started", featureId: started.id, workerSessionId: dispatch.workerSessionId } },
		);
		this.#registerReviver(dispatch.workerSessionId);
		return {
			feature: started,
			milestone: reservation.milestone,
			descriptor: ready,
			mode: dispatch.mode,
			workerSessionId: dispatch.workerSessionId,
			messageToWorker: dispatch.messageToWorker,
			turn,
		};
	}

	// ── child turn ──────────────────────────────────────────────────────────

	async #runChildTurn(
		dispatch: {
			feature: MissionFeature;
			milestone: MissionMilestone;
			descriptor: MissionWorkspaceDescriptor;
			mode: MissionNextRunMode;
			workerSessionId: string;
			messageToWorker?: string;
			turn: number;
		},
		signal?: AbortSignal,
	): Promise<MissionHandoff | null> {
		const state = this.#requireState();
		const feature = dispatch.feature;
		const role = roleOf(feature);
		const controller = new AbortController();
		this.#childAbort = controller;
		const onExternalAbort = (): void => controller.abort(signal?.reason);
		signal?.addEventListener("abort", onExternalAbort, { once: true });

		let inactive = false;
		const armInactivity = (): void => {
			this.#clearInactivity();
			this.#inactivityTimer = setTimeout(() => {
				inactive = true;
				controller.abort(new MissionRuntimeError("Mission worker inactivity timeout"));
			}, MISSION_INACTIVITY_TIMEOUT_MS);
		};
		armInactivity();
		this.#lastHeartbeatAt = 0;

		const owner: MissionChildOwnerEntry = {
			missionId: state.id,
			ownerSessionId: state.ownerSessionId,
			role,
			milestoneId: feature.milestoneId,
			featureId: feature.id,
		};
		const onProgress = (progress: AgentProgress): void => {
			armInactivity();
			const at = this.#now();
			if (at - this.#lastHeartbeatAt < MISSION_HEARTBEAT_INTERVAL_MS) return;
			this.#lastHeartbeatAt = at;
			void this.#withTransitionTail(async () => {
				const live = this.#state?.activeRun;
				if (
					!live ||
					live.featureId !== feature.id ||
					live.workerSessionId !== dispatch.workerSessionId ||
					live.turn !== dispatch.turn
				) {
					return;
				}
				await this.#appendProgressOnly({
					type: "heartbeat",
					featureId: feature.id,
					workerSessionId: dispatch.workerSessionId,
					requests: progress.requests,
					tokens: progress.tokens,
					cost: progress.cost,
				});
			}).catch(error => logger.warn("Mission heartbeat persistence failed", { error: String(error) }));
		};

		let result: SingleResult | undefined;
		let failure: string | undefined;
		try {
			result = await this.#invokeChild(state, dispatch, role, owner, controller.signal, onProgress);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		} finally {
			this.#clearInactivity();
			signal?.removeEventListener("abort", onExternalAbort);
			if (this.#childAbort === controller) this.#childAbort = undefined;
		}

		if (inactive) {
			await this.#settleInactivity(dispatch, feature.id);
			return null;
		}
		return this.#settleTurn(dispatch, result, failure);
	}

	async #invokeChild(
		state: MissionState,
		dispatch: {
			feature: MissionFeature;
			milestone: MissionMilestone;
			descriptor: MissionWorkspaceDescriptor;
			mode: MissionNextRunMode;
			workerSessionId: string;
			messageToWorker?: string;
		},
		role: MissionChildOwnerEntry["role"],
		owner: MissionChildOwnerEntry,
		signal: AbortSignal,
		onProgress: (progress: AgentProgress) => void,
	): Promise<SingleResult> {
		const feature = dispatch.feature;
		const agentName = agentNameForRole(role);
		const outputSchema =
			feature.kind === "implementation" ? MISSION_IMPLEMENTATION_HANDOFF_SCHEMA : MISSION_VALIDATION_HANDOFF_SCHEMA;
		const model = feature.kind === "implementation" ? state.workerModel : state.validatorModel;
		const message =
			dispatch.mode === "follow_up" && dispatch.messageToWorker
				? dispatch.messageToWorker
				: renderMissionPrompt(promptKindForRole(role), {
						feature: { id: feature.id, description: feature.description },
						milestone: { id: dispatch.milestone.id, description: dispatch.milestone.description },
						skillName: feature.skillName,
						expectedBehavior: feature.expectedBehavior,
						priorHandoffGap: dispatch.messageToWorker,
						runbook: state.runbook,
					});

		if (dispatch.mode === "follow_up") {
			const agent = getBundledAgent(agentName);
			if (!agent) throw new MissionRuntimeError(`Bundled agent "${agentName}" is unavailable.`);
			return runSubagentFollowUpTurn({
				id: dispatch.workerSessionId,
				agent,
				message,
				description: `mission ${state.id} ${feature.id}`,
				outputSchema,
				outputSchemaMode: "strict",
				outputSchemaSource: "caller",
				signal,
				onProgress,
				maxRuntimeMs: 0,
			});
		}

		const invocation = await runStructuredSubagent({
			session: this.#host.getToolSession(),
			invocationKind: "task",
			assignment: message,
			agent: agentName,
			model,
			outputSchema,
			schemaMode: "strict",
			identity: { id: dispatch.workerSessionId, label: `mission-${feature.id}` },
			workspace: { cwd: dispatch.descriptor.path, binding: "fixed" },
			approvalDelegate: this.#host.parentApprovalDelegate(owner),
			missionOwner: owner,
			keepAlive: true,
			maxRuntimeMs: 0,
			signal,
			onProgress,
		});
		return invocation.result;
	}

	/** Inactivity: the turn is consumed, the worker id is dropped, and no handoff is recorded. */
	async #settleInactivity(dispatch: { workerSessionId: string; turn: number }, featureId: string): Promise<void> {
		await this.#releaseWorkerId(dispatch.workerSessionId);
		await this.#withTransitionTail(async () => {
			const state = this.#state;
			const active = state?.activeRun;
			if (
				!state ||
				!active ||
				active.featureId !== featureId ||
				active.workerSessionId !== dispatch.workerSessionId ||
				active.turn !== dispatch.turn
			) {
				return;
			}
			const feature = featureById(state, featureId);
			if (!feature) return;
			const reset: MissionFeature = {
				...feature,
				status: "pending",
				currentWorkerSessionId: undefined,
				nextRunIntent: { mode: "fresh" },
			};
			const cleared = await this.#commit(
				{ ...replaceFeature(state, reset), activeRun: undefined },
				{ progress: { type: "worker_failed", featureId, workerSessionId: dispatch.workerSessionId } },
			);
			await this.#commit(
				{ ...cleared, status: "paused", pauseReason: "worker_inactive" },
				{ progress: { type: "paused", reason: "worker_inactive" }, mode: "mission_paused" },
			);
			this.#pauseRequested = true;
		});
	}

	async #settleTurn(
		dispatch: {
			feature: MissionFeature;
			workerSessionId: string;
			turn: number;
		},
		result: SingleResult | undefined,
		failure: string | undefined,
	): Promise<MissionHandoff | null> {
		const parsed = this.#parseHandoff(dispatch.feature, result, failure);
		return this.#withTransitionTail(async () => {
			const state = this.#state;
			const active = state?.activeRun;
			if (
				!state ||
				!active ||
				active.featureId !== dispatch.feature.id ||
				active.workerSessionId !== dispatch.workerSessionId ||
				active.turn !== dispatch.turn
			) {
				// Pause or cancel already won this race; the settling result never overwrites it.
				return null;
			}
			const nextStatus = state.status === "paused" || this.#pauseRequested ? "paused" : "orchestrator_turn";
			await this.#commit(
				{
					...state,
					activeRun: undefined,
					pendingHandoff: parsed.handoff,
					status: nextStatus,
					pauseReason: nextStatus === "paused" ? (state.pauseReason ?? "user_requested") : undefined,
				},
				{
					progress: parsed.failed
						? { type: "worker_failed", featureId: dispatch.feature.id, workerSessionId: dispatch.workerSessionId }
						: {
								type: "worker_completed",
								featureId: dispatch.feature.id,
								workerSessionId: dispatch.workerSessionId,
							},
				},
			);
			return parsed.handoff;
		});
	}

	#parseHandoff(
		feature: MissionFeature,
		result: SingleResult | undefined,
		failure: string | undefined,
	): { handoff: MissionHandoff; failed: boolean } {
		const expectedRole = feature.kind === "validation" ? feature.validator : undefined;
		const synth = (evidence: string, description: string): MissionHandoff =>
			expectedRole
				? syntheticValidationHandoff(expectedRole, evidence, description)
				: syntheticImplementationHandoff(evidence, description);

		if (failure !== undefined) {
			return {
				handoff: synth(sanitizeEvidence(failure), "Worker turn failed before producing a handoff"),
				failed: true,
			};
		}
		if (!result) {
			return { handoff: synth("", "Worker turn produced no result"), failed: true };
		}
		if (result.aborted) {
			return {
				handoff: synth(sanitizeEvidence(result.abortReason ?? "aborted"), "Worker turn was aborted"),
				failed: true,
			};
		}
		if (result.exitCode !== 0 || result.error !== undefined) {
			return {
				handoff: synth(sanitizeEvidence(result.error ?? `exit ${result.exitCode}`), "Worker turn ended in error"),
				failed: true,
			};
		}

		const data = result.structuredOutput?.data;
		const validator = expectedRole ? validationHandoffValidator : implementationHandoffValidator;
		const validation = validator?.validate(data);
		if (!validator || !validation?.success) {
			const description = expectedRole
				? "Validator handoff did not match the required schema"
				: "Worker handoff did not match the required schema";
			return { handoff: synth(schemaEvidenceFrom(validation?.issues ?? []), description), failed: true };
		}

		// Validated against the handoff JSON schema immediately above; kind/role are re-checked below.
		const handoff = data as MissionHandoff;
		if (expectedRole && (handoff.kind !== "validation" || handoff.role !== expectedRole)) {
			return {
				handoff: synth(
					schemaEvidenceFrom([{ path: ["role"], message: `expected "${expectedRole}"` }]),
					"Validator handoff did not match the required schema",
				),
				failed: true,
			};
		}
		if (!expectedRole && handoff.kind !== "implementation") {
			return {
				handoff: synth(
					schemaEvidenceFrom([{ path: ["kind"], message: 'expected "implementation"' }]),
					"Worker handoff did not match the required schema",
				),
				failed: true,
			};
		}
		return { handoff, failed: false };
	}

	// ── handoff resolution ──────────────────────────────────────────────────

	async #acceptHandoff(state: MissionState, feature: MissionFeature, handoff: MissionHandoff): Promise<MissionState> {
		if (!canAcceptPendingHandoff(handoff)) {
			throw new MissionRuntimeError(
				handoff.kind === "implementation"
					? "Only a successful implementation handoff with no blocking issues can be accepted."
					: "Only a passing validator handoff can be accepted.",
			);
		}
		if (handoff.kind === "implementation") return this.#acceptImplementation(state, feature, handoff);
		return this.#acceptValidator(feature);
	}

	async #acceptImplementation(
		state: MissionState,
		feature: MissionFeature,
		handoff: MissionWorkerHandoff,
	): Promise<MissionState> {
		const repository = state.repository;
		const workspace = feature.workspace;
		if (!repository) throw new MissionRuntimeError("Mission has no repository state.");
		if (workspace?.kind !== "feature") {
			throw new MissionRuntimeError(`Feature "${feature.id}" has no feature workspace to integrate.`);
		}
		const expectedOldHead = workspace.baseSha;
		const newHead =
			handoff.commits.length === 0 ? expectedOldHead : (handoff.commits[handoff.commits.length - 1] as string);

		// Phase one: the intent is durable before the CAS.
		await this.#withTransitionTail(() =>
			this.#commit({
				...this.#requireState(),
				integrationPending: { featureId: feature.id, expectedOldHead, newHead },
			}),
		);
		return this.#applyIntegration(feature.id, workspace, handoff);
	}

	/** Phase two: ancestry-checked CAS on the un-checked-out integration ref, then completion. */
	async #applyIntegration(
		featureId: string,
		workspace: MissionFeatureWorkspaceDescriptor,
		handoff: MissionWorkerHandoff,
	): Promise<MissionState> {
		const state = this.#requireState();
		const repository = state.repository;
		if (!repository) throw new MissionRuntimeError("Mission has no repository state.");

		const outcome = await this.#guardExternal(() =>
			this.#workspaces.advanceIntegration(repository, workspace, handoff),
		);
		switch (outcome.kind) {
			case "advanced":
			case "already_applied":
				return this.#completeImplementation(featureId, workspace, outcome.repository);
			case "partial_handoff": {
				// Not provably safe: the handoff degrades to partial and stays on the orchestrator's turn.
				const degraded: MissionWorkerHandoff = {
					...handoff,
					outcome: "partial",
					issues: [...handoff.issues, ...outcome.issues],
				};
				return this.#withTransitionTail(() =>
					this.#commit({ ...this.#requireState(), pendingHandoff: degraded, integrationPending: undefined }),
				);
			}
			case "pause":
				logger.info("Mission integration diverged", {
					featureId,
					integrationBranch: outcome.integrationBranch,
					expectedOldHead: outcome.expectedOldHead,
					actualHead: outcome.actualHead,
				});
				return this.#pauseWith(outcome.reason);
			default:
				return assertNever(outcome, "Unknown advanceIntegration result");
		}
	}

	async #completeImplementation(
		featureId: string,
		workspace: MissionFeatureWorkspaceDescriptor,
		repository: MissionRepositoryState,
	): Promise<MissionState> {
		const completed = await this.#withTransitionTail(async () => {
			const state = this.#requireState();
			const feature = featureById(state, featureId);
			if (!feature) throw new MissionRuntimeError(`Feature "${featureId}" vanished during integration.`);
			const milestone = milestoneOf(state, feature);
			const publishCheck =
				milestone.kind === "publish" && repository.publishCheck
					? {
							...repository.publishCheck,
							integrationHead: repository.integrationHead,
							phase: "validating" as const,
						}
					: repository.publishCheck;
			const done: MissionFeature = {
				...feature,
				status: "completed",
				completedWorkerSessionId: feature.currentWorkerSessionId,
				currentWorkerSessionId: undefined,
				nextRunIntent: undefined,
			};
			return this.#commit(
				{
					...replaceFeature(state, done),
					repository: { ...repository, publishCheck },
					pendingHandoff: undefined,
					integrationPending: undefined,
					status: "running",
					pauseReason: undefined,
				},
				{ progress: { type: "handoff_resolved", featureId, decision: "accept" } },
			);
		});

		// Only after the completed snapshot is durable may children and the worktree go.
		const feature = featureById(completed, featureId);
		if (feature) {
			await this.#releaseWorkers(feature);
			await this.#guardExternal(() => this.#workspaces.release(workspace)).catch(error =>
				logger.warn("Mission feature workspace release failed", { featureId, error: String(error) }),
			);
		}
		return this.#requireState();
	}

	async #acceptValidator(feature: MissionFeature): Promise<MissionState> {
		const workspace = feature.workspace;
		if (workspace?.kind !== "validator") {
			throw new MissionRuntimeError(`Validator "${feature.id}" has no validator workspace.`);
		}
		const completed = await this.#withTransitionTail(() => {
			const current = this.#requireState();
			const done: MissionFeature = {
				...feature,
				status: "completed",
				validatedHead: workspace.head,
				completedWorkerSessionId: feature.currentWorkerSessionId,
				currentWorkerSessionId: undefined,
				nextRunIntent: undefined,
			};
			return this.#commit(
				{ ...replaceFeature(current, done), pendingHandoff: undefined, status: "running", pauseReason: undefined },
				{ progress: { type: "handoff_resolved", featureId: feature.id, decision: "accept" } },
			);
		});

		await this.#releaseWorkers(feature);
		const released = await this.#guardExternal(() => this.#workspaces.releaseIfEmpty(workspace)).catch(error => {
			logger.warn("Mission validator workspace release failed", { featureId: feature.id, error: String(error) });
			return false;
		});
		if (!released) return this.#pauseWith("validator_workspace_dirty");

		await this.#maybeFinishMission(completed);
		return this.#requireState();
	}

	async #retryHandoff(
		feature: MissionFeature,
		handoff: MissionHandoff,
		decision: "retry_same" | "retry_fresh",
		messageToWorker: string | undefined,
	): Promise<MissionState> {
		const mode: MissionNextRunMode = decision === "retry_same" ? "follow_up" : "fresh";
		const message = messageToWorker?.trim() || handoffGapText(handoff);
		if (decision === "retry_fresh") {
			await this.#releaseWorkerId(feature.currentWorkerSessionId);
		}

		const retried = await this.#withTransitionTail(() => {
			const current = this.#requireState();
			const next: MissionFeature = {
				...feature,
				status: "pending",
				currentWorkerSessionId: decision === "retry_same" ? feature.currentWorkerSessionId : undefined,
				nextRunIntent: { mode, messageToWorker: message },
			};
			return this.#commit(
				{ ...replaceFeature(current, next), pendingHandoff: undefined, status: "running", pauseReason: undefined },
				{ progress: { type: "handoff_resolved", featureId: feature.id, decision } },
			);
		});

		if (feature.retryBudgetUsed >= MISSION_WORKER_TURN_CAP) {
			return this.#withTransitionTail(() =>
				this.#commit(
					{ ...this.#requireState(), status: "paused", pauseReason: "feature_retry_limit_exceeded" },
					{ progress: { type: "paused", reason: "feature_retry_limit_exceeded" }, mode: "mission_paused" },
				),
			).then(paused => {
				this.#pauseRequested = true;
				return paused;
			});
		}
		return retried;
	}

	async #cancelFeature(feature: MissionFeature): Promise<MissionState> {
		if (feature.kind !== "implementation") {
			throw new MissionRuntimeError("cancel_feature is legal only for implementation features.");
		}
		await this.#releaseWorkers(feature);
		const workspace = feature.workspace;
		if (workspace) {
			await this.#guardExternal(() => this.#workspaces.releaseIfEmpty(workspace)).catch(error =>
				logger.warn("Mission workspace preserved after cancel_feature", {
					featureId: feature.id,
					error: String(error),
				}),
			);
		}
		return this.#withTransitionTail(() => {
			const current = this.#requireState();
			const cancelled: MissionFeature = {
				...feature,
				status: "cancelled",
				currentWorkerSessionId: undefined,
				nextRunIntent: undefined,
			};
			const pruned = cancelUnsatisfiableFeatures(replaceFeature(current, cancelled));
			return this.#commit(
				{ ...pruned, pendingHandoff: undefined, status: "running", pauseReason: undefined },
				{ progress: { type: "handoff_resolved", featureId: feature.id, decision: "cancel_feature" } },
			);
		});
	}

	// ── resume branches ─────────────────────────────────────────────────────

	async #resumeSimple(state: MissionState, input?: { messageToWorker?: string }): Promise<MissionState> {
		const status = state.pendingHandoff ? "orchestrator_turn" : "running";
		const features = input?.messageToWorker
			? state.features.map(feature =>
					feature.status === "pending" && feature.nextRunIntent
						? { ...feature, nextRunIntent: { ...feature.nextRunIntent, messageToWorker: input.messageToWorker } }
						: feature,
				)
			: state.features;
		this.#pauseRequested = false;
		return this.#withTransitionTail(() =>
			this.#commit(
				{ ...this.#requireState(), features, status, pauseReason: undefined },
				{ progress: { type: "resumed" }, mode: "mission" },
			),
		);
	}

	async #resumeRetryBudget(
		state: MissionState,
		input?: { restartWorker?: boolean; messageToWorker?: string },
	): Promise<MissionState> {
		const target =
			state.features.find(
				feature => feature.status === "pending" && feature.retryBudgetUsed >= MISSION_WORKER_TURN_CAP,
			) ??
			state.features.find(feature => feature.status === "pending" && feature.nextRunIntent) ??
			state.features.find(feature => feature.status === "in_progress");
		if (!target) return this.#resumeSimple(state, input);
		const mode: MissionNextRunMode = input?.restartWorker
			? "fresh"
			: (target.nextRunIntent?.mode ?? (target.currentWorkerSessionId ? "follow_up" : "initial"));
		if (mode === "fresh") await this.#releaseWorkerId(target.currentWorkerSessionId);
		this.#pauseRequested = false;
		return this.#withTransitionTail(() => {
			const current = this.#requireState();
			// A user resume resets only retryBudgetUsed; workerSessionIds are history.
			const reset: MissionFeature = {
				...target,
				status: "pending",
				retryBudgetUsed: 0,
				currentWorkerSessionId: mode === "fresh" ? undefined : target.currentWorkerSessionId,
				nextRunIntent: { mode, messageToWorker: input?.messageToWorker ?? target.nextRunIntent?.messageToWorker },
			};
			return this.#commit(
				{ ...replaceFeature(current, reset), status: "running", pauseReason: undefined },
				{ progress: { type: "resumed" }, mode: "mission" },
			);
		});
	}

	async #resumeWithIntent(
		state: MissionState,
		mode: MissionNextRunMode,
		messageToWorker: string | undefined,
	): Promise<MissionState> {
		const target =
			state.features.find(feature => feature.status === "pending" && feature.nextRunIntent) ??
			state.features.find(feature => feature.status === "in_progress");
		if (!target) return this.#resumeSimple(state, { messageToWorker });
		if (mode === "fresh") await this.#releaseWorkerId(target.currentWorkerSessionId);
		this.#pauseRequested = false;
		return this.#withTransitionTail(() => {
			const current = this.#requireState();
			const next: MissionFeature = {
				...target,
				status: "pending",
				currentWorkerSessionId: mode === "fresh" ? undefined : target.currentWorkerSessionId,
				nextRunIntent: { mode, messageToWorker: messageToWorker ?? target.nextRunIntent?.messageToWorker },
			};
			return this.#commit(
				{ ...replaceFeature(current, next), status: "running", pauseReason: undefined },
				{ progress: { type: "resumed" }, mode: "mission" },
			);
		});
	}

	async #resumeInterrupted(
		state: MissionState,
		input?: { restartWorker?: boolean; messageToWorker?: string },
	): Promise<MissionState> {
		const target = state.features.find(feature => feature.status === "pending" && feature.nextRunIntent);
		if (!target) return this.#resumeSimple(state, input);
		const recovered = target.nextRunIntent?.mode ?? "initial";
		const mode: MissionNextRunMode = input?.restartWorker ? "fresh" : recovered;
		return this.#resumeWithIntent(state, mode, input?.messageToWorker ?? target.nextRunIntent?.messageToWorker);
	}

	async #resumeWorkspaceConflict(
		state: MissionState,
		input?: { restartWorker?: boolean; messageToWorker?: string },
	): Promise<MissionState> {
		const target = state.features.find(feature => feature.workspace && feature.status !== "completed");
		const workspace = target?.workspace;
		if (!target || !workspace) return this.#resumeSimple(state, input);
		const result = await this.#guardExternal(() =>
			this.#workspaces.reconcile(workspace, this.#hasChildTranscript(target.currentWorkerSessionId)),
		);
		if (result.kind !== "ready") {
			throw new MissionRuntimeError(
				`Workspace for "${target.id}" is still conflicted at ${result.path}: ${result.detail}`,
			);
		}
		const reconciled = result.descriptor;
		this.#pauseRequested = false;
		return this.#withTransitionTail(() => {
			const current = this.#requireState();
			return this.#commit(
				{
					...replaceFeature(current, { ...target, workspace: reconciled }),
					status: current.pendingHandoff ? "orchestrator_turn" : "running",
					pauseReason: undefined,
				},
				{ progress: { type: "resumed" }, mode: "mission" },
			);
		});
	}

	async #resumeIntegrationDiverged(state: MissionState): Promise<MissionState> {
		if (!state.integrationPending) return this.#resumeSimple(state);
		const recovered = await this.#recoverIntegrationPending();
		if (recovered.status === "paused") {
			throw new MissionRuntimeError(
				`Integration branch still diverged; reconcile ${state.repository?.integrationBranch ?? "the integration ref"} manually.`,
			);
		}
		return recovered;
	}

	// ── integration-pending recovery ────────────────────────────────────────

	async #recoverIntegrationPending(): Promise<MissionState> {
		const state = this.#requireState();
		const marker = state.integrationPending;
		const repository = state.repository;
		if (!marker || !repository) return state;
		const feature = featureById(state, marker.featureId);
		const workspace = feature?.workspace;
		const handoff = state.pendingHandoff;
		if (!feature || !workspace || workspace.kind !== "feature" || handoff?.kind !== "implementation") {
			return this.#pauseWith("integration_diverged");
		}

		const integrationRef = toLocalBranchRef(repository.integrationBranch);
		const actual = await this.#guardExternal(() => git.ref.resolve(repository.repoRoot, integrationRef));
		if (actual === marker.newHead) {
			return this.#completeImplementation(marker.featureId, workspace, {
				...repository,
				integrationHead: marker.newHead,
			});
		}
		if (actual === marker.expectedOldHead) {
			return this.#applyIntegration(marker.featureId, workspace, handoff);
		}
		logger.info("Mission integration ref moved outside the mission", {
			featureId: marker.featureId,
			expectedOldHead: marker.expectedOldHead,
			newHead: marker.newHead,
			actualHead: actual,
		});
		return this.#pauseWith("integration_diverged");
	}

	// ── publication ─────────────────────────────────────────────────────────

	async #maybeFinishMission(state: MissionState): Promise<void> {
		if (state.status !== "running" && state.status !== "orchestrator_turn") return;
		if (state.pendingHandoff) return;
		const unfinished = state.features.some(
			feature => feature.status !== "completed" && feature.status !== "cancelled",
		);
		if (unfinished) return;
		const pendingValidators = state.milestones.some(milestone =>
			milestone.validators.some(
				role =>
					!state.features.some(
						feature =>
							feature.kind === "validation" &&
							feature.milestoneId === milestone.id &&
							feature.validator === role,
					),
			),
		);
		if (pendingValidators) return;
		if (!state.repository) return;
		await this.#publish(state.repository);
	}

	async #publish(repository: MissionRepositoryState): Promise<void> {
		const repoRoot = repository.repoRoot;
		const integrationRef = toLocalBranchRef(repository.integrationBranch);
		const observed = await this.#guardExternal(async () => {
			const branch = await git.branch.current(repoRoot);
			const summary = await git.status.summary(repoRoot);
			return {
				branch,
				clean: isCleanCheckout(summary),
				parentHead: await git.ref.resolve(repoRoot, "HEAD"),
				integrationHead: await git.ref.resolve(repoRoot, integrationRef),
			};
		});
		const parentHead = observed.parentHead;
		const integrationHead = observed.integrationHead;
		if (observed.branch !== repository.parentBranch || !observed.clean || !parentHead || !integrationHead) {
			await this.#pauseWith("parent_diverged");
			return;
		}
		if (parentHead === integrationHead) {
			// Already applied (crash after the fast-forward, or an out-of-band merge of the exact head).
			await this.#finishCompleted();
			return;
		}

		const existing = repository.publishCheck;
		const generation = existing?.generation ?? 0;
		const expectedParent = existing ? existing.parentHead : repository.baseSha;
		if (parentHead !== expectedParent || integrationHead !== repository.integrationHead) {
			await this.#pauseWith("parent_diverged");
			return;
		}

		// The exact heads are durable before the lock, so a crash after the merge is idempotent.
		await this.#withTransitionTail(() => {
			const state = this.#requireState();
			const current = state.repository;
			if (!current) throw new MissionRuntimeError("Mission has no repository state.");
			return this.#commit({
				...state,
				repository: {
					...current,
					publishCheck: { parentHead, integrationHead: current.integrationHead, generation, phase: "validated" },
				},
			});
		});

		const merged = await this.#guardExternal(() =>
			git.withRepoLock(repoRoot, async (): Promise<boolean> => {
				const branch = await git.branch.current(repoRoot);
				const summary = await git.status.summary(repoRoot);
				if (
					branch !== repository.parentBranch ||
					!isCleanCheckout(summary) ||
					(await git.ref.resolve(repoRoot, "HEAD")) !== parentHead ||
					(await git.ref.resolve(repoRoot, integrationRef)) !== integrationHead
				) {
					return false;
				}
				await git.merge.fastForwardOnly(repoRoot, repository.integrationBranch);
				// The merge command succeeding is not evidence on its own: reread everything.
				const afterBranch = await git.branch.current(repoRoot);
				const afterSummary = await git.status.summary(repoRoot);
				return (
					afterBranch === repository.parentBranch &&
					isCleanCheckout(afterSummary) &&
					(await git.ref.resolve(repoRoot, "HEAD")) === integrationHead &&
					(await git.ref.resolve(repoRoot, integrationRef)) === integrationHead
				);
			}),
		).catch(error => {
			logger.warn("Mission publication fast-forward failed", { error: String(error) });
			return false;
		});

		if (!merged) {
			await this.#pauseWith("parent_diverged");
			return;
		}
		await this.#finishCompleted();
	}

	async #finishCompleted(): Promise<void> {
		await this.#withTransitionTail(() =>
			this.#commit(
				{
					...this.#requireState(),
					status: "completed",
					pauseReason: undefined,
					activeRun: undefined,
					pendingHandoff: undefined,
					integrationPending: undefined,
				},
				{ progress: { type: "completed" }, mode: "none" },
			),
		);
		await this.#deactivateTool();
		this.#unregisterAllRevivers();
		const state = this.#requireState();
		await this.#restoreTerminalCleanup(state);
	}

	/** parent_diverged resume: accept a manually rebased integration ref and open a new publication generation. */
	async #resumePublication(state: MissionState): Promise<MissionState> {
		const repository = state.repository;
		if (!repository) throw new MissionRuntimeError("Mission has no repository state.");
		const repoRoot = repository.repoRoot;
		const integrationRef = toLocalBranchRef(repository.integrationBranch);
		const observed = await this.#guardExternal(async () => {
			const branch = await git.branch.current(repoRoot);
			const summary = await git.status.summary(repoRoot);
			const parentHead = await git.ref.resolve(repoRoot, "HEAD");
			const integrationHead = await git.ref.resolve(repoRoot, integrationRef);
			return { branch, clean: isCleanCheckout(summary), parentHead, integrationHead };
		});
		const parentHead = observed.parentHead;
		const integrationHead = observed.integrationHead;
		if (observed.branch !== repository.parentBranch || !observed.clean || !parentHead || !integrationHead) {
			throw new MissionRuntimeError(
				`Publication requires a clean checkout attached to "${repository.parentBranch}" before resume.`,
			);
		}
		const rebased = await this.#guardExternal(() => git.ref.isAncestor(repoRoot, parentHead, integrationHead));
		if (!rebased) {
			throw new MissionRuntimeError(
				`Rebase "${repository.integrationBranch}" onto ${parentHead} before resuming publication.`,
			);
		}

		const generation = (repository.publishCheck?.generation ?? 0) + 1;
		const roles: MissionValidatorRole[] = [];
		for (const milestone of state.milestones) {
			if (milestone.kind !== "planned") continue;
			for (const role of milestone.validators) {
				if (!roles.includes(role)) roles.push(role);
			}
		}
		const milestoneId = `_publish.${generation}`;
		const publishMilestone: MissionMilestone = {
			id: milestoneId,
			kind: "publish",
			generation,
			description: "Publication validation",
			featureIds: [],
			validators: roles,
		};
		const publishFeatures: MissionFeature[] = roles.map(role => ({
			id: `_validate.publish.${generation}.${role}`,
			description: `${role} validation for publication generation ${generation}`,
			milestoneId,
			preconditions: [],
			expectedBehavior: [
				`Integration branch ${repository.integrationBranch} is safe to fast-forward onto ${repository.parentBranch}.`,
			],
			kind: "validation",
			validator: role,
			status: "pending",
			workerSessionIds: [],
			retryBudgetUsed: 0,
		}));

		this.#pauseRequested = false;
		return this.#withTransitionTail(() =>
			this.#commit(
				{
					...this.#requireState(),
					repository: {
						...repository,
						integrationHead,
						publishCheck: { parentHead, integrationHead, generation, phase: "validating" },
					},
					milestones: [...state.milestones, publishMilestone],
					features: [...state.features, ...publishFeatures],
					status: "running",
					pauseReason: undefined,
				},
				{ progress: { type: "publish_validation_triggered", generation } },
			),
		);
	}

	// ── restore helpers ─────────────────────────────────────────────────────

	/**
	 * No model turn survives a process exit: an `in_progress` feature with a matching
	 * token and no handoff is recovered, never silently redispatched.
	 */
	async #restoreInterruptedWorker(): Promise<void> {
		const state = this.#state;
		if (!state || state.pendingHandoff) return;
		const active = state.activeRun;
		if (!active) return;
		const feature = featureById(state, active.featureId);
		if (feature?.status !== "in_progress") return;
		if (feature.currentWorkerSessionId !== active.workerSessionId) return;

		const workspace = feature.workspace;
		let mode: MissionNextRunMode = "initial";
		let messageToWorker: string | undefined;
		let conflicted = false;

		if (!workspace) {
			conflicted = true;
		} else {
			const result = await this.#guardExternal(() =>
				this.#workspaces.reconcile(workspace, this.#hasChildTranscript(active.workerSessionId)),
			).catch(error => {
				logger.warn("Mission workspace reconcile failed during restore", {
					featureId: feature.id,
					error: String(error),
				});
				return null;
			});
			if (result?.kind !== "ready") {
				conflicted = true;
			} else if (this.#hasExactChildWorkspace(active.workerSessionId, result.descriptor)) {
				mode = "follow_up";
				const milestone = milestoneOf(state, feature);
				messageToWorker = renderMissionPrompt("interrupted", {
					feature: { id: feature.id, description: feature.description },
					milestone: { id: milestone.id, description: milestone.description },
					skillName: feature.skillName,
					priorHandoffGap: undefined,
				});
			}
		}

		// The already-counted turn is preserved; only the token is cleared.
		const recovered: MissionFeature = {
			...feature,
			status: "pending",
			nextRunIntent: { mode, messageToWorker },
		};
		const reason: MissionPauseReason = conflicted ? "workspace_conflict" : "worker_interrupted";
		await this.#withTransitionTail(async () => {
			const current = this.#requireState();
			const cleared = await this.#commit({ ...replaceFeature(current, recovered), activeRun: undefined });
			await this.#commit(
				{ ...cleared, status: "paused", pauseReason: reason },
				{ progress: { type: "paused", reason }, mode: "mission_paused" },
			);
		});
		this.#pauseRequested = true;
	}

	/** Terminal cleanup is idempotent, non-forcible, and preserves anything it cannot prove safe. */
	async #restoreTerminalCleanup(state: MissionState): Promise<void> {
		if (!this.#isOwner()) return;
		for (const feature of state.features) {
			const workspace = feature.workspace;
			if (!workspace) continue;
			const released = await this.#guardExternal(() => this.#workspaces.releaseIfEmpty(workspace)).catch(error => {
				logger.warn("Mission workspace cleanup failed", { featureId: feature.id, error: String(error) });
				return false;
			});
			if (!released) {
				logger.info("workspace_cleanup_conflict", { featureId: feature.id, path: workspace.path });
			}
		}
		if (state.status !== "completed") return;
		const repository = state.repository;
		if (!repository) return;
		const integrationRef = toLocalBranchRef(repository.integrationBranch);
		await this.#guardExternal(async () => {
			const head = await git.ref.resolve(repository.repoRoot, integrationRef);
			if (head === null) return;
			if (head !== repository.integrationHead) {
				logger.info("Mission integration branch preserved: ref changed", {
					branch: repository.integrationBranch,
					expected: repository.integrationHead,
					actual: head,
				});
				return;
			}
			await git.branch.tryDelete(repository.repoRoot, repository.integrationBranch, { force: false });
		}).catch(error => logger.warn("Mission integration branch cleanup failed", { error: String(error) }));
	}

	// ── child bookkeeping ───────────────────────────────────────────────────

	#hasChildTranscript(workerSessionId: string | undefined): boolean {
		if (!workerSessionId) return false;
		const ref = AgentRegistry.global().get(workerSessionId);
		return Boolean(ref?.sessionFile ?? ref?.session);
	}

	#hasExactChildWorkspace(workerSessionId: string, descriptor: MissionWorkspaceDescriptor): boolean {
		if (!this.#hasChildTranscript(workerSessionId)) return false;
		const session = AgentRegistry.global().get(workerSessionId)?.session;
		if (!session) return true;
		return session.sessionManager.getCwd() === descriptor.path;
	}

	#registerReviver(workerSessionId: string): void {
		if (this.#reviverHandles.has(workerSessionId)) return;
		const unregister = this.#host.registerPersistedReviver(workerSessionId);
		if (unregister) this.#reviverHandles.set(workerSessionId, unregister);
	}

	#unregisterAllRevivers(): void {
		for (const unregister of this.#reviverHandles.values()) unregister();
		this.#reviverHandles.clear();
	}

	async #releaseWorkerId(workerSessionId: string | undefined): Promise<void> {
		if (!workerSessionId) return;
		this.#reviverHandles.get(workerSessionId)?.();
		this.#reviverHandles.delete(workerSessionId);
		await this.#host
			.agentLifecycle()
			.release(workerSessionId)
			.catch(error => {
				logger.warn("Mission worker release failed", { workerSessionId, error: String(error) });
				return false;
			});
	}

	async #releaseWorkers(feature: MissionFeature): Promise<void> {
		for (const workerSessionId of feature.workerSessionIds) await this.#releaseWorkerId(workerSessionId);
	}

	#clearInactivity(): void {
		if (this.#inactivityTimer) {
			clearTimeout(this.#inactivityTimer);
			this.#inactivityTimer = undefined;
		}
	}
}

/** The runtime surface `restartMission` drives; keeps the helper testable with a stub. */
export type MissionRestartRuntime = Pick<MissionRuntime, "snapshot" | "resume" | "resolveHandoff">;

/**
 * `/mission restart` semantics expressed over the runtime primitives: release the
 * current child and dispatch a fresh worker in the preserved feature workspace.
 *
 * A paused mission resumes with `restartWorker`, which clears the current worker id
 * and records a `fresh` next-run intent. If that lands back on an unresolved handoff
 * (the paused-handoff case), it is resolved as `retry_fresh` so the same workspace is
 * reused by a brand-new child. Every other status is refused rather than guessed at.
 *
 * Callers MUST reject a busy runtime first — restart is illegal while a turn is in
 * flight, and no primitive here can interrupt one.
 *
 * Exported so `/mission restart` and `mission_restart` share one definition of
 * restart instead of drifting apart in two hosts.
 */
export async function restartMission(
	runtime: MissionRestartRuntime,
	messageToWorker?: string,
): Promise<MissionState | null> {
	const state = runtime.snapshot();
	if (!state) throw new MissionRuntimeError("There is no mission to restart.");
	if (isMissionTerminal(state)) {
		throw new MissionRuntimeError(`Mission ${state.id} is already ${state.status}.`);
	}

	const resumed = state.status === "paused" ? await runtime.resume({ restartWorker: true, messageToWorker }) : state;
	if (resumed.status === "orchestrator_turn" && resumed.pendingHandoff) {
		return runtime.resolveHandoff({ decision: "retry_fresh", messageToWorker });
	}
	if (state.status === "paused") return resumed;
	throw new MissionRuntimeError(
		`restart requires a paused mission or a pending handoff (status is "${state.status}"); pause the mission first.`,
	);
}
