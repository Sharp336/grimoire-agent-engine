import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { EngineBindingSnapshot } from "../../src/engine/contracts";
import { startEngineControlQueryServer } from "../../src/engine/control-query";
import { HostedEngineBridge, HostedGrimoireRpc } from "../../src/engine/hosted-bridge";
import { NatsEngineAdapter } from "../../src/engine/nats-adapter";
import { engineAgentInstanceId } from "../../src/engine/route";
import { EngineRuntime } from "../../src/engine/runtime";
import { RUNTIME_PROTOCOL_HASH } from "../../src/engine/runtime-protocol";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";

// Test-only producer. All reads and controls use the production native IPC server.
// bun test/fixtures/runtime-v1-load.ts --run-dir <owned TEMP> --seconds 1800 --roots 7 --rate 20
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const directory = path.resolve(
	args.get("--run-dir") ??
		(() => {
			throw new Error("--run-dir is required");
		})(),
);
if (fs.existsSync(directory)) throw new Error("Load fixture requires a new, explicitly owned run directory");
const roots = Number(args.get("--roots") ?? 7);
const rate = Number(args.get("--rate") ?? 20);
const seconds = Number(args.get("--seconds") ?? 1800);
const noisyRate = Number(args.get("--noisy-rate") ?? 0);
const activeAgents = roots * 3 + (noisyRate ? 1 : 0);
const catalogAgents = Number(args.get("--catalog-agents") ?? activeAgents);
const historyEntries = Number(args.get("--history-entries") ?? 0);
if (
	![1, 2, 7, 14, 28].includes(roots) ||
	![20, 200].includes(rate) ||
	!Number.isFinite(seconds) ||
	seconds <= 0 ||
	![0, 200].includes(noisyRate) ||
	!Number.isSafeInteger(catalogAgents) ||
	catalogAgents < activeAgents ||
	catalogAgents > 10_000 ||
	!Number.isSafeInteger(historyEntries) ||
	historyEntries < 0 ||
	historyEntries > 100_000
)
	throw new Error("Invalid load dimensions");
const principalId = args.get("--principal") ?? "runtime-load-owner";
const deviceId = args.get("--device-id") ?? "runtime-load-device";
const engineId = args.get("--engine-id") ?? "runtime-load-engine";
const natsUrl = args.get("--nats-url");
const bridgeUrl = args.get("--bridge-url");
const bridgeTokenFile = args.get("--bridge-token-file");
if (bridgeUrl && (!bridgeTokenFile || !natsUrl))
	throw new Error("Bridge fixture requires --bridge-token-file and an isolated --nats-url");
fs.mkdirSync(directory, { recursive: true });
const cwd = path.join(directory, "workspace");
const agentDir = path.join(directory, "agent");
fs.mkdirSync(cwd);
registerMockApi("runtime-v1-load");
const auth = await AuthStorage.create(path.join(directory, "mock-auth.db"));
auth.setRuntimeApiKey("mock", "isolated-load-test");
const models = new ModelRegistry(auth, path.join(directory, "mock-models.yml"));
const sessionOwners = new Map<string, string>();
const sessions = new Map<string, AgentSession>();
const boundaryFile = path.join(cwd, "provider-boundary.txt");
fs.writeFileSync(boundaryFile, "Controlled provider reached a safe action boundary.\n");
let runtime: EngineRuntime;
let boundarySequence = 0;
const mock = createMockModel({
	handler: async (_context, options) => {
		const agentId = sessionOwners.get(options?.sessionId ?? "");
		if (!agentId) throw new Error("Fixture provider has no exact session owner");
		const boundary = Promise.withResolvers<void>();
		const unsubscribe = runtime.subscribe(event => {
			if (event.agentInstanceId === agentId && event.kind === "pause_requested") boundary.resolve();
		});
		const abort = () => boundary.reject(options?.signal?.reason ?? new Error("Fixture provider cancelled"));
		options?.signal?.addEventListener("abort", abort, { once: true });
		if (options?.signal?.aborted) abort();
		else if (runtime.getBinding(agentId)?.manualHold) boundary.resolve();
		try {
			await boundary.promise;
		} finally {
			unsubscribe();
			options?.signal?.removeEventListener("abort", abort);
		}
		// End only the mocked in-flight provider call. The real Agent loop parks before this tool.
		// After Resume the exact Attempt executes the read and starts another controlled call.
		return {
			content: [
				{
					type: "toolCall",
					id: `fixture-boundary-${++boundarySequence}`,
					name: "read",
					arguments: { path: boundaryFile },
				},
			],
		};
	},
});
const settings = await Settings.loadReadOnly({ cwd, agentDir });
runtime = await EngineRuntime.create({
	databasePath: path.join(directory, "engine.sqlite"),
	dispatchPrompt: (session, input, identity) => {
		const target = runtime.resolveBrokerAgent(session.getAgentId() ?? "");
		if (!target) throw new Error("Fixture dispatch has no exact Engine binding");
		sessionOwners.set(session.sessionId, target.agentInstanceId);
		sessions.set(target.agentInstanceId, session);
		return session.prompt(input, identity);
	},
	sessionDefaults: {
		cwd,
		agentDir,
		settings,
		model: mock.model,
		modelRegistry: models,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	},
});
const profile = { spawns: "", profileDigest: "runtime-load-profile", enableMCP: false, enableLsp: false };
const adapter = natsUrl
	? await NatsEngineAdapter.connect({
			runtime,
			deviceId,
			engineId,
			servers: natsUrl,
			authorizeCommand: command => {
				if (command.principalId && command.principalId !== principalId)
					throw new Error("Fixture principal mismatch");
			},
			authorizeMessage: () => {},
			resolveLaunchProfile: () => profile,
		})
	: undefined;
const bridge = bridgeUrl
	? await HostedEngineBridge.connect({
			eventStore: runtime.store,
			deviceId,
			engineId,
			engineGeneration: runtime.engineGeneration,
			servers: natsUrl!,
			rpc: new HostedGrimoireRpc({
				serverUrl: bridgeUrl,
				token: (await Bun.file(bridgeTokenFile!).text()).trim(),
				clientId: args.get("--client-id") ?? "runtime-load-client",
			}),
		})
	: undefined;
const server = await startEngineControlQueryServer({
	runtime,
	runtimeDir: directory,
	deviceId,
	engineId,
	resolveLaunchProfile: () => profile,
});
interface FixtureBinding extends EngineBindingSnapshot {
	agentInstanceRef: string;
	rootAgentInstanceRef: string;
}
const bindings: FixtureBinding[] = [];
const enroll = async (name: string, parent?: FixtureBinding, measured = true): Promise<FixtureBinding> => {
	const agentInstanceRef = `grimoire://tasks/grimoire/runtime-load/agents/${name}`;
	const binding = await runtime.start(
		{
			commandId: `start-${name}`,
			agentInstanceId: engineAgentInstanceId(agentInstanceRef),
			agentInstanceRef,
			parentAgentInstanceId: parent?.agentInstanceId,
			parentAgentInstanceRef: parent?.agentInstanceRef,
			principalId,
			executionId: `execution-${name}`,
			attemptId: `attempt-${name}`,
			authorityGeneration: 1,
			expectedIntentRevision: 0,
			cwd,
			input: "controlled provider",
		},
		profile,
	);
	const item = {
		...binding,
		agentInstanceRef,
		rootAgentInstanceRef: parent?.rootAgentInstanceRef ?? agentInstanceRef,
	};
	if (measured) bindings.push(item);
	return item;
};
for (let i = 0; i < roots; i++) {
	const root = await enroll(`root-${i}`);
	await enroll(`child-${i}-0`, root);
	await enroll(`child-${i}-1`, root);
}
const noisyBinding = noisyRate ? await enroll("noisy", undefined, false) : undefined;
for (let i = activeAgents; i < catalogAgents; i++) {
	const agentInstanceRef = `grimoire://tasks/grimoire/runtime-load/agents/catalog-${i}`;
	await runtime.store.registerAgent({
		agentInstanceId: engineAgentInstanceId(agentInstanceRef),
		agentInstanceRef,
		principalId,
		authorityGeneration: 1,
	});
}
if (historyEntries) {
	const first = bindings[0];
	const session = sessions.get(first.agentInstanceId);
	if (!session) throw new Error("Fixture root session did not start before history preparation");
	const existing = session.sessionManager.getEntries().filter(entry => entry.type === "message").length;
	for (let i = existing; i < historyEntries; i++) {
		session.sessionManager.appendMessage(
			{ role: "user", content: `Canonical retained history entry ${i}`, timestamp: Date.now() },
			{ clientMessageId: `fixture-history-${i}` },
		);
	}
	const transcriptCheckpoint = await session.sessionManager.flushAndCheckpoint();
	await runtime.store.commitAttemptTransition(first, "running", [], {
		expectedStates: ["running"],
		transcriptCheckpoint,
	});
}
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const started = performance.now();
const metrics = fs.createWriteStream(path.join(directory, "metrics.ndjson"), { flags: "wx" });
const writeMetric = async (value: Record<string, unknown>) => {
	if (!metrics.write(`${JSON.stringify(value)}\n`)) await once(metrics, "drain");
};
const payload = "x".repeat(1024);
let produced = 0;
let commitMs = 0;
const streams = new Map<string, { revision: number; offset: number }>();
const produce = async (binding: EngineBindingSnapshot & { agentInstanceRef: string }) => {
	const current = runtime.getBinding(binding.agentInstanceId);
	if (!current || current.attemptId !== binding.attemptId || current.state !== "running" || current.manualHold) return;
	const stream = streams.get(binding.attemptId) ?? { revision: 0, offset: 0 };
	streams.set(binding.attemptId, stream);
	const baseRevision = stream.revision++;
	const offset = stream.offset;
	stream.offset += Buffer.byteLength(payload);
	const began = performance.now();
	const event = await runtime.store.appendEvent({
		...binding,
		causationCommandId: `load-${stream.revision}`,
		kind: "message_updated",
		payload: {
			mode: baseRevision ? "append" : "snapshot",
			messageId: `load-${binding.attemptId}`,
			blockId: "text",
			stream: "assistant",
			contentId: `content-${binding.attemptId}`,
			revision: stream.revision,
			offset,
			endOffset: stream.offset,
			totalBytes: stream.offset,
			text: payload,
			status: "streaming",
			...(baseRevision ? { baseRevision } : { partial: false }),
		},
	});
	produced++;
	commitMs += performance.now() - began;
	if (stream.revision % 20 === 0)
		await writeMetric({
			kind: "commit_sample",
			cursor: event.eventId,
			committedAt: Date.now(),
			agentInstanceRef: binding.agentInstanceRef,
			attemptId: binding.attemptId,
			revision: stream.revision,
		});
	return event.eventId;
};
const provenance = await Bun.$`git rev-parse HEAD`.quiet().text();
console.log(
	JSON.stringify({
		kind: "ready",
		runtimeDir: directory,
		endpoint: server.endpoint,
		principalId,
		roots,
		catalogAgents,
		historyEntries,
		agents: bindings.map(item => ({
			agentInstanceRef: item.agentInstanceRef,
			rootAgentInstanceRef: item.rootAgentInstanceRef,
			attemptId: item.attemptId,
			executionId: item.executionId,
		})),
		...(noisyBinding
			? {
					noisyAgent: {
						agentInstanceRef: noisyBinding.agentInstanceRef,
						rootAgentInstanceRef: noisyBinding.rootAgentInstanceRef,
						attemptId: noisyBinding.attemptId,
						executionId: noisyBinding.executionId,
					},
				}
			: {}),
		ratePerAgent: rate,
		nominalEventsPerSecond: rate * bindings.length,
		noisyRate,
		seconds,
		pid: process.pid,
		sourceHead: provenance.trim(),
		contractHash: RUNTIME_PROTOCOL_HASH,
		bridge: Boolean(bridge),
	}),
);
let tick = 0;
let noisy = 0;
let lastSample = started;
try {
	while (!stop.signal.aborted && performance.now() - started < seconds * 1000) {
		const deadline = started + (++tick * 1000) / rate;
		for (const binding of bindings) await produce(binding);
		const targetNoisy = Math.floor(((performance.now() - started) * noisyRate) / 1000);
		while (noisy < targetNoisy && !stop.signal.aborted) {
			noisy++;
			await produce(noisyBinding!);
		}
		await adapter?.flushEvents();
		if (performance.now() - lastSample >= 1000) {
			const files = ["engine.sqlite", "engine.sqlite-wal"].map(file => {
				try {
					return fs.statSync(path.join(directory, file)).size;
				} catch {
					return 0;
				}
			});
			await writeMetric({
				kind: "metrics",
				at: Date.now(),
				elapsedMs: performance.now() - started,
				produced,
				commitMs,
				lagP95Ms: lag.percentile(95) / 1e6,
				lagMaxMs: lag.max / 1e6,
				rssBytes: process.memoryUsage().rss,
				sqliteBytes: files[0],
				walBytes: files[1],
				loopUtilization: performance.eventLoopUtilization(),
			});
			lag.reset();
			lastSample = performance.now();
		}
		await Bun.sleep(Math.max(0, deadline - performance.now()));
	}
} finally {
	lag.disable();
	await bridge?.stopAdmission();
	await adapter?.stopAdmission();
	await server.close();
	await bridge?.dispose();
	await adapter?.dispose();
	await runtime.dispose();
	auth.close();
	metrics.end();
	await once(metrics, "finish");
	console.log(
		JSON.stringify({ kind: "complete", directory, produced, commitMs, elapsedMs: performance.now() - started }),
	);
}
