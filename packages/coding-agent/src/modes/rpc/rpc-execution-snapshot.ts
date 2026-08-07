import type { AgentSession } from "../../session/agent-session";
import type { RpcOperationsSnapshot, RpcPendingInteractionSnapshot, RpcSessionExecutionSnapshot } from "./rpc-types";

export interface RpcExecutionSnapshotContext {
	applicationApiVersion: number;
	operations: RpcOperationsSnapshot;
	pendingInteractions: RpcPendingInteractionSnapshot[];
}

export async function projectRpcSessionExecution(
	session: AgentSession,
	context: RpcExecutionSnapshotContext,
): Promise<RpcSessionExecutionSnapshot> {
	const goalState = session.getGoalModeState();
	const activeModel = session.model;
	const checkpoint = session.getCheckpointState();
	const completedRewind = session.getLastCompletedRewind();
	const extensionRunner = session.extensionRunner;
	return {
		turn: {
			phase: session.activityPhase,
			streaming: session.isStreaming,
			aborting: session.isAborting,
			messageCount: session.messages.length,
			activeOperations: context.operations.active,
		},
		queue: {
			state: session.getQueueSnapshot(),
			modes: {
				steering: session.steeringMode,
				followUp: session.followUpMode,
				interrupt: session.interruptMode,
			},
		},
		goal: {
			state: goalState ? { ...goalState, goal: { ...goalState.goal } } : null,
			runtime: session.goalRuntime.snapshot,
			turnBudget: session.sessionManager.getTurnBudget(),
		},
		todos: session.getTodoSnapshot(),
		plan: await session.planMode.project(),
		model: {
			...(activeModel
				? { active: { provider: activeModel.provider, id: activeModel.id, api: activeModel.api } }
				: {}),
			activeRole: session.sessionManager.getLastModelChangeRole() ?? "default",
			configuredThinkingLevel: session.configuredThinkingLevel(),
			effectiveThinkingLevel: session.thinkingLevel,
			autoThinking: session.isAutoThinking,
			autoResolvedThinkingLevel: session.autoResolvedThinkingLevel(),
			serviceTiers: { ...session.serviceTierByFamily },
			retryFallbackModel: session.retryFallbackModel,
			advisor: session.getAdvisorStateOverview(),
		},
		maintenance: {
			compaction: { active: session.isCompacting, automatic: session.autoCompactionEnabled },
			retry: {
				active: session.isRetrying,
				automatic: session.autoRetryEnabled,
				attempt: session.retryAttempt,
				...(session.retryFallbackModel ? { fallbackModel: session.retryFallbackModel } : {}),
			},
		},
		recovery: session.getRecoverySnapshot(),
		checkpoint: {
			active: checkpoint ? { ...checkpoint } : null,
			lastCompleted: completedRewind ? { ...completedRewind } : null,
		},
		tools: {
			active: session.getActiveToolNames(),
			enabled: session.getEnabledToolNames(),
			mounted: session.getMountedXdevToolNames(),
			inventory: session.getToolInventory(context.applicationApiVersion),
		},
		interactions: { pending: context.pendingInteractions },
		loop: session.getLoopState(),
		extensions: {
			loaded: extensionRunner !== undefined,
			uiAvailable: extensionRunner?.hasUI() ?? false,
			paths: extensionRunner?.getExtensionPaths() ?? [],
			registeredTools:
				extensionRunner?.getAllRegisteredTools().map(tool => ({
					name: tool.definition.name,
					extensionPath: tool.extensionPath,
				})) ?? [],
		},
		resources: {
			mcp: {
				selectedTools: session.getSelectedMCPToolNames(),
				prompts: session.mcpPromptCommands.map(command => ({
					name: command.command.name,
					...(command.command.description ? { description: command.command.description } : {}),
					source: command.source,
				})),
			},
		},
	};
}
