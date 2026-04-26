import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { commitDirtyRepos, dirtyRepos } from "@oh-my-pi/pi-coding-agent/task/auto-commit";
import * as commitMessageGenerator from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";

const tempDirs: string[] = [];

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

async function initGitRepo(repo: string): Promise<string> {
	await fs.mkdir(repo, { recursive: true });
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

async function createGitRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(repo);
	return await initGitRepo(repo);
}

async function setOriginUrl(repo: string, url: string): Promise<void> {
	await runGit(repo, ["config", "remote.origin.url", url]);
}

async function createNestedRepoFixture(): Promise<{ rootRepo: string; nestedRepo: string }> {
	const rootRepo = await createGitRepo("omp-auto-commit-root-");
	const nestedRepo = path.join(rootRepo, "nested");
	await fs.mkdir(nestedRepo, { recursive: true });
	await runGit(nestedRepo, ["init"]);
	await runGit(nestedRepo, ["config", "user.email", "test@example.com"]);
	await runGit(nestedRepo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(nestedRepo, "nested.txt"), "nested base\n");
	await runGit(nestedRepo, ["add", "."]);
	await runGit(nestedRepo, ["commit", "-m", "nested initial"]);
	return { rootRepo, nestedRepo };
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("dirtyRepos", () => {
	it("returns no dirty repos for a clean git repo", async () => {
		const repo = await createGitRepo("omp-auto-commit-clean-");
		const result = await dirtyRepos(repo);
		expect(result.root).toBe(repo);
		expect(result.repos).toEqual([]);
	});

	it("includes the repo path when the root repo has an unstaged edit", async () => {
		const repo = await createGitRepo("omp-auto-commit-dirty-");
		await fs.writeFile(path.join(repo, "tracked.txt"), "edited\n");
		const result = await dirtyRepos(repo);
		expect(result.repos).toEqual([repo]);
	});

	it("includes the repo path when the starting repo is inside a dot-prefixed directory", async () => {
		const hiddenParent = await fs.mkdtemp(path.join(os.tmpdir(), ".omp-auto-commit-hidden-parent-"));
		tempDirs.push(hiddenParent);
		const repo = await initGitRepo(path.join(hiddenParent, "repo"));
		await fs.writeFile(path.join(repo, "tracked.txt"), "edited\n");

		const result = await dirtyRepos(repo);

		expect(result.root).toBe(repo);
		expect(result.repos).toEqual([repo]);
	});

	it("includes both root and nested repos when a nested repo is dirty", async () => {
		const { rootRepo, nestedRepo } = await createNestedRepoFixture();
		await fs.writeFile(path.join(nestedRepo, "nested.txt"), "nested dirty\n");
		const result = await dirtyRepos(rootRepo);
		expect(result.repos).toEqual(expect.arrayContaining([rootRepo, nestedRepo]));
		expect(result.repos).toHaveLength(2);
	});

	it("lists only dirty repos and excludes clean nested repos", async () => {
		const { rootRepo, nestedRepo } = await createNestedRepoFixture();
		await fs.writeFile(path.join(rootRepo, "tracked.txt"), "dirty\n");
		const result = await dirtyRepos(rootRepo);
		expect(result.repos).toEqual([rootRepo]);
		expect(result.repos).not.toContain(nestedRepo);
	});

	it("discovers ignored nested repos when they have a different origin", async () => {
		const rootRepo = await createGitRepo("omp-auto-commit-ignored-nested-root-");
		const nestedRepo = path.join(rootRepo, "ignored-nested", "repo");
		await setOriginUrl(rootRepo, "https://example.com/root.git");
		await fs.writeFile(path.join(rootRepo, ".gitignore"), "ignored-nested/\n");
		await runGit(rootRepo, ["add", ".gitignore"]);
		await runGit(rootRepo, ["commit", "-m", "ignore nested path"]);

		await fs.mkdir(nestedRepo, { recursive: true });
		await runGit(nestedRepo, ["init"]);
		await runGit(nestedRepo, ["config", "user.email", "test@example.com"]);
		await runGit(nestedRepo, ["config", "user.name", "Test User"]);
		await setOriginUrl(nestedRepo, "https://example.com/independent.git");
		await fs.writeFile(path.join(nestedRepo, "nested.txt"), "nested base\n");
		await runGit(nestedRepo, ["add", "."]);
		await runGit(nestedRepo, ["commit", "-m", "nested initial"]);
		await fs.writeFile(path.join(nestedRepo, "nested.txt"), "nested dirty\n");

		const result = await dirtyRepos(rootRepo);
		expect(result.repos).toEqual([nestedRepo]);
	});

	it("discovers ignored same-origin nested repos when they are ordinary repos", async () => {
		const rootRepo = await createGitRepo("omp-auto-commit-same-origin-root-");
		const nestedRepo = path.join(rootRepo, "ignored-copy", "repo");
		const originUrl = "https://example.com/owner/project.git";
		await setOriginUrl(rootRepo, originUrl);
		await fs.writeFile(path.join(rootRepo, ".gitignore"), "ignored-copy/\n");
		await runGit(rootRepo, ["add", ".gitignore"]);
		await runGit(rootRepo, ["commit", "-m", "ignore nested path"]);

		await fs.mkdir(nestedRepo, { recursive: true });
		await runGit(nestedRepo, ["init"]);
		await runGit(nestedRepo, ["config", "user.email", "test@example.com"]);
		await runGit(nestedRepo, ["config", "user.name", "Test User"]);
		await setOriginUrl(nestedRepo, originUrl);
		await fs.writeFile(path.join(nestedRepo, "nested.txt"), "nested base\n");
		await runGit(nestedRepo, ["add", "."]);
		await runGit(nestedRepo, ["commit", "-m", "nested initial"]);
		await fs.writeFile(path.join(nestedRepo, "nested.txt"), "nested dirty\n");

		const result = await dirtyRepos(rootRepo);
		expect(result.repos).toEqual([nestedRepo]);
	});

	it("does not navigate into ignored dot-prefixed child directories", async () => {
		const rootRepo = await createGitRepo("omp-auto-commit-hidden-nested-root-");
		const nestedRepo = path.join(rootRepo, ".overlay-state", "upper");
		await fs.writeFile(path.join(rootRepo, ".gitignore"), ".overlay-state/\n");
		await runGit(rootRepo, ["add", ".gitignore"]);
		await runGit(rootRepo, ["commit", "-m", "ignore hidden overlay state"]);

		await fs.mkdir(nestedRepo, { recursive: true });
		await runGit(nestedRepo, ["init"]);
		await runGit(nestedRepo, ["config", "user.email", "test@example.com"]);
		await runGit(nestedRepo, ["config", "user.name", "Test User"]);
		await fs.writeFile(path.join(nestedRepo, "nested.txt"), "nested base\n");
		await runGit(nestedRepo, ["add", "."]);
		await runGit(nestedRepo, ["commit", "-m", "nested initial"]);
		await fs.writeFile(path.join(nestedRepo, "nested.txt"), "nested dirty\n");

		const result = await dirtyRepos(rootRepo);

		expect(result.repos).toEqual([]);
	});
});

describe("commitDirtyRepos", () => {
	it("is a no-op when every repo is clean", async () => {
		const repo = await createGitRepo("omp-auto-commit-helper-clean-");
		const entries = await commitDirtyRepos({
			cwd: repo,
			modelRegistry: {} as unknown as never,
			settings: Settings.isolated(),
		});
		expect(entries).toEqual([]);
		expect(await runGit(repo, ["log", "--oneline"])).toMatch(/^[0-9a-f]+ initial$/);
	});

	it("commits dirty tracked + untracked content and leaves the worktree clean", async () => {
		const repo = await createGitRepo("omp-auto-commit-helper-dirty-");
		await runGit(repo, ["config", "commit.gpgsign", "false"]);
		await fs.writeFile(path.join(repo, "tracked.txt"), "edited\n");
		await fs.writeFile(path.join(repo, "brand-new.txt"), "fresh\n");
		vi.spyOn(commitMessageGenerator, "generateCommitMessage").mockResolvedValue("chore: pre-task snapshot");

		const entries = await commitDirtyRepos({
			cwd: repo,
			modelRegistry: {} as unknown as never,
			settings: Settings.isolated(),
		});

		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe("committed");
		expect(entries[0].message).toBe("chore: pre-task snapshot");
		expect(entries[0].filesChanged).toBe(2);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
		expect(await runGit(repo, ["log", "-1", "--format=%s"])).toBe("chore: pre-task snapshot");
	});

	it("throws when the caller passes no model registry but a commit is required", async () => {
		const repo = await createGitRepo("omp-auto-commit-helper-no-registry-");
		await fs.writeFile(path.join(repo, "tracked.txt"), "edited\n");
		await expect(
			commitDirtyRepos({
				cwd: repo,
				modelRegistry: undefined,
				settings: Settings.isolated(),
			}),
		).rejects.toThrow(/model registry/);
		// Worktree stays dirty — no partial commit on the failure path.
		expect(await runGit(repo, ["status", "--porcelain=v1"])).not.toBe("");
	});
});
