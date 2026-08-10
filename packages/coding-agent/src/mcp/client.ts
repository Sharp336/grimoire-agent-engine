/**
 * MCP Client.
 *
 * Handles connection initialization, tool listing, and tool calling.
 */
import * as path from "node:path";
import * as url from "node:url";
import { getProjectDir, isRecord, logger, withTimeout } from "@oh-my-pi/pi-utils";
import {
	LEGACY_PROTOCOL_VERSION,
	type MCPProtocolNegotiationResult,
	MODERN_PROTOCOL_VERSION,
	negotiateMCPProtocol,
} from "./protocol-negotiation";
import { describeMCPTimeout, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "./timeout";
import { createHttpTransport } from "./transports/http";
import {
	buildToolParameterHeaders,
	collectToolHeaderBindings,
	type MCPToolHeaderBinding,
} from "./transports/modern-http";
import { createSseTransport } from "./transports/sse";
import { createStdioTransport } from "./transports/stdio";
import type {
	MCPCacheableResult,
	MCPDiscoverResult,
	MCPGetPromptParams,
	MCPGetPromptResult,
	MCPHttpServerConfig,
	MCPImplementation,
	MCPInitializeParams,
	MCPInitializeResult,
	MCPInputRequiredResult,
	MCPPrompt,
	MCPPromptsListResult,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadParams,
	MCPResourceReadResult,
	MCPResourceSubscribeParams,
	MCPResourcesListResult,
	MCPResourceTemplate,
	MCPResourceTemplatesListResult,
	MCPResult,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPToolsListResult,
	MCPTransport,
} from "./types";
import { MCPError } from "./types";

const MAX_MRTR_ROUND_TRIPS = 8;
const SUBSCRIPTION_RESTART_INITIAL_DELAY_MS = 250;
const SUBSCRIPTION_RESTART_MAX_DELAY_MS = 10_000;

const CLIENT_INFO = {
	name: "omp-coding-agent",
	version: "1.0.0",
};
const MODERN_CLIENT_CAPABILITIES = { roots: {} };
const toolHeaderBindings = new WeakMap<MCPToolDefinition, MCPToolHeaderBinding[]>();

interface MCPHandshakeResult {
	protocolVersion: string;
	serverInfo: MCPImplementation;
	capabilities: MCPServerCapabilities;
	instructions?: string;
}
interface MCPSubscriptionFilter {
	toolsListChanged: boolean;
	promptsListChanged: boolean;
	resourcesListChanged: boolean;
	resourceSubscriptions: string[];
}

interface MCPSubscriptionState {
	abort: AbortController;
	requestId?: string | number;
	requested: MCPSubscriptionFilter;
	settled: boolean;
	resolve: (acceptedResourceUris: string[]) => void;
	reject: (error: Error) => void;
}

interface MCPConnectionRuntime {
	subscription?: MCPSubscriptionState;
	subscriptionRestart?: {
		timer?: NodeJS.Timeout;
		delayMs: number;
	};
	resourceSubscriptions: Set<string>;
	cacheScopes: Partial<
		Record<"tools" | "resources" | "resourceTemplates" | "prompts", "public" | "private" | "uncacheable">
	>;
	cacheExpires: Partial<Record<"tools" | "resources" | "resourceTemplates" | "prompts", number>>;
}

const connectionRuntimes = new WeakMap<MCPServerConnection, MCPConnectionRuntime>();

/**
 * Default handler for standard MCP server-to-client requests.
 * Handles `ping` and `roots/list`; rejects unknown methods with -32601.
 * Reads getProjectDir() at call time so the root stays stable even if
 * the process cwd changes during tool execution.
 */
async function defaultRequestHandler(method: string, _params: unknown): Promise<unknown> {
	switch (method) {
		case "ping":
			return {};
		case "roots/list": {
			const cwd = getProjectDir();
			return {
				roots: [{ uri: url.pathToFileURL(cwd).href, name: path.basename(cwd) }],
			};
		}
		default:
			throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
	}
}

/**
 * Create a transport for the given server config.
 */
async function createTransport(config: MCPServerConfig): Promise<MCPTransport> {
	const serverType = config.type ?? "stdio";

	switch (serverType) {
		case "stdio":
			return createStdioTransport(config as MCPStdioServerConfig);
		case "http":
			return createHttpTransport(config as MCPHttpServerConfig);
		case "sse":
			return createSseTransport(config as MCPSseServerConfig);
		default:
			throw new Error(`Unknown server type: ${serverType}`);
	}
}

function withModernRequestMeta(params: Record<string, unknown> = {}): Record<string, unknown> {
	const existingMeta = isRecord(params._meta) ? params._meta : {};
	return {
		...params,
		_meta: {
			...existingMeta,
			"io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
			"io.modelcontextprotocol/clientInfo": CLIENT_INFO,
			"io.modelcontextprotocol/clientCapabilities": MODERN_CLIENT_CAPABILITIES,
		},
	};
}

type ToolHeaderBindingResult = {
	valid: boolean;
	bindings?: MCPToolHeaderBinding[];
};

function resolveToolHeaderBindings(connection: MCPServerConnection, tool: MCPToolDefinition): ToolHeaderBindingResult {
	if (connection.protocolVersion !== MODERN_PROTOCOL_VERSION || connection.config.type !== "http") {
		return { valid: true };
	}

	const cached = toolHeaderBindings.get(tool);
	if (cached) return { valid: true, bindings: cached };

	const validation = collectToolHeaderBindings(tool.inputSchema);
	if (validation.error) {
		logger.warn("Ignoring invalid MCP tool definition", {
			server: connection.name,
			tool: tool.name,
			error: validation.error,
		});
		return { valid: false };
	}
	toolHeaderBindings.set(tool, validation.bindings);
	return { valid: true, bindings: validation.bindings };
}

function modernServerInfo(name: string, result: MCPDiscoverResult): MCPImplementation {
	const value = result._meta?.["io.modelcontextprotocol/serverInfo"];
	if (isRecord(value) && typeof value.name === "string" && typeof value.version === "string") {
		return { name: value.name, version: value.version };
	}
	return { name, version: "unknown" };
}

async function initializeConnection(
	name: string,
	transport: MCPTransport,
	negotiation: MCPProtocolNegotiationResult,
	options?: {
		signal?: AbortSignal;
		onLegacyInitialized?: () => void | Promise<void>;
	},
): Promise<MCPHandshakeResult> {
	if (negotiation.kind === "modern") {
		return {
			protocolVersion: MODERN_PROTOCOL_VERSION,
			serverInfo: modernServerInfo(name, negotiation.discovery),
			capabilities: negotiation.discovery.capabilities,
			instructions: negotiation.discovery.instructions,
		};
	}

	const params: MCPInitializeParams = {
		protocolVersion: LEGACY_PROTOCOL_VERSION,
		capabilities: {
			roots: { listChanged: false },
		},
		clientInfo: CLIENT_INFO,
	};
	const result = await transport.request<MCPInitializeResult>(
		"initialize",
		params as unknown as Record<string, unknown>,
		{ signal: options?.signal },
	);
	if (options?.signal?.aborted) {
		throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
	}
	await options?.onLegacyInitialized?.();
	await transport.notify("notifications/initialized");
	return {
		protocolVersion: result.protocolVersion,
		serverInfo: result.serverInfo,
		capabilities: result.capabilities,
		instructions: result.instructions,
	};
}

async function fulfillInputRequests(
	connection: MCPServerConnection,
	result: MCPInputRequiredResult,
	method: string,
): Promise<Record<string, unknown> | undefined> {
	if (result.requestState !== undefined && typeof result.requestState !== "string") {
		throw new Error(`MCP server returned invalid requestState while processing ${method}`);
	}
	if (result.inputRequests === undefined) {
		if (result.requestState === undefined) {
			throw new Error(`MCP server returned input_required without inputRequests or requestState for ${method}`);
		}
		return undefined;
	}
	if (!isRecord(result.inputRequests)) {
		throw new Error(`MCP server returned invalid inputRequests while processing ${method}`);
	}
	if (Object.keys(result.inputRequests).length === 0 && result.requestState === undefined) {
		throw new Error(`MCP server returned input_required without inputRequests or requestState for ${method}`);
	}
	const handler = connection.transport.onRequest;
	if (!handler && Object.keys(result.inputRequests).length > 0) {
		throw new Error(`MCP server requires unsupported client input while processing ${method}`);
	}
	const entries = await Promise.all(
		Object.entries(result.inputRequests).map(async ([id, request]) => {
			if (!isRecord(request) || typeof request.method !== "string") {
				throw new Error(`MCP server returned an invalid input request while processing ${method}`);
			}
			if (request.method !== "roots/list") {
				throw new Error(
					`MCP server requested unsupported client input "${request.method}" while processing ${method}`,
				);
			}
			if (request.params !== undefined && !isRecord(request.params)) {
				throw new Error(`MCP server returned invalid input request params while processing ${method}`);
			}
			return [id, await handler!(request.method, request.params)] as const;
		}),
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

async function requestFromServer<T>(
	connection: MCPServerConnection,
	method: string,
	params: Record<string, unknown> = {},
	options?: MCPRequestOptions,
): Promise<T> {
	if (connection.protocolVersion !== MODERN_PROTOCOL_VERSION) {
		return connection.transport.request<T>(method, params, options);
	}
	let requestParams = withModernRequestMeta(params);
	for (let round = 0; round < MAX_MRTR_ROUND_TRIPS; round++) {
		const result = await connection.transport.request<T>(method, requestParams, options);
		if (!isRecord(result) || typeof result.resultType !== "string") {
			throw new Error(`MCP server returned an invalid ${MODERN_PROTOCOL_VERSION} result for ${method}`);
		}
		if (result.resultType === "complete") return result;
		if (result.resultType !== "input_required") {
			throw new Error(`MCP server returned unsupported result type "${result.resultType}" for ${method}`);
		}
		if (method !== "tools/call" && method !== "prompts/get" && method !== "resources/read") {
			throw new Error(`MCP server returned input_required for unsupported method ${method}`);
		}
		const inputRequired = result as unknown as MCPInputRequiredResult;
		const inputResponses = await fulfillInputRequests(connection, inputRequired, method);
		requestParams = withModernRequestMeta({
			...params,
			...(inputResponses === undefined ? {} : { inputResponses }),
			...(inputRequired.requestState === undefined ? {} : { requestState: inputRequired.requestState }),
		});
	}
	throw new Error(`MCP server exceeded ${MAX_MRTR_ROUND_TRIPS} input-required rounds for ${method}`);
}

function cacheIsFresh(
	connection: MCPServerConnection,
	key: "tools" | "resources" | "resourceTemplates" | "prompts",
): boolean {
	const expires = connectionRuntimes.get(connection)?.cacheExpires[key];
	return expires === undefined || expires > Date.now();
}

function updateCacheExpiry(
	connection: MCPServerConnection,
	key: "tools" | "resources" | "resourceTemplates" | "prompts",
	result: MCPCacheableResult,
): void {
	const runtime = connectionRuntimes.get(connection);
	if (!runtime) return;
	const ttlMs =
		connection.protocolVersion === MODERN_PROTOCOL_VERSION
			? typeof result.ttlMs === "number"
				? Math.max(0, result.ttlMs)
				: 0
			: Number.POSITIVE_INFINITY;
	const expires = ttlMs === Number.POSITIVE_INFINITY ? ttlMs : Date.now() + ttlMs;
	runtime.cacheExpires[key] = Math.min(runtime.cacheExpires[key] ?? Number.POSITIVE_INFINITY, expires);
	if (connection.protocolVersion === MODERN_PROTOCOL_VERSION) {
		const scope = result.cacheScope ?? "uncacheable";
		const previousScope = runtime.cacheScopes[key];
		runtime.cacheScopes[key] = previousScope === undefined ? scope : previousScope === scope ? scope : "uncacheable";
	}
}

export function getToolCachePolicy(
	connection: MCPServerConnection,
): { ttlMs?: number; cacheScope?: "public" | "private" } | undefined {
	if (connection.protocolVersion !== MODERN_PROTOCOL_VERSION) return undefined;
	const runtime = connectionRuntimes.get(connection);
	const expires = runtime?.cacheExpires.tools;
	return {
		ttlMs:
			expires === undefined || expires === Number.POSITIVE_INFINITY ? undefined : Math.max(0, expires - Date.now()),
		cacheScope:
			runtime?.cacheScopes.tools === "public" || runtime?.cacheScopes.tools === "private"
				? runtime.cacheScopes.tools
				: undefined,
	};
}

function clearSubscriptionState(connection: MCPServerConnection, state: MCPSubscriptionState): void {
	const runtime = connectionRuntimes.get(connection);
	if (runtime?.subscription === state) runtime.subscription = undefined;
}

function settleSubscriptionError(connection: MCPServerConnection, state: MCPSubscriptionState, error: Error): void {
	if (state.settled) return;
	state.abort.abort(error);
	state.settled = true;
	state.reject(error);
	clearSubscriptionState(connection, state);
}
function clearScheduledSubscriptionRestart(runtime: MCPConnectionRuntime): void {
	const restart = runtime.subscriptionRestart;
	if (!restart) return;
	if (restart.timer !== undefined) clearTimeout(restart.timer);
	restart.timer = undefined;
}

function scheduleSubscriptionRestart(connection: MCPServerConnection): void {
	const runtime = connectionRuntimes.get(connection);
	if (!runtime || runtime.subscription || !connection.transport.connected) return;
	const restart = runtime.subscriptionRestart ?? { delayMs: SUBSCRIPTION_RESTART_INITIAL_DELAY_MS };
	if (restart.timer !== undefined) return;
	const delayMs = restart.delayMs;
	restart.delayMs = Math.min(delayMs * 2, SUBSCRIPTION_RESTART_MAX_DELAY_MS);
	restart.timer = setTimeout(() => {
		restart.timer = undefined;
		if (
			runtime.subscriptionRestart !== restart ||
			runtime.subscription !== undefined ||
			!connection.transport.connected
		) {
			return;
		}
		void startModernSubscriptionListener(connection).catch(error => {
			logger.debug("MCP subscription restart failed", { server: connection.name, error });
		});
	}, delayMs);
	runtime.subscriptionRestart = restart;
}

function finishSubscriptionListener(
	connection: MCPServerConnection,
	state: MCPSubscriptionState,
	restart: boolean,
): void {
	const runtime = connectionRuntimes.get(connection);
	if (!runtime || runtime.subscription !== state) return;
	runtime.subscription = undefined;
	if (restart && !state.abort.signal.aborted && connection.transport.connected) {
		scheduleSubscriptionRestart(connection);
	}
}

function handleSubscriptionAcknowledgment(connection: MCPServerConnection, method: string, params: unknown): void {
	if (method !== "notifications/subscriptions/acknowledged") return;
	const runtime = connectionRuntimes.get(connection);
	const state = runtime?.subscription;
	if (!runtime || !state || !isRecord(params) || !isRecord(params._meta)) return;
	const subscriptionId = params._meta["io.modelcontextprotocol/subscriptionId"];
	if (state.requestId === undefined || subscriptionId === undefined || subscriptionId !== state.requestId) return;
	if (!isRecord(params.notifications)) {
		settleSubscriptionError(
			connection,
			state,
			new Error("MCP server returned an invalid subscription acknowledgment"),
		);
		return;
	}
	for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"] as const) {
		const accepted = params.notifications[key];
		if (
			(accepted !== undefined && typeof accepted !== "boolean") ||
			(accepted === true && state.requested[key] !== true)
		) {
			settleSubscriptionError(
				connection,
				state,
				new Error("MCP server acknowledged an invalid subscription filter"),
			);
			return;
		}
	}
	const acceptedValue = params.notifications.resourceSubscriptions;
	const accepted =
		acceptedValue === undefined
			? []
			: Array.isArray(acceptedValue) && acceptedValue.every(uri => typeof uri === "string")
				? acceptedValue
				: undefined;
	if (!accepted || accepted.some(uri => !state.requested.resourceSubscriptions.includes(uri))) {
		settleSubscriptionError(connection, state, new Error("MCP server acknowledged an invalid subscription filter"));
		return;
	}
	if (state.settled) return;
	runtime.resourceSubscriptions = new Set(accepted);
	state.settled = true;
	state.resolve(accepted);
}

async function startModernSubscriptionListener(
	connection: MCPServerConnection,
	options?: MCPRequestOptions,
): Promise<string[]> {
	if (connection.protocolVersion !== MODERN_PROTOCOL_VERSION) return [];
	const runtime = connectionRuntimes.get(connection);
	if (!runtime) return [];
	clearScheduledSubscriptionRestart(runtime);
	const previous = runtime.subscription;
	if (previous) {
		previous.abort.abort();
		settleSubscriptionError(connection, previous, new Error("MCP subscription was replaced"));
	}
	const notifications: MCPSubscriptionFilter = {
		toolsListChanged: connection.capabilities.tools?.listChanged === true,
		promptsListChanged: connection.capabilities.prompts?.listChanged === true,
		resourcesListChanged: connection.capabilities.resources?.listChanged === true,
		resourceSubscriptions: [...runtime.resourceSubscriptions],
	};
	if (
		!notifications.toolsListChanged &&
		!notifications.promptsListChanged &&
		!notifications.resourcesListChanged &&
		notifications.resourceSubscriptions.length === 0
	) {
		runtime.subscription = undefined;
		return [];
	}
	const abort = new AbortController();
	const acknowledged = Promise.withResolvers<string[]>();
	const state: MCPSubscriptionState = {
		abort,
		requested: notifications,
		settled: false,
		resolve: acknowledged.resolve,
		reject: acknowledged.reject,
	};
	runtime.subscription = state;
	const acknowledgmentTimeoutMs = resolveMCPTimeoutMs(options?.timeout ?? connection.config.timeout);
	let acknowledgmentTimer: NodeJS.Timeout | undefined;
	const abortAcknowledgment = (): void => {
		const reason = options?.signal?.reason;
		settleSubscriptionError(
			connection,
			state,
			reason instanceof Error ? reason : new Error("MCP subscription aborted"),
		);
	};
	if (options?.signal?.aborted) {
		abortAcknowledgment();
	} else {
		options?.signal?.addEventListener("abort", abortAcknowledgment, { once: true });
		if (isMCPTimeoutEnabled(acknowledgmentTimeoutMs)) {
			acknowledgmentTimer = setTimeout(() => {
				settleSubscriptionError(
					connection,
					state,
					new Error(
						`MCP subscription acknowledgment timed out after ${describeMCPTimeout(acknowledgmentTimeoutMs)}`,
					),
				);
			}, acknowledgmentTimeoutMs);
		}
	}
	void requestFromServer<MCPResult>(
		connection,
		"subscriptions/listen",
		{ notifications },
		{
			signal: abort.signal,
			timeout: 0,
			onRequestId: id => {
				state.requestId = id;
			},
		},
	)
		.then(() => {
			if (!state.settled) {
				settleSubscriptionError(connection, state, new Error("MCP subscription ended before acknowledgment"));
			} else {
				// The request stream can complete after its acknowledgment. It is no
				// longer a live listener, so restore it through bounded backoff.
				finishSubscriptionListener(connection, state, true);
			}
		})
		.catch(error => {
			if (!state.settled && !abort.signal.aborted) {
				logger.warn("MCP subscription listener stopped", { server: connection.name, error });
			}
			if (!state.settled) {
				settleSubscriptionError(connection, state, error instanceof Error ? error : new Error(String(error)));
			} else {
				// A closed SSE stream reports as a rejected request when it has no
				// JSON-RPC response. Once acknowledged, that is a normal end.
				finishSubscriptionListener(connection, state, true);
			}
		});
	return acknowledged.promise.finally(() => {
		clearTimeout(acknowledgmentTimer);
		options?.signal?.removeEventListener("abort", abortAcknowledgment);
	});
}

/**
 * Connect to an MCP server.
 * Has a 30 second timeout by default to prevent blocking startup.
 * Set OMP_MCP_TIMEOUT_MS=0 to disable MCP client-side timeouts.
 */
export async function connectToServer(
	name: string,
	config: MCPServerConfig,
	options?: {
		signal?: AbortSignal;
		onNotification?: (method: string, params: unknown) => void;
		onRequest?: (method: string, params: unknown) => Promise<unknown>;
	},
): Promise<MCPServerConnection> {
	const timeoutMs = resolveMCPTimeoutMs(config.timeout);
	let transport: MCPTransport | undefined;

	const protocolMode = config.protocolMode ?? "legacy";
	const connect = async (): Promise<MCPServerConnection> => {
		let negotiation: MCPProtocolNegotiationResult | undefined;
		if (protocolMode === "auto" && (config.type ?? "stdio") === "stdio") {
			const probe = await createStdioTransport(config as MCPStdioServerConfig);
			try {
				negotiation = await negotiateMCPProtocol(probe, {
					name,
					mode: protocolMode,
					transportType: "stdio",
					timeoutMs,
					signal: options?.signal,
					modernParams: withModernRequestMeta(),
				});
			} finally {
				await probe.close();
			}
		}
		transport = await createTransport(config);
		let connectionForNotifications: MCPServerConnection | undefined;
		transport.onNotification = (method, params) => {
			if (connectionForNotifications) {
				handleSubscriptionAcknowledgment(connectionForNotifications, method, params);
			}
			options?.onNotification?.(method, params);
		};

		// Always handle standard MCP server-to-client requests (ping, roots/list).
		// The initialize request declares roots capability, so we must respond to
		// roots/list — even for short-lived test connections.
		transport.onRequest = options?.onRequest ?? defaultRequestHandler;

		try {
			negotiation ??= await negotiateMCPProtocol(transport, {
				name,
				mode: protocolMode,
				transportType: config.type ?? "stdio",
				timeoutMs,
				signal: options?.signal,
				modernParams: withModernRequestMeta(),
			});
			const handshake = await initializeConnection(name, transport, negotiation, {
				signal: options?.signal,
				async onLegacyInitialized() {
					if ("startSSEListener" in transport! && typeof transport!.startSSEListener === "function") {
						await (transport as { startSSEListener(): Promise<void> }).startSSEListener();
					}
				},
			});
			const connection: MCPServerConnection = {
				name,
				config,
				transport,
				serverInfo: handshake.serverInfo,
				capabilities: handshake.capabilities,
				instructions: handshake.instructions,
				protocolVersion: handshake.protocolVersion,
			};
			connectionRuntimes.set(connection, { resourceSubscriptions: new Set(), cacheExpires: {}, cacheScopes: {} });
			connectionForNotifications = connection;
			void startModernSubscriptionListener(connection).catch(error => {
				logger.warn("MCP subscription acknowledgment failed", { server: connection.name, error });
			});
			return connection;
		} catch (error) {
			await transport.close();
			throw error;
		}
	};

	try {
		if (!isMCPTimeoutEnabled(timeoutMs)) {
			return await connect();
		}
		return await withTimeout(
			connect(),
			timeoutMs,
			`Connection to MCP server "${name}" timed out after ${describeMCPTimeout(timeoutMs)}`,
			options?.signal,
		);
	} catch (error) {
		// If withTimeout rejected (timeout/abort) while connect() was still pending,
		// the transport may be alive with an open SSE listener. Close it.
		if (transport) {
			void transport.close().catch(() => {});
		}
		throw error;
	}
}

/**
 * List tools from a connected server.
 */
export async function listTools(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPToolDefinition[]> {
	// Check if server supports tools
	if (!connection.capabilities.tools) {
		return [];
	}

	// Return cached tools if available
	if (connection.tools && cacheIsFresh(connection, "tools")) {
		return connection.tools;
	}
	connection.tools = undefined;
	delete connectionRuntimes.get(connection)?.cacheExpires.tools;
	delete connectionRuntimes.get(connection)?.cacheScopes.tools;

	const allTools: MCPToolDefinition[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await requestFromServer<MCPToolsListResult>(connection, "tools/list", params, options);
		updateCacheExpiry(connection, "tools", result);
		for (const tool of result.tools) {
			if (!resolveToolHeaderBindings(connection, tool).valid) continue;
			allTools.push(tool);
		}
		cursor = result.nextCursor;
	} while (cursor);

	// Cache tools
	connection.tools = allTools;

	return allTools;
}

/**
 * Call a tool on a connected server.
 */
export async function callTool(
	connection: MCPServerConnection,
	toolName: string,
	args: Record<string, unknown> = {},
	options?: MCPRequestOptions,
	toolDefinition?: MCPToolDefinition,
): Promise<MCPToolCallResult> {
	const params: MCPToolCallParams = {
		name: toolName,
		arguments: args,
	};

	const tool = toolDefinition ?? connection.tools?.find(candidate => candidate.name === toolName);
	const bindings = tool ? resolveToolHeaderBindings(connection, tool).bindings : undefined;
	const generatedHeaders = bindings ? buildToolParameterHeaders(bindings, args) : undefined;
	return requestFromServer<MCPToolCallResult>(
		connection,
		"tools/call",
		params as unknown as Record<string, unknown>,
		generatedHeaders ? { ...options, generatedHeaders } : options,
	);
}

/**
 * Disconnect from a server.
 */
export async function disconnectServer(connection: MCPServerConnection): Promise<void> {
	const runtime = connectionRuntimes.get(connection);
	if (runtime) {
		clearScheduledSubscriptionRestart(runtime);
		runtime.subscriptionRestart = undefined;
		const subscription = runtime.subscription;
		if (subscription) {
			subscription.abort.abort();
			settleSubscriptionError(connection, subscription, new Error("MCP connection closed"));
			clearSubscriptionState(connection, subscription);
		}
	}
	await connection.transport.close();
}

/**
 * Check if a server supports tools.
 */
export function serverSupportsTools(capabilities: MCPServerCapabilities): boolean {
	return capabilities.tools !== undefined;
}

/**
 * List resources from a connected server.
 */
export async function listResources(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResource[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resources && cacheIsFresh(connection, "resources")) {
		return connection.resources;
	}
	connection.resources = undefined;
	delete connectionRuntimes.get(connection)?.cacheExpires.resources;
	delete connectionRuntimes.get(connection)?.cacheScopes.resources;

	const allResources: MCPResource[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await requestFromServer<MCPResourcesListResult>(connection, "resources/list", params, options);
		updateCacheExpiry(connection, "resources", result);
		allResources.push(...result.resources);
		cursor = result.nextCursor;
	} while (cursor);

	connection.resources = allResources;
	return allResources;
}

/** True when an error is a JSON-RPC "method not found" (-32601) response. */
function isMethodNotFoundError(error: unknown): boolean {
	if (error instanceof MCPError) return error.code === -32601;
	const message = error instanceof Error ? error.message : String(error);
	return /method not found/i.test(message);
}
/**
 * List resource templates from a connected server.
 *
 * A server MAY advertise the `resources` capability without implementing the
 * optional `resources/templates/list` method (it is optional in the MCP spec).
 * Such servers reject the request with JSON-RPC -32601 ("Method not found").
 * Treat that as "no templates" and return `[]` rather than throwing — otherwise
 * a caller that loads resources and templates together (see `MCPManager`'s
 * `Promise.all([listResources, listResourceTemplates])`) would discard the
 * server's concrete resources too. Any other error still propagates.
 */
export async function listResourceTemplates(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResourceTemplate[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resourceTemplates && cacheIsFresh(connection, "resourceTemplates")) {
		return connection.resourceTemplates;
	}
	connection.resourceTemplates = undefined;
	delete connectionRuntimes.get(connection)?.cacheExpires.resourceTemplates;
	delete connectionRuntimes.get(connection)?.cacheScopes.resourceTemplates;

	const allTemplates: MCPResourceTemplate[] = [];
	let cursor: string | undefined;

	try {
		do {
			const params: Record<string, unknown> = {};
			if (cursor) {
				params.cursor = cursor;
			}

			const result = await requestFromServer<MCPResourceTemplatesListResult>(
				connection,
				"resources/templates/list",
				params,
				options,
			);
			updateCacheExpiry(connection, "resourceTemplates", result);
			allTemplates.push(...result.resourceTemplates);
			cursor = result.nextCursor;
		} while (cursor);
	} catch (error) {
		// A server that doesn't implement the optional templates method answers
		// -32601; cache an empty list so we neither retry nor let the failure
		// bubble up and discard the server's concrete resources.
		if (isMethodNotFoundError(error)) {
			connection.resourceTemplates = [];
			return [];
		}
		throw error;
	}

	connection.resourceTemplates = allTemplates;
	return allTemplates;
}

/**
 * Read a resource from a connected server.
 */
export async function readResource(
	connection: MCPServerConnection,
	uri: string,
	options?: MCPRequestOptions,
): Promise<MCPResourceReadResult> {
	const params: MCPResourceReadParams = { uri };
	return requestFromServer<MCPResourceReadResult>(
		connection,
		"resources/read",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Subscribe to resource update notifications.
 */
export async function subscribeToResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<string[]> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return [];
	if (connection.protocolVersion === MODERN_PROTOCOL_VERSION) {
		const runtime = connectionRuntimes.get(connection);
		if (!runtime) return [];
		for (const uri of uris) runtime.resourceSubscriptions.add(uri);
		const accepted = await startModernSubscriptionListener(connection, options);
		return accepted.filter(uri => uris.includes(uri));
	}
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return requestFromServer(
				connection,
				"resources/subscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	const accepted: string[] = [];
	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") {
			logger.warn("Failed to subscribe to MCP resource", { error: result.reason });
		} else {
			accepted.push(uris[index]!);
		}
	}
	return accepted;
}

/**
 * Unsubscribe from resource update notifications.
 */
export async function unsubscribeFromResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	if (connection.protocolVersion === MODERN_PROTOCOL_VERSION) {
		const runtime = connectionRuntimes.get(connection);
		if (!runtime) return;
		for (const uri of uris) runtime.resourceSubscriptions.delete(uri);
		await startModernSubscriptionListener(connection, options);
		return;
	}
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return requestFromServer(
				connection,
				"resources/unsubscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to unsubscribe from MCP resource", { error: result.reason });
		}
	}
}

/**
 * Check if a server supports resource subscriptions.
 */
export function serverSupportsResourceSubscriptions(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources?.subscribe === true;
}

/**
 * Check if a server supports resources.
 */
export function serverSupportsResources(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources !== undefined;
}

/**
 * List prompts from a connected server.
 */
export async function listPrompts(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPPrompt[]> {
	if (!connection.capabilities.prompts) {
		return [];
	}

	if (connection.prompts && cacheIsFresh(connection, "prompts")) {
		return connection.prompts;
	}
	connection.prompts = undefined;
	delete connectionRuntimes.get(connection)?.cacheExpires.prompts;
	delete connectionRuntimes.get(connection)?.cacheScopes.prompts;

	const allPrompts: MCPPrompt[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await requestFromServer<MCPPromptsListResult>(connection, "prompts/list", params, options);
		updateCacheExpiry(connection, "prompts", result);
		allPrompts.push(...result.prompts);
		cursor = result.nextCursor;
	} while (cursor);

	connection.prompts = allPrompts;
	return allPrompts;
}

/**
 * Get a specific prompt from a connected server.
 */
export async function getPrompt(
	connection: MCPServerConnection,
	name: string,
	args?: Record<string, string>,
	options?: MCPRequestOptions,
): Promise<MCPGetPromptResult> {
	const params: MCPGetPromptParams = { name };
	if (args && Object.keys(args).length > 0) {
		params.arguments = args;
	}

	return requestFromServer<MCPGetPromptResult>(
		connection,
		"prompts/get",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Check if a server supports prompts.
 */
export function serverSupportsPrompts(capabilities: MCPServerCapabilities): boolean {
	return capabilities.prompts !== undefined;
}
