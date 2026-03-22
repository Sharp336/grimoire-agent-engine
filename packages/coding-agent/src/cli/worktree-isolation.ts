import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { getRepoRoot } from "../task/worktree";

const MAIN_WORKTREE_DIRNAME = ".worktrees";
const MAIN_WORKTREE_PREFIX = "omp";
const MAIN_WORKTREE_BRANCH_PREFIX = "worktree";

export interface MainWorktreeIsolationOptions {
	continue?: boolean;
	resume?: string | true;
	fork?: string;
}

export interface MainWorktreeIsolation {
	worktreeRoot: string;
	isolatedCwd: string;
	notice: string;
	cleanupIfClean(): Promise<boolean>;
}

export function validateMainWorktreeIsolationArgs(options: MainWorktreeIsolationOptions): void {
	const conflicts: string[] = [];
	if (options.continue) {
		conflicts.push("--continue");
	}
	if (options.resume !== undefined) {
		conflicts.push("--resume/--session");
	}
	if (options.fork) {
		conflicts.push("--fork");
	}
	if (conflicts.length === 0) {
		return;
	}
	throw new Error(
		`--worktree cannot be combined with ${conflicts.join(", ")}. Start a fresh worktree session instead.`,
	);
}

function getMainWorktreeName(): string {
	return `${MAIN_WORKTREE_PREFIX}-${Snowflake.next()}`;
}

function getMainWorktreeBranchName(worktreeName: string): string {
	return `${MAIN_WORKTREE_BRANCH_PREFIX}-${worktreeName}`;
}

async function getIsolatedCwd(repoRoot: string, worktreeRoot: string, cwd: string): Promise<string> {
	const resolvedCwd = await fs.realpath(cwd).catch(() => path.resolve(cwd));
	const relativeCwd = path.relative(repoRoot, resolvedCwd);
	if (!relativeCwd || relativeCwd === ".") {
		return worktreeRoot;
	}
	if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
		return worktreeRoot;
	}
	const isolatedCwd = path.join(worktreeRoot, relativeCwd);
	await fs.mkdir(isolatedCwd, { recursive: true });
	return isolatedCwd;
}

async function cleanupMainWorktree(
	repoRoot: string,
	worktreeRoot: string,
	branchName: string,
	baseCommit: string,
): Promise<void> {
	const currentHead = (await $`git rev-parse HEAD`.cwd(worktreeRoot).quiet().nothrow().text()).trim();
	if (currentHead && currentHead !== baseCommit) {
		throw new Error("Temporary worktree contains committed changes.");
	}
	const status = (
		await $`git --no-optional-locks status --porcelain`.cwd(worktreeRoot).quiet().nothrow().text()
	).trim();
	if (status.length > 0) {
		throw new Error("Temporary worktree contains uncommitted changes.");
	}
	await $`git worktree remove -f ${worktreeRoot}`.cwd(repoRoot).quiet();
	await fs.rm(worktreeRoot, { recursive: true, force: true });
	await $`git branch -D ${branchName}`.cwd(repoRoot).quiet();
}

export async function prepareMainWorktreeIsolation(cwd: string): Promise<MainWorktreeIsolation> {
	let repoRoot: string;
	try {
		repoRoot = await getRepoRoot(cwd);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`--worktree requires a git repository. ${message}`);
	}

	const baseCommit = (await $`git rev-parse HEAD`.cwd(repoRoot).quiet().text()).trim();
	const worktreeName = getMainWorktreeName();
	const branchName = getMainWorktreeBranchName(worktreeName);
	const worktreeRoot = path.join(repoRoot, MAIN_WORKTREE_DIRNAME, worktreeName);
	await fs.mkdir(path.dirname(worktreeRoot), { recursive: true });
	await fs.rm(worktreeRoot, { recursive: true, force: true });
	await $`git worktree add -b ${branchName} ${worktreeRoot} HEAD`.cwd(repoRoot).quiet();

	const isolatedCwd = await getIsolatedCwd(repoRoot, worktreeRoot, cwd);
	const noticeSuffix = isolatedCwd === worktreeRoot ? "" : ` (cwd: ${isolatedCwd})`;
	const notice = `Running in temporary worktree: ${worktreeRoot}${noticeSuffix}`;

	return {
		worktreeRoot,
		isolatedCwd,
		notice,
		cleanupIfClean: async () => {
			try {
				await cleanupMainWorktree(repoRoot, worktreeRoot, branchName, baseCommit);
				return true;
			} catch {
				return false;
			}
		},
	};
}
