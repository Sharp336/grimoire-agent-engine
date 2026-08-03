import { createHash, randomBytes } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { isArkSchema, isZodSchema, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import type {
	ChatGptWebBindingCapability,
	ChatGptWebConnectorCapability,
	ChatGptWebIssueRequest,
	ChatGptWebOrchestration,
	ChatGptWebTurnIssue as ProviderTurnIssue,
} from "../provider/orchestration";
import type { ChatGptWebRuntimeAdmission, ChatGptWebRuntimeGate, ChatGptWebRuntimeReference } from "../provider/types";
import type {
	OmpBootstrapAuthority,
	OmpBrokerEndpoint,
	OmpConnectorBootstrap,
	OmpTunnelBootstrap,
	OmpTunnelProcessIdentity,
} from "./bootstrap";

const CONNECTOR_BRAND = Symbol("chatgpt-web.mcp-connector");
const ADMISSION_BRAND = Symbol("chatgpt-web.runtime-admission");
const REFERENCE_BRAND = Symbol("chatgpt-web.runtime-reference");
const BIND_TOOL_NAME = "chatgpt_web_bind_turn";
const DEFAULT_BATCH_WINDOW_MS = 15;
const DEFAULT_MAX_BINDINGS = 64;
const DEFAULT_MAX_INVOCATIONS = 256;
const MAX_RETIRED_HANDLES = 128;
const TOOL_ARGUMENT_VALIDATOR = new AjvJsonSchemaValidator();

export interface OmpMcpConnector {
	readonly connectorId: string;
	readonly sessionId: string;
	readonly runtimeEpoch: string;
	readonly sessionNonce: string;
	readonly __opaque: typeof CONNECTOR_BRAND;
}

export interface OmpTurnBinding {
	readonly sessionId: string;
	readonly turnId: string;
	readonly runtimeEpoch: string;
	readonly bindingId: string;
	readonly expiresAt: number;
	readonly declaredToolSetHash: string;
	readonly tools: readonly Tool[];
}

export interface OmpTurnIssue {
	readonly binding: OmpTurnBinding;
	readonly turnToken: string;
}
export interface OmpPreparedTunnelSpawn {
	readonly connectorBootstrap: OmpConnectorBootstrap;
	readonly tunnelBootstrap: OmpTunnelBootstrap;
	readonly tunnelAdmission: ChatGptWebRuntimeAdmission;
	readonly instanceNonce: string;
}

export interface OmpBindTurnTool {
	readonly name: typeof BIND_TOOL_NAME;
	readonly description: string;
	readonly inputSchema: {
		readonly type: "object";
		readonly required: readonly ["turnToken"];
		readonly properties: { readonly turnToken: { readonly type: "string" } };
		readonly additionalProperties: false;
	};
}

export type OmpMcpTool = Tool | OmpBindTurnTool;

export interface BrokerToolRequest {
	readonly callId: string;
	readonly wireName: string;
	readonly freeform: boolean;
	readonly arguments?: Record<string, unknown>;
	readonly input?: string;
}

export interface OmpTurnBroker {
	listen(): Promise<{ endpoint: OmpBrokerEndpoint; runtimeEpoch: string; lifecycleGeneration: number }>;
	prepareTunnelSpawn(): Promise<OmpPreparedTunnelSpawn>;
	abortTunnelSpawn(bootstrap: OmpConnectorBootstrap, admission: ChatGptWebRuntimeAdmission): Promise<void>;
	/** Resolves only after the authorized tunnel child has completed authenticated MCP attach. */
	waitForTunnelReady(process: OmpTunnelProcessIdentity, signal: AbortSignal, timeoutMs: number): Promise<void>;
	readonly gate: ChatGptWebRuntimeGate;
	authorizeTunnel(
		bootstrap: OmpConnectorBootstrap,
		process: OmpTunnelProcessIdentity,
		admission: ChatGptWebRuntimeAdmission,
	): Promise<void>;
	attachConnector(bootstrap: OmpConnectorBootstrap): Promise<OmpMcpConnector>;
	issue(binding: OmpTurnBinding, admission: ChatGptWebRuntimeAdmission): Promise<OmpTurnIssue>;
	claim(turnToken: string, connector: OmpMcpConnector): Promise<OmpTurnBinding>;
	listTools(connector: OmpMcpConnector): Promise<readonly OmpMcpTool[]>;
	nextInvocationBatch(
		bindingId: string,
		connector: OmpMcpConnector,
		signal?: AbortSignal,
	): Promise<readonly BrokerToolRequest[]>;
	resolveBatch(
		bindingId: string,
		connector: OmpMcpConnector,
		calls: readonly { callId: string; result: ToolResultMessage }[],
	): Promise<void>;
	release(bindingId: string, connector: OmpMcpConnector): Promise<void>;
	drain(): Promise<void>;
	close(): Promise<void>;
}

export interface OmpMcpInvocationGateway {
	invoke(
		connector: OmpMcpConnector,
		call: {
			callId: string;
			wireName: string;
			arguments?: Record<string, unknown>;
			input?: string;
		},
	): Promise<ToolResultMessage>;
	onToolsChanged(connector: OmpMcpConnector, listener: () => void): () => void;
	waitForConnector(bindingId: string, signal?: AbortSignal): Promise<OmpMcpConnector>;
	cancelBinding(bindingId: string): void;
	closeConnector(connector: OmpMcpConnector): Promise<void>;
}

interface GateHandleState {
	kind: string;
	epoch: string;
	generation: number;
	released: boolean;
}

function opaqueId(prefix: string): string {
	return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

/** Runtime gate shared by browser leases, turns, tunnel processes, bindings, and connectors. */
export class OmpRuntimeGate implements ChatGptWebRuntimeGate {
	readonly #admissions = new WeakMap<object, GateHandleState>();
	readonly #references = new WeakMap<object, GateHandleState>();
	readonly #active = new Set<GateHandleState>();
	#runtimeEpoch = opaqueId("epoch");
	#generation = 1;
	#draining = false;
	#drainWaiters = new Set<() => void>();

	get state(): { runtimeEpoch: string; lifecycleGeneration: number } {
		return { runtimeEpoch: this.#runtimeEpoch, lifecycleGeneration: this.#generation };
	}

	async admit(kind: "turn" | "tunnel"): Promise<ChatGptWebRuntimeAdmission> {
		if (this.#draining) throw new Error("ChatGPT Web runtime is draining");
		const handle = Object.freeze({
			runtimeEpoch: this.#runtimeEpoch,
			lifecycleGeneration: this.#generation,
			__opaque: ADMISSION_BRAND,
		});
		const state = { kind, epoch: this.#runtimeEpoch, generation: this.#generation, released: false };
		this.#admissions.set(handle, state);
		this.#active.add(state);
		return handle as unknown as ChatGptWebRuntimeAdmission;
	}

	retain(admission: ChatGptWebRuntimeAdmission, owner: string): ChatGptWebRuntimeReference {
		const source = this.#admissions.get(admission as object);
		if (!source || source.released) throw new Error("runtime admission is invalid or released");
		if (this.#draining || source.epoch !== this.#runtimeEpoch || source.generation !== this.#generation) {
			throw new Error("runtime admission is stale or draining");
		}
		const handle = Object.freeze({ __opaque: REFERENCE_BRAND });
		const state = { kind: owner, epoch: source.epoch, generation: source.generation, released: false };
		this.#references.set(handle, state);
		this.#active.add(state);
		return handle as unknown as ChatGptWebRuntimeReference;
	}

	release(handle: ChatGptWebRuntimeAdmission | ChatGptWebRuntimeReference): void {
		const state = this.#admissions.get(handle as object) ?? this.#references.get(handle as object);
		if (!state || state.released) throw new Error("runtime handle is invalid or already released");
		state.released = true;
		this.#active.delete(state);
		if (this.#active.size === 0) {
			for (const resolve of this.#drainWaiters) resolve();
			this.#drainWaiters.clear();
		}
	}

	async drain(): Promise<void> {
		this.#draining = true;
		if (this.#active.size === 0) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#drainWaiters.add(resolve);
		await promise;
	}

	async resume(): Promise<{ runtimeEpoch: string; lifecycleGeneration: number }> {
		if (!this.#draining) throw new Error("runtime must be drained before resume");
		if (this.#active.size !== 0) throw new Error("runtime still has active reservations");
		this.#runtimeEpoch = opaqueId("epoch");
		this.#generation += 1;
		this.#draining = false;
		return this.state;
	}
}

interface InvocationState {
	request: BrokerToolRequest;
	internalName: string;
	delivered: boolean;
	resolve: (result: ToolResultMessage) => void;
	reject: (error: Error) => void;
}

interface Waiter {
	resolve: (batch: readonly BrokerToolRequest[]) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface BindingState {
	binding: OmpTurnBinding;
	turnToken: string;
	reference: ChatGptWebRuntimeReference;
	connector?: ConnectorState;
	claimWaiters: Set<{
		resolve: (connector: OmpMcpConnector) => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}>;
	queued: string[];
	invocations: Map<string, InvocationState>;
	waiters: Set<Waiter>;
	outstandingBatch?: readonly string[];
	batchTimer?: ReturnType<typeof setTimeout>;
	expiryTimer?: ReturnType<typeof setTimeout>;
	released: boolean;
}

interface ConnectorState {
	handle: OmpMcpConnector;
	connection: object;
	reference: ChatGptWebRuntimeReference;
	binding?: BindingState;
	listeners: Set<() => void>;
	closed: boolean;
}

interface SpawnState {
	bootstrap: OmpConnectorBootstrap;
	admission: ChatGptWebRuntimeAdmission;
	admissionReleased: boolean;
	process?: OmpTunnelProcessIdentity;
	processReference?: ChatGptWebRuntimeReference;
	authorization: Promise<void>;
	resolveAuthorization: () => void;
	authorizationError?: Error;
	ready: {
		promise: Promise<void>;
		resolve: () => void;
		reject: (error: Error) => void;
	};
	authorized: boolean;
	attached: boolean;
	attaching: boolean;
	retired: boolean;
	connection?: object;
	connectionClose?: Promise<void>;
	connectionClosed: boolean;
	connector?: ConnectorState;
}

export interface OmpTurnBrokerOptions {
	readonly bootstrapAuthority: OmpBootstrapAuthority;
	readonly gate?: OmpRuntimeGate;
	readonly now?: () => number;
	readonly batchWindowMs?: number;
	readonly maxBindings?: number;
	readonly maxInvocations?: number;
}

const BIND_TOOL: OmpBindTurnTool = Object.freeze({
	name: BIND_TOOL_NAME,
	description: "Bind this MCP connector to the current OMP turn before invoking any turn tool.",
	inputSchema: Object.freeze({
		type: "object",
		required: Object.freeze(["turnToken"] as const),
		properties: Object.freeze({ turnToken: Object.freeze({ type: "string" as const }) }),
		additionalProperties: false,
	}),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value: unknown, path: string): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map((entry, index) => cloneJson(entry, `${path}[${index}]`));
	if (!isRecord(value)) throw new Error(`${path} is not canonical JSON`);
	const clone: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) clone[key] = cloneJson(value[key], `${path}.${key}`);
	return clone;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
	}
	return value;
}

function optional(value: unknown, present: boolean): Record<string, unknown> {
	return present ? { present: true, value } : { present: false };
}

const TOOL_KEYS: Record<string, true> = {
	name: true,
	description: true,
	parameters: true,
	strict: true,
	customFormat: true,
	customWireName: true,
	native: true,
	examples: true,
};

function canonicalTool(tool: Tool, index: number): { snapshot: Tool; hashValue: Record<string, unknown> } {
	if (!isRecord(tool)) throw new Error(`tool[${index}] is invalid`);
	for (const key of Object.keys(tool)) {
		if (!Object.hasOwn(TOOL_KEYS, key))
			throw new Error(`tool[${index}] contains unsupported provider-facing field: ${key}`);
	}
	if (typeof tool.name !== "string" || tool.name.trim() !== tool.name || tool.name.length === 0) {
		throw new Error(`tool[${index}].name is invalid`);
	}
	if (typeof tool.description !== "string") throw new Error(`tool[${index}].description is invalid`);
	if (tool.name === BIND_TOOL_NAME) throw new Error(`tool[${index}].name is reserved for MCP turn binding`);
	if (
		tool.native !== undefined &&
		(!isRecord(tool.native) || tool.native.type !== "computer" || Object.keys(tool.native).length !== 1)
	) {
		throw new Error(`tool[${index}].native is unsupported`);
	}
	if (
		tool.customFormat !== undefined &&
		(!isRecord(tool.customFormat) ||
			(tool.customFormat.syntax !== "lark" && tool.customFormat.syntax !== "regex") ||
			typeof tool.customFormat.definition !== "string" ||
			Object.keys(tool.customFormat).some(key => key !== "syntax" && key !== "definition"))
	) {
		throw new Error(`tool[${index}].customFormat is unsupported`);
	}
	if (
		tool.customWireName !== undefined &&
		(typeof tool.customWireName !== "string" || tool.customWireName.length === 0)
	) {
		throw new Error(`tool[${index}].customWireName is invalid`);
	}
	if (tool.customWireName === BIND_TOOL_NAME) {
		throw new Error(`tool[${index}].customWireName is reserved for MCP turn binding`);
	}
	const parameters =
		isArkSchema(tool.parameters) || isZodSchema(tool.parameters)
			? tool.parameters
			: cloneJson(tool.parameters, `tool[${index}].parameters`);
	const schema = cloneJson(toolWireSchema({ ...tool, parameters } as Tool), `tool[${index}].parameters`) as Record<
		string,
		unknown
	>;
	const examples = tool.examples === undefined ? undefined : cloneJson(tool.examples, `tool[${index}].examples`);
	const customFormat =
		tool.customFormat === undefined ? undefined : cloneJson(tool.customFormat, `tool[${index}].customFormat`);
	const native = tool.native === undefined ? undefined : cloneJson(tool.native, `tool[${index}].native`);
	const snapshot = deepFreeze({
		name: tool.name,
		description: tool.description,
		parameters: schema,
		...(Object.hasOwn(tool, "strict") ? { strict: tool.strict } : {}),
		...(Object.hasOwn(tool, "customWireName") ? { customWireName: tool.customWireName } : {}),
		...(customFormat !== undefined ? { customFormat } : {}),
		...(native !== undefined ? { native } : {}),
		...(examples !== undefined ? { examples } : {}),
	} as Tool);
	return {
		snapshot,
		hashValue: {
			kind: native !== undefined ? "native" : customFormat !== undefined ? "custom" : "function",
			name: tool.name,
			description: tool.description,
			parameters: schema,
			strict: optional(tool.strict, Object.hasOwn(tool, "strict")),
			customWireName: optional(tool.customWireName, Object.hasOwn(tool, "customWireName")),
			customFormat: optional(customFormat, Object.hasOwn(tool, "customFormat")),
			native: optional(native, Object.hasOwn(tool, "native")),
			examples: optional(examples, Object.hasOwn(tool, "examples")),
		},
	};
}

export function canonicalizeOmpTools(tools: readonly Tool[]): { tools: readonly Tool[]; hash: string } {
	if (!Array.isArray(tools)) throw new Error("turn tools must be an array");
	const names = new Set<string>();
	const aliases = new Set<string>();
	const hashValues: Record<string, unknown>[] = [];
	const snapshots = tools.map((tool, index) => {
		const canonical = canonicalTool(tool, index);
		if (names.has(canonical.snapshot.name)) throw new Error(`duplicate tool name: ${canonical.snapshot.name}`);
		names.add(canonical.snapshot.name);
		const alias = canonical.snapshot.customWireName;
		if (alias !== undefined) {
			if (aliases.has(alias)) throw new Error(`duplicate tool alias: ${alias}`);
			aliases.add(alias);
		}
		hashValues.push(canonical.hashValue);
		return canonical.snapshot;
	});
	const hash = createHash("sha256").update(JSON.stringify(hashValues)).digest("hex");
	return { tools: deepFreeze(snapshots), hash };
}

function resolveTool(tools: readonly Tool[], wireName: string): Tool | undefined {
	return tools.find(tool => tool.name === wireName) ?? tools.find(tool => tool.customWireName === wireName);
}

function assertWireKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) {
		throw new Error("native broker parameters are malformed");
	}
}

function wireStringParam(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new Error(`native broker ${key} is malformed`);
	return field;
}

export class OmpTurnBrokerImpl implements OmpTurnBroker, OmpMcpInvocationGateway {
	readonly gate: OmpRuntimeGate;
	readonly #authority: OmpBootstrapAuthority;
	readonly #now: () => number;
	readonly #batchWindowMs: number;
	readonly #maxBindings: number;
	readonly #maxInvocations: number;
	readonly #spawns = new WeakMap<OmpConnectorBootstrap, SpawnState>();
	readonly #liveSpawns = new Set<SpawnState>();
	readonly #connectors = new WeakMap<OmpMcpConnector, ConnectorState>();
	readonly #wireConnectors = new WeakMap<object, OmpMcpConnector>();
	readonly #liveConnectors = new Set<ConnectorState>();
	readonly #tokens = new Map<string, BindingState>();
	readonly #bindings = new Map<string, BindingState>();
	readonly #retiredTokens = new Set<string>();
	readonly #retiredBindings = new Set<string>();
	#listenPromise?: Promise<{ endpoint: OmpBrokerEndpoint; runtimeEpoch: string; lifecycleGeneration: number }>;
	#draining = false;
	#authorityClosed = false;
	#closed = false;

	constructor(options: OmpTurnBrokerOptions) {
		this.#authority = options.bootstrapAuthority;
		this.gate = options.gate ?? new OmpRuntimeGate();
		this.#now = options.now ?? Date.now;
		this.#batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
		this.#maxBindings = options.maxBindings ?? DEFAULT_MAX_BINDINGS;
		this.#maxInvocations = options.maxInvocations ?? DEFAULT_MAX_INVOCATIONS;
		this.#authority.bindBroker?.({
			attach: async bootstrap => {
				const connector = await this.attachConnector(bootstrap);
				this.#wireConnectors.set(connector, connector);
				return connector;
			},
			dispatch: async (wireConnector, method, params) => {
				const connector = this.#wireConnectors.get(wireConnector);
				if (!connector) throw new Error("native connector handle is invalid");
				switch (method) {
					case "claim":
						assertWireKeys(params, ["turnToken"]);
						return this.claim(wireStringParam(params, "turnToken"), connector);
					case "list_tools":
						assertWireKeys(params, []);
						return this.listTools(connector);
					case "invoke": {
						assertWireKeys(params, ["call"]);
						if (!isRecord(params.call)) throw new Error("native broker tool call is malformed");
						const call = params.call;
						assertWireKeys(call, ["callId", "wireName"], ["arguments", "input"]);
						const callId = wireStringParam(call, "callId");
						const wireName = wireStringParam(call, "wireName");
						if (call.arguments !== undefined && !isRecord(call.arguments)) {
							throw new Error("native broker tool arguments are malformed");
						}
						if (call.input !== undefined && typeof call.input !== "string") {
							throw new Error("native broker tool input is malformed");
						}
						return this.invoke(connector, {
							callId,
							wireName,
							...(call.arguments === undefined ? {} : { arguments: call.arguments }),
							...(call.input === undefined ? {} : { input: call.input }),
						});
					}
					case "release":
						assertWireKeys(params, ["bindingId"]);
						return this.release(wireStringParam(params, "bindingId"), connector);
				}
			},
			onToolsChanged: (wireConnector, listener) => {
				const connector = this.#wireConnectors.get(wireConnector);
				if (!connector) throw new Error("native connector handle is invalid");
				return this.onToolsChanged(connector, listener);
			},
			close: async wireConnector => {
				const connector = this.#wireConnectors.get(wireConnector);
				if (!connector) return;
				this.#wireConnectors.delete(wireConnector);
				await this.closeConnector(connector);
			},
		});
	}

	listen(): Promise<{ endpoint: OmpBrokerEndpoint; runtimeEpoch: string; lifecycleGeneration: number }> {
		if (this.#closed) return Promise.reject(new Error("broker is closed"));
		if (this.#listenPromise) return this.#listenPromise;
		const runtime = this.gate.state;
		this.#listenPromise = this.#authority.listen(runtime.runtimeEpoch).then(endpoint => {
			if (this.#closed || this.#draining) throw new Error("broker closed while listening");
			return { endpoint, ...runtime };
		});
		return this.#listenPromise;
	}

	async prepareTunnelSpawn(): Promise<OmpPreparedTunnelSpawn> {
		await this.listen();
		this.#assertRunning();
		const admission = await this.gate.admit("tunnel");
		let prepared: Awaited<ReturnType<OmpBootstrapAuthority["prepare"]>> | undefined;
		try {
			prepared = await this.#authority.prepare(admission.runtimeEpoch);
			if (this.#draining || this.#closed) throw new Error("broker drained during tunnel preparation");
			const authorizationGate = Promise.withResolvers<void>();
			const ready = Promise.withResolvers<void>();
			ready.promise.catch(() => undefined);
			const authorization = authorizationGate.promise;
			const resolveAuthorization = authorizationGate.resolve;
			const spawn: SpawnState = {
				bootstrap: prepared.connectorBootstrap,
				admission,
				admissionReleased: false,
				authorized: false,
				attached: false,
				attaching: false,
				retired: false,
				connectionClosed: false,
				authorization,
				resolveAuthorization,
				ready,
			};
			this.#spawns.set(prepared.connectorBootstrap, spawn);
			this.#liveSpawns.add(spawn);
			return {
				...prepared,
				tunnelAdmission: admission,
				instanceNonce: opaqueId("instance"),
			};
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			if (prepared && this.#authority.abortPrepared) {
				try {
					await this.#authority.abortPrepared(prepared.connectorBootstrap);
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			}
			this.gate.release(admission);
			if (cleanupErrors.length > 0) {
				throw new AggregateError([error, ...cleanupErrors], "tunnel preparation failed and cleanup failed");
			}
			throw error;
		}
	}
	async abortTunnelSpawn(bootstrap: OmpConnectorBootstrap, admission: ChatGptWebRuntimeAdmission): Promise<void> {
		const spawn = this.#spawns.get(bootstrap);
		if (!spawn || spawn.admission !== admission) {
			throw new Error("tunnel spawn abort is invalid or stale");
		}
		const cleanupError = await this.#rollbackSpawn(spawn);
		if (cleanupError) throw cleanupError;
	}

	async authorizeTunnel(
		bootstrap: OmpConnectorBootstrap,
		process: OmpTunnelProcessIdentity,
		admission: ChatGptWebRuntimeAdmission,
	): Promise<void> {
		this.#assertRunning();
		const spawn = this.#spawns.get(bootstrap);
		if (!spawn || spawn.retired || spawn.admission !== admission || spawn.authorized) {
			throw new Error("tunnel authorization is invalid or replayed");
		}
		if (admission.runtimeEpoch !== this.gate.state.runtimeEpoch) throw new Error("tunnel admission epoch mismatch");
		try {
			await this.#authority.authorize(bootstrap, process, admission.runtimeEpoch);
			if (this.#draining || this.#closed || spawn.retired)
				throw new Error("broker drained during tunnel authorization");
			spawn.process = process;
			spawn.processReference = this.gate.retain(admission, "tunnel-process");
			spawn.authorized = true;
			spawn.resolveAuthorization();
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			spawn.authorizationError = cause;
			spawn.resolveAuthorization();
			const cleanupError = await this.#rollbackSpawn(spawn);
			if (cleanupError) {
				throw new AggregateError([cause, cleanupError], "tunnel authorization and rollback failed");
			}
			throw cause;
		}
	}
	async waitForTunnelReady(process: OmpTunnelProcessIdentity, signal: AbortSignal, timeoutMs: number): Promise<void> {
		this.#assertRunning();
		if (!process || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
			throw new Error("Tunnel readiness request is invalid");
		}
		const spawn = [...this.#liveSpawns].find(candidate => candidate.process === process);
		if (!spawn || spawn.retired) throw new Error("Tunnel readiness identity is invalid or stale");
		if (spawn.attached) return;
		if (spawn.authorizationError) throw spawn.authorizationError;
		if (signal.aborted) throw new DOMException("Tunnel readiness wait was cancelled", "AbortError");
		let timer: ReturnType<typeof setTimeout> = setTimeout(() => undefined, 0);
		let onAbort: (() => void) | undefined;
		try {
			const aborted = new Promise<never>((_, reject) => {
				onAbort = () => reject(new DOMException("Tunnel readiness wait was cancelled", "AbortError"));
				signal.addEventListener("abort", onAbort, { once: true });
				timer = setTimeout(() => reject(new Error("Tunnel readiness timed out")), timeoutMs);
			});
			await Promise.race([spawn.ready.promise, aborted]);
		} finally {
			clearTimeout(timer);
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	async attachConnector(bootstrap: OmpConnectorBootstrap): Promise<OmpMcpConnector> {
		this.#assertRunning();
		const spawn = this.#spawns.get(bootstrap);
		if (!spawn || spawn.retired || spawn.attached || spawn.attaching) {
			throw new Error("connector bootstrap is invalid or consumed");
		}
		spawn.attaching = true;
		try {
			const attached = await this.#authority.attach(bootstrap, spawn.admission.runtimeEpoch);
			spawn.connection = attached.connection;
			if (spawn.retired) throw new Error("connector spawn retired during attach");
			await spawn.authorization;
			if (spawn.authorizationError) throw spawn.authorizationError;
			await this.#authority.currentPeer(attached.connection, spawn.admission.runtimeEpoch);
			if (this.#draining || this.#closed || spawn.retired) throw new Error("broker drained during connector attach");
			const reference = this.gate.retain(spawn.admission, "connector");
			const connector = Object.freeze({
				connectorId: attached.connectorId,
				sessionId: attached.sessionId,
				runtimeEpoch: spawn.admission.runtimeEpoch,
				sessionNonce: attached.sessionNonce,
				__opaque: CONNECTOR_BRAND,
			});
			const state: ConnectorState = {
				handle: connector,
				connection: attached.connection,
				reference,
				listeners: new Set(),
				closed: false,
			};
			this.#connectors.set(connector, state);
			this.#liveConnectors.add(state);
			spawn.connector = state;
			spawn.connection = undefined;
			spawn.attached = true;
			spawn.attaching = false;
			spawn.ready.resolve();
			if (!spawn.admissionReleased) {
				this.gate.release(spawn.admission);
				spawn.admissionReleased = true;
			}
			return connector;
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			const cleanupError = await this.#rollbackSpawn(spawn);
			if (cleanupError) throw new AggregateError([cause, cleanupError], "connector attach and rollback failed");
			throw cause;
		}
	}

	async issue(binding: OmpTurnBinding, admission: ChatGptWebRuntimeAdmission): Promise<OmpTurnIssue> {
		this.#assertRunning();
		this.#prune();
		if (this.#bindings.size >= this.#maxBindings) throw new Error("broker binding capacity exceeded");
		if (!binding || typeof binding !== "object") throw new Error("turn binding is invalid");
		if (!binding.sessionId || !binding.turnId || !binding.bindingId)
			throw new Error("turn binding identity is invalid");
		if (this.#bindings.has(binding.bindingId) || this.#retiredBindings.has(binding.bindingId)) {
			throw new Error("binding id is duplicate or retired");
		}
		if (!Number.isFinite(binding.expiresAt) || binding.expiresAt <= this.#now())
			throw new Error("turn binding is expired");
		if (binding.runtimeEpoch !== admission.runtimeEpoch || binding.runtimeEpoch !== this.gate.state.runtimeEpoch) {
			throw new Error("turn binding runtime epoch mismatch");
		}
		const canonical = canonicalizeOmpTools(binding.tools);
		if (binding.declaredToolSetHash !== canonical.hash) throw new Error("declared tool set hash mismatch");
		const reference = this.gate.retain(admission, "broker-binding");
		try {
			const frozenBinding = deepFreeze({ ...binding, tools: canonical.tools });
			const turnToken = opaqueId("turn");
			const state: BindingState = {
				binding: frozenBinding,
				turnToken,
				reference,
				queued: [],
				invocations: new Map(),
				waiters: new Set(),
				claimWaiters: new Set(),
				released: false,
			};
			state.expiryTimer = setTimeout(
				() => this.#expire(state, new Error("turn binding expired")),
				Math.max(1, binding.expiresAt - this.#now()),
			);
			this.#tokens.set(turnToken, state);
			this.#bindings.set(binding.bindingId, state);
			return { binding: frozenBinding, turnToken };
		} catch (error) {
			this.gate.release(reference);
			throw error;
		}
	}

	async claim(turnToken: string, connector: OmpMcpConnector): Promise<OmpTurnBinding> {
		const connectorState = await this.#connector(connector);
		this.#prune();
		const state = this.#tokens.get(turnToken);
		if (!state || state.released) {
			throw new Error(
				this.#retiredTokens.has(turnToken) ? "turn token is retired" : "turn token is invalid or expired",
			);
		}
		this.#assertBindingHash(state);
		if (state.connector) {
			if (state.connector !== connectorState) throw new Error("turn token is already bound to another connector");
			return state.binding;
		}
		if (connectorState.binding && connectorState.binding !== state)
			throw new Error("connector is already bound to another turn");
		state.connector = connectorState;
		connectorState.binding = state;
		for (const waiter of state.claimWaiters) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.resolve(connector);
		}
		state.claimWaiters.clear();
		this.#notify(connectorState);
		return state.binding;
	}

	async listTools(connector: OmpMcpConnector): Promise<readonly OmpMcpTool[]> {
		const connectorState = await this.#connector(connector);
		this.#prune();
		const state = connectorState.binding;
		if (!state || state.released) return [BIND_TOOL];
		this.#assertBindingHash(state);
		return state.binding.tools;
	}

	async invoke(
		connector: OmpMcpConnector,
		call: { callId: string; wireName: string; arguments?: Record<string, unknown>; input?: string },
	): Promise<ToolResultMessage> {
		const connectorState = await this.#connector(connector);
		this.#prune();
		const state = connectorState.binding;
		if (!state || state.released) throw new Error("connector must bind a turn before invoking tools");
		this.#assertBindingHash(state);
		if (typeof call.callId !== "string" || call.callId.length === 0 || call.callId.length > 256)
			throw new Error("tool call id is invalid");
		if (state.invocations.has(call.callId)) {
			this.#expire(state, new Error("duplicate tool call id"));
			throw new Error("duplicate tool call id");
		}
		if (state.invocations.size >= this.#maxInvocations) throw new Error("broker invocation capacity exceeded");
		const tool = resolveTool(state.binding.tools, call.wireName);
		if (!tool) throw new Error(`tool is not available in this turn: ${call.wireName}`);
		const freeform = tool.customFormat !== undefined;
		if (freeform) {
			if (typeof call.input !== "string" || call.arguments !== undefined)
				throw new Error("freeform tool input is invalid");
		} else {
			if (!isRecord(call.arguments) || call.input !== undefined) {
				throw new Error("structured tool arguments are invalid");
			}
			const validation = TOOL_ARGUMENT_VALIDATOR.getValidator(
				toolWireSchema({ ...tool, parameters: cloneJson(tool.parameters, "tool parameters") } as Tool),
			)(call.arguments);
			if (!validation.valid) {
				throw new Error(`structured tool arguments do not match the declared schema: ${validation.errorMessage}`);
			}
		}
		const request = deepFreeze({
			callId: call.callId,
			wireName: call.wireName,
			freeform,
			...(freeform
				? { input: call.input }
				: { arguments: cloneJson(call.arguments, "tool arguments") as Record<string, unknown> }),
		});
		const invocation = Promise.withResolvers<ToolResultMessage>();
		state.invocations.set(call.callId, {
			request,
			internalName: tool.name,
			delivered: false,
			resolve: invocation.resolve,
			reject: invocation.reject,
		});
		state.queued.push(call.callId);
		this.#scheduleWaiter(state);
		return invocation.promise;
	}

	async nextInvocationBatch(
		bindingId: string,
		connector: OmpMcpConnector,
		signal?: AbortSignal,
	): Promise<readonly BrokerToolRequest[]> {
		const connectorState = await this.#connector(connector);
		const state = this.#binding(bindingId, connectorState);
		if (state.outstandingBatch) throw new Error("previous invocation batch has not been resolved");
		const ready = this.#takeQueued(state);
		if (ready.length > 0) return ready;
		if (signal?.aborted) throw new DOMException("tool wait aborted", "AbortError");
		const waiting = Promise.withResolvers<readonly BrokerToolRequest[]>();
		const waiter: Waiter = { resolve: waiting.resolve, reject: waiting.reject, ...(signal ? { signal } : {}) };
		if (signal) {
			waiter.onAbort = () => {
				state.waiters.delete(waiter);
				waiting.reject(new DOMException("tool wait aborted", "AbortError"));
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		state.waiters.add(waiter);
		this.#scheduleWaiter(state);
		return waiting.promise;
	}
	async resolveBatch(
		bindingId: string,
		connector: OmpMcpConnector,
		calls: readonly { callId: string; result: ToolResultMessage }[],
	): Promise<void> {
		const connectorState = await this.#connector(connector);
		const state = this.#binding(bindingId, connectorState);
		const expected = state.outstandingBatch;
		if (!expected) throw new Error("no invocation batch is awaiting results");
		try {
			if (!Array.isArray(calls) || calls.length !== expected.length)
				throw new Error("tool result cardinality mismatch");
			const provided = new Set<string>();
			for (const call of calls) {
				if (
					!call ||
					typeof call.callId !== "string" ||
					provided.has(call.callId) ||
					!expected.includes(call.callId)
				) {
					throw new Error("tool result call ids do not exactly match the invocation batch");
				}
				provided.add(call.callId);
				const invocation = state.invocations.get(call.callId);
				if (!invocation?.delivered) throw new Error("tool result has no delivered invocation");
				if (
					call.result?.role !== "toolResult" ||
					call.result.toolCallId !== call.callId ||
					call.result.toolName !== invocation.internalName
				) {
					throw new Error("tool result metadata does not match the invocation");
				}
			}
			this.#assertBindingHash(state);
			state.outstandingBatch = undefined;
			for (const call of calls) {
				const invocation = state.invocations.get(call.callId)!;
				state.invocations.delete(call.callId);
				invocation.resolve(call.result);
			}
			this.#scheduleWaiter(state);
		} catch (error) {
			this.#expire(state, error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	async release(bindingId: string, connector: OmpMcpConnector): Promise<void> {
		const connectorState = await this.#connector(connector);
		const state = this.#binding(bindingId, connectorState);
		this.#expire(state, new Error("turn binding released"));
	}

	onToolsChanged(connector: OmpMcpConnector, listener: () => void): () => void {
		const state = this.#connectors.get(connector);
		if (!state || state.closed) throw new Error("connector handle is invalid or closed");
		state.listeners.add(listener);
		return () => state.listeners.delete(listener);
	}

	async waitForConnector(bindingId: string, signal?: AbortSignal): Promise<OmpMcpConnector> {
		this.#assertRunning();
		this.#prune();
		const state = this.#bindings.get(bindingId);
		if (!state || state.released) throw new Error("binding is invalid or expired");
		if (state.connector) return state.connector.handle;
		if (signal?.aborted) throw new DOMException("connector wait aborted", "AbortError");
		const waiting = Promise.withResolvers<OmpMcpConnector>();
		const waiter: {
			resolve: (connector: OmpMcpConnector) => void;
			reject: (error: Error) => void;
			signal?: AbortSignal;
			onAbort?: () => void;
		} = { resolve: waiting.resolve, reject: waiting.reject, ...(signal ? { signal } : {}) };
		if (signal) {
			waiter.onAbort = () => {
				state.claimWaiters.delete(waiter);
				waiting.reject(new DOMException("connector wait aborted", "AbortError"));
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		state.claimWaiters.add(waiter);
		return waiting.promise;
	}

	cancelBinding(bindingId: string): void {
		const state = this.#bindings.get(bindingId);
		if (state) this.#expire(state, new Error("turn binding cancelled"));
	}

	async closeConnector(connector: OmpMcpConnector): Promise<void> {
		const state = this.#connectors.get(connector);
		if (!state || state.closed) throw new Error("connector handle is invalid or closed");
		if (state.binding) this.#expire(state.binding, new Error("connector closed"));
		state.closed = true;
		state.listeners.clear();
		this.#liveConnectors.delete(state);
		try {
			await this.#authority.closeConnection(state.connection);
		} finally {
			this.gate.release(state.reference);
		}
	}

	async drain(): Promise<void> {
		if (this.#draining && this.#liveConnectors.size === 0 && this.#liveSpawns.size === 0 && this.#authorityClosed) {
			return this.gate.drain();
		}
		this.#draining = true;
		for (const state of [...this.#bindings.values()]) this.#expire(state, new Error("broker is draining"));
		const errors: unknown[] = [];
		try {
			await this.#closeConnectors();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, "broker drain failed");
		if (!this.#authorityClosed) {
			try {
				await this.#authority.close();
				this.#authorityClosed = true;
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "broker drain failed");
		try {
			await this.gate.drain();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, "broker drain failed");
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		await this.drain();
		this.#closed = true;
	}

	async #connector(handle: OmpMcpConnector): Promise<ConnectorState> {
		this.#assertRunning();
		const state = this.#connectors.get(handle);
		if (!state || state.closed || state.handle !== handle)
			throw new Error("connector handle is invalid, cloned, or closed");
		if (handle.runtimeEpoch !== this.gate.state.runtimeEpoch) throw new Error("connector runtime epoch mismatch");
		await this.#authority.currentPeer(state.connection, handle.runtimeEpoch);
		return state;
	}

	#binding(bindingId: string, connector: ConnectorState): BindingState {
		this.#prune();
		const state = this.#bindings.get(bindingId);
		if (!state || state.released) {
			throw new Error(this.#retiredBindings.has(bindingId) ? "binding is retired" : "binding is invalid or expired");
		}
		if (state.connector !== connector || connector.binding !== state)
			throw new Error("binding belongs to another connector");
		this.#assertBindingHash(state);
		return state;
	}

	#assertBindingHash(state: BindingState): void {
		if (state.binding.runtimeEpoch !== this.gate.state.runtimeEpoch)
			throw new Error("binding runtime epoch mismatch");
		const canonical = canonicalizeOmpTools(state.binding.tools);
		if (canonical.hash !== state.binding.declaredToolSetHash) {
			this.#expire(state, new Error("active tool declaration changed"));
			throw new Error("active tool declaration changed");
		}
	}

	#takeQueued(state: BindingState): readonly BrokerToolRequest[] {
		if (state.outstandingBatch || state.queued.length === 0) return [];
		const ids = state.queued.splice(0);
		for (const id of ids) {
			const invocation = state.invocations.get(id);
			if (invocation) invocation.delivered = true;
		}
		state.outstandingBatch = Object.freeze(ids);
		return Object.freeze(
			ids
				.map(id => state.invocations.get(id)?.request)
				.filter((request): request is BrokerToolRequest => request !== undefined),
		);
	}

	#scheduleWaiter(state: BindingState): void {
		if (
			state.released ||
			state.outstandingBatch ||
			state.queued.length === 0 ||
			state.waiters.size === 0 ||
			state.batchTimer
		)
			return;
		state.batchTimer = setTimeout(() => {
			state.batchTimer = undefined;
			if (state.released || state.outstandingBatch) return;
			const batch = this.#takeQueued(state);
			if (batch.length === 0) return;
			const waiters = [...state.waiters];
			state.waiters.clear();
			const first = waiters.shift();
			if (first) {
				this.#detachAbort(first);
				first.resolve(batch);
			}
			for (const waiter of waiters) {
				this.#detachAbort(waiter);
				waiter.reject(new Error("another waiter claimed the invocation batch"));
			}
		}, this.#batchWindowMs);
	}

	#detachAbort(waiter: Waiter): void {
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}

	#expire(state: BindingState, error: Error): void {
		if (state.released) return;
		state.released = true;
		if (state.batchTimer) clearTimeout(state.batchTimer);
		if (state.expiryTimer) clearTimeout(state.expiryTimer);
		this.#tokens.delete(state.turnToken);
		this.#bindings.delete(state.binding.bindingId);
		this.#retire(this.#retiredTokens, state.turnToken);
		this.#retire(this.#retiredBindings, state.binding.bindingId);
		for (const waiter of state.waiters) {
			this.#detachAbort(waiter);
			waiter.reject(error);
		}
		state.waiters.clear();
		for (const waiter of state.claimWaiters) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(error);
		}
		state.claimWaiters.clear();
		for (const invocation of state.invocations.values()) invocation.reject(error);
		state.invocations.clear();
		state.queued = [];
		state.outstandingBatch = undefined;
		if (state.connector) {
			const connector = state.connector;
			state.connector = undefined;
			if (connector.binding === state) connector.binding = undefined;
			this.#notify(connector);
		}
		this.gate.release(state.reference);
	}

	#notify(connector: ConnectorState): void {
		for (const listener of [...connector.listeners]) listener();
	}

	#retire(set: Set<string>, value: string): void {
		set.delete(value);
		set.add(value);
		while (set.size > MAX_RETIRED_HANDLES) set.delete(set.values().next().value!);
	}

	#prune(): void {
		const now = this.#now();
		for (const state of [...this.#bindings.values()]) {
			if (state.binding.expiresAt <= now) this.#expire(state, new Error("turn binding expired"));
		}
	}

	#assertRunning(): void {
		if (this.#closed) throw new Error("broker is closed");
		if (this.#draining) throw new Error("broker is draining");
	}

	async #rollbackSpawn(spawn: SpawnState): Promise<Error | undefined> {
		spawn.retired = true;
		spawn.attaching = false;
		spawn.ready.reject(spawn.authorizationError ?? new Error("Tunnel connector was closed before readiness"));
		if (!spawn.authorized) {
			spawn.authorizationError ??= new Error("Tunnel spawn was aborted before authorization");
			spawn.resolveAuthorization();
		}
		const cleanupErrors: Error[] = [];
		if (spawn.connection && !spawn.connectionClosed) {
			const closing = spawn.connectionClose ?? this.#authority.closeConnection(spawn.connection);
			spawn.connectionClose = closing;
			try {
				await closing;
				spawn.connectionClosed = true;
				spawn.connection = undefined;
				if (spawn.connectionClose === closing) spawn.connectionClose = undefined;
			} catch (error) {
				if (spawn.connectionClose === closing) spawn.connectionClose = undefined;
				cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (spawn.connector) {
			const connector = spawn.connector;
			spawn.connector = undefined;
			if (!connector.closed) {
				try {
					await this.closeConnector(connector.handle);
				} catch (error) {
					cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
				}
			}
		}
		if (this.#authority.abortPrepared) {
			try {
				await this.#authority.abortPrepared(spawn.bootstrap);
			} catch (error) {
				cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (spawn.processReference) {
			const reference = spawn.processReference;
			try {
				this.gate.release(reference);
				spawn.processReference = undefined;
			} catch (error) {
				cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (!spawn.admissionReleased) {
			try {
				this.gate.release(spawn.admission);
				spawn.admissionReleased = true;
			} catch (error) {
				cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (cleanupErrors.length === 0) {
			this.#liveSpawns.delete(spawn);
			return undefined;
		}
		return cleanupErrors.length === 1
			? cleanupErrors[0]
			: new AggregateError(cleanupErrors, "Tunnel spawn rollback failed");
	}

	async #closeConnectors(): Promise<void> {
		const errors: unknown[] = [];
		for (const state of [...this.#liveConnectors]) {
			state.closed = true;
			state.listeners.clear();
			this.#liveConnectors.delete(state);
			try {
				await this.#authority.closeConnection(state.connection);
			} catch (error) {
				errors.push(error);
			} finally {
				this.gate.release(state.reference);
			}
		}
		for (const spawn of [...this.#liveSpawns]) {
			if (!spawn.authorized && spawn.attaching) {
				spawn.authorizationError = new Error("broker drained before tunnel authorization");
				spawn.resolveAuthorization();
			}
			const error = await this.#rollbackSpawn(spawn);
			if (error) errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, "failed to close broker connectors");
	}
}

export function createOmpTurnBroker(options: OmpTurnBrokerOptions): OmpTurnBrokerImpl {
	return new OmpTurnBrokerImpl(options);
}

interface BrokerProviderIssueState {
	readonly brokerIssue: OmpTurnIssue;
	connector?: OmpMcpConnector;
	released: boolean;
}

export interface BrokerOrchestrationOptions {
	readonly ttlMs?: number;
	readonly now?: () => number;
}

/** Concrete full-mode adapter for the provider's package-owned orchestration boundary. */
export class BrokerOrchestration implements ChatGptWebOrchestration {
	readonly #broker: OmpTurnBrokerImpl;
	readonly #ttlMs: number;
	readonly #now: () => number;
	readonly #issues = new WeakMap<ProviderTurnIssue, BrokerProviderIssueState>();

	constructor(broker: OmpTurnBrokerImpl, options: BrokerOrchestrationOptions = {}) {
		this.#broker = broker;
		this.#ttlMs = options.ttlMs ?? 10 * 60_000;
		this.#now = options.now ?? Date.now;
	}

	async issue(request: ChatGptWebIssueRequest, admission: ChatGptWebRuntimeAdmission): Promise<ProviderTurnIssue> {
		if (!request.identity.sessionId || !request.identity.turnId) throw new Error("provider turn identity is invalid");
		const canonical = canonicalizeOmpTools(request.tools);
		const brokerIssue = await this.#broker.issue(
			{
				sessionId: request.identity.sessionId,
				turnId: request.identity.turnId,
				runtimeEpoch: admission.runtimeEpoch,
				bindingId: opaqueId("binding"),
				expiresAt: this.#now() + this.#ttlMs,
				declaredToolSetHash: canonical.hash,
				tools: canonical.tools,
			},
			admission,
		);
		const providerIssue = Object.freeze({
			turnToken: brokerIssue.turnToken,
			binding: Object.freeze({}) as ChatGptWebBindingCapability,
			connector: Object.freeze({}) as ChatGptWebConnectorCapability,
			expiresAt: brokerIssue.binding.expiresAt,
		});
		this.#issues.set(providerIssue, { brokerIssue, released: false });
		return providerIssue;
	}

	async nextInvocationBatch(issue: ProviderTurnIssue, signal?: AbortSignal): Promise<readonly BrokerToolRequest[]> {
		const state = this.#issue(issue);
		state.connector ??= await this.#broker.waitForConnector(state.brokerIssue.binding.bindingId, signal);
		return this.#broker.nextInvocationBatch(state.brokerIssue.binding.bindingId, state.connector, signal);
	}

	async resolveBatch(
		issue: ProviderTurnIssue,
		results: readonly { callId: string; result: ToolResultMessage }[],
	): Promise<void> {
		const state = this.#issue(issue);
		state.connector ??= await this.#broker.waitForConnector(state.brokerIssue.binding.bindingId);
		await this.#broker.resolveBatch(state.brokerIssue.binding.bindingId, state.connector, results);
	}

	async release(issue: ProviderTurnIssue): Promise<void> {
		const state = this.#issues.get(issue);
		if (!state || state.released) throw new Error("provider turn issue is invalid or already released");
		state.released = true;
		if (state.connector) await this.#broker.release(state.brokerIssue.binding.bindingId, state.connector);
		else this.#broker.cancelBinding(state.brokerIssue.binding.bindingId);
	}

	#issue(issue: ProviderTurnIssue): BrokerProviderIssueState {
		const state = this.#issues.get(issue);
		if (!state || state.released) throw new Error("provider turn issue is invalid or released");
		return state;
	}
}

export function createBrokerOrchestration(
	broker: OmpTurnBrokerImpl,
	options?: BrokerOrchestrationOptions,
): ChatGptWebOrchestration {
	return new BrokerOrchestration(broker, options);
}
