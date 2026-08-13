import { discoverAdvisorConfigs } from "../advisor";
import { reset as resetCapabilities } from "../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers";
import { refreshAgentDiscovery } from "../task";
import { MCPCommandController } from "./controllers/mcp-command-controller";
import type { InteractiveModeContext } from "./types";

/**
 * Reload the interactive session's plugin runtime after a plugin mutation or
 * cwd change. Every plugin-provided surface must move together so removed
 * advisors cannot outlive their package and installed advisors start at once.
 */
export async function reloadTuiPluginState(ctx: InteractiveModeContext): Promise<void> {
	const cwd = ctx.sessionManager.getCwd();
	const projectPath = await resolveActiveProjectRegistryPath(cwd);
	clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
	await refreshAgentDiscovery(cwd);
	await ctx.refreshSkillState();
	await ctx.refreshSlashCommandState();
	resetCapabilities();
	const discovered = await discoverAdvisorConfigs(cwd, ctx.settings.getAgentDir());
	ctx.session.applyAdvisorConfigs(discovered.advisors, discovered.sharedInstructions);
	if (ctx.mcpManager) await new MCPCommandController(ctx).reloadServers();
}
