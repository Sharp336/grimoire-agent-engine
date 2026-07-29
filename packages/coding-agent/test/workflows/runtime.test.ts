import { describe, expect, it } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import {
	type WorkflowDispatchOutcome,
	type WorkflowDispatchRequest,
	WorkflowRuntime,
	type WorkflowSnapshot,
	type WorkflowStore,
} from "../../src/workflows";

interface OutcomeGate {
	promise: Promise<WorkflowDispatchOutcome>;
	resolve: (value: WorkflowDispatchOutcome | PromiseLike<WorkflowDispatchOutcome>) => void;
	reject: (reason?: unknown) => void;
}

class MemoryWorkflowStore implements WorkflowStore {
	snapshots: WorkflowSnapshot[] = [];

	load(): WorkflowSnapshot | null {
		return this.snapshots.at(-1) ? structuredClone(this.snapshots.at(-1)!) : null;
	}

	hasWorkflowId(id: string): boolean {
		return this.snapshots.some(snapshot => snapshot.definition.id === id);
	}

	async append(snapshot: WorkflowSnapshot): Promise<void> {
		this.snapshots.push(structuredClone(snapshot));
	}
}

function resultFor(request: WorkflowDispatchRequest, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: request.name,
		agent: request.agent,
		agentSource: "bundled",
		task: request.task,
		assignment: request.task,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("Timed out waiting for workflow state");
}

async function createRuntime(store = new MemoryWorkflowStore()): Promise<WorkflowRuntime> {
	let now = 1_000;
	return WorkflowRuntime.create({
		store,
		idFactory: () => "test-workflow",
		now: () => now++,
	});
}

describe("WorkflowRuntime", () => {
	it("rejects invalid graphs before dispatching any node", async () => {
		const runtime = await createRuntime();
		await expect(
			runtime.createWorkflow({
				objective: "Invalid graph",
				nodes: [
					{ id: "a", agent: "task", task: "A", needs: ["b"] },
					{ id: "b", agent: "task", task: "B", needs: ["a"] },
				],
			}),
		).rejects.toThrow("dependency cycle");
		expect(runtime.getSnapshot()).toBeNull();
	});

	it("keeps workflow definitions immutable and ids unique on a session branch", async () => {
		const runtime = await createRuntime();
		await runtime.createWorkflow({
			id: "immutable",
			objective: "First definition",
			nodes: [{ id: "only", agent: "task", task: "Finish" }],
		});
		await runtime.run(async request => ({ result: resultFor(request) }));

		await expect(
			runtime.createWorkflow({
				id: "immutable",
				objective: "Replacement definition",
				nodes: [{ id: "replacement", agent: "task", task: "Replace" }],
			}),
		).rejects.toThrow("already exists on this session branch");

		const next = await runtime.createWorkflow({
			id: "next",
			objective: "A new immutable definition",
			nodes: [{ id: "only", agent: "task", task: "Continue" }],
		});
		expect(next.definition.id).toBe("next");
	});

	it("runs independent roots concurrently and holds a join until both settle", async () => {
		const runtime = await createRuntime();
		await runtime.createWorkflow({
			objective: "Join two findings",
			nodes: [
				{ id: "left", agent: "scout", task: "Left" },
				{ id: "right", agent: "scout", task: "Right" },
				{ id: "join", agent: "reviewer", task: "Join", needs: ["left", "right"] },
			],
		});

		const started: string[] = [];
		const gates = new Map<string, OutcomeGate>();
		const running = runtime.run(async request => {
			started.push(request.nodeId);
			const gate = Promise.withResolvers<WorkflowDispatchOutcome>();
			gates.set(request.nodeId, gate);
			return gate.promise;
		});
		await waitFor(() => started.length === 2);
		expect(new Set(started)).toEqual(new Set(["left", "right"]));

		gates.get("left")!.resolve({ result: resultFor({ ...gatesRequest("left"), name: "LeftAgent" }) });
		await waitFor(() => runtime.getSnapshot()?.nodes.left.status === "succeeded");
		expect(started).not.toContain("join");

		gates.get("right")!.resolve({ result: resultFor({ ...gatesRequest("right"), name: "RightAgent" }) });
		await waitFor(() => started.includes("join"));
		const joinSnapshot = runtime.getSnapshot()!;
		expect(joinSnapshot.nodes.left.outputRef).toBe("agent://LeftAgent");
		expect(joinSnapshot.nodes.right.historyRef).toBe("history://RightAgent");
		gates.get("join")!.resolve({ result: resultFor({ ...gatesRequest("join"), name: "JoinAgent" }) });

		const completed = await running;
		expect(completed.status).toBe("succeeded");
		expect(completed.nodes.join.status).toBe("succeeded");
	});

	it("starts a newly ready descendant before an unrelated root settles", async () => {
		const runtime = await createRuntime();
		await runtime.createWorkflow({
			objective: "Keep the critical path moving",
			nodes: [
				{ id: "fast", agent: "task", task: "Fast root" },
				{ id: "child", agent: "task", task: "Fast child", needs: ["fast"] },
				{ id: "slow", agent: "task", task: "Slow root" },
			],
		});

		const started: string[] = [];
		const gates = new Map<string, OutcomeGate>();
		const running = runtime.run(request => {
			started.push(request.nodeId);
			const gate = Promise.withResolvers<WorkflowDispatchOutcome>();
			gates.set(request.nodeId, gate);
			return gate.promise;
		});
		await waitFor(() => started.length === 2);

		gates.get("fast")!.resolve({ result: resultFor(gatesRequest("fast")) });
		await waitFor(() => started.includes("child"));
		expect(runtime.getSnapshot()?.nodes.slow.status).toBe("running");

		gates.get("child")!.resolve({ result: resultFor(gatesRequest("child")) });
		gates.get("slow")!.resolve({ result: resultFor(gatesRequest("slow")) });
		const completed = await running;
		expect(completed.status).toBe("succeeded");
	});

	it("blocks failed descendants, continues independent work, and enforces strict schema success", async () => {
		const runtime = await createRuntime();
		await runtime.createWorkflow({
			objective: "Keep independent work moving",
			nodes: [
				{
					id: "strict",
					agent: "task",
					task: "Return structured data",
					outputSchema: { type: "object" },
					schemaMode: "strict",
				},
				{ id: "blocked", agent: "task", task: "Must not run", needs: ["strict"] },
				{ id: "independent", agent: "task", task: "Still run" },
			],
		});
		const dispatched: string[] = [];
		const snapshot = await runtime.run(async request => {
			dispatched.push(request.nodeId);
			if (request.nodeId === "strict") {
				return {
					result: resultFor(request, {
						structuredOutput: {
							source: "caller",
							mode: "strict",
							status: "invalid",
							error: "required property missing",
						},
					}),
				};
			}
			return { result: resultFor(request) };
		});

		expect(snapshot.status).toBe("failed");
		expect(snapshot.nodes.strict.status).toBe("failed");
		expect(snapshot.nodes.blocked.status).toBe("blocked");
		expect(snapshot.nodes.independent.status).toBe("succeeded");
		expect(dispatched).toContain("independent");
		expect(dispatched).not.toContain("blocked");
	});

	it("retry reopens only the selected failure's descendant closure", async () => {
		const runtime = await createRuntime();
		await runtime.createWorkflow({
			objective: "Recover one failed branch",
			nodes: [
				{ id: "left", agent: "task", task: "Left root" },
				{ id: "left-child", agent: "task", task: "Left child", needs: ["left"] },
				{ id: "right", agent: "task", task: "Right root" },
				{ id: "right-child", agent: "task", task: "Right child", needs: ["right"] },
			],
		});
		await runtime.run(async request =>
			request.nodeId === "left" || request.nodeId === "right"
				? { status: "failed", error: `${request.nodeId} failed` }
				: { result: resultFor(request) },
		);

		const retried = await runtime.retryNode("left");
		expect(retried.nodes.left.status).toBe("ready");
		expect(retried.nodes["left-child"].status).toBe("pending");
		expect(retried.nodes.right.status).toBe("failed");
		expect(retried.nodes["right-child"].status).toBe("blocked");

		const dispatched: string[] = [];
		const resumed = await runtime.run(async request => {
			dispatched.push(request.nodeId);
			return { result: resultFor(request) };
		});
		expect(dispatched).toEqual(["left", "left-child"]);
		expect(resumed.nodes["left-child"].status).toBe("succeeded");
		expect(resumed.nodes["right-child"].status).toBe("blocked");
		expect(resumed.status).toBe("failed");
	});

	it("rehydrates orphaned running nodes as interrupted without rerunning successes", async () => {
		const store = new MemoryWorkflowStore();
		const runtime = await createRuntime(store);
		await runtime.createWorkflow({
			objective: "Recover conservatively",
			nodes: [
				{ id: "done", agent: "task", task: "Done" },
				{ id: "inflight", agent: "task", task: "In flight" },
			],
		});

		const controller = new AbortController();
		const started: string[] = [];
		const running = runtime.run(
			async (request, signal) => {
				started.push(request.nodeId);
				if (request.nodeId === "done") return { result: resultFor(request) };
				return new Promise(resolve => {
					signal.addEventListener("abort", () => resolve({ status: "interrupted", error: "aborted" }), {
						once: true,
					});
				});
			},
			{ signal: controller.signal },
		);
		await waitFor(() => runtime.getSnapshot()?.nodes.inflight.status === "running");

		const restored = await createRuntime(store);
		const recovered = restored.getSnapshot()!;
		expect(recovered.nodes.done.status).toBe("succeeded");
		expect(recovered.nodes.inflight.status).toBe("interrupted");
		expect(recovered.status).toBe("interrupted");

		const resumedDispatches: string[] = [];
		const resumed = await restored.run(async request => {
			resumedDispatches.push(request.nodeId);
			return { result: resultFor(request) };
		});
		expect(resumedDispatches).toEqual([]);
		expect(resumed.nodes.done.status).toBe("succeeded");
		expect(resumed.status).toBe("interrupted");

		await restored.retryNode("inflight");
		const completed = await restored.run(async request => {
			resumedDispatches.push(request.nodeId);
			return { result: resultFor(request) };
		});
		expect(resumedDispatches).toEqual(["inflight"]);
		expect(completed.status).toBe("succeeded");

		controller.abort();
		await running;
	});

	it("cancels active work and prevents dependent dispatch", async () => {
		const runtime = await createRuntime();
		await runtime.createWorkflow({
			objective: "Stop safely",
			nodes: [
				{ id: "first", agent: "task", task: "First" },
				{ id: "second", agent: "task", task: "Second", needs: ["first"] },
			],
		});
		const dispatched: string[] = [];
		const running = runtime.run(async (request, signal) => {
			dispatched.push(request.nodeId);
			return new Promise(resolve => {
				signal.addEventListener("abort", () => resolve({ status: "interrupted", error: "cancelled" }), {
					once: true,
				});
			});
		});
		await waitFor(() => dispatched.includes("first"));
		await runtime.cancel();
		const cancelled = await running;

		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.nodes.first.status).toBe("cancelled");
		expect(cancelled.nodes.second.status).toBe("cancelled");
		expect(dispatched).toEqual(["first"]);
	});
});

function gatesRequest(nodeId: string): WorkflowDispatchRequest {
	return {
		nodeId,
		name: nodeId,
		agent: "task",
		task: nodeId,
		context: "test",
	};
}
