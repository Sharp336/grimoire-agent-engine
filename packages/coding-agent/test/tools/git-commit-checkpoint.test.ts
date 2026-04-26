import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	GitCommitCheckpointTool,
	type GitCommitCheckpointToolDetails,
} from "@oh-my-pi/pi-coding-agent/tools/git-commit-checkpoint";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
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

async function createGitRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(repo);
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

function createSession(cwd: string, overrides?: Partial<ToolSession>): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "tools.gitCommitCheckpoint.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...overrides,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("GitCommitCheckpointTool", () => {
	it("registers only when the setting is enabled at top-level sessions", () => {
		const enabled = createSession("/tmp");
		const disabled: ToolSession = {
			...enabled,
			settings: Settings.isolated(),
		};
		const subagent: ToolSession = {
			...enabled,
			taskDepth: 1,
		};
		expect(GitCommitCheckpointTool.createIf(enabled)).not.toBeNull();
		expect(GitCommitCheckpointTool.createIf(disabled)).toBeNull();
		expect(GitCommitCheckpointTool.createIf(subagent)).toBeNull();
	});

	it("reports clean when there are no dirty repos", async () => {
		const repo = await createGitRepo("omp-cc-clean-");
		const tool = new GitCommitCheckpointTool(createSession(repo));
		const result = await tool.execute("call-1", { reason: "end of scope" });
		const details = result.details as GitCommitCheckpointToolDetails;
		expect(details.overallStatus).toBe("clean");
		expect(details.repos).toEqual([]);
	});

	it("fails when the repo is dirty but no model registry is available", async () => {
		const repo = await createGitRepo("omp-cc-no-model-");
		await fs.writeFile(path.join(repo, "tracked.txt"), "edited\n");
		const tool = new GitCommitCheckpointTool(createSession(repo));
		await expect(tool.execute("call-2", { reason: "end of scope" })).rejects.toThrow(/model registry/);
		// Repo must remain dirty — no fallback commit was made.
		expect(await runGit(repo, ["status", "--porcelain=v1"])).not.toBe("");
	});

	it("uses the generated commit message when a model is available", async () => {
		const repo = await createGitRepo("omp-cc-gen-");
		await fs.writeFile(path.join(repo, "tracked.txt"), "edited\n");
		const spy = vi.spyOn(commitMessageGenerator, "generateCommitMessage").mockResolvedValue("fix: tweak tracked");
		const session = createSession(repo);
		(session as { modelRegistry?: unknown }).modelRegistry = {} as unknown;
		const tool = new GitCommitCheckpointTool(session);
		const result = await tool.execute("call-3", { reason: "tweaks" });
		const details = result.details as GitCommitCheckpointToolDetails;
		expect(spy).toHaveBeenCalledTimes(1);
		expect(details.repos[0].message).toBe("fix: tweak tracked");
		expect(await runGit(repo, ["log", "-1", "--format=%s"])).toBe("fix: tweak tracked");
	});

	it("throws ToolError when every dirty repo's commit fails", async () => {
		const repo = await createGitRepo("omp-cc-fail-");
		await fs.writeFile(path.join(repo, "tracked.txt"), "edited\n");
		// Actually simpler: spy generateCommitMessage to throw to trigger the catch path.
		vi.spyOn(commitMessageGenerator, "generateCommitMessage").mockRejectedValue(new Error("boom"));
		const session = createSession(repo);
		(session as { modelRegistry?: unknown }).modelRegistry = {} as unknown;
		const tool = new GitCommitCheckpointTool(session);
		await expect(tool.execute("call-4", { reason: "failing scope" })).rejects.toThrow(/failed|boom/);
	});
});
