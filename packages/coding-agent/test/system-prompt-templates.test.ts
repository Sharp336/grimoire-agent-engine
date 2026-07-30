import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	buildSystemPrompt,
	buildSystemPromptToolMetadata,
	discoverSubagentSystemPromptTemplate,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { getProjectDir, prompt, setProjectDir } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import Handlebars from "handlebars";
import * as z from "zod/v4";
import type { Args } from "../src/cli/args";
import { inspectSystemPrompt } from "../src/commands/system-prompt";
import { Settings } from "../src/config/settings";
import { runRootCommand } from "../src/main";
import type { CreateAgentSessionOptions } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";

const baseGitContext = {
	isRepo: true,
	currentBranch: "feature/tests",
	mainBranch: "main",
	status: "M packages/coding-agent/src/prompts/system/custom-system-prompt.md",
	commits: "abc123 Fix tests",
};

const systemPromptsDir = path.resolve(import.meta.dir, "../src/prompts/system");

const baseRenderContext: prompt.TemplateContext = {
	TASK_TOOL_NAME: "task",
	ARGUMENTS: "alpha beta",
	agent: "You are a delegated worker",
	agentsMdSearch: { files: [] },
	appendPrompt: "Appendix instructions",
	arguments: "alpha beta",
	base: "Base system prompt",
	content: "Rule content",
	context: "Background context",
	contextFile: "/tmp/context.md",
	contextFiles: [{ path: "/tmp/context/a.md", content: "Alpha context" }],
	customPrompt: "Custom prompt body",
	cwd: "/tmp/pi-issue-147",
	date: "2026-02-24",
	dateTime: "2026-02-24T12:00:00Z",
	editToolName: "edit",
	environment: [{ label: "OS", value: "Darwin" }],
	finalPlanFilePath: "local://PLAN_FINAL.md",
	git: baseGitContext,
	intentField: INTENT_FIELD,
	intentTracing: true,
	iterative: true,
	maxRetries: 3,
	modifiedFiles: ["packages/coding-agent/src/config/prompt-templates.ts"],
	name: "rs-no-unwrap",
	path: "packages/coding-agent/src/config/prompt-templates.ts",
	planContent: "1. Read code\n2. Add tests",
	planExists: true,
	planFilePath: "local://PLAN.md",
	readFiles: ["packages/coding-agent/src/prompts/system/custom-system-prompt.md"],
	repeatToolDescriptions: true,
	reentry: false,
	request: "Create an agent to review prompt templates",
	retryCount: 1,
	rules: [{ name: "rs-no-unwrap", description: "Avoid unwrap", globs: ["**/*.rs"] }],
	skills: [{ name: "system-prompts", description: "Prompt design skill" }],
	systemPromptCustomization: "System customization",
	toolInfo: [{ name: "read", label: "Read", description: "Reads files" }],
	toolRefs: {
		read: "read",
		search: "search",
		find: "find",
		edit: "edit",
		task: "task",
		web_search: "web_search",
		todo_write: "todo_write",
		inspect_image: "inspect_image",
		lsp: "lsp",
		ast_grep: "ast_grep",
		ast_edit: "ast_edit",
		grep: "grep",
		write: "write",
	},
	tools: ["read", "search", "find", "edit", "task", "web_search", "todo_write"],
	worktree: "/tmp/pi-issue-147",
	writeToolName: "write",
};

async function loadSystemPromptTemplates(): Promise<Map<string, string>> {
	const templates = new Map<string, string>();
	const glob = new Bun.Glob("*.md");

	for await (const fileName of glob.scan({ cwd: systemPromptsDir, onlyFiles: true })) {
		const templatePath = path.join(systemPromptsDir, fileName);
		templates.set(fileName, await Bun.file(templatePath).text());
	}

	return templates;
}

function countOccurrences(text: string, needle: string): number {
	if (!needle) return 0;
	return text.split(needle).length - 1;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const originalProjectDir = getProjectDir();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-system-prompt-"));
	try {
		await run(dir);
	} finally {
		setProjectDir(originalProjectDir);
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function createEmptyWorkspaceTree(rootPath: string) {
	return {
		rootPath,
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [],
	};
}

async function captureRootCommandOptions(
	dir: string,
	overrides: Partial<Args> = {},
	configDirName?: string,
): Promise<{ options: CreateAgentSessionOptions; stderr: string }> {
	const originalConfigDir = process.env.PI_CONFIG_DIR;
	if (configDirName) process.env.PI_CONFIG_DIR = configDirName;
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	const stopError = new Error("stop after capturing session options");
	let captured: CreateAgentSessionOptions | undefined;
	let stderr = "";
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		stderr += String(chunk);
		return true;
	});
	try {
		await runRootCommand(
			{
				cwd: dir,
				mode: "text",
				print: true,
				messages: ["hello"],
				fileArgs: [],
				unknownFlags: new Map(),
				unrecognizedFlags: [],
				noExtensions: true,
				noSkills: true,
				noRules: true,
				noTools: true,
				noLsp: true,
				sessionDir: dir,
				...overrides,
			},
			[],
			{
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
				createAgentSession: async options => {
					captured = options;
					throw stopError;
				},
			},
		);
	} catch (error) {
		if (error !== stopError) throw error;
	} finally {
		authStorage.close();
		if (configDirName) {
			if (originalConfigDir === undefined) {
				delete process.env.PI_CONFIG_DIR;
			} else {
				process.env.PI_CONFIG_DIR = originalConfigDir;
			}
		}
	}
	if (!captured) throw new Error("Expected createAgentSession to receive options");
	return { options: captured, stderr };
}

function applyCapturedSystemPromptOverride(
	options: CreateAgentSessionOptions,
	defaultPrompt: string[] = ["Default base", "Default project"],
): string[] {
	if (typeof options.systemPrompt !== "function") {
		throw new Error("Expected captured systemPrompt override function");
	}
	const prompt = options.systemPrompt(defaultPrompt);
	return typeof prompt === "string" ? [prompt] : prompt;
}

async function buildCapturedTemplatePrompt(dir: string, options: CreateAgentSessionOptions): Promise<string[]> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: dir,
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["read"],
		workspaceTree: createEmptyWorkspaceTree(dir),
		systemPromptTemplate: options.systemPromptTemplate,
	});
	return systemPrompt;
}

describe("system Handlebars prompt templates", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("parses and compiles every system template", async () => {
		const templates = await loadSystemPromptTemplates();
		expect(templates.size).toBeGreaterThan(0);

		for (const [fileName, template] of templates) {
			expect(() => Handlebars.parse(template), `Failed parsing ${fileName}`).not.toThrow();
			expect(() => Handlebars.compile(template), `Failed compiling ${fileName}`).not.toThrow();
		}
	});

	test("custom-system-prompt renders project section for context and git combinations", async () => {
		const templatePath = path.join(systemPromptsDir, "custom-system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const both = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [{ path: "a.txt", content: "A" }],
			git: { ...baseGitContext, isRepo: true },
		});
		expect(both).toContain("<project>");
		expect(both).toContain("## Context");
		expect(both).toContain("## Version Control");

		const contextOnly = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [{ path: "a.txt", content: "A" }],
			git: { isRepo: false },
		});
		expect(contextOnly).toContain("<project>");
		expect(contextOnly).toContain("## Context");
		expect(contextOnly).not.toContain("## Version Control");

		const gitOnly = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [],
			git: {
				isRepo: true,
				currentBranch: "feature/tests",
				mainBranch: "main",
				status: "clean",
				commits: "abc123 test commit",
			},
		});
		expect(gitOnly).toContain("<project>");
		expect(gitOnly).not.toContain("## Context");
		expect(gitOnly).toContain("## Version Control");

		const neither = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [],
			git: { isRepo: false },
		});
		expect(neither).not.toContain("<project>");
		expect(neither).not.toContain("## Context");
		expect(neither).not.toContain("## Version Control");
	});

	test("subagent system owns shared context while user prompt only owns assignment", async () => {
		const systemTemplate = await Bun.file(path.join(systemPromptsDir, "subagent-system-prompt.md")).text();
		const userTemplate = await Bun.file(path.join(systemPromptsDir, "subagent-user-prompt.md")).text();

		const subagentSystem = prompt.render(systemTemplate, {
			...baseRenderContext,
			context: "Shared task background",
			agent: "You are a task agent.",
		});
		const subagentUser = prompt.render(userTemplate, {
			...baseRenderContext,
			context: "Shared task background",
			assignment: "Do the task.",
		});

		expect(subagentSystem).toMatch(/CONTEXT\n=+\n\nShared task background/);
		expect(subagentSystem).toMatch(/ROLE\n=+/);
		expect(subagentUser).toContain("Complete the assignment below, thoroughly:");
		expect(subagentUser).toContain("Do the task.");
		expect(subagentUser).not.toMatch(/CONTEXT\n=+/);
		expect(subagentUser).not.toContain("Shared task background");
	});

	test("buildSystemPrompt gates memory root URL advertisement", async () => {
		const nativeTemplate = await Bun.file(path.join(systemPromptsDir, "system-prompt.md")).text();
		const baseOptions = {
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: createEmptyWorkspaceTree(os.tmpdir()),
			systemPromptTemplate: nativeTemplate,
		};

		const enabled = await buildSystemPrompt({
			...baseOptions,
			memoryRootEnabled: true,
		});
		const disabled = await buildSystemPrompt({
			...baseOptions,
			memoryRootEnabled: false,
		});
		const omitted = await buildSystemPrompt(baseOptions);

		expect(enabled.systemPrompt.join("\n\n")).toContain("memory://root");
		expect(disabled.systemPrompt.join("\n\n")).not.toContain("memory://root");
		expect(omitted.systemPrompt.join("\n\n")).not.toContain("memory://root");
	});

	test("raw --system-prompt keeps Handlebars expressions literal", async () => {
		await withTempDir(async dir => {
			const { options } = await captureRootCommandOptions(dir, { systemPrompt: "Literal {{cwd}}" });

			expect(options.systemPromptTemplate).toBeUndefined();
			expect(applyCapturedSystemPromptOverride(options)[0]).toBe("Literal {{cwd}}");
		});
	});

	test("separates raw custom prompts from rendered system templates", async () => {
		await withTempDir(async dir => {
			const commonOptions = {
				cwd: dir,
				skills: [],
				rules: [],
				toolNames: ["read"],
				workspaceTree: createEmptyWorkspaceTree(dir),
			};
			const raw = await buildSystemPrompt({
				...commonOptions,
				customPrompt: "Literal {{cwd}}",
				appendSystemPrompt: "Raw append {{cwd}}",
				contextFiles: [{ path: path.join(dir, "AGENTS.md"), content: "Raw context {{cwd}}" }],
			});
			const rendered = await buildSystemPrompt({
				...commonOptions,
				systemPromptTemplate: "Rendered {{cwd}}",
				contextFiles: [],
			});

			expect(raw.systemPrompt).toHaveLength(2);
			expect(raw.systemPrompt[0]).toContain("Literal {{cwd}}");
			expect(raw.systemPrompt[0]).toContain("Raw append {{cwd}}");
			expect(raw.systemPrompt[0]).toContain("Raw context {{cwd}}");
			expect(raw.systemPrompt[1]).not.toContain("Raw append {{cwd}}");
			expect(raw.systemPrompt[1]).not.toContain("Raw context {{cwd}}");
			expect(raw.dynamicParts).toContainEqual(
				expect.objectContaining({
					id: "append-prompt",
					source: "custom-system-prompt.md",
					providerBlockIndex: 0,
				}),
			);

			expect(rendered.systemPrompt).toHaveLength(2);
			expect(rendered.systemPrompt[0]).toBe(`Rendered ${dir}`);
			expect(rendered.systemPrompt[1]).toContain("<workstation>");
			expect(rendered.dynamicParts).toContainEqual(
				expect.objectContaining({
					id: "workstation",
					source: "project-prompt.md",
					providerBlockIndex: 1,
				}),
			);
		});
	});

	test("SYSTEM.template.md opts into Handlebars rendering", async () => {
		await withTempDir(async dir => {
			const configDir = path.join(dir, ".omp");
			const templatePath = path.join(configDir, "SYSTEM.template.md");
			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(templatePath, "Template {{cwd}}");

			const { options } = await captureRootCommandOptions(dir);
			const systemPrompt = await buildCapturedTemplatePrompt(dir, options);

			expect(options.systemPrompt).toBeUndefined();
			expect(options.systemPromptTemplate).toBe(templatePath);
			expect(systemPrompt[0]).toContain("Template ");
			expect(systemPrompt[0]).not.toContain("{{cwd}}");
		});
	});

	test("system-prompt inspect uses discovered SYSTEM.template.md", async () => {
		await withTempDir(async dir => {
			const templatePath = path.join(dir, ".omp", "SYSTEM.template.md");
			await fs.mkdir(path.dirname(templatePath), { recursive: true });
			await fs.writeFile(templatePath, "Inspect {{cwd}}");

			const inspected = await inspectSystemPrompt(dir);

			expect(inspected.systemPrompt[0]).toContain("Inspect ");
			expect(inspected.systemPrompt[0]).not.toContain("{{cwd}}");
		});
	});

	test("system-prompt inspect attributes discovered SYSTEM.template.md parts", async () => {
		await withTempDir(async dir => {
			const templatePath = path.join(dir, ".omp", "SYSTEM.template.md");
			await fs.mkdir(path.dirname(templatePath), { recursive: true });
			await fs.writeFile(templatePath, 'Before\n{{#inspectPart "custom-part"}}Dynamic{{/inspectPart}}\nAfter');

			const inspected = await inspectSystemPrompt(dir);
			const customPart = inspected.dynamicParts.find(part => part.id === "custom-part");

			expect(inspected.systemPrompt[0]).toBe("Before\nDynamic\nAfter");
			expect(customPart).toEqual({
				id: "custom-part",
				source: "SYSTEM.template.md",
				providerBlockIndex: 0,
				text: "Dynamic",
			});
		});
	});

	test("system-prompt inspect attributes discovered APPEND_SYSTEM.md as a raw dynamic part", async () => {
		await withTempDir(async dir => {
			const appendPath = path.join(dir, ".omp", "APPEND_SYSTEM.md");
			await fs.mkdir(path.dirname(appendPath), { recursive: true });
			await fs.writeFile(appendPath, "Inspect append {{date}}");

			const inspected = await inspectSystemPrompt(dir);
			const appendPart = inspected.dynamicParts.find(part => part.id === "append-system-prompt");

			expect(appendPart).toBeDefined();
			expect(appendPart?.source).toBe("append-system-prompt");
			expect(appendPart?.providerBlockIndex).toBe(inspected.systemPrompt.length - 1);
			expect(appendPart?.text).toBe("Inspect append {{date}}");
		});
	});

	test("--system-prompt raw wins over discovered SYSTEM.template.md", async () => {
		await withTempDir(async dir => {
			const configDir = path.join(dir, ".omp");
			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(path.join(configDir, "SYSTEM.template.md"), "Template {{cwd}}");

			const { options } = await captureRootCommandOptions(dir, { systemPrompt: "Literal {{cwd}}" });

			expect(options.systemPromptTemplate).toBeUndefined();
			expect(applyCapturedSystemPromptOverride(options)[0]).toBe("Literal {{cwd}}");
		});
	});

	test("subagent template discovery returns undefined without a configured source", async () => {
		await withTempDir(async dir => {
			const originalConfigDir = process.env.PI_CONFIG_DIR;
			const configDirName = `.omp-test-${path.basename(dir)}`;
			process.env.PI_CONFIG_DIR = configDirName;
			try {
				expect(discoverSubagentSystemPromptTemplate(dir)).toBeUndefined();
			} finally {
				if (originalConfigDir === undefined) {
					delete process.env.PI_CONFIG_DIR;
				} else {
					process.env.PI_CONFIG_DIR = originalConfigDir;
				}
			}
		});
	});

	test("subagent template discovery selects the user source", async () => {
		await withTempDir(async dir => {
			const originalConfigDir = process.env.PI_CONFIG_DIR;
			const configDirName = `.omp-test-${path.basename(dir)}`;
			const userConfigDir = path.join(os.homedir(), configDirName, "agent");
			const templatePath = path.join(userConfigDir, "SUBAGENT-SYSTEM.template.md");
			process.env.PI_CONFIG_DIR = configDirName;
			try {
				await fs.mkdir(userConfigDir, { recursive: true });
				await fs.writeFile(templatePath, "User child template");
				expect(discoverSubagentSystemPromptTemplate(dir)).toBe(templatePath);
			} finally {
				await fs.rm(path.join(os.homedir(), configDirName), { recursive: true, force: true });
				if (originalConfigDir === undefined) {
					delete process.env.PI_CONFIG_DIR;
				} else {
					process.env.PI_CONFIG_DIR = originalConfigDir;
				}
			}
		});
	});

	test("subagent template discovery prefers the project source", async () => {
		await withTempDir(async dir => {
			const originalConfigDir = process.env.PI_CONFIG_DIR;
			const configDirName = `.omp-test-${path.basename(dir)}`;
			const userConfigDir = path.join(os.homedir(), configDirName, "agent");
			const projectTemplatePath = path.join(dir, ".omp", "SUBAGENT-SYSTEM.template.md");
			process.env.PI_CONFIG_DIR = configDirName;
			try {
				await fs.mkdir(userConfigDir, { recursive: true });
				await fs.mkdir(path.dirname(projectTemplatePath), { recursive: true });
				await fs.writeFile(path.join(userConfigDir, "SUBAGENT-SYSTEM.template.md"), "User child template");
				await fs.writeFile(projectTemplatePath, "Project child template");
				expect(discoverSubagentSystemPromptTemplate(dir)).toBe(projectTemplatePath);
			} finally {
				await fs.rm(path.join(os.homedir(), configDirName), { recursive: true, force: true });
				if (originalConfigDir === undefined) {
					delete process.env.PI_CONFIG_DIR;
				} else {
					process.env.PI_CONFIG_DIR = originalConfigDir;
				}
			}
		});
	});

	test("project SYSTEM.md suppresses project SYSTEM.template.md with a warning", async () => {
		await withTempDir(async dir => {
			const rawPath = path.join(dir, ".omp", "SYSTEM.md");
			const templatePath = path.join(dir, ".omp", "SYSTEM.template.md");
			await fs.mkdir(path.dirname(rawPath), { recursive: true });
			await fs.writeFile(rawPath, "Raw {{cwd}}");
			await fs.writeFile(templatePath, "Template {{cwd}}");

			const { options, stderr } = await captureRootCommandOptions(dir);

			expect(options.systemPromptTemplate).toBeUndefined();
			expect(applyCapturedSystemPromptOverride(options)[0]).toBe("Raw {{cwd}}");
			expect(stderr).toContain(rawPath);
			expect(stderr).toContain(templatePath);
		});
	});

	test("project SYSTEM.template.md wins over user SYSTEM.md", async () => {
		await withTempDir(async dir => {
			const configDirName = `.omp-test-${path.basename(dir)}`;
			const userConfigDir = path.join(os.homedir(), configDirName, "agent");
			try {
				const templatePath = path.join(dir, ".omp", "SYSTEM.template.md");
				await fs.mkdir(path.dirname(templatePath), { recursive: true });
				await fs.mkdir(userConfigDir, { recursive: true });
				await fs.writeFile(templatePath, "Project template {{cwd}}");
				await fs.writeFile(path.join(userConfigDir, "SYSTEM.md"), "User raw {{cwd}}");

				const { options } = await captureRootCommandOptions(dir, {}, configDirName);

				expect(options.systemPrompt).toBeUndefined();
				expect(options.systemPromptTemplate).toBe(templatePath);
			} finally {
				await fs.rm(path.join(os.homedir(), configDirName), { recursive: true, force: true });
			}
		});
	});

	test("user SYSTEM.md suppresses user SYSTEM.template.md with a warning", async () => {
		await withTempDir(async dir => {
			const configDirName = `.omp-test-${path.basename(dir)}`;
			const userConfigDir = path.join(os.homedir(), configDirName, "agent");
			try {
				const rawPath = path.join(userConfigDir, "SYSTEM.md");
				const templatePath = path.join(userConfigDir, "SYSTEM.template.md");
				await fs.mkdir(path.dirname(rawPath), { recursive: true });
				await fs.writeFile(rawPath, "User raw {{cwd}}");
				await fs.writeFile(templatePath, "User template {{cwd}}");

				const { options, stderr } = await captureRootCommandOptions(dir, {}, configDirName);

				expect(options.systemPromptTemplate).toBeUndefined();
				expect(applyCapturedSystemPromptOverride(options)[0]).toBe("User raw {{cwd}}");
				expect(stderr).toContain(rawPath);
				expect(stderr).toContain(templatePath);
			} finally {
				await fs.rm(path.join(os.homedir(), configDirName), { recursive: true, force: true });
			}
		});
	});
	test("user SYSTEM.template.md wins over the built-in default", async () => {
		await withTempDir(async dir => {
			const configDirName = `.omp-test-${path.basename(dir)}`;
			const userConfigDir = path.join(os.homedir(), configDirName, "agent");
			try {
				const templatePath = path.join(userConfigDir, "SYSTEM.template.md");
				await fs.mkdir(path.dirname(templatePath), { recursive: true });
				await fs.writeFile(templatePath, "User template {{cwd}}");

				const { options } = await captureRootCommandOptions(dir, {}, configDirName);
				const systemPrompt = await buildCapturedTemplatePrompt(dir, options);

				expect(options.systemPrompt).toBeUndefined();
				expect(options.systemPromptTemplate).toBe(templatePath);
				expect(systemPrompt[0]).toContain("User template ");
				expect(systemPrompt[0]).not.toContain("{{cwd}}");
			} finally {
				await fs.rm(path.join(os.homedir(), configDirName), { recursive: true, force: true });
			}
		});
	});

	test("system prompt template content that looks like a path stays literal", async () => {
		await withTempDir(async dir => {
			const templatePath = path.join(dir, ".omp", "SYSTEM.template.md");
			await fs.mkdir(path.dirname(templatePath), { recursive: true });
			await fs.writeFile(templatePath, "README.md");

			const { options } = await captureRootCommandOptions(dir);
			const systemPrompt = await buildCapturedTemplatePrompt(dir, options);

			expect(options.systemPromptTemplate).toBe(templatePath);
			expect(systemPrompt[0]).toBe("README.md");
		});
	});

	test("invalid discovered system prompt template hard fails", async () => {
		await withTempDir(async dir => {
			const templatePath = path.join(dir, ".omp", "SYSTEM.template.md");
			await fs.mkdir(path.dirname(templatePath), { recursive: true });
			await fs.writeFile(templatePath, "{{#if}}");

			const { options } = await captureRootCommandOptions(dir);

			await expect(buildCapturedTemplatePrompt(dir, options)).rejects.toThrow();
		});
	});

	test("buildSystemPrompt keeps system and project as separate ordered blocks with date context in project", async () => {
		await withTempDir(async dir => {
			const nativeTemplate = await Bun.file(path.join(systemPromptsDir, "system-prompt.md")).text();
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				workspaceTree: {
					rootPath: dir,
					rendered: ".\n  - src/        1m",
					truncated: false,
					totalLines: 2,
					agentsMdFiles: [],
				},
				includeWorkspaceTree: true,
				systemPromptTemplate: nativeTemplate,
			});

			expect(systemPrompt).toHaveLength(2);
			expect(systemPrompt[0]).toMatch(/CONTRACT\n=+/);
			expect(systemPrompt[0]).not.toContain("current working directory");
			expect(systemPrompt[1]).toContain("<workstation>");
			expect(systemPrompt[1]).toContain("<workspace-tree>");
			expect(systemPrompt[1]).toContain("Today is ");
			expect(systemPrompt[1]).toContain(`current working directory is '${dir}'.`);
			expect(systemPrompt[1].indexOf("</workspace-tree>")).toBeLessThan(systemPrompt[1].indexOf("Today is "));
		});
	});

	test("system prompt template copy of native template renders identically to default", async () => {
		await withTempDir(async dir => {
			const nativeTemplate = await Bun.file(path.join(systemPromptsDir, "system-prompt.md")).text();
			const options = {
				cwd: dir,
				contextFiles: [],
				skills: [
					{
						name: "skill-template-review",
						description: "Reviews prompt templates for rendered dynamic data",
						filePath: "/tmp/skill-template-review/SKILL.md",
						baseDir: "/tmp/skill-template-review",
						source: "native:user",
					},
				],
				rules: [
					{
						name: "paperless-docs",
						description: "Use Paperless for documents",
						path: "/tmp/rule.md",
						globs: ["**/*.md"],
					},
				],
				toolNames: ["read", "search"],
				tools: new Map([
					["read", { label: "Read", description: "Reads files" }],
					["search", { label: "Search", description: "Searches files" }],
				]),
				workspaceTree: {
					rootPath: dir,
					rendered: ".\n  - src/        1m",
					truncated: false,
					totalLines: 2,
					agentsMdFiles: [],
				},
			};

			const nativePrompt = await buildSystemPrompt(options);
			const copiedPrompt = await buildSystemPrompt({ ...options, systemPromptTemplate: nativeTemplate });

			expect(copiedPrompt.systemPrompt).toEqual(nativePrompt.systemPrompt);
		});
	});

	test("system prompt template renders with the native prompt data model", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [
				{
					name: "skill-template-review",
					description: "Reviews prompt templates for rendered dynamic data",
					filePath: "/tmp/skill-template-review/SKILL.md",
					baseDir: "/tmp/skill-template-review",
					source: "native:user",
				},
			],
			rules: [],
			toolNames: ["read", "write"],
			tools: new Map([
				["read", { label: "Read", description: "Reads files" }],
				["write", { label: "Write", description: "Writes files" }],
			]),
			xdevTools: [{ name: "momp_xdev_smoke", summary: "Momp xdev smoke" }],
			xdevDocs: "XDEV_DOCS_SENTINEL",
			autoQaEnabled: true,
			systemPromptTemplate: [
				"{{#if skills.length}}",
				"{{#each skills}}",
				"- {{name}}: {{description}}",
				"{{/each}}",
				"{{/if}}",
				"{{#if xdevTools.length}}{{xdevDocs}}|{{autoQaEnabled}}|{{toolRefs.write}}{{/if}}",
			].join("\n"),
		});

		expect(systemPrompt[0]).toContain("- skill-template-review: Reviews prompt templates for rendered dynamic data");
		expect(systemPrompt[0]).not.toContain("{{#if skills.length}}");
		expect(systemPrompt[0]).toContain("XDEV_DOCS_SENTINEL|true|write");
	});
	test("buildSystemPrompt renders workspace tree after directory context in project prompt", async () => {
		await withTempDir(async dir => {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				workspaceTree: {
					rootPath: dir,
					rendered: ".\n  - src/        1m",
					truncated: true,
					totalLines: 2,
					agentsMdFiles: ["packages/coding-agent/AGENTS.md"],
				},
				includeWorkspaceTree: true,
			});

			const projectPrompt = systemPrompt[1] ?? "";

			expect(projectPrompt).toContain("<workspace-tree>");
			expect(projectPrompt).toContain("Working directory layout (sorted by mtime, recent first; depth ≤ 3):");
			expect(projectPrompt).toContain("(some entries elided to keep the tree short");
			expect(projectPrompt.indexOf("</dir-context>")).toBeLessThan(projectPrompt.indexOf("<workspace-tree>"));
		});
	});

	test("system prompt template does not auto-backfill always-apply rules omitted by the template", async () => {
		const omittedRule = "Surface failures explicitly to callers.";

		const tempDir = os.tmpdir();
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: createEmptyWorkspaceTree(tempDir),
			systemPromptTemplate: "Custom guidance without rule placeholders.",
			alwaysApplyRules: [{ name: "truthful-failures", content: omittedRule, path: "/tmp/truthful-failures.md" }],
		});

		const prompt = systemPrompt.join("\n\n");

		expect(prompt).toContain("Custom guidance without rule placeholders.");
		expect(prompt).not.toContain(omittedRule);
	});

	test("system prompt template renders deduped always-apply rules through the native data model", async () => {
		const duplicateRule = ["Keep functions small.", "", "Extract shared helpers on the second use."].join("\n");
		const distinctRule = "Surface failures explicitly to callers.";

		const { systemPrompt } = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: createEmptyWorkspaceTree(os.tmpdir()),
			systemPromptTemplate: [
				"Custom guidance",
				"",
				duplicateRule,
				"",
				"{{#each alwaysApplyRules}}",
				"{{content}}",
				"{{/each}}",
			].join("\n"),
			alwaysApplyRules: [
				{ name: "small-functions", content: duplicateRule, path: "/tmp/small-functions.md" },
				{ name: "truthful-failures", content: distinctRule, path: "/tmp/truthful-failures.md" },
			],
		});

		const prompt = systemPrompt.join("\n\n");

		expect(countOccurrences(prompt, "Keep functions small.")).toBe(1);
		expect(countOccurrences(prompt, "Extract shared helpers on the second use.")).toBe(1);
		expect(countOccurrences(prompt, distinctRule)).toBe(1);
	});

	test("raw append system prompt inputs keep Handlebars expressions literal", async () => {
		await withTempDir(async dir => {
			const configDirName = `.omp-test-${path.basename(dir)}`;
			const cliAppend = await captureRootCommandOptions(
				dir,
				{ appendSystemPrompt: "CLI append {{date}}" },
				configDirName,
			);

			expect(applyCapturedSystemPromptOverride(cliAppend.options)).toEqual([
				"Default base",
				"Default project",
				"CLI append {{date}}",
			]);
		});

		await withTempDir(async dir => {
			const appendPath = path.join(dir, ".omp", "APPEND_SYSTEM.md");
			await fs.mkdir(path.dirname(appendPath), { recursive: true });
			await fs.writeFile(appendPath, "File append {{date}}");

			const discoveredAppend = await captureRootCommandOptions(dir, {}, `.omp-test-${path.basename(dir)}`);

			expect(applyCapturedSystemPromptOverride(discoveredAppend.options)).toEqual([
				"Default base",
				"Default project",
				"File append {{date}}",
			]);
		});
		await withTempDir(async dir => {
			const rawAndAppend = await captureRootCommandOptions(
				dir,
				{
					systemPrompt: "Raw {{date}}",
					appendSystemPrompt: "Append {{date}}",
				},
				`.omp-test-${path.basename(dir)}`,
			);

			expect(applyCapturedSystemPromptOverride(rawAndAppend.options)).toEqual([
				"Raw {{date}}",
				"Default project",
				"Append {{date}}",
			]);
		});
	});

	test("buildSystemPromptToolMetadata captures custom wire names", () => {
		const editTool = {
			name: "edit",
			label: "Edit",
			description: "Edits files",
			parameters: z.object({}),
			customWireName: "apply_patch",
			execute: async () => ({ content: [] }),
		} satisfies AgentTool;

		const metadata = buildSystemPromptToolMetadata(new Map([["edit", editTool]]));

		expect(metadata.get("edit")?.wireName).toBe("apply_patch");
	});

	test("buildSystemPrompt references overridden tool wire names", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "search", "find", "edit", "lsp", "bash", "eval"],
			workspaceTree: createEmptyWorkspaceTree(os.tmpdir()),
			tools: new Map([
				["read", { label: "Read", description: "Reads files" }],
				["search", { label: "Search", description: "Searches files" }],
				["find", { label: "Find", description: "Finds files" }],
				["edit", { label: "Edit", description: "Edits files", wireName: "apply_patch" }],
				["lsp", { label: "LSP", description: "Queries language servers" }],
				["bash", { label: "Bash", description: "Runs shell commands" }],
				["eval", { label: "Eval", description: "Runs eval cells" }],
			]),
		});

		const promptText = systemPrompt.join("\n\n");

		expect(promptText).toContain("Edit: `apply_patch`");
		expect(promptText).toContain("`apply_patch`");
		expect(promptText).not.toContain("Edit: `edit`");
	});

	test("buildSystemPrompt reads CPU info without os.cpus", async () => {
		const cpusSpy = vi.spyOn(os, "cpus").mockImplementation(() => {
			throw new Error("os.cpus() failed");
		});

		const { systemPrompt } = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: createEmptyWorkspaceTree(os.tmpdir()),
		});

		const projectPrompt = systemPrompt[1] ?? "";

		const workstation = /<workstation>\n(?<content>[\s\S]*?)\n<\/workstation>/u.exec(projectPrompt)?.groups?.content;
		expect(workstation).toContain("OS:");
		expect(workstation).toContain("CPU:");
		expect(cpusSpy).not.toHaveBeenCalled();
	});
});
