import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GithubTool } from "@oh-my-pi/pi-coding-agent/tools/gh";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("rendered GitHub issue workflow guidance", () => {
	it("routes hierarchy reads, assignee searches, and state changes through cache-aware surfaces", () => {
		const description = new GithubTool({} as ToolSession).description;

		expect(description).toContain("Read its `issue://` URL first");
		expect(description).toContain("Read the parent once for direct-child status/progress");
		expect(description).toContain("follow only returned child links");
		expect(description).toContain("child body, comments, or assignees");
		expect(description).toContain("`search_issues` for repository-wide discovery or assignee queries");
		expect(description).toContain("“assigned” means assignees, NEVER attached/sub-issues");
		expect(description).toContain("Close or reopen with `issue_state`, NEVER raw `gh issue close`/`reopen`");
		expect(description).toContain("`issue_state` mutates only explicitly listed issue numbers");
		expect(description).toContain("A singular request to close or reopen an issue targets only that issue");
		expect(description).toContain(
			"NEVER include its sub-issues or descendants unless the user explicitly requests them",
		);
		expect(description).toContain("pass each same-repo batch as one `issue` array");
		expect(description).toContain("operation invalidates cached parent summaries");
		expect(description).toContain("summary is the verification");
		expect(description).toContain("reread the parent once");
		expect(description).toContain("not every child");
		expect(description).toContain("Use `?fresh=1` only after external/raw mutation or when cache state is uncertain");
	});

	it("keeps partial creation and reparenting recovery visible to the model", () => {
		const description = new GithubTool({} as ToolSession).description;

		expect(description).toContain("`issue_create` reparenting is destructive");
		expect(description).toContain("only `replaceParent: true` explicitly opts existing `subIssues` into reparenting");
		expect(description).toContain('A returned `WARNING` with `details.status: "partial"`');
		expect(description).toContain("inspect the issue hierarchy before retrying attachments");
		expect(description).toContain("never retry issue creation");
	});

	it("renders parent-first URL routing and GitHub assignment terminology in the system prompt", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: process.cwd(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: process.cwd() },
			activeRepoContext: null,
		});
		const rendered = systemPrompt.join("\n\n");

		expect(rendered).toContain("primary read for a specific GitHub issue or hierarchy");
		expect(rendered).toContain("Read the parent first for one-hop direct-child status/progress");
		expect(rendered).toContain("follow only returned child links");
		expect(rendered).toContain("child body, comments, or assignees");
		expect(rendered).toContain("`search_issues` for repository-wide or assignee queries");
		expect(rendered).toContain("“assigned issues” means assignee matches, NEVER attached/sub-issues");
		expect(rendered).toContain("use `?fresh=1` only after external/raw mutation or when cache state is uncertain");
	});
});
