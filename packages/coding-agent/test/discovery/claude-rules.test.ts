import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";

async function writeRule(dir: string, filename: string, frontmatter: string, body: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, filename), `---\n${frontmatter}---\n${body}\n`);
}

describe("Claude rules discovery", () => {
	let tempHome = "";
	let repoRoot = "";
	let subProject = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-rules-home-"));
		repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-rules-repo-"));
		subProject = path.join(repoRoot, "packages", "app");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(subProject, { recursive: true });
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await fs.rm(tempHome, { recursive: true, force: true });
		await fs.rm(repoRoot, { recursive: true, force: true });
	});

	test("loads .claude/rules with full OMP rule frontmatter", async () => {
		await writeRule(
			path.join(subProject, ".claude", "rules"),
			"secure-edits.md",
			`${[
				"description: Secure edit policy",
				"globs:",
				"  - '**/*.ts'",
				"alwaysApply: true",
				"condition:",
				"  - dangerous",
				"scope: tool:edit(**/*.ts), tool:write(**/*.ts)",
				"interruptMode: tool-only",
				"claudeIgnoredField: still accepted",
			].join("\n")}\n`,
			"# Secure edits\n\nValidate inputs before writes.",
		);

		const result = await loadCapability<Rule>(ruleCapability.id, {
			cwd: subProject,
			providers: ["claude"],
		});

		const rule = result.items.find(item => item.name === "secure-edits");
		expect(rule).toBeDefined();
		expect(rule).toMatchObject({
			name: "secure-edits",
			content: "# Secure edits\n\nValidate inputs before writes.",
			globs: ["**/*.ts"],
			alwaysApply: true,
			description: "Secure edit policy",
			condition: ["dangerous"],
			scope: ["tool:edit(**/*.ts)", "tool:write(**/*.ts)"],
			interruptMode: "tool-only",
		});
		expect(rule!._source.provider).toBe("claude");
		expect(rule!._source.level).toBe("project");
	});

	test("loads user and walked-up project .claude/rules", async () => {
		await writeRule(path.join(tempHome, ".claude", "rules"), "user-rule.md", "description: User rule\n", "User body");
		await writeRule(
			path.join(repoRoot, ".claude", "rules"),
			"root-rule.mdc",
			"description: Root rule\n",
			"Root body",
		);
		await writeRule(
			path.join(subProject, ".claude", "rules"),
			"local-rule.md",
			"description: Local rule\n",
			"Local body",
		);

		const result = await loadCapability<Rule>(ruleCapability.id, {
			cwd: subProject,
			providers: ["claude"],
		});
		const names = result.items.map(rule => rule.name);

		expect(names).toContain("user-rule");
		expect(names).toContain("root-rule");
		expect(names).toContain("local-rule");
		expect(names.indexOf("local-rule")).toBeLessThan(names.indexOf("root-rule"));
	});

	test("prefers project rule over user rule with same name", async () => {
		await writeRule(
			path.join(tempHome, ".claude", "rules"),
			"shared-rule.md",
			"description: User shared rule\n",
			"User body",
		);
		await writeRule(
			path.join(subProject, ".claude", "rules"),
			"shared-rule.md",
			"description: Project shared rule\n",
			"Project body",
		);

		const result = await loadCapability<Rule>(ruleCapability.id, {
			cwd: subProject,
			providers: ["claude"],
		});

		const sharedRules = result.items.filter(rule => rule.name === "shared-rule");
		expect(sharedRules).toHaveLength(1);
		expect(sharedRules[0]!.content).toBe("Project body");
		expect(sharedRules[0]!._source.level).toBe("project");
	});

	test("loads home .claude/rules only as user rules", async () => {
		await writeRule(path.join(tempHome, ".claude", "rules"), "home-rule.md", "description: Home rule\n", "Home body");

		const result = await loadCapability<Rule>(ruleCapability.id, {
			cwd: tempHome,
			providers: ["claude"],
		});

		const homeRules = result.items.filter(rule => rule.name === "home-rule");
		expect(homeRules).toHaveLength(1);
		expect(homeRules[0]!.content).toBe("Home body");
		expect(homeRules[0]!._source.level).toBe("user");
	});
});
