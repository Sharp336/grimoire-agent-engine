/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { isPromise } from "node:util/types";

import type { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	AgentBusyError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCall,
	type AgentToolContext,
	type AgentToolResult,
	type AgentTurnEndContext,
	AppendOnlyContextManager,
	type AsideMessage,
	resolveTelemetry,
	type StreamFn,
	TERMINAL_TOOL_RESULT_ABORT_REASON,
	type ThinkingLevel,
	type ToolChoiceDirective,
} from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculatePromptTokens,
	collectEntriesForBranchSummary,
	estimateTokens,
	generateBranchSummary,
	type ShakeConfig,
} from "@oh-my-pi/pi-agent-core/compaction";
import type {
	AssistantMessage,
	CodexCompactionContext,
	ImageContent,
	Message,
	Model,
	ModelUsageHealth,
	ProviderSessionState,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import { deriveClaudeDeviceId, type Effort, streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { resetOpenAICodexHistoryAfterCompaction } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { MacOSPowerAssertion } from "@oh-my-pi/pi-natives";
import {
	escapeXmlText,
	formatDuration,
	getAgentDbPath,
	getInstallId,
	isBunTestRuntime,
	isEnoent,
	isInteractiveHost,
	isRecord,
	logger,
	postmortem,
	prompt,
	Snowflake,
	stringProperty,
	withTimeout,
} from "@oh-my-pi/pi-utils";
import type { AdvisorConfig, AdvisorRuntimeStatus } from "../advisor";
import { type AsyncJob, AsyncJobManager } from "../async";
import { shouldEnableAppendOnlyContext } from "../config/append-only-context-mode";
import type { ModelRegistry } from "../config/model-registry";
import { type ResolvedModelRoleValue, resolveModelOverride } from "../config/model-resolver";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import { buildServiceTierByFamily } from "../config/service-tier";
import type { Settings, SkillsSettings } from "../config/settings";
import { onAppendOnlyModeChanged, onModelRolesChanged } from "../config/settings";
import { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { getFileSnapshotStore } from "../edit/file-snapshot-store";
import type { PythonResult } from "../eval/py/executor";
import type { BashResult } from "../exec/bash-executor";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type {
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeBranchResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionStopEventResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensibility/extensions";
import { emitSessionShutdownEvent } from "../extensibility/extensions";
import { ManagedTimers } from "../extensibility/extensions/managed-timers";
import { createExtensionModelQuery } from "../extensibility/extensions/model-api";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import type { HookCommandContext } from "../extensibility/hooks/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { GoalRuntime } from "../goals/runtime";
import type { GoalModeState } from "../goals/state";
import type { HindsightSessionState } from "../hindsight/state";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import type { IrcMessage } from "../irc/bus";
import { shutdownMnemopiEmbedClient } from "../mnemopi/embed-client";
import { getMnemopiSessionState, type MnemopiSessionState, setMnemopiSessionState } from "../mnemopi/state";
import { containsOrchestrate, ORCHESTRATE_NOTICE } from "../modes/orchestrate";
import { theme } from "../modes/theme/theme";
import { parseTurnBudget } from "../modes/turn-budget";
import { containsUltrathink, ULTRATHINK_NOTICE } from "../modes/ultrathink";
import { computeNonMessageTokens } from "../modes/utils/context-usage";
import { containsWorkflow, renderWorkflowNotice } from "../modes/workflow";
import { type PlanApprovalDetails, resolveApprovedPlan } from "../plan-mode/approved-plan";
import { listPlanFiles, readPlanFile } from "../plan-mode/plan-files";
import type { PlanModeState } from "../plan-mode/state";
import goalModeContextPrompt from "../prompts/goals/goal-mode-context.md" with { type: "text" };
import goalTodoContextPrompt from "../prompts/goals/goal-todo-context.md" with { type: "text" };
import autoContinuePrompt from "../prompts/system/auto-continue.md" with { type: "text" };
import interruptedThinkingTemplate from "../prompts/system/interrupted-thinking.md" with { type: "text" };
import planModeActivePrompt from "../prompts/system/plan-mode-active.md" with { type: "text" };
import planModeReferencePrompt from "../prompts/system/plan-mode-reference.md" with { type: "text" };
import planModeToolDecisionReminderPrompt from "../prompts/system/plan-mode-tool-decision-reminder.md" with {
	type: "text",
};
import rewindReportTemplate from "../prompts/system/rewind-report.md" with { type: "text" };
import sideChannelNoToolsReminder from "../prompts/system/side-channel-no-tools.md" with { type: "text" };
import vibeModeActivePrompt from "../prompts/system/vibe-mode-active.md" with { type: "text" };
import {
	deobfuscateAssistantContent,
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateProviderContext,
	type SecretObfuscator,
} from "../secrets/obfuscator";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	parseConfiguredThinkingLevel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";
import { shutdownTinyTitleClient } from "../tiny/title-client";
import { type AskToolDetails, type AskToolInput, recoverAskQuestions } from "../tools/ask";
import { releaseTabsForOwner } from "../tools/browser/tab-supervisor";
import type { CheckpointState, CompletedRewindState } from "../tools/checkpoint";
import { releaseComputerSessionsForOwner } from "../tools/computer/supervisor";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";
import {
	buildResolveReminderMessage,
	isPreviewResolutionToolCall,
	isProposeToolCall,
	type PlanProposalHandler,
	PROPOSE_DEVICE_NAME,
	writeDeviceDispatch,
} from "../tools/resolve";
import type { TodoPhase } from "../tools/todo";
import { ToolError } from "../tools/tool-errors";
import { parseCommandArgs } from "../utils/command-args";
import type { EditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions";
import { normalizeModelContextImages } from "../utils/image-loading";
import { generateSessionTitle } from "../utils/title-generator";
import { buildNamedToolChoice, isToolChoiceActive } from "../utils/tool-choice";
import type { VibeModeState } from "../vibe/state";
import type { AgentSessionEvent, AgentSessionEventListener } from "./agent-session-events";
import type {
	AgentSessionConfig,
	AgentSessionDisposeOptions,
	AsyncJobSnapshot,
	CommandMetadataChangedListener,
	ContextUsageBreakdown,
	FollowUpOptions,
	FreshSessionResult,
	HandoffResult,
	ModelCycleResult,
	Prewalk,
	PromptOptions,
	ResolvedRoleModel,
	RestoredQueuedMessage,
	RoleModelCycle,
	RoleModelCycleResult,
	SessionHandoffOptions,
	SessionOAuthAccountList,
	SessionStats,
	UsageFallbackConfirmation,
} from "./agent-session-types";
import {
	ASYNC_INLINE_RESULT_MAX_CHARS,
	ASYNC_PREVIEW_MAX_CHARS,
	ASYNC_RESULT_MESSAGE_TYPE,
	type AsyncResultEntry,
	buildAsyncResultBatchMessage,
} from "./async-job-delivery";
import type { AuthStorage } from "./auth-storage";
import { BashRunner, type BashRunnerHost } from "./bash-runner";
import {
	checkpointStartedAtFromEntry,
	completedRewindFromEntry,
	isSuccessfulCheckpointEntry,
	semanticToolResult,
} from "./checkpoint-entries";
import type { ClientBridge } from "./client-bridge";
import {
	type CodexAutoRedeemRedeemDecision,
	defaultCodexAutoRedeemCoordinator,
	evaluateCodexAutoRedeem,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "./codex-auto-reset";
import { EvalRunner, type EvalRunnerHost } from "./eval-runner";
import {
	collectPendingToolCalls,
	createInterruptedTurnAbortMessage,
	SESSION_EXIT_CUSTOM_TYPE,
	type SessionExitData,
	summarizeToolArguments,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "./exit-diagnostics";
import { IrcBridge, type IrcBridgeHost } from "./irc-bridge";
import {
	type BashExecutionMessage,
	buildReplanTitleContext,
	type CustomMessage,
	type CustomMessagePayload,
	convertToLlm,
	dedupeEphemeralReply,
	demoteInterruptedThinking,
	didSessionMessagesChange,
	type FileMentionMessage,
	type HookMessage,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	type InterruptedThinkingDetails,
	isEmptyErrorTurn,
	isUserInterruptAbort,
	logProviderTurnError,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	SILENT_ABORT_MARKER,
	SKILL_PROMPT_MESSAGE_TYPE,
	sanitizeAssistantForReparentedHistory,
	USER_INTERRUPT_LABEL,
} from "./messages";
import { ModelControls, type ModelControlsHost } from "./model-controls";
import { PrewalkCoordinator, type PrewalkCoordinatorHost } from "./prewalk";
import {
	isAdvisorCard,
	isDisplayableQueuedMessage,
	isHiddenUserCompanion,
	isUserQueuedMessage,
	queueChipText,
	toRestoredQueuedMessage,
} from "./queued-messages";
import { formatRetryFallbackSelector, type RetryFallbackSelector } from "./retry-fallback-chains";
import { type AdvisorStats, SessionAdvisors, type SessionAdvisorsHost } from "./session-advisors";
import type { BuildSessionContextOptions, SessionContext } from "./session-context";
import { getRestorableSessionModels } from "./session-context";
import { formatSessionDumpText } from "./session-dump-format";
import type { BranchSummaryEntry, NewSessionOptions } from "./session-entries";
import { SessionHandoff, type SessionHandoffHost } from "./session-handoff";
import {
	COMPACTION_CHECK_NONE,
	createCodexCompactionContext as createMaintenanceCodexCompactionContext,
	SessionMaintenance,
	type SessionMaintenanceHost,
} from "./session-maintenance";
import { cleanupEmptyMoveSession, type SessionManager } from "./session-manager";
import { SessionMemory, type SessionMemoryHost } from "./session-memory";
import { SessionProviderBoundary, type SessionProviderBoundaryHost } from "./session-provider-boundary";
import { SessionStatsTracker, type SessionStatsTrackerHost } from "./session-stats";
import { SessionTools, type SessionToolsHost } from "./session-tools";
import { formatShakeSummary, type ShakeMode, type ShakeResult } from "./shake-types";
import { ToolChoiceQueue } from "./tool-choice-queue";
import { planTurnPersistence, sameMessageContent, sessionMessagePersistenceKey } from "./turn-persistence";
import { TurnRecovery, type TurnRecoveryHost } from "./turn-recovery";
import { YieldQueue } from "./yield-queue";

export * from "./agent-session-events";
export * from "./agent-session-types";
export type { AdvisorStats, PerAdvisorStat } from "./session-advisors";

const SESSION_STOP_CONTINUATION_CAP = 8;

import { LoopGuards, type StreamGuardsHost, StreamingEditGuard } from "./stream-guards";
import { TodoTracker, type TodoTrackerHost } from "./todo-tracker";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "./ttsr-coordinator";

const PLAN_MODE_REMINDER_MAX = 3;

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */

/**
 * Build the per-request `metadata` payload for the Anthropic provider, shaped
 * like real Claude Code's `getAPIMetadata` output (`{ session_id, account_uuid,
 * device_id }`) so the backend buckets requests under one session and attributes
 * them to the authenticated OAuth account when available. Resolved at request
 * time so token refreshes and login/logout transitions don't strand a stale
 * account UUID in memory. `account_uuid` and `device_id` are omitted for
 * non-Anthropic providers to avoid leaking the user's Claude identity to
 * third-party APIs (including Anthropic-format-compatible proxies such as
 * cloudflare-ai-gateway or gitlab-duo).
 *
 * `provider` is the target provider string (e.g. `"anthropic"`) and gates the
 * `account_uuid` and `device_id` lookups — only `"anthropic"` requests carry them.
 *
 * `sessionId` is forwarded to the auth-storage session-sticky lookup so that
 * multi-credential setups attribute to the same OAuth account used for the
 * actual API request rather than always picking the first credential.
 *
 * `authStorage` is treated as optional so test fixtures that stub `modelRegistry`
 * without a real storage layer still work; the resolver simply skips the lookup
 * and emits `{ session_id }` alone, matching the no-OAuth-credential path.
 */
function buildSessionMetadata(
	sessionId: string,
	provider: string,
	authStorage: AuthStorage | undefined,
): Record<string, unknown> {
	const userId: Record<string, string> = { session_id: sessionId };
	// Only look up account_uuid when the request is going to Anthropic. Injecting
	// a Claude OAuth account_uuid into requests bound for other providers (including
	// Anthropic-format-compatible proxies like cloudflare-ai-gateway or gitlab-duo)
	// would leak the user's Anthropic identity to unrelated third-party APIs.
	if (provider === "anthropic") {
		const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId);
		if (typeof accountUuid === "string" && accountUuid.length > 0) {
			userId.account_uuid = accountUuid;
			// Claude Code's `device_id` is a stable 64-hex account-scoped install
			// identifier. Include both omp's persistent install id and the Claude
			// account UUID so two accounts on the same install do not share a device.
			userId.device_id = deriveClaudeDeviceId(getInstallId(), accountUuid);
		}
	}
	return { user_id: JSON.stringify(userId) };
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: _theme => Promise.resolve({ success: false, error: "UI not available" }),
	setFooter: () => {},
	setHeader: () => {},
	setEditorComponent: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

// ============================================================================
// AgentSession Class
// ============================================================================

type MessageEndPersistenceSlot = {
	readonly promise: Promise<void>;
	persist: (persistMessage: () => void) => Promise<void>;
	release: () => void;
};

type PostPromptSkipReason = "aborted" | "stale-generation";

type AgentContinueSkipReason =
	| PostPromptSkipReason
	| "session-unavailable"
	| "should-continue-false"
	| "post-restore-unavailable";

type ScheduledAgentContinueOptions = {
	delayMs?: number;
	generation?: number;
	shouldContinue?: () => boolean;
	onSkip?: (reason: AgentContinueSkipReason) => void;
	onError?: () => void;
};

type SessionTitleSource = "auto" | "user";
type SessionNameTrigger = "replan";
type SetSessionNameWithTrigger = (
	name: string,
	source?: SessionTitleSource,
	trigger?: SessionNameTrigger,
) => Promise<boolean>;

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	/** Entries of tools mounted under `xd://`; empty when virtual devices are unmounted. */
	getXdevToolEntries: () => Array<{ name: string; summary: string }>;
	readonly yieldQueue: YieldQueue;
	fileSnapshotStore?: InMemorySnapshotStore;

	#powerAssertion: MacOSPowerAssertion | undefined;

	readonly configWarnings: string[] = [];

	readonly #models: ModelControls;
	readonly #tools: SessionTools;
	readonly #prewalk: PrewalkCoordinator;

	readonly #providerBoundary: SessionProviderBoundary;
	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];

	// Event subscription state
	#unsubscribeAgent?: () => void;
	#cancelExitRecorder?: () => void;
	#exitRecorded = false;
	#unsubscribeAppendOnly?: () => void;
	#unsubscribeModelRoles?: () => void;
	/** Last (enable, providerId) tuple resolved by `#syncAppendOnlyContext` — used to skip no-op invalidations. */
	#lastAppendOnlyResolution?: { enable: boolean; providerId: string | undefined };
	#eventListeners: AgentSessionEventListener[] = [];
	#commandMetadataChangedListeners: CommandMetadataChangedListener[] = [];

	/** Messages queued to be included with the next user prompt as context ("asides"). */
	#pendingNextTurnMessages: CustomMessage[] = [];
	#scheduledHiddenNextTurnGeneration: number | undefined = undefined;
	#queuedMessageDrainScheduled = false;
	#planModeState: PlanModeState | undefined;
	#vibeModeState: VibeModeState | undefined;
	#goalModeState: GoalModeState | undefined;
	#goalRuntime: GoalRuntime;
	readonly #advisors: SessionAdvisors;
	#goalTurnCounter = 0;
	#planReferenceSent = false;
	#planReferencePath = "local://PLAN.md";
	#clientBridge: ClientBridge | undefined;
	#allowAcpAgentInitiatedTurns = false;
	/** Session file created by this session's `/move`; removed on dispose if it stayed empty. */
	#movedFromEmptySessionFile?: string;

	readonly #maintenance: SessionMaintenance;

	// Periodic shake state (shake.interval setting)
	#shakeToolCallCounter = 0;
	#shakeNeedsAgentSync = false;
	#midRunShakeDue = false;
	#midRunShakeRunning = false;

	// Branch summarization state
	#branchSummaryAbortController: AbortController | undefined = undefined;

	readonly #handoff: SessionHandoff;

	// Retry state
	readonly #recovery: TurnRecovery;
	#planModeReminderCount = 0;
	#planModeReminderAwaitingProgress = false;
	readonly #todo: TodoTracker;
	#replanTitleRefreshInFlight: Promise<void> | undefined = undefined;
	/** Resolved TITLE_SYSTEM.md override applied to every automatic session-title
	 *  generation path. Refresh via {@link AgentSession.setTitleSystemPrompt} when
	 *  the session cwd changes. */
	#titleSystemPrompt: string | undefined;
	#titleGenerationAbortController = new AbortController();
	#toolChoiceQueue = new ToolChoiceQueue();

	readonly #bash: BashRunner;

	readonly #eval: EvalRunner;
	/**
	 * AsyncJobManager owned by this session (top-level only). Subagents leave
	 * this undefined and **MUST NOT** dispose the global instance on teardown.
	 */
	readonly #ownedAsyncJobManager: AsyncJobManager | undefined;
	/**
	 * AsyncJobManager scoped to this session for introspection/cancellation.
	 *
	 * This differs from `#ownedAsyncJobManager`: subagents can inherit a parent
	 * manager for their own owner id, while secondary top-level sessions are left
	 * undefined to avoid reading the primary's jobs.
	 */
	readonly #asyncJobManager: AsyncJobManager | undefined;
	/** Clears this session's owner delivery sink registration; set when a manager + agent id exist. */
	#unregisterAsyncDeliverySink: (() => void) | undefined;

	readonly #irc: IrcBridge;
	// Agent identity (registry id) used for IRC routing and job ownership.
	#agentId: string | undefined;
	#agentKind: "main" | "sub" = "main";
	#providerSessionId: string | undefined;
	#freshProviderSessionId: string | undefined;
	#inheritedProviderPromptCacheKey: string | undefined;
	#autolearnCaptureAbortController: AbortController | undefined;
	#autolearnCaptureTask: Promise<void> | undefined;
	#isDisposed = false;
	// Extension system
	#extensionRunner: ExtensionRunner | undefined = undefined;
	/**
	 * Backs `ctx.setInterval`/`setTimeout`/`clearTimer` for the runner-less
	 * command-context fallback (SDK embeddings with no extension runner). Lazily
	 * created; cleared on dispose alongside the runner's own timers (#5664).
	 */
	#fallbackExtensionTimers: ManagedTimers | undefined = undefined;
	#turnIndex = 0;
	#messageEndPersistenceTail: Promise<void> = Promise.resolve();
	#pendingMessageEndPersistence = new Map<string, Promise<void>>();
	#persistedMessageKeys: { anchor: string; keys: Set<string> } | undefined;

	// Custom commands (TypeScript slash commands)
	#customCommands: LoadedCustomCommand[] = [];
	/** MCP prompt commands (updated dynamically when prompts are loaded) */
	#mcpPromptCommands: LoadedCustomCommand[] = [];

	// Model registry for API key resolution
	#modelRegistry: ModelRegistry;
	#usageFallbackConfirmer: ((confirmation: UsageFallbackConfirmation) => Promise<boolean>) | undefined;
	#usageReserveApprovedSelector: string | undefined;
	#usagePreflightAbortControllers = new Set<AbortController>();

	#transformContext: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	#onPayload: SimpleStreamOptions["onPayload"] | undefined;
	#onResponse: SimpleStreamOptions["onResponse"] | undefined;
	#onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	#sideStreamFn: StreamFn;
	#preferWebsockets: boolean | undefined;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#disconnectOwnedMcpManager: (() => Promise<void>) | undefined;

	readonly #ttsr: TtsrCoordinator;
	readonly #stats: SessionStatsTracker;

	/** One-shot flag for expected internal plan-mode aborts. Approval actions may
	 *  abort the post-approval continuation before compaction, execution, or
	 *  manual refinement. Consumed inside `#handleAgentEvent` for the matching
	 *  `message_end` + `stopReason: "aborted"`; callers clear it in `finally` so
	 *  it cannot leak into later unrelated aborts. */
	#planInternalAbortPending = false;
	#pendingAbortErrorId?: number;

	#postPromptTasks = new Set<Promise<unknown>>();
	#postPromptTasksPromise: Promise<void> | undefined = undefined;
	#postPromptTasksResolve: (() => void) | undefined = undefined;
	#postPromptTasksAbortController = new AbortController();

	readonly #streamingEditGuard: StreamingEditGuard;
	readonly #loopGuards: LoopGuards;
	#promptInFlightCount = 0;
	#abortInProgress = false;
	// Wire-level agent_end emission deferred until #promptInFlightCount drops to 0.
	// Internal extension hooks and post-emit work (auto-retry, auto-compaction, todo
	// checks in #handleAgentEvent) still fire on the original schedule — only the
	// `#emit(event)` that reaches external subscribers (rpc-mode stdout, ACP bridge,
	// Cursor exec, TUI listeners) is held back. Without this, a client that resumes
	// on `agent_end` can fire its next `prompt` before #promptWithMessage's finally
	#promptGeneration = 0;
	#pendingAgentEndEmit: AgentSessionEvent | undefined;
	#sessionStopContinuationCount = 0;
	#sessionStopHookActive = false;
	#obfuscator: SecretObfuscator | undefined;
	/** Session-start value of `inlineToolDescriptors`; drives handoff tool pruning. */
	#pruneToolDescriptions = false;
	#checkpointState: CheckpointState | undefined = undefined;
	#pendingRewindReport: string | undefined = undefined;
	#lastCompletedRewind: CompletedRewindState | undefined = undefined;
	#rewoundToolResultIds = new Set<string>();
	#lastSuccessfulYieldToolCallId: string | undefined = undefined;
	/**
	 * Sticky across an in-flight prompt run: a successful `yield` makes the run
	 * terminal for execution purposes, so any trailing empty/aborted assistant
	 * stop must NOT trigger empty-stop/unexpected-stop/compaction continuations.
	 * Cleared before every new prompt turn so the next turn evaluates cleanly.
	 */
	#yieldTerminationPending = false;
	#synchronouslyTerminatedYieldToolCallIds = new Set<string>();
	#providerSessionState = new Map<string, ProviderSessionState>();
	#hindsightSessionState: HindsightSessionState | undefined = undefined;
	readonly #memory: SessionMemory;
	readonly rawSseDebugBuffer: RawSseDebugBuffer;

	#resetPromptMaintenanceState(): void {
		this.#recovery.resetForNewPrompt();
		this.#yieldTerminationPending = false;
	}

	#acquirePowerAssertion(): void {
		if (process.platform !== "darwin") return;
		if (isBunTestRuntime()) return;
		if (this.#powerAssertion) return;
		const mode = this.settings.get("power.sleepPrevention");
		if (mode === "off") return;
		try {
			this.#powerAssertion = MacOSPowerAssertion.start({
				reason: "Oh My Pi agent session",
				idle: true,
				display: mode === "display" || mode === "system",
				system: mode === "system",
				user: mode === "system",
			});
		} catch (error) {
			logger.warn("Failed to acquire macOS power assertion", { error: String(error) });
		}
	}

	#releasePowerAssertion(): void {
		const assertion = this.#powerAssertion;
		this.#powerAssertion = undefined;
		if (!assertion) return;
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: String(error) });
		}
	}

	#beginInFlight(): void {
		this.#promptInFlightCount++;
		if (this.#promptInFlightCount === 1) {
			this.#acquirePowerAssertion();
		}
	}

	#endInFlight(): void {
		this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1);
		if (this.#promptInFlightCount === 0) {
			this.#releasePowerAssertion();
			this.#flushPendingAgentEnd();
			this.#drainStrandedQueuedMessages();
		}
	}

	/** A steer/follow-up can land after the agent loop's final queue poll, or
	 *  after an abort stops an auto-continued queued turn. In both cases the
	 *  agent-core queue still owns the message, but no loop is left to poll it.
	 *  Runs whenever the session settles; the guard makes it a no-op when the
	 *  queue was consumed normally or a new turn already started. */
	#drainStrandedQueuedMessages(): void {
		if (this.#abortInProgress) return;
		// Session transitions (newSession/`/new`, compact, model-switch, session-switch,
		// dispose) call #disconnectFromAgent() BEFORE `await abort()`, so abort's own
		// finally lands here with no listener attached. Auto-resuming now would snapshot
		// the still-old context (the transition hasn't reached agent.reset() yet), start a
		// stale provider turn that races the reset, and — once reconnected — append its
		// output to the fresh session (issue #5800). A disconnected session never owns the
		// queue: the transition does. newSession/switchSession drop the queue (reset /
		// clearAllQueues), so nothing survives; compaction preserves it and re-drains itself
		// after #reconnectToAgent (see compact()'s finally); an explicit prompt flushes it
		// in every case.
		if (this.#unsubscribeAgent === undefined) return;
		// A concern steered into a resumed streaming run after a user interrupt can
		// strand at the turn tail (steered past the loop's final boundary poll). While
		// that interrupt's suppression is still in effect, reclaim such advisor steers
		// as visible advice once idle — mirroring abort's #extractQueuedAdvisorCards —
		// so they neither auto-resume the run the user stopped (a non-empty steer queue
		// otherwise bypasses the latch in #canAutoContinueForFollowUp) nor linger to
		// flush at the next prompt. Real user steers/follow-ups are left untouched.
		if (this.#advisors.autoResumeSuppressed && !this.isStreaming) {
			for (const card of this.#extractQueuedAdvisorCards()) {
				this.#preserveAdvisorCard(card);
			}
		}
		this.#scheduleQueuedMessageDrain();
		this.#resumeStrandedIrcAsides();
	}

	/** IRC records that arrive after the loop's final aside poll — or while an abort skipped that
	 *  poll — land in pending IRC queues with no loop left to drain them; the queued-message drain's
	 *  gate (agent.hasQueuedMessages()) does not count peer IRC interrupts. Once idle, wake a turn so
	 *  the agent responds to the peer. Skip only when a queued steer/follow-up will itself drive a
	 *  resume turn whose aside poll already consumes these (no double-wake). */
	#resumeStrandedIrcAsides(): void {
		if (this.#isDisposed || this.isStreaming || !this.#irc.hasPending()) return;
		if (this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages()) return;
		const records = this.#irc.drainPending();
		if (this.#planModeState?.enabled) {
			// Plan mode: fold stranded IRC asides into context without waking an
			// autonomous turn. Convergence to ask/resolve stays user-driven.
			for (const record of records) {
				this.agent.appendMessage(record);
				this.sessionManager.appendCustomMessageEntry(
					record.customType,
					record.content,
					record.display,
					record.details,
					record.attribution ?? "agent",
				);
			}
			return;
		}
		this.#wakeForIrc(records);
	}

	/** Fire-and-forget wake turn for incoming IRC — idle delivery and stranded-aside resume both
	 *  route here. Wrapped in #beginInFlight/#endInFlight so the turn is tracked and its settle
	 *  re-drains anything that stranded during it. A user interrupt may have intentionally left a
	 *  follow-up queued behind an invalid tail (seam #5); the wake turn's loop would otherwise drain
	 *  it, so park the follow-up queue across the wake and restore it after. It stays queued post-wake
	 *  because #canAutoContinueForFollowUp suppresses follow-up auto-resume while a user interrupt is
	 *  in effect, even though the wake left a provider-valid tail. */
	#wakeForIrc(records: CustomMessage[]): void {
		// Park only a *blocked* follow-up (one a user interrupt is intentionally holding); an
		// already-resumable follow-up can ride the wake turn normally without reordering.
		const parkedFollowUps =
			this.agent.peekSteeringQueue().length === 0 &&
			this.agent.peekFollowUpQueue().length > 0 &&
			!this.#canAutoContinueForFollowUp()
				? [...this.agent.peekFollowUpQueue()]
				: [];
		if (parkedFollowUps.length > 0) {
			this.agent.replaceQueues([...this.agent.peekSteeringQueue()], []);
		}
		this.#resetPromptMaintenanceState();
		this.#beginInFlight();
		void this.agent
			.prompt(records)
			.catch(error => {
				logger.warn("IRC wake turn failed", { error: String(error) });
			})
			.finally(() => {
				if (parkedFollowUps.length > 0) {
					this.agent.replaceQueues(
						[...this.agent.peekSteeringQueue()],
						[...parkedFollowUps, ...this.agent.peekFollowUpQueue()],
					);
				}
				this.#endInFlight();
			});
	}

	/** Remove advisor concern/blocker cards from the agent-core steer/follow-up
	 *  queues and return them. Used on a deliberate user interrupt so the post-abort
	 *  stranded-message drain cannot auto-resume the run on an advisor card that was
	 *  steered in just before the user stopped; real user follow-ups stay queued.
	 *  Synchronous and await-free so it runs before the abort path polls the queue. */
	#extractQueuedAdvisorCards(): CustomMessage[] {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const cards = [...steering, ...followUp].filter(isAdvisorCard);
		if (cards.length === 0) return [];
		this.agent.replaceQueues(
			steering.filter(m => !isAdvisorCard(m)),
			followUp.filter(m => !isAdvisorCard(m)),
		);
		return cards;
	}

	/** Record a suppressed advisor concern as visible, persisted advice without
	 *  triggering a turn. When the agent is idle (the normal post-interrupt case,
	 *  including the post-prompt unwind window where the core loop has ended), emit
	 *  message_start/message_end like #flushPendingIrcAsides so #handleAgentEvent
	 *  renders it live (TUI/ACP) and persists it as a CustomMessageEntry. Only while
	 *  an abort is still tearing a live turn down do we park it hidden, so abort's
	 *  settle step replays it once idle — never appended into a live streamMessage. */
	#preserveAdvisorCard(card: CustomMessage): void {
		if (this.#abortInProgress && this.isStreaming) {
			this.#pendingNextTurnMessages.push(card);
			return;
		}
		this.agent.emitExternalEvent({ type: "message_start", message: card });
		this.agent.emitExternalEvent({ type: "message_end", message: card });
	}

	#resetInFlight(): void {
		this.#promptInFlightCount = 0;
		this.#releasePowerAssertion();
		this.#flushPendingAgentEnd();
		this.#drainStrandedQueuedMessages();
	}

	#flushPendingAgentEnd(): void {
		const pending = this.#pendingAgentEndEmit;
		if (!pending) return;
		this.#pendingAgentEndEmit = undefined;
		this.#emit(pending);
	}

	/**
	 * Arm prewalk outside the normal startup path so an explicit slash command starts immediately.
	 */
	armPrewalk(target: Model, thinkingLevel?: ConfiguredThinkingLevel): void {
		this.#prewalk.arm(target, thinkingLevel);
	}

	/** Validate the active plan artifact and shape an `xd://propose` result for review-mode hosts. */
	async preparePlanForReview(title: string): Promise<AgentToolResult<PlanApprovalDetails>> {
		const state = this.getPlanModeState();
		if (!state?.enabled) {
			throw new ToolError("Plan mode is not active.");
		}
		const { planFilePath, title: resolvedTitle } = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url => this.#readPlanFile(url),
			listPlanFiles: () => this.#listPlanFiles(),
		});
		return {
			content: [{ type: "text", text: "Plan ready for review." }],
			details: { planFilePath, title: resolvedTitle, planExists: true },
		};
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		return readPlanFile(planFilePath, {
			localProtocolOptions: this.#localProtocolOptions(),
			cwd: this.sessionManager.getCwd(),
		});
	}

	/** `local://` URLs of plan files in the session-local root, newest first —
	 *  a fallback for `resolveApprovedPlan` when the agent dropped `extra.title`. */
	async #listPlanFiles(): Promise<string[]> {
		return listPlanFiles({ localProtocolOptions: this.#localProtocolOptions() });
	}

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settings = config.settings;
		this.#modelRegistry = config.modelRegistry;
		const bashHost: BashRunnerHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			extensionRunner: () => this.#extensionRunner,
			isStreaming: () => this.isStreaming,
		};
		this.#bash = new BashRunner(bashHost);
		// Power assertions are taken per turn (see #beginInFlight); nothing acquired here.
		const evalHost: EvalRunnerHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			extensionRunner: () => this.#extensionRunner,
			isStreaming: () => this.isStreaming,
			appendSessionMessage: message => {
				this.agent.appendMessage(message);
				this.sessionManager.appendMessage(message);
			},
		};
		this.#eval = new EvalRunner(evalHost, {
			kernelOwnerId: config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`,
			parentSessionId: config.parentEvalSessionId,
		});
		const ircHost: IrcBridgeHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			isDisposed: () => this.#isDisposed,
			isStreaming: () => this.isStreaming,
			planModeEnabled: () => this.#planModeState?.enabled === true,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			wakeForIrc: records => this.#wakeForIrc(records),
			runEphemeralTurn: args => this.runEphemeralTurn(args),
		};
		this.#irc = new IrcBridge(ircHost);
		const prewalkHost: PrewalkCoordinatorHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			model: () => this.model,
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			setModelTemporary: (model, thinkingLevel, options) => this.setModelTemporary(model, thinkingLevel, options),
			setActiveToolsByName: names => this.setActiveToolsByName(names),
			getActiveToolNames: () => this.getActiveToolNames(),
			getEnabledToolNames: () => this.getEnabledToolNames(),
			hasBuiltInTool: name => this.hasBuiltInTool(name),
			getPlanModeState: () => this.getPlanModeState(),
			setPlanModeState: state => this.setPlanModeState(state),
			getPlanReferencePath: () => this.getPlanReferencePath(),
			setPlanProposalHandler: handler => this.setPlanProposalHandler(handler),
			waitForSessionMessagePersistence: message => this.#waitForSessionMessagePersistence(message),
			localProtocolOptions: () => this.#localProtocolOptions(),
		};
		this.#prewalk = new PrewalkCoordinator(prewalkHost, {
			prewalk: config.prewalk,
			planYolo: config.planYolo,
		});
		const todoHost: TodoTrackerHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			model: () => this.model,
			agentKind: () => this.#agentKind,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			promptGeneration: () => this.#promptGeneration,
			hasPendingAsyncWake: () => this.#hasPendingAsyncWake(),
			getActiveToolNames: () => this.getActiveToolNames(),
			toolRegistry: () => this.#tools.registry,
			planModeEnabled: () => this.#planModeState?.enabled === true,
			consumeLastServedToolChoiceLabel: () => this.#toolChoiceQueue.consumeLastServedLabel(),
		};
		this.#todo = new TodoTracker(todoHost);
		this.#ownedAsyncJobManager = config.ownedAsyncJobManager;
		this.#asyncJobManager = config.asyncJobManager ?? config.ownedAsyncJobManager;
		const modelControlsHost: ModelControlsHost = {
			agent: this.agent,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			sessionManager: this.sessionManager,
			providerSessionState: this.#providerSessionState,
			model: () => this.model,
			sessionId: () => this.sessionId,
			promptGeneration: () => this.#promptGeneration,
			resolveActiveEditMode: () => this.#tools.resolveActiveEditMode(),
			syncAfterModelChange: previousEditMode => this.#tools.syncAfterModelChange(previousEditMode),
			setModelWithProviderSessionReset: model => this.#setModelWithProviderSessionReset(model),
			clearActiveRetryFallback: () => this.#recovery.clearActiveRetryFallback(),
			clearInheritedProviderPromptCacheKey: () => this.#clearInheritedProviderPromptCacheKey(),
			magicKeywordEnabled: keyword => this.#magicKeywordEnabled(keyword),
			emit: event => this.#emit(event),
			emitSessionEvent: event => this.#emitSessionEvent(event),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
		};
		this.#models = new ModelControls(modelControlsHost, {
			scopedModels: config.scopedModels,
			thinkingLevel: config.thinkingLevel,
			serviceTierByFamily: config.serviceTierByFamily,
		});

		this.#promptTemplates = config.promptTemplates ?? [];
		this.#slashCommands = config.slashCommands ?? [];
		this.#extensionRunner = config.extensionRunner;
		this.#customCommands = config.customCommands ?? [];
		const recoveryHost: TurnRecoveryHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			configWarnings: this.configWarnings,
			model: () => this.model,
			thinkingLevel: () => this.thinkingLevel,
			configuredThinkingLevel: () => this.configuredThinkingLevel(),
			setThinkingLevel: level => this.setThinkingLevel(level),
			isDisposed: () => this.#isDisposed,
			isStreaming: () => this.isStreaming,
			isCompacting: () => this.isCompacting,
			abortInProgress: () => this.#abortInProgress,
			streamingEditAbortTriggered: () => this.#streamingEditGuard.abortTriggered,
			promptGeneration: () => this.#promptGeneration,
			sessionId: () => this.sessionId,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			waitForSessionMessagePersistence: message => this.#waitForSessionMessagePersistence(message),
			appendSessionMessage: message => this.#appendSessionMessage(message),
			sessionMessageAlreadyPersisted: message => this.#sessionMessageAlreadyPersisted(message),
			setModelWithProviderSessionReset: model => this.#setModelWithProviderSessionReset(model),
			resetCurrentResponsesProviderSession: reason => this.#resetCurrentResponsesProviderSession(reason),
			maybeAutoRedeemCodexReset: () => this.#maybeAutoRedeemCodexReset(),
			runAutoCompaction: (reason, willRetry, deferred, allowDefer, options) =>
				this.#maintenance.runAutoCompaction(reason, willRetry, deferred, allowDefer, options),
			withBashBranchTransition: operation => this.#bash.withBranchTransition(operation),
		};
		this.#recovery = new TurnRecovery(recoveryHost, { initialRetryFallback: config.initialRetryFallback });
		const statsHost: SessionStatsTrackerHost = {
			session: this,
			agent: this.agent,
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: () => this.model,
			sessionId: () => this.sessionId,
		};
		this.#stats = new SessionStatsTracker(statsHost);
		const memoryHost: SessionMemoryHost = {
			agent: this.agent,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			isDisposed: () => this.#isDisposed,
			memoryBackendSession: () => this,
			getHindsightSessionState: () => this.getHindsightSessionState(),
			setHindsightSessionState: state => this.setHindsightSessionState(state),
			getMnemopiSessionState: () => this.getMnemopiSessionState(),
			takeMnemopiSessionState: () => setMnemopiSessionState(this, undefined),
			setBaseSystemPrompt: prompt => {
				this.#tools.setBaseSystemPrompt(prompt);
				this.agent.setSystemPrompt(prompt);
			},
			refreshBaseSystemPrompt: () => this.#tools.refreshBaseSystemPrompt(),
			replaceMemoryTools: tools => this.#tools.replaceMemoryTools(tools),
		};
		this.#memory = new SessionMemory(memoryHost, {
			memoryAgentDir: config.memoryAgentDir,
			memoryTaskDepth: config.memoryTaskDepth,
			createMemoryTools: config.createMemoryTools,
		});
		// Resolve the wire service-tier per request so the Fireworks Priority
		// toggle scopes priority to Fireworks alone, without mutating the shared
		// session `serviceTier` that drives `/fast` and OpenAI/Anthropic priority.
		this.agent.serviceTierResolver = model => this.#models.effectiveServiceTier(model);
		this.#titleSystemPrompt = config.titleSystemPrompt;
		this.#pruneToolDescriptions = config.pruneToolDescriptions === true;
		this.#transformContext = config.transformContext ?? (messages => messages);
		this.#sideStreamFn = config.sideStreamFn ?? streamSimple;
		this.#preferWebsockets = config.preferWebsockets;
		this.#onPayload = config.onPayload;
		this.rawSseDebugBuffer = config.rawSseDebugBuffer ?? new RawSseDebugBuffer();
		// Avoid wrapping in an `async` closure when no user callback is configured: the
		// outer await on `#onResponse` (provider-response.ts) tolerates a sync void return,
		// and skipping the wrapper drops a per-event `newPromiseCapability` allocation that
		// shows up as ~3.5% self time in streaming profiles.
		const configuredOnResponse = config.onResponse;
		this.#onResponse = configuredOnResponse
			? async (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					this.#stats.ingestProviderUsageHeaders(response, model);
					await configuredOnResponse(response, model);
				}
			: (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					this.#stats.ingestProviderUsageHeaders(response, model);
				};
		const configuredOnSseEvent = config.onSseEvent;
		this.#onSseEvent = configuredOnSseEvent
			? (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
					configuredOnSseEvent(event, model);
				}
			: (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
				};
		this.agent.setProviderResponseInterceptor(this.#onResponse);
		this.agent.setRawSseEventInterceptor(this.#onSseEvent);
		this.agent.setOnTurnEnd(async (messages, signal, context) => {
			if (signal?.aborted) return;
			const rewindReport = this.#extractRewindReport(messages);
			if (rewindReport) {
				this.#pendingRewindReport = undefined;
				await this.#applyRewind(rewindReport, messages);
			}
			this.#loopGuards.recordTurn(messages, context);
			await this.#prewalk.advanceAtTurnEnd(messages, context);
			await this.#advisors.onPrimaryTurnEnd(messages, context?.willContinue, signal);
			await this.#maintenance.maintainContextMidRun(messages, signal, context);
		});
		this.yieldQueue = new YieldQueue({
			isStreaming: () => this.isStreaming,
			injectIdle: async messages => {
				const first = messages[0];
				if (!first) return;
				await this.agent.prompt(messages.length === 1 ? first : messages);
			},
			scheduleIdleFlush: run => {
				this.#schedulePostPromptTask(
					async () => {
						await run();
					},
					{ delayMs: 1 },
				);
			},
		});
		// Background-job completions / late diagnostics are pulled into the run at
		// each step boundary as non-interrupting asides. Peer IRCs share the aside
		// injection boundary, but also expose a non-consuming interrupt peek so
		// `hub` waits can return early before the boundary drains them.
		this.agent.hasIrcInterrupts = () => this.#irc.hasInterrupts();
		this.agent.setAsideMessageProvider(() => {
			const thunks: AsideMessage[] = this.#irc.drainPending().map(record => () => record);
			thunks.push(...this.yieldQueue.drainLazy());
			// Mid-run todo reconciliation — evaluated at injection time so a turn
			// that flips a todo just before this poll suppresses the nudge.
			thunks.push(() => this.#todo.takeMidRunNudge());
			return thunks;
		});
		this.#convertToLlm = config.convertToLlm ?? convertToLlm;
		this.getXdevToolEntries = config.getXdevToolEntries ?? (() => []);
		const sessionToolsHost: SessionToolsHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			extensionRunner: () => this.#extensionRunner,
			clientBridge: () => this.#clientBridge,
			agentKind: () => this.#agentKind,
			isDisposed: () => this.#isDisposed,
			isStreaming: () => this.isStreaming,
			queuedMessageCount: () => this.queuedMessageCount,
			planModeEnabled: () => this.#planModeState?.enabled === true,
			model: () => this.model,
			memoryBackendSession: () => this,
			clearInheritedProviderPromptCacheKey: () => this.#clearInheritedProviderPromptCacheKey(),
			clearMemoryPromotionSnapshot: () => this.#memory.clearPromotionSnapshot(),
			captureMemoryPromotionSnapshot: prompt => this.#memory.capturePromotionSnapshot(prompt),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			notifyCommandMetadataChanged: () => this.#notifyCommandMetadataChanged(),
			localProtocolOptions: () => this.#localProtocolOptions(),
		};
		this.#tools = new SessionTools(sessionToolsHost, {
			autoApprove: config.autoApprove,
			toolRegistry: config.toolRegistry,
			createVibeTools: config.createVibeTools,
			createComputerTool: config.createComputerTool,
			builtInToolNames: config.builtInToolNames,
			presentationPinnedToolNames: config.presentationPinnedToolNames,
			ensureWriteRegistered: config.ensureWriteRegistered,
			rebuildSystemPrompt: config.rebuildSystemPrompt,
			getLocalCalendarDate: config.getLocalCalendarDate,
			getMcpServerInstructions: config.getMcpServerInstructions,
			xdevRegistry: config.xdevRegistry,
			initialMountedXdevToolNames: config.initialMountedXdevToolNames,
			setActiveToolNames: config.setActiveToolNames,
			baseSystemPrompt: this.agent.state.systemPrompt,
			skills: config.skills,
			skillWarnings: config.skillWarnings,
			skillsSettings: config.skillsSettings,
			skillsReloadable: config.skillsReloadable,
		});
		this.#disconnectOwnedMcpManager = config.disconnectOwnedMcpManager;
		const ttsrHost: TtsrCoordinatorHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			schedulePostPromptTask: (task, options) => this.#schedulePostPromptTask(task, options),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			promptGeneration: () => this.#promptGeneration,
		};
		this.#ttsr = new TtsrCoordinator(ttsrHost, config.ttsrManager);
		this.#obfuscator = config.obfuscator;
		const providerBoundaryHost: SessionProviderBoundaryHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			model: () => this.model,
			sessionId: () => this.sessionId,
			localProtocolOptions: () => this.#localProtocolOptions(),
			transformContext: (messages, signal) => this.#transformContext(messages, signal),
			convertToLlm: messages => this.#convertToLlm(messages),
			onPayload: this.#onPayload,
			onResponse: this.#onResponse,
			onSseEvent: this.#onSseEvent,
			obfuscator: this.#obfuscator,
		};
		this.#providerBoundary = new SessionProviderBoundary(providerBoundaryHost);
		const streamGuardsHost: StreamGuardsHost = {
			agent: this.agent,
			settings: this.settings,
			sessionManager: this.sessionManager,
			obfuscator: this.#obfuscator,
			model: () => this.model,
			isDisposed: () => this.#isDisposed,
			promptGeneration: () => this.#promptGeneration,
			localProtocolOptions: () => this.#localProtocolOptions(),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			schedulePostPromptTask: task => this.#schedulePostPromptTask(task),
			discardAssistantTurn: message => this.#recovery.discardAssistantTurn(message),
		};
		this.#streamingEditGuard = new StreamingEditGuard(streamGuardsHost);
		this.#loopGuards = new LoopGuards(streamGuardsHost);
		this.#agentId = config.agentId;
		this.#agentKind = config.agentKind ?? "main";
		this.#providerSessionId = config.providerSessionId;
		this.#inheritedProviderPromptCacheKey =
			config.providerPromptCacheKeySource === "fork" ? this.agent.promptCacheKey : undefined;
		// Owner-routed async delivery: completions for jobs this agent owns are
		// injected into THIS session's run as async-result follow-ups. Without a
		// registered sink the manager dead-letters owned deliveries, so this
		// registration is what makes background jobs usable — for the main
		// session and for subagents inheriting the process manager alike.
		if (this.#asyncJobManager && this.#agentId) {
			const manager = this.#asyncJobManager;
			this.#unregisterAsyncDeliverySink = manager.registerDeliverySink(this.#agentId, (jobId, text, job) =>
				this.#deliverAsyncJobResult(manager, jobId, text, job),
			);
			this.yieldQueue.register<AsyncResultEntry>("async-result", {
				isStale: entry => manager.isDeliverySuppressed(entry.jobId),
				build: buildAsyncResultBatchMessage,
			});
		}
		this.agent.setAssistantMessageEventInterceptor((message, assistantMessageEvent) => {
			const event: AgentEvent = {
				type: "message_update",
				message,
				assistantMessageEvent,
			};
			this.#streamingEditGuard.preCache(event);
			this.#streamingEditGuard.maybeAbort(event);
			this.#loopGuards.onAssistantEvent(message, assistantMessageEvent);
		});
		// Per-tool TTSR reminders are folded into the matched tool's result via this hook.
		this.agent.afterToolCall = async (ctx, _signal) => {
			this.#shakeToolCallCounter++;

			// Flag mid-run shake when counter reaches interval. The actual shake
			// fires from turn_end so tool results are already emitted and persisted
			// when shake scans sessionManager.getBranch().
			const interval = this.settings.get("shake.interval") as number;
			if (Number.isFinite(interval) && interval > 0 && this.#shakeToolCallCounter >= interval) {
				this.#midRunShakeDue = true;
			}

			return this.#afterToolCall(ctx);
		};
		this.agent.providerSessionState = this.#providerSessionState;
		this.#syncAgentSessionId();
		this.#todo.syncFromBranch();
		this.#goalRuntime = new GoalRuntime({
			getState: () => this.#goalModeState,
			setState: state => {
				this.#goalModeState = state;
			},
			getCurrentUsage: () => {
				const usage = this.getSessionStats().tokens;
				return {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				};
			},
			emit: event => {
				if (event.type === "goal_updated") {
					return this.#emitSessionEvent({ type: "goal_updated", goal: event.goal, state: event.state });
				}
			},
			persist: (mode, state) => {
				if (mode === "none") {
					this.sessionManager.appendModeChange("none");
				} else if (state) {
					this.sessionManager.appendModeChange(mode, { goal: state.goal });
				}
			},
			sendHiddenMessage: async message => {
				await this.sendCustomMessage(
					{
						customType: message.customType,
						content: message.content,
						display: false,
						attribution: "agent",
					},
					{ deliverAs: message.deliverAs },
				);
			},
		});
		this.#cancelExitRecorder = postmortem.register(`agent-session:${this.sessionManager.getSessionId()}`, reason => {
			this.#recordSessionExit(reason);
		});

		const advisorsHost: SessionAdvisorsHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			yieldQueue: this.yieldQueue,
			obfuscator: this.#obfuscator,
			providerSessionState: this.#providerSessionState,
			preferWebsockets: this.#preferWebsockets,
			onPayload: this.#onPayload,
			onResponse: this.#onResponse,
			onSseEvent: this.#onSseEvent,
			agentKind: () => this.#agentKind,
			isDisposed: () => this.#isDisposed,
			abortInProgress: () => this.#abortInProgress,
			allowAgentInitiatedTurns: () => this.#allowAcpAgentInitiatedTurns,
			planModeState: () => this.#planModeState,
			clientBridge: () => this.#clientBridge,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			sendCustomMessage: (message, options) => this.sendCustomMessage(message, options),
			extractQueuedAdvisorCards: () => this.#extractQueuedAdvisorCards(),
			dropPendingAdvisorCards: () => {
				this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(message => !isAdvisorCard(message));
			},
			preserveAdvisorCard: card => this.#preserveAdvisorCard(card),
			hasPendingNextTurnMessages: () => this.#pendingNextTurnMessages.length > 0,
			convertToLlmForSideRequest: messages => this.#convertToLlmForSideRequest(messages),
			effectiveServiceTier: model => this.#models.effectiveServiceTier(model),
			resolveContextPromotionTarget: (model, contextWindow) =>
				this.#maintenance.resolveContextPromotionTarget(model, contextWindow),
			resolveCompactionModelCandidates: (model, availableModels) =>
				this.#maintenance.resolveCompactionModelCandidates(model, availableModels),
			resolveRetryFallbackRole: (selector, model) => this.#recovery.resolveRetryFallbackRole(selector, model),
			findRetryFallbackCandidates: (role, selector, model) =>
				this.#recovery.findRetryFallbackCandidates(role, selector, model),
			isRetryFallbackSelectorSuppressed: selector => this.#recovery.isRetryFallbackSelectorSuppressed(selector),
			noteRetryFallbackCooldown: (selector, retryAfterMs, errorMessage) =>
				this.#recovery.noteRetryFallbackCooldown(selector, retryAfterMs, errorMessage),
			createCodexCompactionContext: createMaintenanceCodexCompactionContext,
			sessionId: () => this.sessionId,
		};
		this.#advisors = new SessionAdvisors(advisorsHost, {
			enabled: this.settings.get("advisor.enabled"),
			tools: config.advisorTools,
			watchdogPrompt: config.advisorWatchdogPrompt,
			sharedInstructions: config.advisorSharedInstructions,
			contextPrompt: config.advisorContextPrompt,
			configs: config.advisorConfigs,
			streamFn: config.advisorStreamFn,
			transformProviderContext: config.transformProviderContext,
		});

		const maintenanceHost: SessionMaintenanceHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			extensionRunner: this.#extensionRunner,
			sideStreamFn: this.#sideStreamFn,
			providerSessionState: this.#providerSessionState,
			model: () => this.model,
			thinkingLevel: () => this.thinkingLevel,
			isDisposed: () => this.#isDisposed,
			isStreaming: () => this.isStreaming,
			isGeneratingHandoff: () => this.isGeneratingHandoff,
			promptGeneration: () => this.#promptGeneration,
			sessionId: () => this.sessionId,
			messages: () => this.messages,
			baseSystemPrompt: () => this.#tools.baseSystemPrompt,
			goalModeState: () => this.#goalModeState,
			planReferencePath: () => this.#planReferencePath,
			nonMessageTokenSource: () => this,
			memoryBackendSession: () => this,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			schedulePostPromptTask: (task, options) => this.#schedulePostPromptTask(task, options),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			scheduleCompactionContinuation: options => this.#scheduleCompactionContinuation(options),
			persistTurnMessagesForMidRunCompaction: context => this.#persistTurnMessagesForMidRunCompaction(context),
			findLastAssistantMessage: () => this.#findLastAssistantMessage(),
			disconnectFromAgent: () => this.#disconnectFromAgent(),
			reconnectToAgent: () => this.#reconnectToAgent(),
			drainStrandedQueuedMessages: () => this.#drainStrandedQueuedMessages(),
			buildDisplaySessionContext: () => this.buildDisplaySessionContext(),
			convertToLlmForSideRequest: messages => this.#convertToLlmForSideRequest(messages),
			obfuscateTextForProvider: text => this.#obfuscateTextForProvider(text),
			obfuscatePreparationForProvider: preparation => this.#obfuscatePreparationForProvider(preparation),
			closeCodexProviderSessionsForHistoryRewrite: () => this.#closeCodexProviderSessionsForHistoryRewrite(),
			resetCodexProviderAfterCompaction: compaction => this.#resetCodexProviderAfterCompaction(compaction),
			resetPlanReference: () => {
				this.#planReferenceSent = false;
			},
			syncTodoPhasesFromBranch: () => this.#todo.syncFromBranch(),
			resetAdvisorRuntimes: () => this.#advisors.resetAllRuntimes(),
			rebaseAfterCompaction: () => this.#stats.rebaseAfterCompaction(),
			getContextBreakdown: options => this.getContextBreakdown(options),
			getContextUsage: options => this.getContextUsage(options),
			shake: (mode, options) => this.shake(mode, options),
			dropImages: () => this.dropImages(),
			runHandoff: (customInstructions, options) => this.handoff(customInstructions, options),
			removeAssistantMessageFromActiveContext: message =>
				this.#recovery.removeAssistantMessageFromActiveContext(message),
			dropPersistedAssistantTurn: message => this.#recovery.dropPersistedAssistantTurn(message),
			runRecoveryCompactionWithRollback: (reason, message, allowDefer, options) =>
				this.#recovery.runRecoveryCompactionWithRollback(reason, message, allowDefer, options),
			parseRetryAfterMsFromError: errorMessage => this.#recovery.parseRetryAfterMsFromError(errorMessage),
			setModelTemporary: (model, thinkingLevel, options) => this.setModelTemporary(model, thinkingLevel, options),
			abort: options => this.abort(options),
			abortHandoff: () => this.abortHandoff(),
		};
		this.#maintenance = new SessionMaintenance(maintenanceHost);

		const handoffHost: SessionHandoffHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			extensionRunner: this.#extensionRunner,
			sideStreamFn: this.#sideStreamFn,
			obfuscator: this.#obfuscator,
			model: () => this.model,
			thinkingLevel: () => this.thinkingLevel,
			sessionId: () => this.sessionId,
			sessionFile: () => this.sessionFile,
			baseSystemPrompt: () => this.#tools.baseSystemPrompt,
			assertVibeSessionTransitionAllowed: action => this.#assertVibeSessionTransitionAllowed(action),
			setSkipPostTurnMaintenance: timestamp => {
				this.#maintenance.skipPostTurnMaintenanceAssistantTimestamp = timestamp;
			},
			obfuscateTextForProvider: text => this.#obfuscateTextForProvider(text),
			deobfuscateFromProvider: text => this.#deobfuscateFromProvider(text),
			convertMessagesToLlm: (messages, signal) => this.convertMessagesToLlm(messages, signal),
			prepareSimpleStreamOptions: (options, provider) => this.prepareSimpleStreamOptions(options, provider),
			effectiveServiceTier: model => this.#models.effectiveServiceTier(model),
			flushPendingBash: () => this.#bash.flushPending(),
			beginBashSessionTransition: () => this.#bash.beginSessionTransition(),
			markBashSessionTransition: transition => this.#bash.markSessionTransition(transition),
			finishBashSessionTransition: (transition, success) => this.#bash.finishSessionTransition(transition, success),
			cancelOwnAsyncJobs: () => this.#cancelOwnAsyncJobs(),
			clearCheckpointRuntimeState: () => this.#clearCheckpointRuntimeState(),
			clearSessionScopedToolState: () => this.#clearSessionScopedToolState(),
			clearFreshProviderSessionId: () => {
				this.#freshProviderSessionId = undefined;
			},
			syncAgentSessionId: () => this.#syncAgentSessionId(),
			rekeyMemoryForCurrentSessionId: () => {
				this.#memory.rekeyForCurrentSessionId();
			},
			resetMemoryContextForNewTranscript: () => this.#memory.resetContextForNewTranscript(),
			clearPendingNextTurnMessages: () => {
				this.#pendingNextTurnMessages = [];
				this.#scheduledHiddenNextTurnGeneration = undefined;
			},
			resetTodoCycle: () => this.#todo.resetCycle(),
			buildDisplaySessionContext: () => this.buildDisplaySessionContext(),
			resetAdvisorRuntimes: () => this.#advisors.resetAllRuntimes(),
			syncTodoPhasesFromBranch: () => this.#todo.syncFromBranch(),
		};
		this.#handoff = new SessionHandoff(handoffHost);

		this.#rehydrateCheckpointRewindState();

		// Always subscribe to agent events for internal handling
		// (session persistence, hooks, auto-compaction, retry logic)
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
		// Re-evaluate append-only context mode when the setting changes at runtime.
		this.#unsubscribeAppendOnly = onAppendOnlyModeChanged(_value => this.#syncAppendOnlyContext(this.model));
		this.#unsubscribeModelRoles = onModelRolesChanged(() => this.#advisors.onModelRolesChanged());
	}
	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this.#modelRegistry;
	}

	get asyncJobManager(): AsyncJobManager | undefined {
		return this.#asyncJobManager;
	}

	getAgentId(): string | undefined {
		return this.#agentId;
	}

	/** Dequeue the next HARD forced tool choice for the upcoming LLM call, dropping
	 *  (and rejecting) one whose named tool is no longer active. */
	#nextHardToolChoice(): ToolChoice | undefined {
		const choice = this.#toolChoiceQueue.nextToolChoice();
		if (isToolChoiceActive(choice, this.agent.state.tools)) {
			return choice;
		}
		this.#toolChoiceQueue.reject("unavailable");
		return undefined;
	}

	/**
	 * The per-turn tool-choice directive for the agent loop's `getToolChoice`. Priority:
	 *   1. a HARD forced choice from the queue (genuine forces: user-force, eager-todo, …) —
	 *      consuming (advances the queue generator);
	 *   2. else, when a non-forcing preview is pending, a {@link SoftToolRequirement} — a
	 *      PEEK (advances/pops nothing), so the agent-loop injects the reminder once per head
	 *      and escalates to a forced `write` only if the model declines to
	 *      resolve via `xd://resolve` or `xd://reject`. A compliant turn
	 *      pays ZERO tool_choice change (no prompt-cache messages-cache invalidation);
	 *   3. else undefined.
	 */
	nextToolChoiceDirective(): ToolChoiceDirective | undefined {
		const hard = this.#nextHardToolChoice();
		if (hard !== undefined) return hard;
		const head = this.#toolChoiceQueue.peekPendingHead();
		if (head !== undefined) {
			return {
				soft: true,
				id: head.id,
				// Preview resolution is a `write` to xd://resolve or xd://reject;
				// only those exact shapes satisfy the requirement — a plain write
				// elsewhere is a detour.
				toolName: "write",
				satisfies: isPreviewResolutionToolCall,
				reminder: [buildResolveReminderMessage(head.sourceToolName)],
			};
		}
		return undefined;
	}

	/** Peek the head non-forcing pending preview invoker, for the preview-resolution dispatch. */
	peekPendingInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekPendingInvoker();
	}

	/** Clear stale non-forcing pending preview invokers after a resolve dispatch proves none can run. */
	clearPendingInvokers(): void {
		this.#toolChoiceQueue.clearPendingInvokers();
	}

	/**
	 * Force the next model call to target a specific active tool, then terminate
	 * the agent loop. Pushes a two-step sequence [forced, "none"] so the model
	 * calls exactly the forced tool once and then cannot call another.
	 */
	setForcedToolChoice(toolName: string): void {
		if (!this.getActiveToolNames().includes(toolName)) {
			throw new Error(`Tool "${toolName}" is not currently active.`);
		}

		const forced = buildNamedToolChoice(toolName, this.model);
		if (!forced || typeof forced === "string") {
			throw new Error("Current model does not support forcing a specific tool.");
		}

		this.#toolChoiceQueue.pushSequence([forced, "none"], {
			label: "user-force",
			onRejected: () => "requeue",
		});
	}

	/** The tool-choice queue: forces forthcoming tool invocations and carries handlers. */
	get toolChoiceQueue(): ToolChoiceQueue {
		return this.#toolChoiceQueue;
	}

	/** Peek the in-flight directive's invocation handler for the preview-resolution dispatch. */
	peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekInFlightInvoker();
	}

	/** Plan-proposal handler consulted by `xd://propose` while plan mode is active. */
	#planProposalHandler: PlanProposalHandler | undefined;

	peekPlanProposalHandler(): PlanProposalHandler | undefined {
		return this.#planProposalHandler;
	}

	setPlanProposalHandler(handler: PlanProposalHandler | null): void {
		this.#planProposalHandler = handler ?? undefined;
	}

	#sessionBeforeSwitchReconciler: (() => Promise<void>) | undefined;

	setSessionBeforeSwitchReconciler(reconciler: (() => Promise<void>) | null): void {
		this.#sessionBeforeSwitchReconciler = reconciler ?? undefined;
	}

	#sessionSwitchReconciler: (() => Promise<void>) | undefined;

	setSessionSwitchReconciler(reconciler: (() => Promise<void>) | null): void {
		this.#sessionSwitchReconciler = reconciler ?? undefined;
	}

	/** Provider-scoped mutable state store for transport/session caches. */
	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessionState;
	}

	/** Hint forwarded to provider calls that support websocket transport. */
	get preferWebsockets(): boolean | undefined {
		return this.#preferWebsockets;
	}

	getHindsightSessionState(): HindsightSessionState | undefined {
		return this.#hindsightSessionState;
	}

	setHindsightSessionState(state: HindsightSessionState | undefined): HindsightSessionState | undefined {
		const previous = this.#hindsightSessionState;
		this.#hindsightSessionState = state;
		return previous;
	}

	getMnemopiSessionState(): MnemopiSessionState | undefined {
		return getMnemopiSessionState(this);
	}

	/** TTSR manager for time-traveling stream rules */
	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsr.manager;
	}

	/** Secret obfuscator, when secrets are configured; /share redaction reuses it. */
	get obfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules) */
	get isTtsrAbortPending(): boolean {
		return this.#ttsr.abortPending;
	}

	/** Whether an expected internal plan-mode abort is pending. Consumed by
	 *  `#handleAgentEvent` to stamp `SILENT_ABORT_MARKER` on the next aborted
	 *  assistant message_end; callers clear it in `finally`. */
	get isPlanInternalAbortPending(): boolean {
		return this.#planInternalAbortPending;
	}

	/** Arm the silent-abort marker for the next aborted assistant message_end.
	 *  Caller MUST clear via `clearPlanInternalAbortPending()` in a `finally`
	 *  to guarantee no leak. */
	markPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = true;
	}

	/** Unconditionally clear the silent-abort flag. Idempotent: safe when the
	 *  flag was never set OR was already consumed by `#handleAgentEvent`. */
	clearPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = false;
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		const manager = this.#asyncJobManager;
		if (!manager) return null;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const running = manager.getRunningJobs(ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const recent = manager.getRecentJobs(options?.recentLimit ?? 5, ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const delivery = manager.getDeliveryState(ownerFilter);
		return { running, recent, delivery };
	}

	/**
	 * Cancel async jobs registered by *this* agent only. Used by lifecycle
	 * transitions (newSession, switchSession, handoff, dispose) so a subagent
	 * cleans up its own background work without touching its parent's jobs.
	 *
	 * Cancellation runs against this session's scoped manager. Subagents have
	 * unique agent ids and inherit the parent's manager to clean up their own
	 * jobs. A secondary in-process top-level session gets no scoped manager,
	 * because it defaults to `MAIN_AGENT_ID`; reaching through the global
	 * singleton would tear down the owning primary session's bash/task jobs at
	 * dispose time (issue #1923).
	 *
	 * No-op when no manager is reachable or this session has no agent id.
	 */
	#cancelOwnAsyncJobs(): void {
		if (!this.#agentId) return;
		const manager = this.#asyncJobManager;
		manager?.cancelAll({ ownerId: this.#agentId });
	}

	/**
	 * True when a background async job owned by this agent is still running with
	 * an unsuppressed delivery, a finished job's delivery is still queued or in
	 * flight, or a delivered result is still sitting on the yield queue awaiting
	 * injection. In every case the async-result follow-up will re-wake the loop,
	 * so a settle observed now is a scheduling pause rather than a terminal stop:
	 * stop-time passes (todo reminder, session_stop hooks) defer to the settle
	 * reached once the session is fully idle. Suppressed deliveries
	 * (acknowledged, or watched by an in-flight `hub` wait) never wake the loop,
	 * so they don't count.
	 */
	#hasPendingAsyncWake(): boolean {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		return (
			manager.getRunningJobs(ownerFilter).some(job => !manager.isDeliverySuppressed(job.id)) ||
			manager.hasPendingDeliveries(ownerFilter) ||
			// Delivered but not yet injected: the sink has enqueued the
			// async-result follow-up on the yield queue, and the manager no
			// longer reports it. Without this leg a terminal yield in the
			// (idle-flush delay / step-boundary) handoff window would read as
			// quiescent and the run driver would drop the queued result.
			this.yieldQueue.has(ASYNC_RESULT_MESSAGE_TYPE)
		);
	}

	/**
	 * Public view of the pending-async-wake state for run drivers: true while
	 * owner-scoped async work can still re-wake this session's run (a running
	 * background job with an unsuppressed delivery, or a queued / in-flight
	 * delivery). The task executor's quiescence barrier polls this to
	 * distinguish a scheduling pause from terminal completion.
	 */
	hasPendingAsyncWork(): boolean {
		return this.#hasPendingAsyncWake();
	}

	/**
	 * Settle one generation of owner-scoped async work: wait for running owner
	 * jobs to finish, deliver their queued results (which enqueue async-result
	 * follow-ups on this session's yield queue), and wait for the injected
	 * follow-up turn(s) to go idle. Callers loop while
	 * {@link hasPendingAsyncWork} still holds — a follow-up turn may start new
	 * jobs.
	 */
	async settleAsyncWork(): Promise<void> {
		const manager = this.#asyncJobManager;
		if (!manager || !this.#agentId) return;
		await manager.waitForOwnerJobs(this.#agentId, { excludeSuppressed: true });
		await manager.drainDeliveries({ filter: { ownerId: this.#agentId } });
		await this.waitForIdle();
	}

	/**
	 * Delivery sink for async jobs owned by this agent: format the result
	 * (spilling oversized output to an artifact) and enqueue it as an
	 * async-result follow-up on the yield queue. The queue's idle flush starts
	 * the follow-up turn when the session is between turns.
	 */
	async #deliverAsyncJobResult(manager: AsyncJobManager, jobId: string, text: string, job?: AsyncJob): Promise<void> {
		if (this.#isDisposed) return;
		if (manager.isDeliverySuppressed(jobId)) return;
		const formatted = await this.#formatAsyncResultForFollowUp(text);
		if (manager.isDeliverySuppressed(jobId)) return;
		const durationMs = job ? Math.max(0, Date.now() - job.startTime) : undefined;
		this.yieldQueue.enqueue<AsyncResultEntry>("async-result", { jobId, result: formatted, job, durationMs });
	}

	async #formatAsyncResultForFollowUp(result: string): Promise<string> {
		if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
			return result;
		}
		const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
		try {
			const { path: artifactPath, id: artifactId } = await this.sessionManager.allocateArtifactPath("async");
			if (artifactPath && artifactId) {
				await Bun.write(artifactPath, result);
				return `${preview}\nFull output: artifact://${artifactId}`;
			}
		} catch (error) {
			logger.warn("Failed to persist async follow-up artifact", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return preview;
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	#emit(event: AgentSessionEvent): void {
		// Copy array before iteration to avoid mutation during iteration.
		const listeners = [...this.#eventListeners];
		for (const l of listeners) {
			try {
				const result = l(event) as unknown;
				// Listener may be an async function whose returned Promise we don't await;
				// attach a catch so a rejection does not become an unhandled rejection.
				if (isPromise(result)) {
					result.catch(err => {
						logger.warn("AgentSession listener rejected", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			} catch (err) {
				logger.warn("AgentSession listener threw", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	/**
	 * Emit a UI-only notice to the session. Surfaces in interactive mode as a
	 * `showWarning` / `showError` / `showStatus` line; non-interactive modes
	 * receive the event through the normal subscribe stream.
	 *
	 * Notices are NOT added to agent state and never reach the LLM — use this
	 * for out-of-band conditions the user should see but the model shouldn't
	 * react to (e.g. background queue flush failures).
	 */
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		this.#emit({ type: "notice", level, message, source });
	}

	#recordToolExecutionStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>): void {
		const data: ToolExecutionStartData = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			startedAt: new Date().toISOString(),
		};
		// The assistant message already persists the full arguments; store only
		// the command/path projection the resume warning renders.
		const args = summarizeToolArguments(event.args);
		if (args) data.args = args;
		if (event.intent) data.intent = event.intent;
		this.sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, data);
	}

	#recordSessionExit(reason: postmortem.Reason | "dispose"): void {
		if (this.#exitRecorded) return;
		this.#exitRecorded = true;
		const pendingToolCalls = collectPendingToolCalls(this.sessionManager.getBranch());
		if (
			pendingToolCalls.length === 0 &&
			!this.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant")
		) {
			return;
		}
		const kind: SessionExitData["kind"] =
			reason === "dispose" || reason === postmortem.Reason.MANUAL
				? "normal"
				: reason === postmortem.Reason.UNCAUGHT_EXCEPTION || reason === postmortem.Reason.UNHANDLED_REJECTION
					? "fatal"
					: reason === postmortem.Reason.EXIT
						? "process_exit"
						: "signal";
		const data: SessionExitData = {
			reason,
			kind,
			recordedAt: new Date().toISOString(),
		};
		if (pendingToolCalls.length > 0) data.pendingToolCalls = pendingToolCalls;
		try {
			this.sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, data);
			this.sessionManager.flushSync();
			// Only pending tool calls or an abnormal teardown are noteworthy; a
			// clean dispose logs at debug so routine exits don't read as problems.
			const exitLog = pendingToolCalls.length > 0 || kind !== "normal" ? logger.warn : logger.debug;
			exitLog("Session exit recorded", {
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
				reason,
				kind,
				pendingToolCalls: pendingToolCalls.length,
			});
		} catch (error) {
			logger.error("Failed to record session exit", {
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
				reason,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#queuedExtensionEvents: Promise<void> = Promise.resolve();

	#queueExtensionEvent(event: AgentSessionEvent): Promise<void> {
		const emit = async () => {
			await this.#emitExtensionEvent(event);
		};
		const queued = this.#queuedExtensionEvents.then(emit, emit);
		this.#queuedExtensionEvents = queued.catch(() => {});
		return queued;
	}

	/**
	 * Orders subscriber fan-out across concurrent `#emitSessionEvent` calls.
	 * Extension emits only await when the event type has handlers, so an event
	 * with no handlers could otherwise overtake an earlier event still inside
	 * its extension emit — an instant refusal delivered its assistant
	 * `message_end` to the TUI before its own `message_start`, skipping the
	 * turn-ending error render entirely.
	 */
	#subscriberEmitGate: Promise<void> = Promise.resolve();

	async #emitSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "message_update") {
			this.#emit(event);
			void this.#queueExtensionEvent(event);
			return;
		}
		// Take a FIFO ticket before the extension emit: extension deliveries for
		// consecutive events still run concurrently, but subscriber fan-out waits
		// for every earlier event's fan-out (or deferral) to happen first.
		const previousGate = this.#subscriberEmitGate;
		const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();
		this.#subscriberEmitGate = gate;
		try {
			await this.#emitExtensionEvent(event);
			await previousGate;
			// Hold the wire-level agent_end until in-flight prompts unwind. Subscribers
			// (rpc-mode, ACP, Cursor) treat agent_end as the "session is idle" signal;
			// emitting while #promptInFlightCount > 0 lets a client fire its next
			// `prompt` into a session that still reports isStreaming === true. Flush
			// happens in #endInFlight / #resetInFlight. A later agent_end (e.g. from
			// an auto-compaction turn that starts before the original prompt unwinds)
			// supersedes the pending one, which is what subscribers want — they only
			// care about the final settle.
			if (event.type === "agent_end" && this.#promptInFlightCount > 0) {
				this.#pendingAgentEndEmit = event;
				return;
			}
			this.#emit(event);
		} finally {
			releaseGate();
		}
	}

	// Track last assistant message for auto-compaction check
	#lastAssistantMessage: AssistantMessage | undefined = undefined;
	/**
	 * Classifier-refusal turn pruned from active context at settle (#3591).
	 * Retained until the next run starts so post-settle readers
	 * ({@link getLastAssistantMessage}: print mode, task executor) still see
	 * the terminal error instead of a silently successful-looking state.
	 */
	#prunedTerminalRefusal: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect.
	 *
	 * `agent_end` handling schedules deferred post-prompt recovery work
	 * (compaction/handoff, context-promotion continuations). It is invoked
	 * fire-and-forget by the agent's synchronous `#emit`, and only reaches
	 * `#checkCompaction` after several internal awaits. `prompt()` runs
	 * `#waitForPostPromptRecovery()` the instant `agent.prompt()` resolves — which
	 * can land BEFORE the handler registers its tasks, so the wait would observe an
	 * empty task set and return early, letting a deferred handoff/promotion race
	 * prompt completion. Tracking the `agent_end` handler as a post-prompt task
	 * that is registered SYNCHRONOUSLY (before the first await) closes that window:
	 * `#postPromptTasksPromise` is set the moment `#emit` invokes this handler, so
	 * the recovery wait always sees the in-flight handler and blocks until it — and
	 * everything it schedules — settles. */
	#handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "tool_execution_end" && this.#isTerminalYieldToolResult(event)) {
			const alreadyTerminated = this.#synchronouslyTerminatedYieldToolCallIds.delete(event.toolCallId);
			if (!alreadyTerminated) {
				this.#markTerminalYieldToolCall(event.toolCallId);
				this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			}
		}
		if (event.type !== "agent_end") {
			const processing = this.#processAgentEvent(event);
			if ((event.type === "message_start" || event.type === "message_end") && isAdvisorCard(event.message)) {
				this.#advisors.trackCardEvent(processing);
			}
			return processing;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#trackPostPromptTask(promise);
		try {
			await this.#processAgentEvent(event);
		} finally {
			resolve();
		}
	};

	#createMessageEndPersistenceSlot(message: AgentMessage): MessageEndPersistenceSlot | undefined {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return undefined;
		const previous = this.#messageEndPersistenceTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		const clear = () => {
			if (this.#pendingMessageEndPersistence.get(key) === promise) {
				this.#pendingMessageEndPersistence.delete(key);
			}
		};
		this.#pendingMessageEndPersistence.set(key, promise);
		this.#messageEndPersistenceTail = promise.catch(() => {});
		return {
			promise,
			persist: async persistMessage => {
				await previous;
				try {
					persistMessage();
				} finally {
					resolve();
					clear();
				}
			},
			release: () => {
				resolve();
				clear();
			},
		};
	}

	async #waitForSessionMessagePersistence(message: AgentMessage): Promise<void> {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return;
		await this.#pendingMessageEndPersistence.get(key);
	}

	/**
	 * Index every message entry on the current branch by persistence key, so
	 * the mid-run-compaction planner can ask "is this turn message already on
	 * the branch?" in O(1). The set is memoized through the current leaf path
	 * and validated at use time against a (session file, leaf id) anchor.
	 *
	 * The mid-run ordering check uses key identity alone: same-key content
	 * variants are one logical message at this boundary, because otherwise a
	 * display-side rewrite can make the assistant look missing after its tool
	 * results have already persisted.
	 *
	 * Coherency is anchor-based, not invalidation-based: every branch mutation
	 * (rewind, branch switch, new session, custom-entry append) changes the
	 * session manager's leaf id or session file, so `#ensurePersistedMessageKeys`
	 * detects staleness itself and rebuilds. No mutation call site has to
	 * remember to invalidate anything.
	 *
	 * Pre-#3629 the equivalent was `sessionManager.getBranch()` called twice
	 * per turn message, each call rebuilding the path via O(n²) `unshift` and
	 * structurally JSON-comparing every entry — seconds of synchronous work
	 * per `onTurnEnd` on a long session and the load-bearing source of the
	 * `ui.loop-blocked` warnings in the bug report.
	 */
	#indexPersistedMessageKeys(): Set<string> {
		return this.#ensurePersistedMessageKeys();
	}

	#persistedMessageKeysAnchor(): string {
		return `${this.sessionManager.getSessionFile() ?? ""}\u0000${this.sessionManager.getLeafId() ?? ""}`;
	}

	#ensurePersistedMessageKeys(): Set<string> {
		const anchor = this.#persistedMessageKeysAnchor();
		let cache = this.#persistedMessageKeys;
		if (cache === undefined || cache.anchor !== anchor) {
			cache = { anchor, keys: this.#buildPersistedMessageKeySet() };
			this.#persistedMessageKeys = cache;
		}
		return cache.keys;
	}

	#buildPersistedMessageKeySet(): Set<string> {
		const keys = new Set<string>();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const key = sessionMessagePersistenceKey(entry.message);
			if (key !== undefined) keys.add(key);
		}
		return keys;
	}

	/**
	 * True when {@link message} is structurally identical to a message already
	 * appended to the current branch. Uses the current branch's memoized
	 * persistence-key cache for the common missing-key case, and only walks the
	 * branch to verify content when a key hit could be a rare collision.
	 */
	#sessionMessageAlreadyPersisted(message: AgentMessage): boolean {
		const key = sessionMessagePersistenceKey(message);
		if (key === undefined) return false;
		const keys = this.#ensurePersistedMessageKeys();
		if (!keys.has(key)) return false;
		const branch = this.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message") continue;
			if (sessionMessagePersistenceKey(entry.message) !== key) continue;
			if (sameMessageContent(entry.message, message)) return true;
		}
		return false;
	}

	#appendSessionMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const cache = this.#persistedMessageKeys;
		const wasFresh = cache !== undefined && cache.anchor === this.#persistedMessageKeysAnchor();
		const entryId = this.sessionManager.appendMessage(message);
		const key = sessionMessagePersistenceKey(message);
		if (wasFresh && cache && key) {
			cache.keys.add(key);
			cache.anchor = this.#persistedMessageKeysAnchor();
		}
		return entryId;
	}

	#persistSessionMessageIfMissing(message: AgentMessage): void {
		if (
			message.role !== "user" &&
			message.role !== "developer" &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			message.role !== "fileMention"
		) {
			return;
		}
		if (this.#sessionMessageAlreadyPersisted(message)) return;
		if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;
			if (this.#recovery.isClassifierRefusal(assistantMsg)) return;
			if (isEmptyErrorTurn(assistantMsg)) return;
			if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
				assistantMsg.contextSnapshot = {
					promptTokens: calculatePromptTokens(assistantMsg.usage),
					nonMessageTokens: this.#stats.pendingNonMessageTokens ?? computeNonMessageTokens(this),
				};
			}
		}
		const skipPersistedRewindResult =
			message.role === "toolResult" &&
			semanticToolResult(message.toolName, message)?.toolName === "rewind" &&
			this.#rewoundToolResultIds.delete(message.toolCallId);
		if (!skipPersistedRewindResult) {
			this.#appendSessionMessage(message);
		}
	}

	/**
	 * On a user-interrupted (`Esc`) abort, copy the trailing thinking run into a
	 * hidden `display: false` continuity message for the next turn WITHOUT
	 * mutating the assistant message. The original thinking stays on the message
	 * so live render, reload, and Ctrl+L rebuilds keep showing it; `convertToLlm`
	 * strips the run from the provider request (incomplete/unsigned thinking is
	 * rejected on resend) when this continuity message follows the assistant turn.
	 */
	#demoteInterruptedThinkingOnUserInterrupt(
		message: AssistantMessage,
	): CustomMessage<InterruptedThinkingDetails> | undefined {
		if (message.stopReason !== "aborted" || !isUserInterruptAbort(message)) return undefined;
		const demoted = demoteInterruptedThinking(message);
		if (!demoted) return undefined;
		const interruptedAt = Date.now();
		return {
			role: "custom",
			customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
			content: prompt.render(interruptedThinkingTemplate, { reasoning: demoted.reasoning }),
			display: false,
			details: {
				interruptedAt,
				provider: message.provider,
				model: message.model,
				blockCount: demoted.blockCount,
			},
			attribution: "agent",
			timestamp: interruptedAt,
		};
	}

	async #persistTurnMessagesForMidRunCompaction(context: AgentTurnEndContext | undefined): Promise<boolean> {
		if (!context) return true;
		const turnMessages = [context.message, ...context.toolResults];
		for (const message of turnMessages) {
			await this.#waitForSessionMessagePersistence(message);
		}
		// One branch snapshot + one persistence-key index drives the entire
		// planning pass. Pre-#3629 this re-walked the branch and structurally
		// JSON-compared every entry per turn message, which on long sessions
		// turned each `onTurnEnd` into a seconds-long sync block (the
		// `ui.loop-blocked` warnings tagged `subagent:*` in the bug report).
		const branchKeys = this.#indexPersistedMessageKeys();
		const turnKeys = turnMessages.map(sessionMessagePersistenceKey);
		const persistedKeys = new Set<string>();
		for (let index = 0; index < turnMessages.length; index++) {
			const key = turnKeys[index];
			if (key === undefined) continue;
			// Mid-run ordering is keyed by logical identity. A persisted display
			// variant (for example, redacted/deobfuscated content) must still count;
			// otherwise the assistant can look missing while later tool results are
			// present, producing a false out-of-order skip.
			if (branchKeys.has(key)) {
				persistedKeys.add(key);
			}
		}
		const plan = planTurnPersistence(turnKeys, persistedKeys);
		if (plan.kind === "out-of-order") {
			const message = turnMessages[plan.messageIndex];
			logger.debug("Skipping mid-run compaction because turn persistence is out of order", {
				role: message.role,
				timestamp: message.timestamp,
			});
			return false;
		}
		for (const index of plan.toPersist) {
			this.#persistSessionMessageIfMissing(turnMessages[index]);
		}
		return true;
	}

	#processAgentEvent = async (event: AgentEvent): Promise<void> => {
		// A fresh run supersedes the previously settled (and pruned) refusal
		// turn: state-based lookups take over again.
		if (event.type === "agent_start") {
			this.#prunedTerminalRefusal = undefined;
		}
		// Step the mid-run todo counter synchronously, BEFORE any await in this
		// handler. The agent loop's next-turn `getAsideMessages` poll can run
		// before queued microtasks drain, so `#takeMidRunTodoNudge` MUST see the
		// freshest counter — otherwise a turn that just invoked `todo` could
		// trip a spurious nudge against stale state, and a turn that just hit
		// the threshold could fail to nudge until a later turn (issue #3651).
		// Pure in-memory math — no ordering requirement vs persistence or
		// session-event fan-out. Keyed on toolResult (not the assistant toolCall
		// turn) so planned-but-aborted or permission-denied calls never count,
		// and only successful mutating tools tick — read-only exploration is
		// not progress an agent could mark done.
		if (event.type === "message_end" && event.message.role === "toolResult") {
			this.#todo.onToolResult(event.message.toolName, event.message.isError);
		}
		// Track the settled assistant turn synchronously as well: agent_end
		// maintenance reads `#lastAssistantMessage`, and when a turn's events all
		// land in one tick its handler can run before this handler's post-emit
		// bookkeeping — leaving maintenance looking at the previous (e.g.
		// toolUse) assistant message and skipping settle-only work.
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.#lastAssistantMessage = event.message;
		}
		// Plan-mode internal transition: stamp `SILENT_ABORT_MARKER` on the
		// persisted message BEFORE the obfuscator's display-side copy below.
		// Invariant (must hold across refactors): this branch precedes the
		// `let displayEvent = event; ... displayEvent = { ...event, message: { ...message, content: deobfuscated } }`
		// block. After stamping, both `displayEvent.message` (via the spread)
		// and `event.message` (in-place mutation, used by SessionManager
		// persistence) carry the marker, guaranteeing streaming render and
		// history replay branch identically. The one-shot flag is consumed
		// here, scoped strictly to this aborted message_end; callers still clear it
		// in `finally` so a leaked flag cannot silence a later unrelated abort.
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "aborted"
		) {
			const message = event.message as AssistantMessage;
			if (this.#planInternalAbortPending) {
				message.errorMessage = SILENT_ABORT_MARKER;
				message.errorId = AIError.create(AIError.Flag.SilentAbort);
				this.#planInternalAbortPending = false;
			} else if (this.#pendingAbortErrorId) {
				message.errorId = this.#pendingAbortErrorId;
				this.#pendingAbortErrorId = undefined;
			}
		}

		const interruptedThinkingMessage =
			event.type === "message_end" && event.message.role === "assistant"
				? this.#demoteInterruptedThinkingOnUserInterrupt(event.message as AssistantMessage)
				: undefined;
		// `message_end` handling is fire-and-forget from agent-core. Make the
		// hidden continuity turn visible to the next prompt before any awaited
		// extension delivery or persistence can stall this handler.
		if (interruptedThinkingMessage) {
			this.agent.appendMessage(interruptedThinkingMessage);
		}

		const messageEndPersistence =
			event.type === "message_end" ? this.#createMessageEndPersistenceSlot(event.message) : undefined;

		// Deobfuscate assistant message content for display emission — the LLM echoes back
		// obfuscated placeholders, but listeners (TUI, extensions, exporters) must see real
		// values. The original event.message stays obfuscated so the persistence path below
		// writes `#HASH#` tokens to the session file; convertToLlm re-obfuscates outbound
		// traffic on the next turn. Walks text, thinking, and toolCall arguments/intent.
		let displayEvent: AgentEvent = event;
		const obfuscator = this.#obfuscator;
		if (obfuscator && event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const deobfuscatedContent = deobfuscateAssistantContent(obfuscator, message.content);
			if (deobfuscatedContent !== message.content) {
				displayEvent = { ...event, message: { ...message, content: deobfuscatedContent } };
			}
		}

		if (event.type === "turn_start") {
			const usage = this.getSessionStats().tokens;
			this.#goalRuntime.onTurnStart(`turn-${++this.#goalTurnCounter}`, {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			});
		}

		if (event.type === "tool_execution_start") {
			this.#recordToolExecutionStart(event);
		}

		if (event.type !== "agent_end") {
			try {
				await this.#emitSessionEvent(displayEvent);
			} catch (error) {
				messageEndPersistence?.release();
				throw error;
			}
		}

		if (event.type === "turn_start") {
			this.#streamingEditGuard.reset();
			this.#ttsr.onTurnStart();
		}

		if (event.type === "turn_end") this.#ttsr.onTurnEnd();
		// Finalize the tool-choice queue's in-flight yield after tools have executed.
		// This must happen at turn_end (not message_end) because onInvoked handlers
		// run during tool execution, which happens between message_end and turn_end.
		if (event.type === "turn_end" && this.#toolChoiceQueue.hasInFlight) {
			const msg = event.message as AssistantMessage;
			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				this.#toolChoiceQueue.reject(msg.stopReason === "error" ? "error" : "aborted");
			} else {
				this.#toolChoiceQueue.resolve();
			}
		}
		if (event.type === "tool_execution_end") {
			if (event.toolName === "goal") {
				await this.#goalRuntime.onGoalToolCompleted();
			} else {
				await this.#goalRuntime.onToolCompleted(event.toolName);
			}
			this.#planModeReminderAwaitingProgress = false;
			if (
				event.toolName === "ask" ||
				writeDeviceDispatch(event.toolName, event.result)?.tool === PROPOSE_DEVICE_NAME
			) {
				this.#planModeReminderCount = 0;
				this.#planModeReminderAwaitingProgress = false;
			}
		}

		// Fire deferred mid-run shake after tool results are emitted and
		// persisted, so shake() sees the latest result in getBranch().
		if (event.type === "turn_end" && this.#midRunShakeDue) {
			this.#midRunShakeDue = false;
			await this.#runMidRunShake();
		}

		if (await this.#ttsr.checkMessageUpdate(event)) return;

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_start" ||
				event.assistantMessageEvent.type === "toolcall_delta" ||
				event.assistantMessageEvent.type === "toolcall_end")
		) {
			this.#streamingEditGuard.preCache(event);
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_end" || event.assistantMessageEvent.type === "toolcall_delta")
		) {
			this.#streamingEditGuard.maybeAbort(event);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			const persistMessageEnd = () => {
				// Check if this is a hook/custom message
				if (event.message.role === "hookMessage" || event.message.role === "custom") {
					// Persist as CustomMessageEntry
					this.sessionManager.appendCustomMessageEntry(
						event.message.customType,
						event.message.content,
						event.message.display,
						event.message.details,
						event.message.attribution ?? "agent",
					);
					if (event.message.role === "custom" && event.message.customType === "ttsr-injection") {
						this.#ttsr.markInjectedFromDetails(event.message.details);
					}
				} else {
					this.#persistSessionMessageIfMissing(event.message);
				}
			};
			if (messageEndPersistence) {
				await messageEndPersistence.persist(persistMessageEnd);
			} else {
				persistMessageEnd();
			}
			if (interruptedThinkingMessage) {
				this.sessionManager.appendCustomMessageEntry(
					interruptedThinkingMessage.customType,
					interruptedThinkingMessage.content,
					interruptedThinkingMessage.display,
					interruptedThinkingMessage.details,
					interruptedThinkingMessage.attribution,
				);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				// Fold this turn's timing into per-model perf aggregates (drives the
				// /models TPS/TTFT display). Errored turns measure nothing; aborted
				// turns with reported usage are still valid throughput samples.
				if (assistantMsg.stopReason !== "error" && assistantMsg.duration !== undefined) {
					this.settings.getStorage()?.recordModelPerf(`${assistantMsg.provider}/${assistantMsg.model}`, {
						outputTokens: assistantMsg.usage.output,
						durationMs: assistantMsg.duration,
						ttftMs: assistantMsg.ttft,
					});
				}
				if (
					assistantMsg.disabledFeatures?.includes("priority") &&
					this.serviceTierByFamily.anthropic === "priority"
				) {
					this.setServiceTierFamily("anthropic", undefined);
					this.emitNotice(
						"warning",
						"Priority/fast mode rejected for this model; retried without it. Fast mode is now off.",
						"priority",
					);
				}
				this.#ttsr.onAssistantMessageEnd(assistantMsg);
				if (this.#handoff.isGeneratingHandoff) {
					this.#maintenance.skipPostTurnMaintenanceAssistantTimestamp = assistantMsg.timestamp;
				}
				await this.#recovery.onAssistantSettledSuccessfully(assistantMsg);
				if (assistantMsg.provider === "opencode-go") {
					this.#modelRegistry.authStorage.recordUsageCost(assistantMsg.provider, assistantMsg.usage.cost.total, {
						sessionId: this.#activeProviderSessionId(),
						recordedAt: assistantMsg.timestamp,
						baseUrl: this.#modelRegistry.getProviderBaseUrl?.(assistantMsg.provider),
					});
				}
			}
			if (event.message.role === "toolResult") {
				const { toolName, toolCallId, isError, content } = event.message;
				const details = isRecord(event.message.details) ? event.message.details : undefined;
				const semanticResult = semanticToolResult(toolName, event.message);
				const semanticDetails = isRecord(semanticResult?.details) ? semanticResult.details : undefined;
				// Invalidate streaming edit cache when edit tool completes to prevent stale data
				const editedPath = details ? stringProperty(details, "path") : undefined;
				if (toolName === "edit" && editedPath) {
					this.#streamingEditGuard.invalidate(editedPath);
				}
				if (toolName === "todo" && !isError && details && this.#todo.onTodoResultDetails(details, toolCallId)) {
					this.#scheduleReplanTitleRefresh();
				}
				if (toolName === "todo" && isError) {
					const errorText = content.find(part => part.type === "text")?.text;
					const reminderText = [
						"<system-reminder>",
						"todo failed, so todo progress is not visible to the user.",
						errorText ? `Failure: ${errorText}` : "Failure: todo returned an error.",
						"Fix the todo payload and call todo again before continuing.",
						"</system-reminder>",
					].join("\n");
					await this.sendCustomMessage(
						{
							customType: "todo-error-reminder",
							content: reminderText,
							display: false,
							details: { toolName, errorText },
						},
						{ deliverAs: "nextTurn" },
					);
				}
				if (semanticResult?.toolName === "checkpoint" && !isError) {
					const checkpointEntryId = this.sessionManager.getEntries().at(-1)?.id ?? null;
					this.#checkpointState = {
						checkpointMessageCount: this.agent.state.messages.length,
						checkpointEntryId,
						startedAt:
							(semanticDetails && stringProperty(semanticDetails, "startedAt")) ?? new Date().toISOString(),
					};
					this.#pendingRewindReport = undefined;
					this.#lastCompletedRewind = undefined;
				}
				if (semanticResult?.toolName === "rewind" && !isError && this.#checkpointState) {
					const detailReport = semanticDetails ? (stringProperty(semanticDetails, "report")?.trim() ?? "") : "";
					const textReport = content?.find(part => part.type === "text")?.text?.trim() ?? "";
					const report = detailReport || textReport;
					if (report.length > 0) {
						this.#pendingRewindReport = report;
					}
				}
			}
		}

		// Check auto-retry and auto-compaction after agent completes
		if (event.type === "agent_end") {
			const settledMessages = event.messages;
			const activeMessages = this.agent.state.messages;
			// TTSR retry work runs concurrently and clears the live flag before
			// maintenance can emit agent_end, so preserve the state at settle entry.
			const ttsrAbortPendingAtAgentEnd = this.#ttsr.abortPending;
			const emitAgentEndNotification = async (options?: { willContinue?: boolean }) => {
				// Public agent_end is held out of the eager display pass and emitted
				// here after maintenance routing, tagged isTerminal so subscribers can
				// tell final settles from scheduled continuations.
				await this.#emitSessionEvent({ ...event, isTerminal: !options?.willContinue });
				void this.#emitAgentEndNotification(activeMessages, options).catch(err => {
					logger.error("Agent end extension notification failed", { err });
				});
			};
			const usage = this.getSessionStats().tokens;
			await this.#goalRuntime.onAgentEnd({
				currentUsage: {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				},
			});
			const fallbackAssistant = [...settledMessages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			const msg = this.#lastAssistantMessage ?? fallbackAssistant;
			this.#lastAssistantMessage = undefined;
			if (!msg) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				logger.debug("agent_end maintenance routing", {
					reason: "no-assistant-message",
					goalModeEnabled: this.#goalModeState?.enabled === true,
					goalStatus: this.#goalModeState?.goal.status,
				});
				await emitAgentEndNotification();
				return;
			}

			const yieldOnThisMessage = this.#assistantEndedWithSuccessfulYield(msg);
			const successfulYieldMessage = yieldOnThisMessage
				? msg
				: this.#findSuccessfulYieldAssistantMessage(settledMessages);

			const maintenanceRoute = (route: string, extra?: Record<string, unknown>) => {
				logger.debug("agent_end maintenance routing", {
					route,
					stopReason: msg.stopReason,
					provider: msg.provider,
					model: msg.model,
					contentBlocks: msg.content.length,
					hasToolCalls: msg.content.some(content => content.type === "toolCall"),
					hasText: msg.content.some(content => content.type === "text"),
					goalModeEnabled: this.#goalModeState?.enabled === true,
					goalStatus: this.#goalModeState?.goal.status,
					successfulYield: successfulYieldMessage !== undefined,
					...extra,
				});
			};
			maintenanceRoute("entered");

			// Surface provider stream failures in the main log. The routing trace
			// above is debug-only and drops the error fields, so a session dying
			// repeatedly on provider errors otherwise leaves no actionable trace
			// outside the session transcript (issue #6177).
			logProviderTurnError(msg);

			// Invalidate GitHub Copilot credentials on auth failure so stale tokens
			// aren't reused on the next request
			if (
				msg.stopReason === "error" &&
				msg.provider === "github-copilot" &&
				AIError.is(AIError.classifyMessage(msg), AIError.Flag.AuthFailed)
			) {
				await this.#modelRegistry.authStorage.remove("github-copilot");
			}

			if (this.#maintenance.skipPostTurnMaintenanceAssistantTimestamp === msg.timestamp) {
				this.#maintenance.skipPostTurnMaintenanceAssistantTimestamp = undefined;
				this.#lastSuccessfulYieldToolCallId = undefined;
				maintenanceRoute("skip-post-turn-maintenance");
				await emitAgentEndNotification();
				return;
			}

			const activeGoal = this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active";
			// A successful `yield` in this run is terminal for execution purposes.
			// Suppress empty-stop retry, unexpected-stop retry, queued-message drain,
			// and compaction-driven continuations for the rest of this prompt cycle:
			// the executor consumed the yield as the terminal result, so a trailing
			// empty/aborted assistant stop must NOT revive the agent loop. The
			// `#yieldTerminationPending` sticky flag clears on the next `prompt()`.
			if (successfulYieldMessage || this.#yieldTerminationPending) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				if (successfulYieldMessage && activeGoal) {
					maintenanceRoute(
						yieldOnThisMessage
							? "successful-yield-active-goal-checkCompaction"
							: "post-yield-trailing-stop-active-goal-checkCompaction",
					);
					const compactionTask = this.#maintenance.checkCompaction(successfulYieldMessage);
					this.#trackPostPromptTask(compactionTask);
					await compactionTask;
				} else if (successfulYieldMessage) {
					maintenanceRoute("successful-yield-no-active-goal");
				} else {
					maintenanceRoute("post-yield-trailing-stop-suppressed");
				}
				await emitAgentEndNotification();
				return;
			}
			this.#lastSuccessfulYieldToolCallId = undefined;

			// Empty-stop cleanup MUST run before any compaction continuation: an
			// empty toolUse stop must be stripped from active context + session
			// history before we schedule another turn, otherwise the next
			// Anthropic turn carries a tool_use block with no matching
			// tool_result and corrupts message history. The handler also
			// schedules its own retry, so a real empty stop never needs the
			// active-goal threshold pre-empt below.
			if (await this.#recovery.handleEmptyAssistantStop(msg)) {
				maintenanceRoute("empty-stop-handled");
				await emitAgentEndNotification({ willContinue: true });
				return;
			}

			let compactionResult = COMPACTION_CHECK_NONE;
			let checkedCompaction = false;
			if (activeGoal) {
				maintenanceRoute("active-goal-pre-empt-checkCompaction");
				const compactionTask = this.#maintenance.checkCompaction(msg);
				this.#trackPostPromptTask(compactionTask);
				compactionResult = await compactionTask;
				checkedCompaction = true;
				const compactionContinues = compactionResult.deferredHandoff || compactionResult.continuationScheduled;
				if (compactionContinues || compactionResult.automaticContinuationBlocked) {
					maintenanceRoute("active-goal-pre-empt-compaction-handled", {
						deferredHandoff: compactionResult.deferredHandoff,
						continuationScheduled: compactionResult.continuationScheduled,
						automaticContinuationBlocked: compactionResult.automaticContinuationBlocked === true,
					});
					this.#recovery.resolveRetry();
					await emitAgentEndNotification(
						compactionResult.continuationScheduled ? { willContinue: true } : undefined,
					);
					return;
				}
			}

			if (await this.#recovery.handleUnexpectedAssistantStop(msg)) {
				maintenanceRoute("unexpected-stop-handled");
				await emitAgentEndNotification({ willContinue: true });
				return;
			}

			if (this.#recovery.isRetryableReasonlessAbort(msg)) {
				const didRetry = await this.#recovery.handleRetryableError(msg, { allowModelFallback: false });
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}

			// A deliberate abort should settle the current turn, not trigger queued
			// continuations — except TTSR self-repair, which already scheduled a
			// hidden retry while #ttsrAbortPending is still true.
			if (msg.stopReason === "aborted") {
				this.#recovery.resolveRetry();
				this.#resetSessionStopContinuationState();
				await emitAgentEndNotification(ttsrAbortPendingAtAgentEnd ? { willContinue: true } : undefined);
				return;
			}
			// Fireworks Fast variants degrade to their base model on a failed turn —
			// including hard router errors the generic retry classifier rejects — so
			// run this gate before the standard retryability check.
			if (this.#recovery.isFireworksFastFallbackEligible(msg)) {
				const didRetry = await this.#recovery.handleRetryableError(msg, { fireworksFastFallback: true });
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}
			const resumeResolvedStreamStall = this.#recovery.canResumeResolvedStreamStall(msg);
			if (resumeResolvedStreamStall || this.#recovery.isRetryableError(msg)) {
				const didRetry = await this.#recovery.handleRetryableError(
					msg,
					resumeResolvedStreamStall ? { preserveFailedTurn: true } : undefined,
				);
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			} else if (this.#recovery.isHardErrorFallbackEligible(msg)) {
				// A non-retryable hard error on a model covered by a configured
				// fallback chain: retrying the SAME model is pointless, but a
				// DIFFERENT model is a fresh chance — consult the chain before
				// surfacing the failure. #handleRetryableError bails out (no
				// backoff-retry of the failing model) when no switch happens.
				const didRetry = await this.#recovery.handleRetryableError(msg, { hardErrorFallback: true });
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}
			// Classifier refusals are persisted-skipped above; also prune the trailing
			// stub from active context so the next turn's prompt does not replay it.
			// Keep a reference for post-settle readers (print mode, task executor via
			// getLastAssistantMessage) — pruning made the terminal error invisible to
			// anything inspecting agent state after prompt() resolved.
			// Fall through to the standard error tail so `session_stop` hooks (block,
			// continue, telemetry) still fire — matching the pre-fix flow for
			// `stopReason === "error"`.
			if (this.#recovery.isClassifierRefusal(msg)) {
				this.#prunedTerminalRefusal = msg;
				this.#recovery.removeAssistantMessageFromActiveContext(msg);
			} else if (!AIError.isContextOverflow(msg, this.model?.contextWindow ?? 0)) {
				// No retry, fallback, or compaction continuation fired: this errored
				// turn ends the run. #persistSessionMessageIfMissing dropped it as an
				// empty error turn, so record it here — otherwise the JSONL stops at
				// the last tool result and the provider's errorMessage is lost (#6249).
				// Idempotent and a no-op for non-empty turns. Content-less overflow
				// rejections stay live-UI only per the auto-compaction progress guard:
				// persisting one would replay an empty assistant turn on reload.
				await this.#recovery.persistTerminalEmptyErrorTurn(msg);
			}
			this.#recovery.resolveRetry();

			if (!checkedCompaction) {
				maintenanceRoute("bottom-checkCompaction");
				const compactionTask = this.#maintenance.checkCompaction(msg);
				this.#trackPostPromptTask(compactionTask);
				compactionResult = await compactionTask;
			}
			await this.#recovery.onErrorSettledWithoutRetry(msg, compactionResult);
			// Stop-time todo reconciliation only fires at a text-only final stop. A run
			// that ends still mid-tool-use (deadline hit, context full, etc.) skips the
			// reminder so we don't pile a follow-up onto an already in-flight turn.
			// Mid-run sync is handled separately via #takeMidRunTodoNudge so a long
			// tool-use loop still gets prodded to keep the live HUD honest (issue #3651).

			// When compaction queued recovery or blocked automatic continuation,
			// skip periodic shake and any rewind/todo/session_stop passes:
			// any reminder or hook continuation we append here would race the
			// handoff, retry, auto-continue prompt, or queued-message drain
			// that already owns the next turn.
			if (
				compactionResult.deferredHandoff ||
				compactionResult.continuationScheduled ||
				compactionResult.automaticContinuationBlocked
			) {
				await emitAgentEndNotification(compactionResult.continuationScheduled ? { willContinue: true } : undefined);
				return;
			}

			// When compaction pruned the trailing assistant (overflow / length
			// stop with no recovery path), periodic shake would rebuild agent.state
			// from persisted entries and reintroduce the pruned assistant into the
			// prompt. Skip it but allow normal agent_end processing (session_stop
			// hooks, rewind, todo checks) to continue.
			if (!compactionResult.tailPruned) {
				// Periodic shake — independent of compaction strategy/auto-compaction
				await this.#runPeriodicShake();
			} else {
				// Consume the due counter so the next normal turn doesn't immediately
				// fire shake and reintroduce the pruned assistant via state rebuild.
				this.#shakeToolCallCounter = 0;
			}
			// Check for incomplete todos only after a final assistant stop, not intermediate tool-use turns.
			const hasToolCalls = msg.content.some(content => content.type === "toolCall");
			if (hasToolCalls) {
				await emitAgentEndNotification();
				return;
			}

			if (msg.stopReason !== "error") {
				if (this.#enforceRewindBeforeYield()) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
				const planModeContinuationScheduled = await this.#enforcePlanModeDecisionAtSettle();
				if (planModeContinuationScheduled) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
				const todoContinuationScheduled = await this.#todo.checkCompletion(msg);
				if (todoContinuationScheduled) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}
			// A pending async wake means this settle is a scheduling pause, not
			// the terminal stop: the async-result delivery continues the loop and
			// the real stop settles later. Defer the session_stop hook pass until
			// the session is fully idle (the todo reminder above defers the same
			// way inside #checkTodoCompletion).
			if (this.#hasPendingAsyncWake()) {
				await emitAgentEndNotification({ willContinue: true });
				return;
			}
			const sessionStopWillContinue = await this.#emitSessionStopEvent(activeMessages, msg);
			await emitAgentEndNotification(sessionStopWillContinue ? { willContinue: true } : undefined);
		}
	};

	#ensurePostPromptTasksPromise(): void {
		if (this.#postPromptTasksPromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#postPromptTasksPromise = promise;
		this.#postPromptTasksResolve = resolve;
	}

	#resolvePostPromptTasks(): void {
		if (!this.#postPromptTasksResolve) return;
		this.#postPromptTasksResolve();
		this.#postPromptTasksResolve = undefined;
		this.#postPromptTasksPromise = undefined;
	}

	#trackPostPromptTask(task: Promise<unknown>): void {
		this.#postPromptTasks.add(task);
		this.#ensurePostPromptTasksPromise();
		void task
			.catch(() => {})
			.finally(() => {
				this.#postPromptTasks.delete(task);
				if (this.#postPromptTasks.size === 0) {
					this.#resolvePostPromptTasks();
				}
			});
	}

	#schedulePostPromptTask(
		task: (signal: AbortSignal) => Promise<void>,
		options?: { delayMs?: number; generation?: number; onSkip?: (reason: PostPromptSkipReason) => void },
	): void {
		const delayMs = options?.delayMs ?? 0;
		const signal = this.#postPromptTasksAbortController.signal;
		const scheduled = (async () => {
			if (delayMs > 0) {
				try {
					await scheduler.wait(delayMs, { signal });
				} catch {
					return;
				}
			}
			if (signal.aborted) {
				options?.onSkip?.("aborted");
				return;
			}
			if (options?.generation !== undefined && this.#promptGeneration !== options.generation) {
				options.onSkip?.("stale-generation");
				return;
			}
			await task(signal);
		})();
		this.#trackPostPromptTask(scheduled);
	}

	#skipAgentContinue(reason: AgentContinueSkipReason, options: ScheduledAgentContinueOptions | undefined): void {
		logger.debug("agent.continue skipped after scheduling", { reason });
		options?.onSkip?.(reason);
	}

	#scheduleAgentContinue(options?: ScheduledAgentContinueOptions): void {
		this.#schedulePostPromptTask(
			async signal => {
				// Defense in depth: if compaction/handoff slipped onto the post-prompt queue
				// alongside us (e.g. via a scheduler we don't own), refuse to start a fresh
				// streaming turn — agent.continue() here would race the handoff's session
				// reset. The first-class fix is in #checkCompaction/the agent_end handler,
				// but this guard catches anything that bypasses that path.
				if (signal.aborted || this.#isDisposed || this.isCompacting || this.isGeneratingHandoff) {
					this.#skipAgentContinue("session-unavailable", options);
					return;
				}
				if (options?.shouldContinue && !options.shouldContinue()) {
					this.#skipAgentContinue("should-continue-false", options);
					return;
				}
				this.#beginInFlight();
				try {
					await this.#recovery.maybeRestoreRetryFallbackPrimary();
					if (
						this.settings.get("retry.modelFallback") &&
						this.settings.get("retry.usageAwareFallback") &&
						!(await this.#runUsageAwarePreflight())
					) {
						this.#skipAgentContinue("session-unavailable", options);
						return;
					}
					if (signal.aborted || this.#isDisposed) {
						this.#skipAgentContinue("post-restore-unavailable", options);
						return;
					}
					await this.agent.continue();
				} catch (error) {
					logger.warn("agent.continue failed after scheduling", {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
					options?.onError?.();
				} finally {
					this.#endInFlight();
				}
			},
			{
				delayMs: options?.delayMs,
				generation: options?.generation,
				onSkip: reason => this.#skipAgentContinue(reason, options),
			},
		);
	}

	#scheduleCompactionContinuation(options: {
		generation: number;
		autoContinue: boolean;
		terminalTextAnswer: boolean;
		suppressContinuation: boolean;
	}): boolean {
		if (options.suppressContinuation) return false;
		if (this.agent.hasQueuedMessages()) {
			this.#scheduleAgentContinue({
				delayMs: 100,
				generation: options.generation,
				shouldContinue: () => this.agent.hasQueuedMessages(),
			});
			return true;
		}
		if (!options.autoContinue) return false;
		const activeGoal = this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active";
		if (options.terminalTextAnswer && !activeGoal) return false;
		return this.#scheduleAutoContinuePrompt(options.generation);
	}

	#scheduleAutoContinuePrompt(generation: number): boolean {
		const continuePrompt = async () => {
			// Compaction summarizes away the first-message eager preludes, so re-assert the
			// delegate-via-tasks / phased-todo reminders on this auto-resumed turn. This runs
			// at invocation (past the abort check below), so an aborted continuation queues
			// nothing; scoped to this request via prependMessages, never the shared queue.
			const eagerNudges = this.#todo.buildPostCompactionEagerNudges();
			await this.#promptWithMessage(
				{
					role: "developer",
					content: [{ type: "text", text: autoContinuePrompt }],
					attribution: "agent",
					timestamp: Date.now(),
				},
				autoContinuePrompt,
				{
					skipPostPromptRecoveryWait: true,
					prependMessages: eagerNudges.length > 0 ? eagerNudges : undefined,
				},
			);
		};
		this.#schedulePostPromptTask(
			async signal => {
				await Promise.resolve();
				if (signal.aborted) return;
				if (this.agent.hasQueuedMessages()) {
					this.#scheduleAgentContinue({
						generation,
						shouldContinue: () => this.agent.hasQueuedMessages(),
					});
					return;
				}
				await continuePrompt();
			},
			{ generation },
		);
		return true;
	}

	async #cancelPostPromptTasks(): Promise<void> {
		this.#postPromptTasksAbortController.abort();
		this.#postPromptTasksAbortController = new AbortController();
		this.#ttsr.resolveResume();

		const pendingTasks = Array.from(this.#postPromptTasks);
		if (pendingTasks.length === 0) {
			this.#resolvePostPromptTasks();
			return;
		}

		await Promise.allSettled(pendingTasks);
		if (this.#postPromptTasks.size === 0) {
			this.#resolvePostPromptTasks();
		}
	}
	/**
	 * Wait for retry, TTSR resume, and any background continuation to settle.
	 * Loops because a TTSR continuation can trigger a retry (or vice-versa),
	 * and fire-and-forget `agent.continue()` may still be streaming after
	 * the TTSR resume gate resolves.
	 */
	async #waitForPostPromptRecovery(generation?: number): Promise<void> {
		while (true) {
			// An abort bumps #promptGeneration. When this wait runs on behalf of a
			// specific prompt turn, stop as soon as that turn has been superseded:
			// its promise must resolve on the abort, not block on a queued
			// steer/follow-up that the post-abort drain starts as a fresh turn.
			if (generation !== undefined && this.#promptGeneration !== generation) return;
			const retryPromise = this.#recovery.retryPromise;
			if (retryPromise) {
				await retryPromise;
				continue;
			}
			const ttsrResumeGate = this.#ttsr.resumeGate;
			if (ttsrResumeGate) {
				await ttsrResumeGate;
				continue;
			}
			if (this.#postPromptTasksPromise) {
				await this.#postPromptTasksPromise;
				continue;
			}
			// Tracked post-prompt tasks cover deferred continuations scheduled from
			// event handlers. Keep the streaming fallback for direct agent activity
			// outside the scheduler.
			if (this.agent.state.isStreaming) {
				await this.agent.waitForIdle();
				continue;
			}
			break;
		}
	}

	#afterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		if (
			this.#isTerminalYieldToolResult({
				toolName: ctx.toolCall.name,
				isError: ctx.isError,
				result: ctx.result,
			})
		) {
			this.#markTerminalYieldToolCall(ctx.toolCall.id);
			this.#synchronouslyTerminatedYieldToolCallIds.add(ctx.toolCall.id);
			this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
		}
		return this.#ttsr.afterToolCall(ctx);
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	#findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	#localProtocolOptions(): LocalProtocolOptions {
		return {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		};
	}

	#resetSessionStopContinuationState(): void {
		this.#sessionStopContinuationCount = 0;
		this.#sessionStopHookActive = false;
	}

	#clearPendingSessionStopContinuations(): void {
		if (!this.#pendingNextTurnMessages.some(message => message.customType === "session-stop-continuation")) {
			return;
		}
		this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(
			message => message.customType !== "session-stop-continuation",
		);
	}

	#sessionStopContinuationContext(result: SessionStopEventResult | undefined): string | undefined {
		if (!result) return undefined;
		const additionalContext =
			typeof result.additionalContext === "string" && result.additionalContext.length > 0
				? result.additionalContext
				: undefined;
		const reason = typeof result.reason === "string" && result.reason.length > 0 ? result.reason : undefined;
		if (result.continue === true) {
			return additionalContext ?? reason;
		}
		if (result.decision === "block") {
			return reason ?? additionalContext;
		}
		return undefined;
	}

	async #emitAgentEndNotification(messages: AgentMessage[], options?: { willContinue?: boolean }): Promise<void> {
		await this.#extensionRunner?.emit({
			type: "agent_end",
			messages,
			willContinue: options?.willContinue,
		});
	}

	/** @returns true when a hidden session_stop continuation turn was scheduled. */
	async #emitSessionStopEvent(
		messages: AgentMessage[],
		lastAssistantMessage = this.getLastAssistantMessage(),
	): Promise<boolean> {
		if (this.#abortInProgress || this.#isDisposed) {
			this.#resetSessionStopContinuationState();
			return false;
		}
		if (this.#agentKind === "sub" || !this.#extensionRunner?.hasHandlers("session_stop")) {
			return false;
		}
		const generation = this.#promptGeneration;
		const result = await this.#extensionRunner.emitSessionStop({
			messages,
			turn_id: Math.max(0, this.#turnIndex - 1),
			last_assistant_message: lastAssistantMessage,
			session_id: this.sessionId,
			session_file: this.sessionFile,
			stop_hook_active: this.#sessionStopHookActive,
		});
		if (this.#promptGeneration !== generation || this.#abortInProgress || this.#isDisposed) {
			this.#resetSessionStopContinuationState();
			return false;
		}
		const additionalContext = this.#sessionStopContinuationContext(result);
		if (!additionalContext) {
			this.#resetSessionStopContinuationState();
			return false;
		}
		if (this.#sessionStopContinuationCount >= SESSION_STOP_CONTINUATION_CAP) {
			logger.warn("session_stop continuation cap reached", {
				sessionId: this.sessionId,
				cap: SESSION_STOP_CONTINUATION_CAP,
			});
			this.#resetSessionStopContinuationState();
			return false;
		}
		this.#sessionStopContinuationCount++;
		this.#sessionStopHookActive = true;
		this.#queueHiddenNextTurnMessage(
			{
				role: "custom",
				customType: "session-stop-continuation",
				content: additionalContext,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			true,
		);
		return true;
	}

	/** Emit extension events based on session events */
	async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.#extensionRunner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await this.#extensionRunner.emit({ type: "agent_start" });
			return;
		}

		if (!this.#extensionRunner.hasHandlers(event.type)) return;
		if (event.type === "agent_end") {
			// `agent_end` extension notification is emitted from the settled
			// agent_end maintenance path so `session_stop` control hooks are not
			// blocked by unrelated notification-only work.
		} else if (event.type === "turn_start") {
			const hookEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.#turnIndex,
				timestamp: Date.now(),
			};
			await this.#extensionRunner.emit(hookEvent);
		} else if (event.type === "turn_end") {
			const hookEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.#turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.#extensionRunner.emit(hookEvent);
			this.#turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "auto_compaction_start") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_start",
				reason: event.reason,
				action: event.action,
			});
		} else if (event.type === "auto_compaction_end") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_end",
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			});
		} else if (event.type === "auto_retry_start") {
			await this.#extensionRunner.emit({
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				errorId: event.errorId,
			});
		} else if (event.type === "auto_retry_end") {
			await this.#extensionRunner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
				recoveredErrors: event.recoveredErrors,
			});
		} else if (event.type === "ttsr_triggered") {
			await this.#extensionRunner.emit({ type: "ttsr_triggered", rules: event.rules });
		} else if (event.type === "todo_reminder") {
			await this.#extensionRunner.emit({
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		} else if (event.type === "goal_updated") {
			await this.#extensionRunner.emit({
				type: "goal_updated",
				goal: event.goal,
				state: event.state,
			});
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	subscribeCommandMetadataChanged(listener: CommandMetadataChangedListener): () => void {
		this.#commandMetadataChangedListeners.push(listener);
		return () => {
			const index = this.#commandMetadataChangedListeners.indexOf(listener);
			if (index !== -1) {
				this.#commandMetadataChangedListeners.splice(index, 1);
			}
		};
	}

	#notifyCommandMetadataChanged(): void {
		const listeners = [...this.#commandMetadataChangedListeners];
		for (const listener of listeners) {
			try {
				void listener();
			} catch (err) {
				logger.error("Command metadata listener threw", { err });
			}
		}
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	#reconnectToAgent(): void {
		if (this.#unsubscribeAgent) return; // Already connected
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	#activeProviderSessionId(sessionId?: string): string {
		return this.#freshProviderSessionId ?? this.#providerSessionId ?? sessionId ?? this.sessionManager.getSessionId();
	}

	#adoptInheritedProviderPromptCacheKey(): void {
		const key = this.sessionManager.getHeader()?.providerPromptCacheKey;
		if (!key) return;
		if (this.#inheritedProviderPromptCacheKey !== undefined || this.agent.promptCacheKey === undefined) {
			this.agent.promptCacheKey = key;
			this.#inheritedProviderPromptCacheKey = key;
		}
	}

	#clearInheritedProviderPromptCacheKey(): void {
		const key = this.#inheritedProviderPromptCacheKey;
		this.#inheritedProviderPromptCacheKey = undefined;
		if (key !== undefined && this.agent.promptCacheKey === key) {
			this.agent.promptCacheKey = undefined;
		}
	}

	/**
	 * Set agent.sessionId from the session manager and install a dynamic
	 * metadata resolver so every Anthropic API request carries
	 * `metadata.user_id` shaped like real Claude Code's `getAPIMetadata` output:
	 * `{ session_id, account_uuid, device_id }`. `account_uuid` is included only
	 * when an Anthropic OAuth credential with a known account UUID is loaded;
	 * `device_id` is derived from both the persistent omp install id and that
	 * account UUID. Resolving live keeps the value in sync with auth-state changes
	 * (login/logout, token refresh that surfaces a new account UUID) without
	 * needing to re-call `#syncAgentSessionId()` on every such event.
	 */
	#syncAgentSessionId(sessionId?: string): void {
		const sid = this.#activeProviderSessionId(sessionId);
		this.agent.sessionId = sid;
		this.agent.setMetadataResolver((provider: string) =>
			buildSessionMetadata(sid, provider, this.#modelRegistry.authStorage),
		);
	}

	/** Run one abortable auto-learn capture outside the primary agent loop. */
	async runAutolearnCapture(capture: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.#autolearnCaptureTask || this.#isDisposed) return;
		const controller = new AbortController();
		this.#autolearnCaptureAbortController = controller;
		const task = (async () => {
			try {
				await capture(controller.signal);
			} catch (error) {
				if (!controller.signal.aborted) throw error;
			} finally {
				if (this.#autolearnCaptureAbortController === controller) {
					this.#autolearnCaptureAbortController = undefined;
				}
			}
		})();
		this.#autolearnCaptureTask = task;
		try {
			await task;
		} finally {
			if (this.#autolearnCaptureTask === task) this.#autolearnCaptureTask = undefined;
		}
	}

	#abortAutolearnCapture(): void {
		this.#autolearnCaptureAbortController?.abort();
	}

	async #drainAutolearnCapture(): Promise<void> {
		const task = this.#autolearnCaptureTask;
		if (!task) return;
		try {
			await withTimeout(task, 3_000, "Timed out draining auto-learn capture during dispose");
		} catch (error) {
			logger.warn("Auto-learn capture did not settle during dispose", { error: String(error) });
		}
	}

	/** True once dispose() has begun; deferred background work (e.g. the deferred
	 *  MCP discovery task in sdk.ts) must not touch the session past this point. */
	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	markMovedFromEmptySessionFile(sessionFile: string): void {
		this.#movedFromEmptySessionFile = path.resolve(sessionFile);
	}

	/**
	 * Synchronously mark the session as disposing so new work is rejected
	 * immediately: eval starts throw, queued asides are dropped, and the
	 * aside provider is detached. Idempotent; `dispose()` runs it first.
	 *
	 * Wrappers that await other teardown before delegating to `dispose()` MUST
	 * call this before their first await — otherwise work started in that async
	 * gap slips past the disposal guards.
	 */
	beginDispose(): void {
		this.#isDisposed = true;
		this.#memory.cancelLocalMemoryStartup();
		this.#titleGenerationAbortController.abort();
		this.#abortAutolearnCapture();
		this.#irc.flushPending();
		this.yieldQueue.clear();
		this.agent.setAsideMessageProvider(undefined);
		this.agent.hasIrcInterrupts = undefined;
		this.#advisors.stopRuntime();
		this.#eval.beginDispose();
	}

	/**
	 * Remove all listeners, flush pending writes, and disconnect from agent.
	 * Call this when completely done with the session.
	 *
	 * Idempotent: concurrent or repeated calls share one settled promise. The
	 * keypress `InteractiveMode.shutdown()` path and the postmortem
	 * `SIGTERM`/`SIGHUP`/`uncaughtException` callback can both target this
	 * method, so a second invocation must never re-emit `session_shutdown` or
	 * double-drain the owned `AsyncJobManager` (issue #4080).
	 */
	#disposeCall?: Promise<void>;
	dispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		if (!this.#disposeCall) this.#disposeCall = this.#doDispose(options);
		return this.#disposeCall;
	}

	async #disposeOwnedAsyncJobs(): Promise<void> {
		// Unregister before cancelling: a job completing during teardown must
		// dead-letter rather than enqueue a follow-up into a disposing session.
		this.#unregisterAsyncDeliverySink?.();
		this.#unregisterAsyncDeliverySink = undefined;
		this.#cancelOwnAsyncJobs();
		const manager = this.#ownedAsyncJobManager;
		if (!manager) return;

		try {
			const drained = await manager.dispose({ timeoutMs: 3_000 });
			const deliveryState = manager.getDeliveryState();
			if (drained === false && deliveryState) {
				logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState });
			}
		} finally {
			if (AsyncJobManager.instance() === manager) {
				AsyncJobManager.setInstance(undefined);
			}
		}
	}

	async #releaseOwnedBrowserTabs(ownerId: string | undefined): Promise<void> {
		if (!ownerId) return;
		try {
			const released = await withTimeout(
				releaseTabsForOwner(ownerId, { kill: true }),
				3_000,
				"Timed out releasing owned browser tabs during dispose",
			);
			if (released > 0) {
				logger.debug("Released owned browser tabs during dispose", { ownerId, released });
			}
		} catch (error) {
			logger.warn("Failed to release owned browser tabs during dispose", { error: String(error) });
		}
	}

	async #releaseOwnedComputerSessions(ownerId: string | undefined): Promise<void> {
		if (!ownerId) return;
		try {
			await withTimeout(
				releaseComputerSessionsForOwner(ownerId),
				3_000,
				"Timed out releasing native computer session during dispose",
			);
		} catch (error) {
			logger.warn("Failed to release native computer session during dispose", { error: String(error) });
		}
	}

	async #disconnectOwnedMcp(): Promise<void> {
		if (!this.#disconnectOwnedMcpManager) return;
		try {
			await withTimeout(
				this.#disconnectOwnedMcpManager(),
				3_000,
				"Timed out disconnecting owned MCP manager during dispose",
			);
		} catch (error) {
			logger.warn("Failed to disconnect owned MCP manager during dispose", { error: String(error) });
		}
	}

	async #disposeMnemopi(
		state: MnemopiSessionState | undefined,
		consolidateTimeoutMs: number | undefined,
	): Promise<void> {
		try {
			await state?.dispose({ timeoutMs: consolidateTimeoutMs });
		} finally {
			// Consolidation may embed final memories, so terminate its worker only afterward.
			await shutdownMnemopiEmbedClient();
		}
	}

	async #doDispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		this.beginDispose();
		this.#recordSessionExit(options.reason ?? "dispose");
		this.#cancelExitRecorder?.();
		this.#cancelExitRecorder = undefined;
		try {
			await emitSessionShutdownEvent(this.#extensionRunner);
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: String(error) });
		}

		// Stop fallback extension timers before aborting deferred work they could enqueue.
		this.#fallbackExtensionTimers?.clearAll();
		this.abortRetry();
		this.abortCompaction();
		const postPromptDrain = this.#cancelPostPromptTasks();
		this.agent.abort();
		try {
			await withTimeout(postPromptDrain, 5_000, "Timed out draining post-prompt tasks during dispose");
		} catch (error) {
			logger.warn("Post-prompt tasks still draining at dispose deadline", { error: String(error) });
		}
		await this.#drainAutolearnCapture();
		await this.#memory.transition;

		const hindsightState = this.getHindsightSessionState();
		const mnemopiState = setMnemopiSessionState(this, undefined);
		const advisorRecorderClosed = this.#advisors.recorderClosed();
		const results = await Promise.allSettled([
			this.#disposeOwnedAsyncJobs(),
			this.#eval.disposeKernels(),
			this.#releaseOwnedBrowserTabs(this.sessionManager.getSessionId()),
			this.#releaseOwnedComputerSessions(this.#eval.getKernelOwnerId()),
			shutdownTinyTitleClient(),
			this.#disconnectOwnedMcp(),
			advisorRecorderClosed,
			hindsightState?.flushRetainQueue() ?? Promise.resolve(),
			this.#disposeMnemopi(mnemopiState, options.mnemopiConsolidateTimeoutMs),
		]);
		for (const result of results) {
			if (result.status === "rejected") {
				logger.warn("Session dispose subsystem failed during parallel teardown", {
					error: String(result.reason),
				});
			}
		}

		this.#releasePowerAssertion();
		await cleanupEmptyMoveSession(this.sessionManager, this.#movedFromEmptySessionFile);
		this.#movedFromEmptySessionFile = undefined;
		// All teardown branches that can append session entries have settled.
		await this.sessionManager.close();
		this.#closeAllProviderSessions("dispose");
		this.setHindsightSessionState(undefined);
		hindsightState?.dispose();
		this.#disconnectFromAgent();
		if (this.#unsubscribeAppendOnly) {
			this.#unsubscribeAppendOnly();
			this.#unsubscribeAppendOnly = undefined;
		}
		if (this.#unsubscribeModelRoles) {
			this.#unsubscribeModelRoles();
			this.#unsubscribeModelRoles = undefined;
		}
		this.#eventListeners = [];
	}

	#closeAllProviderSessions(reason: string): void {
		for (const [providerKey, state] of this.#providerSessionState) {
			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state", {
					providerKey,
					reason,
					error: String(error),
				});
			}
		}

		this.#providerSessionState.clear();
	}

	freshSession(): FreshSessionResult | undefined {
		if (this.isStreaming) return undefined;
		const previousSessionId = this.sessionId;
		const closedProviderSessions = this.#providerSessionState.size;
		this.#closeAllProviderSessions("fresh session");
		this.#freshProviderSessionId = Bun.randomUUIDv7();
		this.#syncAgentSessionId();
		this.#memory.rekeyForCurrentSessionId();
		this.agent.appendOnlyContext?.invalidateForModelChange();
		return {
			previousSessionId,
			sessionId: this.sessionId,
			closedProviderSessions,
		};
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model | undefined {
		return this.agent.state.model;
	}

	/** Resolved selector while retry routing is using a fallback model. */
	get retryFallbackModel(): string | undefined {
		return this.#recovery.retryFallbackModel;
	}

	/** Install the interactive decision surface for reserve-triggered model changes. */
	setUsageFallbackConfirmer(
		confirmer: ((confirmation: UsageFallbackConfirmation) => Promise<boolean>) | undefined,
	): void {
		this.#usageFallbackConfirmer = confirmer;
	}

	async #runUsageAwarePreflight(): Promise<boolean> {
		const generation = this.#promptGeneration;
		const controller = new AbortController();
		this.#usagePreflightAbortControllers.add(controller);
		try {
			await this.#maybeApplyUsageAwareFallback(controller.signal);
			return !controller.signal.aborted && this.#promptGeneration === generation;
		} catch (error) {
			if (controller.signal.aborted || this.#promptGeneration !== generation) return false;
			throw error;
		} finally {
			this.#usagePreflightAbortControllers.delete(controller);
		}
	}

	async #confirmUsageFallback(confirmation: UsageFallbackConfirmation, signal: AbortSignal): Promise<boolean> {
		const confirmer = this.#usageFallbackConfirmer;
		if (!confirmer || signal.aborted) return false;
		const aborted = Promise.withResolvers<boolean>();
		const onAbort = () => aborted.resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([confirmer(confirmation), aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async #maybeApplyUsageAwareFallback(signal: AbortSignal): Promise<void> {
		if (!this.settings.get("retry.modelFallback") || !this.settings.get("retry.usageAwareFallback")) return;
		const currentModel = this.model;
		if (!currentModel) return;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.thinkingLevel);
		let health: ModelUsageHealth;
		try {
			health = await this.#modelRegistry.authStorage.getModelUsageHealth(currentModel.provider, {
				modelId: currentModel.id,
				sessionId: this.sessionId,
				baseUrl: currentModel.baseUrl,
				reserveFraction: this.settings.get("retry.usageReservePct") / 100,
				signal,
			});
		} catch (error) {
			logger.debug("Usage-aware runtime preflight failed open", {
				provider: currentModel.provider,
				model: currentModel.id,
				error: String(error),
			});
			return;
		}
		if (signal.aborted) return;

		if (health.state === "healthy") {
			this.#usageReserveApprovedSelector = undefined;
			const selected = health.accounts.find(account => account.selected);
			if (selected && selected.state !== "healthy" && health.accounts.some(account => account.state === "healthy")) {
				this.#modelRegistry.authStorage.releaseSessionCredentialForReselection(
					currentModel.provider,
					this.sessionId,
				);
			}
			return;
		}
		if (health.state === "unknown") {
			this.#usageReserveApprovedSelector = undefined;
			return;
		}
		const reservePolicy = this.settings.get("retry.usageReservePolicy");
		if (reservePolicy === "fail-closed") {
			const condition = health.state === "reserve" ? "reserve reached" : "usage depleted";
			throw new Error(`${condition} for ${currentSelector}; reserve policy is fail-closed.`);
		}

		const role = this.#recovery.resolveRetryFallbackRole(currentSelector, currentModel);
		if (!role) return;
		let fallback: { selector: RetryFallbackSelector; apiKey: string } | undefined;
		for (const candidate of this.#recovery.findRetryFallbackCandidates(role, currentSelector, currentModel)) {
			if (this.#recovery.isRetryFallbackSelectorSuppressed(candidate)) continue;
			const resolved = resolveModelOverride([candidate.raw], this.#modelRegistry, this.settings);
			const candidateModel = resolved.model ?? this.#modelRegistry.find(candidate.provider, candidate.id);
			if (!candidateModel) continue;
			if (!this.#modelRegistry.hasConfiguredAuth(candidateModel)) continue;
			try {
				const candidateHealth = await this.#modelRegistry.authStorage.getModelUsageHealth(candidateModel.provider, {
					modelId: candidateModel.id,
					sessionId: this.sessionId,
					baseUrl: candidateModel.baseUrl,
					reserveFraction: this.settings.get("retry.usageReservePct") / 100,
					signal,
				});
				if (signal.aborted) return;
				if (candidateHealth.state === "depleted" || candidateHealth.state === "reserve") continue;
				if (candidateHealth.state === "healthy") {
					const selected = candidateHealth.accounts.find(account => account.selected);
					if (
						selected &&
						selected.state !== "healthy" &&
						candidateHealth.accounts.some(account => account.state === "healthy")
					) {
						this.#modelRegistry.authStorage.releaseSessionCredentialForReselection(
							candidateModel.provider,
							this.sessionId,
						);
					}
				}
			} catch {
				if (signal.aborted) return;
				// Unknown usage fails open for an otherwise valid fallback.
			}
			if (signal.aborted) return;
			let apiKey: string | undefined;
			try {
				apiKey = await this.#modelRegistry.getApiKey(candidateModel, this.sessionId, { signal });
			} catch {
				if (signal.aborted) return;
				continue;
			}
			if (signal.aborted) return;
			if (!apiKey) continue;
			fallback = { selector: candidate, apiKey };
			break;
		}
		if (!fallback) return;

		if (health.state === "reserve") {
			if (reservePolicy === "confirm" && this.#usageFallbackConfirmer) {
				if (this.#usageReserveApprovedSelector === currentSelector) return;
				const selected = health.accounts.find(account => account.selected);
				const remainingFraction =
					selected?.remainingFraction ??
					health.accounts.reduce<number | undefined>(
						(minimum, account) =>
							account.remainingFraction === undefined
								? minimum
								: minimum === undefined
									? account.remainingFraction
									: Math.min(minimum, account.remainingFraction),
						undefined,
					);
				const shouldFallback = await this.#confirmUsageFallback(
					{
						from: currentSelector,
						to: fallback.selector.raw,
						remainingPercent: remainingFraction === undefined ? undefined : Math.max(0, remainingFraction * 100),
					},
					signal,
				);
				if (signal.aborted) return;
				if (!shouldFallback) {
					this.#usageReserveApprovedSelector = currentSelector;
					return;
				}
			}
		}

		if (signal.aborted) return;
		this.#usageReserveApprovedSelector = undefined;
		await this.#recovery.applyRetryFallbackCandidate(role, fallback.selector, currentSelector, {
			pinFallback: true,
			apiKey: fallback.apiKey,
			signal,
		});
	}

	/** Effective thinking level applied to the agent (the resolved level when `auto`). */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#models.thinkingLevel;
	}

	/** The selector the user configured: `auto` when auto mode is active, else the effective level. */
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#models.configuredThinkingLevel();
	}

	/** True when `auto` thinking mode is active. */
	get isAutoThinking(): boolean {
		return this.#models.isAutoThinking;
	}

	/** The level `auto` resolved to for the current turn (undefined until classified). */
	autoResolvedThinkingLevel(): Effort | undefined {
		return this.#models.autoResolvedThinkingLevel;
	}

	/** Live per-family service tiers (OpenAI / Anthropic / Google). */
	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#models.serviceTierByFamily;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#promptInFlightCount > 0;
	}

	get isAborting(): boolean {
		return this.agent.isAborting;
	}

	/** Wait until streaming, event persistence, and deferred recovery work are fully settled. */
	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
		await this.#advisors.waitForPendingCardEvents();
		await this.#waitForPostPromptRecovery();
	}
	/**
	 * Prevent advisor notes from starting hidden primary turns while a headless
	 * caller prints and drains the final primary response.
	 */
	prepareForHeadlessAdvisorDrain(): void {
		this.#advisors.prepareForHeadlessAdvisorDrain();
	}

	/**
	 * Wait for active advisor reviews and their emitted card events before a
	 * headless caller disposes the session. Returns `false` and logs work disposal
	 * will abandon when the shared deadline expires or an advisor fails.
	 */
	waitForAdvisorCatchup(timeoutMs: number): Promise<boolean> {
		return this.#advisors.waitForAdvisorCatchup(timeoutMs);
	}

	async drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const before = manager.getDeliveryState(ownerFilter);
		if (before.queued === 0 && !before.delivering) return false;
		const previousAllowAcpAgentInitiatedTurns = this.#allowAcpAgentInitiatedTurns;
		this.#allowAcpAgentInitiatedTurns = true;
		try {
			const drained = await manager.drainDeliveries({ timeoutMs: options?.timeoutMs, filter: ownerFilter });
			const after = manager.getDeliveryState(ownerFilter);
			return drained && (before.queued !== after.queued || before.delivering !== after.delivering);
		} finally {
			this.#allowAcpAgentInitiatedTurns = previousAllowAcpAgentInitiatedTurns;
		}
	}

	/**
	 * Most recent settled assistant message. A classifier-refusal turn pruned
	 * from active context at settle is still reported until the next run
	 * starts, so terminal-outcome consumers (print mode, task executor) see
	 * the refusal error rather than the previous turn — or nothing.
	 */
	getLastAssistantMessage(): AssistantMessage | undefined {
		return this.#prunedTerminalRefusal ?? this.#findLastAssistantMessage();
	}
	/** Current effective system prompt blocks (includes any per-turn extension modifications) */
	get systemPrompt(): string[] {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this.#recovery.attempt;
	}

	/** Names of tools currently exposed at the top level. */
	getActiveToolNames(): string[] {
		return this.#tools.getActiveToolNames();
	}

	/** Enabled top-level and discoverable tool names. */
	getEnabledToolNames(): string[] {
		return this.#tools.getEnabledToolNames();
	}

	/** Names of dynamic tools mounted under `xd://`. */
	getMountedXdevToolNames(): string[] {
		return this.#tools.getMountedXdevToolNames();
	}

	/** Whether the edit tool is registered in this session. */
	get hasEditTool(): boolean {
		return this.#tools.hasEditTool;
	}

	/** Looks up a registered tool by name. */
	getToolByName(name: string): AgentTool | undefined {
		return this.#tools.getToolByName(name);
	}

	/** Whether a registry entry came from a built-in factory. */
	hasBuiltInTool(name: string): boolean {
		return this.#tools.hasBuiltInTool(name);
	}

	/** Names of every registered tool. */
	getAllToolNames(): string[] {
		return this.#tools.getAllToolNames();
	}

	/** Installs and activates the ephemeral vibe tool set. */
	activateVibeTools(baseToolNames: string[]): Promise<void> {
		return this.#tools.activateVibeTools(baseToolNames);
	}

	/** Uninstalls vibe tools and activates the replacement set. */
	deactivateVibeTools(nextToolNames: string[]): Promise<void> {
		return this.#tools.deactivateVibeTools(nextToolNames);
	}

	/** Removes vibe tools without restoring a source-session snapshot. */
	removeVibeToolsPreservingActive(): Promise<void> {
		return this.#tools.removeVibeToolsPreservingActive();
	}

	#resolveActiveEditMode(): EditMode {
		return this.#tools.resolveActiveEditMode();
	}

	#syncAfterModelChange(previousEditMode: EditMode): Promise<void> {
		return this.#tools.syncAfterModelChange(previousEditMode);
	}

	/** Enabled MCP tools in their current presentation partition. */
	getSelectedMCPToolNames(): string[] {
		return this.#tools.getSelectedMCPToolNames();
	}

	#applyActiveToolsByName(toolNames: string[]): Promise<void> {
		return this.#tools.applyActiveToolsByName(toolNames);
	}

	#takePendingXdevMountNotice(): CustomMessage | undefined {
		return this.#tools.takePendingXdevMountNotice();
	}

	/** Rediscovers reloadable skills and refreshes prompt metadata. */
	refreshSkills(): Promise<void> {
		return this.#tools.refreshSkills();
	}

	/** Selects enabled tools, ignoring names absent from the registry. */
	setActiveToolsByName(toolNames: string[]): Promise<void> {
		return this.#tools.setActiveToolsByName(toolNames);
	}

	/** Restores an exact top-level versus `xd://` tool partition. */
	setActiveToolPresentation(toolNames: string[], mountedToolNames: string[]): Promise<void> {
		return this.#tools.setActiveToolPresentation(toolNames, mountedToolNames);
	}

	/**
	 * Session-scoped enable/disable for the settings-gated `computer` tool.
	 *
	 * Enabling builds the tool through {@link AgentSessionConfig.createComputerTool}
	 * on first use and activates it; disabling drops it from the active set while
	 * keeping the registry entry so repeated toggles reuse one desktop controller.
	 *
	 * @returns false when enabling was requested but this session cannot build the
	 * tool (e.g. restricted child sessions have no factory).
	 */
	setComputerToolEnabled(enabled: boolean): Promise<boolean> {
		return this.#tools.setComputerToolEnabled(enabled);
	}

	/** Cancels the local rollout-memory startup owned by this session. */
	cancelLocalMemoryStartup(): void {
		this.#memory.cancelLocalMemoryStartup();
	}

	/** Starts a new local rollout-memory generation and cancels its predecessor. */
	beginLocalMemoryStartup(): AbortSignal {
		return this.#memory.beginLocalMemoryStartup();
	}

	/** Releases the local startup slot if `signal` still owns it. */
	endLocalMemoryStartup(signal: AbortSignal): void {
		this.#memory.endLocalMemoryStartup(signal);
	}

	/** Applies the selected memory backend to runtime state, tools, and prompt. */
	applyMemoryBackend(): Promise<void> {
		return this.#memory.applyMemoryBackend();
	}

	/** Rebuilds the stable base prompt for the current tools and model. */
	refreshBaseSystemPrompt(): Promise<void> {
		return this.#tools.refreshBaseSystemPrompt();
	}

	#buildSystemPromptForAgentStart(promptText: string): Promise<string[]> {
		return this.#tools.buildSystemPromptForAgentStart(promptText);
	}

	/** Replaces connected MCP tools and enables them immediately. */
	refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
		return this.#tools.refreshMCPTools(mcpTools);
	}

	/** Replaces host-owned RPC tools before the next model call. */
	refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		return this.#tools.refreshRpcHostTools(rpcTools);
	}

	/** Whether auto-compaction is currently running */
	get isCompacting(): boolean {
		return this.#maintenance.isCompacting;
	}

	/** Strip image content from the current branch and persist the rewrite. */
	dropImages(): Promise<{ removed: number }> {
		return this.#maintenance.dropImages();
	}

	/** Reduce stored context with the selected shake strategy. */

	/** Compact the active session history. */
	compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		return this.#maintenance.compact(customInstructions, options);
	}

	/** Cancel active manual, automatic, and handoff maintenance. */
	abortCompaction(): void {
		this.#maintenance.abortCompaction();
	}

	/** Trigger idle compaction through the automatic maintenance flow. */
	async runIdleCompaction(): Promise<void> {
		await this.#maintenance.runIdleCompaction();
	}

	/** Toggle automatic compaction. */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.#maintenance.setAutoCompactionEnabled(enabled);
	}

	/** Whether automatic compaction is enabled. */
	get autoCompactionEnabled(): boolean {
		return this.#maintenance.autoCompactionEnabled;
	}

	/**
	 * Whether idle-flush tasks, auto-continuations, or other short-lived
	 * post-prompt work are pending.  True in the brief window after
	 * `session.prompt()` returns but before a scheduled background delivery
	 * (e.g. an async-job result) has finished its own streaming turn.
	 * Loop-mode and similar auto-submit paths should treat this as a block
	 * to avoid racing against the delivery turn.
	 */
	get hasPostPromptWork(): boolean {
		return this.#postPromptTasks.size > 0;
	}

	/** Register post-prompt work in tests without driving a full agent turn. */
	trackPostPromptTaskForTests(task: Promise<unknown>): void {
		if (!isBunTestRuntime()) throw new Error("trackPostPromptTaskForTests is test-only");
		this.#trackPostPromptTask(task);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Latest image attachments addressable by tools as `Image #N` or `attachment://N`. */
	getImageAttachments(): { label: string; uri: string; image: ImageContent }[] {
		return this.#providerBoundary.getImageAttachments();
	}

	buildDisplaySessionContext(): SessionContext {
		return this.#providerBoundary.buildDisplaySessionContext();
	}

	/**
	 * Transcript for TUI display. Full history is kept for export/resume-style
	 * callers; live chat can collapse compacted history to keep the hot render
	 * surface bounded. Display-only — NEVER feed the result to
	 * `agent.replaceMessages` or a provider. Because it is never re-obfuscated,
	 * it opts into legacy index-derived alias restoration so pre-keyed sessions
	 * still render their secrets; the agent-feeding paths
	 * (`buildDisplaySessionContext`) keep the keyed-only default.
	 */
	buildTranscriptSessionContext(
		options?: Pick<BuildSessionContextOptions, "collapseCompactedHistory" | "keepDanglingToolCalls">,
	): SessionContext {
		return this.#providerBoundary.buildTranscriptSessionContext(options);
	}

	#obfuscateTextForProvider(text: string | undefined): string | undefined {
		return this.#providerBoundary.obfuscateText(text);
	}

	#obfuscatePreparationForProvider(preparation: CompactionPreparation): CompactionPreparation {
		return this.#providerBoundary.obfuscateCompactionPreparation(preparation);
	}

	#deobfuscateFromProvider(text: string): string {
		return this.#providerBoundary.deobfuscateText(text);
	}

	#deobfuscatedProviderTextReadyForDelta(text: string): string {
		return this.#providerBoundary.deobfuscateDelta(text);
	}

	#convertToLlmForSideRequest(messages: AgentMessage[]): Message[] {
		return this.#providerBoundary.convertToLlmForSideRequest(messages);
	}

	/** Convert session messages using the same pre-LLM pipeline as the active session. */
	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		return await this.#providerBoundary.convertMessagesToLlm(messages, signal);
	}

	/** Apply session-level stream hooks to a direct side request. */
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider = "anthropic"): SimpleStreamOptions {
		return this.#providerBoundary.prepareSimpleStreamOptions(options, provider);
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** Current interrupt mode */
	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.#activeProviderSessionId();
	}
	getEvalSessionId(): string | null {
		return this.#eval.getSessionId();
	}
	getEvalKernelOwnerId(): string {
		return this.#eval.getKernelOwnerId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		return this.#models.scopedModels;
	}

	/** Prompt templates */
	getPlanModeState(): PlanModeState | undefined {
		return this.#planModeState;
	}

	/** Prewalk state, if armed and active */
	getPrewalkState(): Prewalk | undefined {
		return this.#prewalk.state;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.#planModeState = state;
		if (state?.enabled) {
			this.#planReferenceSent = false;
			this.#planReferencePath = state.planFilePath;
		} else {
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;
			// Drop any unconsumed forced decision so a post-plan execution turn
			// does not inherit a stale `required` tool choice.
			this.#toolChoiceQueue.removeByLabel("plan-mode-decision");
		}
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.#goalModeState;
	}

	setGoalModeState(state: GoalModeState | undefined): void {
		this.#goalModeState = state;
	}

	getVibeModeState(): VibeModeState | undefined {
		return this.#vibeModeState;
	}

	setVibeModeState(state: VibeModeState | undefined): void {
		this.#vibeModeState = state;
	}

	#assertVibeSessionTransitionAllowed(action: string): void {
		if (this.#vibeModeState?.enabled) {
			throw new Error(`Cannot ${action} while vibe mode is active. Exit vibe mode first.`);
		}
	}

	get goalRuntime(): GoalRuntime {
		return this.#goalRuntime;
	}

	markPlanReferenceSent(): void {
		this.#planReferenceSent = true;
	}

	setPlanReferencePath(path: string): void {
		this.#planReferencePath = path;
	}

	getPlanReferencePath(): string {
		return this.#planReferencePath;
	}

	get clientBridge(): ClientBridge | undefined {
		return this.#clientBridge;
	}

	setClientBridge(bridge: ClientBridge | undefined): void {
		this.#clientBridge = bridge;
		this.#tools.refreshAcpPermissionGates();
	}

	#clearCheckpointRuntimeState(): void {
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
		this.#lastCompletedRewind = undefined;
		this.#rewoundToolResultIds.clear();
	}

	/** Drop mutable tool decisions and directives owned by the previous logical session. */
	#clearSessionScopedToolState(): void {
		this.#toolChoiceQueue.clear();
		this.#tools.clearAcpPermissionDecisions();
	}

	/**
	 * Rebuild checkpoint/rewind runtime state from the current branch. Handles two
	 * cases surfaced by session resume, `switchSession()` reloading the same file,
	 * and tree navigation:
	 *   - The branch's most recent checkpoint has already been rewound → restore
	 *     `#lastCompletedRewind` so a repeat `rewind` call receives the
	 *     "checkpoint already completed" recovery guidance.
	 *   - The branch's most recent checkpoint has NOT been rewound (e.g. the run
	 *     was aborted between `checkpoint` and `rewind`) → restore
	 *     `#checkpointState` so the next `rewind` call can complete the
	 *     checkpoint instead of failing with "No active checkpoint".
	 */
	#rehydrateCheckpointRewindState(): void {
		this.#clearCheckpointRuntimeState();
		let completed: CompletedRewindState | undefined;
		let pending: { entryId: string; startedAt: string; messageCount: number } | undefined;
		let messageCount = 0;
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type === "message") messageCount++;
			if (isSuccessfulCheckpointEntry(entry)) {
				completed = undefined;
				pending = {
					entryId: entry.id,
					startedAt: checkpointStartedAtFromEntry(entry) ?? entry.timestamp,
					messageCount,
				};
				continue;
			}
			const completedFromEntry = completedRewindFromEntry(entry);
			if (completedFromEntry) {
				completed = completedFromEntry;
				pending = undefined;
			}
		}
		if (pending) {
			this.#checkpointState = {
				checkpointEntryId: pending.entryId,
				startedAt: pending.startedAt,
				checkpointMessageCount: pending.messageCount,
			};
			return;
		}
		this.#lastCompletedRewind = completed;
	}

	getCheckpointState(): CheckpointState | undefined {
		return this.#checkpointState;
	}

	getLastCompletedRewind(): CompletedRewindState | undefined {
		return this.#lastCompletedRewind;
	}

	setCheckpointState(state: CheckpointState | undefined): void {
		this.#checkpointState = state;
		if (state) {
			this.#lastCompletedRewind = undefined;
		} else {
			this.#pendingRewindReport = undefined;
		}
	}

	/**
	 * Inject the plan mode context message into the conversation history.
	 */
	async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = await this.#buildPlanModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	async sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = this.#buildGoalModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				attribution: message.attribution,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	async sendVibeModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = this.#buildVibeModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				attribution: message.attribution,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	resolveRoleModel(role: string): Model | undefined {
		return this.#models.resolveRoleModel(role);
	}

	/**
	 * Resolve a role to its model AND thinking level.
	 * Unlike resolveRoleModel(), this preserves the thinking level suffix
	 * from role configuration (e.g., "anthropic/claude-sonnet-4-5:xhigh").
	 */
	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return this.#models.resolveRoleModelWithThinking(role);
	}

	/**
	 * Resolve the explicit thinking suffix that should apply when a temporary
	 * picker selects a model already assigned to a configured role.
	 */
	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined {
		return this.#models.resolveTemporaryModelThinkingLevel(model);
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	/** Replace file-based slash commands used for prompt expansion. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	/** Custom commands (TypeScript slash commands and MCP prompts) */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	/** MCP prompt commands only, for command-list metadata. */
	get mcpPromptCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#mcpPromptCommands;
	}

	/** Update the MCP prompt commands list. Called when server prompts are (re)loaded. */
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
		this.#notifyCommandMetadataChanged();
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Build a plan mode message.
	 * Returns null if plan mode is not enabled.
	 * @returns The plan mode message, or null if plan mode is not enabled.
	 */
	async #buildPlanReferenceMessage(): Promise<CustomMessage | null> {
		if (this.#planModeState?.enabled) return null;
		if (this.#planReferenceSent) return null;

		const planFilePath = this.#planReferencePath;
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, this.#localProtocolOptions());
		try {
			await fs.promises.access(resolvedPlanPath, fs.constants.R_OK);
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}

		const content = prompt.render(planModeReferencePrompt, {
			planFilePath,
		});

		return {
			role: "custom",
			customType: "plan-mode-reference",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	async #buildPlanModeMessage(): Promise<CustomMessage | null> {
		const state = this.#planModeState;
		if (!state?.enabled) return null;
		const sessionPlanUrl = "local://PLAN.md";
		const resolvedPlanPath = state.planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(normalizeLocalScheme(state.planFilePath), this.#localProtocolOptions())
			: resolveToCwd(state.planFilePath, this.sessionManager.getCwd());
		const resolvedSessionPlan = resolveLocalUrlToPath(sessionPlanUrl, this.#localProtocolOptions());
		const displayPlanPath =
			state.planFilePath.startsWith("local:") || resolvedPlanPath !== resolvedSessionPlan
				? state.planFilePath
				: sessionPlanUrl;

		const planExists = fs.existsSync(resolvedPlanPath);
		const content = prompt.render(planModeActivePrompt, {
			planFilePath: displayPlanPath,
			planExists,
			askToolName: "ask",
			writeToolName: "write",
			editToolName: "edit",
			isHashlineEditMode: this.#resolveActiveEditMode() === "hashline",
			reentry: state.reentry ?? false,
			iterative: state.workflow === "iterative",
		});

		return {
			role: "custom",
			customType: "plan-mode-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildGoalModeMessage(): CustomMessage | null {
		const content = this.#goalRuntime.buildActivePrompt();
		if (!content) return null;
		const todoContext = this.#buildGoalTodoContext();
		return {
			role: "custom",
			customType: "goal-mode-context",
			content: prompt.render(goalModeContextPrompt, { goalContext: content, todoContext }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildVibeModeMessage(): CustomMessage | null {
		if (!this.#vibeModeState?.enabled) return null;
		return {
			role: "custom",
			customType: "vibe-mode-context",
			content: prompt.render(vibeModeActivePrompt),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#sanitizeGoalTodoText(text: string): string {
		return escapeXmlText(text)
			.replace(/\r\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
	}

	#buildGoalTodoContext(): string | undefined {
		if (!this.settings.get("todo.enabled")) return undefined;
		const canCallTodoTool = this.getActiveToolNames().includes("todo");
		if (!canCallTodoTool) return undefined;
		const phases = this.getTodoPhases().filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return undefined;

		let total = 0;
		let closed = 0;
		let open = 0;
		const promptPhases = phases.map(phase => ({
			name: this.#sanitizeGoalTodoText(phase.name),
			tasks: phase.tasks.map(task => {
				total++;
				if (task.status === "completed" || task.status === "abandoned") {
					closed++;
				} else {
					open++;
				}
				return { content: this.#sanitizeGoalTodoText(task.content), status: task.status };
			}),
		}));

		return prompt.render(goalTodoContextPrompt, {
			canCallTodoTool,
			closed: String(closed),
			open: String(open),
			phases: promptPhases,
			total: String(total),
		});
	}

	#normalizeImagesForModel(images: ImageContent[] | undefined): Promise<ImageContent[] | undefined> {
		return normalizeModelContextImages(images, { model: this.model });
	}

	#buildImageDescriptionNotice(
		normalizedImages: ImageContent[],
		signal?: AbortSignal,
	): Promise<CustomMessage | undefined> {
		return this.#providerBoundary.buildImageDescriptionNotice(normalizedImages, signal);
	}

	#normalizeAgentMessageImages<T extends AgentMessage>(message: T): Promise<T> {
		return this.#providerBoundary.normalizeAgentMessageImages(message);
	}

	#magicKeywordEnabled(keyword: "orchestrate" | "ultrathink" | "workflow"): boolean {
		return this.settings.get("magicKeywords.enabled") && this.settings.get(`magicKeywords.${keyword}`);
	}

	#createMagicKeywordNotices(text: string): CustomMessage[] {
		const timestamp = Date.now();
		const turnBudget = parseTurnBudget(text);
		this.sessionManager.beginTurnBudget(turnBudget?.total ?? null, turnBudget?.hard ?? false);
		const keywordNotices: CustomMessage[] = [];
		if (this.#magicKeywordEnabled("ultrathink") && containsUltrathink(text)) {
			keywordNotices.push({
				role: "custom",
				customType: "ultrathink-notice",
				content: ULTRATHINK_NOTICE,
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		if (this.#magicKeywordEnabled("orchestrate") && containsOrchestrate(text)) {
			keywordNotices.push({
				role: "custom",
				customType: "orchestrate-notice",
				content: ORCHESTRATE_NOTICE,
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		if (this.#magicKeywordEnabled("workflow") && containsWorkflow(text)) {
			const activeToolNames = this.getActiveToolNames();
			if (activeToolNames.includes("task") && activeToolNames.includes("eval")) {
				keywordNotices.push({
					role: "custom",
					customType: "workflow-notice",
					content: renderWorkflowNotice({ taskBatch: this.settings.get("task.batch") }),
					display: false,
					attribution: "user",
					timestamp,
				});
			}
		}
		return keywordNotices;
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	/**
	 * Returns `false` when the command was fully handled locally (extension or
	 * custom-TS command consumed without calling the LLM). Returns `true` when
	 * the prompt was forwarded to the agent — either directly or queued as a
	 * steer/follow-up. Callers that render a UI or manage turn lifecycle (e.g.
	 * the ACP agent) use this to know whether to expect an `agent_end` event.
	 */
	async prompt(text: string, options?: PromptOptions): Promise<boolean> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		// Handle extension commands first (execute immediately, even during streaming)
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.#tryExecuteExtensionCommand(text);
			if (handled) {
				return false;
			}

			// Try custom commands (TypeScript slash commands)
			const customResult = await this.#tryExecuteCustomCommand(text);
			if (customResult !== null) {
				if (customResult === "") {
					return false;
				}
				text = customResult;
			}

			// Try file-based slash commands (markdown files from commands/ directories)
			// Only if text still starts with "/" (wasn't transformed by custom command)
			if (text.startsWith("/")) {
				text = expandSlashCommand(text, this.#slashCommands);
			}
		}

		// Expand file-based prompt templates if requested
		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		// Magic keywords ("ultrathink", "orchestrate"): append hidden system notices after the
		// user's message that steer this turn. User-authored prompts only — synthetic /
		// agent-initiated turns never trigger them.
		const keywordNotices = options?.synthetic ? [] : this.#createMagicKeywordNotices(expandedText);

		// A user-initiated prompt (typed message or the `.`/`c` continue shortcut)
		// re-enables advisor auto-resume that a prior user interrupt suppressed.
		// Agent-initiated synthetic prompts (auto-continue, plan, reminders) do not.
		if (options?.userInitiated ?? !options?.synthetic) {
			this.#advisors.autoResumeSuppressed = false;
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;
			// A user turn owns the next decision; drop a queued forced choice from
			// a reminder continuation this prompt just preempted.
			this.#toolChoiceQueue.removeByLabel("plan-mode-decision");
		}

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			const streamingBehavior = options?.streamingBehavior;
			if (!streamingBehavior) throw new AgentBusyError();
			if (!(await this.#runUsageAwarePreflight())) return false;
			// Steer/follow-up the keyword notices BEFORE the queued user message so the
			// model reads the steering notice ahead of the prompt it modifies.
			for (const notice of keywordNotices) {
				await this.#queueCustomMessage(notice, streamingBehavior);
			}
			if (streamingBehavior === "followUp") {
				await this.#queueUserMessage(expandedText, options?.images, "followUp");
			} else {
				await this.#queueUserMessage(expandedText, options?.images, "steer");
			}
			return true;
		}

		// Skip eager preludes when the user has already queued a directive
		const hasPendingUserDirective = this.#toolChoiceQueue.inspect().includes("user-force");
		const eagerTodoPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#todo.createEagerTodoPrelude(expandedText) : undefined;
		const eagerTaskPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#todo.createEagerTaskPrelude(expandedText) : undefined;
		const normalizedImages = await this.#normalizeImagesForModel(options?.images);

		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (normalizedImages?.length) {
			userContent.push(...normalizedImages);
		}
		// Text-only model + image attachment: describe via a vision model and inject the
		// description as a hidden companion (the image stays in the visible user message).
		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;

		const promptAttribution = options?.attribution ?? (options?.synthetic ? "agent" : "user");
		const message = options?.synthetic
			? { role: "developer" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() }
			: { role: "user" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() };

		const preludeMessages: AgentMessage[] = [];
		if (eagerTodoPrelude) {
			if (eagerTodoPrelude.toolChoice) {
				this.#toolChoiceQueue.pushOnce(eagerTodoPrelude.toolChoice, {
					label: "eager-todo",
				});
			}
			preludeMessages.push(eagerTodoPrelude.message);
		}
		if (eagerTaskPrelude) {
			preludeMessages.push(eagerTaskPrelude);
		}

		try {
			await this.#promptWithMessage(message, expandedText, {
				...options,
				images: normalizedImages,
				prependMessages:
					preludeMessages.length > 0 || keywordNotices.length > 0 || imageDescriptionNotice
						? [...preludeMessages, ...keywordNotices, ...(imageDescriptionNotice ? [imageDescriptionNotice] : [])]
						: undefined,
			});
		} finally {
			// Clean up residual eager-todo directive if the prompt never consumed it
			// (e.g., compaction aborted, validation failed).
			this.#toolChoiceQueue.removeByLabel("eager-todo");
		}
		return true;
	}

	async promptCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice"> & {
			queueChipText?: string;
			queueOnly?: boolean;
		},
	): Promise<void> {
		const textContent =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");

		let keywordNotices: CustomMessage[] = [];
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user") {
			const details = message.details;
			let skillArgs = "";
			if (details && typeof details === "object" && "args" in details && typeof details.args === "string") {
				skillArgs = details.args;
			}
			keywordNotices = this.#createMagicKeywordNotices(skillArgs);
		}

		if (options?.queueOnly) {
			const streamingBehavior = options?.streamingBehavior;
			if (!streamingBehavior) throw new AgentBusyError();
			if (!(await this.#runUsageAwarePreflight())) return;
			for (const notice of keywordNotices) {
				await this.#queueCustomMessage(notice, streamingBehavior);
			}
			await this.#queueCustomMessage(message, streamingBehavior, options.queueChipText);
			return;
		}
		if (this.isStreaming) {
			const streamingBehavior = options?.streamingBehavior;
			if (!streamingBehavior) throw new AgentBusyError();
			if (!(await this.#runUsageAwarePreflight())) return;
			for (const notice of keywordNotices) {
				await this.#queueCustomMessage(notice, streamingBehavior);
			}
			await this.#queueCustomMessage(message, streamingBehavior, options?.queueChipText);
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};

		await this.#promptWithMessage(customMessage, textContent, {
			...options,
			prependMessages: keywordNotices.length > 0 ? keywordNotices : undefined,
		});
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
			prependMessages?: AgentMessage[];
			skipPostPromptRecoveryWait?: boolean;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<void> {
		this.#beginInFlight();
		const generation = this.#promptGeneration;
		try {
			await this.#recovery.maybeRestoreRetryFallbackPrimary();
			if (!(await this.#runUsageAwarePreflight())) return;
			// Flush any pending bash messages before the new prompt
			await this.#bash.flushPending();
			this.#eval.flushPending();
			this.#irc.flushPending();

			this.#todo.resetCycle();
			this.#resetPromptMaintenanceState();
			this.#recovery.setAcceptTerminalEmptyStop(options?.acceptTerminalEmptyStop === true);

			// Validate model
			if (!this.model) {
				throw new Error(
					"No model selected.\n\n" +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}\n\n` +
						"Then use /model to select a model.",
				);
			}

			// Validate API key
			const apiKey = await this.#modelRegistry.getApiKey(this.model, this.sessionId);
			if (!apiKey) {
				throw new Error(
					`No API key found for ${this.model.provider}.\n\n` +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}`,
				);
			}

			// Recover a previously failed/incomplete assistant turn before sending.
			// Successful historical turns take the cheaper pre-prompt threshold path
			// below; re-running the full post-turn check on resume can synchronously
			// rewrite/re-render old context before the new prompt starts.
			const lastAssistant = this.#findLastAssistantMessage();
			if (
				lastAssistant &&
				!options?.skipCompactionCheck &&
				(lastAssistant.stopReason === "error" || lastAssistant.stopReason === "length")
			) {
				await this.#maintenance.checkCompaction(lastAssistant, false, false, false);
			}

			await this.#prewalk.armPlanYoloIfNeeded();

			// Build messages array (session context, eager todo prelude, then active prompt message)
			const messages: AgentMessage[] = [];
			const planReferenceMessage = await this.#buildPlanReferenceMessage?.();
			if (planReferenceMessage) {
				messages.push(planReferenceMessage);
			}
			const planModeMessage = await this.#buildPlanModeMessage();
			if (planModeMessage) {
				messages.push(planModeMessage);
			}
			const goalModeMessage = this.#buildGoalModeMessage();
			if (goalModeMessage) {
				messages.push(goalModeMessage);
			}
			const vibeModeMessage = this.#buildVibeModeMessage();
			if (vibeModeMessage) {
				messages.push(vibeModeMessage);
			}
			if (options?.prependMessages) {
				messages.push(...options.prependMessages);
			}

			// Early bail-out: if a newer abort/prompt cycle started during setup,
			// return before mutating shared state (nextTurn messages, system prompt).
			if (this.#promptGeneration !== generation) {
				return;
			}

			// A pending xd:// delta accompanies the next user-authored prompt,
			// never an agent-initiated continuation.
			const xdevMountNotice = isUserQueuedMessage(message) ? this.#takePendingXdevMountNotice() : undefined;
			if (xdevMountNotice) {
				messages.push(xdevMountNotice);
			}
			messages.push(message);
			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this.#pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.#pendingNextTurnMessages = [];

			// Auto-read @filepath mentions
			const fileMentions = extractFileMentions(expandedText);
			if (fileMentions.length > 0) {
				const fileMentionMessages = await generateFileMentionMessages(fileMentions, this.sessionManager.getCwd(), {
					autoResizeImages: this.settings.get("images.autoResize"),
					useHashLines: resolveFileDisplayMode(this).hashLines,
					snapshotStore: getFileSnapshotStore(this),
				});
				for (const fileMentionMessage of fileMentionMessages) {
					messages.push(await this.#normalizeAgentMessageImages(fileMentionMessage));
				}
			}

			// A prompt issued while the session is already disposing must still run:
			// the dispose-driven abort settles its turn (see "does not auto-retry
			// empty reasonless aborts once the session is disposing"). Only drop the
			// prompt when disposal began during the backend-transition await, where
			// resuming would start a turn on a torn-down session.
			const disposingBeforeTransition = this.#isDisposed;
			await this.#memory.transition;
			if ((this.#isDisposed && !disposingBeforeTransition) || this.#promptGeneration !== generation) return;
			const beforeAgentStartSystemPrompt = await this.#buildSystemPromptForAgentStart(expandedText);

			// Emit before_agent_start extension event
			if (this.#extensionRunner) {
				const result = await this.#extensionRunner.emitBeforeAgentStart(
					expandedText,
					options?.images,
					beforeAgentStartSystemPrompt,
				);
				if (result?.messages) {
					const promptAttribution: "user" | "agent" | undefined =
						"attribution" in message ? message.attribution : undefined;
					for (const msg of result.messages) {
						const normalized = normalizeCustomMessagePayload(msg);
						const hasExplicitAttribution =
							msg !== null &&
							typeof msg === "object" &&
							!Array.isArray(msg) &&
							(msg.attribution === "user" || msg.attribution === "agent");
						messages.push(
							await this.#normalizeAgentMessageImages({
								role: "custom",
								customType: normalized.customType,
								content: normalized.content,
								display: normalized.display,
								details: normalized.details,
								attribution: hasExplicitAttribution
									? normalized.attribution
									: (promptAttribution ?? (message.role === "user" ? "user" : "agent")),
								timestamp: Date.now(),
							}),
						);
					}
				}

				if (result?.systemPrompt !== undefined) {
					this.agent.setSystemPrompt(result.systemPrompt);
				} else {
					this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
				}
			} else {
				this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
			}

			// Bail out if a newer abort/prompt cycle has started since we began setup
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Auto thinking: classify this real user turn and set the effective level
			// before the model request. Synthetic/tool-continuation turns (developer/
			// custom roles) and non-auto sessions are skipped. Never blocks the turn —
			// failures fall back to a concrete level inside the helper.
			if (this.isAutoThinking && message.role === "user") {
				await this.#models.applyAutoThinkingLevel(expandedText, generation);
				if (this.#promptGeneration !== generation) {
					return;
				}
			}

			await this.#maintenance.runPrePromptCompactionIfNeeded(messages);
			if (this.#promptGeneration !== generation) {
				return;
			}

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			const nonMessageTokens = computeNonMessageTokens(this);
			const contextWindow = this.model?.contextWindow ?? 0;
			const breakdown = this.getContextBreakdown({ contextWindow, pendingMessages: messages });
			const promptTokens =
				breakdown?.usedTokens ??
				nonMessageTokens +
					this.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0) +
					messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
			this.#stats.setPendingSnapshot({
				promptTokens,
				nonMessageTokens,
				cutoffCount: this.messages.length + messages.length,
			});
			// Commit the plan-reference delivery flag only now that the message is
			// actually handed to agent.prompt. Every pre-send setup step above can
			// return (generation-bail) or throw (@-mention reads, before_agent_start
			// hooks, pre-prompt compaction) before this point; setting the flag at
			// construction time (#buildPlanReferenceMessage) stranded it `true` with
			// nothing delivered, so the retry skipped re-injection and the executor
			// lost the approved plan (issue #4094). The compaction-success resets
			// (issue #1246) still clear it for re-injection on the next turn.
			if (planReferenceMessage) {
				this.#planReferenceSent = true;
			}
			try {
				await this.#recovery.promptAgentWithIdleRetry(messages, agentPromptOptions);
			} finally {
				this.#stats.setPendingSnapshot(undefined);
			}
			if (!options?.skipPostPromptRecoveryWait) {
				await this.#waitForPostPromptRecovery(generation);
			}
		} finally {
			this.#endInFlight();
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this.#extensionRunner) return false;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.#extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this.#extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this.#extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	#createCommandContext(): ExtensionCommandContext {
		if (this.#extensionRunner) {
			return this.#extensionRunner.createCommandContext();
		}

		return {
			ui: noOpUIContext,
			hasUI: false,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model ?? undefined,
			models: createExtensionModelQuery(this.#modelRegistry, this.settings, () => this.model ?? undefined),
			isIdle: () => !this.isStreaming,
			abort: () => {
				void this.abort();
			},
			hasPendingMessages: () => this.queuedMessageCount > 0,
			shutdown: () => {
				// Await the idempotent dispose() before exiting so the browser
				// reaper and other bounded teardown complete — a fire-and-forget
				// `void this.dispose()` raced process.exit() and could leave an
				// OMP-owned Chromium alive (#5643).
				void this.dispose().finally(() => process.exit(0));
			},
			getContextUsage: () => this.getContextUsage(),
			waitForIdle: () => this.waitForIdle(),
			newSession: async options => {
				const success = await this.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				if (options?.setup) {
					await options.setup(this.sessionManager);
				}
				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.navigateTree(targetId, { summarize: options?.summarize });
				return { cancelled: result.cancelled };
			},
			compact: async instructionsOrOptions => {
				const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
				const options =
					instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
				await this.compact(instructions, options);
			},
			switchSession: async sessionPath => {
				const success = await this.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await this.reload();
			},
			getSystemPrompt: () => this.systemPrompt,
			setInterval: (callback, ms, ...args) => this.#fallbackTimers().setInterval(callback, ms, ...args),
			setTimeout: (callback, ms, ...args) => this.#fallbackTimers().setTimeout(callback, ms, ...args),
			clearTimer: timer => this.#fallbackTimers().clear(timer),
		};
	}

	/** Lazily create the runner-less command-context timer registry (#5664). */
	#fallbackTimers(): ManagedTimers {
		this.#fallbackExtensionTimers ??= new ManagedTimers((event, error) =>
			logger.warn("Extension timer callback threw", { event, error }),
		);
		return this.#fallbackExtensionTimers;
	}

	/**
	 * Try to execute a custom command. Returns the prompt string if found, null otherwise.
	 * If the command returns void, returns empty string to indicate it was handled.
	 */
	async #tryExecuteCustomCommand(text: string): Promise<string | null> {
		if (this.#customCommands.length === 0 && this.#mcpPromptCommands.length === 0) return null;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		// Find matching command
		const loaded =
			this.#customCommands.find(c => c.command.name === commandName) ??
			this.#mcpPromptCommands.find(c => c.command.name === commandName);
		if (!loaded) return null;

		// Get command context from extension runner (includes session control methods)
		const baseCtx = this.#createCommandContext();
		const ctx = {
			...baseCtx,
			hasQueuedMessages: baseCtx.hasPendingMessages,
		} as unknown as HookCommandContext;

		try {
			const args = parseCommandArgs(argsString);
			const result = await loaded.command.execute(args, ctx);
			// If result is a string, it's a prompt to send to LLM
			// If void/undefined, command handled everything
			return result ?? "";
		} catch (err) {
			// Emit error via extension runner
			if (this.#extensionRunner) {
				this.#extensionRunner.emitError({
					extensionPath: `custom-command:${commandName}`,
					event: "command",
					error: err instanceof Error ? err.message : String(err),
				});
			} else {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Custom command failed", { commandName, error: message });
			}
			return ""; // Command was handled (with error)
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		if (!(await this.#runUsageAwarePreflight())) return;
		await this.#queueUserMessage(expandedText, images, "steer");
	}

	/**
	 * Queue a follow-up message to process after the agent would otherwise stop.
	 * Set `options.synthetic` to enqueue a hidden developer message (agent-attributed
	 * by default) instead of a user-attributed follow-up; the plan-approval flow
	 * uses this to land its execution directive behind a queued user turn without
	 * flipping advisor auto-resume.
	 */
	async followUp(text: string, images?: ImageContent[], options?: FollowUpOptions): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText =
			options?.expandPromptTemplates === false ? text : expandPromptTemplate(text, [...this.#promptTemplates]);
		if (!(await this.#runUsageAwarePreflight())) return;
		if (!options?.synthetic) {
			await this.#queueUserMessage(expandedText, images, "followUp");
			return;
		}
		// Synthetic branch: agent-initiated hidden developer message. Bypass
		// #queueUserMessage (which clears advisor auto-resume suppression and
		// enqueues as a user-attributed message) and place the developer message
		// directly on the follow-up queue.
		const normalizedImages = await this.#normalizeImagesForModel(images);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (normalizedImages?.length) {
			content.push(...normalizedImages);
		}
		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;
		if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
		this.agent.followUp({
			role: "developer",
			content,
			attribution: options.attribution ?? "agent",
			timestamp: Date.now(),
		});
		this.#scheduleIdleQueueDrain();
	}

	async #queueUserMessage(
		text: string,
		images: ImageContent[] | undefined,
		mode: "steer" | "followUp",
	): Promise<void> {
		// A queued user message (RPC/SDK/collab steer or follow-up, or a typed message
		// while streaming) is a deliberate resume; re-enable advisor auto-resume that
		// a user interrupt suppressed.
		this.#advisors.autoResumeSuppressed = false;
		const normalizedImages = await this.#normalizeImagesForModel(images);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (normalizedImages?.length) {
			content.push(...normalizedImages);
		}
		// Text-only model + image attachment: describe via a vision model and enqueue the
		// description as a hidden companion immediately before the user message.
		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;
		if (mode === "followUp") {
			if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
			this.agent.followUp({
				role: "user",
				content,
				attribution: "user",
				timestamp: Date.now(),
			});
		} else {
			if (imageDescriptionNotice) this.agent.steer(imageDescriptionNotice);
			this.agent.steer({
				role: "user",
				content,
				steering: true,
				attribution: "user",
				timestamp: Date.now(),
			});
		}
		this.#scheduleIdleQueueDrain();
	}

	#scheduleIdleQueueDrain(): void {
		this.#scheduleQueuedMessageDrain();
	}

	#scheduleQueuedMessageDrain(): void {
		if (this.#queuedMessageDrainScheduled || !this.#canAutoContinueForFollowUp() || !this.agent.hasQueuedMessages()) {
			return;
		}
		this.#queuedMessageDrainScheduled = true;
		this.#scheduleAgentContinue({
			shouldContinue: () => {
				this.#queuedMessageDrainScheduled = false;
				return this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages();
			},
			onSkip: () => {
				this.#queuedMessageDrainScheduled = false;
			},
			onError: () => {
				this.#queuedMessageDrainScheduled = false;
			},
		});
	}

	/**
	 * Gate for idle-path queued-message auto-continue. See `#scheduleIdleQueueDrain` for rationale.
	 */
	#canAutoContinueForFollowUp(): boolean {
		if (this.isStreaming) return false;
		if (this.isRetrying) return false;
		// A queued steer resumes from ANY tail: Agent.continue() runs #runLoop(undefined),
		// whose initial steering poll injects the steer before the first provider call, so the
		// request tail becomes the steer (valid) regardless of any injected custom / bashExecution
		// / pythonExecution record a user interrupt left as the literal transcript tail. This is
		// why a queued user steer stranded behind a preserved advisor card (or a flushed IRC aside
		// / eval execution record) still resumes — no tail-role enumeration needed.
		if (this.agent.peekSteeringQueue().length > 0) return true;
		// Follow-up-only auto-resume stays suppressed while a deliberate user interrupt is in effect
		// (#advisorAutoResumeSuppressed, cleared on the next user prompt): the user stopped, so their
		// queued follow-up waits for an explicit resume — even if an interleaving IRC wake turn has
		// since left a provider-valid tail.
		if (this.#advisors.autoResumeSuppressed) return false;
		// Follow-up-only resume has no steer to inject, so Agent.continue() continues from the
		// existing context tail — which must itself be a valid provider tail. An injected
		// non-conversational tail (advisor card → `developer`, bash/python execution) would make
		// the first model call invalid, so leave the follow-up queued for the next explicit resume.
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		return last?.role === "assistant" || last?.role === "toolResult";
	}

	queueDeferredMessage(message: CustomMessage): void {
		this.#queueHiddenNextTurnMessage(message, true);
	}

	#queueHiddenNextTurnMessage(message: CustomMessage, triggerTurn: boolean): void {
		this.#pendingNextTurnMessages.push(message);
		if (!triggerTurn) return;
		const generation = this.#promptGeneration;
		if (this.#scheduledHiddenNextTurnGeneration === generation) {
			return;
		}
		this.#scheduledHiddenNextTurnGeneration = generation;
		this.#schedulePostPromptTask(
			async () => {
				if (this.#scheduledHiddenNextTurnGeneration === generation) {
					this.#scheduledHiddenNextTurnGeneration = undefined;
				}
				if (this.#pendingNextTurnMessages.length === 0) {
					return;
				}
				try {
					await this.#promptQueuedHiddenNextTurnMessages();
				} catch {
					// Leave the hidden next-turn messages queued for the next explicit prompt.
				}
			},
			{
				generation,
				onSkip: () => {
					if (this.#scheduledHiddenNextTurnGeneration === generation) {
						this.#scheduledHiddenNextTurnGeneration = undefined;
					}
				},
			},
		);
	}

	async #promptQueuedHiddenNextTurnMessages(): Promise<void> {
		if (this.#pendingNextTurnMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.#pendingNextTurnMessages];
		this.#pendingNextTurnMessages = [];
		const message = queuedMessages[queuedMessages.length - 1];
		if (!message) {
			return;
		}

		const prependMessages = queuedMessages.slice(0, -1);
		const textContent = this.#getCustomMessageTextContent(message);
		try {
			await this.#promptWithMessage(message, textContent, {
				prependMessages,
				skipPostPromptRecoveryWait: true,
			});
		} catch (error) {
			this.#pendingNextTurnMessages = [...queuedMessages, ...this.#pendingNextTurnMessages];
			throw error;
		}
	}

	#getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("");
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	#throwIfExtensionCommand(text: string): void {
		if (!this.#extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.#extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	async #promptAgentInitiatedMessage(
		message: CustomMessage,
		options?: { acceptTerminalEmptyStop?: boolean },
	): Promise<void> {
		this.#beginInFlight();
		try {
			if (!(await this.#runUsageAwarePreflight())) return;
			const acceptTerminalEmptyStop = options?.acceptTerminalEmptyStop === true;
			if (acceptTerminalEmptyStop) {
				this.#resetPromptMaintenanceState();
			}
			this.#recovery.setAcceptTerminalEmptyStop(acceptTerminalEmptyStop);
			await this.agent.prompt(message);
			await this.#waitForPostPromptRecovery();
		} finally {
			this.#recovery.setAcceptTerminalEmptyStop(false);
			this.#endInFlight();
		}
	}

	/** Queue a custom message without starting a turn, matching steer/follow-up delivery. */
	async #queueCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		deliverAs: "steer" | "followUp",
		queueChipText?: string,
	): Promise<void> {
		const details =
			queueChipText !== undefined
				? ({
						...((message.details && typeof message.details === "object" ? message.details : {}) as Record<
							string,
							unknown
						>),
						__queueChipText: queueChipText,
					} as T)
				: message.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};
		const normalizedAppMessage = await this.#normalizeAgentMessageImages(appMessage);
		if (deliverAs === "followUp") {
			this.agent.followUp(normalizedAppMessage);
		} else {
			this.agent.steer(normalizedAppMessage);
		}
		this.#scheduleIdleQueueDrain();
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queue as steer/follow-up or store for next turn
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn unless the client cannot own it
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @returns true iff this call synchronously started a new turn (awaited
	 * `agent.prompt`); false when the message was queued/appended without a turn
	 * — including when `triggerTurn` is downgraded because the client defers
	 * agent-initiated turns. Callers that must mirror the resulting `agent_end`
	 * use this to avoid acting on a turn that never ran.
	 */
	async sendCustomMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			queueChipText?: string;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<boolean> {
		const normalizedPayload = normalizeCustomMessagePayload<T>(message);
		const details =
			options?.queueChipText && options.deliverAs !== "nextTurn"
				? ({
						...((normalizedPayload.details && typeof normalizedPayload.details === "object"
							? normalizedPayload.details
							: {}) as Record<string, unknown>),
						__queueChipText: options.queueChipText,
					} as T)
				: normalizedPayload.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: normalizedPayload.customType,
			content: normalizedPayload.content,
			display: normalizedPayload.display,
			details,
			attribution: normalizedPayload.attribution,
			timestamp: Date.now(),
		};
		const normalizedAppMessage = await this.#normalizeAgentMessageImages(appMessage);
		if (this.isStreaming) {
			if (options?.deliverAs === "nextTurn") {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, options?.triggerTurn ?? false);
				return false;
			}
			if (!(await this.#runUsageAwarePreflight())) return false;

			if (options?.deliverAs === "followUp") {
				this.agent.followUp(normalizedAppMessage);
			} else {
				this.agent.steer(normalizedAppMessage);
			}
			this.#scheduleIdleQueueDrain();
			return false;
		}

		if (options?.deliverAs === "nextTurn") {
			if (options?.triggerTurn) {
				if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
					this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
					return false;
				}
				await this.#promptAgentInitiatedMessage(normalizedAppMessage, {
					acceptTerminalEmptyStop: options.acceptTerminalEmptyStop === true,
				});
				return true;
			}
			this.agent.appendMessage(normalizedAppMessage);
			this.sessionManager.appendCustomMessageEntry(
				normalizedAppMessage.customType,
				normalizedAppMessage.content,
				normalizedAppMessage.display,
				normalizedAppMessage.details,
				normalizedAppMessage.attribution,
			);
			return false;
		}

		if (options?.triggerTurn) {
			if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
				return false;
			}
			await this.#promptAgentInitiatedMessage(normalizedAppMessage);
			return true;
		}

		this.agent.appendMessage(normalizedAppMessage);
		this.sessionManager.appendCustomMessageEntry(
			normalizedAppMessage.customType,
			normalizedAppMessage.content,
			normalizedAppMessage.display,
			normalizedAppMessage.details,
			normalizedAppMessage.attribution,
		);
		return false;
	}

	/**
	 * Send a user message through the prompt flow.
	 *
	 * Omitted `deliverAs` starts a turn when idle and queues as a steer while streaming.
	 * Explicit `deliverAs` queues without starting a turn in either state.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		if (options?.deliverAs && !(await this.#runUsageAwarePreflight())) return;

		if (options?.deliverAs === "followUp") {
			await this.#queueUserMessage(text, images, "followUp");
			return;
		}
		if (options?.deliverAs === "steer") {
			await this.#queueUserMessage(text, images, "steer");
			return;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion.
		// `streamingBehavior: "steer"` preserves prompt-flow side effects during streaming while
		// covering the narrow race where a stream starts before prompt() acquires the turn.
		await this.prompt(text, {
			expandPromptTemplates: false,
			images,
			streamingBehavior: "steer",
		});
	}

	/** Clear queued messages and return the user-restorable ones (text plus any attached images).
	 *  Only user-authored messages (plain user turns, `attribution:"user"` custom like `/skill`) are
	 *  returned for editor restore. Other queued messages stay in the agent-core queues so a continuing
	 *  stream still delivers them — EXCEPT on `forInterrupt` (Esc+abort), where only advisor cards are
	 *  kept (abort()'s #extractQueuedAdvisorCards preserves them as visible advice) and every other
	 *  non-user steer (hidden goal/plan/budget, IRC/extension asides) is dropped, so abort()'s
	 *  #drainStrandedQueuedMessages can't auto-resume the run the user just interrupted (the drain only
	 *  fires while agent.hasQueuedMessages()). Plain Alt+Up dequeue preserves those non-user steers. */
	clearQueue(options?: { forInterrupt?: boolean }): {
		steering: RestoredQueuedMessage[];
		followUp: RestoredQueuedMessage[];
	} {
		const steeringAll = this.agent.peekSteeringQueue();
		const followUpAll = this.agent.peekFollowUpQueue();
		const steering = steeringAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const followUp = followUpAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const keep: (m: AgentMessage) => boolean = options?.forInterrupt
			? isAdvisorCard
			: m => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m);
		this.agent.replaceQueues(steeringAll.filter(keep), followUpAll.filter(keep));
		return { steering, followUp };
	}

	/** Number of pending displayable messages (includes steering, follow-up, and next-turn messages).
	 *  Reflects actual queued work (advisor cards included) — feeds hasPendingMessages()/RPC and the
	 *  empty-submit abort gate. The user-restorable subset is surfaced by getQueuedMessages()/clearQueue(). */
	get queuedMessageCount(): number {
		return (
			this.agent.peekSteeringQueue().filter(isDisplayableQueuedMessage).length +
			this.agent.peekFollowUpQueue().filter(isDisplayableQueuedMessage).length +
			this.#pendingNextTurnMessages.length
		);
	}

	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return {
			steering: this.agent.peekSteeringQueue().filter(isUserQueuedMessage).map(queueChipText),
			followUp: this.agent.peekFollowUpQueue().filter(isUserQueuedMessage).map(queueChipText),
		};
	}

	/**
	 * Pop the last queued message (steering first, then follow-up).
	 * Used by dequeue keybinding to restore messages to editor one at a time.
	 * Steps over agent-authored queued messages (advisor cards, hidden/internal steers).
	 */
	popLastQueuedMessage(): RestoredQueuedMessage | undefined {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const lastUserIndex = (queue: readonly AgentMessage[]): number => {
			for (let i = queue.length - 1; i >= 0; i--) {
				if (isUserQueuedMessage(queue[i])) return i;
			}
			return -1;
		};
		// Notices queue immediately before their user message, so dropping the popped
		// prompt means also dropping the contiguous hidden-user companions right before
		// it — companions of other queued prompts stay put.
		const removeWithCompanions = (queue: readonly AgentMessage[], userIndex: number): AgentMessage[] => {
			let start = userIndex;
			while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
			const next = queue.slice();
			next.splice(start, userIndex - start + 1);
			return next;
		};
		const fromSteer = lastUserIndex(steering);
		if (fromSteer >= 0) {
			const removed = steering[fromSteer];
			this.agent.replaceQueues(removeWithCompanions(steering, fromSteer), followUp.slice());
			return toRestoredQueuedMessage(removed);
		}
		const fromFollowUp = lastUserIndex(followUp);
		if (fromFollowUp >= 0) {
			const removed = followUp[fromFollowUp];
			this.agent.replaceQueues(steering.slice(), removeWithCompanions(followUp, fromFollowUp));
			return toRestoredQueuedMessage(removed);
		}
		return undefined;
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#tools.skillsSettings;
	}

	/** Skills loaded by SDK (empty if --no-skills or skills: [] was passed) */
	get skills(): readonly Skill[] {
		return this.#tools.skills;
	}

	/** Skill loading warnings captured by SDK */
	get skillWarnings(): readonly SkillWarning[] {
		return this.#tools.skillWarnings;
	}

	getTodoPhases(): TodoPhase[] {
		return this.#todo.phases;
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#todo.setPhases(phases);
	}

	#buildReplanTitleContext(): string {
		return buildReplanTitleContext(this.agent.state.messages);
	}

	#scheduleReplanTitleRefresh(): void {
		// Headless subagent sessions have no operator-visible title, so a todo-init
		// replan refresh only burns a tiny-model call whose result lands in JSONL
		// and is never shown (issue #5910). In an interactive host the operator can
		// focus a live subagent from the Agent Hub, where the status line renders
		// its session name — so keep the refresh there and only skip subagents when
		// no focusable UI exists (print/RPC/ACP/eval/SDK/CI).
		if (this.#agentKind === "sub" && !isInteractiveHost()) return;
		if (this.#replanTitleRefreshInFlight) return;
		if (!this.settings.get("title.refreshOnReplan")) return;
		if (this.sessionManager.titleSource === "user") return;
		const context = this.#buildReplanTitleContext();
		if (!context) return;
		const sessionId = this.sessionManager.getSessionId();
		const refresh = this.#refreshTitleAfterReplan(context, sessionId)
			.catch(err => {
				logger.warn("title-generator: replan refresh failed", {
					sessionId,
					error: err instanceof Error ? err.message : String(err),
				});
			})
			.finally(() => {
				if (this.#replanTitleRefreshInFlight === refresh) {
					this.#replanTitleRefreshInFlight = undefined;
				}
			});
		this.#replanTitleRefreshInFlight = refresh;
	}

	/**
	 * Generate an automatic session title tied to this session's lifecycle.
	 * Input and replan callers share the signal so disposal cancels provider and
	 * local-worker requests instead of leaving background inference alive.
	 */
	generateTitle(firstMessage: string): Promise<string | null> {
		return generateSessionTitle(
			firstMessage,
			this.#modelRegistry,
			this.settings,
			this.sessionId,
			this.model,
			provider => this.agent.metadataForProvider(provider),
			this.#titleSystemPrompt,
			this.#titleGenerationAbortController.signal,
		);
	}

	async #refreshTitleAfterReplan(context: string, sessionId: string): Promise<void> {
		const title = await this.generateTitle(context);
		if (!title) return;
		if (this.sessionManager.getSessionId() !== sessionId) return;
		if (!this.settings.get("title.refreshOnReplan")) return;
		if (this.sessionManager.titleSource === "user") return;
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		await setSessionName.call(this.sessionManager, title, "auto", "replan");
	}

	/** Currently-applied {@link TITLE_SYSTEM.md} override, or undefined when the
	 *  bundled prompt is in effect. Consumed by {@link InteractiveMode} so the
	 *  first-input title path and the replan refresh share one source. */
	get titleSystemPrompt(): string | undefined {
		return this.#titleSystemPrompt;
	}

	/** Replace the title-generation system prompt override. Called by
	 *  {@link InteractiveMode.refreshTitleSystemPrompt} after the session cwd
	 *  changes (e.g. `/move` relocation) so the next replan refresh resolves
	 *  against the destination project's override. */
	setTitleSystemPrompt(prompt: string | undefined): void {
		this.#titleSystemPrompt = prompt;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 *
	 * `reason` (e.g. `USER_INTERRUPT_LABEL`) rides the agent's `AbortController`
	 * and surfaces verbatim on the aborted assistant message's `errorMessage`, so
	 * the transcript can distinguish a deliberate user interrupt from an opaque
	 * abort. Omit it for internal/lifecycle aborts.
	 */
	async abort(options?: {
		goalReason?: "interrupted" | "internal";
		reason?: string;
		/** Internal `/compact` startup keeps the manual-compaction marker alive while aborting the active turn. */
		preserveCompaction?: boolean;
	}): Promise<void> {
		const userInterrupt = options?.reason === USER_INTERRUPT_LABEL;
		this.#pendingAbortErrorId = userInterrupt ? AIError.create(AIError.Flag.UserInterrupt) : undefined;
		if (userInterrupt) this.#advisors.autoResumeSuppressed = true;
		// Pull advisor concerns out of the steer/follow-up queues before any await so
		// the post-abort stranded-message drain can't auto-resume the run on them.
		// They are re-recorded as visible advice once the agent settles (below).
		const strandedAdvisorCards = userInterrupt ? this.#extractQueuedAdvisorCards() : [];
		// Session switch/compact paths disconnect first; explicit aborts should
		// leave any queued steer/follow-up visible for the user rather than
		// auto-starting a fresh turn during cleanup.
		this.#abortInProgress = true;
		try {
			this.#abortAutolearnCapture();
			for (const controller of this.#usagePreflightAbortControllers) controller.abort();
			this.abortRetry();
			this.#promptGeneration++;
			this.#scheduledHiddenNextTurnGeneration = undefined;
			if (options?.preserveCompaction) {
				// Manual `/compact` installed its own #compactionAbortController before
				// this internal abort and must keep it alive (that marker is what makes
				// isCompacting report true during startup). Any in-flight
				// auto-compaction MUST still be cancelled, though: otherwise a
				// background maintenance pass races the manual run and both
				// appendCompaction/replaceMessages, double-rewriting session history.
				this.#maintenance.abortAutomaticCompaction();
			} else {
				this.abortCompaction();
			}
			this.abortHandoff();
			this.abortBash();
			this.abortEval();
			const postPromptDrain = this.#cancelPostPromptTasks();
			this.agent.abort(options?.reason);
			await postPromptDrain;
			await this.agent.waitForIdle();
			await this.#drainAutolearnCapture();
			await this.#goalRuntime.onTaskAborted({ reason: options?.goalReason ?? "interrupted" });
			// Clear prompt-in-flight state: waitForIdle resolves when the agent loop's finally
			// block runs, but nested prompt setup/finalizers may still be unwinding. Without this,
			// a subsequent prompt() can incorrectly observe the session as busy after an abort.
			this.#resetInFlight();
			this.#resetSessionStopContinuationState();
			this.#clearPendingSessionStopContinuations();
			// Safety net: if the agent loop aborted without producing an assistant
			// message (e.g. failed before the first stream), the in-flight yield was
			// never resolved or rejected by the normal message_end path. Reject it now
			// so any requeue callback still fires and the queue stays consistent.
			if (this.#toolChoiceQueue.hasInFlight) {
				this.#toolChoiceQueue.reject("aborted");
			}
			// Re-record advisor concerns the interrupt would otherwise strand, as
			// visible/persisted advice without triggering a turn (the agent is idle
			// now): cards steered into the queue before the user stopped, plus any
			// that arrived via enqueueAdvice mid-abort and were parked hidden in
			// #pendingNextTurnMessages while the turn was still tearing down. Other
			// deferred next-turn context (non-advisor) stays queued, in order.
			const parkedAdvisorCards = this.#pendingNextTurnMessages.filter(isAdvisorCard);
			if (parkedAdvisorCards.length > 0) {
				this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !isAdvisorCard(m));
			}
			for (const card of [...strandedAdvisorCards, ...parkedAdvisorCards]) {
				this.#preserveAdvisorCard(card);
			}
		} finally {
			this.#abortInProgress = false;
			this.#drainStrandedQueuedMessages();
		}
	}

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options - Optional initial messages and parent session path
	 * @returns true if completed, false if cancelled by hook
	 */
	async newSession(options?: NewSessionOptions): Promise<boolean> {
		this.#assertVibeSessionTransitionAllowed("start a new session");
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "new" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();
		this.#cancelOwnAsyncJobs();
		this.#closeAllProviderSessions("new session");
		await this.#bash.flushPending();
		const bashTransition = this.#bash.beginSessionTransition({ persistDetached: options?.drop !== true });
		let sessionTransitioned = false;
		try {
			this.agent.reset();
			if (options?.drop && previousSessionFile) {
				// Detach the advisor recorder feed and drain its writer BEFORE deleting the
				// old artifacts dir: `await this.abort()` only stops the primary, so a still-
				// running advisor turn could otherwise finish, emit `message_end`, and recreate
				// `<old>/__advisor.jsonl`. #resetAdvisorSessionState (after newSession) re-primes
				// the advisor and re-attaches the feed at the new session's path.
				await this.#advisors.detachAndCloseRecorders();
				try {
					await this.sessionManager.dropSession(previousSessionFile);
				} catch (err) {
					logger.error("Failed to delete session during /drop", { err });
				}
			} else {
				await this.sessionManager.flush();
			}
			await this.sessionManager.newSession({
				...options,
				additionalDirectories: this.settings.get("workspace.additionalDirectories"),
			});
			this.#bash.markSessionTransition(bashTransition);
			sessionTransitioned = true;
		} finally {
			this.#bash.finishSessionTransition(bashTransition, sessionTransitioned);
		}

		this.#clearSessionScopedToolState();
		this.#clearCheckpointRuntimeState();
		this.setTodoPhases([]);
		this.#freshProviderSessionId = undefined;
		this.#clearInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#memory.rekeyForCurrentSessionId();
		await this.#memory.resetContextForNewTranscript();
		this.#pendingNextTurnMessages = [];
		this.#shakeToolCallCounter = 0;
		this.#scheduledHiddenNextTurnGeneration = undefined;

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel, this.configuredThinkingLevel());
		this.sessionManager.appendServiceTierChange(this.#models.serviceTierEntry());

		this.#todo.resetCycle();
		this.#planReferenceSent = false;
		this.#planReferencePath = "local://PLAN.md";
		this.#advisors.resetSessionState();
		this.#reconnectToAgent();
		// The workspace-roots block must reflect the new session's directory set,
		// not the previous session's — refresh before the next turn goes out.
		await this.refreshBaseSystemPrompt();

		// Emit session_switch event with reason "new" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string, source: "auto" | "user" = "auto", trigger?: SessionNameTrigger): Promise<boolean> {
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		return setSessionName.call(this.sessionManager, name, source, trigger);
	}

	/**
	 * Fork the current session, creating a new session file with the exact same state.
	 * Copies all entries and artifacts to the new session.
	 * Unlike newSession(), this preserves all messages in the agent state.
	 * @returns true if completed, false if cancelled by hook or not persisting
	 */
	async fork(): Promise<boolean> {
		this.#assertVibeSessionTransitionAllowed("fork the session");
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "fork" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		await this.#bash.flushPending();
		// Flush current session to ensure all entries are written
		await this.sessionManager.flush();
		const bashTransition = this.#bash.beginSessionTransition();

		// Fork the session (creates new session file with same entries)
		let forkResult: { oldSessionFile: string; newSessionFile: string } | undefined;
		try {
			forkResult = await this.sessionManager.fork();
		} catch (error) {
			this.#bash.finishSessionTransition(bashTransition, false);
			throw error;
		}
		if (!forkResult) {
			this.#bash.finishSessionTransition(bashTransition, false);
			return false;
		}
		this.#bash.markSessionTransition(bashTransition);
		this.#bash.finishSessionTransition(bashTransition, true);

		// Copy artifacts directory if it exists
		const oldArtifactDir = forkResult.oldSessionFile.slice(0, -6);
		const newArtifactDir = forkResult.newSessionFile.slice(0, -6);

		try {
			const oldDirStat = await fs.promises.stat(oldArtifactDir);
			if (oldDirStat.isDirectory()) {
				await fs.promises.cp(oldArtifactDir, newArtifactDir, { recursive: true });
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to copy artifacts during fork", {
					oldArtifactDir,
					newArtifactDir,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Update agent session ID
		this.#freshProviderSessionId = undefined;
		this.#adoptInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#memory.rekeyForCurrentSessionId();
		await this.#memory.resetContextForNewTranscript();
		this.#shakeToolCallCounter = 0;

		// Emit session_switch event with reason "fork" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "fork",
				previousSessionFile,
			});
		}

		return true;
	}

	/** Move the active session and artifacts after enforcing mode transition invariants. */
	async moveSession(newCwd: string, targetSessionDir?: string): Promise<void> {
		this.#assertVibeSessionTransitionAllowed("move the session");
		await this.sessionManager.moveTo(newCwd, targetSessionDir);
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly.
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs). Active switches
	 * always take effect; if the current transcript is too large for the target
	 * model, the next prompt's compaction/error path owns that recovery instead
	 * of leaving the session pinned to the old model.
	 * @throws Error if no API key available for the model
	 */
	async setModel(
		model: Model,
		role: string = "default",
		options?: {
			selector?: string;
			thinkingLevel?: ThinkingLevel;
			persist?: boolean;
			currentContextTokens?: number;
		},
	): Promise<{ switched: boolean }> {
		return this.#models.setModel(model, role, options);
	}

	/** Selects a model for this session without updating persisted model settings. */
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void> {
		return this.#models.setModelTemporary(model, thinkingLevel, options);
	}

	/** Cycles the scoped model set, or all available models when no scope exists. */
	cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		return this.#models.cycleModel(direction);
	}

	/** Resolves configured role models and the currently active role index. */
	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		return this.#models.getRoleModelCycle(roleOrder);
	}

	/** Applies a resolved role model without changing global settings. */
	applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		return this.#models.applyRoleModel(entry);
	}

	/** Cycles the configured role models in the supplied order. */
	cycleRoleModels(
		roleOrder: readonly string[],
		direction: "forward" | "backward" = "forward",
	): Promise<RoleModelCycleResult | undefined> {
		return this.#models.cycleRoleModels(roleOrder, direction);
	}

	/** Lists available models after applying the configured enabled-model filter. */
	getAvailableModels(): Model[] {
		return this.#models.getAvailableModels();
	}

	/** Selects the session thinking level and optionally persists it as the default. */
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined, persist: boolean = false): void {
		this.#models.setThinkingLevel(level, persist);
	}

	/** Advances through the thinking selectors supported by the active model. */
	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#models.cycleThinkingLevel();
	}

	/** Reports whether `/fast` is enabled for the active model family. */
	isFastModeEnabled(): boolean {
		return this.#models.isFastModeEnabled();
	}

	/** Reports whether priority service is realized by the active model. */
	isFastModeActive(): boolean {
		return this.#models.isFastModeActive();
	}

	/** Sets or clears one model family's live service tier. */
	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		this.#models.setServiceTierFamily(family, tier);
	}

	/** Enables or disables priority service for the active model family. */
	setFastMode(enabled: boolean): boolean {
		return this.#models.setFastMode(enabled);
	}

	/** Toggles priority service for the active model family. */
	toggleFastMode(): boolean {
		return this.#models.toggleFastMode();
	}

	/** Lists thinking levels supported by the active model. */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		return this.#models.getAvailableThinkingLevels();
	}

	// =========================================================================
	// Message Queue Mode Management
	// =========================================================================

	/**
	 * Set steering mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	/**
	 * Set follow-up mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	/**
	 * Set interrupt mode.
	 * Saves to settings.
	 */
	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	/**
	 * already carry skill protection). The matcher reads the current plan
	 * reference path at match time, so retitled plans are covered.
	 */
	#withPlanProtection<T extends { protectedTools: ProtectedToolMatcher[] }>(config: T): T {
		const planMatcher = createPlanReadMatcher(() => this.#planReferencePath);
		return { ...config, protectedTools: [...config.protectedTools, planMatcher] };
	}

	async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const branchEntries = this.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneToolOutputs(
			branchEntries,
			this.#withPlanProtection({
				...DEFAULT_PRUNE_CONFIG,
				pruneUseless: this.settings.getGroup("compaction").dropUseless,
				// Cache-stable boundary: never re-write the warm, already-sent prefix
				// (deep stale/age victims) or summarized-away entries every turn.
				keepBoundaryId,
				cacheWarmSuffixTokens: PRUNE_CACHE_WARM_SUFFIX_TOKENS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#advisors.resetAllRuntimes();
		this.#todo.syncFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return result;
	}

	/**
	 * Per-turn stale-result pass: prune older `read` results that a newer read
	 * of the same file has made stale, plus results their tool flagged
	 * contextually useless. Cache-aware (only fires when the suffix after a
	 * candidate is small or the session has been idle long enough that the
	 * provider prompt cache is cold), so it is cheap to run every turn. Gated
	 * on the `compaction.supersedeReads` and `compaction.dropUseless` settings.
	 *
	 * Persists via `rewriteEntries` like every other history rewrite — the
	 * session file must match the live (pruned) context or file-based forks
	 * (`/fork`, `/tan`) and resume rebuild a divergent prefix and cold-miss the
	 * provider prompt cache.
	 */
	async #pruneStaleToolResults(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const { supersedeReads, dropUseless } = this.settings.getGroup("compaction");
		if (!supersedeReads && !dropUseless) return undefined;
		const branchEntries = this.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneSupersededToolResults(
			branchEntries,
			this.#withPlanProtection({
				supersedeKey: supersedeReads ? readToolSupersedeKey : undefined,
				pruneUseless: dropUseless,
				protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools],
				// Never re-write summarized-away entries; only flush the whole sent
				// region once the cache is genuinely cold (idle exceeds the 1h TTL).
				keepBoundaryId,
				idleFlushMs: PRUNE_IDLE_FLUSH_MS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#advisors.resetAllRuntimes();
		this.#todo.syncFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return result;
	}

	/**
	 * Strip image content blocks from every message on the current branch and
	 * persist the rewrite. Walks `SessionManager.getBranch()` in place — both
	 * `SessionMessageEntry.message` and `CustomMessageEntry.content` arrays
	 * are mutated, then `rewriteEntries` durably commits the new shape. The
	 * agent's runtime view is rebuilt from the freshly-mutated entries so any
	 * provider sessions caching message identity (Codex Responses) are torn
	 * down to force a clean replay on the next turn.
	 *
	 * No-op when the branch carries no images; returns `{ removed: 0 }` and
	 * skips the disk rewrite.
	 */
	/**
	 * - `images` delegates to {@link dropImages}.
	 * - `elide` replaces whole tool-call results and large fenced/XML blocks
	 *   with short placeholders that embed an `artifact://` recovery link.
	 *
	 * Mutates the branch in place, persists via `rewriteEntries`, replays the
	 * rebuilt context through the agent, and tears down provider sessions that
	 * cache message identity — same rewrite contract as {@link dropImages}.
	 *
	 * No-op (zero counts) when nothing is eligible.
	 */
	async shake(
		mode: ShakeMode,
		opts: { config?: ShakeConfig; signal?: AbortSignal; skipAgentUpdate?: boolean } = {},
	): Promise<ShakeResult> {
		if (mode === "images") {
			const { removed } = await this.dropImages();
			return { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: removed, tokensFreed: 0 };
		}

		const branchEntries = this.sessionManager.getBranch();
		const config = this.#withPlanProtection({
			...(opts.config ?? AGGRESSIVE_SHAKE_CONFIG),
			// Skip entries summarized away by the latest compaction — shaking them
			// only churns persisted history with no prompt/cache effect.
			keepBoundaryId: getLatestCompactionEntry(branchEntries)?.firstKeptEntryId,
		});
		const regions = collectShakeRegions(branchEntries, config);
		if (regions.length === 0) {
			return { mode, toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 };
		}

		const artifactId = await this.#saveShakeArtifact(regions);
		const replacements = regions.map((region, index) => this.#shakeElidePlaceholder(region, index, artifactId));

		let toolResultsDropped = 0;
		let blocksDropped = 0;
		let originalTokens = 0;
		let replacementTokens = 0;
		const items = regions.map((region, index) => {
			if (region.kind === "toolResult") toolResultsDropped++;
			else blocksDropped++;
			originalTokens += region.tokens;
			const replacement = replacements[index];
			if (replacement.length > 0) replacementTokens += countTokens(replacement);
			return { region, replacement };
		});

		applyShakeRegions(items);

		await this.sessionManager.rewriteEntries();
		if (!opts.skipAgentUpdate) {
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#advisors.resetAllRuntimes();
			this.#closeCodexProviderSessionsForHistoryRewrite();
		}

		return {
			mode,
			toolResultsDropped,
			blocksDropped,
			tokensFreed: Math.max(0, originalTokens - replacementTokens),
			artifactId,
		};
	}

	#shakeElidePlaceholder(region: ShakeRegion, index: number, artifactId: string | undefined): string {
		if (artifactId) {
			return `[shaken ~${region.tokens} tokens — recover: artifact://${artifactId} (region ${index + 1})]`;
		}
		return `[shaken ~${region.tokens} tokens]`;
	}

	/**
	 * Concatenate the original region contents into one session artifact so the
	 * agent can read them back via `artifact://<id>`. Returns `undefined` when
	 * the session is not persisted or the write fails — callers degrade to a
	 * bare placeholder.
	 */
	async #saveShakeArtifact(regions: ShakeRegion[]): Promise<string | undefined> {
		const parts: string[] = [];
		for (let i = 0; i < regions.length; i++) {
			const region = regions[i];
			parts.push(`### region ${i + 1} (${region.label}, ~${region.tokens} tok)`, "", region.originalText, "");
		}
		try {
			return await this.sessionManager.saveArtifact(parts.join("\n"), "shake");
		} catch {
			return undefined;
		}
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 * @param options Optional callbacks for completion/error handling
	 */

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	/**
	 * Cancel in-progress handoff generation.
	 */
	abortHandoff(): void {
		this.#handoff.abortHandoff();
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#handoff.isGeneratingHandoff;
	}

	/**
	 * Generate a handoff document with a oneshot LLM call, then start a new session with it.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
	handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		return this.#handoff.handoff(customInstructions, options);
	}

	#isTerminalYieldToolResult(event: { toolName: string; isError?: boolean; result?: { details?: unknown } }): boolean {
		if (event.toolName !== "yield" || event.isError) return false;
		const details = event.result?.details;
		if (!details || typeof details !== "object") return true;
		const record = details as Record<string, unknown>;
		return !(
			record.status === "success" &&
			Array.isArray(record.type) &&
			record.type.length > 0 &&
			record.type.every(item => typeof item === "string")
		);
	}

	#markTerminalYieldToolCall(toolCallId: string): void {
		this.#lastSuccessfulYieldToolCallId = toolCallId;
		this.#yieldTerminationPending = true;
	}

	#assistantMessageHasSuccessfulYieldToolCall(assistantMessage: AssistantMessage, toolCallId: string): boolean {
		const lastToolCall = assistantMessage.content
			.slice()
			.reverse()
			.find((content): content is ToolCall => content.type === "toolCall");
		return lastToolCall?.name === "yield" && lastToolCall.id === toolCallId;
	}

	#assistantEndedWithSuccessfulYield(assistantMessage: AssistantMessage): boolean {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		return toolCallId ? this.#assistantMessageHasSuccessfulYieldToolCall(assistantMessage, toolCallId) : false;
	}

	#findSuccessfulYieldAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		if (!toolCallId) return undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			if (this.#assistantMessageHasSuccessfulYieldToolCall(message, toolCallId)) return message;
		}
		return undefined;
	}

	#enforceRewindBeforeYield(): boolean {
		if (!this.#checkpointState || this.#pendingRewindReport) {
			return false;
		}
		const reminder = [
			"<system-warning>",
			"You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.",
			"</system-warning>",
		].join("\n");
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#extractRewindReport(messages: AgentMessage[]): string | undefined {
		if (!this.#checkpointState) return undefined;
		if (this.#pendingRewindReport) return this.#pendingRewindReport;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role !== "toolResult" || message.isError) continue;
			const semanticResult = semanticToolResult(message.toolName, message);
			if (semanticResult?.toolName !== "rewind") continue;
			const details = semanticResult.details;
			const detailReport =
				details && typeof details === "object" && "report" in details && typeof details.report === "string"
					? details.report.trim()
					: "";
			const textReport = message.content.find(part => part.type === "text")?.text.trim() ?? "";
			const report = detailReport || textReport;
			return report.length > 0 ? report : undefined;
		}
		return undefined;
	}

	async #applyRewind(report: string, activeMessages?: AgentMessage[]): Promise<void> {
		const checkpointState = this.#checkpointState;
		if (!checkpointState) {
			return;
		}
		this.#bash.withBranchTransition(() => {
			try {
				this.sessionManager.branchWithSummary(checkpointState.checkpointEntryId, report, {
					startedAt: checkpointState.startedAt,
				});
			} catch (error) {
				logger.warn("Rewind branch checkpoint missing, falling back to root", {
					error: error instanceof Error ? error.message : String(error),
				});
				this.sessionManager.branchWithSummary(null, report, { startedAt: checkpointState.startedAt });
			}
		});

		const rewoundAt = new Date().toISOString();
		const details = { report, startedAt: checkpointState.startedAt, rewoundAt };
		this.sessionManager.appendCustomMessageEntry(
			"rewind-report",
			prompt.render(rewindReportTemplate, { report }),
			false,
			details,
			"agent",
		);
		this.#lastCompletedRewind = { report, startedAt: checkpointState.startedAt, rewoundAt };

		if (activeMessages) {
			for (const message of activeMessages) {
				if (message.role === "toolResult" && semanticToolResult(message.toolName, message)?.toolName === "rewind") {
					this.#rewoundToolResultIds.add(message.toolCallId);
				}
			}
		}
		const sessionContext = this.buildDisplaySessionContext();
		if (activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...sessionContext.messages);
		}
		this.agent.replaceMessages(activeMessages ?? sessionContext.messages);
		this.#advisors.resetSessionState();
		this.#todo.syncFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
	}
	/** Plan-mode decision affordances: `ask`, or plan approval via `write xd://propose`. */
	#isPlanDecisionTool(toolCall: { name: string; arguments?: Record<string, unknown> }): boolean {
		return toolCall.name === "ask" || isProposeToolCall(toolCall);
	}

	async #enforcePlanModeDecisionAtSettle(): Promise<boolean> {
		if (!this.#planModeState?.enabled) {
			return false;
		}
		const assistantMessage = this.#findLastAssistantMessage();
		if (!assistantMessage) {
			return false;
		}
		if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
			return false;
		}

		const calledDecisionTool = assistantMessage.content.some(
			content => content.type === "toolCall" && this.#isPlanDecisionTool(content),
		);
		if (calledDecisionTool) {
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;
			return false;
		}

		const hasToolCall = assistantMessage.content.some(content => content.type === "toolCall");
		if (hasToolCall) {
			return false;
		}
		if (this.#planModeReminderAwaitingProgress) {
			return false;
		}
		if (this.#planModeReminderCount >= PLAN_MODE_REMINDER_MAX) {
			logger.debug("Plan mode convergence: reminder cap reached; yielding to user");
			return false;
		}
		const hasRequiredTools = this.#tools.registry.has("ask") && this.#tools.registry.has("write");
		if (!hasRequiredTools) {
			logger.warn("Plan mode enforcement skipped because ask/write tools are unavailable", {
				activeToolNames: this.agent.state.tools.map(tool => tool.name),
			});
			return false;
		}

		this.#planModeReminderCount++;
		this.#planModeReminderAwaitingProgress = true;
		this.#toolChoiceQueue.pushOnce("required", { label: "plan-mode-decision" });
		const reminder = prompt.render(planModeToolDecisionReminderPrompt, {
			askToolName: "ask",
		});
		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};

		this.agent.appendMessage(reminderMessage);
		this.sessionManager.appendMessage(reminderMessage);
		this.#scheduleAgentContinue({
			generation: this.#promptGeneration,
			// If the continuation never runs (new prompt, dispose, compaction,
			// handoff), the forced choice must not leak onto an unrelated turn.
			onSkip: () => this.#toolChoiceQueue.removeByLabel("plan-mode-decision"),
		});
		return true;
	}

	#setModelWithProviderSessionReset(model: Model): void {
		const currentModel = this.model;
		if (currentModel) {
			this.#closeProviderSessionsForModelSwitch(currentModel, model);
			if (!modelsAreEqual(currentModel, model)) {
				this.#clearInheritedProviderPromptCacheKey();
			}
		}
		this.agent.setModel(model);

		// Re-evaluate append-only context mode — provider or setting may have changed
		this.#syncAppendOnlyContext(model);
	}

	#closeCodexProviderSessionsForHistoryRewrite(): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-codex-responses") return;
		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
	}

	#resetCodexProviderAfterCompaction(compaction: CodexCompactionContext): void {
		resetOpenAICodexHistoryAfterCompaction({
			providerSessionState: this.#providerSessionState,
			sessionId: this.sessionId,
			compaction,
		});
	}

	#resetCurrentResponsesProviderSession(reason: string): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-responses" && currentModel?.api !== "openai-codex-responses") {
			return;
		}

		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
		this.agent.appendOnlyContext?.invalidateForModelChange();
		logger.debug("Reset Responses provider session after stale replay error", {
			provider: currentModel.provider,
			model: currentModel.id,
			api: currentModel.api,
			reason,
		});
	}

	/**
	 * Re-evaluate append-only context mode, creating or destroying the
	 * manager as needed. Called on model switch AND setting change.
	 */
	#syncAppendOnlyContext(model: Model | null | undefined): void {
		const setting = this.settings.get("provider.appendOnlyContext") ?? "auto";
		const enable = shouldEnableAppendOnlyContext(setting, model);
		const providerId = model?.provider;
		const prev = this.#lastAppendOnlyResolution;
		if (prev && prev.enable === enable && prev.providerId === providerId) return;
		this.#lastAppendOnlyResolution = { enable, providerId };

		if (enable && !this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(new AppendOnlyContextManager());
		} else if (enable && this.agent.appendOnlyContext) {
			// Already active — invalidate prefix + log so the next turn
			// rebuilds for the current model's normalization.
			this.agent.appendOnlyContext.invalidateForModelChange();
		} else if (!enable && this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(undefined);
		}
	}

	#closeProviderSessionsForModelSwitch(currentModel: Model, nextModel: Model): void {
		const providerKeys = new Set<string>();
		if (currentModel.api === "openai-codex-responses" || nextModel.api === "openai-codex-responses") {
			providerKeys.add("openai-codex-responses");
		}
		if (currentModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${currentModel.provider}`);
		}
		if (nextModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${nextModel.provider}`);
		}

		// `openai-completions` sessions are keyed `openai-completions:<provider>:<resolvedBaseUrl>:<modelId>`
		// and cache backend-specific decisions (strict-tools disable scopes, reasoning-effort
		// fallbacks). The resolved request base URL can differ from the catalog `model.baseUrl`
		// (Moonshot env override, Alibaba Coding Plan enterprise URL, Azure deployment URL),
		// so evict by provider prefix when the user moves away from that completions backend.
		let completionsPrefixToEvict: string | undefined;
		if (currentModel.api === "openai-completions") {
			const currentScope = `${currentModel.provider}:${currentModel.baseUrl ?? ""}`;
			const nextScope =
				nextModel.api === "openai-completions" ? `${nextModel.provider}:${nextModel.baseUrl ?? ""}` : undefined;
			if (currentScope !== nextScope) {
				completionsPrefixToEvict = `openai-completions:${currentModel.provider}:`;
			}
		}

		for (const providerKey of providerKeys) {
			const state = this.#providerSessionState.get(providerKey);
			if (!state) continue;

			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state during model switch", {
					providerKey,
					error: String(error),
				});
			}

			this.#providerSessionState.delete(providerKey);
		}

		if (completionsPrefixToEvict !== undefined) {
			for (const [key, state] of this.#providerSessionState) {
				if (!key.startsWith(completionsPrefixToEvict)) continue;
				try {
					state.close();
				} catch (error) {
					logger.warn("Failed to close provider session state during model switch", {
						providerKey: key,
						error: String(error),
					});
				}
				this.#providerSessionState.delete(key);
			}
		}
	}

	#normalizeProviderReplayValue(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map(item => this.#normalizeProviderReplayValue(item));
		}
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, entryValue]) => [key, this.#normalizeProviderReplayValue(entryValue)]),
			);
		}
		return value;
	}

	#normalizeSessionMessageForProviderReplay(message: AgentMessage): unknown {
		switch (message.role) {
			case "user":
			case "developer":
				return {
					role: message.role,
					content: this.#normalizeProviderReplayValue(message.content),
					providerPayload: message.providerPayload,
				};
			case "assistant": {
				const isResponsesFamilyMessage =
					message.api === "openai-responses" || message.api === "openai-codex-responses";
				return {
					role: message.role,
					content:
						isResponsesFamilyMessage && Array.isArray(message.content)
							? message.content.flatMap(block => {
									if (block.type === "thinking") {
										return [];
									}
									if (block.type === "toolCall") {
										return [
											{
												type: block.type,
												id: block.id,
												name: block.name,
												arguments: block.arguments,
											},
										];
									}
									if (block.type === "text") {
										return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
									}
									return [this.#normalizeProviderReplayValue(block)];
								})
							: this.#normalizeProviderReplayValue(message.content),
					api: message.api,
					provider: message.provider,
					model: message.model,
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
					providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
				};
			}
			case "toolResult":
				return {
					role: message.role,
					toolName: message.toolName,
					toolCallId: message.toolCallId,
					isError: message.isError,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "bashExecution":
				return {
					role: message.role,
					command: message.command,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "pythonExecution":
				return {
					role: message.role,
					code: message.code,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "custom":
			case "hookMessage":
				return {
					role: message.role,
					customType: message.customType,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "branchSummary":
				return { role: message.role, summary: message.summary };
			case "compactionSummary":
				return {
					role: message.role,
					summary: message.summary,
					providerPayload: message.providerPayload,
				};
			case "fileMention":
				return {
					role: message.role,
					files: message.files.map(file => ({
						path: file.path,
						content: file.content,
						image: file.image,
					})),
				};
			default:
				return this.#normalizeProviderReplayValue(message);
		}
	}

	#didSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
		if (previousMessages.length !== nextMessages.length) return true;
		return previousMessages.some(
			(message, i) =>
				!Bun.deepEquals(
					this.#normalizeSessionMessageForProviderReplay(message),
					this.#normalizeSessionMessageForProviderReplay(nextMessages[i]),
				),
		);
	}

	#getModelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#formatRoleModelValue(
		role: string,
		model: Model,
		selectorOverride?: string,
		thinkingLevelOverride?: ThinkingLevel,
	): string {
		const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
		if (thinkingLevelOverride !== undefined) {
			return formatModelSelectorValue(modelKey, thinkingLevelOverride);
		}
		const existingRoleValue = this.settings.getModelRole(role);
		if (!existingRoleValue) return modelKey;

		const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, this.settings, {
			isLiteralModelId: (provider, id) => this.#modelRegistry.find(provider, id) !== undefined,
		});
		return formatModelSelectorValue(modelKey, thinkingLevel);
	}
	#resolveConfiguredModelTarget(
		configuredTarget: string | undefined,
		currentModel: Model,
		availableModels: Model[],
	): Model | undefined {
		const trimmedTarget = configuredTarget?.trim();
		if (!trimmedTarget) return undefined;

		const parsed = parseModelString(trimmedTarget, {
			allowMaxSuffix: true,
			allowAutoAlias: true,
			isLiteralModelId: (provider, id) =>
				availableModels.some(model => model.provider === provider && model.id === id),
		});
		if (parsed) {
			const explicitModel = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			if (explicitModel) return explicitModel;
		}

		return availableModels.find(m => m.provider === currentModel.provider && m.id === trimmedTarget);
	}

	#resolveContextPromotionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		return this.#resolveConfiguredModelTarget(currentModel.contextPromotionTarget, currentModel, availableModels);
	}

	#resolveCompactionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		return this.#resolveConfiguredModelTarget(currentModel.compactionModel, currentModel, availableModels);
	}

	#resolveRoleModelFull(
		role: string,
		availableModels: Model[],
		currentModel: Model | undefined,
	): ResolvedModelRoleValue {
		const roleModelStr =
			role === "default"
				? (this.settings.getModelRole("default") ??
					(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
				: this.settings.getModelRole(role);

		if (!roleModelStr) {
			return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
		}

		return resolveModelRoleValue(roleModelStr, availableModels, {
			settings: this.settings,
			matchPreferences: getModelMatchPreferences(this.settings),
		});
	}

	#getCompactionModelCandidates(availableModels: Model[], filter?: (model: Model) => boolean): Model[] {
		return this.#resolveCompactionModelCandidates(this.model, availableModels, filter);
	}

	#resolveCompactionModelCandidates(
		preferredModel: Model | null | undefined,
		availableModels: Model[],
		filter?: (model: Model) => boolean,
	): Model[] {
		const candidates: Model[] = [];
		const seen = new Set<string>();

		const addCandidate = (model: Model | undefined): void => {
			if (!model) return;
			const key = this.#getModelKey(model);
			if (seen.has(key)) return;
			seen.add(key);
			// `seen` still tracks rejected models so the largest-context fallback
			// scan below doesn't reintroduce them; the filter just suppresses
			// inclusion in this caller's candidate chain.
			if (filter && !filter(model)) return;
			candidates.push(model);
		};

		if (preferredModel) {
			addCandidate(this.#resolveCompactionConfiguredTarget(preferredModel, availableModels));
		}
		addCandidate(preferredModel ?? undefined);
		for (const role of MODEL_ROLE_IDS) {
			addCandidate(this.#resolveRoleModelFull(role, availableModels, preferredModel ?? undefined).model);
		}

		const sortedByContext = [...availableModels].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
		for (const model of sortedByContext) {
			if (!seen.has(this.#getModelKey(model))) {
				addCandidate(model);
				break;
			}
		}

		return candidates;
	}

	#buildCompactionAuthError(): Error {
		const currentModel = this.model;
		if (!currentModel) {
			return new Error(
				"Compaction requires a model with usable credentials, but no authenticated compaction model is available.",
			);
		}
		return new Error(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}. ` +
				`Configure ${currentModel.provider} credentials or assign an authenticated fallback role such as modelRoles.smol.`,
		);
	}

	async #compactWithFallbackModel(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		options?: SummaryOptions,
		precomputedCandidates?: Model[],
	): Promise<CompactionResult> {
		const candidates =
			precomputedCandidates ?? this.#getCompactionModelCandidates(this.#modelRegistry.getAvailable());
		const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId);

		for (const candidate of candidates) {
			const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
			if (!apiKey) continue;

			try {
				return await compact(
					this.#obfuscatePreparationForProvider(preparation),
					candidate,
					this.#modelRegistry.resolver(candidate, this.sessionId),
					this.#obfuscateTextForProvider(customInstructions),
					signal,
					{
						...options,
						metadata: this.agent.metadataForProvider(candidate.provider),
						convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
						telemetry,
						// Honor the user's /model thinking selection (incl. `off`) on
						// the manual `/compact` path. Clamped per-model inside compact()
						// via resolveCompactionEffort so unsupported-effort models
						// (xai-oauth/grok-build) don't trip requireSupportedEffort.
						thinkingLevel: this.thinkingLevel,
						tools: this.agent.state.tools,
						sessionId: this.sessionId,
						promptCacheKey: this.sessionId,
						providerSessionState: this.#providerSessionState,
						// Route every summarization HTTP request through the
						// session's side-stream transport so the provider
						// concurrency cap (e.g. providers.ollama-cloud.maxConcurrency)
						// brackets compaction the same way it brackets the live
						// agent turn — without this, multiple ollama-cloud
						// subagents auto/manually compacting issued uncapped
						// summary requests in parallel (chatgpt-codex review on
						// #3751).
						completeImpl: async (requestModel, requestContext, requestOptions) => {
							const stream = await this.#sideStreamFn(requestModel, requestContext, requestOptions);
							return stream.result();
						},
					},
				);
			} catch (error) {
				if (!AIError.is(AIError.classify(error, candidate.api), AIError.Flag.AuthFailed)) {
					throw error;
				}
			}
		}

		throw this.#buildCompactionAuthError();
	}

	async #prepareCompactionFromHooks(
		preparation: CompactionPreparation,
		hookCompaction: CompactionResult | undefined,
	): Promise<
		| {
				kind: "fromHook";
				summary: string;
				shortSummary: string | undefined;
				firstKeptEntryId: string;
				tokensBefore: number;
				details: unknown;
				preserveData: Record<string, unknown> | undefined;
		  }
		| {
				kind: "needsLlm";
				hookContext: string[] | undefined;
				hookPrompt: string | undefined;
				preserveData: Record<string, unknown> | undefined;
		  }
	> {
		let hookContext: string[] | undefined;
		let hookPrompt: string | undefined;
		let preserveData: Record<string, unknown> | undefined;

		if (!hookCompaction && this.#extensionRunner?.hasHandlers("session.compacting")) {
			const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
			const result = (await this.#extensionRunner.emit({
				type: "session.compacting",
				sessionId: this.sessionId,
				messages: compactMessages,
			})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

			hookContext = result?.context;
			hookPrompt = result?.prompt;
			preserveData = result?.preserveData;
		}

		const memoryBackendContext = await this.#collectMemoryBackendContext(preparation);
		if (memoryBackendContext) {
			hookContext = hookContext ? [...hookContext, memoryBackendContext] : [memoryBackendContext];
		}

		if (hookCompaction) {
			preserveData ??= hookCompaction.preserveData;
			return {
				kind: "fromHook",
				summary: hookCompaction.summary,
				shortSummary: hookCompaction.shortSummary,
				firstKeptEntryId: hookCompaction.firstKeptEntryId,
				tokensBefore: hookCompaction.tokensBefore,
				details: hookCompaction.details,
				preserveData,
			};
		}

		return { kind: "needsLlm", hookContext, hookPrompt, preserveData };
	}

	/**
	 * Cap on snapcompact frames the post-compaction context can carry without
	 * busting the model window. Mirrors the per-frame token charge used by the
	 * projection ({@link snapcompact.FRAME_TOKEN_ESTIMATE}, the conservative
	 * high-res Anthropic ceiling), so picking `maxFrames` from this helper makes
	 * {@link #projectSnapcompactContextTokens} succeed by construction.
	 *
	 * Skip vs. cap use different reserves on purpose. The **skip** decision
	 * (return `0`) trips only when kept-recent plus non-message tokens already
	 * eat the entire `ctxWindow − reserve` envelope: at that point no archive
	 * shape — frame-bearing or text-only — can fit, and the caller MUST
	 * shortcut to the LLM summarizer instead of re-running snapcompact to
	 * re-emit the "could not bring the context under the limit" warning every
	 * threshold tick. The **cap** calculation subtracts a shape-aware reserve
	 * (`2 × geometry(shape).capacity` chars worth of text edges, billed at the
	 * tiktoken cl100k baseline, plus a 2k summary-template allowance) sized
	 * from the same `shape` snapcompact will use, so the projection still
	 * passes once frames land — but it MUST NOT gate the skip decision, since
	 * a frame-less archive (`text.length <= 2 * edgeCap` short-circuit in
	 * `planArchive`) typically costs only a few hundred tokens of summary
	 * lead and would fit under residual headroom far smaller than the cap
	 * reserve (chatgpt-codex reviews on #3249).
	 *
	 * Returns `1` when the frame charge would overflow but the text-only path
	 * still has room: snapcompact's planner picks the frame-less layout
	 * automatically when the discarded text fits in the edges, so giving it
	 * the minimum cap lets it succeed instead of being skipped outright.
	 *
	 * Without this cap, the bundled `MAX_FRAMES_DEFAULT = 80` × 5024 tokens =
	 * ~402k frame-token projection always overflows any sub-1M-token window
	 * (issue #3247).
	 */
	#computeSnapcompactMaxFrames(preparation: CompactionPreparation, settings: CompactionSettings): number {
		const ctxWindow = this.model?.contextWindow ?? 0;
		if (ctxWindow <= 0) return Math.min(snapcompact.MAX_FRAMES_DEFAULT, snapcompact.maxFramesForDataBudget());
		const reserve = effectiveReserveTokens(ctxWindow, settings);
		let baseTokens = computeNonMessageTokens(this);
		for (const message of preparation.recentMessages) {
			baseTokens += estimateTokens(message);
		}
		const totalBudget = ctxWindow - reserve;
		// Skip iff there is no headroom whatsoever; a text-only archive costs
		// far less than the cap reserve below, so any positive residual is
		// worth attempting and the projection guard catches actual overflow.
		if (baseTokens >= totalBudget) return 0;
		// Cap reserve mirrors what `estimateTokens(summaryMessage)` will charge
		// when frames > 0: `countTokens(summaryTemplate ‖ textHead ‖ textTail)`
		// plus `numFrames × FRAME_TOKEN_ESTIMATE`. Resolve the shape this
		// snapcompact pass will actually use (matches the `shape` argument
		// passed to `snapcompact.compact` in the auto and manual paths) so the
		// text-edge cost reflects the live frame geometry rather than a fixed
		// approximation. Reviewer (chatgpt-codex on #3249): a 4k reserve
		// undersized the ~7k text-edge cost on the default Anthropic
		// 11on16-bw shape, so the projection then rejected the `maxFrames`
		// the cap had picked and the warning loop reappeared.
		//
		// - `textHead` and `textTail` each consume up to `geometry.capacity`
		//   chars when frames > 0 (one HQ-capacity page per edge: see
		//   `TEXT_EDGE_PAGES = 1` in `planArchive`), so 2 × capacity chars
		//   total. Per-shape capacity: Anthropic 11on16-bw ~13.9k, Opus
		//   1932px ~21k, Gemini 8on22-bw 2048px ~23.8k, OpenAI 1568px ~13.9k.
		// - tiktoken cl100k ≈ 4 chars/token on ASCII (verified empirically
		//   for prose, code, and JSON); a 1.15 multiplier absorbs tokenizer
		//   drift on denser content (e.g. dense JSON / tool-result blobs).
		// - Summary template (intro + FILES section + grid notes) bills
		//   ~2k tokens for typical sessions.
		const shape = snapcompact.resolveShape(this.model, this.settings.get("snapcompact.shape"));
		const edgeCap = snapcompact.geometry(shape).capacity;
		const textEdgeTokens = Math.ceil((2 * edgeCap * 1.15) / 4);
		const SUMMARY_TEMPLATE_TOKENS = 2000;
		const capReserve = textEdgeTokens + SUMMARY_TEMPLATE_TOKENS;
		const frameBudget = totalBudget - baseTokens - capReserve;
		if (frameBudget < snapcompact.FRAME_TOKEN_ESTIMATE) return 1;
		return Math.min(
			Math.floor(frameBudget / snapcompact.FRAME_TOKEN_ESTIMATE),
			snapcompact.MAX_FRAMES_DEFAULT,
			snapcompact.maxFramesForDataBudget(),
		);
	}

	#snapcompactFramePayloadBytes(result: snapcompact.CompactionResult): number {
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		return archive ? snapcompact.frameDataBytes(archive.frames) : 0;
	}

	/**
	 * Project the post-compaction context size of a snapcompact result: kept
	 * recent messages + the summary message with its re-attached frames + the
	 * fixed non-message overhead (system prompt + tools). Mirrors how the
	 * compacted context is rebuilt, so the estimate matches the wire shape, and
	 * lets the caller decide whether snapcompact brought the context under the
	 * window or should fall back to an LLM summary.
	 */
	#projectSnapcompactContextTokens(preparation: CompactionPreparation, result: snapcompact.CompactionResult): number {
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		const blocks = archive
			? snapcompact.historyBlocks(archive, { maxFrameDataBytes: snapcompact.FRAME_DATA_BYTES_BUDGET })
			: undefined;
		const summaryMessage = createCompactionSummaryMessage(
			result.summary,
			result.tokensBefore,
			new Date().toISOString(),
			result.shortSummary,
			undefined,
			undefined,
			blocks,
		);
		let tokens = computeNonMessageTokens(this) + estimateTokens(summaryMessage);
		for (const message of preparation.recentMessages) {
			tokens += estimateTokens(message);
		}
		return tokens;
	}

	/**
	 * Post-maintenance progress check for the context-full / snapcompact tail.
	 *
	 * After `appendCompaction` rewrote history and `replaceMessages` swapped in the
	 * compacted context, measure the residual context off the live message set and
	 * decide whether maintenance actually created headroom. Mirrors the shake
	 * recovery-band logic (#2275): a session whose single most-recent turn already
	 * blows the threshold cannot be reduced by compaction (findCutPoint keeps that
	 * turn verbatim), so re-firing on the next agent_end just thrashes. We only
	 * report progress when residual context lands at or below
	 * `COMPACTION_RECOVERY_BAND × threshold` — a band that sits strictly under the
	 * compaction threshold, so reaching it guarantees the next turn cannot
	 * re-trip threshold compaction.
	 *
	 * When the model/window is unknown we cannot evaluate the band, so we
	 * optimistically allow the continuation (preserving prior behavior).
	 */
	#compactionCreatedHeadroom(): boolean {
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const compactionSettings = this.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			this.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
		// Residual at/below the band is authoritative headroom: the band sits
		// strictly under the compaction threshold, so the next turn cannot
		// re-trip threshold compaction regardless of how little this pass shaved.
		// Don't add a secondary "smaller than the trigger" guard — when stale/
		// tool-output pruning already dropped context under the band before this
		// pass, the trigger is itself sub-band, and requiring a strict reduction
		// would suppress a valid continuation and emit a false no-progress warning
		// even though compaction left the session safe.
		return residualTokens <= recoveryBand;
	}

	/**
	 * Retry-side counterpart to {@link #compactionCreatedHeadroom}. An
	 * overflow/incomplete recovery only needs the rebuilt prompt to *fit* the
	 * window again — it does not have to land under the compaction threshold, let
	 * alone the stricter `COMPACTION_RECOVERY_BAND × threshold` hysteresis the
	 * auto-continue thrash guard uses. Reusing the band here turned recoverable
	 * overflows into manual dead-ends: a 200k-window prompt compacted from
	 * overflow down to ~150k is comfortably retryable, but sits above
	 * `0.8 × 170k = 136k` and was wrongly refused (PR #3412 review).
	 *
	 * Measures residual context against the usable budget (`contextWindow - reserve`).
	 * The default absolute reserve can exceed bundled small-context windows, or
	 * nearly consume a 16k-class window; those known-impossible defaults fall
	 * back to the proportional 15% reserve. Explicit valid reserves still define
	 * the usable prompt budget so retries do not enter headroom the user
	 * intentionally reserved. Callers MUST
	 * invoke this AFTER dropping the failed assistant from `this.messages`, so
	 * the just-failed turn (which the retry prompt will not include) is excluded
	 * from the estimate.
	 *
	 * When the model/window is unknown we cannot evaluate the budget, so we
	 * optimistically allow the retry (preserving prior behavior).
	 */
	#compactionCreatedRetryFit(): boolean {
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const compactionSettings = this.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			this.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		const fitBudget = Math.max(0, contextWindow - resolveBudgetReserveTokens(contextWindow, compactionSettings));
		return residualTokens <= fitBudget;
	}

	/**
	 * Last-resort tiered reducer when {@link #runAutoCompaction} would otherwise
	 * dead-end. The summarizer cut at the only available turn boundary, but the
	 * kept tail is still over the recovery band because a single recent turn (a
	 * large tool-result, a heavy fenced/XML block, attached images) is itself
	 * bigger than the band and `findCutPoint` cannot cut inside one message.
	 *
	 * Tier 1 — `shake("elide")` reaches INSIDE that tail: heavy tool-result /
	 * block content is offloaded to one `artifact://` blob behind a recoverable
	 * placeholder. Skipped when this pass already ran a shake (`skipElide`).
	 * Tier 2 — `dropImages()`: the manual `/shake images` remedy, automated.
	 * Image blocks are stripped from the branch; unlike elided text they are NOT
	 * artifact-recoverable, so this tier only runs once elide has failed the
	 * progress re-test.
	 *
	 * Each tier that rewrote history re-anchors the in-flight context snapshot,
	 * then the caller's progress predicate is re-tested; the first tier that
	 * restores progress emits one info notice describing everything freed and
	 * stops. Returns whether progress was restored — `false` falls through to
	 * the dead-end warning.
	 */
	async #rescueCompactionDeadEnd(
		signal: AbortSignal,
		options: { skipElide: boolean; hasProgress: () => boolean },
	): Promise<boolean> {
		if (signal.aborted) return false;
		// Tier 0 — a snapcompact pass whose just-written frame archive is itself
		// the over-budget cost (each pass re-renders the carried-forward text
		// into MORE frames, so the archive grows past the recovery band and the
		// elide/image tiers below can never shrink it): rebuild the archive at
		// a threshold-derived frame budget.
		const frameRescue = await this.#rescueSnapcompactFrameOverflow(
			this.sessionManager.getBranch(),
			this.settings.getGroup("compaction"),
			signal,
		);
		if (frameRescue !== undefined && options.hasProgress()) return true;
		let elided = 0;
		let elidedTokens = 0;
		let elideSink = "placeholders";
		if (!options.skipElide) {
			try {
				const result = await this.shake("elide", { signal });
				elided = result.toolResultsDropped + result.blocksDropped;
				elidedTokens = result.tokensFreed;
				if (result.artifactId) elideSink = "an artifact";
				if (elided > 0) {
					// The elide pass rewrote history; re-anchor the in-flight snapshot
					// so the caller's headroom/retry-fit re-test measures the shaken
					// context.
					this.#rebasePendingContextSnapshotAfterCompaction();
				}
			} catch (error) {
				logger.warn("Dead-end shake rescue failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			if (elided > 0 && options.hasProgress()) {
				this.emitNotice(
					"info",
					`Compaction dead-end recovery: ${this.#describeElideRescue(elided, elidedTokens, elideSink)} so maintenance could make progress.`,
					"compaction",
				);
				return true;
			}
		}
		if (signal.aborted) return false;
		let imagesDropped = 0;
		try {
			imagesDropped = (await this.dropImages()).removed;
			if (imagesDropped > 0) this.#rebasePendingContextSnapshotAfterCompaction();
		} catch (error) {
			logger.warn("Dead-end image-drop rescue failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (imagesDropped > 0 && options.hasProgress()) {
			const elidedPart = elided > 0 ? `${this.#describeElideRescue(elided, elidedTokens, elideSink)} and ` : "";
			this.emitNotice(
				"info",
				`Compaction dead-end recovery: ${elidedPart}dropped ${imagesDropped} attached image${imagesDropped === 1 ? "" : "s"} so maintenance could make progress.`,
				"compaction",
			);
			return true;
		}
		return false;
	}

	/** Notice fragment for a dead-end elide tier: what was freed and where it went. */
	#describeElideRescue(elided: number, tokensFreed: number, sink: string): string {
		return `elided ${elided} heavy block${elided === 1 ? "" : "s"} (~${tokensFreed.toLocaleString()} tokens) to ${sink}`;
	}

	/**
	 * Frame budget for {@link #rescueSnapcompactFrameOverflow}: targets
	 * `COMPACTION_RECOVERY_BAND × threshold` (the same band
	 * {@link #compactionCreatedHeadroom} re-tests), not the window-fit budget
	 * {@link #computeSnapcompactMaxFrames} sizes against — a rebuilt archive
	 * must land back under the maintenance trigger, or the next settle
	 * re-enters the same dead-end. Cap reserve mirrors
	 * #computeSnapcompactMaxFrames (text edges + summary template), and
	 * `keptTailTokens` charges the kept entries AFTER the archive so the
	 * budget mirrors what #compactionCreatedHeadroom will actually measure.
	 * Returns 0 when not even one frame fits that budget — the rebuild could
	 * never create headroom, so the caller must not append it.
	 */
	#computeSnapcompactRescueMaxFrames(settings: CompactionSettings, keptTailTokens: number): number {
		const ctxWindow = this.model?.contextWindow ?? 0;
		if (ctxWindow <= 0) return Math.min(snapcompact.MAX_FRAMES_DEFAULT, snapcompact.maxFramesForDataBudget());
		const thresholdTokens = resolveThresholdTokens(ctxWindow, settings);
		const recoveryBandTokens = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
		const baseTokens = computeNonMessageTokens(this);
		const shape = snapcompact.resolveShape(this.model, this.settings.get("snapcompact.shape"));
		const edgeCap = snapcompact.geometry(shape).capacity;
		const textEdgeTokens = Math.ceil((2 * edgeCap * 1.15) / 4);
		const SUMMARY_TEMPLATE_TOKENS = 2000;
		const frameBudget = recoveryBandTokens - baseTokens - keptTailTokens - textEdgeTokens - SUMMARY_TEMPLATE_TOKENS;
		if (frameBudget < snapcompact.FRAME_TOKEN_ESTIMATE) return 0;
		// Same hard caps as #computeSnapcompactMaxFrames: a threshold-derived
		// count above the per-request payload budget would "shrink" a huge
		// archive to a frame count the rebuilt prompt can never attach anyway.
		return Math.min(
			Math.floor(frameBudget / snapcompact.FRAME_TOKEN_ESTIMATE),
			snapcompact.MAX_FRAMES_DEFAULT,
			snapcompact.maxFramesForDataBudget(),
		);
	}

	/**
	 * Dead-end rescue for a branch whose latest snapcompact CompactionEntry is
	 * itself billed past the maintenance threshold
	 * (`FRAME_TOKEN_ESTIMATE × frames`). Reaching the `!preparation` dead-end
	 * proves everything after that entry is already kept-recent (nothing to
	 * summarize), so the archive is the irreducible cost — and the elide/image
	 * tiers can never touch it: `collectShakeRegions` and `dropImages()` only
	 * inspect "message"/"custom_message" entries, so a `type: "compaction"`
	 * entry falls through both and the session re-warns on every resume (the
	 * shape issue #4786's rescue does not cover).
	 *
	 * Rebuilds the SAME archive locally — no LLM, no network — by re-running
	 * `snapcompact.compact()` over the entry's carried-forward source text at
	 * a maxFrames derived from the trigger threshold instead of the window:
	 * `planArchive` truncates the oldest chars to fit, so the rebuilt entry
	 * genuinely shrinks. The rebuilt entry keeps the stale entry's
	 * `firstKeptEntryId`, so the kept tail is untouched, and persisting
	 * through `appendCompaction()` lets the write-time superseded-compaction
	 * elision drop the stale frame payload from the JSONL automatically.
	 */
	async #rescueSnapcompactFrameOverflow(
		branchEntries: SessionEntry[],
		settings: CompactionSettings,
		signal: AbortSignal,
	): Promise<snapcompact.CompactionResult | undefined> {
		if (signal.aborted) return undefined;
		// Re-rendering frames needs a vision-capable model, same gate as the
		// snapcompact strategy path.
		if (!this.model?.input.includes("image")) return undefined;
		const staleEntry = getLatestCompactionEntry(branchEntries);
		if (!staleEntry) return undefined;
		// Only rescue when the archive is the actual source of the overflow.
		// The frame budget below charges every kept entry the rebuilt context
		// will still carry — the kept-recent region from `firstKeptEntryId`
		// (re-emitted before the archive by buildSessionContext) plus the
		// entries after the archive — on top of the fixed context, mirroring
		// what #compactionCreatedHeadroom will measure. When not even one
		// frame fits (e.g. a huge kept tool result dominates), rebuilding
		// would append the replacement compaction at the leaf — turning the
		// branch tail into a compaction entry, which prepareCompaction's
		// last-entry guard can never summarize past even after an elide
		// shrinks the real culprit. Bail and let the elide/image tiers handle
		// that tail instead.
		let keptTailTokens = 0;
		let inKeptRegion = false;
		for (const entry of branchEntries) {
			if (entry.id === staleEntry.firstKeptEntryId) inKeptRegion = true;
			if (entry.id === staleEntry.id) {
				// Everything after the archive is always kept.
				inKeptRegion = true;
				continue;
			}
			if (!inKeptRegion) continue;
			const message = (entry as { message?: AgentMessage }).message;
			if (message) keptTailTokens += estimateTokens(message);
		}
		const archive = snapcompact.getPreservedArchive(staleEntry.preserveData);
		if (!archive || archive.frames.length <= 1) return undefined;
		const archiveText = snapcompact.archiveSourceText(archive);
		if (!archiveText) return undefined;
		const maxFrames = this.#computeSnapcompactRescueMaxFrames(settings, keptTailTokens);
		if (maxFrames < 1 || maxFrames >= archive.frames.length) return undefined;

		const staleDetails = staleEntry.details as snapcompact.CompactionDetails | undefined;
		const fileOps = snapcompact.createFileOps();
		for (const file of staleDetails?.readFiles ?? []) fileOps.read.add(file);
		for (const file of staleDetails?.modifiedFiles ?? []) fileOps.edited.add(file);
		const shapeSetting = this.settings.get("snapcompact.shape");
		const shape = snapcompact.resolveShapeForText(archiveText, this.model, shapeSetting);
		let result: snapcompact.CompactionResult;
		try {
			result = await snapcompact.compact(
				{
					firstKeptEntryId: staleEntry.firstKeptEntryId,
					messagesToSummarize: [],
					turnPrefixMessages: [],
					tokensBefore: staleEntry.tokensBefore,
					previousSummary: staleEntry.summary,
					previousPreserveData: staleEntry.preserveData,
					fileOps,
				},
				{
					convertToLlm,
					model: this.model,
					...(shapeSetting === "auto" ? {} : { shape }),
					maxFrames,
				},
			);
		} catch (error) {
			logger.warn("Dead-end snapcompact frame rescue failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		if (signal.aborted) return undefined;
		const rebuilt = snapcompact.getPreservedArchive(result.preserveData);
		if (!rebuilt || rebuilt.frames.length >= archive.frames.length) return undefined;

		const rebuiltEntryId = this.sessionManager.appendCompaction(
			result.summary,
			result.shortSummary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			false,
			result.preserveData,
		);
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#rebasePendingContextSnapshotAfterCompaction();
		// Same post-rewrite bookkeeping as the regular compaction append: the
		// rebuilt context no longer carries the transient plan reference (#1246),
		// and advisor cursors / todo phases were derived from the replaced
		// history.
		this.#planReferenceSent = false;
		this.#advisors.resetAllRuntimes();
		this.#todo.syncFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		// Extensions must see the entry that is now active, not (only) the one
		// this rebuild just superseded — mirror the regular append path's hook.
		const rebuiltEntry = this.sessionManager.getEntries().find(e => e.id === rebuiltEntryId) as
			| CompactionEntry
			| undefined;
		if (this.#extensionRunner && rebuiltEntry) {
			await this.#extensionRunner.emit({
				type: "session_compact",
				compactionEntry: rebuiltEntry,
				fromExtension: false,
			});
		}
		this.emitNotice(
			"info",
			`Compaction dead-end recovery: rebuilt the trailing snapcompact archive at a smaller frame budget (${archive.frames.length} → ${rebuilt.frames.length} frames) so maintenance could make progress.`,
			"compaction",
		);
		return result;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 *
	 * @param allowDefer If true (default), threshold-driven handoff strategy is allowed to
	 *   schedule itself as a deferred post-prompt task and return a deferred-handoff result
	 *   immediately. The caller MUST treat that as "compaction will happen async — do not
	 *   also schedule `agent.continue()` for this turn", otherwise the deferred handoff
	 *   races a fresh streaming turn (the symptom: "Auto-handoff" loader + assistant
	 *   message still streaming). Callers on a path that is about to start a new agent
	 *   turn (e.g. the pre-prompt check in `#promptWithMessage`) pass `false` to force
	 *   inline execution so the handoff completes before the new turn begins.
	 * @returns whether auto-compaction scheduled a follow-up turn.
	 */
	async #runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		deferred = false,
		allowDefer = true,
		options: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			suppressContinuation?: boolean;
			suppressHandoff?: boolean;
			phase?: CodexCompactionContext["phase"];
			terminalTextAnswer?: boolean;
		} = {},
	): Promise<CompactionCheckResult> {
		const compactionSettings = this.settings.getGroup("compaction");
		const tailPruned = options.tailPruned === true;
		const noneResult = tailPruned ? COMPACTION_CHECK_NONE_TAIL_PRUNED : COMPACTION_CHECK_NONE;
		if (compactionSettings.strategy === "off") return noneResult;
		if (reason !== "idle" && !compactionSettings.enabled) return noneResult;
		const generation = this.#promptGeneration;
		const terminalTextAnswer =
			options.terminalTextAnswer ?? isTerminalTextAssistantAnswer(this.#findLastAssistantMessage());
		const suppressContinuation = options.suppressContinuation === true;
		const shouldAutoContinue =
			!suppressContinuation && options.autoContinue !== false && compactionSettings.autoContinue !== false;
		const suppressHandoff = options.suppressHandoff === true;
		let fallbackFromShake = false;
		// Shake runs inline (cheap, no remote LLM). On overflow recovery, if shake
		// reclaims nothing we fall through to the summary-compaction body below so
		// the oversized input still gets resolved.
		if (compactionSettings.strategy === "shake") {
			const outcome = await this.#runAutoShake(
				reason,
				willRetry,
				generation,
				shouldAutoContinue,
				terminalTextAnswer,
				options.triggerContextTokens,
				suppressContinuation,
				tailPruned,
			);
			if (outcome !== "fallback") return outcome;

			fallbackFromShake = true;
		}
		// "overflow" and "incomplete" force inline execution because they are recovery
		// paths the caller wants resolved before scheduling the next turn. "idle" is
		// triggered by the idle loop and does its own scheduling.
		if (
			!suppressHandoff &&
			!deferred &&
			allowDefer &&
			reason !== "overflow" &&
			reason !== "incomplete" &&
			reason !== "idle" &&
			compactionSettings.strategy === "handoff"
		) {
			this.#schedulePostPromptTask(
				async signal => {
					await Promise.resolve();
					if (signal.aborted) return;
					await this.#runAutoCompaction(reason, willRetry, true, true, {
						...options,
						terminalTextAnswer,
					});
				},
				{ generation },
			);
			return {
				...COMPACTION_CHECK_DEFERRED_HANDOFF,
				continuationScheduled: shouldAutoContinue,
			};
		}

		// "overflow" forces context-full because the input itself is broken — a handoff
		// LLM call would hit the same overflow. "incomplete" is an output-side problem,
		// so a handoff request on the existing context is still viable.
		let action: "context-full" | "handoff" | "snapcompact" =
			compactionSettings.strategy === "snapcompact"
				? "snapcompact"
				: compactionSettings.strategy === "handoff" && reason !== "overflow" && !suppressHandoff
					? "handoff"
					: "context-full";
		if (action === "snapcompact" && this.model && !this.model.input.includes("image")) {
			this.emitNotice(
				"warning",
				`snapcompact needs a vision-capable active model (${this.model.id} is text-only); using context-full auto-compaction instead.`,
				"compaction",
			);
			action = "context-full";
		}
		// Abort any older auto-compaction before installing this run's controller.
		this.#autoCompactionAbortController?.abort();
		const autoCompactionAbortController = new AbortController();
		this.#autoCompactionAbortController = autoCompactionAbortController;
		const autoCompactionSignal = autoCompactionAbortController.signal;

		try {
			// Emit start AFTER the controller is installed so isCompacting is already true
			// for any listener — and for input routed during this emit's event-loop yield:
			// a message typed as the compaction loader appears must land in the compaction
			// queue, not the core steering queue (which handoff's agent.reset() would wipe).
			await this.#emitSessionEvent({ type: "auto_compaction_start", reason, action });
			if (action === "handoff") {
				let handoffSwitchCancelled = false;
				const handoffFocus = AUTO_HANDOFF_THRESHOLD_FOCUS;
				const handoffResult = await this.handoff(handoffFocus, {
					autoTriggered: true,
					signal: autoCompactionSignal,
					onSwitchCancelled: () => {
						handoffSwitchCancelled = true;
					},
				});
				if (!handoffResult) {
					const aborted = autoCompactionSignal.aborted || handoffSwitchCancelled;
					if (aborted) {
						await this.#emitSessionEvent({
							type: "auto_compaction_end",
							action,
							result: undefined,
							aborted: true,
							willRetry: false,
						});
						return noneResult;
					}
					logger.warn("Auto-handoff returned no document; falling back to context-full maintenance", {
						reason,
					});
					action = "context-full";
				}
				if (handoffResult) {
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
					});
					const continuationScheduled =
						!autoCompactionSignal.aborted &&
						this.#scheduleCompactionContinuation({
							generation,
							autoContinue: reason !== "idle" && shouldAutoContinue,
							terminalTextAnswer,
							suppressContinuation,
						});
					return {
						...(continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_NONE),
						historyRewritten: true,
					};
				}
			}

			if (!this.model) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return noneResult;
			}

			const availableModels = this.#modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return noneResult;
			}

			const pathEntries = this.sessionManager.getBranch();

			let pathEntriesForCompaction = pathEntries;
			let preparation = prepareCompaction(pathEntriesForCompaction, compactionSettings, this.model);
			if (!preparation) {
				// prepareCompaction found nothing to summarize because the kept region
				// is a single oversized recent turn — findCutPoint never cuts inside a
				// tool result, so a huge tool-result / fenced block tail leaves nothing
				// on the summarizable side and summary compaction cannot even start.
				// That is exactly the dead-end the elide shake rescues: it reaches
				// INSIDE the tail and offloads heavy content to an artifact placeholder,
				// shrinking the tail so findCutPoint can then move the cut and leave
				// older turns to summarize. Run the same tiered rescue the
				// post-maintenance guard uses (elide, then image drop), with progress
				// defined as "prepareCompaction now succeeds on the rewritten branch",
				// and fall through to the normal compaction body when it does (writing
				// a compaction entry anchors the stale billed usage so the
				// auto-continue re-check cannot re-trip and loop the warning — issue
				// #4786). `skipElide` when we already fell through from a shake
				// strategy pass (it tried and found nothing); skip entirely on the
				// idle timer (it re-checks usage on its own cadence).
				let rescueRewroteHistory = false;
				// A snapcompact CompactionEntry is invisible to both rescue tiers
				// below (they only inspect message entries) and to prepareCompaction
				// itself (last-entry-is-compaction guard), so a frame archive billed
				// past the threshold dead-ends here on every resume. Rebuild it at a
				// threshold-derived frame budget first — but treat that as complete
				// only when it actually created headroom: the latest archive may not
				// be the oversized tail (e.g. a huge kept tool result after it), and
				// declaring victory on a mere frame-count shrink would skip the
				// elide/image tiers that can still reach that tail and suppress a
				// warning the user should see.
				let frameRescueResult: snapcompact.CompactionResult | undefined;
				let frameRescueCreatedHeadroom = false;
				if (reason !== "idle") {
					frameRescueResult = await this.#rescueSnapcompactFrameOverflow(
						pathEntriesForCompaction,
						compactionSettings,
						autoCompactionSignal,
					);
					if (frameRescueResult) {
						rescueRewroteHistory = true;
						pathEntriesForCompaction = this.sessionManager.getBranch();
						frameRescueCreatedHeadroom = this.#compactionCreatedHeadroom();
					}
					if (!frameRescueCreatedHeadroom) {
						await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
							skipElide: fallbackFromShake,
							hasProgress: () => {
								// Only reached when a tier actually freed something, so the
								// branch has been rewritten either way.
								rescueRewroteHistory = true;
								pathEntriesForCompaction = this.sessionManager.getBranch();
								preparation = prepareCompaction(pathEntriesForCompaction, compactionSettings, this.model);
								return preparation !== undefined;
							},
						});
					}
				}
				if (!preparation) {
					const noProgressDeadEnd = reason !== "idle" && !frameRescueCreatedHeadroom;
					const deadEndWarning = noProgressDeadEnd
						? compactionDeadEndWarning("shrink it (e.g. clear large tool output)")
						: undefined;
					// A rescue that appended a rebuilt archive without creating
					// headroom must carry the dead-end badge on the entry the
					// transcript actually shows (the rebuilt one), or the pause
					// loses its explanation once the notice scrolls away. Stamp it
					// BEFORE the auto_compaction_end event: a result-carrying event
					// makes the TUI rebuild the chat from the current entries
					// immediately, so a later stamp would not appear until some
					// unrelated rebuild.
					if (deadEndWarning && frameRescueResult) {
						const stampEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
						if (stampEntry) {
							stampEntry.warning = deadEndWarning;
							await this.sessionManager.rewriteEntries();
						}
					}
					// A successful frame rescue rewrote history and activated a new
					// compaction entry — surface it as a real (non-skipped) result so
					// the TUI rebuilds the transcript instead of treating the pass as
					// a benign no-op.
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: frameRescueResult,
						aborted: false,
						willRetry: false,
						skipped: frameRescueResult === undefined,
					});
					let continuationScheduled = false;
					if (frameRescueCreatedHeadroom) {
						continuationScheduled = this.#scheduleCompactionContinuation({
							generation,
							autoContinue: shouldAutoContinue,
							terminalTextAnswer,
							suppressContinuation,
						});
					} else if (!suppressContinuation && this.agent.hasQueuedMessages()) {
						this.#scheduleAgentContinue({
							delayMs: 100,
							generation,
							shouldContinue: () => this.agent.hasQueuedMessages(),
						});
						continuationScheduled = true;
					}
					if (deadEndWarning) {
						this.emitNotice("warning", deadEndWarning, "compaction");
					}
					// A rescue that offloaded content but still could not produce a
					// preparation rewrote the branch; flag it so the overflow-recovery
					// rollback does not re-restore the just-failed assistant turn on top
					// of the elided tail.
					const base = continuationScheduled
						? COMPACTION_CHECK_CONTINUATION
						: noProgressDeadEnd
							? COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION
							: noneResult;
					return rescueRewroteHistory ? { ...base, historyRewritten: true } : base;
				}
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;
			let codexCompaction: CodexCompactionContext | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const hookResult = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntriesForCompaction,
					customInstructions: undefined,
					signal: autoCompactionSignal,
				})) as SessionBeforeCompactResult | undefined;

				if (hookResult?.cancel) {
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return noneResult;
				}

				if (hookResult?.compaction) {
					hookCompaction = hookResult.compaction;
					fromExtension = true;
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			// Snapcompact runs locally first. The post-compaction context = kept-recent
			// + a summary message carrying the imaged archive at FRAME_TOKEN_ESTIMATE
			// per frame; #computeSnapcompactMaxFrames sizes the frame cap from the
			// live window so we don't run snapcompact just to overflow every threshold
			// tick. Any local blocker (unsupported snapcompact glyphs, kept-history too large,
			// post-render overflow) downgrades auto maintenance to a context-full LLM
			// summary instead of wedging the session (#3659) — auto runs the default
			// strategy on the user's behalf, so a fallback that lets the session keep
			// running is the right behavior. Manual `/compact snapcompact` keeps the
			// local-only contract (#3599): the user explicitly picked it.
			let snapcompactResult: snapcompact.CompactionResult | undefined;
			let snapcompactBlocker: string | undefined;
			if (action === "snapcompact" && compactionPrep.kind !== "fromHook") {
				// Drop `¶think:` sections for Anthropic-dialect targets: the archive
				// is replayed as text and Claude refuses reproduced reasoning
				// ("reasoning_extraction", issue #6093).
				const snapcompactIncludeThinking = preferredDialect(this.model.id) !== "anthropic";
				const text = snapcompact.serializeConversation(
					convertToLlm(preparation.messagesToSummarize.concat(preparation.turnPrefixMessages)),
					{ includeThinking: snapcompactIncludeThinking },
				);
				const probeText = snapcompact.renderabilityProbeText(
					text,
					preparation.previousPreserveData,
					preparation.previousSummary,
				);
				const shapeSetting = this.settings.get("snapcompact.shape");
				const shape = snapcompact.resolveShapeForText(probeText, this.model, shapeSetting);
				const renderScan = snapcompact.scanRenderability(probeText, { shape });
				if (!renderScan.isSafe) {
					const percent = (renderScan.unrenderableRatio * 100).toFixed(1);
					logger.warn("Snapcompact disabled: unsupported characters for selected snapcompact font", {
						model: this.model?.id,
						unrenderableRatio: renderScan.unrenderableRatio,
					});
					snapcompactBlocker = `snapcompact disabled: unsupported characters for selected snapcompact font (${percent}%); using context-full auto-compaction instead.`;
				} else {
					const maxFrames = this.#computeSnapcompactMaxFrames(preparation, compactionSettings);
					if (maxFrames < 1) {
						logger.warn("Snapcompact skipped: kept history alone exceeds the context budget", {
							model: this.model?.id,
						});
						snapcompactBlocker =
							"snapcompact: kept history alone exceeds the context budget; using context-full auto-compaction instead.";
					} else {
						snapcompactResult = await snapcompact.compact(preparation, {
							convertToLlm,
							model: this.model,
							...(shapeSetting === "auto" ? {} : { shape }),
							maxFrames,
							includeThinking: snapcompactIncludeThinking,
						});
						const framePayloadBytes = this.#snapcompactFramePayloadBytes(snapcompactResult);
						if (framePayloadBytes > snapcompact.FRAME_DATA_BYTES_BUDGET) {
							logger.warn("Snapcompact exceeded the per-request frame payload budget", {
								model: this.model?.id,
								framePayloadBytes,
								budget: snapcompact.FRAME_DATA_BYTES_BUDGET,
							});
							snapcompactBlocker =
								"snapcompact produced too much standing image payload; using context-full auto-compaction instead.";
							snapcompactResult = undefined;
						}
						if (snapcompactResult) {
							const ctxWindow = this.model?.contextWindow ?? 0;
							const budget =
								ctxWindow > 0
									? ctxWindow - effectiveReserveTokens(ctxWindow, compactionSettings)
									: Number.POSITIVE_INFINITY;
							const projected = this.#projectSnapcompactContextTokens(preparation, snapcompactResult);
							if (projected > budget) {
								logger.warn("Snapcompact still overflows the window after frame-budget sizing", {
									model: this.model?.id,
									projected,
									budget,
								});
								snapcompactBlocker =
									"snapcompact could not bring the context under the limit; using context-full auto-compaction instead.";
								snapcompactResult = undefined;
							}
						}
					}
				}
				if (snapcompactBlocker) {
					this.emitNotice("warning", snapcompactBlocker, "compaction");
					action = "context-full";
				}
			}

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else if (snapcompactResult) {
				summary = snapcompactResult.summary;
				shortSummary = snapcompactResult.shortSummary;
				firstKeptEntryId = snapcompactResult.firstKeptEntryId;
				tokensBefore = snapcompactResult.tokensBefore;
				details = snapcompactResult.details;
				preserveData = { ...(compactionPrep.preserveData ?? {}), ...(snapcompactResult.preserveData ?? {}) };
			} else {
				const candidates = this.#getCompactionModelCandidates(availableModels);
				const retrySettings = this.settings.getGroup("retry");
				const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId);
				let compactResult: CompactionResult | undefined;
				let lastError: unknown;
				codexCompaction = createCodexCompactionContext({
					trigger: "auto",
					reason: "context_limit",
					phase:
						options.phase ??
						(reason === "threshold" ? "pre_turn" : reason === "idle" ? "standalone_turn" : "mid_turn"),
				});

				for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
					const candidate = candidates[candidateIndex];
					const hasMoreCandidates = candidateIndex < candidates.length - 1;
					const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
					if (!apiKey) continue;

					let attempt = 0;
					while (true) {
						try {
							compactResult = await compact(
								this.#obfuscatePreparationForProvider(preparation),
								candidate,
								this.#modelRegistry.resolver(candidate, this.sessionId),
								undefined,
								autoCompactionSignal,
								{
									promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
									extraContext: compactionPrep.hookContext,
									remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
									metadata: this.agent.metadataForProvider(candidate.provider),
									initiatorOverride: "agent",
									convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
									telemetry,
									// Honor the user's /model thinking selection on the
									// auto-compaction path — the most-fired compaction
									// site. Clamped per-model inside compact() via
									// resolveCompactionEffort.
									thinkingLevel: this.thinkingLevel,
									tools: this.agent.state.tools,
									sessionId: this.sessionId,
									promptCacheKey: this.sessionId,
									providerSessionState: this.#providerSessionState,
									codexCompaction,
								},
							);
							break;
						} catch (error) {
							if (autoCompactionSignal.aborted) {
								throw error;
							}

							const message = error instanceof Error ? error.message : String(error);
							const id = AIError.classify(error, candidate.api);
							if (AIError.is(id, AIError.Flag.AuthFailed)) {
								lastError = this.#buildCompactionAuthError();
								break;
							}
							if (AIError.is(id, AIError.Flag.Timeout)) {
								logger.warn(
									hasMoreCandidates
										? "Auto-compaction summarization timed out, trying next model"
										: "Auto-compaction summarization timed out, not retrying same model",
									{
										error: message,
										model: `${candidate.provider}/${candidate.id}`,
									},
								);
								lastError = error;
								break;
							}

							const retryAfterMs = this.#parseRetryAfterMsFromError(message);
							const shouldRetry =
								retrySettings.enabled &&
								attempt < retrySettings.maxRetries &&
								(retryAfterMs !== undefined ||
									AIError.is(id, AIError.Flag.Transient) ||
									AIError.is(id, AIError.Flag.UsageLimit));
							if (!shouldRetry) {
								lastError = error;
								break;
							}

							const baseDelayMs = retrySettings.baseDelayMs * 2 ** attempt;
							const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs;

							// If retry delay is too long (>30s), try next candidate instead of waiting
							const maxAcceptableDelayMs = 30_000;
							if (delayMs > maxAcceptableDelayMs && hasMoreCandidates) {
								logger.warn("Auto-compaction retry delay too long, trying next model", {
									delayMs,
									retryAfterMs,
									error: message,
									model: `${candidate.provider}/${candidate.id}`,
								});
								lastError = error;
								break; // Exit retry loop, continue to next candidate
							}

							attempt++;
							logger.warn("Auto-compaction failed, retrying", {
								attempt,
								maxRetries: retrySettings.maxRetries,
								delayMs,
								retryAfterMs,
								error: message,
								model: `${candidate.provider}/${candidate.id}`,
							});
							await scheduler.wait(delayMs, { signal: autoCompactionSignal });
						}
					}

					if (compactResult) {
						break;
					}
				}

				if (!compactResult) {
					if (lastError) {
						throw lastError;
					}
					throw new Error("Compaction failed: no available model");
				}

				summary = compactResult.summary;
				shortSummary = compactResult.shortSummary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
				preserveData = mergeLlmCompactionPreserveData(compactionPrep.preserveData, compactResult.preserveData);
			}

			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return noneResult;
			}

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#rebasePendingContextSnapshotAfterCompaction();
			// Compaction discarded the conversation history that carried the approved
			// plan reference. Clear the sent-flag so #buildPlanReferenceMessage re-reads
			// the plan from disk and re-injects it on the next turn (issue #1246).
			this.#planReferenceSent = false;
			this.#advisors.resetAllRuntimes();
			this.#todo.syncFromBranch();
			if (codexCompaction) {
				this.#resetCodexProviderAfterCompaction(codexCompaction);
			} else {
				this.#closeCodexProviderSessionsForHistoryRewrite();
			}

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const result: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			// Post-maintenance progress guard — evaluated BEFORE emitting
			// auto_compaction_end so the TUI rebuild triggered by that event
			// already reflects any rescue rewrite (elide / image-drop) and the
			// dead-end warning stamped on the compaction entry. Snapcompact can
			// project over budget and fall back to a context-full summary; the
			// summarizer keeps `keepRecentTokens` of recent history verbatim and
			// findCutPoint can only cut at turn boundaries (never tool results),
			// so a single oversized recent turn (e.g. a huge tool result) leaves
			// the rewritten context still above threshold. Scheduling the
			// continuation regardless means the next agent_end re-enters
			// #checkCompaction over the same oversized tail and re-fires forever.
			// The retry and the threshold auto-continue use different progress
			// tests (a recoverable overflow only has to fit; the auto-continue
			// thrash needs the stricter recovery band), so each branch evaluates
			// its own below.
			let continuationScheduled = false;
			// A non-idle pass that wanted to continue (retry or auto-continue) but freed
			// too little for that path to proceed is a dead-end: warn once so the user
			// understands why maintenance paused instead of silently looping.
			let noProgressDeadEnd = false;
			let retryFits = false;
			let hasHeadroom = false;

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const lastAssistant = lastMsg as AssistantMessage;
					// Drop the prior turn before retry when it carries no actionable deliverable:
					// - "error": failure was kept in history but must not re-enter the next turn's prompt.
					// - reason === "incomplete" && stopReason === "length": truncated output (typically
					//   reasoning-only) — re-running it produces the same dead-end.
					const shouldDrop =
						lastAssistant.stopReason === "error" ||
						(reason === "incomplete" && lastAssistant.stopReason === "length");
					if (shouldDrop) {
						this.agent.replaceMessages(messages.slice(0, -1));
						this.#rebasePendingContextSnapshotAfterCompaction();
					}
				}

				// Retry only needs the rebuilt prompt to fit the window again — measured
				// AFTER the drop above so the just-failed turn (which the retry prompt
				// won't include) is excluded. Reusing the auto-continue recovery band
				// here turned recoverable overflows into manual dead-ends (#3412 review),
				// so use the looser fit budget.
				retryFits = this.#compactionCreatedRetryFit();
				if (!retryFits) {
					retryFits = await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
						skipElide: fallbackFromShake,
						hasProgress: () => this.#compactionCreatedRetryFit(),
					});
				}
				if (!retryFits) {
					noProgressDeadEnd = true;
				}
			} else if (reason !== "idle") {
				// Mirror the shake recovery-band check: only auto-continue when compaction
				// landed residual context under `COMPACTION_RECOVERY_BAND × threshold`.
				// Re-firing on a history that still sits just over the line is the
				// snapcompact thrash, so require genuine headroom, not a bare fit. Even
				// when auto-continue is disabled, a no-headroom threshold pass must still
				// block later automatic continuations (todo reminders/session_stop hooks)
				// from re-entering the same oversized context.
				hasHeadroom = this.#compactionCreatedHeadroom();
				if (!hasHeadroom) {
					hasHeadroom = await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
						skipElide: fallbackFromShake,
						hasProgress: () => this.#compactionCreatedHeadroom(),
					});
				}
				if (!hasHeadroom) {
					noProgressDeadEnd = true;
				}
			}

			const deadEndWarning = noProgressDeadEnd ? compactionDeadEndWarning("clear large tool output") : undefined;
			if (deadEndWarning) {
				// Stamp the divider: the compaction bar badges the dead-end and
				// carries the full warning in its ctrl+o detail, so the pause
				// stays explained even after the notice row scrolls away. Stamp
				// the branch's LATEST compaction entry — a frame rescue may have
				// superseded `savedCompactionEntry` with a rebuilt one, and the
				// collapsed transcript badges only the active entry.
				const stampEntry = getLatestCompactionEntry(this.sessionManager.getBranch()) ?? savedCompactionEntry;
				if (stampEntry) {
					stampEntry.warning = deadEndWarning;
					await this.sessionManager.rewriteEntries();
				}
			}

			await this.#emitSessionEvent({ type: "auto_compaction_end", action, result, aborted: false, willRetry });

			if (retryFits) {
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				continuationScheduled = true;
			} else {
				continuationScheduled = this.#scheduleCompactionContinuation({
					generation,
					autoContinue: hasHeadroom && shouldAutoContinue,
					terminalTextAnswer,
					suppressContinuation,
				});
			}

			if (deadEndWarning) {
				this.emitNotice("warning", deadEndWarning, "compaction");
			}
			if (continuationScheduled) return COMPACTION_CHECK_CONTINUATION;
			return noProgressDeadEnd ? COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION : COMPACTION_CHECK_NONE;
		} catch (error) {
			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return noneResult;
			}
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: reason === "incomplete"
							? `Incomplete response recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			if (this.#autoCompactionAbortController === autoCompactionAbortController) {
				this.#autoCompactionAbortController = undefined;
			}
		}
		return noneResult;
	}

	/**
	 * Run a shake-strategy auto-maintenance pass. Emits the
	 * `auto_compaction_start`/`auto_compaction_end` pair with a shake `action`,
	 * runs {@link shake} inline against the protect-window config, and schedules
	 * continuation exactly like the context-full tail.
	 *
	 * Returns `"fallback"` only for an overflow recovery where shake reclaimed
	 * nothing (or threw) — the caller then runs the summary-compaction body so
	 * the oversized input still gets resolved. Returns `"handled"` otherwise.
	 */
	async #runAutoShake(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		generation: number,
		autoContinue: boolean,
		terminalTextAnswer: boolean,
		triggerContextTokens?: number,
		suppressContinuation = false,
		tailPruned = false,
	): Promise<CompactionCheckResult | "fallback"> {
		const action = "shake";
		this.#autoCompactionAbortController?.abort();
		const controller = new AbortController();
		this.#autoCompactionAbortController = controller;
		const signal = controller.signal;
		const noneResult = tailPruned ? COMPACTION_CHECK_NONE_TAIL_PRUNED : COMPACTION_CHECK_NONE;
		try {
			await this.#emitSessionEvent({ type: "auto_compaction_start", reason, action });
			const result = await this.shake("elide", { config: DEFAULT_SHAKE_CONFIG, signal });
			if (signal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return noneResult;
			}
			const reclaimed = result.toolResultsDropped + result.blocksDropped > 0;
			// Detect the dead-loop reported in issues #2119/#2275: the threshold check
			// fires, shake runs, but residual context is still above the configured
			// threshold. The next agent_end would re-trigger shake, which has nothing
			// new to drop on the second pass, so the loop spins until the user kills it.
			// Same hazard for "incomplete" (the retry would re-hit the length cap) and
			// for the existing "overflow + nothing reclaimed" case. In every recovery
			// reason we hand off to the summarization-driven context-full path so the
			// situation actually resolves; "idle" is exempt because its 60s+ timer
			// re-checks usage before re-firing and cannot dead-loop on its own.
			//
			// #2275: the post-shake check MUST stay provider-anchored when caller
			// usage and local estimates diverge. The local estimator undercounts
			// thinking-signature payloads, so thinking-heavy sessions can read well
			// below the provider usage that fired the threshold. Prefer the caller's
			// context figure when supplied, then subtract shake's own savings and add
			// hysteresis (80% recovery band) so we don't oscillate at the boundary.
			// Threshold callers pass the provider-billed trigger after accounting for
			// any supersede/drop-useless pruning that already rewrote the next prompt;
			// without that pre-shake savings, shake can fall through to context-full
			// even though the post-prune history is already inside the recovery band.
			const contextWindow = this.model?.contextWindow ?? 0;
			const compactionSettings = this.settings.getGroup("compaction");
			let stillOverThreshold = false;
			if (contextWindow > 0) {
				if (typeof triggerContextTokens === "number" && Number.isFinite(triggerContextTokens)) {
					const correctedTokens = Math.max(0, triggerContextTokens - result.tokensFreed);
					const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
					const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
					stillOverThreshold = correctedTokens > recoveryBand;
				} else {
					const postShakeTokens = this.getContextUsage({ contextWindow })?.tokens ?? 0;
					stillOverThreshold = shouldCompact(postShakeTokens, contextWindow, compactionSettings);
				}
			}
			const shouldFallBack = reason !== "idle" && ((reason === "overflow" && !reclaimed) || stillOverThreshold);
			if (shouldFallBack) {
				const errorMessage = reclaimed
					? `Auto-shake reclaimed ~${result.tokensFreed} tokens but context is still above the threshold; falling back to context-full compaction.`
					: "Auto-shake found nothing eligible to drop; falling back to context-full compaction.";
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: !reclaimed,
					errorMessage,
				});
				return "fallback";
			}
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry,
				skipped: !reclaimed,
			});

			let continuationScheduled = false;
			if (willRetry) {
				// The shake rebuild replays every entry, so a trailing error/length
				// assistant from the failed turn re-enters agent state — drop it before
				// retrying, same as the context-full tail.
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const lastAssistant = lastMsg as AssistantMessage;
					const shouldDrop =
						lastAssistant.stopReason === "error" ||
						(reason === "incomplete" && lastAssistant.stopReason === "length");
					if (shouldDrop) this.agent.replaceMessages(messages.slice(0, -1));
				}
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				continuationScheduled = true;
			} else {
				continuationScheduled = this.#scheduleCompactionContinuation({
					generation,
					autoContinue: reason !== "idle" && autoContinue,
					terminalTextAnswer,
					suppressContinuation,
				});
			}
			if (!reclaimed) {
				return willRetry && continuationScheduled
					? { ...COMPACTION_CHECK_CONTINUATION, historyRewritten: true }
					: continuationScheduled
						? COMPACTION_CHECK_CONTINUATION
						: noneResult;
			}
			return {
				...(continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_NONE),
				historyRewritten: true,
			};
		} catch (error) {
			if (signal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return noneResult;
			}
			const message = error instanceof Error ? error.message : "shake failed";
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage: message,
				skipped: false,
			});
			// Overflow still needs recovery even if shake threw.
			return reason === "overflow" ? "fallback" : noneResult;
		} finally {
			if (this.#autoCompactionAbortController === controller) {
				this.#autoCompactionAbortController = undefined;
			}
		}
	}

	/**
	 * Periodic tool-output pruning (shake) every N tool calls, independent of the
	 * compaction strategy. The counter is incremented per tool call via the
	 * afterToolCall hook; this method fires shake("elide") when the counter
	 * reaches the configured interval during the agent_end handler.
	 *
	 * Setting `shake.interval` to 0 (default) or a non-positive number disables.
	 */
	async #runPeriodicShake(): Promise<void> {
		const interval = this.settings.get("shake.interval") as number;
		if (!Number.isFinite(interval) || interval <= 0) {
			this.#shakeToolCallCounter = 0;
			return;
		}
		if (this.#shakeToolCallCounter < interval && !this.#shakeNeedsAgentSync) return;

		if (this.isCompacting || this.agent.state.isStreaming) return;

		// At interval and not blocked — fire and reset
		this.#shakeToolCallCounter = 0;
		logger.debug("Periodic shake firing", {
			interval,
			wasCompacting: this.isCompacting,
			wasStreaming: this.agent.state.isStreaming,
		});
		try {
			const wasSync = this.#shakeNeedsAgentSync;
			this.#shakeNeedsAgentSync = false;
			const result = await this.shake("elide", { config: DEFAULT_SHAKE_CONFIG });
			// When shake was triggered by a pending mid-run sync (#shakeNeedsAgentSync),
			// explicitly rebuild agent.state even if shake found no new regions. The
			// mid-run pass (skipAgentUpdate:true) already rewrote persisted entries, so
			// agent.state.messages may still carry unshaken tool output.
			if (wasSync && result.blocksDropped === 0 && result.tokensFreed === 0) {
				const sessionContext = this.buildDisplaySessionContext();
				this.agent.replaceMessages(sessionContext.messages);
				for (const a of this.#advisors) a.runtime.reset();
				this.#closeCodexProviderSessionsForHistoryRewrite();
			}
			if (result.blocksDropped > 0 || result.tokensFreed > 0) {
				this.emitNotice("info", formatShakeSummary(result), "shake");
			}
		} catch (error) {
			logger.warn("Periodic shake failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Mid-run periodic shake, fired from afterToolCall during an autonomous
	 * agent loop. Prunes session entries with skipAgentUpdate:true to avoid
	 * mutating agent.state.messages while the loop holds a reference to it.
	 * The pruned session takes effect on the next run/continue; the current
	 * loop continues safely with its original message reference.
	 */
	async #runMidRunShake(): Promise<void> {
		// Guard against concurrent entry from parallel tool calls
		if (this.#midRunShakeRunning) return;
		this.#midRunShakeRunning = true;
		try {
			this.#shakeToolCallCounter = 0;
			// Wait for all pending message_end persistence to complete so
			// shake() sees the tool result that crossed the interval in the
			// session branch.
			await this.#messageEndPersistenceTail;
			const result = await this.shake("elide", {
				config: DEFAULT_SHAKE_CONFIG,
				skipAgentUpdate: true,
			});
			this.emitNotice("info", formatShakeSummary(result), "shake");
			this.#shakeNeedsAgentSync = true;
		} catch (error) {
			logger.warn("Mid-run shake failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.#midRunShakeRunning = false;
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/** Cancel an in-progress retry. */
	abortRetry(): void {
		this.#recovery.abortRetry();
	}

	/** Whether auto-retry is currently in progress. */
	get isRetrying(): boolean {
		return this.#recovery.isRetrying;
	}

	/** Whether auto-retry is enabled. */
	get autoRetryEnabled(): boolean {
		return this.#recovery.autoRetryEnabled;
	}

	/** Toggle the auto-retry setting. */
	setAutoRetryEnabled(enabled: boolean): void {
		this.#recovery.setAutoRetryEnabled(enabled);
	}

	/** Retry the last failed assistant turn when the session is idle. */
	retry(): Promise<boolean> {
		return this.#recovery.retry();
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command and retain the session/branch that owned its start.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.useUserShell If true, allow caller to request configured user-shell routing
	 */
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean },
	): Promise<BashResult> {
		return this.#bash.executeBash(command, onChunk, options);
	}

	/** Record a bash result supplied outside executeBash in the current ownership scope. */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this.#bash.recordBashResult(command, result, options);
	}

	/** Cancel running bash commands. */
	abortBash(): void {
		this.#bash.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this.#bash.isRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this.#bash.hasPendingMessages;
	}

	// =========================================================================
	// User-Initiated Python Execution
	// =========================================================================

	/**
	 * Execute Python code in the shared kernel.
	 * Uses the same kernel session as eval's Python backend, allowing collaborative editing.
	 * @param code The Python code to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, execution won't be sent to LLM ($$ prefix)
	 */
	executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		return this.#eval.executePython(code, onChunk, options);
	}

	assertEvalExecutionAllowed(): void {
		this.#eval.assertExecutionAllowed();
	}

	/**
	 * Track Python work started outside AgentSession.executePython so dispose can await and abort it too.
	 */
	trackEvalExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		return this.#eval.trackExecution(execution, abortController);
	}

	/**
	 * Record a Python execution result in session history.
	 */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		this.#eval.recordPythonResult(code, result, options);
	}

	/**
	 * Cancel running Python execution.
	 */
	abortEval(): void {
		this.#eval.abort();
	}

	/** Whether a Python execution is currently running */
	get isEvalRunning(): boolean {
		return this.#eval.isRunning;
	}

	/** Whether there are pending Python messages waiting to be flushed */
	get hasPendingPythonMessages(): boolean {
		return this.#eval.hasPendingMessages;
	}

	/**
	 * Flush pending Python messages to agent state and session.
	 */

	// =========================================================================
	// IRC Delivery
	// =========================================================================

	/** Surfaces and consumes pending IRC records before automatic injection. */
	drainPendingIrcInboxMessages(agentId: string, opts?: { from?: string; limit?: number }): IrcMessage[] {
		return this.#irc.drainInboxMessages(agentId, opts);
	}

	/** Delivers an IRC message into this recipient session. */
	deliverIrcMessage(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		return this.#irc.deliver(msg, opts);
	}

	/** Emits an IRC relay observation for UI rendering without persisting it. */
	emitIrcRelayObservation(record: CustomMessage): void {
		this.#irc.emitRelayObservation(record);
	}

	/**
	 * Run a single ephemeral side-channel turn against this session's current
	 * model + system prompt + history. The main turn's tool catalog is sent
	 * to preserve the prompt cache, but the model is reminded not to call
	 * tools and any tool calls are discarded. The side request
	 * does not block on, or interfere with, any in-flight main turn. The
	 * session's history and persisted state are NOT modified by this call.
	 *
	 * Used by `BtwController` (`/btw`) and `OmfgController` (`/omfg`) to share
	 * the snapshot + stream pipeline. The snapshot includes any in-flight
	 * streaming assistant text so the model sees the half-finished response
	 * rather than missing context.
	 */
	async runEphemeralTurn(args: {
		promptText: string;
		onTextDelta?: (delta: string) => void;
		signal?: AbortSignal;
		dedupeReply?: boolean;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage }> {
		const model = this.model;
		if (!model) {
			throw new Error("No active model on session");
		}
		const cacheSessionId = this.sessionId;
		const snapshot = this.#buildEphemeralSnapshot(args.promptText);
		const llmMessages = await this.convertMessagesToLlm(snapshot, args.signal);
		const context = await this.agent.buildSideRequestContext(llmMessages);
		const options = this.prepareSimpleStreamOptions(
			{
				apiKey: this.#modelRegistry.resolver(model, cacheSessionId),
				// Side-channel turns must not share OpenAI/Codex append-only
				// conversation state with the main agent turn: IRC and /btw can run
				// while the main turn is mid-tool-call. Keep the prompt-cache key
				// stable, but give provider routing a unique request lineage. The
				// shared provider state map is still required so Codex can allocate
				// websocket state under that side-channel session id.
				sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
				promptCacheKey: cacheSessionId,
				preferWebsockets: this.#preferWebsockets,
				providerSessionState: this.#providerSessionState,
				reasoning: toReasoningEffort(this.thinkingLevel),
				disableReasoning: shouldDisableReasoning(this.thinkingLevel),
				hideThinkingSummary: this.agent.hideThinkingSummary,
				serviceTier: this.#models.effectiveServiceTier(model),
				signal: args.signal,
			},
			model.provider,
		);

		let providerReplyText = "";
		let emittedReplyText = "";
		let assistantMessage: AssistantMessage | undefined;
		const stream = await this.#sideStreamFn(model, obfuscateProviderContext(this.#obfuscator, context), options);
		for await (const event of stream) {
			if (event.type === "text_delta") {
				providerReplyText += event.delta;
				if (args.onTextDelta) {
					const readyText = this.#deobfuscatedProviderTextReadyForDelta(providerReplyText);
					if (readyText.length > emittedReplyText.length) {
						const delta = readyText.slice(emittedReplyText.length);
						emittedReplyText = readyText;
						args.onTextDelta(delta);
					}
				}
				continue;
			}
			if (event.type === "done") {
				// A well-formed provider "done" event carries `content: AssistantContentBlock[]`,
				// but a proxy/wrapper (custom extension providers, gateway-wrapped OAuth streams,
				// see #4323) can hand back a message whose `content` was dropped or replaced with
				// `undefined`. Downstream `.content.filter` at the sanitize step below would then
				// crash the recap turn with `TypeError: undefined is not an object (evaluating
				// 'H.content.filter')`. Normalize to `[]` so the recap surfaces an empty reply
				// instead of turning a malformed side-channel response into a session-mute crash.
				const rawContent = Array.isArray(event.message.content) ? event.message.content : [];
				assistantMessage = this.#obfuscator?.hasSecrets()
					? { ...event.message, content: deobfuscateAssistantContent(this.#obfuscator, rawContent) }
					: { ...event.message, content: rawContent };
				break;
			}
			if (event.type === "error") {
				throw new Error(event.error.errorMessage || "Ephemeral turn failed");
			}
		}

		if (!assistantMessage) {
			throw new Error("Ephemeral turn ended without a final message");
		}
		const replyText = this.#deobfuscateFromProvider(providerReplyText);
		if (args.onTextDelta && replyText.length > emittedReplyText.length) {
			args.onTextDelta(replyText.slice(emittedReplyText.length));
		}
		const sanitizedMessage: AssistantMessage = {
			...assistantMessage,
			content: assistantMessage.content.filter(block => block.type !== "toolCall"),
		};
		return {
			replyText: args.dedupeReply === false ? replyText.trim() : dedupeEphemeralReply(replyText.trim()),
			assistantMessage: sanitizedMessage,
		};
	}

	/**
	 * Build a message snapshot for an ephemeral side-channel turn.  Includes
	 * the in-flight streaming assistant message (if any) so the model sees
	 * the partial response in context, then appends the prompt as a virtual
	 * user message.
	 */
	#buildEphemeralSnapshot(promptText: string): AgentMessage[] {
		const messages = [...this.messages];
		const streaming = this.agent.state.streamMessage;
		if (streaming && streaming.role === "assistant" && Array.isArray(streaming.content)) {
			const preservedBlocks: AssistantMessage["content"] = [];
			// Preserve thinking blocks: DeepSeek-class encoders replay them as
			// `reasoning_content` and reject the request (HTTP 400) when the field
			// goes missing on a turn that previously emitted thinking.
			for (const c of streaming.content) {
				if (c.type === "thinking") preservedBlocks.push(c);
			}
			const streamingText = streaming.content
				.filter((c): c is TextContent => c.type === "text")
				.map(c => c.text)
				.join("");
			if (streamingText) {
				preservedBlocks.push({ type: "text", text: streamingText });
			}
			if (preservedBlocks.length > 0) {
				const normalized: AssistantMessage = {
					...streaming,
					content: preservedBlocks,
				};
				const lastMessage = messages.at(-1);
				if (lastMessage?.role === "assistant") {
					messages[messages.length - 1] = normalized;
				} else {
					messages.push(normalized);
				}
			}
		}
		messages.push({
			role: "developer",
			content: [{ type: "text", text: sideChannelNoToolsReminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		messages.push({
			role: "user",
			content: [{ type: "text", text: promptText }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		return messages;
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Reload the current session from disk.
	 *
	 * Intended for extension commands and headless modes to re-read the current session
	 * file and re-emit session_switch hooks.
	 */
	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		await this.switchSession(sessionFile);
	}

	/**
	 * Switch to a different session file.
	 * Aborts current operation, loads messages, restores model/thinking.
	 * Listeners are preserved and will continue receiving events.
	 * @returns true if switch completed, false if cancelled by hook
	 */
	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();
		const switchingToDifferentSession = previousSessionFile
			? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
			: true;
		// Emit session_before_switch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort({ goalReason: "internal" });
		await this.#sessionBeforeSwitchReconciler?.();

		await this.#bash.flushPending();
		// Flush pending writes before switching so restore snapshots reflect committed state.
		await this.sessionManager.flush();
		const previousSessionState = this.sessionManager.captureState();
		const bashTransition = this.#bash.beginSessionTransition();
		// Only same-session reloads compare against the prior context to detect
		// rollback edits (`#didSessionMessagesChange` below). Building it for a
		// different-session switch is a pure waste — and on huge pre-fix sessions
		// it materializes every persisted snapcompact frame plus the
		// `openaiRemoteCompaction.replacementHistory` payload into messages,
		// blowing the heap before the new session even loads (issue #3846). The
		// error-recovery path rebuilds the context on demand from the restored
		// state instead.
		const previousSessionContext = switchingToDifferentSession ? undefined : this.buildDisplaySessionContext();
		// switchSession replaces these arrays wholesale during load/rollback, so retaining
		// the existing message objects is sufficient and avoids structured-clone failures for
		// extension/custom metadata that is valid to persist but not cloneable.
		const previousAgentMessages = [...this.agent.state.messages];
		const previousSteeringMessages = [...this.agent.peekSteeringQueue()];
		const previousFollowUpMessages = [...this.agent.peekFollowUpQueue()];
		const previousPendingNextTurnMessages = [...this.#pendingNextTurnMessages];
		const previousScheduledHiddenNextTurnGeneration = this.#scheduledHiddenNextTurnGeneration;
		const previousModel = this.model;
		const previousThinkingLevel = this.thinkingLevel;
		const previousAutoThinking = this.isAutoThinking;
		const previousAutoResolvedLevel = this.autoResolvedThinkingLevel();
		const previousServiceTierByFamily = this.serviceTierByFamily;
		const previousTools = [...this.agent.state.tools];
		const previousBaseSystemPrompt = this.#tools.baseSystemPrompt;
		const previousSystemPrompt = this.agent.state.systemPrompt;
		const previousBaseSystemPromptBeforeMemoryPromotion = this.#memory.promotionSnapshot;
		const previousFreshProviderSessionId = this.#freshProviderSessionId;
		const previousInheritedProviderPromptCacheKey = this.#inheritedProviderPromptCacheKey;

		// Snapshot the full checkpoint runtime state: the success path calls
		// #rehydrateCheckpointRewindState(), which clears and rebuilds all four
		// fields from the target branch. On rollback every one must be restored,
		// or a failed switch leaks the target session's checkpoint state.
		const previousCheckpointState = this.#checkpointState;
		const previousPendingRewindReport = this.#pendingRewindReport;
		const previousLastCompletedRewind = this.#lastCompletedRewind;
		const previousRewoundToolResultIds = new Set(this.#rewoundToolResultIds);

		this.agent.clearAllQueues();
		this.#pendingNextTurnMessages = [];
		this.#shakeToolCallCounter = 0;
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.#shakeToolCallCounter = 0;

		try {
			await this.sessionManager.setSessionFile(sessionPath);
			this.#bash.markSessionTransition(bashTransition);
			if (switchingToDifferentSession) {
				this.#freshProviderSessionId = undefined;
				this.#clearInheritedProviderPromptCacheKey();
				this.#adoptInheritedProviderPromptCacheKey();
			}
			this.#syncAgentSessionId();
			this.#memory.rekeyForCurrentSessionId();

			let sessionContext = this.buildDisplaySessionContext();
			const didReloadConversationChange =
				previousSessionContext !== undefined &&
				didSessionMessagesChange(previousSessionContext.messages, sessionContext.messages);
			this.#rehydrateCheckpointRewindState();

			// Emit session_switch event to hooks
			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "resume",
					previousSessionFile,
				});
			}

			this.agent.replaceMessages(sessionContext.messages);
			this.#advisors.resetSessionState();
			this.#todo.syncFromBranch();
			if (switchingToDifferentSession) {
				this.#closeAllProviderSessions("session switch");
			} else if (didReloadConversationChange) {
				this.#closeAllProviderSessions("session reload");
			}

			// Restore model if saved
			const targetModelStrings = getRestorableSessionModels(
				sessionContext.models,
				this.sessionManager.getLastModelChangeRole(),
			);
			if (targetModelStrings.length > 0) {
				const availableModels = this.#modelRegistry.getAvailable();
				let match: Model | undefined;
				for (const targetModelStr of targetModelStrings) {
					const slashIdx = targetModelStr.indexOf("/");
					if (slashIdx <= 0) continue;
					const provider = targetModelStr.slice(0, slashIdx);
					const modelId = targetModelStr.slice(slashIdx + 1);
					match = availableModels.find(m => m.provider === provider && m.id === modelId);
					if (match) break;
				}
				if (match) {
					const currentModel = this.model;
					const shouldResetProviderState =
						switchingToDifferentSession ||
						(currentModel !== undefined &&
							(currentModel.provider !== match.provider ||
								currentModel.id !== match.id ||
								currentModel.api !== match.api));
					if (shouldResetProviderState) {
						this.#setModelWithProviderSessionReset(match);
					} else {
						this.agent.setModel(match);
					}
				}
			}

			const model = this.model;
			if (model) {
				const interruptedTurnAbort = createInterruptedTurnAbortMessage(this.sessionManager.getBranch(), {
					api: model.api,
					provider: model.provider,
					model: model.id,
				});
				if (interruptedTurnAbort) {
					this.sessionManager.appendMessage(interruptedTurnAbort);
					sessionContext = this.buildDisplaySessionContext();
					this.agent.replaceMessages(sessionContext.messages);
				}
			}

			const hasThinkingEntry = this.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change");
			const hasServiceTierEntry = this.sessionManager
				.getBranch()
				.some(entry => entry.type === "service_tier_change");
			const defaultThinkingLevel = parseConfiguredThinkingLevel(this.settings.get("defaultThinkingLevel"));
			const configuredServiceTierByFamily = buildServiceTierByFamily(
				this.settings.get("tier.openai"),
				this.settings.get("tier.anthropic"),
				this.settings.get("tier.google"),
			);
			// Restore the thinking selector. Each change persists the configured
			// selector (`auto` or a concrete level), so prefer it: an `auto` session
			// resumes in auto mode (reclassifying the next turn) instead of freezing at
			// the last resolved level. Entries written before the `configured` field
			// existed fall back to the concrete level (legacy pin-on-resume behavior).
			// With no thinking entry, fall back to the global default so fresh sessions
			// still classify their first turn.
			const restoredConfigured = sessionContext.configuredThinkingLevel;
			const restoredThinkingLevel: ConfiguredThinkingLevel | undefined =
				hasThinkingEntry || (defaultThinkingLevel === AUTO_THINKING && sessionContext.thinkingLevel !== "off")
					? restoredConfigured === AUTO_THINKING
						? AUTO_THINKING
						: (sessionContext.thinkingLevel as ThinkingLevel | undefined)
					: defaultThinkingLevel;
			this.#models.restoreThinkingLevel(restoredThinkingLevel);
			this.#models.restoreServiceTiers(
				hasServiceTierEntry ? (sessionContext.serviceTier ?? {}) : configuredServiceTierByFamily,
			);

			if (switchingToDifferentSession) {
				await this.#memory.resetContextForNewTranscript();
			}
			if (switchingToDifferentSession) {
				this.#clearSessionScopedToolState();
			}
			this.#reconnectToAgent();
			try {
				await this.#sessionSwitchReconciler?.();
			} catch (error) {
				logger.warn("Failed to reconcile session mode after switch", {
					targetSessionFile: sessionPath,
					error: String(error),
				});
			}
			// Refresh the workspace-roots block to match the resumed session's directory set.
			// Wrapped so a rebuild failure (e.g. a gate that intentionally fails in tests)
			// doesn't roll back an otherwise-successful session switch.
			try {
				await this.refreshBaseSystemPrompt();
			} catch (refreshErr) {
				logger.warn("Failed to refresh system prompt after session switch", {
					targetSessionFile: sessionPath,
					error: String(refreshErr),
				});
			}
			this.#bash.finishSessionTransition(bashTransition, true);
			return true;
		} catch (error) {
			this.sessionManager.restoreState(previousSessionState);
			this.#freshProviderSessionId = previousFreshProviderSessionId;
			this.#syncAgentSessionId(previousSessionState.sessionId);
			this.#memory.rekeyForCurrentSessionId();
			this.agent.setTools(previousTools);
			this.#tools.setBaseSystemPrompt(previousBaseSystemPrompt);
			this.#memory.restorePromotionSnapshot(previousBaseSystemPromptBeforeMemoryPromotion);
			this.agent.setSystemPrompt(previousSystemPrompt);
			this.agent.replaceMessages(previousAgentMessages);
			this.agent.replaceQueues(previousSteeringMessages, previousFollowUpMessages);
			this.#pendingNextTurnMessages = previousPendingNextTurnMessages;
			this.#scheduledHiddenNextTurnGeneration = previousScheduledHiddenNextTurnGeneration;
			this.#inheritedProviderPromptCacheKey = previousInheritedProviderPromptCacheKey;
			this.#checkpointState = previousCheckpointState;
			this.#pendingRewindReport = previousPendingRewindReport;
			this.#lastCompletedRewind = previousLastCompletedRewind;
			this.#rewoundToolResultIds = previousRewoundToolResultIds;
			if (previousModel) {
				this.agent.setModel(previousModel);
			}
			this.#models.restoreThinkingSnapshot(previousThinkingLevel, previousAutoThinking, previousAutoResolvedLevel);
			this.#models.restoreServiceTiers(previousServiceTierByFamily);
			this.#todo.syncFromBranch();
			this.#advisors.resetAllRuntimes();
			this.#reconnectToAgent();
			try {
				await this.#sessionSwitchReconciler?.();
			} catch (reconcileError) {
				logger.warn("Failed to reconcile session mode after switch rollback", {
					targetSessionFile: sessionPath,
					error: String(reconcileError),
				});
			}
			this.#bash.finishSessionTransition(bashTransition, false);
			throw error;
		}
	}

	/**
	 * Create a branch from a specific entry.
	 * Emits before_branch/branch session events to hooks.
	 *
	 * @param entryId ID of the entry to branch from
	 * @returns Object with:
	 *   - selectedText: The text of the selected user message (for editor pre-fill)
	 *   - cancelled: True if a hook cancelled the branch
	 */
	async branch(entryId: string): Promise<{
		selectedText: string;
		cancelled: boolean;
	}> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (selectedEntry?.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = this.#extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		// Emit session_before_branch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		// Clear pending messages (bound to old session state)
		this.#pendingNextTurnMessages = [];
		this.#shakeToolCallCounter = 0;
		this.#scheduledHiddenNextTurnGeneration = undefined;

		await this.#bash.flushPending();
		// Flush pending writes before branching
		await this.sessionManager.flush();
		const bashTransition = this.#bash.beginSessionTransition();
		this.#cancelOwnAsyncJobs();
		this.#abortAutolearnCapture();
		await this.#drainAutolearnCapture();

		let sessionTransitioned = false;
		try {
			if (!selectedEntry.parentId) {
				await this.sessionManager.newSession({ parentSession: previousSessionFile });
			} else {
				this.sessionManager.createBranchedSession(selectedEntry.parentId);
			}
			this.#bash.markSessionTransition(bashTransition);
			sessionTransitioned = true;
		} finally {
			this.#bash.finishSessionTransition(bashTransition, sessionTransitioned);
		}
		this.#clearSessionScopedToolState();
		this.#rehydrateCheckpointRewindState();
		this.#todo.syncFromBranch();
		this.#freshProviderSessionId = undefined;
		this.#clearInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#memory.rekeyForCurrentSessionId();
		await this.#memory.resetContextForNewTranscript();

		// Reload messages from entries (works for both file and in-memory mode)
		const sessionContext = this.buildDisplaySessionContext();

		// Emit session_branch event to hooks (after branch completes)
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		if (!skipConversationRestore) {
			this.agent.replaceMessages(sessionContext.messages);
			this.#advisors.resetSessionState();
			this.#closeCodexProviderSessionsForHistoryRewrite();
		}

		return { selectedText, cancelled: false };
	}

	async branchFromBtw(
		question: string,
		assistantMessage: AssistantMessage,
	): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
		const previousSessionFile = this.sessionFile;
		if (!this.sessionManager.getSessionFile()) {
			throw new Error("Cannot branch /btw: session is not persisted");
		}

		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			throw new Error("Cannot branch /btw: current session has no leaf");
		}

		if (
			this.isBashRunning ||
			this.isEvalRunning ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			this.isRetrying
		) {
			throw new Error("Cannot branch /btw while session maintenance or user work is still running");
		}

		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId: leafId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { cancelled: true, sessionFile: previousSessionFile };
			}
		}

		await this.#cancelPostPromptTasks();
		if (
			this.isBashRunning ||
			this.isEvalRunning ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			this.isRetrying
		) {
			throw new Error("Cannot branch /btw while session maintenance or user work is still running");
		}

		this.#pendingNextTurnMessages = [];
		this.#shakeToolCallCounter = 0;
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.agent.replaceQueues([], []);
		if (this.isStreaming) {
			await this.abort({ goalReason: "internal", reason: "branching /btw" });
			this.agent.replaceQueues([], []);
		}
		await this.#bash.flushPending();
		await this.sessionManager.flush();
		const bashTransition = this.#bash.beginSessionTransition();
		this.#cancelOwnAsyncJobs();
		this.#abortAutolearnCapture();
		await this.#drainAutolearnCapture();

		let sessionTransitioned = false;
		try {
			this.sessionManager.createBranchedSession(leafId);
			this.#bash.markSessionTransition(bashTransition);
			sessionTransitioned = true;
		} finally {
			this.#bash.finishSessionTransition(bashTransition, sessionTransitioned);
		}

		this.#clearSessionScopedToolState();

		this.#rehydrateCheckpointRewindState();
		this.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: question }],
			timestamp: Date.now(),
		});
		this.sessionManager.appendMessage(sanitizeAssistantForReparentedHistory(assistantMessage));
		this.#todo.syncFromBranch();
		this.#freshProviderSessionId = undefined;
		this.#syncAgentSessionId();
		this.#memory.rekeyForCurrentSessionId();
		await this.#memory.resetContextForNewTranscript();

		const sessionContext = this.buildDisplaySessionContext();

		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		this.agent.replaceMessages(sessionContext.messages);
		this.#advisors.resetSessionState();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		return { cancelled: false, sessionFile: this.sessionFile };
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike branch() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			/**
			 * Opts into the two-phase `ask` toolResult re-answer protocol
			 * (issue #5642): set only by the interactive `/tree` selector, which
			 * knows how to re-open the picker on `reopenAsk` and complete the
			 * navigation with `reanswerAskResult`. Every other public caller
			 * (extensions, hooks, ACP, session-extension actions) leaves this
			 * unset and gets the pre-#5642 plain leaf move onto `ask`
			 * toolResults instead — they have no picker to re-open and would
			 * otherwise report a successful no-op navigation (roboomp review on
			 * #5895).
			 */
			allowAskReopen?: boolean;
			/**
			 * Completes an in-progress `ask` re-answer (issue #5642): the caller
			 * already received `reopenAsk` from a prior call on the same
			 * `targetId`, re-opened the picker, and is handing back the fresh
			 * answer. Branches a new toolResult sibling instead of landing on
			 * the original one.
			 */
			reanswerAskResult?: AgentToolResult<AskToolDetails>;
		} = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
		/** Raw session context built during navigation — pass to renderInitialMessages to skip a second O(N) walk. */
		sessionContext?: SessionContext;
		/**
		 * Set when `targetId` is an `ask` toolResult, `options.allowAskReopen`
		 * was set, and `options.reanswerAskResult` was not supplied: nothing was
		 * mutated. The caller must re-open the ask picker with these
		 * `questions`, then call `navigateTree(targetId, { ...options,
		 * reanswerAskResult })` with the produced result to actually branch
		 * (issue #5642).
		 */
		reopenAsk?: { toolCallId: string; questions: AskToolInput["questions"] };
	}> {
		await this.#bash.flushPending();
		const oldLeafId = this.sessionManager.getLeafId();

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const targetIsAskResult =
			targetEntry.type === "message" &&
			targetEntry.message.role === "toolResult" &&
			targetEntry.message.toolName === "ask";

		// No-op if already at target — except mid-flight through the `ask`
		// re-answer protocol (issue #5642): a probe or completion call can
		// legitimately target the *current* leaf (e.g. the user interrupted
		// right after answering `ask`, before a follow-up assistant message
		// landed, or another caller navigated straight onto the ask result),
		// and must still return `reopenAsk` / branch the new answer instead of
		// silently reporting a no-op (chatgpt-codex review on #5895).
		if (targetId === oldLeafId && !(options.allowAskReopen && targetIsAskResult)) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		// `ask` toolResult, first pass: hand control back to the caller to
		// re-open the picker instead of landing on the stale answer in place.
		// Nothing is mutated here — see the `reanswerAskResult` branch below for
		// the actual sibling-branch construction once the caller has an answer.
		// Gated on `allowAskReopen` — callers that don't understand `reopenAsk`
		// fall straight through to the plain leaf move below instead of
		// reporting a successful no-op (roboomp review on #5895).
		if (
			options.allowAskReopen &&
			!options.reanswerAskResult &&
			targetEntry.type === "message" &&
			targetEntry.message.role === "toolResult" &&
			targetEntry.message.toolName === "ask"
		) {
			const toolCallId = targetEntry.message.toolCallId;
			const questions = this.#recoverAskReanswerQuestions(targetEntry.parentId, toolCallId);
			if (questions) {
				return { cancelled: false, reopenAsk: { toolCallId, questions } };
			}
			// Original arguments couldn't be recovered (corrupted/legacy session
			// data) — fall through to a plain leaf move so navigation still works.
		}

		// Collect entries to summarize (from old leaf to common ancestor). For an
		// `ask` re-answer completion, the branch point is `targetEntry.parentId`
		// (the new sibling toolResult lands there, not on `targetId`) — anchor
		// the collection there too, or the old answer entry is neither on the
		// new branch nor included in the summary (chatgpt-codex review on
		// #5895).
		const summaryAnchorId =
			options.reanswerAskResult !== undefined &&
			targetEntry.type === "message" &&
			targetEntry.message.role === "toolResult" &&
			targetEntry.message.toolName === "ask" &&
			targetEntry.parentId !== null
				? targetEntry.parentId
				: targetId;
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			summaryAnchorId,
		);

		// Prepare event data
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		// Set up abort controller for summarization
		this.#branchSummaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
		if (this.#extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const model = this.model!;
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}
			const branchSummarySettings = this.settings.getGroup("branchSummary");
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey: this.#modelRegistry.resolver(model, this.sessionId),
				signal: this.#branchSummaryAbortController.signal,
				customInstructions: this.#obfuscateTextForProvider(options.customInstructions),
				reserveTokens: branchSummarySettings.reserveTokens,
				metadata: this.agent.metadataForProvider(model.provider),
				convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
				telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
				// Same per-provider concurrency cap rationale as the compaction
				// path above (chatgpt-codex review on #3751).
				completeImpl: async (requestModel, requestContext, requestOptions) => {
					const stream = await this.#sideStreamFn(requestModel, requestContext, requestOptions);
					return stream.result();
				},
			});
			this.#branchSummaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (hookSummary) {
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = this.#extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message" && targetEntry.customType !== SKILL_PROMPT_MESSAGE_TYPE) {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
		} else if (
			targetEntry.type === "message" &&
			targetEntry.message.role === "toolResult" &&
			targetEntry.message.toolName === "ask" &&
			options.reanswerAskResult
		) {
			// `ask` toolResult, second pass: the caller re-opened the picker and
			// is handing back a fresh answer. Branch a *new* sibling toolResult
			// off the same `ask` toolCall instead of reusing `targetId` — the
			// original answer's branch stays reachable (issue #5642).
			const reanswer = options.reanswerAskResult;
			const toolResultMessage: ToolResultMessage = {
				role: "toolResult",
				toolCallId: targetEntry.message.toolCallId,
				toolName: "ask",
				content: reanswer.content,
				details: reanswer.details,
				isError: reanswer.isError === true,
				timestamp: Date.now(),
			};
			newLeafId = this.sessionManager.appendMessageToBranch(toolResultMessage, targetEntry.parentId);
		} else {
			// Non-user message (or a user-invoked skill-prompt injection): land the
			// leaf on the selected node so it stays on the active branch. Skill
			// prompts are custom_message entries but must not be re-editable — their
			// content is a large expanded body, not a user turn (issue #5374).
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		const bashTransition = this.#bash.beginSessionTransition();
		let summaryEntry: BranchSummaryEntry | undefined;
		let branchTransitioned = false;
		try {
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
			} else if (newLeafId === null) {
				this.sessionManager.resetLeaf();
			} else {
				this.sessionManager.branch(newLeafId);
			}
			this.#bash.markSessionTransition(bashTransition);
			branchTransitioned = true;
		} finally {
			this.#bash.finishSessionTransition(bashTransition, branchTransitioned);
		}

		// Update agent state — build display context to populate agent messages.
		const stateContext = this.sessionManager.buildSessionContext();
		const displayContext = deobfuscateSessionContext(stateContext, this.#obfuscator);
		this.agent.replaceMessages(displayContext.messages);
		this.#rehydrateCheckpointRewindState();
		this.#advisors.resetSessionState();
		this.#todo.syncFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		this.#branchSummaryAbortController = undefined;

		// Emit session_tree event; only handlers can mutate session entries, so skip
		// the emit and the context rebuild when no handlers are registered (mirrors
		// the session_before_tree guard above).
		if (this.#extensionRunner?.hasHandlers("session_tree")) {
			await this.#extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
			const rawContext = this.sessionManager.buildSessionContext();
			return { editorText, cancelled: false, summaryEntry, sessionContext: rawContext };
		}
		return { editorText, cancelled: false, summaryEntry, sessionContext: stateContext };
	}

	/**
	 * Look up the `ask` toolCall's persisted `arguments` and validate them
	 * back into `questions`, for `/tree` `ask` re-answer (issue #5642). Walks
	 * up from the toolResult's parent past any interleaved ancestor entries
	 * — sibling toolResults from other tool calls in the same turn (`ask`
	 * runs `exclusive`, which only serializes *execution*, not persistence
	 * order — roboomp review on #5895), and bookkeeping entries such as the
	 * `tool_execution_start` custom entry `#recordToolExecutionStart()`
	 * appends before every toolResult in real persisted sessions (chatgpt-codex
	 * review on #5895) — until it finds the assistant entry that actually
	 * emitted `toolCallId`. Stops at a `user` message (turn boundary) or a
	 * dead end. Returns `undefined` when no ancestor entry holds a matching
	 * `ask` toolCall, or the arguments can't be resolved — the caller falls
	 * back to a plain leaf move rather than opening a picker with bad data.
	 */
	#recoverAskReanswerQuestions(parentId: string | null, toolCallId: string): AskToolInput["questions"] | undefined {
		let current = parentId;
		while (current !== null) {
			const entry = this.sessionManager.getEntry(current);
			if (!entry) return undefined;
			if (entry.type === "message") {
				if (entry.message.role === "assistant") {
					const toolCall = entry.message.content.find(
						(block): block is AgentToolCall => block.type === "toolCall" && block.id === toolCallId,
					);
					if (!toolCall) return undefined;
					if (toolCall.name !== "ask") return undefined;
					const args = this.#obfuscator?.hasSecrets()
						? deobfuscateToolArguments(this.#obfuscator, toolCall.arguments)
						: toolCall.arguments;
					return recoverAskQuestions(args);
				}
				if (entry.message.role === "user") return undefined;
			}
			current = entry.parentId;
		}
		return undefined;
	}

	/**
	 * Build a standalone `AgentToolContext` for running `AskTool.execute()`
	 * outside a normal agent turn, for `/tree` `ask` re-answer (issue #5642).
	 * `SelectorController` has no reachable `ToolContextStore` (that store is
	 * built inside `sdk.ts` and never threaded through to mode controllers),
	 * so this mirrors `refreshMCPTools()`'s `getCustomToolContext` factory
	 * with real session state instead of a `{ ... } as unknown as
	 * AgentToolContext` cast that could silently compile with an incomplete
	 * context (roboomp review on #5895) — every `CustomToolContext` field is
	 * backed by live session state, so a future required field fails to
	 * compile here instead of surfacing as `undefined` at runtime.
	 */
	buildAskReanswerContext(uiContext: ExtensionUIContext): AgentToolContext {
		return {
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
			settings: this.settings,
			ui: uiContext,
			hasUI: true,
		};
	}

	/**
	 * Get all user messages from session for branch selector.
	 */
	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this.#extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	#extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		return this.#stats.getSessionStats();
	}

	/**
	 * Get current context usage statistics.
	 * Uses the last assistant message's usage data when available,
	 * otherwise estimates tokens for all messages.
	 */
	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined {
		return this.#stats.getContextBreakdown(options);
	}

	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		return this.#stats.getContextUsage(options);
	}

	/**
	 * Monotonic counter that changes whenever the in-flight pending context
	 * snapshot is set or cleared. Status-line context memoization keys on this so
	 * a value computed mid-turn cannot persist after the turn ends/aborts.
	 */
	get contextUsageRevision(): number {
		return this.#stats.revision;
	}

	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		const authStorage = this.#modelRegistry.authStorage;
		if (!authStorage.fetchUsageReports) return null;
		return authStorage.fetchUsageReports({
			baseUrlResolver: provider => {
				if (provider === "google-antigravity") {
					const mode = this.settings.get("providers.antigravityEndpoint");
					if (mode === "sandbox") {
						return "https://daily-cloudcode-pa.sandbox.googleapis.com";
					} else if (mode === "production") {
						return "https://daily-cloudcode-pa.googleapis.com";
					}
				}
				return this.#modelRegistry.getProviderBaseUrl?.(provider);
			},
			signal,
		});
	}

	/** Models whose live `/usage` reports map to a quantitative provider scope. */
	getUsageReportingModelSelectors(reports: readonly UsageReport[]): string[] {
		const modelsByProvider = new Map<string, Model[]>();
		for (const model of this.#modelRegistry.getAvailable()) {
			const models = modelsByProvider.get(model.provider) ?? [];
			models.push(model);
			modelsByProvider.set(model.provider, models);
		}
		const selectors = new Set<string>();
		for (const [provider, models] of modelsByProvider) {
			const modelIds = this.#modelRegistry.authStorage.getUsageReportingModelIds(
				provider,
				models.map(model => model.id),
				reports,
			);
			for (const modelId of modelIds) selectors.add(`${provider}/${modelId}`);
		}
		return [...selectors].sort((left, right) => left.localeCompare(right));
	}

	/** List stored OAuth accounts for the current model provider and mark this session's active account. */
	async listCurrentProviderOAuthAccounts(): Promise<SessionOAuthAccountList | undefined> {
		const provider = this.model?.provider;
		if (!provider) return undefined;
		const authStorage = this.#modelRegistry.authStorage;
		await authStorage.reload();
		return {
			provider,
			accounts: authStorage.listOAuthAccounts(provider, this.sessionId),
		};
	}

	/**
	 * Pin a stored OAuth account to the current model provider for this session.
	 * Returns false while streaming or when the credential is no longer available.
	 */
	pinCurrentProviderOAuthAccount(credentialId: number): boolean {
		const provider = this.model?.provider;
		if (!provider || this.isStreaming) return false;
		return this.#modelRegistry.authStorage.pinSessionOAuthAccount(provider, this.sessionId, credentialId);
	}

	/**
	 * Redeem one saved Codex rate-limit reset for a specific account, injecting
	 * the provider base URL like {@link AgentSession.fetchUsageReports}. Powers
	 * the `/usage reset` command and auto-redeem. Never throws for business
	 * outcomes — inspect the returned `code`.
	 */
	async redeemResetCredit(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		return this.#modelRegistry.authStorage.redeemResetCredit({
			target,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}

	/**
	 * List saved Codex rate-limit resets per stored account, fetched live from
	 * the dedicated credits endpoint (bypasses the usage cache). Powers the
	 * `/usage reset` account selector.
	 */
	async listResetCredits(signal?: AbortSignal): Promise<ResetCreditAccountStatus[]> {
		return this.#modelRegistry.authStorage.listResetCredits({
			sessionId: this.sessionId,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}
	async #confirmCodexAutoRedeem(decision: CodexAutoRedeemRedeemDecision): Promise<boolean> {
		const runner = this.#extensionRunner;
		if (!runner?.hasUI()) {
			this.emitNotice(
				"warning",
				"Codex saved reset is eligible, but auto-redeem is unset and no prompt UI is available. Run `/usage reset` or set codexResets.autoRedeem.",
				"codex-auto-reset",
			);
			return false;
		}

		const who = decision.target.email ?? decision.target.accountId ?? "the active account";
		const resetLabel = decision.availableCount === 1 ? "reset" : "resets";
		try {
			const choice = await runner
				.getUIContext()
				.select(
					`Do you wanna redeem your reset?\n${who} is blocked by the weekly Codex limit for about ${formatDuration(decision.remainingMs)}. Spend 1 of ${decision.availableCount} saved ${resetLabel}?`,
					[
						{
							label: "Yes",
							description: "Redeem now and remember yes for future eligible Codex weekly blocks.",
						},
						{
							label: "No",
							description: "Do not auto-redeem saved Codex resets.",
						},
					],
				);
			if (choice === "Yes") {
				this.settings.set("codexResets.autoRedeem", "yes");
				return true;
			}
			if (choice === "No") {
				this.settings.set("codexResets.autoRedeem", "no");
			}
		} catch (error) {
			logger.warn("codex-auto-reset prompt failed", { error: String(error) });
		}
		return false;
	}

	/**
	 * Auto-redeem hook for {@link AgentSession.#handleRetryableError}'s
	 * usage-limit branch. Returns `true` only when a saved Codex reset was
	 * actually spent (so the caller retries immediately). The "unset" mode is
	 * reactive but asks before spending; "yes" skips that prompt, and "no" avoids
	 * the eligibility IO entirely. The decision remains heavily gated — see
	 * `./codex-auto-reset` and the design in `local://autoreset-spec.md`.
	 * Per-account in-flight dedup lets concurrent sessions adopt one redeem
	 * instead of double-spending.
	 */
	async #maybeAutoRedeemCodexReset(coordinator = defaultCodexAutoRedeemCoordinator): Promise<boolean> {
		const cfg = this.settings.getGroup("codexResets");
		const model = this.model;
		// Cheap exits before any IO.
		if (!shouldEvaluateCodexAutoRedeem(cfg.autoRedeem) || !model || model.provider !== "openai-codex") return false;
		const authStorage = this.#modelRegistry.authStorage;
		// Capture identity BEFORE awaits: markUsageLimitReached leaves the
		// usage-limit session credential sticky, so this names the blocked account.
		const identity = authStorage.getOAuthAccountIdentity("openai-codex", this.sessionId);
		const accountKey = (identity?.accountId ?? identity?.email)?.trim().toLowerCase();
		if (!accountKey) return false;
		const existing = coordinator.inFlightByAccount.get(accountKey);
		if (existing) return existing;

		const run = (async (): Promise<boolean> => {
			const reports = await this.fetchUsageReports();
			const decision = evaluateCodexAutoRedeem({
				nowMs: Date.now(),
				provider: model.provider,
				modelId: model.id,
				settings: {
					autoRedeem: true,
					minBlockedMinutes: Math.max(0, cfg.minBlockedMinutes),
					keepCredits: Math.max(0, Math.trunc(cfg.keepCredits)),
				},
				identity,
				reports,
				attemptedBlockKeys: coordinator.attemptedBlockKeys,
				lastAttemptAtByAccount: coordinator.lastAttemptAtByAccount,
			});
			if (!decision.redeem) {
				logger.debug("codex-auto-reset: skipped", { reason: decision.reason, account: accountKey });
				return false;
			}
			if (shouldPromptCodexAutoRedeem(cfg.autoRedeem) && !(await this.#confirmCodexAutoRedeem(decision))) {
				return false;
			}
			// Commit the attempt BEFORE acting so this block can never re-enter.
			coordinator.attemptedBlockKeys.add(decision.blockKey);
			coordinator.lastAttemptAtByAccount.set(decision.accountKey, Date.now());
			const who = decision.target.email ?? decision.target.accountId ?? "the active account";
			const outcome = await authStorage.redeemResetCredit({
				target: decision.target,
				baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
				// Not tied to the retry abort controller: aborting a consume
				// mid-flight leaves credit state unknown.
				signal: AbortSignal.timeout(15_000),
			});
			switch (outcome.code) {
				case "reset": {
					const left = Math.max(0, decision.availableCount - 1);
					this.emitNotice(
						"info",
						`Auto-redeemed a saved Codex rate-limit reset for ${who} (${left} left); retrying now.`,
						"codex-auto-reset",
					);
					void this.fetchUsageReports();
					return true;
				}
				case "already_redeemed":
					this.emitNotice(
						"warning",
						"A saved Codex reset was already redeemed elsewhere; waiting for the window.",
						"codex-auto-reset",
					);
					return false;
				case "no_credit":
					logger.debug("codex-auto-reset: no_credit (snapshot/live mismatch)", { account: accountKey });
					return false;
				case "nothing_to_reset":
					this.emitNotice(
						"warning",
						"Codex reset reported nothing to reset; auto-redeem suppressed for this window.",
						"codex-auto-reset",
					);
					return false;
				default:
					this.emitNotice("warning", `Codex auto-redeem failed (${outcome.code}).`, "codex-auto-reset");
					return false;
			}
		})().finally(() => coordinator.inFlightByAccount.delete(accountKey));
		coordinator.inFlightByAccount.set(accountKey, run);
		return run;
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path
	 * @param useUserThemes Bundle the dark and light TUI themes selected in settings
	 */
	async exportToHtml(outputPath?: string, useUserThemes = false): Promise<string> {
		// Lazy import: the export module embeds the HTML template and pre-built
		// tool renderers as text; only `/export` should pay that load.
		const { exportSessionToHtml } = await import("../export/html");
		return exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			palette: useUserThemes ? "theme" : "web",
			themeNames: useUserThemes
				? {
						dark: this.settings.get("theme.dark") ?? "titanium",
						light: this.settings.get("theme.light") ?? "light",
					}
				: undefined,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.#getLastCopyCandidateAssistantMessage();
		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of lastAssistant.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	hasCopyCandidateAssistantMessage(): boolean {
		return this.#getLastCopyCandidateAssistantMessage() !== undefined;
	}

	#getLastCopyCandidateAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "assistant") continue;

			const assistantMessage = message as AssistantMessage;
			// Skip aborted messages with no content
			if (assistantMessage.stopReason === "aborted" && assistantMessage.content.length === 0) continue;

			return assistantMessage;
		}

		return undefined;
	}
	/**
	 * Get text content of the most recent visible handoff message.
	 * Fresh handoff sessions store the handoff context as a custom message, not
	 * an assistant message, so callers that copy the "last" message can use this
	 * as a fallback before the new session has an assistant response.
	 */
	getLastVisibleHandoffText(): string | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "custom") continue;

			const customMessage = message as CustomMessage;
			if (customMessage.customType !== "handoff" || !customMessage.display) continue;

			if (typeof customMessage.content === "string") {
				return customMessage.content.trim() || undefined;
			}

			let text = "";
			for (const content of customMessage.content) {
				if (content.type === "text") {
					text += content.text;
				}
			}
			return text.trim() || undefined;
		}

		return undefined;
	}

	/**
	 * Format the entire session as plain text for clipboard export: system
	 * prompt, model/thinking config, tool inventory, and the full transcript
	 * rendered with markdown role headings (`## User`, `## Assistant`,
	 * `### Tool Call`/`### Tool Result`).
	 */
	formatSessionAsText(): string {
		return formatSessionDumpText({
			messages: this.messages,
			systemPrompt: this.agent.state.systemPrompt,
			model: this.agent.state.model,
			thinkingLevel: this.thinkingLevel,
			tools: this.agent.state.tools,
			inlineToolDescriptors: this.#pruneToolDescriptions,
		});
	}

	/**
	 * Dump the current session's LLM-facing request context as JSON to a
	 * auto-named file in `os.tmpdir()`. This is the synchronous
	 * `convertToLlm`-boundary snapshot — system prompt, tools (wire schemas),
	 * thinking/service tier, and converted messages — with no network round-trip
	 * and no arming flag, so advisor/side requests cannot intercept it.
	 *
	 * The file persists on disk and may contain the same raw context/secrets
	 * as `/dump`; treat the path accordingly.
	 *
	 * @returns the written file path, or `undefined` when there are no messages.
	 */
	async dumpLlmRequestToTmpDir(): Promise<string | undefined> {
		const messages = this.messages;
		if (messages.length === 0) return undefined;
		const llmMessages = await this.convertMessagesToLlm(messages);
		const payload = {
			model: this.agent.state.model ?? null,
			thinkingLevel: this.thinkingLevel ?? null,
			serviceTier: this.#models.serviceTierEntry(),
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: toolWireSchema(tool),
				...(tool.strict !== undefined ? { strict: tool.strict } : {}),
				...(tool.customWireName ? { customWireName: tool.customWireName } : {}),
			})),
			messages: llmMessages,
		};
		const filePath = path.join(os.tmpdir(), `omp-llm-request-${Snowflake.next()}.json`);
		await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
		return filePath;
	}

	/**
	 * Enable or disable the advisor for this session. The setting is overridden for the session,
	 * and the runtime is started or stopped to match.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	setAdvisorEnabled(enabled: boolean): boolean {
		return this.#advisors.setAdvisorEnabled(enabled);
	}

	/**
	 * Toggle the advisor setting and start/stop the runtime accordingly.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	toggleAdvisorEnabled(): boolean {
		return this.#advisors.toggleAdvisorEnabled();
	}

	/**
	 * Replace the live advisor roster from an edited `WATCHDOG.yml` (the `/advisor
	 * configure` save path). Swaps the configs + shared baseline, then rebuilds the
	 * runtimes in place so the change applies without a restart. When the advisor is
	 * disabled the new configs are simply stored for the next enable.
	 *
	 * @returns the number of advisors active after the rebuild.
	 */
	applyAdvisorConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number {
		return this.#advisors.applyAdvisorConfigs(advisors, sharedInstructions);
	}

	/**
	 * Whether the advisor setting is enabled for this session.
	 */
	isAdvisorEnabled(): boolean {
		return this.#advisors.isAdvisorEnabled();
	}

	/**
	 * Whether a live advisor agent is attached to this session. True only when
	 * `advisor.enabled` is set AND a model resolved for the `advisor` role AND
	 * the advisor applies to this agent kind — i.e. the actual runtime exists,
	 * not merely the setting. Drives the status-line badge and `/dump advisor`.
	 */
	isAdvisorActive(): boolean {
		return this.#advisors.isAdvisorActive();
	}

	/**
	 * The names of the tools available to advisors this session (the pool a
	 * `/advisor configure` editor lists). The advisor is a full agent, so this is the
	 * full built tool set; a tool whose optional factory returns null (e.g. lsp with
	 * no servers) is absent.
	 */
	getAdvisorAvailableToolNames(): string[] {
		return this.#advisors.getAdvisorAvailableToolNames();
	}

	/**
	 * The live advisor `Agent`, or `undefined` when no advisor runtime is
	 * attached. Surfaced for diagnostics (`/dump advisor` already serializes
	 * its transcript via {@link formatAdvisorHistoryAsText}) and so callers can
	 * verify the advisor inherits the session's provider-shaping options
	 * (`streamFn`, `promptCacheKey`, `providerSessionState`, ...).
	 */
	getAdvisorAgent(): Agent | undefined {
		return this.#advisors.getAdvisorAgent();
	}

	/**
	 * Lightweight advisor status for the status line: returns just the configured
	 * flag and per-advisor name/status without computing token/cost breakdowns.
	 * Avoids re-tokenizing the advisor transcript on every render frame.
	 */
	getAdvisorStatusOverview(): { configured: boolean; advisors: { name: string; status: AdvisorRuntimeStatus }[] } {
		return this.#advisors.getAdvisorStatusOverview();
	}
	/**
	 * Return structured advisor stats for the status command and TUI panel.
	 */
	getAdvisorStats(): AdvisorStats {
		return this.#advisors.getAdvisorStats();
	}

	/**
	 * Format a concise advisor status line for ACP/text output.
	 */
	formatAdvisorStatus(): string {
		return this.#advisors.formatAdvisorStatus();
	}

	/**
	 * Format the advisor agent's own transcript (its system prompt, config,
	 * tools, and the markdown deltas it received plus its thinking/advise/read
	 * calls) as plain text — the advisor-side equivalent of
	 * {@link formatSessionAsText}. Returns null when no advisor is active.
	 */
	formatAdvisorHistoryAsText(options?: { compact?: boolean }): string | null {
		return this.#advisors.formatAdvisorHistoryAsText(options);
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.#extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#extensionRunner;
	}
}
