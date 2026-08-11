import { Snowflake } from "@oh-my-pi/pi-utils";
import { analyzeAuthError } from "../../mcp/oauth-discovery";
import { sanitizeRpcText } from "./rpc-safe-text";

const MAX_RESOURCE_ITEMS = 512;
const MAX_RESOURCE_DIAGNOSTICS = 64;
const MAX_RESOURCE_TEXT_BYTES = 4096;

export type RpcResourceKind = "mcp" | "lsp" | "dap";

export type RpcResourceLifecycleState =
	| "discovered"
	| "connecting"
	| "connected"
	| "disconnected"
	| "authentication_required"
	| "reconnecting"
	| "failed"
	| "disabled";

export interface RpcResourceDiagnostic {
	severity: "info" | "warning" | "error";
	code: string;
	message: string;
	retryable: boolean;
}

export interface RpcResourceToolSource {
	name: string;
	description?: string;
	mcpServerName?: string;
}

export interface RpcResourceItemSource {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

export interface RpcResourceTemplateSource {
	uriTemplate: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

export interface RpcResourcePromptSource {
	name: string;
	description?: string;
}

export interface RpcResourceManagerSource {
	getAllServerNames(): string[];
	getResourceKind?(name: string): RpcResourceKind;
	refreshLifecycle?(name: string, signal: AbortSignal): Promise<RpcResourceLifecycleState | undefined>;
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
	getConnection(name: string):
		| {
				capabilities: {
					tools?: unknown;
					resources?: unknown;
					prompts?: unknown;
				};
		  }
		| undefined;
	getTools(): RpcResourceToolSource[];
	getServerResources(
		name: string,
	): { resources: RpcResourceItemSource[]; templates: RpcResourceTemplateSource[] } | undefined;
	getServerPrompts(name: string): RpcResourcePromptSource[] | undefined;
	reconnectServer(name: string, options?: { manual?: boolean; signal?: AbortSignal }): Promise<unknown | null>;
	refreshServerTools(name: string, signal?: AbortSignal): Promise<void>;
	refreshServerResources(name: string, signal?: AbortSignal): Promise<void>;
	refreshServerPrompts(name: string, signal?: AbortSignal): Promise<void>;
	disconnectServer(name: string): Promise<void>;
	rebind?(): void;
}

export interface RpcResourceCollection<T> {
	items: T[];
	total: number;
	truncated?: true;
}

export interface RpcResourceServerSnapshot {
	serverId: string;
	kind: RpcResourceKind;
	state: RpcResourceLifecycleState;
	capabilities: {
		tools: boolean;
		resources: boolean;
		prompts: boolean;
	};
	tools: RpcResourceCollection<{ name: string; description?: string }>;
	resources: RpcResourceCollection<{
		uri: string;
		name?: string;
		description?: string;
		mediaType?: string;
	}>;
	resourceTemplates: RpcResourceCollection<{
		uriTemplate: string;
		name?: string;
		description?: string;
		mediaType?: string;
	}>;
	prompts: RpcResourceCollection<{ name: string; description?: string }>;
	diagnostics: RpcResourceDiagnostic[];
}

export interface RpcResourceLifecycleSnapshot {
	revision: number;
	servers: RpcResourceServerSnapshot[];
	activeOperations: Array<{
		operationId: string;
		requestId?: string;
		kind: "refresh" | "reload";
		serverIds: string[];
	}>;
}

export type RpcResourceLifecycleFrame =
	| {
			type: "resource_lifecycle";
			revision: number;
			serverId: string;
			state: RpcResourceLifecycleState;
			previousState?: RpcResourceLifecycleState;
			operationId?: string;
			diagnostics: RpcResourceDiagnostic[];
	  }
	| {
			type: "resource_operation";
			operationId: string;
			requestId?: string;
			kind: "refresh" | "reload" | "dispose";
			outcome: "completed" | "cancelled" | "failed";
			serverIds: string[];
	  };

interface ResourceStateRecord {
	state: RpcResourceLifecycleState;
	diagnostics: RpcResourceDiagnostic[];
}

interface ResourceOperation {
	operationId: string;
	requestId?: string;
	kind: "refresh" | "reload";
	serverIds: string[];
	controller: AbortController;
	previous: Map<string, ResourceStateRecord>;
	generations: Map<string, number>;
	settled: boolean;
}

export class RpcResourceNotFoundError extends Error {
	readonly code = "resource_not_found";

	constructor(serverId: string) {
		super(`Resource server is not available in this session: ${serverId}`);
		this.name = "RpcResourceNotFoundError";
	}
}

export class RpcResourceAuthenticationRequiredError extends Error {
	constructor() {
		super("Resource authentication is required");
		this.name = "RpcResourceAuthenticationRequiredError";
	}
}

function safeText(value: string): string {
	return sanitizeRpcText(value, MAX_RESOURCE_TEXT_BYTES);
}

function optionalSafeText(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const safe = safeText(value);
	return safe.length > 0 ? safe : undefined;
}

function collection<T>(items: readonly T[]): RpcResourceCollection<T> {
	const projected = items.slice(0, MAX_RESOURCE_ITEMS);
	return {
		items: projected,
		total: items.length,
		...(projected.length < items.length ? { truncated: true as const } : {}),
	};
}

function diagnostic(code: string, message: string, retryable: boolean): RpcResourceDiagnostic {
	return { severity: "error", code, message, retryable };
}

function sameDiagnostics(left: readonly RpcResourceDiagnostic[], right: readonly RpcResourceDiagnostic[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export class RpcResourceLifecycleManager {
	#source: RpcResourceManagerSource;
	readonly #output: (frame: RpcResourceLifecycleFrame) => void;
	readonly #states = new Map<string, ResourceStateRecord>();
	readonly #operations = new Map<string, ResourceOperation>();
	readonly #tasks = new Set<Promise<void>>();
	readonly #serverEffects = new Map<string, Promise<void>>();
	readonly #serverGenerations = new Map<string, number>();
	#revision = 0;
	#disposed = false;
	#draining = false;
	#drainPromise: Promise<void> | undefined;
	#disposePromise: Promise<void> | undefined;

	constructor(source: RpcResourceManagerSource, output: (frame: RpcResourceLifecycleFrame) => void) {
		this.#source = source;
		this.#output = output;
		this.#syncSourceStates();
	}

	snapshot(): RpcResourceLifecycleSnapshot {
		this.#syncSourceStates();
		const serverIds = [...this.#states.keys()].sort();
		return {
			revision: this.#revision,
			servers: serverIds.map(serverId => this.#projectServer(serverId)),
			activeOperations: [...this.#operations.values()].map(operation => ({
				operationId: operation.operationId,
				...(operation.requestId === undefined ? {} : { requestId: operation.requestId }),
				kind: operation.kind,
				serverIds: [...operation.serverIds],
			})),
		};
	}

	startRefresh(serverId?: string, requestId?: string): { operationId: string } {
		this.#assertActive();
		this.#syncSourceStates();
		const serverIds =
			serverId === undefined
				? [...this.#states.keys()].filter(id => this.#states.get(id)?.state !== "disabled")
				: [serverId];
		for (const id of serverIds) {
			this.#assertKnown(id);
			if (this.#states.get(id)?.state === "disabled") throw new RpcResourceNotFoundError(id);
		}
		return this.#startOperation("refresh", serverIds, requestId, operation => this.#runRefresh(operation));
	}

	startReload(reload: () => Promise<void>, requestId?: string): { operationId: string } {
		this.#assertActive();
		this.#syncSourceStates();
		const serverIds = [...this.#states.keys()].filter(id => this.#states.get(id)?.state !== "disabled");
		return this.#startOperation("reload", serverIds, requestId, operation => this.#runReload(operation, reload));
	}

	cancel(operationId: string): boolean {
		const operation = this.#operations.get(operationId);
		if (!operation || operation.settled || operation.controller.signal.aborted) return false;
		operation.controller.abort();
		return true;
	}

	async disposeServer(serverId: string, requestId?: string): Promise<RpcResourceServerSnapshot> {
		this.#assertActive();
		this.#syncSourceStates();
		this.#assertKnown(serverId);
		this.#advanceGeneration(serverId);
		for (const operation of [...this.#operations.values()]) {
			if (operation.serverIds.includes(serverId)) this.cancel(operation.operationId);
		}
		const disposal = this.#disposeServerOwned(serverId, requestId);
		const task = disposal
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => this.#tasks.delete(task));
		this.#tasks.add(task);
		return disposal;
	}

	async #disposeServerOwned(serverId: string, requestId?: string): Promise<RpcResourceServerSnapshot> {
		const operationId = `resource_${Snowflake.next()}`;
		try {
			await this.#serializeServerEffect(serverId, () => this.#source.disconnectServer(serverId));
			this.#transition(serverId, "disabled", [], operationId);
			this.#output({
				type: "resource_operation",
				operationId,
				...(requestId === undefined ? {} : { requestId }),
				kind: "dispose",
				outcome: "completed",
				serverIds: [serverId],
			});
			return this.#projectServer(serverId);
		} catch (cause) {
			this.#transitionFailure(serverId, cause, operationId);
			this.#output({
				type: "resource_operation",
				operationId,
				...(requestId === undefined ? {} : { requestId }),
				kind: "dispose",
				outcome: "failed",
				serverIds: [serverId],
			});
			throw cause;
		}
	}

	/**
	 * Fence new work, abort every accepted operation, and wait until all
	 * implementation effects quiesce. The manager remains reusable after the
	 * caller commits an authority transition and invokes {@link rebind}.
	 */
	async drain(): Promise<void> {
		if (this.#drainPromise) return this.#drainPromise;
		this.#draining = true;
		for (const serverId of this.#states.keys()) this.#advanceGeneration(serverId);
		for (const operation of [...this.#operations.values()]) this.cancel(operation.operationId);
		const drain = this.#waitForTasks().finally(() => {
			if (this.#drainPromise === drain) this.#drainPromise = undefined;
		});
		this.#drainPromise = drain;
		return drain;
	}

	/**
	 * Install a new runtime binding after {@link drain} and after the authority
	 * transition commits. Old snapshots and disabled tombstones never cross the
	 * binding generation.
	 */
	rebind(source: RpcResourceManagerSource = this.#source): void {
		if (this.#disposed) throw new Error("RPC resource lifecycle manager is disposed");
		if (!this.#draining || this.#tasks.size > 0 || this.#drainPromise) {
			throw new Error("RPC resource lifecycle manager must be drained before rebinding");
		}
		this.#source = source;
		this.#source.rebind?.();
		this.#states.clear();
		this.#serverGenerations.clear();
		this.#syncSourceStates();
		this.#draining = false;
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		const dispose = this.drain()
			.then(async () => {
				const serverIds = [...this.#states].flatMap(([serverId, record]) =>
					record.state === "disabled" ? [] : [serverId],
				);
				const outcomes = await Promise.allSettled(
					serverIds.map(serverId =>
						this.#serializeServerEffect(serverId, () => this.#source.disconnectServer(serverId)),
					),
				);
				const failures = outcomes.flatMap(outcome => (outcome.status === "rejected" ? [outcome.reason] : []));
				if (failures.length > 0) throw new AggregateError(failures);
			})
			.finally(() => {
				this.#draining = true;
			});
		this.#disposePromise = dispose;
		return dispose;
	}

	async waitForIdle(): Promise<void> {
		await this.#waitForTasks();
	}

	#startOperation(
		kind: "refresh" | "reload",
		serverIds: string[],
		requestId: string | undefined,
		run: (operation: ResourceOperation) => Promise<void>,
	): { operationId: string } {
		const operationId = `resource_${Snowflake.next()}`;
		const previous = new Map<string, ResourceStateRecord>();
		const generations = new Map<string, number>();
		for (const serverId of serverIds) {
			const current = this.#states.get(serverId);
			if (!current) continue;
			previous.set(serverId, { state: current.state, diagnostics: [...current.diagnostics] });
			generations.set(serverId, this.#generation(serverId));
			const nextState =
				current.state === "connected" ? "connected" : kind === "reload" ? "connecting" : "reconnecting";
			this.#transition(serverId, nextState, [], operationId);
		}
		const operation: ResourceOperation = {
			operationId,
			...(requestId === undefined ? {} : { requestId }),
			kind,
			serverIds: [...serverIds],
			controller: new AbortController(),
			previous,
			generations,
			settled: false,
		};
		this.#operations.set(operationId, operation);
		const task = Promise.resolve()
			.then(() => run(operation))
			.catch(() => {
				if (!operation.settled) this.#settleOperation(operation, "failed");
			})
			.finally(() => this.#tasks.delete(task));
		this.#tasks.add(task);
		return { operationId };
	}

	async #runRefresh(operation: ResourceOperation): Promise<void> {
		const outcomes = await Promise.all(
			operation.serverIds.map(serverId =>
				this.#serializeServerEffect(serverId, () => this.#refreshServer(operation, serverId)),
			),
		);
		if (operation.settled) return;
		if (operation.controller.signal.aborted) {
			this.#restoreCancelled(operation);
			this.#settleOperation(operation, "cancelled");
			return;
		}
		this.#settleOperation(operation, outcomes.every(Boolean) ? "completed" : "failed");
	}

	async #refreshServer(operation: ResourceOperation, serverId: string): Promise<boolean> {
		if (!this.#canContinue(operation, serverId)) return false;
		let reconnected = false;
		try {
			const lifecycleState = await this.#source.refreshLifecycle?.(serverId, operation.controller.signal);
			if (!this.#canContinue(operation, serverId)) return false;
			if (lifecycleState !== undefined) {
				this.#transition(serverId, lifecycleState, [], operation.operationId);
				return lifecycleState !== "failed" && lifecycleState !== "authentication_required";
			}
			if (this.#source.getConnectionStatus(serverId) !== "connected") {
				const connection = await this.#source.reconnectServer(serverId, {
					manual: true,
					signal: operation.controller.signal,
				});
				if (!this.#canContinue(operation, serverId)) {
					if (connection) await this.#compensateStaleEffect(serverId);
					return false;
				}
				if (!connection) {
					this.#transition(
						serverId,
						"failed",
						[diagnostic("connection_failed", "Resource connection failed", true)],
						operation.operationId,
					);
					return false;
				}
				reconnected = true;
			}
			const refreshed = await Promise.allSettled([
				this.#source.refreshServerTools(serverId, operation.controller.signal),
				this.#source.refreshServerResources(serverId, operation.controller.signal),
				this.#source.refreshServerPrompts(serverId, operation.controller.signal),
			]);
			if (!this.#canContinue(operation, serverId)) {
				if (reconnected) await this.#compensateStaleEffect(serverId);
				return false;
			}
			const labels = ["tool metadata", "resource metadata", "prompt metadata"] as const;
			const diagnostics = refreshed.flatMap((result, index) =>
				result.status === "rejected"
					? [
							diagnostic(
								`${labels[index].split(" ")[0]}_refresh_failed`,
								`Failed to refresh ${labels[index]}`,
								true,
							),
						]
					: [],
			);
			this.#transition(serverId, "connected", diagnostics, operation.operationId);
			return diagnostics.length === 0;
		} catch (cause) {
			if (!this.#canContinue(operation, serverId)) {
				if (reconnected) await this.#compensateStaleEffect(serverId);
				return false;
			}
			this.#transitionFailure(serverId, cause, operation.operationId);
			return false;
		}
	}

	async #runReload(operation: ResourceOperation, reload: () => Promise<void>): Promise<void> {
		try {
			await this.#serializeServerEffects(operation.serverIds, () => {
				if (
					operation.controller.signal.aborted ||
					operation.serverIds.some(serverId => !this.#ownsGeneration(operation, serverId))
				) {
					throw operation.controller.signal.reason instanceof Error
						? operation.controller.signal.reason
						: new Error("Resource reload authority changed");
				}
				return reload();
			});
			if (operation.controller.signal.aborted) {
				this.#restoreCancelled(operation);
				this.#settleOperation(operation, "cancelled");
				return;
			}
			this.#syncSourceStates(operation.operationId, true);
			for (const serverId of operation.serverIds) {
				if (!this.#canContinue(operation, serverId)) continue;
				if (!this.#source.getAllServerNames().includes(serverId)) {
					this.#transition(serverId, "disconnected", [], operation.operationId);
				}
			}
			this.#settleOperation(operation, "completed");
		} catch (cause) {
			if (operation.controller.signal.aborted) {
				this.#restoreCancelled(operation);
				this.#settleOperation(operation, "cancelled");
				return;
			}
			for (const serverId of operation.serverIds) {
				if (this.#canContinue(operation, serverId)) this.#transitionFailure(serverId, cause, operation.operationId);
			}
			this.#settleOperation(operation, "failed");
		}
	}

	#transitionFailure(serverId: string, cause: unknown, operationId: string): void {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		if (error instanceof RpcResourceAuthenticationRequiredError || analyzeAuthError(error).requiresAuth) {
			this.#transition(
				serverId,
				"authentication_required",
				[diagnostic("authentication_required", "Authentication is required", true)],
				operationId,
			);
			return;
		}
		this.#transition(
			serverId,
			"failed",
			[diagnostic("connection_failed", "Resource connection failed", true)],
			operationId,
		);
	}

	#syncSourceStates(operationId?: string, reactivateDisabled = false): void {
		for (const serverId of this.#source.getAllServerNames()) {
			const current = this.#states.get(serverId);
			if (current?.state === "disabled" && !reactivateDisabled) continue;
			if (current?.state === "disabled") this.#advanceGeneration(serverId);
			const sourceState = this.#source.getConnectionStatus(serverId);
			const hasActiveOperation = [...this.#operations.values()].some(
				operation => !operation.settled && operation.serverIds.includes(serverId),
			);
			const state: RpcResourceLifecycleState =
				hasActiveOperation && (current?.state === "connecting" || current?.state === "reconnecting")
					? current.state
					: sourceState === "connected"
						? "connected"
						: sourceState === "connecting"
							? "connecting"
							: current === undefined || current.state === "disabled"
								? "discovered"
								: current.state === "connected" ||
										current.state === "connecting" ||
										current.state === "reconnecting"
									? "disconnected"
									: current.state;
			this.#transition(
				serverId,
				state,
				current?.state === "disabled" ? [] : (current?.diagnostics ?? []),
				operationId,
			);
		}
	}

	#transition(
		serverId: string,
		state: RpcResourceLifecycleState,
		diagnostics: RpcResourceDiagnostic[],
		operationId?: string,
	): void {
		const boundedDiagnostics = diagnostics.slice(0, MAX_RESOURCE_DIAGNOSTICS);
		const previous = this.#states.get(serverId);
		if (previous?.state === state && sameDiagnostics(previous.diagnostics, boundedDiagnostics)) return;
		this.#states.set(serverId, { state, diagnostics: boundedDiagnostics });
		this.#revision++;
		this.#output({
			type: "resource_lifecycle",
			revision: this.#revision,
			serverId,
			state,
			...(previous === undefined ? {} : { previousState: previous.state }),
			...(operationId === undefined ? {} : { operationId }),
			diagnostics: boundedDiagnostics,
		});
	}

	#settleOperation(operation: ResourceOperation, outcome: "completed" | "cancelled" | "failed"): void {
		if (operation.settled) return;
		operation.settled = true;
		this.#operations.delete(operation.operationId);
		this.#output({
			type: "resource_operation",
			operationId: operation.operationId,
			...(operation.requestId === undefined ? {} : { requestId: operation.requestId }),
			kind: operation.kind,
			outcome,
			serverIds: [...operation.serverIds],
		});
	}

	#restoreCancelled(operation: ResourceOperation): void {
		for (const [serverId, previous] of operation.previous) {
			if (!this.#ownsGeneration(operation, serverId)) continue;
			this.#transition(
				serverId,
				previous.state,
				[diagnostic("operation_cancelled", "Resource operation was cancelled", true)],
				operation.operationId,
			);
		}
	}

	async #compensateStaleEffect(serverId: string): Promise<void> {
		try {
			await this.#source.disconnectServer(serverId);
		} catch {
			/* The owning dispose/drain path reports teardown failure. */
		}
	}

	async #serializeServerEffect<T>(serverId: string, effect: () => Promise<T>): Promise<T> {
		const previous = this.#serverEffects.get(serverId) ?? Promise.resolve();
		const tail = Promise.withResolvers<void>();
		this.#serverEffects.set(serverId, tail.promise);
		await previous;
		try {
			return await effect();
		} finally {
			tail.resolve();
			if (this.#serverEffects.get(serverId) === tail.promise) this.#serverEffects.delete(serverId);
		}
	}

	async #serializeServerEffects<T>(serverIds: readonly string[], effect: () => Promise<T>): Promise<T> {
		const ordered = [...new Set(serverIds)].sort();
		const acquire = (index: number): Promise<T> => {
			const serverId = ordered[index];
			return serverId === undefined ? effect() : this.#serializeServerEffect(serverId, () => acquire(index + 1));
		};
		return acquire(0);
	}

	#canContinue(operation: ResourceOperation, serverId: string): boolean {
		return !operation.settled && !operation.controller.signal.aborted && this.#ownsGeneration(operation, serverId);
	}

	#ownsGeneration(operation: ResourceOperation, serverId: string): boolean {
		return operation.generations.get(serverId) === this.#generation(serverId);
	}

	#generation(serverId: string): number {
		return this.#serverGenerations.get(serverId) ?? 0;
	}

	#advanceGeneration(serverId: string): void {
		this.#serverGenerations.set(serverId, this.#generation(serverId) + 1);
	}

	async #waitForTasks(): Promise<void> {
		while (this.#tasks.size > 0 || this.#serverEffects.size > 0) {
			await Promise.allSettled([...this.#tasks, ...this.#serverEffects.values()]);
		}
	}

	#projectServer(serverId: string): RpcResourceServerSnapshot {
		const record = this.#states.get(serverId);
		if (!record) throw new RpcResourceNotFoundError(serverId);
		const connection = this.#source.getConnection(serverId);
		const tools = this.#source
			.getTools()
			.filter(tool => tool.mcpServerName === serverId)
			.map(tool => ({
				name: safeText(tool.name),
				...(optionalSafeText(tool.description) === undefined
					? {}
					: { description: optionalSafeText(tool.description) }),
			}));
		const resourceState = this.#source.getServerResources(serverId);
		const resources = (resourceState?.resources ?? []).map(resource => ({
			uri: safeText(resource.uri),
			...(optionalSafeText(resource.name) === undefined ? {} : { name: optionalSafeText(resource.name) }),
			...(optionalSafeText(resource.description) === undefined
				? {}
				: { description: optionalSafeText(resource.description) }),
			...(optionalSafeText(resource.mimeType) === undefined
				? {}
				: { mediaType: optionalSafeText(resource.mimeType) }),
		}));
		const templates = (resourceState?.templates ?? []).map(template => ({
			uriTemplate: safeText(template.uriTemplate),
			...(optionalSafeText(template.name) === undefined ? {} : { name: optionalSafeText(template.name) }),
			...(optionalSafeText(template.description) === undefined
				? {}
				: { description: optionalSafeText(template.description) }),
			...(optionalSafeText(template.mimeType) === undefined
				? {}
				: { mediaType: optionalSafeText(template.mimeType) }),
		}));
		const prompts = (this.#source.getServerPrompts(serverId) ?? []).map(prompt => ({
			name: safeText(prompt.name),
			...(optionalSafeText(prompt.description) === undefined
				? {}
				: { description: optionalSafeText(prompt.description) }),
		}));
		return {
			serverId,
			kind: this.#source.getResourceKind?.(serverId) ?? "mcp",
			state: record.state,
			capabilities: {
				tools: connection?.capabilities.tools !== undefined,
				resources: connection?.capabilities.resources !== undefined,
				prompts: connection?.capabilities.prompts !== undefined,
			},
			tools: collection(tools),
			resources: collection(resources),
			resourceTemplates: collection(templates),
			prompts: collection(prompts),
			diagnostics: [...record.diagnostics],
		};
	}

	#assertKnown(serverId: string): void {
		if (!this.#states.has(serverId)) throw new RpcResourceNotFoundError(serverId);
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("RPC resource lifecycle manager is disposed");
		if (this.#draining) throw new Error("RPC resource lifecycle manager is draining");
	}
}
