import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { buildJobResult } from "@oh-my-pi/pi-coding-agent/tools/hub/jobs";

function makeSession(manager: AsyncJobManager | undefined): ToolSession {
	// Structurally-partial test session: buildJobResult/snapshotJobs only touch
	// `session.asyncJobManager`.
	const stub = { asyncJobManager: manager };
	return stub as unknown as ToolSession;
}

const USAGE = {
	input: 7,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	premiumRequests: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 4 },
};

/**
 * A manager whose delivery sink always fails, so every settled job's delivery
 * stays queued on retry backoff — mirroring the real window in which a `hub`
 * wait/jobs call consumes the job before the idle async-result flush.
 */
function managerWithPendingDeliveries(): AsyncJobManager {
	return new AsyncJobManager({
		onJobComplete: async () => {
			throw new Error("delivery failed");
		},
	});
}

async function waitForQueuedRetry(manager: AsyncJobManager): Promise<void> {
	// Wait for the failing sink's first attempt to settle and re-queue the
	// delivery on retry backoff (nextRetryAt in the future) — the precondition
	// the hub consumption path is meant to intercept.
	const deadline = Date.now() + 2_000;
	while (true) {
		const state = manager.getDeliveryState();
		if (state.queued > 0 && state.nextRetryAt !== undefined && state.nextRetryAt > Date.now()) return;
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the retry-queued delivery");
		await Bun.sleep(5);
	}
}

describe("hub job consumption carries background task usage", () => {
	test("buildJobResult aggregates settled task job usage into details.usage", async () => {
		const manager = managerWithPendingDeliveries();
		const id = manager.register("task", "bg_1", async ({ reportUsage }) => {
			reportUsage?.(USAGE);
			return "done";
		});
		await manager.waitForAll();
		await waitForQueuedRetry(manager);

		const job = manager.getJob(id)!;
		// The settled job's snapshot must carry usage, and the consumed result
		// must fold it into details.usage so the session can bill the background
		// subagent even though no async-result follow-up will be delivered.
		const result = buildJobResult(makeSession(manager), manager, "jobs", [job], [], []);
		expect(result.details?.op).toBe("jobs");
		expect(result.details?.jobs?.[0]?.status).toBe("completed");
		expect(result.details?.jobs?.[0]?.usage).toEqual(USAGE);
		expect(result.details?.usage).toEqual(USAGE);
	});

	test("a bash job without reported usage leaves details.usage absent", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const id = manager.register("bash", "bg_2", async () => "output");
		await manager.waitForAll();

		const job = manager.getJob(id)!;
		const result = buildJobResult(makeSession(manager), manager, "wait", [job], [], []);
		expect(result.details?.jobs?.[0]?.status).toBe("completed");
		expect(result.details?.jobs?.[0]?.usage).toBeUndefined();
		expect(result.details?.usage).toBeUndefined();
	});

	test("a job already delivered is not re-counted by a later hub snapshot", async () => {
		// Contract: usage must be billed exactly once per background subagent.
		// After the first hub result consumes (acknowledges) a job's queued
		// delivery, the job still sits in retention with its usage intact — a
		// second snapshot must NOT carry that usage again, or the session
		// double-bills it (mirrors the async-result-already-delivered case).
		const manager = managerWithPendingDeliveries();
		const id = manager.register("task", "bg_3", async ({ reportUsage }) => {
			reportUsage?.(USAGE);
			return "done";
		});
		await manager.waitForAll();
		await waitForQueuedRetry(manager);
		const job = manager.getJob(id)!;

		const first = buildJobResult(makeSession(manager), manager, "jobs", [job], [], []);
		expect(first.details?.usage).toEqual(USAGE);

		const second = buildJobResult(makeSession(manager), manager, "jobs", [job], [], []);
		expect(second.details?.jobs?.[0]?.status).toBe("completed");
		expect(second.details?.usage).toBeUndefined();
	});

	test("a job that settles while watched by a foreground hub wait still bills its usage", async () => {
		// Contract: `hub wait` watches running jobs, so a job completing during
		// the wait has its delivery skipped entirely (no async-result will ever
		// form). The consuming hub result must still carry that usage, or the
		// background subagent's cost is lost for the wait path.
		const manager = managerWithPendingDeliveries();
		const id = manager.register("task", "bg_4", async ({ reportUsage }) => {
			reportUsage?.(USAGE);
			return "done";
		});
		manager.watchJobs([id]);
		await manager.waitForAll();
		manager.unwatchJobs([id]);

		const job = manager.getJob(id)!;
		const result = buildJobResult(makeSession(manager), manager, "wait", [job], [], []);
		expect(result.details?.jobs?.[0]?.status).toBe("completed");
		expect(result.details?.usage).toEqual(USAGE);
	});
});
