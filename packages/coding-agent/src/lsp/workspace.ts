/**
 * Bounded, file-driven LSP workspace discovery.
 *
 * LSP config and server identity were historically bound to the session's
 * cwd. A conductor session launched in ~/projects cannot see a /tmp clone as
 * a project: diagnostics on an absolute clone path hit an empty server map
 * and returned "No language server found", and any server that did start
 * would be keyed by session.cwd — rootUri, clientKey, and the mux projectDir
 * all collapsing sibling clones onto the founder checkout.
 *
 * This module discovers a bounded "ceiling" for a file and, inside it, the
 * nearest marker-having workspace root. The ceiling is the file's git
 * work-tree root when one exists, the session cwd when the file lives inside
 * the session project, or the file's own directory otherwise. Discovery never
 * escapes the ceiling, never walks to /tmp, $HOME, or / as a fallback, and
 * refuses (fails closed) when the file's realpath escapes its ceiling via a
 * symlink.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathIsWithin } from "@oh-my-pi/pi-utils";
import { hasRootMarkers } from "./config";

export type LspCeilingKind = "git" | "session" | "file";

export interface LspCeiling {
	/** Bounded root-discovery boundary (clone worktree root, session project, or the file's own directory). */
	path: string;
	kind: LspCeilingKind;
	/** True when the file's realpath escapes the ceiling (symlink escape) — callers must fail closed. */
	escaped: boolean;
}

/** Lexical containment: `candidate === root` or strictly under `root`, ignoring symlinks. */
function isWithinLexical(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Find the git work-tree root containing `startDir` by walking upward with
 * lstat-only `.git` checks. A real `.git` directory, or a plain `.git` file
 * (worktree pointer), marks the root. A `.git` SYMLINK is deliberately not a
 * root, and ANY symlinked directory component ends the walk: lstat only
 * skips the final component, so a symlinked prefix (e.g. an alias directory
 * into a sibling clone or the founder checkout) would otherwise be followed
 * and adopted as this file's work-tree.
 */
export function findGitWorktreeRoot(startDir: string): string | null {
	let dir = startDir;
	while (true) {
		let dirStat: fs.Stats | null = null;
		try {
			dirStat = fs.lstatSync(dir);
		} catch {
			dirStat = null;
		}
		if (dirStat?.isSymbolicLink()) return null;
		let gitStat: fs.Stats | null = null;
		try {
			gitStat = fs.lstatSync(path.join(dir, ".git"));
		} catch {
			gitStat = null;
		}
		if (gitStat && (gitStat.isDirectory() || gitStat.isFile())) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** True when any path component of `dir` (from the filesystem root down) is a symlink. */
function hasSymlinkPrefix(dir: string): boolean {
	const resolved = path.resolve(dir);
	const components: string[] = [];
	let current = resolved;
	while (true) {
		components.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const component of components) {
		let stat: fs.Stats | null = null;
		try {
			stat = fs.lstatSync(component);
		} catch {
			stat = null;
		}
		if (stat?.isSymbolicLink()) return true;
	}
	return false;
}

/**
 * Resolve the bounded discovery ceiling for a file:
 *
 * 1. The git work-tree root containing the logical file — treated as an
 *    INDEPENDENT CLONE when the file lives outside the session cwd. Clone
 *    files never fall back to $PATH or the founder checkout.
 * 2. The session cwd when the file is inside it — the session project keeps
 *    its existing config semantics ($PATH allowed). When the file's repo root
 *    sits above the session cwd, discovery is bounded by that repo root so a
 *    marker walk never escapes the file's repository.
 * 3. The file's own directory — a stray file outside the session and any
 *    repo; discovery is bounded to that single directory.
 *
 * A file whose realpath escapes its ceiling (symlink out of the clone or
 * project) is flagged `escaped`; callers must fail closed. /tmp, $HOME, and
 * / are never used as ceilings or roots.
 */
export function resolveLspCeiling(filePath: string, sessionCwd: string): LspCeiling {
	const logical = path.resolve(filePath);
	const session = path.resolve(sessionCwd);
	const gitRoot = findGitWorktreeRoot(path.dirname(logical));
	const inSession = isWithinLexical(logical, session);

	if (inSession) {
		// The file belongs to the session project. If its repo root sits above
		// the session cwd (e.g. a session launched in a project subdirectory),
		// bound discovery by the repo root; otherwise the session cwd. A file
		// that realpaths outside the session (symlinked subdirectory) is
		// escaped and must fail closed.
		if (gitRoot && !isWithinLexical(session, gitRoot)) {
			return { path: gitRoot, kind: "session", escaped: !pathIsWithin(gitRoot, logical) };
		}
		return { path: session, kind: "session", escaped: !pathIsWithin(session, logical) };
	}

	if (gitRoot) {
		return { path: gitRoot, kind: "git", escaped: !pathIsWithin(gitRoot, logical) };
	}
	const dir = path.dirname(logical);
	// A stray file reached through a symlinked directory prefix is not a
	// trustworthy project boundary: fail closed instead of adopting whatever
	// repo or binary the link exposes.
	return { path: dir, kind: "file", escaped: hasSymlinkPrefix(dir) };
}

/**
 * Walk from the file's directory upward, inside `ceiling`, and return the
 * nearest directory whose root markers are present. The ceiling itself is
 * eligible. Returns null when no marker directory exists inside the ceiling
 * (the server is simply not configured for this file) or when the ceiling
 * was escaped.
 */
export function findWorkspaceRoot(filePath: string, ceiling: LspCeiling, markers: string[]): string | null {
	if (ceiling.escaped || markers.length === 0) return null;
	let dir = path.dirname(path.resolve(filePath));
	while (true) {
		if (hasRootMarkers(dir, markers)) return dir;
		if (dir === ceiling.path) return null;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		if (!isWithinLexical(parent, ceiling.path)) return null;
		dir = parent;
	}
}
