import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EngineRuntime } from "../../src/engine/runtime";
import { startEngineControlQueryServer } from "../../src/engine/control-query";
import { engineAgentId, engineAgentInstanceId } from "../../src/engine/route";
import { startStorageWorker } from "../helpers/storage-worker-fixture";
import { admittedExecutionFixture, admittedFixtureStart, binding, semanticBinding } from "../helpers/runtime-v1-rocks-fixture";

const [root, agentRef, owner, taskRef] = process.argv.slice(2);
const executable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
if (!root || !agentRef || !owner || !taskRef || !executable) throw new Error("Disposable archive fixture arguments required");
await fs.mkdir(path.join(root, "storage"), { recursive: true });
const worker = await startStorageWorker(executable, path.join(root, "storage"), crypto.randomUUID() + crypto.randomUUID(), 1);
process.env.GRIMOIRE_STORAGE_BINDING = JSON.stringify(worker.binding);
process.env.PI_BLOBS_DIR = path.join(root, "blobs");
const runtime = await EngineRuntime.create({ databasePath: path.join(root, "engine"), deviceId: "archive-fixture" });
const server = await startEngineControlQueryServer({ runtime, runtimeDir: root, deviceId: "archive-fixture", engineId: "engine" });
try {
	const suffix = crypto.randomUUID();
	const id = engineAgentInstanceId(agentRef);
	const target = await admittedFixtureStart(runtime.store, {
		...binding(suffix), agentInstanceId: id, engineAgentId: engineAgentId(id),
		engineGeneration: runtime.engineGeneration, bindingSnapshot: semanticBinding(agentRef, taskRef),
	}, agentRef, owner, admittedExecutionFixture(taskRef), "archive-fixture");
	const familyId = `archive-${suffix}`;
	const sessionPath = `native://${familyId}/main`;
	await worker.client.write({ operationId: `history-${suffix}`, familyId, generationId: "main", firstSeq: 1,
		entries: [{ entryId: "answer", parentId: null, kind: "message", payload: {
			type: "message", message: { role: "assistant", content: [{ type: "text", text: "Preserve exact native history: \u2603" }] },
		} }], durability: "required", dependencies: [] });
	const read = () => worker.client.readRange({ familyId, generationId: "main", maxRecords: 10, maxBytes: 8192 });
	const before = JSON.stringify((await read()).events);
	const terminal = { ...target, state: "idle" as const, sessionFile: sessionPath };
	await runtime.store.commitAttemptTransition(terminal, "completed", [{ kind: "completed" }], {
		transcriptCheckpoint: { sessionId: familyId, sessionPath, leafEntryId: "answer", byteBoundary: 0,
			native: { familyId, generationId: "main", throughSeq: 1, incarnation: worker.client.incarnation } },
	});
	console.log(JSON.stringify({ binding: terminal, historyBytes: Buffer.byteLength(before) }));
	for await (const _chunk of Bun.stdin.stream()) { /* Closing stdin ends this isolated fixture. */ }
	if (JSON.stringify((await read()).events) !== before) throw new Error("Native archive changed history bytes");
	if ((await runtime.store.getAttempt(target.attemptId))?.state !== "completed") throw new Error("Archive changed Attempt state");
	if ((await runtime.store.listAttempts(0, 10)).length !== 1) throw new Error("Archive launched another Attempt");
	console.log(JSON.stringify({ historyPreserved: true, attempts: 1 }));
} finally {
	await server.close();
	await runtime.dispose();
	await worker.stop();
}
