import { expect, it } from "bun:test";
import { projectEvent } from "../src/engine/rocks-runtime-projection";
import { RocksEngineMutations } from "../src/engine/rocks-store";
import { readStorageBinding, StorageClient } from "../src/session/storage-client";

it.skipIf(!Bun.env.ARTEL_STORAGE_TEST_BINDING)(
	"keeps branch controls responsive while another Rocks session produces events",
	async () => {
		const client = new StorageClient(readStorageBinding(Bun.env.ARTEL_STORAGE_TEST_BINDING)!);
		const store = new RocksEngineMutations(client, async (tx, event) => {
			// A branch projection visits several descendants; model that longer critical section.
			if (event.kind === "holds_changed") await Bun.sleep(20);
			await projectEvent(tx, event);
		});
		await store.nextEngineGeneration();
		const root = `control-${crypto.randomUUID()}`;
		const child = `${root}-child`;
		const hot = `${root}-hot`;
		for (const id of [root, child, hot])
			await store.registerAgent({
				agentInstanceId: id,
				agentInstanceRef: `grimoire://tasks/grimoire/control-test/agents/${id}`,
				principalId: "native-control-test",
				authorityGeneration: 1,
				...(id === child ? { parentAgentInstanceId: root } : {}),
			});
		await store.branchIntent(child, "manual", "pause", 0);
		const hotRun = (async () => {
			for (let n = 0; n < 60; n++)
				await store.mutation(hot, tx => store.identityEvent(tx, hot, `hot-${n}`, "holds_changed", {}));
		})();
		try {
			const start = performance.now();
			await store.branchIntent(root, "parent-pause", "pause", 0);
			expect((await store.intent(child)).holds.map(hold => hold.commandId).sort()).toEqual([
				"manual",
				"parent-pause",
			]);
			await store.branchIntent(root, "parent-resume", "resume", 1);
			expect((await store.intent(child)).holds.map(hold => hold.commandId)).toEqual(["manual"]);
			await store.branchIntent(child, "child-resume", "resume", 3);
			expect((await store.intent(child)).manualHold).toBe(false);
			expect(performance.now() - start).toBeLessThan(5000);
		} finally {
			await hotRun;
			await store.close();
		}
		const events = await store.records.query("event_agent", [hot]);
		expect(events.records).toHaveLength(61); // Registration plus every hot-session event.
		expect(new Set(events.records.map(row => row.id)).size).toBe(61);
	},
	15_000,
);
