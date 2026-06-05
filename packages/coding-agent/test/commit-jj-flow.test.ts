import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { runAgenticCommit } from "../src/commit/agentic";
import * as commitAgentModule from "../src/commit/agentic/agent";
import * as analysisModule from "../src/commit/analysis";
import { runCommitCommand } from "../src/commit/pipeline";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import * as sdkModule from "../src/sdk";
import * as git from "../src/utils/git";
import * as jj from "../src/utils/jj";

const CWD = "/repo";
const MODEL = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!MODEL) {
	throw new Error("Expected claude-sonnet-4-5 model to exist");
}

const JJ_REPOSITORY: jj.JjRepository = {
	repoRoot: CWD,
	storeDir: `${CWD}/.jj/repo/store`,
};
const JJ_PUSH_ERROR =
	"Repository mode 'jj' does not support push after jj commit. Supported alternative: single commit without --push.";
const JJ_CHANGELOG_ERROR =
	"Repository mode 'jj' does not support changelog updates in jj commit flow yet. Supported alternative: pass --no-changelog for jj commit flow, or use Git mode.";

function commitArgs(
	overrides: Partial<Parameters<typeof runCommitCommand>[0]> = {},
): Parameters<typeof runCommitCommand>[0] {
	return {
		push: false,
		dryRun: false,
		model: `${MODEL.provider}/${MODEL.id}`,
		noChangelog: true,
		...overrides,
	};
}

function installCommonSpies(): void {
	spyOn(piUtils, "getProjectDir").mockReturnValue(CWD);
	spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue({
		hasAuth: () => false,
		setFallbackResolver: () => {},
	} as never);
	spyOn(sdkModule, "discoverContextFiles").mockResolvedValue([]);
	spyOn(Settings, "init").mockResolvedValue(Settings.isolated({ "repository.mode": "jj" }));
	spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
	spyOn(ModelRegistry.prototype, "getAvailable").mockReturnValue([MODEL]);
	spyOn(ModelRegistry.prototype, "getApiKey").mockResolvedValue("test-key");
	spyOn(jj.repo, "resolve").mockResolvedValue(JJ_REPOSITORY);
	spyOn(git.repo, "resolve").mockResolvedValue(null);
	const spawn = ((command: string[]) => {
		if (command[0] !== "jj") {
			throw new Error(`Unexpected command in jj flow test: ${command.join(" ")}`);
		}
		return {
			stdout: new Response("diff --git a/src/a.ts b/src/a.ts\n").body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
		} as Subprocess;
	}) as typeof Bun.spawn;
	spyOn(Bun, "spawn").mockImplementation(spawn);
	spyOn(analysisModule, "generateConventionalAnalysis").mockResolvedValue({
		type: "chore",
		scope: null,
		details: [],
		issueRefs: [],
	});
	spyOn(analysisModule, "generateSummary").mockResolvedValue({ summary: "support jj commits" });
}

describe("jj commit flow", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PI_COMMIT_TEST_FALLBACK;
	});

	it("legacy jj single commit uses working-copy jj diff and jj commit without Git staging", async () => {
		installCommonSpies();
		const gitStageSpy = spyOn(git.stage, "files").mockResolvedValue(undefined);
		const gitCommitSpy = spyOn(git, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		const jjCommitSpy = spyOn(jj, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		spyOn(jj.diff, "changedFiles").mockResolvedValue(["src/a.ts"]);

		await runCommitCommand(commitArgs({ legacy: true, dryRun: true }));

		expect(gitStageSpy).not.toHaveBeenCalled();
		expect(gitCommitSpy).not.toHaveBeenCalled();
		expect(jj.diff.changedFiles).toHaveBeenCalledWith(CWD);
		expect(Bun.spawn).toHaveBeenCalledWith(
			["jj", "--no-pager", "--color=never", "diff", "--git"],
			expect.objectContaining({ cwd: CWD }),
		);
		expect(jjCommitSpy).not.toHaveBeenCalled();
	});

	it("agentic jj single commit uses jj commit and does not use Git staging", async () => {
		installCommonSpies();
		process.env.PI_COMMIT_TEST_FALLBACK = "true";
		const gitStageSpy = spyOn(git.stage, "files").mockResolvedValue(undefined);
		const gitCommitSpy = spyOn(git, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		const jjCommitSpy = spyOn(jj, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		spyOn(jj.diff, "changedFiles").mockResolvedValue(["src/a.ts"]);

		await runAgenticCommit(commitArgs());

		expect(gitStageSpy).not.toHaveBeenCalled();
		expect(gitCommitSpy).not.toHaveBeenCalled();
		expect(jjCommitSpy).toHaveBeenCalledWith(CWD, expect.stringContaining("chore: updated files"));
	});

	it("agentic jj split proposal fails before Git index mutation", async () => {
		installCommonSpies();
		const gitResetSpy = spyOn(git.stage, "reset").mockResolvedValue(undefined);
		const gitHunksSpy = spyOn(git.stage, "hunks").mockResolvedValue(undefined);
		const gitCommitSpy = spyOn(git, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		spyOn(jj.diff, "changedFiles").mockResolvedValue(["src/a.ts"]);
		spyOn(commitAgentModule, "runCommitAgentSession").mockResolvedValue({
			splitProposal: {
				warnings: [],
				commits: [
					{
						changes: [{ path: "src/a.ts", hunks: { type: "all" } }],
						type: "chore",
						scope: null,
						summary: "update a",
						details: [],
						issueRefs: [],
						dependencies: [],
					},
				],
			},
		});

		await expect(runAgenticCommit(commitArgs())).rejects.toThrow(
			"Repository mode 'jj' does not support split commit. Supported alternative: single commit.",
		);

		expect(gitResetSpy).not.toHaveBeenCalled();
		expect(gitHunksSpy).not.toHaveBeenCalled();
		expect(gitCommitSpy).not.toHaveBeenCalled();
	});

	it("legacy jj push fails before commit mutation", async () => {
		installCommonSpies();
		const gitCommitSpy = spyOn(git, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		const jjCommitSpy = spyOn(jj, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

		await expect(runCommitCommand(commitArgs({ legacy: true, push: true }))).rejects.toThrow(JJ_PUSH_ERROR);

		expect(gitCommitSpy).not.toHaveBeenCalled();
		expect(jjCommitSpy).not.toHaveBeenCalled();
	});

	it("agentic jj push fails before commit mutation", async () => {
		installCommonSpies();
		process.env.PI_COMMIT_TEST_FALLBACK = "true";
		const gitCommitSpy = spyOn(git, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		const jjCommitSpy = spyOn(jj, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

		await expect(runAgenticCommit(commitArgs({ push: true }))).rejects.toThrow(JJ_PUSH_ERROR);

		expect(gitCommitSpy).not.toHaveBeenCalled();
		expect(jjCommitSpy).not.toHaveBeenCalled();
	});

	it("legacy jj changelog flow fails before commit mutation", async () => {
		installCommonSpies();
		const gitCommitSpy = spyOn(git, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		const jjCommitSpy = spyOn(jj, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

		await expect(runCommitCommand(commitArgs({ legacy: true, noChangelog: false }))).rejects.toThrow(
			JJ_CHANGELOG_ERROR,
		);

		expect(gitCommitSpy).not.toHaveBeenCalled();
		expect(jjCommitSpy).not.toHaveBeenCalled();
	});

	it("agentic jj changelog flow fails before commit mutation", async () => {
		installCommonSpies();
		process.env.PI_COMMIT_TEST_FALLBACK = "true";
		const gitCommitSpy = spyOn(git, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		const jjCommitSpy = spyOn(jj, "commit").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

		await expect(runAgenticCommit(commitArgs({ noChangelog: false }))).rejects.toThrow(JJ_CHANGELOG_ERROR);

		expect(gitCommitSpy).not.toHaveBeenCalled();
		expect(jjCommitSpy).not.toHaveBeenCalled();
	});
});
