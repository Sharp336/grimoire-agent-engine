/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type {
	Effort,
	ImageContent,
	Model,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	ToolExample,
} from "@oh-my-pi/pi-ai";
import type { AdvisorRuntimeStatus } from "../../advisor";
import type { SettingTab } from "../../config/settings-schema";
import type { SettingsSnapshot } from "../../config/settings-snapshot";
import type { BashResult } from "../../exec/bash-executor";
import type {
	ContextUsage,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
} from "../../extensibility/extensions/types";
import type { GoalRuntimeSnapshot } from "../../goals/runtime";
import type { Goal, GoalModeState } from "../../goals/state";
import type {
	AgentControlRegistryUpdate,
	AgentControlReleaseResult,
	AgentControlResult,
	AgentControlSendResult,
	AgentControlSnapshot,
} from "../../registry/agent-control";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import type { SessionStats } from "../../session/agent-session-types";
import type {
	ArtifactDescriptor,
	ArtifactExportResult,
	ArtifactRange,
	ArtifactReference,
} from "../../session/artifacts";
import type {
	SessionCatalogEntry,
	SessionCatalogPage,
	SessionCatalogScope,
	SessionCatalogTreeNode,
	SessionWorkspaceRoot,
} from "../../session/session-catalog";
import type { ContextAssemblySnapshot } from "../../session/session-context-projection";
import type {
	SessionAuthoritySettlement,
	SessionCommand,
	SessionCommandOutcome,
	SessionHostClientCapabilities,
	SessionHostManifest,
	SessionHostNegotiationResult,
	SessionJournalCursor,
	SessionObservation,
	SessionObservationPosition,
	SessionSemanticProfileRange,
	SessionSnapshot,
} from "../../session/session-host";
import type { SessionLoopAction, SessionLoopState } from "../../session/session-loop";
import type { LoopLimitConfig } from "../../session/session-loop-limit";
import type {
	SessionQueueClearResult,
	SessionQueueEntry,
	SessionQueueLane,
	SessionQueueSnapshot,
} from "../../session/session-queue-service";
import type { ToolInventory } from "../../session/session-tools";
import type { TodoTrackerSnapshot } from "../../session/todo-tracker";
import type { TurnRecoverySnapshot } from "../../session/turn-recovery";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { CheckpointState, CompletedRewindState } from "../../tools/checkpoint";
import type { AgentActivitySnapshot, CancelOutcome, JobSnapshot } from "../../tools/hub/types";
import type { RpcCollaborationFrame, RpcCollaborationMediaRange, RpcCollaborationSnapshot } from "./rpc-collaboration";
import type { RpcProvenanceFrame, RpcProvenanceSnapshot } from "./rpc-provenance";
import type {
	RpcResourceLifecycleFrame,
	RpcResourceLifecycleSnapshot,
	RpcResourceServerSnapshot,
} from "./rpc-resource-lifecycle";

export type {
	ToolInventory,
	ToolInventoryEntry,
	ToolInventoryPresentation,
	ToolInventorySource,
} from "../../session/session-tools";

import type { FileEntry } from "../../session/session-entries";
import type { SessionWorkspace } from "../../session/session-workspace";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type {
	AgentProgress,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../../task";
import type { TodoOperationInput, TodoPhase } from "../../tools/todo";
import type { RpcMessagesPage } from "./rpc-messages";
import type {
	RpcSemanticActionRequestedFrame,
	RpcSemanticActionSettledFrame,
	RpcSemanticContentFrame,
} from "./rpc-semantic-rendering";

export type * from "./rpc-collaboration";
export type * from "./rpc-provenance";
export type * from "./rpc-resource-lifecycle";
export type * from "./rpc-semantic-rendering";

export type RpcJsonValue = string | number | boolean | null | RpcJsonValue[] | { [key: string]: RpcJsonValue };

export interface RpcSettingsChange {
	path: string;
	value: RpcJsonValue;
}

// ============================================================================
// RPC Context Projection
// ============================================================================

export interface RpcContextGetOptions {
	maxSources?: number;
	maxRelations?: number;
	maxContentBytes?: number;
}

export interface RpcContextGetBounds {
	maxSources: number;
	maxRelations: number;
	maxContentBytes: number;
}

export interface RpcContextGetTruncation {
	sources: boolean;
	relations: boolean;
	content: boolean;
}

export interface RpcContextGetResult {
	snapshot: ContextAssemblySnapshot;
	bounds: RpcContextGetBounds;
	returned: {
		sources: number;
		relations: number;
		contentBytes: number;
	};
	truncated: RpcContextGetTruncation;
}

// ============================================================================
// Negotiated Interactive UI
// ============================================================================

export interface RpcUiFence {
	channelId: string;
	generation: number;
	sessionId: string;
	authorityGeneration: number;
}

export interface RpcUiEditorState {
	text: string;
	revision: number;
}

export interface RpcUiThemeInfo {
	name: string;
	path?: string;
	current: boolean;
}

export type RpcUiPresentationKind = "widget" | "header" | "footer" | "editor" | "custom";

export interface RpcUiActionDescriptor {
	id: string;
	owner: "rpc" | "client" | "presentation";
	operations: RpcCommand["type"][];
}

export type RpcUiPresentationAction = { id: "input"; kind: "input" } | { id: "cancel"; kind: "cancel" };

export interface RpcUiPresentation {
	id: string;
	kind: RpcUiPresentationKind;
	key?: string;
	placement?: "aboveEditor" | "belowEditor" | "overlay";
	rows: string[];
	revision: number;
	focused: boolean;
	actions: RpcUiPresentationAction[];
}

export interface RpcUiPresentationInputResult {
	completed: boolean;
	presentation: RpcUiPresentation | null;
}

export interface RpcUiSubscriptions {
	editor: boolean;
	presentation: boolean;
	theme: boolean;
	title: boolean;
	toolsExpanded: boolean;
}

export interface RpcUiSnapshot {
	fence: RpcUiFence;
	terminalId: string;
	subscriptions: RpcUiSubscriptions;
	editor: RpcUiEditorState;
	presentations: RpcUiPresentation[];
	theme: { name?: string; revision: number };
	title: { value: string; revision: number };
	toolsExpanded: { value: boolean; revision: number };
	terminalInputHandlers: number;
	actions: RpcUiActionDescriptor[];
}

export interface RpcUiAutocompleteItem {
	id: string;
	value: string;
	label: string;
	description?: string;
	hint?: string;
}

export interface RpcUiAutocompleteResult {
	operationId: string;
	items: RpcUiAutocompleteItem[];
	prefix: string;
	inlineHint?: string;
	replacement: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
}

export type RpcUiClientAction = { type: "clipboard_write"; text: string };

export interface RpcUiAutocompleteApplyResult {
	editor: RpcUiEditorState;
	cursor: { line: number; column: number };
	clientAction?: RpcUiClientAction;
}

export interface RpcUiInputResult {
	consumed: boolean;
	data: string;
}

export type RpcUiChannelSettlementReason =
	| "closed"
	| "replaced"
	| "authority_changed"
	| "session_changed"
	| "client_disconnected"
	| "shutdown";

export interface RpcUiChannelSettledFrame {
	type: "ui_channel_settled";
	channelId: string;
	generation: number;
	reason: RpcUiChannelSettlementReason;
}

export interface RpcUiEditorUpdateFrame {
	type: "ui_editor_update";
	fence: RpcUiFence;
	editor: RpcUiEditorState;
	source: "client" | "extension" | "component" | "session";
}

export interface RpcUiPresentationUpdateFrame {
	type: "ui_presentation_update";
	fence: RpcUiFence;
	presentation: RpcUiPresentation;
}

export interface RpcUiPresentationRemoveFrame {
	type: "ui_presentation_remove";
	fence: RpcUiFence;
	presentationId: string;
	reason: "removed" | "completed" | "cancelled" | "session_changed";
}

export interface RpcUiThemeUpdateFrame {
	type: "ui_theme_update";
	fence: RpcUiFence;
	theme: { name?: string; revision: number };
}

export interface RpcUiTitleUpdateFrame {
	type: "ui_title_update";
	fence: RpcUiFence;
	title: string;
	revision: number;
}

export interface RpcUiToolsExpandedUpdateFrame {
	type: "ui_tools_expanded_update";
	fence: RpcUiFence;
	expanded: boolean;
	revision: number;
}

export type RpcUiFrame =
	| RpcUiChannelSettledFrame
	| RpcUiEditorUpdateFrame
	| RpcUiPresentationUpdateFrame
	| RpcUiPresentationRemoveFrame
	| RpcUiThemeUpdateFrame
	| RpcUiTitleUpdateFrame
	| RpcUiToolsExpandedUpdateFrame;

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Protocol
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }
	| { id?: string; type: "get_capabilities" }
	| {
			id?: string;
			type: "initialize";
			profile: SessionSemanticProfileRange;
			framingVersion: number;
			hostCapabilities: SessionHostClientCapabilities;
			requestedCapabilities: string[];
	  }
	| {
			id: string;
			type: "session_open";
			after?: SessionObservationPosition;
			afterCursor?: SessionJournalCursor;
			snapshot?: boolean;
	  }
	| ({ id: string; type: "context_get" } & RpcContextGetOptions)
	| {
			id: string;
			type: "ui_open";
			terminalId: string;
			width?: number;
			subscriptions?: Partial<RpcUiSubscriptions>;
	  }
	| { id: string; type: "ui_close"; channelId: string; generation: number }
	| { id: string; type: "ui_input"; channelId: string; generation: number; data: string }
	| {
			id: string;
			type: "ui_editor_update";
			channelId: string;
			generation: number;
			expectedRevision: number;
			text: string;
	  }
	| {
			id: string;
			type: "ui_editor_paste";
			channelId: string;
			generation: number;
			expectedRevision: number;
			text: string;
	  }
	| {
			id: string;
			type: "ui_autocomplete_suggest";
			channelId: string;
			generation: number;
			lines: string[];
			cursorLine: number;
			cursorCol: number;
			forceFile?: boolean;
	  }
	| {
			id: string;
			type: "ui_autocomplete_apply";
			channelId: string;
			generation: number;
			suggestionId: string;
	  }
	| { id: string; type: "ui_cancel"; channelId: string; generation: number; operationId: string }
	| {
			id: string;
			type: "ui_presentation_input";
			channelId: string;
			generation: number;
			presentationId: string;
			data: string;
	  }
	| {
			id: string;
			type: "ui_presentation_action";
			channelId: string;
			generation: number;
			presentationId: string;
			action: "cancel";
	  }
	| { id: string; type: "ui_theme_list"; channelId: string; generation: number }
	| { id: string; type: "ui_theme_get"; channelId: string; generation: number; name: string }
	| { id: string; type: "ui_theme_set"; channelId: string; generation: number; name: string }
	| {
			id: string;
			type: "ui_tools_expanded_set";
			channelId: string;
			generation: number;
			expanded: boolean;
	  }
	| {
			id: string;
			type: "ui_title_subscribe";
			channelId: string;
			generation: number;
			subscribed: boolean;
	  }
	| { id: string; type: "session_ack"; subscriptionId: string; sequence: number }
	| { id: string; type: "session_unsubscribe"; subscriptionId: string }
	| { id: string; type: "session_invoke"; command: SessionCommand }
	| { id: string; type: "session_shutdown" }
	| {
			id: string;
			type: "semantic_action";
			renderId: string;
			actionId: string;
			input?: Record<string, RpcJsonValue>;
	  }
	| { id: string; type: "semantic_cancel"; renderId: string; actionId?: string }
	| { id: string; type: "artifact_describe"; artifactId: string }
	| { id: string; type: "artifact_read"; artifactId: string; offset?: number; length?: number }
	| {
			id: string;
			type: "artifact_export";
			artifactId: string;
			destination: string;
			expectedSha256: string;
	  }
	| { id: string; type: "resource_list" }
	| { id: string; type: "resource_refresh"; serverId?: string }
	| { id: string; type: "resource_reload" }
	| { id: string; type: "resource_cancel"; operationId: string }
	| { id: string; type: "resource_dispose"; serverId: string }
	| { id: string; type: "provenance_get"; refreshUsage?: boolean }
	| { id: string; type: "collaboration_get" }
	| { id: string; type: "collaboration_host"; relayUrl?: string; webUrl?: string }
	| { id: string; type: "collaboration_join"; link: string; displayName?: string }
	| { id: string; type: "collaboration_leave"; reason?: string }
	| { id: string; type: "collaboration_revoke"; participantId: string }
	| { id: string; type: "collaboration_rotate" }
	| { id: string; type: "collaboration_acknowledge"; generation: number; sequence: number }
	| { id: string; type: "collaboration_read_media"; mediaId: string; offset?: number; length?: number }

	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "cancel_operation"; operationId: string }
	| {
			id?: string;
			type: "eval_execute";
			language: RpcEvalLanguage;
			code: string;
			title?: string;
			timeout?: number;
			reset?: boolean;
			excludeFromContext?: boolean;
	  }
	| { id?: string; type: "get_eval_history"; limit?: number }
	| { id?: string; type: "new_session"; parentSession?: string }
	| {
			id?: string;
			type: "set_mode";
			mode: RpcSessionMode;
			planFilePath?: string;
			workflow?: RpcPlanWorkflow;
			when?: "immediate" | "next_idle";
	  }
	| { id?: string; type: "get_plan" }
	| {
			id?: string;
			type: "resolve_plan_approval";
			approvalId: string;
			decision: "approve" | "refine" | "reject";
			preserveContext?: boolean;
			compactBeforeExecute?: boolean;
			executionModelRole?: string;
			editedContent?: string;
			feedback?: string;
	  }
	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_operations" }
	| { id?: string; type: "get_tool_inventory" }
	| { id?: string; type: "set_tool_activation"; activate?: string[]; deactivate?: string[] }
	| { id?: string; type: "list_provider_auth" }
	| { id?: string; type: "begin_provider_auth"; providerId: string; method: RpcProviderAuthMethod }
	| { id?: string; type: "cancel_provider_auth"; operationId: string }
	| { id?: string; type: "remove_provider_auth"; providerId: string }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "get_advisor_state" }
	| { id?: string; type: "set_advisor_enabled"; enabled: boolean }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "get_settings"; tab?: SettingTab }
	| { id?: string; type: "set_settings"; changes: RpcSettingsChange[] }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "todo_apply"; operation: TodoOperationInput }
	| {
			id?: string;
			type: "goal_control";
			op: RpcGoalControlOperation;
			objective?: string;
			tokenBudget?: number;
	  }
	| {
			id?: string;
			type: "checkpoint_control";
			op: RpcCheckpointControlOperation;
			goal?: string;
			report?: string;
	  }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { id?: string; type: "list_agents"; includeAdvisors?: boolean }
	| { id?: string; type: "get_agent"; agentId: string }
	| {
			id?: string;
			type: "loop_control";
			op: RpcLoopControlOperation;
			action?: SessionLoopAction;
			prompt?: string;
			limit?: LoopLimitConfig;
	  }
	| {
			id?: string;
			type: "start_agent";
			task: string;
			agent?: string;
			name?: string;
			context?: string;
	  }
	| { id?: string; type: "get_agent_result"; agentId: string }
	| { id?: string; type: "send_agent_message"; agentId: string; message: string; replyTo?: string }
	| { id?: string; type: "park_agent"; agentId: string }
	| { id?: string; type: "resume_agent"; agentId: string }
	| { id?: string; type: "cancel_agent"; agentId: string }
	| { id?: string; type: "release_agent"; agentId: string; tombstone?: boolean }
	| { id?: string; type: "get_queue" }
	| { id?: string; type: "queue_insert"; lane: SessionQueueLane; text: string; toIndex?: number }
	| { id?: string; type: "queue_update"; entryId: string; text: string }
	| { id?: string; type: "queue_move"; entryId: string; lane: SessionQueueLane; toIndex: number }
	| { id?: string; type: "remove_queued_message"; entryId: string }
	| { id?: string; type: "reorder_queued_message"; entryId: string; toIndex: number }
	| { id?: string; type: "clear_queue"; lane?: SessionQueueLane | "all" }
	| { id?: string; type: "list_jobs" }
	| { id?: string; type: "get_job"; jobId: string }
	| { id?: string; type: "cancel_job"; jobIds: string[] }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "set_model_role"; role: string }
	| { id?: string; type: "set_service_tier"; family: ServiceTierFamily; tier: ServiceTier | null }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ConfiguredThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "retry" }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| {
			id?: string;
			type: "list_sessions";
			scope?: SessionCatalogScope;
			cwd?: string;
			cursor?: string;
			limit?: number;
			search?: string;
	  }
	| { id?: string; type: "get_session_info"; session: string; scope?: SessionCatalogScope; cwd?: string }
	| { id?: string; type: "get_session_tree" }
	| {
			id?: string;
			type: "select_session_leaf";
			entryId: string;
			summarize?: boolean;
			customInstructions?: string;
	  }
	| { id?: string; type: "reset_session" }
	| { id?: string; type: "list_workspace_roots" }
	| { id?: string; type: "resume_session"; session: string; scope?: SessionCatalogScope; cwd?: string }
	| { id?: string; type: "fork_session" }
	| { id?: string; type: "rename_session"; session: string; name: string; scope?: SessionCatalogScope; cwd?: string }
	| { id?: string; type: "delete_session"; session: string; scope?: SessionCatalogScope; cwd?: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number };

// ============================================================================
// RPC State
// ============================================================================

export type RpcSessionActivityPhase = "provider" | "maintenance" | "idle";
export interface RpcAdvisorState {
	configured: boolean;
	active: boolean;
	advisors: Array<{ name: string; status: AdvisorRuntimeStatus }>;
}

export type RpcSessionMode = "none" | "plan" | "plan_paused";
export type RpcPlanWorkflow = "parallel" | "iterative";

export interface RpcPendingPlanApproval {
	approvalId: string;
	title: string;
	planFilePath: string;
}

export interface RpcPlanState {
	mode: RpcSessionMode;
	planFilePath?: string;
	workflow?: RpcPlanWorkflow;
	reentry?: boolean;
	awaitingApproval?: RpcPendingPlanApproval;
	planExists?: boolean;
	availablePlanFiles?: string[];
	content?: string;
}

export interface RpcModeChangeResult {
	operationId: string;
	accepted: true;
	deferred: boolean;
}

export interface RpcPlanApprovalResult {
	approvalId: string;
	decision: "approve" | "refine" | "reject";
	executionDispatched: boolean;
	planFilePath: string;
	compaction?: "ok" | "cancelled" | "failed";
}

export interface RpcPlanStateUpdateFrame {
	type: "plan_state_update";
	state: RpcPlanState;
}

export interface RpcPlanApprovalRequestFrame {
	type: "plan_approval_request";
	approvalId: string;
	planFilePath: string;
	title: string;
	planContent: string;
}

export interface RpcPlanApprovalSettledFrame {
	type: "plan_approval_settled";
	approvalId: string;
	result: RpcPlanApprovalResult;
}

export interface RpcSessionState {
	mode: RpcSessionMode;
	plan?: RpcPlanState;
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	configuredThinkingLevel?: ConfiguredThinkingLevel;
	isStreaming: boolean;
	/** Provider generation, post-turn maintenance, or terminal idle. */
	activityPhase: RpcSessionActivityPhase;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	advisor?: RpcAdvisorState;
}
export interface RpcSessionTurnSnapshot {
	phase: RpcSessionActivityPhase;
	streaming: boolean;
	aborting: boolean;
	messageCount: number;
	activeOperations: RpcActiveOperation[];
}

export interface RpcSessionQueueAuthoritySnapshot {
	state: SessionQueueSnapshot;
	modes: {
		steering: "all" | "one-at-a-time";
		followUp: "all" | "one-at-a-time";
		interrupt: "immediate" | "wait";
	};
}

export interface RpcSessionGoalSnapshot {
	state: GoalModeState | null;
	runtime: GoalRuntimeSnapshot;
	turnBudget: { total: number | null; spent: number; hard: boolean };
}
export type RpcGoalControlOperation =
	| "create"
	| "replace"
	| "get"
	| "resume"
	| "pause"
	| "drop"
	| "complete"
	| "set_budget"
	| "clear_budget";
export interface RpcGoalControlResult {
	operation: RpcGoalControlOperation;
	state: GoalModeState | null;
	goal: Goal | null;
}

export interface RpcSessionModelSnapshot {
	active?: { provider: string; id: string; api: string };
	activeRole: string;
	configuredThinkingLevel?: ConfiguredThinkingLevel;
	effectiveThinkingLevel?: ThinkingLevel;
	autoThinking: boolean;
	autoResolvedThinkingLevel?: Effort;
	serviceTiers: ServiceTierByFamily;
	retryFallbackModel?: string;
	advisor: RpcAdvisorState;
}
export interface RpcModelRoleResult {
	role: string;
	model: { provider: string; id: string; api: string };
	thinkingLevel?: ConfiguredThinkingLevel;
}

export interface RpcServiceTierResult {
	family: ServiceTierFamily;
	tier: ServiceTier | null;
	serviceTiers: ServiceTierByFamily;
}

export interface RpcSessionMaintenanceSnapshot {
	compaction: { active: boolean; automatic: boolean };
	retry: { active: boolean; automatic: boolean; attempt: number; fallbackModel?: string };
}

export interface RpcSessionCheckpointSnapshot {
	active: CheckpointState | null;
	lastCompleted: CompletedRewindState | null;
}
export type RpcCheckpointControlOperation = "get" | "create" | "rewind";
export interface RpcCheckpointControlResult extends RpcSessionCheckpointSnapshot {
	operation: RpcCheckpointControlOperation;
}

export interface RpcSessionToolPolicySnapshot {
	active: string[];
	enabled: string[];
	mounted: string[];
	inventory: ToolInventory;
}
export interface RpcSessionExtensionSnapshot {
	loaded: boolean;
	uiAvailable: boolean;
	paths: string[];
	registeredTools: Array<{ name: string; extensionPath: string }>;
}

export interface RpcSessionResourceSnapshot {
	mcp: {
		selectedTools: string[];
		prompts: Array<{ name: string; description?: string; source: string }>;
	};
}

export type RpcLoopControlOperation = "get" | "enable" | "pause" | "resume" | "disable";
export interface RpcLoopControlResult {
	operation: RpcLoopControlOperation;
	state: SessionLoopState;
}

export interface RpcSessionExecutionSnapshot {
	turn: RpcSessionTurnSnapshot;
	queue: RpcSessionQueueAuthoritySnapshot;
	goal: RpcSessionGoalSnapshot;
	todos: TodoTrackerSnapshot;
	plan: RpcPlanState;
	model: RpcSessionModelSnapshot;
	maintenance: RpcSessionMaintenanceSnapshot;
	recovery: TurnRecoverySnapshot;
	checkpoint: RpcSessionCheckpointSnapshot;
	tools: RpcSessionToolPolicySnapshot;
	interactions: { pending: RpcPendingInteractionSnapshot[] };
	loop: SessionLoopState;
	extensions: RpcSessionExtensionSnapshot;
	resources: RpcSessionResourceSnapshot;
}

export type RpcProviderAuthMethod = "oauth_callback" | "paste_code" | "device_code" | "api_key";
export type RpcProviderAuthCredentialOrigin = "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";

export interface RpcProviderAuthMethodCapability {
	method: RpcProviderAuthMethod;
	available: boolean;
	exclusive: true;
}

export interface RpcProviderAuthState {
	providerId: string;
	name: string;
	credentialOrigin?: RpcProviderAuthCredentialOrigin;
	authenticated: boolean;
	disabled: boolean;
	available: boolean;
	unavailableReason?: string;
	identity?: {
		email?: string;
		accountId?: string;
		projectId?: string;
		orgId?: string;
		orgName?: string;
	};
	methods: RpcProviderAuthMethodCapability[];
}

export interface RpcProviderAuthRequestFrame {
	type: "provider_auth_request";
	operationId: string;
	requestId: string;
	providerId: string;
	method: "open_url";
	url: string;
	launchUrl?: string;
	instructions?: string;
}

export interface RpcProviderAuthUpdateFrame {
	type: "provider_auth_update";
	state: RpcProviderAuthState;
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}
export interface RpcToolInventoryUpdateFrame {
	type: "tool_inventory_update";
}
export interface RpcQueueUpdateFrame {
	type: "queue_update";
	queue: SessionQueueSnapshot;
}

export interface RpcLoopStateUpdateFrame {
	type: "loop_state_update";
	state: SessionLoopState;
	causationId?: string;
}

export interface RpcLoopErrorFrame {
	type: "loop_error";
	error: string;
	state: SessionLoopState;
	causationId?: string;
}

export interface RpcJobUpdateFrame {
	type: "job_update";
	jobs: JobSnapshot[];
	agents: AgentActivitySnapshot[];
}

export interface RpcJobListResult {
	jobs: JobSnapshot[];
	agents: AgentActivitySnapshot[];
}

export type { SessionQueueClearResult, SessionQueueSnapshot };

export interface RpcToolActivationResult {
	/** Enabled names after authoritative reconciliation (top-level plus mounted). */
	enabledToolNames: string[];
	/** Top-level names after authoritative reconciliation. */
	activeToolNames: string[];
	/** Names mounted under `xd://` after authoritative reconciliation. */
	mountedToolNames: string[];
	/** Actual enabled-set additions, not an echo of the request. */
	activated: string[];
	/** Actual enabled-set removals, not an echo of the request. */
	deactivated: string[];
	inventoryAvailable: boolean;
	/** Present only when the just-committed authoritative inventory is representable. */
	inventory?: ToolInventory;
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	operationId?: string;
	agentInvoked: boolean;
}

export interface RpcEvalHistoryEntry {
	language: RpcEvalLanguage;
	code: string;
	/** Bounded UTF-8-safe tail preview; complete bytes are in artifact. */
	output: string;
	outputBytes: number;
	outputPreviewBytes: number;
	outputTruncation: {
		truncated: boolean;
		direction: "none" | "tail";
	};
	artifact: ArtifactDescriptor;
	artifactRef: ArtifactReference;
	exitCode: number | undefined;
	cancelled: boolean;
	/** Legacy shorthand retained alongside outputTruncation for existing clients. */
	truncated: boolean;
	timestamp: number;
	excludeFromContext?: boolean;
}

export interface RpcEvalOutputFrame {
	type: "eval_output";
	operationId: string;
	sequence: number;
	chunk: string;
	truncated: boolean;
}

export interface RpcEvalCompleteFrame {
	type: "eval_complete";
	operationId: string;
	result: RpcEvalHistoryEntry;
}

export type RpcEvalLanguage = "py" | "js" | "rb" | "jl";
export type RpcOperationCommand =
	| "prompt"
	| "abort_and_prompt"
	| "set_mode"
	| "resolve_plan_approval"
	| "provider_auth"
	| "eval_execute";
export type RpcOperationCancellationReason =
	| "user"
	| "replaced"
	| "session_transition"
	| "client_disconnected"
	| "shutdown";
export type RpcOperationCancellationCode =
	| "cancelled_by_client"
	| "replaced_by_prompt"
	| "session_changed"
	| "client_disconnected"
	| "session_shutdown";

interface RpcOperationFrameBase {
	operationId: string;
	requestId?: string;
	command: RpcOperationCommand;
}

export interface RpcOperationStartedFrame extends RpcOperationFrameBase {
	type: "operation_started";
	startedAt: number;
}

export type RpcOperationTerminalFrame =
	| (RpcOperationFrameBase & {
			type: "operation_completed";
			agentInvoked: boolean;
			settledAt: number;
			data?: { state: RpcProviderAuthState };
	  })
	| (RpcOperationFrameBase & {
			type: "operation_failed";
			error: string;
			code?: string;
			settledAt: number;
	  })
	| (RpcOperationFrameBase & {
			type: "operation_cancelled";
			reason: RpcOperationCancellationReason;
			code: RpcOperationCancellationCode;
			settledAt: number;
	  });

export interface RpcOperationAccepted {
	operationId: string;
	accepted: true;
}

export interface RpcActiveOperation extends RpcOperationFrameBase {
	status: "accepted" | "started" | "cancelling";
	acceptedAt: number;
	startedAt?: number;
}

export interface RpcOperationsSnapshot {
	active: RpcActiveOperation[];
	recent: RpcOperationTerminalFrame[];
}

export type RpcCancelOperationResult =
	| {
			operationId: string;
			status: "cancelled" | "completed" | "failed";
			terminal: RpcOperationTerminalFrame;
	  }
	| { operationId: string; status: "cancelling" | "not_found" };
export interface RpcCommandOutputFrame {
	type: "command_output";
	text: string;
}

export interface RpcSessionInfoUpdateFrame {
	type: "session_info_update";
	title?: string;
	sessionId: string;
	mode: RpcSessionMode;
}

export interface RpcConfigUpdateFrame {
	type: "config_update";
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	configuredThinkingLevel?: ConfiguredThinkingLevel;
	advisor?: RpcAdvisorState;
}

/** Pull-only invalidation signal; clients should call get_settings for current values. */
export interface RpcSettingsUpdateFrame {
	type: "settings_update";
}

export interface RpcExtensionErrorFrame {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

export type RpcCommandSchedulingClass = "serial" | "concurrent" | "control";
export type RpcCommandScope = "host" | "session" | "turn" | "agent";
export type RpcCommandExecution = "sync" | "operation" | "host-only" | "unavailable";
export type RpcCommandConfirmation = "none" | "required";
export type RpcCommandAvailability = "available" | "conditional" | "unavailable";
export type RpcCommandConcurrencyClass = RpcCommandSchedulingClass;

export interface RpcCapabilityDisabledReason {
	code: string;
	message: string;
}

export interface RpcInputSchema {
	type: "object";
	properties: Record<string, Record<string, unknown>>;
	required: string[];
	additionalProperties: false;
}

interface RpcCommandCapabilityBase {
	/** Stable protocol identity. Unlike the display name, this must never be repurposed. */
	id: string;
	name: RpcCommandType;
	version: number;
	scope: RpcCommandScope;
	execution: RpcCommandExecution;
	inputSchema?: RpcInputSchema;
	outputSchema?: RpcInputSchema;
	concurrencyClass?: RpcCommandConcurrencyClass;
	confirmation: RpcCommandConfirmation;
	requiredFeatures: string[];
}

export type RpcCommandCapability = RpcCommandCapabilityBase &
	(
		| { availability: "available" | "conditional"; disabledReason?: never }
		| { availability: "unavailable"; disabledReason: RpcCapabilityDisabledReason }
	);

export interface RpcCapabilityManifest {
	applicationApiVersion: number;
	commands: RpcCommandCapability[];
	events: RpcEventType[];
	extensionUiMethods: RpcExtensionUIMethod[];
	hostProtocols: string[];
	/** Present only when the host implements the explicitly negotiated omp.session semantic profile. */
	sessionHost?: SessionHostManifest;
}

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: [1, 2];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
	/** Present on servers with application-level capability discovery. */
	capabilities?: RpcCapabilityManifest;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export interface RpcSessionInfoResult {
	session: SessionCatalogEntry;
	workspace: SessionWorkspace;
	active: boolean;
}
export interface RpcSessionTreeResult {
	sessionId: string;
	leafId: string | null;
	roots: SessionCatalogTreeNode[];
}

export interface RpcSelectSessionLeafResult {
	cancelled: boolean;
	leafId: string | null;
}

export interface RpcResetSessionResult {
	droppedCount: number;
}

export interface RpcResumeSessionResult {
	cancelled: boolean;
	sessionFile?: string;
	cwd: string;
	cwdChanged: boolean;
}

export interface RpcForkSessionResult {
	cancelled: boolean;
	sessionFile?: string;
}

export interface RpcRenameSessionResult {
	renamed: boolean;
	active: boolean;
}

export interface RpcDeleteSessionResult {
	deleted: boolean;
	cancelled: boolean;
	wasActive: boolean;
	newSessionStarted: boolean;
	deleteError?: { code: "delete_failed"; message: string };
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
	/** True once the projected lifecycle is terminal; terminal rows remain queryable in a bounded ring. */
	terminal: boolean;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

export type RpcAgentSnapshot = AgentControlSnapshot;
export type RpcAgentResult = AgentControlResult;
export type RpcAgentSendResult = AgentControlSendResult;
export type RpcAgentReleaseResult = AgentControlReleaseResult;

export interface RpcAgentRegistryUpdateFrame extends AgentControlRegistryUpdate {
	type: "agent_registry_update";
}

export interface RpcSessionObservationFrame {
	type: "session_observation";
	subscriptionId: string;
	observation: SessionObservation;
}

export interface RpcSessionOpenResult {
	subscriptionId: string;
	snapshot?: SessionSnapshot;
	durableCursor?: SessionJournalCursor;
	watermark?: SessionObservationPosition;
	replayComplete: true;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Protocol
	| {
			id?: string;
			type: "response";
			command: "negotiate_protocol";
			success: true;
			data: { protocolVersion: 2 };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_capabilities";
			success: true;
			data: RpcCapabilityManifest;
	  }
	| {
			id?: string;
			type: "response";
			command: "initialize";
			success: true;
			data: SessionHostNegotiationResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "session_open";
			success: true;
			data: RpcSessionOpenResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "context_get";
			success: true;
			data: RpcContextGetResult;
	  }
	| { id?: string; type: "response"; command: "ui_open"; success: true; data: RpcUiSnapshot }
	| { id?: string; type: "response"; command: "ui_close"; success: true }
	| { id?: string; type: "response"; command: "ui_input"; success: true; data: RpcUiInputResult }
	| { id?: string; type: "response"; command: "ui_editor_update"; success: true; data: RpcUiEditorState }
	| { id?: string; type: "response"; command: "ui_editor_paste"; success: true; data: RpcUiEditorState }
	| {
			id?: string;
			type: "response";
			command: "ui_autocomplete_suggest";
			success: true;
			data: RpcUiAutocompleteResult | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "ui_autocomplete_apply";
			success: true;
			data: RpcUiAutocompleteApplyResult;
	  }
	| { id?: string; type: "response"; command: "ui_cancel"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "ui_presentation_input";
			success: true;
			data: RpcUiPresentationInputResult;
	  }
	| { id?: string; type: "response"; command: "ui_presentation_action"; success: true }
	| {
			id?: string;
			type: "response";
			command: "ui_theme_list";
			success: true;
			data: { themes: RpcUiThemeInfo[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "ui_theme_get";
			success: true;
			data: { theme: RpcUiThemeInfo | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "ui_theme_set";
			success: true;
			data: { theme: RpcUiThemeInfo };
	  }
	| {
			id?: string;
			type: "response";
			command: "ui_tools_expanded_set";
			success: true;
			data: { expanded: boolean; revision: number };
	  }
	| {
			id?: string;
			type: "response";
			command: "ui_title_subscribe";
			success: true;
			data: { subscribed: boolean; title: string; revision: number };
	  }
	| { id?: string; type: "response"; command: "session_ack"; success: true }
	| { id?: string; type: "response"; command: "session_unsubscribe"; success: true }
	| {
			id?: string;
			type: "response";
			command: "session_invoke";
			success: true;
			data: SessionCommandOutcome;
	  }
	| {
			id?: string;
			type: "response";
			command: "session_shutdown";
			success: true;
			data: SessionAuthoritySettlement;
	  }
	| {
			id?: string;
			type: "response";
			command: "semantic_action";
			success: true;
			data: RpcSemanticActionSettledFrame;
	  }
	| {
			id?: string;
			type: "response";
			command: "semantic_cancel";
			success: true;
			data: { cancelled: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "artifact_describe";
			success: true;
			data: ArtifactDescriptor;
	  }
	| {
			id?: string;
			type: "response";
			command: "artifact_read";
			success: true;
			data: ArtifactRange;
	  }
	| {
			id?: string;
			type: "response";
			command: "artifact_export";
			success: true;
			data: ArtifactExportResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "resource_list";
			success: true;
			data: RpcResourceLifecycleSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "resource_refresh" | "resource_reload";
			success: true;
			data: { operationId: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "resource_cancel";
			success: true;
			data: { cancelled: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "resource_dispose";
			success: true;
			data: RpcResourceServerSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "provenance_get";
			success: true;
			data: RpcProvenanceSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command:
				| "collaboration_get"
				| "collaboration_host"
				| "collaboration_join"
				| "collaboration_leave"
				| "collaboration_revoke"
				| "collaboration_rotate";
			success: true;
			data: RpcCollaborationSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "collaboration_acknowledge";
			success: true;
			data: { acknowledged: number; retained: number };
	  }
	| {
			id?: string;
			type: "response";
			command: "collaboration_read_media";
			success: true;
			data: RpcCollaborationMediaRange;
	  }

	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; data: RpcOperationAccepted }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true; data: RpcOperationAccepted }
	| {
			id?: string;
			type: "response";
			command: "cancel_operation";
			success: true;
			data: RpcCancelOperationResult;
	  }
	| { id?: string; type: "response"; command: "eval_execute"; success: true; data: RpcOperationAccepted }
	| {
			id?: string;
			type: "response";
			command: "get_eval_history";
			success: true;
			data: { entries: RpcEvalHistoryEntry[] };
	  }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "set_mode"; success: true; data: RpcModeChangeResult }
	| { id?: string; type: "response"; command: "get_plan"; success: true; data: RpcPlanState }
	| {
			id?: string;
			type: "response";
			command: "resolve_plan_approval";
			success: true;
			data: RpcOperationAccepted;
	  }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "get_operations"; success: true; data: RpcOperationsSnapshot }
	| { id?: string; type: "response"; command: "get_advisor_state"; success: true; data: RpcAdvisorState }
	| { id?: string; type: "response"; command: "set_advisor_enabled"; success: true; data: RpcAdvisorState }
	| { id?: string; type: "response"; command: "get_tool_inventory"; success: true; data: ToolInventory }
	| {
			id?: string;
			type: "response";
			command: "set_tool_activation";
			success: true;
			data: RpcToolActivationResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "list_provider_auth";
			success: true;
			data: { providers: RpcProviderAuthState[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "begin_provider_auth";
			success: true;
			data: RpcOperationAccepted;
	  }
	| {
			id?: string;
			type: "response";
			command: "cancel_provider_auth";
			success: true;
			data: RpcCancelOperationResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "remove_provider_auth";
			success: true;
			data: { state: RpcProviderAuthState };
	  }
	| {
			id?: string;
			type: "response";
			command: "list_provider_auth";
			success: true;
			data: { providers: RpcProviderAuthState[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "begin_provider_auth";
			success: true;
			data: RpcOperationAccepted;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; active: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| { id?: string; type: "response"; command: "checkpoint_control"; success: true; data: RpcCheckpointControlResult }
	| { id?: string; type: "response"; command: "loop_control"; success: true; data: RpcLoopControlResult }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "todo_apply"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "goal_control"; success: true; data: RpcGoalControlResult }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }
	| { id?: string; type: "response"; command: "get_queue"; success: true; data: SessionQueueSnapshot }
	| {
			id?: string;
			type: "response";
			command: "queue_insert";
			success: true;
			data: { entry: SessionQueueEntry; queue: SessionQueueSnapshot };
	  }
	| {
			id?: string;
			type: "response";
			command: "queue_update";
			success: true;
			data: { entry: SessionQueueEntry; queue: SessionQueueSnapshot };
	  }
	| { id?: string; type: "response"; command: "queue_move"; success: true; data: SessionQueueSnapshot }
	| {
			id?: string;
			type: "response";
			command: "remove_queued_message";
			success: true;
			data: { removed: { text: string; images?: ImageContent[] }; queue: SessionQueueSnapshot };
	  }
	| {
			id?: string;
			type: "response";
			command: "reorder_queued_message";
			success: true;
			data: SessionQueueSnapshot;
	  }
	| { id?: string; type: "response"; command: "clear_queue"; success: true; data: SessionQueueClearResult }
	| { id?: string; type: "response"; command: "list_jobs"; success: true; data: RpcJobListResult }
	| { id?: string; type: "response"; command: "get_job"; success: true; data: { job: JobSnapshot | null } }
	| {
			id?: string;
			type: "response";
			command: "cancel_job";
			success: true;
			data: { outcomes: CancelOutcome[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "list_agents";
			success: true;
			data: { agents: RpcAgentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_agent";
			success: true;
			data: { agent: RpcAgentSnapshot };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_agent_result";
			success: true;
			data: RpcAgentResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "send_agent_message";
			success: true;
			data: RpcAgentSendResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "park_agent" | "resume_agent";
			success: true;
			data: { agent: RpcAgentSnapshot };
	  }
	| {
			id?: string;
			type: "response";
			command: "cancel_agent";
			success: true;
			data: { id: string; status: "cancelled" | "not_found" | "already_completed"; message: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "release_agent";
			success: true;
			data: RpcAgentReleaseResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "start_agent";
			success: true;
			data: { agentIds: string[]; jobId?: string };
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: {
				models: Model[];
				usageOrder?: string[];
				roles?: Array<{ role: string; provider: string; id: string; autoSelected: boolean }>;
				thinkingOptions?: Array<{
					provider: string;
					id: string;
					levels: ConfiguredThinkingLevel[];
				}>;
			};
	  }
	| { id?: string; type: "response"; command: "set_model_role"; success: true; data: RpcModelRoleResult }
	| { id?: string; type: "response"; command: "set_service_tier"; success: true; data: RpcServiceTierResult }
	| {
			id?: string;
			type: "response";
			command: "get_settings";
			success: true;
			data: SettingsSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_settings";
			success: true;
			data: SettingsSnapshot;
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ConfiguredThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "retry"; success: true; data: { retried: boolean } }
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "list_sessions"; success: true; data: SessionCatalogPage }
	| { id?: string; type: "response"; command: "get_session_info"; success: true; data: RpcSessionInfoResult }
	| { id?: string; type: "response"; command: "get_session_tree"; success: true; data: RpcSessionTreeResult }
	| {
			id?: string;
			type: "response";
			command: "select_session_leaf";
			success: true;
			data: RpcSelectSessionLeafResult;
	  }
	| { id?: string; type: "response"; command: "reset_session"; success: true; data: RpcResetSessionResult }
	| {
			id?: string;
			type: "response";
			command: "list_workspace_roots";
			success: true;
			data: { roots: SessionWorkspaceRoot[] };
	  }
	| { id?: string; type: "response"; command: "resume_session"; success: true; data: RpcResumeSessionResult }
	| { id?: string; type: "response"; command: "fork_session"; success: true; data: RpcForkSessionResult }
	| { id?: string; type: "response"; command: "rename_session"; success: true; data: RpcRenameSessionResult }
	| { id?: string; type: "response"; command: "delete_session"; success: true; data: RpcDeleteSessionResult }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "get_messages_page"; success: true; data: RpcMessagesPage }

	// Error response (any command can fail); `code` is an optional machine-readable reason.
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			code?: string;
			data?: object;
	  };

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

export type RpcSessionEventFrame = AgentSessionEvent | RpcSubagentFrame | RpcAgentRegistryUpdateFrame;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

export type RpcInteractiveMethod = "select" | "confirm" | "input" | "editor" | "approval" | "ask";

export interface RpcPendingInteractionSnapshot {
	id: string;
	method: RpcInteractiveMethod;
	startedAt: number;
	title?: string;
	operationId?: string;
	sensitive: boolean;
	toolCallId?: string;
	toolName?: string;
}

export type RpcInteractionOutcome =
	| { state: "accepted"; provenance: "user" | "host"; decision?: "approve" | "deny" }
	| { state: "cancelled" }
	| { state: "timed_out" }
	| { state: "unsupported"; message: string }
	| { state: "failed"; message: string }
	| { state: "disconnected"; message: string };

export interface RpcInteractionSettledFrame {
	type: "interaction_settled";
	id: string;
	method: RpcInteractiveMethod;
	operationId?: string;
	outcome: RpcInteractionOutcome;
}

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "confirm";
			title: string;
			message: string;
			timeout?: number;
			/** Server-issued correlation for privileged RPC mutations. */
			operationId?: string;
			command?:
				| "cancel_agent"
				| "release_agent"
				| "eval_execute"
				| "bash"
				| "cancel_job"
				| "delete_session"
				| "remove_provider_auth";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
			sensitive?: boolean;
			operationId?: string;
			purpose?: "provider_auth";
			providerId?: string;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "approval";
			title: string;
			toolCallId: string;
			toolName: string;
			operation: "read" | "write" | "exec";
			approvalMode: "always-ask" | "write" | "yolo";
			resolvedPolicy: "prompt";
			policySource?: "tool" | "user" | "mode";
			declarationPolicy?: "allow" | "deny" | "prompt";
			escalationReason?: string;
			providerSafety: { required: boolean; checks: string[] };
			choices: readonly ["Approve", "Deny"];
			defaultChoice: "Deny";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "ask";
			questions: ExtensionAskDialogQuestion[];
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "progress";
			message?: string;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
	  };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean; operationId?: string }
	| {
			type: "extension_ui_response";
			id: string;
			decision: "approve" | "deny";
			operationId?: string;
			provenance?: "user";
	  }
	| { type: "extension_ui_response"; id: string; result: ExtensionAskDialogResult }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

type RpcManifestEvent =
	| RpcReadyFrame
	| RpcPromptResultFrame
	| RpcAvailableCommandsUpdateFrame
	| RpcAgentRegistryUpdateFrame
	| RpcToolInventoryUpdateFrame
	| RpcEvalOutputFrame
	| RpcEvalCompleteFrame
	| RpcOperationStartedFrame
	| RpcOperationTerminalFrame
	| RpcPlanStateUpdateFrame
	| RpcPlanApprovalRequestFrame
	| RpcPlanApprovalSettledFrame
	| RpcProviderAuthRequestFrame
	| RpcProviderAuthUpdateFrame
	| RpcSessionEventFrame
	| RpcSessionObservationFrame
	| RpcExtensionUIRequest
	| RpcSettingsUpdateFrame
	| RpcQueueUpdateFrame
	| RpcJobUpdateFrame
	| RpcLoopStateUpdateFrame
	| RpcLoopErrorFrame
	| RpcInteractionSettledFrame
	| RpcHostToolCallRequest
	| RpcHostToolCancelRequest
	| RpcHostUriRequest
	| RpcHostUriCancelRequest
	| RpcSemanticContentFrame
	| RpcSemanticActionRequestedFrame
	| RpcSemanticActionSettledFrame
	| RpcResourceLifecycleFrame
	| RpcProvenanceFrame
	| RpcCollaborationFrame
	| RpcUiFrame
	| {
			type:
				| "command_output"
				| "session_info_update"
				| "config_update"
				| "extension_error"
				| "notice"
				| "goal_updated";
	  };

function eventInventory<const T extends readonly RpcManifestEvent["type"][]>(
	events: T & (Exclude<RpcManifestEvent["type"], T[number]> extends never ? unknown : never),
): T {
	return events;
}

/** Event names advertised by capability discovery, exhaustively linked to RPC output event discriminants. */
export const RPC_EVENT_TYPES = eventInventory([
	"ready",
	"prompt_result",
	"available_commands_update",
	"session_observation",
	"tool_inventory_update",
	"eval_output",
	"eval_complete",
	"queue_update",
	"job_update",
	"loop_state_update",
	"loop_error",
	"interaction_settled",
	"semantic_content",
	"semantic_action_requested",
	"semantic_action_settled",
	"resource_lifecycle",
	"resource_operation",
	"provenance_update",
	"collaboration_state",
	"collaboration_replicated",
	"collaboration_gap",
	"collaboration_stale",
	"operation_started",
	"operation_completed",
	"operation_failed",
	"operation_cancelled",
	"plan_state_update",
	"plan_approval_request",
	"plan_approval_settled",
	"provider_auth_request",
	"provider_auth_update",
	"command_output",
	"session_info_update",
	"config_update",
	"settings_update",
	"extension_ui_request",
	"extension_error",
	"host_tool_call",
	"host_tool_cancel",
	"host_uri_request",
	"host_uri_cancel",
	"subagent_lifecycle",
	"agent_registry_update",
	"subagent_progress",
	"subagent_event",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"credential_rotated",
	"model_changed",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"goal_updated",
	"ui_channel_settled",
	"ui_editor_update",
	"ui_presentation_update",
	"ui_presentation_remove",
	"ui_theme_update",
	"ui_title_update",
	"ui_tools_expanded_update",
] as const);

export type RpcEventType = (typeof RPC_EVENT_TYPES)[number];
export type RpcExtensionUIMethod = RpcExtensionUIRequest["method"];

function extensionUiMethodInventory<const T extends readonly RpcExtensionUIMethod[]>(
	methods: T & (Exclude<RpcExtensionUIMethod, T[number]> extends never ? unknown : never),
): T {
	return methods;
}

/** Extension UI method inventory, exhaustively linked to RpcExtensionUIRequest. */
export const RPC_EXTENSION_UI_METHODS = extensionUiMethodInventory([
	"select",
	"confirm",
	"input",
	"editor",
	"approval",
	"ask",
	"cancel",
	"notify",
	"setStatus",
	"setWidget",
	"progress",
	"setTitle",
	"set_editor_text",
	"open_url",
] as const);
// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
