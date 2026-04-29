import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildRepoDiffMarkdown,
	CommandController,
	formatRepoDiffSnapshotListDetails,
} from "../../../src/modes/controllers/command-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";
import { ensureSessionStartRepoDiffSnapshots, getRepoDiffSnapshots } from "../../../src/session/repo-diff-snapshots";
import { SessionManager } from "../../../src/session/session-manager";

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

async function createGitRepo(prefix = "omp-tui-diff-snapshot-repo-"): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(repo);
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

function createHarness(repo: string) {
	const sessionDir = path.join(os.tmpdir(), `omp-tui-diff-snapshot-session-${Date.now()}-${Math.random()}`);
	tempDirs.push(sessionDir);
	const sessionManager = SessionManager.create(repo, sessionDir);
	const children: Array<{ render?: (width: number) => string[] }> = [];
	const ctx = {
		sessionManager,
		showError: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		chatContainer: {
			addChild: vi.fn((child: { render?: (width: number) => string[] }) => {
				children.push(child);
			}),
		},
		ui: {
			requestRender: vi.fn(),
			terminal: { columns: 120 },
		},
	} as unknown as InteractiveModeContext;
	return {
		children,
		ctx,
		controller: new CommandController(ctx),
		sessionManager,
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("CommandController /diff snapshot", () => {
	it("preserves old label syntax on the known-repositories snapshot path", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const harness = createHarness(firstRepo);
		await ensureSessionStartRepoDiffSnapshots(harness.sessionManager, [firstRepo, secondRepo]);

		await harness.controller.handleDiffCommand("snapshot label text");

		expect(harness.ctx.showError).not.toHaveBeenCalled();
		const snapshots = getRepoDiffSnapshots(harness.sessionManager);
		expect(snapshots.map(snapshot => snapshot.data.repoRoot)).toEqual([firstRepo, secondRepo, firstRepo, secondRepo]);
		expect(snapshots.slice(2).map(snapshot => snapshot.data.label)).toEqual(["label text", "label text"]);
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Repository diff snapshots created for 2 repositories.");
	});

	it("creates an explicit historical snapshot from --repo and --ref", async () => {
		const repo = await createGitRepo();
		const harness = createHarness(repo);
		const historicalCommit = await runGit(repo, ["rev-parse", "HEAD"]);
		await runGit(repo, ["tag", "tui-historical", historicalCommit]);
		await fs.writeFile(path.join(repo, "tracked.txt"), "later tui\n");
		await runGit(repo, ["add", "tracked.txt"]);
		await runGit(repo, ["commit", "-m", "later tui"]);

		await harness.controller.handleDiffCommand(`snapshot history label --repo ${repo} --ref tui-historical`);

		expect(harness.ctx.showError).not.toHaveBeenCalled();
		const snapshots = getRepoDiffSnapshots(harness.sessionManager);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].data.label).toBe("history label");
		expect(snapshots[0].data.sourceRef).toBe("tui-historical");
		expect(snapshots[0].data.ref).toStartWith("refs/omp/diff-snapshots/");
		expect(snapshots[0].data.commit).toBe(historicalCommit);
		expect(snapshots[0].data.headCommit).toBeNull();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith(
			`Repository diff snapshot created: history label at tui-historical (${snapshots[0].entryId})`,
		);
	});

	it("parses quoted repository paths through parseCommandArgs", async () => {
		const repo = await createGitRepo("omp tui quoted repo ");
		const harness = createHarness(repo);

		await harness.controller.handleDiffCommand(`snapshot quoted --repo "${repo}" --ref HEAD`);

		expect(harness.ctx.showError).not.toHaveBeenCalled();
		const snapshots = getRepoDiffSnapshots(harness.sessionManager);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].data.repoRoot).toBe(repo);
		expect(snapshots[0].data.label).toBe("quoted");
		expect(snapshots[0].data.sourceRef).toBe("HEAD");
		expect(snapshots[0].data.ref).toStartWith("refs/omp/diff-snapshots/");
	});

	it("warns with usage for missing explicit option values", async () => {
		const repo = await createGitRepo();
		const harness = createHarness(repo);

		await harness.controller.handleDiffCommand("snapshot label --repo");
		await harness.controller.handleDiffCommand("snapshot label --ref");

		expect(harness.ctx.showWarning).toHaveBeenCalledWith(
			expect.stringContaining("--repo requires a value.\nUsage: /diff snapshot"),
		);
		expect(harness.ctx.showWarning).toHaveBeenCalledWith(
			expect.stringContaining("--ref requires a value.\nUsage: /diff snapshot"),
		);
		expect(getRepoDiffSnapshots(harness.sessionManager)).toHaveLength(0);
	});

	it("lists historical snapshots with ref and short commit metadata", async () => {
		const repo = await createGitRepo();
		const harness = createHarness(repo);
		const historicalCommit = await runGit(repo, ["rev-parse", "HEAD"]);
		await runGit(repo, ["tag", "list-historical", historicalCommit]);
		await harness.controller.handleDiffCommand("snapshot listed --ref list-historical");

		await harness.controller.handleDiffCommand("list");

		expect(harness.ctx.chatContainer.addChild).toHaveBeenCalled();
		const snapshots = getRepoDiffSnapshots(harness.sessionManager);
		const details = formatRepoDiffSnapshotListDetails(snapshots[0]);
		expect(details).toContain("list-historical");
		expect(details).toContain(historicalCommit.slice(0, 12));
	});

	it("formats diff markdown with matching code fences", () => {
		const markdown = buildRepoDiffMarkdown(
			{ entryId: "snapshot-1", data: { label: "baseline", repoRoot: "/tmp/repo" } },
			"diff --git a/tracked.txt b/tracked.txt\n+changed\n``` literal content\n",
			"show",
		);

		expect(markdown).toContain("````diff\n");
		expect(markdown).toEndWith("````");
		expect(markdown.split("\n")).not.toContain("```");
		expect(markdown).toContain("``\\` literal content");
	});
});
