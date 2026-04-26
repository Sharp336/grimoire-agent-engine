import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { projfsOverlayStart, projfsOverlayStop } from "@oh-my-pi/pi-natives";
import { $which, getWorktreeDir, isEnoent, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import * as git from "../utils/git";

/** Baseline state for a single git repository. */
export interface RepoBaseline {
	repoRoot: string;
	/** Real-repo HEAD SHA at orchestration capture. Never mutated — used as the
	 * fixed point for `git worktree add` / `git branch` so per-task branches and
	 * patches always target the same commit, regardless of sibling merges. */
	headCommit: string;
	/** SHA of the `omp-baseline` commit created inside the isolation worktree when
	 * the nested repo was dirty at capture time. Used by `captureRepoDeltaPatch` to
	 * subtract the baseline from task work. Undefined when no omp-baseline was made. */
	isolationBase?: string;
	staged: string;
	unstaged: string;
	untracked: string[];
}

/** Baseline state for the project, including any nested git repos. */
export interface WorktreeBaseline {
	root: RepoBaseline;
	/** Nested git repos (path relative to root.repoRoot). */
	nested: Array<{ relativePath: string; baseline: RepoBaseline }>;
}

export function getEncodedProjectName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export async function getRepoRoot(cwd: string): Promise<string> {
	const repoRoot = await git.repo.root(cwd);
	if (!repoRoot) {
		throw new Error("Git repository not found for isolated task execution.");
	}
	return repoRoot;
}

/**
 * Walk up from the immediate git root to find the outermost enclosing .git directory.
 * Used only for worktree isolation where the worktree must cover the full workspace
 * (e.g. Cargo/npm workspaces whose root sits above a nested git repository).
 */
export async function getOutermostRepoRoot(cwd: string): Promise<string> {
	let root = await getRepoRoot(cwd);
	let dir = path.dirname(root);
	while (dir.length < root.length) {
		try {
			await fs.access(path.join(dir, ".git"));
			root = dir;
		} catch {
			break;
		}
		dir = path.dirname(dir);
	}
	return root;
}

const PROJFS_UNAVAILABLE_PREFIX = "PROJFS_UNAVAILABLE:";
const GIT_NO_INDEX_NULL_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

export function isProjfsUnavailableError(err: unknown): boolean {
	return err instanceof Error && err.message.includes(PROJFS_UNAVAILABLE_PREFIX);
}

function shouldPruneRepoDiscoveryDir(name: string): boolean {
	return name.startsWith(".") || name === "node_modules";
}

export function getGitNoIndexNullPath(): string {
	return GIT_NO_INDEX_NULL_PATH;
}

export async function ensureWorktree(baseCwd: string, id: string, baseSha = "HEAD"): Promise<string> {
	const repoRoot = await getOutermostRepoRoot(baseCwd);
	const encodedProject = getEncodedProjectName(repoRoot);
	const worktreeDir = getWorktreeDir(encodedProject, id);
	await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
	await git.worktree.tryRemove(repoRoot, worktreeDir);
	await fs.rm(worktreeDir, { recursive: true, force: true });
	await git.worktree.add(repoRoot, worktreeDir, baseSha, { detach: true });
	return worktreeDir;
}

/**
 * Find nested git repositories (non-submodule) under the given root.
 * Fails closed before crossing filesystem boundaries. Dot-prefixed child directories
 * are pruned during traversal so checkpoint discovery does not recurse into task
 * overlay/cache internals, but the traversal root itself is still inspected.
 */
export async function discoverNestedRepos(repoRoot: string): Promise<string[]> {
	// Get submodule paths so we can exclude them
	const submodulePaths = new Set(await git.ls.submodules(repoRoot));
	const rootStats = await fs.stat(repoRoot);

	// Find nested repository roots that are not known submodules.
	const result: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: nodeFs.Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (shouldPruneRepoDiscoveryDir(entry.name)) continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(repoRoot, full);

			const stats = await fs.stat(full).catch(err => {
				if (isEnoent(err)) return null;
				throw err;
			});
			if (!stats) continue;
			if (stats.dev !== rootStats.dev) {
				throw new Error(
					`Checkpoint/task discovery refuses to cross filesystem device boundaries at "${rel}" before staging. The directory is on a different filesystem device than the repository root.`,
				);
			}

			// Check if this directory is itself a git repo
			const gitDir = path.join(full, ".git");
			let hasGit = false;
			try {
				await fs.access(gitDir);
				hasGit = true;
			} catch {}
			if (hasGit && !submodulePaths.has(rel)) {
				result.push(rel);
				// Don't recurse into nested repos — they manage their own tree
				continue;
			}
			await walk(full);
		}
	}
	await walk(repoRoot);
	return result;
}

/**
 * Well-known SHA-1 of the empty tree object. Git recognizes this hash as the empty
 * tree in every repository without needing an actual commit, so we use it as the
 * subtract point when a nested repo has no resolvable HEAD (freshly-init'd, no
 * commits yet). Without this sentinel, `git read-tree`/`git diff-tree` on an empty
 * baseSha fails with `fatal: Not a valid object name` and poisons delta capture.
 */
const GIT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function captureRepoBaseline(repoRoot: string): Promise<RepoBaseline> {
	const resolvedHead = await git.head.sha(repoRoot);
	if (resolvedHead === null) {
		// Legitimate state for freshly-init'd nested repos (e.g. a scaffold directory
		// with .git but no commits). Delta capture falls back to the empty-tree SHA so
		// the entire working tree becomes the diff.
		logger.warn("captureRepoBaseline: HEAD unresolvable, using empty-tree fallback", { repoRoot });
	}
	const headCommit = resolvedHead ?? "";
	const staged = await git.diff(repoRoot, { binary: true, cached: true });
	const unstaged = await git.diff(repoRoot, { binary: true });
	const untracked = await git.ls.untracked(repoRoot);
	return { repoRoot, headCommit, staged, unstaged, untracked };
}

export async function captureBaseline(repoRoot: string): Promise<WorktreeBaseline> {
	const [root, nestedPaths] = await Promise.all([captureRepoBaseline(repoRoot), discoverNestedRepos(repoRoot)]);
	const nested = await Promise.all(
		nestedPaths.map(async relativePath => ({
			relativePath,
			baseline: await captureRepoBaseline(path.join(repoRoot, relativePath)),
		})),
	);
	return { root, nested };
}

async function applyRepoBaseline(worktreeDir: string, rb: RepoBaseline, sourceRoot: string): Promise<void> {
	// Reset the worktree to the captured baseline SHA before applying patches.
	// Defends against races where `fs.cp` or `git worktree add HEAD` picked up state
	// newer than orchestration baseline — e.g. a sibling task has already merged into
	// the real repo. Without this reset, captured deltas include sibling task work,
	// and `git apply` in Phase 1 fails on content that already exists in real HEAD.
	if (rb.headCommit) {
		await git.resetHard(worktreeDir, rb.headCommit);
		await git.clean(worktreeDir);
	}
	await git.patch.applyText(worktreeDir, rb.staged, { cached: true });
	await git.patch.applyText(worktreeDir, rb.staged);
	await git.patch.applyText(worktreeDir, rb.unstaged);

	for (const entry of rb.untracked) {
		const source = path.join(sourceRoot, entry);
		const destination = path.join(worktreeDir, entry);
		try {
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.cp(source, destination, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
	}
}

export async function applyBaseline(worktreeDir: string, baseline: WorktreeBaseline): Promise<void> {
	await applyRepoBaseline(worktreeDir, baseline.root, baseline.root.repoRoot);

	// Restore nested repos into the worktree
	for (const entry of baseline.nested) {
		const nestedDir = path.join(worktreeDir, entry.relativePath);
		// Copy the nested repo wholesale (it's not managed by root git)
		const sourceDir = path.join(baseline.root.repoRoot, entry.relativePath);
		try {
			await fs.cp(sourceDir, nestedDir, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		// Apply any uncommitted changes from the nested baseline
		await applyRepoBaseline(nestedDir, entry.baseline, entry.baseline.repoRoot);
		// Commit baseline state so captureRepoDeltaPatch can cleanly subtract it when
		// the subagent commits via `git add -A && git commit`; otherwise baseline untracked
		// files would leak into the diff-tree output. Keep the original staged/unstaged/
		// untracked fields intact on the baseline — Phase 1 replays them onto the task branch
		// so the captured patch's "before" context matches.
		if ((await git.status(nestedDir)).trim().length > 0) {
			await git.stage.files(nestedDir);
			await git.commit(nestedDir, "omp-baseline", { allowEmpty: true });
			entry.baseline.isolationBase = (await git.head.sha(nestedDir)) ?? "";
		}
	}
}

async function captureRepoDeltaPatch(repoDir: string, rb: RepoBaseline): Promise<string> {
	// Use the omp-baseline commit when present (nested repos that were dirty at
	// capture time); otherwise the real-repo HEAD SHA is the correct subtract point.
	// For no-HEAD nested repos (empty init), fall back to the empty-tree sentinel so
	// `git read-tree`/`git diff-tree` accept the base and the subagent's entire tree
	// is captured as the delta.
	const baseSha = rb.isolationBase || rb.headCommit || GIT_EMPTY_TREE_SHA;
	const currentHead = (await git.head.sha(repoDir)) ?? "";
	const headAdvanced = currentHead && currentHead !== baseSha;

	if (headAdvanced) {
		// HEAD moved: use diff-tree to capture committed changes, plus any uncommitted on top
		const parts: string[] = [];

		// Committed changes since baseline
		const committedDiff = await git.diff.tree(repoDir, baseSha, currentHead, {
			allowFailure: true,
			binary: true,
		});
		if (committedDiff.trim()) parts.push(committedDiff);

		// Uncommitted changes on top of the new HEAD
		const staged = await git.diff(repoDir, { binary: true, cached: true });
		const unstaged = await git.diff(repoDir, { binary: true });
		if (staged.trim()) parts.push(staged);
		if (unstaged.trim()) parts.push(unstaged);

		// New untracked files (relative to both baseline and current tracking)
		const currentUntracked = await git.ls.untracked(repoDir);
		const baselineUntracked = new Set(rb.untracked);
		const newUntracked = currentUntracked.filter(entry => !baselineUntracked.has(entry));
		if (newUntracked.length > 0) {
			const nullPath = getGitNoIndexNullPath();
			const untrackedDiffs = await Promise.all(
				newUntracked.map(entry =>
					git.diff(repoDir, {
						allowFailure: true,
						binary: true,
						noIndex: { left: nullPath, right: entry },
					}),
				),
			);
			parts.push(...untrackedDiffs.filter(d => d.trim()));
		}

		return parts.join("\n");
	}

	// HEAD unchanged: use temp index approach (subtracts baseline from delta)
	const tempIndex = path.join(os.tmpdir(), `omp-task-index-${Snowflake.next()}`);
	try {
		await git.readTree(repoDir, baseSha, {
			env: { GIT_INDEX_FILE: tempIndex },
		});
		// When isolationBase is set, the readTree above already loaded a tree containing
		// baseline staged+unstaged+untracked — re-applying them would double-apply.
		if (!rb.isolationBase) {
			await git.patch.applyText(repoDir, rb.staged, {
				cached: true,
				env: { GIT_INDEX_FILE: tempIndex },
			});
			await git.patch.applyText(repoDir, rb.unstaged, {
				cached: true,
				env: { GIT_INDEX_FILE: tempIndex },
			});
		}
		const diff = await git.diff(repoDir, {
			binary: true,
			env: { GIT_INDEX_FILE: tempIndex },
		});

		const currentUntracked = await git.ls.untracked(repoDir);
		const baselineUntracked = new Set(rb.untracked);
		const newUntracked = currentUntracked.filter(entry => !baselineUntracked.has(entry));

		if (newUntracked.length === 0) return diff;

		const nullPath = getGitNoIndexNullPath();
		const untrackedDiffs = await Promise.all(
			newUntracked.map(entry =>
				git.diff(repoDir, {
					allowFailure: true,
					binary: true,
					noIndex: { left: nullPath, right: entry },
				}),
			),
		);
		return `${diff}${diff && !diff.endsWith("\n") ? "\n" : ""}${untrackedDiffs.join("\n")}`;
	} finally {
		await fs.rm(tempIndex, { force: true });
	}
}

export interface NestedRepoPatch {
	relativePath: string;
	patch: string;
	taskId?: string;
	description?: string;
}

export interface DeltaPatchResult {
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
}

export async function captureDeltaPatch(isolationDir: string, baseline: WorktreeBaseline): Promise<DeltaPatchResult> {
	const rootPatch = await captureRepoDeltaPatch(isolationDir, baseline.root);
	const nestedPatches: NestedRepoPatch[] = [];

	for (const { relativePath, baseline: nb } of baseline.nested) {
		const nestedDir = path.join(isolationDir, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			logger.warn("captureDeltaPatch: nested repo .git not accessible, skipping", { relativePath });
			continue;
		}
		const patch = await captureRepoDeltaPatch(nestedDir, nb);
		if (patch.trim()) nestedPatches.push({ relativePath, patch });
	}

	return { rootPatch, nestedPatches };
}

/** Per-patch outcome from {@link applyNestedPatches}. */
export interface NestedPatchOutcome {
	patch: NestedRepoPatch;
	status: "applied" | "skipped" | "failed";
	error?: string;
}

export interface ApplyNestedPatchesResult {
	outcomes: NestedPatchOutcome[];
	applied: NestedPatchOutcome[];
	failed: NestedPatchOutcome[];
}

/**
 * Apply nested repo patches directly to their working directories after parent merge.
 * Each patch is attempted independently: a failure in one nested repo does not abort
 * the remaining patches. The returned result lists per-patch outcomes so the caller
 * can attribute failures back to the originating task and surface preserved artifacts.
 * @param commitMessage Optional async function to generate a commit message from the combined diff.
 *                      If omitted or returns null, falls back to a generic message.
 */
export async function applyNestedPatches(
	repoRoot: string,
	patches: NestedRepoPatch[],
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<ApplyNestedPatchesResult> {
	const outcomes: NestedPatchOutcome[] = [];
	for (const p of patches) {
		if (!p.patch.trim()) {
			outcomes.push({ patch: p, status: "skipped" });
			continue;
		}
		const nestedDir = path.join(repoRoot, p.relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			logger.warn("applyNestedPatches: nested repo .git not accessible, skipping", {
				relativePath: p.relativePath,
			});
			outcomes.push({
				patch: p,
				status: "failed",
				error: `nested repo ${p.relativePath} is not a git repository`,
			});
			continue;
		}

		try {
			await git.patch.applyText(nestedDir, p.patch);
			if ((await git.status(nestedDir)).trim().length > 0) {
				const fallback = p.description ?? p.taskId ?? "changes from isolated task";
				const msg = (await commitMessage?.(p.patch)) ?? fallback;
				await git.stage.files(nestedDir);
				await git.commit(nestedDir, msg);
			}
			outcomes.push({ patch: p, status: "applied" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("applyNestedPatches: patch failed", {
				relativePath: p.relativePath,
				taskId: p.taskId,
				error: msg,
			});
			outcomes.push({ patch: p, status: "failed", error: msg });
		}
	}
	return {
		outcomes,
		applied: outcomes.filter(o => o.status === "applied"),
		failed: outcomes.filter(o => o.status === "failed"),
	};
}

export async function cleanupWorktree(dir: string): Promise<void> {
	try {
		const repository = await git.repo.resolve(dir);
		const commonDir = repository?.commonDir ?? "";
		if (commonDir && path.basename(commonDir) === ".git") {
			const repoRoot = path.dirname(commonDir);
			await git.worktree.tryRemove(repoRoot, dir);
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Reflink snapshot isolation (Unix)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates an independent point-in-time snapshot of the repo via reflink copy
 * (btrfs/xfs/zfs/apfs CoW clone, or full copy fallback on non-CoW filesystems
 * via GNU `cp --reflink=auto`). Unlike a fuse-overlayfs mount — which stacks
 * a CoW layer over the live repo and therefore lets main-session writes bleed
 * into the subagent's view through the unchanged lowerdir — this snapshot is
 * decoupled from the source after creation, so concurrent main-session edits
 * cannot mutate the subagent's baseline.
 */
export async function ensureReflinkSnapshot(baseCwd: string, id: string): Promise<string> {
	if (process.platform === "win32") {
		throw new Error('reflink isolation is unsupported on Windows. Use task.isolation.mode = "fuse-projfs".');
	}

	const repoRoot = await getRepoRoot(baseCwd);
	const encodedProject = getEncodedProjectName(repoRoot);
	const baseDir = getWorktreeDir(encodedProject, id);
	const snapshotDir = path.join(baseDir, "snapshot");

	await fs.rm(baseDir, { recursive: true, force: true });
	await fs.mkdir(baseDir, { recursive: true });

	const cpBin = $which("cp");
	if (!cpBin) {
		await fs.rm(baseDir, { recursive: true, force: true });
		throw new Error("cp not found on PATH; required for reflink snapshot isolation.");
	}

	// GNU cp on Linux: `--reflink=auto -a` (CoW clone where FS supports it, full copy otherwise).
	// BSD cp on macOS: `-c -R -p` (APFS clone + recursive + preserve). BSD `-c` hard-fails on
	// non-clone-capable volumes rather than falling back; that's acceptable because the
	// snapshot guarantee is what we're paying for.
	const args =
		process.platform === "darwin"
			? ["-c", "-R", "-p", repoRoot, snapshotDir]
			: ["--reflink=auto", "-a", repoRoot, snapshotDir];

	const result = await $`${cpBin} ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		await fs.rm(baseDir, { recursive: true, force: true });
		throw new Error(`reflink snapshot failed (exit ${result.exitCode}): ${stderr}`);
	}

	return snapshotDir;
}

export async function cleanupReflinkSnapshot(snapshotDir: string): Promise<void> {
	const baseDir = path.dirname(snapshotDir);
	await fs.rm(baseDir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// ProjFS isolation (Windows)
// ═══════════════════════════════════════════════════════════════════════════

export async function ensureProjfsOverlay(baseCwd: string, id: string): Promise<string> {
	if (process.platform !== "win32") {
		throw new Error("fuse-projfs isolation is only available on Windows.");
	}

	const repoRoot = await getRepoRoot(baseCwd);
	const encodedProject = getEncodedProjectName(repoRoot);
	const baseDir = getWorktreeDir(encodedProject, id);
	const mergedDir = path.join(baseDir, "merged");

	await fs.rm(baseDir, { recursive: true, force: true });
	await fs.mkdir(mergedDir, { recursive: true });
	try {
		projfsOverlayStart(repoRoot, mergedDir);
		return mergedDir;
	} catch (err) {
		await fs.rm(baseDir, { recursive: true, force: true });
		throw err;
	}
}

export async function cleanupProjfsOverlay(mergedDir: string): Promise<void> {
	try {
		if (process.platform === "win32") {
			try {
				projfsOverlayStop(mergedDir);
			} catch (err) {
				logger.warn("ProjFS overlay stop failed during cleanup", {
					mergedDir,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	} finally {
		// baseDir is the parent of the merged directory
		const baseDir = path.dirname(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Branch-mode isolation
// ═══════════════════════════════════════════════════════════════════════════

export interface NestedRepoBranch {
	relativePath: string;
	branchName: string;
}

export interface CommitToBranchResult {
	/** Branch created in the root repo (undefined when root had no changes). */
	branchName?: string;
	/** Per-nested-repo branches, one per nested git repo that the task modified. */
	nestedBranches: NestedRepoBranch[];
	/** Captured nested repo patches for callers that still apply nested repos directly. */
	nestedPatches: NestedRepoPatch[];
}

/**
 * Baseline dirty state to replay onto a fresh task-branch worktree before applying
 * the subagent patch. Committed as an interim `omp-baseline` commit so the subagent
 * patch's context lines resolve against the state they were captured against.
 *
 * `sourceRoot` is the real-repo path from which untracked files are copied.
 */
interface BranchReplay {
	staged: string;
	unstaged: string;
	untracked: string[];
	sourceRoot: string;
}

async function replayBaselineDirtyState(dir: string, replay: BranchReplay): Promise<void> {
	if (replay.staged.trim()) {
		await git.patch.applyText(dir, replay.staged, { cached: true });
		await git.patch.applyText(dir, replay.staged);
	}
	if (replay.unstaged.trim()) {
		await git.patch.applyText(dir, replay.unstaged);
	}
	for (const entry of replay.untracked) {
		const source = path.join(replay.sourceRoot, entry);
		const destination = path.join(dir, entry);
		try {
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.cp(source, destination, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
	}
}

/**
 * Commit a single repo's delta patch to a new branch on that repo.
 *
 * Branch chain: `baseSha → omp-baseline (if replay has content) → task-commit`.
 * The interim omp-baseline commit replays the user's dirty-state at orchestration
 * capture time so the subagent's captured patch — whose context reflects that dirty
 * state — applies cleanly. At Phase 2, cherry-pick of task-commit uses omp-baseline
 * as its merge-base, so the 3-way merge subtracts the dirty state and applies only
 * the subagent delta onto real HEAD (independent of whether the user's working tree
 * still holds the same dirty state).
 *
 * The branch is created at `baseSha` (the orchestration-captured real-repo HEAD, not
 * current HEAD — which may have moved if a sibling task already merged). Applies the
 * patch in a temporary worktree, commits, then tears the worktree down. Safe to run
 * concurrently across distinct repos (git worktree uses per-ref locks).
 */
async function commitPatchToRepoBranch(
	realRepoRoot: string,
	patch: string,
	branchName: string,
	baseSha: string,
	replay: BranchReplay,
	taskId: string,
	fallbackMessage: string,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<void> {
	await git.branch.create(realRepoRoot, branchName, baseSha);
	const tmpDir = path.join(os.tmpdir(), `omp-branch-${Snowflake.next()}`);
	try {
		await git.worktree.add(realRepoRoot, tmpDir, branchName);
		await replayBaselineDirtyState(tmpDir, replay);
		if ((await git.status(tmpDir)).trim().length > 0) {
			await git.stage.files(tmpDir);
			await git.commit(tmpDir, "omp-baseline");
		}
		try {
			await git.patch.applyText(tmpDir, patch);
		} catch (err) {
			if (err instanceof git.GitCommandError) {
				const stderr = err.result.stderr.slice(0, 2000);
				logger.error("commitPatchToRepoBranch: git apply failed", {
					taskId,
					repoRoot: realRepoRoot,
					exitCode: err.result.exitCode,
					stderr,
					patchSize: patch.length,
					patchHead: patch.slice(0, 500),
				});
				throw new Error(`git apply failed for task ${taskId} in ${realRepoRoot}: ${stderr}`);
			}
			throw err;
		}
		// Diagnostic: a non-empty patch that applies cleanly but leaves the tree identical
		// indicates the captured delta was computed against a base that already contained
		// the subagent's work (e.g. stale baseline, overlay/stat cache race). Surface this
		// as a distinct failure with the raw patch preserved in the logs so recurrences can
		// be root-caused without replaying the full session.
		const postApplyStatus = (await git.status(tmpDir)).trim();
		if (postApplyStatus.length === 0 && patch.trim().length > 0) {
			logger.error("commitPatchToRepoBranch: patch applied as no-op", {
				taskId,
				repoRoot: realRepoRoot,
				baseSha,
				patchSize: patch.length,
				patchHead: patch.slice(0, 2000),
			});
			throw new Error(
				`captured patch for task ${taskId} applied as a no-op in ${realRepoRoot} — baseline likely drifted from the subagent's view. Patch preserved via artifacts; inspect before retrying.`,
			);
		}
		await git.stage.files(tmpDir);
		const msg = (commitMessage && (await commitMessage(patch))) || fallbackMessage;
		await git.commit(tmpDir, msg);
	} finally {
		await git.worktree.tryRemove(realRepoRoot, tmpDir);
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

function baselineReplayFor(rb: RepoBaseline): BranchReplay {
	return {
		staged: rb.staged,
		unstaged: rb.unstaged,
		untracked: rb.untracked,
		sourceRoot: rb.repoRoot,
	};
}

/**
 * Commit task-only changes to per-repo branches — one in the root repo and one
 * in each nested git repo that was modified. All branches share the same name
 * `omp/task/<id>` since they live in different repositories.
 *
 * Thin wrapper that captures the delta and hands off to {@link commitDeltaToBranch}.
 * Callers that need the captured delta (e.g. to persist as a recovery artifact before
 * attempting commit) should call {@link captureDeltaPatch} + {@link commitDeltaToBranch}
 * directly instead.
 */
export async function commitToBranch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<CommitToBranchResult | null> {
	const delta = await captureDeltaPatch(isolationDir, baseline);
	return commitDeltaToBranch(delta, baseline, taskId, description, commitMessage);
}

/**
 * Commit a previously captured delta to per-repo branches. Separated from the capture
 * step so callers can persist the captured patches as recovery artifacts before the
 * commit path can drop them on error.
 */
export async function commitDeltaToBranch(
	delta: DeltaPatchResult,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<CommitToBranchResult | null> {
	const { rootPatch, nestedPatches } = delta;
	if (!rootPatch.trim() && nestedPatches.length === 0) return null;

	const branchName = `omp/task/${taskId}`;
	const fallbackMessage = description || taskId;

	let rootBranch: string | undefined;
	if (rootPatch.trim()) {
		await commitPatchToRepoBranch(
			baseline.root.repoRoot,
			rootPatch,
			branchName,
			baseline.root.headCommit,
			baselineReplayFor(baseline.root),
			taskId,
			fallbackMessage,
			commitMessage,
		);
		rootBranch = branchName;
	}

	const nestedBranches: NestedRepoBranch[] = [];
	for (const np of nestedPatches) {
		if (!np.patch.trim()) continue;
		const nestedEntry = baseline.nested.find(n => n.relativePath === np.relativePath);
		if (!nestedEntry) {
			throw new Error(`commitDeltaToBranch: no baseline entry for nested repo ${np.relativePath}`);
		}
		const nestedRealRoot = path.join(baseline.root.repoRoot, np.relativePath);
		await commitPatchToRepoBranch(
			nestedRealRoot,
			np.patch,
			branchName,
			nestedEntry.baseline.headCommit,
			baselineReplayFor(nestedEntry.baseline),
			taskId,
			fallbackMessage,
			commitMessage,
		);
		nestedBranches.push({ relativePath: np.relativePath, branchName });
	}

	return { branchName: rootBranch, nestedBranches, nestedPatches };
}

/**
 * Persist a captured delta to `<artifactsDir>/<taskId>.patch` (root) and
 * `<artifactsDir>/<taskId>.<sanitized-rel>.patch` (per nested repo). Exists so that
 * branch-mode commits have the same recovery trail as patch-mode: when `git apply` or
 * `git commit` on the task branch blows up, the captured delta survives on disk.
 *
 * Returns the list of written paths (may be empty when the delta is entirely whitespace).
 */
export async function writeBranchDeltaArtifacts(
	artifactsDir: string,
	taskId: string,
	delta: DeltaPatchResult,
): Promise<string[]> {
	const written: string[] = [];
	if (delta.rootPatch.trim()) {
		const rootPath = path.join(artifactsDir, `${taskId}.patch`);
		await Bun.write(rootPath, delta.rootPatch);
		written.push(rootPath);
	}
	for (const np of delta.nestedPatches) {
		if (!np.patch.trim()) continue;
		const sanitized = np.relativePath.replace(/[/\\]+/g, "__").replace(/[^A-Za-z0-9._-]/g, "_");
		const nestedPath = path.join(artifactsDir, `${taskId}.${sanitized}.patch`);
		await Bun.write(nestedPath, np.patch);
		written.push(nestedPath);
	}
	return written;
}

export interface AggressiveMergeInfo {
	/** Files whose conflicts were resolved by taking the cherry-picked branch's content. */
	files: string[];
}

export interface MergeSingleBranchResult {
	ok: boolean;
	commit?: string;
	conflict?: string;
	/**
	 * Present when the first cherry-pick conflicted and a `-X theirs` retry succeeded.
	 * Callers MUST surface this to the main session: parallel tasks wrote divergent content to
	 * the listed files and the retry silently took the picked branch's version.
	 */
	aggressive?: AggressiveMergeInfo;
}

/**
 * Cherry-pick a single task branch commit onto HEAD.
 * Stashes any dirty working tree, cherry-picks, then restores the stash.
 *
 * On first cherry-pick conflict: aborts, retries with `-X theirs` so near-identical parallel
 * edits (e.g. the same lint fix landed by two sibling tasks) merge best-effort. Conflicted
 * files from the first attempt are reported as `aggressive` so the main session can audit.
 * If the retry also conflicts, returns `{ ok: false, conflict }`.
 *
 * On stash-pop conflict after a successful cherry-pick: returns `{ ok: false, conflict }`
 * — the caller should preserve the task branch so the user can reconcile manually.
 *
 * Callers MUST serialize `mergeSingleBranch` calls against the same `repoRoot`;
 * stash + cherry-pick are not safe to interleave.
 */
export async function mergeSingleBranch(
	repoRoot: string,
	branch: { branchName: string; taskId: string; description?: string },
): Promise<MergeSingleBranchResult> {
	const didStash = await git.stash.push(repoRoot, "omp-task-merge");
	let cherryPickSucceeded = false;
	let commit: string | undefined;
	let conflict: string | undefined;
	let aggressive: AggressiveMergeInfo | undefined;

	try {
		try {
			await git.cherryPick(repoRoot, branch.branchName);
			cherryPickSucceeded = true;
			commit = (await git.head.short(repoRoot)) ?? undefined;
		} catch (firstErr) {
			// Capture conflicted files before aborting — abort clears the unmerged index.
			let conflictedFiles: string[] = [];
			try {
				conflictedFiles = await git.cherryPick.conflictedFiles(repoRoot);
			} catch {
				/* diff may fail mid-cherry-pick; fall through with empty list */
			}
			try {
				await git.cherryPick.abort(repoRoot);
			} catch {
				/* no state to abort */
			}
			// Best-effort retry: when sibling tasks made overlapping edits (identical or near-identical),
			// -X theirs keeps the picked branch's version. Conflicted files are surfaced as `aggressive`.
			try {
				await git.cherryPick(repoRoot, branch.branchName, { strategyOption: "theirs" });
				cherryPickSucceeded = true;
				commit = (await git.head.short(repoRoot)) ?? undefined;
				aggressive = { files: conflictedFiles };
			} catch (retryErr) {
				try {
					await git.cherryPick.abort(repoRoot);
				} catch {
					/* no state to abort */
				}
				const err = retryErr instanceof Error ? retryErr : firstErr;
				const stderr =
					err instanceof git.GitCommandError
						? err.result.stderr.trim()
						: err instanceof Error
							? err.message
							: String(err);
				conflict = `${branch.branchName}: ${stderr}`;
			}
		}
	} finally {
		if (didStash) {
			try {
				await git.stash.pop(repoRoot, { index: true });
			} catch {
				logger.warn("Failed to restore stashed changes after task merge; stash entry preserved");
				if (cherryPickSucceeded && !conflict) {
					conflict = `${branch.branchName}: stash pop failed — cherry-picked changes conflict with uncommitted edits. Run \`git stash pop\` and resolve manually.`;
				}
			}
		}
	}

	if (conflict) return { ok: false, conflict };
	return { ok: true, commit, aggressive };
}
export interface MergeBranchResult {
	merged: string[];
	failed: string[];
	conflict?: string;
}

export async function mergeTaskBranches(
	repoRoot: string,
	branches: Array<{ branchName: string; taskId: string; description?: string }>,
): Promise<MergeBranchResult> {
	const merged: string[] = [];
	const failed: string[] = [];
	let conflict: string | undefined;

	for (const branch of branches) {
		const result = await mergeSingleBranch(repoRoot, branch);
		if (result.ok) {
			merged.push(branch.branchName);
			continue;
		}
		failed.push(branch.branchName);
		conflict = result.conflict;
		break;
	}

	if (failed.length > 0) {
		failed.push(...branches.slice(merged.length + failed.length).map(branch => branch.branchName));
	}

	return { merged, failed, conflict };
}

/** Clean up temporary task branches. */
export async function cleanupTaskBranches(repoRoot: string, branches: string[]): Promise<void> {
	for (const branch of branches) {
		await git.branch.tryDelete(repoRoot, branch);
	}
}
