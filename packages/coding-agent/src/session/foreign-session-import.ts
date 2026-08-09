import { directoryExists } from "@oh-my-pi/pi-utils";
import { ClaudeSessionStore } from "./claude-session-store";
import { CodexSessionStore } from "./codex-session-store";
import type {
	ForeignSessionInfo,
	ForeignSessionProvenance,
	ForeignSessionSource,
	ForeignSessionStore,
} from "./foreign-session-store";
import type { SessionInfo } from "./session-listing";
import type { SessionManager } from "./session-manager";

/** Construct the importer for a supported foreign session source. */
export function createForeignSessionStore(source: ForeignSessionSource): ForeignSessionStore {
	return source === "claude" ? new ClaudeSessionStore() : new CodexSessionStore();
}

/** Display name for a supported foreign session source. */
export function foreignSessionSourceName(source: ForeignSessionSource): string {
	return source === "claude" ? "Claude" : "Codex";
}

/** Convert lightweight foreign metadata for the existing session picker. */
export function foreignSessionInfoToSessionInfo(info: ForeignSessionInfo): SessionInfo {
	const firstMessage = info.firstMessage ?? "(no messages)";
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		title: info.title,
		created: info.created,
		modified: info.modified,
		messageCount: info.messageCount ?? 0,
		size: 0,
		firstMessage,
		allMessagesText: firstMessage,
	};
}

/** Persist an already-converted session under a fresh OMP identity with provenance. */
export async function persistConvertedSession(
	converted: SessionManager,
	provenance: ForeignSessionProvenance,
	options?: { fallbackCwd?: string; sessionDir?: string; suppressBreadcrumb?: boolean },
): Promise<SessionManager> {
	const persisted = await converted.persistCopy(options);
	if (options?.fallbackCwd && !(await directoryExists(persisted.getCwd()))) {
		await persisted.moveTo(options.fallbackCwd, options.sessionDir);
	}
	persisted.appendCustomEntry("foreign_session_import", provenance);
	await persisted.flush();
	return persisted;
}

/** Import and persist one foreign session under a fresh OMP session identity. */
export async function persistForeignSession(
	store: ForeignSessionStore,
	info: ForeignSessionInfo,
	options?: { fallbackCwd?: string; sessionDir?: string; suppressBreadcrumb?: boolean },
): Promise<SessionManager> {
	const imported = await store.load(info);
	return await persistConvertedSession(
		imported,
		{
			source: info.source,
			sourceId: info.id,
			sourcePath: info.path,
			sourceCwd: info.cwd,
		},
		options,
	);
}
