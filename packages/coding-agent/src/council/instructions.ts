import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode } from "@oh-my-pi/pi-utils";
import type { ContextFileEntry, ToolSession } from "../tools";
import * as workspaceTree from "../workspace-tree";
import { COUNCIL_READ_FLAGS, isContained } from "./durable-fs";
import { sha256CouncilContent } from "./hash";
import type { CouncilInstructionSnapshot } from "./state";

export const DEFAULT_COUNCIL_INSTRUCTION_BYTES = 512 * 1024;

export class CouncilInstructionSnapshotError extends Error {
	readonly code = "COUNCIL_INSTRUCTION_SNAPSHOT_INVALID";
	readonly spending = false;

	constructor(message: string) {
		super(message);
		this.name = "CouncilInstructionSnapshotError";
	}
}

/**
 * Canonicalizes every ancestor of `target` but never its final component.
 *
 * A symlinked ancestor is ordinary - macOS resolves `/var` to `/private/var`, and checkouts are
 * routinely reached through a symlinked home or project directory - so comparing a full `realpath`
 * against the lexical path misreports those as symlinked instruction files. Leaving the basename
 * unresolved keeps the `lstat`/`O_NOFOLLOW` pair as the sole symlink gate while still giving
 * containment a canonical directory prefix to judge.
 */
async function canonicalizeAncestors(target: string): Promise<string> {
	return path.join(await fs.realpath(path.dirname(target)), path.basename(target));
}

/**
 * Identity key for an inherited context entry.
 *
 * These arrive with their content already loaded by the parent session, so nothing is read from
 * disk here and the path is only a dedupe key. User-level instruction files legitimately live
 * outside the repository (`~/.claude/CLAUDE.md`, `~/.omp/AGENTS.md`, …), so containment and symlink
 * hardening apply only to the nested files this module opens itself. Canonicalization is a
 * best-effort dedupe aid: a path that no longer resolves must not abort a snapshot whose content is
 * already in hand.
 */
async function inheritedInstructionPath(repoRoot: string, candidate: string): Promise<string> {
	if (candidate.trim() === "") {
		throw new CouncilInstructionSnapshotError("Council instruction file path is empty");
	}
	const lexical = path.resolve(repoRoot, candidate);
	try {
		return await canonicalizeAncestors(lexical);
	} catch {
		return lexical;
	}
}

/** Sort weight: out-of-repo user-level instructions lead so repository files override them. */
function instructionOrderDepth(root: string, filePath: string): number {
	if (!isContained(root, filePath)) return 0;
	return path.relative(root, filePath).split(path.sep).length;
}

async function readInstructionFile(
	repoRoot: string,
	candidate: string,
	remainingBytes: number,
	byteLimit: number,
): Promise<{ path: string; content: string }> {
	let canonical: string;
	let expectedDevice = -1;
	let expectedInode = -1;
	try {
		canonical = await canonicalizeAncestors(path.resolve(repoRoot, candidate));
		const info = await fs.lstat(canonical);
		if (info.isSymbolicLink()) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction file ${JSON.stringify(candidate)} uses a symlink`,
			);
		}
		if (!info.isFile()) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction path ${JSON.stringify(candidate)} is not a regular file`,
			);
		}
		if (!isContained(repoRoot, canonical)) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction file ${JSON.stringify(candidate)} resolves outside repository root ${JSON.stringify(repoRoot)}`,
			);
		}
		expectedDevice = info.dev;
		expectedInode = info.ino;
	} catch (error) {
		if (error instanceof CouncilInstructionSnapshotError) throw error;
		throw new CouncilInstructionSnapshotError(
			`Council instruction file ${JSON.stringify(candidate)} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let handle: fs.FileHandle;
	try {
		handle = await fs.open(canonical, COUNCIL_READ_FLAGS);
	} catch (error) {
		if (hasFsCode(error, "ELOOP")) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction file ${JSON.stringify(candidate)} uses a symlink`,
			);
		}
		throw new CouncilInstructionSnapshotError(
			`Council instruction file ${JSON.stringify(candidate)} could not be opened: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction path ${JSON.stringify(candidate)} is not a regular file`,
			);
		}
		if (info.dev !== expectedDevice || info.ino !== expectedInode) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction file ${JSON.stringify(candidate)} changed during capture`,
			);
		}
		if (info.size > remainingBytes) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction snapshot exceeds ${byteLimit} bytes at ${JSON.stringify(canonical)}`,
			);
		}
		const bytes = Buffer.allocUnsafe(remainingBytes + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > remainingBytes) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction snapshot exceeds ${byteLimit} bytes at ${JSON.stringify(canonical)}`,
			);
		}
		try {
			const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset));
			return { path: canonical, content };
		} catch (error) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction file ${JSON.stringify(candidate)} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} finally {
		await handle.close();
	}
}

/**
 * Captures all inherited context plus nested AGENTS.md contents before dispatch.
 * Children consume the returned entries directly and never need instruction-file tool reads.
 */
export async function captureCouncilInstructionSnapshot(
	session: Pick<ToolSession, "contextFiles" | "workspaceTree">,
	repoRoot: string,
	maxBytes = DEFAULT_COUNCIL_INSTRUCTION_BYTES,
): Promise<CouncilInstructionSnapshot> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new CouncilInstructionSnapshotError(`Council instruction byte limit must be a non-negative safe integer`);
	}
	let canonicalRoot: string;
	try {
		canonicalRoot = await fs.realpath(path.resolve(repoRoot));
		const rootInfo = await fs.lstat(canonicalRoot);
		if (!rootInfo.isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new CouncilInstructionSnapshotError(
			`Council repository root ${JSON.stringify(repoRoot)} is unusable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const inherited = session.contextFiles ?? [];
	let discovered: workspaceTree.WorkspaceTree;
	try {
		discovered = await workspaceTree.buildWorkspaceTree(canonicalRoot, { strict: true });
	} catch (error) {
		throw new CouncilInstructionSnapshotError(
			`Council instruction discovery failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const inheritedNested = (session.workspaceTree?.agentsMdFiles ?? []).map(candidate =>
		path.isAbsolute(candidate) ? candidate : path.resolve(session.workspaceTree!.rootPath, candidate),
	);
	const discoveredNested = discovered.agentsMdFiles.map(candidate =>
		path.isAbsolute(candidate) ? candidate : path.resolve(canonicalRoot, candidate),
	);
	// One pass per distinct path: reading the same file twice would count its bytes twice.
	const nested = new Set(
		[...inheritedNested, ...discoveredNested].map(candidate => path.resolve(canonicalRoot, candidate)),
	);
	const captured = new Map<string, ContextFileEntry>();
	let totalBytes = 0;
	for (const entry of inherited) {
		const canonical = await inheritedInstructionPath(canonicalRoot, entry.path);
		if (captured.has(canonical)) continue;
		const bytes = Buffer.byteLength(entry.content);
		if (bytes > maxBytes - totalBytes) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction snapshot exceeds ${maxBytes} bytes at ${JSON.stringify(canonical)}`,
			);
		}
		captured.set(canonical, { path: canonical, content: entry.content, depth: entry.depth });
		totalBytes += bytes;
	}
	for (const candidate of nested) {
		if (captured.has(candidate)) continue;
		const entry = await readInstructionFile(canonicalRoot, candidate, maxBytes - totalBytes, maxBytes);
		// Distinct candidates can canonicalize onto one file, so recheck after the read resolves it.
		if (captured.has(entry.path)) continue;
		captured.set(entry.path, entry);
		totalBytes += Buffer.byteLength(entry.content);
	}

	// Codepoint order, not `localeCompare`: this list is hashed into `instructions.json` and compared
	// on resume, so the ordering must not shift with the host's locale or ICU version.
	const contextFiles = [...captured.values()].sort((left, right) => {
		const depthDelta =
			instructionOrderDepth(canonicalRoot, left.path) - instructionOrderDepth(canonicalRoot, right.path);
		if (depthDelta !== 0) return depthDelta;
		return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
	});

	return {
		repoRoot: canonicalRoot,
		contextFiles,
		files: contextFiles.map(entry => ({ path: entry.path, sha256: sha256CouncilContent(entry.content) })),
		totalBytes,
	};
}
