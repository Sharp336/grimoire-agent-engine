import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Type } from "@sinclair/typebox";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import {
	createRepoDiffSnapshot,
	createRepoDiffSnapshotAt,
	createRepoDiffSnapshotsForKnownRepositories,
	diffRepoBetweenSnapshots,
	diffRepoFromSnapshot,
	ensureSessionStartRepoDiffSnapshot,
	ensureSessionStartRepoDiffSnapshots,
	getRepoDiffSnapshots,
	selectRepoDiffSnapshot,
	selectRepoDiffSnapshotForActiveRepo,
} from "../src/session/repo-diff-snapshots";
import { SessionManager } from "../src/session/session-manager";
import { wrapToolWithRepoDiffTracking } from "../src/tools/repo-diff-tracking";
import * as git from "../src/utils/git";

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

async function createGitRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-snapshot-"));
	tempDirs.push(repo);
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "base tracked\n");
	await fs.writeFile(path.join(repo, "staged.txt"), "base staged\n");
	await fs.writeFile(path.join(repo, "deleted.txt"), "base deleted\n");
	await fs.writeFile(path.join(repo, ".gitignore"), "ignored-tracked.txt\nignored-untracked.txt\n");
	await fs.writeFile(path.join(repo, "ignored-tracked.txt"), "base ignored tracked\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["add", "-f", "ignored-tracked.txt"]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

async function createAgentSessionForRepo(repo: string): Promise<{
	authStorage: AuthStorage;
	session: AgentSession;
	sessionManager: SessionManager;
}> {
	const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-session-diff-snapshot-"));
	tempDirs.push(sessionDir);
	const sessionManager = SessionManager.create(repo, sessionDir);
	const settings = Settings.isolated();
	const authStorage = await AuthStorage.create(path.join(sessionDir, "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(sessionDir, "models.yml"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
	const agent = new Agent({
		getApiKey: () => "test",
		initialState: {
			model,
			systemPrompt: ["test"],
			tools: [],
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
	});
	return { authStorage, session, sessionManager };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("git worktree snapshots", () => {
	it("captures full worktree state without modifying the user's index", async () => {
		const repo = await createGitRepo();
		await fs.writeFile(path.join(repo, "tracked.txt"), "snapshot tracked\n");
		await fs.writeFile(path.join(repo, "staged.txt"), "snapshot staged\n");
		await fs.writeFile(path.join(repo, "pre-untracked.txt"), "snapshot untracked\n");
		await fs.writeFile(path.join(repo, "ignored-tracked.txt"), "snapshot ignored tracked\n");
		await runGit(repo, ["add", "staged.txt"]);
		const statusBefore = await runGit(repo, ["status", "--porcelain=v1"]);

		const snapshot = await git.snapshot.create(repo, { label: "before-post-edits" });

		expect(snapshot).not.toBeNull();
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe(statusBefore);
		expect(await runGit(repo, ["cat-file", "-t", snapshot!.commit])).toBe("commit");
		expect(await runGit(repo, ["show-ref", "--verify", snapshot!.ref])).toContain(snapshot!.commit);

		await fs.writeFile(path.join(repo, "tracked.txt"), "post tracked\n");
		await fs.writeFile(path.join(repo, "pre-untracked.txt"), "post untracked\n");
		await fs.writeFile(path.join(repo, "post-untracked.txt"), "new after snapshot\n");
		await fs.writeFile(path.join(repo, "ignored-tracked.txt"), "post ignored tracked\n");
		await fs.rm(path.join(repo, "deleted.txt"));

		const diff = await git.snapshot.diff(repo, snapshot!.tree);

		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("-snapshot tracked");
		expect(diff).toContain("+post tracked");
		expect(diff).toContain("diff --git a/pre-untracked.txt b/pre-untracked.txt");
		expect(diff).toContain("-snapshot untracked");
		expect(diff).toContain("+post untracked");
		expect(diff).toContain("diff --git a/post-untracked.txt b/post-untracked.txt");
		expect(diff).toContain("+new after snapshot");
		expect(diff).toContain("diff --git a/deleted.txt b/deleted.txt");
		expect(diff).toContain("-base deleted");
		expect(diff).toContain("diff --git a/ignored-tracked.txt b/ignored-tracked.txt");
		expect(diff).toContain("-snapshot ignored tracked");
		expect(diff).toContain("+post ignored tracked");
	});
});

describe("session repository diff snapshots", () => {
	it("stores a labeled snapshot in session history and diffs from that stored point", async () => {
		const repo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-snapshot-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(repo, sessionDir);

		const snapshot = await createRepoDiffSnapshot(sessionManager, repo, { label: "before-change" });
		expect(snapshot).not.toBeNull();
		expect(snapshot!.data.kind).toBe("manual");
		expect(snapshot!.data.label).toBe("before-change");
		expect(getRepoDiffSnapshots(sessionManager, repo).map(record => record.entryId)).toEqual([snapshot!.entryId]);

		await fs.writeFile(path.join(repo, "tracked.txt"), "changed through session diff\n");
		const diff = await diffRepoFromSnapshot(snapshot!);

		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("+changed through session diff");
	});

	it("diffs one stored snapshot against another stored snapshot", async () => {
		const repo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-snapshot-compare-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(repo, sessionDir);

		await fs.writeFile(path.join(repo, "tracked.txt"), "first snapshot\n");
		const firstSnapshot = await createRepoDiffSnapshot(sessionManager, repo, { label: "first" });
		expect(firstSnapshot).not.toBeNull();

		await fs.writeFile(path.join(repo, "tracked.txt"), "second snapshot\n");
		const secondSnapshot = await createRepoDiffSnapshot(sessionManager, repo, { label: "second" });
		expect(secondSnapshot).not.toBeNull();
		const diff = await diffRepoBetweenSnapshots(firstSnapshot!, secondSnapshot!);

		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("-first snapshot");
		expect(diff).toContain("+second snapshot");
	});

	it("creates one session-start snapshot and diffs later worktree changes from it", async () => {
		const repo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-start-snapshot-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(repo, sessionDir);

		const snapshot = await ensureSessionStartRepoDiffSnapshot(sessionManager, repo);
		expect(snapshot).not.toBeNull();
		expect(snapshot!.data.kind).toBe("session-start");
		expect(snapshot!.data.label).toBe("session-start");

		const sameSnapshot = await ensureSessionStartRepoDiffSnapshot(sessionManager, repo);
		expect(sameSnapshot?.entryId).toBe(snapshot!.entryId);
		expect(getRepoDiffSnapshots(sessionManager, repo).map(record => record.entryId)).toEqual([snapshot!.entryId]);

		await fs.writeFile(path.join(repo, "tracked.txt"), "changed after session start\n");
		const diff = await diffRepoFromSnapshot(snapshot!);

		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("+changed after session start");
	});

	it("can force a fresh session-start snapshot and selects the latest session baseline", async () => {
		const repo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-forced-start-snapshot-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(repo, sessionDir);

		const firstSnapshot = await ensureSessionStartRepoDiffSnapshot(sessionManager, repo);
		expect(firstSnapshot).not.toBeNull();
		await fs.writeFile(path.join(repo, "tracked.txt"), "changed before forced start\n");

		const forcedSnapshot = await ensureSessionStartRepoDiffSnapshot(sessionManager, repo, { force: true });

		expect(forcedSnapshot).not.toBeNull();
		expect(forcedSnapshot!.entryId).not.toBe(firstSnapshot!.entryId);
		expect(selectRepoDiffSnapshot(getRepoDiffSnapshots(sessionManager, repo), "session")?.entryId).toBe(
			forcedSnapshot!.entryId,
		);
	});

	it("diffs snapshots from the repository that produced them", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-multi-repo-snapshot-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);

		const firstSnapshot = await ensureSessionStartRepoDiffSnapshot(sessionManager, firstRepo);
		const secondSnapshot = await ensureSessionStartRepoDiffSnapshot(sessionManager, secondRepo);
		expect(firstSnapshot).not.toBeNull();
		expect(secondSnapshot).not.toBeNull();
		expect(firstSnapshot!.data.repoRoot).toBe(firstRepo);
		expect(secondSnapshot!.data.repoRoot).toBe(secondRepo);

		await fs.writeFile(path.join(secondRepo, "tracked.txt"), "changed in second repo\n");
		const diff = await diffRepoFromSnapshot(secondSnapshot!);

		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("+changed in second repo");
	});

	it("scopes default snapshot selection to the active repository", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-active-repo-selection-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);

		const firstSnapshot = await ensureSessionStartRepoDiffSnapshot(sessionManager, firstRepo);
		const secondSnapshot = await ensureSessionStartRepoDiffSnapshot(sessionManager, secondRepo);
		expect(firstSnapshot).not.toBeNull();
		expect(secondSnapshot).not.toBeNull();
		const snapshots = getRepoDiffSnapshots(sessionManager);

		expect(selectRepoDiffSnapshotForActiveRepo(snapshots, undefined, firstRepo)?.entryId).toBe(
			firstSnapshot!.entryId,
		);
		expect(selectRepoDiffSnapshotForActiveRepo(snapshots, "session", firstRepo)?.entryId).toBe(
			firstSnapshot!.entryId,
		);
		expect(selectRepoDiffSnapshotForActiveRepo(snapshots, secondSnapshot!.entryId, firstRepo)?.entryId).toBe(
			secondSnapshot!.entryId,
		);
	});

	it("creates session-start snapshots through shared AgentSession transitions", async () => {
		const repo = await createGitRepo();
		const { authStorage, session, sessionManager } = await createAgentSessionForRepo(repo);
		try {
			const initialSessionFile = session.sessionFile;
			expect(initialSessionFile).toBeDefined();
			expect(getRepoDiffSnapshots(sessionManager, repo)).toHaveLength(0);

			await session.newSession();
			expect(getRepoDiffSnapshots(sessionManager, repo)).toHaveLength(1);

			await session.switchSession(initialSessionFile!);
			expect(getRepoDiffSnapshots(sessionManager, repo)).toHaveLength(1);

			sessionManager.appendMessage({
				role: "user",
				content: "branch from here",
				timestamp: Date.now(),
			});
			const branchCandidate = session.getUserMessagesForBranching()[0];
			expect(branchCandidate).toBeDefined();
			const branchResult = await session.branch(branchCandidate.entryId);

			expect(branchResult.cancelled).toBe(false);
			const snapshotsAfterBranch = getRepoDiffSnapshots(sessionManager, repo);
			expect(snapshotsAfterBranch).toHaveLength(2);
			expect(selectRepoDiffSnapshot(snapshotsAfterBranch, "session")?.entryId).toBe(snapshotsAfterBranch[1].entryId);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
	it("creates session-start snapshots for every referenced repository before tool changes", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-tool-repo-snapshots-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);

		const snapshots = await ensureSessionStartRepoDiffSnapshots(sessionManager, [
			path.join(firstRepo, "tracked.txt"),
			path.join(secondRepo, "nested", "new-file.txt"),
			path.join(secondRepo, "another-file.txt"),
		]);

		expect(snapshots.map(snapshot => snapshot.data.repoRoot)).toEqual([firstRepo, secondRepo]);
		expect(getRepoDiffSnapshots(sessionManager).map(snapshot => snapshot.data.repoRoot)).toEqual([
			firstRepo,
			secondRepo,
		]);

		await fs.writeFile(path.join(secondRepo, "tracked.txt"), "changed after second repo snapshot\n");
		const diff = await diffRepoFromSnapshot(snapshots[1]);

		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("+changed after second repo snapshot");
	});

	it("tracks repository roots from mutating tool paths before the tool executes", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-tool-wrapper-snapshots-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);
		const tool = wrapToolWithRepoDiffTracking({
			name: "write",
			label: "Write",
			description: "test write tool",
			parameters: Type.Object({ path: Type.String() }),
			async execute(_toolCallId: string, params: { path: string }) {
				await fs.writeFile(params.path, "changed by wrapped tool\n");
				return { content: [{ type: "text" as const, text: "done" }] };
			},
		} as AgentTool);

		await tool.execute("tool-call", { path: path.join(secondRepo, "tracked.txt") }, undefined, undefined, {
			sessionManager,
		} as never);

		const snapshot = getRepoDiffSnapshots(sessionManager, secondRepo).find(
			record => record.data.kind === "session-start",
		);
		expect(snapshot).toBeDefined();
		const diff = await diffRepoFromSnapshot(snapshot!);

		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("+changed by wrapped tool");
	});

	it("treats mutating tool path arguments with commas as literal paths", async () => {
		const firstRepo = await createGitRepo();
		const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-comma-repo-parent-"));
		tempDirs.push(parentDir);
		const commaRepo = path.join(parentDir, "repo,with,commas");
		await fs.mkdir(commaRepo);
		await runGit(commaRepo, ["init"]);
		await runGit(commaRepo, ["config", "user.email", "test@example.com"]);
		await runGit(commaRepo, ["config", "user.name", "Test User"]);
		await fs.writeFile(path.join(commaRepo, "tracked.txt"), "comma base\n");
		await runGit(commaRepo, ["add", "."]);
		await runGit(commaRepo, ["commit", "-m", "initial"]);
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-comma-path-snapshots-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);
		const tool = wrapToolWithRepoDiffTracking({
			name: "write",
			label: "Write",
			description: "test write tool",
			parameters: Type.Object({ path: Type.String() }),
			async execute(_toolCallId: string, params: { path: string }) {
				await fs.writeFile(params.path, "changed by comma path tool\n");
				return { content: [{ type: "text" as const, text: "done" }] };
			},
		} as AgentTool);

		await tool.execute("tool-call", { path: path.join(commaRepo, "tracked.txt") }, undefined, undefined, {
			sessionManager,
		} as never);

		const snapshot = getRepoDiffSnapshots(sessionManager, commaRepo).find(
			record => record.data.kind === "session-start",
		);
		expect(snapshot).toBeDefined();
		const diff = await diffRepoFromSnapshot(snapshot!);

		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("+changed by comma path tool");
	});

	it("tracks edit input paths before apply_patch and hashline mutations execute", async () => {
		const firstRepo = await createGitRepo();
		const applyPatchRepo = await createGitRepo();
		const hashlineRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-edit-input-snapshots-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);
		const tool = wrapToolWithRepoDiffTracking({
			name: "edit",
			label: "Edit",
			description: "test edit tool",
			parameters: Type.Object({
				input: Type.String(),
				path: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId: string, params: { path?: string }) {
				const targetPath = params.path ?? path.join(applyPatchRepo, "tracked.txt");
				await fs.writeFile(targetPath, `changed by edit input for ${path.basename(path.dirname(targetPath))}\n`);
				return { content: [{ type: "text" as const, text: "done" }] };
			},
		} as AgentTool);
		const applyPatchPath = path.join(applyPatchRepo, "tracked.txt");
		const hashlinePath = path.join(hashlineRepo, "tracked.txt");

		await tool.execute(
			"apply-patch-call",
			{
				input: [
					"*** Begin Patch",
					`*** Update File: ${applyPatchPath}`,
					"@@",
					"-base tracked",
					"+changed",
					"*** End Patch",
				].join("\n"),
			},
			undefined,
			undefined,
			{ sessionManager } as never,
		);
		await tool.execute(
			"hashline-call",
			{
				input: `@${hashlinePath}\n= 1aa\n~changed`,
				path: hashlinePath,
			},
			undefined,
			undefined,
			{ sessionManager } as never,
		);

		for (const repo of [applyPatchRepo, hashlineRepo]) {
			const snapshot = getRepoDiffSnapshots(sessionManager, repo).find(
				record => record.data.kind === "session-start",
			);
			expect(snapshot).toBeDefined();
			const diff = await diffRepoFromSnapshot(snapshot!);
			expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
			expect(diff).toContain("+changed by edit input");
		}
	});

	it("tracks repository roots from ast_edit paths before the tool executes", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-ast-edit-snapshots-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);
		const tool = wrapToolWithRepoDiffTracking({
			name: "ast_edit",
			label: "AST Edit",
			description: "test ast edit tool",
			parameters: Type.Object({ paths: Type.Array(Type.String()) }),
			async execute() {
				await fs.writeFile(path.join(secondRepo, "tracked.txt"), "changed by ast edit\n");
				return { content: [{ type: "text" as const, text: "done" }] };
			},
		} as AgentTool);

		await tool.execute("tool-call", { paths: [path.join(secondRepo, "tracked.txt")] }, undefined, undefined, {
			sessionManager,
		} as never);

		const snapshot = getRepoDiffSnapshots(sessionManager, secondRepo).find(
			record => record.data.kind === "session-start",
		);
		expect(snapshot).toBeDefined();
		const diff = await diffRepoFromSnapshot(snapshot!);

		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("+changed by ast edit");
	});

	it("creates manual snapshots for all repositories already known to the session", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-known-repo-snapshots-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);

		await ensureSessionStartRepoDiffSnapshots(sessionManager, [firstRepo, secondRepo]);
		await fs.writeFile(path.join(firstRepo, "tracked.txt"), "changed in first repo\n");
		await fs.writeFile(path.join(secondRepo, "tracked.txt"), "changed in second repo\n");

		const snapshots = await createRepoDiffSnapshotsForKnownRepositories(sessionManager, [firstRepo], {
			label: "manual",
		});

		expect(snapshots.map(snapshot => snapshot.data.repoRoot)).toEqual([firstRepo, secondRepo]);
		expect(snapshots.map(snapshot => snapshot.data.label)).toEqual(["manual", "manual"]);
		expect(getRepoDiffSnapshots(sessionManager).map(snapshot => snapshot.data.repoRoot)).toEqual([
			firstRepo,
			secondRepo,
			firstRepo,
			secondRepo,
		]);
	});

	it("creates a targeted current-worktree snapshot without modifying the user index", async () => {
		const repo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-targeted-worktree-snapshot-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(repo, sessionDir);

		await fs.writeFile(path.join(repo, "tracked.txt"), "targeted tracked\n");
		await fs.writeFile(path.join(repo, "staged.txt"), "targeted staged\n");
		await fs.writeFile(path.join(repo, "targeted-untracked.txt"), "targeted untracked\n");
		await runGit(repo, ["add", "staged.txt"]);
		const statusBefore = await runGit(repo, ["status", "--porcelain=v1"]);

		const snapshot = await createRepoDiffSnapshotAt(sessionManager, repo, undefined, { label: "targeted-worktree" });

		expect(snapshot).not.toBeNull();
		expect(snapshot!.data.label).toBe("targeted-worktree");
		expect(snapshot!.data.kind).toBe("manual");
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe(statusBefore);
		expect(await runGit(repo, ["cat-file", "-t", snapshot!.data.commit])).toBe("commit");
		expect(await runGit(repo, ["show-ref", "--verify", snapshot!.data.ref])).toContain(snapshot!.data.commit);

		await fs.writeFile(path.join(repo, "tracked.txt"), "after targeted snapshot\n");
		const diff = await diffRepoFromSnapshot(snapshot!);

		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("-targeted tracked");
		expect(diff).toContain("+after targeted snapshot");
	});

	it("creates a read-only targeted snapshot from an explicit historical ref", async () => {
		const repo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-targeted-ref-snapshot-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(repo, sessionDir);
		const historicalCommit = await runGit(repo, ["rev-parse", "HEAD"]);
		const historicalTree = await runGit(repo, ["rev-parse", "HEAD^{tree}"]);
		await runGit(repo, ["tag", "historical-baseline", historicalCommit]);

		await fs.writeFile(path.join(repo, "tracked.txt"), "later tracked\n");
		await runGit(repo, ["add", "tracked.txt"]);
		await runGit(repo, ["commit", "-m", "later"]);
		const headBefore = await runGit(repo, ["rev-parse", "HEAD"]);
		const branchBefore = await runGit(repo, ["branch", "--show-current"]);
		const statusBefore = await runGit(repo, ["status", "--porcelain=v1"]);

		const snapshot = await createRepoDiffSnapshotAt(sessionManager, repo, "historical-baseline", {
			label: "historical",
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.data.label).toBe("historical");
		expect(snapshot!.data.repoRoot).toBe(repo);
		expect(snapshot!.data.sourceRef).toBe("historical-baseline");
		expect(snapshot!.data.ref).toStartWith("refs/omp/diff-snapshots/");
		expect(snapshot!.data.commit).toBe(historicalCommit);
		expect(snapshot!.data.tree).toBe(historicalTree);
		expect(snapshot!.data.headCommit).toBeNull();
		expect(await runGit(repo, ["show-ref", "--verify", snapshot!.data.ref])).toContain(historicalCommit);
		expect(snapshot!.data.kind).toBe("manual");
		expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
		expect(await runGit(repo, ["branch", "--show-current"])).toBe(branchBefore);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe(statusBefore);

		const diff = await diffRepoFromSnapshot(snapshot!);
		expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(diff).toContain("+later tracked");
	});

	it("resolves targeted snapshot repositories relative to the session cwd", async () => {
		const sessionRepo = await createGitRepo();
		const targetRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-relative-target-snapshot-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(sessionRepo, sessionDir);
		const relativeTarget = path.relative(sessionRepo, targetRepo);

		const snapshot = await createRepoDiffSnapshotAt(sessionManager, relativeTarget, "HEAD", {
			label: "relative-target",
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.data.repoRoot).toBe(targetRepo);
		expect(snapshot!.data.sourceRef).toBe("HEAD");
		expect(snapshot!.data.ref).toStartWith("refs/omp/diff-snapshots/");
	});

	it("expands home-relative targeted snapshot repository paths", async () => {
		const homeRepo = await fs.mkdtemp(path.join(os.homedir(), ".omp-session-home-target-snapshot-"));
		tempDirs.push(homeRepo);
		await runGit(homeRepo, ["init"]);
		await runGit(homeRepo, ["config", "user.email", "test@example.com"]);
		await runGit(homeRepo, ["config", "user.name", "Test User"]);
		await fs.writeFile(path.join(homeRepo, "tracked.txt"), "home base\n");
		await runGit(homeRepo, ["add", "."]);
		await runGit(homeRepo, ["commit", "-m", "initial"]);
		const sessionRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-home-target-session-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(sessionRepo, sessionDir);
		const homeRelativeTarget = `~/${path.relative(os.homedir(), homeRepo)}`;

		const snapshot = await createRepoDiffSnapshotAt(sessionManager, homeRelativeTarget, "HEAD", {
			label: "home-target",
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.data.repoRoot).toBe(homeRepo);
		expect(snapshot!.data.sourceRef).toBe("HEAD");
	});

	it("rejects invalid targeted snapshot repositories and refs truthfully", async () => {
		const repo = await createGitRepo();
		const invalidRepo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-invalid-target-repo-"));
		tempDirs.push(invalidRepo);
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-invalid-target-snapshot-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(repo, sessionDir);

		await expect(createRepoDiffSnapshotAt(sessionManager, invalidRepo, "HEAD")).rejects.toThrow(
			"Repository is not a Git repository",
		);
		await expect(createRepoDiffSnapshotAt(sessionManager, repo, "missing-ref")).rejects.toThrow(
			"Git ref does not resolve in repository",
		);
	});

	it("rejects explicit refs that do not resolve to commit snapshots", async () => {
		const repo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-unusable-ref-snapshot-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(repo, sessionDir);
		const blob = await runGit(repo, ["hash-object", "-w", "tracked.txt"]);
		await runGit(repo, ["update-ref", "refs/tags/blob-target", blob]);

		await expect(createRepoDiffSnapshotAt(sessionManager, repo, "blob-target")).rejects.toThrow(
			"Git ref is not usable as a commit snapshot",
		);
	});
});
