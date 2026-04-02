/**
 * OMP Marketplace Plugin Provider
 *
 * Loads configuration from the OMP plugin registry:
 *   - ~/.omp/plugins/installed_plugins.json (user-level OMP marketplace installs)
 *   - .omp/plugins/installed_plugins.json relative to cwd (project-scoped)
 *   - --plugin-dir injected roots (highest precedence)
 *
 * Kept separate from claude-plugins so the user can disable Claude Code Marketplace
 * without affecting OMP marketplace capabilities, and vice versa.
 * Priority: 75 (above claude-plugins at 70, so OMP entries shadow Claude entries for
 * the same plugin ID — matching the previous authoritative-override behavior).
 */
import { listOmpOnlyPluginRoots } from "./helpers";
import { registerPluginProvider } from "./plugin-provider";

registerPluginProvider({
	providerId: "omp-plugins",
	displayName: "OMP Marketplace",
	priority: 75,
	label: "OMP marketplace plugins",
	listRoots: listOmpOnlyPluginRoots,
});
