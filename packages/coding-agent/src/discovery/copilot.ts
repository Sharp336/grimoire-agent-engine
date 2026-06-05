/**
 * GitHub Copilot MCP Provider
 *
 * Discovers MCP servers from ~/.copilot/mcp-config.json.
 * This is the user-level config file written by the GitHub Copilot CLI.
 *
 * Priority: 30 (tool-specific, same as github.ts)
 */
import * as path from "node:path";
import { tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta } from "./helpers";
import { type MCPConfigFile, transformMCPConfig } from "./mcp-json";

const PROVIDER_ID = "copilot";
const DISPLAY_NAME = "GitHub Copilot";
const PRIORITY = 30;

/**
 * Copilot MCP config file format.
 * `mcpServers` is the official key; `servers` is a compatibility fallback.
 */
interface CopilotMCPConfig {
	mcpServers?: MCPConfigFile["mcpServers"];
	servers?: MCPConfigFile["mcpServers"];
}

/**
 * Resolve the Copilot home directory.
 * Prefers COPILOT_HOME env var; falls back to ~/.copilot.
 */
export function resolveCopilotHome(ctx: LoadContext): string {
	return process.env.COPILOT_HOME || path.join(ctx.home, ".copilot");
}

/**
 * Load MCP servers from ~/.copilot/mcp-config.json.
 */
async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const copilotHome = resolveCopilotHome(ctx);
	const configPath = path.join(copilotHome, "mcp-config.json");

	const content = await readFile(configPath);
	if (content === null) {
		return { items: [], warnings: [] };
	}

	const config = tryParseJson<CopilotMCPConfig>(content);
	if (!config) {
		return { items: [], warnings: [`Failed to parse JSON in ${configPath}`] };
	}

	// mcpServers is the official Copilot key; "servers" is a compatibility fallback
	const mcpServers = config.mcpServers ?? config.servers;
	if (!mcpServers) {
		return { items: [], warnings: [] };
	}

	const mcpConfig: MCPConfigFile = { mcpServers };
	const source = createSourceMeta(PROVIDER_ID, configPath, "user");
	const servers = transformMCPConfig(mcpConfig, source);

	return { items: servers, warnings: [] };
}

// Register provider
registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from ~/.copilot/mcp-config.json",
	priority: PRIORITY,
	load: loadMCPServers,
});
