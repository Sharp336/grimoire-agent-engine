import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

const workspaceTree = {
	rootPath: "/tmp/project",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

describe("reviewer.enabled gates the system-prompt Code Review section", () => {
	it("renders the Code Review section by default (reviewer.enabled true)", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			toolNames: ["task"],
			contextFiles: [],
			skills: [],
			workspaceTree,
		});
		const text = systemPrompt.join("\n");

		expect(text).toContain("# Code Review");
		expect(text).toContain("dispatch the `reviewer` agent");
	});

	it("omits the Code Review section when reviewerEnabled is false", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			reviewerEnabled: false,
			toolNames: ["task"],
			contextFiles: [],
			skills: [],
			workspaceTree,
		});
		const text = systemPrompt.join("\n");

		expect(text).not.toContain("# Code Review");
		expect(text).not.toContain("dispatch the `reviewer` agent");
	});

	it("does not render the section without the task tool, even when reviewer is enabled", async () => {
		// The block is nested under {{#has tools "task"}}; no task tool → no block.
		const { systemPrompt } = await buildSystemPrompt({
			toolNames: ["bash"],
			contextFiles: [],
			skills: [],
			workspaceTree,
		});

		expect(systemPrompt.join("\n")).not.toContain("# Code Review");
	});
});

describe("reviewer.enabled default", () => {
	it("defaults to true on a fresh isolated Settings", () => {
		expect(Settings.isolated().get("reviewer.enabled")).toBe(true);
	});
});
