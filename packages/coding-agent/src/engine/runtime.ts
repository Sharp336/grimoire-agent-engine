import * as path from "node:path";
import { AsyncJobManager } from "../async/job-manager";
import { IrcBus, type IrcDeliveryReceipt } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import {
	type EngineAttemptState,
	type EngineBindingSnapshot,
	type EngineCancelRequest,
	type EngineCompletionPayload,
	type EngineEvent,
	type EngineLaunchProfile,
	type EnginePeerMessage,
	type EngineReconcileRequest,
	type EngineReconcileResult,
	type EngineRejectedCommand,
	type EngineStartRequest,
	type EngineStartResult,
	type EngineSteerRequest,
	type EngineTarget,
	EngineTargetError,
	validateStartRequest,
} from "./contracts";
import { engineAgentId, engineRouteToken } from "./route";
import { EngineStore } from "./store";

type EngineEventListener = (event: EngineEvent) => void | Promise<void>;

const MAX_ASSISTANT_FINAL_CHARS = 48_000;

interface LiveBinding extends EngineBindingSnapshot {
	attemptState: EngineAttemptState;
	session: AgentSession;
	steerCommandIds: string[];
	steerCommandSet: Set<string>;
	unsubscribe: () => void;
	disposeProfile: () => void;
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
	>;
	/** Test/integration seam; production uses AgentSession.prompt directly. */
	dispatchPrompt?: (session: AgentSession, input: string) => Promise<boolean>;
	resolveSessionProfile?: (profile: EngineLaunchProfile) => Promise<{
		options: Partial<CreateAgentSessionOptions>;
		dispose(): void;
	}>;
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
	readonly #bindings = new Map<string, LiveBinding>();
	readonly #lanes = new Map<string, Promise<void>>();
	readonly #runs = new Set<Promise<void>>();
	readonly #listeners = new Set<EngineEventListener>();
	readonly #sessionRoot: string;
	#disposed = false;

	private constructor(store: EngineStore, engineGeneration: number, options: EngineRuntimeOptions) {
		this.store = store;
		this.engineGeneration = engineGeneration;
		this.#sessionDefaults = options.sessionDefaults;
		this.#dispatchPrompt = options.dispatchPrompt ?? ((session, input) => session.prompt(input));
		this.#resolveSessionProfile = options.resolveSessionProfile;
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
			if (binding.state !== "running" || !binding.session.isStreaming) {
				throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is not streaming`);
			}
			await binding.session.steer(request.message);
			binding.steerCommandIds.push(request.commandId);
			binding.steerCommandSet.add(request.commandId);
			const evicted = binding.steerCommandIds.length > 256 ? binding.steerCommandIds.shift() : undefined;
			if (evicted) binding.steerCommandSet.delete(evicted);
			await this.#emit(binding, "steered", undefined, request.commandId);
		});
	}

	cancel(request: EngineCancelRequest): Promise<void> {
		if (!request.commandId.trim()) {
			throw new EngineTargetError("invalid_request", "commandId must be a non-empty string");
		}
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			if (binding.attemptState === "cancelled" || binding.attemptState === "cancel_requested") return;
			if (binding.attemptState !== "running") {
				throw new EngineTargetError("too_late", `Attempt ${request.attemptId} is already ${binding.attemptState}`);
			}
			this.asyncJobManager.cancelAll({ ownerId: binding.engineAgentId, attemptId: binding.attemptId });
			const abort = binding.session.abort({ reason: request.reason ?? "Engine attempt cancelled" });
			binding.attemptState = "cancel_requested";
			await this.store.putAttempt(binding, "cancel_requested", request.reason);
			this.#trackRun(this.#finishCancel(binding, request, abort));
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
			await this.#emit(
				snapshot,
				"reconciled",
				{ binding: snapshot, attemptState: attempt?.state },
				request.commandId,
			);
			return { binding: snapshot, attemptState: attempt?.state };
		});
	}

	recordCommandRejection(command: EngineRejectedCommand): Promise<void> {
		return this.#inLane(command.agentInstanceId, async () => {
			this.#throwIfDisposed();
			await this.#emit(
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
		return await this.ircBus.deliver(
			{
				id: message.messageId,
				from: sender,
				to: recipient,
				body: message.body,
				ts: message.sentAt ?? Date.now(),
				replyTo: message.replyToMessageId,
			},
			{ bufferOnFailure: false },
		);
	}

	async drain(): Promise<void> {
		await Promise.all(this.#lanes.values());
		await Promise.all(this.#runs);
		await this.store.drain();
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await Promise.all(this.#lanes.values());
		for (const binding of [...this.#bindings.values()]) await this.#terminateBinding(binding, "engine_lost");
		await Promise.all(this.#runs);
		await this.agentLifecycle.dispose();
		await this.asyncJobManager.dispose({ timeoutMs: 3_000 });
		this.ircBus.dispose();
		await this.store.close();
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
				binding.profileDigest !== profile.profileDigest ||
				binding.authorityGeneration !== request.authorityGeneration
			) {
				await this.#terminateBinding(binding, "requested");
				binding = undefined;
			} else {
				binding.executionId = request.executionId;
				binding.attemptId = request.attemptId;
				binding.commandId = request.commandId;
				binding.authorityGeneration = request.authorityGeneration;
				binding.attemptState = "accepted";
				binding.state = "idle";
				binding.steerCommandIds = [];
				binding.steerCommandSet.clear();
				binding.session.setAttemptId(request.attemptId);
			}
		}
		if (!binding) binding = await this.#openBinding(request, profile);
		try {
			await this.store.putBinding(this.#snapshot(binding));
			if (!(await this.store.putAttempt(binding, "accepted"))) {
				throw new EngineTargetError("invalid_request", `Attempt ${request.attemptId} was claimed concurrently`);
			}
			await this.#emit(binding, "accepted");
			binding.state = "running";
			binding.attemptState = "running";
			await this.store.putBinding(this.#snapshot(binding));
			await this.store.putAttempt(binding, "running");
			await this.#emit(binding, "running");
		} catch (error) {
			await this.#discardBinding(binding);
			throw error;
		}
		this.#trackRun(this.#runPrompt(binding, request.input));
		return { ...this.#snapshot(binding), duplicate: false };
	}

	async #openBinding(request: EngineStartRequest, profile: EngineLaunchProfile): Promise<LiveBinding> {
		const resolved = await this.#resolveSessionProfile?.(profile);
		const prior = await this.store.getBinding(request.agentInstanceId);
		const bindingGeneration = (prior?.bindingGeneration ?? 0) + 1;
		const route = engineRouteToken(request.agentInstanceId);
		const sessionDir = path.join(this.#sessionRoot, route);
		const sessionManager = prior?.sessionFile
			? await SessionManager.open(prior.sessionFile, sessionDir, this.store.sessionStorage, {
					initialCwd: request.cwd,
				})
			: SessionManager.create(request.cwd, sessionDir, this.store.sessionStorage);
		const id = engineAgentId(request.agentInstanceId);
		let created: Awaited<ReturnType<typeof createAgentSession>>;
		try {
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
				...resolved?.options,
				agentId: id,
				agentDisplayName: request.agentInstanceId,
				agentRegistry: this.agentRegistry,
				agentLifecycle: this.agentLifecycle,
				asyncJobManager: this.asyncJobManager,
				ircBus: this.ircBus,
				attemptId: request.attemptId,
				engineMode: true,
				expectedAgentRef: null,
			});
		} catch (error) {
			resolved?.dispose();
			throw error;
		}
		const binding: LiveBinding = {
			bindingId: `${route}:${bindingGeneration}`,
			commandId: request.commandId,
			agentInstanceId: request.agentInstanceId,
			executionId: request.executionId,
			attemptId: request.attemptId,
			engineAgentId: id,
			sessionFile: created.session.sessionFile,
			profileDigest: profile.profileDigest,
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
		};
		binding.unsubscribe = created.session.subscribe(event => {
			if (event.type === "agent_end" && event.isTerminal !== false && binding.state === "running") {
				this.agentRegistry.setStatus(binding.engineAgentId, "idle", binding.session);
			}
		});
		this.#bindings.set(request.agentInstanceId, binding);
		return binding;
	}

	async #runPrompt(binding: LiveBinding, input: string): Promise<void> {
		const attemptId = binding.attemptId;
		try {
			await this.#dispatchPrompt(binding.session, input);
			await this.#waitForAttemptQuiescence(binding, attemptId);
			await this.#inLane(binding.agentInstanceId, async () => {
				if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
				if (binding.attemptId !== attemptId || binding.attemptState !== "running") return;
				binding.state = "idle";
				binding.attemptState = "completed";
				await this.store.putBinding(this.#snapshot(binding));
				await this.store.putAttempt(binding, "completed");
				await this.#emit(binding, "completed", this.#completionPayload(binding));
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.#inLane(binding.agentInstanceId, async () => {
				if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
				if (binding.attemptId !== attemptId || binding.attemptState !== "running") return;
				binding.state = "idle";
				binding.attemptState = "failed";
				await this.store.putBinding(this.#snapshot(binding));
				await this.store.putAttempt(binding, "failed", message);
				await this.#emit(binding, "failed", { error: message });
			});
		}
	}

	async #waitForAttemptQuiescence(binding: LiveBinding, attemptId: string): Promise<void> {
		const filter = { ownerId: binding.engineAgentId, attemptId };
		for (;;) {
			await binding.session.waitForIdle();
			await this.asyncJobManager.waitForOwnerJobs(binding.engineAgentId, { attemptId });
			await this.asyncJobManager.drainDeliveries({ filter });
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
		const final = binding.session.getLastAssistantText() ?? "";
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
		await this.#inLane(binding.agentInstanceId, async () => {
			if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
			if (binding.attemptId !== request.attemptId || binding.attemptState !== "cancel_requested") return;
			binding.state = "idle";
			binding.attemptState = "cancelled";
			await this.store.putBinding(this.#snapshot(binding));
			await this.store.putAttempt(binding, "cancelled", request.reason);
			const payload = request.reason ? { reason: request.reason } : undefined;
			await this.#emit(binding, "cancelled", payload);
			if (request.commandId !== binding.commandId) {
				await this.#emit(binding, "cancelled", payload, request.commandId);
			}
		});
	}

	async #terminateBinding(binding: LiveBinding, cause: "requested" | "engine_lost"): Promise<void> {
		if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
		const wasRunning = binding.state === "running";
		this.#bindings.delete(binding.agentInstanceId);
		binding.state = "released";
		binding.unsubscribe();
		this.asyncJobManager.cancelAll({ ownerId: binding.engineAgentId, attemptId: binding.attemptId });
		await binding.session.abort({ reason: cause === "engine_lost" ? "Engine stopped" : "Engine binding released" });
		await binding.session.dispose();
		binding.disposeProfile();
		this.agentRegistry.unregister(binding.engineAgentId, binding.session);
		await this.store.putBinding(this.#snapshot(binding));
		if (cause === "engine_lost" && wasRunning) {
			binding.attemptState = "interrupted";
			await this.store.putAttempt(binding, "interrupted", cause);
			await this.#emit(binding, "interrupted", { cause });
		} else if (cause === "requested" && wasRunning) {
			binding.attemptState = "cancelled";
			await this.store.putAttempt(binding, "cancelled", "binding_released");
			await this.#emit(binding, "cancelled", { cause: "binding_released" });
		}
	}

	async #discardBinding(binding: LiveBinding): Promise<void> {
		if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
		this.#bindings.delete(binding.agentInstanceId);
		binding.state = "released";
		binding.unsubscribe();
		this.asyncJobManager.cancelAll({ ownerId: binding.engineAgentId, attemptId: binding.attemptId });
		await binding.session.abort({ reason: "Engine admission failed" });
		await binding.session.dispose();
		binding.disposeProfile();
		this.agentRegistry.unregister(binding.engineAgentId, binding.session);
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
		const interrupted = await this.store.reconcileInterrupted(this.engineGeneration);
		for (const attempt of interrupted) {
			await this.#emit(
				{
					commandId: attempt.command_id,
					agentInstanceId: attempt.agent_instance_id,
					executionId: attempt.execution_id,
					attemptId: attempt.attempt_id,
					engineGeneration: this.engineGeneration,
					bindingId: attempt.binding_id,
					bindingGeneration: Number(attempt.binding_generation),
					authorityGeneration: Number(attempt.authority_generation),
				},
				"interrupted",
				{ cause: "engine_lost", lostEngineGeneration: Number(attempt.engine_generation) },
			);
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
		for (const listener of this.#listeners) {
			void Promise.resolve(listener(event)).catch(() => {});
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
