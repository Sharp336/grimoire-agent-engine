/** Disposable cross-language ClientHost acceptance fixture; never opens an installed Engine database. */
import * as path from "node:path";
import { getBlobsDir } from "@oh-my-pi/pi-utils";
import { startEngineControlQueryServer } from "../../src/engine/control-query";
import { engineAgentId, engineRouteToken } from "../../src/engine/route";
import { EngineRuntime } from "../../src/engine/runtime";
import { BlobStore } from "../../src/session/blob-store";
import { SessionManager } from "../../src/session/session-manager";

const root = process.argv[2];
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith("history-engine-")) {
	throw new Error("An explicit disposable history-engine-* directory is required");
}
const blobsDir = getBlobsDir();
if (path.resolve(blobsDir) !== path.resolve(root, "agent", "blobs"))
	throw new Error("Fixture requires a process-isolated blob directory");
const runtime = await EngineRuntime.create({ databasePath: path.join(root, "engine.sqlite") });
try {
	const agentInstanceId = process.argv[3] || "local-agent";
	const manager = SessionManager.create(
		root,
		path.join(root, "engine-sessions", engineRouteToken(agentInstanceId)),
		runtime.store.sessionStorage,
	);
	for (let index = 0; index < 3; index++) {
		manager.appendMessage({
			role: "user",
			content: `${index}: ${"Native history ☃ ".repeat(200_000)}`,
			timestamp: Date.now(),
		});
	}
	const image = Buffer.alloc(2048, 59);
	const blob = await new BlobStore(blobsDir).put(image);
	manager.appendMessage({
		role: "user",
		content: [{ type: "image", mimeType: "image/png", data: image.toString("base64") }],
		timestamp: Date.now(),
	});
	const checkpoint = await manager.flushAndCheckpoint();
	if (!checkpoint) throw new Error("Fixture native checkpoint was not persisted");
	const sessionFile = manager.getSessionFile()!;
	const attachment = path.join(sessionFile.slice(0, -".jsonl".length), "evidence.txt");
	await Bun.write(attachment, "exact attachment ☃");
	const binding = {
		bindingId: "binding",
		commandId: "start",
		agentInstanceId,
		executionId: "execution",
		attemptId: "attempt",
		engineAgentId: engineAgentId(agentInstanceId),
		profileDigest: "fixture",
		state: "idle" as const,
		engineGeneration: runtime.engineGeneration,
		bindingGeneration: 1,
		authorityGeneration: 1,
		sessionFile,
	};
	await runtime.store.putBinding(binding);
	await runtime.store.putAttempt(binding, "completed");
	const server = await startEngineControlQueryServer({
		runtime,
		runtimeDir: root,
		deviceId: "device",
		engineId: "engine",
		resolveLaunchProfile: async () => {
			throw new Error("Model dispatch is forbidden in archive acceptance");
		},
	});
	try {
		console.log(
			JSON.stringify({ binding, sessionId: manager.getSessionId(), sessionFile, attachment, imageBlob: blob.path }),
		);
		await Bun.stdin.text();
	} finally {
		await server.close();
	}
} finally {
	await runtime.dispose();
}
