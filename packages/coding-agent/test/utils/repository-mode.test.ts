import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";

import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";
import * as git from "../../src/utils/git";
import * as jj from "../../src/utils/jj";
import {
	assertRepositoryModeCapability,
	type RepositoryMode,
	resolveRepositoryMode,
} from "../../src/utils/repository-mode";

const CWD = "/repo";
const JJ_REPOSITORY: jj.JjRepository = {
	repoRoot: CWD,
	storeDir: `${CWD}/.jj/repo/store`,
};
const GIT_REPOSITORY: git.GitRepository = {
	commonDir: `${CWD}/.git`,
	gitDir: `${CWD}/.git`,
	gitEntryPath: `${CWD}/.git`,
	headPath: `${CWD}/.git/HEAD`,
	repoRoot: CWD,
};

function expectCapabilities(
	mode: RepositoryMode,
	expected: {
		canReadWorkingCopyDiff: boolean;
		canReadRevDiff: boolean;
		canReadStatus: boolean;
		canSingleCommit: boolean;
		canSplitCommit: boolean;
		canUseGitInteropMutations: boolean;
		canUseNativeWorkspaceMutations: boolean;
	},
): void {
	expect(mode.capabilities).toEqual(expected);
}

describe("repository mode resolver", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		jj.repo.clearRootCache();
	});

	it("auto detects colocated JJ and Git as jj-git-interop", async () => {
		const jjResolve = spyOn(jj.repo, "resolve").mockResolvedValue(JJ_REPOSITORY);
		const gitResolve = spyOn(git.repo, "resolve").mockResolvedValue(GIT_REPOSITORY);

		const mode = await resolveRepositoryMode(CWD, "auto");

		expect(mode.kind).toBe("jj-git-interop");
		expect(mode.setting).toBe("auto");
		expect(mode.jjRepository).toBe(JJ_REPOSITORY);
		expect(mode.gitRepository).toBe(GIT_REPOSITORY);
		expect(jjResolve).toHaveBeenCalledWith(CWD);
		expect(gitResolve).toHaveBeenCalledWith(CWD);
		expectCapabilities(mode, {
			canReadWorkingCopyDiff: true,
			canReadRevDiff: true,
			canReadStatus: true,
			canSingleCommit: true,
			canSplitCommit: false,
			canUseGitInteropMutations: true,
			canUseNativeWorkspaceMutations: false,
		});
	});

	it("auto picks a nested Git repo over an outer JJ workspace when their roots differ (not interop)", async () => {
		// cwd is inside `/repo/vendor/lib/.git` while a parent `/repo/.jj` also resolves. The two
		// are NOT a colocated interop checkout, so Git (the nearer root) must win — routing commits
		// through the outer JJ workspace would be wrong.
		const outerJj: jj.JjRepository = { repoRoot: "/repo", storeDir: "/repo/.jj/repo/store" };
		const nestedGit: git.GitRepository = { ...GIT_REPOSITORY, repoRoot: "/repo/vendor/lib" };
		spyOn(jj.repo, "resolve").mockResolvedValue(outerJj);
		spyOn(git.repo, "resolve").mockResolvedValue(nestedGit);

		const mode = await resolveRepositoryMode("/repo/vendor/lib", "auto");

		expect(mode.kind).toBe("git");
		expect(mode.gitRepository).toBe(nestedGit);
		expect(mode.jjRepository).toBeNull();
	});

	it("auto picks a nested JJ workspace over an outer Git repo when their roots differ", async () => {
		const outerGit: git.GitRepository = { ...GIT_REPOSITORY, repoRoot: "/repo" };
		const nestedJj: jj.JjRepository = { repoRoot: "/repo/sub", storeDir: "/repo/sub/.jj/repo/store" };
		spyOn(jj.repo, "resolve").mockResolvedValue(nestedJj);
		spyOn(git.repo, "resolve").mockResolvedValue(outerGit);

		const mode = await resolveRepositoryMode("/repo/sub", "auto");

		expect(mode.kind).toBe("jj");
		expect(mode.jjRepository).toBe(nestedJj);
		expect(mode.gitRepository).toBeNull();
	});

	it("explicit jj keeps the outer JJ workspace even when a nested Git repo is nearer", async () => {
		const outerJj: jj.JjRepository = { repoRoot: "/repo", storeDir: "/repo/.jj/repo/store" };
		const nestedGit: git.GitRepository = { ...GIT_REPOSITORY, repoRoot: "/repo/vendor/lib" };
		spyOn(jj.repo, "resolve").mockResolvedValue(outerJj);
		spyOn(git.repo, "resolve").mockResolvedValue(nestedGit);

		const mode = await resolveRepositoryMode("/repo/vendor/lib", "jj");

		expect(mode.kind).toBe("jj");
		expect(mode.jjRepository).toBe(outerJj);
		expect(mode.gitRepository).toBeNull();
	});

	it("auto detects pure JJ when Git is absent", async () => {
		spyOn(jj.repo, "resolve").mockResolvedValue(JJ_REPOSITORY);
		spyOn(git.repo, "resolve").mockResolvedValue(null);

		const mode = await resolveRepositoryMode(CWD, "auto");

		expect(mode.kind).toBe("jj");
		expect(mode.gitRepository).toBeNull();
		expectCapabilities(mode, {
			canReadWorkingCopyDiff: true,
			canReadRevDiff: true,
			canReadStatus: true,
			canSingleCommit: true,
			canSplitCommit: false,
			canUseGitInteropMutations: false,
			canUseNativeWorkspaceMutations: false,
		});
	});

	it("auto falls back to Git when JJ is absent", async () => {
		spyOn(jj.repo, "resolve").mockResolvedValue(null);
		spyOn(git.repo, "resolve").mockResolvedValue(GIT_REPOSITORY);

		const mode = await resolveRepositoryMode(CWD, "auto");

		expect(mode.kind).toBe("git");
		expect(mode.jjRepository).toBeNull();
		expectCapabilities(mode, {
			canReadWorkingCopyDiff: true,
			canReadRevDiff: true,
			canReadStatus: true,
			canSingleCommit: true,
			canSplitCommit: true,
			canUseGitInteropMutations: true,
			canUseNativeWorkspaceMutations: false,
		});
	});

	it("forced git ignores JJ detection and requires Git", async () => {
		const jjResolve = spyOn(jj.repo, "resolve").mockResolvedValue(JJ_REPOSITORY);
		spyOn(git.repo, "resolve").mockResolvedValue(GIT_REPOSITORY);

		const mode = await resolveRepositoryMode(CWD, "git");

		expect(mode.kind).toBe("git");
		expect(mode.setting).toBe("git");
		expect(mode.jjRepository).toBeNull();
		expect(jjResolve).not.toHaveBeenCalled();
	});

	it("forced JJ reports interop when colocated Git exists", async () => {
		spyOn(jj.repo, "resolve").mockResolvedValue(JJ_REPOSITORY);
		spyOn(git.repo, "resolve").mockResolvedValue(GIT_REPOSITORY);

		const mode = await resolveRepositoryMode(CWD, "jj");

		expect(mode.kind).toBe("jj-git-interop");
		expect(mode.setting).toBe("jj");
	});

	it("throws when the forced repository mode is unavailable", async () => {
		spyOn(jj.repo, "resolve").mockResolvedValue(null);
		spyOn(git.repo, "resolve").mockResolvedValue(null);

		await expect(resolveRepositoryMode(CWD, "git")).rejects.toThrow(
			"Repository mode 'git' requires a Git repository",
		);
		await expect(resolveRepositoryMode(CWD, "jj")).rejects.toThrow("Repository mode 'jj' requires a JJ workspace");
	});

	it("describes unsupported operations with mode and supported alternative", async () => {
		const mode = await resolveRepositoryMode(CWD, "auto", {
			detectJj: async () => JJ_REPOSITORY,
			detectGit: async () => null,
		});

		expect(() => assertRepositoryModeCapability(mode, "canSplitCommit", "split commit", "single commit")).toThrow(
			"Repository mode 'jj' does not support split commit. Supported alternative: single commit.",
		);
	});
});

describe("repository mode settings schema", () => {
	it("defaults repository.mode to auto", () => {
		expect(SETTINGS_SCHEMA["repository.mode"]).toMatchObject({
			type: "enum",
			values: ["auto", "git", "jj"],
			default: "auto",
		});
	});
});
