import * as path from "node:path";
import type { AgentSession } from "../../session/agent-session";
import { resolveResumableSession, type SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import type { RpcListSessionsResult, RpcResolveSessionResult, RpcSessionInfo } from "./rpc-types";

export interface RpcListSessionsOptions {
	cwd?: string;
}

export interface RpcResolveSessionOptions extends RpcListSessionsOptions {
	session: string;
}

export function toRpcSessionInfo(info: SessionInfo): RpcSessionInfo {
	const modified = toIsoString(info.modified, info.created);
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		title: info.title,
		parentSessionPath: info.parentSessionPath,
		created: toIsoString(info.created, info.modified),
		modified,
		messageCount: info.messageCount,
		size: info.size,
		firstMessage: info.firstMessage,
		allMessagesText: info.allMessagesText,
		status: info.status,
	};
}

function toIsoString(date: Date, fallback: Date): string {
	if (Number.isFinite(date.getTime())) return date.toISOString();
	if (Number.isFinite(fallback.getTime())) return fallback.toISOString();
	return new Date(0).toISOString();
}

export async function listRpcSessions(
	session: Pick<AgentSession, "sessionManager">,
	options: RpcListSessionsOptions = {},
): Promise<RpcListSessionsResult> {
	const cwd = options.cwd ?? session.sessionManager.getCwd();
	const sessionDir = resolveListSessionDir(session, cwd);
	const sessions = await SessionManager.list(cwd, sessionDir);
	return { cwd, sessionDir, sessions: sessions.map(toRpcSessionInfo) };
}

export async function listAllRpcSessions(): Promise<{ sessions: RpcSessionInfo[] }> {
	const sessions = await SessionManager.listAll();
	return { sessions: sessions.map(toRpcSessionInfo) };
}

export async function resolveRpcSession(
	session: Pick<AgentSession, "sessionManager">,
	options: RpcResolveSessionOptions,
): Promise<RpcResolveSessionResult> {
	const cwd = options.cwd ?? session.sessionManager.getCwd();
	const sessionArg = options.session;
	if (sessionArg.trim() === "") return { match: null };
	const currentSessionDir = resolveResumeSessionDir(session, cwd);
	const currentMatch =
		currentSessionDir === undefined
			? undefined
			: ((await resolveRpcSessionPath(sessionArg, cwd, currentSessionDir)) ??
				(await resolveResumableSession(sessionArg, cwd, currentSessionDir)));
	const match =
		currentMatch ??
		(await resolveRpcSessionPath(sessionArg, cwd, undefined)) ??
		(await resolveResumableSession(sessionArg, cwd));
	return match === undefined
		? { match: null }
		: { match: { scope: match.scope, session: toRpcSessionInfo(match.session) } };
}

async function resolveRpcSessionPath(
	sessionArg: string,
	cwd: string,
	sessionDir: string | undefined,
): Promise<{ session: SessionInfo; scope: "local" | "global" } | undefined> {
	if (!path.isAbsolute(sessionArg)) return undefined;
	const normalizedPath = path.resolve(sessionArg);
	const localSessionDir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd);
	const localSessions = await SessionManager.list(cwd, localSessionDir);
	const localMatch = localSessions.find(session => path.resolve(session.path) === normalizedPath);
	if (localMatch) return { session: localMatch, scope: "local" };
	if (sessionDir !== undefined) return undefined;

	const globalSessions = await SessionManager.listAll();
	const globalMatch = globalSessions.find(session => path.resolve(session.path) === normalizedPath);
	if (globalMatch) return { session: globalMatch, scope: "global" };
	return undefined;
}

function resolveListSessionDir(session: Pick<AgentSession, "sessionManager">, cwd: string): string {
	const currentSessionDir = session.sessionManager.getSessionDir();
	if (cwd === session.sessionManager.getCwd() && currentSessionDir !== "") return currentSessionDir;
	return SessionManager.getDefaultSessionDir(cwd);
}

function resolveResumeSessionDir(session: Pick<AgentSession, "sessionManager">, cwd: string): string | undefined {
	const currentSessionDir = session.sessionManager.getSessionDir();
	if (cwd !== session.sessionManager.getCwd() || currentSessionDir === "") return undefined;
	const defaultSessionDir = SessionManager.getDefaultSessionDir(cwd);
	return path.resolve(currentSessionDir) === path.resolve(defaultSessionDir) ? undefined : currentSessionDir;
}
