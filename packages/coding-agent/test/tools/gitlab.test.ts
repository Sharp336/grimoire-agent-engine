import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GitlabTool } from "@oh-my-pi/pi-coding-agent/tools/gitlab";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

function createSession(cwd: string = "/tmp/test"): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "gitlab.enabled": true }),
	};
}

describe("gitlab tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("formats repository metadata and calls glab repo view with JSON output", async () => {
		const jsonSpy = vi.spyOn(git.gitlab, "json").mockResolvedValue({
			path_with_namespace: "group/project",
			description: "Project description",
			web_url: "https://gitlab.com/group/project",
			default_branch: "main",
			visibility: "public",
			star_count: 42,
			forks_count: 7,
			open_issues_count: 3,
			last_activity_at: "2026-06-01T12:00:00Z",
		});

		const tool = new GitlabTool(createSession());
		const result = await tool.execute("repo-view", { op: "repo_view", repo: "group/project", branch: "main" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(jsonSpy).toHaveBeenCalledWith(
			"/tmp/test",
			["repo", "view", "group/project", "--branch", "main", "--output", "json"],
			undefined,
			{ repoProvided: true },
		);
		expect(text).toContain("# group/project");
		expect(text).toContain("Project description");
		expect(text).toContain("Default branch: main");
		expect(text).toContain("Stars: 42");
	});

	it("lists issues with repo, search, state, labels, and limit flags", async () => {
		const jsonSpy = vi.spyOn(git.gitlab, "json").mockResolvedValue([
			{
				iid: 12,
				title: "Fix bug",
				state: "closed",
				author: { username: "dev1" },
				labels: ["bug", "backend"],
				web_url: "https://gitlab.com/group/project/-/issues/12",
			},
		]);

		const tool = new GitlabTool(createSession());
		const result = await tool.execute("issue-list", {
			op: "issue_list",
			repo: "group/project",
			query: "bug",
			state: "closed",
			label: ["bug"],
			assignee: ["alice"],
			limit: 2,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(jsonSpy).toHaveBeenCalledWith(
			"/tmp/test",
			[
				"issue",
				"list",
				"--output",
				"json",
				"--repo",
				"group/project",
				"--closed",
				"--search",
				"bug",
				"--assignee",
				"alice",
				"--label",
				"bug",
				"--per-page",
				"2",
			],
			undefined,
			{ repoProvided: true },
		);
		expect(text).toContain("# GitLab issues");
		expect(text).toContain("Query: bug");
		expect(text).toContain("- #12 Fix bug");
		expect(text).toContain("  Labels: bug, backend");
	});

	it("creates merge requests non-interactively and re-reads the created MR", async () => {
		const textCalls: string[][] = [];
		vi.spyOn(git.gitlab, "text").mockImplementation(async (_cwd, args) => {
			textCalls.push([...args]);
			return "https://gitlab.com/group/project/-/merge_requests/7";
		});
		const jsonCalls: string[][] = [];
		vi.spyOn(git.gitlab, "json").mockImplementation(async <T>(_cwd: string, args: string[]): Promise<T> => {
			jsonCalls.push([...args]);
			return {
				iid: 7,
				title: "Add widget",
				state: "opened",
				draft: true,
				source_branch: "feature/widget",
				target_branch: "main",
				author: { username: "dev1" },
				labels: ["feature"],
				description: "Adds a widget.",
				web_url: "https://gitlab.com/group/project/-/merge_requests/7",
			} as T;
		});

		const tool = new GitlabTool(createSession());
		const result = await tool.execute("mr-create", {
			op: "mr_create",
			repo: "group/project",
			title: "Add widget",
			body: "Adds a widget.",
			base: "main",
			head: "feature/widget",
			draft: true,
			reviewer: ["reviewer1"],
			label: ["feature"],
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		const createArgs = textCalls[0];
		expect(createArgs.slice(0, 3)).toEqual(["mr", "create", "--yes"]);
		expect(createArgs).toEqual(expect.arrayContaining(["--repo", "group/project"]));
		expect(createArgs).toEqual(expect.arrayContaining(["--title", "Add widget"]));
		expect(createArgs).toEqual(expect.arrayContaining(["--description", "Adds a widget."]));
		expect(createArgs).toEqual(expect.arrayContaining(["--target-branch", "main"]));
		expect(createArgs).toEqual(expect.arrayContaining(["--source-branch", "feature/widget"]));
		expect(createArgs).toEqual(expect.arrayContaining(["--reviewer", "reviewer1"]));
		expect(createArgs).toEqual(expect.arrayContaining(["--label", "feature"]));
		expect(createArgs).toContain("--draft");
		expect(jsonCalls[0]).toEqual(["mr", "view", "7", "--output", "json", "--repo", "group/project"]);
		expect(text).toContain("# Created GitLab merge request !7: Add widget");
		expect(text).toContain("Source: feature/widget");
		expect(text).toContain("Target: main");
		expect(text).toContain("Adds a widget.");
	});

	it("rejects mr_create when neither title nor fill is supplied", async () => {
		const textSpy = vi.spyOn(git.gitlab, "text");
		const tool = new GitlabTool(createSession());

		await expect(tool.execute("mr-create", { op: "mr_create", repo: "group/project" })).rejects.toThrow(
			"title is required unless fill is true",
		);
		expect(textSpy).not.toHaveBeenCalled();
	});

	it("rejects unsupported merged state for issue_list", async () => {
		const jsonSpy = vi.spyOn(git.gitlab, "json");
		const tool = new GitlabTool(createSession());

		await expect(tool.execute("issue-list", { op: "issue_list", state: "merged" })).rejects.toThrow(
			"issue_list does not support state 'merged'",
		);
		expect(jsonSpy).not.toHaveBeenCalled();
	});

	it("rejects multiple assignees for issue_list", async () => {
		const jsonSpy = vi.spyOn(git.gitlab, "json");
		const tool = new GitlabTool(createSession());

		await expect(tool.execute("issue-list", { op: "issue_list", assignee: ["alice", "bob"] })).rejects.toThrow(
			"issue_list assignee accepts only one value",
		);
		expect(jsonSpy).not.toHaveBeenCalled();
	});

	it("lists merged merge requests with reviewers and branch filters", async () => {
		const jsonSpy = vi.spyOn(git.gitlab, "json").mockResolvedValue([
			{
				iid: 31,
				title: "Ship feature",
				state: "merged",
				source_branch: "feature",
				target_branch: "main",
				reviewers: [{ username: "reviewer1" }],
				web_url: "https://gitlab.com/group/project/-/merge_requests/31",
			},
		]);

		const tool = new GitlabTool(createSession());
		const result = await tool.execute("mr-list", {
			op: "mr_list",
			repo: "group/project",
			state: "merged",
			reviewer: ["reviewer1"],
			sourceBranch: "feature",
			targetBranch: "main",
			limit: 5,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(jsonSpy).toHaveBeenCalledWith(
			"/tmp/test",
			[
				"mr",
				"list",
				"--output",
				"json",
				"--repo",
				"group/project",
				"--merged",
				"--reviewer",
				"reviewer1",
				"--source-branch",
				"feature",
				"--target-branch",
				"main",
				"--per-page",
				"5",
			],
			undefined,
			{ repoProvided: true },
		);
		expect(text).toContain("# GitLab merge requests");
		expect(text).toContain("- !31 Ship feature");
		expect(text).toContain("  Reviewers: reviewer1");
	});

	it("checks out merge requests with force and rejects flag-shaped MR ids", async () => {
		const textSpy = vi.spyOn(git.gitlab, "text").mockResolvedValue("Checked out branch feature");
		const tool = new GitlabTool(createSession());

		const result = await tool.execute("mr-checkout", {
			op: "mr_checkout",
			repo: "group/project",
			mr: "12",
			branch: "feature",
			force: true,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(textSpy).toHaveBeenCalledWith(
			"/tmp/test",
			["mr", "checkout", "12", "--branch", "feature", "--force", "--repo", "group/project"],
			undefined,
			{ repoProvided: true },
		);
		expect(text).toContain("# GitLab merge request checkout");
		await expect(tool.execute("mr-checkout", { op: "mr_checkout", mr: "--force" })).rejects.toThrow(
			"mr must not start with '-'",
		);
		expect(textSpy).toHaveBeenCalledTimes(1);
	});

	it("reads pipeline status and lists pipelines", async () => {
		const jsonCalls: string[][] = [];
		vi.spyOn(git.gitlab, "json").mockImplementation(async <T>(_cwd: string, args: string[]): Promise<T> => {
			jsonCalls.push([...args]);
			if (args[1] === "status") {
				return { status: "success", ref: "main", sha: "abcdef1234567890" } as T;
			}
			return [{ id: 1001, status: "failed", ref: "main", sha: "1234567890abcdef" }] as T;
		});

		const tool = new GitlabTool(createSession());
		const status = await tool.execute("pipeline-status", {
			op: "pipeline_status",
			repo: "group/project",
			branch: "main",
		});
		const list = await tool.execute("pipeline-list", {
			op: "pipeline_list",
			repo: "group/project",
			branch: "main",
			status: "failed",
			sha: "1234567890abcdef",
			limit: 3,
		});
		const statusText = status.content[0]?.type === "text" ? status.content[0].text : "";
		const listText = list.content[0]?.type === "text" ? list.content[0].text : "";

		expect(jsonCalls[0]).toEqual(["ci", "status", "--output", "json", "--branch", "main", "--repo", "group/project"]);
		expect(jsonCalls[1]).toEqual([
			"ci",
			"list",
			"--output",
			"json",
			"--repo",
			"group/project",
			"--ref",
			"main",
			"--status",
			"failed",
			"--sha",
			"1234567890abcdef",
			"--per-page",
			"3",
		]);
		expect(statusText).toContain("Status: success");
		expect(listText).toContain("# GitLab pipelines");
		expect(listText).toContain("- #1001 failed");
	});

	it("classifies read-only and mutating operations for approval", () => {
		const tool = new GitlabTool(createSession());

		expect(tool.approval({ op: "repo_view" })).toBe("read");
		expect(tool.approval({ op: "pipeline_list" })).toBe("read");
		expect(tool.approval({ op: "mr_create" })).toBe("exec");
		expect(tool.approval({ op: "mr_checkout" })).toBe("exec");
	});
});
