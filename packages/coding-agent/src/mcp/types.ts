/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Supports the stateless 2026-07-28 protocol and legacy initialization-based servers.
 */

// =============================================================================
// JSON-RPC 2.0 Types
// =============================================================================

import type { SourceMeta } from "../capability/types";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export class MCPError extends Error {
	readonly code: number;
	readonly data?: unknown;
	readonly status?: number;

	constructor(error: JsonRpcError, status?: number, message?: string) {
		super(message ?? `MCP error ${error.code}: ${error.message}`);
		this.name = "MCPError";
		this.code = error.code;
		this.data = error.data;
		this.status = status;
	}
}

export class MCPHttpError extends Error {
	readonly status: number;

	constructor(status: number, body: string, suffix = "") {
		super(`HTTP ${status}: ${body}${suffix}`);
		this.name = "MCPHttpError";
		this.status = status;
	}
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// =============================================================================
// MCP Server Configuration (.mcp.json format)
// =============================================================================

/** Authentication configuration for MCP servers */
export interface MCPAuthConfig {
	/** Authentication type */
	type: "oauth" | "apikey";
	/** Credential ID for OAuth (references agent.db) */
	credentialId?: string;
	/** Token endpoint URL — persisted for proactive token refresh */
	tokenUrl?: string;
	/** Client ID — persisted for token refresh */
	clientId?: string;
	/** Client secret — persisted for token refresh */
	clientSecret?: string;
	/** MCP resource URI — persisted for OAuth resource indicators during refresh */
	resource?: string;
}

/** Encoding used for outgoing JSON-RPC request ids. */
export type MCPRequestIdFormat = "string" | "number";

/** MCP protocol lifecycle policy. */
export type MCPProtocolMode = "legacy" | "auto" | "2026-07-28";

/** Base server config with shared options */
interface MCPServerConfigBase {
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/** MCP request timeout in milliseconds (default: 30000, 0 to disable) */
	timeout?: number;
	/**
	 * Encoding for outgoing JSON-RPC request ids (default: `"number"`).
	 *
	 * Set `"string"` for servers that need collision-resistant snowflake string
	 * ids instead of per-transport integers. See `RequestIdAllocator` in
	 * `./request-id`.
	 *
	 * OMP-specific, so only the OMP-owned discovery providers parse it (native,
	 * standalone `mcp.json`, OMP plugins). Providers that translate another
	 * tool's config do not, since the key is not part of those formats.
	 */
	requestIdFormat?: MCPRequestIdFormat;
	/**
	 * Protocol lifecycle policy (default: `"legacy"`).
	 *
	 * `"auto"` probes modern discovery and falls back only on positive legacy
	 * evidence. `"2026-07-28"` requires the modern stateless lifecycle.
	 */
	protocolMode?: MCPProtocolMode;
	/** Authentication configuration (optional) */
	auth?: MCPAuthConfig;
	/** OAuth configuration for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		/** `prompt` param for the authorization request (default "consent"; "" to omit) */
		prompt?: string;
	};
}

/** Stdio server configuration */
export interface MCPStdioServerConfig extends MCPServerConfigBase {
	type?: "stdio"; // Default if not specified
	command: string;
	args?: string[];
	env?: Record<string, string>;
	/**
	 * `literal`: env values are opaque plugin package data (Agent Plugins
	 * §§4.1/9.2) — no env-name lookup, no `!command` execution, no dropping of
	 * empty values. The provider already applied the only permitted expansion
	 * (`${PLUGIN_ROOT}`/`${PLUGIN_DATA}`).
	 */
	envPolicy?: "literal";
	cwd?: string;
}

/** HTTP server configuration (Streamable HTTP transport) */
export interface MCPHttpServerConfig extends MCPServerConfigBase {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	/**
	 * `origin-locked`: configured headers are literal package data pinned to the
	 * configured URL's origin (Agent Plugins §7.2.1) — never expanded, never
	 * forwarded cross-origin, and client-generated headers win case-insensitively.
	 */
	headerPolicy?: "origin-locked";
}

/** SSE server configuration (deprecated, use HTTP) */
export interface MCPSseServerConfig extends MCPServerConfigBase {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
	/** See {@link MCPHttpServerConfig.headerPolicy}. */
	headerPolicy?: "origin-locked";
}

export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;

export const MCP_CONFIG_SCHEMA_URL =
	"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/** Root mcp.json/.mcp.json file structure */
export interface MCPConfigFile {
	$schema?: string;
	mcpServers?: Record<string, MCPServerConfig>;
	/** Names to hide regardless of any source `enabled` flag. Highest precedence. */
	disabledServers?: string[];
	/** Names to force-enable when a non-writable source reports `enabled: false`. */
	enabledServers?: string[];
}

// =============================================================================
// MCP Protocol Types
// =============================================================================

/** MCP implementation info */
export interface MCPImplementation {
	name: string;
	version: string;
}

/** MCP client capabilities */
export interface MCPClientCapabilities {
	roots?: { listChanged?: boolean };
	sampling?: Record<string, unknown>;
	elicitation?: { form?: Record<string, unknown>; url?: Record<string, unknown> };
	extensions?: Record<string, Record<string, unknown>>;
	experimental?: Record<string, unknown>;
}

/** MCP server capabilities */
export interface MCPServerCapabilities {
	tools?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	prompts?: { listChanged?: boolean };
	completions?: Record<string, unknown>;
	logging?: Record<string, unknown>;
	extensions?: Record<string, Record<string, unknown>>;
	experimental?: Record<string, unknown>;
}

/** Initialize request params */
export interface MCPInitializeParams {
	protocolVersion: string;
	capabilities: MCPClientCapabilities;
	clientInfo: MCPImplementation;
}

/** Initialize response result */
export interface MCPInitializeResult {
	protocolVersion: string;
	capabilities: MCPServerCapabilities;
	serverInfo: MCPImplementation;
	instructions?: string;
}

export interface MCPResult {
	resultType?: "complete" | "input_required" | string;
	_meta?: Record<string, unknown>;
}

export interface MCPCacheableResult extends MCPResult {
	ttlMs?: number;
	cacheScope?: "public" | "private";
}

export interface MCPInputRequest {
	method: string;
	params?: Record<string, unknown>;
}

export interface MCPInputRequiredResult extends MCPResult {
	resultType: "input_required";
	inputRequests?: Record<string, MCPInputRequest>;
	requestState?: string;
}

export interface MCPDiscoverResult extends MCPCacheableResult {
	supportedVersions: string[];
	capabilities: MCPServerCapabilities;
	instructions?: string;
}

/** MCP tool definition */
export interface MCPToolDefinition {
	name: string;
	title?: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

export interface MCPToolsListResult extends MCPCacheableResult {
	tools: MCPToolDefinition[];
	nextCursor?: string;
}

/** tools/call params */
export interface MCPToolCallParams {
	name: string;
	arguments?: Record<string, unknown>;
}

/** Content types in tool results */
export interface MCPTextContent {
	type: "text";
	text: string;
}

export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

/** Structured authentication challenge returned in a tool result. */
export interface MCPAuthChallenge {
	/** Values from `_meta["mcp/www_authenticate"]`. */
	readonly wwwAuthenticate: readonly string[];
}

/** tools/call response */
export interface MCPToolCallResult extends MCPResult {
	content: MCPContent[];
	structuredContent?: unknown;
	isError?: boolean;
}

// =============================================================================
// Transport Types
// =============================================================================

export interface MCPRequestOptions {
	/** Abort signal (e.g. Escape-to-interrupt) */
	signal?: AbortSignal;
	/** Per-request timeout override. Zero disables the timeout. */
	timeout?: number;
	/** Validated transport-generated HTTP headers. */
	generatedHeaders?: Record<string, string>;
	/** Observe the generated JSON-RPC request ID before the request is sent. */
	onRequestId?: (id: string | number) => void;
}

/** Transport interface - abstracts stdio/http */
export interface MCPTransport {
	/** Send a request and wait for response */
	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T>;

	/** Send a notification (no response expected) */
	notify(method: string, params?: Record<string, unknown>): Promise<void>;

	/** Close the transport */
	close(): Promise<void>;

	/** Whether the transport is connected */
	readonly connected: boolean;

	/** Event handlers */
	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	/** Handler for server-to-client requests (e.g. roots/list). Returns result or throws a JsonRpcError. */
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

/** Transport factory function */
export type TransportFactory = (config: MCPServerConfig) => Promise<MCPTransport>;

// =============================================================================
// MCP Client Types
// =============================================================================

/** Connected MCP server state */
export interface MCPServerConnection {
	/** Server name from config */
	name: string;
	/** Original config */
	config: MCPServerConfig;
	/** Transport instance */
	transport: MCPTransport;
	/** Server info from initialize */
	serverInfo: MCPImplementation;
	/** Server capabilities */
	capabilities: MCPServerCapabilities;
	/** Cached tools (populated on demand) */
	tools?: MCPToolDefinition[];
	/** Source metadata (for display) */
	_source?: SourceMeta;
	/** Cached resources (populated on demand) */
	resources?: MCPResource[];
	/** Cached resource templates (populated on demand) */
	resourceTemplates?: MCPResourceTemplate[];
	/** Server instructions from initialize */
	instructions?: string;
	/** Negotiated MCP protocol version. Absent on synthetic legacy connections. */
	protocolVersion?: string;
	/** Cached prompts (populated on demand) */
	prompts?: MCPPrompt[];
}

/** MCP tool with server context */
export interface MCPToolWithServer {
	server: MCPServerConnection;
	tool: MCPToolDefinition;
}

// =============================================================================
// MCP Resource Types
// =============================================================================

/** Annotations for resources, templates, and content blocks */
export interface MCPAnnotations {
	audience?: ("user" | "assistant")[];
	priority?: number;
	lastModified?: string;
}

/** A concrete resource exposed by an MCP server */
export interface MCPResource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: MCPAnnotations;
}

/** A parameterized resource template (RFC 6570 URI template) */
export interface MCPResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	annotations?: MCPAnnotations;
}

/** Result of resources/list */
export interface MCPResourcesListResult extends MCPCacheableResult {
	resources: MCPResource[];
	nextCursor?: string;
}

/** Result of resources/templates/list */
export interface MCPResourceTemplatesListResult extends MCPCacheableResult {
	resourceTemplates: MCPResourceTemplate[];
	nextCursor?: string;
}

/** A single content item from resources/read */
export interface MCPResourceContentItem {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

/** Result of resources/read */
export interface MCPResourceReadResult extends MCPCacheableResult {
	contents: MCPResourceContentItem[];
}

/** Params for resources/read */
export interface MCPResourceReadParams {
	uri: string;
}

/** Params for resources/subscribe and resources/unsubscribe */
export interface MCPResourceSubscribeParams {
	uri: string;
}

// =============================================================================
// MCP Prompt Types
// =============================================================================

/** An argument definition for an MCP prompt */
export interface MCPPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** A prompt definition exposed by an MCP server */
export interface MCPPrompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: MCPPromptArgument[];
}

/** Result of prompts/list */
export interface MCPPromptsListResult extends MCPCacheableResult {
	prompts: MCPPrompt[];
	nextCursor?: string;
}

/** Audio content in prompt messages */
export interface MCPAudioContent {
	type: "audio";
	data: string;
	mimeType: string;
}

/** Content type union for prompt messages */
export type MCPPromptContent = MCPTextContent | MCPImageContent | MCPAudioContent | MCPResourceContent;

/** A single message in a prompt result */
export interface MCPPromptMessage {
	role: "user" | "assistant";
	content: MCPPromptContent | MCPPromptContent[];
}

/** Params for prompts/get */
export interface MCPGetPromptParams {
	name: string;
	arguments?: Record<string, string>;
}

/** Result of prompts/get */
export interface MCPGetPromptResult extends MCPResult {
	description?: string;
	messages: MCPPromptMessage[];
}

// =============================================================================
// MCP Notification Method Names
// =============================================================================

/** MCP server notification method names */
export const MCPNotificationMethods = {
	TOOLS_LIST_CHANGED: "notifications/tools/list_changed",
	RESOURCES_LIST_CHANGED: "notifications/resources/list_changed",
	RESOURCES_UPDATED: "notifications/resources/updated",
	PROMPTS_LIST_CHANGED: "notifications/prompts/list_changed",
} as const;

/** Extract a JsonRpcError from a thrown value. Preserves `.code` and `.message` from Error instances or plain objects. */
export function toJsonRpcError(error: unknown): JsonRpcError {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "number" ? error.code : -32603;
		return { code, message: error.message };
	}
	if (typeof error === "object" && error !== null) {
		const obj = error as Record<string, unknown>;
		if (typeof obj.code === "number" && typeof obj.message === "string") {
			return { code: obj.code, message: obj.message };
		}
	}
	return { code: -32603, message: "Internal error" };
}
