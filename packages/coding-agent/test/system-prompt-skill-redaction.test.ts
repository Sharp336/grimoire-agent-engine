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

	it("redactDescriptions:true keeps every skill name, redacts descriptions of non-frequent skills, plus a pointer", async () => {
		const skills = [makeSkill("alpha"), makeSkill("beta"), makeSkill("gamma"), makeSkill("delta")];
		const text = await render({
			skills,
			redactDescriptions: true,
			frequentSkillNames: new Set(["alpha", "beta"]),
		});
		// Frequent skills render with their descriptions.
		expect(text).toContain("- alpha: desc for alpha");
		expect(text).toContain("- beta: desc for beta");
		// Redacted skills keep their name but lose the description.
		expect(text).toContain("- gamma");
		expect(text).not.toContain("desc for gamma");
		expect(text).toContain("- delta");
		expect(text).not.toContain("desc for delta");
		// 2 redacted (gamma, delta)
		expect(text).toContain("(2 skills above are listed without descriptions");
		expect(text).toContain("search_tool_bm25");
		expect(text).toContain("skill://<name>");
	});

	it("deferredSkillCount === 0 (all skills frequent) renders all skills with descriptions and no pointer", async () => {
		const skills = [makeSkill("alpha"), makeSkill("beta")];
		const text = await render({
			skills,
			redactDescriptions: true,
			frequentSkillNames: new Set(["alpha", "beta"]),
		});
		expect(text).toContain("- alpha: desc for alpha");
		expect(text).toContain("- beta: desc for beta");
		expect(text).not.toContain("skills above are listed without descriptions");
	});

	it("hidden skills never appear; deferred skills keep names but lose descriptions", async () => {
		const skills = [makeSkill("alpha"), makeSkill("beta"), makeSkill("secret", { hide: true }), makeSkill("gamma")];
		const text = await render({
			skills,
			redactDescriptions: true,
			frequentSkillNames: new Set(["alpha"]),
		});
		// hidden skill is never rendered
		expect(text).not.toContain("secret");
		// frequent: alpha (name + desc)
		expect(text).toContain("- alpha: desc for alpha");
		// deferred: beta, gamma — names present, descriptions absent (hidden "secret" excluded from both)
		expect(text).toContain("- beta");
		expect(text).not.toContain("desc for beta");
		expect(text).toContain("- gamma");
		expect(text).not.toContain("desc for gamma");
		expect(text).toContain("(2 skills above are listed without descriptions");
	});

	it("empty frequentSkillNames Set redacts all descriptions while keeping every name", async () => {
		const skillList = [makeSkill("alpha"), makeSkill("beta")];
		const text = await render({
			skills: skillList,
			redactDescriptions: true,
			frequentSkillNames: new Set<string>([]),
		});
		// Every skill name still rendered...
		expect(text).toContain("- alpha");
		expect(text).toContain("- beta");
		// ...but no descriptions remain.
		expect(text).not.toContain("desc for alpha");
		expect(text).not.toContain("desc for beta");
		// Pointer line references both redacted skills
		expect(text).toContain("(2 skills above are listed without descriptions");
		expect(text).toContain("search_tool_bm25");
	});

	it("subagent path: redactDescriptions:true + frequentSkillNames:null renders full block (no pointer)", async () => {
		// Subagent sessions always pass frequentSkillNames=null (gated at sdk.ts:1157).
		// system-prompt.ts requires `frequentSkillNames != null` for redaction to be active,
		// so a null set means redaction is inactive even when redactDescriptions is on:
		// every visible skill renders inline with its description and no pointer line appears.
		const skills = [makeSkill("alpha"), makeSkill("beta")];
		const text = await render({ skills, redactDescriptions: true, frequentSkillNames: null });
		expect(text).toContain("- alpha: desc for alpha");
		expect(text).toContain("- beta: desc for beta");
		expect(text).not.toContain("skills above are listed without descriptions");
		expect(text).not.toContain("search_tool_bm25");
	});

	it("custom system prompt: redacted skills render as name-only <skill> entries plus the pointer", async () => {
		const skills = [makeSkill("alpha"), makeSkill("beta"), makeSkill("gamma")];
		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			customPrompt: "You are a custom agent.",
			contextFiles: [],
			skills,
			rules: [],
			toolNames: ["read"],
			tools: READ_TOOLS,
			skillsSettings: { redactDescriptions: true },
			frequentSkillNames: new Set(["alpha"]),
			workspaceTree: workspaceTree(projectDir),
		});
		const text = systemPrompt.join("\n\n");
		// Frequent skill keeps its full <skill> element with description.
		expect(text).toContain('<skill name="alpha">');
		expect(text).toContain("desc for alpha");
		// Redacted skills render as self-closing name-only entries.
		expect(text).toContain('<skill name="beta"/>');
		expect(text).toContain('<skill name="gamma"/>');
		expect(text).not.toContain("desc for beta");
		expect(text).not.toContain("desc for gamma");
		// Pointer present with the redacted count.
		expect(text).toContain("(2 skills above are listed without descriptions");
		expect(text).toContain("search_tool_bm25");
		expect(text).toContain("skill://<name>");
	});
});
