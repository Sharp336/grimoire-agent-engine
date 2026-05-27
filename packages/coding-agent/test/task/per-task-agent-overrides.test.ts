import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "../../src/async";
import type { ModelRegistry } from "../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import { getThemeByName } from "../../src/modes/theme/theme";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import { taskToolRenderer } from "../../src/task/render";
import type { AgentDefinition, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import "../../src/tools/yield";
import { EventBus } from "../../src/utils/event-bus";

const okSchema = {
	type: "object",
	required: ["ok"],
	properties: { ok: { type: "boolean" } },
};

const exploreOutputSchema = { ...okSchema, title: "explore-output" };
const librarianOutputSchema = { ...okSchema, title: "librarian-output" };

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			state.messages.push(createAssistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createSession(
	options: { asyncEnabled?: boolean; disabledAgents?: string[]; parentSpawns?: string } = {},
): ToolSession {
	const modelRegistry = {
		authStorage: undefined,
		refresh: async () => {},
		getAvailable: () => [],
		getApiKey: async () => null,
	} as unknown as ModelRegistry;

	return {
		cwd: "/tmp",
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated({
			"async.enabled": options.asyncEnabled ?? false,
			"task.isolation.mode": "none",
			"task.maxConcurrency": 1,
			"task.disabledAgents": options.disabledAgents ?? [],
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.parentSpawns ?? "*",
		getModelString: () => "openai/default",
		getActiveModelString: () => "openai/default",
		modelRegistry,
	} as unknown as ToolSession;
}

function createAgent(overrides: Partial<AgentDefinition> & Pick<AgentDefinition, "name">): AgentDefinition {
	const { name, ...rest } = overrides;
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `${name} prompt`,
		source: "bundled",
		...rest,
	};
}

function createExploreAgent(): AgentDefinition {
	return createAgent({
		name: "explore",
		tools: ["read"],
		model: ["openai/gpt-explore"],
		output: exploreOutputSchema,
	});
}

function createLibrarianAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return createAgent({
		name: "librarian",
		tools: ["web_search"],
		model: ["anthropic/claude-librarian"],
		output: librarianOutputSchema,
		...overrides,
	});
}

function mockAgents(agents: AgentDefinition[]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents,
		projectAgentsDir: null,
	});
}

function mockCreateAgentSession(): { capturedOptions: CreateAgentSessionOptions[] } {
	const capturedOptions: CreateAgentSessionOptions[] = [];
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
		capturedOptions.push(options);
		return {
			session: createYieldingSession(),
			extensionsResult: {} as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
	return { capturedOptions };
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

type MinimalTaskResult = { agent: string; modelOverride?: string | string[] };

function resultAgents(result: { details?: { results: MinimalTaskResult[] } }): string[] | undefined {
	return result.details?.results.map(taskResult => taskResult.agent);
}

function resultModelOverrides(result: {
	details?: { results: MinimalTaskResult[] };
}): Array<string | string[] | undefined> | undefined {
	return result.details?.results.map(taskResult => taskResult.modelOverride);
}

const originalBlockedAgent = Bun.env.PI_BLOCKED_AGENT;

describe("task tool per-task agent overrides", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: "/tmp", overrides: { "task.showResolvedModelBadge": false } });
		AsyncJobManager.resetForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
		resetSettingsForTest();
		if (originalBlockedAgent === undefined) {
			delete Bun.env.PI_BLOCKED_AGENT;
		} else {
			Bun.env.PI_BLOCKED_AGENT = originalBlockedAgent;
		}
	});

	it("exposes optional per-task agent overrides in the task item schema", async () => {
		mockAgents([createExploreAgent(), createLibrarianAgent()]);

		const tool = await TaskTool.create(createSession());
		const wire = toolWireSchema(tool) as { properties?: Record<string, unknown> };
		const tasksSchema = wire.properties?.tasks as
			| { items?: { properties?: Record<string, unknown>; required?: string[] } }
			| undefined;
		const itemSchema = tasksSchema?.items;

		expect(itemSchema?.properties?.agent).toBeDefined();
		expect(itemSchema?.required ?? []).not.toContain("agent");
	});

	it("keeps legacy same-agent batches on the top-level agent", async () => {
		mockAgents([createExploreAgent()]);
		const { capturedOptions } = mockCreateAgentSession();
		const params: TaskParams = {
			agent: "explore",
			tasks: [
				{ id: "ReadOne", description: "Read one", assignment: "Read the first file." },
				{ id: "ReadTwo", description: "Read two", assignment: "Read the second file." },
			],
		};

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);

		expect(capturedOptions.map(options => options.agentDisplayName)).toEqual(["explore", "explore"]);
		expect(capturedOptions.map(options => options.toolNames)).toEqual([
			["read", "irc"],
			["read", "irc"],
		]);
		expect(capturedOptions.map(options => options.outputSchema)).toEqual([exploreOutputSchema, exploreOutputSchema]);
		expect(resultAgents(result)).toEqual(["explore", "explore"]);
	});

	it("runs mixed explore and librarian batches with each agent's own config", async () => {
		mockAgents([createExploreAgent(), createLibrarianAgent()]);
		const { capturedOptions } = mockCreateAgentSession();
		const params: TaskParams = {
			agent: "explore",
			tasks: [
				{ id: "Scout", description: "Scout code", assignment: "Inspect local code." },
				{
					id: "Research",
					description: "Research docs",
					assignment: "Read external docs.",
					agent: "librarian",
				},
			],
		};

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);

		expect(capturedOptions.map(options => options.agentDisplayName)).toEqual(["explore", "librarian"]);
		expect(capturedOptions.map(options => options.toolNames)).toEqual([
			["read", "irc"],
			["web_search", "irc"],
		]);
		expect(capturedOptions.map(options => options.outputSchema)).toEqual([
			exploreOutputSchema,
			librarianOutputSchema,
		]);
		expect(resultAgents(result)).toEqual(["explore", "librarian"]);
		expect(resultModelOverrides(result)).toEqual([["openai/gpt-explore"], ["anthropic/claude-librarian"]]);

		const theme = (await getThemeByName("dark"))!;
		const callText = Bun.stripANSI(
			taskToolRenderer.renderCall(params, { expanded: false, isPartial: false }, theme).render(160).join("\n"),
		);
		expect(callText).toContain("mixed (explore×1, librarian×1)");

		const resultText = Bun.stripANSI(
			taskToolRenderer
				.renderResult(
					{ content: result.content, details: result.details },
					{ expanded: false, isPartial: false },
					theme,
				)
				.render(160)
				.join("\n"),
		);
		expect(resultText).toContain("explore");
		expect(resultText).toContain("librarian");
	});

	it("includes per-task agent overrides in approval details", async () => {
		mockAgents([createExploreAgent(), createLibrarianAgent()]);
		const tool = await TaskTool.create(createSession());

		const lines = tool.formatApprovalDetails({
			agent: "explore",
			tasks: [
				{ id: "Scout", description: "Scout code", assignment: "Inspect local code." },
				{
					id: "Research",
					description: "Research docs",
					assignment: "Read external docs.",
					agent: "librarian",
				},
			],
		});

		expect(lines).toContain("Agents: mixed (explore×1, librarian×1)");
		expect(lines).toContain("Task: Scout (agent: explore)");
		expect(lines).toContain("+1 more task (agent: librarian)");
	});

	it("uses fresh discovery before synchronous fallback validation", async () => {
		vi.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValueOnce({ agents: [createExploreAgent()], projectAgentsDir: null })
			.mockResolvedValue({ agents: [createExploreAgent(), createLibrarianAgent()], projectAgentsDir: null });
		const { capturedOptions } = mockCreateAgentSession();
		const tool = await TaskTool.create(createSession({ asyncEnabled: false }));

		const result = await tool.execute("tool-call", {
			agent: "explore",
			tasks: [
				{ id: "Scout", description: "Scout code", assignment: "Inspect local code." },
				{
					id: "Research",
					description: "Research docs",
					assignment: "Read external docs.",
					agent: "librarian",
				},
			],
		});

		expect(capturedOptions.map(options => options.agentDisplayName)).toEqual(["explore", "librarian"]);
		expect(resultAgents(result)).toEqual(["explore", "librarian"]);
	});

	it("uses fresh discovery for async per-task agent preflight", async () => {
		vi.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValueOnce({ agents: [createExploreAgent()], projectAgentsDir: null })
			.mockResolvedValue({ agents: [createExploreAgent(), createLibrarianAgent()], projectAgentsDir: null });
		const { capturedOptions } = mockCreateAgentSession();
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				deliveries.push({ jobId, text });
			},
		});
		AsyncJobManager.setInstance(manager);

		try {
			const tool = await TaskTool.create(createSession({ asyncEnabled: true }));
			const result = await tool.execute("tool-call", {
				agent: "explore",
				tasks: [
					{ id: "Scout", description: "Scout code", assignment: "Inspect local code." },
					{
						id: "Research",
						description: "Research docs",
						assignment: "Read external docs.",
						agent: "librarian",
					},
				],
			});

			expect(textContent(result)).toContain("using mixed (explore×1, librarian×1)");
			expect(result.details?.progress?.map(progress => progress.agent)).toEqual(["explore", "librarian"]);

			await manager.waitForAll();
			expect(await manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);
			expect(capturedOptions.map(options => options.agentDisplayName)).toEqual(["explore", "librarian"]);
			expect(deliveries.map(delivery => delivery.jobId)).toEqual(["Scout", "Research"]);
		} finally {
			await manager.dispose({ timeoutMs: 2_000 });
		}
	});

	it("rejects an invalid per-task agent before dispatch", async () => {
		mockAgents([createExploreAgent()]);
		const { capturedOptions } = mockCreateAgentSession();
		const tool = await TaskTool.create(createSession({ asyncEnabled: true }));

		const result = await tool.execute("tool-call", {
			agent: "explore",
			tasks: [
				{ id: "Scout", description: "Scout code", assignment: "Inspect local code." },
				{ id: "Missing", description: "Missing agent", assignment: "Use a missing agent.", agent: "ghost" },
			],
		});

		expect(textContent(result)).toContain('Unknown agent "ghost" for task Missing');
		expect(capturedOptions).toHaveLength(0);
		expect(result.details?.results).toEqual([]);
	});

	it("rejects disabled per-task agents before dispatch", async () => {
		mockAgents([createExploreAgent(), createLibrarianAgent()]);
		const { capturedOptions } = mockCreateAgentSession();
		const tool = await TaskTool.create(createSession({ asyncEnabled: true, disabledAgents: ["librarian"] }));

		const result = await tool.execute("tool-call", {
			agent: "explore",
			tasks: [
				{ id: "Scout", description: "Scout code", assignment: "Inspect local code." },
				{
					id: "Research",
					description: "Research docs",
					assignment: "Read external docs.",
					agent: "librarian",
				},
			],
		});

		expect(textContent(result)).toContain('Agent "librarian" for task Research is disabled');
		expect(capturedOptions).toHaveLength(0);
		expect(result.details?.results).toEqual([]);
	});

	it("rejects self-recursive per-task agents before dispatch", async () => {
		Bun.env.PI_BLOCKED_AGENT = "librarian";
		mockAgents([createExploreAgent(), createLibrarianAgent()]);
		const { capturedOptions } = mockCreateAgentSession();
		const tool = await TaskTool.create(createSession({ asyncEnabled: true }));

		const result = await tool.execute("tool-call", {
			agent: "explore",
			tasks: [
				{ id: "Scout", description: "Scout code", assignment: "Inspect local code." },
				{
					id: "Research",
					description: "Research docs",
					assignment: "Read external docs.",
					agent: "librarian",
				},
			],
		});

		expect(textContent(result)).toContain("Cannot spawn librarian agent for task Research from within itself");
		expect(capturedOptions).toHaveLength(0);
		expect(result.details?.results).toEqual([]);
	});

	it("rejects spawn-disallowed per-task agents before dispatch", async () => {
		mockAgents([createExploreAgent(), createLibrarianAgent()]);
		const { capturedOptions } = mockCreateAgentSession();
		const tool = await TaskTool.create(createSession({ asyncEnabled: true, parentSpawns: "explore" }));

		const result = await tool.execute("tool-call", {
			agent: "explore",
			tasks: [
				{ id: "Scout", description: "Scout code", assignment: "Inspect local code." },
				{
					id: "Research",
					description: "Research docs",
					assignment: "Read external docs.",
					agent: "librarian",
				},
			],
		});

		expect(textContent(result)).toContain("Cannot spawn 'librarian' for task Research. Allowed: explore");
		expect(capturedOptions).toHaveLength(0);
		expect(result.details?.results).toEqual([]);
	});

	it("starts async mixed batches with resolved per-task agents", async () => {
		mockAgents([createExploreAgent(), createLibrarianAgent()]);
		const { capturedOptions } = mockCreateAgentSession();
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				deliveries.push({ jobId, text });
			},
		});
		AsyncJobManager.setInstance(manager);

		try {
			const tool = await TaskTool.create(createSession({ asyncEnabled: true }));
			const result = await tool.execute("tool-call", {
				agent: "explore",
				tasks: [
					{ id: "Scout", description: "Scout code", assignment: "Inspect local code." },
					{
						id: "Research",
						description: "Research docs",
						assignment: "Read external docs.",
						agent: "librarian",
					},
				],
			});

			expect(textContent(result)).toContain("using mixed (explore×1, librarian×1)");
			expect(result.details?.progress?.map(progress => progress.agent)).toEqual(["explore", "librarian"]);
			expect(manager.getAllJobs().map(job => job.id)).toEqual(["Scout", "Research"]);

			await manager.waitForAll();
			expect(await manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);

			expect(capturedOptions.map(options => options.agentDisplayName)).toEqual(["explore", "librarian"]);
			expect(deliveries.map(delivery => delivery.jobId)).toEqual(["Scout", "Research"]);
		} finally {
			await manager.dispose({ timeoutMs: 2_000 });
		}
	});

	it("uses the synchronous path when any resolved agent is blocking", async () => {
		mockAgents([createExploreAgent(), createLibrarianAgent({ blocking: true })]);
		const { capturedOptions } = mockCreateAgentSession();
		const tool = await TaskTool.create(createSession({ asyncEnabled: true }));

		const result = await tool.execute("tool-call", {
			agent: "explore",
			tasks: [
				{ id: "Scout", description: "Scout code", assignment: "Inspect local code." },
				{
					id: "Research",
					description: "Research docs",
					assignment: "Read external docs.",
					agent: "librarian",
				},
			],
		});

		expect(textContent(result)).not.toContain("Async execution is enabled but no async job manager is available");
		expect(capturedOptions.map(options => options.agentDisplayName)).toEqual(["explore", "librarian"]);
		expect(resultAgents(result)).toEqual(["explore", "librarian"]);
	});
});
