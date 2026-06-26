import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

/**
 * Throttle for the working-copy jj query. The statusline calls into jj only
 * while the `git` segment is shown in a colocated jj repo (where git HEAD is
 * parked detached), so a moderate TTL keeps the subprocess rate negligible
 * while a HEAD change still forces an immediate refresh (see
 * `#invalidateGitCaches`).
 */
export const JJ_BRANCH_TTL_MS = 5000;

/**
 * jj template for the working-copy label: local bookmarks on `@` (space marker
 * formatting preserved) plus the shortest unique change-id prefix. `separate`
 * drops the empty bookmark part, so a working copy with no bookmark renders as
 * just the change-id.
 */
const JJ_BRANCH_TEMPLATE = 'separate(" ", bookmarks, change_id.shortest(8))';

/**
 * Walk up from `cwd` to the colocated jj workspace root — the nearest ancestor
 * directory holding a `.jj` entry. Returns `null` when none exists. Sync on
 * purpose: it feeds the synchronous statusline render path and is cached per
 * cwd by the caller, so it runs at most once per directory.
 */
export function findJjRoot(cwd: string): string | null {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".jj"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Collapse a raw jj template line into a single display token, or `null` when empty. */
export function formatJjBranch(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	return trimmed.replace(/\s+/g, " ");
}

/** Runs the jj query in `root`; injectable so the parse boundary is testable without jj. */
export type JjRunner = (root: string) => Promise<{ exitCode: number; stdout: string }>;

const defaultRunner: JjRunner = async root => {
	// `--ignore-working-copy` keeps the query read-only (never snapshots the
	// working copy), so it is safe to run on every refresh.
	const res = await $`jj log --no-graph --ignore-working-copy --color never -r @ -T ${JJ_BRANCH_TEMPLATE}`
		.cwd(root)
		.quiet()
		.nothrow();
	return { exitCode: res.exitCode, stdout: res.text() };
};

/**
 * Query the jj working-copy label (bookmarks + change-id) for `root`. Returns
 * `null` on any failure — non-zero exit (not a jj repo) or a missing `jj`
 * binary — so the caller cleanly falls back to git's detached-HEAD label.
 */
export async function queryJjBranch(root: string, runner: JjRunner = defaultRunner): Promise<string | null> {
	try {
		const res = await runner(root);
		if (res.exitCode !== 0) return null;
		return formatJjBranch(res.stdout);
	} catch {
		return null;
	}
}
