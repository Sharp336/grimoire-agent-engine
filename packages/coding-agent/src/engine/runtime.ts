import * as path from "node:path";
import { AsyncJobManager } from "../async/job-manager";
import { IrcBus, type IrcDeliveryReceipt } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import {
	type EngineBindingSnapshot,
	type EngineCancelRequest,
	type EngineEvent,
	type EngineLaunchProfile,
	type EnginePeerMessage,
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

interface LiveBinding extends EngineBindingSnapshot {
	session: AgentSession;
	unsubscribe: () => void;
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

	start(request: EngineStartRequest, profile: EngineLaunchProfile): Promise<EngineStartResult> {
		validateStartRequest(request);
		if (!profile.profileDigest.trim()) {
			throw new EngineTargetError("invalid_request", "profileDigest must be a non-empty string");
		}
		return this.#inLane(request.agentInstanceId, () => this.#startInLane(request, profile));
	}

	steer(request: EngineSteerRequest): Promise<void> {
		if (!request.message.trim()) {
			throw new EngineTargetError("invalid_request", "message must be a non-empty string");
		}
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			await binding.session.prompt(request.message, { streamingBehavior: "steer" });
		});
	}

	cancel(request: EngineCancelRequest): Promise<void> {
		return this.#inLane(request.agentInstanceId, async () => {
			const binding = this.#requireTarget(request);
			this.asyncJobManager.cancelAll({ ownerId: binding.engineAgentId, attemptId: binding.attemptId });
			binding.state = "idle";
			await binding.session.abort({ reason: request.reason ?? "Engine attempt cancelled" });
			if (binding.attemptId !== request.attemptId) return;
			await this.store.putBinding(this.#snapshot(binding));
			await this.store.putAttempt(binding, "cancelled", request.reason);
			await this.#emit(binding, "cancelled", request.reason ? { reason: request.reason } : undefined);
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
		return await this.ircBus.send({
			from: engineAgentId(message.fromAgentInstanceId),
			to: engineAgentId(message.toAgentInstanceId),
			body: message.body,
		});
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
					return { ...this.#snapshot(binding), duplicate: true };
				}
				throw new EngineTargetError(
					"invalid_request",
					`Attempt ${request.attemptId} is already bound to Execution ${binding.executionId}`,
				);
			}
			if (binding.state === "running" || binding.session.isStreaming) {
				throw new EngineTargetError("agent_busy", `AgentInstance ${request.agentInstanceId} is busy`);
			}
			if (binding.profileDigest !== profile.profileDigest) {
				await this.#terminateBinding(binding, "requested");
				binding = undefined;
			} else {
				binding.executionId = request.executionId;
				binding.attemptId = request.attemptId;
				binding.state = "idle";
				binding.session.setAttemptId(request.attemptId);
			}
		}

		if (!binding) binding = await this.#openBinding(request, profile);
		try {
			await this.store.putBinding(this.#snapshot(binding));
			await this.store.putAttempt(binding, "accepted");
			await this.#emit(binding, "accepted");
			binding.state = "running";
			await this.store.putBinding(this.#snapshot(binding));
			await this.store.putAttempt(binding, "running");
			await this.#emit(binding, "running");
		} catch (error) {
			await this.#discardBinding(binding);
			throw error;
		}
		const run = this.#runPrompt(binding, request.input);
		this.#runs.add(run);
		void run.then(
			() => this.#runs.delete(run),
			() => this.#runs.delete(run),
		);
		return { ...this.#snapshot(binding), duplicate: false };
	}

	async #openBinding(request: EngineStartRequest, profile: EngineLaunchProfile): Promise<LiveBinding> {
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
		const created = await createAgentSession({
			...this.#sessionDefaults,
			cwd: request.cwd,
			sessionManager,
			spawns: profile.spawns,
			toolNames: profile.toolNames,
			restrictToolNames: profile.restrictToolNames,
			enableMCP: profile.enableMCP,
			enableLsp: profile.enableLsp,
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
		const binding: LiveBinding = {
			bindingId: `${route}:${bindingGeneration}`,
			agentInstanceId: request.agentInstanceId,
			executionId: request.executionId,
			attemptId: request.attemptId,
			engineAgentId: id,
			sessionFile: created.session.sessionFile,
			profileDigest: profile.profileDigest,
			state: "idle",
			engineGeneration: this.engineGeneration,
			bindingGeneration,
			session: created.session,
			unsubscribe: () => {},
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
			await this.#inLane(binding.agentInstanceId, async () => {
				if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
				if (binding.attemptId !== attemptId || binding.state !== "running") return;
				binding.state = "idle";
				await this.store.putBinding(this.#snapshot(binding));
				await this.store.putAttempt(binding, "completed");
				await this.#emit(binding, "completed");
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.#inLane(binding.agentInstanceId, async () => {
				if (this.#bindings.get(binding.agentInstanceId) !== binding) return;
				if (binding.attemptId !== attemptId || binding.state !== "running") return;
				binding.state = "idle";
				await this.store.putBinding(this.#snapshot(binding));
				await this.store.putAttempt(binding, "failed", message);
				await this.#emit(binding, "failed", { error: message });
			});
		}
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
		this.agentRegistry.unregister(binding.engineAgentId, binding.session);
		await this.store.putBinding(this.#snapshot(binding));
		if (cause === "engine_lost" && wasRunning) {
			await this.store.putAttempt(binding, "interrupted", cause);
			await this.#emit(binding, "interrupted", { cause });
		} else if (cause === "requested" && wasRunning) {
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
		this.agentRegistry.unregister(binding.engineAgentId, binding.session);
	}

	#requireTarget(target: EngineTarget): LiveBinding {
		this.#throwIfDisposed();
		const binding = this.#bindings.get(target.agentInstanceId);
		if (!binding) throw new EngineTargetError("agent_not_found", `Unknown AgentInstance ${target.agentInstanceId}`);
		if (
			binding.engineGeneration !== target.engineGeneration ||
			binding.bindingGeneration !== target.bindingGeneration ||
			binding.executionId !== target.executionId
		) {
			throw new EngineTargetError("stale_target", `Stale runtime target for ${target.agentInstanceId}`);
		}
		if (binding.attemptId !== target.attemptId) {
			throw new EngineTargetError("too_late", `Attempt ${target.attemptId} is no longer active`);
		}
		return binding;
	}

	async #reconcileLostAttempts(): Promise<void> {
		const interrupted = await this.store.reconcileInterrupted(this.engineGeneration);
		for (const attempt of interrupted) {
			await this.#emit(
				{
					agentInstanceId: attempt.agent_instance_id,
					executionId: attempt.execution_id,
					attemptId: attempt.attempt_id,
					engineGeneration: this.engineGeneration,
					bindingGeneration: Number(attempt.binding_generation),
				},
				"interrupted",
				{ cause: "engine_lost", lostEngineGeneration: Number(attempt.engine_generation) },
			);
		}
	}

	async #emit(
		target: Pick<
			EngineTarget,
			"agentInstanceId" | "executionId" | "attemptId" | "engineGeneration" | "bindingGeneration"
		>,
		kind: EngineEvent["kind"],
		payload?: Record<string, unknown>,
	): Promise<void> {
		const event = await this.store.appendEvent({ ...target, kind, payload });
		for (const listener of this.#listeners) {
			void Promise.resolve(listener(event)).catch(() => {});
		}
	}

	#snapshot(binding: LiveBinding): EngineBindingSnapshot {
		return {
			bindingId: binding.bindingId,
			agentInstanceId: binding.agentInstanceId,
			executionId: binding.executionId,
			attemptId: binding.attemptId,
			engineAgentId: binding.engineAgentId,
			sessionFile: binding.sessionFile,
			profileDigest: binding.profileDigest,
			state: binding.state,
			engineGeneration: binding.engineGeneration,
			bindingGeneration: binding.bindingGeneration,
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

	#throwIfDisposed(): void {
		if (this.#disposed) throw new Error("EngineRuntime is disposed");
	}
}
