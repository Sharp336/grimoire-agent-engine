import { describe, expect, test, vi } from "bun:test";
import { AsyncJobManager, JobProjectionService } from "../src/async";

describe("JobProjectionService", () => {
	test("filters every read and cancellation by authoritative owner and preserves queued state", async () => {
		const manager = new AsyncJobManager({ retentionMs: 5_000 });
		const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		const ownId = manager.register("bash", "own", () => gates[0]!.promise, {
			id: "own-job",
			ownerId: "Main",
			queued: true,
		});
		const otherId = manager.register("bash", "other", () => gates[1]!.promise, {
			id: "other-job",
			ownerId: "Peer",
		});
		const projection = new JobProjectionService({ manager, ownerId: "Main" });

		expect(projection.list().jobs).toMatchObject([{ id: ownId, status: "running", queued: true }]);
		expect(projection.get(otherId)).toBeUndefined();
		expect(await projection.cancel([otherId])).toEqual([
			{ id: otherId, status: "not_found", message: `Background job not found: ${otherId}` },
		]);
		expect(manager.getJob(otherId)?.status).toBe("running");
		expect((await projection.cancel([ownId]))[0]?.status).toBe("cancelled");
		gates[1]!.resolve("done");
		await manager.dispose();
	});

	test("retains bounded settled output until manager expiry", async () => {
		vi.useFakeTimers();
		try {
			const manager = new AsyncJobManager({ retentionMs: 5 });
			const id = manager.register("bash", "short", async () => "done", { ownerId: "Main" });
			await manager.getJob(id)!.promise;
			const projection = new JobProjectionService({ manager, ownerId: "Main" });
			expect(projection.get(id)).toMatchObject({ id, status: "completed", resultText: "done" });
			vi.advanceTimersByTime(6);
			expect(projection.get(id)).toBeUndefined();
			await manager.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});
