import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { engineAgentInstanceId } from "../../src/engine/route";
import { EngineRuntime } from "../../src/engine/runtime";
import { AuthStorage } from "../../src/session/auth-storage";

// Abrupt-process fixture: the only replacement is provider output. Lifecycle,
// persistent stream chunks, recovery, holds and bounded reads are the owner path.
const directory = process.argv[2];
const mode = process.argv[3];
if (!directory || !path.isAbsolute(directory) || !["stream", "recover"].includes(mode))
	throw new Error("An absolute owned run directory and stream/recover mode are required");
const readyFile = path.join(directory, "ready.json");
if (mode === "stream" && (await Bun.file(readyFile).exists()))
	throw new Error("Crash fixture already has a durable baseline");
const cwd = path.join(directory, "workspace");
fs.mkdirSync(cwd, { recursive: true });
const agentDir = path.join(directory, "agent");
registerMockApi("runtime-v1-crash");
const mock = createMockModel({ handler: () => ({ content: [text] }) });
const auth = await AuthStorage.create(path.join(directory, "mock-auth.db"));
auth.setRuntimeApiKey("mock", "isolated-crash-fixture");
const modelRegistry = new ModelRegistry(auth, path.join(directory, "models.yml"));
const settings = await Settings.loadReadOnly({ cwd, agentDir });
const agentInstanceRef = "grimoire://tasks/grimoire/crash-fixture/agents/stream";
const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
const principalId = "crash-owner";
const attemptId = "crash-attempt";
let dispatches = 0;
const text = mode === "stream" ? crypto.randomBytes((3 * 1024 * 1024 * 3) / 4).toString("base64") : "";
const waiting = Promise.withResolvers<void>();
const runtime = await EngineRuntime.create({
	databasePath: path.join(directory, "engine.sqlite"),
	sessionDefaults: {
		cwd,
		agentDir,
		settings,
		modelRegistry,
		model: mock.model,
		disableExtensionDiscovery: true,
		contextFiles: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	},
	dispatchPrompt: async (session, input, identity) => {
		dispatches++;
		session.agent.streamFn = (_model, context, options) => {
			const output = new AssistantMessageEventStream();
			void (async () => {
				try {
					for await (const event of mock.stream(mock.model, context, options)) {
						if (event.type === "done") await waiting.promise;
						output.push(event);
					}
					output.end();
				} catch (error) {
					output.fail(error);
				}
			})();
			return output;
		};
		return session.prompt(input, identity);
	},
});
const request = { agentInstanceRef, attemptId, principalId };
console.log(JSON.stringify({ kind: "owner_open", mode, generation: runtime.engineGeneration }));
if (mode === "stream") {
	const committed = Promise.withResolvers<void>();
	const unsubscribe = runtime.subscribe(event => {
		if (
			event.attemptId === attemptId &&
			event.kind === "message_updated" &&
			event.payload?.totalBytes === Buffer.byteLength(text)
		)
			committed.resolve();
	});
	await runtime.start(
		{
			commandId: "crash-start",
			agentInstanceRef,
			agentInstanceId,
			principalId,
			attemptId,
			executionId: "crash-execution",
			authorityGeneration: 1,
			cwd,
			input: "Fixture response",
		},
		{
			profileDigest: "crash-profile",
			spawns: "",
			enableMCP: false,
			enableLsp: false,
			toolNames: [],
			restrictToolNames: true,
		},
	);
	await committed.promise;
	unsubscribe();
	const page = await runtime.store.runtimeMessages(request);
	const baseline = (page.items as Array<Record<string, unknown>>)[0];
	await Bun.write(
		readyFile,
		JSON.stringify({
			baseline,
			hash: crypto.createHash("sha256").update(text).digest("hex"),
			generation: runtime.engineGeneration,
			dispatches,
		}),
	);
	// Parent keeps stdin open, then terminates this exact process without dispose.
	await Bun.stdin.text();
	waiting.resolve();
	await runtime.dispose();
	auth.close();
} else {
	try {
		const ready = await Bun.file(readyFile).json();
		const page = await runtime.store.runtimeMessages(request);
		const baseline = (page.items as Array<Record<string, unknown>>)[0];
		const resource = baseline.resource as Record<string, unknown>;
		const hash = crypto.createHash("sha256");
		let offset = 0;
		while (offset < Number(resource.bytes)) {
			const range = await runtime.store.runtimeResource({
				principalId,
				resource: ready.baseline.resource,
				offset,
				limit: 65536,
			});
			const bytes = Buffer.from(String(range.contentBase64), "base64");
			if (!bytes.length || bytes.length > 65536) throw new Error("Unbounded or empty retained message range");
			hash.update(bytes);
			offset += bytes.length;
		}
		const result = {
			baseline,
			hash: hash.digest("hex"),
			generation: runtime.engineGeneration,
			dispatches,
			attempt: await runtime.store.getAttempt(attemptId),
			intent: await runtime.store.intent(agentInstanceId),
			work: page.work,
		};
		await Bun.write(path.join(directory, `recovered-${runtime.engineGeneration}.json`), JSON.stringify(result));
	} finally {
		await runtime.dispose();
		auth.close();
	}
}
