import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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

export type OwnedInode = { readonly dev: number; readonly ino: number };

async function inodeAt(file: string | undefined): Promise<OwnedInode | undefined> {
	if (!file) return undefined;
	try {
		const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			const stat = await handle.stat();
			return stat.isFile() ? { dev: stat.dev, ino: stat.ino } : undefined;
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function removeOwnedInode(
	files: readonly (string | undefined)[],
	owned: OwnedInode | undefined,
): Promise<boolean> {
	if (!owned) return false;
	for (const file of [...new Set(files)].filter((value): value is string => value !== undefined)) {
		const candidate = path.resolve(file);
		const current = await inodeAt(candidate);
		if (!current || current.dev !== owned.dev || current.ino !== owned.ino) continue;
		const quarantine = `${candidate}.cleanup-${randomUUID()}`;
		try {
			await fs.rename(candidate, quarantine);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		const moved = await inodeAt(quarantine);
		if (!moved || moved.dev !== owned.dev || moved.ino !== owned.ino) return false;
		await fs.unlink(quarantine);
		return true;
	}
	return false;
}
export interface PersistedSessionPublication {
	readonly path: string;
	readonly identity: OwnedInode;
}

export interface PersistConvertedSessionOptions {
	readonly fallbackCwd?: string;
	readonly sessionDir?: string;
	readonly suppressBreadcrumb?: boolean;
	readonly onPublished?: (publication: PersistedSessionPublication) => void | Promise<void>;
	readonly onCleanupFailure?: (publication: PersistedSessionPublication, error: unknown) => void | Promise<void>;
}
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
	options?: PersistConvertedSessionOptions,
): Promise<SessionManager> {
	const staged = converted.cloneCurrentSession({ persist: false });
	let persisted: SessionManager | undefined;
	let stagedCloseAttempted = false;
	let publication: PersistedSessionPublication | undefined;
	const paths: (string | undefined)[] = [];
	const rememberCurrentPath = (): void => {
		if (!persisted) return;
		try {
			paths.push(persisted.getSessionFile());
		} catch {
			// Cleanup must not replace the primary persistence failure.
		}
	};
	const notifyCleanupFailure = async (error: unknown): Promise<void> => {
		if (!publication || !options?.onCleanupFailure) return;
		try {
			await options.onCleanupFailure(publication, error);
		} catch {
			// Preserve the primary persistence failure.
		}
	};
	const cleanupPublished = async (): Promise<void> => {
		if (!publication) return;
		try {
			const removed = await removeOwnedInode(paths, publication.identity);
			if (!removed) await notifyCleanupFailure(new Error("published session cleanup could not be proven"));
		} catch (error) {
			await notifyCleanupFailure(error);
		}
	};
	const abortPublication = async (error: unknown): Promise<never> => {
		rememberCurrentPath();
		try {
			await persisted?.close();
		} catch {
			// Preserve the primary persistence failure.
		}
		await cleanupPublished();
		throw error;
	};
	try {
		staged.appendCustomEntry("foreign_session_import", provenance);
		const fallbackCwd =
			options?.fallbackCwd && !(await directoryExists(staged.getCwd()))
				? path.resolve(options.fallbackCwd)
				: undefined;
		persisted = await staged.persistCopyCreateOnly({
			sessionDir: options?.sessionDir,
			suppressBreadcrumb: options?.suppressBreadcrumb,
			...(fallbackCwd ? { cwd: fallbackCwd } : {}),
		});
		const initialPath = persisted.getSessionFile();
		const initialIdentity = await inodeAt(initialPath);
		if (!initialPath || !initialIdentity) throw new Error("published session ownership unavailable");
		paths.push(initialPath);
		publication = { path: initialPath, identity: initialIdentity };
		try {
			const publishedPath = persisted.getSessionFile();
			if (!publishedPath) throw new Error("published session path unavailable");
			publication = { path: publishedPath, identity: initialIdentity };
			await options?.onPublished?.(publication);
			await persisted.flush();
			await persisted.close();
		} catch (error) {
			await abortPublication(error);
		}

		stagedCloseAttempted = true;
		try {
			await staged.close();
		} catch (error) {
			await abortPublication(error);
		}
		return persisted;
	} catch (error) {
		if (!stagedCloseAttempted) {
			try {
				await staged.close();
			} catch {
				// Preserve the original persistence failure.
			}
		}
		throw error;
	}
}

/** Import and persist one foreign session under a fresh OMP session identity. */
export async function persistForeignSession(
	store: ForeignSessionStore,
	info: ForeignSessionInfo,
	options?: PersistConvertedSessionOptions,
): Promise<SessionManager> {
	const imported = await store.load(info);
	return persistConvertedSession(
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
