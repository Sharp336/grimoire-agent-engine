/**
 * MCP JSON Provider
 *
 * Discovers standalone mcp.json / .mcp.json files in the project root.
 * This is a fallback for projects that have a standalone mcp.json without any config directory.
 *
 * Priority: 5 (low, as this is a fallback after tool-specific providers)
 */
import * as path from "node:path";
import { logger, tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { createSourceMeta, expandEnvVarsDeep } from "./helpers";

const PROVIDER_ID = "mcp-json";
const DISPLAY_NAME = "MCP Config";

/**
 * Raw MCP JSON format (matches Claude Desktop's format).
 */
export interface MCPConfigFile {
	mcpServers?: Record<
		string,
		{
			enabled?: boolean;
			timeout?: number;
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			cwd?: string;
			url?: string;
			headers?: Record<string, string>;
			auth?: {
				type: "oauth" | "apikey";
				credentialId?: string;
				tokenUrl?: string;
				clientId?: string;
				clientSecret?: string;
			};
			type?: "stdio" | "sse" | "http";
			oauth?: {
				clientId?: string;
				clientSecret?: string;
				redirectUri?: string;
				callbackPort?: number;
				callbackPath?: string;
				prompt?: string;
			};
		}
	>;
}

/**
 * Validate the runtime shape of a parsed MCP config file.
 *
 * `tryParseJson<MCPConfigFile>` only checks syntax — the generic is erased, so
 * a wrong-shape `mcpServers` (a string, an array, or entries that are not
 * objects) reaches `transformMCPConfig` and gets iterated into blank servers
 * named after character or array indices. Callers validate first and then
 * either warn (discovery) or hard-fail (explicitly named files).
 *
 * @param options.strict Also apply the checks that only make sense for a file
 *   the caller named explicitly (`--mcp-config`): `mcpServers` has to be present
 *   (an empty object is fine), and every entry has to be an object. Discovery
 *   leaves this off. It probes fixed paths, so a file there without the key just
 *   contributes nothing, and it stays best-effort per entry rather than per
 *   file — rejecting a whole file over one bad entry would take unrelated
 *   servers down with it, when {@link transformMCPConfig} skips the bad entry
 *   and capability validation drops whatever it produced.
 * @returns A human-readable reason when the shape is invalid, `null` when valid.
 */
export function validateMCPConfigFile(value: unknown, options?: { strict?: boolean }): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "expected a JSON object at the top level";
	}
	const { mcpServers } = value as { mcpServers?: unknown };
	if (mcpServers === undefined) {
		return options?.strict ? 'missing an "mcpServers" object' : null;
	}
	if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
		return '"mcpServers" must be an object mapping server names to server configs';
	}
	if (options?.strict) {
		for (const [name, entry] of Object.entries(mcpServers)) {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				return `server "${name}" must be an object`;
			}
		}
	}
	return null;
}

/**
 * Transform raw MCP config to canonical MCPServer format.
 *
 * Assumes `validateMCPConfigFile` already accepted `config`.
 */
export function transformMCPConfig(config: MCPConfigFile, source: SourceMeta): MCPServer[] {
	const servers: MCPServer[] = [];

	if (config.mcpServers) {
		for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
			// A non-object entry has no fields to read — and `null` would throw on
			// the first access. Skipping keeps the rest of the file usable, which
			// is what discovery wants; explicitly named files never reach this
			// because `validateMCPConfigFile({strict: true})` rejects them first.
			if (typeof serverConfig !== "object" || serverConfig === null || Array.isArray(serverConfig)) {
				logger.warn("MCP server entry is not an object, ignoring", { name });
				continue;
			}

			// Runtime type validation for user-controlled JSON values
			let enabled: boolean | undefined;
			if (serverConfig.enabled !== undefined) {
				if (typeof serverConfig.enabled === "boolean") {
					enabled = serverConfig.enabled;
				} else {
					logger.warn("MCP server has invalid 'enabled' value, ignoring", { name, value: serverConfig.enabled });
				}
			}

			let timeout: number | undefined;
			if (serverConfig.timeout !== undefined) {
				if (
					typeof serverConfig.timeout === "number" &&
					Number.isFinite(serverConfig.timeout) &&
					serverConfig.timeout >= 0
				) {
					timeout = serverConfig.timeout;
				} else {
					logger.warn("MCP server has invalid 'timeout' value, ignoring", { name, value: serverConfig.timeout });
				}
			}

			const server: MCPServer = {
				name,
				enabled,
				timeout,
				command: serverConfig.command,
				args: serverConfig.args,
				env: serverConfig.env,
				cwd: serverConfig.cwd,
				url: serverConfig.url,
				headers: serverConfig.headers,
				auth: serverConfig.auth,
				oauth: serverConfig.oauth,
				transport: serverConfig.type,
				_source: source,
			};

			// Expand environment variables
			if (server.command) server.command = expandEnvVarsDeep(server.command);
			if (server.args) server.args = expandEnvVarsDeep(server.args);
			if (server.env) server.env = expandEnvVarsDeep(server.env);
			if (server.cwd) server.cwd = expandEnvVarsDeep(server.cwd);
			if (server.url) server.url = expandEnvVarsDeep(server.url);
			if (server.headers) server.headers = expandEnvVarsDeep(server.headers);
			if (server.auth) server.auth = expandEnvVarsDeep(server.auth);
			if (server.oauth) server.oauth = expandEnvVarsDeep(server.oauth);
			servers.push(server);
		}
	}

	return servers;
}

/**
 * Load MCP servers from a JSON file.
 */
async function loadMCPJsonFile(
	_ctx: LoadContext,
	path: string,
	level: "user" | "project",
): Promise<LoadResult<MCPServer>> {
	const warnings: string[] = [];
	const items: MCPServer[] = [];

	const content = await readFile(path);
	if (content === null) {
		return { items, warnings };
	}

	const config = tryParseJson<MCPConfigFile>(content);
	if (!config) {
		warnings.push(`Failed to parse JSON in ${path}`);
		return { items, warnings };
	}

	const invalid = validateMCPConfigFile(config);
	if (invalid) {
		warnings.push(`Ignored ${path}: ${invalid}`);
		return { items, warnings };
	}

	const source = createSourceMeta(PROVIDER_ID, path, level);
	const servers = transformMCPConfig(config, source);
	items.push(...servers);

	return { items, warnings };
}

/**
 * MCP JSON Provider loader.
 */
async function load(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const filenames = ["mcp.json", ".mcp.json"];
	const results = await Promise.all(
		filenames.map(filename => loadMCPJsonFile(ctx, path.join(ctx.cwd, filename), "project")),
	);

	const allItems = results.flatMap(r => r.items);
	const allWarnings = results.flatMap(r => r.warnings ?? []);

	return {
		items: allItems,
		warnings: allWarnings.length > 0 ? allWarnings : undefined,
	};
}

// Register provider
registerProvider(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from standalone mcp.json or .mcp.json in project root",
	priority: 5,
	load,
});
