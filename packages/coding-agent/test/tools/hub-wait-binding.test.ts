/**
 * Job wait binding: task agents cannot enter an unbound (bare) wait — it is
 * refused immediately and non-destructively; explicit ids settle immediately
 * whether completed, missing, or owned by another agent; aborting an in-flight
 * wait never cancels the watched job.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails, HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

const SELF_ID = "Main";
const WORKER_ID = "Worker";

function makeSession(manager: AsyncJobManager | undefined, taskDepth = 0): ToolSession {
	const stub = {
		cwd: process.cwd(),
		taskDepth,
		settings: {
			get(key: string): unknown {
				if (key === "async.pollWaitDuration") return "5m";
				if (key === "irc.timeoutMs") return 120_000;
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => (taskDepth > 0 ? WORKER_ID : SELF_ID),
	};
	// Structurally-partial test session: HubTool only touches the fields above.
	return stub as unknown as ToolSession;
}

/** Register a job that never settles on its own; returns its id + resolver. */
function registerHangingJob(
	manager: AsyncJobManager,
	label: string,
	ownerId: string = SELF_ID,
): { id: string; finish: (text: string) => void } {
	const { promise, resolve } = Promise.withResolvers<string>();
	const id = manager.register("bash", label, async () => promise, { ownerId });
	return { id, finish: resolve };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(item => item.type === "text")?.text ?? "";
}

describe("hub job wait binding", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a task agent's bare wait is refused immediately and leaves its jobs running", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: WORKER_ID, displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "worker build", WORKER_ID);
		const tool = new HubTool(makeSession(manager, 1));

		// The poll window is 5 m; a regression to a blocking wait fails via the
		// test timeout. The elapsed bound only proves the refusal was immediate.
		const startedAt = Date.now();
		const result = await tool.execute("call_1", { op: "wait" });
		const elapsed = Date.now() - startedAt;

		expect(result.isError).toBe(true);
		const text = resultText(result);
		expect(text).toContain("Bare `wait` is refused for task agents");
		expect(text).toContain(job.id);
		expect(elapsed).toBeLessThan(1_000);
		// Non-destructive: the job was neither cancelled nor consumed.
		expect(manager.getJob(job.id)?.status).toBe("running");

		manager.cancel(job.id);
	});

	test("a task agent may still wait on an explicit owned job id", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: WORKER_ID, displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "worker build", WORKER_ID);
		const tool = new HubTool(makeSession(manager, 1));

		const pending = tool.execute("call_2", { op: "wait", ids: [job.id] });
		job.finish("built");
		const result = await pending;

		const details = result.details as CoordinationDetails;
		expect(result.isError).not.toBe(true);
		expect(details.jobs?.map(j => j.status)).toEqual(["completed"]);
		expect(details.jobs?.[0]?.resultText).toBe("built");
	});

	test("explicit ids of an already-settled job return the snapshot immediately", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const id = manager.register("bash", "quick job", async () => "done", { ownerId: SELF_ID });
		await manager.waitForAll();

		const startedAt = Date.now();
		const result = await new HubTool(makeSession(manager)).execute("call_3", { op: "wait", ids: [id] });
		const elapsed = Date.now() - startedAt;

		const details = result.details as CoordinationDetails;
		expect(details.jobs?.map(j => j.status)).toEqual(["completed"]);
		expect(resultText(result)).toContain("## Completed (1)");
		expect(elapsed).toBeLessThan(1_000);
	});

	test("explicit ids of a job owned by another agent return immediately", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Sibling", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const sibling = registerHangingJob(manager, "sibling job", "Other");
		const tool = new HubTool(makeSession(manager));

		const startedAt = Date.now();
		const result = await tool.execute("call_4", { op: "wait", ids: [sibling.id] });
		const elapsed = Date.now() - startedAt;

		// Owner filtering is preserved: the sibling job is invisible, so the
		// wait reports no matches instead of blocking on a job it may not touch.
		expect(resultText(result)).toContain("No matching jobs found for IDs");
		expect(elapsed).toBeLessThan(1_000);
		expect(manager.getJob(sibling.id)?.status).toBe("running");

		manager.cancel(sibling.id);
	});

	test("aborting an in-flight bound wait never cancels the watched job", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "sleep forever", SELF_ID);
		const tool = new HubTool(makeSession(manager));

		const controller = new AbortController();
		const pending = tool.execute("call_5", { op: "wait", ids: [job.id], timeoutMs: 0 }, controller.signal);
		setTimeout(() => controller.abort(), 50);
		await pending;

		// Steering interrupted the wait only — the job was not cancelled and its
		// delivery is not suppressed.
		expect(manager.getJob(job.id)?.status).toBe("running");

		manager.cancel(job.id);
	});
});
