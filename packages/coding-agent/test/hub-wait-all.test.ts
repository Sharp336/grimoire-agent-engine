/**
 * `hub wait` with `all: true` blocks until every watched job settles
 * (default returns on the first); an explicit `timeoutMs` still bounds it.
 * Runs against a real AsyncJobManager with real registered jobs (#6906).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function makeSession(manager: AsyncJobManager): HubTool {
	return new HubTool({
		agentRegistry: undefined,
		getAgentId: () => "test-agent",
		asyncJobManager: manager,
		settings: { get: () => "30s" },
	} as never);
}

function statuses(result: unknown): Array<{ id: string; status: string }> {
	return (result as { details: { jobs: Array<{ id: string; status: string }> } }).details.jobs;
}

function register(manager: AsyncJobManager, label: string, done: { promise: Promise<string> }): string {
	return manager.register("task", label, async () => done.promise, { ownerId: "test-agent" });
}

describe("hub wait all mode (issue #6906)", () => {
	afterEach(() => {
		// Pending run functions resolve via their deferreds; nothing else to reap.
	});

	it("returns on the first settled job by default", async () => {
		const manager = new AsyncJobManager({});
		const d1 = Promise.withResolvers<string>();
		const d2 = Promise.withResolvers<string>();
		register(manager, "job-a", d1);
		register(manager, "job-b", d2);
		const hub = makeSession(manager);

		const waitPromise = hub.execute("c1", { op: "wait" });
		d1.resolve("result-a");

		const result = await waitPromise;
		expect(statuses(result).find(j => j.id === "bg_1")?.status).toBe("completed");
		expect(statuses(result).find(j => j.id === "bg_2")?.status).toBe("running");
		d2.resolve("result-b");
	});

	it("with all: true waits until every watched job settles", async () => {
		const manager = new AsyncJobManager({});
		const d1 = Promise.withResolvers<string>();
		const d2 = Promise.withResolvers<string>();
		const id1 = register(manager, "job-a", d1);
		const id2 = register(manager, "job-b", d2);
		const hub = makeSession(manager);

		let settled = false;
		const waitPromise = hub.execute("c2", { op: "wait", all: true, ids: [id1, id2] }).then(result => {
			settled = true;
			return result;
		});

		d1.resolve("result-a");
		await sleep(100);
		expect(settled).toBe(false);

		d2.resolve("result-b");
		const result = await waitPromise;
		expect(statuses(result).every(j => j.status === "completed")).toBe(true);
	});

	it("with all: true still honors an explicit timeoutMs", async () => {
		const manager = new AsyncJobManager({});
		const d1 = Promise.withResolvers<string>();
		const d2 = Promise.withResolvers<string>();
		const id1 = register(manager, "job-a", d1);
		const id2 = register(manager, "job-b", d2);
		const hub = makeSession(manager);

		const result = await hub.execute("c3", { op: "wait", all: true, ids: [id1, id2], timeoutMs: 100 });
		expect(statuses(result).every(j => j.status === "running")).toBe(true);
	});
});
