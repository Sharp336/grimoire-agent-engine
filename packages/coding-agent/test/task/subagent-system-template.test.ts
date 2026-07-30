import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function model(): Model<Api> {
	return buildModel({
		provider: "test",
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		baseUrl: "https://test.example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

async function withTemplateEnvironment(
	run: (paths: { projectDir: string; projectTemplate: string; userTemplate: string }) => Promise<void>,
): Promise<void> {
	const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-template-"));
	const projectDir = path.join(fixtureDir, "project");
	const testHome = path.join(fixtureDir, "home");
	const configDirName = `.omp-test-${path.basename(fixtureDir)}`;
	const originalConfigDir = process.env.PI_CONFIG_DIR;
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(testHome, { recursive: true });
	const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(testHome);
	try {
		process.env.PI_CONFIG_DIR = configDirName;
		const userConfigDir = path.join(testHome, configDirName, "agent");
		await run({
			projectDir,
			projectTemplate: path.join(projectDir, ".omp", "SUBAGENT-SYSTEM.template.md"),
			userTemplate: path.join(userConfigDir, "SUBAGENT-SYSTEM.template.md"),
		});
	} finally {
		homedirSpy.mockRestore();
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		await fs.rm(fixtureDir, { recursive: true, force: true });
	}
}

async function executeAndCaptureSystemPrompt(cwd: string): Promise<string[]> {
	let capturedPrompt: string[] | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("Expected createAgentSession options");
		if (typeof options.systemPrompt !== "function") throw new Error("Expected a child system prompt callback");
		const renderedPrompt = options.systemPrompt(["base-block", "project-block"]);
		capturedPrompt = typeof renderedPrompt === "string" ? [renderedPrompt] : renderedPrompt;
		return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
	});
	const testModel = model();
	const agent: AgentDefinition = {
		name: "scout",
		description: "test",
		systemPrompt: "Rendered scout role",
		source: "bundled",
	};
	const result = await runSubprocess({
		cwd,
		agent,
		task: "work",
		index: 0,
		id: "subagent-template-test",
		modelOverride: "test/test-model",
		settings: Settings.isolated(),
		modelRegistry: {
			refresh: async () => {},
			getAvailable: () => [testModel],
			getApiKey: async () => "test-key",
		} as never,
		enableLsp: false,
	});
	if (result.error) throw new Error(result.error);
	if (!capturedPrompt) throw new Error("Expected the child system prompt to be captured");
	return capturedPrompt;
}

describe("subagent system prompt templates", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test.serial("uses the bundled wrapper between provider sentinel blocks", async () => {
		await withTemplateEnvironment(async ({ projectDir }) => {
			const blocks = await executeAndCaptureSystemPrompt(projectDir);
			expect(blocks[0]).toBe("base-block");
			expect(blocks[1]).toContain("COOP");
			expect(blocks[1]).toContain("Rendered scout role");
			expect(blocks[2]).toBe("project-block");
		});
	});

	test.serial("renders a user template", async () => {
		await withTemplateEnvironment(async ({ projectDir, userTemplate }) => {
			await fs.mkdir(path.dirname(userTemplate), { recursive: true });
			await fs.writeFile(userTemplate, "USER-SUBAGENT-MARKER {{agent}}");
			const blocks = await executeAndCaptureSystemPrompt(projectDir);
			expect(blocks[1]).toBe("USER-SUBAGENT-MARKER Rendered scout role");
		});
	});

	test.serial("prefers a project template over the user template", async () => {
		await withTemplateEnvironment(async ({ projectDir, projectTemplate, userTemplate }) => {
			await fs.mkdir(path.dirname(projectTemplate), { recursive: true });
			await fs.mkdir(path.dirname(userTemplate), { recursive: true });
			await fs.writeFile(userTemplate, "USER-SUBAGENT-MARKER {{agent}}");
			await fs.writeFile(projectTemplate, "PROJECT-SUBAGENT-MARKER {{agent}}");
			const blocks = await executeAndCaptureSystemPrompt(projectDir);
			expect(blocks[1]).toContain("PROJECT-SUBAGENT-MARKER Rendered scout role");
			expect(blocks[1]).not.toContain("USER-SUBAGENT-MARKER");
		});
	});

	test.serial("rejects an empty selected template before dispatch", async () => {
		await withTemplateEnvironment(async ({ projectDir, projectTemplate }) => {
			await fs.mkdir(path.dirname(projectTemplate), { recursive: true });
			await fs.writeFile(projectTemplate, "\uFEFF  \n");
			await expect(executeAndCaptureSystemPrompt(projectDir)).rejects.toThrow(
				`Subagent system prompt template is empty: ${projectTemplate}`,
			);
		});
	});

	test.serial("rejects malformed Handlebars before dispatch", async () => {
		await withTemplateEnvironment(async ({ projectDir, projectTemplate }) => {
			await fs.mkdir(path.dirname(projectTemplate), { recursive: true });
			await fs.writeFile(projectTemplate, "{{#if}}");
			await expect(executeAndCaptureSystemPrompt(projectDir)).rejects.toBeInstanceOf(Error);
		});
	});
});
