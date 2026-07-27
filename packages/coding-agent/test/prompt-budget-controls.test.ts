/**
 * Contracts for the two prompt-budget controls added around tool/skill
 * presentation:
 *
 * - `truncateSkillDescription` backs `skills.promptDescriptionMaxChars`: the
 *   rendered skills listing is a routing index, so a cap must cut at a
 *   sentence boundary when one exists (ASCII and CJK), never split a
 *   surrogate pair, and leave text alone when disabled or already within
 *   budget.
 * - `isMountableUnderXdev` with pin globs backs `tools.xdevTopLevelDevices`:
 *   a matching discoverable tool must stay top-level (skipping xd:// dispatch
 *   round-trips) while non-matching tools still mount.
 */
import { describe, expect, it } from "bun:test";
import {
	firstSentenceOfDescription,
	renderSkillPromptDescription,
	truncateSkillDescription,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { compileXdevDeviceGlobs, isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";

describe("truncateSkillDescription", () => {
	it("returns input unchanged when the cap is disabled or not exceeded", () => {
		expect(truncateSkillDescription("short routing cue", 0)).toBe("short routing cue");
		expect(truncateSkillDescription("short routing cue", 100)).toBe("short routing cue");
	});

	it("cuts at the last sentence boundary inside the budget", () => {
		const text = "First sentence stays. Second sentence is far too long to fit the budget.";
		expect(truncateSkillDescription(text, 30)).toBe("First sentence stays.…");
	});

	it("cuts CJK text at sentence punctuation when the boundary sits in the back half of the budget", () => {
		const text = "飞书多维表格操作。建表、字段、记录、视图、统计、公式，遇到多维表格链接时使用。文件导入转其他技能。";
		expect(truncateSkillDescription(text, 12)).toBe("飞书多维表格操作。…");
		// An early boundary (front half) is skipped in favor of filling the budget.
		expect(truncateSkillDescription(text, 20)).toBe("飞书多维表格操作。建表、字段、记录、视图…");
	});

	it("hard-cuts boundary-free text without splitting a surrogate pair", () => {
		const text = "𝕏".repeat(40); // each 𝕏 is a surrogate pair
		const result = truncateSkillDescription(text, 21);
		expect(result.endsWith("…")).toBe(true);
		// Round-trip through code points: no lone surrogates survive.
		expect([...result].every(ch => ch.length <= 2)).toBe(true);
		expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
		expect([...result.slice(0, -1)].every(ch => ch === "𝕏")).toBe(true);
	});
});

describe("renderSkillPromptDescription (skills.promptDescriptionMode)", () => {
	const skill = {
		description: "飞书多维表格操作。建表、字段、记录、视图、统计、公式，遇到多维表格链接时使用。",
		summary: "多维表格 Base 增删改查",
	};

	it("full mode renders the whole description", () => {
		expect(renderSkillPromptDescription(skill, {})).toBe(skill.description);
		expect(renderSkillPromptDescription(skill, { mode: "full" })).toBe(skill.description);
	});

	it("brief mode prefers the author's frontmatter summary", () => {
		expect(renderSkillPromptDescription(skill, { mode: "brief" })).toBe("多维表格 Base 增删改查");
	});

	it("brief mode falls back to the first sentence when no summary exists", () => {
		expect(renderSkillPromptDescription({ description: skill.description }, { mode: "brief" })).toBe(
			"飞书多维表格操作。",
		);
		expect(firstSentenceOfDescription("no boundary at all")).toBe("no boundary at all");
	});

	it("applies the maxChars cap on top of brief mode", () => {
		expect(
			renderSkillPromptDescription(
				{ description: "x", summary: "多维表格 Base 增删改查全家桶超长摘要" },
				{ mode: "brief", maxChars: 8 },
			),
		).toBe("多维表格…");
	});
});

describe("tools.xdevTopLevelDevices pins", () => {
	it("keeps a matching discoverable tool top-level and mounts the rest", () => {
		const pins = compileXdevDeviceGlobs(["lsp", "mcp__linear_*"]);
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" }, pins)).toBe(false);
		expect(isMountableUnderXdev({ name: "mcp__linear_create_issue", loadMode: "discoverable" }, pins)).toBe(false);
		expect(isMountableUnderXdev({ name: "browser", loadMode: "discoverable" }, pins)).toBe(true);
	});

	it("never promotes transport tools or demotes essentials via pins", () => {
		const pins = compileXdevDeviceGlobs(["*"]);
		// A '*' pin keeps every discoverable tool top-level…
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" }, pins)).toBe(false);
		// …and essential tools were never mountable to begin with.
		expect(isMountableUnderXdev({ name: "edit", loadMode: "essential" }, pins)).toBe(false);
	});

	it("drops malformed glob config entries instead of breaking partitioning", () => {
		const pins = compileXdevDeviceGlobs([42, null, "lsp"] as unknown as string[]);
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" }, pins)).toBe(false);
		expect(isMountableUnderXdev({ name: "debug", loadMode: "discoverable" }, pins)).toBe(true);
	});
});
