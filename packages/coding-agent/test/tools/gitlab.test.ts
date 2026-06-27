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

	it("rejects mr_create body that would make glab interactive", async () => {
		const textSpy = vi.spyOn(git.gitlab, "text");
		const tool = new GitlabTool(createSession());

		await expect(
			tool.execute("mr-create", { op: "mr_create", repo: "group/project", title: "Explicit", body: "-" }),
		).rejects.toThrow("body must not be '-'");
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

		expect(opEnum).toEqual(["mr_checkout", "mr_create"]);
		const propertyNames = properties && typeof properties === "object" ? Object.keys(properties) : [];
		expect(propertyNames).not.toContain("limit");
		expect(propertyNames).not.toContain("status");
		expect(propertyNames).not.toContain("sha");
		expect(tool.description).toContain("issue://");
		expect(tool.description).toContain("pr://");
		expect(tool.description).not.toContain("repo_view");
		expect(tool.description).not.toContain("pipeline_status");
		expect(tool.description).not.toContain("pipeline_list");
		expect(tool.description).not.toContain("issue_view");
		expect(tool.description).not.toContain("mr_view");
		expect(tool.description).not.toContain("issue_list");
		expect(tool.description).not.toContain("mr_list");
		expect(tool.approval).toBe("exec");
	});
});
