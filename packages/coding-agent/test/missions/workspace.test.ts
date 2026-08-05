import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	MissionFeatureSpec,
	MissionRepositoryState,
	MissionState,
	MissionWorkerHandoff,
} from "../../src/missions";
import { type MissionFeatureWorkspaceDescriptor, MissionWorkspaceManager } from "../../src/missions";

const GIT_ENV = {
	GIT_AUTHOR_NAME: "workspace-test",
	GIT_AUTHOR_EMAIL: "workspace-test@example.com",
	GIT_COMMITTER_NAME: "workspace-test",
	GIT_COMMITTER_EMAIL: "workspace-test@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

function gitRun(cwd: string, args: string[]): string {
	const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, env, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

async function makeRepository(): Promise<{ root: string; repository: MissionRepositoryState }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mission-workspace-"));
	gitRun(root, ["init", "-q", "-b", "main"]);
	await fs.writeFile(path.join(root, "README.md"), "workspace test\n");
	gitRun(root, ["add", "README.md"]);
	gitRun(root, ["commit", "-q", "-m", "initial"]);
	const head = gitRun(root, ["rev-parse", "HEAD"]);
	return {
		root,
		repository: {
			repoRoot: root,
			parentBranch: "main",
			baseSha: head,
			integrationBranch: "main",
			integrationHead: head,
		},
	};
}

function mission(repository: MissionRepositoryState): MissionState {
	return { id: `mission-${randomUUID()}`, repository } as MissionState;
}

const feature: MissionFeatureSpec = {
	id: "feature",
	description: "exercise the workspace manager",
	milestoneId: "milestone",
	preconditions: [],
	expectedBehavior: [],
};

function handoff(commits: string[]): MissionWorkerHandoff {
	return {
		kind: "implementation",
		outcome: "success",
		summary: "done",
		implementation: [],
		remaining: [],
		verification: { commands: [], interactiveChecks: [] },
		tests: { added: [], coverageNotes: [] },
		issues: [],
		skillDeviations: [],
		commits,
	};
}

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("MissionWorkspaceManager", () => {
	test("reserves a deterministic feature workspace without touching git", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();

		const descriptor = await manager.reserveFeature("owner", mission(repository), feature);

		expect(descriptor).toMatchObject({
			id: expect.stringContaining("feature:"),
			kind: "feature",
			ownerSessionId: "owner",
			phase: "reserved",
			branch: expect.stringContaining("/feature/feature"),
			baseSha: repository.integrationHead,
		});
		await expect(fs.stat(descriptor.path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(gitRun(root, ["branch", "--list", descriptor.branch])).toBe("");
	});

	test("materializes a reserved workspace and cleanly releases it", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const reserved = await manager.reserveFeature("owner", mission(repository), feature);

		const ready = (await manager.materialize(reserved)) as MissionFeatureWorkspaceDescriptor;
		expect(ready.phase).toBe("ready");
		expect(gitRun(ready.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(ready.branch);
		expect(await manager.releaseIfEmpty(ready)).toBe(true);
		await expect(fs.stat(ready.path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(gitRun(root, ["branch", "--list", ready.branch])).toBe("");
	});

	test("reconciles an unregistered on-disk workspace as a conflict", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const reserved = await manager.reserveFeature("owner", mission(repository), feature);
		await fs.mkdir(reserved.path, { recursive: true });

		const result = await manager.reconcile(reserved, false);

		expect(result).toMatchObject({
			kind: "pause",
			reason: "workspace_conflict",
			descriptorId: reserved.id,
			detail: "Workspace path exists on disk but is not a registered worktree",
		});
		await fs.rm(reserved.path, { recursive: true, force: true });
	});

	test("advances the integration ref only for the recorded feature handoff", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = (await manager.materialize(
			await manager.reserveFeature("owner", mission(repository), feature),
		)) as MissionFeatureWorkspaceDescriptor;
		await fs.writeFile(path.join(descriptor.path, "feature.txt"), "done\n");
		gitRun(descriptor.path, ["add", "feature.txt"]);
		gitRun(descriptor.path, ["commit", "-q", "-m", "feature"]);
		const featureHead = gitRun(descriptor.path, ["rev-parse", "HEAD"]);

		const result = await manager.advanceIntegration(repository, descriptor, handoff([featureHead]));

		expect(result).toMatchObject({ kind: "advanced", repository: { integrationHead: featureHead } });
		expect(gitRun(root, ["rev-parse", "main"])).toBe(featureHead);
		expect(await fs.readFile(path.join(root, "feature.txt"), "utf8")).toBe("done\n");
		expect(await manager.advanceIntegration(repository, descriptor, handoff([featureHead]))).toMatchObject({
			kind: "already_applied",
			repository: { integrationHead: featureHead },
		});
		await manager.release(descriptor);
	});

	test("refuses to advance a dirty checked-out integration worktree", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = (await manager.materialize(
			await manager.reserveFeature("owner", mission(repository), feature),
		)) as MissionFeatureWorkspaceDescriptor;
		await fs.writeFile(path.join(descriptor.path, "feature.txt"), "done\n");
		gitRun(descriptor.path, ["add", "feature.txt"]);
		gitRun(descriptor.path, ["commit", "-q", "-m", "feature"]);
		const featureHead = gitRun(descriptor.path, ["rev-parse", "HEAD"]);
		await fs.writeFile(path.join(root, "README.md"), "dirty\n");

		const result = await manager.advanceIntegration(repository, descriptor, handoff([featureHead]));

		expect(result).toMatchObject({
			kind: "partial_handoff",
			issues: [{ description: "Integration worktree is dirty; integration branch cannot be advanced" }],
		});
		expect(gitRun(root, ["rev-parse", "main"])).toBe(repository.integrationHead);
	});

	test("rejects a handoff whose commit list differs from the feature branch", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = (await manager.materialize(
			await manager.reserveFeature("owner", mission(repository), feature),
		)) as MissionFeatureWorkspaceDescriptor;
		await fs.writeFile(path.join(descriptor.path, "feature.txt"), "done\n");
		gitRun(descriptor.path, ["add", "feature.txt"]);
		gitRun(descriptor.path, ["commit", "-q", "-m", "feature"]);

		const result = await manager.advanceIntegration(repository, descriptor, handoff([]));

		expect(result).toMatchObject({
			kind: "partial_handoff",
			issues: [{ description: "Feature commit list does not match handoff.commits" }],
		});
	});

	test("reports an integration branch that moved since the feature was reserved", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = (await manager.materialize(
			await manager.reserveFeature("owner", mission(repository), feature),
		)) as MissionFeatureWorkspaceDescriptor;
		await fs.writeFile(path.join(descriptor.path, "feature.txt"), "done\n");
		gitRun(descriptor.path, ["add", "feature.txt"]);
		gitRun(descriptor.path, ["commit", "-q", "-m", "feature"]);
		const featureHead = gitRun(descriptor.path, ["rev-parse", "HEAD"]);
		await fs.writeFile(path.join(root, "other.txt"), "other\n");
		gitRun(root, ["add", "other.txt"]);
		gitRun(root, ["commit", "-q", "-m", "other"]);

		const result = await manager.advanceIntegration(repository, descriptor, handoff([featureHead]));

		expect(result).toMatchObject({ kind: "pause", reason: "integration_diverged" });
	});

	test("rejects a stale reserved feature branch instead of adopting it", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const reserved = await manager.reserveFeature("owner", mission(repository), feature);
		await fs.writeFile(path.join(root, "stale.txt"), "stale\n");
		gitRun(root, ["add", "stale.txt"]);
		gitRun(root, ["commit", "-q", "-m", "stale"]);
		gitRun(root, ["branch", reserved.branch]);

		await expect(manager.materialize(reserved)).rejects.toThrow(`Feature branch ${reserved.branch} already exists`);
	});

	test("recreates a registered feature worktree whose directory disappeared without a child transcript", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = (await manager.materialize(
			await manager.reserveFeature("owner", mission(repository), feature),
		)) as MissionFeatureWorkspaceDescriptor;
		await fs.rm(descriptor.path, { recursive: true, force: true });

		const result = await manager.reconcile(descriptor, false);

		expect(result).toMatchObject({ kind: "ready", descriptor: { id: descriptor.id, phase: "ready" } });
		expect(gitRun(descriptor.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(descriptor.branch);
	});

	test("recreates a registered validator worktree whose directory disappeared without a child transcript", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = await manager.materialize(
			await manager.reserveValidator("owner", mission(repository), feature.id),
		);
		await fs.rm(descriptor.path, { recursive: true, force: true });

		const result = await manager.reconcile(descriptor, false);

		expect(result).toMatchObject({ kind: "ready", descriptor: { id: descriptor.id, phase: "ready" } });
		expect(gitRun(descriptor.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
	});

	test("does not release a worktree registered to an unrelated branch", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = (await manager.materialize(
			await manager.reserveFeature("owner", mission(repository), feature),
		)) as MissionFeatureWorkspaceDescriptor;
		gitRun(root, ["worktree", "remove", descriptor.path]);
		gitRun(root, ["worktree", "add", "-b", "unowned-release", descriptor.path, "main"]);

		await expect(manager.release(descriptor)).rejects.toThrow("Refusing to remove unowned worktree");
		expect(gitRun(descriptor.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("unowned-release");
		gitRun(root, ["worktree", "remove", descriptor.path]);
		gitRun(root, ["branch", "-D", "unowned-release"]);
		gitRun(root, ["branch", "-D", descriptor.branch]);
	});

	test("rejects a worktree path registered to a branch it does not own", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = (await manager.materialize(
			await manager.reserveFeature("owner", mission(repository), feature),
		)) as MissionFeatureWorkspaceDescriptor;
		gitRun(root, ["worktree", "remove", descriptor.path]);
		gitRun(root, ["worktree", "add", "-b", "unowned-workspace", descriptor.path, "main"]);

		const result = await manager.reconcile(descriptor, false);

		expect(result).toMatchObject({
			kind: "pause",
			reason: "workspace_conflict",
			detail: "Worktree path is registered to an unowned or mismatched branch",
			branch: descriptor.branch,
		});
		gitRun(root, ["worktree", "remove", descriptor.path]);
		gitRun(root, ["branch", "-D", "unowned-workspace"]);
		gitRun(root, ["branch", "-D", descriptor.branch]);
	});

	test("preserves a feature branch that moved after the accepted handoff", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = (await manager.materialize(
			await manager.reserveFeature("owner", mission(repository), feature),
		)) as MissionFeatureWorkspaceDescriptor;
		await fs.writeFile(path.join(descriptor.path, "feature.txt"), "done\n");
		gitRun(descriptor.path, ["add", "feature.txt"]);
		gitRun(descriptor.path, ["commit", "-q", "-m", "feature"]);
		const acceptedHead = gitRun(descriptor.path, ["rev-parse", "HEAD"]);
		await expect(manager.advanceIntegration(repository, descriptor, handoff([acceptedHead]))).resolves.toMatchObject({
			kind: "advanced",
		});

		// A commit lands on the feature branch after integration-advance but before cleanup.
		await fs.writeFile(path.join(descriptor.path, "late.txt"), "late\n");
		gitRun(descriptor.path, ["add", "late.txt"]);
		gitRun(descriptor.path, ["commit", "-q", "-m", "late"]);
		const movedHead = gitRun(descriptor.path, ["rev-parse", "HEAD"]);
		expect(movedHead).not.toBe(acceptedHead);

		await manager.release(descriptor, { expectedHead: acceptedHead });

		expect(gitRun(root, ["rev-parse", descriptor.branch])).toBe(movedHead);
		await expect(fs.stat(descriptor.path)).rejects.toMatchObject({ code: "ENOENT" });
		gitRun(root, ["branch", "-D", descriptor.branch]);
	});

	test("deletes a feature branch still at the accepted handoff head", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = (await manager.materialize(
			await manager.reserveFeature("owner", mission(repository), feature),
		)) as MissionFeatureWorkspaceDescriptor;
		await fs.writeFile(path.join(descriptor.path, "feature.txt"), "done\n");
		gitRun(descriptor.path, ["add", "feature.txt"]);
		gitRun(descriptor.path, ["commit", "-q", "-m", "feature"]);
		const acceptedHead = gitRun(descriptor.path, ["rev-parse", "HEAD"]);
		await expect(manager.advanceIntegration(repository, descriptor, handoff([acceptedHead]))).resolves.toMatchObject({
			kind: "advanced",
		});

		await manager.release(descriptor, { expectedHead: acceptedHead });

		expect(gitRun(root, ["branch", "--list", descriptor.branch])).toBe("");
		await expect(fs.stat(descriptor.path)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
