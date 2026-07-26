import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
	MissionWorkspaceManager,
	type MissionFeatureWorkspaceDescriptor,
} from "../../src/missions";
import type { MissionFeatureSpec, MissionRepositoryState, MissionState, MissionWorkerHandoff } from "../../src/missions";

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

		const ready = await manager.materialize(reserved) as MissionFeatureWorkspaceDescriptor;
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
		const descriptor = await manager.materialize(await manager.reserveFeature("owner", mission(repository), feature)) as MissionFeatureWorkspaceDescriptor;
		await fs.writeFile(path.join(descriptor.path, "feature.txt"), "done\n");
		gitRun(descriptor.path, ["add", "feature.txt"]);
		gitRun(descriptor.path, ["commit", "-q", "-m", "feature"]);
		const featureHead = gitRun(descriptor.path, ["rev-parse", "HEAD"]);

		const result = await manager.advanceIntegration(repository, descriptor, handoff([featureHead]));

		expect(result).toMatchObject({ kind: "advanced", repository: { integrationHead: featureHead } });
		expect(gitRun(root, ["rev-parse", "main"])).toBe(featureHead);
		await manager.release(descriptor);
	});

	test("rejects a worktree path registered to a branch it does not own", async () => {
		const { root, repository } = await makeRepository();
		roots.push(root);
		const manager = new MissionWorkspaceManager();
		const descriptor = await manager.materialize(await manager.reserveFeature("owner", mission(repository), feature)) as MissionFeatureWorkspaceDescriptor;
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
});
