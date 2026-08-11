import type { AgentSession } from "../session/agent-session";
import type { MCPLoadResult, MCPManager } from "./manager";

export interface ReloadMcpResourcesOptions {
	session: AgentSession;
	manager: MCPManager;
	enableProjectConfig: boolean;
	browserEnabled: boolean;
}

/** Rediscover configured MCP servers and atomically rebind the session-facing tools and prompts. */
export async function reloadMcpResources(options: ReloadMcpResourcesOptions): Promise<MCPLoadResult> {
	await options.manager.disconnectAll();
	options.session.setMCPPromptCommands([]);
	const result = await options.manager.discoverAndConnect({
		enableProjectConfig: options.enableProjectConfig,
		filterExa: true,
		filterBrowser: options.browserEnabled,
	});
	await options.session.refreshMCPTools(options.manager.getTools());
	return result;
}
