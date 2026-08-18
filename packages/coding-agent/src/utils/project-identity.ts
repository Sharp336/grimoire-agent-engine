/**
 * Shared project identity derivation.
 *
 * Two consumers need "which project is this cwd", with different needs:
 *   - Hindsight bank scoping wants a human-readable, stable-across-worktrees
 *     LABEL it can embed in a bank id or a `project:<name>` tag.
 *   - The Auto-Learn procedure catalog wants a collision-free KEY it can store
 *     and rank on, because two unrelated checkouts named `agent` must not share
 *     project affinity.
 *
 * Both derive from the same resolved root so the conventions cannot drift.
 */
import * as path from "node:path";
import * as git from "./git";

const UNKNOWN_PROJECT = "unknown";
/** Wide enough that basename collisions are the only realistic tie, short enough to stay readable in a key. */
const ROOT_HASH_HEX_LENGTH = 12;

/** Stable identity for the project owning a working directory. */
export interface ProjectIdentity {
	/**
	 * Collision-resistant identifier: `<label>-<hash of resolved root>`. Stable
	 * across linked worktrees of one repository and across processes, but
	 * distinct for two same-named checkouts in different locations.
	 */
	key: string;
	/** Lowercased basename of the resolved root; human-facing, may collide. */
	label: string;
}

/**
 * Resolve the directory that identifies the project.
 *
 * Prefers the repository's primary checkout root so every linked worktree of one
 * repository shares an identity, and falls back to the absolute working
 * directory. Absolute is load-bearing: a relative `cwd` like `"."` would
 * otherwise basename to `"."` and give every project the same label.
 */
function resolveProjectRoot(directory: string): string {
	if (!directory) return "";
	return git.repo.primaryRootSync(directory) ?? path.resolve(directory);
}

/**
 * Lowercased basename of the project root.
 *
 * Sync only: `computeBankScope` is a sync API on a hot path.
 * `git.repo.primaryRootSync` walks `.git`/`commondir` with sync file reads (no
 * subprocess), so the cost is one or two `stat`s plus a small `readFile`.
 *
 * Lowercasing is load-bearing for Hindsight: tags match literally, so a checkout
 * at `.../General` would otherwise retain into a `project:General` scope that
 * never meets the `project:general` scope other clients use.
 */
export function resolveProjectLabel(directory: string): string {
	const root = resolveProjectRoot(directory);
	if (!root) return UNKNOWN_PROJECT;
	return path.basename(root).toLowerCase() || UNKNOWN_PROJECT;
}

/**
 * Resolve both the ranking key and the display label for `cwd`.
 *
 * The key hashes the RESOLVED ROOT rather than the label, so `~/a/agent` and
 * `~/b/agent` never share project affinity in the catalog while every linked
 * worktree of one repository does.
 */
export function resolveProjectIdentity(cwd: string): ProjectIdentity {
	const root = resolveProjectRoot(cwd);
	const label = root ? path.basename(root).toLowerCase() || UNKNOWN_PROJECT : UNKNOWN_PROJECT;
	if (!root) return { key: UNKNOWN_PROJECT, label };
	// Case-fold the hash input only where the filesystem is case-insensitive:
	// Windows reaches one directory through many casings, so folding keeps a
	// single project key. On Linux `/srv/App` and `/srv/app` are DIFFERENT
	// directories, and folding there would merge two unrelated projects.
	const hashInput = process.platform === "win32" ? root.toLowerCase() : root;
	const hash = Bun.hash.wyhash(hashInput).toString(16).padStart(ROOT_HASH_HEX_LENGTH, "0");
	return { key: `${label}-${hash.slice(-ROOT_HASH_HEX_LENGTH)}`, label };
}
