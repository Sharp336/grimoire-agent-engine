import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isEnoent, logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async/job-manager";
import { withCapabilityProviderPolicy } from "../capability";
import { SETTINGS_SCHEMA, type SettingPath, withSettingsScope } from "../config/settings";

import {
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	noOpUIContext,
	type ToolExecutionHook,
	type ToolExecutionHookCall,
	type ToolExecutionHookOutcome,
	type ToolExecutionHookToken,
} from "../extensibility/extensions";
import { IrcBus, type IrcDeliveryReceipt } from "../irc/bus";
import { withLspSessionScope } from "../lsp/client";
import { MCPManager } from "../mcp/manager";
import type { MCPHttpServerConfig } from "../mcp/types";
import historyEditContinuePrompt from "../prompts/system/history-edit-continue.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { TurnRetryPolicy } from "../session/agent-session-types";
import { createProviderRetryBudgetHook } from "../session/provider-retry-budget";
import type { SessionEntry, SessionMessageIdentity } from "../session/session-entries";
import { loadSessionFile, parseSessionContent, type SessionLoadResult } from "../session/session-loader";
import {
	type NativeHistoryForkResult,
	type SessionDurabilityCheckpoint,
	SessionManager,
} from "../session/session-manager";
import { migrateToCurrentVersion } from "../session/session-migrations";
import type { EngineChildLaunchResult, EngineChildProfile, EngineInboxToolRequest } from "../tools";
import {
	type EngineAttemptState,
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
	type EngineInboxTarget,
	type EngineLaunchProfile,
	type EnginePeerMessage,
	type EngineReconcileRequest,
	type EngineReconcileResult,
	type EngineRejectedCommand,
	type EngineResolveInputRequest,
	type EngineStartRequest,
	type EngineStartResult,
	type EngineSteerRequest,
	type EngineTarget,
	EngineTargetError,
	type EngineToolApprovalDecision,
	type EngineToolPolicy,
	validateCommandContext,
	validateStartRequest,
} from "./contracts";
import { withProviderObservationContext } from "./provider-admission";
import { safeEngineErrorDetail } from "./public-error";
import { engineAgentId, engineAgentInstanceId, engineRouteToken } from "./route";
import {
	EngineAttemptConflictError,
	type EngineAttemptRecord,
	EngineInboxConflictError,
	type EngineModelEffectInput,
	EngineStore,
	type EngineToolEffectInput,
	type EngineTransitionEvent,
} from "./store";

type EngineEventListener = (event: EngineEvent) => void | Promise<void>;

const MAX_ASSISTANT_FINAL_CHARS = 48_000;
const MAX_INPUT_FIELD_CHARS = 48_000;
const MAX_INPUT_RESULT_CHARS = 128_000;
const MAX_HISTORY_MESSAGE_CHARS = 48_000;
const MAX_HISTORY_ACTIVITY_CHARS = 48_000;
const ASSISTANT_SNAPSHOT_GROWTH_CHARS = 192;
const MAX_ASSISTANT_STREAMING_SNAPSHOTS = 256;
const ENGINE_TURN_RETRY_DELAYS_MS = [3_000, 15_000, 30_000] as const;
const TERMINAL_ATTEMPT_STATES = new Set<EngineAttemptState>(["completed", "cancelled", "failed", "interrupted"]);
const MAX_NATIVE_RESTORE_BYTES = 128 * 1024 * 1024;
const MAX_NATIVE_RESTORE_CHUNK_BYTES = 24_000;

interface NativeRestoreStageMetadata {
	schema: "grimoire.engine.native_session_restore_stage.v1";
	restoreId: string;
	agentInstanceId: string;
	agentInstanceRef: string;
	authorityGeneration: number;
	contentHash: string;
	totalBytes: number;
	replaceBinding?: {
		bindingId: string;
		bindingGeneration: number;
		authorityGeneration: number;
		executionId: string;
		attemptId: string;
		sessionFile: string;
	};
}

interface NativeSessionArchiveMetadata {
	schema: "grimoire.engine.native_session_archive_snapshot.v1";
	agentInstanceId: string;
	sessionId: string;
	contentHash: string;
	byteLength: number;
}

interface NativeSessionCheckpoint {
	schema: "grimoire.engine.native_session_checkpoint.v1";
	sessionId: string;
	sessionJsonlHash: string;
	sessionJsonlBase64: string;
	artifacts: Array<{ name: string; contentHash: string; byteLength: number; contentBase64: string }>;
}

export interface EngineRestoreHistoryTarget {
	agentInstanceRef: string;
	authorityGeneration: number;
	restoreCheckpoint: { restoreId: string; contentHash: string };
}

type EngineHistoryActivityBlock = {
	blockId: string;
	blockIndex: number;
	kind: "reasoning" | "tool_call";
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
	error?: string;
};

function taskRefFromAgentInstanceRef(agentInstanceRef: string | undefined): string | undefined {
	if (!agentInstanceRef?.startsWith("grimoire://tasks/")) return undefined;
	const agentSegment = agentInstanceRef.lastIndexOf("/agents/");
	return agentSegment > "grimoire://tasks/".length ? agentInstanceRef.slice(0, agentSegment) : undefined;
}

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
): { found: boolean; data?: unknown } {
	const successfulResults = new Map<string, { data: unknown; messageIndex: number }>();
	for (let i = Math.max(0, startIndex); i < messages.length; i++) {
		const message = messages[i];
		if (
			message?.role !== "toolResult" ||
			message.toolName !== "yield" ||
			typeof message.toolCallId !== "string" ||
			message.isError === true ||
			!message.details ||
			typeof message.details !== "object" ||
			Array.isArray(message.details)
		) {
			continue;
		}
		const details = message.details as Record<string, unknown>;
		if (details.status !== "success" || (Array.isArray(details.type) && details.type.length > 0)) continue;
		if (!Object.hasOwn(details, "data")) continue;
		successfulResults.set(message.toolCallId, { data: details.data, messageIndex: i });
	}
	for (let i = messages.length - 1; i >= Math.max(0, startIndex); i--) {
		const message = messages[i];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j];
			if (!block || typeof block !== "object") continue;
			const call = block as { type?: string; id?: unknown; name?: string };
			if (call.type !== "toolCall" || call.name !== "yield" || typeof call.id !== "string") continue;
			const result = successfulResults.get(call.id);
			if (result && result.messageIndex > i) return { found: true, data: result.data };
		}
	}
	return { found: false };
}

interface LiveBinding extends EngineBindingSnapshot {
	conversationIdentityDigest: string;
	previousInboxSessionId?: string;
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
	disposeProfile: () => void;
	requireYieldTool: boolean;
	pauseGate: AgentPauseGate;
	activeToolCallIds: Set<string>;
	pauseProgress: PromiseWithResolvers<void>;
	pauseCommandIds: Set<string>;
	pauseRequests: Map<string, EngineControlInitiator>;
	resumeCommandIds: Set<string>;
	traceWriteTail: Promise<void>;
	retryWriteError?: unknown;
	traceTools: Map<string, { name: string; startedAt: number }>;
	childLaunchCount: number;
	modelCallSequence: number;
	assistantMessageSequence: number;
	assistantStream?: AssistantStreamState;
	lastAssistantMessageId?: string;
	activeModelCalls: Set<Promise<void>>;
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
}

interface ToolInvocationRecord {
	invocationId: string;
	policy: EngineToolPolicy;
	toolCallId: string;
	toolName: string;
	inputHash: string;
	target: EngineBindingSnapshot;
	done: Promise<void>;
	resolveDone: () => void;
	settled: boolean;
}

interface PendingToolApproval {
	record: ToolInvocationRecord;
	resolve: (decision: {
		decision: "approve" | "deny" | "cancelled";
		reason?: string;
		causationCommandId?: string;
	}) => void;
}

interface PendingInput {
	inputId: string;
	questions: ExtensionAskDialogQuestion[];
	resolve: (result: ExtensionAskDialogResult | undefined) => void;
}

type HistoryDispatchKind = "prompt" | "continue" | "continue_after_assistant";

interface PreparedHistoryStart {
	sessionManager: SessionManager;
	dispatchKind: HistoryDispatchKind;
	dispatchInput: string;
	pendingInboxSourceSessionId?: string;
	result: NonNullable<EngineStartResult["historyEdit"]>;
}

interface PreparedRestoreStart {
	sessionManager: SessionManager;
	stageDir: string;
}

export interface EngineRuntimeOptions {
	databasePath: string;
	/** Hosted Core binding. Credentials stay in memory; undefined preserves standalone discovery. */
	mcpServer?: MCPHttpServerConfig;
	childHistoryTtlMinutes?: number;
	childHistoryRetention?: "local" | "off" | "grimoire";
	archiveChildHistory?: (request: {
		agentInstanceId: string;
		agentInstanceRef: string;
		attemptId: string;
		terminalAt: number;
		content: string;
	}) => Promise<void>;
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
	/** Test/integration seam; production uses AgentSession.prompt directly. */
	dispatchPrompt?: (
		session: AgentSession,
		input: string,
		identity?: SessionMessageIdentity,
		kind?: HistoryDispatchKind,
	) => Promise<boolean>;
	resolveSessionProfile?: (
		profile: EngineLaunchProfile,
		cwd: string,
		signal?: AbortSignal,
	) => Promise<{
		options: Partial<CreateAgentSessionOptions>;
		childProfiles?: EngineChildProfile[];
		sameModelRouteFallback?: NonNullable<TurnRetryPolicy["sameModelRouteFallback"]>;
		dispose(): void;
	}>;
	/** Exact non-secret digest of every external dependency resolved for this launch. */
	resolveSessionContinuation?: (profile: EngineLaunchProfile, cwd: string) => Promise<string>;
	launchChild?: (request: {
		parentAgentInstanceId: string;
		parentAgentInstanceRef: string;
		parentAttemptId: string;
		profileRef: string;
		workStepId: string;
		toolCallId: string;
		cwd: string;
		maxSpawnDepth: number;
		signal?: AbortSignal;
	}) => Promise<EngineChildLaunchResult>;
}

type PendingStartResolution = {
	target: Pick<EngineStartRequest, "agentInstanceId" | "executionId" | "attemptId" | "authorityGeneration">;
	controller: AbortController;
};

export class EngineRuntime {
	readonly agentRegistry = new AgentRegistry();
	readonly agentLifecycle = new AgentLifecycleManager(this.agentRegistry);
	readonly asyncJobManager = new AsyncJobManager({ requireAttemptId: true });
	readonly ircBus = new IrcBus(this.agentRegistry, this.agentLifecycle);
	readonly engineGeneration: number;
	readonly store: EngineStore;
	readonly #sessionDefaults: EngineRuntimeOptions["sessionDefaults"];
	readonly #mcpServer: EngineRuntimeOptions["mcpServer"];
	readonly #dispatchPrompt: (
		session: AgentSession,
		input: string,
		identity?: SessionMessageIdentity,
		kind?: HistoryDispatchKind,
	) => Promise<boolean>;
	readonly #resolveSessionProfile: EngineRuntimeOptions["resolveSessionProfile"];
	readonly #resolveSessionContinuation: EngineRuntimeOptions["resolveSessionContinuation"];
	readonly #launchChild: EngineRuntimeOptions["launchChild"];
	readonly #childHistoryTtlMinutes: number;
	readonly #childHistoryRetention: "local" | "off" | "grimoire";
	readonly #archiveChildHistory: EngineRuntimeOptions["archiveChildHistory"];
	readonly #bindings = new Map<string, LiveBinding>();
	readonly #lanes = new Map<string, Promise<void>>();
	readonly #runs = new Set<Promise<void>>();
	readonly #listeners = new Set<EngineEventListener>();
	readonly #toolInvocations = new Map<string, ToolInvocationRecord>();
	readonly #pendingToolApprovals = new Map<string, PendingToolApproval>();
	readonly #pendingStarts = new Set<PendingStartResolution>();
	readonly #sessionRoot: string;
	#inboxWakeSignal = Promise.withResolvers<void>();
	#inboxWakeRun?: Promise<void>;
	#disposed = false;

	private constructor(store: EngineStore, engineGeneration: number, options: EngineRuntimeOptions) {
		this.store = store;
		this.engineGeneration = engineGeneration;
		this.#sessionDefaults = options.sessionDefaults;
		this.#mcpServer = options.mcpServer;
		this.#dispatchPrompt =
			options.dispatchPrompt ??
			((session, input, identity, kind = "prompt") => {
				if (kind === "continue") return session.continueNativeHistory().then(() => true);
				if (kind === "continue_after_assistant") {
					return session.prompt(input, { synthetic: true, expandPromptTemplates: false, attribution: "agent" });
				}
				return session.prompt(input, identity);
			});
		this.#resolveSessionProfile = options.resolveSessionProfile;
		this.#resolveSessionContinuation = options.resolveSessionContinuation;
		this.#launchChild = options.launchChild;
		this.#childHistoryTtlMinutes = options.childHistoryTtlMinutes ?? 60;
		if (!Number.isSafeInteger(this.#childHistoryTtlMinutes) || this.#childHistoryTtlMinutes < 1) {
			throw new Error("childHistoryTtlMinutes must be a positive integer");
		}
		this.#childHistoryRetention = options.childHistoryRetention ?? "local";
		this.#archiveChildHistory = options.archiveChildHistory;
		this.#sessionRoot = path.join(path.dirname(path.resolve(options.databasePath)), "engine-sessions");
	}

	static async create(options: EngineRuntimeOptions): Promise<EngineRuntime> {
		const store = await EngineStore.open(options.databasePath);
		const engineGeneration = await store.nextEngineGeneration();
		const runtime = new EngineRuntime(store, engineGeneration, options);
		await runtime.#reconcileLostAttempts();
		runtime.#inboxWakeRun = runtime.#runInboxWakeLoop();
		return runtime;
	}

	subscribe(listener: EngineEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
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

	start(request: EngineStartRequest, profile: EngineLaunchProfile): Promise<EngineStartResult> {
		validateStartRequest(request);
		if (!profile.profileDigest.trim()) {
			throw new EngineTargetError("invalid_request", "profileDigest must be a non-empty string");
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
		return this.#inLanes(laneIds, () => this.#startInLane(request, profile, pending.controller.signal))
			.catch(async error => {
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
			.finally(() => this.#pendingStarts.delete(pending));
	}

	steer(request: EngineSteerRequest): Promise<EngineControlResult> {
		validateCommandContext(request.context);
		const queued = request.queueId !== undefined;
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
				: !request.message?.trim() || request.mutationId !== undefined || request.expectedRevision !== undefined)
		) {
			throw new EngineTargetError("invalid_request", "steer requires text or a complete queued-item identity");
		}
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = await this.#requireCancelableTarget(request);
			if (!binding) {
				const durable = await this.store.getBinding(request.agentInstanceId);
				if (queued) {
					if (durable && request.expectedIntentRevision !== durable.intentRevision) {
						throw new EngineTargetError(
							"stale_target",
							`Intent revision ${durable.intentRevision} does not match ${request.expectedIntentRevision}`,
						);
					}
					throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is no longer active`);
				}
				return {
					phase: "applied",
					manualHold: durable?.manualHold ?? true,
					intentRevision: durable?.intentRevision ?? 0,
				};
			}
			if (binding.steerCommandSet.has(request.commandId)) return this.#controlResult(binding);
			const steerableState =
				binding.attemptState === "running" ||
				binding.attemptState === "pause_requested" ||
				binding.attemptState === "paused";
			if (
				binding.state !== "running" ||
				!steerableState ||
				(binding.attemptState !== "paused" && !binding.session.isStreaming)
			) {
				throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is not streaming`);
			}
			const item = queued ? await this.store.getInboxItem(binding.session.sessionId, request.queueId!) : undefined;
			if (queued && (item?.disposition !== "pending" || item.revision !== request.expectedRevision)) {
				throw new EngineTargetError(
					"stale_target",
					`Inbox item ${request.queueId} is no longer pending at that revision`,
				);
			}
			const previousIntent = this.#setManualHold(binding, request.commandId, request.expectedIntentRevision, false);
			const previousState = binding.attemptState;
			const result = this.#controlResult(
				binding,
				item ? "consumed" : "applied",
				item ? { ...item, revision: item.revision + 1 } : undefined,
			);
			try {
				await this.#sendCommandContext(binding, request.context, request.commandId);
				await binding.session.steer(item?.deliveryPayload ?? request.message!, undefined, {
					sourceCommandId: request.commandId,
					...(request.clientMessageId
						? { clientMessageId: request.clientMessageId }
						: item?.sourceType === "user"
							? { clientMessageId: item.sourceEventId }
							: {}),
				});
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
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			if (binding.pauseCommandIds.has(request.commandId)) return this.#controlResult(binding);
			const previousIntent = this.#setManualHold(binding, request.commandId, request.expectedIntentRevision, true);
			if (binding.attemptState === "paused") {
				const result = this.#controlResult(binding);
				try {
					await this.#commitAttemptTransition(
						binding,
						"paused",
						[
							{
								kind: "paused",
								payload: controlPayload(request.initiator, "paused", true, binding),
								causationCommandId: request.commandId,
							},
						],
						{
							expectedStates: ["paused"],
							settleCommandId: request.commandId,
							settleCommandReceipt: { outcome: "applied", detail: result },
						},
					);
				} catch (error) {
					this.#restoreIntent(binding, previousIntent);
					throw error;
				}
				binding.pauseCommandIds.add(request.commandId);
				return result;
			}
			if (binding.attemptState === "pause_requested") {
				const result = this.#controlResult(binding);
				try {
					await this.#commitAttemptTransition(
						binding,
						"pause_requested",
						[
							{
								kind: "pause_requested",
								payload: controlPayload(request.initiator, "pause_requested", true, binding),
								causationCommandId: request.commandId,
							},
						],
						{
							expectedStates: ["pause_requested"],
							settleCommandId: request.commandId,
							settleCommandReceipt: { outcome: "applied", detail: result },
						},
					);
				} catch (error) {
					this.#restoreIntent(binding, previousIntent);
					throw error;
				}
				binding.pauseCommandIds.add(request.commandId);
				binding.pauseRequests.set(request.commandId, request.initiator);
				return result;
			}
			if (binding.attemptState !== "running") {
				this.#restoreIntent(binding, previousIntent);
				throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is already ${binding.attemptState}`);
			}
			binding.pauseGate.pause();
			binding.attemptState = "pause_requested";
			const result = this.#controlResult(binding);
			try {
				await this.#commitAttemptTransition(
					binding,
					"pause_requested",
					[
						{
							kind: "pause_requested",
							payload: controlPayload(request.initiator, "pause_requested", false, binding),
							causationCommandId: request.commandId,
						},
					],
					{
						settleCommandId: request.commandId,
						settleCommandReceipt: { outcome: "applied", detail: result },
						expectedStates: ["running"],
					},
				);
			} catch (error) {
				binding.attemptState = "running";
				binding.pauseGate.resume();
				this.#restoreIntent(binding, previousIntent);
				throw error;
			}
			binding.pauseCommandIds.add(request.commandId);
			binding.pauseRequests.set(request.commandId, request.initiator);
			this.#trackRun(this.#finishPause(binding, request.attemptId));
			return result;
		});
	}

	resume(request: EngineControlRequest): Promise<EngineControlResult> {
		validateControlRequest(request);
		validateCommandContext(request.context);
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			if (binding.resumeCommandIds.has(request.commandId)) return this.#controlResult(binding);
			this.#assertIntentRevision(binding, request.expectedIntentRevision);
			if (binding.attemptState !== "paused") {
				throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is already ${binding.attemptState}`);
			}
			const previousIntent = this.#setManualHold(binding, request.commandId, request.expectedIntentRevision, false);
			binding.attemptState = "running";
			const result = this.#controlResult(binding);
			try {
				await this.#sendCommandContext(binding, request.context, request.commandId);
				await this.#commitAttemptTransition(
					binding,
					"running",
					[
						{
							kind: "resumed",
							payload: controlPayload(request.initiator, "running", false, binding),
							causationCommandId: request.commandId,
						},
					],
					{
						settleCommandId: request.commandId,
						settleCommandReceipt: { outcome: "applied", detail: result },
						expectedStates: ["paused"],
					},
				);
			} catch (error) {
				binding.attemptState = "paused";
				this.#restoreIntent(binding, previousIntent);
				throw error;
			}
			binding.resumeCommandIds.add(request.commandId);
			binding.pauseGate.resume();
			this.#signalInboxWake();
			return result;
		});
	}

	cancel(request: EngineCancelRequest): Promise<EngineControlResult> {
		if (!request.commandId.trim()) {
			throw new EngineTargetError("invalid_request", "commandId must be a non-empty string");
		}
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			if (binding.attemptState === "cancelled" || binding.attemptState === "cancel_requested") {
				return this.#controlResult(binding);
			}
			if (
				request.expectedIntentRevision !== undefined &&
				(binding.attemptState === "completed" ||
					binding.attemptState === "failed" ||
					binding.attemptState === "interrupted")
			) {
				this.#assertIntentRevision(binding, request.expectedIntentRevision);
				const terminalState = binding.attemptState;
				const previousIntent = this.#setManualHold(
					binding,
					request.commandId,
					request.expectedIntentRevision,
					true,
				);
				const result: EngineControlResult = { ...this.#controlResult(binding), alreadyTerminal: true };
				try {
					const event = await this.store.commitBindingEvent(
						this.#snapshot(binding),
						{
							kind: "inbox_changed",
							payload: {
								action: "hold_applied",
								attemptState: terminalState,
								manualHold: true,
								intentRevision: binding.intentRevision,
							},
							causationCommandId: request.commandId,
						},
						request.commandId,
						{ outcome: "applied", detail: result },
					);
					this.#notifyEvents([event]);
				} catch (error) {
					this.#restoreIntent(binding, previousIntent);
					throw error;
				}
				return result;
			}
			if (
				binding.attemptState !== "running" &&
				binding.attemptState !== "pause_requested" &&
				binding.attemptState !== "paused" &&
				binding.attemptState !== "waiting_input"
			) {
				throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is already ${binding.attemptState}`);
			}
			const reason = request.reason ?? "Engine attempt cancelled";
			const previousState = binding.attemptState;
			const previousIntent = this.#setManualHold(binding, request.commandId, request.expectedIntentRevision, true);
			binding.attemptState = "cancel_requested";
			const result = this.#controlResult(binding);
			try {
				await this.#commitAttemptTransition(binding, "cancel_requested", [], {
					cause: request.reason,
					settleCommandId: request.commandId,
					settleCommandReceipt: { outcome: "applied", detail: result },
					expectedStates: [previousState],
				});
			} catch (error) {
				binding.attemptState = previousState;
				this.#restoreIntent(binding, previousIntent);
				throw error;
			}
			await this.#cancelToolApprovals(binding, reason, request.commandId);
			this.asyncJobManager.cancelAll({ ownerId: binding.engineAgentId, attemptId: binding.attemptId });
			await this.#cancelPendingInput(binding, reason, request.commandId);
			const abort = binding.session.abort({ reason });
			binding.pauseGate.resume();
			this.#notifyPauseProgress(binding);
			this.#trackRun(this.#finishCancel(binding, request, abort));
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
	}): Promise<Record<string, unknown>> {
		if (!request.commandId.trim()) {
			throw new EngineTargetError("invalid_request", "commandId must be a non-empty string");
		}
		this.#throwIfDisposed();
		if (request.engineGeneration !== this.engineGeneration) {
			throw new EngineTargetError("stale_target", `Engine generation ${request.engineGeneration} is stale`);
		}
		const cancelLiveBinding = async (): Promise<EngineControlResult | undefined> => {
			const binding = this.#bindings.get(request.agentInstanceId);
			if (!binding) return undefined;
			if (
				binding.executionId !== request.executionId ||
				binding.attemptId !== request.attemptId ||
				binding.authorityGeneration !== request.authorityGeneration ||
				binding.engineGeneration !== request.engineGeneration
			)
				return undefined;
			return await this.cancel({
				...this.#snapshot(binding),
				commandId: request.commandId,
				reason: request.reason,
				expectedIntentRevision: request.expectedIntentRevision,
			});
		};
		const liveResult = await cancelLiveBinding();
		if (liveResult) return liveResult;
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
			const racedLiveResult = await cancelLiveBinding();
			if (racedLiveResult) return racedLiveResult;
			throw new EngineTargetError("too_late", `Attempt ${request.attemptId} has already started or settled`);
		}
		throw new EngineTargetError("agent_not_found", `Unknown pending Attempt ${request.attemptId}`);
	}

	resolveToolApproval(request: EngineToolApprovalDecision): Promise<void> {
		if (!request.commandId.trim() || !request.approvalId.trim()) {
			throw new EngineTargetError("invalid_request", "commandId and approvalId must be non-empty strings");
		}
		if (request.decision !== "approve" && request.decision !== "deny") {
			throw new EngineTargetError("invalid_request", "decision must be approve or deny");
		}
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			const pending = this.#pendingToolApprovals.get(request.approvalId);
			if (!pending || pending.record.target.bindingId !== binding.bindingId) {
				throw new EngineTargetError("too_late", `Tool approval ${request.approvalId} is no longer pending`);
			}
			const events = await this.store.resolveToolApproval(
				pending.record.target,
				request.approvalId,
				request.decision,
				{
					...(request.reason ? { reason: request.reason.slice(0, 2_048) } : {}),
					causationCommandId: request.commandId,
					settleCommandId: request.commandId,
				},
			);
			this.#notifyEvents(events);
			if (this.#pendingToolApprovals.get(request.approvalId) !== pending) return;
			this.#pendingToolApprovals.delete(request.approvalId);
			pending.resolve({ decision: request.decision, reason: request.reason });
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
								result,
								attemptState: "running",
								controlReadiness: controlReadiness("running"),
							},
							causationCommandId: request.commandId,
						},
					],
					{ settleCommandId: request.commandId, expectedStates: ["waiting_input"] },
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

	recordCommandRejection(command: EngineRejectedCommand, settleCommand = true): Promise<void> {
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
			await this.#commitEvent(
				{
					commandId: command.commandId,
					agentInstanceId: command.agentInstanceId,
					executionId: command.executionId,
					attemptId: command.attemptId,
					engineGeneration: this.engineGeneration,
					bindingId: "",
					bindingGeneration: command.bindingGeneration ?? 0,
					authorityGeneration: command.authorityGeneration,
				},
				"rejected",
				{ code: command.code, message: command.message, ...(sessionState ? { sessionState } : {}) },
				command.commandId,
				settleCommand ? command.commandId : undefined,
				{
					outcome: "rejected",
					detail: { code: command.code, message: command.message },
				},
			);
		});
	}

	release(target: EngineTarget, cause: "requested" | "engine_lost" = "requested"): Promise<void> {
		return this.#inLane(target.agentInstanceId, async () => {
			const binding = this.#requireTarget(target);
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
		return this.#inLane(target.agentInstanceId, async () => {
			const retained = await this.#requireSessionTarget(target);
			const queued = await this.store.enqueueInboxItem(retained, source);
			if (queued.created) {
				this.#signalInboxWake();
			}
			return queued;
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
			if (!this.#bindings.has(target.agentInstanceId)) {
				const retained = await this.#requireSessionTarget(target);
				return {
					schema: "grimoire.engine.session_context.v1",
					status: "not_ready",
					attemptId: retained.attemptId,
					sessionId: retained.sessionId,
					context: null,
					reason: "session_not_active",
				};
			}
			const binding = this.#requireTarget(target);
			const model = binding.session.model;
			return {
				schema: "grimoire.engine.session_context.v1",
				attemptId: binding.attemptId,
				sessionId: binding.session.sessionId,
				model: model ? { provider: model.provider, id: model.id, contextWindow: model.contextWindow } : null,
				context: binding.session.getContextBreakdown() ?? null,
				contextUsageRevision: binding.session.contextUsageRevision,
			};
		});
	}

	sessionUsage(target: EngineTarget): Promise<Record<string, unknown>> {
		return this.#inLane(target.agentInstanceId, async () => {
			if (!this.#bindings.has(target.agentInstanceId)) {
				const retained = await this.#requireSessionTarget(target);
				return {
					schema: "grimoire.engine.session_usage.v1",
					status: "not_ready",
					attemptId: retained.attemptId,
					sessionId: retained.sessionId,
					local: null,
					provider: { status: "unavailable", reason: "session_not_active" },
				};
			}
			const binding = this.#requireTarget(target);
			const model = binding.session.model;
			const local = binding.session.getSessionStats();
			try {
				const reports = await binding.session.fetchUsageReports();
				return {
					schema: "grimoire.engine.session_usage.v1",
					attemptId: binding.attemptId,
					sessionId: binding.session.sessionId,
					model: model ? { provider: model.provider, id: model.id } : null,
					local,
					provider: reports?.length
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
						: { status: "unavailable", reason: "provider_usage_not_supported" },
				};
			} catch {
				return {
					schema: "grimoire.engine.session_usage.v1",
					attemptId: binding.attemptId,
					sessionId: binding.session.sessionId,
					model: model ? { provider: model.provider, id: model.id } : null,
					local,
					provider: { status: "unavailable", reason: "provider_usage_fetch_failed" },
				};
			}
		});
	}

	async sessionHistory(
		agentInstanceId: string,
		restore?: EngineRestoreHistoryTarget,
	): Promise<{
		sessionId: string;
		leafEntryId: string | null;
		sessionLeafEntryId?: string | null;
		entries: Array<{
			entryId: string;
			parentEntryId: string | null;
			role: "user" | "assistant";
			text: string;
			createdAt: string;
			textTruncated: boolean;
			sourceCommandId?: string;
			clientMessageId?: string;
			assistantMessageId?: string;
			blocks?: EngineHistoryActivityBlock[];
		}>;
		activityCompleteness: "complete" | "legacy_messages_only";
	}> {
		return await this.#inLane(agentInstanceId, async () => {
			this.#throwIfDisposed();
			const live = this.#bindings.get(agentInstanceId);
			let sessionId: string;
			let branch: SessionEntry[];
			if (restore) {
				const { checkpoint } = await this.#readRestoreCheckpoint({ agentInstanceId, ...restore });
				const loaded = parseSessionContent(
					new TextDecoder("utf-8", { fatal: true }).decode(
						decodeCanonicalBase64(checkpoint.sessionJsonlBase64, "Session JSONL"),
					),
				);
				migrateToCurrentVersion(loaded.entries);
				sessionId = checkpoint.sessionId;
				branch = activeSessionBranch(
					loaded.entries.filter((entry): entry is SessionEntry => entry.type !== "session"),
				);
			} else if (live) {
				sessionId = live.session.sessionId;
				branch = live.session.sessionManager.getBranch();
			} else {
				const binding = await this.store.getBinding(agentInstanceId);
				if (!binding) {
					throw new EngineTargetError("agent_not_found", `No retained OMP session for ${agentInstanceId}`);
				}
				if (!binding.sessionFile) {
					const attempt = await this.store.getAttempt(binding.attemptId);
					if (attempt?.transcript_session_id && attempt.transcript_path && attempt.transcript_revision > 0) {
						throw new EngineTargetError("history_expired", `OMP session history expired for ${agentInstanceId}`);
					}
					throw new EngineTargetError("agent_not_found", `No retained OMP session for ${agentInstanceId}`);
				}
				const loaded = await loadSessionFile(binding.sessionFile, this.store.sessionStorage);
				if (loaded.entries.length === 0 || loaded.entries[0]?.type !== "session") {
					throw new EngineTargetError("agent_not_found", `No retained OMP session for ${agentInstanceId}`);
				}
				migrateToCurrentVersion(loaded.entries);
				sessionId = loaded.entries[0].id;
				branch = activeSessionBranch(
					loaded.entries.filter((entry): entry is SessionEntry => entry.type !== "session"),
				);
			}
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
				blocks?: ReturnType<typeof historyActivityBlocks>;
			}> = [];
			const toolBlocks = new Map<string, ReturnType<typeof historyActivityBlocks>[number]>();
			let sawActivity = false;
			for (const entry of branch) {
				if (entry.type !== "message") continue;
				if (entry.message.role === "toolResult") {
					const block = toolBlocks.get(entry.message.toolCallId);
					if (!block) continue;
					const fullResult = historyMessageText(entry.message.content);
					block.toolStatus = entry.message.isError ? "failed" : "succeeded";
					if (fullResult) {
						block.resultText = fullResult.slice(0, MAX_HISTORY_ACTIVITY_CHARS);
						block.resultTruncated = fullResult.length > MAX_HISTORY_ACTIVITY_CHARS;
					}
					if (entry.message.isError && fullResult) block.error = block.resultText;
					continue;
				}
				if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
				const fullText = historyMessageText(entry.message.content);
				const blocks =
					entry.message.role === "assistant"
						? historyActivityBlocks(sessionId, entry.id, entry.message.content)
						: [];
				for (const block of blocks) {
					if (block.toolCallId) toolBlocks.set(block.toolCallId, block);
				}
				sawActivity ||= blocks.length > 0;
				if (!fullText && blocks.length === 0) continue;
				entries.push({
					entryId: entry.id,
					parentEntryId: null,
					role: entry.message.role,
					text: fullText.slice(0, MAX_HISTORY_MESSAGE_CHARS),
					createdAt: entry.timestamp,
					textTruncated: fullText.length > MAX_HISTORY_MESSAGE_CHARS,
					...(blocks.length ? { blocks } : {}),
					...(entry.message.role === "user" && entry.sourceCommandId
						? { sourceCommandId: entry.sourceCommandId }
						: {}),
					...(entry.message.role === "user" && entry.clientMessageId
						? { clientMessageId: entry.clientMessageId }
						: {}),
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
				activityCompleteness: sawActivity ? "complete" : "legacy_messages_only",
			};
		});
	}

	async sessionArchive(
		agentInstanceId: string,
		expectedContentHash?: string,
		offset = 0,
		limit = 24_000,
	): Promise<{
		schema: "grimoire.engine.session_archive.v1";
		agentInstanceId: string;
		sessionId: string;
		payloadSchema: "grimoire.engine.native_session_checkpoint.v1";
		contentHash: string;
		byteLength: number;
		offset: number;
		nextOffset: number | null;
		contentBase64: string;
	}> {
		return await this.#inLane(agentInstanceId, async () => {
			this.#throwIfDisposed();
			const live = this.#bindings.get(agentInstanceId);
			if (
				live &&
				(live.state !== "idle" ||
					!TERMINAL_ATTEMPT_STATES.has(live.attemptState) ||
					live.session.isStreaming ||
					live.pendingInput !== undefined)
			) {
				throw new EngineTargetError("agent_busy", `AgentInstance ${agentInstanceId} is not idle for archival`);
			}
			if (live) {
				await live.traceWriteTail;
				await live.session.sessionManager.flushAndCheckpoint();
			}
			const binding = live ? this.#snapshot(live) : await this.store.getBinding(agentInstanceId);
			if (!binding?.sessionFile) {
				throw new EngineTargetError(
					"history_expired",
					`Native session archive is unavailable for ${agentInstanceId}`,
				);
			}
			const snapshot =
				expectedContentHash === undefined
					? await this.#createSessionArchiveSnapshot(agentInstanceId, binding.sessionFile)
					: await this.#sessionArchiveSnapshot(agentInstanceId, expectedContentHash);
			if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.byteLength) {
				throw new EngineTargetError("invalid_request", "Native session archive offset is outside the payload");
			}
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24_000) {
				throw new EngineTargetError(
					"invalid_request",
					"Native session archive limit is outside the accepted range",
				);
			}
			const end = Math.min(snapshot.byteLength, offset + limit);
			const content = Buffer.alloc(end - offset);
			const handle = await fs.open(snapshot.payloadPath, "r");
			try {
				const { bytesRead } = await handle.read(content, 0, content.byteLength, offset);
				if (bytesRead !== content.byteLength) {
					throw new EngineTargetError("history_expired", "Native session archive snapshot is incomplete");
				}
			} finally {
				await handle.close();
			}
			return {
				schema: "grimoire.engine.session_archive.v1",
				agentInstanceId,
				sessionId: snapshot.sessionId,
				payloadSchema: "grimoire.engine.native_session_checkpoint.v1",
				contentHash: snapshot.contentHash,
				byteLength: snapshot.byteLength,
				offset,
				nextOffset: end < snapshot.byteLength ? end : null,
				contentBase64: content.toString("base64"),
			};
		});
	}

	async #createSessionArchiveSnapshot(
		agentInstanceId: string,
		sessionFile: string,
	): Promise<NativeSessionArchiveMetadata & { payloadPath: string }> {
		let content: string;
		try {
			content = await this.store.sessionStorage.readText(sessionFile);
		} catch (error) {
			if (isEnoent(error)) {
				throw new EngineTargetError(
					"history_expired",
					`Native session archive is unavailable for ${agentInstanceId}`,
				);
			}
			throw error;
		}
		const loaded = await loadSessionFile(sessionFile, this.store.sessionStorage);
		const header = loaded.entries[0];
		if (header?.type !== "session") {
			throw new EngineTargetError("history_expired", `Native session archive is invalid for ${agentInstanceId}`);
		}
		const artifactsDir = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : "";
		let artifactFiles: string[] = [];
		if (artifactsDir) {
			try {
				const children = await fs.readdir(artifactsDir, { withFileTypes: true });
				if (children.some(child => !child.isFile() || child.isSymbolicLink())) {
					throw new EngineTargetError("history_expired", "Native session artifact directory is unsafe");
				}
				artifactFiles = children.map(child => path.join(artifactsDir, child.name)).sort();
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		const artifacts: NativeSessionCheckpoint["artifacts"] = [];
		for (const artifactFile of artifactFiles) {
			const name = path.basename(artifactFile);
			if (
				!/^[A-Za-z0-9_.-]+$/.test(name) ||
				path.dirname(path.resolve(artifactFile)) !== path.resolve(artifactsDir)
			) {
				throw new EngineTargetError("history_expired", "Native session artifact path is invalid");
			}
			const artifactBytes = await fs.readFile(artifactFile);
			artifacts.push({
				name,
				contentHash: `sha256:${crypto.createHash("sha256").update(artifactBytes).digest("hex")}`,
				byteLength: artifactBytes.byteLength,
				contentBase64: artifactBytes.toString("base64"),
			});
		}
		const bytes = Buffer.from(
			`${JSON.stringify({
				schema: "grimoire.engine.native_session_checkpoint.v1",
				sessionId: header.id,
				sessionJsonlHash: `sha256:${crypto.createHash("sha256").update(content, "utf8").digest("hex")}`,
				sessionJsonlBase64: Buffer.from(content, "utf8").toString("base64"),
				artifacts,
			})}\n`,
			"utf8",
		);
		if (bytes.byteLength > MAX_NATIVE_RESTORE_BYTES) {
			throw new EngineTargetError("history_expired", "Native session archive exceeds the accepted range");
		}
		const contentHash = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
		const snapshotDir = this.#sessionArchiveSnapshotDir(agentInstanceId);
		const payloadPath = path.join(snapshotDir, `${contentHash.slice("sha256:".length)}.bin`);
		const metadataPath = path.join(snapshotDir, `${contentHash.slice("sha256:".length)}.json`);
		await fs.mkdir(snapshotDir, { recursive: true });
		try {
			await fs.writeFile(payloadPath, bytes, { flag: "wx" });
		} catch (error) {
			if (!isEexist(error)) throw error;
			const existing = await fs.readFile(payloadPath);
			if (!existing.equals(bytes)) {
				throw new EngineTargetError("history_expired", "Native session archive snapshot is corrupt");
			}
		}
		const metadata: NativeSessionArchiveMetadata = {
			schema: "grimoire.engine.native_session_archive_snapshot.v1",
			agentInstanceId,
			sessionId: header.id,
			contentHash,
			byteLength: bytes.byteLength,
		};
		try {
			await fs.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", flag: "wx" });
		} catch (error) {
			if (!isEexist(error)) throw error;
			const existing = JSON.parse(await fs.readFile(metadataPath, "utf8")) as NativeSessionArchiveMetadata;
			if (stableStringifyJson(existing) !== stableStringifyJson(metadata)) {
				throw new EngineTargetError("history_expired", "Native session archive metadata is corrupt");
			}
		}
		return { ...metadata, payloadPath };
	}

	async #sessionArchiveSnapshot(
		agentInstanceId: string,
		contentHash: string,
	): Promise<NativeSessionArchiveMetadata & { payloadPath: string }> {
		if (!/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
			throw new EngineTargetError("invalid_request", "Native session archive content hash is invalid");
		}
		const snapshotDir = this.#sessionArchiveSnapshotDir(agentInstanceId);
		const digest = contentHash.slice("sha256:".length);
		const payloadPath = path.join(snapshotDir, `${digest}.bin`);
		let metadata: NativeSessionArchiveMetadata;
		try {
			metadata = JSON.parse(await fs.readFile(path.join(snapshotDir, `${digest}.json`), "utf8"));
			const stat = await fs.stat(payloadPath);
			if (
				metadata.schema !== "grimoire.engine.native_session_archive_snapshot.v1" ||
				metadata.agentInstanceId !== agentInstanceId ||
				metadata.contentHash !== contentHash ||
				!Number.isSafeInteger(metadata.byteLength) ||
				metadata.byteLength < 1 ||
				metadata.byteLength > MAX_NATIVE_RESTORE_BYTES ||
				stat.size !== metadata.byteLength
			) {
				throw new Error("invalid archive snapshot");
			}
		} catch (error) {
			if (isEnoent(error))
				throw new EngineTargetError("stale_target", "Native session archive snapshot is unavailable");
			throw new EngineTargetError("history_expired", "Native session archive snapshot is invalid");
		}
		return { ...metadata, payloadPath };
	}

	async sessionRestoreStage(request: {
		agentInstanceId: string;
		agentInstanceRef: string;
		authorityGeneration: number;
		contentHash: string;
		totalBytes: number;
		offset: number;
		contentBase64: string;
		replaceRetainedBinding?: boolean;
	}): Promise<{ restoreId: string; contentHash: string; totalBytes: number; nextOffset: number; complete: boolean }> {
		return await this.#inLane(request.agentInstanceId, async () => {
			this.#throwIfDisposed();
			if (!request.agentInstanceId.trim() || !request.agentInstanceRef.trim()) {
				throw new EngineTargetError("invalid_request", "Restore target identity must be non-empty");
			}
			if (request.agentInstanceId !== engineAgentInstanceId(request.agentInstanceRef)) {
				throw new EngineTargetError("invalid_request", "Restore AgentInstance id does not match its durable ref");
			}
			if (!Number.isSafeInteger(request.authorityGeneration) || request.authorityGeneration < 0) {
				throw new EngineTargetError("invalid_request", "Restore authorityGeneration must be non-negative");
			}
			if (!/^sha256:[0-9a-f]{64}$/.test(request.contentHash)) {
				throw new EngineTargetError("invalid_request", "Restore contentHash must be a SHA-256 digest");
			}
			if (
				!Number.isSafeInteger(request.totalBytes) ||
				request.totalBytes < 1 ||
				request.totalBytes > MAX_NATIVE_RESTORE_BYTES
			) {
				throw new EngineTargetError("invalid_request", "Restore totalBytes is outside the accepted range");
			}
			if (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > request.totalBytes) {
				throw new EngineTargetError("invalid_request", "Restore offset is outside the payload");
			}
			if (
				typeof request.contentBase64 !== "string" ||
				request.contentBase64.length > Math.ceil(MAX_NATIVE_RESTORE_CHUNK_BYTES / 3) * 4
			) {
				throw new EngineTargetError("invalid_request", "Restore chunk is outside the accepted range");
			}
			const chunk = decodeCanonicalBase64(request.contentBase64, "Restore chunk");
			if (chunk.byteLength < 1 || chunk.byteLength > MAX_NATIVE_RESTORE_CHUNK_BYTES) {
				throw new EngineTargetError("invalid_request", "Restore chunk is outside the accepted range");
			}
			if (request.offset + chunk.byteLength > request.totalBytes) {
				throw new EngineTargetError("invalid_request", "Restore chunk exceeds totalBytes");
			}
			const prior = await this.store.getBinding(request.agentInstanceId);
			let replaceBinding: NativeRestoreStageMetadata["replaceBinding"];
			if (request.replaceRetainedBinding) {
				if (!prior?.sessionFile || (prior.state !== "idle" && prior.state !== "released")) {
					throw new EngineTargetError("stale_target", "Restore target has no terminal retained native session");
				}
				const live = this.#bindings.get(request.agentInstanceId);
				if (
					live &&
					(live.bindingId !== prior.bindingId ||
						live.bindingGeneration !== prior.bindingGeneration ||
						live.attemptId !== prior.attemptId ||
						live.executionId !== prior.executionId ||
						live.authorityGeneration !== prior.authorityGeneration ||
						live.sessionFile !== prior.sessionFile ||
						live.state !== "idle" ||
						live.session.isStreaming)
				) {
					throw new EngineTargetError("agent_busy", "Restore target binding is not durably idle");
				}
				replaceBinding = {
					bindingId: prior.bindingId,
					bindingGeneration: prior.bindingGeneration,
					authorityGeneration: prior.authorityGeneration,
					executionId: prior.executionId,
					attemptId: prior.attemptId,
					sessionFile: prior.sessionFile,
				};
			} else if (prior?.sessionFile) {
				throw new EngineTargetError("stale_target", "Restore target already has a native session");
			}

			const restoreId = crypto
				.createHash("sha256")
				.update(
					`${request.agentInstanceId}\0${request.agentInstanceRef}\0${request.authorityGeneration}\0${request.contentHash}\0${stableStringifyJson(replaceBinding ?? null)}`,
				)
				.digest("hex");
			const stageDir = this.#restoreStageDir(restoreId);
			const metadata: NativeRestoreStageMetadata = {
				schema: "grimoire.engine.native_session_restore_stage.v1",
				restoreId,
				agentInstanceId: request.agentInstanceId,
				agentInstanceRef: request.agentInstanceRef,
				authorityGeneration: request.authorityGeneration,
				contentHash: request.contentHash,
				totalBytes: request.totalBytes,
				...(replaceBinding ? { replaceBinding } : {}),
			};
			await fs.mkdir(stageDir, { recursive: true });
			const metadataPath = path.join(stageDir, "metadata.json");
			try {
				await fs.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", flag: "wx" });
			} catch (error) {
				if (!isEexist(error)) throw error;
				const existing = JSON.parse(await fs.readFile(metadataPath, "utf8")) as NativeRestoreStageMetadata;
				if (stableStringifyJson(existing) !== stableStringifyJson(metadata)) {
					throw new EngineTargetError("stale_target", "Restore stage identity changed");
				}
			}
			const payloadPath = path.join(stageDir, "checkpoint.bin");
			let currentBytes = 0;
			try {
				currentBytes = (await fs.stat(payloadPath)).size;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			if (request.offset > currentBytes) {
				throw new EngineTargetError("stale_target", `Restore expects offset ${currentBytes}`);
			}
			if (request.offset < currentBytes) {
				const replayEnd = request.offset + chunk.byteLength;
				if (replayEnd > currentBytes) {
					throw new EngineTargetError("stale_target", "Restore chunk conflicts with staged bytes");
				}
				const replay = Buffer.alloc(chunk.byteLength);
				const handle = await fs.open(payloadPath, "r");
				try {
					const { bytesRead } = await handle.read(replay, 0, replay.byteLength, request.offset);
					if (bytesRead !== replay.byteLength || !replay.equals(chunk)) {
						throw new EngineTargetError("stale_target", "Restore chunk conflicts with staged bytes");
					}
				} finally {
					await handle.close();
				}
			} else {
				await fs.appendFile(payloadPath, chunk);
				currentBytes += chunk.byteLength;
			}
			if (currentBytes > request.totalBytes) {
				throw new EngineTargetError("stale_target", "Restore stage exceeds totalBytes");
			}
			const complete = currentBytes === request.totalBytes;
			if (complete) {
				const current = await fs.readFile(payloadPath);
				const hash = `sha256:${crypto.createHash("sha256").update(current).digest("hex")}`;
				if (hash !== request.contentHash) {
					await fs.rm(payloadPath, { force: true });
					await fs.rm(path.join(stageDir, "ready"), { force: true });
					throw new EngineTargetError("invalid_request", "Restore checkpoint hash does not match");
				}
				try {
					parseNativeSessionCheckpoint(current);
				} catch (error) {
					await fs.rm(payloadPath, { force: true });
					await fs.rm(path.join(stageDir, "ready"), { force: true });
					throw error;
				}
				await fs.writeFile(path.join(stageDir, "ready"), `${request.contentHash}\n`, {
					encoding: "utf8",
					flag: "w",
				});
			}
			return {
				restoreId,
				contentHash: request.contentHash,
				totalBytes: request.totalBytes,
				nextOffset: currentBytes,
				complete,
			};
		});
	}

	async sweepExpiredChildHistory(now = Date.now()): Promise<{
		expired: number;
		archived: number;
		deleted: number;
		retained: number;
	}> {
		this.#throwIfDisposed();
		if (this.#childHistoryRetention === "local") {
			return { expired: 0, archived: 0, deleted: 0, retained: 0 };
		}
		const cutoff = now - this.#childHistoryTtlMinutes * 60_000;
		const candidates = await this.store.listExpiredChildHistory(cutoff);
		let archived = 0;
		let deleted = 0;
		let retained = 0;
		for (const candidate of candidates) {
			await this.#inLane(candidate.agentInstanceId, async () => {
				let localDeleted = false;
				const binding = await this.store.getBinding(candidate.agentInstanceId);
				const attempt = await this.store.getAttempt(candidate.attemptId);
				if (
					binding?.attemptId !== candidate.attemptId ||
					binding.sessionFile !== candidate.sessionFile ||
					!attempt ||
					attempt.updated_at > cutoff ||
					!["completed", "cancelled", "failed", "interrupted"].includes(attempt.state)
				)
					return;
				try {
					let content: string;
					try {
						content = await this.store.sessionStorage.readText(candidate.sessionFile);
					} catch (error) {
						if (!isEnoent(error)) throw error;
						await this.store.clearBindingSession(
							candidate.agentInstanceId,
							candidate.attemptId,
							candidate.sessionFile,
						);
						return;
					}
					if (this.#childHistoryRetention === "grimoire") {
						if (!this.#archiveChildHistory) throw new Error("Grimoire child-history archive is unavailable");
						await this.#archiveChildHistory({ ...candidate, content });
						archived++;
					}
					const live = this.#bindings.get(candidate.agentInstanceId);
					if (live) await this.#terminateBinding(live, "requested");
					await this.store.sessionStorage.deleteSessionWithArtifacts(candidate.sessionFile);
					localDeleted = true;
					deleted++;
					await this.store.clearBindingSession(
						candidate.agentInstanceId,
						candidate.attemptId,
						candidate.sessionFile,
					);
				} catch (error) {
					if (!localDeleted) retained++;
					logger.warn(
						localDeleted
							? "Expired child OMP history metadata cleanup will retry"
							: "Expired child OMP history retained for retry",
						{
							agentInstanceId: candidate.agentInstanceId,
							error: error instanceof Error ? error.message : String(error),
						},
					);
				}
			});
		}
		return { expired: candidates.length, archived, deleted, retained };
	}

	compact(target: EngineTarget): Promise<Record<string, unknown>> {
		return this.#inLane(target.agentInstanceId, async () => {
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

	async drain(): Promise<void> {
		await Promise.all(this.#lanes.values());
		await Promise.all(this.#runs);
		await this.store.drain();
	}

	async dispose(options: { closeStore?: boolean } = {}): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#signalInboxWake();
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
		const sourceAttempt = await this.store.getAttempt(source.attemptId);
		if (!sourceAttempt || !TERMINAL_ATTEMPT_STATES.has(sourceAttempt.state)) {
			throw new EngineTargetError("agent_busy", `History source Attempt ${source.attemptId} is not terminal`);
		}
		if (live && (live.state === "running" || live.session.isStreaming)) {
			throw new EngineTargetError("agent_busy", `History source ${source.agentInstanceId} is busy`);
		}
		if (!source.sessionFile) throw new EngineTargetError("history_expired", "History source session is unavailable");
		if (live) await live.session.sessionManager.flushAndCheckpoint();

		const loaded = await loadSessionFile(source.sessionFile, this.store.sessionStorage);
		if (loaded.entries.length === 0 || loaded.entries[0]?.type !== "session") {
			throw new EngineTargetError("history_expired", "History source session is unavailable");
		}
		migrateToCurrentVersion(loaded.entries);
		const sourceSessionId = loaded.entries[0].id;
		const branch = activeSessionBranch(
			loaded.entries.filter((entry): entry is SessionEntry => entry.type !== "session"),
		);
		if (sourceSessionId !== edit.sourceSessionId || branch.at(-1)?.id !== edit.expectedLeafEntryId) {
			throw new EngineTargetError("stale_target", "History source session or leaf changed");
		}
		const selectedEntry = branch.find(entry => entry.id === edit.entryId);
		if (
			selectedEntry?.type !== "message" ||
			(selectedEntry.message.role !== "user" && selectedEntry.message.role !== "assistant")
		) {
			throw new EngineTargetError("stale_target", "History entry is not an active user or assistant message");
		}
		const hasPendingInbox = edit.mode === "edit" && (await this.store.listInboxItems(sourceSessionId)).length > 0;

		const sessionDir = path.join(this.#sessionRoot, engineRouteToken(request.agentInstanceId));
		const forked: NativeHistoryForkResult = await SessionManager.forkNativeHistory(
			source.sessionFile,
			request.cwd,
			edit.entryId,
			sessionDir,
			this.store.sessionStorage,
			{
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
			},
		);

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

	async #readRestoreCheckpoint(request: EngineRestoreHistoryTarget & { agentInstanceId: string }) {
		const restore = request.restoreCheckpoint;
		const prior = await this.store.getBinding(request.agentInstanceId);
		const stageDir = this.#restoreStageDir(restore.restoreId);
		let metadata: NativeRestoreStageMetadata;
		try {
			metadata = JSON.parse(await fs.readFile(path.join(stageDir, "metadata.json"), "utf8"));
			const ready = (await fs.readFile(path.join(stageDir, "ready"), "utf8")).trim();
			if (ready !== restore.contentHash) throw new Error("ready hash mismatch");
		} catch (error) {
			if (isEnoent(error)) throw new EngineTargetError("history_expired", "Restore checkpoint is unavailable");
			throw new EngineTargetError("invalid_request", "Restore checkpoint is not ready");
		}
		if (
			metadata.restoreId !== restore.restoreId ||
			metadata.agentInstanceId !== request.agentInstanceId ||
			metadata.agentInstanceRef !== request.agentInstanceRef ||
			metadata.authorityGeneration !== request.authorityGeneration ||
			metadata.contentHash !== restore.contentHash
		) {
			throw new EngineTargetError("stale_target", "Restore checkpoint authority is stale");
		}
		if (metadata.replaceBinding) {
			const expected = metadata.replaceBinding;
			if (
				!prior?.sessionFile ||
				(prior.state !== "idle" && prior.state !== "released") ||
				prior.bindingId !== expected.bindingId ||
				prior.bindingGeneration !== expected.bindingGeneration ||
				prior.authorityGeneration !== expected.authorityGeneration ||
				prior.executionId !== expected.executionId ||
				prior.attemptId !== expected.attemptId ||
				prior.sessionFile !== expected.sessionFile
			) {
				throw new EngineTargetError("stale_target", "Restore target binding changed after staging");
			}
			const live = this.#bindings.get(request.agentInstanceId);
			if (
				live &&
				(live.bindingId !== expected.bindingId ||
					live.bindingGeneration !== expected.bindingGeneration ||
					live.attemptId !== expected.attemptId ||
					live.executionId !== expected.executionId ||
					live.authorityGeneration !== expected.authorityGeneration ||
					live.sessionFile !== expected.sessionFile ||
					live.state !== "idle" ||
					live.session.isStreaming)
			) {
				throw new EngineTargetError("stale_target", "Restore target live binding changed after staging");
			}
		} else if (prior?.sessionFile) {
			throw new EngineTargetError("stale_target", "Restore target already has a native session");
		}
		const bytes = await fs.readFile(path.join(stageDir, "checkpoint.bin"));
		if (bytes.byteLength !== metadata.totalBytes) {
			throw new EngineTargetError("history_expired", "Restore checkpoint is incomplete");
		}
		const hash = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
		if (hash !== restore.contentHash) throw new EngineTargetError("history_expired", "Restore checkpoint changed");
		const checkpoint = parseNativeSessionCheckpoint(bytes);
		return { checkpoint, stageDir };
	}

	async #prepareRestoreStart(request: EngineStartRequest): Promise<PreparedRestoreStart | undefined> {
		if (!request.restoreCheckpoint) return undefined;
		if (!request.agentInstanceRef) {
			throw new EngineTargetError("invalid_request", "Restored start requires agentInstanceRef");
		}
		const { checkpoint, stageDir } = await this.#readRestoreCheckpoint({
			agentInstanceId: request.agentInstanceId,
			agentInstanceRef: request.agentInstanceRef,
			authorityGeneration: request.authorityGeneration,
			restoreCheckpoint: request.restoreCheckpoint,
		});
		const materialized = path.join(stageDir, "source.jsonl");
		const artifactsDir = materialized.slice(0, -".jsonl".length);
		await fs.rm(artifactsDir, { recursive: true, force: true });
		await this.store.sessionStorage.writeText(
			materialized,
			new TextDecoder("utf-8", { fatal: true }).decode(
				decodeCanonicalBase64(checkpoint.sessionJsonlBase64, "Session JSONL"),
			),
		);
		let sessionManager: SessionManager;
		try {
			if (checkpoint.artifacts.length > 0) await fs.mkdir(artifactsDir, { recursive: true });
			for (const artifact of checkpoint.artifacts) {
				await fs.writeFile(
					path.join(artifactsDir, artifact.name),
					decodeCanonicalBase64(artifact.contentBase64, "Artifact"),
				);
			}
			const loaded = await loadSessionFile(materialized, this.store.sessionStorage);
			if (loaded.entries[0]?.type !== "session" || loaded.entries[0].id !== checkpoint.sessionId) {
				throw new EngineTargetError("history_expired", "Restore checkpoint native session is invalid");
			}
			const sessionDir = path.join(this.#sessionRoot, engineRouteToken(request.agentInstanceId));
			sessionManager = await SessionManager.forkFrom(
				materialized,
				request.cwd,
				sessionDir,
				this.store.sessionStorage,
				{ copyArtifacts: true, suppressBreadcrumb: true },
			);
		} finally {
			await this.store.sessionStorage.unlink(materialized).catch(error => {
				if (!isEnoent(error)) throw error;
			});
			await fs.rm(artifactsDir, { recursive: true, force: true });
		}
		return { sessionManager, stageDir };
	}

	#restoreStageDir(restoreId: string): string {
		return path.join(this.#sessionRoot, ".restore", restoreId);
	}

	#sessionArchiveSnapshotDir(agentInstanceId: string): string {
		return path.join(this.#sessionRoot, ".archive", engineRouteToken(agentInstanceId));
	}

	async #startInLane(
		request: EngineStartRequest,
		profile: EngineLaunchProfile,
		pendingStartSignal: AbortSignal,
	): Promise<EngineStartResult> {
		this.#throwIfDisposed();
		let binding = this.#bindings.get(request.agentInstanceId);
		if (binding) {
			if (binding.attemptId === request.attemptId) {
				if (binding.executionId === request.executionId) {
					if (binding.authorityGeneration !== request.authorityGeneration) {
						throw new EngineTargetError("stale_target", `Stale authority for ${request.agentInstanceId}`);
					}
					return { ...this.#snapshot(binding), duplicate: true };
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
			) {
				throw new EngineTargetError("invalid_request", `Attempt ${request.attemptId} is already bound`);
			}
			const durableBinding = await this.store.getBinding(request.agentInstanceId);
			if (
				durableBinding?.attemptId === request.attemptId &&
				durableBinding.executionId === request.executionId &&
				durableBinding.authorityGeneration === request.authorityGeneration
			) {
				return { ...durableBinding, duplicate: true };
			}
			throw new EngineTargetError(
				"too_late",
				`Attempt ${request.attemptId} already exists in state ${priorAttempt.state}`,
			);
		}
		const queuedItem = request.queueId ? await this.store.getInboxItemByQueueId(request.queueId) : undefined;
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
				!queuedItem.wakeIntent ||
				(queuedItem.wakeDeliveredAt === undefined && !exactHeldQueueStart))
		) {
			throw new EngineTargetError(
				"stale_target",
				`Inbox item ${request.queueId} is no longer pending at that wake revision`,
			);
		}
		if (binding && queuedItem && queuedItem.sessionId !== binding.session.sessionId) {
			throw new EngineTargetError("stale_target", `Inbox item ${queuedItem.queueId} belongs to another session`);
		}
		if (binding && (binding.state === "running" || binding.session.isStreaming)) {
			throw new EngineTargetError("agent_busy", `AgentInstance ${request.agentInstanceId} is busy`);
		}
		const continuationDigest = await this.#continuationDigest(request, profile);
		const conversationIdentityDigest = await this.#conversationIdentityDigest(request);
		if (binding) this.#assertManualHoldClear(binding, request.expectedIntentRevision);
		const preparedHistory = await this.#prepareHistoryStart(request);
		const preparedRestore = await this.#prepareRestoreStart(request);
		const preparedSession = preparedHistory?.sessionManager ?? preparedRestore?.sessionManager;

		if (binding) {
			if (binding.state === "running" || binding.session.isStreaming) {
				throw new EngineTargetError("agent_busy", `AgentInstance ${request.agentInstanceId} is busy`);
			}
			if (
				preparedSession ||
				profile.continuationPolicy === "fresh" ||
				binding.profileDigest !== continuationDigest
			) {
				try {
					await this.#terminateBinding(binding, "requested");
				} catch (error) {
					if (!preparedSession) throw error;
					try {
						await this.#discardPreparedSession(preparedSession);
					} catch (cleanupError) {
						throw new AggregateError([error, cleanupError], "History binding release and cleanup failed");
					}
					throw error;
				}
				binding = undefined;
			} else {
				binding.pauseGate.resume();
				binding.executionId = request.executionId;
				binding.attemptId = request.attemptId;
				binding.commandId = request.commandId;
				binding.authorityGeneration = request.authorityGeneration;
				binding.attemptState = "accepted";
				binding.state = "idle";
				binding.steerCommandIds = [];
				binding.steerCommandSet.clear();
				binding.activeToolCallIds.clear();
				binding.traceTools.clear();
				binding.traceWriteTail = Promise.resolve();
				binding.modelCallSequence = 0;
				this.#resetAssistantStream(binding);
				binding.assistantMessageSequence = 0;
				binding.lastAssistantMessageId = undefined;
				binding.activeModelCalls.clear();
				binding.pauseCommandIds.clear();
				binding.pauseRequests.clear();
				binding.resumeCommandIds.clear();
				binding.session.setAttemptId(request.attemptId);
			}
		}
		if (!binding)
			binding = await this.#openBinding(
				request,
				profile,
				continuationDigest,
				conversationIdentityDigest,
				preparedSession,
				pendingStartSignal,
			);
		if (preparedHistory?.pendingInboxSourceSessionId) {
			binding.pendingInboxSourceSessionId = preparedHistory.pendingInboxSourceSessionId;
		}
		if (
			queuedItem &&
			queuedItem.sessionId !== binding.session.sessionId &&
			queuedItem.sessionId !== binding.previousInboxSessionId
		) {
			await this.#discardBinding(binding);
			throw new EngineTargetError("stale_target", `Inbox item ${queuedItem.queueId} belongs to another session`);
		}
		let previousIntent = this.#intentState(binding);
		try {
			const holdPendingInbox = preparedHistory?.pendingInboxSourceSessionId !== undefined;
			previousIntent = this.#setManualHold(
				binding,
				request.commandId,
				request.expectedIntentRevision,
				holdPendingInbox,
				!holdPendingInbox,
			);
			binding.state = "running";
			binding.attemptState = "running";
			const result = {
				...this.#controlResult(
					binding,
					queuedItem ? "consumed" : "applied",
					queuedItem ? { ...queuedItem, revision: queuedItem.revision + 1 } : undefined,
				),
				...(preparedHistory ? { historyEdit: preparedHistory.result } : {}),
			};
			await this.#commitAttemptTransition(binding, "running", [{ kind: "accepted" }, { kind: "running" }], {
				settleCommandId: request.commandId,
				settleCommandReceipt: { outcome: "applied", detail: result },
				requireNew: true,
				inboxSessionId: binding.session.sessionId,
				...(queuedItem
					? {
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
			delete binding.previousInboxSessionId;
			delete binding.pendingInboxSourceSessionId;
			delete binding.uncommittedForkSessionFile;
		} catch (error) {
			this.#restoreIntent(binding, previousIntent);
			try {
				await this.#discardBinding(binding);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Engine admission and cleanup failed");
			}
			if (error instanceof EngineAttemptConflictError) {
				throw new EngineTargetError("invalid_request", `Attempt ${request.attemptId} was claimed concurrently`);
			}
			if (error instanceof EngineInboxConflictError) {
				throw new EngineTargetError("stale_target", error.message);
			}
			throw error;
		}
		if (preparedRestore) {
			await fs.rm(preparedRestore.stageDir, { recursive: true, force: true }).catch(error => {
				logger.warn("Committed native restore stage cleanup failed", {
					restoreId: request.restoreCheckpoint?.restoreId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
		this.#trackRun(
			this.#runPrompt(
				binding,
				preparedHistory?.dispatchInput ?? queuedItem?.deliveryPayload ?? request.input!,
				{
					sourceCommandId: request.commandId,
					...(request.clientMessageId
						? { clientMessageId: request.clientMessageId }
						: queuedItem?.sourceType === "user"
							? { clientMessageId: queuedItem.sourceEventId }
							: {}),
				},
				preparedHistory?.dispatchKind,
				request.context,
			),
		);
		this.#signalInboxWake();
		return {
			...this.#snapshot(binding),
			duplicate: false,
			...(preparedHistory ? { historyEdit: preparedHistory.result } : {}),
			...(queuedItem ? { queueId: queuedItem.queueId, queueRevision: queuedItem.revision + 1 } : {}),
		};
	}

	async #discardPreparedSession(sessionManager: SessionManager): Promise<void> {
		const sessionFile = sessionManager.getSessionFile();
		sessionManager.seal();
		const errors: unknown[] = [];
		await collectFailure(errors, () => sessionManager.close());
		if (sessionFile) {
			await collectFailure(errors, () => this.store.sessionStorage.deleteSessionWithArtifacts(sessionFile));
		}
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
				await Promise.race([Bun.sleep(Math.max(0, dueAt - Date.now())), signal]);
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

	async #openBinding(
		request: EngineStartRequest,
		profile: EngineLaunchProfile,
		continuationDigest: string,
		conversationIdentityDigest: string,
		preparedSessionManager?: SessionManager,
		pendingStartSignal?: AbortSignal,
	): Promise<LiveBinding> {
		let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
		let unsubscribeCreated: (() => void) | undefined;
		let sessionManager = preparedSessionManager;
		let uncommittedForkSessionFile = preparedSessionManager?.getSessionFile();
		let disposeResolved: (() => void) | undefined;
		let mcpManager: MCPManager | undefined;
		try {
			if (preparedSessionManager && !uncommittedForkSessionFile)
				throw new Error("Prepared session was not durably materialized");
			pendingStartSignal?.throwIfAborted();
			const resolved = await this.#resolveSessionProfile?.(profile, request.cwd, pendingStartSignal);
			disposeResolved = resolved?.dispose;
			pendingStartSignal?.throwIfAborted();
			const prior = await this.store.getBinding(request.agentInstanceId);
			const profileDigest = continuationDigest;
			const bindingGeneration = (prior?.bindingGeneration ?? 0) + 1;
			const route = engineRouteToken(request.agentInstanceId);
			const sessionDir = path.join(this.#sessionRoot, route);
			let previousInboxSessionId: string | undefined;
			if (
				!preparedSessionManager &&
				prior?.sessionFile &&
				prior.profileDigest === profileDigest &&
				profile.continuationPolicy !== "fresh"
			) {
				sessionManager = await SessionManager.open(prior.sessionFile, sessionDir, this.store.sessionStorage, {
					initialCwd: request.cwd,
				});
			} else if (!preparedSessionManager) {
				previousInboxSessionId = prior?.sessionFile
					? await this.#conversationCarrySource(prior, request, profile, conversationIdentityDigest)
					: undefined;
				if (prior?.sessionFile && previousInboxSessionId) {
					// A profile/dependency change needs a fresh AgentSession so none of the old
					// model, tools, settings, or admission policy survives. Fork only the durable
					// conversation branch, then rebuild the runtime from the newly resolved profile.
					sessionManager = await SessionManager.forkFrom(
						prior.sessionFile,
						request.cwd,
						sessionDir,
						this.store.sessionStorage,
					);
					uncommittedForkSessionFile = sessionManager.getSessionFile();
					if (!uncommittedForkSessionFile) throw new Error("Carried AgentSession was not durably materialized");
					// Workspace roots are executable authority, not conversation history. The
					// new profile/settings snapshot repopulates its own roots during session setup.
					await sessionManager.setAdditionalDirectories([]);
				} else {
					sessionManager = SessionManager.create(request.cwd, sessionDir, this.store.sessionStorage);
				}
			}
			const id = engineAgentId(request.agentInstanceId);
			const pauseGate = new AgentPauseGate();
			let liveBinding: LiveBinding | undefined;
			const toolExecutionHook: ToolExecutionHook = {
				before: (call, signal) => {
					if (!liveBinding) throw new Error("Engine tool boundary is not bound to its AgentSession");
					return this.#beforeToolExecution(liveBinding, profile, call, signal);
				},
				after: (call, token, outcome) => this.#afterToolExecution(token, call, outcome),
			};
			const childProfiles = resolved?.childProfiles ?? [];
			const childProfileRefs = profile.childProfileRefs ?? [];
			const maxChildren = profile.maxChildren ?? 0;
			const engineChildLauncher =
				this.#launchChild &&
				request.agentInstanceRef &&
				profile.spawns === "*" &&
				(profile.maxSpawnDepth ?? 0) > 0 &&
				maxChildren > 0 &&
				childProfiles.length > 0 &&
				childProfileRefs.length > 0
					? {
							parentAgentInstanceRef: request.agentInstanceRef,
							profiles: childProfiles,
							launch: async (child: {
								profileRef: string;
								workStepId: string;
								toolCallId: string;
								signal?: AbortSignal;
							}) => {
								const parent = liveBinding;
								if (!parent) throw new Error("Engine child launcher is not bound to its parent Attempt");
								if (
									!childProfileRefs.includes(child.profileRef) ||
									!childProfiles.some(candidate => candidate.profileRef === child.profileRef)
								) {
									throw new Error(`AgentProfile ${child.profileRef} is outside the pinned child catalog`);
								}
								if (parent.childLaunchCount >= maxChildren) {
									throw new Error(`AgentProfile maxChildren ceiling (${maxChildren}) reached`);
								}
								parent.childLaunchCount++;
								return await this.#launchChild!({
									...child,
									parentAgentInstanceId: parent.agentInstanceId,
									parentAgentInstanceRef: request.agentInstanceRef!,
									parentAttemptId: parent.attemptId,
									cwd: request.cwd,
									maxSpawnDepth: Math.max(0, (profile.maxSpawnDepth ?? 0) - 1),
								});
							},
						}
					: undefined;
			const engineHistory = await this.#retainedDirectChildHistory(request, profile, prior);
			const sessionOptions: CreateAgentSessionOptions = {
				...this.#sessionDefaults,
				cwd: request.cwd,
				sessionManager,
				systemPrompt: profile.systemPrompt
					? defaultPrompt => [...defaultPrompt, profile.systemPrompt as string]
					: undefined,
				providerPromptCacheKey: profile.providerPromptCacheKey,
				spawns: profile.spawns,
				toolNames: profile.toolNames,
				restrictToolNames: profile.restrictToolNames,
				enableMCP: profile.enableMCP,
				enableLsp: profile.enableLsp,
				outputSchema: profile.outputSchema,
				requireYieldTool: profile.requireYieldTool,
				...resolved?.options,
				providerRequestHook: createProviderRetryBudgetHook(
					resolved?.options.providerRequestHook ?? this.#sessionDefaults?.providerRequestHook,
				),
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
				engineChildLauncher,
				engineInbox: {
					invoke: request => {
						if (!liveBinding) throw new Error("Engine inbox is not bound to its AgentSession");
						return this.#invokeEngineInbox(liveBinding, request);
					},
				},
				engineHistory,
				agentId: id,
				agentDisplayName: request.agentInstanceId,
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
					sameModelRouteFallback: resolved?.sameModelRouteFallback,
				},
				pauseGate,
				parentAgentId: request.parentAgentInstanceId ? engineAgentId(request.parentAgentInstanceId) : undefined,
				engineMode: true,
				expectedAgentRef: null,
			};
			if (this.#mcpServer) {
				// A hosted session never inherits an ambient manager, including from a profile.
				sessionOptions.mcpManager = undefined;
				if (sessionOptions.enableMCP !== false && sessionOptions.restrictToolNames !== true) {
					mcpManager = new MCPManager(request.cwd, null);
					const ready = Promise.withResolvers<void>();
					await Promise.all([
						ready.promise,
						mcpManager.connectServers({ grimoire_engine: this.#mcpServer }, {}, event => {
							if (event.type === "connected") ready.resolve();
							if (event.type === "failed") ready.reject(new Error("Hosted Core MCP binding failed"));
						}),
					]);
					sessionOptions.mcpManager = mcpManager;
				}
			}
			created = await createAgentSession(sessionOptions);
			if (mcpManager) {
				const session = created.session;
				await session.refreshMCPTools(mcpManager.getTools());
				mcpManager.setOnToolsChanged(async tools => {
					if (session.isDisposed) return;
					await session.refreshMCPTools(tools).catch(() => {
						logger.error("Hosted Core MCP catalog refresh failed");
					});
				});
			}

			const binding: LiveBinding = {
				bindingId: `${route}:${bindingGeneration}`,
				commandId: request.commandId,
				agentInstanceId: request.agentInstanceId,
				executionId: request.executionId,
				attemptId: request.attemptId,
				engineAgentId: id,
				sessionFile: created.session.sessionFile,
				profileDigest,
				conversationIdentityDigest,
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
				disposeProfile: resolved?.dispose ?? (() => {}),
				requireYieldTool: profile.requireYieldTool === true,
				pauseGate,
				activeToolCallIds: new Set(),
				pauseProgress: Promise.withResolvers<void>(),
				pauseCommandIds: new Set(),
				pauseRequests: new Map(),
				resumeCommandIds: new Set(),
				traceWriteTail: Promise.resolve(),
				traceTools: new Map(),
				childLaunchCount: 0,
				modelCallSequence: 0,
				assistantMessageSequence: 0,
				activeModelCalls: new Set(),
			};
			liveBinding = binding;
			created.setToolUIContext(
				{
					...noOpUIContext,
					askDialog: (questions, dialogOptions) => this.#requestInput(binding, questions, dialogOptions?.signal),
				},
				true,
			);
			binding.unsubscribe = created.session.subscribe(event => {
				if (event.type === "message_start" && event.message.role === "assistant") {
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
				if (event.type === "agent_end" && event.isTerminal !== false && binding.state === "running") {
					this.agentRegistry.setStatus(binding.engineAgentId, "idle", binding.session);
				}
			});
			unsubscribeCreated = binding.unsubscribe;
			this.#bindings.set(request.agentInstanceId, binding);
			return binding;
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			if (unsubscribeCreated) await collectFailure(cleanupErrors, unsubscribeCreated);
			const createdSession = created?.session;
			if (createdSession) await collectFailure(cleanupErrors, () => createdSession.dispose());
			const createdMcpManager = mcpManager;
			if (createdMcpManager) await collectFailure(cleanupErrors, () => createdMcpManager.disconnectAll());
			if (uncommittedForkSessionFile && sessionManager) {
				const forkSessionManager = sessionManager;
				const forkSessionFile = uncommittedForkSessionFile;
				forkSessionManager.seal();
				await collectFailure(cleanupErrors, () => forkSessionManager.close());
				await collectFailure(cleanupErrors, () =>
					this.store.sessionStorage.deleteSessionWithArtifacts(forkSessionFile),
				);
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
		profile: EngineLaunchProfile,
		prior: EngineBindingSnapshot | undefined,
	) {
		const parentTaskRef = taskRefFromAgentInstanceRef(request.agentInstanceRef);
		if (
			!prior?.sessionFile ||
			profile.continuationPolicy === "fresh" ||
			prior.authorityGeneration !== request.authorityGeneration ||
			!parentTaskRef
		) {
			return undefined;
		}
		const canonicalCwd = await canonicalWorkspacePath(request.cwd);
		const refs: Array<{ id: string; parentId: string; sessionFile: string }> = [];
		for (const child of await this.store.listRetainedDirectChildHistory(request.agentInstanceId)) {
			if (taskRefFromAgentInstanceRef(child.agentInstanceRef) !== parentTaskRef) continue;
			if (child.engineAgentId !== engineAgentId(child.agentInstanceId)) continue;
			const loaded = await loadSessionFile(child.sessionFile, this.store.sessionStorage);
			const header = loaded.entries[0];
			if (header?.type !== "session" || typeof header.cwd !== "string") continue;
			if ((await canonicalWorkspacePath(header.cwd)) !== canonicalCwd) continue;
			refs.push({
				id: child.engineAgentId,
				parentId: engineAgentId(request.agentInstanceId),
				sessionFile: child.sessionFile,
			});
		}
		return refs.length > 0 ? { refs, storage: this.store.sessionStorage } : undefined;
	}

	async #continuationDigest(request: EngineStartRequest, profile: EngineLaunchProfile): Promise<string> {
		if (
			profile.continuationPolicy !== undefined &&
			profile.continuationPolicy !== "exact" &&
			profile.continuationPolicy !== "fresh"
		) {
			throw new EngineTargetError("invalid_request", "continuationPolicy must be exact or fresh");
		}
		if (this.#resolveSessionProfile && !this.#resolveSessionContinuation) {
			throw new Error("Engine session profile resolution requires an exact continuation dependency digest");
		}
		const canonicalCwd = await canonicalWorkspacePath(request.cwd);
		return sessionProfileDigest({
			agentInstanceId: request.agentInstanceId,
			agentInstanceRef: request.agentInstanceRef,
			parentAgentInstanceId: request.parentAgentInstanceId,
			authorityGeneration: request.authorityGeneration,
			canonicalCwd,
			continuationPolicy: profile.continuationPolicy ?? "exact",
			profile,
			dependencyDigest: await this.#resolveSessionContinuation?.(profile, request.cwd),
			sessionDefaults: sessionClosure(this.#sessionDefaults),
		});
	}

	async #conversationCarrySource(
		prior: EngineBindingSnapshot,
		request: EngineStartRequest,
		profile: EngineLaunchProfile,
		conversationIdentityDigest: string,
	): Promise<string | undefined> {
		if (!prior.sessionFile || profile.continuationPolicy === "fresh") return undefined;
		if (prior.authorityGeneration !== request.authorityGeneration) return undefined;
		const storedDigest = await this.store.getBindingConversationIdentity(request.agentInstanceId);
		if (storedDigest !== conversationIdentityDigest) {
			if (storedDigest) return undefined;
			// Upgrade compatibility for bindings created before the conversation digest
			// column existed. The admitted start retains the same durable identity tuple.
			const identity = await this.store.getStartConversationIdentity(prior.commandId);
			if (
				identity?.operation !== "start" ||
				identity.agentInstanceId !== request.agentInstanceId ||
				identity.agentInstanceRef !== request.agentInstanceRef ||
				identity.parentAgentInstanceId !== request.parentAgentInstanceId ||
				identity.authorityGeneration !== request.authorityGeneration
			) {
				return undefined;
			}
		}
		let loaded: SessionLoadResult;
		try {
			loaded = await loadSessionFile(prior.sessionFile, this.store.sessionStorage);
		} catch (error) {
			throw new Error("Retained AgentSession conversation could not be loaded", { cause: error });
		}
		const header = loaded?.entries[0];
		if (header?.type !== "session" || typeof header.cwd !== "string") {
			throw new Error("Retained AgentSession conversation is missing or invalid");
		}
		if ((await canonicalWorkspacePath(header.cwd)) !== (await canonicalWorkspacePath(request.cwd))) return undefined;
		return header.id;
	}

	async #conversationIdentityDigest(request: EngineStartRequest): Promise<string> {
		return sessionProfileDigest({
			agentInstanceId: request.agentInstanceId,
			agentInstanceRef: request.agentInstanceRef,
			parentAgentInstanceId: request.parentAgentInstanceId,
			authorityGeneration: request.authorityGeneration,
			canonicalCwd: await canonicalWorkspacePath(request.cwd),
		});
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
		profile: EngineLaunchProfile,
		call: ToolExecutionHookCall,
		signal?: AbortSignal,
	): Promise<ToolExecutionHookToken | undefined> {
		const policy = profile.toolPolicies?.[call.toolName] ?? "unrestricted";
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
			target: this.#snapshot(binding),
			done: done.promise,
			resolveDone: done.resolve,
			settled: false,
		};
		this.#toolInvocations.set(invocationId, record);
		if (policy === "permit") return await this.#requestToolApproval(record, signal);
		try {
			const event = await this.store.startToolEffect(record.target, this.#toolEffect(record));
			this.#notifyEvents([event]);
			return { invocationId };
		} catch (error) {
			this.#toolInvocations.delete(invocationId);
			record.resolveDone();
			throw error;
		}
	}

	async #requestToolApproval(record: ToolInvocationRecord, signal?: AbortSignal): Promise<ToolExecutionHookToken> {
		signal?.throwIfAborted();
		const completion = Promise.withResolvers<{
			decision: "approve" | "deny" | "cancelled";
			reason?: string;
			causationCommandId?: string;
		}>();
		const pending: PendingToolApproval = { record, resolve: completion.resolve };
		this.#pendingToolApprovals.set(record.invocationId, pending);
		try {
			const event = await this.store.requestToolApproval(record.target, this.#toolEffect(record));
			this.#notifyEvents([event]);
		} catch (error) {
			this.#pendingToolApprovals.delete(record.invocationId);
			this.#toolInvocations.delete(record.invocationId);
			record.resolveDone();
			throw error;
		}
		const abort = () => {
			if (this.#pendingToolApprovals.get(record.invocationId) !== pending) return;
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
		if (jobs.length === 0) {
			this.#completeToolInvocation(record, outcome.isError ? "failed" : "completed", outcome.error);
			return;
		}
		void Promise.all(jobs.map(job => job.promise)).then(() => {
			const failed = jobs.find(job => job.status === "failed");
			const cancelled = jobs.find(job => job.status === "cancelled");
			const status = outcome.isError || failed ? "failed" : cancelled ? "cancelled" : "completed";
			this.#completeToolInvocation(
				record,
				status,
				outcome.error ?? failed?.errorText,
				jobs.map(job => job.id),
			);
		});
	}

	#completeToolInvocation(
		record: ToolInvocationRecord,
		status: "completed" | "failed" | "cancelled",
		error?: string,
		jobIds?: string[],
	): void {
		if (record.settled) return;
		record.settled = true;
		void this.store
			.settleToolEffect(record.target, record.invocationId, status, {
				...(error ? { error: error.slice(0, 2_048) } : {}),
				...(jobIds?.length ? { jobIds } : {}),
			})
			.then(event => {
				this.#notifyEvents([event]);
				this.#toolInvocations.delete(record.invocationId);
				record.resolveDone();
			})
			.catch(error => {
				record.settled = false;
				logger.warn("Engine tool effect settlement failed", {
					invocationId: record.invocationId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	#toolEffect(record: ToolInvocationRecord): EngineToolEffectInput {
		return {
			effectId: record.invocationId,
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			policy: record.policy,
			inputHash: record.inputHash,
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
		const events = await this.store.resolveToolApproval(pending.record.target, approvalId, "cancelled", {
			reason: reason.slice(0, 2_048),
			causationCommandId,
		});
		this.#notifyEvents(events);
		if (this.#pendingToolApprovals.get(approvalId) !== pending) return;
		this.#pendingToolApprovals.delete(approvalId);
		pending.resolve({ decision: "cancelled", reason, causationCommandId });
	}

	/** Cancel an Engine child when its parent task call is aborted. */
	async cancelAgentInstance(agentInstanceId: string, reason: string): Promise<void> {
		const binding = this.#bindings.get(agentInstanceId);
		if (
			binding?.attemptState !== "running" &&
			binding?.attemptState !== "pause_requested" &&
			binding?.attemptState !== "paused" &&
			binding?.attemptState !== "waiting_input"
		) {
			return;
		}
		// The start command owns the Attempt terminal event, including parent-driven cancellation.
		await this.cancel({ ...this.#snapshot(binding), commandId: binding.commandId, reason });
	}

	async #finishPause(binding: LiveBinding, attemptId: string): Promise<void> {
		await binding.pauseGate.waitUntilParked();
		while (binding.activeToolCallIds.size > 0 && binding.attemptState === "pause_requested") {
			const progress = binding.pauseProgress.promise;
			if (binding.activeToolCallIds.size > 0) await progress;
		}
		const transcriptCheckpoint = await binding.session.sessionManager.flushAndCheckpoint();
		await this.#inLane(binding.agentInstanceId, async () => {
			if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
			if (binding.attemptId !== attemptId || binding.attemptState !== "pause_requested") return;
			const events = [...binding.pauseRequests].map(([commandId, initiator]) => ({
				kind: "paused" as const,
				payload: controlPayload(initiator, "paused", false, binding),
				causationCommandId: commandId,
			}));
			await this.#commitAttemptTransition(binding, "paused", events, {
				expectedStates: ["pause_requested"],
				transcriptCheckpoint,
			});
			binding.attemptState = "paused";
			binding.pauseRequests.clear();
		});
	}

	#notifyPauseProgress(binding: LiveBinding): void {
		binding.pauseProgress.resolve();
		binding.pauseProgress = Promise.withResolvers<void>();
	}

	async #dispatchModel(
		binding: LiveBinding,
		input: string,
		identity?: SessionMessageIdentity,
		kind: HistoryDispatchKind = "prompt",
	): Promise<boolean> {
		const completed = Promise.withResolvers<void>();
		binding.activeModelCalls.add(completed.promise);
		const modelCallId = `model-${++binding.modelCallSequence}`;
		const inputHash = sha256(input);
		const effect: EngineModelEffectInput = {
			effectId: `model_${sha256(`${binding.bindingId}\0${binding.attemptId}\0${modelCallId}`).slice(0, 32)}`,
			modelCallId,
			inputHash,
		};
		try {
			const started = await this.store.startModelEffect(this.#snapshot(binding), effect);
			this.#notifyEvents([started]);
			const previous = binding.session.getLastAssistantMessage();
			let dispatched: boolean;
			try {
				dispatched = await withProviderObservationContext(effect, () =>
					this.#withSessionScope(binding, () => this.#dispatchPrompt(binding.session, input, identity, kind)),
				);
				const current = binding.session.getLastAssistantMessage();
				if (current !== previous && current?.stopReason === "error") {
					throw new Error(current.errorMessage?.trim() || "Model request failed");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const settled = await this.store.settleModelEffect(
					this.#snapshot(binding),
					effect,
					"failed",
					message.slice(0, 2_048),
				);
				this.#notifyEvents([settled]);
				throw error;
			}
			const settled = await this.store.settleModelEffect(this.#snapshot(binding), effect, "completed");
			this.#notifyEvents([settled]);
			return dispatched;
		} finally {
			completed.resolve();
			binding.activeModelCalls.delete(completed.promise);
			await binding.pauseGate.waitUntilResumed();
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

	async #sendCommandContext(binding: LiveBinding, context: string | undefined, commandId: string): Promise<void> {
		if (!context) return;
		await binding.session.sendCustomMessage(
			{
				customType: "engine-command-context",
				content: context,
				display: false,
				details: { sourceCommandId: commandId },
			},
			{ triggerTurn: false },
		);
	}

	async #runPrompt(
		binding: LiveBinding,
		input: string,
		identity?: SessionMessageIdentity,
		kind: HistoryDispatchKind = "prompt",
		context?: string,
	): Promise<void> {
		const attemptId = binding.attemptId;
		const attemptMessageStart = binding.session.messages.length;
		try {
			await this.#sendCommandContext(binding, context, identity?.sourceCommandId ?? binding.commandId);
			await this.#dispatchModel(binding, input, identity, kind);
			for (let reminder = 0; reminder < 2 && binding.requireYieldTool; reminder++) {
				await binding.pauseGate.waitUntilResumed();
				if (
					terminalYield(binding.session.messages, attemptMessageStart).found ||
					binding.attemptState !== "running"
				)
					break;
				await this.#dispatchModel(
					binding,
					"Your previous response was not submitted. Call the yield tool now with the complete output object in result.data. Do not answer with text.",
				);
			}
			await this.#waitForAttemptQuiescence(binding, attemptId);
			if (binding.requireYieldTool && !terminalYield(binding.session.messages, attemptMessageStart).found) {
				throw new Error("required_yield_not_submitted");
			}
			await this.#settleAttempt(binding, attemptId, attemptMessageStart, "completed");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.#settleAttempt(binding, attemptId, attemptMessageStart, "failed", message);
		}
	}

	async #settleAttempt(
		binding: LiveBinding,
		attemptId: string,
		attemptMessageStart: number,
		state: "completed" | "failed",
		cause?: string,
	): Promise<void> {
		await binding.traceWriteTail;
		if (binding.retryWriteError) {
			const error = new Error("Engine retry state could not be persisted", { cause: binding.retryWriteError });
			binding.retryWriteError = undefined;
			if (state === "completed") throw error;
			cause = error.message;
		}
		for (;;) {
			await binding.pauseGate.waitUntilResumed();
			const retry = await this.#inLane(binding.agentInstanceId, async () => {
				if (this.#bindings.get(binding.agentInstanceId) !== binding || binding.attemptId !== attemptId)
					return false;
				if (binding.attemptState === "pause_requested" || binding.attemptState === "paused") return true;
				if (binding.attemptState !== "running") return false;
				const transcriptCheckpoint = await binding.session.sessionManager.flushAndCheckpoint();
				binding.state = "idle";
				binding.attemptState = state;
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
						{ cause, expectedStates: ["running"], transcriptCheckpoint },
					);
				} catch (error) {
					binding.state = "running";
					binding.attemptState = "running";
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
		const write = binding.traceWriteTail.then(() => this.#emit(binding, kind, payload));
		binding.traceWriteTail = write.catch(error => {
			logger.warn("Engine trace event write failed", {
				kind,
				error: error instanceof Error ? error.message : String(error),
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

	#settleAssistantStream(binding: LiveBinding, message: AssistantMessage): void {
		const state = binding.assistantStream ?? this.#beginAssistantStream(binding, message.timestamp);
		if (state.attemptId !== binding.attemptId || state.settled) return;
		const fullText = historyMessageText(message.content);
		state.text = fullText.slice(0, MAX_ASSISTANT_FINAL_CHARS);
		state.textTruncated = fullText.length > MAX_ASSISTANT_FINAL_CHARS;
		state.settled = true;
		binding.lastAssistantMessageId = state.assistantMessageId;
		binding.session.rememberMessageIdentity(message, {
			assistantMessageId: state.assistantMessageId,
		});
		if (state.text || state.streamingSnapshots > 0) {
			this.#emitAssistantSnapshot(binding, state, "settled", assistantSnapshotStopReason(message.stopReason));
		}
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
		const write = binding.traceWriteTail.then(async () => {
			let historyEntryId: string | undefined;
			if (status === "settled") {
				await binding.session.settleInFlightMessagePersistence();
				historyEntryId = binding.session.sessionManager
					.getBranch()
					.find(entry => entry.type === "message" && entry.assistantMessageId === state.assistantMessageId)?.id;
			}
			await this.#emit(binding, "assistant_snapshot", {
				...payload,
				...(historyEntryId ? { historyEntryId } : {}),
			});
		});
		binding.traceWriteTail = write.catch(error => {
			logger.warn("Engine assistant snapshot write failed", {
				status,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	#resetAssistantStream(binding: LiveBinding): void {
		binding.assistantStream = undefined;
	}

	#queueRetryEvent(
		binding: LiveBinding,
		kind: "retry_scheduled" | "retry_settled",
		retry: import("./contracts").EngineRetryState,
	): void {
		const write = binding.traceWriteTail.then(async () => {
			const event = await this.store.commitAttemptRetry(binding, retry, { kind, payload: { retry } });
			if (event) this.#notifyEvents([event]);
		});
		binding.traceWriteTail = write.catch(error => {
			binding.retryWriteError ??= error;
			logger.warn("Engine retry state write failed", {
				kind,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	async #waitForAttemptQuiescence(binding: LiveBinding, attemptId: string): Promise<void> {
		const filter = { ownerId: binding.engineAgentId, attemptId };
		for (;;) {
			await binding.pauseGate.waitUntilResumed();
			await binding.session.waitForIdle();
			await this.asyncJobManager.waitForOwnerJobs(binding.engineAgentId, { attemptId });
			await this.asyncJobManager.drainDeliveries({ filter });
			await this.#waitForToolInvocations(binding, attemptId);
			await binding.pauseGate.waitUntilResumed();
			await binding.session.waitForIdle();
			if (
				this.asyncJobManager.getRunningJobs(filter).length === 0 &&
				!this.asyncJobManager.hasPendingDeliveries(filter)
			) {
				return;
			}
		}
	}

	#completionPayload(binding: LiveBinding, attemptMessageStart: number): EngineCompletionPayload {
		const yielded = terminalYield(binding.session.messages, attemptMessageStart);
		const final = yielded.found ? JSON.stringify(yielded.data) : (binding.session.getLastAssistantText() ?? "");
		const outputTruncated = final.length > MAX_ASSISTANT_FINAL_CHARS;
		return {
			assistantFinal: outputTruncated ? `${final.slice(0, MAX_ASSISTANT_FINAL_CHARS)}\n[…truncated]` : final,
			...(!yielded.found && binding.lastAssistantMessageId
				? { assistantMessageId: binding.lastAssistantMessageId }
				: {}),
			...(binding.sessionFile ? { transcriptRef: `history://${binding.engineAgentId}` } : {}),
			...(outputTruncated ? { outputTruncated: true } : {}),
		};
	}

	async #finishCancel(binding: LiveBinding, request: EngineCancelRequest, abort: Promise<void>): Promise<void> {
		await abort.catch(() => {});
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
			const events: EngineTransitionEvent[] = [
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
				wasRunning
					? async () => {
							await Promise.all(binding.activeModelCalls);
							await this.#waitForToolInvocations(binding, binding.attemptId);
							transcriptCheckpoint = await binding.session.sessionManager.flushAndCheckpoint();
						}
					: undefined,
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
		} else if (!wasRunning) {
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
				this.store.sessionStorage.deleteSessionWithArtifacts(uncommittedForkSessionFile),
			);
		}
		throwCollectedFailures(errors, `Engine binding ${binding.agentInstanceId} admission cleanup failed`);
	}

	async #disposeBindingResources(
		binding: LiveBinding,
		reason: string,
		attemptState: EngineAttemptState,
		beforeSessionDispose?: () => Promise<void>,
	): Promise<void> {
		const errors: unknown[] = [];
		await collectFailure(errors, binding.unsubscribe);
		await collectFailure(errors, () => this.#cancelToolApprovals(binding, reason));
		await collectFailure(errors, () => this.#cancelPendingInput(binding, reason, undefined, attemptState));
		await collectFailure(errors, () =>
			this.asyncJobManager.cancelAll({ ownerId: binding.engineAgentId, attemptId: binding.attemptId }),
		);
		let abort: Promise<void> | undefined;
		await collectFailure(errors, () => {
			abort = binding.session.abort({ reason });
		});
		await collectFailure(errors, () => binding.pauseGate.resume());
		await collectFailure(errors, () => this.#notifyPauseProgress(binding));
		if (abort) await collectFailure(errors, () => abort!);
		if (beforeSessionDispose) await collectFailure(errors, beforeSessionDispose);
		await collectFailure(errors, () => binding.session.dispose());
		await collectFailure(errors, () => binding.mcpManager?.disconnectAll());
		await collectFailure(errors, binding.disposeProfile);
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
			const loaded = await loadSessionFile(binding.sessionFile, this.store.sessionStorage);
			if (loaded.entries[0]?.type === "session") sessionId = loaded.entries[0].id;
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
				const loaded = await loadSessionFile(binding.sessionFile, this.store.sessionStorage);
				if (loaded.entries[0]?.type === "session") currentSessionId = loaded.entries[0].id;
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

	#attemptMatchesTarget(attempt: EngineAttemptRecord, target: EngineTarget): boolean {
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

	async #reconcileLostAttempts(): Promise<void> {
		this.#notifyEvents(await this.store.interruptGeneration(this.engineGeneration));
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
		kind: EngineEvent["kind"],
		payload?: Record<string, unknown>,
		causationCommandId = target.commandId,
	): Promise<void> {
		const { commandId: _, ...eventTarget } = target;
		const event = await this.store.appendEvent({
			...eventTarget,
			causationCommandId,
			kind,
			payload,
		});
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
		kind: EngineEvent["kind"],
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
		events: readonly EngineTransitionEvent[],
		options: {
			cause?: string;
			settleCommandId?: string;
			settleCommandReceipt?: { outcome: "applied" | "rejected"; detail?: Record<string, unknown> };
			expectedStates?: readonly EngineAttemptState[];
			requireNew?: boolean;
			transcriptCheckpoint?: SessionDurabilityCheckpoint;
			inboxSessionId?: string;
			inboxMutation?: EngineInboxMutation;
			inboxMutationCausationCommandId?: string;
			pendingInboxSourceSessionId?: string;
		} = {},
	): Promise<void> {
		const committed = await this.store.commitAttemptTransition(this.#snapshot(binding), state, events, {
			...options,
			conversationIdentityDigest: binding.conversationIdentityDigest,
			...(binding.previousInboxSessionId ? { previousInboxSessionId: binding.previousInboxSessionId } : {}),
			...(binding.pendingInboxSourceSessionId
				? { pendingInboxSourceSessionId: binding.pendingInboxSourceSessionId }
				: {}),
		});
		this.#notifyEvents(committed);
	}

	#notifyEvents(events: readonly EngineEvent[]): void {
		for (const event of events) {
			for (const listener of this.#listeners) {
				void Promise.resolve(listener(event)).catch(() => {});
			}
		}
	}

	#snapshot(binding: LiveBinding): EngineBindingSnapshot {
		return {
			bindingId: binding.bindingId,
			commandId: binding.commandId,
			agentInstanceId: binding.agentInstanceId,
			executionId: binding.executionId,
			attemptId: binding.attemptId,
			engineAgentId: binding.engineAgentId,
			sessionFile: binding.sessionFile,
			profileDigest: binding.profileDigest,
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

	#assertManualHoldClear(binding: LiveBinding, expectedRevision: number | undefined): void {
		this.#assertIntentRevision(binding, expectedRevision);
		if (binding.manualHold && expectedRevision === undefined) {
			throw new EngineTargetError(
				"stale_target",
				`Manual hold requires expectedIntentRevision ${binding.intentRevision}`,
			);
		}
	}

	#assertIntentRevision(binding: LiveBinding, expectedRevision: number | undefined): void {
		if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
			throw new EngineTargetError("invalid_request", "expectedIntentRevision must be a non-negative safe integer");
		}
		if (expectedRevision !== undefined && expectedRevision !== binding.intentRevision) {
			throw new EngineTargetError(
				"stale_target",
				`Intent revision ${binding.intentRevision} does not match ${expectedRevision}`,
			);
		}
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
		if (this.#disposed) throw new Error("EngineRuntime is disposed");
	}
}

function activeSessionBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let entry = entries.at(-1);
	while (entry && !seen.has(entry.id)) {
		seen.add(entry.id);
		branch.push(entry);
		entry = entry.parentId ? byId.get(entry.parentId) : undefined;
	}
	return branch.reverse();
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

function historyActivityText(value: unknown): { text?: string; truncated?: boolean } {
	let raw: string;
	try {
		raw = typeof value === "string" ? value : stableStringifyJson(value);
	} catch {
		return {};
	}
	if (!raw) return {};
	return {
		text: raw.slice(0, MAX_HISTORY_ACTIVITY_CHARS),
		truncated: raw.length > MAX_HISTORY_ACTIVITY_CHARS,
	};
}

function historyActivityBlocks(sessionId: string, entryId: string, content: unknown): EngineHistoryActivityBlock[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap<EngineHistoryActivityBlock>((raw, blockIndex) => {
		if (!raw || typeof raw !== "object") return [];
		const block = raw as Record<string, unknown>;
		if (block.type === "thinking" || block.type === "redactedThinking") {
			const value = historyActivityText(
				block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "",
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
		const args = historyActivityText(block.arguments);
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
		steer: state === "running" || state === "pause_requested" || state === "paused",
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

function sha256(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
	if (typeof value !== "string") {
		throw new EngineTargetError("invalid_request", `${label} must be canonical base64`);
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) {
		throw new EngineTargetError("invalid_request", `${label} must be canonical base64`);
	}
	return bytes;
}

function parseNativeSessionCheckpoint(bytes: Buffer): NativeSessionCheckpoint {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new EngineTargetError("invalid_request", "Restore checkpoint must be valid UTF-8 JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new EngineTargetError("invalid_request", "Restore checkpoint must be an object");
	}
	const checkpoint = value as Partial<NativeSessionCheckpoint>;
	if (
		checkpoint.schema !== "grimoire.engine.native_session_checkpoint.v1" ||
		typeof checkpoint.sessionId !== "string" ||
		!checkpoint.sessionId ||
		typeof checkpoint.sessionJsonlHash !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(checkpoint.sessionJsonlHash) ||
		typeof checkpoint.sessionJsonlBase64 !== "string" ||
		!Array.isArray(checkpoint.artifacts)
	) {
		throw new EngineTargetError("invalid_request", "Restore checkpoint shape is invalid");
	}
	if (checkpoint.sessionJsonlBase64.length > Math.ceil(MAX_NATIVE_RESTORE_BYTES / 3) * 4) {
		throw new EngineTargetError("invalid_request", "Restore session JSONL is outside the accepted range");
	}
	const sessionBytes = decodeCanonicalBase64(checkpoint.sessionJsonlBase64, "Session JSONL");
	if (sessionBytes.byteLength < 1 || sessionBytes.byteLength > MAX_NATIVE_RESTORE_BYTES) {
		throw new EngineTargetError("invalid_request", "Restore session JSONL is outside the accepted range");
	}
	if (`sha256:${crypto.createHash("sha256").update(sessionBytes).digest("hex")}` !== checkpoint.sessionJsonlHash) {
		throw new EngineTargetError("invalid_request", "Restore session JSONL hash does not match");
	}
	let jsonl: string;
	try {
		jsonl = new TextDecoder("utf-8", { fatal: true }).decode(sessionBytes);
	} catch {
		throw new EngineTargetError("invalid_request", "Restore session JSONL must be valid UTF-8");
	}
	const entries = jsonl
		.split("\n")
		.filter(Boolean)
		.map(line => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				throw new EngineTargetError("invalid_request", "Restore session JSONL contains invalid JSON");
			}
		});
	const header = entries.find(entry => entry.type === "session");
	if (header?.id !== checkpoint.sessionId) {
		throw new EngineTargetError("invalid_request", "Restore session header identity does not match");
	}
	const portableNames = new Set<string>();
	let artifactBytes = 0;
	for (const artifactValue of checkpoint.artifacts) {
		if (!artifactValue || typeof artifactValue !== "object" || Array.isArray(artifactValue)) {
			throw new EngineTargetError("invalid_request", "Restore artifact shape is invalid");
		}
		const artifact = artifactValue as NativeSessionCheckpoint["artifacts"][number];
		const portableName = typeof artifact.name === "string" ? artifact.name.toLowerCase() : "";
		const portableStem = portableName.split(".", 1)[0] ?? "";
		if (
			typeof artifact.name !== "string" ||
			!/^[A-Za-z0-9_.-]+$/.test(artifact.name) ||
			artifact.name === "." ||
			artifact.name === ".." ||
			artifact.name.endsWith(".") ||
			/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(portableStem) ||
			portableNames.has(portableName) ||
			typeof artifact.contentHash !== "string" ||
			!/^sha256:[0-9a-f]{64}$/.test(artifact.contentHash) ||
			!Number.isSafeInteger(artifact.byteLength) ||
			artifact.byteLength < 0 ||
			typeof artifact.contentBase64 !== "string" ||
			artifact.byteLength > MAX_NATIVE_RESTORE_BYTES - artifactBytes ||
			artifact.contentBase64.length !== Math.ceil(artifact.byteLength / 3) * 4
		) {
			throw new EngineTargetError("invalid_request", "Restore artifact metadata is invalid");
		}
		portableNames.add(portableName);
		const content = decodeCanonicalBase64(artifact.contentBase64, `Artifact ${artifact.name}`);
		artifactBytes += content.byteLength;
		if (content.byteLength !== artifact.byteLength) {
			throw new EngineTargetError("invalid_request", "Restore artifact byte length is invalid");
		}
		if (`sha256:${crypto.createHash("sha256").update(content).digest("hex")}` !== artifact.contentHash) {
			throw new EngineTargetError("invalid_request", `Restore artifact ${artifact.name} hash does not match`);
		}
	}
	return checkpoint as NativeSessionCheckpoint;
}

function isEexist(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function sessionProfileDigest(continuation: Record<string, unknown>): string {
	return `sha256:${sha256(stableStringifyJson(continuation))}`;
}

async function canonicalWorkspacePath(cwd: string): Promise<string> {
	const canonical = await fs.realpath(cwd).catch(() => path.resolve(cwd));
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function sessionClosure(options: EngineRuntimeOptions["sessionDefaults"]): Record<string, unknown> {
	const settings = options?.settings;
	return {
		additionalDirectories: options?.additionalDirectories,
		model: options?.model
			? {
					api: options.model.api,
					baseUrl: options.model.baseUrl,
					id: options.model.id,
					provider: options.model.provider,
				}
			: undefined,
		thinkingLevel: options?.thinkingLevel,
		toolNames: options?.toolNames,
		restrictToolNames: options?.restrictToolNames,
		enableMCP: options?.enableMCP,
		enableLsp: options?.enableLsp,
		maxSpawnDepth: options?.maxSpawnDepth,
		skills: options?.skills,
		rules: options?.rules,
		contextFiles: options?.contextFiles,
		promptTemplates: options?.promptTemplates,
		slashCommands: options?.slashCommands,
		settings: settings
			? Object.fromEntries((Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(key => [key, settings.get(key)]))
			: undefined,
		extensions: "explicit-disabled",
	};
}
