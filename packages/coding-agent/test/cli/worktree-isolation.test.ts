import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	prepareMainWorktreeIsolation,
	validateMainWorktreeIsolationArgs,
} from "@oh-my-pi/pi-coding-agent/cli/worktree-isolation";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

async function createGitRepo(baseDir: string): Promise<{ repoRoot: string; workingCwd: string }> {
	const repoRoot = path.join(baseDir, "repo");
	const workingCwd = path.join(repoRoot, "subdir");
	await fs.mkdir(workingCwd, { recursive: true });
	await Bun.write(path.join(workingCwd, "tracked.txt"), "base\n");
	await $`git init`.cwd(repoRoot).quiet();
	await $`git config user.email test@example.com`.cwd(repoRoot).quiet();
	await $`git config user.name "Test User"`.cwd(repoRoot).quiet();
	await $`git add .`.cwd(repoRoot).quiet();
	await $`git commit -m init`.cwd(repoRoot).quiet();
	return { repoRoot, workingCwd };
}

describe("main worktree isolation", () => {
	const tempDirs: string[] = [];

	async function createTempDir(): Promise<string> {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-main-worktree-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		return tempDir;
	}

	async function createTempRepo(): Promise<{ repoRoot: string; workingCwd: string }> {
		return createGitRepo(await createTempDir());
	}

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects incompatible resume-style flags", () => {
		expect(() => validateMainWorktreeIsolationArgs({ continue: true })).toThrow("--continue");
		expect(() => validateMainWorktreeIsolationArgs({ resume: true })).toThrow("--resume/--session");
		expect(() => validateMainWorktreeIsolationArgs({ fork: "abc123" })).toThrow("--fork");
	});

	it("errors when the current directory is not inside a git repository", async () => {
		const tempDir = await createTempDir();
		await expect(prepareMainWorktreeIsolation(tempDir)).rejects.toThrow("--worktree requires a git repository");
	});

	it("creates a clean temporary worktree rooted at the current subdirectory", async () => {
		const { repoRoot, workingCwd } = await createTempRepo();
		await Bun.write(path.join(workingCwd, "tracked.txt"), "changed\n");
		await Bun.write(path.join(workingCwd, "scratch.txt"), "local only\n");

		const isolation = await prepareMainWorktreeIsolation(workingCwd);
		const expectedWorktreeBase = await fs.realpath(path.join(repoRoot, ".worktrees"));
		expect(await fs.realpath(isolation.worktreeRoot)).toStartWith(expectedWorktreeBase);
		expect(isolation.isolatedCwd).toBe(path.join(isolation.worktreeRoot, "subdir"));
		expect(await Bun.file(path.join(isolation.isolatedCwd, "tracked.txt")).text()).toBe("base\n");
		await expect(fs.access(path.join(isolation.isolatedCwd, "scratch.txt"))).rejects.toThrow();
		expect(await isolation.cleanupIfClean()).toBe(true);
		await expect(fs.access(isolation.worktreeRoot)).rejects.toThrow();
	});

	it("retains the temporary worktree when it contains changes", async () => {
		const { workingCwd } = await createTempRepo();
		const isolation = await prepareMainWorktreeIsolation(workingCwd);

		await Bun.write(path.join(isolation.isolatedCwd, "tracked.txt"), "updated from worktree\n");
		expect(await isolation.cleanupIfClean()).toBe(false);
		expect(await Bun.file(path.join(isolation.isolatedCwd, "tracked.txt")).text()).toBe("updated from worktree\n");
	});

	it("retains the temporary worktree when it contains committed changes", async () => {
		const { workingCwd } = await createTempRepo();
		const isolation = await prepareMainWorktreeIsolation(workingCwd);

		await Bun.write(path.join(isolation.isolatedCwd, "tracked.txt"), "committed from worktree\n");
		await $`git add tracked.txt`.cwd(isolation.isolatedCwd).quiet();
		await $`git commit -m "worktree update"`.cwd(isolation.isolatedCwd).quiet();
		expect(await isolation.cleanupIfClean()).toBe(false);
		expect(await Bun.file(path.join(isolation.isolatedCwd, "tracked.txt")).text()).toBe("committed from worktree\n");
	});
});
