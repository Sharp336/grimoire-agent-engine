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
import { type EngineCommandEnvelope, engineCommandIdentity, NatsEngineAdapter } from "../../src/engine/nats-adapter";
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
const staircaseSeconds = Number(args.get("--staircase-seconds") ?? 0);
const staircaseStartFile = args.get("--staircase-start-file");
if (
	staircaseSeconds &&
	(roots !== 28 ||
		!Number.isInteger(staircaseSeconds) ||
		staircaseSeconds < 4 ||
		staircaseSeconds % 4 !== 0 ||
		staircaseSeconds > seconds ||
		!staircaseStartFile ||
		path.resolve(staircaseStartFile) !== path.join(directory, "staircase-start"))
)
	throw new Error("Staircase requires 28 roots, four finite equal phases and its owned start marker");
const activeAgents = roots * 3 + (noisyRate ? 1 : 0);
const legacyOwnership = args.get("--legacy-ownership") === "true";
const initialAgents = activeAgents + (legacyOwnership ? 4 : 0);
const catalogAgents = Number(args.get("--catalog-agents") ?? initialAgents);
const historyEntries = Number(args.get("--history-entries") ?? 0);
if (
	![1, 2, 7, 14, 28].includes(roots) ||
	![20, 200].includes(rate) ||
	!Number.isFinite(seconds) ||
	seconds <= 0 ||
	![0, 200].includes(noisyRate) ||
	!Number.isSafeInteger(catalogAgents) ||
	catalogAgents < initialAgents ||
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
const legacySeed: Array<{
	scenario: string;
	agentInstanceRef: string;
	agentInstanceId: string;
	authorityGeneration: number;
	command?: EngineCommandEnvelope;
}> = [];
if (legacyOwnership) {
	const readyFile = args.get("--ownership-ready-file");
	if (!readyFile || !path.isAbsolute(readyFile))
		throw new Error("Legacy proof fixture requires an absolute --ownership-ready-file barrier");
	for (const scenario of ["native", "missing", "oversized", "conflict"]) {
		const name = `legacy-${scenario}`;
		const agentInstanceRef = `grimoire://tasks/grimoire/runtime-load/agents/${name}`;
		const identity = {
			agentInstanceRef,
			agentInstanceId: engineAgentInstanceId(agentInstanceRef),
			authorityGeneration: 1,
		};
		if (scenario === "native") {
			await runtime.store.registerAgent(identity);
			legacySeed.push({ scenario, ...identity });
		} else {
			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: `fixture-${name}`,
				op: "start",
				deviceId,
				engineId,
				engineGeneration: runtime.engineGeneration,
				...identity,
				attemptId: `attempt-${name}`,
				executionId: `execution-${name}`,
				issuedAt: Date.now(),
				payload: { input: "Historical ownership fixture", cwd, profileDigest: profile.profileDigest },
			};
			await runtime.store.admitCommand(engineCommandIdentity(command), runtime.engineGeneration);
			legacySeed.push({ scenario, ...identity, command });
		}
	}
	const manifestPath = path.join(directory, "legacy-ownership.json");
	await Bun.write(manifestPath, JSON.stringify({ principalId, deviceId, engineId, candidates: legacySeed }));
	console.log(JSON.stringify({ kind: "ownership_seed_required", manifestPath, readyFile }));
	const deadline = Date.now() + 30_000;
	while (!(await Bun.file(readyFile).exists())) {
		if (Date.now() >= deadline) {
			await runtime.dispose();
			auth.close();
			throw new Error("Legacy ownership seed barrier timed out");
		}
		await Bun.sleep(25);
	}
}
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
for (let i = initialAgents; i < catalogAgents; i++) {
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
	await session.sessionManager.appendEntriesAtomically(() => {
		for (let i = existing; i < historyEntries; i++) {
			session.sessionManager.appendMessage(
				{ role: "user", content: `Canonical retained history entry ${i}`, timestamp: Date.now() },
				{ clientMessageId: `fixture-history-${i}` },
			);
		}
	});
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
let producerStarted = started;
let staircaseStarted: number | undefined;
let stage = -1;
let producingRoots = roots;
const metrics = fs.createWriteStream(path.join(directory, "metrics.ndjson"), { flags: "wx" });
const writeMetric = async (value: Record<string, unknown>) => {
	if (!metrics.write(`${JSON.stringify(value)}\n`)) await once(metrics, "drain");
};
const admitCommand = runtime.store.admitCommand.bind(runtime.store);
runtime.store.admitCommand = async (command, generation) => {
	const result = await admitCommand(command, generation);
	if (command.commandId.startsWith("measure-control-"))
		await writeMetric({
			kind: "command_admitted",
			commandId: command.commandId,
			admittedAt: Date.now(),
			status: result.status,
		});
	return result;
};
const payload = "x".repeat(1024);
function measureRead<Args extends unknown[], Result>(
	method: string,
	read: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
	return async (...args) => {
		const began = performance.now();
		const startedAt = Date.now();
		let status = "ok";
		try {
			return await read(...args);
		} catch (error) {
			status = "error";
			throw error;
		} finally {
			await writeMetric({ kind: "owner_read", method, startedAt, elapsedMs: performance.now() - began, status });
		}
	};
}
runtime.store.runtimeSnapshot = measureRead("runtime.snapshot", runtime.store.runtimeSnapshot.bind(runtime.store));
runtime.store.runtimeQueue = measureRead("runtime.queue", runtime.store.runtimeQueue.bind(runtime.store));
runtime.sessionHistoryPage = measureRead("runtime.history", runtime.sessionHistoryPage.bind(runtime));
let produced = 0;
let commitMs = 0;
const streams = new Map<string, { revision: number; offset: number }>();
const produce = async (binding: EngineBindingSnapshot & { agentInstanceRef: string }) => {
	const current = runtime.getBinding(binding.agentInstanceId);
	if (!current || current.attemptId !== binding.attemptId || current.state !== "running" || current.manualHold) return;
	const stream = streams.get(binding.attemptId) ?? { revision: 0, offset: 0 };
	streams.set(binding.attemptId, stream);
	const revision = ++stream.revision;
	const baseRevision = revision - 1;
	const offset = stream.offset;
	stream.offset += Buffer.byteLength(payload);
	const began = performance.now();
	const event = await runtime.store.appendEvent({
		...binding,
		causationCommandId: `load-${revision}`,
		kind: "message_updated",
		payload: {
			mode: baseRevision ? "append" : "snapshot",
			messageId: `load-${binding.attemptId}`,
			blockId: "text",
			stream: "assistant",
			contentId: `content-${binding.attemptId}`,
			revision,
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
	// Match the product runtime's post-COMMIT coalesced outbox wake. Provider
	// admission does not wait for an unrelated sink's entire durable backlog.
	adapter?.wakeEvents();
	if (revision % 20 === 0)
		await writeMetric({
			kind: "commit_sample",
			cursor: event.eventId,
			committedAt: Date.now(),
			agentInstanceRef: binding.agentInstanceRef,
			attemptId: binding.attemptId,
			revision,
			...(staircaseSeconds ? { stage } : {}),
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
		...(legacyOwnership ? { legacyOwnership: legacySeed } : {}),
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
		...(staircaseSeconds ? { producingRootStages: [1, 7, 14, 28], staircaseSeconds } : {}),
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
		if (staircaseSeconds && staircaseStarted === undefined) {
			// The root starts the measured staircase after both real UI observers attach.
			// Do not use Bun.file().exists(): its cached ENOENT can miss a later marker.
			try {
				await fs.promises.access(staircaseStartFile!);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await Bun.sleep(25);
				continue;
			}
			staircaseStarted = producerStarted = performance.now();
		}
		if (staircaseStarted !== undefined) {
			const nextStage = Math.min(3, Math.floor((performance.now() - staircaseStarted) / (staircaseSeconds * 250)));
			if (nextStage !== stage) {
				stage = nextStage;
				producingRoots = [1, 7, 14, 28][stage];
				await writeMetric({
					kind: "load_stage",
					stage,
					producingRoots,
					producingAgents: producingRoots * 3,
					at: Date.now(),
					pid: process.pid,
					produced,
				});
			}
		}
		const deadline = producerStarted + (++tick * 1000) / rate;
		// Preserve the offered ratio under saturation. A wall-clock backlog here can grow
		// faster than it drains and prevent every nominal AgentInstance from getting its next turn.
		const targetNoisy = Math.floor((tick * noisyRate) / rate);
		await Promise.all([
			...bindings.slice(0, producingRoots * 3).map(binding => produce(binding)),
			(async () => {
				const pending: Array<Promise<number | undefined>> = [];
				while (noisy < targetNoisy && !stop.signal.aborted) {
					noisy++;
					const delay = producerStarted + (noisy * 1000) / noisyRate - performance.now();
					if (delay > 0) await Bun.sleep(delay);
					// Model the independently paced producer. At most one cohort (10 at
					// 200/s) is outstanding; its next cohort waits for durable admission.
					pending.push(produce(noisyBinding!));
				}
				await Promise.all(pending);
			})(),
		]);
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
				...(staircaseSeconds ? { stage, producingRoots } : {}),
				producerRevisions: Object.fromEntries(
					[...streams].map(([attemptId, stream]) => [attemptId, stream.revision]),
				),
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
		JSON.stringify({
			kind: "complete",
			directory,
			produced,
			commitMs,
			elapsedMs: performance.now() - started,
			producerRevisions: Object.fromEntries([...streams].map(([attemptId, stream]) => [attemptId, stream.revision])),
		}),
	);
}
