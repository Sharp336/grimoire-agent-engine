import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { Goal, GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	DEFAULT_RPC_PLAN_FILE_PATH,
	RPC_GOAL_CONTINUATION_DELAY_MS,
	type RpcGoalRuntime,
	RpcNativeModeController,
	type RpcNativeModeHost,
	type RpcPersistedMode,
	type RpcPersistedNativeMode,
	type RpcPlanResolveHandler,
	type RpcPlanRoleModel,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-native-mode-controller";
import {
	RPC_NATIVE_MODE_PROTOCOL,
	type RpcNativeModeState,
	type RpcReadyFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";

interface ModelState {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

interface NativeModeHostOptions {
	planModeEnabled?: boolean;
	goalModeEnabled?: boolean;
	continuationModes?: readonly string[];
	activeTools?: string[];
	builtInTools?: string[];
	modelState?: ModelState;
	planRoleModel?: RpcPlanRoleModel;
	persisted?: RpcPersistedMode;
}

interface GoalTransitionHost {
	getGoalModeState(): GoalModeState | undefined;
	setGoalModeState(state: GoalModeState | undefined): void;
	appendModeChange(mode: RpcPersistedNativeMode, data?: Record<string, unknown>): void;
}

/** A deterministic implementation of the controller's production GoalRuntime boundary. */
class TransitionGoalRuntime implements RpcGoalRuntime {
	#nextGoalId = 1;
	readonly calls: string[] = [];
	readonly #host: GoalTransitionHost;

	constructor(host: GoalTransitionHost) {
		this.#host = host;
	}

	clearAccounting(): void {
		this.calls.push("clearAccounting");
	}

	async onThreadResumed(options?: { preserveActiveGoal?: boolean }): Promise<GoalModeState | undefined> {
		this.calls.push("threadResumed");
		const state = this.#host.getGoalModeState();
		if (!state || (options?.preserveActiveGoal && state.enabled && state.goal.status === "active")) return state;
		if (state.goal.status !== "active") return state;
		return await this.pauseGoal();
	}

	async createGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalModeState> {
		this.calls.push("create");
		const existing = this.#host.getGoalModeState();
		if (existing?.goal && existing.goal.status !== "complete" && existing.goal.status !== "dropped") {
			throw new Error("cannot create a new goal because this session already has a goal");
		}
		const id = this.#nextGoalId++;
		const state: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: {
				id: `goal-${id}`,
				objective: input.objective,
				status: "active",
				...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: id,
				updatedAt: id,
			},
		};
		this.#host.setGoalModeState(state);
		this.#host.appendModeChange("goal", { goal: { ...state.goal } });
		return state;
	}

	async resumeGoal(): Promise<GoalModeState> {
		this.calls.push("resume");
		const state = this.#host.getGoalModeState();
		if (!state) throw new Error("No paused goal.");
		const resumed: GoalModeState = {
			...state,
			enabled: true,
			mode: "active",
			reason: undefined,
			goal: { ...state.goal, status: "active", updatedAt: state.goal.updatedAt + 1 },
		};
		this.#host.setGoalModeState(resumed);
		this.#host.appendModeChange("goal", { goal: { ...resumed.goal } });
		return resumed;
	}

	async pauseGoal(): Promise<GoalModeState | undefined> {
		this.calls.push("pause");
		const state = this.#host.getGoalModeState();
		if (!state) return undefined;
		const status =
			state.goal.status === "active" || state.goal.status === "budget-limited" ? "paused" : state.goal.status;
		const paused: GoalModeState = {
			...state,
			enabled: false,
			mode: "active",
			reason: undefined,
			goal: { ...state.goal, status, updatedAt: state.goal.updatedAt + 1 },
		};
		this.#host.setGoalModeState(paused);
		this.#host.appendModeChange("goal_paused", { goal: { ...paused.goal } });
		return paused;
	}

	async dropGoal(): Promise<Goal | undefined> {
		this.calls.push("drop");
		const state = this.#host.getGoalModeState();
		if (!state) return undefined;
		const dropped: Goal = { ...state.goal, status: "dropped", updatedAt: state.goal.updatedAt + 1 };
		this.#host.setGoalModeState(undefined);
		this.#host.appendModeChange("none");
		return dropped;
	}

	buildContinuationPrompt(): string | undefined {
		const state = this.#host.getGoalModeState();
		return state?.enabled && state.goal.status === "active" ? `Continue goal: ${state.goal.objective}` : undefined;
	}
}

class NativeModeHost implements RpcNativeModeHost {
	streaming = false;
	compacting = false;
	postPromptWork = false;
	planModeEnabled: boolean;
	goalModeEnabled: boolean;
	continuationModes: readonly string[];
	activeTools: string[];
	readonly builtInTools: Set<string>;
	planState: PlanModeState | undefined;
	planReferencePath = "";
	goalState: GoalModeState | undefined;
	persisted: RpcPersistedMode;
	resolveHandler: RpcPlanResolveHandler | null = null;
	modelState: ModelState | undefined;
	temporaryModelFailure: Error | undefined;
	planRoleModel: RpcPlanRoleModel;
	readonly planFiles = new Map<string, string>();
	readonly confirmations: boolean[] = [];
	readonly confirmCalls: Array<{ title: string; message: string }> = [];
	readonly prompts: string[] = [];
	readonly promptOptions: Array<{ expandPromptTemplates: false } | undefined> = [];
	confirmationResult: Promise<boolean> | undefined;
	readonly confirmationSignals: AbortSignal[] = [];
	readonly cancelledConfirmations: AbortSignal[] = [];
	readonly promptSnapshots: Array<{ planActive: boolean; goalActive: boolean }> = [];
	readonly continuations: string[] = [];
	readonly backgroundErrors: unknown[] = [];
	readonly modeChanges: Array<{ mode: RpcPersistedNativeMode; data?: Record<string, unknown> }> = [];
	readonly activeToolSnapshots: string[][] = [];
	promptResult: void | Promise<unknown> = undefined;
	readonly goalRuntime: TransitionGoalRuntime;

	constructor(options: NativeModeHostOptions = {}) {
		this.planModeEnabled = options.planModeEnabled ?? true;
		this.goalModeEnabled = options.goalModeEnabled ?? true;
		this.continuationModes = options.continuationModes ?? [];
		this.activeTools = [...(options.activeTools ?? ["read"])];
		this.builtInTools = new Set(options.builtInTools ?? ["write", "resolve", "goal"]);
		this.persisted = options.persisted ?? { mode: "none" };
		this.modelState = options.modelState ? { ...options.modelState } : undefined;
		this.planRoleModel = options.planRoleModel ?? { model: undefined, explicitThinkingLevel: false };
		this.goalRuntime = new TransitionGoalRuntime(this);
	}

	isStreaming(): boolean {
		return this.streaming;
	}

	isCompacting(): boolean {
		return this.compacting;
	}

	hasPostPromptWork(): boolean {
		return this.postPromptWork;
	}

	isPlanModeEnabled(): boolean {
		return this.planModeEnabled;
	}

	isGoalModeEnabled(): boolean {
		return this.goalModeEnabled;
	}

	getGoalContinuationModes(): readonly string[] {
		return this.continuationModes;
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	hasBuiltInTool(name: string): boolean {
		return this.builtInTools.has(name);
	}

	async setActiveToolsByName(names: string[]): Promise<void> {
		this.activeTools = [...names];
		this.activeToolSnapshots.push([...names]);
	}

	captureModelState(): ModelState | undefined {
		return this.modelState ? { ...this.modelState } : undefined;
	}

	resolvePlanRoleModel(): RpcPlanRoleModel {
		return { ...this.planRoleModel };
	}

	async applyTemporaryModel(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void> {
		const failure = this.temporaryModelFailure;
		this.temporaryModelFailure = undefined;
		this.modelState = { model, thinkingLevel };
		if (failure) throw failure;
	}

	setThinkingLevel(thinkingLevel?: ConfiguredThinkingLevel): void {
		if (!this.modelState) return;
		this.modelState = { ...this.modelState, thinkingLevel };
	}

	getPlanModeState(): PlanModeState | undefined {
		return this.planState;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.planState = state ? { ...state } : undefined;
	}

	getPlanReferencePath(): string {
		return this.planReferencePath;
	}

	setPlanReferencePath(path: string): void {
		this.planReferencePath = path;
	}

	setStandingResolveHandler(handler: RpcPlanResolveHandler | null): void {
		this.resolveHandler = handler;
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.goalState;
	}

	setGoalModeState(state: GoalModeState | undefined): void {
		this.goalState = state;
	}

	getPersistedMode(): RpcPersistedMode {
		return this.persisted;
	}

	appendModeChange(mode: RpcPersistedNativeMode, data?: Record<string, unknown>): void {
		const entry = data ? { mode, data: { ...data } } : { mode };
		this.modeChanges.push(entry);
		this.persisted = { mode, ...(data ? { modeData: { ...data } } : {}) };
	}

	async readPlan(path: string): Promise<string | null> {
		return this.planFiles.get(path) ?? null;
	}

	async listPlanFiles(): Promise<string[]> {
		return [...this.planFiles.keys()];
	}

	async confirmPlan(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean> {
		this.confirmCalls.push({ title, message });
		const signal = options?.signal;
		if (signal) {
			this.confirmationSignals.push(signal);
			if (signal.aborted) this.cancelledConfirmations.push(signal);
			else signal.addEventListener("abort", () => this.cancelledConfirmations.push(signal), { once: true });
		}
		return this.confirmationResult ?? this.confirmations.shift() ?? false;
	}

	submitPrompt(description: string, options?: { expandPromptTemplates: false }): void | Promise<unknown> {
		this.prompts.push(description);
		this.promptOptions.push(options);
		this.promptSnapshots.push({
			planActive: this.planState?.enabled === true,
			goalActive: this.goalState?.enabled === true,
		});
		return this.promptResult;
	}

	submitGoalContinuation(prompt: string): void | Promise<unknown> {
		this.continuations.push(prompt);
	}

	reportBackgroundError(error: unknown): void {
		this.backgroundErrors.push(error);
	}
}

function createHarness(options?: NativeModeHostOptions): {
	host: NativeModeHost;
	controller: RpcNativeModeController;
} {
	const host = new NativeModeHost(options);
	return { host, controller: new RpcNativeModeController(host) };
}

function persistedGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship the release",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

async function scheduleActiveGoalContinuation(controller: RpcNativeModeController): Promise<void> {
	await controller.handleSessionEvent({ type: "agent_end" });
}

const executionModel = { provider: "test", id: "execution" } as Model;
const planModel = { provider: "test", id: "plan" } as Model;
const executionThinking = "low" as ConfiguredThinkingLevel;
const planThinking = "high" as ConfiguredThinkingLevel;

function createPlanRoleHarness(): { host: NativeModeHost; controller: RpcNativeModeController } {
	return createHarness({
		modelState: { model: executionModel, thinkingLevel: executionThinking },
		planRoleModel: { model: planModel, thinkingLevel: planThinking, explicitThinkingLevel: true },
	});
}

function expectModelState(host: NativeModeHost, state: ModelState): void {
	expect(host.modelState?.model).toBe(state.model);
	expect(host.modelState?.thinkingLevel).toBe(state.thinkingLevel);
}
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
});

describe("RPC native mode controller", () => {
	it("advertises the exact v2 native mode capability in ready frames", () => {
		const ready: RpcReadyFrame = { type: "ready", protocol: RPC_NATIVE_MODE_PROTOCOL };

		expect(ready).toEqual({
			type: "ready",
			protocol: { version: 2, capabilities: { nativeModeControl: 1 } },
		});
	});

	it("reports an honest discriminated off-mode state before any transition", () => {
		const { controller } = createHarness({ continuationModes: ["rpc"] });
		const mode: RpcNativeModeState = controller.getMode();

		expect(mode).toEqual({
			plan: { status: "off" },
			goal: { status: "off", continuationEnabled: false },
		});
	});

	it("rejects native mutations when their settings are disabled", async () => {
		const { host, controller } = createHarness();
		host.planModeEnabled = false;

		await expect(controller.setPlanMode({ action: "on", description: "Draft a plan" })).rejects.toThrow(
			"Plan mode is disabled by settings.",
		);

		host.goalModeEnabled = false;
		await expect(controller.setGoalMode({ action: "on", description: "Ship a release" })).rejects.toThrow(
			"Goal mode is disabled by settings.",
		);
		expect(host.activeTools).toEqual(["read"]);
		expect(host.prompts).toEqual([]);
	});

	it("requires a real description to activate an inactive native mode", async () => {
		const { controller } = createHarness();

		await expect(controller.setPlanMode({ action: "on", description: " \t " })).rejects.toThrow(
			"A description is required to enable plan mode.",
		);
		await expect(controller.setGoalMode({ action: "toggle" })).rejects.toThrow(
			"An objective is required to enable goal mode.",
		);
	});

	it("changes plan mode before submitting a trimmed normal prompt without waiting for its turn", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const { host, controller } = createHarness();
		host.promptResult = promise;

		const result = await controller.setPlanMode({ action: "on", description: "  Design the rollout  " });

		expect(result).toMatchObject({
			agentInvoked: true,
			mode: { plan: { status: "active", planFilePath: DEFAULT_RPC_PLAN_FILE_PATH } },
		});
		expect(host.prompts).toEqual(["Design the rollout"]);
		expect(host.promptSnapshots).toEqual([{ planActive: true, goalActive: false }]);
		expect(host.prompts[0]).not.toMatch(/^\//);
		resolve();
	});

	it("augments and restores tools across plan on, toggle pause, toggle off, and explicit off", async () => {
		const { host, controller } = createHarness({ activeTools: ["read", "todo"] });

		await controller.setPlanMode({ action: "on", description: "Draft the migration plan" });
		expect(controller.getMode().plan).toEqual({ status: "active", planFilePath: DEFAULT_RPC_PLAN_FILE_PATH });
		expect(host.activeTools).toEqual(["read", "todo", "resolve", "write"]);

		await controller.setPlanMode({ action: "toggle" });
		expect(controller.getMode().plan).toEqual({ status: "paused", planFilePath: DEFAULT_RPC_PLAN_FILE_PATH });
		expect(host.activeTools).toEqual(["read", "todo"]);
		expect(host.modeChanges.at(-1)).toEqual({
			mode: "plan_paused",
			data: { planFilePath: DEFAULT_RPC_PLAN_FILE_PATH },
		});

		await expect(controller.setPlanMode({ action: "on" })).rejects.toThrow(
			"A description is required to enable plan mode.",
		);

		await controller.setPlanMode({ action: "toggle" });
		expect(controller.getMode().plan).toEqual({ status: "off" });
		expect(host.modeChanges.at(-1)).toEqual({ mode: "none" });

		await controller.setPlanMode({ action: "on", description: "Draft the recovery plan" });
		expect(host.activeTools).toEqual(["read", "todo", "resolve", "write"]);
		await controller.setPlanMode({ action: "off" });
		expect(controller.getMode().plan).toEqual({ status: "off" });
		expect(host.activeTools).toEqual(["read", "todo"]);
		expect(host.modeChanges.map(change => change.mode)).toEqual(["plan", "plan_paused", "none", "plan", "none"]);
	});

	it("keeps plan and goal modes mutually exclusive", async () => {
		const { controller } = createHarness();

		await controller.setPlanMode({ action: "on", description: "Plan the release" });
		await expect(controller.setGoalMode({ action: "on", description: "Ship the release" })).rejects.toThrow(
			"Cannot enable goal mode while plan mode is active or paused.",
		);

		await controller.setPlanMode({ action: "off" });
		await controller.setGoalMode({ action: "on", description: "Ship the release" });
		await expect(controller.setPlanMode({ action: "on", description: "Plan the release" })).rejects.toThrow(
			"Cannot enable plan mode while goal mode is active or paused.",
		);
	});

	it("rehydrates paused modes and persists their explicit off transitions", async () => {
		const pausedPlan = createHarness({
			persisted: { mode: "plan_paused", modeData: { planFilePath: "local://paused-plan.md" } },
		});

		await pausedPlan.controller.reconcile();
		expect(pausedPlan.controller.getMode().plan).toEqual({
			status: "paused",
			planFilePath: "local://paused-plan.md",
		});
		expect(pausedPlan.host.activeTools).toEqual(["read"]);
		await pausedPlan.controller.setPlanMode({ action: "off" });
		expect(pausedPlan.controller.getMode().plan).toEqual({ status: "off" });
		expect(pausedPlan.host.modeChanges.at(-1)).toEqual({ mode: "none" });

		const pausedGoal = createHarness({
			persisted: { mode: "goal", modeData: { goal: persistedGoal() } },
		});
		await pausedGoal.controller.reconcile();
		expect(pausedGoal.controller.getMode().goal).toMatchObject({
			status: "paused",
			objective: "Ship the release",
			continuationEnabled: false,
		});
		expect(pausedGoal.host.modeChanges.at(-1)?.mode).toBe("goal_paused");

		const resumed = await pausedGoal.controller.setGoalMode({ action: "on" });
		expect(resumed.agentInvoked).toBe(false);
		expect(resumed.mode.goal).toMatchObject({ status: "active", objective: "Ship the release" });
		expect(pausedGoal.host.activeTools).toEqual(["read", "goal"]);
	});

	it("preserves an active persisted goal through reconcileAfterSessionChange without overwriting it as paused", async () => {
		vi.useFakeTimers();
		const goal = persistedGoal();
		const { host, controller } = createHarness({
			continuationModes: ["rpc"],
			persisted: { mode: "goal", modeData: { goal } },
		});

		const mode = await controller.reconcileAfterSessionChange();

		expect(mode.goal).toMatchObject({
			status: "active",
			objective: "Ship the release",
			continuationEnabled: true,
		});
		expect(host.goalState).toMatchObject({ enabled: true, goal: { status: "active" } });
		expect(host.activeTools).toEqual(["read", "goal"]);
		expect(host.modeChanges).toEqual([]);
		expect(host.persisted).toEqual({ mode: "goal", modeData: { goal } });

		await scheduleActiveGoalContinuation(controller);
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS);
		await flushMicrotasks();
		expect(host.continuations).toEqual(["Continue goal: Ship the release"]);
	});

	it("keeps a real plan active on denial or timeout and exits only after affirmative approval", async () => {
		const { host, controller } = createHarness();
		await controller.setPlanMode({ action: "on", description: "Draft the migration" });
		const handler = host.resolveHandler;
		if (!handler) throw new Error("Expected plan mode to install a standing resolve handler");

		await expect(handler({ action: "apply", reason: "Plan is ready", extra: { title: "my-plan" } })).rejects.toThrow(
			"Plan file not found",
		);

		host.planFiles.set("local://my-plan.md", "# Migration\n\n1. Migrate safely.\n");
		host.confirmations.push(false, false, true);
		const denied = await handler({ action: "apply", reason: "Plan is ready", extra: { title: "my-plan" } });
		expect(denied.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Plan refinement requested"),
		});
		expect(controller.getMode().plan).toMatchObject({ status: "active" });
		expect(host.resolveHandler).toBe(handler);
		expect(host.activeTools).toEqual(["read", "resolve", "write"]);

		const timedOut = await handler({ action: "apply", reason: "Plan is ready", extra: { title: "my-plan" } });
		expect(timedOut.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Plan refinement requested"),
		});
		expect(controller.getMode().plan).toMatchObject({ status: "active" });

		const approved = await handler({ action: "apply", reason: "Plan is ready", extra: { title: "my-plan" } });
		expect(approved.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Plan approved") });
		expect(host.confirmCalls).toHaveLength(3);
		expect(host.confirmCalls[0]).toMatchObject({
			title: "Approve plan: my-plan",
			message: expect.stringContaining("local://my-plan.md"),
		});
		expect(host.planReferencePath).toBe("local://my-plan.md");
		expect(controller.getMode().plan).toEqual({ status: "off" });
		expect(host.resolveHandler).toBeNull();
		expect(host.activeTools).toEqual(["read"]);
		expect(host.modeChanges.at(-1)).toEqual({ mode: "none" });
	});

	it("cancels a pending approval when a new session generation replaces its plan", async () => {
		const pendingConfirmation = Promise.withResolvers<boolean>();
		const { host, controller } = createHarness();
		host.confirmationResult = pendingConfirmation.promise;

		await controller.setPlanMode({ action: "on", description: "Draft the outgoing plan" });
		host.planFiles.set(DEFAULT_RPC_PLAN_FILE_PATH, "# Outgoing plan\n");
		const staleHandler = host.resolveHandler;
		if (!staleHandler) throw new Error("Expected an outgoing plan approval handler");
		const staleApproval = staleHandler({
			action: "apply",
			reason: "Plan is ready",
			extra: { title: "PLAN" },
		});
		await flushMicrotasks();
		expect(host.confirmationSignals).toHaveLength(1);

		await controller.prepareForSessionChange();
		host.planReferencePath = "local://new-session-plan.md";
		await controller.setPlanMode({ action: "on", description: "Draft the incoming plan" });
		const newSessionHandler = host.resolveHandler;
		if (!newSessionHandler) throw new Error("Expected an incoming plan approval handler");
		expect(host.confirmationSignals[0]?.aborted).toBe(true);

		pendingConfirmation.resolve(true);
		await staleApproval.catch(() => undefined);

		expect(host.cancelledConfirmations).toEqual([host.confirmationSignals[0]]);
		expect(host.planReferencePath).toBe("local://new-session-plan.md");
		expect(controller.getMode().plan).toEqual({ status: "active", planFilePath: "local://new-session-plan.md" });
		expect(host.resolveHandler).toBe(newSessionHandler);
	});

	it("submits a slash-prefixed plan description as literal prompt content", async () => {
		const { host, controller } = createHarness();

		await controller.setPlanMode({ action: "on", description: "/drop keep this plan request literal" });

		expect(host.prompts).toEqual(["/drop keep this plan request literal"]);
		expect(host.promptOptions).toEqual([{ expandPromptTemplates: false }]);
	});

	it("applies the configured plan model and explicit thinking on entry", async () => {
		const { host, controller } = createPlanRoleHarness();

		await controller.setPlanMode({ action: "on", description: "Draft the model-aware plan" });

		expectModelState(host, { model: planModel, thinkingLevel: planThinking });
	});

	it("rolls back a rejected plan-role model activation so a retry can enter cleanly", async () => {
		const { host, controller } = createPlanRoleHarness();
		host.temporaryModelFailure = new Error("plan model is unavailable");

		await expect(controller.setPlanMode({ action: "on", description: "Draft the failed plan" })).rejects.toThrow(
			"plan model is unavailable",
		);

		expect(controller.getMode().plan).toEqual({ status: "off" });
		expect(host.getPlanModeState()).toBeUndefined();
		expect(host.activeTools).toEqual(["read"]);
		expectModelState(host, { model: executionModel, thinkingLevel: executionThinking });
		expect(host.resolveHandler).toBeNull();
		expect(host.modeChanges).toEqual([]);

		const retry = await controller.setPlanMode({ action: "on", description: "Draft the recovered plan" });
		expect(retry).toMatchObject({
			agentInvoked: true,
			mode: { plan: { status: "active", planFilePath: DEFAULT_RPC_PLAN_FILE_PATH } },
		});
		expect(host.getPlanModeState()).toMatchObject({ enabled: true, planFilePath: DEFAULT_RPC_PLAN_FILE_PATH });
		expect(host.activeTools).toEqual(["read", "resolve", "write"]);
		expectModelState(host, { model: planModel, thinkingLevel: planThinking });
		expect(host.resolveHandler).not.toBeNull();
	});

	it("restores the exact pre-plan model and thinking when plan mode pauses", async () => {
		const { host, controller } = createPlanRoleHarness();
		await controller.setPlanMode({ action: "on", description: "Draft the paused plan" });
		expectModelState(host, { model: planModel, thinkingLevel: planThinking });

		await controller.setPlanMode({ action: "toggle" });

		expectModelState(host, { model: executionModel, thinkingLevel: executionThinking });
	});

	it("restores the exact pre-plan model and thinking when plan mode is turned off", async () => {
		const { host, controller } = createPlanRoleHarness();
		await controller.setPlanMode({ action: "on", description: "Draft the disposable plan" });
		expectModelState(host, { model: planModel, thinkingLevel: planThinking });

		await controller.setPlanMode({ action: "off" });

		expectModelState(host, { model: executionModel, thinkingLevel: executionThinking });
	});

	it("keeps the plan model after denial and restores it after approval", async () => {
		const denied = createPlanRoleHarness();
		await denied.controller.setPlanMode({ action: "on", description: "Draft the review plan" });
		expectModelState(denied.host, { model: planModel, thinkingLevel: planThinking });
		denied.host.planFiles.set(DEFAULT_RPC_PLAN_FILE_PATH, "# Review plan\n");
		const deniedHandler = denied.host.resolveHandler;
		if (!deniedHandler) throw new Error("Expected a plan approval handler");
		denied.host.confirmations.push(false);

		await deniedHandler({ action: "apply", reason: "Plan is ready", extra: { title: "PLAN" } });

		expectModelState(denied.host, { model: planModel, thinkingLevel: planThinking });
		expect(denied.controller.getMode().plan).toMatchObject({ status: "active" });

		const approved = createPlanRoleHarness();
		await approved.controller.setPlanMode({ action: "on", description: "Draft the approved plan" });
		expectModelState(approved.host, { model: planModel, thinkingLevel: planThinking });
		approved.host.planFiles.set(DEFAULT_RPC_PLAN_FILE_PATH, "# Approved plan\n");
		const approvedHandler = approved.host.resolveHandler;
		if (!approvedHandler) throw new Error("Expected a plan approval handler");
		approved.host.confirmations.push(true);

		await approvedHandler({ action: "apply", reason: "Plan is ready", extra: { title: "PLAN" } });

		expectModelState(approved.host, { model: executionModel, thinkingLevel: executionThinking });
	});

	it("restores the exact pre-plan model and thinking during session preparation", async () => {
		const { host, controller } = createPlanRoleHarness();
		await controller.setPlanMode({ action: "on", description: "Draft the switching plan" });
		expectModelState(host, { model: planModel, thinkingLevel: planThinking });

		await controller.prepareForSessionChange();

		expectModelState(host, { model: executionModel, thinkingLevel: executionThinking });
	});
	it("routes goal create, pause, resume, and drop through the GoalRuntime transition contract", async () => {
		const { host, controller } = createHarness();

		const created = await controller.setGoalMode({ action: "on", description: "  Ship the release  " });
		expect(created).toMatchObject({
			agentInvoked: true,
			mode: {
				goal: {
					status: "active",
					objective: "Ship the release",
					continuationEnabled: false,
				},
			},
		});
		expect(host.goalState?.enabled).toBe(true);
		expect(host.goalState?.goal.status).toBe("active");
		expect(host.activeTools).toEqual(["read", "goal"]);
		expect(host.modeChanges.at(-1)?.mode).toBe("goal");
		expect(host.prompts).toEqual(["Ship the release"]);
		expect(host.prompts[0]).not.toMatch(/^\//);

		await controller.setGoalMode({ action: "toggle" });
		expect(controller.getMode().goal).toMatchObject({ status: "paused", objective: "Ship the release" });
		expect(host.goalState?.enabled).toBe(false);
		expect(host.goalState?.goal.status).toBe("paused");
		expect(host.activeTools).toEqual(["read"]);
		expect(host.modeChanges.at(-1)?.mode).toBe("goal_paused");

		await expect(controller.setGoalMode({ action: "on", description: "Replace it" })).rejects.toThrow(
			"A paused goal can only be resumed without a replacement objective.",
		);
		const resumed = await controller.setGoalMode({ action: "on" });
		expect(resumed.agentInvoked).toBe(false);
		expect(host.goalState?.enabled).toBe(true);
		expect(host.goalState?.goal.status).toBe("active");
		expect(host.activeTools).toEqual(["read", "goal"]);
		expect(host.modeChanges.at(-1)?.mode).toBe("goal");

		await controller.setGoalMode({ action: "off" });
		expect(controller.getMode().goal).toEqual({ status: "off", continuationEnabled: false });
		expect(host.goalState).toBeUndefined();
		expect(host.activeTools).toEqual(["read"]);
		expect(host.modeChanges.at(-1)?.mode).toBe("none");
		expect(host.goalRuntime.calls).toEqual(["create", "pause", "resume", "drop"]);
	});

	it("rejects both native mode mutations while a response is streaming", async () => {
		const { host, controller } = createHarness();
		host.streaming = true;

		await expect(controller.setPlanMode({ action: "on", description: "Draft the plan" })).rejects.toThrow(
			"Cannot change plan mode while a response is in progress.",
		);
		await expect(controller.setGoalMode({ action: "on", description: "Ship the release" })).rejects.toThrow(
			"Cannot change goal mode while a response is in progress.",
		);
		expect(controller.getMode()).toEqual({
			plan: { status: "off" },
			goal: { status: "off", continuationEnabled: false },
		});
	});

	it("reports disabled continuation honestly and dispatches one continuation only after an active idle end", async () => {
		vi.useFakeTimers();
		const disabled = createHarness();
		await disabled.controller.setGoalMode({ action: "on", description: "Ship the release" });
		expect(disabled.controller.getMode().goal).toMatchObject({ status: "active", continuationEnabled: false });
		await scheduleActiveGoalContinuation(disabled.controller);
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS);
		await flushMicrotasks();
		expect(disabled.host.continuations).toEqual([]);

		const enabled = createHarness({ continuationModes: ["rpc"] });
		await enabled.controller.setGoalMode({ action: "on", description: "Ship the release" });
		expect(enabled.controller.getMode().goal).toMatchObject({ status: "active", continuationEnabled: true });
		await scheduleActiveGoalContinuation(enabled.controller);
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS - 1);
		await flushMicrotasks();
		expect(enabled.host.continuations).toEqual([]);
		enabled.host.postPromptWork = true;
		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(enabled.host.continuations).toEqual([]);

		enabled.host.postPromptWork = false;
		await scheduleActiveGoalContinuation(enabled.controller);
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS);
		await flushMicrotasks();
		expect(enabled.host.continuations).toHaveLength(1);
		expect(enabled.host.continuations[0]).toContain("goal");
	});

	it("cancels scheduled RPC goal continuation when user work or a mode transition supersedes it", async () => {
		vi.useFakeTimers();

		const userStart = createHarness({ continuationModes: ["rpc"] });
		await userStart.controller.setGoalMode({ action: "on", description: "Ship the release" });
		await scheduleActiveGoalContinuation(userStart.controller);
		await userStart.controller.handleSessionEvent({ type: "message_start", message: { role: "user" } });
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS);
		await flushMicrotasks();
		expect(userStart.host.continuations).toEqual([]);

		const agentStart = createHarness({ continuationModes: ["rpc"] });
		await agentStart.controller.setGoalMode({ action: "on", description: "Ship the release" });
		await scheduleActiveGoalContinuation(agentStart.controller);
		await agentStart.controller.handleSessionEvent({ type: "agent_start" });
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS);
		await flushMicrotasks();
		expect(agentStart.host.continuations).toEqual([]);

		const paused = createHarness({ continuationModes: ["rpc"] });
		await paused.controller.setGoalMode({ action: "on", description: "Ship the release" });
		await scheduleActiveGoalContinuation(paused.controller);
		await paused.controller.setGoalMode({ action: "toggle" });
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS);
		await flushMicrotasks();
		expect(paused.host.continuations).toEqual([]);

		const dropped = createHarness({ continuationModes: ["rpc"] });
		await dropped.controller.setGoalMode({ action: "on", description: "Ship the release" });
		await scheduleActiveGoalContinuation(dropped.controller);
		await dropped.controller.setGoalMode({ action: "off" });
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS);
		await flushMicrotasks();
		expect(dropped.host.continuations).toEqual([]);

		const planResume = createHarness({ continuationModes: ["rpc"] });
		await planResume.controller.setGoalMode({ action: "on", description: "Ship the release" });
		await scheduleActiveGoalContinuation(planResume.controller);
		planResume.host.persisted = { mode: "plan", modeData: { planFilePath: "local://resume-plan.md" } };
		await planResume.controller.reconcile();
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS);
		await flushMicrotasks();
		expect(planResume.host.continuations).toEqual([]);
		expect(planResume.controller.getMode().plan).toEqual({
			status: "active",
			planFilePath: "local://resume-plan.md",
		});
	});

	it("suppresses the next RPC continuation after a continuation turn ends without tool execution", async () => {
		vi.useFakeTimers();
		const { host, controller } = createHarness({ continuationModes: ["rpc"] });
		await controller.setGoalMode({ action: "on", description: "Ship the release" });

		await scheduleActiveGoalContinuation(controller);
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS);
		await flushMicrotasks();
		expect(host.continuations).toHaveLength(1);

		await controller.handleSessionEvent({ type: "agent_end" });
		vi.advanceTimersByTime(RPC_GOAL_CONTINUATION_DELAY_MS);
		await flushMicrotasks();
		expect(host.continuations).toHaveLength(1);
	});
});
