import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { StreamAdmissionError } from "@oh-my-pi/pi-ai/utils/stream-admission";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { EngineRuntime } from "../../src/engine/runtime";
import { AuthStorage } from "../../src/session/auth-storage";

// The mock producer reports its rejected error event after stream abort. Keep
// that fixture-only rejection separate from the durable runtime outcome.
process.on("unhandledRejection", error => {
	if (!(error instanceof StreamAdmissionError)) throw error;
});
const root = process.argv[2];
const cwd = path.join(root, "workspace");
await fs.mkdir(cwd, { recursive: true });
const agentDir = path.join(root, "agent");
registerMockApi("s3-overflow-regression");
const mock = createMockModel({ responses: [{ content: ["x".repeat(300_000)] }] });
const auth = await AuthStorage.create(path.join(root, "auth.db"));
auth.setRuntimeApiKey("mock", "fixture-key");
const modelRegistry = new ModelRegistry(auth, path.join(root, "models.yml"));
const settings = await Settings.loadReadOnly({ cwd, agentDir });
const runtime = await EngineRuntime.create({
	databasePath: path.join(root, "engine.sqlite"),
	dispatchPrompt: (session, input) => session.prompt(input),
	sessionDefaults: {
		cwd,
		agentDir,
		settings,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		modelRegistry,
		model: mock.model,
	},
});
try {
	const start = await runtime.start(
		{
			commandId: "overflow-cmd",
			agentInstanceId: "overflow-agent",
			executionId: "overflow-execution",
			attemptId: "overflow-attempt",
			authorityGeneration: 1,
			cwd,
			input: "overflow fixture",
		},
		{ spawns: "", profileDigest: "overflow-profile", enableMCP: false, enableLsp: false },
	);
	await runtime.drain();
	const attempt = await runtime.store.getAttempt(start.attemptId);
	const events = (await runtime.store.pendingEvents()).filter(event => event.attemptId === start.attemptId);
	const settlements = events.filter(event => event.kind === "model_settled");
	assert.equal(attempt?.state, "interrupted");
	assert.equal(mock.calls.length, 1);
	assert.equal(settlements.length, 1);
	assert.equal(settlements[0].payload?.status, "failed");
	assert.equal(
		events.some(event => event.kind === "completed"),
		false,
	);
	console.log(
		JSON.stringify({ state: attempt.state, calls: mock.calls.length, modelOutcome: settlements[0].payload?.status }),
	);
} finally {
	await runtime.dispose();
	auth.close();
}
