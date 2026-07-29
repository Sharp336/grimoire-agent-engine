/**
 * `/worktree` handler — list, create, and remove agent-managed git worktrees
 * under `~/.omp/wt` (see `utils/managed-worktrees.ts`). One body serves both
 * dispatchers: the TUI adapts `runtime.output` to `ctx.showStatus`, ACP routes
 * it to `sessionUpdate`. Cleanup of orphaned entries stays with the
 * `omp worktree clear` CLI (`cli/worktree-cli.ts`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreeDir, getWorktreesDir } from "@oh-my-pi/pi-utils";
import { resolveToCwd } from "../../tools/path-utils";
import * as git from "../../utils/git";
import {
	managedWorktreeName,
	resolveManagedWorktreePath,
	scanWorktrees,
	type WorktreeEntry,
} from "../../utils/managed-worktrees";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

const WORKTREE_USAGE = "Usage: /worktree [list [--all] | create <branch> [base] | remove <path|branch> [--force]]";

/** `/worktree` entry point shared by the TUI and ACP dispatchers via the spec. */
export async function handleWorktreeAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	switch (verb) {
		case "":
		case "list":
			return handleList(rest, runtime);
		case "create":
			return handleCreate(rest, runtime);
		case "remove":
		case "rm":
			return handleRemove(rest, runtime);
		default:
			return usage(WORKTREE_USAGE, runtime);
	}
}

async function handleList(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const tokens = rest.split(/\s+/).filter(Boolean);
	if (tokens.some(token => token !== "--all")) return usage("Usage: /worktree list [--all]", runtime);
	const all = tokens.length > 0;

	const entries = await scanWorktrees();
	const primaryRoot = await git.repo.primaryRoot(runtime.cwd);
	const visible = entries.filter(entry => {
		if (all) return true;
		if (entry.kind !== "pr-checkout" || entry.orphanReason !== undefined) return false;
		// Outside a repo there is no "current repo" to filter by — show everything.
		if (!primaryRoot || !entry.parentRepo) return true;
		return path.resolve(entry.parentRepo) === path.resolve(primaryRoot);
	});
	if (visible.length === 0) {
		const scope = all ? getWorktreesDir() : `the current repo under ${getWorktreesDir()}`;
		return usage(`No agent-managed worktrees found for ${scope}.`, runtime);
	}
	const lines = visible.map(entry => {
		const suffix = entry.orphanReason ? ` — orphaned (${entry.orphanReason})` : "";
		return `${entry.path} — ${entry.branch ?? "unknown branch"}${suffix}`;
	});
	if (all && visible.some(entry => entry.orphanReason !== undefined)) {
		lines.push("Clean up orphaned entries with `omp worktree clear`.");
	}
	await runtime.output(lines.join("\n"));
	return commandConsumed();
}

async function handleCreate(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const tokens = rest.split(/\s+/).filter(Boolean);
	const [branch, base] = tokens;
	if (!branch || branch.startsWith("-") || tokens.length > 2) {
		return usage("Usage: /worktree create <branch> [base]", runtime);
	}
	const repoRoot = await git.repo.root(runtime.cwd);
	if (!repoRoot) return usage(`Not a git repository: ${runtime.cwd}`, runtime);
	const primaryRoot = (await git.repo.primaryRoot(runtime.cwd)) ?? repoRoot;
	const branchRef = `refs/heads/${branch}`;

	const existing = await git.worktree.list(primaryRoot);
	const checkedOut = existing.find(entry => entry.branch === branchRef);
	if (checkedOut) return usage(`Branch ${branch} is already checked out at ${checkedOut.path}.`, runtime);

	const branchExists = await git.ref.exists(primaryRoot, branchRef);
	// Default base: the session checkout's HEAD, resolved to a SHA. Inside a
	// linked worktree, `git worktree add … HEAD` run from primaryRoot would
	// fork from the *primary* checkout's commit, not the caller's.
	const startPoint = base ?? (await git.head.sha(runtime.cwd)) ?? "HEAD";
	const worktreePath = await resolveManagedWorktreePath(
		getWorktreeDir(managedWorktreeName(branch, primaryRoot)),
		existing.map(entry => entry.path),
	);

	try {
		// Serialize against other git mutations on this repo (see gh.ts pr_checkout).
		await git.withRepoLock(primaryRoot, async () => {
			await fs.mkdir(path.dirname(worktreePath), { recursive: true });
			if (branchExists) {
				await git.worktree.add(primaryRoot, worktreePath, branch);
			} else {
				await git.worktree.add(primaryRoot, worktreePath, startPoint, { newBranch: branch });
			}
		});
	} catch (err) {
		return usage(`Create failed: ${errorMessage(err)}`, runtime);
	}
	await runtime.output(
		[
			`Created worktree: ${worktreePath}`,
			`Branch: ${branch}${branchExists ? " (existing)" : ` (new, from ${base ?? "HEAD"})`}`,
			"Move the session into it with /move (alias /cd).",
		].join("\n"),
	);
	return commandConsumed();
}

async function handleRemove(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const tokens = rest.split(/\s+/).filter(Boolean);
	const force = tokens.includes("--force");
	const selector = tokens.find(token => token !== "--force");
	if (!selector || tokens.some(token => token !== "--force" && token !== selector)) {
		return usage("Usage: /worktree remove <path|branch> [--force]", runtime);
	}

	const target = await resolveRemovalTarget(selector, runtime.cwd);
	if ("error" in target) return usage(target.error, runtime);
	const { entry } = target;

	const sessionRoot = await git.repo.root(runtime.cwd);
	if (sessionRoot && path.resolve(sessionRoot) === path.resolve(entry.path)) {
		return usage("Refusing to remove the worktree the session is running in.", runtime);
	}
	const parentRepo = entry.parentRepo!;
	try {
		await git.worktree.remove(parentRepo, entry.path, { force });
	} catch (err) {
		const message = errorMessage(err);
		if (!force && /dirty|modified|untracked|not clean/i.test(message)) {
			return usage(`Worktree has uncommitted changes; pass --force to discard them. (${message})`, runtime);
		}
		return usage(message, runtime);
	}
	await git.worktree.prune(parentRepo).catch(() => {});
	await runtime.output(`Removed worktree: ${entry.path}${entry.branch ? ` (${entry.branch})` : ""}`);
	return commandConsumed();
}

type RemovalTarget = { entry: WorktreeEntry } | { error: string };

/**
 * Match a `<path|branch>` selector against the live managed worktrees of the
 * current repo. Path equality wins over branch equality so a selector that is
 * both stays deterministic.
 */
async function resolveRemovalTarget(selector: string, cwd: string): Promise<RemovalTarget> {
	const entries = await scanWorktrees();
	const primaryRoot = await git.repo.primaryRoot(cwd);
	const candidates = entries.filter(entry => {
		if (entry.kind !== "pr-checkout" || entry.orphanReason !== undefined || !entry.parentRepo) return false;
		if (!primaryRoot) return true;
		return path.resolve(entry.parentRepo) === path.resolve(primaryRoot);
	});
	const resolvedSelector = path.resolve(resolveToCwd(selector, cwd));
	const byPath = candidates.filter(entry => path.resolve(entry.path) === resolvedSelector);
	const matches = byPath.length > 0 ? byPath : candidates.filter(entry => entry.branch === selector);
	if (matches.length === 0) {
		return {
			error: `No live managed worktree of the current repo matches ${selector}. Use /worktree list to see candidates.`,
		};
	}
	if (matches.length > 1) {
		return { error: `Ambiguous selector: ${matches.map(entry => entry.path).join(", ")}` };
	}
	return { entry: matches[0]! };
}
