import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { Goal, GoalModeState, GoalStatus } from "../../goals/state";
import { type PlanApprovalDetails, resolveApprovedPlan } from "../../plan-mode/approved-plan";
import type { PlanModeState } from "../../plan-mode/state";
import type { ConfiguredThinkingLevel } from "../../thinking";
import { type ResolveToolDetails, runResolveInvocation } from "../../tools/resolve-invocation";
import { ToolError } from "../../tools/tool-errors";
import type {
	RpcGoalModeStatus,
	RpcNativeModeAction,
	RpcNativeModeResult,
	RpcNativeModeState,
	RpcPlanModeStatus,
} from "./rpc-types";

export const DEFAULT_RPC_PLAN_FILE_PATH = "local://PLAN.md";
export const RPC_GOAL_CONTINUATION_DELAY_MS = 800;

export type RpcPersistedNativeMode = "plan" | "plan_paused" | "goal" | "goal_paused" | "none";

export interface RpcPersistedMode {
	mode: string;
	modeData?: Record<string, unknown>;
}

export interface RpcGoalRuntime {
	clearAccounting(): void;
	onThreadResumed(options?: { preserveActiveGoal?: boolean }): Promise<GoalModeState | undefined>;
	createGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalModeState>;
	resumeGoal(): Promise<GoalModeState>;
	pauseGoal(): Promise<GoalModeState | undefined>;
	dropGoal(): Promise<Goal | undefined>;
	buildContinuationPrompt(): string | undefined;
}

export type RpcPlanResolveHandler = (input: unknown) => Promise<AgentToolResult<ResolveToolDetails>>;

export interface RpcNativeModeModelState {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

export interface RpcPlanRoleModel {
	model: Model | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

type PendingPlanApproval = {
	generation: number;
	state: PlanModeState;
	planFilePath: string;
	abortController: AbortController;
};

/**
 * The small host boundary keeps native RPC mode transitions independent from the
 * terminal UI and makes the controller directly unit-testable.
 */
export interface RpcNativeModeHost {
	isStreaming(): boolean;
	isCompacting(): boolean;
	hasPostPromptWork(): boolean;

	isPlanModeEnabled(): boolean;
	isGoalModeEnabled(): boolean;
	getGoalContinuationModes(): readonly string[];

	getActiveToolNames(): string[];
	hasBuiltInTool(name: string): boolean;
	setActiveToolsByName(names: string[]): Promise<void>;

	getPlanModeState(): PlanModeState | undefined;
	setPlanModeState(state: PlanModeState | undefined): void;
	getPlanReferencePath(): string;
	setPlanReferencePath(path: string): void;
	setStandingResolveHandler(handler: RpcPlanResolveHandler | null): void;

	captureModelState(): RpcNativeModeModelState | undefined;
	resolvePlanRoleModel(): RpcPlanRoleModel;
	applyTemporaryModel(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void>;
	setThinkingLevel(thinkingLevel?: ConfiguredThinkingLevel): void;

	getGoalModeState(): GoalModeState | undefined;
	setGoalModeState(state: GoalModeState | undefined): void;
	goalRuntime: RpcGoalRuntime;

	getPersistedMode(): RpcPersistedMode;
	appendModeChange(mode: RpcPersistedNativeMode, data?: Record<string, unknown>): void;

	readPlan(path: string): Promise<string | null>;
	listPlanFiles(): Promise<string[]>;
	confirmPlan(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;

	/** Starts a normal user prompt without making the mode response await its turn. */
	submitPrompt(description: string, options: { expandPromptTemplates: false }): void | Promise<unknown>;
	/** Starts a hidden goal continuation without making the scheduler await its turn. */
	submitGoalContinuation(prompt: string): void | Promise<unknown>;
	/** Optional reporting hook for fire-and-forget prompt failures. */
	reportBackgroundError?(error: unknown): void;
}

export type RpcNativeModeSessionEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "tool_execution_start" }
	| { type: "message_start"; message: { role: string; synthetic?: boolean } }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState };

export function isRpcNativeModeAction(value: unknown): value is RpcNativeModeAction {
	return value === "on" || value === "off" || value === "toggle";
}

/** Converts absent and whitespace-only descriptions to `undefined`. */
export function normalizeRpcNativeModeDescription(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("description must be a string");
	const description = value.trim();
	return description || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return (
		value === "active" ||
		value === "paused" ||
		value === "budget-limited" ||
		value === "complete" ||
		value === "dropped"
	);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Reads only complete, non-terminal persisted goals. Invalid persisted data is stale. */
export function goalFromRpcPersistedModeData(modeData: unknown): Goal | undefined {
	if (!isRecord(modeData) || !isRecord(modeData.goal)) return undefined;
	const value = modeData.goal;
	if (
		typeof value.id !== "string" ||
		!value.id.trim() ||
		typeof value.objective !== "string" ||
		!value.objective.trim() ||
		!isGoalStatus(value.status) ||
		value.status === "complete" ||
		value.status === "dropped" ||
		!isNonNegativeFiniteNumber(value.tokensUsed) ||
		!isNonNegativeFiniteNumber(value.timeUsedSeconds) ||
		!isNonNegativeFiniteNumber(value.createdAt) ||
		!isNonNegativeFiniteNumber(value.updatedAt)
	) {
		return undefined;
	}
	const tokenBudget = value.tokenBudget;
	if (tokenBudget !== undefined) {
		if (
			typeof tokenBudget !== "number" ||
			!Number.isFinite(tokenBudget) ||
			!Number.isInteger(tokenBudget) ||
			tokenBudget <= 0
		) {
			return undefined;
		}
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status,
		...(tokenBudget === undefined ? {} : { tokenBudget }),
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

export function planModeStatus(planFilePath: string | undefined, active: boolean, paused: boolean): RpcPlanModeStatus {
	if (!active && !paused) return { status: "off" };
	return {
		status: active ? "active" : "paused",
		...(planFilePath ? { planFilePath } : {}),
	};
}

export function goalModeStatus(state: GoalModeState | undefined, continuationConfigured: boolean): RpcGoalModeStatus {
	if (!state || state.goal.status === "complete" || state.goal.status === "dropped") {
		return { status: "off", continuationEnabled: false };
	}
	const active = state.enabled === true;
	const goal = state.goal;
	return {
		status: active ? "active" : "paused",
		objective: goal.objective,
		goalId: goal.id,
		...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
		tokensUsed: goal.tokensUsed,
		continuationEnabled: active && goal.status === "active" && continuationConfigured,
	};
}

export interface RpcNativeModeRequest {
	action: RpcNativeModeAction;
	description?: string;
}

export class RpcNativeModeController {
	readonly #host: RpcNativeModeHost;
	#plan: RpcPlanModeStatus = { status: "off" };
	#planPreviousTools: string[] | undefined;
	#planPreviousModelState: RpcNativeModeModelState | undefined;
	#planGeneration = 0;
	#pendingPlanApproval: PendingPlanApproval | undefined;
	#goalPreviousTools: string[] | undefined;
	#goalContinuationTimer: ReturnType<typeof setTimeout> | undefined;
	#goalContinuationTurnInFlight = false;
	#goalSuppressNextContinuation = false;
	#goalTurnHadToolCalls = false;

	constructor(host: RpcNativeModeHost) {
		this.#host = host;
	}

	getMode(): RpcNativeModeState {
		const livePlan = this.#host.getPlanModeState();
		const plan = livePlan?.enabled ? planModeStatus(livePlan.planFilePath, true, false) : { ...this.#plan };
		const goal = goalModeStatus(this.#host.getGoalModeState(), this.#isGoalContinuationConfigured());
		return { plan, goal };
	}

	/** Rehydrates the current session's persisted mode after startup or session navigation. */
	async reconcile(): Promise<RpcNativeModeState> {
		await this.prepareForSessionChange();
		return this.#reconcilePersistedMode();
	}

	/** Rehydrates after AgentSession has already restored the target session state. */
	async reconcileAfterSessionChange(): Promise<RpcNativeModeState> {
		await this.prepareForSessionChange({ restoreTools: false, restoreModel: false });
		return this.#reconcilePersistedMode(true);
	}

	async #reconcilePersistedMode(preserveActiveGoal = false): Promise<RpcNativeModeState> {
		const persisted = this.#host.getPersistedMode();

		if (persisted.mode === "plan" || persisted.mode === "plan_paused") {
			await this.#reconcilePlan(persisted.mode, persisted.modeData);
			return this.getMode();
		}
		if (persisted.mode === "goal" || persisted.mode === "goal_paused") {
			await this.#reconcileGoal(persisted.mode, persisted.modeData, preserveActiveGoal);
			return this.getMode();
		}

		this.#host.goalRuntime.clearAccounting();
		if (persisted.mode !== "none") this.#host.appendModeChange("none");
		return this.getMode();
	}
	/**
	 * Restores transient tools and model state before a session branch/new/switch operation. This
	 * intentionally does not append a mode entry: the outgoing session must retain
	 * its durable mode while the target session is loaded.
	 */
	async prepareForSessionChange(options?: { restoreTools?: boolean; restoreModel?: boolean }): Promise<void> {
		this.#invalidatePlanApprovals();
		this.#cancelGoalContinuation();
		this.#goalContinuationTurnInFlight = false;
		this.#goalSuppressNextContinuation = false;
		this.#goalTurnHadToolCalls = false;
		if (options?.restoreTools !== false) {
			await this.#restorePlanTools();
			await this.#restoreGoalTools();
		} else {
			this.#planPreviousTools = undefined;
			this.#goalPreviousTools = undefined;
		}
		if (options?.restoreModel !== false) {
			await this.#restorePlanModel();
		} else {
			this.#planPreviousModelState = undefined;
		}
		this.#host.setStandingResolveHandler(null);
		this.#host.setPlanModeState(undefined);
		this.#host.setGoalModeState(undefined);
		this.#host.goalRuntime.clearAccounting();
		this.#plan = { status: "off" };
	}

	async setPlanMode(input: RpcNativeModeRequest): Promise<RpcNativeModeResult> {
		this.#assertCanMutate("plan");
		const action = this.#validatedAction(input.action);
		const description = normalizeRpcNativeModeDescription(input.description);
		const current = this.getMode().plan.status;

		if (action === "off") {
			if (current !== "off") await this.#exitPlan({ paused: false });
			return { mode: this.getMode(), agentInvoked: false };
		}
		if (action === "toggle") {
			if (current === "active") {
				await this.#exitPlan({ paused: true });
				return { mode: this.getMode(), agentInvoked: false };
			}
			if (current === "paused") {
				await this.#exitPlan({ paused: false });
				return { mode: this.getMode(), agentInvoked: false };
			}
			this.#requireDescription(description, "A description is required to enable plan mode.");
			await this.#enterPlan();
			this.#submitDescription(description);
			return { mode: this.getMode(), agentInvoked: true };
		}

		if (current === "active") {
			if (description) this.#submitDescription(description);
			return { mode: this.getMode(), agentInvoked: description !== undefined };
		}
		this.#requireDescription(description, "A description is required to enable plan mode.");
		await this.#enterPlan();
		this.#submitDescription(description);
		return { mode: this.getMode(), agentInvoked: true };
	}

	async setGoalMode(input: RpcNativeModeRequest): Promise<RpcNativeModeResult> {
		this.#assertCanMutate("goal");
		const action = this.#validatedAction(input.action);
		const description = normalizeRpcNativeModeDescription(input.description);
		const current = this.getMode().goal.status;

		if (action === "off") {
			if (current !== "off") await this.#dropGoal();
			return { mode: this.getMode(), agentInvoked: false };
		}
		if (action === "toggle") {
			if (current === "active") {
				await this.#pauseGoal();
				return { mode: this.getMode(), agentInvoked: false };
			}
			if (current === "paused") {
				await this.#dropGoal();
				return { mode: this.getMode(), agentInvoked: false };
			}
			this.#requireDescription(description, "An objective is required to enable goal mode.");
			await this.#createGoal(description);
			this.#submitDescription(description);
			return { mode: this.getMode(), agentInvoked: true };
		}

		if (current === "active") {
			if (description) this.#submitDescription(description);
			return { mode: this.getMode(), agentInvoked: description !== undefined };
		}
		if (current === "paused") {
			if (description) {
				throw new Error("A paused goal can only be resumed without a replacement objective.");
			}
			await this.#resumeGoal();
			return { mode: this.getMode(), agentInvoked: false };
		}
		this.#requireDescription(description, "An objective is required to enable goal mode.");
		await this.#createGoal(description);
		this.#submitDescription(description);
		return { mode: this.getMode(), agentInvoked: true };
	}

	/** Receives structural AgentSession events without coupling tests to AgentSession. */
	async handleSessionEvent(event: unknown): Promise<void> {
		if (!isRecord(event) || typeof event.type !== "string") return;
		if (event.type === "agent_start") {
			this.#goalTurnHadToolCalls = false;
			this.#cancelGoalContinuation();
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#goalTurnHadToolCalls = true;
			if (!this.#goalContinuationTurnInFlight) this.#goalSuppressNextContinuation = false;
			return;
		}
		if (event.type === "message_start" && this.#isUserMessageStart(event.message)) {
			this.#goalSuppressNextContinuation = false;
			this.#cancelGoalContinuation();
			return;
		}
		if (event.type === "goal_updated") {
			await this.#handleGoalUpdated(event);
			return;
		}
		if (event.type !== "agent_end") return;

		if (this.#goalContinuationTurnInFlight) {
			this.#goalSuppressNextContinuation = !this.#goalTurnHadToolCalls;
			this.#goalContinuationTurnInFlight = false;
		}
		const state = this.#host.getGoalModeState();
		if (state?.mode === "exiting" || state?.goal.status === "complete") {
			await this.#finishCompletedGoal();
			return;
		}
		this.#scheduleGoalContinuation();
	}

	#validatedAction(action: unknown): RpcNativeModeAction {
		if (isRpcNativeModeAction(action)) return action;
		throw new Error(`Invalid native mode action: ${String(action)}`);
	}

	#assertCanMutate(mode: "plan" | "goal"): void {
		if (this.#host.isStreaming()) {
			throw new Error(`Cannot change ${mode} mode while a response is in progress.`);
		}
	}

	#requireDescription(description: string | undefined, message: string): asserts description is string {
		if (!description) throw new Error(message);
	}

	#planPath(): string {
		const live = this.#host.getPlanModeState()?.planFilePath;
		const plan = this.#plan;
		const remembered = plan.status === "off" ? undefined : plan.planFilePath;
		const reference = this.#host.getPlanReferencePath().trim();
		return live || remembered || reference || DEFAULT_RPC_PLAN_FILE_PATH;
	}

	#assertPlanCanEnter(): void {
		if (!this.#host.isPlanModeEnabled()) {
			throw new Error("Plan mode is disabled by settings.");
		}
		const goalStatus = this.getMode().goal.status;
		if (goalStatus !== "off") {
			throw new Error("Cannot enable plan mode while goal mode is active or paused.");
		}
	}

	#assertGoalCanEnter(): void {
		if (!this.#host.isGoalModeEnabled()) {
			throw new Error("Goal mode is disabled by settings.");
		}
		const planStatus = this.getMode().plan.status;
		if (planStatus !== "off") {
			throw new Error("Cannot enable goal mode while plan mode is active or paused.");
		}
	}

	async #enterPlan(options?: { planFilePath?: string; reentry?: boolean; persist?: boolean }): Promise<void> {
		this.#assertPlanCanEnter();
		this.#cancelGoalContinuation();
		const previousTools = this.#host.getActiveToolNames();
		const planTools = [...previousTools, "resolve"];
		if (this.#host.hasBuiltInTool("write")) planTools.push("write");
		const planFilePath = options?.planFilePath ?? this.#planPath();
		await this.#host.setActiveToolsByName([...new Set(planTools)]);
		this.#planPreviousTools = previousTools;
		this.#plan = planModeStatus(planFilePath, true, false);
		this.#host.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: "parallel",
			reentry: options?.reentry === true,
		});
		try {
			await this.#applyPlanModel();
		} catch (error) {
			await this.#rollbackPlanEntry(error);
		}
		this.#host.setStandingResolveHandler(input => this.#runPlanApprovalResolve(input));
		if (options?.persist !== false) this.#host.appendModeChange("plan", { planFilePath });
	}

	async #rollbackPlanEntry(error: unknown): Promise<never> {
		const rollbackFailures: unknown[] = [];
		try {
			await this.#restorePlanTools();
		} catch (rollbackError) {
			rollbackFailures.push(rollbackError);
		}
		try {
			await this.#restorePlanModel();
		} catch (rollbackError) {
			rollbackFailures.push(rollbackError);
		}
		this.#planPreviousTools = undefined;
		this.#planPreviousModelState = undefined;
		this.#host.setStandingResolveHandler(null);
		this.#host.setPlanModeState(undefined);
		this.#plan = { status: "off" };
		if (rollbackFailures.length > 0) {
			throw new AggregateError(
				[error, ...rollbackFailures],
				"Failed to activate the plan model and restore the prior session state.",
			);
		}
		throw error;
	}

	async #exitPlan(options: { paused: boolean }): Promise<void> {
		this.#invalidatePlanApprovals();
		const current = this.getMode().plan;
		if (current.status === "off") return;
		const planFilePath = current.planFilePath ?? this.#planPath();
		await this.#restorePlanTools();
		await this.#restorePlanModel();
		this.#host.setStandingResolveHandler(null);
		this.#host.setPlanModeState(undefined);
		if (options.paused) {
			this.#plan = planModeStatus(planFilePath, false, true);
			this.#host.appendModeChange("plan_paused", { planFilePath });
			return;
		}
		this.#plan = { status: "off" };
		this.#host.appendModeChange("none");
	}

	async #restorePlanTools(): Promise<void> {
		const previousTools = this.#planPreviousTools;
		this.#planPreviousTools = undefined;
		if (previousTools !== undefined) await this.#host.setActiveToolsByName(previousTools);
	}

	async #applyPlanModel(): Promise<void> {
		const planRole = this.#host.resolvePlanRoleModel();
		if (!planRole.model) return;

		const previous = this.#host.captureModelState();
		this.#planPreviousModelState = previous;
		const planThinkingLevel = planRole.explicitThinkingLevel ? planRole.thinkingLevel : undefined;
		if (!previous || !modelsAreEqual(previous.model, planRole.model)) {
			await this.#host.applyTemporaryModel(planRole.model, planThinkingLevel);
			return;
		}
		if (planRole.explicitThinkingLevel) this.#host.setThinkingLevel(planThinkingLevel);
	}

	async #restorePlanModel(): Promise<void> {
		const previous = this.#planPreviousModelState;
		if (!previous) return;

		const current = this.#host.captureModelState();
		if (current && modelsAreEqual(current.model, previous.model)) {
			this.#host.setThinkingLevel(previous.thinkingLevel);
		} else {
			await this.#host.applyTemporaryModel(previous.model, previous.thinkingLevel);
		}
		this.#planPreviousModelState = undefined;
	}

	#invalidatePlanApprovals(): void {
		this.#planGeneration += 1;
		this.#cancelPendingPlanApproval();
	}

	#cancelPendingPlanApproval(): void {
		const pending = this.#pendingPlanApproval;
		this.#pendingPlanApproval = undefined;
		pending?.abortController.abort();
	}

	#isSameActivePlan(generation: number, state: PlanModeState, planFilePath: string): boolean {
		const activeState = this.#host.getPlanModeState();
		if (!activeState?.enabled) return false;
		return this.#planGeneration === generation && activeState === state && activeState.planFilePath === planFilePath;
	}

	#beginPlanApproval(generation: number, state: PlanModeState, planFilePath: string): PendingPlanApproval | undefined {
		if (!this.#isSameActivePlan(generation, state, planFilePath)) return undefined;
		this.#cancelPendingPlanApproval();
		const pending: PendingPlanApproval = {
			generation,
			state,
			planFilePath,
			abortController: new AbortController(),
		};
		this.#pendingPlanApproval = pending;
		return pending;
	}

	#isCurrentPlanApproval(pending: PendingPlanApproval): boolean {
		return (
			this.#pendingPlanApproval === pending &&
			!pending.abortController.signal.aborted &&
			this.#isSameActivePlan(pending.generation, pending.state, pending.planFilePath)
		);
	}

	#finishPlanApproval(pending: PendingPlanApproval): void {
		if (this.#pendingPlanApproval === pending) this.#pendingPlanApproval = undefined;
	}

	#cancelledPlanApprovalResult(details: PlanApprovalDetails): AgentToolResult<PlanApprovalDetails> {
		return {
			content: [{ type: "text" as const, text: "Plan approval was cancelled." }],
			details,
		};
	}

	#runPlanApprovalResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetails>> {
		return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
			sourceToolName: "plan_approval",
			label: "Plan ready for approval",
			apply: async (_reason, extra) => {
				const state = this.#host.getPlanModeState();
				if (!state?.enabled) throw new ToolError("Plan mode is not active.");
				const generation = this.#planGeneration;
				const activePlanFilePath = state.planFilePath;
				const { planFilePath, planContent, title } = await resolveApprovedPlan({
					suppliedTitle: extra?.title,
					statePlanFilePath: activePlanFilePath,
					readPlan: path => this.#host.readPlan(path),
					listPlanFiles: () => this.#host.listPlanFiles(),
				});
				const details: PlanApprovalDetails = { planFilePath, title, planExists: true };
				const approval = this.#beginPlanApproval(generation, state, activePlanFilePath);
				if (!approval) return this.#cancelledPlanApprovalResult(details);

				try {
					const approved = await this.#host.confirmPlan(
						`Approve plan: ${title}`,
						`Approve and execute the plan at ${planFilePath}?\n\n${planContent}`,
						{ signal: approval.abortController.signal },
					);
					if (!this.#isCurrentPlanApproval(approval)) return this.#cancelledPlanApprovalResult(details);
					if (!approved) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Plan refinement requested. Update the plan file, then request approval again when ready.",
								},
							],
							details,
						};
					}
					this.#host.setPlanReferencePath(planFilePath);
					await this.#exitPlan({ paused: false });
					return {
						content: [
							{
								type: "text" as const,
								text: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
							},
						],
						details,
					};
				} finally {
					this.#finishPlanApproval(approval);
				}
			},
		});
	}

	async #createGoal(objective: string): Promise<void> {
		this.#assertGoalCanEnter();
		const previousTools = this.#host.getActiveToolNames();
		await this.#host.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
		try {
			await this.#host.goalRuntime.createGoal({ objective });
			this.#goalPreviousTools = previousTools;
		} catch (error) {
			await this.#host.setActiveToolsByName(previousTools);
			throw error;
		}
	}

	async #resumeGoal(): Promise<void> {
		this.#assertGoalCanEnter();
		const previousTools = this.#host.getActiveToolNames();
		await this.#host.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
		try {
			await this.#host.goalRuntime.resumeGoal();
			this.#goalPreviousTools = previousTools;
			this.#goalSuppressNextContinuation = false;
		} catch (error) {
			await this.#host.setActiveToolsByName(previousTools);
			throw error;
		}
	}

	async #pauseGoal(): Promise<void> {
		this.#cancelGoalContinuation();
		await this.#host.goalRuntime.pauseGoal();
		await this.#restoreGoalTools();
	}

	async #dropGoal(): Promise<void> {
		this.#cancelGoalContinuation();
		await this.#host.goalRuntime.dropGoal();
		await this.#restoreGoalTools();
		this.#goalContinuationTurnInFlight = false;
		this.#goalSuppressNextContinuation = false;
	}

	async #restoreGoalTools(): Promise<void> {
		const previousTools = this.#goalPreviousTools;
		this.#goalPreviousTools = undefined;
		if (previousTools !== undefined) await this.#host.setActiveToolsByName(previousTools);
	}

	async #handleGoalUpdated(event: Record<string, unknown>): Promise<void> {
		const state = event.state as GoalModeState | undefined;
		if (state?.goal?.status === "dropped") {
			this.#cancelGoalContinuation();
			await this.#restoreGoalTools();
			this.#goalContinuationTurnInFlight = false;
			this.#goalSuppressNextContinuation = false;
			return;
		}
		if (!state?.enabled) {
			this.#cancelGoalContinuation();
			await this.#restoreGoalTools();
		}
	}

	async #finishCompletedGoal(): Promise<void> {
		this.#cancelGoalContinuation();
		await this.#restoreGoalTools();
		this.#host.setGoalModeState(undefined);
		this.#host.appendModeChange("none");
		this.#goalContinuationTurnInFlight = false;
		this.#goalSuppressNextContinuation = false;
	}

	#isGoalContinuationConfigured(): boolean {
		return this.#host.getGoalContinuationModes().includes("rpc");
	}

	#scheduleGoalContinuation(): void {
		this.#cancelGoalContinuation();
		if (!this.#isGoalContinuationConfigured() || this.#goalSuppressNextContinuation) return;
		if (this.getMode().plan.status !== "off") return;
		const state = this.#host.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.#host.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.#goalContinuationTimer = setTimeout(() => {
			this.#goalContinuationTimer = undefined;
			if (!this.#isGoalContinuationConfigured() || this.#goalSuppressNextContinuation) return;
			if (this.#host.isStreaming() || this.#host.isCompacting() || this.#host.hasPostPromptWork()) return;
			if (this.getMode().plan.status !== "off") return;
			const latest = this.#host.getGoalModeState();
			if (!latest?.enabled || latest.goal.status !== "active") return;
			this.#goalContinuationTurnInFlight = true;
			this.#runBackground(
				() => this.#host.submitGoalContinuation(prompt),
				() => {
					this.#goalContinuationTurnInFlight = false;
				},
			);
		}, RPC_GOAL_CONTINUATION_DELAY_MS);
	}

	#cancelGoalContinuation(): void {
		if (this.#goalContinuationTimer !== undefined) {
			clearTimeout(this.#goalContinuationTimer);
			this.#goalContinuationTimer = undefined;
		}
	}

	#isUserMessageStart(value: unknown): boolean {
		return isRecord(value) && value.role === "user" && value.synthetic !== true;
	}

	#submitDescription(description: string): void {
		this.#runBackground(() => this.#host.submitPrompt(description, { expandPromptTemplates: false }));
	}

	#runBackground(start: () => void | Promise<unknown>, onError?: () => void): void {
		try {
			void Promise.resolve(start()).catch(error => {
				onError?.();
				this.#host.reportBackgroundError?.(error);
			});
		} catch (error) {
			onError?.();
			this.#host.reportBackgroundError?.(error);
		}
	}

	async #reconcilePlan(mode: "plan" | "plan_paused", modeData: Record<string, unknown> | undefined): Promise<void> {
		this.#host.goalRuntime.clearAccounting();
		if (!this.#host.isPlanModeEnabled()) {
			this.#host.appendModeChange("none");
			return;
		}
		const planFilePath =
			typeof modeData?.planFilePath === "string" && modeData.planFilePath.trim()
				? modeData.planFilePath.trim()
				: this.#planPath();
		if (mode === "plan_paused") {
			this.#plan = planModeStatus(planFilePath, false, true);
			return;
		}
		await this.#enterPlan({ planFilePath, reentry: true, persist: false });
	}

	async #reconcileGoal(
		mode: "goal" | "goal_paused",
		modeData: Record<string, unknown> | undefined,
		preserveActiveGoal: boolean,
	): Promise<void> {
		if (!this.#host.isGoalModeEnabled()) {
			this.#host.goalRuntime.clearAccounting();
			this.#host.appendModeChange("none");
			return;
		}
		const goal = goalFromRpcPersistedModeData(modeData);
		if (!goal) {
			this.#host.goalRuntime.clearAccounting();
			this.#host.appendModeChange("none");
			return;
		}
		const restoredGoal =
			mode === "goal_paused" && goal.status !== "paused" ? { ...goal, status: "paused" as const } : goal;
		this.#host.setGoalModeState({
			enabled: mode === "goal",
			mode: "active",
			goal: restoredGoal,
		});
		const restored = await this.#host.goalRuntime.onThreadResumed(
			preserveActiveGoal ? { preserveActiveGoal: true } : undefined,
		);
		if (!restored || restored.goal.status === "complete" || restored.goal.status === "dropped") {
			this.#host.setGoalModeState(undefined);
			this.#host.goalRuntime.clearAccounting();
			this.#host.appendModeChange("none");
			return;
		}
		if (!restored.enabled) return;
		const previousTools = this.#host.getActiveToolNames();
		await this.#host.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
		this.#goalPreviousTools = previousTools;
	}
}
