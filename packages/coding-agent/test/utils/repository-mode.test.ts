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
