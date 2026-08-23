import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Skill } from "../src/extensibility/skills";
import type { ToolSession } from "../src/tools";
import { SkillSearchTool } from "../src/tools/skill-search";

function skill(name: string, description: string, hide = false): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		source: "test",
		hide,
	};
}

function makeTool(skills: readonly Skill[]): SkillSearchTool {
	return new SkillSearchTool({ skills } as ToolSession);
}

function textOf(result: AgentToolResult): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("skill_search tool", () => {
	it("returns ranked metadata and skill URLs without loading skill bodies", async () => {
		const tool = makeTool([
			skill("frontend-design", "Design polished interfaces"),
			skill("react-testing", "Test React components with Vitest"),
			skill("postgres", "Design and tune PostgreSQL schemas"),
		]);

		const result = await tool.execute("call-1", { query: "react testing" });
		const text = textOf(result);

		expect(text).toContain("skill://react-testing");
		expect(text).toContain("Test React components with Vitest");
		expect(text).toContain("Use read with skill://react-testing");
		expect(text).not.toContain("frontend-design");
		expect(text).not.toContain("# full skill body");
	});

	it("does not expose hidden skills through model search", async () => {
		const tool = makeTool([skill("secret-workflow", "Private workflow", true)]);

		const result = await tool.execute("call-2", { query: "secret workflow" });

		expect(textOf(result)).toBe("No matching skills found.");
		expect(result.useless).toBe(true);
	});
});
