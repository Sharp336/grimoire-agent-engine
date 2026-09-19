/**
 * Shared helpers for internal-url protocol handlers that resolve IDs against
 * registered agent sessions.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import type { ResolveContext } from "./types";

const extraArtifactsDirs = new Set<string>();

export function registerArtifactsDir(dir: string): () => void {
	extraArtifactsDirs.add(dir);
	return () => {
		extraArtifactsDirs.delete(dir);
	};
}

export function resetRegisteredArtifactDirsForTests(): void {
	extraArtifactsDirs.clear();
}

/**
 * Snapshot of artifacts dirs for every registered session, deduped.
 *
 * Collects TWO candidate dirs per ref, because a subagent reads from its
 * adopted (root-wide) `ArtifactManager.dir` but its own children are written
 * one level deeper, under `sessionFile.slice(0, -6)` (`task/index.ts`). A
 * depth-2+ subagent's output therefore lives in the write-time dir, not the
 * adopted one, so `agent://` must scan both or it 404s a live nested peer.
 * `addDir` dedup collapses the depth-0 case (both formulas agree) back to a
 * single entry.
 *
 * When `options.preferredDir` is supplied — the caller root's canonical
 * artifact directory, derived from the caller's session file — it is inserted
 * FIRST, ahead of every registry-derived dir. Under A/B same-id conflicts the
 * caller's own root must win even when the process-global registry's single
 * `Main` ref belongs to another root (or the caller's session is not
 * registered at all). Absent a preferred dir, the pre-existing process-global
 * ordering is preserved unchanged.
 */
export function agentRegistryFromContext(context?: ResolveContext): AgentRegistry {
	if (context?.agentRegistry) return context.agentRegistry;
	if (context?.engineMode) throw new Error("Engine internal URL resolution requires an AgentRegistry");
	return AgentRegistry.global();
}

export function artifactsDirsFromRegistry(options?: {
	preferredDir?: string;
	agentRegistry?: AgentRegistry;
}): string[] {
	const dirs: string[] = [];
	const addDir = (dir: string | null | undefined) => {
		if (!dir) return;
		if (!dirs.includes(dir)) dirs.push(dir);
	};
	if (options?.preferredDir) addDir(options.preferredDir);
	for (const ref of (options?.agentRegistry ?? AgentRegistry.global()).list()) {
		addDir(ref.session?.sessionManager?.getArtifactsDir());
		if (ref.sessionFile) addDir(ref.sessionFile.slice(0, -6));
	}
	for (const dir of extraArtifactsDirs) addDir(dir);
	return dirs;
}

export async function sessionFilesFromDisk(
	preferredDir?: string,
	agentRegistry: AgentRegistry = AgentRegistry.global(),
): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	const seenDirs = new Set<string>();
	const scan = async (dir: string, depth: number): Promise<void> => {
		if (depth > 8 || seenDirs.has(dir)) return;
		seenDirs.add(dir);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return;
			throw err;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				await scan(path.join(dir, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			const name = entry.name;
			if (!name.endsWith(".jsonl") || /^__advisor(?:\.[^.]+)?\.jsonl$/.test(name)) continue;
			const id = name.slice(0, -".jsonl".length);
			if (!found.has(id)) found.set(id, path.join(dir, name));
		}
	};
	const registryDirs = artifactsDirsFromRegistry({ agentRegistry });
	const dirs = preferredDir ? [preferredDir, ...registryDirs] : registryDirs;
	for (const dir of dirs) await scan(dir, 0);
	return found;
}

/**
 * Availability half of the `history://` resolution semantics: true when a
 * transcript for `agentId` can be served from a registered ref's live session
 * or retained session file, or from an on-disk `.jsonl` under a known
 * artifacts dir. Hint surfaces use this so they only advertise
 * `history://<agentId>` links that `HistoryProtocolHandler` can actually
 * resolve. A retained sessionFile path is verified on disk before it counts,
 * and probing never throws: a stale path or unreadable artifacts subtree
 * reads as unavailable instead of disturbing the caller's delivery path.
 */
export async function hasResolvableTranscript(
	agentId: string,
	agentRegistry: AgentRegistry = AgentRegistry.global(),
): Promise<boolean> {
	try {
		const registry = agentRegistry;
		const lower = agentId.toLowerCase();
		let ref = registry.get(agentId);
		ref ??= registry.list().find(candidate => candidate.id.toLowerCase() === lower);
		if (ref?.session) return true;
		if (ref?.sessionFile && (await isReadableFile(ref.sessionFile))) return true;
		const files = await sessionFilesFromDisk(undefined, registry);
		for (const id of files.keys()) {
			if (id.toLowerCase() === lower) return true;
		}
	} catch {
		// Availability probing is advisory; any filesystem failure means the
		// transcript cannot be promised, never that delivery should fail.
	}
	return false;
}

/** True when `file` exists and is a regular file; never throws. */
async function isReadableFile(file: string): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		return stat.isFile();
	} catch {
		return false;
	}
}
