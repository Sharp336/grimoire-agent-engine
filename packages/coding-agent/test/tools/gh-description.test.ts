import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GithubTool } from "@oh-my-pi/pi-coding-agent/tools/gh";

/**
 * Minimal session stub. The description getter reads `session.settings`
 * (reviewer.enabled + task.disabledAgents via isReviewerActive),
 * `session.isToolActive` (task availability), and `session.getSessionSpawns()`
 * (spawn policy via spawnPolicyAllowsReviewer). Defaults render the block.
 */
function makeToolSession(
	settings: Settings,
	activeTools: ReadonlySet<string> = new Set(["task"]),
	spawns: string | null = null,
): ToolSession {
	return {
		settings,
		isToolActive: (name: string) => activeTools.has(name),
		getSessionSpawns: () => spawns,
	} as unknown as ToolSession;
}

describe("GithubTool description reviewer gating", () => {
	it("includes the review-before-pr block when reviewer is enabled and task is available (default)", () => {
		const tool = new GithubTool(makeToolSession(Settings.isolated()));

		expect(tool.description).toContain("<review-before-pr>");
		expect(tool.description).toContain("Before `pr_create`");
	});

	it("omits the block when reviewer.enabled is false", () => {
		const tool = new GithubTool(makeToolSession(Settings.isolated({ "reviewer.enabled": false })));

		expect(tool.description).not.toContain("<review-before-pr>");
		expect(tool.description).not.toContain("Before `pr_create`");
	});

	it("omits the block when task is not active, even if reviewer is enabled", () => {
		const tool = new GithubTool(makeToolSession(Settings.isolated(), new Set()));

		expect(tool.description).not.toContain("<review-before-pr>");
		expect(tool.description).not.toContain("Before `pr_create`");
	});

	it("omits the block when the reviewer agent is disabled via task.disabledAgents", () => {
		const tool = new GithubTool(makeToolSession(Settings.isolated({ "task.disabledAgents": ["reviewer"] })));

		expect(tool.description).not.toContain("<review-before-pr>");
		expect(tool.description).not.toContain("Before `pr_create`");
	});

	it("omits the block when the spawn policy excludes reviewer", () => {
		const tool = new GithubTool(makeToolSession(Settings.isolated(), new Set(["task"]), "scout"));

		expect(tool.description).not.toContain("<review-before-pr>");
		expect(tool.description).not.toContain("Before `pr_create`");
	});

	it("renders the block when the spawn policy explicitly lists reviewer", () => {
		const tool = new GithubTool(makeToolSession(Settings.isolated(), new Set(["task"]), "reviewer"));

		expect(tool.description).toContain("<review-before-pr>");
		expect(tool.description).toContain("Before `pr_create`");
	});
});
