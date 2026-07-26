import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GithubTool } from "@oh-my-pi/pi-coding-agent/tools/gh";

/** Minimal session stub — the description getter only reads `session.settings`. */
function makeToolSession(settings: Settings): ToolSession {
	return { settings } as unknown as ToolSession;
}

describe("GithubTool description reviewer gating", () => {
	it("includes the review-before-pr block when reviewer.enabled is true (default)", () => {
		const tool = new GithubTool(makeToolSession(Settings.isolated()));

		expect(tool.description).toContain("<review-before-pr>");
		expect(tool.description).toContain("Before `pr_create`");
	});

	it("omits the review-before-pr block when reviewer.enabled is false", () => {
		const tool = new GithubTool(makeToolSession(Settings.isolated({ "reviewer.enabled": false })));

		expect(tool.description).not.toContain("<review-before-pr>");
		expect(tool.description).not.toContain("Before `pr_create`");
	});
});
