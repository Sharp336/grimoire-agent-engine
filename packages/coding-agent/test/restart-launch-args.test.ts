import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { buildRestartLaunchArgs } from "@oh-my-pi/pi-coding-agent/main";
import { getProjectDir } from "@oh-my-pi/pi-utils";

describe("buildRestartLaunchArgs", () => {
	it("does not preserve launch cwd guards because restart uses the current project dir", () => {
		const parsed = parseArgs(["--cwd", "/work/project", "--allow-home"]);

		expect(buildRestartLaunchArgs(parsed)).toEqual([]);
	});

	it("resolves config overlays against the startup project dir", () => {
		const parsed = parseArgs(["--config", "config.local.yaml"]);

		expect(buildRestartLaunchArgs(parsed, "/startup/project")).toEqual([
			"--config",
			path.resolve("/startup/project", "config.local.yaml"),
		]);
	});

	it("expands tilde before resolving restart path inputs", () => {
		const parsed = parseArgs(["--config=~/omp.yml", "--extension=~/plugin.ts"]);

		expect(buildRestartLaunchArgs(parsed)).toEqual([
			"--config",
			path.join(os.homedir(), "omp.yml"),
			"--extension",
			path.join(os.homedir(), "plugin.ts"),
		]);
	});

	it("resolves existing prompt files without rewriting literal prompts", () => {
		const parsed = parseArgs(["--system-prompt", "package.json", "--append-system-prompt", "literal prompt text"]);

		expect(buildRestartLaunchArgs(parsed, getProjectDir())).toEqual([
			"--system-prompt",
			path.resolve(getProjectDir(), "package.json"),
			"--append-system-prompt",
			"literal prompt text",
		]);
	});
	it("preserves extension-aware flags without replaying initial messages", () => {
		const parsed = parseArgs(
			["--extension", "plan-mode.ts", "--plan", "review diff", "--workspace", "team-a"],
			new Map([
				["plan", { type: "boolean" }],
				["workspace", { type: "string" }],
			]),
		);

		expect(parsed.plan).toBeUndefined();
		expect(parsed.messages).toEqual(["review diff"]);
		expect(buildRestartLaunchArgs(parsed)).toEqual([
			"--extension",
			path.resolve(getProjectDir(), "plan-mode.ts"),
			"--plan",
			"--workspace",
			"team-a",
		]);
	});

	it("preserves equals form for dashed extension flag values", () => {
		const parsed = parseArgs(["--target=--staging"], new Map([["target", { type: "string" }]]));

		expect(buildRestartLaunchArgs(parsed)).toEqual(["--target=--staging"]);
	});

	it("treats changelog handoff path as a built-in string flag", () => {
		const parsed = parseArgs(["--changelog-on-resume-path", "--notes", "--profile", "work"]);

		expect(parsed.changelogOnResumePath).toBe("--notes");
		expect(parsed.profile).toBe("work");
	});

	it("preserves tool, approval, scoped model, and extension launch restrictions", () => {
		const parsed = parseArgs([
			"--no-tools",
			"--tools",
			"read,bash",
			"--models",
			"anthropic/claude-sonnet-4-5,openai/gpt-5",
			"--approval-mode",
			"always-ask",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
		]);

		expect(buildRestartLaunchArgs(parsed)).toEqual([
			"--models",
			"anthropic/claude-sonnet-4-5,openai/gpt-5",
			"--no-tools",
			"--tools",
			"read,bash",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--approval-mode",
			"always-ask",
		]);
	});

	it("omits session-state model and thinking flags so resume restores current session state", () => {
		const parsed = parseArgs([
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
			"--thinking",
			"high",
			"--hide-thinking",
		]);

		expect(buildRestartLaunchArgs(parsed)).toEqual([]);
	});
});
