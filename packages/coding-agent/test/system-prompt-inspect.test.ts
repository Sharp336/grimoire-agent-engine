import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import SystemPromptCommand, { formatInspectOutput, type SystemPromptInspection } from "../src/commands/system-prompt";
import { buildSystemPrompt, type DynamicPromptPart, type SystemPromptToolMetadata } from "../src/system-prompt";

const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");
const PIPE_BUFFER_BYTES = 64 * 1024;
const LARGE_PROMPT_BYTES = PIPE_BUFFER_BYTES + 32 * 1024;

const tools = new Map<string, SystemPromptToolMetadata>([
	["read", { wireName: "read", label: "Read", description: "Read files" }],
	["grep", { wireName: "grep", label: "Grep", description: "Search file contents" }],
	["glob", { wireName: "glob", label: "Glob", description: "Find paths" }],
	["lsp", { wireName: "lsp", label: "LSP", description: "Language server" }],
	["ast_grep", { wireName: "ast_grep", label: "AST Grep", description: "Search syntax trees" }],
	["ast_edit", { wireName: "ast_edit", label: "AST Edit", description: "Rewrite syntax trees" }],
	["inspect_image", { wireName: "inspect_image", label: "Inspect Image", description: "Inspect images" }],
	["task", { wireName: "task", label: "Task", description: "Subagents" }],
]);

function part(parts: DynamicPromptPart[], id: string): DynamicPromptPart {
	const found = parts.find(p => p.id === id);
	expect(found).toBeDefined();
	return found!;
}

describe("system prompt inspect metadata", () => {
	test("attributes every inspectable fragment to its provider block", async () => {
		const result = await buildSystemPrompt({
			cwd: "/tmp/inspect-project",
			tools,
			toolNames: ["read", "grep", "glob", "lsp", "ast_grep", "ast_edit", "inspect_image", "task"],
			skills: [
				{
					name: "skill-a",
					description: "Skill A",
					filePath: "/tmp/skill-a/SKILL.md",
					baseDir: "/tmp/skill-a",
					source: "native:user",
				},
			],
			rules: [{ name: "rule-a", description: "Rule A", path: "rule://rule-a", globs: ["**/*.ts"] }],
			alwaysApplyRules: [{ name: "always-a", content: "Always rule body", path: "rule://always-a" }],
			contextFiles: [{ path: "/tmp/inspect-project/AGENTS.md", content: "Agent context" }],
			workspaceTree: {
				rootPath: "/tmp/inspect-project",
				rendered: ".\n  - package.json",
				truncated: true,
				totalLines: 2,
				agentsMdFiles: ["nested/AGENTS.md"],
			},
			includeWorkspaceTree: true,
			appendSystemPrompt: "Memory text\n\nMCP text\n\nAuto-learn text",
			appendSystemPromptParts: [
				{ id: "memory-instructions", source: "memory", text: "Memory text" },
				{ id: "mcp-server-instructions", source: "mcp", text: "MCP text" },
				{ id: "auto-learn-instructions", source: "auto-learn", text: "Auto-learn text" },
			],
			intentField: "i",
			eagerTasks: true,
			secretsEnabled: true,
			renderMermaid: true,
			activeRepoContext: {
				cwd: "/tmp/inspect-project",
				repoRoot: "/tmp/inspect-project/repo",
				relativeRepoRoot: "repo",
				source: "single-direct-child-repo",
			},
		});

		expect(result.systemPrompt).toHaveLength(3);
		expect(result.dynamicParts.map(promptPart => promptPart.id)).toEqual(
			expect.arrayContaining([
				"mermaid",
				"skills",
				"always-apply-rules",
				"rules",
				"tool-inventory",
				"intent-tracing",
				"secrets",
				"images",
				"tool-priority",
				"lsp",
				"ast-tools",
				"eager-tasks",
				"workstation",
				"context-files",
				"dir-context",
				"workspace-tree",
				"cwd-date",
				"append-prompt",
				"memory-instructions",
				"mcp-server-instructions",
				"auto-learn-instructions",
				"active-repo-context",
			]),
		);
		expect(part(result.dynamicParts, "skills").text).toContain("skill-a: Skill A");
		expect(part(result.dynamicParts, "rules").text).toContain("rule-a");
		expect(part(result.dynamicParts, "always-apply-rules").text).toContain("Always rule body");
		expect(part(result.dynamicParts, "context-files").text).toContain("Agent context");
		expect(part(result.dynamicParts, "workspace-tree").text).toContain("use `glob`/`read` to drill in");
		expect(part(result.dynamicParts, "tool-priority").text).toContain("Regex search → `grep`");
		expect(part(result.dynamicParts, "tool-priority").text).toContain("Globbing → `glob`");
		expect(part(result.dynamicParts, "ast-tools").text).toContain("Use `grep` only for plain-text lookup");
		expect(part(result.dynamicParts, "mermaid").text).toContain("```mermaid");
		expect(part(result.dynamicParts, "memory-instructions")).toMatchObject({
			source: "memory",
			providerBlockIndex: 1,
		});
		expect(part(result.dynamicParts, "mcp-server-instructions")).toMatchObject({
			source: "mcp",
			providerBlockIndex: 1,
		});
		expect(part(result.dynamicParts, "auto-learn-instructions")).toMatchObject({
			source: "auto-learn",
			providerBlockIndex: 1,
		});
		expect(part(result.dynamicParts, "active-repo-context")).toMatchObject({
			source: "active-repo-context.md",
			providerBlockIndex: 2,
		});
		expect(
			result.dynamicParts.every(promptPart =>
				result.systemPrompt[promptPart.providerBlockIndex]?.includes(promptPart.text),
			),
		).toBe(true);
		expect(result.systemPrompt.every(block => !block.includes("inspectPart"))).toBe(true);
		expect(result.dynamicParts.every(promptPart => !promptPart.text.includes("You are a helpful assistant"))).toBe(
			true,
		);
	});

	test("does not attribute static custom prompt text as dynamic", async () => {
		const result = await buildSystemPrompt({
			cwd: "/tmp/inspect-project",
			customPrompt: "Static custom SYSTEM body",
			tools,
			toolNames: ["read", "lsp"],
			contextFiles: [],
			skills: [],
			workspaceTree: {
				rootPath: "/tmp/inspect-project",
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			activeRepoContext: null,
		});

		expect(result.systemPrompt[0]).toContain("Static custom SYSTEM body");
		expect(result.dynamicParts.every(p => p.source !== "system-prompt.md")).toBe(true);
		expect(result.dynamicParts.every(p => !p.text.includes("Static custom SYSTEM body"))).toBe(true);
	});

	test("attributes resolved custom-prompt append fragments to provider block zero", async () => {
		const result = await buildSystemPrompt({
			cwd: "/tmp/inspect-project",
			resolvedCustomPrompt: "Static custom SYSTEM body",
			resolvedAppendSystemPrompt: "Memory text",
			appendSystemPromptParts: [{ id: "memory-instructions", source: "memory", text: "Memory text" }],
			tools,
			toolNames: ["read", "lsp"],
			contextFiles: [],
			skills: [],
			workspaceTree: {
				rootPath: "/tmp/inspect-project",
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			activeRepoContext: null,
		});

		expect(result.systemPrompt).toHaveLength(2);
		expect(result.systemPrompt[0]).toContain("Static custom SYSTEM body");
		expect(result.systemPrompt[0]).toContain("Memory text");
		expect(result.systemPrompt[1]).not.toContain("Memory text");
		expect(part(result.dynamicParts, "append-prompt")).toMatchObject({
			source: "custom-system-prompt.md",
			providerBlockIndex: 0,
		});
		expect(part(result.dynamicParts, "memory-instructions")).toMatchObject({
			source: "memory",
			providerBlockIndex: 0,
		});
	});
});

describe("system-prompt inspect output", () => {
	const result = {
		systemPrompt: ["System block", "Project block"],
		dynamicParts: [
			{
				id: "append-system-prompt",
				source: "append-system-prompt" as const,
				providerBlockIndex: 2,
				text: "Append text",
			},
		],
	};

	test("system-prompt inspect --json exposes provider blocks", () => {
		const parsed = JSON.parse(formatInspectOutput("/tmp/project", result, { mode: "provider", json: true }));
		expect(parsed).toEqual({
			cwd: "/tmp/project",
			mode: "provider",
			blocks: [
				{ index: 0, text: "System block" },
				{ index: 1, text: "Project block" },
			],
		});
	});

	test("system-prompt inspect --dynamic-parts --json exposes provider block indexes", () => {
		const parsed = JSON.parse(formatInspectOutput("/tmp/project", result, { mode: "dynamic-parts", json: true }));
		expect(parsed).toEqual({
			cwd: "/tmp/project",
			mode: "dynamic-parts",
			blocks: result.dynamicParts,
		});
	});

	test("system-prompt inspect --breakdown --json separates source, tool prompt, and schema shares", () => {
		const inspection: SystemPromptInspection = {
			...result,
			model: { provider: "openai-codex", id: "gpt-5.4" },
			providerTools: [
				{
					name: "read",
					description: "Read files",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
						additionalProperties: false,
					},
					customFormat: { syntax: "lark", definition: "start: PATH" },
				},
			],
		};
		const parsed = JSON.parse(formatInspectOutput("/tmp/project", inspection, { mode: "breakdown", json: true })) as {
			mode: string;
			tokenizer: { provider: string; encoding: string };
			measurementScope: { includes: string[]; excludes: string[] };
			totalMeasuredContextTokens: number;
			categories: {
				providerPrompt: { tokens: number; percentOfMeasuredContext: number };
				toolPrompts: { tokens: number; percentOfMeasuredContext: number };
				toolSchemas: { tokens: number; percentOfMeasuredContext: number };
			};
			dynamicParts: Array<{ id: string; source: string; tokens: number; percentOfMeasuredContext: number }>;
			dynamicSources: Array<{ source: string; tokens: number; percentOfMeasuredContext: number }>;
			dynamicPercentagesMayOverlap: boolean;
			tools: Array<{
				name: string;
				prompt: { tokens: number; percentOfMeasuredContext: number };
				schema: { tokens: number; percentOfMeasuredContext: number };
			}>;
		};
		const providerTokens = countTokens(inspection.systemPrompt, Encoding.O200kBase);
		const promptTokens = countTokens(["Read files"], Encoding.O200kBase);
		const inspectedTool = inspection.providerTools[0];
		const schemaTokens = countTokens(
			[`${JSON.stringify(inspectedTool?.parameters ?? {})}\n${JSON.stringify(inspectedTool?.customFormat ?? {})}`],
			Encoding.O200kBase,
		);

		expect(parsed).toMatchObject({
			mode: "breakdown",
			tokenizer: { provider: "openai", encoding: "o200k_base" },
			measurementScope: {
				includes: expect.arrayContaining(["tool parameter schemas and grammars"]),
				excludes: expect.arrayContaining(["provider-specific request framing and control metadata"]),
			},
			totalMeasuredContextTokens: providerTokens + promptTokens + schemaTokens,
			dynamicPercentagesMayOverlap: true,
		});
		expect(parsed.categories.providerPrompt.tokens).toBe(providerTokens);
		expect(parsed.categories.toolPrompts.tokens).toBe(promptTokens);
		expect(parsed.categories.toolSchemas.tokens).toBe(schemaTokens);
		expect(parsed.dynamicParts).toEqual([
			expect.objectContaining({
				id: "append-system-prompt",
				source: "append-system-prompt",
				tokens: countTokens(["Append text"], Encoding.O200kBase),
			}),
		]);
		expect(parsed.dynamicSources).toEqual([
			expect.objectContaining({
				source: "append-system-prompt",
				tokens: countTokens(["Append text"], Encoding.O200kBase),
			}),
		]);
		expect(parsed.tools).toEqual([
			expect.objectContaining({
				name: "read",
				prompt: expect.objectContaining({ tokens: promptTokens }),
				schema: expect.objectContaining({ tokens: schemaTokens }),
			}),
		]);
		expect(
			parsed.categories.providerPrompt.percentOfMeasuredContext +
				parsed.categories.toolPrompts.percentOfMeasuredContext +
				parsed.categories.toolSchemas.percentOfMeasuredContext,
		).toBeCloseTo(100, 1);
		expect(parsed.dynamicParts[0]?.percentOfMeasuredContext).toBeGreaterThan(0);
		expect(parsed.dynamicSources[0]?.percentOfMeasuredContext).toBeGreaterThan(0);
	});
});

describe("system-prompt command", () => {
	test("parses inspect flags", async () => {
		const command = new SystemPromptCommand(["inspect", "--cwd", "/tmp", "--dynamic-parts", "--json"], TEST_CONFIG);
		const parsed = await command.parse(SystemPromptCommand);
		expect(parsed.args.action).toBe("inspect");
		expect(parsed.flags.cwd).toBe("/tmp");
		expect(parsed.flags["dynamic-parts"]).toBe(true);
		expect(parsed.flags.json).toBe(true);
	});

	test("parses the breakdown flag", async () => {
		const command = new SystemPromptCommand(["inspect", "--breakdown", "--json"], TEST_CONFIG);
		const parsed = await command.parse(SystemPromptCommand);
		expect(parsed.flags.breakdown).toBe(true);
		expect(parsed.flags.json).toBe(true);
	});

	test("writes provider JSON larger than the stdout pipe buffer completely", async () => {
		const tempDir = TempDir.createSync("@omp-system-prompt-inspect-");
		const marker = "large-provider-prompt-marker";
		const projectDir = path.join(tempDir.path(), "project");
		const agentDir = path.join(tempDir.path(), "agent");
		try {
			await Bun.write(path.join(projectDir, "AGENTS.md"), `${marker}\n${"x".repeat(LARGE_PROMPT_BYTES)}`);
			await Bun.write(
				path.join(agentDir, "settings.json"),
				JSON.stringify({ modelRoles: { default: "anthropic/claude-sonnet-4-5" } }),
			);
			const proc = Bun.spawn(
				[process.execPath, CLI_ENTRY, "system-prompt", "inspect", "--cwd", projectDir, "--provider", "--json"],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...process.env,
						ANTHROPIC_API_KEY: "test-key",
						NO_COLOR: "1",
						PI_CODING_AGENT_DIR: agentDir,
					},
				},
			);
			const stdout = new Response(proc.stdout).text();
			const stderr = new Response(proc.stderr).text();
			const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);

			expect({ exitCode, error }).toEqual({ exitCode: 0, error: "" });
			expect(output.length).toBeGreaterThan(PIPE_BUFFER_BYTES);
			const parsed = JSON.parse(output) as { blocks: Array<{ text: string }> };
			expect(parsed.blocks.some(block => block.text.includes(marker))).toBe(true);
		} finally {
			await tempDir.remove();
		}
	});

	test("rejects combined output modes", async () => {
		const command = new SystemPromptCommand(["inspect", "--provider", "--dynamic-parts"], TEST_CONFIG);
		await expect(command.run()).rejects.toThrow("Use only one of --provider, --dynamic-parts, or --breakdown");
	});
});
