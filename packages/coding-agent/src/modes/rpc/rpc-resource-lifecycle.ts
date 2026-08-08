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
	refreshLifecycle?(name: string): Promise<RpcResourceLifecycleState | undefined>;
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
	reconnectServer(name: string, options?: { manual?: boolean }): Promise<unknown | null>;
	refreshServerTools(name: string): Promise<void>;
	refreshServerResources(name: string): Promise<void>;
	refreshServerPrompts(name: string): Promise<void>;
	disconnectServer(name: string): Promise<void>;
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
	settled: boolean;
}

export class RpcResourceNotFoundError extends Error {
	readonly code = "resource_not_found";

	constructor(serverId: string) {
		super(`Resource server is not available in this session: ${serverId}`);
		this.name = "RpcResourceNotFoundError";
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
	readonly #source: RpcResourceManagerSource;
	readonly #output: (frame: RpcResourceLifecycleFrame) => void;
	readonly #states = new Map<string, ResourceStateRecord>();
	readonly #operations = new Map<string, ResourceOperation>();
	readonly #tasks = new Set<Promise<void>>();
	#revision = 0;
	#disposed = false;

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
		for (const id of serverIds) this.#assertKnown(id);
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
		if (!operation || operation.settled) return false;
		operation.controller.abort();
		for (const [serverId, previous] of operation.previous) {
			this.#transition(
				serverId,
				previous.state,
				[diagnostic("operation_cancelled", "Resource operation was cancelled", true)],
				operationId,
			);
		}
		this.#settleOperation(operation, "cancelled");
		return true;
	}

	async disposeServer(serverId: string, requestId?: string): Promise<RpcResourceServerSnapshot> {
		this.#assertActive();
		this.#syncSourceStates();
		this.#assertKnown(serverId);
		for (const operation of [...this.#operations.values()]) {
			if (operation.serverIds.includes(serverId)) this.cancel(operation.operationId);
		}
		const operationId = `resource_${Snowflake.next()}`;
		try {
			await this.#source.disconnectServer(serverId);
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

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const operation of [...this.#operations.values()]) this.cancel(operation.operationId);
	}

	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.#tasks]);
	}

	#startOperation(
		kind: "refresh" | "reload",
		serverIds: string[],
		requestId: string | undefined,
		run: (operation: ResourceOperation) => Promise<void>,
	): { operationId: string } {
		const operationId = `resource_${Snowflake.next()}`;
		const previous = new Map<string, ResourceStateRecord>();
		for (const serverId of serverIds) {
			const current = this.#states.get(serverId);
			if (!current) continue;
			previous.set(serverId, { state: current.state, diagnostics: [...current.diagnostics] });
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
		await Promise.allSettled(operation.serverIds.map(serverId => this.#refreshServer(operation, serverId)));
		if (!operation.settled) this.#settleOperation(operation, "completed");
	}

	async #refreshServer(operation: ResourceOperation, serverId: string): Promise<void> {
		try {
			const lifecycleState = await this.#source.refreshLifecycle?.(serverId);
			if (operation.controller.signal.aborted || operation.settled) return;
			if (lifecycleState !== undefined) {
				this.#transition(serverId, lifecycleState, [], operation.operationId);
				return;
			}
			if (this.#source.getConnectionStatus(serverId) !== "connected") {
				const connection = await this.#source.reconnectServer(serverId, { manual: true });
				if (operation.controller.signal.aborted || operation.settled) return;
				if (!connection) {
					this.#transition(
						serverId,
						"failed",
						[diagnostic("connection_failed", "Resource connection failed", true)],
						operation.operationId,
					);
					return;
				}
			}
			const refreshed = await Promise.allSettled([
				this.#source.refreshServerTools(serverId),
				this.#source.refreshServerResources(serverId),
				this.#source.refreshServerPrompts(serverId),
			]);
			if (operation.controller.signal.aborted || operation.settled) return;
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
		} catch (cause) {
			if (operation.controller.signal.aborted || operation.settled) return;
			this.#transitionFailure(serverId, cause, operation.operationId);
		}
	}

	async #runReload(operation: ResourceOperation, reload: () => Promise<void>): Promise<void> {
		try {
			await reload();
			if (operation.controller.signal.aborted || operation.settled) return;
			this.#syncSourceStates(operation.operationId);
			for (const serverId of operation.serverIds) {
				if (!this.#source.getAllServerNames().includes(serverId)) {
					this.#transition(serverId, "disconnected", [], operation.operationId);
				}
			}
			this.#settleOperation(operation, "completed");
		} catch (cause) {
			if (operation.controller.signal.aborted || operation.settled) return;
			for (const serverId of operation.serverIds) this.#transitionFailure(serverId, cause, operation.operationId);
			this.#settleOperation(operation, "failed");
		}
	}

	#transitionFailure(serverId: string, cause: unknown, operationId: string): void {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		if (analyzeAuthError(error).requiresAuth) {
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

	#syncSourceStates(operationId?: string): void {
		for (const serverId of this.#source.getAllServerNames()) {
			const current = this.#states.get(serverId);
			if (current?.state === "disabled") continue;
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
							: current === undefined
								? "discovered"
								: current.state === "connected" ||
										current.state === "connecting" ||
										current.state === "reconnecting"
									? "disconnected"
									: current.state;
			this.#transition(serverId, state, current?.diagnostics ?? [], operationId);
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
	}
}
