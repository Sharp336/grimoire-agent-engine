/**
 * @file Reference Resolution for Context Files
 *
 * Resolves `@relative/path.ext` references found in context file content
 * (CLAUDE.md, AGENTS.md, etc.) by inlining the referenced file's content
 * at the point of reference.
 *
 * Pattern: a line that is exactly `@path/to/file.ext` (must contain a `.`)
 * — resolved relative to the context file's directory.
 * — contained within the context file's repo root (or cwd fallback).
 * — symlinks resolved before containment check to prevent traversal.
 * — recursive with depth limit and cycle detection.
 * — git worktree refs require tracked targets when git metadata is available.
 * — controlled by the `contextFiles.resolveAtRefs` setting (default: enabled).
 *
 * See: https://github.com/can1357/oh-my-pi/issues/375
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { glob } from "@oh-my-pi/pi-natives";
import * as git from "../utils/git";
import { findRepoRoot, readFile } from "./fs";

export interface ResolveAtRefsFile {
	path: string;
	content: string;
	depth?: number;
	/** Per-file containment root, used when discovery knows the project scope. */
	rootDir?: string;
}

export interface ResolveAtRefsOptions {
	/** Maximum recursion depth for nested @-references (default: 5) */
	maxDepth?: number;
	/**
	 * Boundary directory for path containment.
	 * Resolved refs that escape this root are rejected.
	 * When unset, each context file's containment root is independently
	 * discovered from its own path (repo root → directory fallback),
	 * so user-level files are not rejected by a project-level boundary.
	 */
	rootDir?: string;
}

/**
 * Matches a line that is *exactly* an @-reference:
 *   - Must start with `@`
 *   - Must contain at least one `.` (to distinguish from mentions/emails)
 *   - Must not contain whitespace (paths don't have spaces)
 *   - Allows letters, digits, `-`, `_`, `.`, `/`
 *   - Must be on its own line (leading/trailing whitespace is stripped)
 *
 * Examples that match:
 *   @package.json
 *   @pyproject.toml
 *   @../configs/rules.md
 *   @src/types.ts
 *
 * Examples that don't match:
 *   @username (no extension)
 *   email@example.com (@ is not at start of segment)
 *   See @foo for details (not on its own line)
 */
const AT_REF_PATTERN = /^@([\w.\-/]+\.[\w.-]+)\s*$/;

function isWithin(absPath: string, root: string): boolean {
	const normalized = path.normalize(absPath);
	const normalizedRoot = path.normalize(root);
	return normalized.startsWith(normalizedRoot + path.sep) || normalized === normalizedRoot;
}

async function realpathOrSelf(filePath: string): Promise<string> {
	try {
		return await fs.promises.realpath(filePath);
	} catch {
		return filePath;
	}
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

async function isIgnoredByGitignore(absPath: string, root: string): Promise<boolean> {
	const relativePath = path.relative(root, absPath);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		return true;
	}
	const pattern = toPosixPath(relativePath);
	try {
		const result = await glob({ pattern, path: root, hidden: true, gitignore: true, maxResults: 1 });
		return !result.matches.some(match => match.path === pattern);
	} catch {
		return true;
	}
}

async function loadTrackedFiles(root: string): Promise<Set<string> | null> {
	try {
		return new Set(await git.ls.files(root));
	} catch {
		return null;
	}
}

function isTrackedByGit(absPath: string, root: string, trackedFiles: Set<string> | null): boolean {
	if (!trackedFiles) return true;
	const relativePath = path.relative(root, absPath);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		return false;
	}
	return trackedFiles.has(toPosixPath(relativePath));
}

async function resolveContent(
	content: string,
	filePath: string,
	realRootDir: string,
	trackedFiles: Set<string> | null,
	seen: Set<string>,
	depth: number,
	maxDepth: number,
): Promise<string> {
	if (depth >= maxDepth) return content;

	const baseDir = path.dirname(filePath);
	const lines = content.split("\n");
	const resolved: string[] = [];

	for (const line of lines) {
		const match = AT_REF_PATTERN.exec(line);
		if (!match) {
			resolved.push(line);
			continue;
		}

		const refPath = match[1];

		// Reject absolute paths — @-refs must be relative
		if (path.isAbsolute(refPath)) {
			resolved.push(`<!-- @${refPath}: absolute paths are not allowed -->`);
			continue;
		}

		let realRefPath: string;
		try {
			realRefPath = await fs.promises.realpath(path.resolve(baseDir, refPath));
		} catch {
			resolved.push(`<!-- @${refPath}: file not found -->`);
			continue;
		}

		// Containment is enforced in the realpath namespace. That keeps ordinary
		// refs, symlinked context files, and symlinked included files on the same
		// path model while still rejecting symlink traversal outside the root.
		if (!isWithin(realRefPath, realRootDir)) {
			resolved.push(`<!-- @${refPath}: escapes project root -->`);
			continue;
		}

		const trackedByGit = isTrackedByGit(realRefPath, realRootDir, trackedFiles);
		if (!trackedByGit) {
			resolved.push(`<!-- @${refPath}: not tracked by git -->`);
			continue;
		}

		if (!trackedFiles && (await isIgnoredByGitignore(realRefPath, realRootDir))) {
			resolved.push(`<!-- @${refPath}: ignored by gitignore -->`);
			continue;
		}

		// Cycle detection
		if (seen.has(realRefPath)) {
			resolved.push(`<!-- @${refPath}: circular reference skipped -->`);
			continue;
		}

		const refContent = await readFile(realRefPath);
		if (refContent === null) {
			resolved.push(`<!-- @${refPath}: file not found -->`);
			continue;
		}

		// Recursively resolve references in the included file. Use the real target
		// path so nested refs are resolved from the target's directory.
		seen.add(realRefPath);
		const innerResolved = await resolveContent(
			refContent,
			realRefPath,
			realRootDir,
			trackedFiles,
			seen,
			depth + 1,
			maxDepth,
		);
		seen.delete(realRefPath);

		resolved.push(innerResolved);
	}

	return resolved.join("\n");
}

/**
 * Resolve @-file references in an array of context files.
 *
 * For each context file, scans its content for lines matching `@relative/path.ext`
 * and replaces them with the referenced file's content. References are resolved
 * relative to the context file's own directory and contained within `rootDir`.
 * Recursion is bounded by `maxDepth` and cycles are detected.
 *
 * Files that cannot be read or that escape the project root produce a comment
 * placeholder instead of crashing.
 */
export async function resolveAtRefs(
	files: ResolveAtRefsFile[],
	options: ResolveAtRefsOptions = {},
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	const maxDepth = options.maxDepth ?? 5;
	const resolved: Array<{ path: string; content: string; depth?: number }> = [];
	for (const file of files) {
		// Each context file gets its own containment root.
		// User-level files (e.g. ~/.omp/AGENTS.md) use their own repo root
		// so their @-refs aren't rejected by a project-level boundary.
		const fileRootDir =
			file.rootDir ??
			options.rootDir ??
			(await findRepoRoot(path.dirname(path.resolve(file.path)))) ??
			path.dirname(path.resolve(file.path));
		const realFileRootDir = await realpathOrSelf(fileRootDir);
		const realFilePath = await realpathOrSelf(file.path);
		const trackedFiles = await loadTrackedFiles(realFileRootDir);
		const seen = new Set<string>([realFilePath]);
		const newContent = await resolveContent(
			file.content,
			realFilePath,
			realFileRootDir,
			trackedFiles,
			seen,
			0,
			maxDepth,
		);
		resolved.push({
			path: file.path,
			content: newContent,
			depth: file.depth,
		});
	}

	return resolved;
}
