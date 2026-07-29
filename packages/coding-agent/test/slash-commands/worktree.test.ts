import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleWorktreeAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/worktree";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { hashPath } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const ENV_KEY = "OMP_WORKTREE_DIR";

let tmpRoot: string;
let managedDir: string;
let repoDir: string;
let savedEnv: string | undefined;
let outputs: string[];

function runtime(cwd: string): SlashCommandRuntime {
	return {
		cwd,
		output: (text: string) => {
			outputs.push(text);
		},
	} as unknown as SlashCommandRuntime;
}

/** Invoke `/worktree <args>` against a stub runtime and capture its output. */
async function run(args: string, cwd: string = repoDir): Promise<string> {
	outputs = [];
	const command: ParsedSlashCommand = { name: "worktree", args, text: `/worktree ${args}` };
	await handleWorktreeAcp(command, runtime(cwd));
	return outputs.join("\n");
}

async function initRepo(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await $`git init -b main ${dir}`.quiet();
	await fs.writeFile(path.join(dir, "file.txt"), "hello\n");
	await $`git -C ${dir} add file.txt`.quiet();
	await $`git -C ${dir} -c user.email=t@t.t -c user.name=t commit -m init`.quiet();
}

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-cmd-"));
	managedDir = path.join(tmpRoot, "wt");
	repoDir = path.join(tmpRoot, "repo");
	await initRepo(repoDir);
	savedEnv = process.env[ENV_KEY];
	process.env[ENV_KEY] = managedDir;
});

afterEach(async () => {
	if (savedEnv === undefined) {
		delete process.env[ENV_KEY];
	} else {
		process.env[ENV_KEY] = savedEnv;
	}
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("/worktree command", () => {
	it("create makes a new-branch worktree under the managed dir", async () => {
		const out = await run("create feat/thing");
		const expected = path.join(managedDir, `feat-thing-${hashPath(repoDir)}`);
		expect(out).toContain(`Created worktree: ${expected}`);
		expect(out).toContain("Branch: feat/thing (new, from HEAD)");
		const branch = await $`git -C ${expected} branch --show-current`.text();
		expect(branch.trim()).toBe("feat/thing");
	});

	it("create checks out an existing branch as-is", async () => {
		await $`git -C ${repoDir} branch existing`.quiet();
		const out = await run("create existing");
		expect(out).toContain("Branch: existing (existing)");
	});

	it("create refuses a branch already checked out in a worktree", async () => {
		await run("create dup");
		const out = await run("create dup");
		expect(out).toContain("already checked out");
	});

	it("list defaults to the current repo; --all includes other repos", async () => {
		await run("create mine");
		const otherRepo = path.join(tmpRoot, "other");
		await initRepo(otherRepo);
		await run("create theirs", otherRepo);

		const scoped = await run("list");
		expect(scoped).toContain(`mine-${hashPath(repoDir)}`);
		expect(scoped).not.toContain("theirs");

		const all = await run("list --all");
		expect(all).toContain(`mine-${hashPath(repoDir)}`);
		expect(all).toContain(`theirs-${hashPath(otherRepo)}`);
	});

	it("remove deletes by branch; dirty trees need --force", async () => {
		await run("create doomed");
		const wtPath = path.join(managedDir, `doomed-${hashPath(repoDir)}`);
		await fs.writeFile(path.join(wtPath, "dirty.txt"), "x");

		const refused = await run("remove doomed");
		expect(refused).toContain("--force");
		const removed = await run("remove doomed --force");
		expect(removed).toContain(`Removed worktree: ${wtPath}`);
		const stat = await fs.stat(wtPath).catch(() => null);
		expect(stat).toBeNull();
	});

	it("remove refuses the worktree the session is running in", async () => {
		await run("create home");
		const wtPath = path.join(managedDir, `home-${hashPath(repoDir)}`);
		const out = await run(`remove ${wtPath} --force`, wtPath);
		expect(out).toContain("session is running in");
	});
});
