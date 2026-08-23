import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { getSessionsDir, hasFsCode, isEnoent } from "@oh-my-pi/pi-utils";
import { listSessionsReadOnly, type SessionInfo } from "./session-listing";
import { resolveManagedSessionRoot } from "./session-paths";
import { FileSessionStorage } from "./session-storage";

const JSONL_GLOB = new Bun.Glob("**/*.jsonl");
export const LIVE_NESTED_STATUSES: Record<string, true> = {
	pending: true,
	interrupted: true,
	unknown: true,
};
export const SESSION_SUFFIX = ".jsonl";
export const COMPRESSED_SESSION_SUFFIX = ".jsonl.gz";

export function archivedSessionsDirForRoot(sessionsRoot: string): string {
	if (path.basename(sessionsRoot) === "sessions") {
		return path.join(path.dirname(sessionsRoot), "archive", "sessions");
	}
	return path.join(sessionsRoot, "archive");
}

export function getArchivedSessionsDir(agentDir: string): string {
	return archivedSessionsDirForRoot(getSessionsDir(agentDir));
}

/**
 * Pick the sessions root that actually contains `sessionFile`, then the matching
 * archive tree. Default profile sessions keep `../archive/sessions`; a custom
 * `--session-dir` archives beside that directory. Returns null when the file is
 * not under the session manager directory or the default store.
 */
export function resolveArchiveRoots(input: {
	sessionFile: string;
	sessionDir: string;
	cwd: string;
	agentDir: string;
}): { sessionsRoot: string; archiveRoot: string; destinationPath: string } | null {
	const sessionFile = path.resolve(input.sessionFile);
	const sessionDir = path.resolve(input.sessionDir);
	const candidates: string[] = [path.resolve(getSessionsDir(input.agentDir))];
	const managedRoot = resolveManagedSessionRoot(sessionDir, input.cwd);
	if (managedRoot) candidates.push(path.resolve(managedRoot));
	if (path.basename(sessionDir) === "sessions") {
		candidates.push(sessionDir);
	} else if (path.basename(path.dirname(sessionDir)) === "sessions") {
		candidates.push(path.dirname(sessionDir));
	}
	candidates.push(sessionDir);

	const seen = new Set<string>();
	for (const sessionsRoot of candidates) {
		if (seen.has(sessionsRoot)) continue;
		seen.add(sessionsRoot);
		const archiveRoot = archivedSessionsDirForRoot(sessionsRoot);
		const destination = resolveArchiveDestination(sessionFile, sessionsRoot, archiveRoot);
		if (destination) {
			return { sessionsRoot, archiveRoot, destinationPath: destination.destinationPath };
		}
	}
	return null;
}

export async function archiveDestinationExists(destinationPath: string): Promise<boolean> {
	const legacyDestSession = destinationPath.endsWith(".gz")
		? destinationPath.slice(0, -".gz".length)
		: `${destinationPath}.gz`;
	return (await pathExists(destinationPath)) || (await pathExists(legacyDestSession));
}

export function sessionArtifactsPath(sessionPath: string): string {
	if (sessionPath.endsWith(COMPRESSED_SESSION_SUFFIX)) {
		return sessionPath.slice(0, -COMPRESSED_SESSION_SUFFIX.length);
	}
	return sessionPath.slice(0, -SESSION_SUFFIX.length);
}

export function resolveArchiveDestination(
	sessionPath: string,
	sessionsRoot: string,
	archiveRoot: string,
): { relativePath: string; destinationPath: string } | null {
	const relativePath = path.relative(sessionsRoot, sessionPath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
	if (!relativePath.endsWith(SESSION_SUFFIX)) return null;
	return {
		relativePath,
		destinationPath: path.join(archiveRoot, `${relativePath}.gz`),
	};
}

export async function archiveSessionFile(
	sessionPath: string,
	sessionsRoot: string,
	archiveRoot: string,
): Promise<string> {
	const destination = resolveArchiveDestination(sessionPath, sessionsRoot, archiveRoot);
	if (!destination) throw new Error(`session is outside the sessions directory: ${sessionPath}`);
	await moveSessionWithArtifacts(sessionPath, destination.destinationPath);
	return destination.destinationPath;
}

export async function sessionHasLiveNestedSessions(
	sessionPath: string,
	options?: { recentlyModifiedAfterMs?: number },
): Promise<boolean> {
	for (const nested of await listNestedSessionsReadOnly(sessionArtifactsPath(sessionPath))) {
		if (nested.status && LIVE_NESTED_STATUSES[nested.status]) return true;
		if (
			options?.recentlyModifiedAfterMs !== undefined &&
			nested.modified.getTime() > options.recentlyModifiedAfterMs
		) {
			return true;
		}
	}
	return false;
}

export async function moveSessionWithArtifacts(sourceSession: string, destSession: string): Promise<void> {
	const legacyDestSession = destSession.endsWith(".gz") ? destSession.slice(0, -".gz".length) : `${destSession}.gz`;
	const sourceArtifacts = sessionArtifactsPath(sourceSession);
	const destArtifacts = sessionArtifactsPath(destSession);
	if (await pathExists(destSession)) throw new Error(`archive destination exists: ${destSession}`);
	if (await pathExists(legacyDestSession)) throw new Error(`archive destination exists: ${legacyDestSession}`);
	if ((await pathExists(sourceArtifacts)) && (await pathExists(destArtifacts))) {
		throw new Error(`archive artifacts destination exists: ${destArtifacts}`);
	}

	const moved: Array<{ source: string; destination: string; compressed?: boolean }> = [];
	try {
		await gzipSessionFile(sourceSession, destSession);
		moved.push({ source: sourceSession, destination: destSession, compressed: true });
		if (await pathExists(sourceArtifacts)) {
			await movePath(sourceArtifacts, destArtifacts);
			moved.push({ source: sourceArtifacts, destination: destArtifacts });
		}
	} catch (error) {
		for (const move of moved.reverse()) {
			try {
				if (move.compressed) {
					await restoreGzipSessionFile(move.destination, move.source);
				} else {
					await movePath(move.destination, move.source);
				}
			} catch {
				// Preserve the original failure; rollback failure is reported by the next scan.
			}
		}
		throw error;
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

export async function collectGlobFiles(root: string, glob: Bun.Glob): Promise<string[]> {
	try {
		const files = await Array.fromAsync(glob.scan(root), name => path.join(root, name));
		files.sort();
		return files;
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function listNestedSessionsReadOnly(artifactsRoot: string) {
	const files = await collectGlobFiles(artifactsRoot, JSONL_GLOB);
	const dirs = [...new Set(files.map(file => path.dirname(file)))].sort();
	const storage = new FileSessionStorage();
	const sessions: SessionInfo[] = [];
	for (const dir of dirs) sessions.push(...(await listSessionsReadOnly(dir, storage)));
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

async function movePath(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	try {
		await fs.rename(source, destination);
		return;
	} catch (error) {
		if (!hasFsCode(error, "EXDEV")) throw error;
	}
	const stat = await fs.stat(source);
	if (stat.isDirectory()) {
		await fs.cp(source, destination, { recursive: true });
		await fs.rm(source, { recursive: true, force: true });
		return;
	}
	await fs.copyFile(source, destination);
	await fs.unlink(source);
}

async function gzipSessionFile(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const tempPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
	let renamed = false;
	try {
		const compressed = gzipSync(await Bun.file(source).bytes(), { level: 9 });
		await Bun.write(tempPath, compressed);
		await fs.rename(tempPath, destination);
		renamed = true;
		await fs.unlink(source);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		if (renamed) await fs.rm(destination, { force: true });
		throw error;
	}
}

async function restoreGzipSessionFile(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const decompressed = gunzipSync(await Bun.file(source).bytes());
	await Bun.write(destination, decompressed);
	await fs.unlink(source);
}
