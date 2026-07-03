/**
 * MCP (Model Context Protocol) Servers Capability
 *
 * Canonical shape for MCP server configurations, regardless of source format.
 * All providers translate their native format to this shape.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Canonical MCP server configuration.
 */
export interface MCPServer {
	/** Server name (unique key) */
	name: string;
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/** Connection timeout in milliseconds */
	timeout?: number;
	/** Command to run (for stdio transport) */
	command?: string;
	/** Command arguments */
	args?: string[];
	/** Environment variables */
	env?: Record<string, string>;
	/** Working directory for stdio transport */
	cwd?: string;
	/** URL (for HTTP/SSE transport) */
	url?: string;
	/** HTTP headers (for HTTP transport) */
	headers?: Record<string, string>;
	/** Authentication configuration */
	auth?: {
		type: "oauth" | "apikey";
		credentialId?: string;
		tokenUrl?: string;
		clientId?: string;
		clientSecret?: string;
		resource?: string;
	};
	/** OAuth configuration (clientId, clientSecret, redirectUri, callbackPort, callbackPath, prompt) for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		prompt?: string;
	};
	/** Transport type */
	transport?: "stdio" | "sse" | "http";
	/** Connection lifecycle: "eager" (default) connects at session start; "lazy" connects on first tool use and idle-disconnects after idleTimeout. */
	lifecycle?: "eager" | "lazy";
	/** Idle-disconnect timeout in milliseconds for lazy servers. 0 disables idle disconnect. */
	idleTimeout?: number;
	/** Source metadata (added by loader) */
	_source: SourceMeta;
}

export const mcpCapability = defineCapability<MCPServer>({
	id: "mcps",
	displayName: "MCP Servers",
	description: "Model Context Protocol server configurations for external tool integrations",
	key: server => server.name,
	toExtensionId: server => `mcp:${server.name}`,
	validate: server => {
		if (!server.name) return "Missing server name";
		if (!server.command && !server.url) return "Must have command or url";

		// Validate transport-endpoint pairing
		if (server.transport === "stdio" && !server.command) {
			return "stdio transport requires command field";
		}
		if ((server.transport === "http" || server.transport === "sse") && !server.url) {
			return "http/sse transport requires url field";
		}

		// Validate lifecycle policy so a typo (e.g. "lazyy") surfaces as a config
		// error instead of silently falling through every === "lazy" check as eager.
		if (server.lifecycle !== undefined && server.lifecycle !== "eager" && server.lifecycle !== "lazy") {
			return `Invalid lifecycle "${server.lifecycle}" (expected "eager" or "lazy")`;
		}
		if (
			server.idleTimeout !== undefined &&
			(typeof server.idleTimeout !== "number" || !Number.isFinite(server.idleTimeout) || server.idleTimeout < 0)
		) {
			return "idleTimeout must be a non-negative number of milliseconds";
		}

		return undefined;
	},
});
