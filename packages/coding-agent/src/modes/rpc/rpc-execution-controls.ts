import type { ServiceTier, ServiceTierFamily } from "@oh-my-pi/pi-ai";
import type { Goal } from "../../goals/state";
import type { AgentSession } from "../../session/agent-session";
import type { SessionLoopAction } from "../../session/session-loop";
import type { LoopLimitConfig } from "../../session/session-loop-limit";
import {
	applyOpsToPhases,
	type TodoOperationInput,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../../tools/todo";
import type {
	RpcCheckpointControlOperation,
	RpcCheckpointControlResult,
	RpcGoalControlOperation,
	RpcGoalControlResult,
	RpcLoopControlOperation,
	RpcLoopControlResult,
	RpcModelRoleResult,
	RpcServiceTierResult,
} from "./rpc-types";

export class RpcTodoOperationError extends Error {}

function persistTodoPhases(session: AgentSession, phases: TodoPhase[]): TodoPhase[] {
	session.setTodoPhases(phases);
	const persisted = session.getTodoPhases();
	session.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: persisted });
	return persisted;
}

/** Replace the authoritative todo projection and persist it through SessionManager. */
export function setRpcTodoPhases(session: AgentSession, phases: TodoPhase[]): TodoPhase[] {
	return persistTodoPhases(session, phases);
}

/** Apply one semantic todo transition atomically and persist successful mutations. */
export function applyRpcTodoOperation(session: AgentSession, operation: TodoOperationInput): TodoPhase[] {
	const applied = applyOpsToPhases(session.getTodoPhases(), [operation]);
	if (applied.errors.length > 0) throw new RpcTodoOperationError(applied.errors.join("; "));
	if (operation.op === "view") return session.getTodoPhases();
	return persistTodoPhases(session, applied.phases);
}

export interface RpcGoalControlInput {
	op: RpcGoalControlOperation;
	objective?: string;
	tokenBudget?: number;
}

/** Apply a goal lifecycle transition through GoalRuntime, which owns persistence and accounting. */
export async function controlRpcGoal(session: AgentSession, input: RpcGoalControlInput): Promise<RpcGoalControlResult> {
	let terminalGoal: Goal | undefined;
	switch (input.op) {
		case "create":
			await session.goalRuntime.createGoal({
				objective: input.objective ?? "",
				...(input.tokenBudget == null ? {} : { tokenBudget: input.tokenBudget }),
			});
			break;
		case "replace":
			await session.goalRuntime.replaceGoal({
				objective: input.objective ?? "",
				...(input.tokenBudget == null ? {} : { tokenBudget: input.tokenBudget }),
			});
			break;
		case "get":
			break;
		case "resume":
			await session.goalRuntime.resumeGoal();
			break;
		case "pause":
			await session.goalRuntime.pauseGoal();
			break;
		case "drop":
			terminalGoal = await session.goalRuntime.dropGoal();
			break;
		case "complete":
			terminalGoal = await session.goalRuntime.completeGoalFromTool();
			break;
		case "set_budget":
			if (input.tokenBudget === undefined) {
				throw new Error("tokenBudget is required when op=set_budget");
			}
			await session.goalRuntime.onBudgetMutated(input.tokenBudget);
			break;
		case "clear_budget":
			await session.goalRuntime.onBudgetMutated(undefined);
			break;
	}
	const state = session.getGoalModeState();
	return {
		operation: input.op,
		state: state ?? null,
		goal: terminalGoal ?? state?.goal ?? null,
	};
}
/** Select a configured model role without mutating global model settings. */
export async function setRpcModelRole(session: AgentSession, role: string): Promise<RpcModelRoleResult> {
	const normalizedRole = role.trim();
	if (!normalizedRole) throw new Error("role is required");
	const cycle = session.getRoleModelCycle([normalizedRole]);
	const entry = cycle?.models.find(candidate => candidate.role === normalizedRole);
	if (!entry) throw new Error(`Model role is not configured: ${normalizedRole}`);
	await session.applyRoleModel(entry);
	return {
		role: entry.role,
		model: { provider: entry.model.provider, id: entry.model.id, api: entry.model.api },
		...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }),
	};
}

/** Set or clear one provider family's live service tier. */
export function setRpcServiceTier(
	session: AgentSession,
	family: ServiceTierFamily,
	tier: ServiceTier | null,
): RpcServiceTierResult {
	session.setServiceTierFamily(family, tier ?? undefined);
	return {
		family,
		tier,
		serviceTiers: { ...session.serviceTierByFamily },
	};
}

export interface RpcCheckpointControlInput {
	op: RpcCheckpointControlOperation;
	goal?: string;
	report?: string;
}

/** Create, inspect, or rewind a durable AgentSession checkpoint. */
export async function controlRpcCheckpoint(
	session: AgentSession,
	input: RpcCheckpointControlInput,
): Promise<RpcCheckpointControlResult> {
	switch (input.op) {
		case "get":
			break;
		case "create":
			session.createCheckpoint(input.goal ?? "");
			break;
		case "rewind":
			await session.rewindCheckpoint(input.report ?? "");
			break;
	}
	const active = session.getCheckpointState();
	const lastCompleted = session.getLastCompletedRewind();
	return {
		operation: input.op,
		active: active ? { ...active } : null,
		lastCompleted: lastCompleted ? { ...lastCompleted } : null,
	};
}

export interface RpcLoopControlInput {
	op: RpcLoopControlOperation;
	action?: SessionLoopAction;
	prompt?: string;
	limit?: LoopLimitConfig;
}

/** Control the host-neutral loop authority; presentation adapters own only scheduling. */
export function controlRpcLoop(session: AgentSession, input: RpcLoopControlInput): RpcLoopControlResult {
	switch (input.op) {
		case "get":
			break;
		case "enable":
			session.enableLoop({
				...(input.action === undefined ? {} : { action: input.action }),
				...(input.prompt === undefined ? {} : { prompt: input.prompt }),
				...(input.limit === undefined ? {} : { limit: input.limit }),
			});
			break;
		case "pause":
			session.pauseLoop();
			break;
		case "resume":
			session.resumeLoop(input.prompt ?? "");
			break;
		case "disable":
			session.disableLoop();
			break;
	}
	return { operation: input.op, state: session.getLoopState() };
}
