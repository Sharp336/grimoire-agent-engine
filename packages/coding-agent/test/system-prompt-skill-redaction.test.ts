import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function makeSkill(name: string, opts: { hide?: boolean } = {}): Skill {
	return {
		name,
		description: `desc for ${name}`,
		filePath: `/skills/${name}.md`,
		baseDir: "/skills",
		source: "test",
		hide: opts.hide,
	};
}

const READ_TOOLS = new Map<string, SystemPromptToolMetadata>([["read", { label: "Read", description: "Read a file" }]]);

function workspaceTree(projectDir: string) {
	return {
		rootPath: projectDir,
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [],
	};
}

describe("system prompt skill redaction", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let projectDir = "";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-redact-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-redact-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
		projectDir = path.join(tempDir, "project");
		fs.mkdirSync(projectDir, { recursive: true });
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(options: {
		skills: Skill[];
		redactDescriptions?: boolean;
		frequentSkillNames?: ReadonlySet<string> | null;
	}): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			contextFiles: [],
			skills: options.skills,
			rules: [],
			toolNames: ["read"],
			tools: READ_TOOLS,
			skillsSettings: { redactDescriptions: options.redactDescriptions ?? false },
			frequentSkillNames: options.frequentSkillNames ?? null,
			workspaceTree: workspaceTree(projectDir),
		});
		return systemPrompt.join("\n\n");
	}

	it("redactDescriptions:false renders all skills with no pointer (baseline)", async () => {
		const skills = [makeSkill("alpha"), makeSkill("beta"), makeSkill("gamma")];
		const text = await render({ skills, redactDescriptions: false });
		expect(text).toContain("- alpha: desc for alpha");
		expect(text).toContain("- beta: desc for beta");
		expect(text).toContain("- gamma: desc for gamma");
		expect(text).not.toContain("more skills not listed");
	});

	it("baseline output is byte-identical whether frequentSkillNames is null or redaction is off", async () => {
		const skills = [makeSkill("alpha"), makeSkill("beta"), makeSkill("gamma")];
		// Off-path: redactDescriptions:false but a frequent set is supplied — must be ignored.
		const offWithSet = await render({
			skills,
			redactDescriptions: false,
			frequentSkillNames: new Set(["alpha"]),
		});
		const plainBaseline = await render({ skills, redactDescriptions: false, frequentSkillNames: null });
		expect(offWithSet).toBe(plainBaseline);
	});

	it("redactDescriptions:true renders only frequent skills plus a pointer with the deferred count", async () => {
		const skills = [makeSkill("alpha"), makeSkill("beta"), makeSkill("gamma"), makeSkill("delta")];
		const text = await render({
			skills,
			redactDescriptions: true,
			frequentSkillNames: new Set(["alpha", "beta"]),
		});
		expect(text).toContain("- alpha: desc for alpha");
		expect(text).toContain("- beta: desc for beta");
		expect(text).not.toContain("- gamma: desc for gamma");
		expect(text).not.toContain("- delta: desc for delta");
		// 2 deferred (gamma, delta)
		expect(text).toContain("(2 more skills not listed");
		expect(text).toContain("search_tool_bm25");
	});

	it("deferredSkillCount === 0 (all skills frequent) renders all skills and no pointer", async () => {
		const skills = [makeSkill("alpha"), makeSkill("beta")];
		const text = await render({
			skills,
			redactDescriptions: true,
			frequentSkillNames: new Set(["alpha", "beta"]),
		});
		expect(text).toContain("- alpha: desc for alpha");
		expect(text).toContain("- beta: desc for beta");
		expect(text).not.toContain("more skills not listed");
	});

	it("hidden skills never appear in rendered output or the deferred count", async () => {
		const skills = [makeSkill("alpha"), makeSkill("beta"), makeSkill("secret", { hide: true }), makeSkill("gamma")];
		const text = await render({
			skills,
			redactDescriptions: true,
			frequentSkillNames: new Set(["alpha"]),
		});
		// hidden skill is never rendered
		expect(text).not.toContain("secret");
		// rendered: alpha; deferred: beta, gamma (hidden "secret" excluded from both)
		expect(text).toContain("- alpha: desc for alpha");
		expect(text).toContain("(2 more skills not listed");
	});

	it("empty frequentSkillNames Set defers all skills — pointer-only block", async () => {
		const skillList = [makeSkill("alpha"), makeSkill("beta")];
		const text = await render({
			skills: skillList,
			redactDescriptions: true,
			frequentSkillNames: new Set<string>([]),
		});
		// No skill entries rendered
		expect(text).not.toContain("- alpha:");
		expect(text).not.toContain("- beta:");
		// Pointer line references both deferred skills
		expect(text).toContain("(2 more skills not listed");
		expect(text).toContain("search_tool_bm25");
	});
});
