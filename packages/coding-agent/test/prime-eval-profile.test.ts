import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import primeEvalProfile from "../examples/extensions/prime-eval-profile";

const tempDirs: TempDir[] = [];

const taskAgent = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
	spawns: "*",
	model: ["@task"],
} satisfies AgentDefinition;

async function createSession(withProfile: boolean) {
	const tempDir = TempDir.createSync("@prime-eval-profile-");
	tempDirs.push(tempDir);
	const cwd = tempDir.join("project");
	const agentDir = tempDir.join("agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({
			"async.enabled": false,
			"python.kernelMode": "session",
			"task.isolation.mode": "none",
		}),
		model,
		disableExtensionDiscovery: true,
		extensions: withProfile ? [primeEvalProfile] : [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		workspaceTree: {
			rootPath: cwd,
			rendered: ".",
			truncated: false,
			totalLines: 1,
			agentsMdFiles: [],
		} satisfies WorkspaceTree,
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		toolNames: ["eval", "read"],
	});
	await initializeExtensions(session, {
		reportSendError: (_action, error) => {
			throw error;
		},
		reportRuntimeError: error => {
			throw new Error(error.error);
		},
	});
	return session;
}

function singleResult(options: ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "child complete",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
});

describe("Prime eval profile extension spike", () => {
	it("exposes only eval to the model without changing ordinary sessions", async () => {
		const ordinary = await createSession(false);
		const profiled = await createSession(true);
		try {
			expect(ordinary.getActiveToolNames()).toEqual(expect.arrayContaining(["eval", "read"]));
			expect(profiled.getActiveToolNames()).toEqual(["eval"]);
			const context = await profiled.agent.buildSideRequestContext([]);
			expect(context.tools?.map(tool => tool.name)).toEqual(["eval"]);
			await profiled.setActiveToolsByName(["eval", "read"]);
			await profiled.extensionRunner!.emit({ type: "session_branch", previousSessionFile: undefined });
			expect(profiled.getActiveToolNames()).toEqual(["eval"]);

			await profiled.setActiveToolsByName(["eval", "read"]);
			await profiled.extensionRunner!.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
			expect(profiled.getActiveToolNames()).toEqual(["eval"]);
		} finally {
			await ordinary.dispose();
			await profiled.dispose();
		}
	});

	it("preserves Python state and reinstalls the facade after reset", async () => {
		const session = await createSession(true);
		try {
			const evalTool = session.getToolByName("eval");
			expect(evalTool).toBeDefined();
			const first = await evalTool!.execute("prime-state-1", {
				language: "py",
				code: "prime_counter = 41\nprint(prime_counter)",
			});
			const second = await evalTool!.execute("prime-state-2", {
				language: "py",
				code: "prime_counter += 1\nprint(prime_counter)\nprint(type(rlm).__name__)",
			});
			const reset = await evalTool!.execute("prime-reset", {
				language: "py",
				reset: true,
				code: [
					"from __future__ import annotations",
					"class PrimeFuture:",
					"    value: MissingType",
					"print(PrimeFuture.__annotations__['value'])",
					"print(type(rlm).__name__)",
				].join("\n"),
			});

			expect(first.content).toContainEqual(
				expect.objectContaining({ type: "text", text: expect.stringContaining("41") }),
			);
			expect(second.content).toContainEqual(
				expect.objectContaining({ type: "text", text: expect.stringContaining("42") }),
			);
			expect(second.content).toContainEqual(
				expect.objectContaining({ type: "text", text: expect.stringContaining("_PrimeRlm") }),
			);
			expect(reset.details?.isError).not.toBe(true);
			expect(reset.content).toContainEqual(
				expect.objectContaining({ type: "text", text: expect.stringContaining("MissingType") }),
			);
			expect(reset.content).toContainEqual(
				expect.objectContaining({ type: "text", text: expect.stringContaining("_PrimeRlm") }),
			);
		} finally {
			await session.dispose();
		}
	});

	it("rejects unsupported lifecycle and invalid eval calls explicitly", async () => {
		const session = await createSession(true);
		try {
			const evalTool = session.getToolByName("eval");
			const unsupported = await evalTool!.execute("prime-unsupported", {
				language: "py",
				code: [
					"operations = [",
					"    ('schedule', schedule),",
					"    ('heartbeat', heartbeat),",
					"    ('goal', goal),",
					"    ('refine', refine),",
					"    ('rlm.schedule', rlm.schedule),",
					"    ('rlm.heartbeat', rlm.heartbeat),",
					"    ('rlm.goal', rlm.goal),",
					"    ('rlm.refine', rlm.refine),",
					"]",
					"for name, operation in operations:",
					"    try:",
					"        operation()",
					"    except RuntimeError as error:",
					"        print(f'{name}:{error}')",
				].join("\n"),
			});
			const output = unsupported.content.map(item => (item.type === "text" ? item.text : "")).join("\n");
			for (const name of [
				"schedule",
				"heartbeat",
				"goal",
				"refine",
				"rlm.schedule",
				"rlm.heartbeat",
				"rlm.goal",
				"rlm.refine",
			]) {
				expect(output).toContain(`${name}:Prime eval profile does not support`);
			}

			const nonPython = await session.extensionRunner!.emitToolCall({
				type: "tool_call",
				toolCallId: "non-python",
				toolName: "eval",
				input: { language: "js", code: "1" },
			});
			expect(nonPython).toEqual({
				block: true,
				reason: "Prime eval profile only supports Python, not js",
			});

			const invalidCode = await session.extensionRunner!.emitToolCall({
				type: "tool_call",
				toolCallId: "invalid-code",
				toolName: "eval",
				input: { language: "py", code: 42 },
			});
			expect(invalidCode).toEqual({
				block: true,
				reason: "Prime eval profile requires Python code",
			});
		} finally {
			await session.dispose();
		}
	});

	it("routes rlm.run through the canonical OMP worker executor", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));
		const session = await createSession(true);
		try {
			const evalTool = session.getToolByName("eval");
			const result = await evalTool!.execute("prime-rlm", {
				language: "py",
				code: 'print(rlm.run("inspect", label="PrimeChild"))',
			});

			expect(result.details?.isError).not.toBe(true);
			expect(result.content).toContainEqual(
				expect.objectContaining({ type: "text", text: expect.stringContaining("child complete") }),
			);
			expect(runSpy).toHaveBeenCalledTimes(1);
			expect(runSpy.mock.calls[0]?.[0]).toMatchObject({ id: "PrimeChild", assignment: "inspect" });
		} finally {
			await session.dispose();
		}
	});
});
