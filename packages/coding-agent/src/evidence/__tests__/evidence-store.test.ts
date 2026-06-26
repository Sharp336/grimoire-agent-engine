import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { EvidenceStore } from "../store";
import type { InvestigationRequestInput } from "../types";

const baseInput: InvestigationRequestInput = {
	question: "Which API is correct?",
	objective: "It could change the advisor guidance.",
	mode: "docs",
	risk: "could_change_direction",
};

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-evidence-store-"));
	try {
		return await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function createStore(dir: string, sessionId = "session-1"): EvidenceStore {
	const store = EvidenceStore.fromArtifactsDir(dir, sessionId);
	if (!store) throw new Error("store unavailable");
	return store;
}

describe("EvidenceStore", () => {
	it("reconciles running records back to queued", async () => {
		await withTempDir(async dir => {
			const store = createStore(dir);
			const record = await store.create(baseInput);
			await store.update(record.id, { status: "running" });

			const reconciled = await store.reconcileStale();
			const updated = reconciled.find(entry => entry.id === record.id);
			expect(updated?.status).toBe("queued");

			const reloaded = createStore(dir);
			expect((await reloaded.get(record.id))?.status).toBe("queued");
		});
	});

	it("reconciles claimed records back to pending", async () => {
		await withTempDir(async dir => {
			const store = createStore(dir);
			const record = await store.create(baseInput);
			await store.update(record.id, { status: "ready", summary: "answer" });
			await store.claimForAdvisor();

			const reconciled = await store.reconcileStale();
			const updated = reconciled.find(entry => entry.id === record.id);
			expect(updated?.advisorDelivery).toBe("pending");
			expect(updated?.status).toBe("ready");
		});
	});

	it("release and delivery transitions affect only requested ids", async () => {
		await withTempDir(async dir => {
			const store = createStore(dir);
			const first = await store.create({ ...baseInput, question: "first" });
			const second = await store.create({ ...baseInput, question: "second" });
			const third = await store.create({ ...baseInput, question: "third" });
			await store.update(first.id, { status: "ready", summary: "first" });
			await store.update(second.id, { status: "ready", summary: "second" });
			await store.update(third.id, { status: "ready", summary: "third" });
			await store.claimForAdvisor(2);

			await store.releaseAdvisorClaims([first.id]);
			let records = await store.list();
			expect(records.find(entry => entry.id === first.id)?.advisorDelivery).toBe("pending");
			expect(records.find(entry => entry.id === second.id)?.advisorDelivery).toBe("claimed");
			expect(records.find(entry => entry.id === third.id)?.advisorDelivery).toBe("pending");

			await store.markDeliveredToAdvisor([first.id, second.id]);
			records = await store.list();
			expect(records.find(entry => entry.id === first.id)?.advisorDelivery).toBe("delivered");
			expect(records.find(entry => entry.id === second.id)?.advisorDelivery).toBe("delivered");
			expect(records.find(entry => entry.id === third.id)?.advisorDelivery).toBe("pending");
		});
	});

	it("serializes concurrent status update and advisor claim", async () => {
		await withTempDir(async dir => {
			const store = createStore(dir);
			const record = await store.create(baseInput);

			const [, batch] = await Promise.all([
				store.update(record.id, { status: "ready", summary: "done" }),
				store.claimForAdvisor(),
			]);

			expect(batch?.ids).toEqual([record.id]);
			const updated = await store.get(record.id);
			expect(updated?.status).toBe("ready");
			expect(updated?.summary).toBe("done");
			expect(updated?.advisorDelivery).toBe("claimed");
		});
	});

	it("persists concurrent worker updates on different ids", async () => {
		await withTempDir(async dir => {
			const store = createStore(dir);
			const first = await store.create({ ...baseInput, question: "first" });
			const second = await store.create({ ...baseInput, question: "second" });

			await Promise.all([
				store.update(first.id, { status: "ready", summary: "first ready" }),
				store.update(second.id, { status: "failed", error: "second failed" }),
			]);

			const reloaded = createStore(dir);
			expect((await reloaded.get(first.id))?.summary).toBe("first ready");
			expect((await reloaded.get(second.id))?.error).toBe("second failed");
		});
	});
});
