import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

const ZERO_SHA = "0".repeat(40);

function gitRun(cwd: string, args: string[]): string {
	const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_OBJECT_DIRECTORY;
	delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

describe("git ref compare-and-swap and fast-forward helpers", () => {
	let tmpRoot: string;
	let repository: string;
	let initialSha: string;
	let nextSha: string;

	beforeAll(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-helpers-test-"));
	});

	beforeEach(async () => {
		repository = await fs.mkdtemp(path.join(tmpRoot, "repository-"));
		gitRun(repository, ["init", "-q", "-b", "main"]);
		gitRun(repository, ["commit", "-q", "--allow-empty", "-m", "initial"]);
		initialSha = gitRun(repository, ["rev-parse", "HEAD"]);
		gitRun(repository, ["commit", "-q", "--allow-empty", "-m", "next"]);
		nextSha = gitRun(repository, ["rev-parse", "HEAD"]);
	});

	afterAll(async () => {
		await removeWithRetries(tmpRoot);
	});

	test("updates a ref when its expected value matches", async () => {
		const refName = "refs/heads/cas-success";

		expect(await git.ref.update(repository, refName, initialSha, ZERO_SHA)).toBe(true);
		expect(gitRun(repository, ["rev-parse", refName])).toBe(initialSha);
	});

	test("returns false when a ref moved after its expected value was read", async () => {
		const refName = "refs/heads/cas-moved";
		expect(await git.ref.update(repository, refName, initialSha, ZERO_SHA)).toBe(true);

		expect(await git.ref.update(repository, refName, nextSha, nextSha)).toBe(false);
		expect(gitRun(repository, ["rev-parse", refName])).toBe(initialSha);
	});

	test("returns false when an expected-absent ref was created", async () => {
		const refName = "refs/heads/cas-created";
		expect(await git.ref.update(repository, refName, initialSha, ZERO_SHA)).toBe(true);

		expect(await git.ref.update(repository, refName, nextSha, ZERO_SHA)).toBe(false);
		expect(gitRun(repository, ["rev-parse", refName])).toBe(initialSha);
	});

	test("returns false when an expected ref was deleted", async () => {
		expect(await git.ref.update(repository, "refs/heads/cas-deleted", nextSha, initialSha)).toBe(false);
	});

	test("throws for an invalid ref instead of treating it as a CAS loss", async () => {
		await expect(git.ref.update(repository, "refs/heads/not valid", initialSha, ZERO_SHA)).rejects.toThrow();
	});

	test("treats a dash-prefixed branch name as a merge target", async () => {
		gitRun(repository, ["reset", "-q", "--hard", initialSha]);
		gitRun(repository, ["update-ref", "refs/heads/--no-ff", nextSha]);

		await git.merge.fastForwardOnly(repository, "--no-ff");

		expect(gitRun(repository, ["rev-parse", "HEAD"])).toBe(nextSha);
	});
});
