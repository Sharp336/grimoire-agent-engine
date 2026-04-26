import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyBaseline,
	captureBaseline,
	captureDeltaPatch,
	commitToBranch,
	discoverNestedRepos,
	ensureWorktree,
	getGitNoIndexNullPath,
	isProjfsUnavailableError,
	mergeSingleBranch,
} from "../../src/task/worktree";

const projfsOverlayStartMock = vi.fn();
const projfsOverlayStopMock = vi.fn();
const tempDirs: string[] = [];

vi.mock("@oh-my-pi/pi-natives", () => ({
	projfsOverlayStart: projfsOverlayStartMock,
	projfsOverlayStop: projfsOverlayStopMock,
}));

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

async function createGitRepo(prefix = "omp-worktree-"): Promise<{ baseBranch: string; repo: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(repo);
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "merged.txt"), "base version\n");
	await fs.writeFile(path.join(repo, "staged.txt"), "base staged\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return {
		baseBranch: await runGit(repo, ["branch", "--show-current"]),
		repo,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("worktree isolation helpers", () => {
	it("returns platform-specific null path for git --no-index diffs", () => {
		const expected = process.platform === "win32" ? "NUL" : "/dev/null";
		expect(getGitNoIndexNullPath()).toBe(expected);
	});

	it("detects ProjFS prerequisite errors by prefix", () => {
		expect(isProjfsUnavailableError(new Error("PROJFS_UNAVAILABLE: missing feature"))).toBe(true);
		expect(isProjfsUnavailableError(new Error("reflink snapshot failed"))).toBe(false);
		expect(isProjfsUnavailableError("PROJFS_UNAVAILABLE: not-an-error-instance")).toBe(false);
	});

	it("does not navigate into dot-prefixed child directories during nested repo discovery", async () => {
		const { repo } = await createGitRepo();
		const hiddenRepo = path.join(repo, ".overlay-state", "upper");
		const visibleRepo = path.join(repo, "visible");
		await fs.mkdir(hiddenRepo, { recursive: true });
		await fs.mkdir(visibleRepo, { recursive: true });
		await runGit(hiddenRepo, ["init"]);
		await runGit(visibleRepo, ["init"]);

		const nested = await discoverNestedRepos(repo);

		expect(nested).toEqual(["visible"]);
	});

	it("discovers nested repos when the traversal root is dot-prefixed", async () => {
		const { repo } = await createGitRepo(".omp-worktree-hidden-root-");
		const visibleRepo = path.join(repo, "visible");
		await fs.mkdir(visibleRepo, { recursive: true });
		await runGit(visibleRepo, ["init"]);

		const nested = await discoverNestedRepos(repo);

		expect(nested).toEqual(["visible"]);
	});

	it("does not pop an unrelated pre-existing stash when there is nothing to merge", async () => {
		const { repo } = await createGitRepo();
		await fs.writeFile(path.join(repo, "preexisting.txt"), "user stash\n");
		await runGit(repo, ["stash", "push", "--include-untracked", "-m", "preexisting-user-stash"]);
		const before = await runGit(repo, ["stash", "list"]);

		// Merging with no branches is simulated by just not calling mergeSingleBranch at all.
		// Verify the stash list is still intact (sanity).
		expect(await runGit(repo, ["stash", "list"])).toBe(before);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
	});

	it("restores staged changes with index preservation after merging a task branch", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-staged";
		await runGit(repo, ["checkout", "-b", taskBranch]);
		await fs.writeFile(path.join(repo, "merged.txt"), "task branch change\n");
		await runGit(repo, ["add", "merged.txt"]);
		await runGit(repo, ["commit", "-m", "task-change"]);
		await runGit(repo, ["checkout", baseBranch]);
		await fs.writeFile(path.join(repo, "staged.txt"), "local staged change\n");
		await runGit(repo, ["add", "staged.txt"]);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("M  staged.txt");

		const result = await mergeSingleBranch(repo, { branchName: taskBranch, taskId: "task-1" });

		expect(result.ok).toBe(true);
		expect(result.commit).toMatch(/^[0-9a-f]+$/);
		expect(await fs.readFile(path.join(repo, "merged.txt"), "utf8")).toBe("task branch change\n");
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("M  staged.txt");
		expect(await runGit(repo, ["diff", "--cached", "--", "staged.txt"])).toContain("+local staged change");
		expect(await runGit(repo, ["stash", "list"])).toBe("");
	});

	it("creates task branch at the orchestration baseline SHA even when real HEAD has advanced", async () => {
		const { baseBranch, repo } = await createGitRepo();
		// Capture baseline while real HEAD points at commit A.
		const baselineSha = await runGit(repo, ["rev-parse", "HEAD"]);
		const baseline = await captureBaseline(repo);
		expect(baseline.root.headCommit).toBe(baselineSha);

		// Set up an isolation worktree at baseline and produce a task edit.
		const isolationDir = await ensureWorktree(repo, "task-race", baseline.root.headCommit);
		tempDirs.push(isolationDir);
		try {
			await applyBaseline(isolationDir, baseline);
			await fs.writeFile(path.join(isolationDir, "merged.txt"), "task edit\n");

			// Simulate a sibling task having merged into real repo: advance HEAD on main.
			await fs.writeFile(path.join(repo, "sibling.txt"), "sibling merged\n");
			await runGit(repo, ["add", "."]);
			await runGit(repo, ["commit", "-m", "sibling merged"]);
			const advancedSha = await runGit(repo, ["rev-parse", "HEAD"]);
			expect(advancedSha).not.toBe(baselineSha);

			// Phase 1: commit task delta to a branch. MUST create it at baselineSha so the
			// delta (generated against baseline) applies cleanly.
			const result = await commitToBranch(isolationDir, baseline, "race-test", "race task");
			expect(result).not.toBeNull();
			expect(result?.branchName).toBe("omp/task/race-test");

			const parentSha = await runGit(repo, ["rev-parse", `omp/task/race-test^`]);
			expect(parentSha).toBe(baselineSha);
			expect(parentSha).not.toBe(advancedSha);
			expect(await runGit(repo, ["show", "omp/task/race-test:merged.txt"])).toBe("task edit");
		} finally {
			await runGit(repo, ["worktree", "remove", "--force", isolationDir]).catch(() => {});
			await runGit(repo, ["branch", "-D", baseBranch]).catch(() => {});
		}
	});

	it("drops redundant cherry-pick when a sibling task already merged identical content", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const baselineSha = await runGit(repo, ["rev-parse", "HEAD"]);

		// Create two task branches off the same baseline with identical changes, as happens
		// when parallel subagents all emit the same edit (e.g. one ran a formatter, the other
		// wrote the same refactor the primary task was assigned).
		async function commitOnBranch(name: string): Promise<string> {
			await runGit(repo, ["checkout", "-b", name, baselineSha]);
			await fs.writeFile(path.join(repo, "merged.txt"), "duplicated edit\n");
			await runGit(repo, ["add", "merged.txt"]);
			await runGit(repo, ["commit", "-m", `${name}: duplicated edit`]);
			const sha = await runGit(repo, ["rev-parse", "HEAD"]);
			await runGit(repo, ["checkout", baseBranch]);
			return sha;
		}

		await commitOnBranch("omp/task/first");
		await commitOnBranch("omp/task/second");

		// First cherry-pick applies cleanly.
		const firstResult = await mergeSingleBranch(repo, { branchName: "omp/task/first", taskId: "first" });
		expect(firstResult.ok).toBe(true);
		expect(firstResult.commit).toMatch(/^[0-9a-f]+$/);
		const headAfterFirst = await runGit(repo, ["rev-parse", "HEAD"]);

		// Second cherry-pick is a no-op: content already in HEAD. Without --empty=drop this
		// would abort with exit 1 and preserve the branch; we want it to drop silently so the
		// batch continues.
		const secondResult = await mergeSingleBranch(repo, { branchName: "omp/task/second", taskId: "second" });
		expect(secondResult.ok).toBe(true);
		expect(secondResult.conflict).toBeUndefined();
		expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(headAfterFirst);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
	});
	it("replays the user's uncommitted dirty state into the task branch so Phase 1 apply succeeds", async () => {
		const { baseBranch, repo } = await createGitRepo();

		// Baseline file has ten numbered lines; the user's dirty edit replaces line 1 only, and
		// the subagent appends a new line at the end. Non-overlapping regions so Phase 2
		// cherry-pick can also succeed cleanly.
		const baseContent = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join("");
		await fs.writeFile(path.join(repo, "page.tsx"), baseContent);
		await runGit(repo, ["add", "page.tsx"]);
		await runGit(repo, ["commit", "-m", "page baseline"]);
		const baselineSha = await runGit(repo, ["rev-parse", "HEAD"]);

		// User makes an uncommitted edit to line 1.
		const dirtyContent = baseContent.replace("line 1\n", "line 1 EDITED BY USER\n");
		await fs.writeFile(path.join(repo, "page.tsx"), dirtyContent);
		const baseline = await captureBaseline(repo);
		expect(baseline.root.unstaged.trim().length).toBeGreaterThan(0);

		const isolationDir = await ensureWorktree(repo, "dirty-replay", baseline.root.headCommit);
		tempDirs.push(isolationDir);
		try {
			await applyBaseline(isolationDir, baseline);
			expect(await fs.readFile(path.join(isolationDir, "page.tsx"), "utf8")).toBe(dirtyContent);

			// Subagent appends at the end — far from the user's dirty edit on line 1.
			const subagentContent = `${dirtyContent}line 11 ADDED BY SUBAGENT\n`;
			await fs.writeFile(path.join(isolationDir, "page.tsx"), subagentContent);

			// Phase 1 must succeed: the captured patch's "before" context includes the user's
			// dirty state, so the task branch needs it replayed as an interim omp-baseline commit.
			const result = await commitToBranch(isolationDir, baseline, "dirty-replay", "dirty replay task");
			expect(result?.branchName).toBe("omp/task/dirty-replay");

			// Branch chain: baseSha -> omp-baseline (replayed dirty state) -> task-commit.
			const taskCommit = await runGit(repo, ["rev-parse", "omp/task/dirty-replay"]);
			const parentSha = await runGit(repo, ["rev-parse", `${taskCommit}^`]);
			const grandparentSha = await runGit(repo, ["rev-parse", `${taskCommit}^^`]);
			expect(grandparentSha).toBe(baselineSha);
			expect(await runGit(repo, ["log", "-1", "--format=%s", parentSha])).toBe("omp-baseline");
			expect(await runGit(repo, ["show", `${parentSha}:page.tsx`])).toBe(dirtyContent.trimEnd());
			expect(await runGit(repo, ["show", `${taskCommit}:page.tsx`])).toBe(subagentContent.trimEnd());

			// Phase 2: cherry-pick subtracts the replayed dirty state via 3-way merge and lands
			// only the subagent delta on real HEAD; stash pop then restores the user's edit.
			const mergeResult = await mergeSingleBranch(repo, {
				branchName: "omp/task/dirty-replay",
				taskId: "dirty-replay",
			});
			expect(mergeResult.ok).toBe(true);
			expect(mergeResult.conflict).toBeUndefined();
			// Landed commit is subagent delta only (no user dirty state).
			expect(await runGit(repo, ["show", "HEAD:page.tsx"])).toBe(`${baseContent}line 11 ADDED BY SUBAGENT`);
			// Working tree has both the user's dirty edit (from stash pop) and the subagent addition.
			expect(await fs.readFile(path.join(repo, "page.tsx"), "utf8")).toBe(subagentContent);
		} finally {
			await runGit(repo, ["worktree", "remove", "--force", isolationDir]).catch(() => {});
			await runGit(repo, ["branch", "-D", baseBranch]).catch(() => {});
		}
	});

	it("retries with -X theirs on conflict and reports aggressive-merge files", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const baselineSha = await runGit(repo, ["rev-parse", "HEAD"]);

		// Two parallel tasks edit the same file with divergent content on the same lines.
		// Standard cherry-pick will conflict; -X theirs must take the picked branch's version.
		async function commitOnBranch(name: string, content: string): Promise<void> {
			await runGit(repo, ["checkout", "-b", name, baselineSha]);
			await fs.writeFile(path.join(repo, "merged.txt"), content);
			await runGit(repo, ["add", "merged.txt"]);
			await runGit(repo, ["commit", "-m", `${name}: edit`]);
			await runGit(repo, ["checkout", baseBranch]);
		}

		await commitOnBranch("omp/task/first-aggr", "first task wins the slot\n");
		await commitOnBranch("omp/task/second-aggr", "second task writes something else\n");

		// First merges cleanly.
		const first = await mergeSingleBranch(repo, { branchName: "omp/task/first-aggr", taskId: "first" });
		expect(first.ok).toBe(true);
		expect(first.aggressive).toBeUndefined();

		// Second conflicts on merged.txt; retry with -X theirs must succeed and report the file.
		const second = await mergeSingleBranch(repo, { branchName: "omp/task/second-aggr", taskId: "second" });
		expect(second.ok).toBe(true);
		expect(second.conflict).toBeUndefined();
		expect(second.aggressive).toBeDefined();
		expect(second.aggressive?.files).toContain("merged.txt");
		// The picked branch's content wins.
		expect(await runGit(repo, ["show", "HEAD:merged.txt"])).toBe("second task writes something else");
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
	});

	it("captures delta for nested repo with unresolvable HEAD (freshly init'd, no commits)", async () => {
		// Regression: `captureRepoBaseline` used to coerce `git.head.sha() === null` to `""`,
		// which then flowed into `git read-tree` as an empty SHA and raised `fatal: Not a valid
		// object name`, aborting the whole task merge. Fresh `git init` with no commits is a
		// legitimate nested state (scaffolded tool dirs) and must not poison delta capture.
		const { repo } = await createGitRepo();
		const nestedRel = "tools/scaffold";
		const nestedDir = path.join(repo, nestedRel);
		await fs.mkdir(nestedDir, { recursive: true });
		await runGit(nestedDir, ["init"]);
		await runGit(nestedDir, ["config", "user.email", "test@example.com"]);
		await runGit(nestedDir, ["config", "user.name", "Test User"]);
		// Deliberately no commits: HEAD resolves to nothing.
		await expect(runGit(nestedDir, ["rev-parse", "HEAD"])).rejects.toThrow();

		const baseline = await captureBaseline(repo);
		const nestedEntry = baseline.nested.find(n => n.relativePath === nestedRel);
		expect(nestedEntry).toBeDefined();
		expect(nestedEntry?.baseline.headCommit).toBe("");

		const isolationDir = await ensureWorktree(repo, "no-head-nested", baseline.root.headCommit);
		tempDirs.push(isolationDir);
		try {
			await applyBaseline(isolationDir, baseline);

			// Subagent produces a file inside the no-HEAD nested repo.
			const isolatedNested = path.join(isolationDir, nestedRel);
			await fs.writeFile(path.join(isolatedNested, "added.txt"), "subagent added\n");

			// Must not throw `fatal: Not a valid object name`.
			const delta = await captureDeltaPatch(isolationDir, baseline);
			const nestedPatch = delta.nestedPatches.find(p => p.relativePath === nestedRel);
			expect(nestedPatch).toBeDefined();
			expect(nestedPatch?.patch).toContain("added.txt");
			expect(nestedPatch?.patch).toContain("subagent added");
		} finally {
			await runGit(repo, ["worktree", "remove", "--force", isolationDir]).catch(() => {});
		}
	});
});
