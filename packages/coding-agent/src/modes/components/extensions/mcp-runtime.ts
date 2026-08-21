/**
 * Live MCP runtime view-model for `/extensions`.
 *
 * Discovery yields config (`MCPServer`). `MCPManager` holds the live connection.
 * This module joins them by server name without stuffing runtime objects into
 * `Extension.raw`.
 */
import type { MCPServer } from "../../../capability/mcp";
import type { MCPManager } from "../../../mcp/manager";
import type {
	MCPImplementation,
	MCPPrompt,
	MCPResource,
	MCPResourceTemplate,
	MCPServerConfig,
	MCPServerConnection,
} from "../../../mcp/types";

export type MCPConnectionHealth = "connected" | "connecting" | "disconnected" | "inactive";

export interface MCPRuntimeCatalogItem {
	name: string;
	title?: string;
	description?: string;
}

export interface MCPRuntimeSnapshot {
	health: MCPConnectionHealth;
	transport: "stdio" | "sse" | "http";
	title?: string;
	description?: string;
	websiteUrl?: string;
	implementationName?: string;
	implementationVersion?: string;
	instructions?: string;
	tools: MCPRuntimeCatalogItem[];
	resources: MCPRuntimeCatalogItem[];
	prompts: MCPRuntimeCatalogItem[];
	command?: string;
	args?: string[];
	url?: string;
	envCount: number;
}

/** Narrow manager surface so tests can stub without constructing MCPManager. */
export interface MCPRuntimeSource {
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
	getConnection(name: string): MCPServerConnection | undefined;
	getTools(): Array<{
		mcpServerName?: string;
		mcpToolName?: string;
		description?: string;
		label?: string;
	}>;
	getServerResources?(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined;
	getServerPrompts?(name: string): MCPPrompt[] | undefined;
}

const DEFAULT_VISIBLE_TOOLS = 8;

export function isDiscoveredMcpServer(raw: unknown): raw is MCPServer {
	if (!raw || typeof raw !== "object") return false;
	const value = raw as { name?: unknown; _source?: unknown };
	return typeof value.name === "string" && value._source !== undefined;
}

export function inferMcpTransport(server: MCPServer | MCPServerConfig): "stdio" | "sse" | "http" {
	if (
		"transport" in server &&
		(server.transport === "stdio" || server.transport === "sse" || server.transport === "http")
	) {
		return server.transport;
	}
	if ("type" in server && (server.type === "stdio" || server.type === "sse" || server.type === "http")) {
		return server.type;
	}
	if ("url" in server && typeof server.url === "string" && server.url.length > 0) {
		return "http";
	}
	return "stdio";
}

function catalogItem(name: string, title?: string, description?: string): MCPRuntimeCatalogItem {
	return {
		name,
		...(title && title !== name ? { title } : {}),
		...(description ? { description } : {}),
	};
}

function toolsFromManager(manager: MCPRuntimeSource, serverName: string): MCPRuntimeCatalogItem[] {
	const items: MCPRuntimeCatalogItem[] = [];
	const seen: Record<string, true> = {};
	for (const tool of manager.getTools()) {
		if (tool.mcpServerName !== serverName) continue;
		const name = tool.mcpToolName ?? tool.label?.split("/").pop() ?? tool.label;
		if (!name || seen[name]) continue;
		seen[name] = true;
		items.push(catalogItem(name, undefined, tool.description));
	}
	return items;
}

function resourcesFrom(connection: MCPServerConnection, manager?: MCPRuntimeSource): MCPRuntimeCatalogItem[] {
	const listed = manager?.getServerResources?.(connection.name);
	const resources = listed?.resources ?? connection.resources ?? [];
	const templates = listed?.templates ?? connection.resourceTemplates ?? [];
	return [
		...resources.map(resource => catalogItem(resource.name, resource.title, resource.description ?? resource.uri)),
		...templates.map(template =>
			catalogItem(template.name, template.title, template.description ?? template.uriTemplate),
		),
	];
}

function promptsFrom(connection: MCPServerConnection, manager?: MCPRuntimeSource): MCPRuntimeCatalogItem[] {
	const listed = manager?.getServerPrompts?.(connection.name) ?? connection.prompts ?? [];
	return listed.map(prompt => catalogItem(prompt.name, prompt.title, prompt.description));
}

function identityFrom(
	info: MCPImplementation | undefined,
	fallbackName: string,
): Pick<MCPRuntimeSnapshot, "title" | "description" | "websiteUrl" | "implementationName" | "implementationVersion"> {
	if (!info) return {};
	const displayTitle = info.title && info.title !== fallbackName ? info.title : undefined;
	return {
		title: displayTitle,
		description: info.description,
		websiteUrl: info.websiteUrl,
		implementationName: info.name,
		implementationVersion: info.version,
	};
}

export function snapshotMcpRuntime(
	server: MCPServer,
	manager: MCPRuntimeSource | MCPManager | undefined,
	opts?: { enabled: boolean },
): MCPRuntimeSnapshot {
	const enabled = opts?.enabled ?? server.enabled !== false;
	const transport = inferMcpTransport(server);
	const envCount = server.env ? Object.keys(server.env).length : 0;
	const base: MCPRuntimeSnapshot = {
		health: enabled ? "disconnected" : "inactive",
		transport,
		command: server.command,
		args: server.args,
		url: server.url,
		envCount,
		tools: [],
		resources: [],
		prompts: [],
	};

	if (!enabled || !manager) {
		return base;
	}

	const health = manager.getConnectionStatus(server.name);
	const connection = manager.getConnection(server.name);
	const identity = identityFrom(connection?.serverInfo, server.name);
	const connectedTools = (connection?.tools ?? []).map(tool =>
		catalogItem(tool.name, tool.title ?? tool.annotations?.title, tool.description),
	);
	const tools = connectedTools.length > 0 ? connectedTools : toolsFromManager(manager, server.name);

	return {
		...base,
		health,
		...identity,
		instructions: connection?.instructions,
		tools,
		resources: connection ? resourcesFrom(connection, manager) : [],
		prompts: connection ? promptsFrom(connection, manager) : [],
		command:
			server.command ??
			(connection?.config && "command" in connection.config ? connection.config.command : undefined),
		args: server.args ?? (connection?.config && "args" in connection.config ? connection.config.args : undefined),
		url: server.url ?? (connection?.config && "url" in connection.config ? connection.config.url : undefined),
		transport: connection ? inferMcpTransport(connection.config) : transport,
	};
}

export function formatMcpListHint(snapshot: MCPRuntimeSnapshot): string {
	switch (snapshot.health) {
		case "inactive":
			return "inactive";
		case "connecting":
			return "connecting…";
		case "disconnected":
			return "unavailable";
		case "connected": {
			const parts = [`${snapshot.tools.length} tool${snapshot.tools.length === 1 ? "" : "s"}`];
			if (snapshot.resources.length > 0) {
				parts.push(`${snapshot.resources.length} resource${snapshot.resources.length === 1 ? "" : "s"}`);
			}
			if (snapshot.prompts.length > 0) {
				parts.push(`${snapshot.prompts.length} prompt${snapshot.prompts.length === 1 ? "" : "s"}`);
			}
			return parts.join(" · ");
		}
	}
}

export function formatMcpHealthLabel(health: MCPConnectionHealth): string {
	switch (health) {
		case "connected":
			return "Connected";
		case "connecting":
			return "Connecting";
		case "disconnected":
			return "Not connected";
		case "inactive":
			return "Inactive";
	}
}

export function visibleMcpTools(
	tools: MCPRuntimeCatalogItem[],
	limit = DEFAULT_VISIBLE_TOOLS,
): { shown: MCPRuntimeCatalogItem[]; hidden: number } {
	if (tools.length <= limit) return { shown: tools, hidden: 0 };
	return { shown: tools.slice(0, limit), hidden: tools.length - limit };
}
