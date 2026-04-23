/**
 * Claude Code Marketplace Plugin Provider
 *
 * Loads configuration from ~/.claude/plugins/installed_plugins.json.
 * Only covers plugins from the Claude Code registry — OMP marketplace plugins
 * are handled by the separate omp-plugins provider.
 * Priority: 70 (below claude.ts at 80, so user overrides in .claude/ take precedence).
 *
 * All loader logic lives in the shared `plugin-provider` factory, which honors
 * `.claude-plugin/plugin.json` manifest overrides for skills and slash-commands.
 */
import { listClaudeOnlyPluginRoots } from "./helpers";
import { registerPluginProvider } from "./plugin-provider";


registerPluginProvider({
	providerId: "claude-plugins",
	displayName: "Claude Code Marketplace",
	priority: 70,
	label: "Claude Code marketplace plugins",
	listRoots: listClaudeOnlyPluginRoots,
});
