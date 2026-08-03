import type { MCPManager } from "../../mcp";
import { loadAllMCPConfigs } from "../../mcp/config";

export type McpServerRefreshState = "updated" | "connecting" | "failed";

export interface McpServerRefreshResult {
	state: McpServerRefreshState;
	errors: Map<string, string>;
}

export interface RefreshMcpServerOptions {
	cwd: string;
	serverName: string;
	enabled: boolean;
	manager: MCPManager;
	refreshTools: (manager: MCPManager) => Promise<void>;
}

/** Apply one persisted MCP server toggle without disturbing unrelated connections. */
export async function refreshMcpServer({
	cwd,
	serverName,
	enabled,
	manager,
	refreshTools,
}: RefreshMcpServerOptions): Promise<McpServerRefreshResult> {
	if (!enabled) {
		await manager.disconnectServer(serverName);
		await refreshTools(manager);
		return { state: "updated", errors: new Map() };
	}

	const { configs, sources } = await loadAllMCPConfigs(cwd);
	const config = configs[serverName];
	if (!config) {
		return {
			state: "failed",
			errors: new Map([
				[serverName, `Enabled MCP server "${serverName}" was not found after refreshing configuration`],
			]),
		};
	}

	const result = await manager.connectServers(
		{ [serverName]: config },
		sources[serverName] ? { [serverName]: sources[serverName] } : {},
	);
	await refreshTools(manager);

	if (result.errors.has(serverName)) return { state: "failed", errors: result.errors };

	const status = manager.getConnectionStatus(serverName);
	if (status === "connected") return { state: "updated", errors: result.errors };
	if (status === "connecting") return { state: "connecting", errors: result.errors };
	return {
		state: "failed",
		errors: new Map([...result.errors, [serverName, `MCP server "${serverName}" did not start connecting`]]),
	};
}
