import { describe, expect, it } from "bun:test";
import { selectPromptSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skill-selection";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";

function makeSkill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		source: "test",
	};
}

describe("selectPromptSkills", () => {
	const skills: Skill[] = [
		makeSkill("vercel-react-best-practices", "React Next.js performance optimization and bundle improvements"),
		makeSkill("linear", "Manage issues and project workflows in Linear"),
		makeSkill("pdf", "Create and review PDF files"),
	];

	it("always includes pinned skills when present", () => {
		const selected = selectPromptSkills(skills, "work on some unrelated thing", ["linear"]);
		expect(selected.map(skill => skill.name)).toContain("linear");
	});

	it("selects explicitly named skills from prompt text", () => {
		const selected = selectPromptSkills(
			skills,
			"use vercel-react-best-practices for this optimization task",
			[],
		);
		expect(selected.map(skill => skill.name)).toContain("vercel-react-best-practices");
	});

	it("does not auto-select skills from generic semantic similarity", () => {
		const selected = selectPromptSkills(skills, "optimize React Next.js bundle size and performance", []);
		expect(selected).toHaveLength(0);
	});

	it("keeps pinned skills first and avoids duplicates", () => {
		const selected = selectPromptSkills(
			skills,
			"please use vercel-react-best-practices to optimize react performance",
			["vercel-react-best-practices"],
		);
		const names = selected.map(skill => skill.name);
		expect(names[0]).toBe("vercel-react-best-practices");
		expect(names.filter(name => name === "vercel-react-best-practices")).toHaveLength(1);
	});
});
