export * from "./adapter";
export * from "./config";
export * from "./db";
export * from "./embed";
export * from "./prompt";
export * from "./retrieve";
export * from "./schema";
export * from "./staleness";
export * from "./state";
export * from "./store";
export * from "./tools";
export * from "./turso";

import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { loadCodemapConfig } from "./config";
import { closeCodemapDb, openCodemapDb } from "./db";
import { shutdownCodemapEmbedClient } from "./embed";
import { type CodemapSessionState, getCodemapSessionState, setCodemapSessionState } from "./state";
import { resolveTursoConfig } from "./turso";

/**
 * Initialize the codemap feature for a session.
 * Opens the DB, runs auto-provisioning if needed, and stores state on the session.
 * Returns true if codemap is active for this session, false if disabled.
 */
export async function resolveCodemap(session: AgentSession, settings: Settings): Promise<boolean> {
	const config = loadCodemapConfig(settings, getAgentDir());
	if (!config.enabled) return false;

	try {
		// Run Turso auto-provisioning if configured
		const resolvedConfig = await resolveTursoConfig(config, settings);
		// Open the DB (local file or embedded replica)
		const client = await openCodemapDb(resolvedConfig);
		// Store state on the session
		const state: CodemapSessionState = {
			client,
			config: resolvedConfig,
			hasInjectedForFirstTurn: false,
		};
		setCodemapSessionState(session, state);
		return true;
	} catch (err) {
		logger.warn("codemap: initialization failed, feature disabled for this session", {
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/** Shutdown codemap for a session — close DB and embedding client. */
export async function shutdownCodemap(session: AgentSession): Promise<void> {
	const state = getCodemapSessionState(session);
	if (!state) return;
	await closeCodemapDb(state.client);
	await shutdownCodemapEmbedClient();
}
