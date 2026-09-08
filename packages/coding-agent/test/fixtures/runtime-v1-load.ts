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
if (
	![1, 7, 14, 28].includes(roots) ||
	![20, 200].includes(rate) ||
	!Number.isFinite(seconds) ||
	seconds <= 0 ||
	![0, 200].includes(noisyRate)
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
const mock = createMockModel({
	handler: { content: ["controlled load completed"], delayMs: Math.ceil(seconds * 1000 + 60_000) },
});
const settings = await Settings.loadReadOnly({ cwd, agentDir });
const runtime = await EngineRuntime.create({
	databasePath: path.join(directory, "engine.sqlite"),
	dispatchPrompt: (session, input, identity) => session.prompt(input, identity),
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
const bindings: Array<EngineBindingSnapshot & { agentInstanceRef: string }> = [];
const enroll = async (name: string, parent?: EngineBindingSnapshot & { agentInstanceRef: string }) => {
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
	const item = { ...binding, agentInstanceRef };
	bindings.push(item);
	return item;
};
for (let i = 0; i < roots; i++) {
	const root = await enroll(`root-${i}`);
	await enroll(`child-${i}-0`, root);
	await enroll(`child-${i}-1`, root);
}
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const started = performance.now();
const metrics = fs.createWriteStream(path.join(directory, "metrics.ndjson"), { flags: "wx" });
const payload = "x".repeat(1024);
let produced = 0;
let commitMs = 0;
const streams = new Map<string, { revision: number; offset: number }>();
const produce = async (binding: EngineBindingSnapshot & { agentInstanceRef: string }) => {
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
		agents: bindings.map(item => ({
			agentInstanceRef: item.agentInstanceRef,
			attemptId: item.attemptId,
			executionId: item.executionId,
		})),
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
			await produce(bindings[0]);
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
			metrics.write(
				`${JSON.stringify({ at: Date.now(), elapsedMs: performance.now() - started, produced, commitMs, lagP95Ms: lag.percentile(95) / 1e6, lagMaxMs: lag.max / 1e6, rssBytes: process.memoryUsage().rss, sqliteBytes: files[0], walBytes: files[1], loopUtilization: performance.eventLoopUtilization() })}\n`,
			);
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
	await new Promise<void>((resolve, reject) => {
		metrics.once("error", reject);
		metrics.end(resolve);
	});
	console.log(
		JSON.stringify({ kind: "complete", directory, produced, commitMs, elapsedMs: performance.now() - started }),
	);
}
