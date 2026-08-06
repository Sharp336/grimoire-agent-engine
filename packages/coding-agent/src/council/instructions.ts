import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ContextFileEntry, ToolSession } from "../tools";
import * as workspaceTree from "../workspace-tree";
import { sha256CouncilContent } from "./hash";
import type { CouncilInstructionSnapshot } from "./state";

export { sha256CouncilContent as sha256Text } from "./hash";

export const DEFAULT_COUNCIL_INSTRUCTION_BYTES = 512 * 1024;

export class CouncilInstructionSnapshotError extends Error {
	readonly code = "COUNCIL_INSTRUCTION_SNAPSHOT_INVALID";
	readonly spending = false;

	constructor(message: string) {
		super(message);
		this.name = "CouncilInstructionSnapshotError";
	}
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalInstructionPath(repoRoot: string, candidate: string): Promise<string> {
	const lexical = path.resolve(repoRoot, candidate);
	try {
		const [info, canonical] = await Promise.all([fs.lstat(lexical), fs.realpath(lexical)]);
		if (info.isSymbolicLink() || canonical !== lexical) {
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
		return canonical;
	} catch (error) {
		if (error instanceof CouncilInstructionSnapshotError) throw error;
		throw new CouncilInstructionSnapshotError(
			`Council instruction file ${JSON.stringify(candidate)} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function readInstructionFile(
	repoRoot: string,
	candidate: string,
	remainingBytes: number,
	byteLimit: number,
): Promise<{ path: string; content: string }> {
	const lexical = path.resolve(repoRoot, candidate);
	let canonical: string;
	let expectedDevice = -1;
	let expectedInode = -1;
	try {
		const [canonicalPath, lexicalInfo] = await Promise.all([fs.realpath(lexical), fs.lstat(lexical)]);
		canonical = canonicalPath;
		if (lexicalInfo.isSymbolicLink() || canonical !== lexical) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction file ${JSON.stringify(candidate)} uses a symlink`,
			);
		}
		if (!lexicalInfo.isFile()) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction path ${JSON.stringify(candidate)} is not a regular file`,
			);
		}
		if (!isContained(repoRoot, canonical)) {
			throw new CouncilInstructionSnapshotError(
				`Council instruction file ${JSON.stringify(candidate)} resolves outside repository root ${JSON.stringify(repoRoot)}`,
			);
		}
		expectedDevice = lexicalInfo.dev;
		expectedInode = lexicalInfo.ino;
	} catch (error) {
		if (error instanceof CouncilInstructionSnapshotError) throw error;
		throw new CouncilInstructionSnapshotError(
			`Council instruction file ${JSON.stringify(candidate)} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let handle: fs.FileHandle;
	try {
		handle = await fs.open(lexical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
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
	const nested = [...inheritedNested, ...discoveredNested];
	const captured = new Map<string, ContextFileEntry>();
	let totalBytes = 0;
	for (const entry of inherited) {
		const canonical = await canonicalInstructionPath(canonicalRoot, entry.path);
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
		const lexical = path.resolve(canonicalRoot, candidate);
		if (captured.has(lexical)) continue;
		const entry = await readInstructionFile(canonicalRoot, candidate, maxBytes - totalBytes, maxBytes);
		const bytes = Buffer.byteLength(entry.content);
		captured.set(entry.path, entry);
		totalBytes += bytes;
	}

	const contextFiles = [...captured.values()].sort((left, right) => {
		const leftDepth = path.relative(canonicalRoot, left.path).split(path.sep).length;
		const rightDepth = path.relative(canonicalRoot, right.path).split(path.sep).length;
		return leftDepth - rightDepth || left.path.localeCompare(right.path);
	});

	return {
		repoRoot: canonicalRoot,
		contextFiles,
		files: contextFiles.map(entry => ({ path: entry.path, sha256: sha256CouncilContent(entry.content) })),
		totalBytes,
	};
}
