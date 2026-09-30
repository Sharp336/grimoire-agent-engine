import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { EngineOrdinaryEvent } from "../../src/engine/contracts";
import { EngineRuntime } from "../../src/engine/runtime";
import { AuthStorage } from "../../src/session/auth-storage";
import { admittedExecution, admitRequest, startRequest } from "../helpers/engine-runtime-admitted-fixture";

const root = process.argv[2]!;
const cwd = path.join(root, "workspace");
await fs.mkdir(cwd, { recursive: true });
const agentDir = path.join(root, "agent");
registerMockApi("s3-overflow-regression");
const mock = createMockModel({ responses: [{ content: ["x".repeat(300_000)] }] });
const auth = await AuthStorage.create(path.join(root, "auth.db"));
auth.setRuntimeApiKey("mock", "fixture-key");
const modelRegistry = new ModelRegistry(auth, path.join(root, "models.yml"));
const settings = await Settings.loadReadOnly({ cwd, agentDir });
const execution = admittedExecution(mock.model, modelRegistry, {
	taskRef: "grimoire://tasks/grimoire/model-overflow",
});
const runtime = await EngineRuntime.create({
	databasePath: path.join(root, "engine.sqlite"),
	// Keep this fixture focused on the shared 1 MiB admission contract; the
	// production Engine window is wider so its durable writer can chunk bursts.
	streamAdmissionLimits: { maxQueuedBytes: 4 * 1024 * 1024, maxEventBytes: 1024 * 1024 },
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
	},
	...execution.optionsFor({}),
});
try {
	const started = await admitRequest(
		runtime,
		startRequest(
			execution,
			{
				commandId: "overflow-cmd",
				agentInstanceId: "overflow-agent",
				agentInstanceRef: "grimoire://tasks/grimoire/model-overflow/agents/overflow",
				executionId: "overflow-execution",
				attemptId: "overflow-attempt",
			},
			{ cwd, principalId: "owner", input: "overflow fixture" },
		),
	);
	await runtime.drain();
	const attempt = await runtime.store.getAttempt(started.attemptId);
	const events = (await runtime.store.pendingEvents()).filter(event => event.attemptId === started.attemptId);
	// model_settled and completed are ordinary kinds: selecting that union arm keeps payload a plain record.
	const ordinary = events.filter(event => event.kind !== "assistant_snapshot") as EngineOrdinaryEvent[];
	const settlements = ordinary.filter(event => event.kind === "model_settled");
	assert.equal(attempt?.state, "interrupted");
	assert.equal(mock.calls.length, 1);
	assert.equal(settlements.length, 1);
	assert.equal(settlements[0]!.payload?.status, "failed");
	assert.equal(
		ordinary.some(event => event.kind === "completed"),
		false,
	);
	console.log(
		JSON.stringify({ state: attempt.state, calls: mock.calls.length, modelOutcome: settlements[0]!.payload?.status }),
	);
} finally {
	await runtime.dispose();
	auth.close();
}
