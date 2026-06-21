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

import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { loadCodemapConfig } from "./config";
import { closeCodemapDb, openCodemapDb } from "./db";
import { shutdownCodemapEmbedClient } from "./embed";
import { buildCodemapInjectionBlock } from "./prompt";
import { getTaskContext } from "./retrieve";
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

/**
 * First-turn injection for codemap (code summaries).
 *
 * Runs REGARDLESS of memory.backend — codemap is a distinct feature axis
 * that composes with any memory backend including "off" (the default).
 * Gated only on `codemap.enabled` and `codemap.autoInject`.
 *
 * Fires once per session via the `hasInjectedForFirstTurn` flag. The caller
 * must invoke `markInjected` (which sets the flag on the session state) so
 * subsequent calls return null.
 *
 * Returns the injection block string, or null when:
 *   - codemap is disabled or autoInject is off
 *   - no session state exists (codemap not initialized)
 *   - the first-turn injection already fired
 *   - the retrieval returned no files
 *   - any error occurred (swallowed + logged at debug — injection must never
 *     break the agent start)
 *
 * Extracted from AgentSession.#injectCodemapTaskContext for testability.
 */
export async function injectCodemapTaskContext(
	settings: Settings,
	state: CodemapSessionState | undefined,
	cwd: string,
	promptText: string,
	markInjected: () => void,
): Promise<string | null> {
	try {
		if (!settings.get("codemap.enabled")) return null;
		if (!settings.get("codemap.autoInject")) return null;
		if (!state) return null;
		if (state.hasInjectedForFirstTurn) return null;

		const projectLabel = path.basename(cwd);
		const result = await getTaskContext(state.client, state.config, promptText, projectLabel, cwd);
		markInjected();
		const block = buildCodemapInjectionBlock(result);
		return block || null;
	} catch (err) {
		logger.debug("codemap: first-turn injection failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
