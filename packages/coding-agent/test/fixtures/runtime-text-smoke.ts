import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runtimeLimits, validateRuntimeValue } from "../../src/engine/runtime-protocol";
import { EngineStore } from "../../src/engine/store";

// Compile this existing owner path with Bun --compile; it must keep native FFI
// working without an extra SQLite DLL in the package or a full-cell fallback.
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error("An explicitly owned absolute TEMP path is required");
await fs.mkdir(directory); // A prior runtime directory must never be reused.
const store = await EngineStore.open(path.join(directory, "engine.sqlite"));
try {
	const engineGeneration = await store.nextEngineGeneration();
	const agent = {
		agentInstanceId: "native-text-smoke",
		agentInstanceRef: "grimoire://tasks/grimoire/runtime-smoke/agents/native-text",
		principalId: "native-text-owner",
		authorityGeneration: 1,
	};
	await store.registerAgent(agent);
	const sessionPath = "/runtime-text-smoke.jsonl";
	const header = JSON.stringify({ type: "session", id: "native-text-session", version: 3, cwd: directory });
	const entry = JSON.stringify({
		type: "message",
		id: "entry",
		parentId: null,
		message: { role: "assistant", content: "я😀".repeat(1_400_000) },
	});
	await store.sessionStorage.writeText(sessionPath, `${header}\n${entry}\n`);
	await store.putBinding({
		agentInstanceId: agent.agentInstanceId,
		bindingId: "binding",
		commandId: "command",
		executionId: "execution",
		attemptId: "attempt",
		engineAgentId: "native-text",
		profileDigest: "profile",
		state: "running",
		engineGeneration,
		bindingGeneration: 1,
		authorityGeneration: 1,
		sessionFile: sessionPath,
	});
	const page = await store.nativeHistoryPage(agent.agentInstanceId);
	assert.equal(page.entryRef?.entryId, "entry");
	const resource = {
		kind: "history_entry",
		agentInstanceRef: agent.agentInstanceRef,
		sessionId: page.sessionId,
		entryId: "entry",
		revision: page.entryRef!.revision,
		bytes: Buffer.byteLength(entry),
		mediaType: "application/json",
	};
	for (const offset of [0, 65535, resource.bytes - runtimeLimits.httpRangeBytes]) {
		const range = await store.runtimeResource({
			principalId: agent.principalId,
			resource,
			offset,
			limit: runtimeLimits.httpRangeBytes,
		});
		validateRuntimeValue("httpRange", range);
		assert.deepEqual(
			Buffer.from(String(range.contentBase64), "base64"),
			Buffer.from(entry).subarray(offset, offset + runtimeLimits.httpRangeBytes),
		);
	}
	console.log(
		JSON.stringify({
			kind: "native_text_smoke",
			status: "PASS",
			platform: process.platform,
			arch: process.arch,
			bun: Bun.version,
			sourceBytes: resource.bytes,
			ranges: 3,
			rangeBytes: runtimeLimits.httpRangeBytes,
		}),
	);
} finally {
	await store.close();
}
