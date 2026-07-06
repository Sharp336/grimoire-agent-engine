/**
 * Contracts: task.batch gating (batch spawning + shared context).
 *
 * 1. The wire schema is shape-swapped by `task.batch`: `{ agent, context,
 *    tasks[] }` when on (per-spawn fields — including `isolated` — live in the
 *    items), the flat `{ agent, ...item }` when off. Neither shape exposes a
 *    per-call `schema` input (structured output comes from agent frontmatter /
 *    inherited session schema / eval agent()).
 * 2. Shape validation rejects `schema` always, `tasks`/`context` while batch
 *    is disabled, top-level `assignment` in batch calls, empty/invalid items,
 *    duplicate ids, and a missing shared `context`.
 * 3. With `async.enabled=true`, a batch call registers one background job per
 *    item; with `async.enabled=false`, it blocks and returns merged results.
 *    Both modes forward the shared `context`; the flat form stays accepted at
 *    runtime for internal callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const librarianAgent: AgentDefinition = {
	name: "librarian",
	description: "Research librarian agent",
	systemPrompt: "You are a librarian.",
	source: "project",
	blocking: true,
};

function createSession(
	options: {
		manager?: AsyncJobManager;
		settings?: Record<string, unknown>;
		agentId?: string;
		spawns?: string | null;
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		getAgentId: () => options.agentId ?? null,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function getSchemaProperties(tool: TaskTool): Record<string, unknown> {
	const wire = toolWireSchema(tool);
	if (!isRecord(wire)) return {};
	const properties = wire.properties;
	return isRecord(properties) ? properties : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function getTaskItemProperties(properties: Record<string, unknown>): Record<string, unknown> | undefined {
	const tasks = properties.tasks;
	if (!isRecord(tasks)) return undefined;
	const items = tasks.items;
	if (!isRecord(items)) return undefined;
	const itemProperties = items.properties;
	return isRecord(itemProperties) ? itemProperties : undefined;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function mockDiscovery(agents: AgentDefinition[] = [taskAgent]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents,
		projectAgentsDir: null,
	});
}

describe("task.batch schema gating", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("swaps between the flat and batch wire shapes", async () => {
		mockDiscovery();

		const off = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		const offProperties = getSchemaProperties(off);
		expect(offProperties.tasks).toBeUndefined();
		expect(offProperties.context).toBeUndefined();
		expect(offProperties.assignment).toBeDefined();
		expect(offProperties.id).toBeDefined();

		const on = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const onProperties = getSchemaProperties(on);
		expect(onProperties.tasks).toBeDefined();
		expect(onProperties.context).toBeDefined();
		// The batch shape is { agent, context, tasks[] } — the per-spawn fields
		// live only inside the task items.
		expect(onProperties.assignment).toBeUndefined();
		expect(onProperties.id).toBeUndefined();
		expect(onProperties.description).toBeUndefined();
		const itemProperties = getTaskItemProperties(onProperties);
		expect(itemProperties?.assignment).toBeDefined();
		expect(itemProperties?.id).toBeDefined();
	});

	it("exposes per-item agent in the batch wire shape", async () => {
		mockDiscovery([taskAgent, librarianAgent]);

		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const itemProperties = getTaskItemProperties(getSchemaProperties(tool));

		expect(itemProperties?.agent).toBeDefined();
	});

	it("places isolated per item in the batch shape when isolation is enabled", async () => {
		mockDiscovery();

		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "task.isolation.mode": "auto" } }),
		);
		const itemProperties = getTaskItemProperties(getSchemaProperties(tool));
		expect(itemProperties?.isolated).toBeDefined();
	});

	it("never exposes a per-call schema input", async () => {
		mockDiscovery();

		for (const settings of [{ "task.batch": false }, { "task.batch": true }]) {
			const tool = await TaskTool.create(createSession({ settings }));
			expect(getSchemaProperties(tool).schema).toBeUndefined();
		}
	});
});

describe("task.batch validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function executeText(params: unknown, settings: Record<string, unknown> = {}): Promise<string> {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings }));
		const result = await tool.execute("tool-call", params);
		return getFirstText(result);
	}

	it("rejects a schema argument regardless of batch mode", async () => {
		for (const batch of [false, true]) {
			const text = await executeText(
				{ agent: "task", assignment: "Work.", schema: '{"properties":{}}' },
				{ "task.batch": batch },
			);
			expect(text).toContain("does not accept `schema`");
		}
	});

	it("rejects tasks and context while task.batch is disabled", async () => {
		const disabled = { "task.batch": false };
		const text = await executeText({ agent: "task", tasks: [{ assignment: "Work." }] }, disabled);
		expect(text).toContain("task.batch is disabled");

		const contextText = await executeText({ agent: "task", assignment: "Work.", context: "Background." }, disabled);
		expect(contextText).toContain("task.batch is disabled");
	});

	it("rejects top-level assignment in the batch shape", async () => {
		const text = await executeText(
			{ agent: "task", assignment: "Work.", tasks: [{ assignment: "Other." }] },
			{ "task.batch": true },
		);
		expect(text).toContain("not part of the batch shape");
	});

	it("rejects empty task arrays and items without assignments", async () => {
		const empty = await executeText({ agent: "task", tasks: [] }, { "task.batch": true });
		expect(empty).toContain("Missing `tasks`");

		const missing = await executeText(
			{ agent: "task", tasks: [{ assignment: "Work." }, { id: "Beta" }] },
			{ "task.batch": true },
		);
		expect(missing).toContain("Task 2 (`Beta`) is missing `assignment`");
	});

	it("requires a shared context for batch calls", async () => {
		const text = await executeText({ agent: "task", tasks: [{ assignment: "Work." }] }, { "task.batch": true });
		expect(text).toContain("Missing `context`");
	});

	it("rejects duplicate provided ids case-insensitively", async () => {
		const text = await executeText(
			{
				agent: "task",
				tasks: [
					{ id: "Anna", assignment: "A." },
					{ id: "anna", assignment: "B." },
				],
			},
			{ "task.batch": true },
		);
		expect(text).toContain("Duplicate task id");
	});
});

describe("task.batch approval details", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces mixed effective agents in batch approval details", async () => {
		mockDiscovery([taskAgent, librarianAgent]);
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true } }));

		const details = tool.formatApprovalDetails({
			agent: "task",
			context: "# Goal\nRoute each task to the right specialist.",
			tasks: [
				{ id: "Scout", assignment: "Inspect the implementation." },
				{ id: "Archivist", agent: "librarian", assignment: "Find the reference material." },
			],
		} as TaskParams);

		expect(details).toContain("Agents: mixed (task×1, librarian×1)");
		expect(details).toContain("Task: Scout (agent: task)");
		expect(details).toContain("+1 more task (agent: librarian)");
	});
});

describe("task.batch spawning", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("spawns one background job per task item and forwards the shared context", async () => {
		mockDiscovery();
		const seen: Array<{ id?: string; context?: string; assignment?: string; parentAgentId?: string }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({
				id: options.id,
				context: options.context,
				assignment: options.assignment,
				parentAgentId: options.parentAgentId,
			});
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, agentId: "ParentA", settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-batch", {
			agent: "task",
			context: "# Goal\nShared background.",
			tasks: [
				{ id: "Alpha", description: "first", assignment: "Do A." },
				{ id: "Beta", assignment: "Do B." },
			],
		} as TaskParams);

		const text = getFirstText(result);
		expect(text).toContain("Spawned 2 background agents");
		expect(text).toContain("- `Alpha`");
		expect(text).toContain("- `Beta`");
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(result.details?.async?.state).toBe("running");

		const alphaJob = manager.getJob("Alpha");
		const betaJob = manager.getJob("Beta");
		expect(alphaJob).toBeDefined();
		expect(betaJob).toBeDefined();
		await alphaJob!.promise;
		await betaJob!.promise;

		expect(alphaJob!.status).toBe("completed");
		expect(betaJob!.status).toBe("completed");
		expect(alphaJob!.resultText).toContain("Alpha is now idle");
		expect(betaJob!.resultText).toContain("history://Beta");

		expect(seen).toHaveLength(2);
		for (const spawn of seen) {
			expect(spawn.context).toBe("# Goal\nShared background.");
		}
		expect(seen.map(spawn => spawn.assignment).sort()).toEqual(["Do A.", "Do B."]);
		// Every spawn is parented to the spawning agent (not to itself): the
		// registry "of <parent>" link must be the caller, never the child's id.
		for (const spawn of seen) expect(spawn.parentAgentId).toBe("ParentA");
	});

	it("treats a one-item batch as a single spawn and forwards context", async () => {
		mockDiscovery();
		let capturedContext: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedContext = options.context;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-single", {
			agent: "task",
			context: "Shared notes.",
			tasks: [{ id: "Solo", assignment: "Do the thing." }],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Solo`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(capturedContext).toBe("Shared notes.");
	});

	it("accepts the flat single-spawn form at runtime under batch mode", async () => {
		// Internal callers (e.g. the commit flow) and stale transcripts use the
		// flat shape directly; the wire schema is batch-only but runtime is not.
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-flat", {
			agent: "task",
			id: "Flat",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Flat`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
	});

	it("blocks batch execution when async.enabled is false even with a job manager", async () => {
		mockDiscovery();
		const seen: Array<{ id?: string; context?: string; assignment?: string }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({ id: options.id, context: options.context, assignment: options.assignment });
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("tc-sync-batch", {
			agent: "task",
			context: "# Goal\nShared synchronous context.",
			tasks: [
				{ id: "Alpha", assignment: "Do A." },
				{ id: "Beta", assignment: "Do B." },
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("All done.");
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results.map(item => item.id).sort()).toEqual(["Alpha", "Beta"]);
		expect(manager.getJob("Alpha")).toBeUndefined();
		expect(manager.getJob("Beta")).toBeUndefined();
		expect(seen.map(spawn => spawn.context)).toEqual([
			"# Goal\nShared synchronous context.",
			"# Goal\nShared synchronous context.",
		]);
	});

	it("falls back to sync fanout when any resolved item agent is blocking", async () => {
		mockDiscovery([taskAgent, librarianAgent]);
		const seen: Array<{ id?: string; agent: string; context?: string }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({ id: options.id, agent: options.agent.name, context: options.context });
			return makeResult(options.id ?? "?", { agent: options.agent.name, agentSource: options.agent.source });
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-mixed-blocking-batch", {
			agent: "task",
			context: "# Goal\nRoute each item to its effective agent.",
			tasks: [
				{ id: "Code", assignment: "Inspect the code paths." },
				{ id: "Books", agent: "librarian", assignment: "Catalogue the references." },
			],
		} as unknown as TaskParams);

		expect(result.details?.async).toBeUndefined();
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(seen).toHaveLength(2);
		expect(seen.map(spawn => spawn.context)).toEqual([
			"# Goal\nRoute each item to its effective agent.",
			"# Goal\nRoute each item to its effective agent.",
		]);
		expect(
			seen.map(({ id, agent }) => ({ id, agent })).sort((a, b) => (a.id ?? "").localeCompare(b.id ?? "")),
		).toEqual([
			{ id: "Books", agent: "librarian" },
			{ id: "Code", agent: "task" },
		]);
		expect(
			result.details?.results.map(({ id, agent }) => ({ id, agent })).sort((a, b) => a.id.localeCompare(b.id)),
		).toEqual([
			{ id: "Books", agent: "librarian" },
			{ id: "Code", agent: "task" },
		]);
	});

	it("rejects invalid per-item agents before dispatching any batch job", async () => {
		const batchWithOverride = (agent: string) => ({
			agent: "task",
			context: "# Goal\nValidate every effective agent before dispatch.",
			tasks: [
				{ id: "Default", assignment: "Use the inherited agent." },
				{ id: "Override", agent, assignment: "Use the item override." },
			],
		});
		const scenarios: Array<{
			name: string;
			params: unknown;
			settings?: Record<string, unknown>;
			spawns?: string;
			blockedAgent?: string;
			expected: string;
		}> = [
			{
				name: "unknown item agent",
				params: batchWithOverride("ghost"),
				expected: 'Unknown agent "ghost"',
			},
			{
				name: "disabled item agent",
				params: batchWithOverride("librarian"),
				settings: { "task.disabledAgents": ["librarian"] },
				expected: 'Agent "librarian" for task id `Override` is disabled',
			},
			{
				name: "self-recursive item agent",
				params: batchWithOverride("librarian"),
				blockedAgent: "librarian",
				expected: "Cannot spawn librarian agent for task id `Override` from within itself",
			},
			{
				name: "parent-spawn-disallowed item agent",
				params: batchWithOverride("librarian"),
				spawns: "task",
				expected: "Cannot spawn 'librarian'",
			},
		];

		for (const scenario of scenarios) {
			const previousBlockedAgent = Bun.env.PI_BLOCKED_AGENT;
			try {
				if (scenario.blockedAgent) {
					Bun.env.PI_BLOCKED_AGENT = scenario.blockedAgent;
				} else {
					delete Bun.env.PI_BLOCKED_AGENT;
				}
				mockDiscovery([taskAgent, librarianAgent]);
				const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
					return makeResult(options.id ?? "?", { agent: options.agent.name, agentSource: options.agent.source });
				});
				const manager = createManager();
				const tool = await TaskTool.create(
					createSession({
						manager,
						spawns: scenario.spawns,
						settings: { "async.enabled": true, "task.batch": true, ...scenario.settings },
					}),
				);

				const result = await tool.execute(
					`tc-preflight-${scenario.name}`,
					scenario.params as unknown as TaskParams,
				);

				expect(getFirstText(result)).toContain(scenario.expected);
				expect(runSubprocess).not.toHaveBeenCalled();
				expect(manager.getAllJobs()).toHaveLength(0);
			} finally {
				if (previousBlockedAgent === undefined) {
					delete Bun.env.PI_BLOCKED_AGENT;
				} else {
					Bun.env.PI_BLOCKED_AGENT = previousBlockedAgent;
				}
				vi.restoreAllMocks();
			}
		}
	});

	it("settles the batch async aggregate when a queued spawn is cancelled mid-flight", async () => {
		mockDiscovery();
		const started: string[] = [];
		const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const { promise, resolve } = Promise.withResolvers<void>();
			gates.set(id, { promise, resolve });
			await promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: { "async.enabled": true, "task.batch": true, "task.maxConcurrency": 1 },
			}),
		);

		const updates: Array<{ async?: { state?: string }; progress?: Array<{ id: string; status: string }> }> = [];
		const result = await tool.execute(
			"tc-batch-cancel",
			{
				agent: "task",
				context: "ctx",
				tasks: [
					{ id: "First", assignment: "Do A." },
					{ id: "Second", assignment: "Do B." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) {
					updates.push({
						async: update.details.async,
						progress: update.details.progress?.map(p => ({ id: p.id, status: p.status })),
					});
				}
			},
		);

		expect(result.details?.async?.state).toBe("running");

		const firstJob = manager.getJob("First")!;
		const secondJob = manager.getJob("Second")!;
		const deadline = Date.now() + 1_000;
		while (started.length === 0) {
			if (Date.now() > deadline) throw new Error("First spawn never reached the executor");
			await Bun.sleep(5);
		}
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;

		gates.get("First")!.resolve();
		await firstJob.promise;

		expect(secondJob.status).toBe("cancelled");
		const last = updates.at(-1);
		// The acquire-time abort path has to flow through the same `onSettled`
		// the post-acquire abort path uses, otherwise the batch aggregate sticks
		// at "running" forever after the surviving spawn completes.
		expect(last?.async?.state).toBe("failed");
		expect(last?.progress?.find(p => p.id === "Second")?.status).toBe("aborted");
		expect(last?.progress?.find(p => p.id === "First")?.status).toBe("completed");
	});
});
