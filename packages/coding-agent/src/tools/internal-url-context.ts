import type { ResolveContext } from "../internal-urls";
import type { ToolSession } from ".";

/** Build the caller context used by every internal-URL entry point. */
export function internalUrlContext(session: ToolSession, signal?: AbortSignal): ResolveContext {
	return {
		cwd: session.cwd,
		settings: session.settings,
		signal,
		sessionFile: session.getSessionFile() ?? undefined,
		localProtocolOptions: session.localProtocolOptions,
		skills: session.skills,
		agentRegistry: session.agentRegistry,
		mcpManager: session.mcpManager,
		rules: session.rules,
		engineMode: session.engineMode,
	};
}
