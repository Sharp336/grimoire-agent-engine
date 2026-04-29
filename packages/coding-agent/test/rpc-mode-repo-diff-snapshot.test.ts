import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleRpcRepoDiffGetCommand, handleRpcRepoDiffSnapshotCommand } from "../src/modes/rpc/rpc-mode";
import type { RpcResponse } from "../src/modes/rpc/rpc-types";
import type { AgentSession } from "../src/session/agent-session";
import { ensureSessionStartRepoDiffSnapshots, getRepoDiffSnapshots } from "../src/session/repo-diff-snapshots";
import { SessionManager } from "../src/session/session-manager";

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
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-diff-snapshot-repo-"));
	tempDirs.push(repo);
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

function createRpcSession(sessionManager: SessionManager): AgentSession {
	return { sessionManager } as unknown as AgentSession;
}

function expectRepoDiffSnapshotSuccess(
	response: RpcResponse,
): asserts response is Extract<RpcResponse, { command: "repo_diff_snapshot"; success: true }> {
	expect(response).toMatchObject({
		type: "response",
		command: "repo_diff_snapshot",
		success: true,
	});
	if (!response.success || response.command !== "repo_diff_snapshot") {
		throw new Error(response.success ? `Unexpected command ${response.command}` : response.error);
	}
}

function expectRepoDiffGetFailure(
	response: RpcResponse,
): asserts response is Extract<RpcResponse, { success: false }> & { command: "repo_diff_get" } {
	expect(response).toMatchObject({
		type: "response",
		command: "repo_diff_get",
		success: false,
	});
	if (response.success || response.command !== "repo_diff_get") {
		throw new Error(response.success ? `Unexpected command ${response.command}` : response.error);
	}
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("RPC repo_diff_snapshot", () => {
	it("keeps label-only requests on the known-repositories snapshot path", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-diff-snapshot-session-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);
		await ensureSessionStartRepoDiffSnapshots(sessionManager, [firstRepo, secondRepo]);

		const response = await handleRpcRepoDiffSnapshotCommand(createRpcSession(sessionManager), {
			id: "rpc-snapshot-1",
			type: "repo_diff_snapshot",
			label: "manual-label",
		});

		expectRepoDiffSnapshotSuccess(response);
		const snapshots = getRepoDiffSnapshots(sessionManager);
		expect(snapshots.map(snapshot => snapshot.data.repoRoot)).toEqual([firstRepo, secondRepo, firstRepo, secondRepo]);
		expect(snapshots.slice(2).map(snapshot => snapshot.data.label)).toEqual(["manual-label", "manual-label"]);
		expect(response.data.selectedSnapshot?.entryId).toBe(snapshots[2].entryId);
	});

	it("scopes default repo_diff_get selection to the active repository", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-active-repo-diff-session-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);
		await ensureSessionStartRepoDiffSnapshots(sessionManager, [firstRepo, secondRepo]);
		await fs.writeFile(path.join(firstRepo, "tracked.txt"), "active repo change\n");
		await fs.writeFile(path.join(secondRepo, "tracked.txt"), "other repo change\n");

		const response = await handleRpcRepoDiffGetCommand(createRpcSession(sessionManager), {
			id: "rpc-diff-get-active-repo",
			type: "repo_diff_get",
		});

		expect(response).toMatchObject({
			id: "rpc-diff-get-active-repo",
			type: "response",
			command: "repo_diff_get",
			success: true,
		});
		if (!response.success || response.command !== "repo_diff_get") {
			throw new Error(response.success ? `Unexpected command ${response.command}` : response.error);
		}
		expect(response.data.selectedSnapshot?.repoRoot).toBe(firstRepo);
		expect(response.data.diff).toContain("+active repo change");
		expect(response.data.diff).not.toContain("+other repo change");
	});

	it("creates and selects only the targeted explicit repo/ref snapshot", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-explicit-diff-snapshot-session-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);
		await ensureSessionStartRepoDiffSnapshots(sessionManager, [firstRepo, secondRepo]);
		const historicalCommit = await runGit(secondRepo, ["rev-parse", "HEAD"]);
		await runGit(secondRepo, ["tag", "rpc-historical", historicalCommit]);
		await fs.writeFile(path.join(secondRepo, "tracked.txt"), "later second repo\n");
		await runGit(secondRepo, ["add", "tracked.txt"]);
		await runGit(secondRepo, ["commit", "-m", "later second"]);

		const response = await handleRpcRepoDiffSnapshotCommand(createRpcSession(sessionManager), {
			id: "rpc-snapshot-2",
			type: "repo_diff_snapshot",
			label: "targeted",
			repoRoot: secondRepo,
			ref: "rpc-historical",
		});

		expectRepoDiffSnapshotSuccess(response);
		const snapshots = getRepoDiffSnapshots(sessionManager);
		expect(snapshots).toHaveLength(3);
		const created = snapshots[2];
		expect(created.data.repoRoot).toBe(secondRepo);
		expect(created.data.sourceRef).toBe("rpc-historical");
		expect(created.data.ref).toStartWith("refs/omp/diff-snapshots/");
		expect(created.data.commit).toBe(historicalCommit);
		expect(created.data.headCommit).toBeNull();
		expect(response.data.selectedSnapshot?.entryId).toBe(created.entryId);
		expect(response.data.selectedSnapshot?.commit).toBe(historicalCommit);
		expect(response.data.selectedSnapshot?.ref).toBe(created.data.ref);
		expect(response.data.selectedSnapshot?.sourceRef).toBe("rpc-historical");
		expect(response.data.diff).toContain("+later second repo");
	});

	it("returns a repo_diff_get error when selected snapshots cross repositories", async () => {
		const firstRepo = await createGitRepo();
		const secondRepo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-cross-repo-diff-session-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(firstRepo, sessionDir);
		await ensureSessionStartRepoDiffSnapshots(sessionManager, [firstRepo, secondRepo]);
		const snapshots = getRepoDiffSnapshots(sessionManager);

		const response = await handleRpcRepoDiffGetCommand(createRpcSession(sessionManager), {
			id: "rpc-diff-get-cross-repo",
			type: "repo_diff_get",
			selector: snapshots[0].entryId,
			headSelector: snapshots[1].entryId,
		});

		expectRepoDiffGetFailure(response);
		expect(response.id).toBe("rpc-diff-get-cross-repo");
		expect(response.error).toContain("Snapshot comparison crosses repositories");
	});

	it("returns repo_diff_get errors for explicit selectors that do not match snapshots", async () => {
		const repo = await createGitRepo();
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-missing-selector-diff-session-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(repo, sessionDir);
		await ensureSessionStartRepoDiffSnapshots(sessionManager, [repo]);

		const missingBase = await handleRpcRepoDiffGetCommand(createRpcSession(sessionManager), {
			id: "rpc-diff-get-missing-base",
			type: "repo_diff_get",
			selector: "missing-base",
		});
		const missingHead = await handleRpcRepoDiffGetCommand(createRpcSession(sessionManager), {
			id: "rpc-diff-get-missing-head",
			type: "repo_diff_get",
			headSelector: "missing-head",
		});

		expectRepoDiffGetFailure(missingBase);
		expect(missingBase.id).toBe("rpc-diff-get-missing-base");
		expect(missingBase.error).toContain("No matching repository diff snapshot for selector: missing-base");
		expectRepoDiffGetFailure(missingHead);
		expect(missingHead.id).toBe("rpc-diff-get-missing-head");
		expect(missingHead.error).toContain("No matching repository diff snapshot for head selector: missing-head");
	});

	it("returns a repo_diff_snapshot error for invalid explicit targets", async () => {
		const repo = await createGitRepo();
		const invalidRepo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-invalid-repo-"));
		tempDirs.push(invalidRepo);
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-invalid-diff-snapshot-session-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(repo, sessionDir);

		const response = await handleRpcRepoDiffSnapshotCommand(createRpcSession(sessionManager), {
			id: "rpc-snapshot-3",
			type: "repo_diff_snapshot",
			repoRoot: invalidRepo,
			ref: "HEAD",
		});

		expect(response).toMatchObject({
			id: "rpc-snapshot-3",
			type: "response",
			command: "repo_diff_snapshot",
			success: false,
		});
		expect(response.success).toBe(false);
		if (response.success) throw new Error("Expected failure response");
		expect(response.error).toContain("Repository is not a Git repository");
	});
});
