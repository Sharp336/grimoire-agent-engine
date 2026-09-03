import * as crypto from "node:crypto";
import * as path from "node:path";
import { AgentPauseGate } from "@oh-my-pi/pi-agent-core";
import { logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
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
import { IrcBus, type IrcDeliveryReceipt } from "../irc/bus";
import { withLspSessionScope } from "../lsp/client";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { type SessionDurabilityCheckpoint, SessionManager } from "../session/session-manager";
import type { EngineChildLaunchResult, EngineChildProfile } from "../tools";
import {
	type EngineAttemptState,
	type EngineBindingSnapshot,
	type EngineCancelRequest,
	type EngineCompletionPayload,
	type EngineControlInitiator,
	type EngineControlRequest,
	type EngineEvent,
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
	validateStartRequest,
} from "./contracts";
import { engineAgentId, engineRouteToken } from "./route";
import {
	EngineAttemptConflictError,
	type EngineModelEffectInput,
	EngineStore,
	type EngineToolEffectInput,
	type EngineTransitionEvent,
} from "./store";

type EngineEventListener = (event: EngineEvent) => void | Promise<void>;

const MAX_ASSISTANT_FINAL_CHARS = 48_000;
const MAX_TRACE_CHARS = 48_000;
const MAX_INPUT_FIELD_CHARS = 48_000;
const MAX_INPUT_RESULT_CHARS = 128_000;

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

function terminalYield(messages: readonly { role: string; content?: unknown }[]): { found: boolean; data?: unknown } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j];
			if (!block || typeof block !== "object") continue;
			const call = block as { type?: string; name?: string; arguments?: unknown };
			if (call.type !== "toolCall" || call.name !== "yield") continue;
			const args = call.arguments;
			if (!args || typeof args !== "object" || Array.isArray(args)) return { found: false };
			const result = (args as Record<string, unknown>).result;
			if (!result || typeof result !== "object" || Array.isArray(result)) return { found: false };
			return { found: "data" in result, data: (result as Record<string, unknown>).data };
		}
	}
	return { found: false };
}

interface LiveBinding extends EngineBindingSnapshot {
	attemptState: EngineAttemptState;
	session: AgentSession;
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
	traceTools: Map<string, { name: string; summary: string; startedAt: number }>;
	childLaunchCount: number;
	modelCallSequence: number;
	activeModelCalls: Set<Promise<void>>;
	pendingInput?: PendingInput;
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

export interface EngineRuntimeOptions {
	databasePath: string;
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
	dispatchPrompt?: (session: AgentSession, input: string) => Promise<boolean>;
	resolveSessionProfile?: (
		profile: EngineLaunchProfile,
		cwd: string,
	) => Promise<{
		options: Partial<CreateAgentSessionOptions>;
		childProfiles?: EngineChildProfile[];
		dispose(): void;
	}>;
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

export class EngineRuntime {
	readonly agentRegistry = new AgentRegistry();
	readonly agentLifecycle = new AgentLifecycleManager(this.agentRegistry);
	readonly asyncJobManager = new AsyncJobManager({ requireAttemptId: true });
	readonly ircBus = new IrcBus(this.agentRegistry, this.agentLifecycle);
	readonly engineGeneration: number;
	readonly store: EngineStore;
	readonly #sessionDefaults: EngineRuntimeOptions["sessionDefaults"];
	readonly #dispatchPrompt: (session: AgentSession, input: string) => Promise<boolean>;
	readonly #resolveSessionProfile: EngineRuntimeOptions["resolveSessionProfile"];
	readonly #launchChild: EngineRuntimeOptions["launchChild"];
	readonly #bindings = new Map<string, LiveBinding>();
	readonly #lanes = new Map<string, Promise<void>>();
	readonly #runs = new Set<Promise<void>>();
	readonly #listeners = new Set<EngineEventListener>();
	readonly #toolInvocations = new Map<string, ToolInvocationRecord>();
	readonly #pendingToolApprovals = new Map<string, PendingToolApproval>();
	readonly #sessionRoot: string;
	#disposed = false;

	private constructor(store: EngineStore, engineGeneration: number, options: EngineRuntimeOptions) {
		this.store = store;
		this.engineGeneration = engineGeneration;
		this.#sessionDefaults = options.sessionDefaults;
		this.#dispatchPrompt = options.dispatchPrompt ?? ((session, input) => session.prompt(input));
		this.#resolveSessionProfile = options.resolveSessionProfile;
		this.#launchChild = options.launchChild;
		this.#sessionRoot = path.join(path.dirname(path.resolve(options.databasePath)), "engine-sessions");
	}

	static async create(options: EngineRuntimeOptions): Promise<EngineRuntime> {
		const store = await EngineStore.open(options.databasePath);
		const engineGeneration = await store.nextEngineGeneration();
		const runtime = new EngineRuntime(store, engineGeneration, options);
		await runtime.#reconcileLostAttempts();
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
		return this.#inLane(request.agentInstanceId, () => this.#startInLane(request, profile));
	}

	steer(request: EngineSteerRequest): Promise<void> {
		if (!request.commandId.trim() || !request.message.trim()) {
			throw new EngineTargetError("invalid_request", "commandId and message must be non-empty strings");
		}
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = await this.#requireCancelableTarget(request);
			if (!binding) return;
			if (binding.steerCommandSet.has(request.commandId)) return;
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
			await binding.session.steer(request.message);
			binding.steerCommandIds.push(request.commandId);
			binding.steerCommandSet.add(request.commandId);
			const evicted = binding.steerCommandIds.length > 256 ? binding.steerCommandIds.shift() : undefined;
			if (evicted) binding.steerCommandSet.delete(evicted);
			await this.#commitEvent(binding, "steered", undefined, request.commandId, request.commandId);
		});
	}

	pause(request: EngineControlRequest): Promise<void> {
		validateControlRequest(request);
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			if (binding.pauseCommandIds.has(request.commandId)) return;
			if (binding.attemptState === "paused") {
				await this.#commitEvent(
					binding,
					"paused",
					controlPayload(request.initiator, "paused", true),
					request.commandId,
					request.commandId,
				);
				binding.pauseCommandIds.add(request.commandId);
				return;
			}
			if (binding.attemptState === "pause_requested") {
				await this.#commitEvent(
					binding,
					"pause_requested",
					controlPayload(request.initiator, "pause_requested", true),
					request.commandId,
					request.commandId,
				);
				binding.pauseCommandIds.add(request.commandId);
				binding.pauseRequests.set(request.commandId, request.initiator);
				return;
			}
			if (binding.attemptState !== "running") {
				throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is already ${binding.attemptState}`);
			}
			binding.pauseGate.pause();
			binding.attemptState = "pause_requested";
			try {
				await this.#commitAttemptTransition(
					binding,
					"pause_requested",
					[
						{
							kind: "pause_requested",
							payload: controlPayload(request.initiator, "pause_requested"),
							causationCommandId: request.commandId,
						},
					],
					{ settleCommandId: request.commandId, expectedStates: ["running"] },
				);
			} catch (error) {
				binding.attemptState = "running";
				binding.pauseGate.resume();
				throw error;
			}
			binding.pauseCommandIds.add(request.commandId);
			binding.pauseRequests.set(request.commandId, request.initiator);
			this.#trackRun(this.#finishPause(binding, request.attemptId));
		});
	}

	resume(request: EngineControlRequest): Promise<void> {
		validateControlRequest(request);
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			if (binding.resumeCommandIds.has(request.commandId)) return;
			if (binding.attemptState !== "paused") {
				throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is already ${binding.attemptState}`);
			}
			binding.attemptState = "running";
			try {
				await this.#commitAttemptTransition(
					binding,
					"running",
					[
						{
							kind: "resumed",
							payload: controlPayload(request.initiator, "running"),
							causationCommandId: request.commandId,
						},
					],
					{ settleCommandId: request.commandId, expectedStates: ["paused"] },
				);
			} catch (error) {
				binding.attemptState = "paused";
				throw error;
			}
			binding.resumeCommandIds.add(request.commandId);
			binding.pauseGate.resume();
		});
	}

	cancel(request: EngineCancelRequest): Promise<void> {
		if (!request.commandId.trim()) {
			throw new EngineTargetError("invalid_request", "commandId must be a non-empty string");
		}
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			if (binding.attemptState === "cancelled" || binding.attemptState === "cancel_requested") return;
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
			binding.attemptState = "cancel_requested";
			try {
				await this.#commitAttemptTransition(binding, "cancel_requested", [], {
					cause: request.reason,
					settleCommandId: request.commandId,
					expectedStates: [previousState],
				});
			} catch (error) {
				binding.attemptState = previousState;
				throw error;
			}
			await this.#cancelToolApprovals(binding, reason, request.commandId);
			this.asyncJobManager.cancelAll({ ownerId: binding.engineAgentId, attemptId: binding.attemptId });
			await this.#cancelPendingInput(binding, reason, request.commandId);
			const abort = binding.session.abort({ reason });
			binding.pauseGate.resume();
			this.#notifyPauseProgress(binding);
			this.#trackRun(this.#finishCancel(binding, request, abort));
		});
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
				{ code: command.code, message: command.message },
				command.commandId,
				settleCommand ? command.commandId : undefined,
				"rejected",
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
		this.#throwIfDisposed();
		if (!message.messageId.trim() || !message.body.trim()) {
			throw new EngineTargetError("invalid_request", "messageId and body must be non-empty strings");
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
		return await this.#withSessionScope(binding, () =>
			this.ircBus.deliver(
				{
					id: message.messageId,
					from: sender,
					to: recipient,
					body: message.body,
					ts: message.sentAt ?? Date.now(),
					replyTo: message.replyToMessageId,
				},
				{ bufferOnFailure: false },
			),
		);
	}

	async drain(): Promise<void> {
		await Promise.all(this.#lanes.values());
		await Promise.all(this.#runs);
		await this.store.drain();
	}

	async dispose(options: { closeStore?: boolean } = {}): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
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
		await collectFailure(errors, () => this.agentLifecycle.dispose());
		await collectFailure(errors, () => this.asyncJobManager.dispose({ timeoutMs: 3_000 }));
		await collectFailure(errors, () => this.ircBus.dispose());
		if (options.closeStore !== false) await collectFailure(errors, () => this.store.close());
		throwCollectedFailures(errors, "Engine disposal failed");
	}

	async #startInLane(request: EngineStartRequest, profile: EngineLaunchProfile): Promise<EngineStartResult> {
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

		if (binding) {
			if (binding.state === "running" || binding.session.isStreaming) {
				throw new EngineTargetError("agent_busy", `AgentInstance ${request.agentInstanceId} is busy`);
			}
			if (
				binding.profileDigest !== sessionProfileDigest(profile) ||
				binding.authorityGeneration !== request.authorityGeneration
			) {
				await this.#terminateBinding(binding, "requested");
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
				binding.activeModelCalls.clear();
				binding.pauseCommandIds.clear();
				binding.pauseRequests.clear();
				binding.resumeCommandIds.clear();
				binding.session.setAttemptId(request.attemptId);
			}
		}
		if (!binding) binding = await this.#openBinding(request, profile);
		try {
			binding.state = "running";
			binding.attemptState = "running";
			await this.#commitAttemptTransition(binding, "running", [{ kind: "accepted" }, { kind: "running" }], {
				settleCommandId: request.commandId,
				requireNew: true,
			});
		} catch (error) {
			try {
				await this.#discardBinding(binding);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Engine admission and cleanup failed");
			}
			if (error instanceof EngineAttemptConflictError) {
				throw new EngineTargetError("invalid_request", `Attempt ${request.attemptId} was claimed concurrently`);
			}
			throw error;
		}
		this.#trackRun(this.#runPrompt(binding, request.input));
		return { ...this.#snapshot(binding), duplicate: false };
	}

	async #openBinding(request: EngineStartRequest, profile: EngineLaunchProfile): Promise<LiveBinding> {
		const resolved = await this.#resolveSessionProfile?.(profile, request.cwd);
		let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
		let unsubscribeCreated: (() => void) | undefined;
		try {
			const prior = await this.store.getBinding(request.agentInstanceId);
			const profileDigest = sessionProfileDigest(profile);
			const bindingGeneration = (prior?.bindingGeneration ?? 0) + 1;
			const route = engineRouteToken(request.agentInstanceId);
			const sessionDir = path.join(this.#sessionRoot, route);
			const sessionManager =
				prior?.sessionFile && prior.profileDigest === profileDigest
					? await SessionManager.open(prior.sessionFile, sessionDir, this.store.sessionStorage, {
							initialCwd: request.cwd,
						})
					: SessionManager.create(request.cwd, sessionDir, this.store.sessionStorage);
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
			created = await createAgentSession({
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
				agentId: id,
				agentDisplayName: request.agentInstanceId,
				agentRegistry: this.agentRegistry,
				agentLifecycle: this.agentLifecycle,
				asyncJobManager: this.asyncJobManager,
				ircBus: this.ircBus,
				attemptId: request.attemptId,
				pauseGate,
				parentAgentId: request.parentAgentInstanceId ? engineAgentId(request.parentAgentInstanceId) : undefined,
				engineMode: true,
				expectedAgentRef: null,
			});

			const binding: LiveBinding = {
				bindingId: `${route}:${bindingGeneration}`,
				commandId: request.commandId,
				agentInstanceId: request.agentInstanceId,
				executionId: request.executionId,
				attemptId: request.attemptId,
				engineAgentId: id,
				sessionFile: created.session.sessionFile,
				profileDigest,
				attemptState: "accepted",
				state: "idle",
				engineGeneration: this.engineGeneration,
				bindingGeneration,
				authorityGeneration: request.authorityGeneration,
				session: created.session,
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
				if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end") {
					const reasoning = event.assistantMessageEvent.content.trim();
					if (reasoning)
						this.#queueTraceEvent(binding, "trace_reasoning", { reasoning: reasoning.slice(0, MAX_TRACE_CHARS) });
				}
				if (event.type === "tool_execution_start") {
					binding.activeToolCallIds.add(event.toolCallId);
					const intent = event.intent?.trim();
					if (intent)
						this.#queueTraceEvent(binding, "trace_reasoning", { reasoning: intent.slice(0, MAX_TRACE_CHARS) });
					let traceName = event.toolName;
					let traceArgs: unknown = event.args;
					if (
						traceName === "write" &&
						typeof traceArgs === "object" &&
						traceArgs !== null &&
						"path" in traceArgs &&
						typeof traceArgs.path === "string" &&
						traceArgs.path.startsWith("xd://mcp__")
					) {
						traceName = traceArgs.path.slice("xd://".length);
						traceArgs = "content" in traceArgs ? traceArgs.content : {};
					}
					const summary = typeof traceArgs === "string" ? traceArgs : stableStringifyJson(traceArgs);
					binding.traceTools.set(event.toolCallId, {
						name: traceName,
						summary: summary.length > 2_048 ? `${summary.slice(0, 2_048)}…` : summary,
						startedAt: Date.now(),
					});
				}
				if (event.type === "tool_execution_end") {
					binding.activeToolCallIds.delete(event.toolCallId);
					const started = binding.traceTools.get(event.toolCallId);
					binding.traceTools.delete(event.toolCallId);
					this.#queueTraceEvent(binding, "trace_tool", {
						tool: {
							name: started?.name ?? event.toolName,
							...(started?.summary ? { summary: started.summary } : {}),
							outcome: event.isError ? "failed" : "ok",
							...(started ? { took: Math.max(0, Math.round((Date.now() - started.startedAt) / 100) / 10) } : {}),
						},
					});
					this.#notifyPauseProgress(binding);
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
			if (resolved) await collectFailure(cleanupErrors, resolved.dispose);
			if (cleanupErrors.length > 0) {
				logger.warn("Engine binding startup cleanup failed", {
					errors: cleanupErrors.map(item => (item instanceof Error ? item.message : String(item))),
				});
			}
			throw error;
		}
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
				payload: controlPayload(initiator, "paused"),
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

	async #dispatchModel(binding: LiveBinding, input: string): Promise<boolean> {
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
				dispatched = await this.#withSessionScope(binding, () => this.#dispatchPrompt(binding.session, input));
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

	async #runPrompt(binding: LiveBinding, input: string): Promise<void> {
		const attemptId = binding.attemptId;
		try {
			await this.#dispatchModel(binding, input);
			for (let reminder = 0; reminder < 2 && binding.requireYieldTool; reminder++) {
				await binding.pauseGate.waitUntilResumed();
				if (terminalYield(binding.session.messages).found || binding.attemptState !== "running") break;
				await this.#dispatchModel(
					binding,
					"Your previous response was not submitted. Call the yield tool now with the complete output object in result.data. Do not answer with text.",
				);
			}
			await this.#waitForAttemptQuiescence(binding, attemptId);
			if (binding.requireYieldTool && !terminalYield(binding.session.messages).found) {
				throw new Error("required_yield_not_submitted");
			}
			await this.#settleAttempt(binding, attemptId, "completed");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.#settleAttempt(binding, attemptId, "failed", message);
		}
	}

	async #settleAttempt(
		binding: LiveBinding,
		attemptId: string,
		state: "completed" | "failed",
		cause?: string,
	): Promise<void> {
		await binding.traceWriteTail;
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
										? this.#completionPayload(binding)
										: { error: cause ?? "Unknown Engine failure" },
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
			if (!retry) return;
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

	#completionPayload(binding: LiveBinding): EngineCompletionPayload {
		const yielded = terminalYield(binding.session.messages);
		const final = yielded.found ? JSON.stringify(yielded.data) : (binding.session.getLastAssistantText() ?? "");
		const outputTruncated = final.length > MAX_ASSISTANT_FINAL_CHARS;
		return {
			assistantFinal: outputTruncated ? `${final.slice(0, MAX_ASSISTANT_FINAL_CHARS)}\n[…truncated]` : final,
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
		const transcriptCheckpoint = await binding.session.sessionManager.flushAndCheckpoint();
		await this.#inLane(binding.agentInstanceId, async () => {
			if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
			if (binding.attemptId !== request.attemptId || binding.attemptState !== "cancel_requested") return;
			binding.state = "idle";
			binding.attemptState = "cancelled";
			const payload = request.reason ? { reason: request.reason } : undefined;
			const events: EngineTransitionEvent[] = [{ kind: "cancelled", payload }];
			if (request.commandId !== binding.commandId) {
				events.push({ kind: "cancelled", payload, causationCommandId: request.commandId });
			}
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
	}

	async #terminateBinding(binding: LiveBinding, cause: "requested" | "engine_lost"): Promise<void> {
		if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
		const wasRunning = binding.state === "running";
		const previousAttemptState = binding.attemptState;
		this.#bindings.delete(binding.agentInstanceId);
		binding.state = "released";
		const reason = cause === "engine_lost" ? "Engine stopped" : "Engine binding released";
		const errors: unknown[] = [];
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
				this.#commitAttemptTransition(binding, "interrupted", [{ kind: "interrupted", payload: { cause } }], {
					cause,
					expectedStates: [previousAttemptState],
					transcriptCheckpoint,
				}),
			);
		} else if (cause === "requested" && wasRunning && transcriptCheckpoint) {
			binding.attemptState = "cancelled";
			await collectFailure(errors, () =>
				this.#commitAttemptTransition(
					binding,
					"cancelled",
					[{ kind: "cancelled", payload: { cause: "binding_released" } }],
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
		await this.#disposeBindingResources(binding, "Engine admission failed", "cancelled");
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
		settleOutcome: "applied" | "rejected" = "applied",
	): Promise<void> {
		const event = await this.store.commitEvent(
			target,
			{ kind, payload, causationCommandId },
			settleCommandId,
			settleOutcome,
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
			expectedStates?: readonly EngineAttemptState[];
			requireNew?: boolean;
			transcriptCheckpoint?: SessionDurabilityCheckpoint;
		} = {},
	): Promise<void> {
		const committed = await this.store.commitAttemptTransition(this.#snapshot(binding), state, events, options);
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
): Record<string, unknown> {
	return {
		initiator,
		attemptState: state,
		controlReadiness: controlReadiness(state),
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

function sessionProfileDigest(profile: EngineLaunchProfile): string {
	return `sha256:${sha256(stableStringifyJson(profile))}`;
}
