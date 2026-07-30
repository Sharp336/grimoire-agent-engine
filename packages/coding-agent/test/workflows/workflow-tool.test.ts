import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { SessionEntry } from "../../src/session/session-entries";
import { type SettledTaskRunner, TaskDispatchService } from "../../src/task/dispatch-service";
import type { AgentDefinition, TaskItem } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { WorkflowTool } from "../../src/workflows/tools/workflow-tool";

interface RecordedSpawn {
	context: string;
	item: TaskItem;
}

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [taskAgent],
		projectAgentsDir: null,
	});
}

function taskResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task",
		assignment: "task",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function createPersistentSession(spawns: RecordedSpawn[], runSettled?: SettledTaskRunner): ToolSession {
	const entries: SessionEntry[] = [];
	let nextId = 0;
	const sessionManager: NonNullable<ToolSession["sessionManager"]> = {
		appendCustomEntry: (customType, data) => {
			const id = `entry-${++nextId}`;
			entries.push({
				type: "custom",
				id,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date(nextId).toISOString(),
				customType,
				data,
			});
			return id;
		},
		appendEntriesAtomically: async append => append(),
		ensureOnDisk: async () => {},
		flush: async () => {},
		getBranch: () => entries,
		getEntries: () => entries,
	};
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => "/tmp/session.jsonl",
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		sessionManager,
		toolRegistry: new Map(),
	};
	session.taskDispatchService = new TaskDispatchService(
		session,
		runSettled ??
			(async (_toolCallId, params, item) => {
				spawns.push(structuredClone({ context: params.context ?? "", item }));
				const id = item.name ?? "unnamed";
				return {
					content: [{ type: "text", text: "done" }],
					details: { projectAgentsDir: null, results: [taskResult(id)], totalDurationMs: 1 },
				};
			}),
	);
	return session;
}

describe("WorkflowTool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("persists a graph and dispatches downstream nodes with durable dependency references", async () => {
		mockDiscovery();
		const spawns: RecordedSpawn[] = [];
		const session = createPersistentSession(spawns);
		const tool = await WorkflowTool.createIf(session);
		if (!tool) throw new Error("Expected workflow tool for a persistent top-level session");

		const created = await tool.execute("workflow-call", {
			op: "create",
			id: "case-study",
			objective: "Build a verified case study",
			nodes: [
				{ id: "research", agent: "task", task: "Research" },
				{ id: "draft", agent: "task", task: "Draft", needs: ["research"] },
			],
		});
		expect(created.details?.workflow?.status).toBe("created");

		const restored = await WorkflowTool.createIf(session);
		if (!restored) throw new Error("Expected persisted workflow to reload");
		const reloaded = await restored.execute("workflow-call", { op: "get" });
		expect(reloaded.details?.workflow?.definition.id).toBe("case-study");

		const completed = await restored.execute("workflow-call", { op: "run" });
		expect(completed.details?.workflow?.status).toBe("succeeded");
		expect(spawns.map(spawn => spawn.item.task)).toEqual(["Research", "Draft"]);
		const researchAgentId = spawns[0]?.item.name;
		if (!researchAgentId) throw new Error("Expected a stable research agent id");
		expect(spawns[1]?.context).toContain("research: succeeded");
		expect(spawns[1]?.context).toContain(`agent://${researchAgentId}`);
		expect(spawns[1]?.context).toContain(`history://${researchAgentId}`);

		const finalReload = await WorkflowTool.createIf(session);
		if (!finalReload) throw new Error("Expected completed workflow to reload");
		const finalSnapshot = await finalReload.execute("workflow-call", { op: "get" });
		expect(finalSnapshot.details?.workflow?.nodes.research.outputRef).toBe(`agent://${researchAgentId}`);
	});

	it("preflights every node before persisting an immutable definition", async () => {
		mockDiscovery();
		const spawns: RecordedSpawn[] = [];
		const session = createPersistentSession(spawns);
		const tool = await WorkflowTool.createIf(session);
		if (!tool) throw new Error("Expected workflow tool for a persistent top-level session");

		await expect(
			tool.execute("workflow-call", {
				op: "create",
				id: "atomic-preflight",
				objective: "Persist nothing if any node is invalid",
				nodes: [
					{ id: "root", agent: "task", task: "Would be valid" },
					{
						id: "later",
						agent: "task",
						task: "Invalid strict schema",
						needs: ["root"],
						outputSchema: "string",
						schemaMode: "strict",
					},
				],
			}),
		).rejects.toThrow("Invalid strict caller output schema");
		expect(spawns).toEqual([]);
		const status = await tool.execute("workflow-call", { op: "get" });
		expect(status.details?.workflow).toBeNull();

		const corrected = await tool.execute("workflow-call", {
			op: "create",
			id: "atomic-preflight",
			objective: "Persist the corrected definition under the same id",
			nodes: [
				{ id: "root", agent: "task", task: "Valid root" },
				{
					id: "later",
					agent: "task",
					task: "Valid strict schema",
					needs: ["root"],
					outputSchema: { type: "string" },
					schemaMode: "strict",
				},
			],
		});
		expect(corrected.details?.workflow?.definition.id).toBe("atomic-preflight");
	});

	it("preserves aggregate usage from workflow node Task dispatches", async () => {
		mockDiscovery();
		const usage = {
			input: 10,
			output: 2,
			cacheRead: 3,
			cacheWrite: 1,
			totalTokens: 16,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.01, total: 0.34 },
		};
		const session = createPersistentSession([], async (_toolCallId, _params, item) => ({
			content: [{ type: "text", text: "done" }],
			details: {
				projectAgentsDir: null,
				results: [taskResult(item.name ?? "unnamed")],
				totalDurationMs: 1,
				usage,
			},
		}));
		const tool = await WorkflowTool.createIf(session);
		if (!tool) throw new Error("Expected workflow tool for a persistent top-level session");
		await tool.execute("workflow-create", {
			op: "create",
			id: "usage",
			objective: "Preserve nested usage",
			nodes: [
				{ id: "one", agent: "task", task: "One" },
				{ id: "two", agent: "task", task: "Two" },
			],
		});

		const completed = await tool.execute("workflow-run", { op: "run" });

		expect(completed.details?.usage).toEqual({
			input: 20,
			output: 4,
			cacheRead: 6,
			cacheWrite: 2,
			totalTokens: 32,
			cost: { input: 0.2, output: 0.4, cacheRead: 0.06, cacheWrite: 0.02, total: 0.68 },
		});
	});

	it("sanitizes objectives and Task errors in generic tool output", async () => {
		mockDiscovery();
		const session = createPersistentSession([], async (_toolCallId, _params, item) => {
			const id = item.name ?? "unnamed";
			return {
				content: [{ type: "text", text: "failed" }],
				details: {
					projectAgentsDir: null,
					results: [
						{
							...taskResult(id),
							error: `merge failed\tat ${os.homedir()}/private/${"x".repeat(200)}`,
						},
					],
					totalDurationMs: 1,
				},
			};
		});
		const tool = await WorkflowTool.createIf(session);
		if (!tool) throw new Error("Expected workflow tool for a persistent top-level session");
		const created = await tool.execute("workflow-create", {
			op: "create",
			id: "safe-output",
			objective: `Inspect\t${os.homedir()}/secret/${"x".repeat(200)}`,
			nodes: [{ id: "only", agent: "task", task: "Fail safely" }],
		});
		const createdText = created.content.find(part => part.type === "text")?.text ?? "";
		expect(createdText).not.toContain(os.homedir());
		expect(createdText).not.toContain("\t");

		const failed = await tool.execute("workflow-run", { op: "run" });
		const failedText = failed.content.find(part => part.type === "text")?.text ?? "";
		expect(failedText).not.toContain(os.homedir());
		expect(failedText).not.toContain("\t");
		for (const line of failedText.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(140);
	});

	it("is unavailable without a persistent parent session", async () => {
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		expect(await WorkflowTool.createIf(session)).toBeNull();
		const inMemorySession = createPersistentSession([]);
		inMemorySession.getSessionFile = () => null;
		expect(await WorkflowTool.createIf(inMemorySession)).toBeNull();
		expect(await WorkflowTool.createIf({ ...session, taskDepth: 1 })).toBeNull();
	});

	it("serializes model-facing workflow operations", async () => {
		const tool = await WorkflowTool.createIf(createPersistentSession([]));
		if (!tool) throw new Error("Expected workflow tool for a persistent top-level session");
		expect(tool.concurrency).toBe("exclusive");
	});

	it("lets the operator cancel the live runtime while run is blocked", async () => {
		mockDiscovery();
		const dispatchStarted = Promise.withResolvers<void>();
		const session = createPersistentSession([], async (_toolCallId, _params, item, _defaultAgent, signal) => {
			dispatchStarted.resolve();
			const aborted = Promise.withResolvers<void>();
			signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			const id = item.name ?? "unnamed";
			return {
				content: [{ type: "text", text: "cancelled" }],
				details: {
					projectAgentsDir: null,
					results: [{ ...taskResult(id), exitCode: 1, aborted: true, abortReason: "cancelled" }],
					totalDurationMs: 1,
				},
			};
		});
		const tool = await WorkflowTool.createIf(session);
		if (!tool) throw new Error("Expected workflow tool for a persistent top-level session");
		await tool.execute("workflow-create", {
			op: "create",
			id: "operator-cancel",
			objective: "Stop active work",
			nodes: [
				{ id: "active", agent: "task", task: "Wait" },
				{ id: "downstream", agent: "task", task: "Must not start", needs: ["active"] },
			],
		});

		const running = tool.execute("workflow-run", { op: "run" });
		await dispatchStarted.promise;
		const cancelling = await tool.cancelActiveWorkflow();
		expect(["cancelling", "cancelled"]).toContain(cancelling.status);

		const cancelled = await running;
		expect(cancelled.details?.workflow?.status).toBe("cancelled");
		expect(cancelled.details?.workflow?.nodes.active.status).toBe("cancelled");
		expect(cancelled.details?.workflow?.nodes.downstream.status).toBe("cancelled");

		const restored = await WorkflowTool.createIf(session);
		if (!restored) throw new Error("Expected cancelled workflow to reload");
		const reloaded = await restored.execute("workflow-get", { op: "get" });
		expect(reloaded.details?.workflow?.status).toBe("cancelled");
	});
});
