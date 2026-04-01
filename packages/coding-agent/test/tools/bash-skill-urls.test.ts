import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "../../src/extensibility/skills";
import { resolveLocalUrlToPath } from "../../src/internal-urls";
import { expandInternalUrls, expandSkillUrls, resolveSkillUrlToPath } from "../../src/tools/bash-skill-urls";
import { ToolError } from "../../src/tools/tool-errors";

function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

function createSkill(name: string, baseDir: string): Skill {
	const resolvedBaseDir = path.resolve(baseDir);
	return {
		name,
		description: `${name} description`,
		filePath: path.join(resolvedBaseDir, "SKILL.md"),
		baseDir: resolvedBaseDir,
		source: "test",
	};
}

function createPluginSkill(name: string, baseDir: string, pluginRoot: string): Skill {
	return { ...createSkill(name, baseDir), pluginRoot: path.resolve(pluginRoot) };
}

function createInternalRouter(resources: Record<string, { sourcePath?: string; error?: string }>): {
	canHandle: (input: string) => boolean;
	resolve: (
		input: string,
	) => Promise<{ url: string; content: string; contentType: "text/plain"; sourcePath?: string; immutable: boolean }>;
} {
	return {
		canHandle: input => /^(agent|artifact|plan|memory|rule):\/\//.test(input),
		resolve: async input => {
			const entry = resources[input];
			if (!entry) {
				throw new Error(`No mapping for ${input}`);
			}
			if (entry.error) {
				throw new Error(entry.error);
			}
			return {
				url: input,
				content: "",
				contentType: "text/plain",
				sourcePath: entry.sourcePath,
				immutable: true,
			};
		},
	};
}

describe("expandSkillUrls", () => {
	it("expands a basic skill:// URI to an absolute path", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "python skill://valid-skill/scripts/init.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(await expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("expands multiple skill:// URIs in one command", async () => {
		const skills = [
			createSkill("first-skill", "/tmp/skills/first-skill"),
			createSkill("second-skill", "/tmp/skills/second-skill"),
		];
		const command = "cp skill://first-skill/a.txt skill://second-skill/b.txt";
		const firstPath = path.join(skills[0].baseDir, "a.txt");
		const secondPath = path.join(skills[1].baseDir, "b.txt");

		expect(await expandSkillUrls(command, skills)).toBe(`cp ${shellEscape(firstPath)} ${shellEscape(secondPath)}`);
	});

	it("throws ToolError for unknown skills with available names", async () => {
		const skills = [
			createSkill("first-skill", "/tmp/skills/first-skill"),
			createSkill("second-skill", "/tmp/skills/second-skill"),
		];

		await expect(expandSkillUrls("python skill://missing/run.py", skills)).rejects.toThrow(
			"Unknown skill: missing. Available: first-skill, second-skill",
		);
	});

	it("throws ToolError for path traversal attempts", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];

		await expect(expandSkillUrls("cat skill://valid-skill/../../../etc/passwd", skills)).rejects.toThrow(
			"Path traversal (..) is not allowed in skill:// URLs",
		);
	});

	it("returns command unchanged when there are no skill:// tokens", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "git status";

		expect(await expandSkillUrls(command, skills)).toBe(command);
	});

	it("does not expand non-skill internal URIs", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "echo agent://1 artifact://abc rule://security";

		expect(await expandSkillUrls(command, skills)).toBe(command);
	});

	it("expands URI in double quotes", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'python "skill://valid-skill/scripts/init.py"';
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(await expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("expands URI in single quotes", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "python 'skill://valid-skill/scripts/init.py'";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(await expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("shell-escapes paths with spaces", async () => {
		const skills = [createSkill("space-skill", "/tmp/skills/with space")];
		const command = "python skill://space-skill/scripts/my%20file.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/my file.py");

		expect(await expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("shell-escapes paths containing single quotes", async () => {
		const skills = [createSkill("quote-skill", "/tmp/skills/with'quote")];
		const command = "python skill://quote-skill/scripts/init.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(await expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("resolves skill://name with no relative path to SKILL.md", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "cat skill://valid-skill";

		expect(await expandSkillUrls(command, skills)).toBe(`cat ${shellEscape(skills[0].filePath)}`);
	});

	it("returns command unchanged when no skills are loaded", async () => {
		const command = "python skill://valid-skill/scripts/init.py";
		expect(await expandSkillUrls(command, [])).toBe(command);
	});

	it("throws ToolError when traversal is attempted with encoded segments", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		await expect(expandSkillUrls("cat skill://valid-skill/%2E%2E/%2E%2E/etc/passwd", skills)).rejects.toThrow(
			ToolError,
		);
	});
});

describe("plugin-root traversal (issue #585)", () => {
	it("allows .. traversal within plugin root for plugin skills", async () => {
		// PLUGIN_ROOT/skills/greet/ is the skill baseDir; ../commands/hello.md stays within PLUGIN_ROOT.
		const pluginRoot = "/tmp/test-plugin-root";
		const skill = createPluginSkill("hello-plugin:greet", `${pluginRoot}/skills/greet`, pluginRoot);
		const url = "skill://hello-plugin:greet/../../commands/hello.md";
		const expectedPath = path.resolve(`${pluginRoot}/commands/hello.md`);

		expect(await resolveSkillUrlToPath(url, [skill])).toBe(expectedPath);
	});

	it("rejects .. that escapes plugin root", async () => {
		const pluginRoot = "/tmp/test-plugin-root";
		const skill = createPluginSkill("hello-plugin:greet", `${pluginRoot}/skills/greet`, pluginRoot);

		await expect(resolveSkillUrlToPath("skill://hello-plugin:greet/../../../outside.md", [skill])).rejects.toThrow(
			ToolError,
		);
	});

	it("still rejects .. for non-plugin skills (no pluginRoot)", async () => {
		const skill = createSkill("plain-skill", "/tmp/skills/plain-skill");

		await expect(resolveSkillUrlToPath("skill://plain-skill/../sibling.md", [skill])).rejects.toThrow(
			"Path traversal (..) is not allowed in skill:// URLs",
		);
	});

	describe("symlink-ancestor escape prevention", () => {
		let tmpDir: string;

		beforeAll(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-test-"));
			// Plugin structure: PLUGIN_ROOT/skills/greet/ (skill dir)
			await fs.mkdir(path.join(tmpDir, "skills", "greet"), { recursive: true });
			// Symlink inside plugin root pointing outside: PLUGIN_ROOT/evil -> os.tmpdir()
			await fs.symlink(os.tmpdir(), path.join(tmpDir, "evil"));
		});

		afterAll(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		it("blocks write-path injection through a symlinked directory inside plugin root", async () => {
			const skill = createPluginSkill("p:greet", path.join(tmpDir, "skills", "greet"), tmpDir);
			// Lexically within plugin root, but evil/ is a symlink to outside.
			const url = "skill://p:greet/../../evil/pwned.txt";

			await expect(resolveSkillUrlToPath(url, [skill])).rejects.toThrow(ToolError);
		});

		it("blocks deep write-path injection where intermediate dirs do not exist", async () => {
			const skill = createPluginSkill("p:greet", path.join(tmpDir, "skills", "greet"), tmpDir);
			// evil/ -> outside, but evil/new/sub/ does not exist. The immediate-parent check
			// would throw ENOENT on evil/new/sub and fall through; the ancestor walk must
			// reach evil/ itself, realpath it to the outside target, and reject.
			const url = "skill://p:greet/../../evil/new/sub/file.txt";

			await expect(resolveSkillUrlToPath(url, [skill])).rejects.toThrow(ToolError);
		});
	});
});

describe("expandInternalUrls", () => {
	it("expands skill/agent/artifact/memory/rule URLs in one command", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const router = createInternalRouter({
			"artifact://12": { sourcePath: "/tmp/artifacts/12.bash.log" },
			"agent://reviewer_0": { sourcePath: "/tmp/session/reviewer_0.md" },
			"memory://root/memory_summary.md": { sourcePath: "/tmp/memories/memory_summary.md" },
			"rule://rs-no-unwrap": { sourcePath: "/tmp/rules/rs-no-unwrap.md" },
		});
		const command =
			"cat agent://reviewer_0 artifact://12 memory://root/memory_summary.md rule://rs-no-unwrap skill://valid-skill/scripts/init.py";
		const expectedSkillPath = path.join(skills[0].baseDir, "scripts/init.py");

		await expect(expandInternalUrls(command, { skills, internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/session/reviewer_0.md")} ${shellEscape("/tmp/artifacts/12.bash.log")} ${shellEscape("/tmp/memories/memory_summary.md")} ${shellEscape("/tmp/rules/rs-no-unwrap.md")} ${shellEscape(expectedSkillPath)}`,
		);
	});

	it("expands quoted non-skill URLs and shell-escapes quotes in paths", async () => {
		const router = createInternalRouter({
			"artifact://7": { sourcePath: "/tmp/artifacts/with'quote.log" },
		});
		await expect(expandInternalUrls('cat "artifact://7"', { skills: [], internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/artifacts/with'quote.log")}`,
		);
	});

	it("expands agent:// URLs when router is available", async () => {
		const router = createInternalRouter({
			"agent://abc": { sourcePath: "/tmp/session/abc.md" },
		});
		await expect(expandInternalUrls("echo agent://abc", { skills: [], internalRouter: router })).resolves.toBe(
			`echo ${shellEscape("/tmp/session/abc.md")}`,
		);
	});

	it("expands local:// URLs to filesystem paths without requiring preexisting files", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "mv /tmp/source.json local://handoffs/new-file.json";
		const expectedPath = resolveLocalUrlToPath("local://handoffs/new-file.json", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`mv /tmp/source.json ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL in double quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = 'cat "local:/PLAN.md"';
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL in single quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat 'local:/PLAN.md'";
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL without quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat local:/PLAN.md";
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("throws when local:// URL is used without local protocol options", async () => {
		await expect(expandInternalUrls("mv foo local://bar", { skills: [] })).rejects.toThrow(
			"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
		);
	});

	it("throws when non-skill URL is used without an internal router", async () => {
		await expect(expandInternalUrls("cat artifact://1", { skills: [] })).rejects.toThrow(
			"Cannot resolve artifact:// URL in bash command",
		);
	});

	it("throws when internal router resolves URL without sourcePath", async () => {
		const router = createInternalRouter({
			"rule://my-rule": {},
		});
		await expect(expandInternalUrls("cat rule://my-rule", { skills: [], internalRouter: router })).rejects.toThrow(
			"rule:// URL resolved without a filesystem path",
		);
	});

	it("surfaces resolver errors with actionable context", async () => {
		const router = createInternalRouter({
			"memory://root/missing.md": { error: "Memory file not found" },
		});
		await expect(
			expandInternalUrls("cat memory://root/missing.md", { skills: [], internalRouter: router }),
		).rejects.toThrow("Failed to resolve memory:// URL in bash command");
	});

	it("does not match local:/ inside filesystem paths (e.g. /repo/local:/PLAN.md)", async () => {
		const command = "cat /repo/local:/PLAN.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("does not match local:/ after ./ or ../ prefixes", async () => {
		const command = "cat ./local:/PLAN.md ../local:/other.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("still matches standalone local:/ at a real token boundary", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat local:/PLAN.md";
		const expectedPath = resolveLocalUrlToPath("local://PLAN.md", localOptions);
		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("does not match local:/ when embedded in words (e.g., notlocal:/, mylocal:/)", async () => {
		const command1 = "cat notlocal:/PLAN.md";
		await expect(expandInternalUrls(command1, { skills: [] })).resolves.toBe(command1);

		const command2 = "cat mylocal:/data.json";
		await expect(expandInternalUrls(command2, { skills: [] })).resolves.toBe(command2);

		const command3 = "cat getlocal:/file.txt";
		await expect(expandInternalUrls(command3, { skills: [] })).resolves.toBe(command3);

		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		await expect(expandInternalUrls(command1, { skills: [], localOptions })).resolves.toBe(command1);
	});

	it("does not match local:/ after a hyphen (e.g. not-local:/PLAN.md)", async () => {
		const command = "cat not-local:/PLAN.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);

		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(command);
	});
});
