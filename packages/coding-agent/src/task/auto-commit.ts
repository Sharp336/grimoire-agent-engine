import * as path from "node:path";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import { discoverNestedRepos, getOutermostRepoRoot } from "./worktree";

export interface DirtyRepoReport {
	root: string;
	repos: string[];
}

/**
 * Enumerate every dirty git repository under the outermost repo root containing `cwd`.
 * Used by the `git_commit_checkpoint` tool and the task dispatcher to decide which repos
 * need committing.
 * Discovery prunes hidden child directories and fails before `git status` if
 * nested-repo traversal would cross filesystem boundaries.
 */
export async function dirtyRepos(cwd: string): Promise<DirtyRepoReport> {
	const root = await getOutermostRepoRoot(cwd);
	const nestedRepos = await discoverNestedRepos(root);
	const allRepos = [root, ...nestedRepos.map(relativePath => path.join(root, relativePath))];
	const statuses = await Promise.all(
		allRepos.map(async repoPath => ({
			repoPath,
			status: await git.status(repoPath, {
				porcelainV1: true,
				untrackedFiles: "all",
			}),
		})),
	);
	return {
		root,
		repos: statuses.filter(entry => entry.status.trim().length > 0).map(entry => entry.repoPath),
	};
}

export interface CommitDirtyRepoEntry {
	repoPath: string;
	status: "committed" | "skipped" | "failed";
	sha?: string;
	filesChanged: number;
	message?: string;
	reason?: "no-changes";
	error?: string;
}

export interface CommitDirtyReposOptions {
	cwd: string;
	modelRegistry: ModelRegistry | undefined;
	settings: Settings;
	sessionId?: string;
}

/**
 * Commit every dirty repo under `cwd` using a model-generated commit message per repo.
 *
 * Shared by:
 * - the `git_commit_checkpoint` tool (LLM-invoked scope closer), and
 * - the `task` dispatcher (automatic pre-task safety commit: cherry-picking the task's
 *   branch onto a dirty parent is the primary cause of merge failures; committing
 *   first collapses that hazard entirely).
 *
 * Discovery runs before `git add -A`, so hidden child task/cache directories are
 * never staged as a side effect of checkpointing.
 * Entries with no staged content after `git add -A` are returned as `skipped`.
 * Throws only when the caller passes no `modelRegistry` AND a commit would be required —
 * otherwise each repo's failure is reported in its entry so a partial failure does not
 * block siblings.
 */
export async function commitDirtyRepos(options: CommitDirtyReposOptions): Promise<CommitDirtyRepoEntry[]> {
	const { cwd, modelRegistry, settings, sessionId } = options;
	const { repos } = await dirtyRepos(cwd);
	if (repos.length === 0) return [];
	if (!modelRegistry) {
		throw new Error("A model registry is required to generate a commit message.");
	}

	const entries: CommitDirtyRepoEntry[] = [];
	for (const repoPath of repos) {
		try {
			entries.push(await commitSingleRepo(repoPath, modelRegistry, settings, sessionId));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			entries.push({
				repoPath,
				status: "failed",
				filesChanged: 0,
				error: message,
			});
		}
	}
	return entries;
}

async function commitSingleRepo(
	repoPath: string,
	modelRegistry: ModelRegistry,
	settings: Settings,
	sessionId: string | undefined,
): Promise<CommitDirtyRepoEntry> {
	await git.stage.files(repoPath);
	const stagedFiles = await git.diff.changedFiles(repoPath, { cached: true });
	if (stagedFiles.length === 0) {
		return {
			repoPath,
			status: "skipped",
			filesChanged: 0,
			reason: "no-changes",
		};
	}
	const diff = await git.diff(repoPath, { cached: true });
	const message = await generateCommitMessage(diff, modelRegistry, settings, sessionId);
	if (!message) {
		throw new Error("Could not generate a commit message.");
	}
	await git.commit(repoPath, message);
	const sha = (await git.head.short(repoPath)) ?? undefined;
	return {
		repoPath,
		status: "committed",
		sha,
		filesChanged: stagedFiles.length,
		message,
	};
}
