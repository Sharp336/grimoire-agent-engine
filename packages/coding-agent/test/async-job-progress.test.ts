import { afterEach, describe, expect, test, vi } from "bun:test";
import { type AsyncJob, AsyncJobManager, type AsyncJobProgressSink } from "@oh-my-pi/pi-coding-agent/async/job-manager";

function heldJob(manager: AsyncJobManager, ownerId = "Main") {
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<(text: string) => void>();
	const jobId = manager.register(
		"bash",
		"held",
		async ({ reportAgentProgress }) => {
			started.resolve(reportAgentProgress);
			await gate.promise;
			return "done";
		},
		{ ownerId },
	);
	return { jobId, report: started.promise, release: gate.resolve };
}

function recordingSink(active = true): {
	sink: AsyncJobProgressSink;
	seen: Array<{ jobId: string; text: string; seq: number }>;
	setActive(value: boolean): void;
} {
	const seen: Array<{ jobId: string; text: string; seq: number }> = [];
	let state: "idle" | "streaming" = active ? "streaming" : "idle";
	return {
		sink: {
			state: () => state,
			deliver: (jobId, text, _job: AsyncJob, seq) => {
				seen.push({ jobId, text, seq });
			},
		},
		seen,
		setActive(value) {
			state = value ? "streaming" : "idle";
		},
	};
}

describe("AsyncJobManager model progress", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("coalesces to the newest update on a fixed trailing edge", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const job = heldJob(manager);
		const report = await job.report;

		report("first");
		report("second");
		report("newest");
		expect(recorder.seen.map(item => item.text)).toEqual(["first"]);

		vi.advanceTimersByTime(1_000);
		expect(recorder.seen).toEqual([
			{ jobId: job.jobId, text: "first", seq: 1 },
			{ jobId: job.jobId, text: "newest", seq: 2 },
		]);

		report("stale after completion");
		job.release();
		await manager.waitForAll();
		vi.advanceTimersByTime(1_000);
		expect(recorder.seen).toHaveLength(2);
	});

	test("respects wait/ack suppression and routes only to the owning active session", async () => {
		const manager = new AsyncJobManager({});
		const mine = recordingSink(false);
		const other = recordingSink();
		manager.registerProgressSink("Main", mine.sink);
		manager.registerProgressSink("Other", other.sink);
		const job = heldJob(manager);
		const report = await job.report;

		report("idle");
		expect(mine.seen).toEqual([]);
		mine.setActive(true);
		report("active");
		expect(mine.seen.map(item => item.text)).toEqual(["active"]);
		expect(other.seen).toEqual([]);

		manager.watchJobs([job.jobId]);
		report("watched");
		expect(mine.seen).toHaveLength(1);
		manager.unwatchJobs([job.jobId]);
		manager.acknowledgeDeliveries([job.jobId]);
		report("acknowledged");
		expect(mine.seen).toHaveLength(1);

		job.release();
		await manager.waitForAll();
	});

	test("sink failures are best-effort and do not block completion", async () => {
		const completions: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerProgressSink("Main", {
			state: () => "streaming",
			deliver: async () => {
				throw new Error("sink failed");
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});

		const jobId = manager.register(
			"bash",
			"failure",
			async ({ reportAgentProgress }) => {
				reportAgentProgress("tick");
				return "complete";
			},
			{ ownerId: "Main" },
		);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		expect(completions).toEqual(["complete"]);
	});
});
