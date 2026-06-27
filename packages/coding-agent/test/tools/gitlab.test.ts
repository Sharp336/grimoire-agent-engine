import { afterEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
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

	it("creates merge requests with fill without title or description flags", async () => {
		const textCalls: string[][] = [];
		vi.spyOn(git.gitlab, "text").mockImplementation(async (_cwd, args) => {
			textCalls.push([...args]);
			return "https://gitlab.com/group/project/-/merge_requests/8";
		});
		vi.spyOn(git.gitlab, "json").mockResolvedValue({
			iid: 8,
			title: "Commit derived title",
			description: "Commit derived body",
			web_url: "https://gitlab.com/group/project/-/merge_requests/8",
		});

		const tool = new GitlabTool(createSession());
		const result = await tool.execute("mr-create", { op: "mr_create", repo: "group/project", fill: true });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		const createArgs = textCalls[0];
		expect(createArgs.slice(0, 3)).toEqual(["mr", "create", "--yes"]);
		expect(createArgs).toEqual(expect.arrayContaining(["--repo", "group/project", "--fill"]));
		expect(createArgs).not.toContain("--title");
		expect(createArgs).not.toContain("--description");
		expect(text).toContain("# Created GitLab merge request !8: Commit derived title");
		expect(text).toContain("Commit derived body");
	});

	it("rejects mr_create when neither title nor fill is supplied", async () => {
		const textSpy = vi.spyOn(git.gitlab, "text");
		const tool = new GitlabTool(createSession());

		await expect(tool.execute("mr-create", { op: "mr_create", repo: "group/project" })).rejects.toThrow(
			"title is required unless fill is true",
		);
		expect(textSpy).not.toHaveBeenCalled();
	});

	it("rejects mr_create fill when title or body is supplied", async () => {
		const textSpy = vi.spyOn(git.gitlab, "text");
		const tool = new GitlabTool(createSession());

		await expect(
			tool.execute("mr-create", { op: "mr_create", repo: "group/project", fill: true, title: "Explicit" }),
		).rejects.toThrow("fill is mutually exclusive with title and body");
		await expect(
			tool.execute("mr-create", { op: "mr_create", repo: "group/project", fill: true, body: "Explicit" }),
		).rejects.toThrow("fill is mutually exclusive with title and body");
		await expect(
			tool.execute("mr-create", { op: "mr_create", repo: "group/project", fill: true, body: "" }),
		).rejects.toThrow("fill is mutually exclusive with title and body");
		expect(textSpy).not.toHaveBeenCalled();
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

	it("exposes only supported public ops and classifies approval", () => {
		const tool = new GitlabTool(createSession());
		const properties = toolWireSchema(tool).properties;
		const opProperty = properties && typeof properties === "object" && "op" in properties ? properties.op : undefined;
		const opEnumValue =
			opProperty && typeof opProperty === "object" && "enum" in opProperty ? opProperty.enum : undefined;
		expect(Array.isArray(opEnumValue)).toBe(true);
		const opEnum = Array.isArray(opEnumValue)
			? opEnumValue.filter((value): value is string => typeof value === "string").sort()
			: [];

		expect(opEnum).toEqual(["mr_checkout", "mr_create", "pipeline_list", "pipeline_status", "repo_view"]);
		expect(tool.description).toContain("issue://");
		expect(tool.description).toContain("pr://");
		expect(tool.description).not.toContain("issue_view");
		expect(tool.description).not.toContain("mr_view");
		expect(tool.description).not.toContain("issue_list");
		expect(tool.description).not.toContain("mr_list");
		expect(tool.approval({ op: "repo_view" })).toBe("read");
		expect(tool.approval({ op: "pipeline_list" })).toBe("read");
		expect(tool.approval({ op: "mr_create" })).toBe("exec");
		expect(tool.approval({ op: "mr_checkout" })).toBe("exec");
	});
});
