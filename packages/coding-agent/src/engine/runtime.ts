import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentMessage, AgentPauseGate } from "@oh-my-pi/pi-agent-core";
import { createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { AssistantMessage, AssistantMessageEvent, ImageContent, Model } from "@oh-my-pi/pi-ai";
import {
	enqueueStreamWork,
	runWithStreamAdmission,
	StreamAdmission,
	StreamAdmissionError,
	type StreamAdmissionLimits,
} from "@oh-my-pi/pi-ai/utils/stream-admission";
import { getBlobsDir, logger, SUPPORTED_IMAGE_MIME_TYPES, stableStringifyJson, withTimeout } from "@oh-my-pi/pi-utils";
import {
	attachLatencyPersistence,
	createLatencyAudit,
	type LatencyAudit,
	latencyFetch,
	latencyFirst,
	latencyNormalizedSource,
	latencyPersistenceSource,
} from "@oh-my-pi/pi-utils/latency-audit";
import { AsyncJobManager } from "../async/job-manager";
import { withCapabilityProviderPolicy } from "../capability";
import { withSettingsScope } from "../config/settings";
import {
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	noOpUIContext,
	type ToolExecutionHook,
	type ToolExecutionHookCall,
	type ToolExecutionHookOutcome,
	type ToolExecutionHookToken,
} from "../extensibility/extensions";
import type { EngineHistoryAccess } from "../internal-urls/types";
import { IrcBus, type IrcDeliveryReceipt } from "../irc/bus";
import { withLspSessionScope } from "../lsp/client";
import { MCPManager } from "../mcp/manager";
import type { MCPHttpServerConfig } from "../mcp/types";
import engineContinuePrompt from "../prompts/system/engine-continue.md" with { type: "text" };
import historyEditContinuePrompt from "../prompts/system/history-edit-continue.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { TurnRetryPolicy } from "../session/agent-session-types";
import { BlobStore } from "../session/blob-store";
import { NativeSessionWriteRejectedError } from "../session/native-session-storage";
import { createProviderRetryBudgetHook } from "../session/provider-retry-budget";
import { decodeNativeEntry, parseNativeSessionLocator, RocksNativeSessionStorage } from "../session/rocks-native-session-storage";
import type {
	SessionEntry,
	SessionHeader,
	SessionLaunchSnapshot,
	SessionMessageIdentity,
} from "../session/session-entries";
import {
	type NativeHistoryForkResult,
	type SessionDurabilityCheckpoint,
	SessionManager,
} from "../session/session-manager";
import { readStorageBinding, StorageClient, StorageClientError, storageCanonicalJson } from "../session/storage-client";
import type { StructuredSubagentOutput, YieldItem } from "../task/types";
import { arrayValuedLabels, assembleYieldResult } from "../task/yield-assembly";
import type { EngineChildLaunchResult, EngineInboxToolRequest } from "../tools";
import { normalizeToolNames } from "../tools/builtin-names";
import { buildOutputValidator } from "../tools/output-schema-validator";
import type { EngineCommandEnvelope } from "./nats-adapter";
import {
	type ApprovalAddressee,
	type ApprovalRequest,
	type CandidateIdentity,
	type EngineApprovalDecision,
	type EngineAttemptState,
	type EngineBindingGate,
	type EngineBindingResult,
	EngineBindingPendingError,
	type EngineBindingSnapshot,
	type EngineCancelRequest,
	type EngineCompletionPayload,
	type EngineControlInitiator,
	type EngineControlRequest,
	type EngineControlResult,
	type EngineEvent,
	type EngineInboxItem,
	type EngineInboxMutation,
	type EngineInboxSource,
	type EngineExecutionConfiguration,
	type EngineOrdinaryEvent,
	type EngineExecutionRoute,
	type EngineInboxTarget,
	type EngineMessageAttachments,
	type EnginePeerMessage,
	type EngineReconcileRequest,
	type EngineReconcileResult,
	type EngineRejectedCommand,
	type EngineResolveInputRequest,
	type EngineSemanticBindingSnapshot,
	sameSemanticBinding,
	type EngineStartRequest,
	type EngineStartResult,
	type EngineSteerRequest,
	type EngineTarget,
	EngineRoutingQueuedError,
	EngineTargetError,
	type EngineToolPolicy,
	type ExecutorChoice,
	type ExecutorRouteState,
	type InstructionRule,
	type SelectedExecutor,
	validateCommandContext,
	validateStartRequest,
	type WorkTarget,
} from "./contracts";
import type { ExecutionAttemptIdentity, ResolvedEngineExecution } from "./execution-resolver";
import { markProviderLatency, setProviderObservationModel, withProviderObservationContext } from "./provider-admission";
import type { BillingPoolProposal } from "./provider-execution";
import { safeEngineErrorDetail, safeHostedMcpFailure } from "./public-error";
import { beginRestoreRebind, type RestoreWorkspaceReceipt, resolveRestoreWorkspace } from "./rocks-restore-workspace";
import { readNativeHeader } from "./rocks-runtime-history";
import { RocksEngineStore } from "./rocks-runtime-store";
import type { ResumeMember } from "./rocks-store";
import { engineAgentId, engineAgentInstanceId, engineRouteToken } from "./route";
import { EngineAttachmentUploads, messageAttachmentReferences } from "./runtime-attachments";
import {
	type EngineHistoryAttachment,
	type EngineHistoryImage,
	type EngineHistoryMediaBlock,
	historyMediaBlocks,
	nativeHistoryAttachments,
	nativeHistoryImages,
} from "./runtime-history";
import { utf8Chunks } from "./runtime-messages";
import { runtimeInputBody, runtimeInputPreview } from "./runtime-projection";
import {
	type AdmissionRequest, candidateIdentity, candidateRef, currentIdentity, frozenCandidate,
	executorRuleReplay, l1For, LEASE_HEARTBEAT_MS, renderRules,
} from "./routing-admission";
import { runtimeLimits, validateRuntimeValue } from "./runtime-protocol";
import { type EnginePendingStartTarget, validateStartFence } from "./start-fence";
import {
	EngineAttemptConflictError,
	type EngineAttemptTargetRecord,
	EngineInboxConflictError,
	type EngineModelEffectInput,
	type EngineToolEffectInput,
	type EngineTransitionEvent,
} from "./store";
import { waitForEngineWake } from "./wake";

type EngineEventListener = (event: EngineEvent) => void | Promise<void>;

const MAX_ASSISTANT_FINAL_CHARS = 48_000;
// The full result shares one bounded storage write with its terminal event; beyond it the transcript ref serves it.
const MAX_TERMINAL_RESULT_BYTES = 512 * 1024;
const MAX_INPUT_FIELD_CHARS = 48_000;
const MAX_INPUT_RESULT_CHARS = 128_000;
const MAX_HISTORY_MESSAGE_CHARS = 48_000;
const MAX_HISTORY_ACTIVITY_CHARS = 48_000;
const ASSISTANT_SNAPSHOT_GROWTH_CHARS = 192;
const MAX_ASSISTANT_STREAMING_SNAPSHOTS = 256;
// Persisted assistant text is coalesced per block: the first delta of a block is written at once, later
// deltas at most once per window or byte budget. Replay concatenates the same text either way.
const ASSISTANT_DELTA_WINDOW_MS = 100;
const ASSISTANT_DELTA_WINDOW_BYTES = 8 * 1024;
const ENGINE_TURN_RETRY_DELAYS_MS = [3_000, 15_000, 30_000] as const;
const TERMINAL_ATTEMPT_STATES = new Set<EngineAttemptState>(["completed", "cancelled", "failed", "interrupted"]);
// Provider bursts are chunked into bounded durable writes below. Keep the
// transport admission window large enough for one bounded 3 MiB response
// while leaving the shared AI admission defaults unchanged.
const ENGINE_STREAM_ADMISSION_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const ENGINE_STREAM_ADMISSION_MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export interface EngineRestoreHistoryTarget {
	agentInstanceRef: string;
	authorityGeneration: number;
	restoreCheckpoint: { restoreId: string; contentHash: string };
}

type EngineHistoryActivityBlock = {
	blockId: string;
	blockIndex: number;
	kind: "text" | "reasoning" | "tool_call";
	status: "available" | "unavailable";
	text?: string;
	textTruncated?: boolean;
	toolCallId?: string;
	toolName?: string;
	argumentsText?: string;
	argumentsTruncated?: boolean;
	toolStatus?: "unknown" | "succeeded" | "failed";
	resultText?: string;
	resultTruncated?: boolean;
	images?: EngineHistoryImage[];
	resultBlocks?: EngineHistoryMediaBlock[];
	resultRef?: {
		kind: "history_entry";
		agentInstanceRef: string;
		attemptId?: string;
		sessionId: string;
		entryId: string;
		revision: string;
		bytes: number;
		mediaType: "application/json";
	};
	error?: string;
};


async function collectFailure(errors: unknown[], action: () => unknown | Promise<unknown>): Promise<void> {
	try {
		await action();
	} catch (error) {
		errors.push(error);
	}
}

function throwCollectedFailures(errors: unknown[], message: string): void {
	if (errors.length > 0) throw new AggregateError(errors, message);
}

function terminalYield(
	messages: readonly {
		role: string;
		content?: unknown;
		toolCallId?: unknown;
		toolName?: unknown;
		details?: unknown;
		isError?: unknown;
	}[],
	startIndex: number,
	lastAssistantText?: string,
	outputSchema?: unknown,
): { found: boolean; data?: unknown; rawText?: boolean; schemaOverridden?: boolean; aborted?: boolean; error?: string } {
	const pendingById = new Map<string, { indices: number[]; next: number }>();
	const ordered: (YieldItem | undefined)[] = [];
	for (let i = Math.max(0, startIndex); i < messages.length; i++) {
		const message = messages[i];
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!block || typeof block !== "object") continue;
				const call = block as { type?: string; id?: unknown; name?: string };
				if (call.type !== "toolCall" || call.name !== "yield" || typeof call.id !== "string") continue;
				const pending = pendingById.get(call.id) ?? { indices: [], next: 0 };
				pending.indices.push(ordered.length);
				pendingById.set(call.id, pending);
				ordered.push(undefined);
			}
		}
		if (message?.role !== "toolResult" || message.toolName !== "yield" || typeof message.toolCallId !== "string")
			continue;
		const pending = pendingById.get(message.toolCallId);
		if (!pending) continue;
		const index = pending.indices[pending.next++];
		if (index === undefined) continue;
		if (message.isError === true || !message.details || typeof message.details !== "object" || Array.isArray(message.details))
			continue;
		const details = message.details as Record<string, unknown>;
		if (details.status === "success" || details.status === "aborted") ordered[index] = details as YieldItem;
	}
	const items = ordered.filter((item): item is YieldItem => item !== undefined);
	const last = items.at(-1);
	if (last?.status === "aborted") return { found: false, aborted: true, error: last.error };
	if (items.length === 0) return { found: false };
	const assembled = assembleYieldResult(
		items,
		lastAssistantText,
		items.some(item => Array.isArray(item.type) && item.type.length > 0) ? arrayValuedLabels(outputSchema) : undefined,
	);
	return assembled && !assembled.missingData && assembled.data !== undefined
		? { found: true, data: assembled.data, rawText: assembled.rawText, schemaOverridden: assembled.schemaOverridden }
		: { found: false };
}

interface LiveBinding extends EngineBindingSnapshot {
	previousInboxSessionId?: string;
	principalId: string;
	approvalSettings: { timeout_seconds: number; settings_revision: number; settings_hash: string };
	pendingInboxSourceSessionId?: string;
	uncommittedForkSessionFile?: string;
	manualHold: boolean;
	intentRevision: number;
	attemptState: EngineAttemptState;
	session: AgentSession;
	mcpManager?: MCPManager;
	steerCommandIds: string[];
	steerCommandSet: Set<string>;
	unsubscribe: () => void;
	disposeExecution: () => void;
	requireYieldTool: boolean;
	outputSchema?: unknown;
	pauseGate: AgentPauseGate;
	activeToolCallIds: Set<string>;
	childWaits: Map<string, { agentInstanceId: string; attemptId?: string }>;
	parkedEffectTools: Set<string>;
	pauseProgress: PromiseWithResolvers<void>;
	pauseCommandIds: Set<string>;
	pauseRequests: Map<string, EngineControlInitiator>;
	approvalPauseCause?: { kind: "approval_deadline"; request_id: string; address_revision: number };
	resumeCommandIds: Set<string>;
	resumeMessageCommands: Set<string>;
	pendingPausedMessage?: { input: string; identity: SessionMessageIdentity; images?: ImageContent[] };
	traceWriteTail: Promise<void>;
	streamAdmission?: StreamAdmission;
	messageWriteError?: unknown;
	retryWriteError?: unknown;
	traceTools: Map<string, { name: string; startedAt: number }>;
	childLaunches: Set<string>;
	spawnApprovals: Map<string, string>;
	approvalGrants: Map<string, { receiptId: string; ceilingHash: string }>;
	recoveryCallIds?: string[];
	consultantEffectId?: string;
	modelCallSequence: number;
	modelEffect?: EngineModelEffectInput;
	/** Admitted immutable execution: frozen route units index-aligned with their native selectors. */
	execution: {
		config: EngineExecutionConfiguration;
		frozen: EngineExecutionRoute[];
		selectors: Array<string | undefined>;
		verifyCandidate: ResolvedEngineExecution["verifyCandidate"];
		activateCandidate: ResolvedEngineExecution["activateCandidate"];
		ruleEventsPending?: string[];
		choice: ExecutorChoice;
	};
	leaseHeartbeat?: NodeJS.Timeout;
	executorRouteState?: ExecutorRouteState;
	assistantMessageSequence: number;
	assistantStream?: AssistantStreamState;
	/** Final provider usage per native assistant response; null means accounting was unavailable. */
	measuredUsage: Map<string, { input: number; output: number; cached: number } | null>;
	lastAssistantNativeEntry?: { messageId: string; entryId: string };
	lastAssistantMessageId?: string;
	toolOrigins?: { attemptId: string; blocks: Map<string, NonNullable<EngineToolEffectInput["origin"]>> };
	activeModelCalls: Set<Promise<void>>;
	/** Uploads of direct Start/steer/resume messages by clientMessageId, consumed once the user entry is durable. */
	directUploads: Map<string, EngineMessageAttachments>;
	pendingInput?: PendingInput;
}

interface AssistantStreamState {
	attemptId: string;
	sourceTimestamp: number;
	assistantMessageId: string;
	revision: number;
	text: string;
	textTruncated: boolean;
	emittedText: string;
	streamingSnapshots: number;
	settled: boolean;
	blocks: Map<number, AssistantBlockState>;
	flushTimer?: NodeJS.Timeout;
}

interface AssistantBlockState {
	blockId: string;
	stream: "assistant" | "thinking";
	contentId: string;
	revision: number;
	offset: number;
	receivedChars: number;
	pendingSurrogate: string;
	hash: crypto.Hash;
	settled: boolean;
	/** Well-formed text received but not yet persisted. */
	pending: string;
	pendingBytes: number;
	/** Queued flush that has not started; it takes all pending text when it runs. */
	flush?: Promise<void>;
}

interface ToolInvocationRecord {
	invocationId: string;
	policy: EngineToolPolicy;
	toolCallId: string;
	toolName: string;
	inputHash: string;
	origin?: EngineToolEffectInput["origin"];
	target: EngineBindingSnapshot;
	done: Promise<void>;
	resolveDone: () => void;
	settled: boolean;
	checkpoint?: SessionDurabilityCheckpoint;
	outcome?: { status: "completed" | "failed" | "cancelled"; error?: string; jobIds?: string[] };
}

interface PendingToolApproval {
	record: ToolInvocationRecord;
	resolve: (decision: {
		decision: "approve" | "deny" | "cancelled";
		reason?: string;
		causationCommandId?: string;
		receiptId?: string;
	}) => void;
}

interface PendingInput {
	inputId: string;
	questions: ExtensionAskDialogQuestion[];
	resolve: (result: ExtensionAskDialogResult | undefined) => void;
}

type HistoryDispatchKind = "prompt" | "continue" | "continue_after_assistant" | "resume_queued" | "pending_tool";

interface PreparedHistoryStart {
	sessionManager: SessionManager;
	dispatchKind: HistoryDispatchKind;
	dispatchInput: string;
	pendingInboxSourceSessionId?: string;
	result: NonNullable<EngineStartResult["historyEdit"]>;
}

export interface ApprovalAncestor {
	root?: boolean;
	unknown?: boolean;
	agent_ref?: string;
	attempt_id?: string;
	binding_revision?: number;
	installation_id?: string;
	ceiling?: {
		tools: string[] | null;
		tools_permit: string[];
		spawn: EngineExecutionConfiguration["dispatch"]["spawn"];
		trusted: boolean | "unknown";
	};
	terminal_known?: boolean;
}

export interface EngineRuntimeOptions {
	databasePath: string;
	/** Reduced only by isolated acceptance fixtures; production uses the bounded defaults. */
	streamAdmissionLimits?: Partial<StreamAdmissionLimits>;
	/** Hosted Core binding. Credentials stay in memory; undefined preserves standalone discovery. */
	mcpServer?: MCPHttpServerConfig;
	childHistoryTtlMinutes?: number;
	childHistoryRetention?: "local" | "off" | "grimoire";
	sessionDefaults?: Omit<
		CreateAgentSessionOptions,
		| "agentId"
		| "agentRegistry"
		| "agentLifecycle"
		| "asyncJobManager"
		| "attemptId"
		| "engineMode"
		| "ircBus"
		| "sessionManager"
		| "spawns"
		| "toolExecutionHook"
	>;
	/** Optional isolated blob store for embedded runtimes/tests; production uses the configured canonical store. */
	attachmentBlobStore?: BlobStore;
	/** Test/integration seam; production uses AgentSession.prompt directly. */
	dispatchPrompt?: (
		session: AgentSession,
		input: string,
		identity?: SessionMessageIdentity,
		kind?: HistoryDispatchKind,
		images?: ImageContent[],
	) => Promise<boolean>;
	/** Device-local routing slots are keyed by this device. */
	deviceId: string;
	/** Materializes the admitted frozen route units; standalone runtimes without it cannot start. */
	resolveExecution?: (
		config: EngineExecutionConfiguration,
		frozen: readonly EngineExecutionRoute[],
		attempt: ExecutionAttemptIdentity,
		cwd: string,
		signal?: AbortSignal,
	) => Promise<ResolvedEngineExecution>;
	/** Resolves the exact server-private origin receipt; no opaque id alone is trusted. */
	verifyOriginReceipt?: (receipt: {
		originReceiptId: string;
		commandId: string;
		agentInstanceRef: string;
		attemptId: string;
		principalId: string;
	}) => Promise<{ verified: true; dispatchHash?: string; commandHash?: string; bindingSnapshot?: EngineSemanticBindingSnapshot; authContextId: string; approvalSettings: { timeout_seconds: number; settings_revision: number; settings_hash: string } | null; specialApproval: { kind: "consultant"; unavailable_pin: unknown; proposed_reselection_hash: string } | null }>;
	verifyApprovalReceipt?: (receipt: {
		originReceiptId: string;
		commandId: string;
		agentInstanceRef: string;
		attemptId: string;
		principalId: string;
	}) => Promise<{ verified: true; approvalDecision: EngineApprovalDecision["approvalDecision"]; expectedInputRevision: number | null }>;
	/** Receipt-backed one-step walk of the requester's exact Start ancestry. */
	approvalAncestor?: (identity: {
		agentInstanceRef: string;
		attemptId: string;
		principalId: string;
		installationId: string;
	}) => Promise<ApprovalAncestor>;
	reserveChild?: (request: {
		parentAgentInstanceRef: string;
		parentAttemptId: string;
		parentBindingSnapshot: EngineSemanticBindingSnapshot;
		principalId: string;
		authorityGeneration: number;
		target: WorkTarget;
		assignment: string;
		toolCallId: string;
		cwd: string;
		signal?: AbortSignal;
	}) => Promise<Extract<ApprovalRequest, { kind: "spawn" }>["subject"]>;
	launchChild?: (request: {
		parentAgentInstanceId: string;
		parentAgentInstanceRef: string;
		parentAttemptId: string;
		parentBindingSnapshot: EngineSemanticBindingSnapshot;
		principalId?: string;
		authorityGeneration: number;
		/** Explicit child target; never copied from the parent's Step. */
		target: WorkTarget;
		assignment: string;
		toolCallId: string;
		cwd: string;
		signal?: AbortSignal;
		spawnApprovalReceiptId?: string;
		enrollChild(agentInstanceRef: string, attemptId?: string): Promise<void>;
	}) => Promise<EngineChildLaunchResult>;
}

type PendingStartResolution = {
	target: Pick<EngineStartRequest, "agentInstanceId" | "executionId" | "attemptId" | "authorityGeneration">;
	controller: AbortController;
};

/** Session archive, restore staging and child-history expiry are deferred for native storage. */
export function nativeArchiveUnsupported(): EngineTargetError {
	return new EngineTargetError("invalid_request", "This archive operation is not supported by native storage");
}

export class EngineRuntime {
	readonly agentRegistry = new AgentRegistry();
	readonly agentLifecycle = new AgentLifecycleManager(this.agentRegistry);
	readonly asyncJobManager = new AsyncJobManager({ requireAttemptId: true });
	readonly ircBus = new IrcBus(this.agentRegistry, this.agentLifecycle);
	readonly engineGeneration: number;
	readonly store: RocksEngineStore;
	readonly attachmentUploads: EngineAttachmentUploads;
	readonly #sessionDefaults: EngineRuntimeOptions["sessionDefaults"];
	readonly #mcpServer: EngineRuntimeOptions["mcpServer"];
	readonly #dispatchPrompt: (
		session: AgentSession,
		input: string,
		identity?: SessionMessageIdentity,
		kind?: HistoryDispatchKind,
		images?: ImageContent[],
	) => Promise<boolean>;
	readonly #resolveExecution: EngineRuntimeOptions["resolveExecution"];
	readonly #verifyOriginReceipt: EngineRuntimeOptions["verifyOriginReceipt"];
	readonly #verifyApprovalReceipt: EngineRuntimeOptions["verifyApprovalReceipt"];
	readonly #approvalAncestor: EngineRuntimeOptions["approvalAncestor"];
	readonly #deviceId: string;
	readonly #launchChild: EngineRuntimeOptions["launchChild"];
	readonly #reserveChild: EngineRuntimeOptions["reserveChild"];
	readonly #childHistoryRetention: "local" | "off" | "grimoire";
	readonly #streamAdmissionLimits: EngineRuntimeOptions["streamAdmissionLimits"];
	readonly #bindings = new Map<string, LiveBinding>();
	readonly #lanes = new Map<string, Promise<void>>();
	readonly #runs = new Set<Promise<void>>();
	readonly #listeners = new Set<EngineEventListener>();
	readonly #toolInvocations = new Map<string, ToolInvocationRecord>();
	readonly #pendingToolApprovals = new Map<string, PendingToolApproval>();
	readonly #pendingEscalations = new Map<string, PromiseWithResolvers<EngineApprovalDecision["approvalDecision"]>>();
	readonly #pendingConsultants = new Map<string, PromiseWithResolvers<"approve" | "deny">>();
	readonly #approvalTimers = new Map<string, NodeJS.Timeout>();
	readonly #retainedApprovals = new Map<string, EngineBindingSnapshot>();
	readonly #recoveryTimers = new Map<string, NodeJS.Timeout>();
	readonly #approvalRoutingWakes = new Set<string>();
	readonly #pendingStarts = new Set<PendingStartResolution>();
	readonly #sessionRoot: string;
	#inboxWakeSignal = Promise.withResolvers<void>();
	#inboxWakeRun?: Promise<void>;
	#nativeDeleteRun?: Promise<void>;
	#disposed = false;
	#storageFailure?: Error;
	#storageFailureUnsubscribe?: () => void;

	private constructor(store: RocksEngineStore, engineGeneration: number, options: EngineRuntimeOptions) {
		this.store = store;
		this.engineGeneration = engineGeneration;
		this.#sessionDefaults = options.sessionDefaults;
		this.#mcpServer = options.mcpServer;
		this.#streamAdmissionLimits = options.streamAdmissionLimits;
		this.#dispatchPrompt =
			options.dispatchPrompt ??
			((session, input, identity, kind = "prompt", images) => {
				if (kind === "continue" && session.messages.at(-1)?.role !== "assistant")
					return session.continueNativeHistory().then(() => true);
				if (kind === "continue_after_assistant" || kind === "continue") {
					return session.prompt(kind === "continue" ? engineContinuePrompt : input, {
						synthetic: true,
						expandPromptTemplates: false,
						attribution: "agent",
					});
				}
				return session.prompt(input, { ...identity, ...(images?.length ? { images } : {}) });
			});
		this.#resolveExecution = options.resolveExecution;
		this.#verifyOriginReceipt = options.verifyOriginReceipt;
		this.#verifyApprovalReceipt = options.verifyApprovalReceipt;
		this.#approvalAncestor = options.approvalAncestor;
		this.#deviceId = options.deviceId;
		this.#launchChild = options.launchChild;
		this.#reserveChild = options.reserveChild;
		const childHistoryTtlMinutes = options.childHistoryTtlMinutes ?? 60;
		if (!Number.isSafeInteger(childHistoryTtlMinutes) || childHistoryTtlMinutes < 1) {
			throw new Error("childHistoryTtlMinutes must be a positive integer");
		}
		this.#childHistoryRetention = options.childHistoryRetention ?? "local";
		this.#sessionRoot = path.join(path.dirname(path.resolve(options.databasePath)), "engine-sessions");
		this.attachmentUploads = new EngineAttachmentUploads(
			path.join(path.dirname(this.#sessionRoot), "engine-uploads"),
			options.attachmentBlobStore ?? new BlobStore(getBlobsDir()),
			store.records,
		);
	}

	/** Live tool ceiling for an addressed ancestor, not the child's approval-required list. */
	canApproveTool(agentInstanceId: string, attemptId: string, toolName: string): boolean {
		const binding = this.#bindings.get(agentInstanceId);
		if (!binding || binding.attemptId !== attemptId || binding.attemptState !== "running" ||
			binding.manualHold || !binding.session.getEnabledToolNames().includes(toolName)) return false;
		const config = binding.execution.config;
		const policy = config.continuationConfiguration;
		if (policy.tools_permit.includes(toolName) || policy.toolPolicies[toolName] === "permit") return false;
		const current = currentIdentity(binding.execution.choice);
		const route = binding.execution.frozen.find(candidate => candidateRef(candidate) === candidateRef(current));
		return Boolean(route?.execution.trusted);
	}
	/** Binding-local grants never cross Attempts; consumption still requires a fresh live-lease proof. */
	approvalGrant(agentInstanceId: string, attemptId: string, kind: "tool" | "spawn", name: string,
		ceilingHash: string, receiptId?: string): string | undefined {
		const binding = this.#bindings.get(agentInstanceId);
		if (!binding || binding.attemptId !== attemptId || binding.attemptState !== "running" ||
			binding.manualHold || !binding.bindingSnapshot) return undefined;
		const dispatch = binding.execution.config.dispatch;
		const current = currentIdentity(binding.execution.choice);
		const route = binding.execution.frozen.find(candidate => candidateRef(candidate) === candidateRef(current));
		const trusted = route?.execution.trusted === true;
		const currentHash = executionHash({
			tools: dispatch.tools, tools_permit: dispatch.tools_permit, spawn: dispatch.spawn, trusted,
		});
		if (currentHash !== ceilingHash || !trusted ||
			(kind === "tool" && !this.canApproveTool(agentInstanceId, attemptId, name)) ||
			(kind === "spawn" && dispatch.spawn.allowed !== "auto"))
			return undefined;
		const key = `${kind}\0${name}`;
		if (receiptId) {
			if (!/^[A-Za-z0-9._:-]{1,160}$/.test(receiptId)) return undefined;
			const old = binding.approvalGrants.get(key);
			if (old && old.receiptId !== receiptId) return undefined;
			binding.approvalGrants.set(key, { receiptId, ceilingHash });
		}
		const grant = binding.approvalGrants.get(key);
		return grant?.ceilingHash === currentHash ? grant.receiptId : undefined;
	}

	async #addressApproval(binding: LiveBinding, kind: ApprovalRequest["kind"], name: string,
		subject?: ApprovalRequest["subject"], timedOut: readonly string[] = []): Promise<ApprovalAddressee | "unknown"> {
		if (kind === "escalation") return { kind: "human", principal_id: binding.principalId };
		if (!binding.bindingSnapshot?.installationId || !this.#approvalAncestor)
			return { kind: "human", principal_id: binding.principalId };
		let agentInstanceRef = binding.bindingSnapshot.agentInstanceRef;
		let attemptId = binding.attemptId;
		let installationId = binding.bindingSnapshot.installationId;
		const visited = new Set<string>([attemptId]);
		for (let distance = 1; distance <= 256; distance++) {
			let next: ApprovalAncestor;
			try {
				next = await this.#approvalAncestor({
					agentInstanceRef, attemptId, principalId: binding.principalId,
					installationId,
				});
			} catch {
				return "unknown";
			}
			if (next.unknown || (!next.root && (!next.agent_ref || !next.attempt_id || !next.ceiling || !next.installation_id)))
				return "unknown";
			if (next.root) return { kind: "human", principal_id: binding.principalId };
			if (visited.has(next.attempt_id!)) return "unknown";
			visited.add(next.attempt_id!);
			agentInstanceRef = next.agent_ref!;
			attemptId = next.attempt_id!;
			installationId = next.installation_id!;
			const ceiling = next.ceiling!;
			if (ceiling.trusted === "unknown") return "unknown";
			const canTool = (ceiling.tools === null || ceiling.tools.includes(name)) &&
				!ceiling.tools_permit.includes(name) && ceiling.trusted;
			const capable = kind === "tool" || kind === "consultant"
				? canTool : kind === "spawn" && subject && "requested_child_ordinal" in subject &&
					ceiling.spawn.allowed === "auto" && ceiling.spawn.max_depth >= distance + 1 &&
					subject.requested_child_ordinal <= ceiling.spawn.max_children;
			if (capable && !next.terminal_known && !timedOut.includes(attemptId))
				return { kind: "attempt", agent_ref: agentInstanceRef, attempt_id: attemptId };
		}
		return "unknown";
	}

	/** Verify current CH authority for every non-Start command before local admission or side effects. */
	async verifyCommandOrigin(command: EngineCommandEnvelope): Promise<void> {
		if (command.op === "start") return; // Start verifies its dispatch and binding in #startInLane.
		if (!this.#verifyOriginReceipt) throw new EngineTargetError("source_unavailable", "Verified command origin is required");
		const { originReceiptId: ignored, ...payload } = command.payload;
		if (typeof ignored !== "string" || !ignored || !command.agentInstanceRef || !command.attemptId || !command.principalId)
			throw new EngineTargetError("invalid_request", "Command requires an exact origin receipt and Attempt identity");
		const commandHash = `sha256:${crypto.createHash("sha256").update(storageCanonicalJson({ ...command, payload })).digest("hex")}`;
		const origin = await this.#verifyOriginReceipt({
			originReceiptId: ignored, commandId: command.commandId, agentInstanceRef: command.agentInstanceRef,
			attemptId: command.attemptId, principalId: command.principalId,
		});
		if (origin.verified !== true || origin.commandHash !== commandHash || !origin.authContextId)
			throw new EngineTargetError("stale_target", "Command origin differs from its exact frozen envelope");
	}

	/** Re-verify origin and the current member of this Attempt's immutable frozen list. */
	async #resumeRouting(binding: LiveBinding): Promise<AdmissionRequest> {
		if (!binding.bindingSnapshot || !this.#verifyOriginReceipt)
			throw new EngineTargetError("stale_target", "Resume requires an admitted hosted binding");
		const original = await this.store.getStartConversationIdentity(binding.commandId);
		const start = original?.serializedCommand
			? JSON.parse(original.serializedCommand) as { payload?: { originReceiptId?: string } }
			: undefined;
		const originReceiptId = start?.payload?.originReceiptId;
		if (!originReceiptId) throw new EngineTargetError("stale_target", "Original Start origin is missing");
		const origin = await this.#verifyOriginReceipt({
			originReceiptId, commandId: binding.commandId,
			agentInstanceRef: binding.bindingSnapshot.agentInstanceRef,
			attemptId: binding.attemptId, principalId: binding.principalId,
		});
		if (origin.verified !== true || origin.dispatchHash !== binding.dispatchHash ||
			!origin.bindingSnapshot || !sameSemanticBinding(origin.bindingSnapshot, binding.bindingSnapshot) ||
			!origin.authContextId)
			throw new EngineTargetError("stale_target", "Resume origin or semantic binding changed");
		const config = binding.execution.config;
		const current = currentIdentity(binding.execution.choice);
		const candidate = binding.execution.frozen.find(route =>
			candidateRef(route) === candidateRef(current) &&
			route.billing_pools.some(pool => pool.pool_id === current.billing_pool_id));
		if (!candidate || (config.dispatch.requirement.require_trusted_provider && !candidate.execution.trusted))
			throw new EngineTargetError("stale_target", "Current executor is outside the admitted frozen choices");
		const request: AdmissionRequest = {
			principalId: binding.principalId, deviceId: this.#deviceId, engineGeneration: this.engineGeneration,
			commandId: binding.commandId, agentInstanceRef: binding.bindingSnapshot.agentInstanceRef,
			attemptId: binding.attemptId, dispatchId: config.dispatch.dispatch_id,
			dispatchRef: binding.dispatchRef, dispatchHash: binding.dispatchHash, originReceiptId,
			authContextId: origin.authContextId, bindingSnapshot: binding.bindingSnapshot,
			executionKind: config.dispatch.execution_kind, limits: config.routingLimits,
			rosterRevision: config.roster_revision, expectedRevisions: config.record_revisions,
			candidates: [{ ...candidate, billing_pool_id: current.billing_pool_id,
				billing_pool_basis: current.billing_pool_basis }], callerAttemptId: null, frozen: true,
		};
		return request;
	}

	#armLeaseHeartbeat(binding: LiveBinding): void {
		clearInterval(binding.leaseHeartbeat);
		let renewing = false;
		const heartbeat = setInterval(() => {
			if (renewing) return;
			renewing = true;
			void this.store.renewRouting(binding.attemptId, this.engineGeneration)
				.then(held => {
					if (!held) throw new EngineTargetError("stale_target", "Routing lease disappeared");
				})
				.catch(error => {
					if (binding.attemptState !== "paused" && !TERMINAL_ATTEMPT_STATES.has(binding.attemptState))
						binding.session.agent.abort(error instanceof Error ? error : new Error(String(error)));
				})
				.finally(() => { renewing = false; });
		}, LEASE_HEARTBEAT_MS);
		heartbeat.unref?.();
		binding.leaseHeartbeat = heartbeat;
	}

	static async create(options: EngineRuntimeOptions): Promise<EngineRuntime> {
		const binding = readStorageBinding();
		if (!binding) throw new Error("Engine requires the ClientHost storage binding (GRIMOIRE_STORAGE_BINDING)");
		const store = new RocksEngineStore(new StorageClient(binding));
		const engineGeneration = await store.nextEngineGeneration();
		const runtime = new EngineRuntime(store, engineGeneration, options);
		await runtime.attachmentUploads.sweepAbandoned();
		runtime.#nativeDeleteRun = store.reconcilePendingNativeDeletes().catch(error => {
			logger.warn("Native generation deletion recovery failed", { error: String(error) });
		});
		runtime.#attachStorageFailure();
		await runtime.#reconcileLostAttempts();
		runtime.#inboxWakeRun = runtime.#runInboxWakeLoop();
		return runtime;
	}

	#nativeSessionStorage(locator: string): RocksNativeSessionStorage {
		const { familyId, generationId } = parseNativeSessionLocator(locator);
		return new RocksNativeSessionStorage(this.store.storageClient, familyId, generationId);
	}

	async #sessionHeader(locator: string): Promise<SessionHeader | undefined> {
		return (await readNativeHeader(this.store.storageClient, parseNativeSessionLocator(locator))).header;
	}

	async #readSessionMessages(locator: string) {
		const manager = await SessionManager.openNative(this.#nativeSessionStorage(locator));
		return manager.buildSessionContext({ transcript: true, collapseCompactedHistory: true }).messages;
	}

	subscribe(listener: EngineEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	verifyInstallation(installationId: string, principalId: string): void {
		this.store.verifyInstallation(installationId, principalId);
		this.#signalInboxWake();
	}

	async finishSemanticBinding(action: "activate" | "abort", result: EngineBindingResult): Promise<EngineBindingGate> {
		const gate = await this.#inLane(engineAgentInstanceId(result.agent_ref),
			() => this.store.bindingTransition(action, result));
		this.#signalInboxWake();
		return gate;
	}

	prepareSemanticBinding(gate: EngineBindingGate): Promise<EngineBindingGate> {
		return this.#inLane(engineAgentInstanceId(gate.bindingSnapshot.agentInstanceRef),
			() => this.store.bindingPrepare(gate));
	}

	async adoptSemanticBinding(gate: EngineBindingGate, result: EngineBindingResult): Promise<EngineBindingGate> {
		const id = engineAgentInstanceId(result.agent_ref);
		return this.#inLane(id, async () => {
			const live = this.#bindings.get(id);
			const current = await this.store.semanticGate(id);
			const ownsGate = current?.operationId === result.operation_id && current.proposalHash === result.proposal_hash;
			if (ownsGate && live && (live.state === "running" || live.session.isStreaming))
				throw new EngineBindingPendingError("Binding adoption requires an idle session");
			const adopted = await this.store.bindingTransition("adopt", result, gate);
			if (ownsGate && live) await this.#terminateBinding(live, "requested");
			return adopted;
		});
	}

	getBinding(agentInstanceId: string): EngineBindingSnapshot | undefined {
		const binding = this.#bindings.get(agentInstanceId);
		return binding ? this.#snapshot(binding) : undefined;
	}

	listBindings(): EngineBindingSnapshot[] {
		return [...this.#bindings.values()].map(binding => this.#snapshot(binding));
	}

	resolveBrokerAgent(
		engineAgentId: string,
	): Pick<LiveBinding, "agentInstanceId" | "executionId" | "attemptId" | "authorityGeneration"> | undefined {
		let current = engineAgentId;
		const seen = new Set<string>();
		let binding: LiveBinding | undefined;
		while (!seen.has(current)) {
			seen.add(current);
			binding = [...this.#bindings.values()].find(candidate => candidate.engineAgentId === current);
			if (binding) break;
			const parent = this.agentRegistry.get(current)?.parentId;
			if (!parent) return undefined;
			current = parent;
		}
		return binding
			? {
					agentInstanceId: engineAgentId === binding.engineAgentId ? binding.agentInstanceId : engineAgentId,
					executionId: binding.executionId,
					attemptId: binding.attemptId,
					authorityGeneration: binding.authorityGeneration,
				}
			: undefined;
	}

	resolveEngineAgentId(agentInstanceId: string): string | undefined {
		const binding = this.#bindings.get(agentInstanceId);
		if (binding) return binding.engineAgentId;
		return this.agentRegistry.get(agentInstanceId)?.id;
	}

	start(request: EngineStartRequest): Promise<EngineStartResult> {
		validateStartRequest(request);
		request = { ...request, bindingSnapshot: { ...request.bindingSnapshot } };
		if (request.attachmentUploadIds !== undefined) {
			const references = this.#messageAttachments(request);
			request = { ...request, attachmentUploadIds: references!.uploadIds };
		}
		const laneIds = request.historyEdit
			? [request.agentInstanceId, request.historyEdit.source.agentInstanceId]
			: [request.agentInstanceId];
		const pending: PendingStartResolution = {
			target: {
				agentInstanceId: request.agentInstanceId,
				executionId: request.executionId,
				attemptId: request.attemptId,
				authorityGeneration: request.authorityGeneration,
			},
			controller: new AbortController(),
		};
		this.#pendingStarts.add(pending);
		const audit = createLatencyAudit({
			commandId: request.commandId,
			clientMessageId: request.clientMessageId,
			agentInstanceId: request.agentInstanceId,
			attemptId: request.attemptId,
			executionId: request.executionId,
		});
		audit?.mark("start_enter");
		return this.#inLanes(laneIds, () => {
			audit?.mark("lane_ready");
			return this.#startInLane(request, pending.controller.signal, audit);
		})
			.catch(async error => {
				audit?.mark("start_error");
				if (
					error instanceof EngineTargetError &&
					(error.code === "agent_busy" || error.code === "stale_target") &&
					request.queueId &&
					request.expectedRevision !== undefined &&
					(await this.store.rearmInboxWake(request.queueId, request.expectedRevision))
				) {
					this.#signalInboxWake();
				}
				throw error;
			})
			.finally(() => {
				this.#pendingStarts.delete(pending);
				audit?.finish("start_settled");
			});
	}

	steer(request: EngineSteerRequest): Promise<EngineControlResult> {
		validateCommandContext(request.context);
		const queued = request.queueId !== undefined;
		if (request.attachmentUploadIds !== undefined) {
			if (queued) throw new EngineTargetError("invalid_request", "Queued steer uses its retained attachments");
			request = { ...request, attachmentUploadIds: this.#messageAttachments(request)!.uploadIds };
		}
		if (
			!request.commandId.trim() ||
			(request.clientMessageId !== undefined &&
				(!request.clientMessageId.trim() || request.clientMessageId.length > 200)) ||
			(queued
				? !request.queueId?.trim() ||
					!request.mutationId?.trim() ||
					!Number.isSafeInteger(request.expectedRevision) ||
					request.expectedRevision! < 0 ||
					!Number.isSafeInteger(request.expectedIntentRevision) ||
					request.expectedIntentRevision! < 0 ||
					request.message !== undefined
				: (!request.message?.trim() && !request.attachmentUploadIds?.length) ||
					request.mutationId !== undefined ||
					request.expectedRevision !== undefined)
		) {
			throw new EngineTargetError("invalid_request", "steer requires text or a complete queued-item identity");
		}
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = await this.#requireCancelableTarget(request);
			if (!binding) {
				throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is no longer active`);
			}
			if (binding.steerCommandSet.has(request.commandId)) return this.#controlResult(binding);
			await this.store.assertIntent(request.agentInstanceId, request.expectedIntentRevision, true);
			const steerableState = binding.attemptState === "running";
			if (binding.state !== "running" || !steerableState || binding.manualHold || !binding.session.isStreaming) {
				throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is not streaming`);
			}
			const item = queued ? await this.store.getInboxItem(binding.session.sessionId, request.queueId!) : undefined;
			if (queued && (item?.disposition !== "pending" || item.revision !== request.expectedRevision)) {
				throw new EngineTargetError(
					"stale_target",
					`Inbox item ${request.queueId} is no longer pending at that revision`,
				);
			}
			if (item && request.clientMessageId !== undefined && request.clientMessageId !== item.sourceEventId)
				throw new EngineTargetError(
					"invalid_request",
					"Queued delivery clientMessageId must match the retained message",
				);
			const references = item?.attachments ?? this.#messageAttachments(request);
			const preparedAttachments = references
				? await this.attachmentUploads.prepareForMessage(
						item?.sourceEventId ?? request.clientMessageId!,
						references,
						undefined,
						item?.attachmentDescriptors,
					)
				: undefined;
			const images = preparedAttachments?.images;
			this.#assertAttachmentSupport(binding.session, images, preparedAttachments?.originalAttachments);
			if (binding.state !== "running" || !binding.session.isStreaming)
				throw new EngineTargetError(
					"too_late",
					"The Attempt stopped streaming while attachments were being prepared",
				);
			const routingResume = binding.attemptState === "paused" ? await this.#resumeRouting(binding) : undefined;
			const previousIntent = this.#setManualHold(binding, request.commandId, request.expectedIntentRevision, false);
			const previousState = binding.attemptState;
			const result = this.#controlResult(
				binding,
				item ? "consumed" : "applied",
				item ? { ...item, revision: item.revision + 1 } : undefined,
			);
			if (references && !item?.attachments) binding.directUploads.set(request.clientMessageId!, references);
			try {
				await binding.session.steer(
					item?.deliveryPayload ?? request.message ?? "",
					images,
					{
						sourceCommandId: request.commandId,
						...(preparedAttachments ? { originalAttachments: preparedAttachments.originalAttachments } : {}),
						...(request.clientMessageId
							? { clientMessageId: request.clientMessageId }
							: item?.sourceType === "user"
								? { clientMessageId: item.sourceEventId }
								: {}),
					},
					request.context
						? {
								customType: "engine-command-context",
								content: request.context,
								display: false,
								details: { sourceCommandId: request.commandId },
							}
						: undefined,
				);
				binding.attemptState = "running";
				await this.#commitAttemptTransition(
					binding,
					"running",
					[
						...(previousState === "paused"
							? [
									{
										kind: "resumed" as const,
										payload: controlPayload({ kind: "human" }, "running", false, binding),
										causationCommandId: request.commandId,
									},
								]
							: []),
						{ kind: "steered", causationCommandId: request.commandId },
					],
					{
						expectedStates: [previousState],
						...(routingResume ? { routingResume } : {}),
						settleCommandId: request.commandId,
						settleCommandReceipt: { outcome: "applied", detail: result },
						...(item
							? {
									inboxSessionId: binding.session.sessionId,
									inboxMutation: {
										mutationId: request.mutationId!,
										queueId: item.queueId,
										expectedRevision: request.expectedRevision!,
										op: "acknowledge" as const,
									},
									inboxMutationCausationCommandId: request.commandId,
								}
							: {}),
					},
				);
			} catch (error) {
				binding.attemptState = previousState;
				this.#restoreIntent(binding, previousIntent);
				if (queued && error instanceof EngineInboxConflictError) {
					throw new EngineTargetError("stale_target", error.message);
				}
				throw error;
			}
			binding.steerCommandIds.push(request.commandId);
			binding.steerCommandSet.add(request.commandId);
			const evicted = binding.steerCommandIds.length > 256 ? binding.steerCommandIds.shift() : undefined;
			if (evicted) binding.steerCommandSet.delete(evicted);
			if (previousState === "paused") binding.pauseGate.resume();
			this.#signalInboxWake();
			return result;
		});
	}

	pause(request: EngineControlRequest): Promise<EngineControlResult> {
		validateControlRequest(request);
		if (request.message !== undefined || request.clientMessageId !== undefined || request.attachmentUploadIds !== undefined)
			throw new EngineTargetError("invalid_request", "Only resume accepts a user message");
		return this.#branchControl(request, "pause");
	}

	resume(request: EngineControlRequest): Promise<EngineControlResult> {
		validateControlRequest(request);
		validateCommandContext(request.context);
		const message = request.message !== undefined || request.clientMessageId !== undefined || request.attachmentUploadIds !== undefined;
		if (message) {
			validateRuntimeValue("composerText", request.message);
			validateRuntimeValue("id", request.clientMessageId);
			if (
				(!request.message?.trim() && !request.attachmentUploadIds?.length) ||
				!request.principalId?.trim() ||
				request.expectedIntentRevision === undefined
			) throw new EngineTargetError("invalid_request", "Resume message requires text or uploads, principal and intent revision");
		}
		if (!message) return this.#branchControl(request, "resume");
		return (async () => {
			// A pause_requested turn may still be appending its answer; wait outside the
			// branch lane so its safe-point checkpoint can finish before the new user entry.
			for (;;) {
				const binding = this.#bindings.get(request.agentInstanceId);
				if (binding?.attemptId !== request.attemptId || binding.attemptState !== "pause_requested") break;
				const changed = this.store.changeSignal();
				if (binding.attemptState === "pause_requested")
					await Promise.race([changed, binding.pauseProgress.promise]);
			}
			return this.#branchControl(request, "resume");
		})();
	}

	cancel(request: EngineCancelRequest): Promise<EngineControlResult> {
		validateStartFence(request);
		if ("message" in request || "clientMessageId" in request || "attachmentUploadIds" in request)
			throw new EngineTargetError("invalid_request", "Stop cannot carry a user message");
		return this.#branchControl(request, "stop");
	}

	#branchControl(
		request: EngineControlRequest | EngineCancelRequest,
		action: "pause" | "resume" | "stop",
		settleCommand = true,
	): Promise<EngineControlResult> {
		if (!request.commandId.trim()) throw new EngineTargetError("invalid_request", "commandId is required");
		return this.#inLane(request.agentInstanceId, async () => {
			this.#throwIfDisposed();
			const durable = await this.store.getBinding(request.agentInstanceId);
			const attempt = await this.store.getAttemptTarget(request.attemptId);
			if (!durable || !attempt) throw new EngineTargetError("agent_not_found", "Unknown branch target");
			const ownership = action === "resume" ? await this.store.resumeOwnership(request.commandId, request.agentInstanceId) : undefined;
			const resumedIntent = ownership !== undefined &&
				(request.expectedIntentRevision === undefined || ownership.intentRevision === request.expectedIntentRevision + 1);
			if ((!resumedIntent && durable.attemptId !== request.attemptId) || !this.#attemptMatchesTarget(attempt, request))
				throw new EngineTargetError("stale_target", "Branch target is stale");
			const root = this.#bindings.get(request.agentInstanceId);
			if (
				root &&
				((action === "pause" && root.pauseCommandIds.has(request.commandId)) ||
					(action === "resume" && root.resumeCommandIds.has(request.commandId)) ||
					(action === "stop" &&
						root.intentCommandId === request.commandId &&
						["cancel_requested", "cancelled"].includes(root.attemptState)))
			)
				return this.#controlResult(root);
			if (
				["completed", "cancelled", "failed", "interrupted"].includes(attempt.state) &&
				request.expectedIntentRevision === undefined && !resumedIntent
			)
				throw new EngineTargetError("too_late", "Terminal branch control requires an intent revision");
			const startFence =
				action === "stop" && "pendingStartCommandId" in request && request.pendingStartCommandId
					? (request as EngineCancelRequest)
					: undefined;
			const resumeMessage = action === "resume" && "message" in request && request.message !== undefined;
			const recoveringAcceptedMessage = action === "resume" && !resumeMessage &&
				root?.pendingPausedMessage !== undefined && root.attemptState === "running" && attempt.state === "paused";
			if (!startFence && !resumedIntent)
				await this.store.assertIntent(request.agentInstanceId, request.expectedIntentRevision);
			if (
				action === "resume" &&
				(!resumedIntent && (!root || (!recoveringAcceptedMessage &&
					!["paused", "pause_requested", "waiting_input"].includes(root.attemptState))))
			)
				throw new EngineTargetError(
					"too_late",
					"Only a paused Attempt can resume; interrupted execution requires Continue",
				);
			if (resumeMessage) {
				if (!root || root.attemptId !== request.attemptId || (!resumedIntent && root.attemptState !== "paused") || root.pendingInput ||
					[...this.#pendingToolApprovals.values()].some(pending => pending.record.target.bindingId === root.bindingId))
					throw new EngineTargetError("too_late", "A paused Attempt without pending input or approval is required");
				const intent = await this.store.intent(request.agentInstanceId);
				if (resumedIntent
					? intent.holds.length > 0
					: !intent.holds.some(hold => hold.kind === "pause" && hold.sourceAgentInstanceId === request.agentInstanceId) ||
						intent.holds.some(hold => hold.kind !== "pause" || hold.sourceAgentInstanceId !== request.agentInstanceId))
					throw new EngineTargetError("agent_busy", "Another branch hold prevents message resume");
				if (!root.resumeMessageCommands.has(request.commandId)) {
					const references = this.#messageAttachments(request);
					const prepared = references
						? await this.attachmentUploads.prepareForMessage(request.clientMessageId!, references)
						: undefined;
					this.#assertAttachmentSupport(root.session, prepared?.images, prepared?.originalAttachments);
					await this.store.assertIntent(request.agentInstanceId, request.expectedIntentRevision);
					if (references) root.directUploads.set(request.clientMessageId!, references);
					const identity: SessionMessageIdentity = {
						sourceCommandId: request.commandId,
						clientMessageId: request.clientMessageId,
						...(prepared ? { originalAttachments: prepared.originalAttachments } : {}),
					};
					await root.session.steer(
						request.message!,
						prepared?.images,
						identity,
						request.context
							? {
									customType: "engine-command-context",
									content: request.context,
									display: false,
									details: { sourceCommandId: request.commandId },
								}
							: undefined,
						true,
					);
					root.resumeMessageCommands.add(request.commandId);
					root.pendingPausedMessage = { input: request.message!, identity, images: prepared?.images };
				}
			}
			let changed: { agentIds: string[]; events: EngineEvent[]; intentRevision: number;
				superseded: boolean; parents: Map<string, string | null>; targets: Map<string, ResumeMember> } | undefined;
			const changeIntent = async () => {
				try {
					changed = await this.store.branchIntent(
						request.agentInstanceId,
						request.commandId,
						action,
						request.expectedIntentRevision,
						startFence,
					);
				} catch (error) {
					if (resumeMessage)
						throw new EngineTargetError("message_accepted_resume_unknown", "User message was accepted; resume outcome is unknown");
					throw error;
				}
			};
			if (action === "resume" && !resumedIntent && root && "context" in request && request.context && !resumeMessage)
				await this.#sendCommandContext(root, request.context, request.commandId, changeIntent);
			else await changeIntent();
			if (!changed) throw new Error("Command context returned without applying its intent boundary");
			this.#notifyEvents(changed.events);
			if (action === "stop") {
				const descendants = new Set(changed.agentIds);
				for (const pending of this.#pendingStarts) {
					if (descendants.has(pending.target.agentInstanceId))
						pending.controller.abort(new EngineTargetError("cancelled", "Engine branch stopped"));
				}
			}
			let queued: EngineRoutingQueuedError | EngineBindingPendingError | undefined;
			let superseded = changed.superseded;
			const blockedAncestors = new Set<string>();
			const apply = async (agentId: string) => {
				const saved = changed!.targets.get(agentId);
				if (action === "resume" && saved) {
					const original = await this.store.getAttempt(saved.attemptId);
					if (original && TERMINAL_ATTEMPT_STATES.has(original.state)) return;
				}
				const binding = this.#bindings.get(agentId);
				if (!binding) {
					const retained = await this.store.getBinding(agentId);
					if (action === "resume" && retained &&
						(await this.store.getAttempt(retained.attemptId))?.state === "paused")
						throw new EngineTargetError("stale_target", "Paused branch member requires its live Resume Attempt");
					return;
				}
				const retained = await this.store.getBinding(agentId);
				if (action === "resume" && (!saved || !retained ||
					retained.attemptId !== saved.attemptId || retained.bindingId !== saved.bindingId ||
					retained.executionId !== saved.executionId || retained.engineGeneration !== saved.engineGeneration ||
					retained.bindingGeneration !== saved.bindingGeneration || retained.authorityGeneration !== saved.authorityGeneration ||
					!sameSemanticBinding(retained.bindingSnapshot, saved.bindingSnapshot) ||
					retained.intentCommandId !== request.commandId || retained.intentRevision !== saved.intentRevision)) {
					superseded = true;
					return;
				}
				const intent = await this.store.intent(agentId);
				if (action === "resume" && intent.intentRevision !== saved!.intentRevision) {
					superseded = true;
					return;
				}
				binding.intentRevision = intent.intentRevision;
				binding.manualHold = intent.manualHold;
				binding.intentCommandId = request.commandId;
				if (action === "resume" && blockedAncestors.has(agentId)) {
					await this.store.cancelPausedRouting(binding.attemptId, request.commandId, this.engineGeneration);
					return;
				}
				if (action !== "resume") await this.store.cancelPausedRouting(binding.attemptId);
				if (["completed", "cancelled", "failed", "interrupted"].includes(binding.attemptState)) return;
				const initiator = "initiator" in request ? request.initiator : { kind: "human" as const };
				if (action === "stop") {
					if (binding.attemptState === "cancel_requested") return;
					const previous = binding.attemptState;
					const reason =
						"reason" in request ? (request.reason ?? "Engine branch stopped") : "Engine branch stopped";
					binding.attemptState = "cancel_requested";
					await this.#commitAttemptTransition(
						binding,
						"cancel_requested",
						[{ kind: "cancel_requested", causationCommandId: request.commandId, payload: { reason } }],
						{ expectedStates: [previous] },
					);
					await this.#cancelToolApprovals(binding, reason, request.commandId);
					this.asyncJobManager.cancelAll({ ownerId: binding.engineAgentId, attemptId: binding.attemptId });
					await this.#cancelPendingInput(binding, reason, request.commandId);
					const abort = binding.session.abort({ reason });
					binding.pauseGate.resume();
					this.#notifyPauseProgress(binding);
					this.#trackRun(
						this.#finishCancel(
							binding,
							{ ...this.#snapshot(binding), commandId: request.commandId, reason },
							abort,
						),
					);
				} else if (binding.manualHold) {
					binding.pauseGate.pause();
					binding.pauseRequests.set(request.commandId, initiator);
					binding.pauseCommandIds.add(request.commandId);
					if (binding.attemptState !== "paused" && binding.attemptState !== "pause_requested") {
						const previous = binding.attemptState;
						binding.attemptState = "pause_requested";
						await this.#commitAttemptTransition(
							binding,
							"pause_requested",
							[
								{
									kind: "pause_requested",
									causationCommandId: request.commandId,
									payload: controlPayload(initiator, "pause_requested", false, binding),
								},
							],
							{ expectedStates: [previous] },
						);
						this.#trackRun(this.#finishPause(binding, binding.attemptId));
					}
				} else if (action === "resume") {
					if ((binding.attemptState === "paused" || binding.attemptState === "pause_requested") && binding.approvalPauseCause) {
						if (binding.attemptState === "pause_requested")
							throw new EngineBindingPendingError("Branch Resume awaits its retained approval pause");
						const approvals = await this.store.durableApprovalPause(binding.attemptId);
						if (!approvals || approvals.some(approval =>
							approval.status !== "approved" && approval.status !== "denied"))
							throw new EngineBindingPendingError("Branch Resume awaits its retained approval decision");
					}
					const previous = resumedIntent || (recoveringAcceptedMessage && agentId === request.agentInstanceId)
						? (await this.store.getAttemptTarget(binding.attemptId))?.state ?? binding.attemptState
						: binding.attemptState;
					binding.attemptState = binding.pendingInput ? "waiting_input" : "running";
					if (previous !== binding.attemptState && !["completed", "cancelled", "failed", "interrupted"].includes(previous)) {
						try {
							await this.#commitAttemptTransition(
								binding,
								binding.attemptState,
								[
									{
										kind: "resumed",
										causationCommandId: request.commandId,
										payload: controlPayload(initiator, binding.attemptState, false, binding),
									},
								],
								{ expectedStates: [previous],
									intentGuard: { expectedRevision: intent.intentRevision, requireUnheld: true,
										commandId: request.commandId },
									...(previous === "paused" ? { routingResume: await this.#resumeRouting(binding) } : {}) },
							);
						} catch (error) {
							binding.attemptState = previous;
							throw error;
						}
					}
					binding.pauseRequests.clear();
					binding.pauseGate.resume();
					this.#notifyPauseProgress(binding);
					if (binding.attemptState === "running") {
						for (const [id, pending] of this.#pendingToolApprovals) {
							if (pending.record.target.bindingId !== binding.bindingId ||
								(await this.store.getApproval(id))?.request.status !== "approved") continue;
							const effect = await this.store.getEffect(id);
							if (effect?.state === "planned")
								this.#notifyEvents([await this.store.activateApprovedToolEffect(this.#snapshot(binding), id)]);
							this.#pendingToolApprovals.delete(id);
							pending.resolve({ decision: "approve",
								receiptId: (await this.store.getApproval(id))?.decision_record?.origin_receipt_id });
						}
					}
				}
			};
			try {
				const members = action === "resume" ? [...changed.agentIds].reverse() : changed.agentIds;
				for (const id of members) {
					try {
						if (id === request.agentInstanceId) await apply(id);
						else await this.#inLane(id, () => apply(id));
					} catch (error) {
						if (!(error instanceof EngineRoutingQueuedError) && !(error instanceof EngineBindingPendingError)) throw error;
						queued ??= error;
						let ancestor = changed.parents.get(id);
						while (ancestor && !blockedAncestors.has(ancestor)) {
							blockedAncestors.add(ancestor);
							ancestor = changed.parents.get(ancestor);
						}
					}
				}
				if (queued) throw queued;
				if (superseded)
					throw new EngineTargetError("stale_target", "Branch Resume was partially superseded by a newer intent",
						{ partial: true, superseded: true });
			} catch (error) {
				if (resumeMessage && !(error instanceof EngineRoutingQueuedError) && !(error instanceof EngineBindingPendingError))
					throw new EngineTargetError("message_accepted_resume_unknown", "User message was accepted; resume outcome is unknown");
				throw error;
			}
			this.#signalInboxWake();
			const intent = await this.store.intent(request.agentInstanceId).catch(error => {
				if (resumeMessage)
					throw new EngineTargetError("message_accepted_resume_unknown", "User message was accepted; resume outcome is unknown");
				throw error;
			});
			const result: EngineControlResult = {
				phase: "applied",
				manualHold: intent.manualHold,
				intentRevision: intent.intentRevision,
				...(["completed", "cancelled", "failed", "interrupted"].includes(attempt.state)
					? { alreadyTerminal: true as const }
					: {}),
			};
			try {
				await this.store.commitBindingEvent(
					{
						...durable,
						manualHold: intent.manualHold,
						intentRevision: intent.intentRevision,
						intentCommandId: request.commandId,
					},
					{ kind: "holds_changed", causationCommandId: request.commandId, payload: { action, ...result } },
					settleCommand ? { commandId: request.commandId, receipt: { outcome: "applied", detail: result } } : undefined,
				);
			} catch (error) {
				if (resumeMessage)
					throw new EngineTargetError("message_accepted_resume_unknown", "User message was accepted; resume outcome is unknown");
				throw error;
			}
			if (action === "resume" && root) root.resumeCommandIds.add(request.commandId);
			return result;
		});
	}

	async cancelPendingStart(request: {
		commandId: string;
		agentInstanceId: string;
		executionId: string;
		attemptId: string;
		authorityGeneration: number;
		engineGeneration: number;
		reason?: string;
		expectedIntentRevision?: number;
		pendingStartCommandId?: string;
		expectedStartIntentRevision?: number;
		principalId?: string;
	}): Promise<Record<string, unknown>> {
		validateStartFence(request);
		if (!request.commandId.trim()) {
			throw new EngineTargetError("invalid_request", "commandId must be a non-empty string");
		}
		this.#throwIfDisposed();
		if (request.engineGeneration !== this.engineGeneration) {
			throw new EngineTargetError("stale_target", `Engine generation ${request.engineGeneration} is stale`);
		}
		const cancelStartedAttempt = async (): Promise<EngineControlResult | undefined> => {
			const binding = await this.store.getBinding(request.agentInstanceId);
			if (!binding) return undefined;
			if (
				binding.executionId !== request.executionId ||
				binding.attemptId !== request.attemptId ||
				binding.authorityGeneration !== request.authorityGeneration ||
				binding.engineGeneration !== request.engineGeneration
			)
				return undefined;
			return await this.cancel({
				...binding,
				commandId: request.commandId,
				reason: request.reason,
				expectedIntentRevision: request.expectedIntentRevision,
				pendingStartCommandId: request.pendingStartCommandId,
				expectedStartIntentRevision: request.expectedStartIntentRevision,
				principalId: request.principalId,
			});
		};
		const cancelled = await this.store.cancelPendingStart(request, request.commandId);
		if (cancelled.event) this.#notifyEvents([cancelled.event]);
		if (cancelled.status === "cancelled" || cancelled.status === "already_cancelled") {
			const reason = request.reason ?? "Engine pending start cancelled";
			for (const pending of this.#pendingStarts) {
				if (
					pending.target.agentInstanceId === request.agentInstanceId &&
					pending.target.executionId === request.executionId &&
					pending.target.attemptId === request.attemptId &&
					pending.target.authorityGeneration === request.authorityGeneration
				) {
					pending.controller.abort(new Error(reason));
				}
			}
			return {
				phase: "applied",
				preStart: true,
				manualHold: true,
				...(cancelled.intentRevision !== undefined ? { intentRevision: cancelled.intentRevision } : {}),
			};
		}
		if (cancelled.status === "too_late") {
			const racedLiveResult = await cancelStartedAttempt();
			if (racedLiveResult) return racedLiveResult;
			throw new EngineTargetError("too_late", `Attempt ${request.attemptId} has already started or settled`);
		}
		throw new EngineTargetError("agent_not_found", `Unknown pending Attempt ${request.attemptId}`);
	}

	resolveApproval(request: EngineApprovalDecision): Promise<void> {
		const decision = request.approvalDecision;
		validateRuntimeValue("approvalDecision", decision);
		const verifyReceipt = this.#verifyApprovalReceipt;
		if (!request.commandId.trim() || decision.command_id !== request.commandId || !verifyReceipt)
			throw new EngineTargetError("invalid_request", "A verified approval decision and command are required");
		return this.#inLane(request.agentInstanceId, async () => {
			const live = this.#bindings.get(request.agentInstanceId);
			const binding = live ? this.#requireTarget(request) : this.#retainedApprovals.get(request.agentInstanceId);
			if (!binding || binding.bindingId !== request.bindingId ||
				binding.engineGeneration !== request.engineGeneration ||
				binding.bindingGeneration !== request.bindingGeneration ||
				binding.executionId !== request.executionId ||
				binding.attemptId !== request.attemptId ||
				binding.authorityGeneration !== request.authorityGeneration)
				throw new EngineTargetError("stale_target", "Approval target is not the retained requester Attempt");
			const pending = this.#pendingToolApprovals.get(decision.request_id);
			const approval = await this.store.getApproval(decision.request_id);
			if (!binding.bindingSnapshot || approval?.state !== "pending" ||
				approval.request.requester_attempt_id !== binding.attemptId ||
				approval.request.requester_agent_ref !== binding.bindingSnapshot.agentInstanceRef ||
				approval.request.principal_id !== decision.decided_by.principal_id)
				throw new EngineTargetError("stale_target", "Approval requester or principal changed");
			const verified = await verifyReceipt({
				originReceiptId: decision.origin_receipt_id,
				commandId: request.commandId,
				agentInstanceRef: binding.bindingSnapshot.agentInstanceRef,
				attemptId: binding.attemptId,
				principalId: approval.request.principal_id,
			});
			if (verified.verified !== true ||
				storageCanonicalJson(verified.approvalDecision) !== storageCanonicalJson(decision) ||
				(verified.expectedInputRevision === null
					? request.expectedInputRevision !== undefined
					: verified.expectedInputRevision !== request.expectedInputRevision))
				throw new EngineTargetError("stale_target", "Approval origin or captured input revision differs from its submitted decision");
			const events = await this.store.resolveApproval(
				live ? this.#snapshot(live) : binding, decision.request_id, decision.decision, decision,
				{
					causationCommandId: request.commandId,
					settleCommandId: request.commandId,
					expectedIntentRevision: request.expectedIntentRevision,
					expectedInputRevision: request.expectedInputRevision,
				},
			);
			this.#notifyEvents(events);
			clearTimeout(this.#approvalTimers.get(decision.request_id));
			this.#approvalTimers.delete(decision.request_id);
			const paused = live
				? live.attemptState === "paused" || live.attemptState === "pause_requested"
				: (await this.store.getAttempt(binding.attemptId))?.state === "paused";
			if (paused) {
				if (live?.attemptState === "paused" && !live.manualHold)
					this.#trackRun(this.#resumeApprovedTool(live, decision.request_id));
				if (!live && !(await this.store.intent(binding.agentInstanceId)).manualHold)
					this.#trackRun(this.#inLane(binding.agentInstanceId, async () => {
						const reopened = await this.#rehydratePausedApproval(binding);
						this.#trackRun(this.#resumeApprovedTool(reopened, decision.request_id));
					}).catch(error => this.#retryPausedRecovery(binding, error)));
				return;
			}
			if (pending && this.#pendingToolApprovals.get(decision.request_id) === pending) {
				this.#pendingToolApprovals.delete(decision.request_id);
				pending.resolve({
					decision: decision.decision === "deny" ? "deny" : "approve",
					reason: decision.reason ?? undefined,
					receiptId: decision.origin_receipt_id,
				});
			}
			const escalation = this.#pendingEscalations.get(decision.request_id);
			if (escalation) {
				this.#pendingEscalations.delete(decision.request_id);
				escalation.resolve(decision);
			}
			const consultant = this.#pendingConsultants.get(decision.request_id);
			if (consultant) {
				this.#pendingConsultants.delete(decision.request_id);
				consultant.resolve(decision.decision === "deny" ? "deny" : "approve");
			}
		});
	}

	resolveInput(request: EngineResolveInputRequest): Promise<void> {
		if (!request.commandId.trim() || !request.inputId.trim()) {
			throw new EngineTargetError("invalid_request", "commandId and inputId must be non-empty strings");
		}
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			const pending = binding.pendingInput;
			if (!pending || pending.inputId !== request.inputId || binding.attemptState !== "waiting_input") {
				throw new EngineTargetError("too_late", `Input ${request.inputId} is no longer pending`);
			}
			const result = validateInputResult(request.result, pending.questions);
			const compactResult =
				request.result.kind === "submit" && request.result.results.some(item => "selectedOptionIndexes" in item);
			binding.attemptState = "running";
			try {
				await this.#commitAttemptTransition(
					binding,
					"running",
					[
						{
							kind: "input_resolved",
							payload: {
								inputId: request.inputId,
								result: compactResult ? request.result : result,
								attemptState: "running",
								controlReadiness: controlReadiness("running"),
							},
							causationCommandId: request.commandId,
						},
					],
					{
						settleCommandId: request.commandId,
						expectedStates: ["waiting_input"],
						intentGuard: {
							expectedRevision: request.expectedIntentRevision,
							requireUnheld: true,
							inputId: request.inputId,
							inputRevision: request.expectedInputRevision,
						},
					},
				);
			} catch (error) {
				binding.attemptState = "waiting_input";
				throw error;
			}
			if (binding.pendingInput !== pending) return;
			binding.pendingInput = undefined;
			pending.resolve(result);
		});
	}

	reconcile(request: EngineReconcileRequest): Promise<EngineReconcileResult> {
		if (!request.commandId.trim() || !request.agentInstanceId.trim()) {
			throw new EngineTargetError("invalid_request", "commandId and agentInstanceId must be non-empty strings");
		}
		if (!Number.isSafeInteger(request.authorityGeneration) || request.authorityGeneration < 0) {
			throw new EngineTargetError("invalid_request", "authorityGeneration must be a non-negative safe integer");
		}
		return this.#inLane(request.agentInstanceId, async () => {
			this.#throwIfDisposed();
			const binding = this.#bindings.get(request.agentInstanceId);
			const snapshot = binding ? this.#snapshot(binding) : await this.store.getBinding(request.agentInstanceId);
			if (!snapshot) return {};
			if (snapshot.authorityGeneration !== request.authorityGeneration) {
				throw new EngineTargetError("stale_target", `Stale authority for ${request.agentInstanceId}`);
			}
			const attempt = await this.store.getAttempt(snapshot.attemptId);
			await this.#commitEvent(
				snapshot,
				"reconciled",
				{ binding: snapshot, attemptState: attempt?.state },
				request.commandId,
				request.commandId,
			);
			return { binding: snapshot, attemptState: attempt?.state };
		});
	}

	recordCommandRejection(command: EngineRejectedCommand): Promise<void> {
		return this.#inLane(command.agentInstanceId, async () => {
			this.#throwIfDisposed();
			const retainedBinding =
				command.operation === "start" && command.code === "launch_failed"
					? (this.#bindings.get(command.agentInstanceId) ?? (await this.store.getBinding(command.agentInstanceId)))
					: undefined;
			const sessionState =
				command.operation === "start" && command.code === "launch_failed" && !retainedBinding
					? "absent"
					: undefined;
			const target = {
				commandId: command.commandId,
				agentInstanceId: command.agentInstanceId,
				executionId: command.executionId,
				attemptId: command.attemptId,
				engineGeneration: this.engineGeneration,
				bindingId: "",
				bindingGeneration: command.bindingGeneration ?? 0,
				authorityGeneration: command.authorityGeneration,
			};
			const payload = { code: command.code, message: command.message, ...(sessionState ? { sessionState } : {}) };
			const receipt = {
				outcome: "rejected" as const,
				detail: { code: command.code, message: command.message },
			};
			if (command.operation === "start") {
				const event = await this.store.commitUnboundStartRejection(
					target,
					{ kind: "rejected", payload, causationCommandId: command.commandId },
					receipt,
				);
				this.#notifyEvents([event]);
				return;
			}
			await this.#commitEvent(
				target,
				"rejected",
				payload,
				command.commandId,
				command.commandId,
				receipt,
			);
		});
	}

	release(
		target: EngineTarget,
		cause: "requested" | "engine_lost" = "requested",
		expectedIntentRevision?: number,
	): Promise<void> {
		return this.#inLane(target.agentInstanceId, async () => {
			const binding = this.#requireTarget(target);
			await this.store.assertIntent(target.agentInstanceId, expectedIntentRevision);
			if (expectedIntentRevision !== undefined) {
				const hold = await this.store.branchIntent(
					target.agentInstanceId,
					`session-exit:${target.attemptId}`,
					"stop",
					expectedIntentRevision,
				);
				this.#notifyEvents(hold.events);
				binding.manualHold = true;
				binding.intentRevision = hold.intentRevision;
			}
			await this.#terminateBinding(binding, cause);
		});
	}

	async deliverPeerMessage(message: EnginePeerMessage): Promise<IrcDeliveryReceipt> {
		return await this.#inLane(message.toAgentInstanceId, async () => {
			this.#throwIfDisposed();
			if (!message.messageId.trim() || !message.body.trim()) {
				throw new EngineTargetError("invalid_request", "messageId and body must be non-empty strings");
			}
			if (message.body.length > MAX_INPUT_FIELD_CHARS) {
				throw new EngineTargetError("invalid_request", `message body exceeds ${MAX_INPUT_FIELD_CHARS} characters`);
			}
			const recipient = this.resolveEngineAgentId(message.toAgentInstanceId);
			const sender = this.resolveEngineAgentId(message.fromAgentInstanceId);
			if (!recipient || !sender) {
				return { to: message.toAgentInstanceId, outcome: "failed", error: "Unknown Engine peer" };
			}
			const owner = this.resolveBrokerAgent(recipient);
			const binding = owner
				? [...this.#bindings.values()].find(
						candidate =>
							candidate.executionId === owner.executionId &&
							candidate.attemptId === owner.attemptId &&
							candidate.authorityGeneration === owner.authorityGeneration,
					)
				: undefined;
			if (!binding) return { to: message.toAgentInstanceId, outcome: "failed", error: "Unknown Engine peer" };
			const queued = await this.store.enqueueInboxItem(this.#inboxTarget(binding), {
				sourceEventId: message.messageId,
				sourceType: "agent",
				sender: message.fromAgentInstanceId,
				body: message.body,
				createdAt: message.sentAt ?? Date.now(),
			});
			if (queued.created) {
				this.#signalInboxWake();
			}
			return { to: message.toAgentInstanceId, outcome: "queued" };
		});
	}

	listInbox(target: EngineTarget, includeTerminal = false): Promise<EngineInboxItem[]> {
		return this.#inLane(target.agentInstanceId, async () => {
			const retained = await this.#requireSessionReadTarget(target);
			return await this.store.listInboxItems(retained.sessionId, includeTerminal);
		});
	}

	enqueueInbox(target: EngineTarget, source: EngineInboxSource): Promise<{ item: EngineInboxItem; created: boolean }> {
		if (source.attachments) source = { ...source, attachments: messageAttachmentReferences(source.attachments) };
		return this.#inLane(target.agentInstanceId, async () => {
			const retained = await this.#requireSessionTarget(target);
			const queued = await this.store.enqueueInboxItem(retained, source);
			if (queued.created) {
				this.#signalInboxWake();
			}
			return queued;
		});
	}

	async #agentInboxTarget(agentInstanceId: string): Promise<EngineInboxTarget> {
		const live = this.#bindings.get(agentInstanceId);
		if (live) return this.#inboxTarget(live);
		const binding = await this.store.getBinding(agentInstanceId);
		if (binding) {
			if (!binding.sessionFile && (await this.store.getAttempt(binding.attemptId))?.state === "failed")
				return { ...binding, sessionId: `pending:${agentInstanceId}` };
			return await this.#requireSessionTarget(binding);
		}
		return {
			agentInstanceId,
			sessionId: `pending:${agentInstanceId}`,
			bindingId: "",
			attemptId: "",
			executionId: "",
			engineGeneration: this.engineGeneration,
			bindingGeneration: 0,
			authorityGeneration: 0,
		};
	}

	enqueueAgentInbox(
		agentInstanceId: string,
		source: EngineInboxSource,
		expectedIntentRevision?: number,
		commandId = source.sourceEventId,
	): Promise<{ item: EngineInboxItem; created: boolean }> {
		if (source.attachments) source = { ...source, attachments: messageAttachmentReferences(source.attachments) };
		return this.#inLane(agentInstanceId, async () => {
			const result = await this.store.enqueueInboxItem(
				await this.#agentInboxTarget(agentInstanceId),
				source,
				expectedIntentRevision,
				commandId,
			);
			if (result.created) this.#signalInboxWake();
			return result;
		});
	}

	mutateAgentInbox(agentInstanceId: string, mutation: EngineInboxMutation): Promise<EngineInboxItem> {
		return this.#inLane(agentInstanceId, async () => {
			const result = await this.store.mutateInboxItemWithEvent(
				await this.#agentInboxTarget(agentInstanceId),
				mutation,
			);
			if (result.event) this.#notifyEvents([result.event]);
			this.#signalInboxWake();
			return result.item;
		});
	}

	reorderAgentInbox(
		agentInstanceId: string,
		mutationId: string,
		expectedOrder: string[],
		desiredOrder: string[],
		expectedQueueRevision: number,
	): Promise<EngineInboxItem[]> {
		return this.#inLane(agentInstanceId, async () => {
			const result = await this.store.reorderInboxItemsWithEvent(
				await this.#agentInboxTarget(agentInstanceId),
				mutationId,
				expectedOrder,
				desiredOrder,
				expectedQueueRevision,
			);
			if (result.event) this.#notifyEvents([result.event]);
			this.#signalInboxWake();
			return result.items;
		});
	}

	readInbox(target: EngineTarget, queueId: string): Promise<EngineInboxItem | undefined> {
		return this.#inLane(target.agentInstanceId, async () => {
			const retained = await this.#requireSessionReadTarget(target);
			return await this.store.getInboxItem(retained.sessionId, queueId);
		});
	}

	sessionContext(target: EngineTarget): Promise<Record<string, unknown>> {
		return this.#inLane(target.agentInstanceId, async () => {
			if (this.#bindings.get(target.agentInstanceId)?.attemptId !== target.attemptId) {
				const retained = await this.store.nativeSessionHeader(target);
				const attempt = await this.store.getAttempt(target.attemptId);
				return {
					schema: "grimoire.engine.session_context.v1",
					status: "not_ready",
					attemptId: target.attemptId,
					...(attempt?.binding_snapshot ? { bindingSnapshot: attempt.binding_snapshot } : {}),
					sessionId: retained.sessionId,
					cwd: retained.cwd,
					context: null,
					reason: "session_not_active",
				};
			}
			const binding = this.#requireTarget(target);
			const model = binding.session.model;
			return {
				schema: "grimoire.engine.session_context.v1",
				attemptId: binding.attemptId,
				bindingSnapshot: binding.bindingSnapshot,
				sessionId: binding.session.sessionId,
				cwd: binding.session.sessionManager.getCwd(),
				model: model ? { provider: model.provider, id: model.id, contextWindow: model.contextWindow } : null,
				context: binding.session.getContextBreakdown() ?? null,
				contextUsageRevision: binding.session.contextUsageRevision,
			};
		});
	}

	async sessionUsage(target: EngineTarget, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const captured = await this.#inLane(target.agentInstanceId, async () => {
			if (this.#bindings.get(target.agentInstanceId)?.attemptId !== target.attemptId) {
				const retained = await this.store.nativeSessionHeader(target);
				return {
					response: {
						schema: "grimoire.engine.session_usage.v1",
						status: "not_ready",
						attemptId: target.attemptId,
						sessionId: retained.sessionId,
						local: null,
						provider: { status: "unavailable", reason: "session_not_active" },
					},
				};
			}
			const binding = this.#requireTarget(target);
			const model = binding.session.model;
			return {
				session: binding.session,
				response: {
					schema: "grimoire.engine.session_usage.v1",
					attemptId: binding.attemptId,
					sessionId: binding.session.sessionId,
					model: model ? { provider: model.provider, id: model.id } : null,
					local: binding.session.getSessionStats(),
				},
			};
		});
		if (!captured.session) return captured.response;
		signal?.throwIfAborted();
		const controller = new AbortController();
		let provider: Record<string, unknown>;
		try {
			const reports = await withTimeout(
				captured.session.fetchUsageReports(controller.signal),
				runtimeLimits.bootstrapTimeoutMs,
				"Provider usage query timed out",
				signal,
			);
			provider = reports?.length
				? {
						status: "available",
						fetchedAt: Math.max(0, ...reports.map(report => report.fetchedAt)),
						reports: reports.map(report => ({
							provider: report.provider,
							fetchedAt: report.fetchedAt,
							limits: report.limits,
							...(report.resetCredits ? { resetCredits: report.resetCredits } : {}),
							...(report.notes ? { notes: report.notes } : {}),
						})),
					}
				: { status: "unavailable", reason: "provider_usage_not_supported" };
		} catch (error) {
			if (signal?.aborted) throw error;
			provider = { status: "unavailable", reason: "provider_usage_fetch_failed" };
		} finally {
			controller.abort();
		}
		return await this.#inLane(target.agentInstanceId, async () => {
			if (this.#requireTarget(target).session !== captured.session) {
				throw new EngineTargetError("stale_target", "Session changed during provider usage query");
			}
			return { ...captured.response, provider };
		});
	}

	async sessionHistoryPage(
		agentInstanceId: string,
		agentInstanceRef: string,
		cursor?: string,
		limit = runtimeLimits.httpPageRecords,
		attemptId?: string,
	) {
		const page = await this.store.nativeHistoryPage(agentInstanceId, cursor, limit, attemptId);
		const images = await nativeHistoryImages(page, agentInstanceRef, new BlobStore(getBlobsDir()));
		const attachments = await nativeHistoryAttachments(page, agentInstanceRef, new BlobStore(getBlobsDir()));
		const projected = projectHistoryEntries(
			page.sessionId,
			page.entries as SessionEntry[],
			false,
			images,
			attachments,
		);
		for (const entry of projected.entries)
			for (const block of entry.blocks ?? []) {
				const ref = page.activityRefs?.find(ref => ref.toolCallId === block.toolCallId);
				if (ref)
					block.resultRef = {
						kind: "history_entry",
						agentInstanceRef,
						...(attemptId ? { attemptId } : {}),
						sessionId: page.sessionId,
						entryId: ref.entryId,
						revision: ref.revision,
						bytes: ref.bytes,
						mediaType: "application/json",
					};
			}
		return { ...page, entries: projected.entries, activityCompleteness: projected.activityCompleteness };
	}

	async chatLifecycle(
		agentInstanceRef: string,
		principalId: string,
		action: "status" | "archive" | "unarchive" | "delete",
		operationId?: string,
		expectedRevision?: number,
	) {
		const store = this.store;
		const agentInstanceId = await store.chatIdentityId(agentInstanceRef, principalId);
		return this.#inLane(agentInstanceId, async () => {
			if (action === "status") return store.chatLifecycleStatus(agentInstanceId, principalId);
			const live = this.#bindings.get(agentInstanceId);
			if (live && !TERMINAL_ATTEMPT_STATES.has(live.attemptState))
				throw new EngineTargetError("agent_busy", "Stop the active chat first");
			if (!operationId || expectedRevision === undefined)
				throw new EngineTargetError("invalid_request", "Operation ID and lifecycle revision are required");
			return store.chatLifecycle(agentInstanceId, principalId, action, operationId, expectedRevision);
		});
	}

	async archivedChats(principalId: string, cursor?: string) {
		return this.store.archivedChats(principalId, cursor);
	}

	async sweepExpiredChildHistory(): Promise<{
		expired: number;
		archived: number;
		deleted: number;
		retained: number;
	}> {
		this.#throwIfDisposed();
		if (this.#childHistoryRetention === "local") {
			return { expired: 0, archived: 0, deleted: 0, retained: 0 };
		}
		throw nativeArchiveUnsupported();
	}

	compact(target: EngineTarget, expectedIntentRevision?: number): Promise<Record<string, unknown>> {
		return this.#inLane(target.agentInstanceId, async () => {
			await this.store.assertIntent(target.agentInstanceId, expectedIntentRevision, true);
			const binding = this.#requireTarget(target);
			const before = binding.session.getContextBreakdown();
			const result = await this.#withSessionScope(binding, () => binding.session.compact());
			const after = binding.session.getContextBreakdown();
			return {
				schema: "grimoire.engine.session_compaction.v1",
				attemptId: binding.attemptId,
				sessionId: binding.session.sessionId,
				tokensBefore: result.tokensBefore,
				tokensAfter: after?.usedTokens ?? null,
				contextBefore: before ?? null,
				contextAfter: after ?? null,
			};
		});
	}

	mutateInbox(target: EngineTarget, mutation: EngineInboxMutation): Promise<EngineInboxItem> {
		return this.#inLane(target.agentInstanceId, async () => {
			const retained = await this.#requireSessionTarget(target);
			const { item, event } = await this.store.mutateInboxItemWithEvent(retained, mutation);
			if (event) this.#notifyEvents([event]);
			this.#signalInboxWake();
			return item;
		});
	}

	reorderInbox(
		target: EngineTarget,
		mutationId: string,
		expectedOrder: readonly string[],
		desiredOrder: readonly string[],
	): Promise<EngineInboxItem[]> {
		return this.#inLane(target.agentInstanceId, async () => {
			const retained = await this.#requireSessionTarget(target);
			const { items, event } = await this.store.reorderInboxItemsWithEvent(
				retained,
				mutationId,
				expectedOrder,
				desiredOrder,
			);
			if (event) this.#notifyEvents([event]);
			this.#signalInboxWake();
			return items;
		});
	}

	async runControlQuery<T>(work: () => Promise<T>): Promise<T> {
		this.#throwIfDisposed();
		return await work();
	}

	async drain(): Promise<void> {
		await this.#nativeDeleteRun;
		await Promise.all(this.#lanes.values());
		await Promise.all(this.#runs);
		await this.store.drain();
	}

	async dispose(options: { closeStore?: boolean } = {}): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#storageFailureUnsubscribe?.();
		for (const timer of this.#approvalTimers.values()) clearTimeout(timer);
		this.#approvalTimers.clear();
		for (const timer of this.#recoveryTimers.values()) clearTimeout(timer);
		this.#recoveryTimers.clear();
		this.#signalInboxWake();
		for (const pending of this.#pendingStarts)
			pending.controller.abort(new EngineTargetError("cancelled", "Engine stopped during profile resolution"));
		const errors: unknown[] = [];
		for (const result of await Promise.allSettled(this.#lanes.values())) {
			if (result.status === "rejected") errors.push(result.reason);
		}
		for (const binding of [...this.#bindings.values()]) {
			await collectFailure(errors, () => this.#terminateBinding(binding, "engine_lost"));
		}
		for (const result of await Promise.allSettled(this.#runs)) {
			if (result.status === "rejected") errors.push(result.reason);
		}
		const inboxWakeRun = this.#inboxWakeRun;
		if (inboxWakeRun) await collectFailure(errors, () => inboxWakeRun);
		if (this.#nativeDeleteRun) await collectFailure(errors, () => this.#nativeDeleteRun!);
		await collectFailure(errors, () => this.agentLifecycle.dispose());
		await collectFailure(errors, () => this.asyncJobManager.dispose({ timeoutMs: 3_000 }));
		await collectFailure(errors, () => this.ircBus.dispose());
		if (options.closeStore !== false) await collectFailure(errors, () => this.store.close());
		throwCollectedFailures(errors, "Engine disposal failed");
	}

	async #prepareHistoryStart(request: EngineStartRequest): Promise<PreparedHistoryStart | undefined> {
		const edit = request.historyEdit;
		if (!edit) return undefined;
		const sameAgent = request.agentInstanceId === edit.source.agentInstanceId;
		if ((edit.mode === "edit") !== sameAgent) {
			throw new EngineTargetError(
				"invalid_request",
				edit.mode === "edit"
					? "History edit must keep the source AgentInstance"
					: "History branch must use a distinct AgentInstance",
			);
		}
		if (edit.mode === "edit") {
			if (edit.replacementText === undefined || request.input !== undefined) {
				throw new EngineTargetError("invalid_request", "History edit requires replacementText and no input");
			}
		} else if (edit.replacementText !== undefined) {
			throw new EngineTargetError("invalid_request", "History branch cannot replace the selected message");
		}

		const live = this.#bindings.get(edit.source.agentInstanceId);
		const source = live ? this.#snapshot(live) : await this.store.getBinding(edit.source.agentInstanceId);
		if (!source)
			throw new EngineTargetError("agent_not_found", `Unknown AgentInstance ${edit.source.agentInstanceId}`);
		for (const field of [
			"bindingId",
			"executionId",
			"attemptId",
			"authorityGeneration",
			"engineGeneration",
			"bindingGeneration",
		] as const) {
			if (source[field] !== edit.source[field]) {
				throw new EngineTargetError("stale_target", `History source ${field} is stale`);
			}
		}
		if (edit.mode === "edit" && !(await this.#sameAdmittedBinding(source, request)))
			throw new EngineTargetError("stale_target", "History edit cannot cross semantic bindings");
		const sourceAttempt = await this.store.getAttempt(source.attemptId);
		if (!sourceAttempt || !TERMINAL_ATTEMPT_STATES.has(sourceAttempt.state)) {
			throw new EngineTargetError("agent_busy", `History source Attempt ${source.attemptId} is not terminal`);
		}
		if (live && (live.state === "running" || live.session.isStreaming)) {
			throw new EngineTargetError("agent_busy", `History source ${source.agentInstanceId} is busy`);
		}
		if (!source.sessionFile) throw new EngineTargetError("history_expired", "History source session is unavailable");
		if (live) await live.session.sessionManager.flushAndCheckpoint();

		const sourceSessionId = (await this.#sessionHeader(source.sessionFile))?.id;
		if (!sourceSessionId || sourceSessionId !== edit.sourceSessionId)
			throw new EngineTargetError("stale_target", "History source session changed");
		const hasPendingInbox = edit.mode === "edit" && (await this.store.listInboxItems(sourceSessionId)).length > 0;
		const sessionDir = path.join(this.#sessionRoot, engineRouteToken(request.agentInstanceId));
		const forkOptions = {
			leafEntryId: edit.expectedLeafEntryId,
			...(edit.mode === "edit"
				? {
						edit: {
							entryId: edit.entryId,
							text: edit.replacementText!,
							identity: {
								sourceCommandId: request.commandId,
								...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
							},
						},
					}
				: {}),
		};
		const nativeSource = this.#nativeSessionStorage(source.sessionFile);
		const sourceContext = await nativeSource.readContext();
		const mapped = await resolveRestoreWorkspace(
			this.store,
			edit.source.agentInstanceId,
			source.sessionFile,
			sourceContext.checkpoint.header,
			sourceContext.position,
		);
		if (mapped && (await canonicalWorkspacePath(request.cwd)) !== (await canonicalWorkspacePath(mapped.cwd)))
			throw new EngineTargetError("stale_target", "History branch cwd differs from restored workspace mapping");
		const { familyId } = parseNativeSessionLocator(source.sessionFile);
		const nativeTarget = new RocksNativeSessionStorage(this.store.storageClient, familyId, crypto.randomUUID());
		const manager = await SessionManager.forkNativeContext(
			nativeSource,
			nativeTarget,
			request.cwd,
			sessionDir,
			{
				...forkOptions,
				entryId: edit.entryId,
			},
			mapped?.additionalDirectories,
		);
		const selected = manager.getLeafEntry();
		if (selected?.type !== "message" || (selected.message.role !== "user" && selected.message.role !== "assistant"))
			throw new EngineTargetError("stale_target", "Native fork lost its selected message");
		const forked: NativeHistoryForkResult = {
			sessionManager: manager,
			selectedRole: selected.message.role,
			selectedEntryId: edit.entryId,
			...(edit.mode === "edit" ? { replacementEntryId: selected.id } : {}),
		};

		const branchInput = edit.mode === "branch" && request.input?.trim() ? request.input : undefined;
		const dispatchKind: HistoryDispatchKind = branchInput
			? "prompt"
			: forked.selectedRole === "user"
				? "continue"
				: "continue_after_assistant";
		const dispatchInput =
			branchInput ?? (dispatchKind === "continue_after_assistant" ? historyEditContinuePrompt : "history-resume");
		return {
			sessionManager: forked.sessionManager,
			dispatchKind,
			dispatchInput,
			...(hasPendingInbox ? { pendingInboxSourceSessionId: sourceSessionId } : {}),
			result: {
				mode: edit.mode,
				sourceSessionId,
				sourceEntryId: edit.entryId,
				...(forked.replacementEntryId ? { replacementEntryId: forked.replacementEntryId } : {}),
				sessionId: forked.sessionManager.getSessionId(),
			},
		};
	}

	async #startInLane(
		request: EngineStartRequest,
		pendingStartSignal: AbortSignal,
		audit?: LatencyAudit,
	): Promise<EngineStartResult> {
		this.#throwIfDisposed();
		if (!this.#resolveExecution || !this.#verifyOriginReceipt)
			throw new EngineTargetError("source_unavailable", "Execution resolver and verified origin are required");
		const origin = await this.#verifyOriginReceipt({
			originReceiptId: request.originReceiptId,
			commandId: request.commandId,
			agentInstanceRef: request.agentInstanceRef,
			attemptId: request.attemptId,
			principalId: request.principalId,
		});
		if (origin.verified !== true || origin.dispatchHash !== request.dispatchHash || !origin.bindingSnapshot ||
			!sameSemanticBinding(origin.bindingSnapshot, request.bindingSnapshot) || !origin.authContextId)
			throw new EngineTargetError("stale_target", "Origin receipt differs from admitted dispatch or binding");
		await this.store.checkSemanticStart(request.agentInstanceId, request.bindingSnapshot, request.principalId);
		let binding = this.#bindings.get(request.agentInstanceId);
		const admitted = binding ?? await this.store.getBinding(request.agentInstanceId);
		if (admitted?.bindingSnapshot?.bindingRevision === 0 &&
			!sameSemanticBinding(admitted.bindingSnapshot, request.bindingSnapshot))
			throw new EngineTargetError("stale_target", "Legacy binding is immutable");
		if (binding) {
			if (binding.attemptId === request.attemptId) {
				if (binding.executionId === request.executionId) {
					if (binding.authorityGeneration !== request.authorityGeneration) {
						throw new EngineTargetError("stale_target", `Stale authority for ${request.agentInstanceId}`);
					}
					return { ...this.#snapshot(binding), executorChoice: binding.execution.choice, duplicate: true };
				}
				throw new EngineTargetError(
					"invalid_request",
					`Attempt ${request.attemptId} is already bound to Execution ${binding.executionId}`,
				);
			}
		}

		const priorAttempt = await this.store.getAttempt(request.attemptId);
		if (priorAttempt) {
			if (
				priorAttempt.agent_instance_id !== request.agentInstanceId ||
				priorAttempt.execution_id !== request.executionId
				|| (priorAttempt.binding_snapshot && !sameSemanticBinding(priorAttempt.binding_snapshot, request.bindingSnapshot))
			) {
				throw new EngineTargetError("invalid_request", `Attempt ${request.attemptId} is already bound`);
			}
			const durableBinding = await this.store.getBinding(request.agentInstanceId);
			if (
				durableBinding?.attemptId === request.attemptId &&
				durableBinding.executionId === request.executionId &&
				durableBinding.authorityGeneration === request.authorityGeneration
			) {
				return { ...durableBinding, executorChoice: priorAttempt.execution?.executor_choice, duplicate: true };
			}
			throw new EngineTargetError(
				"too_late",
				`Attempt ${request.attemptId} already exists in state ${priorAttempt.state}`,
			);
		}
		await this.store.registerAgent(request);
		const initialIntent = await this.store.intent(request.agentInstanceId);
		await this.store.assertIntent(request.agentInstanceId, request.expectedIntentRevision);
		const explicitContinue = request.explicitContinue === true || request.historyEdit !== undefined;
		if (initialIntent.manualHold && !explicitContinue && !request.parentAgentInstanceId)
			throw new EngineTargetError("agent_busy", "Held AgentInstance requires explicit Continue");
		const queuedItem = request.queueId ? await this.store.getInboxItemByQueueId(request.queueId) : undefined;
		const archive = await this.store.getHistoryArchive(request.agentInstanceId);
		if (archive && archive.state !== "restored") {
			throw new EngineTargetError("history_expired", "Restore this archived history before starting a new Attempt");
		}
		const retainedQueueBinding =
			queuedItem?.wakeDeliveredAt === undefined
				? binding
					? this.#snapshot(binding)
					: await this.store.getBinding(request.agentInstanceId)
				: undefined;
		const exactHeldQueueStart =
			retainedQueueBinding?.manualHold === true &&
			request.expectedIntentRevision === retainedQueueBinding.intentRevision;
		if (
			request.queueId &&
			(queuedItem?.agentInstanceId !== request.agentInstanceId ||
				queuedItem.disposition !== "pending" ||
				queuedItem.revision !== request.expectedRevision ||
				(!queuedItem.wakeIntent && !explicitContinue) ||
				(queuedItem.wakeDeliveredAt === undefined && !exactHeldQueueStart && !explicitContinue))
		) {
			throw new EngineTargetError(
				"stale_target",
				`Inbox item ${request.queueId} is no longer pending at that wake revision`,
			);
		}
		if (queuedItem && request.clientMessageId !== undefined && request.clientMessageId !== queuedItem.sourceEventId)
			throw new EngineTargetError(
				"invalid_request",
				"Queued delivery clientMessageId must match the retained message",
			);
		if (binding && queuedItem && queuedItem.sessionId !== binding.session.sessionId) {
			throw new EngineTargetError("stale_target", `Inbox item ${queuedItem.queueId} belongs to another session`);
		}
		if (binding && (binding.state === "running" || binding.session.isStreaming)) {
			throw new EngineTargetError("agent_busy", `AgentInstance ${request.agentInstanceId} is busy`);
		}
		let restoreReceipt: RestoreWorkspaceReceipt | undefined;
		if (!binding) {
			const prior = await this.store.getBinding(request.agentInstanceId);
			if (prior?.sessionFile?.startsWith("native:") && await this.#sameAdmittedBinding(prior, request)) {
				const storage = this.#nativeSessionStorage(prior.sessionFile);
				const loaded = await storage.readContext();
				const restored = await resolveRestoreWorkspace(
					this.store,
					request.agentInstanceId,
					prior.sessionFile,
					loaded.checkpoint.header,
					loaded.position,
				);
				if (restored?.receipt?.state === "complete") {
					if (restored.checkpointNeeded)
						throw new EngineTargetError("stale_target", "Completed workspace rebind lost its native checkpoint");
				} else if (restored) {
					if (!explicitContinue || request.executionConfiguration.continuationPolicy === "fresh")
						throw new EngineTargetError("stale_target", "Restored workspace requires explicit Continue");
					if ((await canonicalWorkspacePath(request.cwd)) !== (await canonicalWorkspacePath(restored.cwd)))
						throw new EngineTargetError(
							"stale_target",
							"Continue cwd differs from the restored workspace mapping",
						);
					restoreReceipt = await beginRestoreRebind(
						this.store,
						restored,
						request.agentInstanceId,
						prior.sessionFile,
						loaded.checkpoint.header,
						loaded.position,
					);
					if (restored.checkpointNeeded) {
						const manager = await SessionManager.openNative(storage);
						await manager.rebindRestoredNativeWorkspace(restored.cwd, restored.additionalDirectories);
						manager.seal();
					}
					const checked = await storage.readContext();
					const resolved = await resolveRestoreWorkspace(
						this.store,
						request.agentInstanceId,
						prior.sessionFile,
						checked.checkpoint.header,
						checked.position,
					);
					if (!resolved?.receipt || resolved.checkpointNeeded)
						throw new EngineTargetError("stale_target", "Restored native checkpoint did not become durable");
				}
			}
		}
		const references = queuedItem?.attachments ?? this.#messageAttachments(request);
		const preparedAttachments = references
			? await this.attachmentUploads.prepareForMessage(
					queuedItem?.sourceEventId ?? request.clientMessageId!,
					references,
					pendingStartSignal,
					queuedItem?.attachmentDescriptors,
				)
			: undefined;
		const images = preparedAttachments?.images;
		const continuationDigest = await this.#continuationDigest(request);
		const compatibilityDigest = restoreReceipt
			? await this.#continuationDigest(request, restoreReceipt.originalCwd)
			: undefined;
		if (request.restoreCheckpoint) throw nativeArchiveUnsupported();
		const preparedHistory = await this.#prepareHistoryStart(request);
		const preparedSession = preparedHistory?.sessionManager;
		let ownsPreparedSession = true;
		try {
		audit?.mark("binding_prepare");

		if (binding && (binding.state === "running" || binding.session.isStreaming)) {
			throw new EngineTargetError("agent_busy", `AgentInstance ${request.agentInstanceId} is busy`);
		}
		const originals = preparedAttachments?.originalAttachments;
		const config = request.executionConfiguration;
		if (executionHash(config.dispatch) !== request.dispatchHash)
			throw new EngineTargetError("invalid_request", "Dispatch hash does not match the normalized execution");
		if (!config.roster_complete || config.routes.routes.length === 0)
			throw new EngineTargetError("admission_state_unknown", "A complete authorized executor roster is required");
		const requirement = config.dispatch.requirement;
		const roster = config.routes.routes.filter(route =>
			(!requirement.require_trusted_provider || route.execution.trusted) &&
			(route.tier === null ? requirement.min_tier === 0 : route.tier >= requirement.min_tier) &&
			(!requirement.pin || (route.model_id === requirement.pin.model_id &&
				route.effort === requirement.pin.effort &&
				(requirement.pin.route_ref === null || route.route_ref === requirement.pin.route_ref))));
		if (!roster.length)
			throw new EngineTargetError("capacity_unavailable", "No route satisfies the admitted trust, tier and pin");
		const { toolNames, restrictToolNames } = config.continuationConfiguration;
		assertFilesReadable(
			toolNames ? normalizeToolNames(toolNames).includes("read") : restrictToolNames !== true,
			originals,
		);
		const admission: AdmissionRequest = {
			principalId: request.principalId,
			deviceId: this.#deviceId,
			engineGeneration: this.engineGeneration,
			commandId: request.commandId,
			agentInstanceRef: request.agentInstanceRef,
			attemptId: request.attemptId,
			dispatchId: config.dispatch.dispatch_id,
			dispatchRef: request.dispatchRef,
			dispatchHash: request.dispatchHash,
			originReceiptId: request.originReceiptId,
			authContextId: origin.authContextId,
			bindingSnapshot: request.bindingSnapshot,
			executionKind: request.executionKind,
			limits: config.routingLimits,
			rosterRevision: config.roster_revision,
			expectedRevisions: config.record_revisions,
			candidates: roster,
			callerAttemptId: request.bindingSnapshot.parentAttemptId,
			frozen: false,
		};
		let preview = await this.store.previewRouting(admission);
		if (preview.status === "queued") {
			try {
				preview = await this.store.queueRouting(admission);
			} catch (error) {
				if (!(error instanceof EngineTargetError) || error.code !== "admission_state_unknown") throw error;
				preview = await this.store.previewRouting(admission);
				if (preview.status === "queued") preview = await this.store.queueRouting(admission);
			}
		}
		if (preview.status === "queued") {
			return {
				bindingId: `${engineRouteToken(request.agentInstanceId)}:${(admitted?.bindingGeneration ?? 0) + 1}`,
				commandId: request.commandId,
				bindingSnapshot: request.bindingSnapshot,
				agentInstanceId: request.agentInstanceId,
				executionId: request.executionId,
				attemptId: request.attemptId,
				engineAgentId: engineAgentId(request.agentInstanceId),
				executionDigest: executionHash(config),
				continuationDigest,
				dispatchRef: request.dispatchRef,
				dispatchHash: request.dispatchHash,
				state: "idle",
				engineGeneration: this.engineGeneration,
				bindingGeneration: (admitted?.bindingGeneration ?? 0) + 1,
				authorityGeneration: request.authorityGeneration,
				manualHold: initialIntent.manualHold,
				intentRevision: initialIntent.intentRevision,
				queueId: preview.queueId,
				duplicate: false,
			};
		}
		const route = preview.frozen[0];
		if (!route) throw new EngineTargetError("admission_state_unknown", "Admitted route is missing");
		const selected: SelectedExecutor = {
			...candidateIdentity(route),
			basis: requirement.pin ? "pin" : route.order_match ? "order" : "rank",
			order_match: route.order_match,
		};
		const candidates = preview.frozen.map(frozenCandidate);
		const l1Rules = l1For(config.instruction_sources, candidateIdentity(route));
		const executionDigest = executionHash({
			schema: "artel.execution.v2",
			dispatchHash: request.dispatchHash,
			executionConfiguration: config,
			record_revisions: config.record_revisions,
			scope_revision: config.scope_revision,
			candidates,
			selected,
		});
		const choice: ExecutorChoice = {
			schema: "grimoire.executor_choice.v1",
			dispatch_hash: request.dispatchHash,
			preset_ref: config.dispatch.preset?.ref ?? null,
			effective_requirement: config.dispatch.requirement,
			scope_revision: config.scope_revision,
			candidates,
			filtered_counts: preview.filtered,
			selected,
			execution_digest: executionDigest,
			shadow_cost_estimate: route.shadow_cost,
			rules: l1Rules.map(rule => ({ ref: rule.ref, revision: rule.revision, content_hash: rule.content_hash })),
			skills: config.instruction_sources.skills,
			transitions: [],
			actual_cost: null,
			grants_used: [],
		};
		const initial: EngineBindingSnapshot = {
			bindingId: `${engineRouteToken(request.agentInstanceId)}:${(admitted?.bindingGeneration ?? 0) + 1}`,
			commandId: request.commandId,
			bindingSnapshot: request.bindingSnapshot,
			agentInstanceId: request.agentInstanceId,
			executionId: request.executionId,
			attemptId: request.attemptId,
			engineAgentId: engineAgentId(request.agentInstanceId),
			executionDigest,
			continuationDigest,
			dispatchRef: request.dispatchRef,
			dispatchHash: request.dispatchHash,
			state: "running",
			engineGeneration: this.engineGeneration,
			bindingGeneration: (admitted?.bindingGeneration ?? 0) + 1,
			authorityGeneration: request.authorityGeneration,
			manualHold: initialIntent.manualHold && !explicitContinue,
			intentRevision: initialIntent.intentRevision + (request.expectedIntentRevision === undefined ? 0 : 1),
			intentCommandId: request.commandId,
		};
		const result = {
			phase: queuedItem ? "consumed" : "applied",
			manualHold: initial.manualHold,
			intentRevision: initial.intentRevision,
			executorChoice: choice,
			executionDigest,
			continuationDigest,
			...(preparedHistory ? { historyEdit: preparedHistory.result } : {}),
		};
		// Nothing requests a credential or issues an effect until the owner's one atomic acceptance.
			const events = await this.store.commitAttemptTransition(initial, "running", [{ kind: "accepted" }, { kind: "running" }], {
				routingAdmission: { request: admission, preview },
				execution: {
					execution_schema: 2,
					execution_digest: executionDigest,
					continuation_digest: continuationDigest,
					dispatch_ref: request.dispatchRef,
					dispatch_hash: request.dispatchHash,
					executor_choice: choice,
					lease_id: `slot-lease:${request.attemptId}`,
					queue_id: null,
				},
				startIntent: {
					expectedRevision: request.expectedIntentRevision,
					explicitContinue,
					allowInheritedHold: Boolean(request.parentAgentInstanceId),
					sourceAgentInstanceId: request.historyEdit?.source.agentInstanceId,
					sourceRevision: request.historyEdit?.expectedSourceIntentRevision,
				},
				settleCommandId: request.commandId,
				settleCommandReceipt: { outcome: "applied", detail: result },
				...(restoreReceipt ? { restoreWorkspaceReceipt: restoreReceipt } : {}),
				requireNew: true,
				...(queuedItem
					? {
							inboxSessionId: queuedItem.sessionId,
							inboxMutation: {
								mutationId: request.mutationId!,
								queueId: queuedItem.queueId,
								expectedRevision: request.expectedRevision!,
								op: "acknowledge" as const,
							},
							inboxMutationCausationCommandId: request.commandId,
						}
					: {}),
			});
			this.#notifyEvents(events);
		let leaseError: unknown;
		let renewing = false;
		const heartbeat = setInterval(() => {
			if (renewing || leaseError) return;
			renewing = true;
			void this.store.renewRouting(request.attemptId, this.engineGeneration)
				.then(renewed => {
					if (!renewed) throw new EngineTargetError("stale_target", "Routing lease disappeared");
				})
				.catch(error => {
					leaseError = error;
					if (binding?.attemptId === request.attemptId)
						binding.session.agent.abort(error instanceof Error ? error : new Error(String(error)));
				})
				.finally(() => { renewing = false; });
		}, LEASE_HEARTBEAT_MS);
		heartbeat.unref?.();
		let resolved: ResolvedEngineExecution | undefined;
		try {
			if (binding) await this.#terminateBinding(binding, "requested");
			const attempt: ExecutionAttemptIdentity = {
				expectedPrincipalId: request.principalId,
				agentInstanceRef: request.agentInstanceRef,
				attemptId: request.attemptId,
				bindingRevision: request.bindingSnapshot.bindingRevision,
				installationId: request.bindingSnapshot.installationId,
				dispatchRef: request.dispatchRef,
				dispatchHash: request.dispatchHash,
				executionDigest,
				originReceiptId: request.originReceiptId,
			};
			resolved = await this.#resolveExecution(config, preview.frozen, attempt, request.cwd, pendingStartSignal);
			const openingExecution = resolved;
			resolved = undefined;
			ownsPreparedSession = false;
			binding = await this.#openBinding(
				request, openingExecution, continuationDigest,
				executionDigest, choice, preview.frozen, admitted, initial.bindingGeneration,
				restoreReceipt, compatibilityDigest, preparedSession, pendingStartSignal, audit, origin.approvalSettings ?? undefined,
			);
			this.#assertAttachmentSupport(binding.session, images, originals);
			if (preparedHistory?.pendingInboxSourceSessionId)
				binding.pendingInboxSourceSessionId = preparedHistory.pendingInboxSourceSessionId;
			if (queuedItem && queuedItem.sessionId !== binding.session.sessionId &&
				queuedItem.sessionId !== binding.previousInboxSessionId &&
				queuedItem.sessionId !== `pending:${request.agentInstanceId}`)
				throw new EngineTargetError("stale_target", "Queued message belongs to another session");
			binding.manualHold = initial.manualHold ?? false;
			binding.intentRevision = initial.intentRevision ?? 0;
			binding.intentCommandId = request.commandId;
			binding.state = "running";
			binding.attemptState = "running";
			if (leaseError) throw leaseError;
			binding.leaseHeartbeat = heartbeat;
			await this.#commitAttemptTransition(binding, "running", [], {
				transcriptCheckpoint: await binding.session.sessionManager.flushAndCheckpoint(),
				inboxSessionId: binding.session.sessionId,
			});
		} catch (error) {
			clearInterval(heartbeat);
			if (binding?.attemptId === request.attemptId) await this.#discardBinding(binding);
			else resolved?.dispose();
			const events = await this.store.commitAttemptTransition(initial, "failed", [
				{ kind: "failed", payload: { reason: safeEngineErrorDetail(error) } },
			], { cause: safeEngineErrorDetail(error) });
			this.#notifyEvents(events);
			throw error;
		}
		const promptInput = preparedHistory?.dispatchInput ?? queuedItem?.deliveryPayload ?? request.input ?? "";
		this.#trackRun((async () => {
			if (origin.specialApproval) {
				try {
					if (!request.specialRef || request.executionKind !== "consultation")
						throw new EngineTargetError("stale_target", "Consultant approval requires the exact consultation Start");
					await this.#requestConsultantApproval(binding, origin.specialApproval, request.specialRef,
						promptInput, preparedAttachments?.originalAttachments, images);
				} catch (error) {
					await this.#settleAttempt(binding, binding.attemptId, binding.session.messages.length,
						"failed", error instanceof Error ? error.message : String(error));
					return;
				}
			}
			await this.#runPrompt(
				binding,
				promptInput,
				{
					sourceCommandId: request.commandId,
					...(preparedAttachments ? { originalAttachments: preparedAttachments.originalAttachments } : {}),
					...(request.clientMessageId
						? { clientMessageId: request.clientMessageId }
						: queuedItem?.sourceType === "user"
							? { clientMessageId: queuedItem.sourceEventId }
							: {}),
				},
				preparedHistory?.dispatchKind ??
					(explicitContinue &&
					request.input === undefined &&
					!queuedItem &&
					!preparedAttachments?.originalAttachments.length
						? "continue"
						: undefined),
				request.context,
				{ agentInstanceRef: request.agentInstanceRef },
				images,
			);
		})());
		this.#signalInboxWake();
		return {
			...this.#snapshot(binding),
			duplicate: false,
			executorChoice: binding.execution.choice,
			...(preparedHistory ? { historyEdit: preparedHistory.result } : {}),
			...(queuedItem ? { queueId: queuedItem.queueId, queueRevision: queuedItem.revision + 1 } : {}),
		};
		} finally {
			if (ownsPreparedSession && preparedSession)
				await this.#discardPreparedSession(request.agentInstanceId, preparedSession);
		}
	}

	async #discardPreparedSession(agentInstanceId: string, sessionManager: SessionManager): Promise<void> {
		const sessionFile = sessionManager.getSessionFile();
		sessionManager.seal();
		const errors: unknown[] = [];
		await collectFailure(errors, () => sessionManager.close());
		// The prepared fork was never bound: its native generation goes to reclaim.
		if (sessionFile)
			await collectFailure(errors, () => this.store.abandonNativeGeneration(agentInstanceId, sessionFile));
		throwCollectedFailures(errors, "Prepared session cleanup failed");
	}

	#inboxTarget(binding: LiveBinding): EngineInboxTarget {
		return { ...this.#snapshot(binding), sessionId: binding.session.sessionId };
	}

	async #invokeEngineInbox(binding: LiveBinding, request: EngineInboxToolRequest): Promise<EngineInboxItem[]> {
		switch (request.action) {
			case "list":
				return await this.store.listInboxItems(binding.session.sessionId, request.includeTerminal);
			case "read": {
				const item = await this.store.getInboxItem(binding.session.sessionId, request.queueId);
				return item ? [item] : [];
			}
			case "reorder": {
				const { items, event } = await this.store.reorderInboxItemsWithEvent(
					this.#inboxTarget(binding),
					request.mutationId,
					request.expectedOrder,
					request.desiredOrder,
				);
				if (event) this.#notifyEvents([event]);
				this.#signalInboxWake();
				return items;
			}
			default: {
				const { item, event } = await this.store.mutateInboxItemWithEvent(this.#inboxTarget(binding), {
					mutationId: request.mutationId,
					queueId: request.queueId,
					expectedRevision: request.expectedRevision,
					op: request.action,
					value: request.value,
				});
				if (event) this.#notifyEvents([event]);
				this.#signalInboxWake();
				return [item];
			}
		}
	}

	async #runInboxWakeLoop(): Promise<void> {
		while (!this.#disposed) {
			const signal = this.#inboxWakeSignal.promise;
			try {
				const dueAt = await this.store.nextInboxWakeAt(this.engineGeneration);
				if (dueAt === undefined) {
					await signal;
					continue;
				}
				await waitForEngineWake(signal, dueAt - Date.now());
				if (this.#disposed) break;
				const events = await this.store.claimDueInboxWakes(this.engineGeneration);
				this.#notifyEvents(events);
			} catch (error) {
				if (!this.#disposed) logger.warn("Engine inbox wake loop failed", { error: String(error) });
				await Bun.sleep(1_000);
			}
		}
	}

	#signalInboxWake(): void {
		const current = this.#inboxWakeSignal;
		this.#inboxWakeSignal = Promise.withResolvers<void>();
		current.resolve();
	}

	/** Takes ownership of `resolved`: it is disposed with the binding or on any startup failure. */
	async #openBinding(
		request: EngineStartRequest,
		resolved: ResolvedEngineExecution,
		continuationDigest: string,
		executionDigest: string,
		choice: ExecutorChoice,
		frozen: readonly EngineExecutionRoute[],
		priorBinding: EngineBindingSnapshot | undefined,
		bindingGeneration: number,
		restoreReceipt?: RestoreWorkspaceReceipt,
		compatibilityDigest?: string,
		preparedSessionManager?: SessionManager,
		pendingStartSignal?: AbortSignal,
		audit?: LatencyAudit,
		approvalSettings?: { timeout_seconds: number; settings_revision: number; settings_hash: string },
		recoverSession = false,
	): Promise<LiveBinding> {
		let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
		let unsubscribeCreated: (() => void) | undefined;
		let sessionManager = preparedSessionManager;
		const uncommittedForkSessionFile = preparedSessionManager?.getSessionFile();
		const disposeResolved = resolved?.dispose;
		let mcpManager: MCPManager | undefined;
		try {
			if (preparedSessionManager && !uncommittedForkSessionFile)
				throw new Error("Prepared session was not durably materialized");
			pendingStartSignal?.throwIfAborted();
			audit?.mark("binding_history_start");
			const prior = priorBinding;
			const config = request.executionConfiguration;
			// L1 is the immutable admitted baseline (choice.selected); a later route change
			// reaches the model only through its durable hidden message, never a prompt rebuild.
			const l1Rules = l1For(config.instruction_sources, choice.selected);
			const route = engineRouteToken(request.agentInstanceId);
			const sessionDir = path.join(this.#sessionRoot, route);
			let previousInboxSessionId: string | undefined;
			if (recoverSession && prior?.sessionFile)
				sessionManager = await SessionManager.openNative(this.#nativeSessionStorage(prior.sessionFile), sessionDir);
			if (
				!recoverSession &&
				!preparedSessionManager &&
				prior?.sessionFile &&
				await this.#sameAdmittedBinding(prior, request) &&
				(prior.continuationDigest === continuationDigest ||
					(restoreReceipt &&
						prior.continuationDigest === compatibilityDigest &&
						prior.bindingId === restoreReceipt.oldBindingId)) &&
				config.continuationPolicy !== "fresh"
			) {
				sessionManager = await SessionManager.openNative(this.#nativeSessionStorage(prior.sessionFile), sessionDir);
			} else if (!recoverSession && !preparedSessionManager) {
				previousInboxSessionId = prior?.sessionFile
					? await this.#conversationCarrySource(
							prior,
							request,
							restoreReceipt,
						)
					: undefined;
				if (prior?.sessionFile && previousInboxSessionId) {
					// A changed execution gets a fresh runtime; only the durable conversation is forked.
					const source = this.#nativeSessionStorage(prior.sessionFile);
					const { familyId } = parseNativeSessionLocator(prior.sessionFile);
					const target = new RocksNativeSessionStorage(this.store.storageClient, familyId, crypto.randomUUID());
					sessionManager = await SessionManager.forkNativeContext(source, target, request.cwd, sessionDir).catch(
						error => {
							throw new Error("Retained AgentSession conversation could not be loaded", { cause: error });
						},
					);
					// Workspace roots are authority, not conversation history.
					await sessionManager.setAdditionalDirectories([]);
				} else {
					sessionManager = SessionManager.createNative(
						request.cwd,
						new RocksNativeSessionStorage(this.store.storageClient, request.agentInstanceId, crypto.randomUUID()),
						sessionDir,
					);
				}
			}
			audit?.mark("binding_history_done");
			const id = engineAgentId(request.agentInstanceId);
			const pauseGate = new AgentPauseGate();
			let liveBinding: LiveBinding | undefined;
			const toolExecutionHook: ToolExecutionHook = {
				before: (call, signal) => {
					if (!liveBinding) throw new Error("Engine tool boundary is not bound to its AgentSession");
					return this.#beforeToolExecution(liveBinding, call, signal);
				},
				after: (call, token, outcome) => this.#afterToolExecution(token, call, outcome),
			};
			const spawn = config.dispatch.spawn;
			const maxChildren = spawn.allowed === "no" ? 0 : spawn.max_children;
			const engineChildLauncher =
				this.#launchChild && spawn.allowed !== "no" &&
					(spawn.max_depth > 0 && maxChildren > 0 || spawn.on_exceed === "approve")
					? {
							parentAgentInstanceRef: request.agentInstanceRef,
							launch: async (child: {
								target: WorkTarget;
								assignment: string;
								toolCallId: string;
								signal?: AbortSignal;
							}) => {
								const parent = liveBinding;
								if (!parent) throw new Error("Engine child launcher is not bound to its parent Attempt");
								if (!parent.bindingSnapshot)
									throw new EngineTargetError("source_unavailable", "Parent Attempt binding is unavailable");
								const spawnApprovalReceiptId = parent.spawnApprovals.get(child.toolCallId);
								if (!spawnApprovalReceiptId &&
									(spawn.max_depth < 1 ||
										(!parent.childLaunches.has(child.toolCallId) && parent.childLaunches.size >= maxChildren)))
									throw new EngineTargetError("capacity_unavailable", "Child spawn ceiling reached");
								parent.childLaunches.add(child.toolCallId);
								try {
									return await this.#launchChild!({
										...child,
										...(spawnApprovalReceiptId ? { spawnApprovalReceiptId } : {}),
										parentAgentInstanceId: parent.agentInstanceId,
										parentAgentInstanceRef: request.agentInstanceRef,
										parentAttemptId: parent.attemptId,
										parentBindingSnapshot: parent.bindingSnapshot,
										principalId: request.principalId,
										authorityGeneration: request.authorityGeneration,
										cwd: request.cwd,
										enrollChild: async (agentInstanceRef, attemptId) => {
											const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
											await this.store.registerAgent({
												agentInstanceId,
												agentInstanceRef,
												parentAgentInstanceId: parent.agentInstanceId,
												parentAgentInstanceRef: request.agentInstanceRef!,
												principalId: request.principalId,
												authorityGeneration: request.authorityGeneration,
											});
											parent.childWaits.set(child.toolCallId, { agentInstanceId, attemptId });
											this.#notifyPauseProgress(parent);
										},
									});
								} finally {
									parent.spawnApprovals.delete(child.toolCallId);
									parent.childWaits.delete(child.toolCallId);
									this.#notifyPauseProgress(parent);
								}
							},
						}
					: undefined;
			audit?.mark("binding_child_history_start");
			const engineHistory = await this.#retainedDirectChildHistory(request, prior);
			audit?.mark("binding_child_history_done");
			const sessionOptions: CreateAgentSessionOptions = {
				...this.#sessionDefaults,
				cwd: request.cwd,
				sessionManager,
				// L1 renders before L2/L3; byte-identical on recovery (renderRules over the frozen config).
				systemPrompt: config.continuationConfiguration.systemPrompt || l1Rules
					? defaultPrompt => [
						...defaultPrompt,
						renderRules(l1Rules),
						config.continuationConfiguration.systemPrompt,
					].filter((block): block is string => typeof block === "string" && block.length > 0)
					: undefined,
				providerPromptCacheKey: config.continuationConfiguration.providerPromptCacheKey ?? undefined,
				spawns: spawn.allowed === "no" ? "" : "*",
				toolNames: config.continuationConfiguration.toolNames,
				restrictToolNames: config.continuationConfiguration.restrictToolNames,
				enableMCP: config.continuationConfiguration.enableMCP,
				enableLsp: config.continuationConfiguration.enableLsp,
				outputSchema: config.continuationConfiguration.outputSchema ?? undefined,
				requireYieldTool: config.continuationConfiguration.requireYieldTool,
				...resolved.options,
				providerRequestHook: {
					wrapFetch: (model, fetch) => {
						const wrapped = createProviderRetryBudgetHook(
							resolved?.options.providerRequestHook ?? this.#sessionDefaults?.providerRequestHook,
						).wrapFetch(model, (input, init) => latencyFetch(fetch, input, init));
						return async (input, init) => {
							if (!liveBinding) throw new Error("Provider boundary has no Engine binding");
							markProviderLatency("intent_admission_start");
							await this.#admitEffect(
								liveBinding,
								() => this.store.assertIntent(liveBinding!.agentInstanceId, undefined, true),
								init?.signal ?? undefined,
							);
							markProviderLatency("intent_admission_done");
							return await wrapped(input, init);
						};
					},
				},
				disableExtensionDiscovery: true,
				extensions: [],
				additionalExtensionPaths: [],
				extensionRoots: undefined,
				preloadedExtensions: undefined,
				preloadedExtensionPaths: undefined,
				preloadedPreparedExtensions: undefined,
				customTools: [],
				preloadedCustomToolPaths: [],
				interactivePrompts: true,
				toolExecutionHook,
				recoverPendingApprovalTools: recoverSession,
				engineChildLauncher,
				engineInbox: {
					invoke: request => {
						if (!liveBinding) throw new Error("Engine inbox is not bound to its AgentSession");
						return this.#invokeEngineInbox(liveBinding, request);
					},
				},
				engineHistory,
				// Engine-only projection: hides other Attempts' rule deltas from the model
				// (durable history keeps them); after compaction one authoritative current-rules
				// block is rebuilt from durable state, no LLM call.
				engineContextProjection: (messages: AgentMessage[]) => projectExecutorRulesContext(messages, {
					attemptId: request.attemptId,
					rules: l1For(config.instruction_sources, currentIdentity(liveBinding?.execution.choice ?? choice)),
					compactionEntryId: () => {
						const branch = sessionManager!.getContextBranch();
						const entry = branch.findLast(
							(item): item is Extract<SessionEntry, { type: "compaction" }> => item.type === "compaction",
						);
						return entry?.id ?? null;
					},
				}),
				agentId: id,
				agentDisplayName: request.displayName ?? request.agentInstanceId,
				agentDelegationHint: request.delegationHint,
				agentRegistry: this.agentRegistry,
				agentLifecycle: this.agentLifecycle,
				asyncJobManager: this.asyncJobManager,
				ircBus: this.ircBus,
				attemptId: request.attemptId,
				turnRetryPolicy: {
					delaysMs: ENGINE_TURN_RETRY_DELAYS_MS,
					sharedFallbackBudget: true,
					transientOnly: true,
					exactSchedule: true,
					allowRetryAfterBeyondMaxDelay: true,
					deferNestedProviderRetries: true,
					orderedRouteFallback: {
						selectors: resolved.selectors.filter((selector): selector is string => selector !== undefined),
						beforeApply: async (selector, signal) => {
							const parent = liveBinding;
							if (!parent || parent.attemptState !== "running") return false;
							const index = parent.execution.selectors.indexOf(selector);
							if (index <= 0) return false;
							const candidate = parent.execution.frozen[index];
							if (!candidate) return false;
							const requirement = parent.execution.config.dispatch.requirement;
							if (requirement.fallback_mode === "none" ||
								(requirement.fallback_mode === "same_model" &&
									candidate.model_id !== parent.execution.choice.selected.model_id) ||
								(requirement.require_trusted_provider && !candidate.execution.trusted))
								return false;
							const billing = await parent.execution.verifyCandidate(index, parent.execution.choice.execution_digest, signal);
							if (!candidate.billing_pools.some(pool => pool.pool_id === billing.billing_pool_id)) return false;
							const updated = {
								...parent.execution.choice.selected,
								...candidateIdentity(candidate),
								...billing,
								order_match: candidate.order_match,
							};
							const digest = executionHash({
								schema: "artel.execution.v2",
								dispatchHash: parent.dispatchHash,
								executionConfiguration: parent.execution.config,
								record_revisions: parent.execution.config.record_revisions,
								scope_revision: parent.execution.config.scope_revision,
								candidates: parent.execution.choice.candidates,
								selected: updated,
							});
							const changed = await this.store.commitExecutorRoute(
								this.#snapshot(parent), candidateIdentity(updated), "route_fallback",
								digest, parent.execution.config.routingLimits,
							);
							if (!changed) return false;
							if (changed.event.kind !== "executor_route_changed")
								throw new EngineTargetError("stale_target", "Fallback did not commit its route event");
							parent.execution.activateCandidate(index, digest);
							parent.executionDigest = digest;
							parent.execution.choice = changed.choice;
							(parent.execution.ruleEventsPending ??= []).push(changed.event.payload.event_id);
							this.#notifyEvents([changed.event]);
							return true;
						},
						afterApply: async () => {
							const parent = liveBinding;
							if (!parent) throw new EngineTargetError("stale_target", "Executor binding disappeared after route admission");
							// Persist and append before retry sends its first provider request. A nextTurn queue
							// may not drain during fallback and is not evidence that the rule was delivered.
							const eventIds = parent.execution.ruleEventsPending;
							if (!eventIds?.length) throw new EngineTargetError("stale_target", "Fallback lost its committed rule events");
							for (const eventId of eventIds)
								await this.#repairExecutorRuleMessages(parent, parent.execution.choice, parent.execution.config, eventId);
							parent.execution.ruleEventsPending = undefined;
						},
					},
				},
				pauseGate,
				parentAgentId: request.parentAgentInstanceId ? engineAgentId(request.parentAgentInstanceId) : undefined,
				engineMode: true,
				expectedAgentRef: null,
			};
			if (!resolved?.options.settings && prior?.sessionFile && sessionOptions.settings &&
				path.relative(path.resolve(request.cwd), path.resolve(sessionOptions.settings.getCwd())) !== "") {
				// Retained Agents may explicitly move workspaces; static defaults must not keep the old project scope.
				sessionOptions.settings = await sessionOptions.settings.cloneForCwd(request.cwd);
			}
			if (this.#mcpServer) {
				// A hosted session uses its own signed Attempt context, never ambient MCP authority.
				sessionOptions.mcpManager = undefined;
				if (sessionOptions.enableMCP !== false && sessionOptions.restrictToolNames !== true) {
					const authorization = this.#mcpServer.headers?.Authorization;
					if (!authorization?.startsWith("Bearer "))
						throw new EngineTargetError("source_unavailable", "Hosted MCP caller attestation requires local bearer");
					const callerContext = JSON.stringify({
						agentInstanceRef: request.agentInstanceRef,
						attemptId: request.attemptId,
						bindingRevision: request.bindingSnapshot.bindingRevision,
						dispatchHash: request.dispatchHash,
					});
					const callerAttestation = `hmac-sha256:${crypto.createHmac("sha256", authorization.slice(7))
						.update("grimoire-client-caller-context-v1\0").update(callerContext).digest("hex")}`;
					const attestToolCall: NonNullable<MCPHttpServerConfig["attestToolCall"]> =
						async (toolCallId, toolName, mcpName, input, outbound) => {
							const active = liveBinding;
							const inputHash = sha256(stableStringifyJson(input));
							const effectId = active
								? `tool_${sha256(`${active.bindingId}\0${request.attemptId}\0${toolCallId}\0${inputHash}`).slice(0, 32)}`
								: "";
							const record = this.#toolInvocations.get(effectId);
							const effect = effectId ? await this.store.getEffect(effectId) : undefined;
							if (!active || active.attemptId !== request.attemptId || !record ||
								record.toolCallId !== toolCallId || record.toolName !== toolName ||
								record.inputHash !== inputHash || record.target.bindingId !== active.bindingId ||
								effect?.state !== "started" || effect.effect_kind !== "tool" ||
								effect.attempt_id !== request.attemptId || effect.binding_id !== active.bindingId ||
								effect.tool_call_id !== toolCallId || effect.tool_name !== toolName ||
								effect.input_hash !== inputHash)
								throw new EngineTargetError("stale_target", "MCP call lacks its persisted started ToolEffect");
							const canonicalCallHash = `sha256:${crypto.createHash("sha256")
								.update(storageCanonicalJson({ name: mcpName, arguments: outbound })).digest("hex")}`;
							const context = JSON.stringify({
								agentInstanceRef: request.agentInstanceRef, attemptId: request.attemptId,
								bindingRevision: request.bindingSnapshot.bindingRevision, dispatchHash: request.dispatchHash,
								effectId, toolCallId, toolName: mcpName, canonicalCallHash,
							});
							return {
								"X-Grimoire-Client-Caller-Context": context,
								"X-Grimoire-Client-Caller-Attestation": `hmac-sha256:${crypto.createHmac("sha256", authorization.slice(7))
									.update("grimoire-client-caller-context-v1\0").update(context).digest("hex")}`,
							};
						};
					const requestEscalation: NonNullable<MCPHttpServerConfig["requestEscalation"]> =
						(toolCallId, toolName, subject, hash, signal) => {
							if (!liveBinding) throw new EngineTargetError("stale_target", "Escalation binding was released");
							return this.#requestEscalation(liveBinding, toolCallId, toolName, subject, hash, signal);
						};
					audit?.mark("binding_mcp_connect_start");
					mcpManager = new MCPManager(request.cwd, null);
					const ready = Promise.withResolvers<void>();
					try {
						await Promise.all([
							ready.promise,
							mcpManager.connectServers({ grimoire_engine: {
								...this.#mcpServer,
								attestToolCall,
								requestEscalation,
								headers: {
									...this.#mcpServer.headers,
									"X-Grimoire-Client-Caller-Context": callerContext,
									"X-Grimoire-Client-Caller-Attestation": callerAttestation,
								},
							} }, {}, event => {
								if (event.type === "connected") ready.resolve();
								if (event.type === "failed") ready.reject(new Error(safeHostedMcpFailure(event.error)));
							}),
						]);
					} catch (error) {
						await mcpManager.disconnectAll();
						throw error;
					}
					sessionOptions.mcpManager = mcpManager;
					audit?.mark("binding_mcp_connect_done");
				}
			}
			audit?.mark("binding_session_create_start");
			created = await createAgentSession(sessionOptions);
			audit?.mark("binding_session_create_done");
			if (mcpManager) {
				const session = created.session;
				audit?.mark("binding_mcp_refresh_start");
				await session.refreshMCPTools(mcpManager.getTools());
				audit?.mark("binding_mcp_refresh_done");
				mcpManager.setOnToolsChanged(async tools => {
					if (session.isDisposed) return;
					await session.refreshMCPTools(tools).catch(() => {
						logger.error("Hosted Core MCP catalog refresh failed");
					});
				});
			}

			const binding: LiveBinding = {
				principalId: request.principalId,
				bindingId: `${route}:${bindingGeneration}`,
				commandId: request.commandId,
				bindingSnapshot: request.bindingSnapshot,
				approvalSettings: approvalSettings ?? {
					timeout_seconds: 300, settings_revision: 0,
					settings_hash: executionHash({ approval_timeout_seconds: 300 }),
				},
				agentInstanceId: request.agentInstanceId,
				executionId: request.executionId,
				attemptId: request.attemptId,
				engineAgentId: id,
				sessionFile: created.session.sessionFile,
				executionDigest: executionDigest,
				continuationDigest,
				dispatchRef: request.dispatchRef,
				dispatchHash: request.dispatchHash,
				...(previousInboxSessionId ? { previousInboxSessionId } : {}),
				...(uncommittedForkSessionFile ? { uncommittedForkSessionFile } : {}),
				attemptState: "accepted",
				state: "idle",
				engineGeneration: this.engineGeneration,
				bindingGeneration,
				authorityGeneration: request.authorityGeneration,
				manualHold: prior?.manualHold ?? false,
				intentRevision: prior?.intentRevision ?? 0,
				...(prior?.intentCommandId ? { intentCommandId: prior.intentCommandId } : {}),
				session: created.session,
				mcpManager,
				steerCommandIds: [],
				steerCommandSet: new Set(),
				unsubscribe: () => {},
				disposeExecution: resolved.dispose,
				execution: { config, frozen: [...frozen], selectors: resolved.selectors, choice,
					verifyCandidate: resolved.verifyCandidate, activateCandidate: resolved.activateCandidate },
				requireYieldTool: config.continuationConfiguration.requireYieldTool,
				outputSchema: sessionOptions.outputSchema,
				pauseGate,
				activeToolCallIds: new Set(),
				childWaits: new Map(),
				spawnApprovals: new Map(),
				approvalGrants: new Map(),
				parkedEffectTools: new Set(),
				pauseProgress: Promise.withResolvers<void>(),
				pauseCommandIds: new Set(),
				pauseRequests: new Map(),
				resumeCommandIds: new Set(),
				resumeMessageCommands: new Set(),
				traceWriteTail: Promise.resolve(),
				traceTools: new Map(),
				childLaunches: new Set(),
				modelCallSequence: 0,
				assistantMessageSequence: 0,
				measuredUsage: new Map(),
				activeModelCalls: new Set(),
				directUploads: new Map(),
			};
			liveBinding = binding;
			resolved.setBillingPoolChanged((proposal, signal) => this.#reconcileBillingPool(binding, proposal, signal));
			this.#bindMessagePersistence(binding);
			created.session.setAssistantMessagePersistence((message, event) =>
				this.#recordAssistantDelta(binding, message.timestamp, event),
			);
			created.setToolUIContext(
				{
					...noOpUIContext,
					askDialog: (questions, dialogOptions) => this.#requestInput(binding, questions, dialogOptions?.signal),
				},
				true,
			);
			const session = created.session;
			const manager = session.sessionManager;
			const previousEntryAppended = manager.onEntryAppended;
			let observingEntries = true;
			const onEntryAppended = (entry: SessionEntry) => {
				try {
					previousEntryAppended?.(entry);
				} finally {
					if (entry.type === "message" && entry.message.role === "assistant" &&
						entry.assistantMessageId && binding.measuredUsage.has(entry.assistantMessageId)) {
						const message = entry.message;
						binding.lastAssistantNativeEntry = { messageId: entry.assistantMessageId, entryId: entry.id };
						// The final snapshot is already queued. Its native entry and ownership pointer
						// must be durable before the model effect closes and any tool can be admitted.
						void this.#queueBindingWrite(binding, entry.id, async () => {
							await this.#settleActiveModelEffect(binding,
								message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "completed",
								message.errorMessage);
						});
					}
					if (entry.type === "message" && entry.message.role === "user") {
						const target = this.#snapshot(binding);
						const sessionId = manager.getSessionId();
						const sessionFile = manager.getSessionFile();
						const current = () =>
							observingEntries &&
							!this.#disposed &&
							this.#bindings.get(target.agentInstanceId) === binding &&
							binding.session === session &&
							manager.getSessionId() === sessionId &&
							manager.getSessionFile() === sessionFile &&
							binding.sessionFile === sessionFile &&
							binding.bindingId === target.bindingId &&
							binding.attemptId === target.attemptId &&
							binding.executionId === target.executionId &&
							binding.authorityGeneration === target.authorityGeneration &&
							!TERMINAL_ATTEMPT_STATES.has(binding.attemptState) &&
							binding.attemptState !== "cancel_requested";
						// The append tap is synchronous; indexed storage may still have queued writes.
						const checkpoint = this.#queueBindingWrite(binding, { type: "user_checkpoint" }, async () =>
							current() ? manager.flushAndCheckpoint() : undefined,
						);
						const failed = (error: unknown) => {
							if (current() && !(error instanceof StreamAdmissionError)) binding.messageWriteError ??= error;
						};
						// Earlier history writes may need this lane; drain them before acquiring it.
						this.#trackRun(
							enqueueStreamWork(
								binding.streamAdmission?.signal.aborted ? undefined : binding.streamAdmission,
								checkpoint,
								target,
								async () => {
									const durable = await checkpoint;
									const uploads = entry.clientMessageId
										? binding.directUploads.get(entry.clientMessageId)
										: undefined;
									if (durable && uploads) {
										binding.directUploads.delete(entry.clientMessageId!);
										// The durable entry owns the bodies now; a row left behind only waits for its TTL.
										await this.store.consumeUploads(uploads).catch(error =>
											logger.warn("Delivered upload rows remain until their TTL", {
												error: error instanceof Error ? error.message : String(error),
											}),
										);
									}
									await this.#inLane(target.agentInstanceId, async () => {
										if (!durable || !current()) return;
										await this.#commitAttemptTransition(binding, binding.attemptState, [], {
											expectedStates: [binding.attemptState],
											transcriptCheckpoint: durable,
										});
									});
								},
							).catch(failed),
						);
					}
				}
			};
			manager.onEntryAppended = onEntryAppended;
			const detachModelAdmission = session.agent.addBeforeModelCallHook(async signal => {
				const checkpoint = await this.#effectCheckpoint(binding);
				await binding.traceWriteTail;
				if (binding.messageWriteError) throw binding.messageWriteError;
				if (binding.modelEffect) return;
				const effect = this.#nextModelEffect(binding, sha256(stableStringifyJson(session.messages)));
				const started = await this.#admitEffect(binding,
					() => this.store.startModelEffect(this.#snapshot(binding), effect, checkpoint), signal);
				binding.modelEffect = effect;
				setProviderObservationModel(effect);
				this.#notifyEvents([started]);
			});
			const unsubscribe = session.subscribe(event => {
				if (event.type === "message_start" && event.message.role === "assistant") {
					this.#queueExecutorRoute(binding, "active", event.message);
					this.#beginAssistantStream(binding, event.message.timestamp);
				}
				if (
					event.type === "message_update" &&
					event.message.role === "assistant" &&
					(event.assistantMessageEvent.type === "text_start" ||
						event.assistantMessageEvent.type === "text_delta" ||
						event.assistantMessageEvent.type === "text_end")
				) {
					this.#updateAssistantStream(binding, event.message.timestamp, event.message.content);
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					this.#settleAssistantStream(binding, event.message);
				}
				if (event.type === "message_end") this.#queueHistoryCheckpoint(binding);
				if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end") {
					this.#queueTraceEvent(binding, "trace_reasoning", { state: "completed" });
				}
				if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") {
					this.#queueTraceEvent(binding, "trace_reasoning", { state: "started" });
				}
				if (event.type === "tool_execution_start") {
					binding.activeToolCallIds.add(event.toolCallId);
					let traceName = event.toolName;
					if (
						traceName === "write" &&
						typeof event.args === "object" &&
						event.args !== null &&
						"path" in event.args &&
						typeof event.args.path === "string" &&
						event.args.path.startsWith("xd://mcp__")
					) {
						traceName = event.args.path.slice("xd://".length);
					}
					binding.traceTools.set(event.toolCallId, {
						name: traceName,
						startedAt: Date.now(),
					});
					this.#queueTraceEvent(binding, "trace_tool", { tool: { callId: event.toolCallId, name: traceName } });
				}
				if (event.type === "tool_execution_end") {
					binding.activeToolCallIds.delete(event.toolCallId);
					const started = binding.traceTools.get(event.toolCallId);
					binding.traceTools.delete(event.toolCallId);
					this.#queueTraceEvent(binding, "trace_tool", {
						tool: {
							callId: event.toolCallId,
							name: started?.name ?? event.toolName,
							outcome: event.isError ? "failed" : "ok",
							...(started ? { took: Math.max(0, Math.round((Date.now() - started.startedAt) / 100) / 10) } : {}),
						},
					});
					this.#notifyPauseProgress(binding);
				}
				if (event.type === "auto_retry_start") {
					this.#queueExecutorRoute(binding, "loading");
					const model = binding.session.model;
					const retry = {
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						...(model ? { route: `${model.provider}/${model.id}` } : {}),
						delayMs: event.delayMs,
						scheduledAt: Date.now() + event.delayMs,
						outcome: "waiting" as const,
						error: event.errorMessage.slice(0, 2_048),
					};
					this.#queueRetryEvent(binding, "retry_scheduled", retry);
				}
				if (event.type === "auto_retry_end") {
					const model = binding.session.model;
					const retry = {
						attempt: event.attempt,
						maxAttempts: ENGINE_TURN_RETRY_DELAYS_MS.length,
						...(model ? { route: `${model.provider}/${model.id}` } : {}),
						outcome: event.success
							? ("succeeded" as const)
							: event.finalError === "Retry cancelled"
								? ("cancelled" as const)
								: ("failed" as const),
						...(event.finalError ? { error: event.finalError.slice(0, 2_048) } : {}),
					};
					this.#queueRetryEvent(binding, "retry_settled", retry);
				}
				if (event.type === "profile_route_exhausted" && event.reason === "routes_unavailable") {
					this.#queueExecutorRoute(binding, "exhausted");
				}
				if (event.type === "agent_end" && event.isTerminal !== false && binding.state === "running") {
					this.agentRegistry.setStatus(binding.engineAgentId, "idle", binding.session);
				}
			});
			binding.unsubscribe = () => {
				observingEntries = false;
				binding.session.setMessagePersistedHandler(null);
				unsubscribe();
				detachModelAdmission();
				if (manager.onEntryAppended === onEntryAppended) manager.onEntryAppended = previousEntryAppended;
			};
			unsubscribeCreated = binding.unsubscribe;
			this.#bindings.set(request.agentInstanceId, binding);
			return binding;
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			if (unsubscribeCreated) await collectFailure(cleanupErrors, unsubscribeCreated);
			const createdSession = created?.session;
			if (createdSession) await collectFailure(cleanupErrors, () => createdSession.dispose());
			if (!createdSession && sessionManager && !uncommittedForkSessionFile) {
				const openedManager = sessionManager;
				await collectFailure(cleanupErrors, () => openedManager.close());
			}
			const createdMcpManager = mcpManager;
			if (createdMcpManager) await collectFailure(cleanupErrors, () => createdMcpManager.disconnectAll());
			// Only the unbound prepared generation is reclaimed, never its inherited source.
			if (uncommittedForkSessionFile && sessionManager) {
				const forkSessionManager = sessionManager;
				await collectFailure(cleanupErrors, () => this.#discardPreparedSession(request.agentInstanceId, forkSessionManager));
			}
			if (disposeResolved) await collectFailure(cleanupErrors, disposeResolved);
			if (cleanupErrors.length > 0) {
				logger.warn("Engine binding startup cleanup failed", {
					errors: cleanupErrors.map(item => (item instanceof Error ? item.message : String(item))),
				});
			}
			throw error;
		}
	}

	async #retainedDirectChildHistory(
		request: EngineStartRequest,
		prior: EngineBindingSnapshot | undefined,
	): Promise<EngineHistoryAccess> {
		const access: EngineHistoryAccess = {
			refs: [],
			readMessages: async (id, sessionFile) => {
				const agentInstanceId = await this.store.agentInstanceIdForEngineAgent(id);
				if (!agentInstanceId) return await this.#readSessionMessages(sessionFile);
				return await this.#inLane(agentInstanceId, async () => {
					const archive = await this.store.getHistoryArchive(agentInstanceId);
					if (archive && archive.state !== "restored" && archive.binding.sessionFile === sessionFile) {
						throw new EngineTargetError("history_expired", "This history is archived; restore it before reading");
					}
					return await this.#readSessionMessages(sessionFile);
				});
			},
		};
		const parentTaskRef = request.bindingSnapshot?.taskRef;
		if (
			!prior?.sessionFile ||
			request.executionConfiguration.continuationPolicy === "fresh" ||
			prior.authorityGeneration !== request.authorityGeneration ||
			!(await this.#sameAdmittedBinding(prior, request)) ||
			!request.bindingSnapshot
		) {
			return access;
		}
		const canonicalCwd = await canonicalWorkspacePath(request.cwd);
		const refs: Array<{ id: string; parentId: string; sessionFile: string }> = [];
		for (const child of await this.store.listRetainedDirectChildHistory(request.agentInstanceId, request.bindingSnapshot!)) {
			const snapshot = child.bindingSnapshot;
			if (!snapshot || snapshot.taskRef !== parentTaskRef ||
				snapshot.parentAgentInstanceRef !== request.agentInstanceRef ||
				snapshot.parentBindingRevision !== request.bindingSnapshot?.bindingRevision ||
				snapshot.parentAttemptId === null) continue;
			if (child.engineAgentId !== engineAgentId(child.agentInstanceId)) continue;
			const loaded = await this.#nativeSessionStorage(child.sessionFile).readContext();
			const mappedCwd = (
				await resolveRestoreWorkspace(
					this.store,
					child.agentInstanceId,
					child.sessionFile,
					loaded.checkpoint.header,
					loaded.position,
				)
			)?.cwd;
			const header = await this.#sessionHeader(child.sessionFile);
			if (header?.type !== "session" || typeof header.cwd !== "string") continue;
			if ((await canonicalWorkspacePath(mappedCwd ?? header.cwd)) !== canonicalCwd) continue;
			refs.push({
				id: child.engineAgentId,
				parentId: engineAgentId(request.agentInstanceId),
				sessionFile: child.sessionFile,
			});
		}
		return { ...access, refs };
	}

	async #sameAdmittedBinding(prior: EngineBindingSnapshot, request: EngineStartRequest): Promise<boolean> {
		if (prior.bindingSnapshot) return sameSemanticBinding(prior.bindingSnapshot, request.bindingSnapshot);
		const identity = await this.store.getStartConversationIdentity(prior.commandId);
		if (identity?.bindingSnapshot) return sameSemanticBinding(identity.bindingSnapshot, request.bindingSnapshot);
		// A trusted r0 snapshot proves the immutable legacy binding without parsing its provenance URI.
		// Never enrich an owned row, and never rewrite the retained digests or completed Attempt.
		if (request.bindingSnapshot?.bindingRevision === 0 && request.bindingSnapshot.installationId === null &&
			identity?.operation === "start" && identity.agentInstanceRef === request.agentInstanceRef &&
			identity.agentInstanceRef?.startsWith("grimoire://tasks/") &&
			identity.agentInstanceId === request.agentInstanceId &&
			identity.parentAgentInstanceId === request.parentAgentInstanceId)
			return true;
		return false;
	}

	async #continuationDigest(request: EngineStartRequest, canonicalCwdOverride?: string): Promise<string> {
		const config = request.executionConfiguration;
		const canonicalCwd =
			canonicalCwdOverride === undefined
				? await canonicalWorkspacePath(request.cwd)
				: canonicalRetainedWorkspacePath(canonicalCwdOverride);
		return executionHash({
			schema: "artel.continuation.v2",
			agentInstanceRef: request.agentInstanceRef,
			parentAgentInstanceRef: request.parentAgentInstanceRef ?? null,
			authorityGeneration: request.authorityGeneration,
			canonicalCwd,
			continuationPolicy: config.continuationPolicy,
			continuationConfiguration: config.continuationConfiguration,
			stableDependencyDigest: config.stableDependencyDigest,
			sessionDefaults: config.sessionDefaults,
		});
	}

	async #conversationCarrySource(
		prior: EngineBindingSnapshot,
		request: EngineStartRequest,
		restoreReceipt?: RestoreWorkspaceReceipt,
	): Promise<string | undefined> {
		if (!prior.sessionFile || request.executionConfiguration.continuationPolicy === "fresh") return undefined;
		if (prior.authorityGeneration !== request.authorityGeneration) return undefined;
		if (!(await this.#sameAdmittedBinding(prior, request))) return undefined;
		const identity = await this.store.getStartConversationIdentity(prior.commandId);
		if (identity?.operation !== "start" || identity.agentInstanceId !== request.agentInstanceId ||
			identity.agentInstanceRef !== request.agentInstanceRef ||
			identity.parentAgentInstanceId !== request.parentAgentInstanceId ||
			identity.authorityGeneration !== request.authorityGeneration || identity.principalId !== request.principalId)
			return undefined;
		let header: SessionHeader | undefined;
		try {
			header = await this.#sessionHeader(prior.sessionFile);
		} catch (error) {
			throw new Error("Retained AgentSession conversation could not be loaded", { cause: error });
		}
		if (header?.type !== "session" || typeof header.cwd !== "string") {
			throw new Error("Retained AgentSession conversation is missing or invalid");
		}
		const retainedCwd = restoreReceipt?.oldBindingId === prior.bindingId ? restoreReceipt.originalCwd : request.cwd;
		if (canonicalRetainedWorkspacePath(header.cwd) !== canonicalRetainedWorkspacePath(retainedCwd)) return undefined;
		return header.id;
	}


	async #requestInput(
		binding: LiveBinding,
		questions: ExtensionAskDialogQuestion[],
		signal?: AbortSignal,
	): Promise<ExtensionAskDialogResult | undefined> {
		signal?.throwIfAborted();
		const completion = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
		const pending: PendingInput = {
			inputId: `input_${crypto.randomUUID().replaceAll("-", "")}`,
			questions,
			resolve: completion.resolve,
		};
		// Reject an unusable input shape to the invoking tool before creating pending state.
		runtimeInputPreview(
			runtimeInputBody({
				...binding,
				kind: "input_requested",
				eventId: 1,
				seq: 0,
				causationCommandId: binding.commandId,
				createdAt: Date.now(),
				payload: { inputId: pending.inputId, questions },
			}),
		);
		await this.#inLane(binding.agentInstanceId, async () => {
			if (
				this.#bindings.get(binding.agentInstanceId) !== binding ||
				binding.state !== "running" ||
				binding.attemptState !== "running"
			) {
				throw new Error(`Attempt ${binding.attemptId} cannot request input while ${binding.attemptState}`);
			}
			if (binding.pendingInput) throw new Error(`Attempt ${binding.attemptId} already has pending input`);
			binding.pendingInput = pending;
			binding.attemptState = "waiting_input";
			try {
				await this.#commitAttemptTransition(
					binding,
					"waiting_input",
					[
						{
							kind: "input_requested",
							payload: {
								inputId: pending.inputId,
								inputKind: "ask",
								questions,
								attemptState: "waiting_input",
								controlReadiness: controlReadiness("waiting_input"),
							},
						},
					],
					{ expectedStates: ["running"] },
				);
			} catch (error) {
				binding.pendingInput = undefined;
				binding.attemptState = "running";
				throw error;
			}
		});
		const abort = () => {
			if (binding.pendingInput !== pending || binding.attemptState !== "waiting_input") return;
			binding.attemptState = "running";
			void this.#cancelPendingInput(binding, "Input request aborted", undefined, "running", true);
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		return await completion.promise.finally(() => signal?.removeEventListener("abort", abort));
	}

	async #cancelPendingInput(
		binding: LiveBinding,
		reason: string,
		causationCommandId?: string,
		attemptState = binding.attemptState,
		persistState = false,
	): Promise<void> {
		const pending = binding.pendingInput;
		if (!pending) return;
		binding.pendingInput = undefined;
		try {
			const event = {
				kind: "input_resolved" as const,
				payload: {
					inputId: pending.inputId,
					status: "cancelled",
					reason: reason.slice(0, 2_048),
					attemptState,
					controlReadiness: controlReadiness(attemptState),
				},
				causationCommandId,
			};
			if (persistState) {
				await this.#commitAttemptTransition(binding, attemptState, [event], { expectedStates: ["waiting_input"] });
			} else await this.#commitEvent(binding, event.kind, event.payload, causationCommandId);
		} catch (error) {
			logger.warn("Engine input cancellation event write failed", {
				inputId: pending.inputId,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			pending.resolve(undefined);
		}
	}

	async #beforeToolExecution(
		binding: LiveBinding,
		call: ToolExecutionHookCall,
		signal?: AbortSignal,
	): Promise<ToolExecutionHookToken | undefined> {
		// The tool's source blocks must be durable before publishing its admission.
		const checkpoint = await this.#effectCheckpoint(binding);
		await binding.traceWriteTail;
		if (binding.messageWriteError) throw binding.messageWriteError;
		const policy = binding.execution.config.continuationConfiguration.toolPolicies[call.toolName] ?? "unrestricted";
		const input = stableStringifyJson(call.input);
		const inputHash = sha256(input);
		const invocationId = `tool_${sha256(`${binding.bindingId}\0${binding.attemptId}\0${call.toolCallId}\0${inputHash}`).slice(0, 32)}`;
		if (this.#toolInvocations.has(invocationId)) {
			throw new Error(`Tool invocation ${invocationId} is already active`);
		}
		const done = Promise.withResolvers<void>();
		const record: ToolInvocationRecord = {
			invocationId,
			policy,
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			inputHash,
			origin:
				binding.toolOrigins?.attemptId === binding.attemptId
					? binding.toolOrigins.blocks.get(call.toolCallId)
					: undefined,
			target: this.#snapshot(binding),
			done: done.promise,
			resolveDone: done.resolve,
			settled: false,
		};
		this.#toolInvocations.set(invocationId, record);
		if (binding.recoveryCallIds?.includes(call.toolCallId)) {
			const effect = await this.store.getEffect(invocationId);
			const approval = await this.store.getApproval(invocationId);
			if (!effect || !approval || effect.tool_call_id !== call.toolCallId ||
				effect.tool_name !== call.toolName || effect.input_hash !== inputHash ||
				approval.request.effect_id !== invocationId ||
				approval.request.requester_attempt_id !== binding.attemptId) {
				this.#toolInvocations.delete(invocationId);
				record.resolveDone();
				throw new EngineTargetError("stale_target", "Recovered tool call differs from its original effect");
			}
			if (effect.state === "started" && approval.request.kind === "escalation") return { invocationId };
			if (approval.state === "pending" && effect.state === "planned")
				return await this.#requestToolApproval(record, signal);
			if (approval.request.status === "approved" &&
				(effect.state === "planned" || (effect.state === "started" && approval.request.kind === "escalation"))) {
				if (effect.state === "planned")
					this.#notifyEvents([await this.store.activateApprovedToolEffect(this.#snapshot(binding), invocationId)]);
				if (approval.request.kind === "spawn" && approval.decision_record?.origin_receipt_id)
					binding.spawnApprovals.set(call.toolCallId, approval.decision_record.origin_receipt_id);
				return { invocationId };
			}
			this.#toolInvocations.delete(invocationId);
			record.resolveDone();
			throw new EngineTargetError("cancelled", `Recovered tool approval was ${approval.request.status}`);
		}
		const spawn = binding.execution.config.dispatch.spawn;
		if (call.toolName === "task" && spawn.allowed !== "no" &&
			(spawn.max_depth < 1 || binding.childLaunches.size >= spawn.max_children)) {
			try {
				if (spawn.on_exceed !== "approve" || !this.#reserveChild || !binding.bindingSnapshot)
					throw new EngineTargetError("capacity_unavailable", "Child spawn ceiling reached");
				const child = call.input as { target?: WorkTarget; assignment?: string };
				if (!child.target || typeof child.assignment !== "string")
					throw new EngineTargetError("invalid_request", "Child target and assignment are required");
				const subject = await this.#reserveChild({
					parentAgentInstanceRef: binding.bindingSnapshot.agentInstanceRef,
					parentAttemptId: binding.attemptId, parentBindingSnapshot: binding.bindingSnapshot,
					principalId: binding.principalId, authorityGeneration: binding.authorityGeneration,
					target: child.target, assignment: child.assignment, toolCallId: call.toolCallId,
					cwd: binding.session.settings.getCwd(), signal,
				});
				return await this.#requestToolApproval(record, signal, subject);
			} catch (error) {
				this.#toolInvocations.delete(invocationId);
				record.resolveDone();
				throw error;
			}
		}
		if (policy === "permit") return await this.#requestToolApproval(record, signal);
		try {
			binding.parkedEffectTools.add(call.toolCallId);
			const event = await this.#admitEffect(
				binding,
				() => this.store.startToolEffect(record.target, this.#toolEffect(record), checkpoint),
				signal,
			).finally(() => binding.parkedEffectTools.delete(call.toolCallId));
			this.#notifyEvents([event]);
			return { invocationId };
		} catch (error) {
			this.#toolInvocations.delete(invocationId);
			record.resolveDone();
			throw error;
		}
	}

	#armApprovalDeadline(binding: LiveBinding, request: ApprovalRequest, backoff = 0): void {
		clearTimeout(this.#approvalTimers.get(request.id));
		if (!request.expires_at || this.#disposed) return;
		const delay = backoff || Math.max(0, Date.parse(request.expires_at) - Date.now());
		const timer = setTimeout(() => {
			this.#approvalTimers.delete(request.id);
			this.#trackRun(this.#inLane(binding.agentInstanceId, async () => {
				if (this.#disposed || this.#bindings.get(binding.agentInstanceId) !== binding) return;
				const current = await this.store.getApproval(request.id);
				if (current?.state !== "pending" ||
					current.request.address_revision !== request.address_revision) return;
				const timedOut = current.request.addressed_to.kind === "attempt"
					? [...current.timed_out_attempt_ids, current.request.addressed_to.attempt_id]
					: current.timed_out_attempt_ids;
				const address = current.request.addressed_to.kind === "human"
					? { kind: "human" as const, principal_id: binding.principalId }
					: await this.#addressApproval(binding, current.request.kind, current.request.name,
						current.request.subject, timedOut);
				if (address === "unknown") {
					this.#armApprovalDeadline(binding, current.request, 2_000);
					return;
				}
				const expiresAt = address.kind === "human" ? null
					: new Date(Date.now() + current.request.timeout_seconds * 1_000).toISOString();
				const events = await this.store.readdressApproval(this.#snapshot(binding), request.id,
					request.address_revision, address, expiresAt);
				this.#notifyEvents(events);
				if (!events.length) return;
				const updated = await this.store.getApproval(request.id);
				if (!updated) return;
				if (address.kind === "human") {
					const cause = { kind: "approval_deadline" as const,
						request_id: request.id, address_revision: updated.request.address_revision };
					binding.approvalPauseCause = cause;
					if (binding.attemptState === "running") {
						binding.pauseGate.pause();
						binding.attemptState = "pause_requested";
						await this.#commitAttemptTransition(binding, "pause_requested", [{
							kind: "pause_requested", payload: { cause },
						}], { expectedStates: ["running"], cause: "approval_deadline" });
						this.#trackRun(this.#finishPause(binding, binding.attemptId));
					}
				} else this.#armApprovalDeadline(binding, updated.request);
			}).catch(error => logger.warn("Approval deadline handling failed", { error: String(error) })));
		}, delay);
		this.#approvalTimers.set(request.id, timer);
	}

	async #requestConsultantApproval(binding: LiveBinding,
		special: { kind: "consultant"; unavailable_pin: unknown; proposed_reselection_hash: string } | null,
		ref: NonNullable<EngineStartRequest["specialRef"]>,
		input: string, originals?: SessionMessageIdentity["originalAttachments"], images?: ImageContent[]): Promise<void> {
		if (!special || special.kind !== "consultant" || !binding.bindingSnapshot)
			throw new EngineTargetError("stale_target", "Consultant approval lacks exact Start provenance");
		const modelCallId = "model-1";
		const effect: EngineModelEffectInput = {
			effectId: `model_${sha256(`${binding.bindingId}\0${binding.attemptId}\0${modelCallId}`).slice(0, 32)}`,
			modelCallId, inputHash: modelInputHash(input, originals, images),
		};
		const subject: Extract<ApprovalRequest, { kind: "consultant" }>["subject"] = {
			call_id: ref.occurrenceOrCallId, definition_ref: ref.definitionRef,
			definition_revision: ref.revision, dispatch_hash: binding.dispatchHash,
			unavailable_pin: special.unavailable_pin as Extract<ApprovalRequest, { kind: "consultant" }>["subject"]["unavailable_pin"],
			proposed_reselection_hash: special.proposed_reselection_hash,
		};
		const address = await this.#addressApproval(binding, "consultant", "grimoire_consultant_run", subject);
		const addressedTo: ApprovalAddressee = address === "unknown"
			? binding.bindingSnapshot.parentAgentInstanceRef && binding.bindingSnapshot.parentAttemptId
				? { kind: "attempt", agent_ref: binding.bindingSnapshot.parentAgentInstanceRef,
					attempt_id: binding.bindingSnapshot.parentAttemptId }
				: { kind: "human", principal_id: binding.principalId }
			: address;
		const now = new Date();
		const timeoutSeconds = binding.approvalSettings.timeout_seconds;
		const request: ApprovalRequest = {
			schema: "grimoire.approval_request.v1", id: effect.effectId,
			principal_id: binding.principalId, requester_agent_ref: binding.bindingSnapshot.agentInstanceRef,
			requester_attempt_id: binding.attemptId,
			requester_binding_revision: binding.bindingSnapshot.bindingRevision,
			dispatch_hash: binding.dispatchHash, effect_id: effect.effectId,
			kind: "consultant", name: "grimoire_consultant_run", subject,
			requires_human: false, reason: "Consultant route pin unavailable",
			created_at: now.toISOString(), addressed_to: addressedTo, addressed_at: now.toISOString(),
			expires_at: new Date(now.getTime() + timeoutSeconds * 1_000).toISOString(),
			address_revision: 1, decision_revision: 0, status: "pending",
			timeout_seconds: timeoutSeconds,
			settings_revision: binding.approvalSettings.settings_revision,
			settings_hash: binding.approvalSettings.settings_hash,
		};
		validateRuntimeValue("approvalRequest", request);
		const pending = Promise.withResolvers<"approve" | "deny">();
		this.#pendingConsultants.set(effect.effectId, pending);
		try {
			const event = await this.store.requestModelApproval(this.#snapshot(binding), effect, request,
				await this.#effectCheckpoint(binding));
			binding.consultantEffectId = effect.effectId;
			this.#notifyEvents([event]);
			this.#armApprovalDeadline(binding, request);
			if (await pending.promise !== "approve")
				throw new EngineTargetError("cancelled", "Consultant route reselection denied");
		} finally {
			this.#pendingConsultants.delete(effect.effectId);
		}
	}

	/** Broker a child preparation challenge on the original native task ToolEffect. */
	async requestChildEscalation(request: {
		parentAgentInstanceId: string;
		parentAttemptId: string;
		parentBindingSnapshot: EngineSemanticBindingSnapshot;
		toolCallId: string;
		subject: Record<string, unknown>;
		subjectHash: string;
		signal?: AbortSignal;
	}): Promise<{ receiptId: string; effectId: string }> {
		const binding = this.#bindings.get(request.parentAgentInstanceId);
		if (!binding || binding.attemptId !== request.parentAttemptId ||
			!binding.bindingSnapshot ||
			!sameSemanticBinding(binding.bindingSnapshot, request.parentBindingSnapshot))
			throw new EngineTargetError("stale_target", "Child escalation requires the current parent Attempt");
		const record = [...this.#toolInvocations.values()].find(item =>
			item.target.bindingId === binding.bindingId && item.toolCallId === request.toolCallId &&
			item.toolName === "task");
		if (!record) throw new EngineTargetError("stale_target", "Original native task ToolEffect is missing");
		const receiptId = await this.#requestEscalation(binding, request.toolCallId, "task",
			request.subject, request.subjectHash, request.signal);
		if (this.#bindings.get(binding.agentInstanceId) !== binding ||
			binding.attemptState !== "running" || binding.manualHold)
			throw new EngineTargetError("stale_target", "Parent Attempt changed before child retry");
		return { receiptId, effectId: record.invocationId };
	}

	async #requestEscalation(binding: LiveBinding, toolCallId: string, toolName: string,
		subject: Record<string, unknown>, subjectHash: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		const record = [...this.#toolInvocations.values()].find(item =>
			item.target.bindingId === binding.bindingId && item.toolCallId === toolCallId &&
			item.toolName === toolName);
		const effect = record && await this.store.getEffect(record.invocationId);
		if (!binding.bindingSnapshot || !record || effect?.state !== "started" ||
			effect.effect_kind !== "tool" || effect.input_hash !== record.inputHash ||
			`sha256:${sha256(storageCanonicalJson(subject))}` !== subjectHash ||
			this.#pendingEscalations.has(record.invocationId))
			throw new EngineTargetError("stale_target", "Escalation requires the exact started MCP ToolEffect and subject hash");
		const existing = await this.store.getApproval(record.invocationId);
		if (existing && (existing.request.kind !== "escalation" ||
			existing.request.requester_attempt_id !== binding.attemptId ||
			storageCanonicalJson(existing.request.subject) !== storageCanonicalJson(subject)))
			throw new EngineTargetError("stale_target", "Escalation differs from the retained tool effect");
		if (existing?.request.status === "approved") {
			if (!existing.decision_record?.origin_receipt_id)
				throw new EngineTargetError("stale_target", "Escalation approval lacks its original receipt");
			return existing.decision_record.origin_receipt_id;
		}
		if (existing?.state === "resolved")
			throw new EngineTargetError("cancelled", "Escalation was denied or cancelled");
		const now = new Date();
		const timeoutSeconds = binding.approvalSettings.timeout_seconds;
		const approval: ApprovalRequest = {
			schema: "grimoire.approval_request.v1", id: record.invocationId,
			principal_id: binding.principalId, requester_agent_ref: binding.bindingSnapshot.agentInstanceRef,
			requester_attempt_id: binding.attemptId,
			requester_binding_revision: binding.bindingSnapshot.bindingRevision,
			dispatch_hash: binding.dispatchHash, effect_id: record.invocationId,
			kind: "escalation", name: String(subject.kind),
			subject: subject as Extract<ApprovalRequest, { kind: "escalation" }>["subject"],
			requires_human: true, reason: `Human approval required for ${subject.kind}`,
			created_at: now.toISOString(), addressed_to: { kind: "human", principal_id: binding.principalId },
			addressed_at: now.toISOString(),
			expires_at: new Date(now.getTime() + timeoutSeconds * 1_000).toISOString(),
			address_revision: 1, decision_revision: 0, status: "pending",
			timeout_seconds: timeoutSeconds,
			settings_revision: binding.approvalSettings.settings_revision,
			settings_hash: binding.approvalSettings.settings_hash,
		};
		validateRuntimeValue("approvalRequest", approval);
		const pending = Promise.withResolvers<EngineApprovalDecision["approvalDecision"]>();
		this.#pendingEscalations.set(record.invocationId, pending);
		const abort = () => {
			pending.reject(new EngineTargetError("cancelled", "Escalation call was cancelled"));
			if (this.#disposed) return;
			void this.#inLane(binding.agentInstanceId, async () => {
				if ((await this.store.getApproval(record.invocationId))?.state !== "pending") return;
				this.#notifyEvents(await this.store.resolveApproval(this.#snapshot(binding),
					record.invocationId, "cancelled", null));
			}).catch(error => logger.warn("Escalation cancellation failed", { error: String(error) }));
		};
		signal?.addEventListener("abort", abort, { once: true });
		binding.parkedEffectTools.add(toolCallId);
		this.#notifyPauseProgress(binding);
		try {
			if (existing?.state === "pending") this.#armApprovalDeadline(binding, existing.request);
			else {
				const event = await this.store.requestStartedEffectApproval(this.#snapshot(binding), record.invocationId, approval);
				this.#notifyEvents([event]);
				this.#armApprovalDeadline(binding, approval);
			}
			const decision = await pending.promise;
			if (decision.decision !== "approve")
				throw new EngineTargetError("cancelled", "Escalation denied");
			return decision.origin_receipt_id;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.#pendingEscalations.delete(record.invocationId);
			binding.parkedEffectTools.delete(toolCallId);
			this.#notifyPauseProgress(binding);
		}
	}

	async #requestToolApproval(record: ToolInvocationRecord, signal?: AbortSignal,
		spawnSubject?: Extract<ApprovalRequest, { kind: "spawn" }>["subject"]): Promise<ToolExecutionHookToken> {
		signal?.throwIfAborted();
		const completion = Promise.withResolvers<{
			decision: "approve" | "deny" | "cancelled";
			reason?: string;
			causationCommandId?: string;
			receiptId?: string;
		}>();
		const pending: PendingToolApproval = { record, resolve: completion.resolve };
		this.#pendingToolApprovals.set(record.invocationId, pending);
		try {
			const binding = this.#bindings.get(record.target.agentInstanceId);
			if (!binding?.bindingSnapshot) throw new EngineTargetError("stale_target", "Approval binding was released");
			const existing = await this.store.getApproval(record.invocationId);
			const name = spawnSubject ? spawnSubject.exceeded.join("+") : record.toolName;
			const subject = spawnSubject ?? {
				tool_name: record.toolName, call_hash: `sha256:${record.inputHash}`,
				ceiling_hash: executionHash(binding.execution.config.continuationConfiguration.tools_permit),
			};
			const address = existing?.state === "pending" ? existing.request.addressed_to
				: await this.#addressApproval(binding, spawnSubject ? "spawn" : "tool", name, subject);
			const addressedTo: ApprovalAddressee = address === "unknown"
				? binding.bindingSnapshot.parentAgentInstanceRef && binding.bindingSnapshot.parentAttemptId
					? { kind: "attempt", agent_ref: binding.bindingSnapshot.parentAgentInstanceRef,
						attempt_id: binding.bindingSnapshot.parentAttemptId }
					: { kind: "human", principal_id: binding.principalId }
				: address;
			const now = new Date();
			const timeoutSeconds = binding.approvalSettings.timeout_seconds;
			const request: ApprovalRequest = existing?.state === "pending" ? existing.request : {
				schema: "grimoire.approval_request.v1",
				id: record.invocationId,
				principal_id: binding.principalId,
				requester_agent_ref: binding.bindingSnapshot.agentInstanceRef,
				requester_attempt_id: binding.attemptId,
				requester_binding_revision: binding.bindingSnapshot.bindingRevision,
				dispatch_hash: binding.dispatchHash,
				effect_id: record.invocationId,
				...(spawnSubject ? { kind: "spawn" as const, name, subject: spawnSubject } :
					{ kind: "tool" as const, name, subject: subject as Extract<ApprovalRequest, { kind: "tool" }>["subject"] }),
				requires_human: false,
				reason: `Permission requested for ${record.toolName}`,
				created_at: now.toISOString(),
				addressed_to: addressedTo,
				addressed_at: now.toISOString(),
				expires_at: new Date(now.getTime() + timeoutSeconds * 1000).toISOString(),
				address_revision: 1,
				decision_revision: 0,
				status: "pending",
				timeout_seconds: timeoutSeconds,
				settings_revision: binding.approvalSettings.settings_revision,
				settings_hash: binding.approvalSettings.settings_hash,
			};
			validateRuntimeValue("approvalRequest", request);
			if (existing?.state === "pending" && existing.request.requester_attempt_id === binding.attemptId &&
				existing.request.kind === request.kind) {
				this.#armApprovalDeadline(binding, existing.request);
			} else {
				const checkpoint = await this.#effectCheckpoint(binding);
				const event = await this.#admitEffect(
					binding,
					() => this.store.requestToolApproval(record.target, this.#toolEffect(record), request, checkpoint),
					signal,
				);
				this.#notifyEvents([event]);
				this.#armApprovalDeadline(binding, request);
			}
		} catch (error) {
			this.#pendingToolApprovals.delete(record.invocationId);
			this.#toolInvocations.delete(record.invocationId);
			record.resolveDone();
			throw error;
		}
		const abort = () => {
			if (this.#disposed || this.#pendingToolApprovals.get(record.invocationId) !== pending) return;
			void this.#cancelPendingToolApproval(pending, "Attempt cancelled while awaiting approval").catch(error => {
				logger.warn("Engine tool approval cancellation failed", {
					approvalId: record.invocationId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		};
		signal?.addEventListener("abort", abort, { once: true });
		const decision = await completion.promise.finally(() => signal?.removeEventListener("abort", abort));
		if (decision.decision === "approve") {
			if (spawnSubject || (await this.store.getApproval(record.invocationId))?.request.kind === "spawn") {
				const binding = this.#bindings.get(record.target.agentInstanceId);
				if (!decision.receiptId || !binding || binding.attemptId !== record.target.attemptId)
					throw new EngineTargetError("stale_target", "Approved child requires a receipt on the original parent Attempt");
				binding.spawnApprovals.set(record.toolCallId, decision.receiptId);
			}
			return { invocationId: record.invocationId };
		}
		this.#toolInvocations.delete(record.invocationId);
		record.resolveDone();
		throw new Error(
			decision.decision === "deny"
				? `Tool call denied by approval: ${record.toolName}`
				: `Tool approval cancelled: ${record.toolName}`,
		);
	}

	#bindMessagePersistence(binding: LiveBinding): void {
		binding.session.setMessagePersistedHandler(async message => {
			if (message.role !== "toolResult") return;
			// A device invocation (`<outer>:xd:<name>`) has no toolResult of its own: the outer result makes it durable.
			const device = `${message.toolCallId}:xd:`;
			const records = [...this.#toolInvocations.values()]
				.filter(
					candidate =>
						candidate.target.bindingId === binding.bindingId &&
						candidate.target.attemptId === binding.attemptId &&
						(candidate.toolCallId === message.toolCallId || candidate.toolCallId.startsWith(device)),
				)
				// Devices settle before the call that ran them.
				.sort((a, b) => Number(a.toolCallId === message.toolCallId) - Number(b.toolCallId === message.toolCallId));
			if (!records.length) return;
			// Runs inside the persistence slot: draining that slot here would deadlock.
			const checkpoint = await binding.session.sessionManager.flushAndCheckpoint();
			for (const record of records) {
				record.checkpoint = checkpoint;
				if (record.outcome)
					await this.#completeToolInvocation(
						record,
						record.outcome.status,
						record.outcome.error,
						record.outcome.jobIds,
					);
			}
		});
	}

	#attachStorageFailure(): void {
		this.#storageFailureUnsubscribe = this.store.storageClient.onFailure(error => {
			this.#storageFailure = error;
			for (const pending of this.#pendingStarts) pending.controller.abort(error);
			for (const binding of this.#bindings.values()) {
				binding.manualHold = true;
				binding.messageWriteError = error;
				binding.session.agent.abort(error);
			}
			for (const approval of this.#pendingToolApprovals.values())
				approval.resolve({ decision: "cancelled", reason: error.message });
			this.#pendingToolApprovals.clear();
			for (const record of this.#toolInvocations.values()) record.resolveDone();
			this.#toolInvocations.clear();
		});
	}

	async #effectCheckpoint(binding: LiveBinding): Promise<SessionDurabilityCheckpoint | undefined> {
		await binding.session.settleInFlightMessagePersistence();
		return binding.session.sessionManager.flushAndCheckpoint();
	}

	#afterToolExecution(
		token: ToolExecutionHookToken,
		call: ToolExecutionHookCall,
		outcome: ToolExecutionHookOutcome,
	): void {
		const record = this.#toolInvocations.get(token.invocationId);
		if (!record || record.toolCallId !== call.toolCallId || record.toolName !== call.toolName) return;
		const jobs = this.asyncJobManager
			.getAllJobs({ ownerId: record.target.engineAgentId, attemptId: record.target.attemptId })
			.filter(job => job.sourceToolCallId === record.toolCallId);
		const settle = async () => {
			const failed = jobs.find(job => job.status === "failed");
			const cancelled = jobs.find(job => job.status === "cancelled");
			record.outcome = {
				status: outcome.isError || failed ? "failed" : cancelled ? "cancelled" : "completed",
				error: outcome.error ?? failed?.errorText,
				jobIds: jobs.map(job => job.id),
			};
			// Native completion is gated by the toolResult persistence callback.
			if (record.checkpoint)
				await this.#completeToolInvocation(
					record,
					record.outcome.status,
					record.outcome.error,
					record.outcome.jobIds,
				);
		};
		void (jobs.length ? Promise.all(jobs.map(job => job.promise)).then(settle) : settle()).catch(error =>
			this.#toolSettlementFailed(record, error),
		);
	}

	#toolSettlementFailed(record: ToolInvocationRecord, error: unknown): void {
		const failure = error instanceof Error ? error : new Error(String(error));
		const binding = this.#bindings.get(record.target.agentInstanceId);
		if (binding && binding.bindingId === record.target.bindingId) {
			binding.messageWriteError = failure;
			binding.session.agent.abort(failure);
		}
		this.#toolInvocations.delete(record.invocationId);
		record.resolveDone();
		logger.warn("Engine tool effect settlement failed", {
			invocationId: record.invocationId,
			error: failure.message,
		});
	}

	async #completeToolInvocation(
		record: ToolInvocationRecord,
		status: "completed" | "failed" | "cancelled",
		error?: string,
		jobIds?: string[],
	): Promise<void> {
		if (record.settled) return;
		record.settled = true;
		try {
			const options = { ...(error ? { error: error.slice(0, 2_048) } : {}), ...(jobIds?.length ? { jobIds } : {}) };
			const event = await this.store.settleToolEffect(record.target, record.invocationId, status, {
				...options,
				checkpoint: record.checkpoint,
			});
			this.#notifyEvents([event]);
			this.#toolInvocations.delete(record.invocationId);
			record.resolveDone();
		} catch (error) {
			this.#toolSettlementFailed(record, error);
			throw error;
		}
	}

	#toolEffect(record: ToolInvocationRecord): EngineToolEffectInput {
		return {
			effectId: record.invocationId,
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			policy: record.policy,
			inputHash: record.inputHash,
			...(record.origin ? { origin: record.origin } : {}),
		};
	}

	async #waitForToolInvocations(binding: LiveBinding, attemptId: string): Promise<void> {
		for (;;) {
			const pending = [...this.#toolInvocations.values()].filter(
				record => record.target.bindingId === binding.bindingId && record.target.attemptId === attemptId,
			);
			if (pending.length === 0) return;
			await Promise.all(pending.map(record => record.done));
		}
	}

	async #cancelToolApprovals(binding: LiveBinding, reason: string, causationCommandId?: string): Promise<void> {
		for (const pending of this.#pendingToolApprovals.values()) {
			if (
				pending.record.target.bindingId !== binding.bindingId ||
				pending.record.target.attemptId !== binding.attemptId
			) {
				continue;
			}
			await this.#cancelPendingToolApproval(pending, reason, causationCommandId);
		}
	}

	async #cancelPendingToolApproval(
		pending: PendingToolApproval,
		reason: string,
		causationCommandId?: string,
	): Promise<void> {
		const approvalId = pending.record.invocationId;
		if (this.#pendingToolApprovals.get(approvalId) !== pending) return;
		const events = await this.store.resolveApproval(pending.record.target, approvalId, "cancelled", null, {
			causationCommandId,
		});
		this.#notifyEvents(events);
		if (this.#pendingToolApprovals.get(approvalId) !== pending) return;
		this.#pendingToolApprovals.delete(approvalId);
		pending.resolve({ decision: "cancelled", reason, causationCommandId });
	}

	/** Cancel an Engine child when its parent task call is aborted. */
	async cancelAgentInstance(target: EnginePendingStartTarget & { commandId: string }, reason: string): Promise<void> {
		for (const pending of this.#pendingStarts) {
			if (pending.target.agentInstanceId === target.agentInstanceId &&
				pending.target.executionId === target.executionId && pending.target.attemptId === target.attemptId)
				pending.controller.abort(new Error(reason));
		}
		const binding = this.#bindings.get(target.agentInstanceId);
		if (
			!binding || binding.executionId !== target.executionId || binding.attemptId !== target.attemptId ||
			binding.authorityGeneration !== target.authorityGeneration || binding.engineGeneration !== target.engineGeneration ||
			(binding.attemptState !== "running" &&
				binding.attemptState !== "pause_requested" &&
				binding.attemptState !== "paused" &&
				binding.attemptState !== "waiting_input")
		) {
			const cancelled = await this.store.cancelPendingStart(target, target.commandId);
			if (cancelled.event) this.#notifyEvents([cancelled.event]);
			return;
		}
		// The start command owns the Attempt terminal event, including parent-driven cancellation.
		await this.#branchControl({ ...this.#snapshot(binding), commandId: binding.commandId, reason }, "stop", false);
	}

	async #resumeApprovedTool(binding: LiveBinding, id: string): Promise<void> {
		await this.#inLane(binding.agentInstanceId, async () => {
			if (this.#disposed || this.#bindings.get(binding.agentInstanceId) !== binding ||
				binding.attemptState !== "paused" || binding.manualHold) return;
			const approval = await this.store.getApproval(id);
			if (approval?.state !== "resolved" ||
				!["approved", "denied"].includes(approval.request.status)) return;
			try {
				const route = await this.#resumeRouting(binding);
				await this.#commitAttemptTransition(binding, "running", [{
					kind: "resumed", payload: { cause: binding.approvalPauseCause },
				}], { expectedStates: ["paused"], routingResume: route,
					intentGuard: { expectedRevision: binding.intentRevision, requireUnheld: true } });
			} catch (error) {
				if (error instanceof EngineRoutingQueuedError) {
					if (!this.#approvalRoutingWakes.has(binding.agentInstanceId)) {
						this.#approvalRoutingWakes.add(binding.agentInstanceId);
						this.#trackRun((async () => {
							try {
								await waitForEngineWake(this.store.changeSignal(), 1_000);
							} finally {
								this.#approvalRoutingWakes.delete(binding.agentInstanceId);
							}
							if (!this.#disposed) await this.#resumeApprovedTool(binding, id);
						})());
					}
					return;
				}
				logger.warn("Decided approval awaits same-Attempt FIFO routing", {
					requestId: id, error: safeEngineErrorDetail(error),
				});
				if (!this.#transientRecoveryFailure(error)) {
					await this.#commitEvent(this.#snapshot(binding), "paused", {
						cause: "approval_recovery_refused",
						code: error instanceof EngineTargetError ? error.code : "stale_target",
						reason: safeEngineErrorDetail(error),
					});
				} else if (!this.#recoveryTimers.has(binding.agentInstanceId)) {
					const timer = setTimeout(() => {
						this.#recoveryTimers.delete(binding.agentInstanceId);
						this.#trackRun(this.#resumeApprovedTool(binding, id));
					}, 2_000);
					timer.unref?.();
					this.#recoveryTimers.set(binding.agentInstanceId, timer);
				}
				return;
			}
			clearTimeout(this.#recoveryTimers.get(binding.agentInstanceId));
			this.#recoveryTimers.delete(binding.agentInstanceId);
			binding.attemptState = "running";
			binding.approvalPauseCause = undefined;
			binding.pauseGate.resume();
			this.#notifyPauseProgress(binding);
			if (binding.recoveryCallIds?.length) {
				this.#trackRun(this.#runPrompt(binding, "", undefined, "pending_tool"));
				return;
			}
			const effect = await this.store.getEffect(id);
			if (effect?.state === "planned" && approval.request.status === "approved")
				this.#notifyEvents([await this.store.activateApprovedToolEffect(this.#snapshot(binding), id)]);
			const pending = this.#pendingToolApprovals.get(id);
			if (pending) {
				this.#pendingToolApprovals.delete(id);
				pending.resolve({
					decision: approval.request.status === "denied" ? "deny" : "approve",
					receiptId: approval.decision_record?.origin_receipt_id,
					reason: approval.decision_record?.reason ?? undefined,
				});
			}
			const escalation = this.#pendingEscalations.get(id);
			if (escalation && approval.decision_record) {
				this.#pendingEscalations.delete(id);
				escalation.resolve(approval.decision_record);
			}
			const consultant = this.#pendingConsultants.get(id);
			if (consultant) {
				this.#pendingConsultants.delete(id);
				consultant.resolve(approval.request.status === "denied" ? "deny" : "approve");
			}
		});
	}

	async #finishPause(binding: LiveBinding, attemptId: string): Promise<void> {
		while (
			!this.#disposed &&
			this.#bindings.get(binding.agentInstanceId) === binding &&
			binding.attemptState === "pause_requested" &&
			binding.attemptId === attemptId
		) {
			const changed = this.store.changeSignal();
			const progress = binding.pauseProgress.promise;
			const suspended = new Set<string>(binding.parkedEffectTools);
			for (const [toolCallId, child] of binding.childWaits) {
				const childBinding = child.attemptId ? undefined : await this.store.getBinding(child.agentInstanceId);
				const childAttempt = await this.store.getAttempt(child.attemptId ?? childBinding?.attemptId ?? "");
				if (
					childAttempt
						? ["paused", "waiting_input", "completed", "cancelled", "failed", "interrupted"].includes(
								childAttempt.state,
							)
						: (await this.store.intent(child.agentInstanceId)).manualHold
				)
					suspended.add(toolCallId);
			}
			for (const pending of this.#pendingToolApprovals.values())
				if (pending.record.target.bindingId === binding.bindingId) suspended.add(pending.record.toolCallId);
			if (binding.pendingInput)
				for (const [id, tool] of binding.traceTools) if (tool.name === "ask") suspended.add(id);
			const active = [...binding.activeToolCallIds].some(id => !suspended.has(id));
			if (
				!active &&
				(binding.pauseGate.parked || suspended.size > 0 || binding.pendingInput || !binding.session.isStreaming)
			)
				break;
			await Promise.race([
				changed,
				progress,
				...(binding.pauseGate.parked ? [] : [binding.pauseGate.waitUntilParked()]),
			]);
		}
		if (this.#disposed || this.#bindings.get(binding.agentInstanceId) !== binding) return;
		const transcriptCheckpoint = await binding.session.sessionManager.flushAndCheckpoint();
		await this.#inLane(binding.agentInstanceId, async () => {
			if (this.#disposed || this.#bindings.get(binding.agentInstanceId) !== binding) return;
			if (binding.attemptId !== attemptId || binding.attemptState !== "pause_requested") return;
			const events: EngineTransitionEvent<EngineOrdinaryEvent>[] = [...binding.pauseRequests].map(([commandId, initiator]) => ({
				kind: "paused" as const,
				payload: controlPayload(initiator, "paused", false, binding),
				causationCommandId: commandId,
			}));
			if (binding.approvalPauseCause)
				events.push({ kind: "paused", payload: { cause: binding.approvalPauseCause },
					causationCommandId: undefined });
			await this.#commitAttemptTransition(binding, "paused", events, {
				expectedStates: ["pause_requested"],
				cause: binding.approvalPauseCause ? "approval_deadline" : undefined,
				transcriptCheckpoint,
			});
			binding.attemptState = "paused";
			binding.pauseRequests.clear();
			if (binding.approvalPauseCause && !binding.manualHold)
				for (const [id, pending] of this.#pendingToolApprovals) {
					if (pending.record.target.bindingId === binding.bindingId &&
						["approved", "denied"].includes((await this.store.getApproval(id))?.request.status ?? ""))
						this.#trackRun(this.#resumeApprovedTool(binding, id));
				}
			if (binding.approvalPauseCause && !binding.manualHold)
				for (const id of this.#pendingEscalations.keys())
					if (["approved", "denied"].includes((await this.store.getApproval(id))?.request.status ?? ""))
						this.#trackRun(this.#resumeApprovedTool(binding, id));
			if (binding.approvalPauseCause && !binding.manualHold)
				for (const id of this.#pendingConsultants.keys())
					if (["approved", "denied"].includes((await this.store.getApproval(id))?.request.status ?? ""))
						this.#trackRun(this.#resumeApprovedTool(binding, id));
		});
	}

	#notifyPauseProgress(binding: LiveBinding): void {
		binding.pauseProgress.resolve();
		binding.pauseProgress = Promise.withResolvers<void>();
	}

	async #reconcileBillingPool(binding: LiveBinding, proposal: BillingPoolProposal, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (this.#bindings.get(binding.agentInstanceId) !== binding || binding.attemptState !== "running")
			throw new EngineTargetError("stale_target", "Billing transition requires the current running Attempt");
		const choice = binding.execution.choice;
		const current = binding.execution.frozen.find(route =>
			candidateRef(route) === candidateRef(currentIdentity(choice)));
		if (!current) throw new EngineTargetError("stale_target", "Billing route is outside the frozen choices");
		const selected = { ...choice.selected, ...candidateIdentity(proposal.to), order_match: current.order_match };
		const digest = executionHash({
			schema: "artel.execution.v2",
			dispatchHash: binding.dispatchHash,
			executionConfiguration: binding.execution.config,
			record_revisions: binding.execution.config.record_revisions,
			scope_revision: binding.execution.config.scope_revision,
			candidates: choice.candidates,
			selected,
		});
		const result = await this.store.commitBillingPoolTransition(this.#snapshot(binding), proposal, digest);
		if (this.#bindings.get(binding.agentInstanceId) !== binding || binding.attemptState !== "running")
			throw new EngineTargetError("stale_target", "Billing transition lost the admitted Attempt");
		const index = binding.execution.frozen.findIndex(route => candidateRef(route) === candidateRef(result.current));
		if (index < 0) throw new EngineTargetError("stale_target", "Current billing route is outside the frozen choices");
		binding.execution.choice = result.choice;
		binding.executionDigest = result.executionDigest;
		binding.execution.activateCandidate(index, result.executionDigest);
		if (result.event) this.#notifyEvents([result.event]);
	}

	async #admitEffect<T>(binding: LiveBinding, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		for (;;) {
			signal?.throwIfAborted();
			this.#throwIfDisposed();
			if (["cancel_requested", "cancelled", "failed", "interrupted"].includes(binding.attemptState))
				throw new EngineTargetError("cancelled", "Attempt cannot admit another effect");
			const changed = this.store.changeSignal();
			// Stop, release and disposal signal pause progress without a store change; a parked admission must see them.
			const progress = binding.pauseProgress.promise;
			try {
				return await work();
			} catch (error) {
				if (!(error instanceof EngineTargetError) || error.code !== "agent_busy") throw error;
				this.#throwIfDisposed();
				if (this.#bindings.get(binding.agentInstanceId) !== binding)
					throw new EngineTargetError("cancelled", "Attempt binding was released during effect admission");
				binding.pauseGate.pause();
				void binding.pauseGate.waitUntilResumed(signal);
				await this.#inLane(binding.agentInstanceId, async () => {
					const intent = await this.store.intent(binding.agentInstanceId);
					this.#throwIfDisposed();
					if (this.#bindings.get(binding.agentInstanceId) !== binding)
						throw new EngineTargetError("cancelled", "Attempt binding was released during effect admission");
					binding.manualHold = intent.manualHold;
					binding.intentRevision = intent.intentRevision;
					if (!intent.manualHold || binding.attemptState !== "running") return;
					binding.attemptState = "pause_requested";
					binding.pauseRequests.set(binding.commandId, { kind: "human" });
					await this.#commitAttemptTransition(binding, "pause_requested", [{ kind: "pause_requested" }], {
						expectedStates: ["running"],
					});
					this.#trackRun(this.#finishPause(binding, binding.attemptId));
				});
				const cancelled = Promise.withResolvers<void>();
				const abort = () => cancelled.resolve();
				signal?.addEventListener("abort", abort, { once: true });
				try {
					await Promise.race([changed, progress, cancelled.promise]);
				} finally {
					signal?.removeEventListener("abort", abort);
				}
			}
		}
	}

	#messageAttachments(
		request: Pick<EngineSteerRequest, "principalId" | "clientMessageId" | "attachmentUploadIds">,
	): EngineMessageAttachments | undefined {
		if (request.attachmentUploadIds === undefined) return undefined;
		validateRuntimeValue("id", request.clientMessageId);
		return messageAttachmentReferences({
			principalId: request.principalId ?? "",
			uploadIds: request.attachmentUploadIds,
		});
	}

	/** Must run before a live binding is mutated or a new one is opened: a rejection here is terminal. */
	#assertAttachmentSupport(
		session: AgentSession,
		images: ImageContent[] | undefined,
		originals?: SessionMessageIdentity["originalAttachments"],
		model = session.model,
	): void {
		assertFilesReadable(session.getEnabledToolNames().includes("read"), originals);
		if (!images?.length) return;
		if (model?.input.includes("image") && !session.settings.get("images.blockImages")) return;
		const image = originals?.find(item => SUPPORTED_IMAGE_MIME_TYPES.has(item.mediaType));
		throw new EngineTargetError(
			"attachment_requires_images",
			`${image ? `Image "${image.name}" cannot be sent` : "Images cannot be sent"}: the selected model or profile does not accept images. Choose an image-capable route or send the message without this image.`,
		);
	}

	#nextModelEffect(binding: LiveBinding, inputHash: string): EngineModelEffectInput {
		const modelCallId = `model-${++binding.modelCallSequence}`;
		return {
			effectId: `model_${sha256(`${binding.bindingId}\0${binding.attemptId}\0${modelCallId}`).slice(0, 32)}`,
			modelCallId,
			inputHash,
		};
	}

	async #settleActiveModelEffect(
		binding: LiveBinding,
		outcome: "completed" | "failed",
		error?: string,
	): Promise<EngineEvent | undefined> {
		const effect = binding.modelEffect;
		if (!effect) return;
		const checkpoint = outcome === "failed" && binding.messageWriteError
			? undefined : await this.#effectCheckpoint(binding);
		const event = await this.store.settleModelEffect(
			this.#snapshot(binding), effect, outcome, error?.slice(0, 2_048), checkpoint,
		);
		binding.modelEffect = undefined;
		this.#notifyEvents([event]);
		return event;
	}

	async #dispatchModel(
		binding: LiveBinding,
		input: string,
		identity?: SessionMessageIdentity,
		kind: HistoryDispatchKind = "prompt",
		images?: ImageContent[],
	): Promise<boolean> {
		const completed = Promise.withResolvers<void>();
		binding.activeModelCalls.add(completed.promise);
		const effect = this.#nextModelEffect(binding, modelInputHash(input, identity?.originalAttachments, images));
		const modelCallId = effect.modelCallId;
		const audit = createLatencyAudit({
			commandId: identity?.sourceCommandId ?? binding.commandId,
			clientMessageId: identity?.clientMessageId,
			agentInstanceId: binding.agentInstanceId,
			attemptId: binding.attemptId,
			executionId: binding.executionId,
			engineGeneration: binding.engineGeneration,
			effectId: effect.effectId,
			modelCallId,
		});
		audit?.mark("model_admission_start");
		try {
			if (binding.consultantEffectId === effect.effectId) {
				const approved = await this.store.getEffect(effect.effectId);
				if (approved?.state !== "started" || approved.effect_kind !== "model" ||
					approved.input_hash !== effect.inputHash)
					throw new EngineTargetError("stale_target", "Consultant model effect differs from approved call");
				binding.consultantEffectId = undefined;
			} else {
				const admissionCheckpoint = await this.#effectCheckpoint(binding);
				const started = await this.#admitEffect(binding, () =>
					this.store.startModelEffect(this.#snapshot(binding), effect, admissionCheckpoint));
				this.#notifyEvents([started]);
				audit?.mark("model_started", { eventId: started.eventId });
			}
			binding.modelEffect = effect;
			this.#queueExecutorRoute(binding, "loading");
			const previous = binding.session.getLastAssistantMessage();
			let dispatched: boolean;
			try {
				audit?.mark("prompt_dispatch");
				dispatched = await withProviderObservationContext(
					effect,
					() =>
						this.#withSessionScope(binding, () =>
							kind === "resume_queued"
								? binding.session.continueNativeHistory().then(() => true)
								: this.#dispatchPrompt(binding.session, input, identity, kind, images),
						),
					audit,
				);
				await binding.session.settleInFlightMessagePersistence();
				await binding.traceWriteTail;
				binding.streamAdmission?.check();
				if (binding.messageWriteError) throw binding.messageWriteError;
				const current = binding.session.getLastAssistantMessage();
				if (current !== previous && (current?.stopReason === "error" || current?.stopReason === "aborted")) {
					throw new Error(current.errorMessage?.trim() || "Model request failed");
				}
			} catch (error) {
				audit?.mark("model_failed");
				const message = error instanceof Error ? error.message : String(error);
				try {
					await binding.session.settleInFlightMessagePersistence();
				} catch (persistenceError) {
					binding.messageWriteError ??= persistenceError;
				}
				await binding.traceWriteTail;
				await this.#settleActiveModelEffect(binding, "failed", message);
				throw error;
			}
			const settled = await this.#settleActiveModelEffect(binding, "completed");
			audit?.mark("model_completed", { eventId: settled?.eventId });
			return dispatched;
		} finally {
			audit?.finish("model_settled");
			completed.resolve();
			binding.activeModelCalls.delete(completed.promise);
			await binding.pauseGate.waitUntilResumed(binding.streamAdmission?.signal);
		}
	}

	#withSessionScope<T>(binding: LiveBinding, callback: () => T): T {
		const settings = binding.session.settings;
		return withSettingsScope(settings, () =>
			withCapabilityProviderPolicy(
				{
					disabledProviders: settings.get("disabledProviders"),
					disabledExtensions: settings.get("disabledExtensions"),
				},
				() =>
					withLspSessionScope(
						{ shared: settings.get("lsp.shared"), ownerId: binding.engineAgentId, realm: "engine" },
						callback,
					),
			),
		);
	}

	async #sendCommandContext(
		binding: LiveBinding,
		context: string | undefined,
		commandId: string,
		beforeEnqueue?: () => Promise<void>,
	): Promise<void> {
		if (!context) return;
		await binding.session.sendCustomMessage(
			{
				customType: "engine-command-context",
				content: context,
				display: false,
				details: { sourceCommandId: commandId },
			},
			{ triggerTurn: false, ...(beforeEnqueue ? { beforeEnqueue } : {}) },
		);
	}

	async #runPrompt(
		binding: LiveBinding,
		input: string,
		identity?: SessionMessageIdentity,
		kind: HistoryDispatchKind = "prompt",
		context?: string,
		selection?: Pick<EngineStartRequest, "agentInstanceRef">,
		images?: ImageContent[],
	): Promise<void> {
		const configuredLimits = this.#streamAdmissionLimits;
		const maxQueuedBytes = configuredLimits?.maxQueuedBytes ?? ENGINE_STREAM_ADMISSION_MAX_QUEUED_BYTES;
		const maxEventBytes =
			configuredLimits?.maxEventBytes ?? Math.min(ENGINE_STREAM_ADMISSION_MAX_EVENT_BYTES, maxQueuedBytes);
		const admission = new StreamAdmission({ ...configuredLimits, maxQueuedBytes, maxEventBytes });
		binding.streamAdmission = admission;
		// Capacity failure stops the model; it is not a storage failure, so the already produced text still settles.
		const detach = admission.onAbort(error => binding.session.agent.abort(error));
		try {
			await runWithStreamAdmission(admission, () =>
				this.#runAdmittedPrompt(binding, input, identity, kind, context, selection, images),
			);
		} finally {
			detach();
			logger.debug("Engine stream admission settled", { attemptId: binding.attemptId, ...admission.metrics });
			if (binding.streamAdmission === admission) binding.streamAdmission = undefined;
		}
	}

	async #runAdmittedPrompt(
		binding: LiveBinding,
		input: string,
		identity?: SessionMessageIdentity,
		kind: HistoryDispatchKind = "prompt",
		context?: string,
		selection?: Pick<EngineStartRequest, "agentInstanceRef">,
		images?: ImageContent[],
	): Promise<void> {
		const attemptId = binding.attemptId;
		const attemptMessageStart = binding.session.messages.length;
		// The native user entry keeps the Attempt's immutable admitted execution, not a profile selection.
		if (kind === "prompt" && identity?.sourceCommandId) {
			identity = {
				...identity,
				launchSnapshot: {
					schema: "engine.launch_snapshot.v2",
					agentInstanceId: binding.agentInstanceId,
					agentInstanceRef: selection?.agentInstanceRef ?? binding.bindingSnapshot!.agentInstanceRef,
					executionId: binding.executionId,
					attemptId,
					dispatchRef: binding.dispatchRef,
					dispatchHash: binding.dispatchHash,
					executionDigest: binding.executionDigest,
					continuationDigest: binding.continuationDigest,
					selectedRouteRef: binding.execution.choice.selected.route_ref,
				},
			};
		}
		try {
			await this.#sendCommandContext(binding, context, identity?.sourceCommandId ?? binding.commandId);
			if (kind === "pending_tool") {
				if (!binding.recoveryCallIds?.length)
					throw new EngineTargetError("stale_target", "Recovered tool turn is missing its exact call ids");
				await this.#withSessionScope(binding, () =>
					binding.session.resumeNativeToolCalls(binding.recoveryCallIds!));
				await this.#waitForToolInvocations(binding, attemptId);
				await binding.session.sessionManager.flushAndCheckpoint();
				binding.recoveryCallIds = undefined;
				await this.#dispatchModel(binding, "", undefined, "resume_queued");
			} else await this.#dispatchModel(binding, input, identity, kind, images);
			for (let reminder = 0; reminder < 2 && binding.requireYieldTool; reminder++) {
				await binding.pauseGate.waitUntilResumed(binding.streamAdmission?.signal);
				binding.streamAdmission?.check();
				const yielded = terminalYield(
					binding.session.messages,
					attemptMessageStart,
					binding.session.getLastAssistantText(),
					binding.outputSchema,
				);
				if (yielded.found || yielded.aborted || binding.attemptState !== "running") break;
				await this.#dispatchModel(
					binding,
					"Your previous response was not submitted. Call the yield tool now with the complete output object in result.data. Do not answer with text.",
				);
			}
			await this.#waitForAttemptQuiescence(binding, attemptId);
			binding.streamAdmission?.check();
			const yielded = terminalYield(
				binding.session.messages,
				attemptMessageStart,
				binding.session.getLastAssistantText(),
				binding.outputSchema,
			);
			if (yielded.aborted) throw new Error(yielded.error || "yield_aborted");
			if (binding.requireYieldTool && !yielded.found) throw new Error("required_yield_not_submitted");
			await this.#settleAttempt(binding, attemptId, attemptMessageStart, "completed");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const overflow = binding.streamAdmission?.signal.reason instanceof StreamAdmissionError;
			await this.#settleAttempt(
				binding,
				attemptId,
				attemptMessageStart,
				overflow ? "interrupted" : "failed",
				message,
			);
		}
	}

	async #settleAttempt(
		binding: LiveBinding,
		attemptId: string,
		attemptMessageStart: number,
		state: "completed" | "failed" | "interrupted",
		cause?: string,
	): Promise<void> {
		// A response that never reached message_end still owns its coalesced text.
		if (binding.assistantStream) this.#flushAssistantStream(binding, binding.assistantStream);
		await binding.traceWriteTail;
		if (binding.messageWriteError) {
			const error = new Error("Engine message content could not be persisted", { cause: binding.messageWriteError });
			if (state === "completed") throw error;
			cause = error.message;
		}
		if (binding.retryWriteError) {
			const error = new Error("Engine retry state could not be persisted", { cause: binding.retryWriteError });
			binding.retryWriteError = undefined;
			if (state === "completed") throw error;
			cause = error.message;
		}
		for (;;) {
			if (state !== "interrupted") await binding.pauseGate.waitUntilResumed();
			const retry = await this.#inLane(binding.agentInstanceId, async () => {
				if (this.#bindings.get(binding.agentInstanceId) !== binding || binding.attemptId !== attemptId)
					return false;
				if (
					state !== "interrupted" &&
					(binding.attemptState === "pause_requested" || binding.attemptState === "paused")
				)
					return true;
				const expectedState = binding.attemptState;
				if (
					!(state === "interrupted"
						? ["running", "pause_requested", "paused", "waiting_input"].includes(expectedState)
						: expectedState === "running")
				)
					return false;
				let transcriptCheckpoint: SessionDurabilityCheckpoint | undefined;
				try {
					transcriptCheckpoint = await binding.session.sessionManager.flushAndCheckpoint();
				} catch (error) {
					// Unknown durability keeps the Attempt nonterminal (a later Stop can still cut it). A write the
					// owner definitively rejected never becomes durable, so a failure settles without a new cut.
					if (state === "completed" || !isRejectedTranscriptWrite(error)) throw error;
					const detail = error instanceof Error ? error.message : String(error);
					cause = cause ? `${cause}; transcript not persisted: ${detail}` : `Transcript not persisted: ${detail}`;
				}
				const previousHold = binding.manualHold;
				binding.state = "idle";
				binding.attemptState = state;
				if (state === "interrupted") binding.manualHold = true;
				try {
					await this.#commitAttemptTransition(
						binding,
						state,
						[
							{
								kind: state,
								payload:
									state === "completed"
										? this.#completionPayload(binding, attemptMessageStart)
										: {
												error: safeEngineErrorDetail(cause ?? "Unknown Engine failure"),
												...(binding.sessionFile
													? { transcriptRef: `history://${binding.engineAgentId}` }
													: {}),
											},
							},
						],
						{
							cause,
							expectedStates: [expectedState],
							transcriptCheckpoint,
							actualCost: this.#actualCost(binding),
							...(state === "completed"
								? { terminalResult: this.#completionPayload(binding, attemptMessageStart, true) }
								: {}),
						},
					);
				} catch (error) {
					binding.state = "running";
					binding.attemptState = expectedState;
					binding.manualHold = previousHold;
					throw error;
				}
				return false;
			});
			if (!retry) {
				this.#signalInboxWake();
				return;
			}
		}
	}

	#queueTraceEvent(
		binding: LiveBinding,
		kind: "trace_reasoning" | "trace_tool",
		payload: Record<string, unknown>,
	): void {
		void this.#queueBindingWrite(binding, payload, () => this.#emit(binding, kind, payload));
	}

	#queueHistoryCheckpoint(binding: LiveBinding): void {
		const attemptId = binding.attemptId;
		void this.#queueBindingWrite(binding, { type: "history_checkpoint" }, async () => {
			// message_end is emitted before native persistence finishes. Only publish
			// a durable cut; tool-only responses have no assistant_snapshot to await.
			await binding.session.settleInFlightMessagePersistence();
			await this.#inLane(binding.agentInstanceId, async () => {
				if (
					this.#disposed ||
					this.#bindings.get(binding.agentInstanceId) !== binding ||
					binding.attemptId !== attemptId ||
					!["running", "pause_requested", "paused", "waiting_input"].includes(binding.attemptState)
				)
					return;
				const transcriptCheckpoint = await binding.session.sessionManager.flushAndCheckpoint();
				await this.#commitAttemptTransition(binding, binding.attemptState, [{ kind: "history_checkpoint" }], {
					expectedStates: [binding.attemptState],
					transcriptCheckpoint,
				});
			});
		});
	}

	#beginAssistantStream(binding: LiveBinding, timestamp: number): AssistantStreamState {
		if (
			binding.assistantStream?.attemptId === binding.attemptId &&
			binding.assistantStream.sourceTimestamp === timestamp &&
			!binding.assistantStream.settled
		) {
			return binding.assistantStream;
		}
		this.#resetAssistantStream(binding);
		const assistantMessageId = `assistant_${crypto
			.createHash("sha256")
			.update(`${binding.attemptId}\0${timestamp}\0${++binding.assistantMessageSequence}`)
			.digest("hex")
			.slice(0, 32)}`;
		const state: AssistantStreamState = {
			attemptId: binding.attemptId,
			sourceTimestamp: timestamp,
			assistantMessageId,
			revision: 0,
			text: "",
			textTruncated: false,
			emittedText: "",
			streamingSnapshots: 0,
			settled: false,
			blocks: new Map(),
		};
		binding.assistantStream = state;
		return state;
	}

	#updateAssistantStream(binding: LiveBinding, timestamp: number, content: unknown): void {
		const state = binding.assistantStream ?? this.#beginAssistantStream(binding, timestamp);
		if (state.attemptId !== binding.attemptId || state.settled) return;
		const fullText = historyMessageText(content);
		state.text = fullText.slice(0, MAX_ASSISTANT_FINAL_CHARS);
		state.textTruncated = fullText.length > MAX_ASSISTANT_FINAL_CHARS;
		if (!state.text || state.text === state.emittedText) return;
		if (
			state.streamingSnapshots === 0 ||
			Math.abs(state.text.length - state.emittedText.length) >= ASSISTANT_SNAPSHOT_GROWTH_CHARS
		) {
			this.#emitAssistantSnapshot(binding, state, "streaming");
		}
	}

	#assistantBlock(state: AssistantStreamState, index: number, stream: "assistant" | "thinking"): AssistantBlockState {
		let block = state.blocks.get(index);
		if (!block) {
			block = {
				blockId: `block_${index}`,
				stream,
				contentId: crypto.randomUUID(),
				revision: 0,
				offset: 0,
				receivedChars: 0,
				pendingSurrogate: "",
				hash: crypto.createHash("sha256"),
				settled: false,
				pending: "",
				pendingBytes: 0,
			};
			state.blocks.set(index, block);
		}
		return block;
	}

	async #recordAssistantDelta(binding: LiveBinding, timestamp: number, event: AssistantMessageEvent): Promise<void> {
		const auditSource = latencyNormalizedSource(event);
		const auditStream = event.type.startsWith("thinking") ? "thinking" : "assistant";
		latencyFirst(auditSource, "persistence_enter", auditStream, {
			parsedAt: auditSource?.sourceCorrelation === "direct" ? auditSource.parsedAt : undefined,
			sourceCorrelation: auditSource?.sourceCorrelation,
		});
		// The interceptor runs before the public subscriber, so a failed write stops the stream here.
		if (binding.messageWriteError) throw binding.messageWriteError;
		if (
			event.type !== "text_delta" &&
			event.type !== "thinking_delta" &&
			event.type !== "text_end" &&
			event.type !== "thinking_end"
		)
			return;
		const state = binding.assistantStream ?? this.#beginAssistantStream(binding, timestamp);
		if (state.settled || state.attemptId !== binding.attemptId) return;
		const stream = event.type.startsWith("thinking") ? "thinking" : "assistant";
		if (event.type === "text_end" || event.type === "thinking_end") {
			await this.#persistAssistantWrite(binding, event.content, () =>
				this.#reconcileAssistantBlock(binding, state, event.contentIndex, stream, event.content, "streaming"),
			);
			return;
		}
		const block = this.#assistantBlock(state, event.contentIndex, stream);
		block.receivedChars += event.delta.length;
		let text = block.pendingSurrogate + event.delta;
		block.pendingSurrogate = "";
		if (text.length && /[\uD800-\uDBFF]/.test(text.at(-1)!)) {
			block.pendingSurrogate = text.at(-1)!;
			text = text.slice(0, -1);
		}
		const wellFormed = text.toWellFormed();
		attachLatencyPersistence(block, auditSource, wellFormed === event.delta);
		block.pending += wellFormed;
		block.pendingBytes += Buffer.byteLength(wellFormed);
		// The first text of a block is durable before the provider moves on. Later text never waits for storage:
		// it is written once per window or byte budget, and a queued write takes everything pending when it runs.
		if (block.revision === 0) await this.#flushAssistantBlock(binding, state, block);
		else if (block.pendingBytes >= ASSISTANT_DELTA_WINDOW_BYTES)
			void this.#flushAssistantBlock(binding, state, block);
		else state.flushTimer ??= setTimeout(() => this.#flushAssistantStream(binding, state), ASSISTANT_DELTA_WINDOW_MS);
	}

	/** Queue one write for a block's coalesced text; a flush that has not started yet takes all later text too. */
	#flushAssistantBlock(binding: LiveBinding, state: AssistantStreamState, block: AssistantBlockState): Promise<void> {
		if (block.flush) return block.flush;
		const flush = this.#persistAssistantWrite(binding, block.pending, async () => {
			block.flush = undefined;
			const text = block.pending;
			block.pending = "";
			block.pendingBytes = 0;
			if (text && !block.settled) await this.#appendAssistantBlock(binding, state, block, text, "streaming");
		});
		// A write dropped before it ran leaves its text pending for the next flush or the settle.
		const done = () => {
			if (block.flush === flush) block.flush = undefined;
		};
		void flush.then(done, done);
		block.flush = flush;
		return flush;
	}

	#flushAssistantStream(binding: LiveBinding, state: AssistantStreamState): void {
		clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		if (state.attemptId !== binding.attemptId) return;
		for (const block of state.blocks.values()) {
			if (block.pending) void this.#flushAssistantBlock(binding, state, block);
		}
	}

	async #reconcileAssistantBlock(
		binding: LiveBinding,
		state: AssistantStreamState,
		index: number,
		stream: "assistant" | "thinking",
		content: string,
		status: "streaming" | "settled" | "cancelled" | "interrupted",
	): Promise<void> {
		let block = this.#assistantBlock(state, index, stream);
		if (block.settled) return;
		const text = content.toWellFormed();
		let tail = block.pendingSurrogate;
		block.pendingSurrogate = "";
		if (block.receivedChars < content.length) {
			tail += content.slice(block.receivedChars);
			block.receivedChars = content.length;
		}
		const missing = block.pending + tail.toWellFormed();
		block.pending = "";
		block.pendingBytes = 0;
		if (missing) await this.#appendAssistantBlock(binding, state, block, missing, "streaming");
		if (block.hash.copy().digest("hex") !== crypto.createHash("sha256").update(text).digest("hex")) {
			block = {
				...block,
				contentId: crypto.randomUUID(),
				revision: 0,
				offset: 0,
				receivedChars: content.length,
				pendingSurrogate: "",
				flush: undefined,
				hash: crypto.createHash("sha256"),
			};
			state.blocks.set(index, block);
			await this.#appendAssistantBlock(binding, state, block, text, "streaming");
		}
		if (status !== "streaming") {
			await this.#appendAssistantBlock(binding, state, block, "", status);
			block.settled = true;
		}
	}

	async #appendAssistantBlock(
		binding: LiveBinding,
		state: AssistantStreamState,
		block: AssistantBlockState,
		text: string,
		status: "streaming" | "settled" | "cancelled" | "interrupted",
	): Promise<void> {
		const chunks = text ? utf8Chunks(text) : status !== "streaming" || block.revision === 0 ? [""] : [];
		const singleChunk = Buffer.byteLength(text) <= runtimeLimits.bulkPreviewBytes;
		const target = this.#snapshot(binding);
		let payloads: Record<string, unknown>[] = [];
		let bytes = 0;
		for (const chunk of chunks) {
			const baseRevision = block.revision++;
			const offset = block.offset;
			block.offset += Buffer.byteLength(chunk);
			block.hash.update(chunk);
			const payload = {
				mode: baseRevision ? "append" : "snapshot",
				messageId: state.assistantMessageId,
				blockId: block.blockId,
				stream: block.stream,
				contentId: block.contentId,
				revision: block.revision,
				offset,
				endOffset: block.offset,
				totalBytes: block.offset,
				text: chunk,
				status,
				...(baseRevision ? { baseRevision } : { partial: false }),
			};
			const auditSource = latencyPersistenceSource(block);
			const direct = singleChunk && auditSource?.sourceCorrelation === "direct";
			if (
				chunk.trim() &&
				latencyFirst(auditSource, "persistence_payload", block.stream, {
					messageId: state.assistantMessageId,
					blockId: block.blockId,
					chars: chunk.length,
					parsedAt: direct ? auditSource?.parsedAt : undefined,
					sourceCorrelation: direct ? "direct" : "unknown",
				})
			) {
				attachLatencyPersistence(payload, auditSource, direct);
			}
			const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
			if (
				bytes + payloadBytes > runtimeLimits.deliveryBatchBytes ||
				payloads.length >= runtimeLimits.httpPageRecords
			) {
				await Promise.all(payloads.map(value => this.#emit(target, "message_updated", value)));
				payloads = [];
				bytes = 0;
			}
			payloads.push(payload);
			bytes += payloadBytes;
		}
		await Promise.all(payloads.map(value => this.#emit(target, "message_updated", value)));
	}

	#queueBindingWrite<T>(binding: LiveBinding, payload: unknown, work: () => Promise<T>): Promise<T> {
		const failed = (error: unknown) => {
			// A capacity abort already stopped the model; the write it dropped is not a storage failure.
			if (error instanceof StreamAdmissionError) return;
			binding.messageWriteError ??= error;
			binding.session.agent.abort(error);
			logger.error("Engine bounded write failed", { error: error instanceof Error ? error.message : String(error) });
		};
		// After a capacity abort only bounded teardown writes remain (settled text, checkpoints); they must land.
		const admission = binding.streamAdmission?.signal.aborted ? undefined : binding.streamAdmission;
		let write: Promise<T>;
		try {
			write = enqueueStreamWork(admission, binding.traceWriteTail, payload, work);
		} catch (error) {
			failed(error);
			write = Promise.reject(error);
			void write.catch(() => {});
			return write;
		}
		binding.traceWriteTail = write.then(() => {}, failed);
		return write;
	}

	#persistAssistantWrite(binding: LiveBinding, payload: unknown, persist: () => Promise<void>): Promise<void> {
		return this.#queueBindingWrite(binding, payload, async () => {
			if (binding.messageWriteError) throw binding.messageWriteError;
			await persist();
		});
	}

	#actualCost(binding: LiveBinding): ExecutorChoice["actual_cost"] {
		if (binding.measuredUsage.size === 0) return null;
		let input = 0;
		let output = 0;
		let cached = 0;
		let complete = true;
		for (const usage of binding.measuredUsage.values()) {
			if (!usage) {
				complete = false;
				break;
			}
			input += usage.input;
			output += usage.output;
			cached += usage.cached;
		}
		if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || !Number.isSafeInteger(cached))
			complete = false;
		return {
			input_tokens: complete ? input : null,
			output_tokens: complete ? output : null,
			cached_input_tokens: complete ? cached : null,
			currency: "USD",
			amount: null,
			source: complete ? "provider_response" : "provider_usage_unavailable",
			observed_at: new Date().toISOString(),
		};
	}

	#settleAssistantStream(binding: LiveBinding, message: AssistantMessage): void {
		const state = binding.assistantStream ?? this.#beginAssistantStream(binding, message.timestamp);
		if (state.attemptId !== binding.attemptId || state.settled) return;
		// The settle reconciles every block, pending coalesced text included.
		clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		// These are the exact native blocks which may execute next, not a guess
		// based on the latest text or wall-clock timestamps. Replace per response.
		binding.toolOrigins = {
			attemptId: state.attemptId,
			blocks: new Map(
				message.content.flatMap((part, index) =>
					part.type === "toolCall"
						? [[part.id, { messageId: state.assistantMessageId, blockId: `block_${index}` }] as const]
						: [],
				),
			),
		};
		void this.#persistAssistantWrite(binding, message, async () => {
			for (const [index, part] of message.content.entries()) {
				if (part.type === "text")
					await this.#reconcileAssistantBlock(
						binding,
						state,
						index,
						"assistant",
						part.text,
						message.stopReason === "aborted"
							? "cancelled"
							: message.stopReason === "error"
								? "interrupted"
								: "settled",
					);
				else if (part.type === "thinking")
					await this.#reconcileAssistantBlock(
						binding,
						state,
						index,
						"thinking",
						part.thinking,
						message.stopReason === "aborted"
							? "cancelled"
							: message.stopReason === "error"
								? "interrupted"
								: "settled",
					);
			}
		});
		const fullText = historyMessageText(message.content);
		state.text = fullText.slice(0, MAX_ASSISTANT_FINAL_CHARS);
		state.textTruncated = fullText.length > MAX_ASSISTANT_FINAL_CHARS;
		state.settled = true;
		binding.measuredUsage.set(state.assistantMessageId, measuredAssistantUsage(message.usage));
		binding.lastAssistantMessageId = state.assistantMessageId;
		binding.session.rememberMessageIdentity(message, {
			assistantMessageId: state.assistantMessageId,
		});
		// Empty failures and tool-only responses still own a native history entry.
		// Publish its identity before subsequent retry/lifecycle events on this lane.
		this.#emitAssistantSnapshot(binding, state, "settled", assistantSnapshotStopReason(message.stopReason));
		binding.assistantStream = undefined;
	}

	#emitAssistantSnapshot(
		binding: LiveBinding,
		state: AssistantStreamState,
		status: "streaming" | "settled",
		stopReason?: "stop" | "length" | "toolUse" | "aborted" | "error",
	): void {
		if (status === "streaming") {
			if (state.streamingSnapshots >= MAX_ASSISTANT_STREAMING_SNAPSHOTS) return;
			state.streamingSnapshots++;
		}
		state.emittedText = state.text;
		const payload = {
			assistantMessageId: state.assistantMessageId,
			revision: ++state.revision,
			text: state.text,
			status,
			...(stopReason ? { stopReason } : {}),
			textTruncated: state.textTruncated,
		};
		void this.#queueBindingWrite(binding, payload, async () => {
			let historyEntryId: string | undefined;
			if (status === "settled") {
				await binding.session.settleInFlightMessagePersistence();
				if (binding.lastAssistantNativeEntry?.messageId === state.assistantMessageId)
					historyEntryId = binding.lastAssistantNativeEntry.entryId;
			}
			await this.#emit(binding, "assistant_snapshot", {
				...payload,
				...(historyEntryId ? { historyEntryId } : {}),
			});
		});
	}

	#resetAssistantStream(binding: LiveBinding): void {
		binding.assistantStream = undefined;
	}

	#queueExecutorRoute(binding: LiveBinding, phase: ExecutorRouteState["phase"], message?: AssistantMessage): void {
		const provider = message?.provider ?? binding.session.model?.provider;
		const modelId = message?.model ?? binding.session.model?.id;
		const route = binding.execution.frozen.find(candidate =>
			candidate.provider === provider && candidate.modelId === modelId);
		if (!route) return;
		const previous = binding.executorRouteState;
		const selected = currentIdentity(binding.execution.choice);
		const projected = candidateRef(route) === candidateRef(selected) ? selected : candidateIdentity(route);
		const state: ExecutorRouteState = {
			dispatchHash: binding.dispatchHash,
			selected: phase === "active" ? projected : selected,
			pending: phase === "loading" ? projected : null,
			fallback: candidateRef(projected) !== candidateRef(binding.execution.choice.selected),
			phase,
			eventSeq: previous?.eventSeq ?? 0,
		};
		if (previous && storageCanonicalJson(previous) === storageCanonicalJson(state)) return;
		binding.executorRouteState = state;
		const target = this.#snapshot(binding);
		void this.#queueBindingWrite(binding, state, () => this.store.commitExecutorRouteState(target, state));
	}

	#queueRetryEvent(
		binding: LiveBinding,
		kind: "retry_scheduled" | "retry_settled",
		retry: import("./contracts").EngineRetryState,
	): void {
		void this.#queueBindingWrite(binding, retry, async () => {
			const event = await this.store.commitAttemptRetry(binding, retry, { kind, payload: { retry } });
			if (event) this.#notifyEvents([event]);
		});
	}

	async #waitForAttemptQuiescence(binding: LiveBinding, attemptId: string): Promise<void> {
		const filter = { ownerId: binding.engineAgentId, attemptId };
		for (;;) {
			await binding.pauseGate.waitUntilResumed(binding.streamAdmission?.signal);
			binding.streamAdmission?.check();
			await binding.session.waitForIdle();
			if (binding.pendingPausedMessage) {
				const pending = binding.pendingPausedMessage;
				binding.pendingPausedMessage = undefined;
				if (binding.session.agent.hasQueuedMessages()) {
					await this.#dispatchModel(binding, pending.input, pending.identity, "resume_queued", pending.images);
					continue;
				}
			}
			await this.asyncJobManager.waitForOwnerJobs(binding.engineAgentId, { attemptId });
			await this.asyncJobManager.drainDeliveries({ filter });
			await this.#waitForToolInvocations(binding, attemptId);
			await binding.pauseGate.waitUntilResumed(binding.streamAdmission?.signal);
			binding.streamAdmission?.check();
			await binding.session.waitForIdle();
			if (
				this.asyncJobManager.getRunningJobs(filter).length === 0 &&
				!this.asyncJobManager.hasPendingDeliveries(filter)
			) {
				return;
			}
		}
	}

	#completionPayload(binding: LiveBinding, attemptMessageStart: number, full = false): EngineCompletionPayload {
		const lastAssistantText = binding.session.getLastAssistantText();
		const yielded = terminalYield(binding.session.messages, attemptMessageStart, lastAssistantText, binding.outputSchema);
		const final = yielded.found
			? yielded.rawText && typeof yielded.data === "string"
				? yielded.data
				: JSON.stringify(yielded.data)
			: (lastAssistantText ?? "");
		const outputTruncated =
			final.length > MAX_ASSISTANT_FINAL_CHARS &&
			!(full && Buffer.byteLength(JSON.stringify(final)) <= MAX_TERMINAL_RESULT_BYTES);
		const payload: EngineCompletionPayload = {
			assistantFinal: outputTruncated ? `${final.slice(0, MAX_ASSISTANT_FINAL_CHARS)}\n[…truncated]` : final,
			...(!yielded.found && binding.lastAssistantMessageId
				? { assistantMessageId: binding.lastAssistantMessageId }
				: {}),
			...(binding.sessionFile ? { transcriptRef: `history://${binding.engineAgentId}` } : {}),
			...(outputTruncated ? { outputTruncated: true } : {}),
		};
		if (full && yielded.found) {
			const source = binding.outputSchema === undefined ? "none" : "session";
			const { validator, normalized, error } = buildOutputValidator(binding.outputSchema);
			const validation = validator?.validate(yielded.data);
			const structuredOutput: StructuredSubagentOutput = {
				source,
				mode: "permissive",
				status:
					source === "none" || error || normalized === undefined
						? "unavailable"
						: yielded.schemaOverridden || validation?.success === false
							? "invalid"
							: "valid",
				data: yielded.data,
				...(error ? { error: `invalid output schema: ${error}` } : {}),
				...(yielded.schemaOverridden ? { error: "yield schema validation overridden" } : {}),
				...(validation?.success === false ? { error: "yield data does not match output schema" } : {}),
			};
			if (
				!outputTruncated &&
				Buffer.byteLength(JSON.stringify({ ...payload, structuredOutput }), "utf8") <= MAX_TERMINAL_RESULT_BYTES
			) {
				payload.structuredOutput = structuredOutput;
			} else {
				payload.structuredOutput = {
					source,
					mode: "permissive",
					status: "unavailable",
					error: "Structured result exceeds terminal result size limit; read the transcript",
				} satisfies StructuredSubagentOutput;
			}
		}
		if (full && Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_TERMINAL_RESULT_BYTES) {
			payload.assistantFinal = `${final.slice(0, MAX_ASSISTANT_FINAL_CHARS)}\n[…truncated]`;
			payload.outputTruncated = true;
		}
		return payload;
	}

	async #finishCancel(binding: LiveBinding, request: EngineCancelRequest, abort: Promise<void>): Promise<void> {
		await abort.catch(() => {});
		await Promise.all(binding.activeModelCalls);
		await this.asyncJobManager.waitForOwnerJobs(binding.engineAgentId, { attemptId: request.attemptId });
		await this.asyncJobManager.drainDeliveries({
			filter: { ownerId: binding.engineAgentId, attemptId: request.attemptId },
		});
		await this.#waitForToolInvocations(binding, request.attemptId);
		await binding.traceWriteTail;
		const transcriptCheckpoint = await binding.session.sessionManager.flushAndCheckpoint();
		await this.#inLane(binding.agentInstanceId, async () => {
			if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
			if (binding.attemptId !== request.attemptId || binding.attemptState !== "cancel_requested") return;
			binding.state = "idle";
			binding.attemptState = "cancelled";
			const payload = {
				error: "attempt_cancelled",
				...(request.reason ? { reason: request.reason } : {}),
				...(binding.sessionFile ? { transcriptRef: `history://${binding.engineAgentId}` } : {}),
			};
			const events: EngineTransitionEvent<EngineOrdinaryEvent>[] = [
				{ kind: "cancelled", payload, causationCommandId: request.commandId },
			];
			try {
				await this.#commitAttemptTransition(binding, "cancelled", events, {
					cause: request.reason,
					expectedStates: ["cancel_requested"],
					transcriptCheckpoint,
				});
			} catch (error) {
				binding.state = "running";
				binding.attemptState = "cancel_requested";
				throw error;
			}
		});
		this.#signalInboxWake();
	}

	async #terminateBinding(binding: LiveBinding, cause: "requested" | "engine_lost"): Promise<void> {
		if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
		const wasRunning = binding.state === "running";
		const retainApproval = cause === "engine_lost" && binding.attemptState === "paused" &&
			(await this.store.durableApprovalPause(binding.attemptId)) !== undefined;
		if (retainApproval) {
			await binding.session.sessionManager.flushAndCheckpoint();
			binding.session.sessionManager.seal();
		}
		const previousAttemptState = binding.attemptState;
		this.#bindings.delete(binding.agentInstanceId);
		binding.state = "released";
		const reason = cause === "engine_lost" ? "Engine stopped" : "Engine binding released";
		const errors: unknown[] = [];
		this.#resetAssistantStream(binding);
		let transcriptCheckpoint: SessionDurabilityCheckpoint | undefined;
		await collectFailure(errors, () =>
			this.#disposeBindingResources(
				binding,
				reason,
				cause === "engine_lost" ? "interrupted" : "cancelled",
				wasRunning && !retainApproval
					? async () => {
							await Promise.all(binding.activeModelCalls);
							await this.#waitForToolInvocations(binding, binding.attemptId);
							transcriptCheckpoint = await binding.session.sessionManager.flushAndCheckpoint();
						}
					: undefined,
				retainApproval,
			),
		);
		if (cause === "engine_lost" && wasRunning && transcriptCheckpoint) {
			binding.attemptState = "interrupted";
			await collectFailure(errors, () =>
				this.#commitAttemptTransition(
					binding,
					"interrupted",
					[
						{
							kind: "interrupted",
							payload: {
								cause,
								error: "engine_lost",
								...(binding.sessionFile ? { transcriptRef: `history://${binding.engineAgentId}` } : {}),
							},
						},
					],
					{
						cause,
						expectedStates: [previousAttemptState],
						transcriptCheckpoint,
					},
				),
			);
		} else if (cause === "requested" && wasRunning && transcriptCheckpoint) {
			binding.attemptState = "cancelled";
			await collectFailure(errors, () =>
				this.#commitAttemptTransition(
					binding,
					"cancelled",
					[
						{
							kind: "cancelled",
							payload: {
								cause: "binding_released",
								error: "attempt_cancelled",
								...(binding.sessionFile ? { transcriptRef: `history://${binding.engineAgentId}` } : {}),
							},
						},
					],
					{
						cause: "binding_released",
						expectedStates: [previousAttemptState],
						transcriptCheckpoint,
					},
				),
			);
		} else if (!wasRunning && !retainApproval) {
			await collectFailure(errors, () => this.store.putBinding(this.#snapshot(binding)));
		}
		throwCollectedFailures(errors, `Engine binding ${binding.agentInstanceId} cleanup failed`);
	}

	async #discardBinding(binding: LiveBinding): Promise<void> {
		if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
		this.#bindings.delete(binding.agentInstanceId);
		binding.state = "released";
		const errors: unknown[] = [];
		await collectFailure(errors, () =>
			this.#disposeBindingResources(binding, "Engine admission failed", "cancelled"),
		);
		const uncommittedForkSessionFile = binding.uncommittedForkSessionFile;
		if (uncommittedForkSessionFile) {
			await collectFailure(errors, () =>
				this.store.abandonNativeGeneration(binding.agentInstanceId, uncommittedForkSessionFile),
			);
		}
		throwCollectedFailures(errors, `Engine binding ${binding.agentInstanceId} admission cleanup failed`);
	}

	async #disposeBindingResources(
		binding: LiveBinding,
		reason: string,
		attemptState: EngineAttemptState,
		beforeSessionDispose?: () => Promise<void>,
		retainApproval = false,
	): Promise<void> {
		clearInterval(binding.leaseHeartbeat);
		binding.leaseHeartbeat = undefined;
		binding.session.beginDispose();
		const errors: unknown[] = [];
		let abort: Promise<void> | undefined;
		await collectFailure(errors, () => {
			abort = binding.session.abort({ reason });
		});
		await collectFailure(errors, binding.unsubscribe);
		if (retainApproval) {
			for (const [id, pending] of this.#pendingToolApprovals)
				if (pending.record.target.bindingId === binding.bindingId) {
					this.#pendingToolApprovals.delete(id);
					pending.resolve({ decision: "cancelled", reason: "Engine stopped; approval remains durable" });
				}
		} else await collectFailure(errors, () => this.#cancelToolApprovals(binding, reason));
		await collectFailure(errors, () => this.#cancelPendingInput(binding, reason, undefined, attemptState));
		await collectFailure(errors, () =>
			this.asyncJobManager.cancelAll({ ownerId: binding.engineAgentId, attemptId: binding.attemptId }),
		);
		await collectFailure(errors, () => binding.pauseGate.resume());
		await collectFailure(errors, () => this.#notifyPauseProgress(binding));
		if (abort) await collectFailure(errors, () => abort!);
		if (beforeSessionDispose) await collectFailure(errors, beforeSessionDispose);
		await collectFailure(errors, () => binding.session.dispose());
		await collectFailure(errors, () => binding.mcpManager?.disconnectAll());
		await collectFailure(errors, binding.disposeExecution);
		await collectFailure(errors, () => this.agentRegistry.unregister(binding.engineAgentId, binding.session));
		throwCollectedFailures(errors, `Engine binding ${binding.agentInstanceId} resource cleanup failed`);
	}

	#requireTarget(target: EngineTarget): LiveBinding {
		this.#throwIfDisposed();
		const binding = this.#bindings.get(target.agentInstanceId);
		if (!binding) throw new EngineTargetError("agent_not_found", `Unknown AgentInstance ${target.agentInstanceId}`);
		if (
			binding.bindingId !== target.bindingId ||
			binding.engineGeneration !== target.engineGeneration ||
			binding.bindingGeneration !== target.bindingGeneration ||
			binding.executionId !== target.executionId ||
			binding.authorityGeneration !== target.authorityGeneration
		) {
			throw new EngineTargetError("stale_target", `Stale runtime target for ${target.agentInstanceId}`);
		}
		if (binding.attemptId !== target.attemptId) {
			throw new EngineTargetError("too_late", `Attempt ${target.attemptId} is no longer active`);
		}
		return binding;
	}

	async #requireSessionTarget(target: EngineTarget): Promise<EngineInboxTarget> {
		const archive = await this.store.getHistoryArchive(target.agentInstanceId);
		if (archive && archive.state !== "restored") {
			throw new EngineTargetError("history_expired", "Archived history cannot accept input until restored");
		}
		if (this.#bindings.has(target.agentInstanceId)) return this.#inboxTarget(this.#requireTarget(target));
		this.#throwIfDisposed();
		const binding = await this.store.getBinding(target.agentInstanceId);
		if (!binding?.sessionFile)
			throw new EngineTargetError("agent_not_found", "No retained session for this AgentInstance");
		if (
			binding.bindingId !== target.bindingId ||
			binding.engineGeneration !== target.engineGeneration ||
			binding.bindingGeneration !== target.bindingGeneration ||
			binding.executionId !== target.executionId ||
			binding.attemptId !== target.attemptId ||
			binding.authorityGeneration !== target.authorityGeneration
		) {
			throw new EngineTargetError("stale_target", "The retained session target has changed");
		}
		let sessionId = (await this.store.getAttempt(target.attemptId))?.transcript_session_id;
		if (!sessionId) {
			sessionId = (await this.#sessionHeader(binding.sessionFile))?.id;
		}
		if (!sessionId) throw new EngineTargetError("agent_not_found", "No retained session for this AgentInstance");
		return { ...binding, sessionId };
	}

	async #requireSessionReadTarget(target: EngineTarget): Promise<EngineInboxTarget> {
		try {
			return await this.#requireSessionTarget(target);
		} catch (error) {
			if (!(error instanceof EngineTargetError) || (error.code !== "stale_target" && error.code !== "too_late")) {
				throw error;
			}
		}

		this.#throwIfDisposed();
		const attempt = await this.store.getAttempt(target.attemptId);
		if (!attempt || attempt.agent_instance_id !== target.agentInstanceId) {
			throw new EngineTargetError("agent_not_found", `Unknown Attempt ${target.attemptId}`);
		}
		if (!this.#attemptMatchesTarget(attempt, target)) {
			throw new EngineTargetError("stale_target", `Stale historical target for ${target.agentInstanceId}`);
		}
		if (!TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
			throw new EngineTargetError("too_late", `Attempt ${target.attemptId} is not terminal`);
		}
		const sessionId = attempt.transcript_session_id;
		if (!sessionId)
			throw new EngineTargetError("agent_not_found", `Attempt ${target.attemptId} has no durable session`);

		const live = this.#bindings.get(target.agentInstanceId);
		const binding = live ? this.#snapshot(live) : await this.store.getBinding(target.agentInstanceId);
		if (!binding) throw new EngineTargetError("agent_not_found", `Unknown AgentInstance ${target.agentInstanceId}`);
		if (binding.authorityGeneration !== target.authorityGeneration) {
			throw new EngineTargetError("stale_target", `Stale authority for ${target.agentInstanceId}`);
		}
		let currentSessionId = live?.session.sessionId;
		if (!currentSessionId) {
			currentSessionId = (await this.store.getAttempt(binding.attemptId))?.transcript_session_id ?? undefined;
			if (!currentSessionId && binding.sessionFile) {
				currentSessionId = (await this.#sessionHeader(binding.sessionFile))?.id;
			}
		}
		if (currentSessionId !== sessionId) {
			throw new EngineTargetError(
				"stale_target",
				`Historical Attempt ${target.attemptId} belongs to another session`,
			);
		}
		return { ...target, sessionId };
	}

	#attemptMatchesTarget(attempt: EngineAttemptTargetRecord, target: EngineTarget): boolean {
		return (
			attempt.agent_instance_id === target.agentInstanceId &&
			attempt.execution_id === target.executionId &&
			attempt.attempt_id === target.attemptId &&
			attempt.binding_id === target.bindingId &&
			Number(attempt.engine_generation) === target.engineGeneration &&
			Number(attempt.binding_generation) === target.bindingGeneration &&
			Number(attempt.authority_generation) === target.authorityGeneration
		);
	}

	async #requireCancelableTarget(target: EngineTarget): Promise<LiveBinding | undefined> {
		const binding = this.#bindings.get(target.agentInstanceId);
		if (binding) return this.#requireTarget(target);
		this.#throwIfDisposed();
		const attempt = await this.store.getAttempt(target.attemptId);
		if (!attempt || attempt.agent_instance_id !== target.agentInstanceId) {
			throw new EngineTargetError("agent_not_found", `Unknown AgentInstance ${target.agentInstanceId}`);
		}
		if (
			attempt.binding_id !== target.bindingId ||
			attempt.execution_id !== target.executionId ||
			Number(attempt.engine_generation) !== target.engineGeneration ||
			Number(attempt.binding_generation) !== target.bindingGeneration ||
			Number(attempt.authority_generation) !== target.authorityGeneration
		) {
			throw new EngineTargetError("stale_target", `Stale runtime target for ${target.agentInstanceId}`);
		}
		if (attempt.state === "cancelled" || attempt.state === "cancel_requested") return undefined;
		throw new EngineTargetError("too_late", `Attempt ${target.attemptId} is already ${attempt.state}`);
	}

	async #recoveryToolCallIds(binding: LiveBinding): Promise<string[]> {
		const completed = new Set(binding.session.messages.flatMap(message =>
			message.role === "toolResult" ? [message.toolCallId] : []));
		const assistant = [...binding.session.messages].reverse().find(message =>
			message.role === "assistant" &&
			message.content.some(part => part.type === "toolCall" && !completed.has(part.id)));
		if (!assistant || assistant.role !== "assistant")
			throw new EngineTargetError("stale_target", "Paused native history has no pending tool calls");
		const effects = await this.store.attemptToolEffects(binding.attemptId);
		const ids: string[] = [];
		for (const call of assistant.content) {
			if (call.type !== "toolCall" || completed.has(call.id)) continue;
			const matches = effects.filter(effect => effect.tool_call_id === call.id && effect.effect_kind === "tool");
			const effect = matches.length === 1 ? matches[0] : undefined;
			const approval = effect && await this.store.getApproval(effect.effect_id);
			if (!effect || !approval || effect.tool_name !== call.name || effect.binding_id !== binding.bindingId ||
				approval.request.effect_id !== effect.effect_id || approval.request.requester_attempt_id !== binding.attemptId ||
				!((effect.state === "planned" && ["pending", "waiting_human_paused", "approved"].includes(approval.request.status)) ||
					(effect.state === "started" && approval.request.kind === "escalation") ||
					(effect.state === "settled" && approval.request.status === "denied")))
				throw new EngineTargetError("stale_target", "Pending native tool call differs from its approved effect ledger");
			ids.push(call.id);
		}
		if (!ids.length) throw new EngineTargetError("stale_target", "No original tool call is recoverable");
		binding.modelCallSequence = binding.session.messages.filter(message => message.role === "assistant").length;
		while (await this.store.getEffect(`model_${sha256(`${binding.bindingId}\0${binding.attemptId}\0model-${binding.modelCallSequence + 1}`).slice(0, 32)}`))
			binding.modelCallSequence++;
		return ids;
	}

	/**
	 * Restart repair: recompute the route rule deltas from the frozen config and assert their union
	 * equals the durable choice.rules. Appends only executor-rules messages whose eventId is missing;
	 * a mismatch is a stale target, never a silent rewrite.
	 */
	async #repairExecutorRuleMessages(
		binding: LiveBinding,
		choice: ExecutorChoice,
		config: EngineExecutionConfiguration,
		eventId?: string,
	): Promise<void> {
		const replay = executorRuleReplay(config.instruction_sources, choice);
		const deltas = eventId === undefined ? replay : replay.filter(delta => delta.eventId === eventId);
		const delivered = new Set(
			binding.session.sessionManager.getContextBranch()
				.filter((entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
					entry.type === "custom_message" && entry.customType === "executor-rules")
				.flatMap(entry => {
					const details = entry.details as { attemptId?: unknown; eventId?: unknown } | undefined;
					return details?.attemptId === binding.attemptId && typeof details.eventId === "string" ? [details.eventId] : [];
				}),
		);
		if (eventId === undefined && deltas.some(delta => !delivered.has(delta.eventId))) {
			// The working context may have compacted these messages away. Read only bounded pages
			// on this exact native branch/cut; absence from the working set is not absence from history.
			const checkpoint = await binding.session.sessionManager.flushAndCheckpoint();
			if (!checkpoint.native || !checkpoint.leafEntryId)
				throw new EngineTargetError("stale_target", "Rule repair requires its durable native history");
			const pending = new Set(deltas.filter(delta => !delivered.has(delta.eventId)).map(delta => delta.eventId));
			let cursor: string | undefined;
			do {
				const page = await this.store.storageClient.readContext({
					familyId: checkpoint.native.familyId, generationId: checkpoint.native.generationId,
					cutSeq: checkpoint.native.throughSeq, leafId: checkpoint.leafEntryId, cursor,
					maxRecords: runtimeLimits.httpPageRecords, maxBytes: 1024 * 1024,
				});
				for (const entry of page.events) {
					if (entry.kind !== "custom_message") continue;
					const message = await decodeNativeEntry(entry, this.attachmentUploads.blobs);
					if (message.type !== "custom_message" || message.customType !== "executor-rules") continue;
					const details = message.details as { attemptId?: unknown; eventId?: unknown } | undefined;
					if (details?.attemptId === binding.attemptId && typeof details.eventId === "string") {
						delivered.add(details.eventId);
						pending.delete(details.eventId);
					}
				}
				if (page.nextCursor && page.nextCursor === cursor)
					throw new EngineTargetError("source_unavailable", "Rule history cursor did not advance");
				cursor = page.nextCursor ?? undefined;
			} while (cursor && pending.size);
		}
		for (const delta of deltas) {
			if (delivered.has(delta.eventId)) continue;
			const message = createCustomMessage(
				"executor-rules", renderRules(delta.rules), false,
				{ attemptId: binding.attemptId, eventId: delta.eventId, routeRef: delta.route.route_ref,
					rules: delta.rules.map(({ ref, revision, content_hash }) => ({ ref, revision, content_hash })) },
				new Date().toISOString(), "agent",
			);
			binding.session.sessionManager.appendCustomMessageEntry(
				message.customType, message.content, message.display, message.details, message.attribution,
			);
			await binding.session.sessionManager.flushAndCheckpoint();
			binding.session.agent.appendMessage(message);
		}
	}

	async #restoreMeasuredUsage(binding: LiveBinding, native: SessionDurabilityCheckpoint["native"]): Promise<void> {
		const owners = await this.store.attemptMessageOwnership(binding.agentInstanceId, binding.attemptId);
		binding.assistantMessageSequence = Math.max(owners.size,
			binding.session.messages.filter(message => message.role === "assistant").length);
		// Recovery cannot call a post-restart-only sum complete when its earlier response source is absent.
		if (!owners.size) binding.measuredUsage.set("recovered-usage-unavailable", null);
		for (const [messageId, entryId] of owners) {
			binding.measuredUsage.set(messageId, null);
			if (!native || !entryId) continue;
			const page = await this.store.storageClient.readContext({
				familyId: native.familyId, generationId: native.generationId, cutSeq: native.throughSeq,
				leafId: entryId, maxRecords: 1, maxBytes: runtimeLimits.httpPageBytes,
			}).catch((error: unknown) => {
				if (error instanceof StorageClientError && (error.code === "not_found" || error.code === "schema_error"))
					return undefined;
				throw error;
			});
			const retained = page?.events[0];
			if (!retained || retained.entryId !== entryId) continue;
			// A missing/corrupt body makes usage unavailable, not zero. Transport/fence failures above still fail.
			const entry = await decodeNativeEntry(retained, this.attachmentUploads.blobs).catch(() => undefined);
			if (entry?.type === "message" && entry.message.role === "assistant" && entry.assistantMessageId === messageId)
				binding.measuredUsage.set(messageId, measuredAssistantUsage(entry.message.usage));
		}
	}

	async #rehydratePausedApproval(target: EngineBindingSnapshot): Promise<LiveBinding> {
		const current = await this.store.getBinding(target.agentInstanceId);
		const attempt = await this.store.getAttempt(target.attemptId);
		const identity = await this.store.getStartConversationIdentity(target.commandId);
		const envelope = identity?.serializedCommand
			? JSON.parse(identity.serializedCommand) as EngineCommandEnvelope : undefined;
		const payload = envelope?.payload;
		if (!current || !attempt?.execution || attempt.state !== "paused" || !identity?.principalId ||
			attempt.cause !== "approval_deadline" || !payload || envelope?.op !== "start" ||
			current.engineGeneration !== this.engineGeneration ||
			current.bindingId !== target.bindingId || attempt.engine_generation !== this.engineGeneration ||
			!current.sessionFile || !this.#resolveExecution || !this.#verifyOriginReceipt ||
			!envelope.bindingSnapshot || !sameSemanticBinding(envelope.bindingSnapshot, current.bindingSnapshot))
			throw new EngineTargetError("stale_target", "Retained approval Attempt or original Start changed");
		const config = payload.executionConfiguration as EngineExecutionConfiguration;
		validateRuntimeValue("engineExecutionConfiguration", config);
		if (executionHash(config.dispatch) !== current.dispatchHash || !config.roster_complete)
			throw new EngineTargetError("stale_target", "Retained approval has no matching admitted execution");
		const request: EngineStartRequest = {
			commandId: target.commandId, principalId: identity.principalId!,
			agentInstanceId: target.agentInstanceId,
			agentInstanceRef: envelope.agentInstanceRef!,
			bindingSnapshot: envelope.bindingSnapshot,
			parentAgentInstanceId: envelope.parentAgentInstanceId,
			parentAgentInstanceRef: envelope.parentAgentInstanceRef,
			executionId: target.executionId, attemptId: target.attemptId,
			authorityGeneration: target.authorityGeneration,
			cwd: payload.cwd as string, executionConfiguration: config,
			dispatchRef: current.dispatchRef, dispatchHash: current.dispatchHash,
			executionKind: payload.executionKind as EngineStartRequest["executionKind"],
			specialRef: (payload.specialRef ?? null) as EngineStartRequest["specialRef"],
			originReceiptId: payload.originReceiptId as string,
			...(typeof payload.displayName === "string" ? { displayName: payload.displayName } : {}),
		};
		const origin = await this.#verifyOriginReceipt({
			originReceiptId: request.originReceiptId, commandId: request.commandId,
			agentInstanceRef: request.agentInstanceRef, attemptId: request.attemptId,
			principalId: request.principalId,
		});
		if (origin.verified !== true || origin.dispatchHash !== current.dispatchHash ||
			!origin.bindingSnapshot || !sameSemanticBinding(origin.bindingSnapshot, request.bindingSnapshot) ||
			!origin.authContextId)
			throw new EngineTargetError("stale_target", "Retained Start no longer has current CH/Core authority");
		await this.store.checkSemanticStart(request.agentInstanceId, request.bindingSnapshot, request.principalId);
		const frozen = attempt.execution.executor_choice.candidates.map(saved => {
			const matches = config.routes.routes.filter(route =>
				storageCanonicalJson(frozenCandidate(route)) === storageCanonicalJson(saved));
			if (matches.length !== 1)
				throw new EngineTargetError("stale_target", "Retained route is not in the original frozen roster");
			return matches[0];
		});
		const choice = attempt.execution.executor_choice;
		const currentIndex = frozen.findIndex(route => candidateRef(route) === candidateRef(currentIdentity(choice)));
		if (currentIndex < 0)
			throw new EngineTargetError("stale_target", "Current route is outside the retained frozen choices");
		// The immutable choice keeps its admitted baseline. Materialization resumes the current
		// route and only its remaining fallbacks, never the already-exhausted prefix.
		const remaining = frozen.slice(currentIndex);
		const continuationDigest = await this.#continuationDigest(request);
		if (continuationDigest !== current.continuationDigest)
			throw new EngineTargetError("stale_target", "Retained native continuation changed");
		const resolved = await this.#resolveExecution(config, remaining, {
			expectedPrincipalId: request.principalId, agentInstanceRef: request.agentInstanceRef,
			attemptId: request.attemptId, bindingRevision: request.bindingSnapshot.bindingRevision,
			installationId: request.bindingSnapshot.installationId, dispatchRef: request.dispatchRef,
			dispatchHash: request.dispatchHash, executionDigest: choice.execution_digest,
			originReceiptId: request.originReceiptId,
		}, request.cwd);
		const binding = await this.#openBinding(request, resolved, continuationDigest,
			choice.execution_digest, choice, remaining, current,
			current.bindingGeneration, undefined, undefined, undefined, undefined, undefined,
			origin.approvalSettings ?? undefined, true);
		await this.#restoreMeasuredUsage(binding, attempt.transcript_native);
		await this.#repairExecutorRuleMessages(binding, choice, config);
		binding.manualHold = current.manualHold ?? false;
		binding.intentRevision = current.intentRevision ?? 0;
		binding.attemptState = "paused";
		binding.state = "running";
		binding.pauseGate.pause();
		try {
			binding.recoveryCallIds = await this.#recoveryToolCallIds(binding);
			const approvals = await this.store.durableApprovalPause(target.attemptId);
			for (const approval of approvals ?? []) {
				if (approval.status === "waiting_human_paused")
					binding.approvalPauseCause ??= {
						kind: "approval_deadline", request_id: approval.id,
						address_revision: approval.address_revision,
					};
				this.#armApprovalDeadline(binding, approval);
				if (!binding.manualHold && (approval.status === "approved" || approval.status === "denied"))
					this.#trackRun(this.#resumeApprovedTool(binding, approval.id));
			}
			this.#retainedApprovals.delete(target.agentInstanceId);
			return binding;
		} catch (error) {
			binding.session.sessionManager.seal();
			await this.#discardBinding(binding);
			throw error;
		}
	}

	/** Only unknown availability or capacity is retried; an explicit authority refusal stays visibly paused. */
	#transientRecoveryFailure(error: unknown): boolean {
		if (error instanceof EngineBindingPendingError) return true;
		if (!(error instanceof EngineTargetError)) return true;
		return ["binding_pending", "source_unavailable", "admission_state_unknown"]
			.includes(error.code);
	}

	#retryPausedRecovery(target: EngineBindingSnapshot, error: unknown): void {
		logger.warn("Approval Attempt remains paused awaiting revalidation", {
			attemptId: target.attemptId, error: safeEngineErrorDetail(error),
		});
		if (this.#disposed) return;
		if (!this.#transientRecoveryFailure(error)) {
			// A later decision or control command re-checks; nothing retries a refusal on a timer.
			this.#trackRun(this.#commitEvent(target, "paused", {
				cause: "approval_recovery_refused",
				code: error instanceof EngineTargetError ? error.code : "stale_target",
				reason: safeEngineErrorDetail(error),
			}).catch(reason => logger.warn("Approval recovery refusal was not recorded", {
				attemptId: target.attemptId, error: safeEngineErrorDetail(reason),
			})));
			return;
		}
		if (this.#recoveryTimers.has(target.agentInstanceId)) return;
		const timer = setTimeout(() => {
			this.#recoveryTimers.delete(target.agentInstanceId);
			this.#trackRun(this.#inLane(target.agentInstanceId, async () => {
				if (this.#disposed || !this.#retainedApprovals.has(target.agentInstanceId) ||
					this.#bindings.has(target.agentInstanceId)) return;
				try {
					await this.#rehydratePausedApproval(target);
				} catch (reason) {
					this.#retryPausedRecovery(target, reason);
				}
			}));
		}, 2_000);
		timer.unref?.();
		this.#recoveryTimers.set(target.agentInstanceId, timer);
	}

	async #reconcileLostAttempts(): Promise<void> {
		const retained: string[] = [];
		await this.store.interruptGeneration(this.engineGeneration, events => this.#notifyEvents(events),
			id => retained.push(id));
		for (const attemptId of retained) {
			const target = await this.store.recoverPausedApproval(attemptId, this.engineGeneration);
			if (!target) continue;
			this.#retainedApprovals.set(target.agentInstanceId, target);
			try {
				await this.#rehydratePausedApproval(target);
			} catch (error) {
				this.#retryPausedRecovery(target, error);
			}
		}
	}

	async #emit(
		target: Pick<
			EngineBindingSnapshot,
			| "commandId"
			| "agentInstanceId"
			| "executionId"
			| "attemptId"
			| "engineGeneration"
			| "bindingId"
			| "bindingGeneration"
			| "authorityGeneration"
		>,
		kind: EngineOrdinaryEvent["kind"],
		payload?: Record<string, unknown>,
		causationCommandId = target.commandId,
	): Promise<void> {
		const { commandId: _, ...eventTarget } = target;
		const auditSource = payload ? latencyPersistenceSource(payload) : undefined;
		const auditStream = typeof payload?.stream === "string" ? payload.stream : "unknown";
		latencyFirst(auditSource, "append_call", auditStream);
		const event = await this.store.appendEvent({
			...eventTarget,
			causationCommandId,
			kind,
			payload,
		});
		latencyFirst(auditSource, "append_committed", auditStream, { eventId: event.eventId, cursor: event.eventId });
		this.#notifyEvents([event]);
	}

	async #commitEvent(
		target: Pick<
			EngineBindingSnapshot,
			| "commandId"
			| "agentInstanceId"
			| "executionId"
			| "attemptId"
			| "engineGeneration"
			| "bindingId"
			| "bindingGeneration"
			| "authorityGeneration"
		>,
		kind: EngineOrdinaryEvent["kind"],
		payload?: Record<string, unknown>,
		causationCommandId = target.commandId,
		settleCommandId?: string,
		settleReceipt:
			| "applied"
			| "rejected"
			| { outcome: "applied" | "rejected"; detail?: Record<string, unknown> } = "applied",
	): Promise<void> {
		const event = await this.store.commitEvent(
			target,
			{ kind, payload, causationCommandId },
			settleCommandId,
			settleReceipt,
		);
		this.#notifyEvents([event]);
	}

	async #commitAttemptTransition(
		binding: LiveBinding,
		state: EngineAttemptState,
		events: readonly EngineTransitionEvent<EngineOrdinaryEvent>[],
		options: {
			cause?: string;
			terminalResult?: Record<string, unknown>;
			actualCost?: ExecutorChoice["actual_cost"];
			intentGuard?: { expectedRevision?: number; requireUnheld?: boolean; inputId?: string; inputRevision?: number; commandId?: string };
			startIntent?: {
				expectedRevision?: number;
				explicitContinue?: boolean;
				allowInheritedHold?: boolean;
				sourceAgentInstanceId?: string;
				sourceRevision?: number;
			};
			settleCommandId?: string;
			settleCommandReceipt?: { outcome: "applied" | "rejected"; detail?: Record<string, unknown> };
			expectedStates?: readonly EngineAttemptState[];
			routingResume?: AdmissionRequest;
			requireNew?: boolean;
			transcriptCheckpoint?: SessionDurabilityCheckpoint;
			inboxSessionId?: string;
			inboxMutation?: EngineInboxMutation;
			inboxMutationCausationCommandId?: string;
			pendingInboxSourceSessionId?: string;
			restoreWorkspaceReceipt?: RestoreWorkspaceReceipt;
		} = {},
	): Promise<void> {
		const committed = await this.store.commitAttemptTransition(this.#snapshot(binding), state, events, {
			...options,
			...(binding.previousInboxSessionId ? { previousInboxSessionId: binding.previousInboxSessionId } : {}),
			...(binding.pendingInboxSourceSessionId
				? { pendingInboxSourceSessionId: binding.pendingInboxSourceSessionId }
				: {}),
		});
		if (TERMINAL_ATTEMPT_STATES.has(state) && binding.pendingInboxSourceSessionId) {
			const intent = await this.store.intent(binding.agentInstanceId);
			binding.manualHold = intent.manualHold;
			binding.intentRevision = intent.intentRevision;
			binding.pendingInboxSourceSessionId = undefined;
		}
		if (state === "paused" || TERMINAL_ATTEMPT_STATES.has(state)) {
			clearInterval(binding.leaseHeartbeat);
			binding.leaseHeartbeat = undefined;
		} else if (options.routingResume) this.#armLeaseHeartbeat(binding);
		this.#notifyEvents(committed);
	}

	#notifyEvents(events: readonly EngineEvent[]): void {
		for (const event of events) {
			for (const listener of this.#listeners) {
				try {
					void Promise.resolve(listener(event)).catch(() => {});
				} catch {
					// A projection subscriber cannot undo an already committed Engine event.
				}
			}
		}
	}

	#snapshot(binding: LiveBinding): EngineBindingSnapshot {
		return {
			bindingId: binding.bindingId,
			commandId: binding.commandId,
			bindingSnapshot: binding.bindingSnapshot,
			agentInstanceId: binding.agentInstanceId,
			executionId: binding.executionId,
			attemptId: binding.attemptId,
			engineAgentId: binding.engineAgentId,
			sessionFile: binding.sessionFile,
			executionDigest: binding.executionDigest,
			continuationDigest: binding.continuationDigest,
			dispatchRef: binding.dispatchRef,
			dispatchHash: binding.dispatchHash,
			state: binding.state,
			engineGeneration: binding.engineGeneration,
			bindingGeneration: binding.bindingGeneration,
			authorityGeneration: binding.authorityGeneration,
			manualHold: binding.manualHold,
			intentRevision: binding.intentRevision,
			...(binding.intentCommandId ? { intentCommandId: binding.intentCommandId } : {}),
		};
	}

	#setManualHold(
		binding: LiveBinding,
		commandId: string,
		expectedRevision: number | undefined,
		manualHold: boolean,
		requireExpectedToClear = false,
	): Pick<LiveBinding, "manualHold" | "intentRevision" | "intentCommandId"> {
		const previous = this.#intentState(binding);
		if (binding.intentCommandId === commandId) return previous;
		if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
			throw new EngineTargetError("invalid_request", "expectedIntentRevision must be a non-negative safe integer");
		}
		if (!manualHold && expectedRevision !== undefined && expectedRevision !== binding.intentRevision) {
			throw new EngineTargetError(
				"stale_target",
				`Intent revision ${binding.intentRevision} does not match ${expectedRevision}`,
			);
		}
		if (requireExpectedToClear && expectedRevision === undefined) {
			if (binding.manualHold) {
				throw new EngineTargetError(
					"stale_target",
					`Manual hold requires expectedIntentRevision ${binding.intentRevision}`,
				);
			}
			return previous;
		}
		binding.manualHold = manualHold;
		binding.intentRevision++;
		binding.intentCommandId = commandId;
		return previous;
	}

	#intentState(binding: LiveBinding): Pick<LiveBinding, "manualHold" | "intentRevision" | "intentCommandId"> {
		return {
			manualHold: binding.manualHold,
			intentRevision: binding.intentRevision,
			...(binding.intentCommandId ? { intentCommandId: binding.intentCommandId } : {}),
		};
	}

	#restoreIntent(
		binding: LiveBinding,
		previous: Pick<LiveBinding, "manualHold" | "intentRevision" | "intentCommandId">,
	): void {
		binding.manualHold = previous.manualHold;
		binding.intentRevision = previous.intentRevision;
		if (previous.intentCommandId) binding.intentCommandId = previous.intentCommandId;
		else delete binding.intentCommandId;
	}

	#controlResult(
		binding: LiveBinding,
		phase: EngineControlResult["phase"] = "applied",
		item?: EngineInboxItem,
	): EngineControlResult {
		return {
			phase,
			manualHold: binding.manualHold,
			intentRevision: binding.intentRevision,
			...(item ? { queueId: item.queueId, queueRevision: item.revision, sourceEventId: item.sourceEventId } : {}),
		};
	}

	#inLane<T>(agentInstanceId: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#lanes.get(agentInstanceId) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(work);
		const tail = current.then(
			() => {},
			() => {},
		);
		this.#lanes.set(agentInstanceId, tail);
		void tail.finally(() => {
			if (this.#lanes.get(agentInstanceId) === tail) this.#lanes.delete(agentInstanceId);
		});
		return current;
	}

	#inLanes<T>(agentInstanceIds: readonly string[], work: () => Promise<T>): Promise<T> {
		const ids = [...new Set(agentInstanceIds)].sort();
		const acquire = (index: number): Promise<T> => {
			const id = ids[index];
			return id === undefined ? work() : this.#inLane(id, () => acquire(index + 1));
		};
		return acquire(0);
	}

	#trackRun(run: Promise<void>): void {
		this.#runs.add(run);
		void run.then(
			() => this.#runs.delete(run),
			() => this.#runs.delete(run),
		);
	}

	#throwIfDisposed(): void {
		if (this.#storageFailure) throw this.#storageFailure;
		if (this.#disposed) throw new Error("EngineRuntime is disposed");
	}
}

/**
 * Engine-only provider-context projection for executor rules.
 * Before compaction: drops other Attempts' executor-rules messages from the model
 * context while durable history keeps them. After a compaction summary: drops all
 * raw executor-rules messages and inserts exactly one authoritative current-rules
 * message right after the last summary, marked as superseding historical summary
 * text. Built from durable state only — no model call, no persistence.
 */
export function projectExecutorRulesContext(
	messages: AgentMessage[],
	current: { attemptId: string; rules: readonly InstructionRule[]; compactionEntryId: () => string | null },
): AgentMessage[] {
	const lastSummary = messages.findLastIndex(message => message.role === "compactionSummary");
	const projected: AgentMessage[] = [];
	for (const [index, message] of messages.entries()) {
		if (message.role === "custom" && message.customType === "executor-rules") {
			const details = message.details as { attemptId?: unknown } | undefined;
			if (lastSummary !== -1 || details?.attemptId !== current.attemptId) continue;
		}
		if (index === lastSummary) {
			projected.push(message);
			// One authoritative block after the summary; summary rule text is historical.
			const entryId = current.compactionEntryId();
			if (!entryId) throw new EngineTargetError("stale_target", "Compacted executor context lacks its durable summary identity");
			projected.push(createCustomMessage(
				"executor-rules",
				`${renderRules(current.rules)}\n\nThese are the current executor rules; any rule text inside the preceding summary is historical and lower priority.`,
				false,
				{ attemptId: current.attemptId, eventId: `compaction:${entryId}` },
				new Date(message.timestamp).toISOString(),
				"agent",
			));
			continue;
		}
		// Non-rule audit and conversation history remain in their original order.
		projected.push(message);
	}
	return projected;
}

function historyLaunchSnapshot(value: SessionLaunchSnapshot | undefined): SessionLaunchSnapshot | undefined {
	const text = (item: unknown): item is string => typeof item === "string" && item.length > 0 && item.length <= 512;
	if (value?.schema === "engine.launch_snapshot.v2") {
		if (Object.keys(value).sort().join(",") !==
			"agentInstanceId,agentInstanceRef,attemptId,continuationDigest,dispatchHash,dispatchRef,executionDigest,executionId,schema,selectedRouteRef" ||
			![value.agentInstanceId, value.agentInstanceRef, value.attemptId, value.executionId,
				value.dispatchRef, value.selectedRouteRef].every(text) ||
			![value.continuationDigest, value.dispatchHash, value.executionDigest].every(
				hash => /^sha256:[0-9a-f]{64}$/.test(hash))) return undefined;
		return structuredClone(value);
	}
	const context = (item: unknown) => item === null || (Number.isSafeInteger(item) && Number(item) >= 0);
	if (
		!value ||
		typeof value !== "object" ||
		Object.keys(value)
			.filter(key => !["selectionRevision", "previousSelectionRevision", "agentInstanceRef"].includes(key))
			.sort()
			.join(",") !==
			"agentInstanceId,attemptId,executionId,model,profileDigest,profileRef,routes,schema,thinkingLevel" ||
		value.schema !== "engine.launch_snapshot.v1" ||
		(value.selectionRevision !== undefined &&
			value.selectionRevision !== null &&
			(!Number.isSafeInteger(value.selectionRevision) || value.selectionRevision < 1)) ||
		(value.previousSelectionRevision !== undefined &&
			value.previousSelectionRevision !== null &&
			(!Number.isSafeInteger(value.previousSelectionRevision) || value.previousSelectionRevision < 0)) ||
		(value.agentInstanceRef !== undefined && value.agentInstanceRef !== null && !text(value.agentInstanceRef)) ||
		![value.agentInstanceId, value.executionId, value.attemptId, value.profileDigest].every(text) ||
		(value.profileRef !== null && !text(value.profileRef)) ||
		(value.thinkingLevel !== null && !text(value.thinkingLevel)) ||
		(value.model !== null &&
			(!value.model ||
				Object.keys(value.model).sort().join(",") !== "contextWindow,id,provider" ||
				!text(value.model.id) ||
				!text(value.model.provider) ||
				!context(value.model.contextWindow))) ||
		!Array.isArray(value.routes) ||
		value.routes.length > 64 ||
		!value.routes.every(
			route =>
				route &&
				Object.keys(route).sort().join(",") === "modelId,provider,routeRef" &&
				text(route.routeRef) &&
				text(route.provider) &&
				text(route.modelId),
		)
	)
		return undefined;
	return structuredClone(value);
}

function projectHistoryEntries(
	sessionId: string,
	branch: SessionEntry[],
	preview = true,
	images?: Map<string, EngineHistoryImage[]>,
	attachments?: Map<string, EngineHistoryAttachment[]>,
) {
	const messageLimit = preview ? MAX_HISTORY_MESSAGE_CHARS : Infinity;
	const activityLimit = preview ? MAX_HISTORY_ACTIVITY_CHARS : Infinity;
	const entries: Array<{
		entryId: string;
		parentEntryId: string | null;
		role: "user" | "assistant";
		text: string;
		createdAt: string;
		textTruncated: boolean;
		sourceCommandId?: string;
		clientMessageId?: string;
		assistantMessageId?: string;
		launchSnapshot?: SessionLaunchSnapshot;
		stopReason?: "stop" | "length" | "toolUse" | "aborted" | "error";
		blocks?: EngineHistoryActivityBlock[];
		images?: EngineHistoryImage[];
		attachments?: EngineHistoryAttachment[];
	}> = [];
	const toolBlocks = new Map<string, EngineHistoryActivityBlock>();
	let sawActivity = false;
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "toolResult") {
			const block = toolBlocks.get(entry.message.toolCallId);
			if (!block) continue;
			const fullResult = historyMessageText(entry.message.content);
			block.toolStatus = entry.message.isError ? "failed" : "succeeded";
			if (images?.has(entry.id)) {
				block.images = images.get(entry.id);
				block.resultBlocks = historyMediaBlocks(entry.message.content, block.images!);
			}
			if (fullResult) {
				block.resultText = fullResult.slice(0, activityLimit);
				block.resultTruncated = fullResult.length > activityLimit;
			}
			if (entry.message.isError && fullResult) block.error = block.resultText;
			continue;
		}
		if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
		const fullText = historyMessageText(entry.message.content);
		const blocks =
			entry.message.role === "assistant" || images?.has(entry.id)
				? historyActivityBlocks(sessionId, entry.id, entry.message.content, activityLimit, messageLimit)
				: [];
		for (const block of blocks) {
			if (block.toolCallId) toolBlocks.set(block.toolCallId, block);
		}
		sawActivity ||= blocks.some(block => block.kind !== "text");
		const stopReason =
			entry.message.role === "assistant" ? assistantSnapshotStopReason(entry.message.stopReason) : undefined;
		if (
			!fullText &&
			blocks.length === 0 &&
			!attachments?.has(entry.id) &&
			stopReason !== "error" &&
			stopReason !== "aborted"
		)
			continue;
		const launchSnapshot =
			entry.message.role === "user" && entry.sourceCommandId
				? historyLaunchSnapshot(entry.launchSnapshot)
				: undefined;
		entries.push({
			entryId: entry.id,
			parentEntryId: null,
			role: entry.message.role,
			text: fullText.slice(0, messageLimit),
			createdAt: entry.timestamp,
			textTruncated: fullText.length > messageLimit,
			...(blocks.length ? { blocks } : {}),
			...(images?.has(entry.id) ? { images: images.get(entry.id) } : {}),
			...(attachments?.has(entry.id) ? { attachments: attachments.get(entry.id) } : {}),
			...(entry.message.role === "user" && entry.sourceCommandId ? { sourceCommandId: entry.sourceCommandId } : {}),
			...(entry.message.role === "user" && entry.clientMessageId ? { clientMessageId: entry.clientMessageId } : {}),
			...(launchSnapshot ? { launchSnapshot } : {}),
			...(stopReason ? { stopReason } : {}),
			...(entry.message.role === "assistant" && entry.assistantMessageId
				? { assistantMessageId: entry.assistantMessageId }
				: {}),
		});
	}
	const projected = entries.map((entry, index) => ({
		...entry,
		parentEntryId: entries[index - 1]?.entryId ?? null,
	}));
	return {
		sessionId,
		leafEntryId: projected.at(-1)?.entryId ?? null,
		sessionLeafEntryId: branch.at(-1)?.id ?? null,
		entries: projected,
		activityCompleteness: sawActivity ? ("complete" as const) : ("legacy_messages_only" as const),
	};
}

function historyMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(block => {
			if (!block || typeof block !== "object") return [];
			const value = block as { type?: unknown; text?: unknown };
			if (value.type === "text" && typeof value.text === "string") return [value.text];
			if (value.type === "image") return ["[Image]"];
			return [];
		})
		.join("\n");
}

function historyActivityText(
	value: unknown,
	limit = MAX_HISTORY_ACTIVITY_CHARS,
): { text?: string; truncated?: boolean } {
	let raw: string;
	try {
		raw = typeof value === "string" ? value : stableStringifyJson(value);
	} catch {
		return {};
	}
	if (!raw) return {};
	return {
		text: raw.slice(0, limit),
		truncated: raw.length > limit,
	};
}

function historyActivityBlocks(
	sessionId: string,
	entryId: string,
	content: unknown,
	limit = MAX_HISTORY_ACTIVITY_CHARS,
	textLimit = MAX_HISTORY_MESSAGE_CHARS,
): EngineHistoryActivityBlock[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap<EngineHistoryActivityBlock>((raw, blockIndex) => {
		if (!raw || typeof raw !== "object") return [];
		const block = raw as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string" && block.text) {
			return [
				{
					blockId: `history:${sessionId}:${entryId}:${blockIndex}`,
					blockIndex,
					kind: "text",
					status: "available",
					text: block.text.slice(0, textLimit),
					textTruncated: block.text.length > textLimit,
				},
			];
		}
		if (block.type === "thinking" || block.type === "redactedThinking") {
			const value = historyActivityText(
				block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "",
				limit,
			);
			return [
				{
					blockId: `history:${sessionId}:${entryId}:${blockIndex}`,
					blockIndex,
					kind: "reasoning" as const,
					status: value.text ? ("available" as const) : ("unavailable" as const),
					...(value.text ? { text: value.text, textTruncated: value.truncated === true } : {}),
				},
			];
		}
		if (block.type !== "toolCall" || typeof block.id !== "string" || !block.id.trim()) return [];
		const args = historyActivityText(block.arguments, limit);
		return [
			{
				blockId: `history:${sessionId}:${entryId}:${blockIndex}`,
				blockIndex,
				kind: "tool_call" as const,
				status: "available" as const,
				toolCallId: block.id.slice(0, 200),
				...(typeof block.name === "string" && block.name.trim() ? { toolName: block.name.slice(0, 200) } : {}),
				...(args.text ? { argumentsText: args.text, argumentsTruncated: args.truncated === true } : {}),
				toolStatus: "unknown" as const,
			},
		];
	});
}

function assistantSnapshotStopReason(value: unknown): "stop" | "length" | "toolUse" | "aborted" | "error" | undefined {
	if (value === "stop" || value === "length" || value === "toolUse" || value === "aborted" || value === "error") {
		return value;
	}
	return undefined;
}

function validateControlRequest(request: EngineControlRequest): void {
	if (!request.commandId.trim()) {
		throw new EngineTargetError("invalid_request", "commandId must be a non-empty string");
	}
	if (request.initiator.kind === "human") return;
	if (request.initiator.kind !== "agent") {
		throw new EngineTargetError("invalid_request", "initiator kind must be human or agent");
	}
	if (!request.initiator.agentInstanceId.trim() || !request.initiator.agentInstanceRef.trim()) {
		throw new EngineTargetError("invalid_request", "agent initiator identity must be non-empty");
	}
}

function controlPayload(
	initiator: EngineControlInitiator,
	state: EngineAttemptState,
	duplicate = false,
	binding?: Pick<EngineBindingSnapshot, "manualHold" | "intentRevision">,
): Record<string, unknown> {
	return {
		initiator,
		attemptState: state,
		controlReadiness: controlReadiness(state),
		...(binding ? { manualHold: binding.manualHold, intentRevision: binding.intentRevision } : {}),
		...(duplicate ? { duplicate: true } : {}),
	};
}

function controlReadiness(state: EngineAttemptState): Record<string, boolean> {
	return {
		pause: state === "running",
		resume: state === "paused",
		steer: state === "running",
		cancel: state === "running" || state === "pause_requested" || state === "paused" || state === "waiting_input",
		resolveInput: state === "waiting_input",
	};
}

function validateInputResult(value: unknown, questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogResult {
	let serialized: string;
	try {
		serialized = stableStringifyJson(value);
	} catch {
		throw new EngineTargetError("invalid_request", "result must be JSON-serializable");
	}
	if (serialized.length > MAX_INPUT_RESULT_CHARS) {
		throw new EngineTargetError("invalid_request", `result exceeds ${MAX_INPUT_RESULT_CHARS} characters`);
	}
	const result = inputResultRecord(value, "result");
	if (result.kind === "chat") return { kind: "chat" };
	const rawResults = result.results;
	if (result.kind !== "submit" || !Array.isArray(rawResults)) {
		throw new EngineTargetError("invalid_request", "result must be a chat or submit Ask result");
	}
	if (rawResults.length !== questions.length) {
		throw new EngineTargetError("invalid_request", "result count does not match the pending questions");
	}
	return {
		kind: "submit",
		results: questions.map((question, index) => {
			const item = inputResultRecord(rawResults[index], `result.results[${index}]`);
			if (Object.hasOwn(item, "selectedOptionIndexes")) {
				validateRuntimeValue("indexedQuestionAnswer", item);
				const indexes = item.selectedOptionIndexes as number[];
				if (
					item.id !== question.id ||
					(!(question.multi ?? false) && indexes.length > 1) ||
					indexes.some(selected => selected >= question.options.length)
				)
					throw new EngineTargetError(
						"invalid_request",
						"Indexed response does not match the exact pending question",
					);
				return {
					id: question.id,
					question: question.question,
					options: question.options.map(option => option.label),
					multi: question.multi ?? false,
					selectedOptions: indexes.map(selected => question.options[selected].label),
					...optionalInputResultString(item, "customInput", index),
					...optionalInputResultString(item, "note", index),
				};
			}
			inputResultString(item.question, `result.results[${index}].question`);
			inputResultStringArray(item.options, `result.results[${index}].options`);
			const selectedOptions = inputResultStringArray(
				item.selectedOptions,
				`result.results[${index}].selectedOptions`,
			);
			const expectedOptions = question.options.map(option => option.label);
			const multi = question.multi ?? false;
			if (item.id !== question.id || item.multi !== multi) {
				throw new EngineTargetError(
					"invalid_request",
					`result.results[${index}] does not match the pending question`,
				);
			}
			if (!multi && selectedOptions.length > 1) {
				throw new EngineTargetError(
					"invalid_request",
					`result.results[${index}].selectedOptions has multiple values for a single-select question`,
				);
			}
			const available = new Map<string, string[]>();
			for (const option of expectedOptions) {
				const normalized = option.trim();
				const matching = available.get(normalized) ?? [];
				matching.push(option);
				available.set(normalized, matching);
			}
			const canonicalSelectedOptions = selectedOptions.map(selected => {
				const matching = available.get(selected.trim());
				const canonical = matching?.shift();
				if (canonical === undefined) {
					throw new EngineTargetError(
						"invalid_request",
						`result.results[${index}].selectedOptions contains an unknown option`,
					);
				}
				return canonical;
			});
			return {
				id: question.id,
				question: question.question,
				options: expectedOptions,
				multi,
				selectedOptions: canonicalSelectedOptions,
				...optionalInputResultString(item, "customInput", index),
				...optionalInputResultString(item, "note", index),
				...optionalInputResultBoolean(item, "timedOut"),
			};
		}),
	};
}

function inputResultRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new EngineTargetError("invalid_request", `${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function inputResultStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		throw new EngineTargetError("invalid_request", `${label} must be a string array`);
	}
	return value;
}

function inputResultString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new EngineTargetError("invalid_request", `${label} must be a string`);
	return value;
}

function optionalInputResultString(
	record: Record<string, unknown>,
	key: "customInput" | "note",
	index: number,
): Partial<Record<"customInput" | "note", string>> {
	const value = record[key];
	if (value === undefined) return {};
	if (typeof value !== "string") throw new EngineTargetError("invalid_request", `${key} must be a string`);
	if (value.length > MAX_INPUT_FIELD_CHARS) {
		throw new EngineTargetError(
			"invalid_request",
			`result.results[${index}].${key} exceeds ${MAX_INPUT_FIELD_CHARS} characters`,
		);
	}
	return { [key]: value };
}

function optionalInputResultBoolean(
	record: Record<string, unknown>,
	key: "timedOut",
): Partial<Record<"timedOut", boolean>> {
	const value = record[key];
	if (value === undefined) return {};
	if (typeof value !== "boolean") throw new EngineTargetError("invalid_request", `${key} must be a boolean`);
	return { [key]: value };
}

function sha256(value: string | Uint8Array): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

/** The storage owner rejected the transcript write itself; retrying the same prefix cannot make it durable. Only a
 * validation rejection proves that: any other storage failure leaves durability unknown (or merely refused admission). */
function isRejectedTranscriptWrite(error: unknown): boolean {
	for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
		if (current instanceof NativeSessionWriteRejectedError) return true;
		if (current instanceof StorageClientError)
			return current.code === "conflict" || current.code === "schema_error" || current.code === "sequence_gap";
	}
	return false;
}

/** Non-image files reach the model only through the read tool (attachment:// URIs). */
function assertFilesReadable(readEnabled: boolean, originals?: SessionMessageIdentity["originalAttachments"]): void {
	const file = readEnabled ? undefined : originals?.find(item => !SUPPORTED_IMAGE_MIME_TYPES.has(item.mediaType));
	if (file)
		throw new EngineTargetError(
			"attachment_requires_read",
			`File "${file.name}" cannot be sent: this execution does not allow the read tool required for attachments.`,
		);
}

function measuredAssistantUsage(usage: AssistantMessage["usage"] | undefined):
	{ input: number; output: number; cached: number } | null {
	if (!usage || usage.unavailable ||
		[usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(value => !Number.isSafeInteger(value) || value < 0))
		return null;
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	return Number.isSafeInteger(input) ? { input, output: usage.output, cached: usage.cacheRead } : null;
}

function modelInputHash(input: string, originals?: SessionMessageIdentity["originalAttachments"],
	images?: ImageContent[]): string {
	return images?.length || originals?.length
		? sha256(stableStringifyJson({
				input, originalAttachments: originals,
				images: images?.map(image => ({
					mimeType: image.mimeType, hash: sha256(Buffer.from(image.data, "base64")),
				})),
			}))
		: sha256(input);
}

function executionHash(value: unknown): string {
	return `sha256:${sha256(storageCanonicalJson(value))}`;
}

async function canonicalWorkspacePath(cwd: string): Promise<string> {
	const canonical = await fs.realpath(cwd).catch(() => path.resolve(cwd));
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function canonicalRetainedWorkspacePath(cwd: string): string {
	return process.platform === "win32" ? cwd.toLowerCase() : cwd;
}

