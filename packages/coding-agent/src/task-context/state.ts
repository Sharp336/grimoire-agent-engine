import type { Client } from "@libsql/client";
import type { AgentSession } from "../session/agent-session";
import type { CodemapConfig } from "./config";

const kCodemapSessionState = Symbol("codemap.sessionState");

interface AgentSessionWithCodemapState extends AgentSession {
	[kCodemapSessionState]?: CodemapSessionState;
}

export interface CodemapSessionState {
	/** The libSQL client for this session (cached, shared across tool calls). */
	client: Client;
	/** The resolved codemap config for this session. */
	config: CodemapConfig;
	/** Whether the first-turn injection has already fired for this session. */
	hasInjectedForFirstTurn: boolean;
}

export function getCodemapSessionState(session: AgentSession | undefined): CodemapSessionState | undefined {
	return session ? (session as AgentSessionWithCodemapState)[kCodemapSessionState] : undefined;
}

export function setCodemapSessionState(
	session: AgentSession,
	state: CodemapSessionState | undefined,
): CodemapSessionState | undefined {
	const previous = (session as AgentSessionWithCodemapState)[kCodemapSessionState];
	(session as AgentSessionWithCodemapState)[kCodemapSessionState] = state;
	return previous;
}

/** Mark that the first-turn injection has fired. */
export function markFirstTurnInjected(session: AgentSession): void {
	const state = getCodemapSessionState(session);
	if (state) state.hasInjectedForFirstTurn = true;
}

/** Check whether the first-turn injection has already fired. */
export function hasFirstTurnInjected(session: AgentSession): boolean {
	return getCodemapSessionState(session)?.hasInjectedForFirstTurn ?? false;
}
